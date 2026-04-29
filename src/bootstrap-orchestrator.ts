// ── Auto-bootstrap + Tableau routes (M03 — extracted from server.ts) ────────
import { Hono } from 'hono'
import { writeFileSync as writeFileSyncRaw, readFileSync, renameSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from './google.ts'
import { aes, customers, saveAes, patchAe, CUSTOMERS_PATH } from './server-state.ts'
import { runSfPipelineSync, runSfPipelineSyncFromData, scrapeSfReport, createPipelineSheet, type SfReportRow } from './sf-scraper.ts'
import { runSupportableDiscoverAndScrape, writeSupportableSheet } from './supportable-scraper.ts'
import { fetchSfBookingsRaw, deriveSfCustomersByTerritory, listPodBookingSheets, matchPodSheet } from './sf-bookings-reader.ts'
import { runCcspScrape, writeCcspSheet, consumeTableauSessionExpired, parseTerritoryParts, checkCcspL3Exists } from './ccsp-scraper.ts'
import { parseCsvToSfReport } from './csv-parse.ts'
import { fetchCustomerAccountNumbers, normalizeRows } from './sheets.ts'
import { writeSheetCache, readPipelineCache, readCCSPCache } from './cache-layer.ts'
import type { PipelineRecord } from './pipeline.ts'
import { enqueueScraperTask } from './background-scheduler.ts'
import { getAiConfig } from './settings-api.ts'

import { getScrapeContext } from './rh-scraper.ts'
import { startTableauLoginBrowser, waitForTableauLogin, checkTableauSessionFromCookies, probeTableauSession } from './tableau-auth.ts'
import { refreshPipeline } from './refresh-engine.ts'
import { inferCustomerDomain, isHighConfidenceDomain } from './domains.ts'
import { batchInferDomains, isPublicDomain, tier1Clearbit } from './domain-waterfall.ts'
import type { AE } from './types.ts'
import { sanitizeErr, isValidDriveFolderId } from './utils.ts'
import { loadProductIntelConfig, saveProductConfig, getProductIntelParentFolderId } from './product-release-radar.ts'
import { recordBootstrapRun } from './bootstrap-history.ts'
import { getBackupSheetId, setBackupSheetId, createBackupSheet } from './backup-config.ts'
import { normalizeSettings } from './region-config.ts'
import { emitCacheLevel } from './ingest-events.js'

// ── Constants ────────────────────────────────────────────────────────────────
const SRV_CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const RH_PROFILE_DIR = process.env.RH_PROFILE_DIR ?? resolve(SRV_CONFIG_DIR, '.rh-chrome-profile')
const OAUTH_STATE_PATH = resolve(SRV_CONFIG_DIR, 'oauth-state.json')
const DATA_SOURCES_PATH = resolve(SRV_CONFIG_DIR, 'data-sources.json')
const SETTINGS_PATH = resolve(SRV_CONFIG_DIR, 'settings.json')
const NTFY_TOPIC = process.env.NTFY_TOPIC ?? 'asa-command-center'

// ── POD config persistence ────────────────────────────────────────────────────
/** Save the POD bootstrap inputs to data-sources.json so they survive restarts. */
function savePodConfig(cfg: { territorySheetId: string; sfReportId: string; parentFolderId: string; podTabTitle?: string }): void {
  try {
    let ds: Record<string, unknown> = {}
    try { ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8')) } catch { /* fresh file */ }
    const tmp = DATA_SOURCES_PATH + '.tmp'
    writeFileSyncRaw(tmp, JSON.stringify({ ...ds, podConfig: cfg }, null, 2), { mode: 0o600 })
    renameSync(tmp, DATA_SOURCES_PATH)
    console.log('[pod-bootstrap] POD config saved to data-sources.json')
  } catch (e: any) {
    console.warn('[pod-bootstrap] Could not save POD config:', e?.message)
  }
}

/** Read the last saved POD config from data-sources.json. Returns null if not saved. */
function readPodConfig(): { territorySheetId: string; sfReportId: string; parentFolderId: string; podTabTitle?: string } | null {
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    return ds.podConfig ?? null
  } catch { return null }
}

// ── BKL-DRIVE-SCAFFOLD-01 ────────────────────────────────────────────────────
/**
 * Idempotently scaffold `Config/` and `Products/<slug>` folders under the
 * AE/POD parentFolderId. Runs once per bootstrap, before AE Drive folder
 * creation (Step 0). Non-fatal: any Drive API failure is logged and
 * swallowed so the wider bootstrap can continue.
 *
 * Note: folder IDs are logged only — they are NOT persisted to settings.json
 * or any config file in this pass. BKL-DRIVE-PRODUCTS-ROOT-01 will wire the
 * product folder IDs into products.json in a follow-up.
 */
async function ensureConfigAndProductsScaffold(parentFolderId: string): Promise<{ configFolderId: string; productsFolderId: string } | null> {
  if (!parentFolderId) return null
  // BKL-DRIVE-SCAFFOLD-SLUGS-01: derive slugs from products.json — single source of truth
  const productSlugs = loadProductIntelConfig().products.map(p => p.slug)
  console.log(`[auto-bootstrap:scaffold] ensuring Config/ and Products/ under parentFolderId=${parentFolderId}`)
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    const findOrCreateFolder = async (name: string, parentId: string): Promise<string | null> => {
      const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const existing = await withQuotaRetry(
        () => drive.files.list({
          q: `name='${safeName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'files(id, name)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        })
      ).catch(() => ({ data: { files: [] as Array<{ id?: string | null }> } }))
      if (existing.data.files?.length) {
        return existing.data.files[0].id ?? null
      }
      const created = await withQuotaRetry(
        () => drive.files.create({
          requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
          supportsAllDrives: true,
          fields: 'id',
        })
      ).catch(() => null)
      return created?.data.id ?? null
    }

    const configFolderId = await findOrCreateFolder('Config', parentFolderId)
    const productsFolderId = await findOrCreateFolder('Products', parentFolderId)
    if (productsFolderId) {
      for (const slug of productSlugs) {
        const slugId = await findOrCreateFolder(slug, productsFolderId)
        if (!slugId) {
          console.warn(`[auto-bootstrap:scaffold] failed to ensure Products/${slug} (non-blocking)`)
        }
      }
    }
    console.log(`[auto-bootstrap:scaffold] done — configFolderId=${configFolderId ?? 'null'} productsFolderId=${productsFolderId ?? 'null'}`)
    if (!configFolderId || !productsFolderId) return null
    return { configFolderId, productsFolderId }
  } catch (e: any) {
    console.warn('[auto-bootstrap:scaffold] failed (non-blocking):', e?.message ?? e)
    return null
  }
}

async function notify(title: string, message: string, priority: 'default' | 'high' | 'urgent' = 'default'): Promise<void> {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { 'Title': title, 'Priority': priority, 'Content-Type': 'text/plain' },
      body: message,
    })
  } catch (e: any) {
    console.warn('[ntfy] notification failed:', e?.message ?? e)
  }
}

// BKL-M05: Display-oriented normalizer — differs from normalizeForMatch by stripping state codes, parentheticals, and applying title case (needed for Drive folder names).
/**
 * Normalize a customer name for use as a Drive folder name and search key.
 * Strips state suffixes, legal entity suffixes, and parentheticals; applies title case.
 * Input:  "DROPBOX, INC. - CA"  →  Output: "Dropbox"
 * Input:  "FRED HUTCHINSON CANCER CENTER"  →  Output: "Fred Hutchinson Cancer Center"
 * Input:  "A10 NETWORKS, INC."  →  Output: "A10 Networks"
 */
function normalizeCustomerName(raw: string): string {
  let name = raw.trim()
  // Strip state suffix " - XX" or " - XX/XX"
  name = name.replace(/\s+-\s+[A-Z]{2}(\/[A-Z]{2})?$/, '')
  // Strip parentheticals like "(REI)" or "(HostGator)"
  name = name.replace(/\s*\([^)]*\)\s*$/, '')
  // Strip legal entity suffixes (with or without leading comma)
  const legalSuffixes = [
    /,?\s+L\.?L\.?P\.?$/i,
    /,?\s+P\.?T\.?Y\.?\s+LTD\.?$/i,
    /,?\s+L\.?P\.?$/i,
    /,?\s+INC\.?$/i,
    /,?\s+LLC\.?$/i,
    /,?\s+LTD\.?$/i,
    /,?\s+CORP\.?$/i,
    /,?\s+CO\.?$/i,
    /,?\s+PLC\.?$/i,
  ]
  for (const re of legalSuffixes) name = name.replace(re, '')
  name = name.trim().replace(/,+$/, '').trim()
  // Title case: preserve words with digits (A10, H2O) or internal dots (U.S.) or already mixed case
  name = name.split(/\s+/).map(word => {
    if (/\d/.test(word) || /[a-z]/.test(word) || /\.[a-zA-Z]/.test(word)) return word
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  }).join(' ')
  return name
}

// BKL-W2-12: Search for an existing Google Sheet by name inside a Drive folder before creating a new one.
async function findExistingSheet(drive: any, folderId: string, name: string): Promise<string | null> {
  try {
    const q = `name='${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`
    const res = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 1 })
    return res.data.files?.[0]?.id ?? null
  } catch {
    return null
  }
}

/** Salesforce report/object ID — alphanumeric only, 15-18 chars. */
function isValidSfId(value: unknown): boolean {
  if (typeof value !== 'string') return true
  if (value === '') return true
  return /^[A-Za-z0-9]{15,18}$/.test(value)
}

/**
 * BKL-F07: Extract a bare SF report ID from a full Salesforce URL or return as-is if already bare.
 */
function extractSfReportId(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (/^[A-Za-z0-9]{15,18}$/.test(trimmed)) return trimmed
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const segments = url.pathname.split('/').filter(Boolean)
      for (let i = segments.length - 1; i >= 0; i--) {
        if (/^[A-Za-z0-9]{15,18}$/.test(segments[i])) return segments[i]
      }
    } catch { /* not a valid URL */ }
  }
  return trimmed
}

/**
 * BKL-F06: Reject names that are clearly territory sheet junk — deal rows, billing rows,
 * CCSP charges, opportunity rows, etc. Conservative by design: only rejects obvious patterns.
 */
function isJunkCustomerName(name: string): boolean {
  if (name.length < 3) return true
  if (name.includes('~')) return true
  // Opportunity/deal/billing keywords
  if (/\b(DSOR|Renewal|Royalty|billing|deal|opportunity)\b/i.test(name)) return true
  // Date patterns in the name (e.g. "2024-01 Something" or "01/2024")
  if (/\b\d{4}-\d{2}\b/.test(name) || /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(name)) return true
  // CCSP billing rows (e.g. "Global Royalty-CCSP")
  if (/-CCSP\b/i.test(name)) return true
  return false
}

// ── Interfaces ───────────────────────────────────────────────────────────────

interface AutoBootstrapStep {
  name: string
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped'
  detail?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
}

interface AutoBootstrapResources {
  driveFolder?: { id: string; url: string }
  customerFolders?: Record<string, { id: string; url: string }>
  supportableSheet?: { id: string; url: string }
  ccspSheet?: { id: string; url: string }
  pipelineSheet?: { id: string; url: string }
  unmatchedCustomers?: string[]  // customer names with 0 Supportable account matches
  junkFiltered?: string[]        // names rejected by junk filter before bootstrap
  domainInference?: { customerName: string; domain: string; confidence: 'high' | 'low'; sources: string[] }[]  // BKL-F05: auto-inferred domains
}

interface AutoBootstrapState {
  running: boolean
  aeName: string | null
  steps: AutoBootstrapStep[]
  error: string | null
  completedAt: string | null
  resources: AutoBootstrapResources
}

export let autoBootstrapState: AutoBootstrapState = {
  running: false, aeName: null, steps: [], error: null, completedAt: null, resources: {}
}

// BKL-DOM-INF-01: Module-level guards for the post-bootstrap domain inference IIFE.
// `inferenceRunning` lets the 409 gate and POD wait loop see in-progress inference
// even after autoBootstrapState.running has flipped to false (the state machine
// marks the bootstrap "complete" before kicking off inference today — but inference
// still mutates customers.json and resources.domainInference, so callers must wait).
// `_customerWriteLock` is a simple promise-chain mutex serializing writes to
// customers.json from the auto-save block — concurrent IIFEs across overlapping
// AE bootstraps could otherwise interleave read-modify-write and silently drop
// updates.
let inferenceRunning = false
let _customerWriteLock: Promise<void> = Promise.resolve()

/** BKL-W2-17: Exposed so background-scheduler can include bootstrap in isAnyScraperRunning() guard. */
export function isBootstrapRunning(): boolean { return autoBootstrapState.running || podBootstrapState.running }

/** Clear both bootstrap states — called by /api/setup/reset so UI doesn't show stale last-run details after a wipe. */
export function resetBootstrapStates(): void {
  autoBootstrapState = { running: false, steps: [], aeName: null, completedAt: null, error: null, resources: {} }
  podBootstrapState = { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null }
  autoBootstrapCancelRequested = false
}

// BKL-WIZ-02: Single-AE cancellation flag — checked between bootstrap steps for graceful stop
let autoBootstrapCancelRequested = false

// BKL-BOOTSTRAP-CANCEL-01: Per-step watchdog timeout — fires if a step hangs on a network call
const STEP_TIMEOUT_MS = 90_000

// ── POD Bootstrap ───────────────────────────────────────────────────────────

interface PodAeResult {
  name: string
  status: 'skipped' | 'ok' | 'error' | 'pending' | 'retrying'
  error?: string
  customerCount?: number
  startedAt?: string
  completedAt?: string
  durationMs?: number
}

interface PodBootstrapState {
  running: boolean
  total: number
  completed: number
  currentAE: string | null
  results: PodAeResult[]
  startedAt: string | null
  completedAt: string | null
  totalDurationMs?: number
  error: string | null
}

export let podBootstrapState: PodBootstrapState = {
  running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null,
}

/** BKL-WIZ-02: Cancellation flag — checked between AE steps in the POD bootstrap loop. */
let podBootstrapCancelled = false

// BKL-PERF-01: Cache SF report data during POD bootstrap to avoid re-scraping per AE
let podSfDataCache: { reportId: string; data: SfReportRow; expiresAt: number } | null = null
const POD_SF_CACHE_TTL_MS = 30 * 60 * 1000  // 30 min — safe within a single bootstrap run

// BKL-TOKEN-07: When a fresh disk pipeline cache exists, skip the live SF pre-scrape
// during POD bootstrap. The disk cache is written by refreshPipeline() after prior
// runs parsed each AE's pipeline sheet. 4h is conservative — SF pipeline data changes
// slowly within a business day, and any AE-level refresh still runs refreshPipeline()
// after bootstrap to re-sync from Google Sheets.
const PIPELINE_DISK_TTL_MS = 4 * 60 * 60 * 1000  // 4h

// BKL-TOKEN-07: Adapt parsed PipelineRecord[] back into an SfReportRow shape that
// writePipelineSheet() + parsePipelineRows() both understand. Emits one row per
// product so the downstream round-trip through parsePipelineRows re-aggregates
// products identically. Header set matches the columns parsePipelineRows reads.
function synthesizeSfReportFromPipelineRecords(records: PipelineRecord[]): SfReportRow {
  const headers = [
    'Opportunity ID',
    'Opportunity Number',
    'Opportunity Name',
    'Account Name',
    'Close Date',
    'Forecast Category',
    'ACV Opportunity',
    'Opportunity Owner',
    'Renewal',
    'Offering Group',
    'Probability (%)',
    'Product Description',
    'Opportunity Territory Name',
  ]
  const rows: string[][] = []
  for (const r of records) {
    // Expand each product to its own row (mirrors how scrapeSfReport emits raw SF rows)
    const prods = r.products.length > 0 ? r.products : ['']
    for (const prod of prods) {
      rows.push([
        r.oppId ?? '',
        r.oppNumber ?? '',
        r.oppName ?? '',
        r.accountName ?? '',
        r.closeDate ?? '',
        r.forecastCategory ?? '',
        r.acv != null ? String(r.acv) : '',
        r.owner ?? '',
        r.renewal ? 'true' : 'false',
        r.offeringGroup ?? '',
        r.probability != null ? String(r.probability) : '',
        prod,
        r.territory ?? '',
      ])
    }
  }
  return { headers, rows }
}


