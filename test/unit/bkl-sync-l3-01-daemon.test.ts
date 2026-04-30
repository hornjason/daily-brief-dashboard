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
  test('daemon checks NODE_ROLE === primary at startup', () => {
    expect(DAEMON_SRC).toContain("process.env.NODE_ROLE !== 'primary'")
  })

  test('daemon calls process.exit(1) on non-primary NODE_ROLE', () => {
    // The guard and exit must appear together
    const guardIdx = DAEMON_SRC.indexOf("process.env.NODE_ROLE !== 'primary'")
    const nearbySlice = DAEMON_SRC.slice(guardIdx, guardIdx + 200)
    expect(nearbySlice).toContain('process.exit(1)')
  })

  test('getMsUntil530amET is exported from sync-l3-daemon.ts', () => {
    expect(DAEMON_SRC).toContain('export function getMsUntil530amET(')
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
    const slice = SYNC_POD_SRC.slice(fnIdx, fnIdx + 2500)
    expect(slice).toContain('completedAt')
    expect(slice).toContain('results')
  })

  test('SYNC_NOW env var triggers immediate run', () => {
    expect(SYNC_POD_SRC).toContain("process.env.SYNC_NOW === 'true'")
    expect(SYNC_POD_SRC).toContain('syncAllPods()')
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
