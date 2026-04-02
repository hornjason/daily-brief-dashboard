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
