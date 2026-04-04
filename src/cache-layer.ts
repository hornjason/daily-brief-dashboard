import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import type { Hono } from 'hono'
import type { CCSPRecord } from './sheets.ts'
import type { PipelineRecord } from './pipeline.ts'
import type { ProductSubscription } from './types.ts'

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

// ── Brief cache TTL (ADR-007) ────────────────────────────────────────────────
export const BRIEF_CACHE_TTL_MS = 4 * 60 * 60 * 1000  // 4 hours

// ── Brief cache (daily, date-stamped) ────────────────────────────────────────
export function briefCachePath(customerName: string): string {
  const today = new Date().toLocaleDateString('en-CA') // YYYY-MM-DD local time
  return `${CACHE_DIR}/${toSlug(customerName)}-${today}.json`
}

export function readBriefCache(customerName: string): { text: string; cachedAt: string } | null {
  try {
    return JSON.parse(readFileSync(briefCachePath(customerName), 'utf-8'))
  } catch {
    return null
  }
}

export function writeBriefCache(customerName: string, text: string): void {
  try {
    const path = briefCachePath(customerName)
    // Stale-overwrite guard: don't replace a longer brief with a shorter one
    // (truncated Gemini output or race between pre-gen and on-demand generation)
    const existing = readBriefCache(customerName)
    if (existing && existing.text.length > text.length * 1.5 && text.length < 500) {
      console.warn(`[cache] writeBriefCache: rejecting shorter brief for ${customerName} (${text.length} chars vs existing ${existing.text.length} chars)`)
      return
    }
    writeFileSync(path, JSON.stringify({ text, cachedAt: new Date().toISOString() }), { mode: 0o600 })
  } catch {
    // Cache write failure is non-fatal
  }
}

// ── Brief cache invalidation (BKL-M47) ─────────────────────────────────────
// Called by drive-watcher when customer documents change — deletes today's
// brief cache so the next request triggers fresh generation.

export function invalidateBriefCaches(customerNames: string[]): void {
  for (const name of customerNames) {
    try {
      const path = briefCachePath(name)
      unlinkSync(path)
      console.log(`[cache] invalidated brief cache for ${name}`)
    } catch {
      // Cache file may not exist — that's fine
    }
  }
}

// ── Sheet data cache — permanent (no date), stays until force-refreshed ────────
export function sheetCachePath(customerName: string): string {
  return `${CACHE_DIR}/${toSlug(customerName)}-sheets.json`
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
    writeFileSync(sheetCachePath(customerName), JSON.stringify({ rows, cachedAt: new Date().toISOString() }), { mode: 0o600 })
  } catch (e: any) { console.warn('[cache] sheet write failed:', e.message) }
}

export function readLatestBriefCache(customerName: string): { text: string; cachedAt: string; date: string } | null {
  try {
    const slug = toSlug(customerName)
    const files = readdirSync(CACHE_DIR)
      .filter((f) => f.startsWith(slug + '-') && !f.endsWith('-sheets.json') && f.endsWith('.json'))
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
export function readCCSPCache(): { records: CCSPRecord[]; cachedAt: string; fileIds?: string[] } | null {
  try {
    return JSON.parse(readFileSync(`${CACHE_DIR}/ccsp-data.json`, 'utf-8'))
  } catch {
    return null
  }
}

export function writeCCSPCache(records: CCSPRecord[], fileIds: string[] = []): void {
  try {
    writeFileSync(`${CACHE_DIR}/ccsp-data.json`, JSON.stringify({ records, cachedAt: new Date().toISOString(), fileIds }), { mode: 0o600 })
  } catch (e: any) { console.warn('[cache] CCSP write failed:', e.message) }
}

// ── Pipeline cache ──────────────────────────────────────────────────────────
export function readPipelineCache(): { records: PipelineRecord[]; cachedAt: string; fileIds?: string[] } | null {
  try {
    return JSON.parse(readFileSync(`${CACHE_DIR}/pipeline-data.json`, 'utf-8'))
  } catch {
    return null
  }
}

export function writePipelineCache(records: PipelineRecord[], fileIds: string[] = []): void {
  try {
    writeFileSync(`${CACHE_DIR}/pipeline-data.json`, JSON.stringify({ records, cachedAt: new Date().toISOString(), fileIds }), { mode: 0o600 })
  } catch (e: any) { console.warn('[cache] pipeline write failed:', e.message) }
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
    // Extract slug: either <slug>-sheets.json or <slug>-<YYYY-MM-DD>.json
    const match = file.match(/^(.+?)-(sheets|\d{4}-\d{2}-\d{2})\.json$/)
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
export function registerCacheRoutes(app: Hono): void {
  // GET /api/cache/status — last-modified time and byte size for each data cache file
  app.get('/api/cache/status', (c) => {
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
}
