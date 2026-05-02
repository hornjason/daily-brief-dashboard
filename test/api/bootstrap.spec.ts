/**
 * Bootstrap API endpoint tests.
 *
 * Covers auto-bootstrap status, reset, supportable status, tableau session,
 * duplicate prevention, and auth guards.
 */
import { test, expect, getJSON, postJSON } from '../fixtures'

// ── GET /api/bootstrap/auto/status ──────────────────────────────────────────

test.describe('GET /api/bootstrap/auto/status', () => {
  test('returns all 6 expected fields', async () => {
    const { status, body } = await getJSON('/api/bootstrap/auto/status')
    expect(status).toBe(200)
    expect(body).toHaveProperty('running')
    expect(body).toHaveProperty('steps')
    expect(body).toHaveProperty('aeName')
    expect(body).toHaveProperty('completedAt')
    expect(body).toHaveProperty('error')
    expect(body).toHaveProperty('resources')
  })

  test('running is a boolean', async () => {
    const { body } = await getJSON('/api/bootstrap/auto/status')
    expect(typeof body.running).toBe('boolean')
  })

  test('steps is an array', async () => {
    const { body } = await getJSON('/api/bootstrap/auto/status')
    expect(Array.isArray(body.steps)).toBe(true)
  })

  test('resources is an object', async () => {
    const { body } = await getJSON('/api/bootstrap/auto/status')
    expect(typeof body.resources).toBe('object')
    expect(body.resources).not.toBeNull()
  })
})

// ── POST /api/bootstrap/auto/reset ──────────────────────────────────────────

test.describe('POST /api/bootstrap/auto/reset', () => {
  test('returns ok:true', async () => {
    const { status, body } = await postJSON('/api/bootstrap/auto/reset')
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
  })

  test('resources becomes {} after reset', async () => {
    // Reset first
    await postJSON('/api/bootstrap/auto/reset')
    // Then check status — resources must be an empty object
    const { body } = await getJSON('/api/bootstrap/auto/status')
    expect(body.resources).toEqual({})
    expect(body.running).toBe(false)
    expect(body.steps).toEqual([])
    expect(body.aeName).toBe('')
    expect(body.completedAt).toBeNull()
    expect(body.error).toBeNull()
  })
})

// ── POST /api/bootstrap/auto without Google auth ────────────────────────────

test.describe('POST /api/bootstrap/auto — auth guard', () => {
  test('returns 401 or 403 when Google auth is missing/insufficient (not 500)', async () => {
    const { status, body } = await postJSON('/api/bootstrap/auto', {})
    // Without valid Google token: 401. With token but wrong scopes: 403.
    // With valid token but missing body fields: 400. Already running: 409.
    expect(status).not.toBe(500)
    expect([400, 401, 403, 409]).toContain(status)
    expect(body).toHaveProperty('error')
  })
})

// ── Duplicate bootstrap prevention ──────────────────────────────────────────

test.describe('POST /api/bootstrap/auto — duplicate prevention', () => {
  test('returns 409 if bootstrap is already running', async () => {
    // We cannot easily start a real bootstrap in tests without full Google auth,
    // but we can verify the server's guard at least returns 409 or a clean error
    // code rather than 500 when called twice in quick succession.
    // First call may succeed (400/401/403/409 depending on auth state).
    const first = await postJSON('/api/bootstrap/auto', {})
    expect(first.status).not.toBe(500)

    // If the first call started a bootstrap (unlikely without auth), the second
    // should get 409. Otherwise both will fail with the same auth/validation error.
    if (first.status === 200 || first.status === 202) {
      const second = await postJSON('/api/bootstrap/auto', {})
      expect(second.status).toBe(409)
      expect(second.body.error).toContain('already in progress')
      // Clean up
      await postJSON('/api/bootstrap/auto/reset')
    }
  })
})

// ── GET /api/bootstrap/tableau/session-status ───────────────────────────────

test.describe('GET /api/bootstrap/tableau/session-status', () => {
  test('returns shape with reachable and sessionValid booleans', async () => {
    const { status, body } = await getJSON('/api/bootstrap/tableau/session-status')
    expect(status).toBe(200)
    expect(body).toHaveProperty('reachable')
    expect(body).toHaveProperty('sessionValid')
    expect(typeof body.reachable).toBe('boolean')
    expect(typeof body.sessionValid).toBe('boolean')
  })
})

// ── GET /api/scrape/ccsp/status ──────────────────────────────────────────

test.describe('GET /api/scrape/ccsp/status', () => {
  test('returns shape { running, lastScrape, lastError }', async () => {
    const { status, body } = await getJSON('/api/scrape/ccsp/status')
    expect(status).toBe(200)
    expect(body).toHaveProperty('running')
    expect(body).toHaveProperty('lastScrape')
    expect(body).toHaveProperty('lastError')
    expect(typeof body.running).toBe('boolean')
  })
})
