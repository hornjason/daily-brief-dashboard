// src/lib/saleshub-content.ts
// GitHub Issue #448, #507 — SalesHub Content library (signal module consumption layer)
// Reads Drive content cache (drive-content.json) and knowledge JSON for signal emission.
// Pure functions, no framework deps.

import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'
import { CACHE_DIR } from './paths.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SalesHubDocument {
  name: string
  contentType: string        // "Business presentation", "Cheatsheet", "Competitive review"
  tdp?: string               // TDP association
  salesPlay?: string         // Sales Play association
  product: string            // Red Hat product tag
  distributionTerms: string  // "General Distribution" or "Confidential - Channel NDA Required"
  salesStage: string         // "1. Discover", "2. Validate", etc
  versionCreated: string     // ISO date — last updated
  driveUrl?: string          // Google Drive link if available
  size?: number
}

// ── Knowledge JSON shape (subset relevant to content signals) ─────────────

interface KnowledgeTdp {
  name: string
  documents?: Array<{
    name: string
    contentType: string
    product: string
    distributionTerms: string
    salesStage: string
    versionCreated: string
    size?: number
    driveUrl?: string
    downloadUrl?: string
  }>
  whatToShare?: Array<{ name: string; url?: string; type?: string }>
  customerWins?: Array<{ customer: string; outcome: string }>
}

interface KnowledgeSalesPlay {
  name: string
  documents?: Array<{
    name: string
    contentType: string
    product: string
    distributionTerms: string
    salesStage: string
    versionCreated: string
    size?: number
    driveUrl?: string
    downloadUrl?: string
  }>
}

interface KnowledgeTactic {
  name: string
  parentTdp: string
  documents?: Array<{
    name: string
    contentType: string
    product: string
    distributionTerms: string
    salesStage: string
    versionCreated: string
    size?: number
    driveUrl?: string
    downloadUrl?: string
  }>
  whatToShare?: Array<{ name: string; url?: string; type?: string }>
}

interface KnowledgeProduct {
  name: string
  slug: string
  decks?: Array<{ text?: string; name?: string; url: string; type: string }>
  resources?: Array<{ text?: string; name?: string; url: string; type: string }>
}

interface SalesHubKnowledgeJson {
  version?: number
  scrapedAt: string
  lastContentScrape?: string
  tdps: KnowledgeTdp[]
  salesPlays: KnowledgeSalesPlay[]
  tactics: KnowledgeTactic[]
  products: KnowledgeProduct[]
}

// ── Cache ─────────────────────────────────────────────────────────────────────

let _cache: SalesHubKnowledgeJson | null = null
let _cacheMtime: number = 0
let _lastCheck: number = 0
const CHECK_INTERVAL_MS = 60_000

function getConfigDir(): string {
  return process.env.CONFIG_DIR ?? 'config'
}

function getKnowledgePaths(): string[] {
  const paths = [resolve(getConfigDir(), 'saleshub-knowledge.json')]
  if (!process.env.CONFIG_DIR) {
    paths.push(resolve('config-templates', 'saleshub-knowledge.json'))
  }
  return paths
}

