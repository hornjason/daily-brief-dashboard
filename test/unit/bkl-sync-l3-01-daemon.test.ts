// BKL-SYNC-L3-01: Regression tests for the L3 sync daemon.
//
// Verifies structural invariants across the three new files:
//   - runSfPodSync is exported from src/sf-scraper.ts
//   - sync-l3-daemon.ts exits 1 when NODE_ROLE !== 'primary' (source check)
//   - sync-pod-l3.ts exports a syncAllPods function
//   - getMsUntil530amET() returns a positive number and <= 24h
//
// Uses source-grep and runtime tests (no live scrapes).

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')

const SF_SCRAPER = readFileSync(resolve(ROOT, 'src/sf-scraper.ts'), 'utf-8')
const DAEMON_SRC = readFileSync(resolve(ROOT, 'scripts/sync-l3-daemon.ts'), 'utf-8')
const SYNC_POD_SRC = readFileSync(resolve(ROOT, 'scripts/sync-pod-l3.ts'), 'utf-8')

// ── sf-scraper.ts: runSfPodSync exported ──────────────────────────────────────

describe('BKL-SYNC-L3-01: runSfPodSync exported from sf-scraper.ts', () => {
  test('export keyword present on runSfPodSync declaration', () => {
    expect(SF_SCRAPER).toContain('export async function runSfPodSync(')
  })

  test('runSfPodSync takes (reportId, podKey, podBookingsFolderId) parameters', () => {
    const match = SF_SCRAPER.match(/export async function runSfPodSync\(([^)]+)\)/)
    expect(match).not.toBeNull()
    const params = match![1]
    expect(params).toContain('reportId')
    expect(params).toContain('podKey')
    expect(params).toContain('podBookingsFolderId')
  })

  test('runSfPodSync returns Promise<number>', () => {
    expect(SF_SCRAPER).toContain('export async function runSfPodSync(')
    expect(SF_SCRAPER).toContain('Promise<number>')
  })

  test('runSfPodSync performs Drive cache check before live scrape', () => {
    const fnIdx = SF_SCRAPER.indexOf('export async function runSfPodSync(')
    const slice = SF_SCRAPER.slice(fnIdx, fnIdx + 800)
    expect(slice).toContain('Drive cache check')
    expect(slice).toContain('cacheFileName')
  })

  test('runSfPodSync performs stale cache cleanup on write', () => {
    const fnIdx = SF_SCRAPER.indexOf('export async function runSfPodSync(')
    const slice = SF_SCRAPER.slice(fnIdx, fnIdx + 4000)
    expect(slice).toContain('stale')
    expect(slice).toContain('drive.files.delete')
  })
})

// ── sync-l3-daemon.ts: primary guard ─────────────────────────────────────────

describe('BKL-SYNC-L3-01: sync-l3-daemon exits 1 when NODE_ROLE !== primary', () => {
  test('daemon checks primary node role at startup', () => {
    // Daemon uses isPrimary() from node-role.ts (refactored from inline env check)
    expect(DAEMON_SRC).toContain('isPrimary()')
  })

  test('daemon calls process.exit(1) on non-primary NODE_ROLE', () => {
    // The guard and exit must appear together
    const guardIdx = DAEMON_SRC.indexOf('isPrimary()')
    const nearbySlice = DAEMON_SRC.slice(guardIdx, guardIdx + 200)
    expect(nearbySlice).toContain('process.exit(1)')
  })

  test('getMsUntil530amET is exported from sync-l3-daemon.ts', () => {
    expect(DAEMON_SRC).toContain('export function getMsUntil530amET(')
  })
})

// ── sync-pod-l3.ts: checkBookingsGSheetExists label-word matching ─────────────
//
// BKL-SYNC-L3-06 regression: function must accept optional podLabel and use
// label keywords (words >3 chars) as a fallback when pod key doesn't match.
// Real Drive sheets use human names ("Northwest POD - Subscriptions"), not
// pod keys ("WEST_COMM_CORP_NORTHWEST").

