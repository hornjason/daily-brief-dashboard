/**
 * Zod contract tests — validate API response shapes against schemas.
 * These are read-only and do not mutate server state.
 */
import { test, expect } from '@playwright/test'
import {
  AEsResponseSchema,
  BootstrapStatusSchema,
  TableauSessionSchema,
  ScrapeStatusSchema,
  CacheStatusSchema,
  BriefResponseSchema,
  IntelligenceStatusSchema,
  MorningSummarySchema,
  PipelineCustomerSchema,
} from './schemas'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'

test.describe('API contract: /api/aes', () => {
  test('GET /api/aes matches AEsResponseSchema', async ({ request }) => {
    const res = await request.get(`${BASE}/api/aes`)
    expect(res.ok()).toBe(true)
    const body = await res.json()
    const result = AEsResponseSchema.safeParse(body)
    expect(result.success, `Schema errors: ${JSON.stringify(result.error?.issues ?? [])}`).toBe(true)
  })

  test('each AE has required fields', async ({ request }) => {
    const res = await request.get(`${BASE}/api/aes`)
    const { aes } = await res.json()
    for (const ae of aes) {
      expect(typeof ae.name).toBe('string')
      expect(typeof ae.driveFolderId).toBe('string')
      expect(Array.isArray(ae.tableauTerritories)).toBe(true)
    }
  })
})

test.describe('API contract: /api/bootstrap/auto/status', () => {
  test('GET /api/bootstrap/auto/status matches BootstrapStatusSchema', async ({ request }) => {
    const res = await request.get(`${BASE}/api/bootstrap/auto/status`)
    expect(res.ok()).toBe(true)
    const body = await res.json()
    const result = BootstrapStatusSchema.safeParse(body)
    expect(result.success, `Schema errors: ${JSON.stringify(result.error?.issues ?? [])}`).toBe(true)
  })

  test('running field is boolean', async ({ request }) => {
    const res = await request.get(`${BASE}/api/bootstrap/auto/status`)
    const body = await res.json()
    expect(typeof body.running).toBe('boolean')
  })

  test('steps field is an array', async ({ request }) => {
    const res = await request.get(`${BASE}/api/bootstrap/auto/status`)
    const body = await res.json()
    expect(Array.isArray(body.steps)).toBe(true)
  })
})

test.describe('API contract: /api/bootstrap/tableau/session-status', () => {
  test('GET /api/bootstrap/tableau/session-status matches TableauSessionSchema', async ({ request }) => {
    const res = await request.get(`${BASE}/api/bootstrap/tableau/session-status`)
    expect(res.ok()).toBe(true)
    const body = await res.json()
    const result = TableauSessionSchema.safeParse(body)
    expect(result.success, `Schema errors: ${JSON.stringify(result.error?.issues ?? [])}`).toBe(true)
  })
})

test.describe('API contract: /api/status/scrapes', () => {
  test('GET /api/status/scrapes matches ScrapeStatusSchema', async ({ request }) => {
    const res = await request.get(`${BASE}/api/status/scrapes`)
    expect(res.ok()).toBe(true)
    const body = await res.json()
    const result = ScrapeStatusSchema.safeParse(body)
    expect(result.success, `Schema errors: ${JSON.stringify(result.error?.issues ?? [])}`).toBe(true)
  })

  test('each scraper source has boolean isRunning and isStale', async ({ request }) => {
    const res = await request.get(`${BASE}/api/status/scrapes`)
    const body = await res.json()
    for (const key of ['supportable', 'ccsp', 'rh', 'salesforce'] as const) {
      expect(typeof body[key].isRunning).toBe('boolean')
      expect(typeof body[key].isStale).toBe('boolean')
    }
  })
})

test.describe('API contract: /api/cache/status', () => {
  test('GET /api/cache/status matches CacheStatusSchema', async ({ request }) => {
    const res = await request.get(`${BASE}/api/cache/status`)
    expect(res.ok()).toBe(true)
    const body = await res.json()
    const result = CacheStatusSchema.safeParse(body)
    expect(result.success, `Schema errors: ${JSON.stringify(result.error?.issues ?? [])}`).toBe(true)
  })

  test('each cache entry has lastModified as string or null', async ({ request }) => {
    const res = await request.get(`${BASE}/api/cache/status`)
    const body = await res.json()
    for (const key of ['ccsp', 'pipeline', 'rh_cases'] as const) {
      const lm = body[key].lastModified
      expect(lm === null || typeof lm === 'string').toBe(true)
    }
  })
})

