/**
 * API Contract Tests — verify server returns correct schemas and handles edge cases
 *
 * These are API-level tests using fetch() directly against the live server.
 * No browser needed.
 *
 * Requires the server to be running:
 *   bun run server.ts &
 * Or against the container:
 *   podman run --rm -p 7777:7777 localhost/daily-brief-dashboard
 *
 * Run:
 *   bun run test:e2e
 */
import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** GET JSON from the server */
async function getJSON(path: string) {
  const res = await fetch(`${BASE_URL}${path}`)
  return { status: res.status, body: await res.json() }
}

/** POST JSON to the server */
async function postJSON(path: string, data: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return { status: res.status, body: await res.json() }
}

// ── Snapshot / restore AE config ─────────────────────────────────────────────

let originalAes: unknown[] = []

test.beforeAll(async () => {
  const { body } = await getJSON('/api/aes')
  originalAes = body.aes ?? []
})

test.afterAll(async () => {
  // Restore original AE config so tests are non-destructive
  await postJSON('/api/aes', { aes: originalAes })
})

// ── Health endpoint ──────────────────────────────────────────────────────────

test.describe('Health endpoint', () => {
  test('GET /health returns 200 with status ok', async () => {
    const res = await fetch(`${BASE_URL}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('status', 'ok')
  })
})

// ── AE config API ────────────────────────────────────────────────────────────

test.describe('AE config API', () => {
  test('GET /api/aes returns { aes: [] } shape', async () => {
    const { status, body } = await getJSON('/api/aes')
    expect(status).toBe(200)
    expect(body).toHaveProperty('aes')
    expect(Array.isArray(body.aes)).toBe(true)
  })

  test('POST /api/aes with valid AE returns 200', async () => {
    const res = await postJSON('/api/aes', {
      aes: [{ name: 'Contract Test AE', driveFolderId: 'test-folder-123' }],
    })
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('ok', true)
  })

  test('POST /api/aes with empty aes array returns 200 (clearing is valid)', async () => {
    const res = await postJSON('/api/aes', { aes: [] })
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('ok', true)
  })

  test('POST /api/aes with name > 200 chars returns 400', async () => {
    const longName = 'A'.repeat(201)
    const res = await postJSON('/api/aes', {
      aes: [{ name: longName }],
    })
    expect(res.status).toBe(400)
    expect(res.body).toHaveProperty('error')
  })

  test('POST /api/aes with non-array aes returns 400', async () => {
    const res = await postJSON('/api/aes', { aes: 'not-an-array' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('aes must be an array')
  })

  test('POST /api/aes with > 50 entries returns 400', async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ name: `AE ${i}` }))
    const res = await postJSON('/api/aes', { aes: tooMany })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('exceeds maximum')
  })
})

// ── Bootstrap pre-checks ─────────────────────────────────────────────────────

test.describe('Bootstrap pre-checks', () => {
  test('POST /api/scrape/supportable without RH session returns 400 or 409', async () => {
    // This test is only meaningful when there is no active RH session.
    // If a real session exists, the endpoint may return 200 — skip in that case.
    const rhStatus = await getJSON('/api/auth/redhat/status')
    test.skip(rhStatus.body.hasSession === true, 'RH session is active — cannot test no-session path')

    const res = await postJSON('/api/scrape/supportable', {})
    expect([400, 401, 403, 409]).toContain(res.status)
    expect(res.body).toHaveProperty('error')
  })

  test('GET /api/scrape/ccsp/status returns correct shape', async () => {
    const { status, body } = await getJSON('/api/scrape/ccsp/status')
    expect(status).toBe(200)
    expect(body).toHaveProperty('running')
    expect(typeof body.running).toBe('boolean')
    // lastScrape is string | null
    expect('lastScrape' in body).toBe(true)
    // lastError is string | null
    expect('lastError' in body).toBe(true)
  })

  test('GET /api/bootstrap/tableau/session-status returns correct shape', async () => {
    const { status, body } = await getJSON('/api/bootstrap/tableau/session-status')
    expect(status).toBe(200)
    expect(body).toHaveProperty('reachable')
    expect(typeof body.reachable).toBe('boolean')
    expect(body).toHaveProperty('sessionValid')
    expect(typeof body.sessionValid).toBe('boolean')
  })
})

// ── RH auth status ───────────────────────────────────────────────────────────

test.describe('RH auth status', () => {
  test('GET /api/auth/redhat/status returns correct shape', async () => {
    const { status, body } = await getJSON('/api/auth/redhat/status')
    expect(status).toBe(200)

    // Required fields
    expect(body).toHaveProperty('hasSession')
    expect(typeof body.hasSession).toBe('boolean')

    expect(body).toHaveProperty('sessionExpired')
    expect(typeof body.sessionExpired).toBe('boolean')

    expect(body).toHaveProperty('loginInProgress')
    expect(typeof body.loginInProgress).toBe('boolean')

    expect(body).toHaveProperty('loginTimedOut')
    expect(typeof body.loginTimedOut).toBe('boolean')

    // lastScraped is string | null
    expect('lastScraped' in body).toBe(true)

    // caseCount is number
    expect(body).toHaveProperty('caseCount')
    expect(typeof body.caseCount).toBe('number')
  })
})

// ── Salesforce auth status ───────────────────────────────────────────────────

test.describe('Salesforce auth status', () => {
  test('GET /api/auth/salesforce/status returns correct shape', async () => {
    const { status, body } = await getJSON('/api/auth/salesforce/status')
    expect(status).toBe(200)

    // From getSfAuthStatus: hasSession, sessionExpired, loginInProgress, loginTimedOut
    expect(body).toHaveProperty('hasSession')
    expect(typeof body.hasSession).toBe('boolean')

    expect(body).toHaveProperty('sessionExpired')
    expect(typeof body.sessionExpired).toBe('boolean')

    expect(body).toHaveProperty('loginInProgress')
    expect(typeof body.loginInProgress).toBe('boolean')

    expect(body).toHaveProperty('loginTimedOut')
    expect(typeof body.loginTimedOut).toBe('boolean')

    // Server-added fields: lastSync, rowCount, syncError, reportConfigured, sheetConfigured
    expect('lastSync' in body).toBe(true)
    expect('syncError' in body).toBe(true)
    expect(body).toHaveProperty('reportConfigured')
    expect(typeof body.reportConfigured).toBe('boolean')
    expect(body).toHaveProperty('sheetConfigured')
    expect(typeof body.sheetConfigured).toBe('boolean')
  })
})
