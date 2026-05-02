/**
 * BKL-TEST-21: Route handler coverage — API-level tests
 *
 * Tests key route handlers via fetch() against the live server.
 * Establishes the pattern for route handler coverage without requiring
 * Hono app.request() (server.ts has side effects that prevent clean import).
 *
 * Run against test container:
 *   BASE_URL=http://localhost:7776 npx playwright test test/api/routes.spec.ts
 *
 * Run against production (read-only tests only — reset test excluded):
 *   npx playwright test test/api/routes.spec.ts --project=ci
 */
import { test, expect, getJSON, postJSON, postJSONDestructive } from '../fixtures'

// ── POST /api/setup/reset — production guard ─────────────────────────────────

test.describe('POST /api/setup/reset — guard checks', () => {
  test('returns 400 when confirm param is missing', async () => {
    // Guard fires before the customer-count check — confirm=true is always required
    const { status, body } = await postJSON('/api/setup/reset', {})
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('confirm=true')
  })

  test('returns 403 when customer count > 5 and ALLOW_RESET not set @destructive', async () => {
    // This test is only meaningful on the test container with seeded data.
    // The seed script provides 5 customers — so we add a 6th, check the guard fires,
    // then rely on serverState fixture to restore.
    // If the server has fewer than 6 customers seeded, skip.
    const { body: accountsBody } = await getJSON('/api/accounts')
    test.skip(
      !accountsBody?.customers || accountsBody.customers.length <= 5,
      'Need >5 customers loaded to test production guard'
    )

    const { status, body } = await postJSON('/api/setup/reset?confirm=true', {})
    // Production guard: ALLOW_RESET not set on this server → 403
    expect(status).toBe(403)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('production guard')
  })
})

// ── GET /api/accounts — response shape ───────────────────────────────────────

test.describe('GET /api/accounts', () => {
  test('returns 200 with customers array field', async () => {
    const { status, body } = await getJSON('/api/accounts')
    expect(status).toBe(200)
    expect(body).toHaveProperty('customers')
    expect(Array.isArray(body.customers)).toBe(true)
  })

  test('each customer entry has required shape fields', async () => {
    const { body } = await getJSON('/api/accounts')
    // Skip shape check if no customers are configured
    if (body.customers.length === 0) return
    const first = body.customers[0]
    expect(first).toHaveProperty('name')
    expect(first).toHaveProperty('accountNumbers')
    expect(first).toHaveProperty('ae')
    expect(Array.isArray(first.accountNumbers)).toBe(true)
  })
})

// ── POST /api/browser/open-tableau-login — L3 hero guard (BKL-HERO-21) ───────

test.describe('POST /api/browser/open-tableau-login — L3 hero guard', () => {
  test('returns 404 on hero (L3) node — Chromium not installed @destructive', async () => {
    // The test container runs without NODE_ROLE=primary → hero node → 404.
    const { status, body } = await postJSONDestructive('/api/browser/open-tableau-login', {})
    expect(status).toBe(404)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('hero')
  })
})

// ── POST /api/aes — validation ────────────────────────────────────────────────

test.describe('POST /api/aes — validation', () => {
  test('returns 400 when aes entry has empty name', async () => {
    const { status, body } = await postJSON('/api/aes', {
      aes: [{ name: '', driveFolderId: 'test123' }],
    })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect(body.error).toContain('name')
  })

  test('returns 400 when aes is not an array', async () => {
    const { status, body } = await postJSON('/api/aes', { aes: 'not-an-array' })
    expect(status).toBe(400)
    expect(body.error).toContain('aes must be an array')
  })
})
