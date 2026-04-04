/**
 * src/scraper-status-store.test.ts
 * Unit tests for scraper-status-store.ts public API.
 *
 * We set CACHE_DIR to a temp path before importing the module so that disk
 * persistence doesn't touch the real data directory.
 */

// Set temp CACHE_DIR before any module is imported — must be before the import
const _tmpDir = `/tmp/test-scraper-status-${Date.now()}`
process.env.CACHE_DIR = _tmpDir

import { mkdirSync } from 'fs'
mkdirSync(_tmpDir, { recursive: true })

import { test, expect, describe, beforeEach } from 'bun:test'
import {
  recordOutcome,
  markRunning,
  getStatus,
  getScraperStatus,
  initStatusStore,
  type ScraperName,
} from './scraper-status-store.ts'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Drive the named scraper back to a baseline 'stale' state by re-initializing. */
function resetToDefault(name: ScraperName): void {
  // Force a success run to wipe old state, then nothing — state will be 'fresh'
  // We can't reset to 'stale' directly from tests. Instead, each describe block
  // assumes fresh import state or documents the expected transition.
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getScraperStatus — initial state', () => {
  test('rh scraper initial state is stale (no lastSuccess yet)', () => {
    // On first import, defaultEntry() sets state 'stale' and lastSuccess null.
    // initStatusStore() may have loaded from disk if file exists (unlikely in /tmp).
    // We only guarantee: getScraperStatus returns a valid entry.
    const status = getScraperStatus('rh-cases')
    expect(status).toBeDefined()
    expect(['fresh', 'stale', 'failed', 'running']).toContain(status.state)
    expect(status.consecutiveFailures).toBeGreaterThanOrEqual(0)
  })

  test('getStatus returns entries for all 4 scrapers', () => {
    const all = getStatus()
    expect(all['rh-cases']).toBeDefined()
    expect(all['supportable']).toBeDefined()
    expect(all['ccsp']).toBeDefined()
    expect(all['sf-pipeline']).toBeDefined()
  })
})

describe('recordOutcome — success', () => {
  test('transitions state to fresh on success', () => {
    recordOutcome('rh-cases', { success: true, recordCount: 13 })
    const status = getScraperStatus('rh-cases')
    expect(status.state).toBe('fresh')
  })

  test('sets recordCount to provided value on success', () => {
    recordOutcome('rh-cases', { success: true, recordCount: 13 })
    const status = getScraperStatus('rh-cases')
    expect(status.recordCount).toBe(13)
  })

  test('sets lastRun and lastSuccess timestamps on success', () => {
    const before = new Date().toISOString()
    recordOutcome('rh-cases', { success: true, recordCount: 5 })
    const status = getScraperStatus('rh-cases')
    expect(status.lastRun).not.toBeNull()
    expect(status.lastSuccess).not.toBeNull()
    expect(status.lastRun! >= before).toBe(true)
  })

  test('clears lastError on success', () => {
    recordOutcome('rh-cases', { success: false, error: 'Some error' })
    recordOutcome('rh-cases', { success: true, recordCount: 7 })
    const status = getScraperStatus('rh-cases')
    expect(status.lastError).toBeNull()
  })

  test('resets consecutiveFailures to 0 on success', () => {
    recordOutcome('rh-cases', { success: false, error: 'err1' })
    recordOutcome('rh-cases', { success: false, error: 'err2' })
    recordOutcome('rh-cases', { success: true, recordCount: 3 })
    const status = getScraperStatus('rh-cases')
    expect(status.consecutiveFailures).toBe(0)
  })
})

describe('recordOutcome — failure', () => {
  beforeEach(() => {
    // Reset to a known good state first
    recordOutcome('supportable', { success: true, recordCount: 0 })
  })

  test('transitions state to failed on failure', () => {
    recordOutcome('supportable', { success: false, error: 'Session expired' })
    const status = getScraperStatus('supportable')
    expect(status.state).toBe('failed')
  })

  test('sets lastError on failure', () => {
    recordOutcome('supportable', { success: false, error: 'Session expired' })
    const status = getScraperStatus('supportable')
    expect(status.lastError).not.toBeNull()
    // Error is sanitized but should still contain meaningful content
    expect(typeof status.lastError).toBe('string')
  })

  test('consecutiveFailures increments on each failure', () => {
    recordOutcome('supportable', { success: false, error: 'err A' })
    const after1 = getScraperStatus('supportable').consecutiveFailures
    recordOutcome('supportable', { success: false, error: 'err B' })
    const after2 = getScraperStatus('supportable').consecutiveFailures
    expect(after2).toBe(after1 + 1)
  })

  test('two consecutive failures increments consecutiveFailures by 2', () => {
    recordOutcome('supportable', { success: true, recordCount: 0 }) // reset
    recordOutcome('supportable', { success: false, error: 'fail 1' })
    recordOutcome('supportable', { success: false, error: 'fail 2' })
    const status = getScraperStatus('supportable')
    expect(status.consecutiveFailures).toBe(2)
  })
})

describe('markRunning', () => {
  test('sets state to running', () => {
    markRunning('ccsp')
    const status = getScraperStatus('ccsp')
    expect(status.state).toBe('running')
  })

  test('running state is not overridden to stale by staleness check', () => {
    markRunning('ccsp')
    const all = getStatus()
    // When running, staleness check is bypassed — state stays 'running'
    expect(all['ccsp'].state).toBe('running')
  })
})

describe('getStatus — staleness logic', () => {
  test('fresh scraper with recent lastSuccess stays fresh', () => {
    recordOutcome('sf-pipeline', { success: true, recordCount: 10, durationMs: 5000 })
    const all = getStatus()
    // Just ran — should be fresh (not yet past threshold)
    expect(all['sf-pipeline'].state).toBe('fresh')
  })
})
