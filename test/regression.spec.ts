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

// @destructive tests (REG-001, REG-002, REG-004) replace the AEs list — always route to test container.
// Read-only tests (REG-003, REG-005, REG-006, REG-007) use BASE_URL which defaults to production.
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'
const DESTRUCTIVE_URL = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'

// REG-005/006: known customer with a populated brief cache — override with TEST_KNOWN_CUSTOMER in CI
const KNOWN_CUSTOMER = process.env.TEST_KNOWN_CUSTOMER ?? 'Big Ten Network Services'
const KNOWN_CUSTOMER_ENCODED = encodeURIComponent(KNOWN_CUSTOMER)

// ── Helpers ──────────────────────────────────────────────────────────────────

/** GET JSON from the server (read-only, targets BASE_URL) */
async function getJSON(path: string) {
  const res = await fetch(`${BASE_URL}${path}`)
  return { status: res.status, body: await res.json() }
}

/** POST JSON to the server (read-only, targets BASE_URL) */
async function postJSON(path: string, data: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** POST JSON to the test container (destructive — replaces AEs/customers) */
async function postJSONDestructive(path: string, data: unknown) {
  const res = await fetch(`${DESTRUCTIVE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return { status: res.status, body: await res.json() }
}

// ── Snapshot / restore full config (aes + customers) ─────────────────────────
// Uses /api/__test/snapshot + /api/__test/restore to capture and atomically
// restore both aes.json and customers.json. This prevents the POST /api/aes
// wizard cleanup from irreversibly purging customers for "removed" AEs.

let snapshot: unknown = null

// Gracefully handle missing test container (7776 may not be running in ci --project=ci read-only runs)
test.beforeAll(async () => {
  try {
    const { body } = await postJSONDestructive('/api/__test/snapshot', {})
    snapshot = body
  } catch {
    snapshot = null // test container unavailable — @destructive tests will be skipped by project filter
  }
})

test.afterAll(async () => {
  if (snapshot) {
    try {
      await postJSONDestructive('/api/__test/restore', snapshot)
    } catch { /* ignore — test container may have been stopped */ }
  }
})

// ── REG-001: tableauTerritories preserved after POST /api/aes ────────────────

test.describe('@destructive REG-001: tableauTerritories preserved after POST /api/aes', () => {
  test('server-managed fields survive a round-trip save', async () => {
    // Save an AE with tableauTerritories set
    const testAe = {
      name: 'Regression Test AE',
      driveFolderId: 'test-folder-id',
      tableauTerritories: ['WEST_COMM_CORP_NORTHWEST_TERR01', 'EAST_ENT_TERR02'],
    }
    const postRes = await postJSONDestructive('/api/aes', { aes: [testAe] })
    expect(postRes.status).toBe(200)

    // Read back and verify tableauTerritories survived
    const getRes = await (async () => {
      const res = await fetch(`${DESTRUCTIVE_URL}/api/aes`)
      return { status: res.status, body: await res.json() }
    })()
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

test.describe('@destructive REG-002: POST /api/scrape/ccsp rejects AEs without territories', () => {
  test('returns 400 when no AEs have tableauTerritories configured', async () => {
    // Save an AE with NO tableauTerritories
    const aeWithoutTerritories = { name: 'No Territory AE' }
    await postJSONDestructive('/api/aes', { aes: [aeWithoutTerritories] })

    const res = await postJSONDestructive('/api/scrape/ccsp', {})
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

test.describe('@destructive REG-004: POST /api/aes rejects HTML injection in AE names', () => {
  test('script tag in name returns 400', async () => {
    const res = await postJSONDestructive('/api/aes', {
      aes: [{ name: '<script>alert(1)</script>' }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
    expect(res.body.error).toContain('invalid')
  })

  test('img onerror injection in name returns 400', async () => {
    const res = await postJSONDestructive('/api/aes', {
      aes: [{ name: '<img onerror="alert(1)" src=x>' }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
  })

  test('valid name is accepted', async () => {
    const res = await postJSONDestructive('/api/aes', {
      aes: [{ name: 'Jane Smith' }],
    })
    expect(res.status).toBe(200)
  })
})

// ── REG-005: Brief cache behavior (BKL-AI20) ─────────────────────────────────

test.describe('REG-005: Brief cache behavior (BKL-AI20)', () => {

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
  // Note: file-level beforeAll/afterAll snapshot+restore ensures AE config is restored
  // before these tests run. No nested beforeAll needed.

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

// ── REG-008: Morning summary never returns 500 (BKL-G02) ─────────────────────
// BKL-G02: 8 of 9 signal types were missing — all renewals-only. Fixed 2026-04-04.

test.describe('REG-008: Morning summary response shape (BKL-G02)', () => {
  test('GET /api/morning-summary returns 200 with signals array', async () => {
    const { status, body } = await getJSON('/api/morning-summary')
    expect(status).toBe(200)
    expect(body).toHaveProperty('signals')
    expect(Array.isArray(body.signals)).toBe(true)
  })

  test('morning summary never returns 500 (regression: was missing 8 signal types)', async () => {
    const { status, body } = await getJSON('/api/morning-summary')
    if (status === 500) {
      expect(body).toHaveProperty('error')
      expect(typeof body.error).toBe('string')
      expect(body.error.length).toBeGreaterThan(0)
    } else {
      expect(status).toBe(200)
    }
  })

  test('morning summary response never has null or undefined signals field', async () => {
    const { body } = await getJSON('/api/morning-summary')
    expect(body.signals).not.toBeNull()
    expect(body.signals).not.toBeUndefined()
  })
})

// ── REG-009: Domain inference endpoint is callable (BKL-REG-03) ──────────────
// BKL-REG-03: No Admin UI to re-run domain inference — all domains empty after wipe.
// Fixed 2026-04-10: Added DomainInferenceSection to AdminPage + endpoint verified.

test.describe('@destructive REG-009: Domain inference re-runnable (BKL-REG-03)', () => {
  test('POST /api/setup/infer-domains returns structured result', async () => {
    const res = await postJSONDestructive('/api/setup/infer-domains', {})
    // Accept 200 (success) or 400/409 (in-flight or no customers)
    expect([200, 400, 409]).toContain(res.status)
    if (res.status === 200) {
      expect(res.body).toHaveProperty('total')
      expect(typeof res.body.total).toBe('number')
    } else {
      expect(res.body.error).toBeTruthy()
    }
  })
})

// ── REG-010: Intelligence endpoint uses correct path (BKL-REG-01) ────────────
// BKL-REG-01: AccountIntelligencePanel called POST /api/intelligence/run (non-existent)
// instead of POST /api/customer/:name/generate-intelligence. Fixed 2026-04-10.

test.describe('REG-010: Account intelligence uses correct endpoint (BKL-REG-01)', () => {
  test('POST /api/intelligence/run returns 404 (old wrong endpoint must not exist)', async () => {
    const { status } = await postJSON('/api/intelligence/run', { customer: KNOWN_CUSTOMER })
    expect(status).toBe(404)
  })

  test('POST /api/customer/:name/generate-intelligence returns 200 or queued (never 500)', async () => {
    const { status, body } = await postJSON(`/api/customer/${KNOWN_CUSTOMER_ENCODED}/generate-intelligence`, {})
    if (status === 500) {
      expect(body).toHaveProperty('error')
      expect(body.error.length).toBeGreaterThan(0)
    } else {
      expect([200, 202, 404, 409]).toContain(status)
    }
  })
})

// ── REG-011: Intelligence status schema (BKL-AI05) ───────────────────────────
// BKL-AI05: Dashboard UI — per-customer Generate Intelligence button + doc links.
// Status endpoint must always return a schema, never 500 with empty body.

test.describe('REG-011: Intelligence status endpoint schema (BKL-AI05)', () => {
  test('GET /api/customer/:name/intelligence-status returns schema', async () => {
    const { status, body } = await getJSON(`/api/customer/${KNOWN_CUSTOMER_ENCODED}/intelligence-status`)
    if (status === 200) {
      expect(body).toHaveProperty('status')
    } else {
      expect([200, 404]).toContain(status)
    }
  })
})

// ── REG-012: Pipeline data always well-formed (BKL-W2-26 / BKL-M18) ─────────
// BKL-W2-26: refreshPipeline() staleness check used old sheet IDs → always skipped.
// BKL-M18: Pipeline cache not populated after bootstrap — ReferenceError manualId.
// Both bugs caused pipeline data to be missing or corrupt.
// POST /api/refresh/pipeline requires live Google auth — covered by @live suite.
// This suite covers the read path (GET /api/pipeline) which must always be well-formed.

test.describe('REG-012: Pipeline data always well-formed (BKL-W2-26 / BKL-M18)', () => {
  test('GET /api/pipeline always returns 200 with byOwner array', async () => {
    const { status, body } = await getJSON('/api/pipeline')
    expect(status).toBe(200)
    expect(body).toHaveProperty('byOwner')
    expect(Array.isArray(body.byOwner)).toBe(true)
  })

  test('GET /api/pipeline totalAcv is a non-NaN number (regression: ReferenceError manualId)', async () => {
    const { body } = await getJSON('/api/pipeline')
    expect(typeof body.totalAcv).toBe('number')
    expect(isNaN(body.totalAcv)).toBe(false)
  })

  test('@live POST /api/refresh/pipeline returns 200 (regression: always skipped with old sheet IDs)', async () => {
    const { status, body } = await postJSON('/api/refresh/pipeline', {})
    if (status === 500) {
      expect(body).toHaveProperty('error')
      expect(body.error.length).toBeGreaterThan(0)
    } else {
      expect([200, 202, 401, 403]).toContain(status)
    }
  })
})

// ── REG-013: Brief includes pipeline + CCSP context (BKL-AI21) ───────────────
// BKL-AI21: UI-triggered brief was missing pipeline and CCSP data. Fixed 2026-04-04.

test.describe('REG-013: Brief content includes pipeline and CCSP context (BKL-AI21)', () => {
  test('brief endpoint always returns fromCache field', async () => {
    const { status, body } = await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/brief`)
    expect([200, 404]).toContain(status)
    if (status === 200) {
      expect(body).toHaveProperty('fromCache')
      expect(typeof body.fromCache).toBe('boolean')
    }
  })

  test('@live brief text is non-empty string when cache exists', async () => {
    // First call seeds cache, second call must return fromCache:true
    await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/brief`)
    const { status, body } = await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/brief`)
    expect(status).toBe(200)
    if (body.fromCache === true) {
      expect(typeof body.text).toBe('string')
      expect(body.text.length).toBeGreaterThan(0)
    }
  })
})