// ── BKL-AI27: Morning summary contract ──────────────────────────────────────

const KNOWN_CUSTOMER_ENCODED = encodeURIComponent('A10 Networks')

test.describe('API contract: /api/morning-summary', () => {
  test('GET /api/morning-summary returns 200 matching MorningSummarySchema', async ({ request }) => {
    const res = await request.get(`${BASE}/api/morning-summary`)
    expect(res.ok()).toBe(true)
    const body = await res.json()
    const result = MorningSummarySchema.safeParse(body)
    expect(result.success, `Schema errors: ${JSON.stringify(result.error?.issues ?? [])}`).toBe(true)
  })

  test('signals array contains valid signal objects', async ({ request }) => {
    const res = await request.get(`${BASE}/api/morning-summary`)
    const body = await res.json()
    expect(Array.isArray(body.signals)).toBe(true)
    for (const s of body.signals) {
      expect(typeof s.customer).toBe('string')
      expect(typeof s.type).toBe('string')
      expect(typeof s.text).toBe('string')
    }
  })

  test('synthesis field is string when present', async ({ request }) => {
    const res = await request.get(`${BASE}/api/morning-summary`)
    const body = await res.json()
    if (body.synthesis !== undefined) {
      expect(typeof body.synthesis).toBe('string')
    }
  })

  test('customerCount is a non-negative integer', async ({ request }) => {
    const res = await request.get(`${BASE}/api/morning-summary`)
    const body = await res.json()
    if (body.customerCount !== undefined) {
      expect(typeof body.customerCount).toBe('number')
      expect(body.customerCount).toBeGreaterThanOrEqual(0)
    }
  })
})

// ── BKL-AI20: Brief response contract ────────────────────────────────────────

test.describe('API contract: /customer/:name/brief', () => {
  test('GET /customer/A10 Networks/brief returns BriefResponseSchema shape', async ({ request }) => {
    const res = await request.get(`${BASE}/customer/${KNOWN_CUSTOMER_ENCODED}/brief`)
    expect(res.ok()).toBe(true)
    const body = await res.json()
    const result = BriefResponseSchema.safeParse(body)
    expect(result.success, `Schema errors: ${JSON.stringify(result.error?.issues ?? [])}`).toBe(true)
  })

  test('fromCache field is present and boolean', async ({ request }) => {
    const res = await request.get(`${BASE}/customer/${KNOWN_CUSTOMER_ENCODED}/brief`)
    const body = await res.json()
    expect(typeof body.fromCache).toBe('boolean')
  })
})

// ── BKL-AI21: Customer pipeline contract ─────────────────────────────────────

test.describe('API contract: /customer/:name/pipeline', () => {
  test('GET /customer/A10 Networks/pipeline matches PipelineCustomerSchema', async ({ request }) => {
    const res = await request.get(`${BASE}/customer/${KNOWN_CUSTOMER_ENCODED}/pipeline`)
    expect(res.ok()).toBe(true)
    const body = await res.json()
    const result = PipelineCustomerSchema.safeParse(body)
    expect(result.success, `Schema errors: ${JSON.stringify(result.error?.issues ?? [])}`).toBe(true)
  })
})

// ── Account Intelligence contract ────────────────────────────────────────────

test.describe('API contract: /api/customer/:name/intelligence-status', () => {
  test('GET intelligence-status for known customer returns IntelligenceStatusSchema', async ({ request }) => {
    const res = await request.get(`${BASE}/api/customer/${KNOWN_CUSTOMER_ENCODED}/intelligence-status`)
    expect(res.ok()).toBe(true)
    const body = await res.json()
    const result = IntelligenceStatusSchema.safeParse(body)
    expect(result.success, `Schema errors: ${JSON.stringify(result.error?.issues ?? [])}`).toBe(true)
  })

  test('intelligence-status for nonexistent customer returns 404', async ({ request }) => {
    const res = await request.get(`${BASE}/api/customer/__nonexistent__/intelligence-status`)
    expect(res.status()).toBe(404)
  })
})
