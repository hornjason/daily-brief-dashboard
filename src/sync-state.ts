/**
 * src/sync-state.ts — BKL-INGEST-09
 *
 * Tracks whether today's scheduled scrapes ran.
 * Used by initBackgroundScheduler() to detect late container startup
 * and trigger a catch-up sync after a 60s stabilization delay.
 *
 * File: ${CACHE_DIR}/sync-state.json
 *
 * Schema:
 * {
 *   "date": "2026-04-19",           // ISO date YYYY-MM-DD
 *   "flows": {
 *     "sfBookings": "ok" | "failed" | "partial" | null,
 *     "ccsp":       "ok" | "failed" | "partial" | null,
 *     "pipeline":   "ok" | "failed" | "partial" | null
 *   },
 *   "updatedAt": "2026-04-19T06:31:00Z"
 * }
 */

import { existsSync, readFileSync } from 'fs'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { resolve } from 'path'

// ── Types ─────────────────────────────────────────────────────────────────────

export type FlowStatus = 'ok' | 'failed' | 'partial' | null

export interface SyncStateFlows {
  sfBookings: FlowStatus
  ccsp:       FlowStatus
  pipeline:   FlowStatus
}

export interface SyncState {
  date:      string           // YYYY-MM-DD
  flows:     SyncStateFlows
  updatedAt: string           // ISO timestamp
}

// ── File path ─────────────────────────────────────────────────────────────────

const SYNC_STATE_PATH = resolve(process.env.DATA_DIR ?? 'data', 'cache', 'sync-state.json')

const DEFAULT_STATE: SyncState = {
  date: '',
  flows: { sfBookings: null, ccsp: null, pipeline: null },
  updatedAt: new Date().toISOString(),
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns today's date as YYYY-MM-DD (local time). */
function todayDate(): string {
  return new Date().toLocaleDateString('en-CA')  // YYYY-MM-DD
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read sync-state.json from disk.
 * Returns a default (empty) state if the file is missing or corrupt.
 */
export function readSyncState(): SyncState {
  try {
    if (!existsSync(SYNC_STATE_PATH)) return { ...DEFAULT_STATE, date: todayDate() }
    const raw = JSON.parse(readFileSync(SYNC_STATE_PATH, 'utf-8'))
    return {
      date:      typeof raw.date === 'string'      ? raw.date      : todayDate(),
      flows:     typeof raw.flows === 'object' && raw.flows !== null ? {
        sfBookings: raw.flows.sfBookings ?? null,
        ccsp:       raw.flows.ccsp       ?? null,
        pipeline:   raw.flows.pipeline   ?? null,
      } : { sfBookings: null, ccsp: null, pipeline: null },
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    }
  } catch {
    return { ...DEFAULT_STATE, date: todayDate() }
  }
}

/**
 * Atomically update a single flow's status in sync-state.json.
 * Uses tmp + rename to prevent corrupt file on crash during write.
 *
 * Note: Current design stores a single snapshot. This function resets
 * date to today on every write, so old entries naturally drop off.
 * Cleanup logic below is defensive for future time-series schemas.
 */
export function writeSyncStateFlow(
  flow: keyof SyncStateFlows,
  status: FlowStatus,
): void {
  try {
    const existing = readSyncState()
    const today = todayDate()
    const next: SyncState = {
      date:      today,
      flows:     { ...existing.flows, [flow]: status },
      updatedAt: new Date().toISOString(),
    }
    writeJsonAtomic(SYNC_STATE_PATH, next)
    console.log(`[sync-state] ${flow} → ${status} (date: ${today})`)

    // Defensive cleanup: if schema evolves to time-series, enforce 90-day retention
    // Current single-entry design self-rotates, so this is future-proofing only.
    cleanupSyncState()
  } catch (e: any) {
    console.warn(`[sync-state] writeSyncStateFlow failed: ${e.message}`)
  }
}

/**
 * Remove sync-state entries older than 90 days.
 * Current schema (single snapshot) makes this a no-op, but defends against
 * future time-series evolution where old entries could accumulate.
 */
function cleanupSyncState(): void {
  try {
    if (!existsSync(SYNC_STATE_PATH)) return
    const raw = JSON.parse(readFileSync(SYNC_STATE_PATH, 'utf-8'))

    // Current schema: single entry with .date field (YYYY-MM-DD)
    // Future schema: could be an array of { date, flows, updatedAt }[]
    // This cleanup handles both cases safely

    if (Array.isArray(raw)) {
      // Time-series format (future-proofing)
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA')
      const cleaned = raw.filter((entry: any) => {
        if (typeof entry.date !== 'string') return false
        return entry.date >= ninetyDaysAgo
      })
      if (cleaned.length < raw.length) {
        writeJsonAtomic(SYNC_STATE_PATH, cleaned)
        console.log(`[sync-state] cleaned ${raw.length - cleaned.length} entries older than 90 days`)
      }
    }
    // Single-entry format: no cleanup needed (self-rotates via date reset)
  } catch (e: any) {
    console.warn(`[sync-state] cleanup failed: ${e.message}`)
  }
}

/**
 * Returns true if today's sync has already run successfully.
 * Condition: date === today AND at least one flow is 'ok'.
 */
export function todaySyncRan(): boolean {
  const state = readSyncState()
  const today = todayDate()
  if (state.date !== today) return false
  return Object.values(state.flows).some(s => s === 'ok')
}
