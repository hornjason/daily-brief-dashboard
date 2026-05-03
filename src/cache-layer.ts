import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { Hono } from 'hono'
import type { CCSPRecord } from './sheets.ts'
import type { PipelineRecord } from './pipeline.ts'
import type { ProductSubscription, EmailHighlight, CalendarEvent } from './types.ts'
import type { DocClassification } from './doc-extraction.ts'

// ── Module state ─────────────────────────────────────────────────────────────
let CACHE_DIR = ''
let RH_CASES_CACHE_PATH = ''

export function initCacheLayer(cacheDir: string, rhCasesCachePath: string): void {
  CACHE_DIR = cacheDir
  RH_CASES_CACHE_PATH = rhCasesCachePath
}

// ── Slug helper ──────────────────────────────────────────────────────────────
export const toSlug = (name: string) =>
  name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '')

// ── Time constants ───────────────────────────────────────────────────────────
export const MS_PER_DAY = 86_400_000

// ── Brief cache TTL (ADR-013 P2) ─────────────────────────────────────────────
// 7-day safety-net TTL — the SHA256 input fingerprint (set by brief route) is the
// primary invalidation mechanism. This TTL is a last-resort fallback for cases
// where fingerprint checks are bypassed (e.g. raw cache read with no fingerprint).
export const BRIEF_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

// ── Brief cache (daily, date-stamped) ────────────────────────────────────────
export function briefCachePath(customerName: string): string {
  const slug = toSlug(customerName)
  if (!slug || /[^a-zA-Z0-9_-]/.test(slug)) {
    throw new Error(`[cache] unsafe slug for cache path: "${slug}"`)
  }
  const today = new Date().toLocaleDateString('en-CA') // YYYY-MM-DD local time
  return `${CACHE_DIR}/${slug}-${today}.json`
}

// BKL-AI-COST-08: read honors per-file ttlMs if present (activity-aware TTL)
// BKL-ADR013-P2: returns inputFingerprint so callers can compare against current input hash
// BKL-AI-FP-09: returns docCorpusSnapshot for delta-mode brief generation
export function readBriefCache(customerName: string): { text: string; cachedAt: string; inputFingerprint?: string; docCorpusSnapshot?: Record<string, string> } | null {
  try {
    const data = JSON.parse(readFileSync(briefCachePath(customerName), 'utf-8'))
    const ttlMs = typeof data.ttlMs === 'number' ? data.ttlMs : BRIEF_CACHE_TTL_MS
    const age = Date.now() - new Date(data.cachedAt).getTime()
    if (age > ttlMs) return null  // expired per stored TTL
    const inputFingerprint = typeof data.inputFingerprint === 'string' ? data.inputFingerprint : undefined
    const docCorpusSnapshot = (data.docCorpusSnapshot !== null && typeof data.docCorpusSnapshot === 'object' && !Array.isArray(data.docCorpusSnapshot)
      && Object.values(data.docCorpusSnapshot).every(v => typeof v === 'string'))
      ? data.docCorpusSnapshot as Record<string, string>
      : undefined
    return { text: data.text, cachedAt: data.cachedAt, inputFingerprint, docCorpusSnapshot }
  } catch {
    return null
  }
}

// BKL-AI-COST-08: lastActivityDate previously extended TTL to 48h for inactive customers.
// BKL-ADR013-P2: fingerprint now handles freshness; both active + inactive paths use 7d safety-net TTL.
// The 4th arg (inputFingerprint) is stored so the next request can bypass Gemini on input-unchanged.
// BKL-AI-FP-09: 5th arg (docCorpusSnapshot) stored for corpus delta detection on next miss.
export function writeBriefCache(
  customerName: string,
  text: string,
  lastActivityDate?: Date,
  inputFingerprint?: string,
  docCorpusSnapshot?: Record<string, string>,
): void {
  try {
    const path = briefCachePath(customerName)
    // Stale-overwrite guard: don't replace a longer brief with a shorter one
    // (truncated Gemini output or race between pre-gen and on-demand generation).
    // Exception: when an inputFingerprint is present the write is a complete,
    // fingerprinted generation — bypass the length heuristic so that DISALLOW_GEMINI
    // fixture responses (< 500 chars) can still stamp the fingerprint into cache and
    // allow subsequent calls to short-circuit via fingerprint match.
    const existing = readBriefCache(customerName)
    if (!inputFingerprint && existing && existing.text.length > text.length * 1.5 && text.length < 500) {
      console.warn(`[cache] writeBriefCache: rejecting shorter brief for ${customerName} (${text.length} chars vs existing ${existing.text.length} chars)`)
      return
    }
    // lastActivityDate retained for signature compat; fingerprint now governs freshness, so 7d TTL applies uniformly.
    void lastActivityDate
    const ttlMs = BRIEF_CACHE_TTL_MS
    const payload: Record<string, unknown> = { text, cachedAt: new Date().toISOString(), ttlMs }
    if (inputFingerprint) payload.inputFingerprint = inputFingerprint
    if (docCorpusSnapshot && Object.keys(docCorpusSnapshot).length > 0) {
      payload.docCorpusSnapshot = docCorpusSnapshot
    }
    writeFileSync(path, JSON.stringify(payload), { mode: 0o600 })
  } catch {
    // Cache write failure is non-fatal
  }
}