/**
 * BKL-SFCACHE-01: Write an SfReportRow to Google Drive as SF-PIPELINE-<reportId>-<pod>-<date>.csv
 * inside the podBookingsFolderId. Mirrors the CCSP Drive cache write pattern:
 *   1. List and delete any existing SF-PIPELINE-<reportId>-<pod>-*.csv for this POD (stale cleanup)
 *   2. Create the new file with today's filename
 * All failures are non-fatal — caller falls through to live scrape on retry.
 */
async function writeSfDriveCache(
  data: SfReportRow,
  podBookingsFolderId: string,
  sfReportId: string,
  podName: string,
  cacheFileName: string,
): Promise<void> {
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    if (!auth) return
    const drive = google.drive({ version: 'v3', auth })

    // Delete stale SF-PIPELINE-<reportId>-<pod>-*.csv files for this POD
    try {
      const staleRes = await withQuotaRetry(
        () => drive.files.list({
          q: `name contains 'SF-PIPELINE-${sfReportId}-${podName}-' and '${podBookingsFolderId}' in parents and trashed = false`,
          fields: 'files(id, name)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
        'SF Drive stale cache list',
      )
      const staleFiles = staleRes.data.files ?? []
      for (const oldFile of staleFiles) {
        if (!oldFile.id || !oldFile.name) continue
        if (!oldFile.name.startsWith(`SF-PIPELINE-${sfReportId}-${podName}-`) || !oldFile.name.endsWith('.csv')) continue
        try {
          await drive.files.delete({ fileId: oldFile.id, supportsAllDrives: true })
          console.log(`[pod-bootstrap] deleted stale SF Drive cache ${oldFile.name}`)
        } catch (delErr: any) {
          console.warn(`[pod-bootstrap] stale SF cache delete failed for ${oldFile.name}: ${delErr.message} — non-fatal`)
        }
      }
    } catch (listErr: any) {
      console.warn(`[pod-bootstrap] stale SF cache list failed: ${listErr.message} — non-fatal, proceeding to write`)
    }

    // Build CSV — escape commas, quotes, newlines same as CCSP writer
    const escape = (val: string): string =>
      val.includes(',') || val.includes('"') || val.includes('\n')
        ? `"${val.replace(/"/g, '""')}"` : val
    const csvLines = [data.headers.map(escape).join(',')]
    for (const row of data.rows) {
      csvLines.push(row.map(c => escape(c ?? '')).join(','))
    }

    await withQuotaRetry(
      () => drive.files.create({
        requestBody: { name: cacheFileName, mimeType: 'text/csv', parents: [podBookingsFolderId] },
        media: { mimeType: 'text/csv', body: csvLines.join('\n') },
        supportsAllDrives: true,
        fields: 'id',
      }),
      'SF Drive cache write',
    )
    console.log(`[pod-bootstrap] SF Drive cache written: ${cacheFileName} (${data.rows.length} rows)`)
  } catch (e: any) {
    console.warn(`[pod-bootstrap] SF Drive cache write failed: ${e?.message} — non-fatal`)
  }
}

/**
 * BKL-SFCACHE-01: Read SF-PIPELINE-<reportId>-<pod>-<today>.csv from podBookingsFolderId.
 * Returns parsed SfReportRow on hit, null on miss or error (non-fatal).
 */
async function readSfDriveCache(
  podBookingsFolderId: string,
  cacheFileName: string,
): Promise<SfReportRow | null> {
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    if (!auth) return null
    const drive = google.drive({ version: 'v3', auth })
    const listRes = await withQuotaRetry(
      () => drive.files.list({
        q: `name = '${cacheFileName}' and '${podBookingsFolderId}' in parents and trashed = false`,
        fields: 'files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      'SF Drive cache check',
    )
    const cacheFile = listRes.data.files?.[0]
    if (!cacheFile?.id) return null
    const dlRes = await withQuotaRetry(
      () => drive.files.get({ fileId: cacheFile.id!, alt: 'media', supportsAllDrives: true }, { responseType: 'text' }),
      'SF Drive cache download',
    )
    const csvText = typeof dlRes.data === 'string' ? dlRes.data : String(dlRes.data)
    const parsed = parseCsvToSfReport(csvText)
    return parsed.rows.length > 0 ? parsed : null
  } catch (e: any) {
    console.warn(`[pod-bootstrap] SF Drive cache read failed: ${e?.message} — non-fatal`)
    return null
  }
}

// ─── BKL-CACHE-HIER-01: 4-level cache hierarchy helpers (CCSP + SF pipeline) ───
// Level 1: on-disk local cache, cachedAt < 24h → use directly (no Drive)
// Level 2: AE Drive sheet (ccspSheetId / pipelineSheetId), modifiedTime < 24h → read rows
// Level 3: Subscription Data folder CSV < 24h (existing scraper paths handle this)
// Level 4: fresh source pull (Tableau for CCSP / Salesforce for SF) — existing paths

/** BKL-CACHE-HIER-01: 24h threshold shared by every Level 1/Level 2 check. */
const CACHE_HIER_FRESH_MS = 24 * 60 * 60 * 1000

/**
 * BKL-CACHE-HIER-01: Level 1 check for SF pipeline — on-disk `pipeline-data.json`
 * is fresh (cachedAt < 24h) AND includes this AE's pipelineSheetId in fileIds.
 * Non-fatal: any failure returns false and the caller falls through.
 */
function isPipelineDiskCacheFreshForAe(pipelineSheetId: string | undefined): boolean {
  if (!pipelineSheetId) return false
  try {
    const cached = readPipelineCache()
    if (!cached?.cachedAt) return false
    const age = Date.now() - new Date(cached.cachedAt).getTime()
    if (!Number.isFinite(age) || age >= CACHE_HIER_FRESH_MS) return false
    const fileIds = cached.fileIds ?? []
    return fileIds.includes(pipelineSheetId)
  } catch {
    return false
  }
}

/**
 * BKL-CACHE-HIER-01: Level 1 check for CCSP — on-disk `ccsp-data.json`
 * is fresh (cachedAt < 24h) AND includes this AE's ccspSheetId in fileIds.
 * Non-fatal: any failure returns false and the caller falls through.
 */
function isCcspDiskCacheFreshForAe(ccspSheetId: string | undefined): boolean {
  if (!ccspSheetId) return false
  try {
    const cached = readCCSPCache()
    if (!cached?.cachedAt) return false
    const age = Date.now() - new Date(cached.cachedAt).getTime()
    if (!Number.isFinite(age) || age >= CACHE_HIER_FRESH_MS) return false
    const fileIds = cached.fileIds ?? []
    return fileIds.includes(ccspSheetId)
  } catch {
    return false
  }
}

/**
 * BKL-CACHE-HIER-01: Level 2 helper — fetch a Drive file's modifiedTime.
 * Uses drive.files.get with fields: 'id,modifiedTime' — the lightest possible call.
 * Returns null on any failure (non-fatal, caller falls through to Level 3).
 */
async function getSheetModifiedTime(sheetId: string): Promise<Date | null> {
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    if (!auth) return null
    const drive = google.drive({ version: 'v3', auth })
    const res = await withQuotaRetry(
      () => drive.files.get({ fileId: sheetId, fields: 'id,modifiedTime', supportsAllDrives: true }),
      'cache-hier modifiedTime',
    )
    const mt = res.data.modifiedTime
    if (!mt) return null
    const d = new Date(mt)
    return isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}

/**
 * BKL-CACHE-HIER-01: Level 2 read for an AE's existing CCSP sheet.
 * The sheet is already parsed + territory-filtered by a prior bootstrap run — no CSV
 * parsing or territory filter needed. Returns rows as Record<string, string>[] matching
 * the shape runCcspScrape() would emit (so downstream writers/normalizers are identical).
 * Returns null on any failure — caller falls through to Level 3 non-fatally.
 */
async function readCcspFromAeSheet(ccspSheetId: string): Promise<Record<string, string>[] | null> {
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    if (!auth) return null
    const sheets = google.sheets({ version: 'v4', auth })
    // CCSP sheet tab is always 'CCSP Data' (writeCcspSheet enforces this).
    const res = await withQuotaRetry(
      () => sheets.spreadsheets.values.get({ spreadsheetId: ccspSheetId, range: `'CCSP Data'!A:AM` }),
      'cache-hier CCSP sheet read',
    )
    const raw = (res.data.values ?? []) as string[][]
    if (raw.length < 2) return null
    const headers = raw[0].map(h => String(h ?? ''))
    const out: Record<string, string>[] = []
    for (let i = 1; i < raw.length; i++) {
      const row = raw[i]
      if (!row || !row.some(v => v != null && String(v).trim() !== '')) continue
      const obj: Record<string, string> = {}
      for (let c = 0; c < headers.length; c++) {
        obj[headers[c]] = String(row[c] ?? '')
      }
      out.push(obj)
    }
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/**
 * BKL-CACHE-HIER-01: Level 2 read for an AE's existing SF Pipeline sheet.
 * The sheet is already parsed from a prior SF report scrape — no browser session
 * needed. Returns data as the SfReportRow shape runSfPipelineSyncFromData expects
 * (headers + rows). Returns null on any failure — caller falls through to Level 3.
 */
async function readPipelineFromAeSheet(pipelineSheetId: string): Promise<SfReportRow | null> {
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    if (!auth) return null
    const sheets = google.sheets({ version: 'v4', auth })
    // SF pipeline scraper always writes to a 'Pipeline' tab (see fetchPipelineData).
    const res = await withQuotaRetry(
      () => sheets.spreadsheets.values.get({ spreadsheetId: pipelineSheetId, range: `'Pipeline'!A1:Z5000` }),
      'cache-hier Pipeline sheet read',
    )
    const raw = (res.data.values ?? []) as string[][]
    if (raw.length < 2) return null
    const headers = raw[0].map(h => String(h ?? ''))
    const rows: string[][] = []
    for (let i = 1; i < raw.length; i++) {
      const row = raw[i]
      if (!row || !row.some(v => v != null && String(v).trim() !== '')) continue
      rows.push(row.map(c => String(c ?? '')))
    }
    return rows.length > 0 ? { headers, rows } : null
  } catch {
    return null
  }
}

/**
 * BKL-INGEST-02: Level 2 read for an AE's existing Supportable (SF Bookings) sheet.
 * The sheet is already parsed + territory-filtered by a prior bootstrap run — no
 * POD-level SF bookings sheet read needed. Reconstructs SupportableResult[] from
 * the sheet's multi-tab structure:
 *   - 'Accounts' tab → customer names + account numbers
 *   - One tab per customer → subscription rows (CSV_HEADERS format)
 * Returns null on any failure — caller falls through to Level 3 (L3 = read the
 * POD-level SF bookings source sheet via fetchSfBookingsRaw).
 */
async function readSfBookingsFromAeSheet(supportableSheetId: string): Promise<import('./supportable-scraper.ts').SupportableResult[] | null> {
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    if (!auth) return null
    const sheetsClient = google.sheets({ version: 'v4', auth })

    // Read Accounts tab — the directory of customers in this sheet.
    const accountsRes = await withQuotaRetry(
      () => sheetsClient.spreadsheets.values.get({ spreadsheetId: supportableSheetId, range: `'Accounts'!A1:C1000` }),
      'cache-hier SF bookings Accounts read',
    )
    const accountsRaw = (accountsRes.data.values ?? []) as string[][]
    if (accountsRaw.length < 2) return null  // header-only or empty

    // Skip header row; row shape is [Account Name, Account ID(s), Alias].
    const accountEntries: Array<{ customerName: string; accountNumbers: string[] }> = []
    for (let i = 1; i < accountsRaw.length; i++) {
      const row = accountsRaw[i] ?? []
      const customerName = String(row[0] ?? '').trim()
      if (!customerName) continue
      const accountNumbers = String(row[1] ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0)
      accountEntries.push({ customerName, accountNumbers })
    }
    if (accountEntries.length === 0) return null

    // Read each customer's subscription tab.
    const results: import('./supportable-scraper.ts').SupportableResult[] = []
    for (const entry of accountEntries) {
      const tab = entry.customerName.slice(0, 100)  // matches writeSupportableSheet tab naming
      // Escape single quotes in tab names for Sheets A1 notation (e.g. "O'Reilly" → "O''Reilly").
      // Without this, the range string `'O'Reilly'!A1:ZZ5000` terminates after the first quote
      // and the API returns a 400 for the malformed range.
      const safeTab = tab.replace(/'/g, "''")
      try {
        const tabRes = await withQuotaRetry(
          () => sheetsClient.spreadsheets.values.get({ spreadsheetId: supportableSheetId, range: `'${safeTab}'!A1:ZZ5000` }),
          `cache-hier SF bookings tab read (${tab})`,
        )
        const tabRaw = (tabRes.data.values ?? []) as string[][]
        if (tabRaw.length < 1) {
          // Tab missing or empty — include customer with no rows so downstream accounting still sees the match.
          results.push({ customerName: entry.customerName, accountNumbers: entry.accountNumbers, rows: [] })
          continue
        }
        const headers = (tabRaw[0] ?? []).map(h => String(h ?? ''))
        const rows: Record<string, string>[] = []
        for (let i = 1; i < tabRaw.length; i++) {
          const row = tabRaw[i] ?? []
          if (!row.some(v => v != null && String(v).trim() !== '')) continue
          const obj: Record<string, string> = {}
          for (let c = 0; c < headers.length; c++) {
            obj[headers[c]] = String(row[c] ?? '')
          }
          rows.push(obj)
        }
        results.push({ customerName: entry.customerName, accountNumbers: entry.accountNumbers, rows })
      } catch (e: any) {
        // Tab read failed (e.g. deleted, quota) — skip this customer, keep the rest.
        console.warn(`[bootstrap] L2 SF bookings read failed for ${tab}: ${sanitizeErr(e)}`)
        results.push({ customerName: entry.customerName, accountNumbers: entry.accountNumbers, rows: [] })
      }
    }
    return results.length > 0 ? results : null
  } catch (e: any) {
    console.warn(`[bootstrap] L2 SF bookings read failed for sheet ${supportableSheetId}: ${sanitizeErr(e)}`)
    return null
  }
}

export function requestPodBootstrapCancel(): boolean {
  if (!podBootstrapState.running) return false
  podBootstrapCancelled = true
  return true
}

/**
 * Read the territory sheet and extract a map of AE name → { territories, customerNames }.
 * Reuses the same parsing logic as territory-sync.ts but returns raw AE-level data
 * rather than a diff against the current customer list.
 */
async function readAEsFromTerritorySheet(
  territorySheetId: string,
  podTabTitle?: string,
): Promise<Array<{ aeName: string; territories: string[]; customerNames: string[] }>> {
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  if (!auth) throw new Error('Google auth not configured')

  const sheetsClient = google.sheets({ version: 'v4', auth })
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: territorySheetId })
  const tabNames = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')

  // When a specific POD tab is requested, skip the corp/commercial pre-filter so
  // enterprise tabs (e.g. "TOLA") are not excluded before the pod-name filter runs.
  const candidateTabs = podTabTitle
    ? tabNames
    : tabNames.filter(t => {
        const lower = t.toLowerCase()
        return (lower.includes('corp') || lower.includes('northwest') || lower.includes('southwest')) &&
               !lower.includes('accounts a')
      })

  // When a POD is selected, restrict to matching tab using word-level match.
  // Accepts either an exact tab name OR a Drive sheet displayName (e.g. "Northwest", "TOLA").
  const filteredTabs = podTabTitle
    ? candidateTabs.filter(t => {
        const words = podTabTitle.toLowerCase().split(/[\W_]+/).filter(w => w.length > 3)
        return t.toLowerCase() === podTabTitle.toLowerCase() ||
               words.every(w => t.toLowerCase().includes(w))
      })
    : candidateTabs

  // Same pod-prefix logic as territory-sync.ts
  const podPrefixFromTab = (tabTitle: string): string => {
    const t = tabTitle.toLowerCase()
    if (t.includes('northwest') || t.includes('nw')) return 'WEST_COMM_CORP_NORTHWEST'
    if (t.includes('southwest') || t.includes('sw')) return 'WEST_COMM_CORP_SOUTHWEST'
    if (t.includes('north central') || t.includes('nc corp')) return 'WEST_COMM_CORP_NORTH_CENTRAL'
    if (t.includes('south central') || t.includes('sc corp')) return 'WEST_COMM_CORP_SOUTH_CENTRAL'
    if (t.includes('tola')) return 'CENTRAL_ENT_TOLA'
    return ''
  }

  // Accumulate per-AE data: name → { territories, customerNames }
  const aeMap = new Map<string, { territories: Set<string>; customerNames: Set<string> }>()

  for (const tabTitle of filteredTabs) {
    const podPrefix = podPrefixFromTab(tabTitle)
    if (!podPrefix) continue

    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: territorySheetId,
      range: `'${tabTitle}'!A1:Z60`,
    })
    const rows: string[][] = (resp.data.values ?? []).map((r: any[]) =>
      r.map((c: any) => String(c ?? '').trim())
    )

    // Find "Account Executive" header row
    let headerRowIdx = -1
    for (let r = 0; r < rows.length; r++) {
      if (rows[r].some(cell => cell === 'Account Executive')) { headerRowIdx = r; break }
    }
    if (headerRowIdx === -1) continue

    const aeNameRowIdx = headerRowIdx + 1
    const accountsStartIdx = aeNameRowIdx + 1
    const headerRow = rows[headerRowIdx] ?? []
    const aeNameRow = rows[aeNameRowIdx] ?? []

    const aeCols = headerRow
      .map((cell, idx) => ({ cell, idx }))
      .filter(({ cell }) => cell === 'Account Executive')
      .map(({ idx }) => idx)

    for (const col of aeCols) {
      const aeCell = aeNameRow[col] ?? ''
      if (!aeCell) continue

      // Extract AE name (first line) and territory code
      const aeName = aeCell.split('\n')[0].trim()
      if (!aeName) continue

      let terrCode = ''
      if (aeCell.includes('\n')) {
        terrCode = aeCell.split('\n')[1].trim()
      } else {
        const terrMatch = aeCell.match(/\bTerr(\d+)\b/i)
        if (terrMatch) terrCode = terrMatch[0]
      }

      const terrNumMatch = terrCode.match(/(\d+)/)
      if (!terrNumMatch) continue
      const terrNum = terrNumMatch[1].padStart(2, '0')
      const tableauTerritory = `${podPrefix}_TERR${terrNum}`

      // Ensure AE entry exists in map
      if (!aeMap.has(aeName)) {
        aeMap.set(aeName, { territories: new Set(), customerNames: new Set() })
      }
      const entry = aeMap.get(aeName)!
      entry.territories.add(tableauTerritory)

      // Extract customer names from column
      for (let r = accountsStartIdx; r < rows.length; r++) {
        const cell = rows[r][col] ?? ''
        if (!cell) continue
        if (/^\d{1,3}$/.test(cell)) break
        if (/^Account\s+S[Aa]/i.test(cell)) break
        if (/^(Support|Partner Sales|\d+ of \d+)$/i.test(cell)) break
        if (/^(Openshift|Ansible|Rhel|Ai)\s+(SSP|SSA)/i.test(cell)) break
        const normalized = normalizeCustomerName(cell)
        if (normalized && !isJunkCustomerName(normalized)) {
          entry.customerNames.add(normalized)
        }
      }
    }
  }

  return Array.from(aeMap.entries()).map(([aeName, data]) => ({
    aeName,
    territories: [...data.territories],
    customerNames: [...data.customerNames],
  }))
}

