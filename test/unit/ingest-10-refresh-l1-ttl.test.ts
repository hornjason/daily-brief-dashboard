// BKL-INGEST-10: L1 disk-cache TTL gate for background refresh functions.
//
// Before this fix, refresh-engine.ts always hit L2 (Drive modifiedTime check)
// on every heartbeat tick, even when the L1 disk cache was < 24h old. The
// canonical cache hierarchy requires L1 to be consulted first, so a fresh
// L1 short-circuits any external call.
//
// This test verifies the L1 early-return path for the three background
// refresh functions by:
//   1. Mocking `./cache-layer.ts` to return controllable cachedAt values.
//   2. Mocking `./drive-watcher.ts::checkFilesModified` to THROW — if the
//      refresh function ever reaches L2 when L1 is fresh, the test fails.
//   3. Mocking all downstream scraper + sheet modules to keep the test
//      hermetic (no Drive, no Sheets, no SF, no browser).

import { test, expect, describe, beforeEach, mock } from 'bun:test'

// ── Mock module state — mutated per-test ────────────────────────────────────

let mockCCSPCache: { records: any[]; cachedAt: string; fileIds?: string[] } | null = null
let mockPipelineCache: { records: any[]; cachedAt: string; fileIds?: string[] } | null = null
const mockSheetCacheByCustomer = new Map<string, { rows: any[]; cachedAt: string }>()

let checkFilesModifiedCalled = false
let fetchCCSPDataCalled = false
let fetchPipelineDataCalled = false
let batchFetchSubscriptionsCalled = false

// ── Mocks must be registered BEFORE importing the SUT ──────────────────────

// cache-layer: controllable reads, no-op writes.
mock.module('../../src/cache-layer.ts', () => ({
  readCCSPCache:     () => mockCCSPCache,
  readPipelineCache: () => mockPipelineCache,
  readSheetCache:    (customerName: string) => mockSheetCacheByCustomer.get(customerName) ?? null,
  writeCCSPCache:     () => {},
  writePipelineCache: () => {},
  writeSheetCache:    () => {},
  isCCSPCacheStale:   () => false,
  initCacheLayer:     () => {},
}))

// drive-watcher: checkFilesModified THROWS. If any L1-fresh test reaches L2,
// the uncaught throw will bubble (or the outer try/catch in refresh* will log
// a warning) and our per-test assertion on `checkFilesModifiedCalled` will
// catch the gate violation.
mock.module('../../src/drive-watcher.ts', () => ({
  checkFilesModified: async (_fileIds: string[], _cachedAt: string) => {
    checkFilesModifiedCalled = true
    throw new Error('L2 Drive check reached when L1 should have short-circuited')
  },
}))

// sheets + pipeline fetchers: no-op. Reached only when L1 is stale.
mock.module('../../src/sheets.ts', () => ({
  fetchCustomerSheetData: async () => [],
  fetchCCSPData:          async () => { fetchCCSPDataCalled = true; return { records: [], fileIds: [] } },
  batchFetchSubscriptions: async () => { batchFetchSubscriptionsCalled = true; return new Map() },
}))

mock.module('../../src/pipeline.ts', () => ({
  fetchPipelineData: async () => { fetchPipelineDataCalled = true; return { records: [], fileIds: [] } },
}))

// Scraper status modules — no-op recorders so refresh* doesn't write to disk.
mock.module('../../src/sf-scraper.ts', () => ({
  recordSfSyncSuccess: () => {},
}))

mock.module('../../src/scraper-status-store.ts', () => ({
  recordOutcome: () => {},
}))

mock.module('../../src/ccsp-scraper.ts', () => ({
  recordCcspRefreshAt: () => {},
}))

mock.module('../../src/supportable-scraper.ts', () => ({
  recordSupportableRefreshAt: () => {},
}))

// server-state: controllable `aes` + `customers` exports. We mutate them per test.
const mockAes: any[] = []
const mockCustomers: any[] = []

mock.module('../../src/server-state.ts', () => ({
  aes:       mockAes,
  customers: mockCustomers,
}))

// Now import the SUT AFTER all mocks are registered.
const { refreshCCSP, refreshPipeline, refreshSubscriptions } = await import('../../src/refresh-engine.ts')

// ── Helpers ─────────────────────────────────────────────────────────────────

const ONE_HOUR_MS = 60 * 60 * 1000
const ONE_DAY_MS  = 24 * ONE_HOUR_MS

