// BKL-ARCH-SCRAPER-03: scraper-status-store as single source of truth.
// Verifies that seedSuccess preserves the source timestamp, recordSfSyncSuccess
// flows into the store, and the ccsp scrape error/success paths record correctly.

import { test, expect, describe, beforeAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Set CACHE_DIR before importing modules that read it lazily.
const TMP_DIR = mkdtempSync(join(tmpdir(), 'arch-03-'))
process.env.CACHE_DIR = TMP_DIR

const { initSfSyncFromCache, recordSfSyncSuccess } = await import('../../src/sf-scraper.ts')
const { recordOutcome, getScraperStatus, initStatusStore } = await import('../../src/scraper-status-store.ts')

describe('BKL-ARCH-SCRAPER-03: scraper-status-store single source of truth', () => {
  beforeAll(() => {
    // Ensure clean store at start of suite.
    initStatusStore()
  })

  beforeEach(() => {
    // Reset store between tests by re-seeding with empty disk file (deleted).
    const statusFile = join(TMP_DIR, 'scraper-status.json')
    try { if (existsSync(statusFile)) rmSync(statusFile) } catch { /* ignore */ }
  })

  test('SF seed from cache uses given timestamp (not now)', () => {
    // Use a recent timestamp so staleness override does not flip state to 'stale'.
    // The point of this test is the timestamp pass-through, not freshness math.
    const cachedAt = new Date(Date.now() - 60_000).toISOString() // 1 min ago
    initSfSyncFromCache(() => ({ records: [{}, {}, {}], cachedAt }))
    const status = getScraperStatus('sf-pipeline')
    expect(status.lastSuccess).toBe(cachedAt)
    expect(status.recordCount).toBe(3)
    expect(status.state).toBe('fresh')
  })

  test('recordSfSyncSuccess updates store recordCount', () => {
    recordSfSyncSuccess(42)
    const status = getScraperStatus('sf-pipeline')
    expect(status.recordCount).toBe(42)
    expect(status.state).toBe('fresh')
    expect(status.lastError).toBeNull()
  })

  test('CCSP error path writes to store', () => {
    recordOutcome('ccsp', { success: false, error: 'simulated tableau timeout' })
    const status = getScraperStatus('ccsp')
    expect(status.lastError).not.toBeNull()
    expect(typeof status.lastError).toBe('string')
    // After a failure with no prior success, getScraperStatus' staleness override
    // flips 'failed' to 'stale' (no lastSuccess). The lastError persistence is the
    // contract under test — surfacing the failure is handled by getUnifiedStatus.
    expect(['failed', 'stale']).toContain(status.state)
  })

  test('CCSP success path clears error', () => {
    // First fail, then succeed
    recordOutcome('ccsp', { success: false, error: 'transient failure' })
    expect(getScraperStatus('ccsp').lastError).not.toBeNull()

    recordOutcome('ccsp', { success: true, recordCount: 100, durationMs: 1234 })
    const status = getScraperStatus('ccsp')
    expect(status.lastError).toBeNull()
    expect(status.state).toBe('fresh')
    expect(status.recordCount).toBe(100)
  })
})
