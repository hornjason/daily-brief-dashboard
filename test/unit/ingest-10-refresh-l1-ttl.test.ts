// BKL-INGEST-10: L1 disk-cache TTL gate for background refresh functions.
//
// The canonical cache hierarchy requires L1 to be consulted first, so a fresh
// L1 short-circuits any external call.
//
// refreshCCSP and refreshPipeline use ADR-019 CSV discovery from Drive when
// L1 is stale (discoverL3Csv + readL3CsvRaw). refreshSubscriptions still uses
// checkFilesModified for L2.
//
// This test verifies the L1 early-return path by:
//   1. Mocking `./cache-layer.ts` to return controllable cachedAt values.
//   2. Tracking whether post-L1 code was reached via mock call flags.
//   3. Mocking all downstream modules to keep the test hermetic.

import { test, expect, describe, beforeEach, mock } from 'bun:test'

// Re-export real parseCcspRows so Bun's global mock doesn't replace it for
// other test files (ccsp-resolvers.test.ts) that import from ccsp-resolvers.ts.
import { parseCcspRows as realParseCcspRows } from '../../src/lib/ccsp-resolvers.ts'

// ── Mock module state — mutated per-test ────────────────────────────────────

let mockCCSPCache: { records: any[]; cachedAt: string; fileIds?: string[] } | null = null
let mockPipelineCache: { records: any[]; cachedAt: string; fileIds?: string[] } | null = null
const mockSheetCacheByCustomer = new Map<string, { rows: any[]; cachedAt: string }>()

let checkFilesModifiedCalled = false
let discoverL3CsvCalled = false
let batchFetchSubscriptionsCalled = false

// ── Mocks must be registered BEFORE importing the SUT ──────────────────────

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

mock.module('../../src/drive-watcher.ts', () => ({
  checkFilesModified: async (_fileIds: string[], _cachedAt: string) => {
    checkFilesModifiedCalled = true
    throw new Error('L2 Drive check reached when L1 should have short-circuited')
  },
}))

mock.module('../../src/sheets.ts', () => ({
  fetchCustomerSheetData: async () => [],
  fetchCCSPData:          async () => ({ records: [], fileIds: [] }),
  batchFetchSubscriptions: async () => { batchFetchSubscriptionsCalled = true; return new Map() },
  parseCcspRows: realParseCcspRows,
}))

mock.module('../../src/pipeline.ts', () => ({
  fetchPipelineData: async () => ({ records: [], fileIds: [] }),
  parsePipelineRows: () => [],
}))

// ADR-019: CSV discovery mocks — discoverL3Csv returns null (no CSV found)
// so refreshCCSP/refreshPipeline proceed past L1 but exit gracefully.
mock.module('../../src/lib/l3-csv-reader.ts', () => ({
  discoverL3Csv: async (..._args: any[]) => { discoverL3CsvCalled = true; return null },
  readL3CsvRaw:  async () => '',
}))

mock.module('../../src/csv-parse.ts', () => ({
  parseCsvToSfReport: () => ({ headers: [], rows: [] }),
}))

mock.module('../../src/region-config.ts', () => ({
  normalizeSettings: () => ({
    regions: [{ podBookingsFolderId: 'test-folder', pods: { 'POD1': {} } }],
  }),
  getRegionById: (settings: any, _regionId?: string) => settings.regions[0],
}))

mock.module('../../src/google.ts', () => ({
  makeAuth: () => ({}),
  GOOGLE_UNIFIED_TOKEN_PATH: '/tmp/fake-token.json',
  withQuotaRetry: async <T>(fn: () => Promise<T>) => fn(),
}))

mock.module('../../src/ingest-events.ts', () => ({
  emitCacheLevel: () => {},
}))

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

const mockAes: any[] = []
const mockCustomers: any[] = []

mock.module('../../src/server-state.ts', () => ({
  aes:       mockAes,
  customers: mockCustomers,
}))

const { refreshCCSP, refreshPipeline, refreshSubscriptions } = await import('../../src/refresh-engine.ts')

// ── Helpers ─────────────────────────────────────────────────────────────────

const ONE_HOUR_MS = 60 * 60 * 1000

function isoAgoMs(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

function resetState(): void {
  checkFilesModifiedCalled = false
  discoverL3CsvCalled = false
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
  test('refreshCCSP skips Drive when L1 cache < 24h', async () => {
    mockCCSPCache = {
      records: [{ dummy: 1 }],
      cachedAt: isoAgoMs(12 * ONE_HOUR_MS),
    }

    await refreshCCSP()

    expect(discoverL3CsvCalled).toBe(false)
  })

  test('refreshCCSP proceeds to CSV discovery when L1 cache is 25h old', async () => {
    mockCCSPCache = {
      records: [{ dummy: 1 }],
      cachedAt: isoAgoMs(25 * ONE_HOUR_MS),
    }

    await refreshCCSP()

    // L1 stale → code proceeds past L1 to Drive CSV discovery.
    // discoverL3Csv is called (returns null → no CSVs found → exits gracefully).
    // The key assertion: L1 did NOT short-circuit.
    expect(discoverL3CsvCalled).toBe(true)
  })

  // ── refreshPipeline ───────────────────────────────────────────────────────
  test('refreshPipeline skips Drive when L1 cache < 24h', async () => {
    mockPipelineCache = {
      records: [{ dummy: 1 }],
      cachedAt: isoAgoMs(6 * ONE_HOUR_MS),
    }

    await refreshPipeline()

    expect(discoverL3CsvCalled).toBe(false)
  })

  test('refreshPipeline proceeds to CSV discovery when L1 cache is 25h old', async () => {
    mockPipelineCache = {
      records: [{ dummy: 1 }],
      cachedAt: isoAgoMs(25 * ONE_HOUR_MS),
    }

    await refreshPipeline()

    expect(discoverL3CsvCalled).toBe(true)
  })

  // ── refreshSubscriptions ──────────────────────────────────────────────────
  test('refreshSubscriptions skips Drive check when all customer L1 caches < 24h', async () => {
    mockCustomers.push({ name: 'CustA', ae: 'AE1' }, { name: 'CustB', ae: 'AE1' })
    mockSheetCacheByCustomer.set('CustA', { rows: [], cachedAt: isoAgoMs(1 * ONE_HOUR_MS) })
    mockSheetCacheByCustomer.set('CustB', { rows: [], cachedAt: isoAgoMs(2 * ONE_HOUR_MS) })

    await refreshSubscriptions()

    expect(checkFilesModifiedCalled).toBe(false)
    expect(batchFetchSubscriptionsCalled).toBe(false)
  })

  test('refreshSubscriptions proceeds to L2 check when ANY customer L1 cache > 24h', async () => {
    mockAes.push({ name: 'AE1', subscriptionSheetId: 'ae1-sheet' })
    mockCustomers.push({ name: 'CustA', ae: 'AE1' }, { name: 'CustB', ae: 'AE1' })
    mockSheetCacheByCustomer.set('CustA', { rows: [], cachedAt: isoAgoMs(1 * ONE_HOUR_MS) })
    mockSheetCacheByCustomer.set('CustB', { rows: [], cachedAt: isoAgoMs(30 * ONE_HOUR_MS) })

    await refreshSubscriptions()

    expect(batchFetchSubscriptionsCalled).toBe(true)
  })
})
