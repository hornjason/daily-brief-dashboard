// src/scraper-status-store.ts
// Centralized persistent scraper status store (council-approved design 2026-04-03).
// Replaces 6 scattered `export let` status variables across scraper modules.
// Phase 1: ADD calls alongside existing variables. Old variables removed in phase 2.

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'node:path'
import { sanitizeErr } from './utils.ts'
import { ScraperRegistry } from './scraper-registry.ts'
import { writeJsonAtomic } from './lib/atomic-write.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export type ScraperName = 'rh-cases' | 'supportable' | 'ccsp' | 'sf-pipeline'
export type ScraperState = 'fresh' | 'stale' | 'failed' | 'running'

export interface ScraperStatusEntry {
  state: ScraperState
  lastRun: string | null        // ISO timestamp
  lastSuccess: string | null    // ISO timestamp of last successful run
  lastError: string | null      // sanitized error message
  recordCount: number           // rows/cases returned
  durationMs: number            // how long the scrape took
  updatedAt: string             // ISO timestamp of this status write
  consecutiveFailures: number   // increments on failure, resets to 0 on success
}

export type ScraperStatusMap = Record<ScraperName, ScraperStatusEntry>

// ── Constants ────────────────────────────────────────────────────────────────

/** Minutes after lastSuccess that a scraper is considered stale.
 *  BKL-UX-STALE-HEALTH-01: Partial — 'supportable' is permanently disabled and
 *  intentionally omitted so it never participates in staleness calculations. */
const STALE_THRESHOLDS: Partial<Record<ScraperName, number>> = {
  'rh-cases':    4 * 60,   // 4 hours
  'ccsp':        24 * 60,  // 24 hours
  'sf-pipeline': 24 * 60,  // 24 hours
}

// Lazy path resolution so tests can set CACHE_DIR before any reads/writes occur.
function getStatusFilePath() {
  return resolve(process.env.CACHE_DIR ?? 'data/cache', 'scraper-status.json')
}

const SCRAPER_NAMES: ScraperName[] = ['rh-cases', 'ccsp', 'sf-pipeline']

// ── In-memory store ──────────────────────────────────────────────────────────

function defaultEntry(): ScraperStatusEntry {
  return {
    state: 'stale',
    lastRun: null,
    lastSuccess: null,
    lastError: null,
    recordCount: 0,
    durationMs: 0,
    updatedAt: new Date().toISOString(),
    consecutiveFailures: 0,
  }
}

// BKL-UX-STALE-HEALTH-01: Partial — 'supportable' is permanently disabled and
// intentionally never initialized. Callers that still pass 'supportable' (legacy
// scraper modules) write to a key the store never serves via getStatus().
let _store: Partial<ScraperStatusMap> = {
  'rh-cases':    defaultEntry(),
  'ccsp':        defaultEntry(),
  'sf-pipeline': defaultEntry(),
}

// ── Persistence helpers ──────────────────────────────────────────────────────

