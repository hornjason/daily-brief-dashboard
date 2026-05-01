/**
 * BKL-HERO-01 Phase 3 — offline-token API tests.
 *
 * Tests the GET + POST /api/settings/offline-token endpoints.
 * POST now validates the token against SSO before saving, so a deliberately
 * invalid token must return 400 — no real token needed to cover the sad path.
 *
 * Tagged @destructive — runs against the test container (7776).
 * Pattern: follows test/api/region-access.spec.ts for structure.
 */
import { test, expect } from '@playwright/test'

// @destructive routes target the test container — TEST_URL > BASE_URL > 7776
const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'

test.describe('@destructive BKL-HERO-01 Phase 3 — offline-token API', () => {
  test.describe.configure({ mode: 'serial' })

  test('GET /api/settings/offline-token returns {configured: boolean}', async ({ request }) => {
    const res = await request.get(`${BASE}/api/settings/offline-token`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(typeof body.configured).toBe('boolean')
  })

  test('POST with bad token returns 400 with sanitized error', async ({ request }) => {
    const res = await request.post(`${BASE}/api/settings/offline-token`, {
      data: { token: 'deliberately-invalid-token-for-test' },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
    // Error must not contain raw internal SSO credential data
    expect(body.error).not.toContain('access_token')
  })

  test('POST with empty token returns 400', async ({ request }) => {
    const res = await request.post(`${BASE}/api/settings/offline-token`, {
      data: { token: '' },
    })
    expect(res.status()).toBe(400)
  })

  test('POST with token containing newline returns 400', async ({ request }) => {
    const res = await request.post(`${BASE}/api/settings/offline-token`, {
      data: { token: 'abc\ndef' },
    })
    expect(res.status()).toBe(400)
  })
})
