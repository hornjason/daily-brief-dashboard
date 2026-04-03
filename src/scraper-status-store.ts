// src/scraper-status-store.ts
// Centralized persistent scraper status store (council-approved design 2026-04-03).
// Replaces 6 scattered `export let` status variables across scraper modules.
// Phase 1: ADD calls alongside existing variables. Old variables removed in phase 2.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { resolve } from 'node:path'
import { sanitizeErr } from './utils.ts'

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
}

export type ScraperStatusMap = Record<ScraperName, ScraperStatusEntry>

// ── Constants ────────────────────────────────────────────────────────────────

/** Minutes after lastSuccess that a scraper is considered stale. */
const STALE_THRESHOLDS: Record<ScraperName, number> = {
  'rh-cases':    4 * 60,   // 4 hours
  'supportable': 24 * 60,  // 24 hours
  'ccsp':        24 * 60,  // 24 hours
  'sf-pipeline': 24 * 60,  // 24 hours
}

const STATUS_FILE_PATH = resolve(process.env.CACHE_DIR ?? 'data/cache', 'scraper-status.json')

const SCRAPER_NAMES: ScraperName[] = ['rh-cases', 'supportable', 'ccsp', 'sf-pipeline']

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
  }
}

let _store: ScraperStatusMap = {
  'rh-cases':    defaultEntry(),
  'supportable': defaultEntry(),
  'ccsp':        defaultEntry(),
  'sf-pipeline': defaultEntry(),
}

// ── Persistence helpers ──────────────────────────────────────────────────────

/** Write current store to disk atomically (write .tmp, then rename). */
function persistStore(): void {
  try {
    const tmpPath = STATUS_FILE_PATH + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(_store, null, 2), { mode: 0o600 })
    renameSync(tmpPath, STATUS_FILE_PATH)
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
    if (!existsSync(STATUS_FILE_PATH)) {
      console.log('[scraper-status-store] no status file found — initializing with defaults')
      return
    }
    const raw = readFileSync(STATUS_FILE_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ScraperStatusMap>
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

  if (result.success) {
    entry.state = 'fresh'
    entry.lastRun = now
    entry.lastSuccess = now
    entry.lastError = null
    entry.recordCount = result.recordCount ?? 0
    entry.durationMs = result.durationMs ?? 0
  } else {
    entry.state = 'failed'
    entry.lastRun = now
    entry.lastError = result.error ? sanitizeErr({ message: result.error }) : null
  }
  entry.updatedAt = now

  persistStore()
}

/**
 * Mark a scraper as currently running.
 * Sets state 'running' and updatedAt. Persists to disk.
 */
export function markRunning(name: ScraperName): void {
  _store[name].state = 'running'
  _store[name].updatedAt = new Date().toISOString()
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
    const entry = { ..._store[name] }

    if (entry.state !== 'running') {
      const thresholdMs = STALE_THRESHOLDS[name] * 60 * 1000
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
 */
export function getScraperStatus(name: ScraperName): ScraperStatusEntry {
  return getStatus()[name]
}
