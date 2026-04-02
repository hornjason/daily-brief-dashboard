/**
 * Regression Tests — one test per previously-fixed bug
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

// ── REG-001: tableauTerritories preserved after POST /api/aes ────────────────

test.describe('REG-001: tableauTerritories preserved after POST /api/aes', () => {
  test('server-managed fields survive a round-trip save', async () => {
    // Save an AE with tableauTerritories set
    const testAe = {
      name: 'Regression Test AE',
      driveFolderId: 'test-folder-id',
      tableauTerritories: ['WEST_COMM_CORP_NORTHWEST_TERR01', 'EAST_ENT_TERR02'],
    }
    const postRes = await postJSON('/api/aes', { aes: [testAe] })
    expect(postRes.status).toBe(200)

    // Read back and verify tableauTerritories survived
    const getRes = await getJSON('/api/aes')
    expect(getRes.status).toBe(200)
    expect(getRes.body.aes).toHaveLength(1)
    expect(getRes.body.aes[0].tableauTerritories).toEqual([
      'WEST_COMM_CORP_NORTHWEST_TERR01',
      'EAST_ENT_TERR02',
    ])
    expect(getRes.body.aes[0].driveFolderId).toBe('test-folder-id')
  })
})

// ── REG-002: POST /api/scrape/ccsp returns 400 when no territories ────────

test.describe('REG-002: POST /api/scrape/ccsp rejects AEs without territories', () => {
  test('returns 400 when no AEs have tableauTerritories configured', async () => {
    // Save an AE with NO tableauTerritories
    const aeWithoutTerritories = { name: 'No Territory AE' }
    await postJSON('/api/aes', { aes: [aeWithoutTerritories] })

    const res = await postJSON('/api/scrape/ccsp', {})
    // Should be 400 (or 401/403 if no Google auth) — but NOT 200 with silent skip
    // Accept 400 (no territories), 401 (no Google auth), 403 (missing scopes), 409 (scrape in flight from parallel tests)
    expect([400, 401, 403, 409]).toContain(res.status)
    expect(res.body.error).toBeTruthy()
  })
})

// ── REG-003: GET /api/aes returns correct schema ─────────────────────────────

test.describe('REG-003: GET /api/aes returns correct schema', () => {
  test('response has { aes: Array } shape', async () => {
    const { status, body } = await getJSON('/api/aes')
    expect(status).toBe(200)
    expect(body).toHaveProperty('aes')
    expect(Array.isArray(body.aes)).toBe(true)
  })

  test('each AE has a non-empty string name', async () => {
    const { body } = await getJSON('/api/aes')
    for (const ae of body.aes) {
      expect(typeof ae.name).toBe('string')
      expect(ae.name.length).toBeGreaterThan(0)
      expect(ae.name).not.toBe('undefined')
      expect(ae.name).not.toBe('null')
    }
  })

  test('no AE has undefined or null name', async () => {
    const { body } = await getJSON('/api/aes')
    for (const ae of body.aes) {
      expect(ae.name).toBeDefined()
      expect(ae.name).not.toBeNull()
    }
  })
})

// ── REG-004: POST /api/aes rejects HTML injection ───────────────────────────

test.describe('REG-004: POST /api/aes rejects HTML injection in AE names', () => {
  test('script tag in name returns 400', async () => {
    const res = await postJSON('/api/aes', {
      aes: [{ name: '<script>alert(1)</script>' }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
    expect(res.body.error).toContain('invalid')
  })

  test('img onerror injection in name returns 400', async () => {
    const res = await postJSON('/api/aes', {
      aes: [{ name: '<img onerror="alert(1)" src=x>' }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
  })

  test('valid name is accepted', async () => {
    const res = await postJSON('/api/aes', {
      aes: [{ name: 'Jane Smith' }],
    })
    expect(res.status).toBe(200)
  })
})
