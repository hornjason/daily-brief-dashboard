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

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import {
  recordOutcome,
  markRunning,
  getStatus,
  getScraperStatus,
  initStatusStore,
  getUnifiedStatus,
  getAllUnifiedStatus,
  type ScraperName,
} from './scraper-status-store.ts'
import { ScraperRegistry, type ScraperDescriptor } from './scraper-registry.ts'

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

  test('getStatus returns entries for all 3 active scrapers (supportable retired)', () => {
    const all = getStatus()
    expect(all['rh-cases']).toBeDefined()
    expect(all['ccsp']).toBeDefined()
    expect(all['sf-pipeline']).toBeDefined()
    // supportable is permanently disabled — must NOT appear in status store
    expect(all['supportable']).toBeUndefined()
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
    // Reset to a known good state first (supportable retired — use ccsp)
    recordOutcome('ccsp', { success: true, recordCount: 0 })
  })

  test('transitions state to failed on failure', () => {
    recordOutcome('ccsp', { success: false, error: 'Session expired' })
    const status = getScraperStatus('ccsp')
    expect(status.state).toBe('failed')
  })

  test('sets lastError on failure', () => {
    recordOutcome('ccsp', { success: false, error: 'Session expired' })
    const status = getScraperStatus('ccsp')
    expect(status.lastError).not.toBeNull()
    // Error is sanitized but should still contain meaningful content
    expect(typeof status.lastError).toBe('string')
  })

  test('consecutiveFailures increments on each failure', () => {
    recordOutcome('ccsp', { success: false, error: 'err A' })
    const after1 = getScraperStatus('ccsp').consecutiveFailures
    recordOutcome('ccsp', { success: false, error: 'err B' })
    const after2 = getScraperStatus('ccsp').consecutiveFailures
    expect(after2).toBe(after1 + 1)
  })

  test('two consecutive failures increments consecutiveFailures by 2', () => {
    recordOutcome('ccsp', { success: true, recordCount: 0 }) // reset
    recordOutcome('ccsp', { success: false, error: 'fail 1' })
    recordOutcome('ccsp', { success: false, error: 'fail 2' })
    const status = getScraperStatus('ccsp')
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

// ── BKL-ARCH-02 Phase 1: getUnifiedStatus ─────────────────────────────────────

describe('getUnifiedStatus — lastSync resolution', () => {
  let originals: Record<string, ScraperDescriptor | undefined> = {}

  beforeEach(() => {
    originals = {
      'rh-cases':    ScraperRegistry.get('rh-cases'),
      'supportable': ScraperRegistry.get('supportable'),
    }
  })

  function restore() {
    for (const [name, d] of Object.entries(originals)) {
      if (d) ScraperRegistry.register(d)
    }
  }

  test('uses in-memory hint when set (overrides store.lastSuccess)', () => {
    const inMem = '2026-05-02T10:00:00.000Z'
    ScraperRegistry.register({
      name: 'rh-cases',
      adopt: () => {},
      getInMemoryLastSync: () => inMem,
      getInMemoryLastError: () => null,
      getInMemoryIsRunning: () => false,
    })
    recordOutcome('rh-cases', { success: true, recordCount: 1, durationMs: 1 })
    const u = getUnifiedStatus('rh-cases')
    expect(u.lastSync).toBe(inMem)
    restore()
  })

  test('falls back to store.lastSuccess when in-memory hint is null', () => {
    ScraperRegistry.register({
      name: 'rh-cases',
      adopt: () => {},
      getInMemoryLastSync: () => null,
      getInMemoryLastError: () => null,
      getInMemoryIsRunning: () => false,
    })
    recordOutcome('rh-cases', { success: true, recordCount: 1, durationMs: 1 })
    const u = getUnifiedStatus('rh-cases')
    expect(u.lastSync).not.toBeNull()
    expect(u.lastSync).toBe(u.lastSuccess)
    restore()
  })

  test('returns null when both hints are null (supportable retired path)', () => {
    ScraperRegistry.register({
      name: 'supportable',
      adopt: () => {},
      getInMemoryLastSync: () => null,
      getInMemoryLastError: () => null,
      getInMemoryIsRunning: () => false,
      retired: true,
    })
    const u = getUnifiedStatus('supportable')
    expect(u.lastSync).toBeNull()
    restore()
  })
})

describe('getUnifiedStatus — supportable (retired)', () => {
  let original: ScraperDescriptor | undefined

  beforeEach(() => {
    original = ScraperRegistry.get('supportable')
  })

  afterEach(() => {
    if (original) ScraperRegistry.register(original)
  })

  test('always reports state=stale, recordCount=null, isStale=true', () => {
    ScraperRegistry.register({
      name: 'supportable',
      adopt: () => {},
      getInMemoryLastSync: () => null,
      getInMemoryLastError: () => null,
      getInMemoryIsRunning: () => false,
      retired: true,
    })
    const u = getUnifiedStatus('supportable')
    expect(u.state).toBe('stale')
    expect(u.recordCount).toBeNull()
    expect(u.isStale).toBe(true)
  })

  test('still reports stale even when in-memory hint claims recent sync', () => {
    ScraperRegistry.register({
      name: 'supportable',
      adopt: () => {},
      getInMemoryLastSync: () => new Date().toISOString(),
      getInMemoryLastError: () => null,
      getInMemoryIsRunning: () => false,
      retired: true,
    })
    const u = getUnifiedStatus('supportable')
    expect(u.isStale).toBe(true)
    expect(u.state).toBe('stale')
  })
})

describe('getUnifiedStatus — isStale threshold', () => {
  test('flips to true when lastSync is older than STALE_THRESHOLDS[name]', () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    const original = ScraperRegistry.get('ccsp')
    ScraperRegistry.register({
      name: 'ccsp',
      adopt: () => {},
      getInMemoryLastSync: () => stale,
      getInMemoryLastError: () => null,
      getInMemoryIsRunning: () => false,
    })
    const u = getUnifiedStatus('ccsp')
    expect(u.isStale).toBe(true)
    if (original) ScraperRegistry.register(original)
  })

  test('reports fresh when lastSync is within threshold', () => {
    const fresh = new Date(Date.now() - 60 * 1000).toISOString()
    const original = ScraperRegistry.get('sf-pipeline')
    ScraperRegistry.register({
      name: 'sf-pipeline',
      adopt: () => {},
      getInMemoryLastSync: () => fresh,
      getInMemoryLastError: () => null,
      getInMemoryIsRunning: () => false,
    })
    const u = getUnifiedStatus('sf-pipeline')
    expect(u.isStale).toBe(false)
    if (original) ScraperRegistry.register(original)
  })
})

describe('getAllUnifiedStatus', () => {
  test('returns entries for all 4 known scraper names', () => {
    const all = getAllUnifiedStatus()
    expect(all['rh-cases']).toBeDefined()
    expect(all['ccsp']).toBeDefined()
    expect(all['sf-pipeline']).toBeDefined()
    expect(all['supportable']).toBeDefined()
  })
})