function loadKnowledge(): SalesHubKnowledgeJson | null {
  const now = Date.now()
  if (_cache && now - _lastCheck < CHECK_INTERVAL_MS) {
    return _cache
  }

  for (const p of getKnowledgePaths()) {
    try {
      if (!existsSync(p)) continue
      const mtime = statSync(p).mtimeMs
      if (_cache && mtime === _cacheMtime) {
        _lastCheck = now
        return _cache
      }
      _cache = JSON.parse(readFileSync(p, 'utf-8'))
      _cacheMtime = mtime
      _lastCheck = now
      return _cache
    } catch { /* try next */ }
  }

  return null
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load all SalesHub content documents from the knowledge JSON.
 * Aggregates documents from TDPs, Sales Plays, and Tactics,
 * plus product decks/resources as document references.
 */
export function loadSalesHubContent(): SalesHubDocument[] {
  const kb = loadKnowledge()
  if (!kb) return []

  const docs: SalesHubDocument[] = []
  const seen = new Set<string>() // dedupe by name+contentType

  // Documents from TDPs
  for (const tdp of kb.tdps ?? []) {
    for (const doc of tdp.documents ?? []) {
      const key = `${doc.name}|${doc.contentType}`
      if (seen.has(key)) continue
      seen.add(key)
      docs.push({
        name: doc.name,
        contentType: doc.contentType,
        tdp: tdp.name,
        product: doc.product ?? '',
        distributionTerms: doc.distributionTerms ?? '',
        salesStage: doc.salesStage ?? '',
        versionCreated: doc.versionCreated ?? '',
        driveUrl: doc.driveUrl ?? doc.downloadUrl,
        size: doc.size,
      })
    }
  }

  // Documents from Sales Plays
  for (const play of kb.salesPlays ?? []) {
    for (const doc of play.documents ?? []) {
      const key = `${doc.name}|${doc.contentType}`
      if (seen.has(key)) continue
      seen.add(key)
      docs.push({
        name: doc.name,
        contentType: doc.contentType,
        salesPlay: play.name,
        product: doc.product ?? '',
        distributionTerms: doc.distributionTerms ?? '',
        salesStage: doc.salesStage ?? '',
        versionCreated: doc.versionCreated ?? '',
        driveUrl: doc.driveUrl ?? doc.downloadUrl,
        size: doc.size,
      })
    }
  }

  // Documents from Tactics
  for (const tactic of kb.tactics ?? []) {
    for (const doc of tactic.documents ?? []) {
      const key = `${doc.name}|${doc.contentType}`
      if (seen.has(key)) continue
      seen.add(key)
      docs.push({
        name: doc.name,
        contentType: doc.contentType,
        tdp: tactic.parentTdp || undefined,
        product: doc.product ?? '',
        distributionTerms: doc.distributionTerms ?? '',
        salesStage: doc.salesStage ?? '',
        versionCreated: doc.versionCreated ?? '',
        driveUrl: doc.driveUrl ?? doc.downloadUrl,
        size: doc.size,
      })
    }
  }

  // Product decks and resources as document references
  for (const product of kb.products ?? []) {
    for (const deck of product.decks ?? []) {
      const docName = deck.text || deck.name || ''
      if (!docName) continue
      const key = `${docName}|deck`
      if (seen.has(key)) continue
      seen.add(key)
      docs.push({
        name: docName,
        contentType: 'Business presentation',
        product: product.name,
        distributionTerms: '',
        salesStage: '',
        versionCreated: kb.scrapedAt ?? '',
        driveUrl: deck.url,
      })
    }
  }

  return docs
}

/**
 * Get the scrapedAt timestamp from the knowledge JSON.
 */
export function getKnowledgeScrapedAt(): string | null {
  const kb = loadKnowledge()
  return kb?.scrapedAt ?? null
}

/**
 * Get the mtime of the knowledge JSON file (for ensureFresh checks).
 */
export function getKnowledgeMtime(): number {
  for (const p of getKnowledgePaths()) {
    try {
      if (existsSync(p)) return statSync(p).mtimeMs
    } catch { /* try next */ }
  }
  return 0
}

/**
 * Reset the in-memory cache (for testing or forced reload).
 */
export function resetContentCache(): void {
  _cache = null
  _cacheMtime = 0
  _lastCheck = 0
}

// ── Drive Content Cache (#507) ──────────────────────────────────────────────

export interface DriveContentFile {
  name: string
  mimeType: string
  driveUrl: string
  driveId: string
  size: number | null
  modifiedTime: string
  parentFolder: string
  extractedText: string | null
}

export interface DriveContentCache {
  files: DriveContentFile[]
  lastSynced: string
  totalFiles: number
  withText: number
}

const DRIVE_CONTENT_CACHE_PATH = resolve(CACHE_DIR, 'saleshub', 'drive-content.json')

let _driveCache: DriveContentCache | null = null
let _driveCacheMtime: number = 0
let _driveLastCheck: number = 0

function loadDriveCacheFromDisk(): DriveContentCache | null {
  const now = Date.now()
  if (_driveCache && now - _driveLastCheck < CHECK_INTERVAL_MS) {
    return _driveCache
  }

  try {
    if (!existsSync(DRIVE_CONTENT_CACHE_PATH)) return null
    const mtime = statSync(DRIVE_CONTENT_CACHE_PATH).mtimeMs
    if (_driveCache && mtime === _driveCacheMtime) {
      _driveLastCheck = now
      return _driveCache
    }
    _driveCache = JSON.parse(readFileSync(DRIVE_CONTENT_CACHE_PATH, 'utf-8'))
    _driveCacheMtime = mtime
    _driveLastCheck = now
    return _driveCache
  } catch {
    return null
  }
}

/**
 * Load Drive content files from the local cache.
 * Returns empty array if cache does not exist.
 */
export function loadDriveContent(): DriveContentFile[] {
  const cache = loadDriveCacheFromDisk()
  return cache?.files ?? []
}

/**
 * Get the mtime of the Drive content cache file (for ensureFresh checks).
 */
export function getDriveContentMtime(): number {
  try {
    if (existsSync(DRIVE_CONTENT_CACHE_PATH)) {
      return statSync(DRIVE_CONTENT_CACHE_PATH).mtimeMs
    }
  } catch {}
  return 0
}

/**
 * Get the path to the Drive content cache file.
 */
export function getDriveContentCachePath(): string {
  return DRIVE_CONTENT_CACHE_PATH
}

/**
 * Reset the Drive content in-memory cache (for testing or forced reload).
 */
export function resetDriveContentCache(): void {
  _driveCache = null
  _driveCacheMtime = 0
  _driveLastCheck = 0
}

// ── Product folder name mapping (#507) ──────────────────────────────────────

const FOLDER_PRODUCT_MAP: Array<{ pattern: RegExp; product: string }> = [
  { pattern: /^(Ansible|AAP)/i, product: 'Red Hat Ansible Automation Platform' },
  { pattern: /^(OpenShift|OCP)/i, product: 'Red Hat OpenShift' },
  { pattern: /^(RHEL|Red Hat Enterprise Linux|Enterprise Linux)/i, product: 'Red Hat Enterprise Linux' },
  { pattern: /^(Advanced Cluster|ACM|RHACM)/i, product: 'Red Hat Advanced Cluster Management' },
  { pattern: /^(Quay)/i, product: 'Red Hat Quay' },
  { pattern: /^(Satellite)/i, product: 'Red Hat Satellite' },
  { pattern: /^(JBoss|EAP|Middleware)/i, product: 'Red Hat JBoss Enterprise Application Platform' },
  { pattern: /^(Insights)/i, product: 'Red Hat Insights' },
  { pattern: /^(Virtualization|RHV|CNV|OpenShift Virtualization)/i, product: 'Red Hat OpenShift Virtualization' },
  { pattern: /^(Storage|ODF|Ceph)/i, product: 'Red Hat OpenShift Data Foundation' },
  { pattern: /^(Integration|Fuse|Camel|3scale)/i, product: 'Red Hat Integration' },
  { pattern: /^(Developer|DevSpaces|CodeReady)/i, product: 'Red Hat Developer Tools' },
]

/**
 * Map a Drive folder name to a known Red Hat product name.
 * Returns the folder name unchanged if no mapping found.
 */
export function mapFolderToProduct(folderName: string): string {
  for (const { pattern, product } of FOLDER_PRODUCT_MAP) {
    if (pattern.test(folderName)) return product
  }
  return folderName
}