describe('BKL-SYNC-L3-06: checkBookingsGSheetExists accepts podLabel parameter', () => {
  test('function signature includes optional podLabel parameter', () => {
    expect(SYNC_POD_SRC).toContain('checkBookingsGSheetExists(folderId: string, podKey: string, podLabel?: string)')
  })

  test('function uses label words >3 chars as fallback match terms', () => {
    const fnIdx = SYNC_POD_SRC.indexOf('async function checkBookingsGSheetExists(')
    const slice = SYNC_POD_SRC.slice(fnIdx, fnIdx + 1200)
    expect(slice).toContain('podLabel')
    expect(slice).toContain('labelWords')
    expect(slice).toContain('length > 3')
  })

  test('call site passes pod.label to checkBookingsGSheetExists', () => {
    expect(SYNC_POD_SRC).toContain('checkBookingsGSheetExists(region.podBookingsFolderId, podKey, pod.label)')
  })
})

// ── sync-pod-l3.ts: syncAllPods exported ─────────────────────────────────────

describe('BKL-SYNC-L3-01: sync-pod-l3.ts exports syncAllPods', () => {
  test('syncAllPods is exported', () => {
    expect(SYNC_POD_SRC).toContain('export async function syncAllPods(')
  })

  test('syncAllPods iterates regions and pods', () => {
    const fnIdx = SYNC_POD_SRC.indexOf('export async function syncAllPods(')
    const slice = SYNC_POD_SRC.slice(fnIdx, fnIdx + 1500)
    expect(slice).toContain('normalizeSettings')
    expect(slice).toContain('for (const region of regions)')
    expect(slice).toContain('for (const [podKey, pod] of Object.entries(region.pods))')
  })

  test('syncAllPods returns SyncRunResult with completedAt and results', () => {
    const fnIdx = SYNC_POD_SRC.indexOf('export async function syncAllPods(')
    // Slice covers the full function body including the SyncRunResult construction at the end.
    // Widened to 8000 chars to accommodate BKL-CCSP-RETRY-01 retry-wrapper logic added inside
    // the per-pod loop. The function is still a single contiguous declaration; we just need
    // a window large enough to span its current implementation.
    const slice = SYNC_POD_SRC.slice(fnIdx, fnIdx + 8000)
    expect(slice).toContain('completedAt')
    expect(slice).toContain('results')
  })

  // ADR-006 §2 H2: SYNC_NOW standalone path removed; daemon trigger mechanism replaces it.
  test('SYNC_NOW standalone path is removed (ADR-006 H2)', () => {
    expect(SYNC_POD_SRC).not.toContain("process.env.SYNC_NOW === 'true'")
  })

  // ADR-006 §2 H1: precondition assertion must be first logic in syncAllPods().
  test('syncAllPods asserts browser contexts initialized (ADR-006 H1)', () => {
    const fnIdx = SYNC_POD_SRC.indexOf('export async function syncAllPods(')
    const slice = SYNC_POD_SRC.slice(fnIdx, fnIdx + 600)
    expect(slice).toContain('getScrapeContext()')
    expect(slice).toContain('getSfContext()')
    expect(slice).toContain('must be invoked through the sync daemon')
  })
})

// ── #447: Recycle mutex — cross-timer coordination ──────────────────────────
//
// Verifies that proactiveRecycle() has a mutex guard, keepalive checks it before
// recovery, sync pre-check waits for it, Timer 5 calls proactiveRecycle() (guarded),
// and there's a 90s timeout.