function isoAgoMs(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

function resetState(): void {
  checkFilesModifiedCalled = false
  fetchCCSPDataCalled = false
  fetchPipelineDataCalled = false
  batchFetchSubscriptionsCalled = false
  mockCCSPCache = null
  mockPipelineCache = null
  mockSheetCacheByCustomer.clear()
  mockAes.length = 0
  mockCustomers.length = 0
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('BKL-INGEST-10: L1 cache TTL gate', () => {
  beforeEach(() => resetState())

  // ── refreshCCSP ──────────────────────────────────────────────────────────
  test('refreshCCSP skips Drive check when L1 cache < 24h and fileIds match', async () => {
    mockAes.push({ name: 'AE1', ccspSheetId: 'sheet-1' })
    mockCCSPCache = {
      records: [{ dummy: 1 }],
      cachedAt: isoAgoMs(12 * ONE_HOUR_MS), // 12h old — fresh
      fileIds: ['sheet-1'],
    }

    await refreshCCSP()

    // L1 hit → no L2 Drive check, no L3 fetchCCSPData.
    expect(checkFilesModifiedCalled).toBe(false)
    expect(fetchCCSPDataCalled).toBe(false)
  })

  test('refreshCCSP proceeds to Drive check when L1 cache is 25h old', async () => {
    mockAes.push({ name: 'AE1', ccspSheetId: 'sheet-1' })
    mockCCSPCache = {
      records: [{ dummy: 1 }],
      cachedAt: isoAgoMs(25 * ONE_HOUR_MS), // 25h old — stale
      fileIds: ['sheet-1'],
    }

    // checkFilesModified throws — refreshCCSP's outer try/catch will swallow
    // it, but the flag will flip, proving L2 was attempted.
    await refreshCCSP()

    expect(checkFilesModifiedCalled).toBe(true)
  })

  test('refreshCCSP does NOT short-circuit L1 when fileIds do not match current AE set', async () => {
    // AE set changed (cached for sheet-1, now have sheet-2) — L1 early-return
    // must NOT fire even though cachedAt is fresh. Instead, the AE-set-changed
    // branch takes over and forces a full refresh via fetchCCSPData (no Drive
    // modifiedTime check, because modifiedTime would compare against the
    // wrong fileIds).
    mockAes.push({ name: 'AE2', ccspSheetId: 'sheet-2' })
    mockCCSPCache = {
      records: [{ dummy: 1 }],
      cachedAt: isoAgoMs(1 * ONE_HOUR_MS), // 1h old — fresh on age alone
      fileIds: ['sheet-1'],                // but stale fileId set
    }

    await refreshCCSP()

    // L1 correctly gated out (fileIds differ) → AE-set-changed branch ran →
    // fetchCCSPData was called. If L1 had wrongly short-circuited, fetchCCSPData
    // would NOT have been called.
    expect(fetchCCSPDataCalled).toBe(true)
    // AE-set-changed path skips modifiedTime check — that's existing behavior.
    expect(checkFilesModifiedCalled).toBe(false)
  })

  // ── refreshPipeline ───────────────────────────────────────────────────────
  test('refreshPipeline skips Drive check when L1 cache < 24h and fileIds match', async () => {
    mockAes.push({ name: 'AE1', pipelineSheetId: 'pipe-1' })
    mockPipelineCache = {
      records: [{ dummy: 1 }],
      cachedAt: isoAgoMs(6 * ONE_HOUR_MS), // 6h old — fresh
      fileIds: ['pipe-1'],
    }

    await refreshPipeline()

    // L1 hit → no L2 Drive check, no L3 fetchPipelineData.
    expect(checkFilesModifiedCalled).toBe(false)
    expect(fetchPipelineDataCalled).toBe(false)
  })

  test('refreshPipeline proceeds to Drive check when L1 cache is 25h old', async () => {
    mockAes.push({ name: 'AE1', pipelineSheetId: 'pipe-1' })
    mockPipelineCache = {
      records: [{ dummy: 1 }],
      cachedAt: isoAgoMs(25 * ONE_HOUR_MS), // 25h old — stale
      fileIds: ['pipe-1'],
    }

    await refreshPipeline()

    expect(checkFilesModifiedCalled).toBe(true)
  })

  // ── refreshSubscriptions ──────────────────────────────────────────────────
  test('refreshSubscriptions skips Drive check when all customer L1 caches < 24h', async () => {
    mockCustomers.push({ name: 'CustA', ae: 'AE1' }, { name: 'CustB', ae: 'AE1' })
    mockSheetCacheByCustomer.set('CustA', { rows: [], cachedAt: isoAgoMs(1 * ONE_HOUR_MS) })
    mockSheetCacheByCustomer.set('CustB', { rows: [], cachedAt: isoAgoMs(2 * ONE_HOUR_MS) })

    await refreshSubscriptions()

    // L1 hit for ALL customers → no L2 Drive check, no L3 batch fetch.
    expect(checkFilesModifiedCalled).toBe(false)
    expect(batchFetchSubscriptionsCalled).toBe(false)
  })

  test('refreshSubscriptions proceeds to L2 check when ANY customer L1 cache > 24h', async () => {
    // Even one stale customer must drop the L1 short-circuit — otherwise the
    // stale customer never refreshes.
    mockAes.push({ name: 'AE1', supportableSheetId: 'ae1-sheet' })
    mockCustomers.push({ name: 'CustA', ae: 'AE1' }, { name: 'CustB', ae: 'AE1' })
    mockSheetCacheByCustomer.set('CustA', { rows: [], cachedAt: isoAgoMs(1 * ONE_HOUR_MS) })
    mockSheetCacheByCustomer.set('CustB', { rows: [], cachedAt: isoAgoMs(30 * ONE_HOUR_MS) }) // stale

    await refreshSubscriptions()

    // L1 short-circuit must not fire — CustB is > 24h old. Since
    // SHEETS_SYNC_PATH is "" in tests the L2 try{} swallows, and execution
    // falls through to the batch refresh path. That's the correct behavior:
    // the L1 gate correctly declined to short-circuit, and downstream code ran.
    expect(batchFetchSubscriptionsCalled).toBe(true)
  })
})