/** Write current store to disk atomically via writeJsonAtomic. */
function persistStore(): void {
  try {
    writeJsonAtomic(getStatusFilePath(), _store)
  } catch (e: any) {
    console.warn('[scraper-status-store] failed to persist:', sanitizeErr(e))
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load scraper-status.json from $CACHE_DIR on startup.
 * If the file doesn't exist, initializes all scrapers as stale.
 * Call this during initBackgroundScheduler().
 */
export function initStatusStore(): void {
  try {
    if (!existsSync(getStatusFilePath())) {
      console.log('[scraper-status-store] no status file found — initializing with defaults')
      return
    }
    const raw = readFileSync(getStatusFilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ScraperStatusMap>
    // BKL-UX-STALE-HEALTH-01: Strip retired 'supportable' key from disk before
    // it enters memory. Older scraper-status.json files (pre-disable) carry a
    // 'supportable' entry that would otherwise resurface in /api/scraper-status
    // and the Session Health Panel after a restart. Supportable is permanently
    // disabled — its disk entry must never reappear in the live store.
    if (parsed && typeof parsed === 'object' && 'supportable' in parsed) {
      delete (parsed as any).supportable
    }
    // Merge parsed entries over defaults to handle partial/missing keys
    for (const name of SCRAPER_NAMES) {
      if (parsed[name] && typeof parsed[name] === 'object') {
        _store[name] = { ...defaultEntry(), ...parsed[name] }
      }
    }
    console.log('[scraper-status-store] loaded status from disk')
  } catch (e: any) {
    console.warn('[scraper-status-store] failed to load status file, using defaults:', sanitizeErr(e))
  }
}

/**
 * Record the outcome of a scrape run.
 * On success: sets state 'fresh', updates lastRun, lastSuccess, recordCount, durationMs.
 * On failure: sets state 'failed', updates lastRun, lastError.
 * Always updates updatedAt and persists to disk.
 */
export function recordOutcome(
  name: ScraperName,
  result: { success: boolean; recordCount?: number; durationMs?: number; error?: string },
): void {
  const now = new Date().toISOString()
  const entry = _store[name]
  // BKL-UX-STALE-HEALTH-01: silent no-op for retired scrapers (e.g. 'supportable')
  // whose entry was never initialized. Legacy callers stay safe.
  if (!entry) return

  if (result.success) {
    entry.state = 'fresh'
    entry.lastRun = now
    entry.lastSuccess = now
    entry.lastError = null
    entry.recordCount = result.recordCount ?? 0
    entry.durationMs = result.durationMs ?? 0
    entry.consecutiveFailures = 0
  } else {
    entry.state = 'failed'
    entry.lastRun = now
    entry.lastError = result.error ? sanitizeErr({ message: result.error }) : null
    entry.consecutiveFailures = (entry.consecutiveFailures ?? 0) + 1
  }
  entry.updatedAt = now

  persistStore()
}

/**
 * Seed scraper success state from a disk cache at startup.
 * Unlike recordOutcome, this accepts an explicit timestamp (not always 'now').
 * Use only in startup seed paths (e.g. initSfSyncFromCache). Never call from scrape paths.
 */
export function seedSuccess(
  name: ScraperName,
  { lastSuccess, recordCount }: { lastSuccess: string; recordCount: number }
): void {
  const entry = _store[name]
  if (!entry) return
  entry.state = 'fresh'
  entry.lastRun = lastSuccess
  entry.lastSuccess = lastSuccess
  entry.recordCount = recordCount
  entry.lastError = null
  entry.consecutiveFailures = 0
  entry.updatedAt = new Date().toISOString()
  persistStore()
}

/**
 * Mark a scraper as currently running.
 * Sets state 'running' and updatedAt. Persists to disk.
 */
export function markRunning(name: ScraperName): void {
  const entry = _store[name]
  // BKL-UX-STALE-HEALTH-01: silent no-op for retired scrapers (e.g. 'supportable')
  if (!entry) return
  entry.state = 'running'
  entry.updatedAt = new Date().toISOString()
  persistStore()
}

/**
 * Get the full status map.
 * Applies staleness check: if lastSuccess is older than threshold, overrides
 * state to 'stale' (unless currently 'running').
 */
export function getStatus(): ScraperStatusMap {
  const now = Date.now()
  const result = {} as ScraperStatusMap

  for (const name of SCRAPER_NAMES) {
    const stored = _store[name]
    if (!stored) continue
    const entry = { ...stored }

    if (entry.state !== 'running') {
      const threshold = STALE_THRESHOLDS[name]
      const thresholdMs = (threshold ?? 0) * 60 * 1000
      const lastSuccess = entry.lastSuccess ? new Date(entry.lastSuccess).getTime() : null
      if (!lastSuccess || (now - lastSuccess) > thresholdMs) {
        entry.state = 'stale'
      }
    }

    result[name] = entry
  }

  return result
}

/**
 * Get the status for a single scraper.
 * Applies staleness check same as getStatus().
 * Returns a safe stale-default entry for retired scrapers (e.g. 'supportable')
 * that have no entry in the store — preserves legacy caller compatibility
 * without resurrecting them in /api/scraper-status (getStatus() skips them).
 */
export function getScraperStatus(name: ScraperName): ScraperStatusEntry {
  return getStatus()[name] ?? defaultEntry()
}

// ── Unified status (BKL-ARCH-02) ─────────────────────────────────────────────
//
// Phase 1 of unified scraper status. Exposes a single struct that resolves the
// in-memory hint vs. on-disk store ordering once, in one place. Existing
// getStatus / getScraperStatus / recordOutcome / markRunning are unchanged so
// the existing unit tests keep passing — callers migrate at their own pace.
//
// Resolution order for `lastSync`:
//   1. In-memory hint via ScraperRegistry.get(name).getInMemoryLastSync()
//      (process-local timestamp; survives intra-process restart of a scrape)
//   2. store.lastSuccess (persisted to disk in scraper-status.json)
//   3. null
//
// `isStale` is computed against STALE_THRESHOLDS[name]. Scrapers without an
// entry (e.g. retired 'supportable') always report isStale: true and
// state: 'stale' regardless of lastSync — they can never become fresh.

export interface UnifiedScraperStatus {
  scraper: ScraperName
  /** Resolved freshness timestamp: inMemoryHint ?? store.lastSuccess ?? null */
  lastSync: string | null
  /** Raw store.lastSuccess (independent of in-memory hint) */
  lastSuccess: string | null
  lastRun: string | null
  lastError: string | null
  /** null for retired scrapers, otherwise the store's recordCount */
  recordCount: number | null
  state: ScraperState
  isRunning: boolean
  /** Computed against STALE_THRESHOLDS[name]; always true for retired scrapers. */
  isStale: boolean
  consecutiveFailures: number
  durationMs: number
  updatedAt: string
}

function readRegistryHints(name: ScraperName): {
  inMemoryLastSync: string | null
  inMemoryLastError: string | null
  inMemoryIsRunning: boolean
} {
  const desc = ScraperRegistry.get(name)
  if (!desc) {
    return { inMemoryLastSync: null, inMemoryLastError: null, inMemoryIsRunning: false }
  }
  let inMemoryLastSync: string | null = null
  let inMemoryLastError: string | null = null
  let inMemoryIsRunning = false
  try { inMemoryLastSync = desc.getInMemoryLastSync() } catch { /* ignore */ }
  try { inMemoryLastError = desc.getInMemoryLastError() } catch { /* ignore */ }
  try { inMemoryIsRunning = desc.getInMemoryIsRunning() } catch { /* ignore */ }
  return { inMemoryLastSync, inMemoryLastError, inMemoryIsRunning }
}

export function getUnifiedStatus(name: ScraperName): UnifiedScraperStatus {
  const stored = _store[name]
  const baseEntry = stored ?? defaultEntry()
  const hints = readRegistryHints(name)

  const lastSuccess = baseEntry.lastSuccess
  const lastSync = hints.inMemoryLastSync ?? lastSuccess ?? null

  const threshold = STALE_THRESHOLDS[name]
  const hasThreshold = typeof threshold === 'number'
  const desc = ScraperRegistry.get(name)
  const retired = desc?.retired === true

  let isStale: boolean
  if (!hasThreshold || retired) {
    isStale = true
  } else if (!lastSync) {
    isStale = true
  } else {
    const ageMs = Date.now() - new Date(lastSync).getTime()
    isStale = ageMs > threshold * 60 * 1000
  }

  const isRunning = hints.inMemoryIsRunning || baseEntry.state === 'running'
  let state: ScraperState = baseEntry.state
  if (isRunning) {
    state = 'running'
  } else if (retired || !hasThreshold) {
    state = 'stale'
  } else if (state !== 'failed' && isStale) {
    state = 'stale'
  }

  const recordCount = retired || !hasThreshold ? null : baseEntry.recordCount

  return {
    scraper: name,
    lastSync,
    lastSuccess,
    lastRun: baseEntry.lastRun,
    lastError: hints.inMemoryLastError ?? baseEntry.lastError,
    recordCount,
    state,
    isRunning,
    isStale,
    consecutiveFailures: baseEntry.consecutiveFailures ?? 0,
    durationMs: baseEntry.durationMs,
    updatedAt: baseEntry.updatedAt,
  }
}

export function getAllUnifiedStatus(): Record<ScraperName, UnifiedScraperStatus> {
  // BKL-ARCH-SCRAPER-09-FOLLOW-01: 'supportable' removed — permanently disabled; no longer exposed in API
  const names: ScraperName[] = ['rh-cases', 'ccsp', 'sf-pipeline']
  const out = {} as Record<ScraperName, UnifiedScraperStatus>
  for (const n of names) out[n] = getUnifiedStatus(n)
  return out
}