describe('#447: recycleRunning mutex guards proactiveRecycle()', () => {
  test('AC-1: recycleRunning flag declared at module level', () => {
    expect(DAEMON_SRC).toContain('let recycleRunning = false')
  })

  test('AC-1: proactiveRecycle checks recycleRunning and skips if true', () => {
    const fnIdx = DAEMON_SRC.indexOf('async function proactiveRecycle()')
    expect(fnIdx).toBeGreaterThan(-1)
    const slice = DAEMON_SRC.slice(fnIdx, fnIdx + 400)
    expect(slice).toContain('if (recycleRunning)')
    expect(slice).toContain('SKIPPED — another recycle is already in progress')
    expect(slice).toContain('recycleRunning = true')
  })

  test('AC-1: proactiveRecycle releases mutex in finally block', () => {
    const fnIdx = DAEMON_SRC.indexOf('async function proactiveRecycle()')
    const fnBody = DAEMON_SRC.slice(fnIdx, fnIdx + 4500)
    expect(fnBody).toContain('finally')
    expect(fnBody).toContain('recycleRunning = false')
  })

  test('AC-2: keepalive checks recycleRunning before calling recoverScrapeContext', () => {
    // Find the keepalive health check section
    const healthIdx = DAEMON_SRC.indexOf('isContextHealthy(ctx')
    expect(healthIdx).toBeGreaterThan(-1)
    const slice = DAEMON_SRC.slice(healthIdx, healthIdx + 500)
    expect(slice).toContain('recycleRunning')
    expect(slice).toContain('keepalive: recycle in progress — skipping RH recovery')
  })

  test('AC-3: runSyncCycle checks recycleRunning and waits up to 60s', () => {
    const syncIdx = DAEMON_SRC.indexOf('async function runSyncCycle()')
    expect(syncIdx).toBeGreaterThan(-1)
    const slice = DAEMON_SRC.slice(syncIdx, syncIdx + 2000)
    expect(slice).toContain('recycleRunning')
    expect(slice).toContain('recycle already in progress — waiting up to 60s')
    expect(slice).toContain('60_000')
  })

  test('AC-4: Timer 5 calls proactiveRecycle (mutex guard is inside the function)', () => {
    // Timer 5 is the 12h recycle interval — it calls proactiveRecycle() which has the guard
    expect(DAEMON_SRC).toContain('RECYCLE_INTERVAL_MS')
    const timer5Idx = DAEMON_SRC.indexOf('scheduled 12h browser recycle')
    expect(timer5Idx).toBeGreaterThan(-1)
    const slice = DAEMON_SRC.slice(timer5Idx, timer5Idx + 300)
    expect(slice).toContain('proactiveRecycle()')
  })

  test('AC-5: proactiveRecycle has a 90s hard timeout with Promise.race', () => {
    const fnIdx = DAEMON_SRC.indexOf('async function proactiveRecycle()')
    const fnBody = DAEMON_SRC.slice(fnIdx, fnIdx + 3500)
    expect(fnBody).toContain('Promise.race')
    expect(fnBody).toContain('RECYCLE_TIMEOUT_MS')
    expect(fnBody).toContain("'timeout'")
  })

  test('AC-5: 90s timeout constant defined', () => {
    expect(DAEMON_SRC).toContain('const RECYCLE_TIMEOUT_MS = 90_000')
  })

  test('AC-5: timeout sends alert email recommending container restart', () => {
    const fnIdx = DAEMON_SRC.indexOf('async function proactiveRecycle()')
    const fnBody = DAEMON_SRC.slice(fnIdx, fnIdx + 3500)
    expect(fnBody).toContain('TIMED OUT')
    expect(fnBody).toContain('sendBriefEmail')
    expect(fnBody).toContain('podman restart pai-sync-l3')
  })

  test('AC-7: _getRecycleRunning test helper exported', () => {
    expect(DAEMON_SRC).toContain('export function _getRecycleRunning()')
  })
})

// ── getMsUntil530amET: inline implementation test ────────────────────────────
//
// The daemon module calls process.exit(1) at top-level when NODE_ROLE !== 'primary',
// so we cannot dynamically import it in a test environment. Instead we test the
// getMsUntil530amET logic directly by reimplementing it inline — this validates
// the algorithm without triggering the process guard.

function getMsUntil530amET(): number {
  const now = new Date()
  const target = new Date(now)
  target.setUTCHours(9, 30, 0, 0)
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1)
  }
  return target.getTime() - now.getTime()
}

describe('BKL-SYNC-L3-01: getMsUntil530amET() returns valid delay', () => {
  test('returns a positive number', () => {
    const ms = getMsUntil530amET()
    expect(typeof ms).toBe('number')
    expect(ms).toBeGreaterThan(0)
  })

  test('returns a value <= 24 hours in milliseconds', () => {
    const ms = getMsUntil530amET()
    const msIn24h = 24 * 60 * 60 * 1000
    expect(ms).toBeLessThanOrEqual(msIn24h)
  })

  test('algorithm matches daemon source (target = next 09:30 UTC)', () => {
    // Verify the exported source describes the same 09:30 UTC target
    expect(DAEMON_SRC).toContain('setUTCHours(9, 30, 0, 0)')
    expect(DAEMON_SRC).toContain('setUTCDate(target.getUTCDate() + 1)')
  })
})