// ── Email cache — Tier 2 (ADR-013) ──────────────────────────────────────────
// Wall-clock TTL. Unconditional overwrite on miss — no hash guard. Eliminates
// live Gmail API calls on every brief generation for recently-fetched data.

export const EMAIL_CACHE_TTL_MS = 2 * 60 * 60 * 1000  // 2 hours

function emailCachePath(customerSlug: string): string {
  if (!customerSlug || /[^a-zA-Z0-9_-]/.test(customerSlug)) {
    throw new Error(`[cache] unsafe slug for email cache path: "${customerSlug}"`)
  }
  return `${CACHE_DIR}/${customerSlug}-emails.json`
}

export function readEmailCache(customerSlug: string): EmailHighlight[] | null {
  try {
    const raw = JSON.parse(readFileSync(emailCachePath(customerSlug), 'utf-8'))
    const ttlMs = typeof raw.ttlMs === 'number' ? raw.ttlMs : EMAIL_CACHE_TTL_MS
    const age = Date.now() - new Date(raw.cachedAt).getTime()
    if (age > ttlMs) return null  // expired
    return Array.isArray(raw.data) ? raw.data : null
  } catch {
    return null
  }
}

export function writeEmailCache(customerSlug: string, emails: EmailHighlight[]): void {
  try {
    writeFileSync(
      emailCachePath(customerSlug),
      JSON.stringify({ data: emails, cachedAt: new Date().toISOString(), ttlMs: EMAIL_CACHE_TTL_MS }),
      { mode: 0o600 },
    )
  } catch (e: any) { console.warn('[cache] email write failed:', e.message) }
}

// ── Meeting cache — Tier 2 (ADR-013) ────────────────────────────────────────
// Wall-clock TTL. Unconditional overwrite on miss — no hash guard. Eliminates
// live Google Calendar API calls on every brief generation.

export const MEETING_CACHE_TTL_MS = 2 * 60 * 60 * 1000  // 2 hours

function meetingCachePath(customerSlug: string): string {
  if (!customerSlug || /[^a-zA-Z0-9_-]/.test(customerSlug)) {
    throw new Error(`[cache] unsafe slug for meeting cache path: "${customerSlug}"`)
  }
  return `${CACHE_DIR}/${customerSlug}-meetings.json`
}

export function readMeetingCache(customerSlug: string): CalendarEvent[] | null {
  try {
    const raw = JSON.parse(readFileSync(meetingCachePath(customerSlug), 'utf-8'))
    const ttlMs = typeof raw.ttlMs === 'number' ? raw.ttlMs : MEETING_CACHE_TTL_MS
    const age = Date.now() - new Date(raw.cachedAt).getTime()
    if (age > ttlMs) return null  // expired
    return Array.isArray(raw.data) ? raw.data : null
  } catch {
    return null
  }
}

export function writeMeetingCache(customerSlug: string, meetings: CalendarEvent[]): void {
  try {
    writeFileSync(
      meetingCachePath(customerSlug),
      JSON.stringify({ data: meetings, cachedAt: new Date().toISOString(), ttlMs: MEETING_CACHE_TTL_MS }),
      { mode: 0o600 },
    )
  } catch (e: any) { console.warn('[cache] meeting write failed:', e.message) }
}

