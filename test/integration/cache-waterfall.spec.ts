/**
 * Cache Waterfall — L1 disk-cache integration tests
 *
 * Validates that the 4-layer cache waterfall (L1 disk → L2 AE sheet →
 * L3 CSV → L4 live scrape) serves from L1 when data is fresh, without
 * triggering downstream layers. Does NOT test L2–L4 (those require live
 * OAuth sessions); focuses on L1 behavior which works without auth.
 *
 * Cache layers:
 *   L1  — disk cache, 24h TTL (refresh-engine.ts)
 *   L2  — AE sheet (Google Sheets)
 *   L3  — CSV fallback
 *   L4  — live scrape (requires browser + OAuth)
 *
 * Targets the test container (port 7776) — tagged @destructive so the
 * playwright `test` project routes it to TEST_URL/7776.
 *
 * Endpoints exercised:
 *   GET /api/ccsp              — CCSP data with cachedAt field
 *   GET /api/pipeline          — pipeline data with cachedAt field
 *   GET /api/status/scrapes    — per-source lastSync, lastError, isRunning, isStale, recordCount
 */
import { test } from '../fixtures'
import { expect } from '@playwright/test'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'

test.describe('Cache waterfall — L1 disk cache behavior @destructive', () => {
  test.use({ baseURL: BASE })

  // Precondition guard: needs ≥1 AE seeded. Without at least one AE the
  // cache layer has nothing to serve and all assertions become meaningless.
  test.beforeEach(async ({ request }, testInfo) => {
    const aesRes = await request.get(`${BASE}/api/aes`)
    if (!aesRes.ok()) {
      testInfo.skip(true, `precondition: GET /api/aes returned ${aesRes.status()}`)
      return
    }
    const body = await aesRes.json()
    const aes = Array.isArray(body) ? body : body.aes ?? []
    if (aes.length < 1) {
      testInfo.skip(true, `precondition: ${aes.length} AEs seeded — need ≥1. Restore via 'make test-restore' + 'make test-up-live'.`)
    }
  })

  test('L1 cache hit: second /api/ccsp call does not trigger a new scrape', async ({ request }) => {
    // First call — populates or serves from L1
    const statusBefore = await request.get(`${BASE}/api/status/scrapes`)
    expect(statusBefore.status(), 'GET /api/status/scrapes must succeed').toBe(200)
    const scrapesBefore = await statusBefore.json()
    const ccspSyncBefore = scrapesBefore.ccsp?.lastSync

    // Hit the CCSP endpoint — should serve from L1 cache
    const ccspRes1 = await request.get(`${BASE}/api/ccsp`)
    expect(ccspRes1.status(), 'first GET /api/ccsp must succeed').toBe(200)

    // Second call — should still be served from L1, no new scrape
    const ccspRes2 = await request.get(`${BASE}/api/ccsp`)
    expect(ccspRes2.status(), 'second GET /api/ccsp must succeed').toBe(200)

    // Verify lastSync did not change — proves no new scrape was triggered
    const statusAfter = await request.get(`${BASE}/api/status/scrapes`)
    expect(statusAfter.status(), 'GET /api/status/scrapes after second call must succeed').toBe(200)
    const scrapesAfter = await statusAfter.json()
    const ccspSyncAfter = scrapesAfter.ccsp?.lastSync

    expect(ccspSyncAfter, 'ccsp lastSync must not change between consecutive calls (L1 cache hit)').toBe(ccspSyncBefore)
  })

  test('L1 freshness: ccsp lastSync is within 24h', async ({ request }) => {
    const statusRes = await request.get(`${BASE}/api/status/scrapes`)
    expect(statusRes.status(), 'GET /api/status/scrapes must succeed').toBe(200)
    const scrapes = await statusRes.json()

    // lastSync may be null on a fresh-seeded container (no live scrape yet).
    // When present, it must be a valid ISO date within the 24h L1 TTL window.
    if (scrapes.ccsp?.lastSync) {
      const lastSync = new Date(scrapes.ccsp.lastSync)
      const now = new Date()
      const ageMs = now.getTime() - lastSync.getTime()
      const twentyFourHoursMs = 24 * 60 * 60 * 1000

      expect(ageMs, 'ccsp lastSync must be within 24h (L1 TTL window)').toBeLessThan(twentyFourHoursMs)
      expect(ageMs, 'ccsp lastSync must not be in the future').toBeGreaterThanOrEqual(0)
    }

    // recordCount is a number (may be 0 on seeded containers without live data)
    expect(typeof scrapes.ccsp?.recordCount, 'ccsp.recordCount must be a number').toBe('number')
  })

  test('cache status shape: all 4 sources present with expected fields', async ({ request }) => {
    const statusRes = await request.get(`${BASE}/api/status/scrapes`)
    expect(statusRes.status(), 'GET /api/status/scrapes must succeed').toBe(200)
    const scrapes = await statusRes.json()

    const expectedSources = ['supportable', 'ccsp', 'rh', 'salesforce'] as const
    const expectedFields = ['lastSync', 'lastError', 'isRunning', 'isStale'] as const

    for (const source of expectedSources) {
      expect(scrapes[source], `${source} must exist in scrapes status`).toBeDefined()

      for (const field of expectedFields) {
        expect(
          scrapes[source],
          `${source} must have field '${field}'`
        ).toHaveProperty(field)
      }

      // recordCount should be a number (may be 0 for sources without auth)
      expect(typeof scrapes[source].recordCount, `${source}.recordCount must be a number`).toBe('number')

      // isRunning and isStale must be booleans
      expect(typeof scrapes[source].isRunning, `${source}.isRunning must be boolean`).toBe('boolean')
      expect(typeof scrapes[source].isStale, `${source}.isStale must be boolean`).toBe('boolean')
    }
  })

  test('L1 cache hit: second /api/pipeline call does not trigger a new scrape', async ({ request }) => {
    // Capture scrape status before pipeline calls
    const statusBefore = await request.get(`${BASE}/api/status/scrapes`)
    expect(statusBefore.status(), 'GET /api/status/scrapes must succeed').toBe(200)
    const scrapesBefore = await statusBefore.json()
    const sfSyncBefore = scrapesBefore.salesforce?.lastSync

    // First pipeline call
    const pipelineRes1 = await request.get(`${BASE}/api/pipeline`)
    expect(pipelineRes1.status(), 'first GET /api/pipeline must succeed').toBe(200)
    const pipeline1 = await pipelineRes1.json()
    expect(pipeline1, 'pipeline response must have cachedAt').toHaveProperty('cachedAt')

    // Second pipeline call — should serve from L1
    const pipelineRes2 = await request.get(`${BASE}/api/pipeline`)
    expect(pipelineRes2.status(), 'second GET /api/pipeline must succeed').toBe(200)
    const pipeline2 = await pipelineRes2.json()
    expect(pipeline2, 'pipeline response must have cachedAt').toHaveProperty('cachedAt')

    // Verify no new scrape was triggered
    const statusAfter = await request.get(`${BASE}/api/status/scrapes`)
    expect(statusAfter.status(), 'GET /api/status/scrapes after pipeline calls must succeed').toBe(200)
    const scrapesAfter = await statusAfter.json()
    const sfSyncAfter = scrapesAfter.salesforce?.lastSync

    expect(sfSyncAfter, 'salesforce lastSync must not change between consecutive pipeline calls (L1 cache hit)').toBe(sfSyncBefore)
  })
})