/**
 * Check if an AE is considered "already bootstrapped" — has all 4 key sheet IDs
 * and a Drive folder.
 */
function isAEFullyBootstrapped(aeConfig: AE): boolean {
  return !!(
    aeConfig.driveFolderId &&
    aeConfig.supportableSheetId &&
    aeConfig.pipelineSheetId &&
    aeConfig.ccspSheetId
  )
}

/**
 * Bootstrap all AEs in the POD sequentially from a territory sheet.
 * Reads the AE list from the territory sheet URL/ID, then calls bootstrapAE() per AE
 * via the internal HTTP endpoint (fire-and-forget + poll pattern).
 *
 * Options:
 *   territorySheetId: the Google Sheet containing the AE list
 *   force: if true, re-bootstrap AEs that already have all 4 sheet IDs (normally skipped)
 *   onProgress: callback called after each AE completes
 */
export async function bootstrapPOD(opts: {
  territorySheetId: string
  sfReportId: string
  parentFolderId: string
  podTabTitle?: string
  force?: boolean
  onProgress?: (info: { aeName: string; index: number; total: number; status: 'skipped' | 'ok' | 'error'; error?: string }) => void
}): Promise<{ succeeded: string[]; skipped: string[]; failed: Array<{ name: string; error: string }> }> {
  const { territorySheetId, sfReportId, parentFolderId, podTabTitle, force = false, onProgress } = opts
  const port = process.env.PORT ?? '7777'
  const baseUrl = `http://localhost:${port}`

  // Step 1: Read territory sheet to discover AEs + their customer lists
  console.log(`[pod-bootstrap] Reading territory sheet ${territorySheetId}…`)
  const aeEntries = await readAEsFromTerritorySheet(territorySheetId, podTabTitle)
  if (aeEntries.length === 0) {
    throw new Error('No AEs found in territory sheet — check that the sheet has "Account Executive" header rows')
  }
  console.log(`[pod-bootstrap] Found ${aeEntries.length} AEs in territory sheet: ${aeEntries.map(a => a.aeName).join(', ')}`)
  // Persist POD config so it survives server restarts and can seed future re-runs
  savePodConfig({ territorySheetId, sfReportId, parentFolderId, podTabTitle })

  // BKL-DRIVE-SCAFFOLD-01: Idempotently scaffold Config/ and Products/<slug> under parentFolderId.
  // Runs once per POD bootstrap, before per-AE Drive folder creation. Non-fatal.
  const scaffoldResult = await ensureConfigAndProductsScaffold(parentFolderId)

  // BKL-BACKUP-01 / BKL-DRIVE-APPBACKUP-01: Create config backup sheet in Config/ subfolder.
  // Fall back to parentFolderId if scaffold didn't run (no auth, existing install, etc.)
  const backupTargetFolder = scaffoldResult?.configFolderId ?? parentFolderId
  if (!getBackupSheetId() && parentFolderId) {
    try {
      const backupId = await createBackupSheet(backupTargetFolder)
      setBackupSheetId(backupId)
      console.log(`[backup] Config Backup sheet created: ${backupId}`)
    } catch (e: any) {
      console.warn('[backup] Could not create backup sheet during bootstrap:', e.message)
    }
  }

  const succeeded: string[] = []
  const skipped: string[] = []
  const failed: Array<{ name: string; error: string }> = []

  // Initialize POD bootstrap state for status endpoint
  const podStartedAt = new Date().toISOString()
  podBootstrapState = {
    running: true,
    total: aeEntries.length,
    completed: 0,
    currentAE: null,
    results: aeEntries.map(e => ({ name: e.aeName, status: 'pending' as const })),
    startedAt: podStartedAt,
    completedAt: null,
    error: null,
  }

  // Dynamic timeout: 30 min per AE
  const podTimeoutMs = aeEntries.length * 30 * 60 * 1000
  const podTimeoutId = setTimeout(() => {
    if (podBootstrapState.running) {
      podBootstrapState.running = false
      podBootstrapState.completedAt = new Date().toISOString()
      podBootstrapState.error = `POD bootstrap timed out after ${Math.round(podTimeoutMs / 60000)} minutes`
      console.error(`[pod-bootstrap] Hard timeout reached (${Math.round(podTimeoutMs / 60000)} min)`)
    }
  }, podTimeoutMs)

  // BKL-WIZ-02: Reset cancellation flag at start
  podBootstrapCancelled = false

  // ─── BKL-CACHE-HIER-01: 4-level cache hierarchy probe (per AE) ───────────────
  // Before the shared SF pre-scrape + per-AE CCSP scrape, log which cache level
  // each AE can satisfy. Opportunistically populate podSfDataCache from any AE
  // whose Pipeline sheet is fresh (L2) so the subsequent pre-scrape block can
  // skip the live SF scrape entirely.
  // L1 = on-disk pipeline/ccsp cache cachedAt<24h
  // L2 = AE Drive sheet modifiedTime<24h (already parsed + per-AE)
  // L3 = Subscription Data folder CSV <24h (handled inside scrapeOneAe / SF Drive cache)
  // L4 = live Tableau/SF scrape
  for (const preEntry of aeEntries) {
    const preAe = aes.find(a => a.name === preEntry.aeName)
    const ccspSheetId = preAe?.ccspSheetId
    const pipelineSheetId = preAe?.pipelineSheetId

    // -- SF pipeline probe --------------------------------------------------
    if (isPipelineDiskCacheFreshForAe(pipelineSheetId)) {
      console.log(`[bootstrap] ${preEntry.aeName}: SF cache L1 hit (disk)`)
      emitCacheLevel({ ae: preEntry.aeName, flow: 'sfPipeline', level: 1 })
    } else if (pipelineSheetId) {
      const sfMt = await getSheetModifiedTime(pipelineSheetId)
      const sfFresh = sfMt ? (Date.now() - sfMt.getTime()) < CACHE_HIER_FRESH_MS : false
      if (sfFresh) {
        console.log(`[bootstrap] ${preEntry.aeName}: SF cache L2 hit (AE sheet)`)
        emitCacheLevel({ ae: preEntry.aeName, flow: 'sfPipeline', level: 2 })
        // Opportunistically warm podSfDataCache if empty/stale — skips pre-scrape below.
        if (!podSfDataCache || podSfDataCache.reportId !== sfReportId || Date.now() > podSfDataCache.expiresAt) {
          const sheetData = await readPipelineFromAeSheet(pipelineSheetId)
          if (sheetData && sheetData.rows.length > 0) {
            podSfDataCache = { reportId: sfReportId, data: sheetData, expiresAt: Date.now() + POD_SF_CACHE_TTL_MS }
            console.log(`[bootstrap] ${preEntry.aeName}: SF L2 populated podSfDataCache — ${sheetData.rows.length} rows`)
          }
        }
      } else {
        console.log(`[bootstrap] ${preEntry.aeName}: SF cache L3 candidate (Subscription Data CSV) / L4 fresh scrape`)
      }
    } else {
      console.log(`[bootstrap] ${preEntry.aeName}: SF cache L3 candidate (Subscription Data CSV) / L4 fresh scrape`)
    }

    // -- CCSP probe ---------------------------------------------------------
    if (isCcspDiskCacheFreshForAe(ccspSheetId)) {
      console.log(`[bootstrap] ${preEntry.aeName}: CCSP cache L1 hit (disk)`)
      emitCacheLevel({ ae: preEntry.aeName, flow: 'ccsp', level: 1 })
    } else if (ccspSheetId) {
      const ccspMt = await getSheetModifiedTime(ccspSheetId)
      const ccspFresh = ccspMt ? (Date.now() - ccspMt.getTime()) < CACHE_HIER_FRESH_MS : false
      if (ccspFresh) {
        console.log(`[bootstrap] ${preEntry.aeName}: CCSP cache L2 hit (AE sheet)`)
        emitCacheLevel({ ae: preEntry.aeName, flow: 'ccsp', level: 2 })
      } else {
        console.log(`[bootstrap] ${preEntry.aeName}: CCSP cache L3 candidate (Subscription Data CSV) / L4 fresh scrape`)
      }
    } else {
      console.log(`[bootstrap] ${preEntry.aeName}: CCSP cache L3 candidate (Subscription Data CSV) / L4 fresh scrape`)
    }
  }

  // BKL-PERF-01: Pre-scrape SF report once for all AEs — avoids N redundant browser sessions
  if (!podSfDataCache || podSfDataCache.reportId !== sfReportId || Date.now() > podSfDataCache.expiresAt) {
    // BKL-SFCACHE-01: Resolve podBookingsFolderId + podName for Drive-backed SF pipeline cache.
    // Mirrors the CCSP Drive cache pattern: 24h TTL keyed by SF-PIPELINE-<reportId>-<pod>-<date>.csv.
    // Non-fatal — any Drive failure falls through to the disk pipeline cache + live scrape.
    let podBookingsFolderId = ''
    let podName = ''
    try {
      const firstTerritory = aeEntries.find(e => e.territories.length > 0)?.territories[0]
      if (firstTerritory) podName = parseTerritoryParts(firstTerritory).pod
      const rawSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
      const normalized = normalizeSettings(rawSettings)
      const podKey = firstTerritory?.replace(/_TERR\d+$/, '')
      const region = podKey
        ? (normalized.regions.find(r => podKey in r.pods) ?? normalized.regions[0])
        : normalized.regions[0]
      podBookingsFolderId = region?.podBookingsFolderId ?? ''
    } catch { /* no settings — skip Drive cache, fall through to disk + scrape */ }

    const today = new Date().toISOString().slice(0, 10)
    const sfCacheFileName = podName ? `SF-PIPELINE-${sfReportId}-${podName}-${today}.csv` : ''

    // BKL-SFCACHE-01: Drive cache read — skip scrape entirely if today's SF-PIPELINE CSV exists.
    let driveSfData: SfReportRow | null = null
    if (podBookingsFolderId && sfCacheFileName) {
      driveSfData = await readSfDriveCache(podBookingsFolderId, sfCacheFileName)
      if (driveSfData) {
        console.log(`[pod-bootstrap] SF Drive cache hit — ${driveSfData.rows.length} rows from ${sfCacheFileName}`)
      }
    }

    if (driveSfData) {
      podSfDataCache = { reportId: sfReportId, data: driveSfData, expiresAt: Date.now() + POD_SF_CACHE_TTL_MS }
    } else {
      // BKL-TOKEN-07: Check disk pipeline cache before the live SF scrape. If a recent
      // parse exists (<4h), synthesize an SfReportRow from it and skip the browser-driven
      // scrape entirely. Saves one expensive SF browser session per POD bootstrap run.
      const diskPipeline = readPipelineCache()
      const diskPipelineAgeMs = diskPipeline?.cachedAt
        ? Date.now() - new Date(diskPipeline.cachedAt).getTime()
        : Infinity

      if (diskPipelineAgeMs < PIPELINE_DISK_TTL_MS && diskPipeline?.records?.length) {
        const synthesized = synthesizeSfReportFromPipelineRecords(diskPipeline.records)
        podSfDataCache = { reportId: sfReportId, data: synthesized, expiresAt: Date.now() + POD_SF_CACHE_TTL_MS }
        console.log(
          `[pod-bootstrap] Reusing disk pipeline cache (${diskPipeline.records.length} records, ` +
          `${Math.round(diskPipelineAgeMs / 60000)}m old) — skipping live SF scrape ` +
          `(synthesized ${synthesized.rows.length} rows for ${aeEntries.length} AEs)`,
        )
      } else {
        console.log(`[pod-bootstrap] Pre-scraping SF report ${sfReportId} for ${aeEntries.length} AEs…`)
        try {
          const data = await scrapeSfReport(sfReportId, RH_PROFILE_DIR)
          podSfDataCache = { reportId: sfReportId, data, expiresAt: Date.now() + POD_SF_CACHE_TTL_MS }
          console.log(`[pod-bootstrap] SF report cached: ${data.rows.length} rows`)
          // BKL-SFCACHE-01: Write Drive cache so next bootstrap within 24h skips the browser scrape
          if (podBookingsFolderId && sfCacheFileName && data.rows.length > 0) {
            await writeSfDriveCache(data, podBookingsFolderId, sfReportId, podName, sfCacheFileName)
          }
        } catch (e: any) {
          console.warn(`[pod-bootstrap] SF pre-scrape failed — each AE will scrape individually: ${e?.message}`)
          podSfDataCache = null
        }
      }
    }
  } else {
    console.log(`[pod-bootstrap] Reusing cached SF report data (${aeEntries.length} AEs)`)
  }

  // Step 2: Sequential bootstrap per AE
  for (let i = 0; i < aeEntries.length; i++) {
    if (!podBootstrapState.running) break  // timeout triggered
    // BKL-WIZ-02: Check cancellation between AE steps
    if (podBootstrapCancelled) {
      console.log(`[pod-bootstrap] Cancelled by user after ${i} AE(s)`)
      podBootstrapState.error = `Cancelled by user after ${i} AE(s) completed`
      // Mark remaining AEs as skipped
      for (let j = i; j < aeEntries.length; j++) {
        if (podBootstrapState.results[j].status === 'pending') {
          podBootstrapState.results[j] = { name: aeEntries[j].aeName, status: 'skipped' }
        }
      }
      break
    }

    const entry = aeEntries[i]
    const { aeName, territories, customerNames } = entry

    podBootstrapState.currentAE = aeName
    const aeStartMs = Date.now()
    podBootstrapState.results[i] = { ...podBootstrapState.results[i], startedAt: new Date().toISOString() }

    // Check if AE exists in aes.json with required config
    let aeConfig = aes.find(a => a.name === aeName)

    // Idempotency: skip if already fully bootstrapped (unless force)
    if (aeConfig && isAEFullyBootstrapped(aeConfig) && !force) {
      console.log(`[pod-bootstrap] Skipping ${aeName} — already fully bootstrapped`)
      skipped.push(aeName)
      podBootstrapState.results[i] = { name: aeName, status: 'skipped' }
      podBootstrapState.completed++
      onProgress?.({ aeName, index: i, total: aeEntries.length, status: 'skipped' })
      continue
    }

    // Create or update AE in aes.json using POD-level sfReportId + parentFolderId
    // REG-CONN-02: pod config is always source of truth — always write sfReportId
    // regardless of whether the AE already has one. The old `else if (!aeConfig.sfReportId)`
    // guard prevented correcting wrong report IDs on existing AEs.
    if (!aeConfig) {
      const newAe = { name: aeName, driveFolderId: '', sfReportId, tableauTerritories: territories, parentFolderId }
      saveAes([...aes, newAe])
      aeConfig = aes.find(a => a.name === aeName)!
      console.log(`[pod-bootstrap] Created new AE entry for ${aeName}`)
    } else {
      const updated = aes.map(a => a.name === aeName ? { ...a, sfReportId, parentFolderId } : a)
      saveAes(updated)
      aeConfig = aes.find(a => a.name === aeName)!
      console.log(`[pod-bootstrap] Updated sfReportId for ${aeName}`)
    }

    // Wait for any in-progress single-AE bootstrap to finish before starting the next.
    // BKL-DOM-INF-01: also wait on the post-bootstrap domain inference IIFE — it mutates
    // customers.json and would race with the next AE's bootstrap if we let it overlap.
    while (autoBootstrapState.running || inferenceRunning) {
      await new Promise(r => setTimeout(r, 3000))
    }

    // Fire the bootstrap for this AE via internal endpoint
    console.log(`[pod-bootstrap] Starting bootstrap for ${aeName} (${i + 1}/${aeEntries.length})…`)
    try {
      const MAX_409_RETRIES = 3
      let startRes: Response | null = null
      for (let attempt = 1; attempt <= MAX_409_RETRIES; attempt++) {
        startRes = await fetch(`${baseUrl}/api/bootstrap/auto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            aeName,
            sfReportId: aeConfig.sfReportId,
            tableauTerritories: territories.length > 0 ? territories : aeConfig.tableauTerritories,
            customerNames,
            parentFolderId: aeConfig.parentFolderId,
          }),
        })

        if (startRes.status === 409 && attempt < MAX_409_RETRIES) {
          console.log(`[bootstrap] 409 — scraper busy, waiting 30s (attempt ${attempt}/${MAX_409_RETRIES})`)
          await new Promise(r => setTimeout(r, 30_000))
          continue
        }
        break
      }

      if (!startRes!.ok) {
        const body = await startRes!.json().catch(() => ({ error: `HTTP ${startRes!.status}` }))
        throw new Error((body as any).error ?? `Bootstrap start failed: HTTP ${startRes!.status}`)
      }

      // Poll until this AE's bootstrap completes
      // BKL-POD-02: 30 min per AE (was 15) — AEs with 10+ accounts need more time
      const perAeTimeoutMs = 30 * 60 * 1000
      const deadline = Date.now() + perAeTimeoutMs
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5000))
        if (!autoBootstrapState.running) break
      }

      if (autoBootstrapState.running) {
        // Still running after per-AE timeout — force-reset and record error
        autoBootstrapState.running = false
        autoBootstrapState.completedAt = new Date().toISOString()
        autoBootstrapState.error = `Timed out after ${Math.round(perAeTimeoutMs / 60000)} minutes (POD bootstrap)`
        throw new Error(`Bootstrap for ${aeName} timed out after ${Math.round(perAeTimeoutMs / 60000)} minutes`)
      }

      // Check if bootstrap had errors
      if (autoBootstrapState.error) {
        const err = autoBootstrapState.error
        console.warn(`[pod-bootstrap] ${aeName} completed with error: ${err}`)
        // Still count as succeeded if some steps completed — error might be non-fatal
        const hasAnySheet = !!(aes.find(a => a.name === aeName)?.supportableSheetId ||
                              aes.find(a => a.name === aeName)?.pipelineSheetId ||
                              aes.find(a => a.name === aeName)?.ccspSheetId)
        if (hasAnySheet) {
          succeeded.push(aeName)
          const aeCustomerCount = customers.filter(c => c.ae === aeName).length
          podBootstrapState.results[i] = { name: aeName, status: 'ok', customerCount: aeCustomerCount }
        } else {
          failed.push({ name: aeName, error: err })
          podBootstrapState.results[i] = { name: aeName, status: 'error', error: err }
        }
      } else {
        succeeded.push(aeName)
        const aeCustomerCount = customers.filter(c => c.ae === aeName).length
        podBootstrapState.results[i] = { name: aeName, status: 'ok', customerCount: aeCustomerCount }
        console.log(`[pod-bootstrap] ${aeName} bootstrap complete (${aeCustomerCount} customers)`)
      }
    } catch (e: any) {
      const err = e?.message ?? String(e)
      console.error(`[pod-bootstrap] ${aeName} failed: ${err}`)
      failed.push({ name: aeName, error: err })
      podBootstrapState.results[i] = { name: aeName, status: 'error', error: err }
    }

    const aeDurationMs = Date.now() - aeStartMs
    podBootstrapState.results[i] = {
      ...podBootstrapState.results[i],
      completedAt: new Date().toISOString(),
      durationMs: aeDurationMs,
    }
    podBootstrapState.completed++
    onProgress?.({
      aeName,
      index: i,
      total: aeEntries.length,
      status: podBootstrapState.results[i].status === 'ok' ? 'ok' : podBootstrapState.results[i].status === 'skipped' ? 'skipped' : 'error',
      error: podBootstrapState.results[i].error,
    })
  }

  // Step 3: Auto-retry pass for AEs with zero customers (one retry only)
  // Note: accountNumbers are populated by the RH scraper separately — not during bootstrap.
  // Only retry if no customers were discovered at all (SF sheet returned nothing).
  const zeroAccountAEs = succeeded.filter(aeName => {
    const aeCustomers = customers.filter(c => c.ae === aeName)
    return aeCustomers.length === 0
  })

  if (zeroAccountAEs.length > 0 && podBootstrapState.running) {
    console.log(`[pod-bootstrap] Auto-retry: ${zeroAccountAEs.length} AE(s) with zero accounts: ${zeroAccountAEs.join(', ')}`)

    for (const aeName of zeroAccountAEs) {
      if (!podBootstrapState.running) break

      const idx = aeEntries.findIndex(e => e.aeName === aeName)
      if (idx >= 0) podBootstrapState.results[idx] = { name: aeName, status: 'retrying' }
      podBootstrapState.currentAE = `${aeName} (retry)`

      const entry = aeEntries.find(e => e.aeName === aeName)
      const aeConfig = aes.find(a => a.name === aeName)
      if (!entry || !aeConfig?.sfReportId) continue

      // Wait for any in-progress bootstrap
      while (autoBootstrapState.running) {
        await new Promise(r => setTimeout(r, 3000))
      }

      try {
        console.log(`[pod-bootstrap] Retrying bootstrap for ${aeName}…`)
        const startRes = await fetch(`${baseUrl}/api/bootstrap/auto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            aeName,
            sfReportId: aeConfig.sfReportId,
            tableauTerritories: entry.territories.length > 0 ? entry.territories : aeConfig.tableauTerritories,
            customerNames: entry.customerNames,
            parentFolderId: aeConfig.parentFolderId,
          }),
        })

        if (!startRes.ok) {
          console.warn(`[pod-bootstrap] Retry for ${aeName} failed to start`)
          continue
        }

        const deadline = Date.now() + 30 * 60 * 1000
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 5000))
          if (!autoBootstrapState.running) break
        }

        const retryCustomerCount = customers.filter(c => c.ae === aeName).length
        if (idx >= 0) {
          podBootstrapState.results[idx] = {
            name: aeName,
            status: retryCustomerCount > 0 ? 'ok' : 'error',
            customerCount: retryCustomerCount,
            error: retryCustomerCount === 0 ? 'Zero customers after retry' : undefined,
          }
        }
        console.log(`[pod-bootstrap] Retry for ${aeName}: ${retryCustomerCount} customers`)
      } catch (e: any) {
        console.warn(`[pod-bootstrap] Retry for ${aeName} failed: ${e?.message}`)
        if (idx >= 0) {
          podBootstrapState.results[idx] = { name: aeName, status: 'error', error: `Retry failed: ${e?.message}` }
        }
      }
    }
  }

  clearTimeout(podTimeoutId)
  const podTotalMs = Date.now() - new Date(podStartedAt).getTime()
  podBootstrapState.running = false
  podBootstrapState.currentAE = null
  podBootstrapState.completedAt = new Date().toISOString()
  podBootstrapState.totalDurationMs = podTotalMs
  console.log(`[pod-bootstrap] Complete: ${succeeded.length} succeeded, ${skipped.length} skipped, ${failed.length} failed — total ${Math.round(podTotalMs / 60000)}min`)

  // BKL-TOKEN-03: Fire intelligence + brief pregen ONCE after the full AE loop completes.
  // Previously these fired from the per-AE /api/bootstrap/auto handler, so a POD with N AEs
  // triggered N pregen batches (each rescanning every customer). Now a single POD bootstrap
  // runs one pregen pass for all newly-bootstrapped customers.
  if (succeeded.length > 0) {
    if (getAiConfig().intelligenceEnabled) {
      fetch(`${baseUrl}/api/intelligence/generate-all`, { method: 'POST' })
        .then(r => console.log(`[pod-bootstrap] intelligence batch started: ${r.status}`))
        .catch(e => console.warn('[pod-bootstrap] intelligence batch trigger failed:', e?.message))
    } else {
      console.log('[pod-bootstrap] intelligence generation skipped — intelligenceEnabled=false')
    }

    fetch(`${baseUrl}/api/briefs/pregen-all`, { method: 'POST' })
      .then(r => r.json())
      .then((d: any) => console.log(`[pod-bootstrap] brief pregen triggered: ${d?.message ?? 'ok'}`))
      .catch(e => console.warn('[pod-bootstrap] brief pregen trigger failed:', e?.message))
  }

  // BKL-BOOT-SCRAPE-ORDER-01: RH Cases is scheduled-only — it runs on its own timer
  // (background-scheduler), not during bootstrap. Triggering it here previously raced
  // SF/CCSP scrapes on the shared Chromium context. Account discovery and case fetch
  // will happen at the next scheduled RH cases run.
  // (Previously BKL-BOOT-06 / BKL-BOOT-07 enqueued two passes here — removed.)

  return { succeeded, skipped, failed }
}