// ── Sheet data cache — permanent (no date), stays until force-refreshed ────────
export function sheetCachePath(customerName: string): string {
  const slug = toSlug(customerName)
  if (!slug || /[^a-zA-Z0-9_-]/.test(slug)) {
    throw new Error(`[cache] unsafe slug for cache path: "${slug}"`)
  }
  return `${CACHE_DIR}/${slug}-sheets.json`
}

export function readSheetCache(customerName: string): { rows: ProductSubscription[]; cachedAt: string } | null {
  try {
    return JSON.parse(readFileSync(sheetCachePath(customerName), 'utf-8'))
  } catch {
    return null
  }
}

export function writeSheetCache(customerName: string, rows: ProductSubscription[]): void {
  try {
    const newHash = createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16)
    const existing = readSheetCache(customerName)
    const existingHash = existing ? createHash('sha256').update(JSON.stringify(existing.rows)).digest('hex').slice(0, 16) : null
    if (existingHash === newHash) return  // data unchanged — preserve cachedAt so brief cache stays valid
    writeFileSync(sheetCachePath(customerName), JSON.stringify({ rows, cachedAt: new Date().toISOString() }), { mode: 0o600 })
  } catch (e: any) { console.warn('[cache] sheet write failed:', e.message) }
}

export function isBriefCacheFile(slug: string, filename: string): boolean {
  const datePattern = /^\d{4}-\d{2}-\d{2}\.json$/
  if (!filename.startsWith(slug + '-')) return false
  const suffix = filename.slice(slug.length + 1)
  return datePattern.test(suffix)
}

export function readLatestBriefCache(customerName: string): { text: string; cachedAt: string; date: string } | null {
  try {
    const slug = toSlug(customerName)
    const files = readdirSync(CACHE_DIR)
      .filter((f) => isBriefCacheFile(slug, f))
      .sort()
      .reverse()
    if (!files.length) return null
    const data = JSON.parse(readFileSync(resolve(CACHE_DIR, files[0]), 'utf-8'))
    const date = files[0].replace(`${slug}-`, '').replace('.json', '')
    return { ...data, date }
  } catch {
    return null
  }
}

