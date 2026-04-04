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

// ── REG-005: Brief cache behavior (BKL-AI20) ─────────────────────────────────

test.describe('REG-005: Brief cache behavior (BKL-AI20)', () => {
  const KNOWN_CUSTOMER_ENCODED = encodeURIComponent('A10 Networks')

  test('brief endpoint returns fromCache field (never missing)', async () => {
    const { status, body } = await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/brief`)
    expect(status).toBe(200)
    expect(body).toHaveProperty('fromCache')
    expect(typeof body.fromCache).toBe('boolean')
  })

  test('brief endpoint second call returns fromCache: true immediately', async () => {
    await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/brief`)
    const { status, body } = await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/brief`)
    expect(status).toBe(200)
    expect(body.fromCache).toBe(true)
  })

  test('brief endpoint nonexistent customer returns 404, not 500', async () => {
    const { status } = await getJSON('/customer/__nonexistent__/brief')
    expect(status).toBe(404)
  })
})

// ── REG-006: HTTP 500 on empty Gemini response (BKL-G08) ────────────────────

test.describe('REG-006: HTTP 500 on empty Gemini response (BKL-G08)', () => {
  const KNOWN_CUSTOMER_ENCODED = encodeURIComponent('A10 Networks')

  test('brief endpoint returns 200 or structured error (never 500 with empty body)', async () => {
    const { status, body } = await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/brief`)
    // Should never return 500 with no error message
    if (status === 500) {
      expect(body).toHaveProperty('error')
      expect(typeof body.error).toBe('string')
      expect(body.error.length).toBeGreaterThan(0)
    } else {
      expect(status).toBe(200)
    }
  })

  test('brief 500 always has an error string (regression: empty body was returned)', async () => {
    // Verify the route always wraps errors in { error: string } — never sends empty 500 body
    // We test this indirectly: 200 response must have text or error field (not bare empty)
    const { body } = await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/brief`)
    const hasContent = body?.text !== undefined || body?.fromCache !== undefined || body?.error !== undefined
    expect(hasContent).toBe(true)
  })
})

// ── REG-007: Pipeline data flows to both AEs (BKL-W2-26) ────────────────────
//
// NOTE: This test runs after REG-001 restores original AEs — the pipeline
// endpoint uses filterToAEs() which reads the in-memory AE list, so it MUST
// run after the afterAll restore. We use a fresh getJSON call that hits the
// server after restore. Because the afterAll is file-scoped, these tests run
// inside the same describe block so they complete before afterAll fires.
// The pipeline test uses originalAes to restore context explicitly.

test.describe('REG-007: Pipeline data flows to both AEs (BKL-W2-26)', () => {
  // Restore full AE config before these tests so filterToAEs includes both AEs
  test.beforeAll(async () => {
    await postJSON('/api/aes', { aes: originalAes })
  })

  test('pipeline endpoint returns 200 with byOwner array', async () => {
    const { status, body } = await getJSON('/api/pipeline')
    expect(status).toBe(200)
    expect(body).toHaveProperty('byOwner')
    expect(Array.isArray(body.byOwner)).toBe(true)
  })

  test('pipeline totalAcv matches sum of byOwner ACV when data present', async () => {
    const { body } = await getJSON('/api/pipeline')
    const owners = body.byOwner ?? []
    if (owners.length === 0) return // no cache in CI — skip assertion
    const sumAcv = owners.reduce((acc: number, o: { acv: number }) => acc + o.acv, 0)
    expect(Math.abs(body.totalAcv - sumAcv)).toBeLessThan(1)
  })

  test('@live pipeline has data for Elmer Alvarez after BKL-W2-26 fix', async () => {
    const { body } = await getJSON('/api/pipeline')
    const elmer = (body.byOwner ?? []).find((o: { owner: string }) => o.owner?.includes('Elmer'))
    expect(elmer).toBeDefined()
    expect(elmer.count).toBeGreaterThan(0)
    expect(elmer.acv).toBeGreaterThan(0)
  })

  test('@live pipeline has data for Carolanne Farrell', async () => {
    const { body } = await getJSON('/api/pipeline')
    const carolanne = (body.byOwner ?? []).find((o: { owner: string }) => o.owner?.includes('Carolanne'))
    expect(carolanne).toBeDefined()
    expect(carolanne.count).toBeGreaterThan(0)
  })
})