// ── Tableau constant ─────────────────────────────────────────────────────────
const TABLEAU_URL = 'https://10ay.online.tableau.com/#/site/redhatanalytics/views/OverallCloudConsumptionDashboard/CloudConsumption'

// startAccountDiscovery() removed — account discovery now handled by RH Cases scraper
// (runRhScrapeWithState in scraper-manager.ts searches by customer name when accountNumbers is empty)

// ── Route registration ───────────────────────────────────────────────────────

export function registerBootstrapRoutes(app: Hono): void {

  app.get('/api/bootstrap/auto/status', (c) => {
    const sanitizeDetail = (s: string | null | undefined) =>
      s ? s.slice(0, 200).replace(/\/[^\s:]+\.(ts|js)/g, '[file]') : s
    const sanitized: Record<string, unknown> = {
      ...autoBootstrapState,
      error: sanitizeDetail(autoBootstrapState.error),
      steps: autoBootstrapState.steps.map(step => ({
        ...step,
        detail: sanitizeDetail(step.detail),
      })),
    }
    // Phase 3: Include POD bootstrap progress when a POD bootstrap is running or recently completed
    if (podBootstrapState.running || podBootstrapState.completedAt) {
      sanitized.podBootstrap = {
        running: podBootstrapState.running,
        total: podBootstrapState.total,
        completed: podBootstrapState.completed,
        currentAE: podBootstrapState.currentAE,
        startedAt: podBootstrapState.startedAt,
        completedAt: podBootstrapState.completedAt,
        totalDurationMs: podBootstrapState.totalDurationMs,
        results: podBootstrapState.results.map(r => ({
          name: r.name,
          status: r.status,
          ...(r.error ? { error: sanitizeDetail(r.error) } : {}),
          ...(r.customerCount !== undefined ? { customerCount: r.customerCount } : {}),
          ...(r.startedAt ? { startedAt: r.startedAt } : {}),
          ...(r.completedAt ? { completedAt: r.completedAt } : {}),
          ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
        })),
        error: sanitizeDetail(podBootstrapState.error),
      }
    }
    return c.json(sanitized)
  })

  // BKL-WIZ-02: POST /api/bootstrap/cancel — request cancellation of a running POD bootstrap
  app.post('/api/bootstrap/cancel', (c) => {
    const cancelled = requestPodBootstrapCancel()
    if (!cancelled) {
      return c.json({ ok: false, error: 'No POD bootstrap is currently running' }, 400)
    }
    console.log('[pod-bootstrap] Cancellation requested by user')
    return c.json({ ok: true })
  })

  // POST /api/bootstrap/auto/reset — clear a stuck bootstrap state
  app.post('/api/bootstrap/auto/reset', (c) => {
    autoBootstrapState = { running: false, steps: [], aeName: '', completedAt: null, error: null, resources: {} }
    autoBootstrapCancelRequested = false
    podBootstrapState = { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null }
    console.log('[auto-bootstrap] State reset by user request')
    return c.json({ ok: true })
  })

  // BKL-WIZ-02: POST /api/bootstrap/auto/cancel — request graceful cancellation of single-AE bootstrap
  app.post('/api/bootstrap/auto/cancel', (c) => {
    if (!autoBootstrapState.running) {
      return c.json({ error: 'No single-AE bootstrap is currently running' }, 400)
    }
    autoBootstrapCancelRequested = true
    console.log('[auto-bootstrap] Cancellation requested by user')
    return c.json({ ok: true, message: 'Cancellation requested — bootstrap will stop after the current step' })
  })

  // GET /api/bootstrap/pod/tabs — List corp tabs from a territory sheet
  app.get('/api/bootstrap/pod/tabs', async (c) => {
    const rawSheetId = (c.req.query('sheetId') ?? '').trim()
    const urlMatch = rawSheetId.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{10,})/)
    const sheetId = urlMatch ? urlMatch[1] : rawSheetId
    if (!sheetId || !/^[a-zA-Z0-9_-]{10,}$/.test(sheetId)) {
      return c.json({ error: 'sheetId query parameter is required' }, 400)
    }
    try {
      const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
      if (!auth) return c.json({ error: 'Google auth not configured' }, 500)
      const sheetsClient = google.sheets({ version: 'v4', auth })
      const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: sheetId })
      const tabNames = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')
      const tabs = tabNames.filter(t => {
        const lower = t.toLowerCase()
        return (lower.includes('corp') || lower.includes('northwest') || lower.includes('southwest')) &&
               !lower.includes('accounts a')
      })
      return c.json({ tabs })
    } catch (e: any) {
      console.error(`[pod-tabs] Error reading sheet ${sheetId}: ${e?.message ?? e}`)
      // Fallback: if we have a saved POD config with a tab title, return it as a cached hint
      const savedCfg = readPodConfig()
      if (savedCfg?.podTabTitle) {
        console.log(`[pod-tabs] Returning cached tab from saved POD config: ${savedCfg.podTabTitle}`)
        return c.json({ tabs: [savedCfg.podTabTitle], fromCache: true })
      }
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/bootstrap/pod/config — Return last saved POD bootstrap config
  app.get('/api/bootstrap/pod/config', (c) => {
    const cfg = readPodConfig()
    if (!cfg) return c.json({ config: null })
    return c.json({ config: cfg })
  })

  // POST /api/bootstrap/pod — Bootstrap all AEs in the POD from a territory sheet
  // Fire-and-forget: returns immediately, poll /api/bootstrap/auto/status for progress
  app.post('/api/bootstrap/pod', async (c) => {
    if (autoBootstrapState.running || podBootstrapState.running) {
      return c.json({ error: 'A bootstrap is already in progress' }, 409)
    }

    // Claim the lock SYNCHRONOUSLY before the first `await` (c.req.json yields the event loop).
    // Without this, two simultaneous POSTs both pass the guard above, then both set running=true
    // after the await — a TOCTOU race. Claiming here with total:0/results:[] is an "initializing"
    // marker; bootstrapPOD() overwrites these fields once it reads the territory sheet.
    podBootstrapState = { running: true, total: 0, completed: 0, currentAE: null, results: [], startedAt: new Date().toISOString(), completedAt: null, error: null }

    const body = await c.req.json<{ territorySheetId?: string; sfReportId?: string; parentFolderId?: string; podTabTitle?: string; force?: boolean }>().catch(() => ({} as { territorySheetId?: string; sfReportId?: string; parentFolderId?: string; podTabTitle?: string; force?: boolean }))
    const rawTerritorySheet = (body.territorySheetId ?? '').trim()
    // Accept full Google Sheets URL — extract bare sheet ID
    const territorySheetId = rawTerritorySheet.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{44})/)?.[1] ?? rawTerritorySheet
    const rawSfReportId = (body.sfReportId ?? '').trim()
    const sfReportId = rawSfReportId ? extractSfReportId(rawSfReportId) : ''
    const rawParent = (body.parentFolderId ?? '').trim()
    const parentFolderId = rawParent
      ? (rawParent.match(/\/folders\/([a-zA-Z0-9_-]{20,})/)?.[1] ?? rawParent)
      : ''

    if (!territorySheetId) {
      podBootstrapState = { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null }
      return c.json({ error: 'territorySheetId is required' }, 400)
    }
    // Validate sheet ID format (alphanumeric + hyphens + underscores, typical Google Sheet IDs)
    if (!/^[a-zA-Z0-9_-]{44}$/.test(territorySheetId)) {
      podBootstrapState = { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null }
      return c.json({ error: 'Invalid territorySheetId format' }, 400)
    }
    if (!sfReportId || !isValidSfId(sfReportId)) {
      podBootstrapState = { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null }
      return c.json({ error: 'sfReportId is required — provide a Salesforce report URL or bare ID' }, 400)
    }
    if (!parentFolderId || !/^[a-zA-Z0-9_-]{10,}$/.test(parentFolderId)) {
      podBootstrapState = { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null }
      return c.json({ error: 'parentFolderId is required — provide a Google Drive folder URL or bare ID' }, 400)
    }

    const podTabTitle = (body.podTabTitle ?? '').trim() || undefined
    const force = body.force === true

    // Run async — fire-and-forget
    bootstrapPOD({
      territorySheetId,
      sfReportId,
      parentFolderId,
      podTabTitle,
      force,
      onProgress: (info) => {
        console.log(`[pod-bootstrap] Progress: ${info.aeName} (${info.index + 1}/${info.total}) — ${info.status}${info.error ? ': ' + info.error : ''}`)
      },
    }).then(result => {
      console.log(`[pod-bootstrap] Final: ${result.succeeded.length} succeeded, ${result.skipped.length} skipped, ${result.failed.length} failed`)
    }).catch(e => {
      console.error(`[pod-bootstrap] Fatal error: ${e?.message ?? e}`)
      podBootstrapState.running = false
      podBootstrapState.error = `Fatal: ${e?.message ?? e}`
      podBootstrapState.completedAt = new Date().toISOString()
    })

    return c.json({ ok: true, message: `POD bootstrap started — poll /api/bootstrap/auto/status for progress` })
  })

  // POST /api/oauth/dismiss-downgrade — user has seen the reduce-permissions banner
  app.post('/api/oauth/dismiss-downgrade', (c) => {
    try {
      writeFileSyncRaw(OAUTH_STATE_PATH, JSON.stringify({ pendingDowngrade: false, dismissedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
    } catch (e: any) { console.warn('[oauth] dismiss write failed:', e.message) }
    return c.json({ ok: true })
  })

  app.post('/api/bootstrap/auto', async (c) => {
    // BKL-DOM-INF-01: include inferenceRunning so a follow-up POD AE bootstrap can't
    // start while the previous AE's domain inference is still mutating customers.json.
    if (autoBootstrapState.running || inferenceRunning) return c.json({ error: 'Auto-bootstrap already in progress' }, 409)

    const body = await c.req.json<{
      aeName?: string
      sfReportId?: string
      tableauTerritories?: string[]
      customerNames?: string[]
      parentFolderId?: string
      podName?: string  // BKL-DRIVE-01: optional POD display name for subfolder hierarchy
    }>().catch(() => ({} as { aeName?: string; sfReportId?: string; tableauTerritories?: string[]; customerNames?: string[]; parentFolderId?: string; podName?: string }))

    const aeName = (body.aeName ?? '').trim()
    // BKL-F07: Accept full Salesforce URLs — extract bare ID
    const sfReportId = extractSfReportId(body.sfReportId ?? '')
    const tableauTerritories = body.tableauTerritories ?? []
    const allCustomerNames = (body.customerNames ?? []).map(n => normalizeCustomerName(n)).filter(Boolean)
    const junkFiltered = allCustomerNames.filter(n => isJunkCustomerName(n))
    const customerNames = allCustomerNames.filter(n => !isJunkCustomerName(n))
    if (junkFiltered.length > 0) {
      console.log(`[auto-bootstrap] Filtered ${junkFiltered.length} junk name(s) from territory sheet: ${junkFiltered.join(', ')}`)
    }
    // BKL-DRIVE-01: optional POD display name for subfolder hierarchy
    const podName = (body.podName ?? '').trim() || undefined
    // Accept full Drive URL or bare folder ID — extract ID from URL if needed
    const rawParent = (body.parentFolderId ?? '').trim()
    const parentFolderId = rawParent
      ? (rawParent.match(/\/folders\/([a-zA-Z0-9_-]{20,})/)?.[1] ?? rawParent)
      : undefined

    if (!aeName) return c.json({ error: 'aeName is required' }, 400)
    if (aeName.length > 200) return c.json({ error: 'aeName exceeds 200 characters' }, 400)
    if (/<[^>]*>/.test(aeName)) return c.json({ error: 'aeName contains invalid characters' }, 400)
    if (!sfReportId) return c.json({ error: 'sfReportId is required' }, 400)
    if (!isValidSfId(sfReportId)) return c.json({ error: 'sfReportId must be a valid Salesforce report URL or 15-18 character ID' }, 400)
    if (!tableauTerritories.length) return c.json({ error: 'tableauTerritories is required' }, 400)
    if (!customerNames.length) {
      // Distinguish between empty input and fully-filtered junk input
      if (junkFiltered.length > 0 && allCustomerNames.length > 0) {
        return c.json({ error: `customerNames contains invalid characters — only letters, numbers, spaces, and basic punctuation allowed (${junkFiltered.length} names filtered)` }, 400)
      }
      return c.json({ error: 'customerNames is required' }, 400)
    }
    if (customerNames.some(n => /<[^>]*>/.test(n))) return c.json({ error: 'customerNames contains invalid characters' }, 400)
    if (parentFolderId && !/^[a-zA-Z0-9_-]{10,}$/.test(parentFolderId)) return c.json({ error: 'Invalid parentFolderId format' }, 400)

    // Upsert AE into aes.json immediately with basic fields
    let aeConfig = aes.find(a => a.name === aeName)
    if (!aeConfig) {
      aeConfig = { name: aeName, driveFolderId: '', sfReportId, tableauTerritories, ...(parentFolderId ? { parentFolderId } : {}) }
      saveAes([...aes, aeConfig])
    } else {
      const updated = aes.map(a => a.name === aeName ? { ...a, sfReportId, tableauTerritories, ...(parentFolderId ? { parentFolderId } : {}) } : a)
      saveAes(updated)
      aeConfig = aes.find(a => a.name === aeName)!
    }

    // BKL-WIZ-02: Reset cancellation flag at the start of each new bootstrap run
    autoBootstrapCancelRequested = false

    autoBootstrapState = {
      running: true,
      aeName,
      steps: [
        { name: 'Create Drive Folder', status: 'pending' },
        { name: 'Create Customer Folders', status: 'pending' },
        { name: 'Read SF Bookings Sheet', status: 'pending' },
        { name: 'Write Subscriptions Sheet', status: 'pending' },
        { name: 'Create CCSP Sheet', status: 'pending' },
        { name: 'Sync Pipeline Sheet', status: 'pending' },
      ],
      error: null,
      completedAt: null,
      resources: { junkFiltered: junkFiltered.length > 0 ? junkFiltered : undefined },
    }

    const bootstrapStartMs = Date.now()
    const stepStartMs: Record<number, number> = {}
    const setStep = (idx: number, status: AutoBootstrapStep['status'], detail?: string) => {
      const now = Date.now()
      const existing = autoBootstrapState.steps[idx] ?? {}
      // Record startedAt when transitioning to 'running'
      if (status === 'running' && !stepStartMs[idx]) {
        stepStartMs[idx] = now
      }
      // Record completedAt + durationMs when finishing
      const isFinished = status === 'done' || status === 'error' || status === 'skipped'
      autoBootstrapState.steps[idx] = {
        ...existing,
        status,
        detail,
        ...(status === 'running' && !existing.startedAt ? { startedAt: new Date(now).toISOString() } : {}),
        ...(isFinished && stepStartMs[idx] ? {
          completedAt: new Date(now).toISOString(),
          durationMs: now - stepStartMs[idx],
        } : {}),
      }
    }

    // BKL-BOOTSTRAP-CANCEL-01: Per-step watchdog — fires if a step is still 'running' after timeout
    const makeStepTimeout = (idx: number, label: string, timeoutMs = STEP_TIMEOUT_MS): ReturnType<typeof setTimeout> =>
      setTimeout(() => {
        if (autoBootstrapState.steps[idx]?.status === 'running') {
          console.warn(`[auto-bootstrap] Step ${idx} (${label}) timed out after ${timeoutMs / 1000}s`)
          setStep(idx, 'error', `Step timed out after ${timeoutMs / 1000}s`)
          autoBootstrapCancelRequested = true
        }
      }, timeoutMs)

    // Hard timeout: scales with AE count (min 60 min, +30 min per AE)
    const autoTimeoutMin = Math.max(60, aes.length * 30)
    const bootstrapTimeoutId = setTimeout(() => {
      if (autoBootstrapState.running) {
        autoBootstrapState.running = false
        autoBootstrapState.completedAt = new Date().toISOString()
        autoBootstrapState.error = `Bootstrap timed out after ${autoTimeoutMin} minutes`
        const stuck = autoBootstrapState.steps.findIndex(s => s.status === 'running')
        if (stuck >= 0) autoBootstrapState.steps[stuck] = { ...autoBootstrapState.steps[stuck], status: 'error', detail: 'Timed out' }
        console.error('[auto-bootstrap] Hard timeout reached — unsticking')
        notify('Bootstrap Timed Out', `Bootstrap did not complete within ${autoTimeoutMin} minutes — check dashboard`, 'urgent').catch(() => {})
      }
    }, autoTimeoutMin * 60 * 1_000)

    // Run async — client polls /api/bootstrap/auto/status
    ;(async () => {
      // BKL-WIZ-02: Check cancellation between steps and mark remaining pending steps as cancelled
      const checkCancelled = (): boolean => {
        if (!autoBootstrapCancelRequested) return false
        for (const step of autoBootstrapState.steps) {
          if (step.status === 'pending') step.status = 'cancelled'
        }
        autoBootstrapState.running = false
        autoBootstrapState.completedAt = new Date().toISOString()
        autoBootstrapState.error = 'Cancelled by user'
        clearTimeout(bootstrapTimeoutId)
        autoBootstrapCancelRequested = false
        console.log(`[auto-bootstrap] Cancelled by user after completing some steps for ${aeName}`)
        return true
      }

      // BKL-DRIVE-SCAFFOLD-01: Idempotently scaffold Config/ and Products/<slug> under parentFolderId
      // before AE Drive folder creation (Step 0). Idempotent + non-fatal — safe to run per-AE in
      // POD batches (the bootstrapPOD function also calls it once up-front; per-AE invocations no-op).
      let perAeScaffold: { configFolderId: string; productsFolderId: string } | null = null
      if (parentFolderId) {
        perAeScaffold = await ensureConfigAndProductsScaffold(parentFolderId)
      }

      // Pre-flight — Ensure product intel Drive folders exist under Products/ (BKL-DRIVE-PRODUCTS-ROOT-01)
      try {
        const productIntelConfig = loadProductIntelConfig()
        // BKL-UX-PRODUCT-FOLDER-CONFIG-01: parent folder now sourced from
        // existing AE records via the helper, not from product-intel-config.
        const parentId = getProductIntelParentFolderId()
        // BKL-DRIVE-PRODUCTS-ROOT-01: slug folders go under Products/ subfolder, not CommandCenter root.
        const slugParentId = perAeScaffold?.productsFolderId ?? parentId
        // BKL-SEC-DRIVEID-VALIDATE-01: defense-in-depth — validate parentId before Drive calls
        if (parentId && isValidDriveFolderId(parentId)) {
          const drivePI = google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) })
          const updatedProducts = [...productIntelConfig.products]
          let anyUpdated = false
          for (let i = 0; i < updatedProducts.length; i++) {
            const p = updatedProducts[i]
            if (p.driveFolder) {
              // BKL-UX-PRODUCT-FOLDER-REPARENT-01: verify existing folder is under slugParentId;
              // if not, add slugParentId as an additional parent (non-destructive).
              const meta = await drivePI.files.get({
                fileId: p.driveFolder,
                fields: 'id,parents',
                supportsAllDrives: true,
              }).catch(() => null)
              if (meta?.data.parents && !meta.data.parents.includes(slugParentId ?? parentId)) {
                await drivePI.files.update({
                  fileId: p.driveFolder,
                  addParents: slugParentId ?? parentId,
                  supportsAllDrives: true,
                  fields: 'id',
                }).catch((e: any) => console.warn(`[auto-bootstrap] failed to re-parent ${p.slug}:`, e?.message))
                console.log(`[auto-bootstrap] Re-parented ${p.slug} under ${slugParentId ?? parentId}`)
              }
              continue
            }
            const safeSlug = p.slug.replace(/'/g, "\\'")
            const existing = await drivePI.files.list({
              q: `name='${safeSlug}' and '${slugParentId ?? parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
              fields: 'files(id)',
              supportsAllDrives: true,
              includeItemsFromAllDrives: true,
            }).catch(() => ({ data: { files: [] } }))
            if (existing.data.files?.length) {
              updatedProducts[i] = { ...p, driveFolder: existing.data.files[0].id! }
              anyUpdated = true
              console.log(`[auto-bootstrap] Product folder found for ${p.slug}: ${existing.data.files[0].id}`)
            } else {
              const created = await drivePI.files.create({
                requestBody: { name: p.slug, mimeType: 'application/vnd.google-apps.folder', parents: [slugParentId ?? parentId] },
                supportsAllDrives: true,
                fields: 'id',
              }).catch(() => null)
              if (created?.data.id) {
                updatedProducts[i] = { ...p, driveFolder: created.data.id }
                anyUpdated = true
                console.log(`[auto-bootstrap] Product folder created for ${p.slug}: ${created.data.id}`)
              }
            }
          }
          if (anyUpdated) saveProductConfig(updatedProducts)
        }
      } catch (e: any) {
        console.warn('[auto-bootstrap] Product intel folder pre-flight failed (non-blocking):', e?.message)
      }

      // Check if AE already has a Drive folder from a previous run — skip creation if so
      const existingAe = aes.find(a => a.name === aeName)
      let driveFolderId = existingAe?.driveFolderId ?? ''

      // Step 1 — Create Drive Folder (skip if already exists)
      const tid0 = makeStepTimeout(0, 'Create Drive Folder')
      try {
        setStep(0, 'running')
        if (driveFolderId) {
          autoBootstrapState.resources.driveFolder = { id: driveFolderId, url: `https://drive.google.com/drive/folders/${driveFolderId}` }
          setStep(0, 'done', `Folder: ${driveFolderId}`)
          console.log(`[auto-bootstrap] Drive folder already exists, reusing: ${driveFolderId}`)
        } else {
          const drive = google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) })

          // BKL-DRIVE-01: If podName is provided, find-or-create a POD subfolder under
          // parentFolderId, then use it as the effective parent for the AE folder.
          // Hierarchy: parentFolderId / POD Name / AE Name / customer folders
          // Single-AE bootstrap without podName skips the POD layer.
          let effectiveParentId = parentFolderId
          if (podName && parentFolderId) {
            const safePodName = podName.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
            const existingPod = await drive.files.list({
              q: `name='${safePodName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
              fields: 'files(id, name)',
              supportsAllDrives: true,
              includeItemsFromAllDrives: true,
            }).catch(() => ({ data: { files: [] } }))
            if (existingPod.data.files?.length) {
              effectiveParentId = existingPod.data.files[0].id!
              console.log(`[auto-bootstrap] Reusing existing POD folder: ${podName} (${effectiveParentId})`)
            } else {
              const podFolder = await drive.files.create({
                requestBody: {
                  name: podName,
                  mimeType: 'application/vnd.google-apps.folder',
                  parents: [parentFolderId],
                },
                supportsAllDrives: true,
                fields: 'id',
              })
              effectiveParentId = podFolder.data.id!
              console.log(`[auto-bootstrap] Created POD folder: ${podName} (${effectiveParentId})`)
            }
          }

          // BKL-M27: Check if folder already exists in parent before creating
          if (effectiveParentId) {
            const safeName = aeName.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
            const existing = await drive.files.list({
              q: `name='${safeName}' and '${effectiveParentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
              fields: 'files(id, name, webViewLink)',
              supportsAllDrives: true,
              includeItemsFromAllDrives: true,
            }).catch(() => ({ data: { files: [] } }))
            if (existing.data.files?.length) {
              driveFolderId = existing.data.files[0].id!
              autoBootstrapState.resources.driveFolder = { id: driveFolderId, url: existing.data.files[0].webViewLink ?? `https://drive.google.com/drive/folders/${driveFolderId}` }
              const updated = aes.map(a => a.name === aeName ? { ...a, driveFolderId } : a)
              saveAes(updated)
              setStep(0, 'done', `Folder: ${driveFolderId} (reused existing)`)
              console.log(`[auto-bootstrap] Reusing existing folder: ${aeName} (${driveFolderId})`)
            }
          }

          if (!driveFolderId) {
            const folder = await drive.files.create({
              requestBody: {
                name: aeName,
                mimeType: 'application/vnd.google-apps.folder',
                ...(effectiveParentId ? { parents: [effectiveParentId] } : {}),
              },
              supportsAllDrives: true,
              fields: 'id,webViewLink',
            })
            driveFolderId = folder.data.id!
            autoBootstrapState.resources.driveFolder = { id: driveFolderId, url: folder.data.webViewLink ?? `https://drive.google.com/drive/folders/${driveFolderId}` }
            const updated = aes.map(a => a.name === aeName ? { ...a, driveFolderId } : a)
            saveAes(updated)
            setStep(0, 'done', `Folder: ${driveFolderId}`)
            console.log(`[auto-bootstrap] Drive folder created: ${driveFolderId}`)
          }
        }
      } catch (e: any) {
        setStep(0, 'error', e.message)
        autoBootstrapState.error = `Drive folder creation failed: ${e.message}`
        console.error('[auto-bootstrap] Drive folder creation failed:', e.message)
      } finally {
        clearTimeout(tid0)
      }

      if (checkCancelled()) return

      // Step 2 — Create Customer Folders (one subfolder per customer inside AE folder)
      if (!driveFolderId) {
        setStep(1, 'skipped', 'Skipped: Drive folder creation failed')
        console.log('[auto-bootstrap] Skipping customer folders — no Drive folder')
      } else {
        const tid1 = makeStepTimeout(1, 'Create Customer Folders')
        try {
          setStep(1, 'running', `0/${customerNames.length} folders…`)
          const drive2 = google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) })
          const folderResources: Record<string, { id: string; url: string }> = {}
          for (let i = 0; i < customerNames.length; i++) {
            const cname = customerNames[i]
            try {
              const existingCustomer = customers.find(cx => cx.name === cname)
              let folderId = existingCustomer?.driveFolderId ?? ''
              if (!folderId) {
                // BKL-M27: Check if customer folder already exists before creating
                const safeCname = cname.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
                const existingFolder = await drive2.files.list({
                  q: `name='${safeCname}' and '${driveFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                  fields: 'files(id, name)',
                  supportsAllDrives: true,
                  includeItemsFromAllDrives: true,
                }).catch(() => ({ data: { files: [] } }))

                if (existingFolder.data.files?.length) {
                  folderId = existingFolder.data.files[0].id!
                  console.log(`[bootstrap] Reusing existing folder: ${cname} (${folderId})`)
                } else {
                  const res = await drive2.files.create({
                    requestBody: {
                      name: cname,
                      mimeType: 'application/vnd.google-apps.folder',
                      parents: [driveFolderId],
                    },
                    supportsAllDrives: true,
                    fields: 'id',
                  })
                  folderId = res.data.id!
                }
                if (existingCustomer) {
                  existingCustomer.driveFolderId = folderId
                  try {
                    // BKL-DATA-03: folderId persisted to customers.json via atomic tmp+rename
                    const tmpPath = CUSTOMERS_PATH + '.tmp'
                    writeFileSyncRaw(tmpPath, JSON.stringify({ customers }, null, 2), { mode: 0o600 })
                    renameSync(tmpPath, CUSTOMERS_PATH)
                  } catch (e: any) { console.warn('[bootstrap] customer folder ID persist failed:', e.message) }
                }
                // Do NOT create territory-sheet customer records — territory sheet is AE→territory map only.
                // Customers are sourced exclusively from sf-bookings-sync with canonical SF names.
              }
              folderResources[cname] = { id: folderId, url: `https://drive.google.com/drive/folders/${folderId}` }
              setStep(1, 'running', `${i + 1}/${customerNames.length} folders…`)
              console.log(`[auto-bootstrap] Customer folder ready for ${cname}: ${folderId}`)
            } catch (e: any) {
              console.warn(`[auto-bootstrap] Customer folder creation failed for ${cname}: ${e.message}`)
            }
          }
          autoBootstrapState.resources.customerFolders = folderResources
          setStep(1, 'done', `${Object.keys(folderResources).length}/${customerNames.length} folders created`)
          console.log(`[auto-bootstrap] Customer folders done: ${Object.keys(folderResources).length}/${customerNames.length}`)
        } catch (e: any) {
          setStep(1, 'error', e.message)
          autoBootstrapState.error = `Customer folder creation failed: ${e.message}`
          console.error('[auto-bootstrap] Customer folder creation failed:', e.message)
        } finally {
          clearTimeout(tid1)
        }
      }

      if (checkCancelled()) return

      // Steps 3 + 4 — Populate subscription data.
      // If a podBookingsSheet is registered for this AE's territory (settings.json), use the
      // SF bookings sheet as source of truth. Otherwise fall back to Supportable scraper.
      let supportableScrapeResults: Awaited<ReturnType<typeof runSupportableDiscoverAndScrape>> = []

      // Check settings.json for a POD bookings folder, then discover sheets from Drive
      // BKL-UX90: Read from regions[].podBookingsFolderId via normalizeSettings — the flat
      // root config's bookings folder field may hold the parent folder ID (not the bookings folder).
      let podSheetId: string | null = null
      try {
        const rawSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
        const normalized = normalizeSettings(rawSettings)
        // Find the region whose pods map contains this AE's pod key
        const podKey = tableauTerritories[0]?.replace(/_TERR\d+$/, '')
        const region = podKey
          ? (normalized.regions.find(r => podKey in r.pods) ?? normalized.regions[0])
          : normalized.regions[0]
        const folderId = region?.podBookingsFolderId
        if (folderId) {
          const podSheets = await listPodBookingSheets(folderId)
          podSheetId = matchPodSheet(podSheets, tableauTerritories)
          if (podSheetId) {
            const matched = podSheets.find(s => s.sheetId === podSheetId)
            console.log(`[auto-bootstrap] Resolved POD sheet for ${aeName}: "${matched?.displayName}" (${podSheetId})`)
          }
        }
      } catch { /* no settings file or Drive error — fall back to Supportable */ }

      if (podSheetId) {
        // ── SF Bookings path ──────────────────────────────────────────────────
        // SF sheet is source of truth for customer names + subscriptions.
        // Account numbers come later via RH case scraper (no Supportable needed).
        //
        // BKL-INGEST-02: 4-level cache hierarchy
        //   L2 = AE Supportable sheet modifiedTime < 24h → read rows directly (skip L3)
        //   L3 = POD-level SF bookings sheet via fetchSfBookingsRaw() (L1 local cache inside)
        //   Pattern mirrors CCSP L2 check at this file's CCSP section below.
        const tid2 = makeStepTimeout(2, 'Read SF Bookings')
        const tid3 = makeStepTimeout(3, 'Write Subscriptions')
        try {
          setStep(2, 'running', `reading SF bookings sheet…`)
          setStep(3, 'running', 'waiting for SF data…')
          console.log(`[auto-bootstrap] Using SF bookings sheet ${podSheetId} for ${aeName} (territories: ${tableauTerritories.join(', ')})`)

          // Cold-start guard — if customers.json was wiped we must re-derive even on a fresh L2 hit.
          const aeHasCustomers = customers.some(cx => cx.ae === aeName && !cx.inactive)

          // L2 probe — if AE's existing Supportable sheet is <24h old, read from it and skip L3.
          const existingSupportableIdForL2 = aes.find(a => a.name === aeName)?.supportableSheetId
            ?? (driveFolderId ? await findExistingSheet(google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) }), driveFolderId, `Supportable — ${aeName}`) : null)
            ?? null
          let l2Results: Awaited<ReturnType<typeof readSfBookingsFromAeSheet>> = null
          if (existingSupportableIdForL2) {
            const supMt = await getSheetModifiedTime(existingSupportableIdForL2)
            if (supMt && (Date.now() - supMt.getTime()) < CACHE_HIER_FRESH_MS) {
              l2Results = await readSfBookingsFromAeSheet(existingSupportableIdForL2)
              if (l2Results && l2Results.length > 0) {
                const rowCount = l2Results.reduce((n, r) => n + r.rows.length, 0)
                console.log(`[bootstrap] ${aeName}: SF bookings cache L2 hit (AE Supportable sheet) — ${l2Results.length} customers, ${rowCount} rows${aeHasCustomers ? '' : ' (cold start — will re-derive from L3)'}`)
                emitCacheLevel({ ae: aeName, flow: 'sfBookings', level: 2, rowCount })
                supportableScrapeResults = l2Results
                setStep(2, 'done', `${l2Results.length} customers from L2 cache (AE sheet)`)
                // Short-circuit — no L3 read, no customers.json upsert (prior run already wrote customers).
                // Guard: aeHasCustomers ensures this path only fires when customers.json already has this AE's data.
                // On cold start (empty customers.json), fall through to L3 to re-derive customers.
                // Step 3 (write Supportable sheet) still runs below with the L2 results.
              } else {
                console.log(`[bootstrap] ${aeName}: SF bookings L2 read returned no rows — falling through to L3`)
                emitCacheLevel({ ae: aeName, flow: 'sfBookings', level: 3 })
              }
            } else {
              const ageH = supMt ? Math.round((Date.now() - supMt.getTime()) / 3_600_000) : null
              console.log(`[bootstrap] ${aeName}: SF bookings cache L2 stale (${ageH ?? '?'}h) — falling through to L3`)
              emitCacheLevel({ ae: aeName, flow: 'sfBookings', level: 3 })
            }
          }

          if (l2Results && l2Results.length > 0 && aeHasCustomers) {
            // L2 hit — skip L3 read + customer derivation. Continue to Step 3 (sheet write).
          } else {
          const rawSfData = await fetchSfBookingsRaw(podSheetId)
          const existingCustomers = customers.filter(cx => cx.ae === aeName && !cx.inactive)
          const { results, matched, newCustomers, aliasedCustomers, ccspOnly } = deriveSfCustomersByTerritory(
            rawSfData, tableauTerritories, existingCustomers, aeName, false,
          )

          // Upsert net-new and alias-updated customers into customers array + disk
          for (const nc of newCustomers) {
            if (!customers.some(c => c.name === nc.name)) {
              customers.push(nc)
              console.log(`[auto-bootstrap] SF new customer: ${nc.name}`)
            }
          }
          for (const ac of aliasedCustomers) {
            const idx = customers.findIndex(c => c.name === ac.name)
            if (idx !== -1) customers[idx] = ac
          }
          for (const name of ccspOnly) {
            const cx = customers.find(c => c.name === name)
            if (cx) cx.ccspCustomer = true
          }
          const tmpPath = CUSTOMERS_PATH + '.tmp'
          writeFileSyncRaw(tmpPath, JSON.stringify({ customers }, null, 2), { mode: 0o600 })
          renameSync(tmpPath, CUSTOMERS_PATH)

          supportableScrapeResults = results
          setStep(2, 'done', `${matched.length}/${results.length} customers with subscriptions`)
          console.log(`[auto-bootstrap] SF bookings: ${matched.length} matched, ${newCustomers.length} new, ${ccspOnly.length} CCSP-only`)
          }  // end BKL-INGEST-02 L2-miss branch
        } catch (e: any) {
          setStep(2, 'error', e.message)
          setStep(3, 'error', 'SF sheet read failed — no results to write')
          console.error('[auto-bootstrap] SF bookings read failed:', e.message)
          autoBootstrapState.error = `SF bookings read failed: ${e.message}`
        } finally {
          clearTimeout(tid2)
          clearTimeout(tid3)
        }
      } else {
        // No SF bookings sheet found for this AE's territory — skip subscription steps.
        // This app only processes PODs that have a sheet in the shared Drive folder.
        setStep(2, 'skipped', 'No SF bookings sheet found for this territory — add sheet to shared folder to enable')
        setStep(3, 'skipped', 'Skipped: no SF bookings sheet')
        console.warn(`[auto-bootstrap] No POD sheet found for ${aeName} (territories: ${tableauTerritories.join(', ')}) — skipping subscription steps`)
      }

      if (checkCancelled()) return

      // Step 4 — Write Supportable Sheet (data already scraped in Step 3)
      if (!driveFolderId) {
        setStep(3, 'skipped', 'Skipped: Drive folder creation failed')
        console.log('[auto-bootstrap] Skipping Supportable sheet — no Drive folder')
      } else if (supportableScrapeResults.length > 0) {
        try {
          setStep(3, 'running', 'writing to Google Sheet…')
          const existingSupportableId = aes.find(a => a.name === aeName)?.supportableSheetId
            ?? (driveFolderId ? await findExistingSheet(google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) }), driveFolderId, `Supportable — ${aeName}`) : null)
            ?? null
          if (existingSupportableId) console.log(`[auto-bootstrap] Supportable sheet found/reusing: ${existingSupportableId}`)
          const sheetId = await writeSupportableSheet(supportableScrapeResults, aeName, driveFolderId || undefined, existingSupportableId || undefined)
          patchAe(aeName, { supportableSheetId: sheetId })
          autoBootstrapState.resources.supportableSheet = { id: sheetId, url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit` }
          // Warm sheet cache immediately from in-memory data — no extra API calls needed
          for (const result of supportableScrapeResults) {
            if (result.rows.length > 0) {
              const normalized = normalizeRows(result.rows, result.customerName)
              if (normalized.length > 0) writeSheetCache(result.customerName, normalized)
            }
          }
          setStep(3, 'done', `Sheet: ${sheetId}`)
          console.log(`[auto-bootstrap] Supportable sheet ${existingSupportableId ? 'updated' : 'created'}: ${sheetId}`)
        } catch (e: any) {
          setStep(3, 'error', e.message)
          autoBootstrapState.error = `Supportable sheet failed: ${e.message}`
          console.error('[auto-bootstrap] Supportable sheet write failed:', e.message)
        }
      }

      if (checkCancelled()) return

      // Step 5 — Create CCSP Sheet
      if (!driveFolderId) {
        setStep(4, 'skipped', 'Skipped: Drive folder creation failed')
        console.log('[auto-bootstrap] Skipping CCSP sheet — no Drive folder')
      } else {
        const tid4 = makeStepTimeout(4, 'Create CCSP Sheet', 300_000)
        try {
          setStep(4, 'running')
          const currentAe = aes.find(a => a.name === aeName)!
          const ccspAe = { ...currentAe, tableauTerritories, driveFolderId: driveFolderId || currentAe.driveFolderId } as AE
          const existingCcspId = aes.find(a => a.name === aeName)?.ccspSheetId
            ?? (driveFolderId ? await findExistingSheet(google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) }), driveFolderId, `${aeName} CCSP`) : null)
            ?? null

          // ─── BKL-BOOT-SCRAPE-ORDER-01: L3-existence short-circuit ───────────
          // ─── BKL-CACHE-HIER-01: 4-level CCSP cache hierarchy ───────────────
          // L1 = on-disk ccsp-data.json cachedAt<24h + includes this AE's sheet ID
          // L2 = AE CCSP sheet modifiedTime<24h → read rows directly (no CSV parse, no territory filter)
          // L3 = Subscription Data folder CSV<24h (inside runCcspScrape)
          // L4 = live Tableau scrape (inside runCcspScrape)
          let ccspResults: Awaited<ReturnType<typeof runCcspScrape>> | null = null
          let ccspLevel: 'L1' | 'L2' | 'L3-or-L4' = 'L3-or-L4'

          if (isCcspDiskCacheFreshForAe(existingCcspId ?? undefined)) {
            console.log(`[bootstrap] ${aeName}: CCSP cache L1 hit (disk)`)
            emitCacheLevel({ ae: aeName, flow: 'ccsp', level: 1 })
            // L1 still requires a sheet write because we must persist the current CCSP results
            // to the AE's sheet for downstream readers; the "cache hit" just tells us we already
            // have the authoritative data on disk — but we still need to ensure the Drive sheet
            // is populated. We fall through to L2 read since the AE sheet is the fastest source.
            ccspLevel = 'L1'
            if (existingCcspId) {
              const l1Rows = await readCcspFromAeSheet(existingCcspId)
              if (l1Rows && l1Rows.length > 0) {
                ccspResults = [{ aeName, rows: l1Rows, accountPeriod: '' }]
              }
            }
          }

          if (!ccspResults && existingCcspId) {
            const ccspMt = await getSheetModifiedTime(existingCcspId)
            if (ccspMt && (Date.now() - ccspMt.getTime()) < CACHE_HIER_FRESH_MS) {
              const l2Rows = await readCcspFromAeSheet(existingCcspId)
              if (l2Rows && l2Rows.length > 0) {
                console.log(`[bootstrap] ${aeName}: CCSP cache L2 hit (AE sheet) — ${l2Rows.length} rows`)
                emitCacheLevel({ ae: aeName, flow: 'ccsp', level: 2, rowCount: l2Rows.length })
                ccspResults = [{ aeName, rows: l2Rows, accountPeriod: '' }]
                ccspLevel = 'L2'
              }
            }
          }

          // L3/L4 — fall through to runCcspScrape which handles Drive Subscription Data
          // CSV check (L3) and live Tableau scrape (L4) internally via _podCsvCache
          // + Drive cache read + Tableau navigation.
          if (!ccspResults) {
            console.log(`[bootstrap] ${aeName}: CCSP cache L3 hit (Subscription Data CSV) or L4 fresh scrape`)
            emitCacheLevel({ ae: aeName, flow: 'ccsp', level: 3 })
            // BKL-PERF-02: _podCsvCache inside scrapeOneAe handles caching lazily — first AE populates, rest use cache
            ccspResults = await runCcspScrape([ccspAe])
          }

          void ccspLevel  // retained for future log surface; current logs already announce L1/L2/L3/L4

          if (existingCcspId) console.log(`[auto-bootstrap] CCSP sheet found/reusing: ${existingCcspId}`)
          const sheetId = await writeCcspSheet(ccspResults, aeName, ccspAe.driveFolderId, existingCcspId || undefined)
          patchAe(aeName, { ccspSheetId: sheetId })
          autoBootstrapState.resources.ccspSheet = { id: sheetId, url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit` }
          const totalCcspRows = ccspResults.flatMap(r => r.rows).length
          const ccspMsg = totalCcspRows === 0
            ? `Sheet: ${sheetId} — 0 records (no CCSP data found for this territory in the rolling window — verify territory and run Sync CCSP to retry)`
            : `Sheet: ${sheetId} (${totalCcspRows} records)`
          setStep(4, 'done', ccspMsg)
          if (totalCcspRows === 0) console.warn(`[auto-bootstrap] CCSP sheet created with 0 records — no territory data found; check territory mapping and Tableau filters`)
          else console.log(`[auto-bootstrap] CCSP sheet ${existingCcspId ? 'updated' : 'created'}: ${sheetId} (${totalCcspRows} records)`)
        } catch (e: any) {
          setStep(4, 'error', e.message)
          autoBootstrapState.error = `CCSP sheet failed: ${e.message}`
          console.error('[auto-bootstrap] CCSP sheet failed:', e.message)
        } finally {
          clearTimeout(tid4)
        }
      }

      if (checkCancelled()) return

      // Step 6 — Sync Pipeline Sheet
      if (!driveFolderId) {
        setStep(5, 'error', 'Pipeline sheet skipped: Drive folder was not created in step 1')
        console.log('[auto-bootstrap] Skipping Pipeline sheet — no Drive folder')
      } else {
        const tid5 = makeStepTimeout(5, 'Sync Pipeline Sheet')
        try {
          setStep(5, 'running')
          // BKL-POD-03: Verify Drive folder still exists before attempting pipeline sheet create
          const driveCheck = await google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) })
            .files.get({ fileId: driveFolderId, fields: 'id' })
            .catch(() => null)
          if (!driveCheck) {
            throw new Error(`Drive folder was deleted or inaccessible (${driveFolderId}) — re-run bootstrap with force:true to recreate it`)
          }
          const existingPipelineId = aes.find(a => a.name === aeName)?.pipelineSheetId
            ?? (driveFolderId ? await findExistingSheet(google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) }), driveFolderId, `${aeName} Pipeline`) : null)
            ?? null
          if (existingPipelineId) console.log(`[auto-bootstrap] Pipeline sheet found/reusing: ${existingPipelineId}`)
          const pipelineSheetId = existingPipelineId ?? await createPipelineSheet(aeName, driveFolderId || aes.find(a => a.name === aeName)?.driveFolderId || '')
          if (existingPipelineId) console.log(`[auto-bootstrap] Reusing existing pipeline sheet for ${aeName}: ${existingPipelineId}`)
          // FIX N3: Persist pipelineSheetId immediately so AE retains the sheet link even if sync fails
          patchAe(aeName, { pipelineSheetId })

          // ─── BKL-CACHE-HIER-01: 4-level SF Pipeline cache hierarchy ────────
          // L1 = on-disk pipeline-data.json cachedAt<24h + includes this AE's sheet ID
          // L2 = AE Pipeline sheet modifiedTime<24h → read directly (no browser)
          // L3 = Subscription Data SF-PIPELINE CSV<24h (existing readSfDriveCache path)
          // L4 = live SF scrape (runSfPipelineSync)
          let hierSfData: SfReportRow | null = null
          if (isPipelineDiskCacheFreshForAe(pipelineSheetId)) {
            // L1 hit — disk cache is fresh; we still need to populate the AE's Drive pipeline
            // sheet on first-ever bootstrap. Fast path: read rows from the sheet itself (L2 read);
            // if that fails, fall through to L3/L4.
            console.log(`[bootstrap] ${aeName}: SF cache L1 hit (disk)`)
            emitCacheLevel({ ae: aeName, flow: 'sfPipeline', level: 1 })
            hierSfData = await readPipelineFromAeSheet(pipelineSheetId)
          }
          if (!hierSfData) {
            const pipelineMt = await getSheetModifiedTime(pipelineSheetId)
            if (pipelineMt && (Date.now() - pipelineMt.getTime()) < CACHE_HIER_FRESH_MS) {
              const sheetData = await readPipelineFromAeSheet(pipelineSheetId)
              if (sheetData && sheetData.rows.length > 0) {
                console.log(`[bootstrap] ${aeName}: SF cache L2 hit (AE sheet) — ${sheetData.rows.length} rows`)
                emitCacheLevel({ ae: aeName, flow: 'sfPipeline', level: 2, rowCount: sheetData.rows.length })
                hierSfData = sheetData
                // Warm podSfDataCache so subsequent AEs in the same POD also skip L3/L4
                if (!podSfDataCache || podSfDataCache.reportId !== sfReportId || Date.now() > podSfDataCache.expiresAt) {
                  podSfDataCache = { reportId: sfReportId, data: sheetData, expiresAt: Date.now() + POD_SF_CACHE_TTL_MS }
                }
              }
            }
          }

          const cachedSfData = hierSfData
            ?? (podSfDataCache?.reportId === sfReportId && Date.now() < (podSfDataCache?.expiresAt ?? 0)
              ? podSfDataCache!.data
              : null)
          if (cachedSfData) {
            if (!hierSfData) console.log(`[auto-bootstrap] Using cached SF report data for ${aeName} pipeline sheet`)
            await runSfPipelineSyncFromData(cachedSfData, pipelineSheetId)
          } else {
            console.log(`[bootstrap] ${aeName}: SF cache L3 hit (Subscription Data CSV) or L4 fresh scrape`)
            // Emit optimistically at L3; if Drive cache misses we'll fall to L4 below
            emitCacheLevel({ ae: aeName, flow: 'sfPipeline', level: 3 })
            // BKL-SFCACHE-01: Single-AE fallback — check Drive for today's SF-PIPELINE cache before
            // running a live browser scrape. Same 24h TTL / filename contract as the POD path.
            let driveSfData: SfReportRow | null = null
            let sfDriveFolderId = ''
            let sfDrivePodName = ''
            let sfDriveFileName = ''
            try {
              const firstTerritory = tableauTerritories[0]
              if (firstTerritory) sfDrivePodName = parseTerritoryParts(firstTerritory).pod
              const rawSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
              const normalized = normalizeSettings(rawSettings)
              const podKey = firstTerritory?.replace(/_TERR\d+$/, '')
              const region = podKey
                ? (normalized.regions.find(r => podKey in r.pods) ?? normalized.regions[0])
                : normalized.regions[0]
              sfDriveFolderId = region?.podBookingsFolderId ?? ''
              if (sfDriveFolderId && sfDrivePodName) {
                const today = new Date().toISOString().slice(0, 10)
                sfDriveFileName = `SF-PIPELINE-${sfReportId}-${sfDrivePodName}-${today}.csv`
                driveSfData = await readSfDriveCache(sfDriveFolderId, sfDriveFileName)
                if (driveSfData) {
                  console.log(`[auto-bootstrap] SF Drive cache hit — ${driveSfData.rows.length} rows from ${sfDriveFileName}`)
                }
              }
            } catch { /* no settings — fall through to live scrape */ }

            if (driveSfData) {
              await runSfPipelineSyncFromData(driveSfData, pipelineSheetId)
              // Warm the in-memory cache so subsequent AEs in the same POD benefit
              podSfDataCache = { reportId: sfReportId, data: driveSfData, expiresAt: Date.now() + POD_SF_CACHE_TTL_MS }
            } else {
              emitCacheLevel({ ae: aeName, flow: 'sfPipeline', level: 4 })
              const liveData = await scrapeSfReport(sfReportId, RH_PROFILE_DIR)
              await runSfPipelineSyncFromData(liveData, pipelineSheetId)
              // BKL-SFCACHE-01: Write Drive cache after successful live scrape
              podSfDataCache = { reportId: sfReportId, data: liveData, expiresAt: Date.now() + POD_SF_CACHE_TTL_MS }
              if (sfDriveFolderId && sfDriveFileName && liveData.rows.length > 0) {
                await writeSfDriveCache(liveData, sfDriveFolderId, sfReportId, sfDrivePodName, sfDriveFileName)
              }
            }
          }
          autoBootstrapState.resources.pipelineSheet = { id: pipelineSheetId, url: `https://docs.google.com/spreadsheets/d/${pipelineSheetId}/edit` }
          setStep(5, 'done', `Sheet: ${pipelineSheetId}`)
          console.log(`[auto-bootstrap] Pipeline sheet synced: ${pipelineSheetId}`)
          // Populate local pipeline cache immediately so dashboard shows data without waiting for 2am scheduler (BKL-M18)
          refreshPipeline().catch(e => console.warn('[auto-bootstrap] post-bootstrap pipeline cache refresh failed:', e.message))
        } catch (e: any) {
          setStep(5, 'error', e.message)
          autoBootstrapState.error = `Pipeline sync failed: ${e.message}`
          console.error('[auto-bootstrap] Pipeline sync failed:', e.message)
        } finally {
          clearTimeout(tid5)
        }
      }

      // BKL-F05 / BKL-DOM-INF-01 / BKL-DOM-BATCH-01: Auto-run domain inference for
      // bootstrapped customers after all steps complete. Single Gemini Flash-Lite
      // batch call per 20 names + retry pass for nulls + Clearbit fallback. Awaited
      // inline (not fire-and-forget) so the 409 gate and POD wait loop see a
      // consistent running flag through the whole inference pass. capturedState
      // anchors writes to the state object that owned this run.
      const capturedState = autoBootstrapState
      inferenceRunning = true
      let inferenceTimedOut = false
      try {
        await Promise.race([
          (async () => {
            const aeCustomers = customers.filter(cx => !cx.inactive && cx.ae === aeName && !cx.domain)
            if (aeCustomers.length === 0) return
            const names = aeCustomers.map(cu => cu.name)
            console.log(`[auto-bootstrap] Domain inference: ${names.length} customers for ${aeName}…`)
            const inferenceResults: NonNullable<typeof capturedState.resources.domainInference> = []
            const highConfidenceSaves: { name: string; domain: string; ae: string }[] = []

            // Step 1: Gemini batch call
            let batchMap = await batchInferDomains(names).catch((e: any) => {
              console.warn(`[infer-domains] batch failed for ${aeName}:`, e?.message ?? e)
              return null
            })

            // Step 2: Gemini retry for nulls only
            if (batchMap) {
              const nulls = names.filter(n => !batchMap!.get(n))
              if (nulls.length > 0) {
                console.log(`[infer-domains] retry batch for ${nulls.length} nulls: ${nulls.join(', ')}`)
                const retryMap = await batchInferDomains(nulls).catch(() => null)
                if (retryMap) {
                  for (const [name, domain] of retryMap) {
                    if (domain) batchMap.set(name, domain)
                  }
                }
              }
            }

            // Step 3: Clearbit fallback for still-null
            const stillNull = names.filter(n => !batchMap?.get(n))
            for (const name of stillNull) {
              const domain = await tier1Clearbit(name).catch(() => null)
              if (domain) {
                batchMap = batchMap ?? new Map()
                batchMap.set(name, domain)
              }
            }

            // Build results and collect saves
            for (const cu of aeCustomers) {
              const domain = batchMap?.get(cu.name) ?? null
              if (!domain || !isPublicDomain(domain)) {
                // Step 4: signal fallback (last ditch — Gmail/Calendar headers)
                const r = await inferCustomerDomain(cu, GOOGLE_UNIFIED_TOKEN_PATH).catch((e: any) => {
                  console.warn(`[infer-domains] signal fallback error for ${cu.name}:`, e?.message ?? e)
                  return null
                })
                if (!r || r.candidates.length === 0) continue
                const top = r.candidates[0]
                const confidence = isHighConfidenceDomain(top) ? 'high' : 'low'
                inferenceResults.push({ customerName: r.customerName, domain: top.domain, confidence, sources: top.sources })
                if (confidence === 'high') highConfidenceSaves.push({ name: r.customerName, domain: top.domain, ae: aeName })
                continue
              }
              inferenceResults.push({ customerName: cu.name, domain, confidence: 'high', sources: ['llm'] })
              highConfidenceSaves.push({ name: cu.name, domain, ae: aeName })
            }

            // Auto-save high-confidence domains to customers.json — AE-scoped lookup so a
            // matching name under a different AE (or an inactive customer) cannot be
            // contaminated by this run. Serialized through _customerWriteLock so concurrent
            // inference across overlapping bootstraps does not lose writes.
            if (!inferenceTimedOut && highConfidenceSaves.length > 0) {
              _customerWriteLock = _customerWriteLock.then(async () => {
                for (const { name, domain, ae } of highConfidenceSaves) {
                  const cu = customers.find(cx => cx.name === name && cx.ae === ae && !cx.inactive)
                  if (cu && !cu.domain) cu.domain = domain
                }
                try {
                  writeFileSyncRaw(CUSTOMERS_PATH + '.tmp', JSON.stringify({ customers }, null, 2), { mode: 0o600 })
                  renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
                  console.log(`[auto-bootstrap] Domain inference complete for ${aeName}: ${highConfidenceSaves.length} saved, ${inferenceResults.length - highConfidenceSaves.length} unresolved`)
                } catch (e: any) { console.warn('[auto-bootstrap] domain auto-save failed:', e.message) }
              })
              await _customerWriteLock
            }

            if (!inferenceTimedOut && inferenceResults.length > 0) {
              capturedState.resources.domainInference = inferenceResults
            }
          })(),
          new Promise<void>(resolve => setTimeout(() => { inferenceTimedOut = true; resolve() }, 60_000)),
        ])
        if (inferenceTimedOut) {
          console.warn(`[auto-bootstrap] domain inference timed out after 60s for ${aeName}`)
        }
      } catch (e: any) {
        console.warn(`[auto-bootstrap] domain inference failed for ${aeName}:`, e?.message ?? e)
      } finally {
        inferenceRunning = false
      }

      autoBootstrapState.running = false
      autoBootstrapState.completedAt = new Date().toISOString()
      clearTimeout(bootstrapTimeoutId)

      // Record bootstrap history
      const aeCustomerCount = customers.filter(cx => !cx.inactive && cx.ae === aeName).length
      recordBootstrapRun({
        aeName,
        completedAt: autoBootstrapState.completedAt,
        success: !autoBootstrapState.error,
        customerCount: aeCustomerCount,
        accountsFound: customers.filter(cx => !cx.inactive && cx.ae === aeName).length,
        durationMs: Date.now() - bootstrapStartMs,
        source: 'single',
      })

      // BKL-TOKEN-03: intelligence + brief pregen triggers moved to POD-level (bootstrapPOD),
      // fired ONCE after the full AE loop completes. Previously a POD with N AEs triggered
      // N pregen batches, each processing every customer in the system — quadratic token waste.
      // Single-AE bootstraps (non-POD) rely on the scheduled/manual pregen endpoints or the
      // POD completion hook when run as part of a POD.

      console.log(`[auto-bootstrap] All steps complete for ${aeName}`)

      // BKL-BOOT-SCRAPE-ORDER-01: RH Cases is scheduled-only — do not trigger during bootstrap.
      // The next scheduled run will pick up account discovery + case fetch for the new AE.
      // (Previously BKL-BOOT-06 enqueued an rh-cases scrape here — removed to keep the
      // shared Chromium context unloaded during the fragile bootstrap window.)

      notify('Bootstrap Complete', `All steps complete for ${aeName}`, 'high').catch(() => {})
    })()

    return c.json({ started: true })
  })

  // ── Tableau login helper ────────────────────────────────────────────────────

  // GET /api/bootstrap/tableau/session-status — probe Tableau reachability + session validity
  // Returns { reachable: boolean, sessionValid: boolean }
  // reachable=false → not on VPN or Tableau is down — don't show login prompt
  // reachable=true, sessionValid=false → on VPN but needs login — show prompt
  // reachable=true, sessionValid=true → already logged in — no action needed
  //
  // Cached for 5 minutes — the live browser probe takes ~6s (SSO redirect settle).
  // Pass ?force=true to bypass cache (used by Connect button after login).
  let _tableauStatusCache: { result: { reachable: boolean; sessionValid: boolean }; cachedAt: number } | null = null
  const TABLEAU_STATUS_TTL_MS = 60 * 1000  // BKL-SEC-CONN-02: reduced from 5min to 60s
  // BKL-CONN-TABLEAU-CTX-01: Tableau login uses a dedicated Interactive Auth Page (IAP)
  // — see src/interactive-auth-page.ts. _livePage is reserved for the scraper SSO anchor;
  // driving cross-domain SSO chains through it corrupted the renderer and hung sister scrapers.

  app.get('/api/bootstrap/tableau/session-status', async (c) => {
    const force = c.req.query('force') === 'true'
    // BKL-UX79: If scraper detected an expired session since last status check, invalidate cache immediately
    if (consumeTableauSessionExpired()) {
      _tableauStatusCache = null
    }
    if (!force && _tableauStatusCache && Date.now() - _tableauStatusCache.cachedAt < TABLEAU_STATUS_TTL_MS) {
      return c.json(_tableauStatusCache.result)
    }
    // BKL-CONN-TABLEAU-CTX-01: probe via Node-side HEAD + cookie freshness.
    // No browser opened — zero shared-context risk. HEAD probe determines reachability
    // (VPN check); cookie freshness determines session validity.
    let reachable = true
    try {
      await fetch('https://10ay.online.tableau.com', {
        method: 'HEAD',
        signal: AbortSignal.timeout(3_000),
      })
    } catch {
      reachable = false
    }
    const sessionValid = reachable ? await checkTableauSessionFromCookies() : false
    const result = { reachable, sessionValid }
    _tableauStatusCache = { result, cachedAt: Date.now() }
    return c.json(result)
  })

  // GET /api/bootstrap/tableau/wait-for-login — long-poll that resolves when the live page
  // lands on the Tableau dashboard (logged-in URL, no login form). Uses a two-phase
  // check: first waits for the Tableau hostname, then waits for the SAML redirect
  // chain to settle (6s) before re-verifying. Without the settle delay, the initial
  // domcontentloaded on 10ay.online.tableau.com fires BEFORE SSO redirects the page
  // to the login form — causing a false-positive that closes the VNC window immediately.
  app.get('/api/bootstrap/tableau/wait-for-login', async (c) => {
    // BKL-CONN-TABLEAU-CTX-01: waitForTableauLogin polls the isolated Chromium context.
    // On success, it harvests cookies to TABLEAU_SESSION_PATH and closes the isolated
    // context — VNC clears automatically when the context closes.
    // BKL-CONN-TABLEAU-CTX-01: 90s timeout stays safely under Bun's idleTimeout=120s.
    // The client re-polls wait-for-login if it times out — no 5-minute HTTP hang.
    const sessionValid = await waitForTableauLogin(90_000)
    if (sessionValid) {
      _tableauStatusCache = { result: { reachable: true, sessionValid: true }, cachedAt: Date.now() }
      console.log('[tableau] login confirmed — cookies harvested, isolated context closed')
    } else {
      console.warn('[tableau] wait-for-login: timed out or failed')
    }
    return c.json({ sessionValid })
  })

  // POST /api/bootstrap/tableau/open-login — opens a dedicated IAP for Tableau
  // login so the user can complete SSO via the VNC viewer at localhost:6080.
  // BKL-CONN-TABLEAU-CTX-01: uses the IAP (not _livePage) so the SSO redirect
  // chain cannot corrupt the scraper anchor page or hang sister scrapers.
  app.post('/api/bootstrap/tableau/open-login', async (c) => {
    // BKL-CONN-TABLEAU-CTX-01: isolated context — no longer requires active RH session
    _tableauStatusCache = null  // force fresh probe on next status check
    try {
      await startTableauLoginBrowser()
      console.log('[tableau] isolated Chromium launched for Tableau login — visible at localhost:6080')
      return c.json({ ok: true })
    } catch (e: any) {
      console.error('[tableau] open-login failed:', e?.message ?? e)
      return c.json({ error: 'Could not open Tableau — check VPN connection' }, 500)
    }
  })

  // ── Tableau territory discovery ────────────────────────────────────────────

  app.get('/api/bootstrap/tableau/territories', async (c) => {
    const ctx = getScrapeContext()
    if (!ctx) return c.json({ error: 'No RH session — connect Red Hat Portal first' }, 400)

    let page: Awaited<ReturnType<typeof ctx.newPage>> | null = null
    try {
      page = await ctx.newPage()
      const TABLEAU_URL = 'https://10ay.online.tableau.com/#/site/redhatanalytics/views/OverallCloudConsumptionDashboard/CloudConsumption'
      await page.goto(TABLEAU_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {
        console.warn('[territories] networkidle timed out — continuing anyway')
      })

      // Inline applyFilter helper for territory discovery
      const applyFilterLocal = async (label: string, values: string[]) => {
        const trigger = await page!.$(`[aria-label="${label}"], select[title*="${label}"]`)
        if (!trigger) {
          const byText = await page!.$(`text="${label}"`)
          if (!byText) { console.warn(`[territories] filter "${label}" not found`); return }
          const parent = await byText.$('xpath=ancestor::div[contains(@class,"filter") or contains(@class,"dropdown")][1]')
          if (!parent) { console.warn(`[territories] filter "${label}" parent not found`); return }
          await parent.click()
        } else {
          await trigger.click()
        }
        await page!.waitForTimeout(800)

        const allOption = await page!.$('text="(All)"')
        if (allOption) {
          const checkbox = await allOption.$('xpath=preceding-sibling::input[@type="checkbox"] | ancestor::label/input')
          const checked = await checkbox?.isChecked()
          if (checked) await allOption.click()
          await page!.waitForTimeout(300)
        }

        for (const val of values) {
          const opt = await page!.$(`text="${val}"`)
          if (opt) { await opt.click(); await page!.waitForTimeout(300) }
        }

        const applyBtn = await page!.$('button:has-text("Apply"), input[value="Apply"]')
        if (applyBtn) await applyBtn.click()
        await page!.waitForTimeout(1_500)
      }

      // Apply prerequisite filters
      await applyFilterLocal('Super Geo', ['AMERICAS'])
      await applyFilterLocal('Geo', ['NA_COMM'])
      await applyFilterLocal('Region', ['NA_COMM_COMMERCIAL'])
      await applyFilterLocal('Segment', ['Commercial'])

      // Open the Account Territory filter dropdown
      const trigger = await page.$(`[aria-label="Account Territory"], select[title*="Account Territory"]`)
      if (!trigger) {
        const byText = await page.$('text="Account Territory"')
        if (byText) {
          const parent = await byText.$('xpath=ancestor::div[contains(@class,"filter") or contains(@class,"dropdown")][1]')
          if (parent) await parent.click()
        }
      } else {
        await trigger.click()
      }
      await page.waitForTimeout(800)

      // Scrape all option text values
      const options = await page.$$eval(
        '[role="option"], [role="listbox"] label, .FICheckRadio label, [class*="filter"] label',
        (els: Element[]) => els.map(el => el.textContent?.trim() ?? '').filter(t => t && t !== '(All)')
      )

      // Dedupe and sort
      const territories = [...new Set(options)].sort()

      return c.json({ territories })
    } catch (e: any) {
      console.error('[territories] Discovery failed:', e.message)
      return c.json({ error: `Territory discovery failed: ${sanitizeErr(e)}` }, 500)
    } finally {
      if (page) await page.close().catch(() => {})
    }
  })

  // ── Initial Load (BKL-M44) ────────────────────────────────────────────────
  // Crash-safe, resume-capable full Supportable load for new instances.
  // Runs sequentially (council decision 2026-04-03), writes incrementally.

  const initialLoadState = {
    running: false,
    currentCustomer: null as string | null,
    completedCount: 0,
    totalCount: 0,
    errors: [] as { customer: string; message: string }[],
    startedAt: null as string | null,
    completedAt: null as string | null,
  }

  app.get('/api/bootstrap/initial-load/status', (c) => {
    return c.json({
      ...initialLoadState,
      errors: initialLoadState.errors.map(e => ({
        customer: e.customer,
        message: String(e.message ?? '').slice(0, 200).replace(/\/[^\s:]+\.(ts|js)/g, '[file]'),
      })),
    })
  })

  app.post('/api/bootstrap/initial-load', async (c) => {
    const { supportableScrapeRunning } = await import('./supportable-scraper.ts')
    if (initialLoadState.running) return c.json({ error: 'Initial load already running' }, 409)
    if (supportableScrapeRunning) return c.json({ error: 'Supportable scrape already in progress — wait for it to finish' }, 409)

    const ctx = getScrapeContext()
    if (!ctx) return c.json({ error: 'No browser context — connect Red Hat Portal first' }, 400)

    // Snapshot customer list at start time
    const allCustomers = [...customers]
    if (!allCustomers.length) return c.json({ error: 'No customers configured' }, 400)

    // Determine which customers to run: skip those with existing supportableSheetId + cached rows
    const toRun: typeof allCustomers = []
    const skipped: string[] = []
    for (const cu of allCustomers) {
      const ae = aes.find(a => a.name === cu.ae)
      if (ae?.supportableSheetId) {
        // Try to check if sheet has rows via account number cache
        const hasAccounts = (cu.accountNumbers?.length ?? 0) > 0
        if (hasAccounts) { skipped.push(cu.name); continue }
      }
      toRun.push(cu)
    }

    initialLoadState.running = true
    initialLoadState.completedCount = 0
    initialLoadState.totalCount = toRun.length
    initialLoadState.errors = []
    initialLoadState.currentCustomer = null
    initialLoadState.startedAt = new Date().toISOString()
    initialLoadState.completedAt = null

    console.log(`[initial-load] starting: ${toRun.length} to run, ${skipped.length} skipped (already have data)`)

    // Hard timeout: 3 hours max — unsticks the lock if a customer scrape hangs indefinitely
    const initialLoadTimeoutId = setTimeout(() => {
      if (initialLoadState.running) {
        initialLoadState.running = false
        initialLoadState.currentCustomer = null
        initialLoadState.completedAt = new Date().toISOString()
        initialLoadState.errors.push({ customer: '(timeout)', message: 'Initial load timed out after 3 hours' })
        console.error('[initial-load] Hard timeout reached — unsticking lock')
      }
    }, 3 * 60 * 60 * 1_000)

    ;(async () => {
      for (const cu of toRun) {
        initialLoadState.currentCustomer = cu.name
        try {
          const ae = aes.find(a => a.name === cu.ae)
          const results = await runSupportableDiscoverAndScrape(
            [cu],
            () => {},
            (msg) => console.log(`[initial-load:${cu.name}] ${msg}`)
          )
          if (results.length && results[0].accountNumbers.length > 0) {
            // Persist account numbers incrementally
            const r = results[0]
            const idx = customers.findIndex(c => c.name === cu.name)
            if (idx >= 0) {
              customers[idx] = { ...customers[idx], accountNumbers: r.accountNumbers }
              const tmpPath = CUSTOMERS_PATH + '.tmp'
              writeFileSyncRaw(tmpPath, JSON.stringify({ customers }, null, 2), { mode: 0o600 })
              renameSync(tmpPath, CUSTOMERS_PATH)
            }
            // Write Supportable sheet incrementally
            if (ae) {
              const sheetId = await writeSupportableSheet(
                results,
                cu.ae!,
                ae.driveFolderId || undefined,
                ae.supportableSheetId || undefined
              ).catch((e: any) => { console.warn(`[initial-load:${cu.name}] sheet write failed: ${sanitizeErr(e)}`); return null })
              if (sheetId && !ae.supportableSheetId) {
                saveAes(aes.map(a => a.name === cu.ae ? { ...a, supportableSheetId: sheetId } : a))
              }
            }
          }
          initialLoadState.completedCount++
        } catch (e: any) {
          const msg = sanitizeErr(e)
          console.warn(`[initial-load:${cu.name}] error: ${msg}`)
          initialLoadState.errors.push({ customer: cu.name, message: msg })
          initialLoadState.completedCount++
        }
      }
      clearTimeout(initialLoadTimeoutId)
      initialLoadState.running = false
      initialLoadState.currentCustomer = null
      initialLoadState.completedAt = new Date().toISOString()
      console.log(`[initial-load] complete: ${initialLoadState.completedCount} processed, ${initialLoadState.errors.length} errors`)
    })().catch((e: any) => {
      clearTimeout(initialLoadTimeoutId)
      console.error('[initial-load] fatal:', sanitizeErr(e))
      initialLoadState.running = false
      initialLoadState.currentCustomer = null
      initialLoadState.completedAt = new Date().toISOString()
    })

    return c.json({ started: true, total: toRun.length, skipped: skipped.length })
  })
}