// ── CCSP Cloud Spend cache ──────────────────────────────────────────────────
export function readCCSPCache(): { records: CCSPRecord[]; cachedAt: string; fileIds?: string[]; hash?: string } | null {
  try {
    return JSON.parse(readFileSync(`${CACHE_DIR}/ccsp-data.json`, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * BKL-CCSP-03: Check whether the CCSP cache is stale relative to the current AE set.
 * Returns true if the cached fileIds do not exactly match the provided currentSheetIds
 * (i.e., AEs were added, removed, or completely replaced since the cache was written).
 */
export function isCCSPCacheStale(currentSheetIds: string[]): boolean {
  const cached = readCCSPCache()
  if (!cached) return true  // no cache at all — stale by definition
  const cachedIds = cached.fileIds ?? []
  if (currentSheetIds.length !== cachedIds.length) return true
  // Sort both for order-independent comparison
  const sortedCurrent = [...currentSheetIds].sort()
  const sortedCached = [...cachedIds].sort()
  return sortedCurrent.some((id, i) => id !== sortedCached[i])
}

/**
 * BKL-CCSP-03: Invalidate CCSP cache by removing the file.
 * Called when AE set changes and cached data is known stale.
 */
export function invalidateCCSPCache(): void {
  try {
    unlinkSync(`${CACHE_DIR}/ccsp-data.json`)
    console.log('[cache] invalidated stale CCSP cache (AE set changed)')
  } catch {
    // File may not exist — that's fine
  }
}

export function writeCCSPCache(records: CCSPRecord[], fileIds: string[] = []): void {
  try {
    const newHash = createHash('sha256').update(JSON.stringify(records)).digest('hex').slice(0, 16)
    const existing = readCCSPCache()
    const existingHash = existing
      ? (existing.hash ?? createHash('sha256').update(JSON.stringify(existing.records)).digest('hex').slice(0, 16))
      : null
    if (existingHash === newHash) return  // data unchanged — preserve cachedAt so brief fingerprint stays stable
    writeFileSync(`${CACHE_DIR}/ccsp-data.json`, JSON.stringify({ records, cachedAt: new Date().toISOString(), fileIds, hash: newHash }), { mode: 0o600 })
  } catch (e: any) { console.warn('[cache] CCSP write failed:', e.message) }
}

// ── Pipeline cache ──────────────────────────────────────────────────────────
export function readPipelineCache(): { records: PipelineRecord[]; cachedAt: string; fileIds?: string[]; hash?: string } | null {
  try {
    return JSON.parse(readFileSync(`${CACHE_DIR}/pipeline-data.json`, 'utf-8'))
  } catch {
    return null
  }
}

export function writePipelineCache(records: PipelineRecord[], fileIds: string[] = []): void {
  try {
    const newHash = createHash('sha256').update(JSON.stringify({ records, fileIds })).digest('hex').slice(0, 16)
    const existing = readPipelineCache()
    const existingHash = existing
      ? (existing.hash ?? createHash('sha256').update(JSON.stringify({ records: existing.records, fileIds: existing.fileIds ?? [] })).digest('hex').slice(0, 16))
      : null
    if (existingHash === newHash) return  // data unchanged — preserve cachedAt so brief fingerprint stays stable
    writeFileSync(`${CACHE_DIR}/pipeline-data.json`, JSON.stringify({ records, cachedAt: new Date().toISOString(), fileIds, hash: newHash }), { mode: 0o600 })
  } catch (e: any) { console.warn('[cache] pipeline write failed:', e.message) }
}

// ── Drive doc raw content cache — Tier 3 (ADR-013) ──────────────────────────
// Content-addressed by (fileId, modifiedTime). No TTL — fingerprint IS the invalidation key.
// Eliminates repeated drive.files.export() and PDF multimodal re-runs on every brief.

function safeModTime(modifiedTime: string): string {
  return modifiedTime.replace(/[:.]/g, '-')
}

function docContentCachePath(fileId: string, modifiedTime: string): string {
  return `${CACHE_DIR}/docs/${fileId}-${safeModTime(modifiedTime)}.json`
}

export function readDocContentCache(fileId: string, modifiedTime: string): string | null {
  try {
    const data = JSON.parse(readFileSync(docContentCachePath(fileId, modifiedTime), 'utf-8'))
    return typeof data.content === 'string' ? data.content : null
  } catch {
    return null
  }
}

export function writeDocContentCache(fileId: string, modifiedTime: string, content: string): void {
  try {
    mkdirSync(`${CACHE_DIR}/docs`, { recursive: true })
    writeFileSync(
      docContentCachePath(fileId, modifiedTime),
      JSON.stringify({ content, cachedAt: new Date().toISOString() }),
      { mode: 0o600 },
    )
  } catch (e: any) { console.warn('[cache] doc-content write failed:', e.message) }
}

// ── Doc classification cache — Tier 3 (ADR-013) ─────────────────────────────
// Content-addressed by (fileId, modifiedTime). No TTL.
// Eliminates N Gemini classification calls per brief for stable Drive folders.

function docClassCachePath(fileId: string, modifiedTime: string): string {
  return `${CACHE_DIR}/doc-classifications/${fileId}-${safeModTime(modifiedTime)}.json`
}

export function readDocClassCache(fileId: string, modifiedTime: string): DocClassification | null {
  try {
    const data = JSON.parse(readFileSync(docClassCachePath(fileId, modifiedTime), 'utf-8'))
    return data.classification ?? null
  } catch {
    return null
  }
}

export function writeDocClassCache(fileId: string, modifiedTime: string, classification: DocClassification): void {
  try {
    mkdirSync(`${CACHE_DIR}/doc-classifications`, { recursive: true })
    writeFileSync(
      docClassCachePath(fileId, modifiedTime),
      JSON.stringify({ classification, cachedAt: new Date().toISOString() }),
      { mode: 0o600 },
    )
  } catch (e: any) { console.warn('[cache] doc-class write failed:', e.message) }
}

// ── Industry analysis cache — shared by {industry, region} (BKL-TOKEN-05) ──
// Tier 4: 30-day TTL (industry landscape changes slowly). Keyed by industry+region
// slug, NOT per-customer — so N customers sharing the same industry/region pay
// for at most 1 grounded Gemini call per 30 days instead of N calls.
// Path: {CACHE_DIR}/industry-analysis/{slug}.json

export const INDUSTRY_ANALYSIS_TTL_MS = 30 * 24 * 60 * 60 * 1000  // 30 days

export function industryAnalysisSlug(industry: string, region = 'global'): string {
  return (industry + '-' + region)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function industryAnalysisCachePath(industry: string, region = 'global'): string {
  const slug = industryAnalysisSlug(industry, region)
  if (!slug || /[^a-z0-9\-]/.test(slug)) {
    throw new Error(`[cache] unsafe slug for industry analysis cache: "${slug}"`)
  }
  return `${CACHE_DIR}/industry-analysis/${slug}.json`
}

export function readIndustryAnalysisCache(industry: string, region = 'global'): { analysis: string; cachedAt: string } | null {
  try {
    const data = JSON.parse(readFileSync(industryAnalysisCachePath(industry, region), 'utf-8'))
    const age = Date.now() - new Date(data.cachedAt).getTime()
    if (age > INDUSTRY_ANALYSIS_TTL_MS) return null  // expired per 30d TTL
    if (typeof data.analysis !== 'string') return null
    return { analysis: data.analysis, cachedAt: data.cachedAt }
  } catch {
    return null
  }
}

export function writeIndustryAnalysisCache(industry: string, region = 'global', analysis: string): void {
  try {
    mkdirSync(`${CACHE_DIR}/industry-analysis`, { recursive: true })
    writeFileSync(
      industryAnalysisCachePath(industry, region),
      JSON.stringify({ analysis, cachedAt: new Date().toISOString() }),
      { mode: 0o600 },
    )
  } catch (e: any) { console.warn('[cache] industry-analysis write failed:', e.message) }
}

// ── Orphaned cache cleanup (BKL-M26) ────────────────────────────────────────
// Per-customer cache files use the pattern: <slug>-sheets.json, <slug>-<date>.json
// Global files (cases.json, ccsp-data.json, pipeline-data.json) are never cleaned.

const GLOBAL_CACHE_FILES = new Set(['cases.json', 'ccsp-data.json', 'pipeline-data.json'])

export function cleanOrphanedCacheFiles(currentCustomerNames: string[]): void {
  if (!CACHE_DIR) return
  const validSlugs = new Set(currentCustomerNames.map(toSlug))
  let files: string[]
  try {
    files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'))
  } catch {
    return
  }
  for (const file of files) {
    if (GLOBAL_CACHE_FILES.has(file)) continue
    // Extract slug: <slug>-sheets.json, <slug>-emails.json, <slug>-meetings.json, or <slug>-<YYYY-MM-DD>.json
    const match = file.match(/^(.+?)-(sheets|emails|meetings|\d{4}-\d{2}-\d{2})\.json$/)
    if (!match) continue
    const fileSlug = match[1]
    if (validSlugs.has(fileSlug)) continue
    // Orphaned — slug doesn't match any current customer
    try {
      unlinkSync(resolve(CACHE_DIR, file))
      console.log(`[cleanup] deleted orphaned cache file: ${file}`)
    } catch (e: any) {
      console.warn(`[cleanup] failed to delete ${file}: ${e.message}`)
    }
  }
}

// ── Route registration ──────────────────────────────────────────────────────
export function createCacheRouter(): Hono {
  const router = new Hono()
  // GET /api/cache/status — last-modified time and byte size for each data cache file
  router.get('/api/cache/status', (c) => {
    const sources = [
      { key: 'ccsp',      path: `${CACHE_DIR}/ccsp-data.json` },
      { key: 'pipeline',  path: `${CACHE_DIR}/pipeline-data.json` },
      { key: 'rh_cases',  path: RH_CASES_CACHE_PATH },
    ]
    const result: Record<string, { lastModified: string | null; bytes: number | null }> = {}
    for (const { key, path } of sources) {
      try {
        const f = Bun.file(path)
        const bytes = f.size
        const mtimeMs = f.lastModified
        const d = new Date(mtimeMs)
        // Guard against Bun returning bogus mtime for empty/missing files
        const lastModified = !isNaN(d.getTime()) && d.getFullYear() > 1970 && d.getFullYear() < 9999
          ? d.toISOString()
          : null
        result[key] = { lastModified, bytes: bytes > 0 ? bytes : null }
      } catch {
        result[key] = { lastModified: null, bytes: null }
      }
    }
    return c.json(result)
  })

  return router
}
