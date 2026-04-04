/**
 * Account intelligence pipeline API tests.
 * Covers job status shape, intelligence endpoint existence, and pipeline data flow.
 *
 * Routes under test:
 *   GET  /api/customer/:name/intelligence-status  — job status for a customer
 *   POST /api/customer/:name/generate-intelligence — trigger intelligence run
 *   GET  /api/pipeline                             — aggregated pipeline (both AEs)
 *   GET  /api/ccsp                                 — aggregated cloud spend
 *   GET  /customer/:name/pipeline                  — per-customer pipeline opps
 */
import { test, expect, getJSON, CAROLANNE } from '../fixtures'

// "A10 Networks" is a real customer under Carolanne's territory.
// CAROLANNE.name is the AE name — not a customer — so we use an actual customer.
const KNOWN_CUSTOMER = 'A10 Networks'
const KNOWN_CUSTOMER_ENCODED = encodeURIComponent(KNOWN_CUSTOMER)
const NONEXISTENT = '__nonexistent_customer_xyz__'

// ── Intelligence job status ──────────────────────────────────────────────────

test.describe('Intelligence job status', () => {
  test('GET intelligence-status for known customer returns valid shape', async () => {
    const { status, body } = await getJSON(`/api/customer/${KNOWN_CUSTOMER_ENCODED}/intelligence-status`)
    expect(status).toBe(200)
    // When no job has ever run, server returns { status: 'none', message: '...' }
    expect(body).toHaveProperty('status')
    expect(typeof body.status).toBe('string')
    // Valid status values: 'none', 'pending', 'running', 'complete', 'error'
    expect(['none', 'pending', 'running', 'complete', 'error']).toContain(body.status)
  })

  test('GET intelligence-status status field is always a string', async () => {
    const { body } = await getJSON(`/api/customer/${KNOWN_CUSTOMER_ENCODED}/intelligence-status`)
    expect(typeof body.status).toBe('string')
    expect(body.status.length).toBeGreaterThan(0)
  })

  test('GET intelligence-status for nonexistent customer returns 404', async () => {
    const { status } = await getJSON(`/api/customer/${NONEXISTENT}/intelligence-status`)
    expect(status).toBe(404)
  })

  test('GET intelligence-status 404 body has error field', async () => {
    const { body } = await getJSON(`/api/customer/${NONEXISTENT}/intelligence-status`)
    expect(body).toHaveProperty('error')
    expect(typeof body.error).toBe('string')
  })
})

// ── Pipeline data flow (BKL-AI21 + BKL-W2-26) ───────────────────────────────

test.describe('Pipeline data flows to both AEs', () => {
  test('GET /api/pipeline returns 200', async () => {
    const { status } = await getJSON('/api/pipeline')
    expect(status).toBe(200)
  })

  test('/api/pipeline byOwner is an array', async () => {
    const { body } = await getJSON('/api/pipeline')
    expect(body).toHaveProperty('byOwner')
    expect(Array.isArray(body.byOwner)).toBe(true)
  })

  test('/api/pipeline has byOwner array with correct shape when data present', async () => {
    const { body } = await getJSON('/api/pipeline')
    for (const owner of body.byOwner ?? []) {
      expect(typeof owner.owner).toBe('string')
      expect(typeof owner.acv).toBe('number')
      expect(typeof owner.count).toBe('number')
    }
  })

  test('@live /api/pipeline byOwner is non-empty', async () => {
    const { body } = await getJSON('/api/pipeline')
    expect(body.byOwner.length).toBeGreaterThanOrEqual(1)
  })

  test('@live /api/pipeline has data for Carolanne Farrell', async () => {
    const { body } = await getJSON('/api/pipeline')
    const carolanne = (body.byOwner ?? []).find((o: { owner: string }) => o.owner?.includes('Carolanne'))
    expect(carolanne).toBeDefined()
    expect(carolanne.count).toBeGreaterThan(0)
    expect(carolanne.acv).toBeGreaterThan(0)
  })

  test('@live /api/pipeline has data for Elmer Alvarez (BKL-W2-26 fix)', async () => {
    const { body } = await getJSON('/api/pipeline')
    const elmer = (body.byOwner ?? []).find((o: { owner: string }) => o.owner?.includes('Elmer'))
    expect(elmer).toBeDefined()
    expect(elmer.count).toBeGreaterThan(0)
    expect(elmer.acv).toBeGreaterThan(0)
  })

  test('@live /api/pipeline totalAcv is positive number', async () => {
    const { body } = await getJSON('/api/pipeline')
    expect(typeof body.totalAcv).toBe('number')
    expect(body.totalAcv).toBeGreaterThan(0)
  })

  test('/api/pipeline has byStage array', async () => {
    const { body } = await getJSON('/api/pipeline')
    expect(body).toHaveProperty('byStage')
    expect(Array.isArray(body.byStage)).toBe(true)
  })
})

// ── CCSP cache data ───────────────────────────────────────────────────────────

test.describe('CCSP cache has data', () => {
  test('GET /api/ccsp returns 200', async () => {
    const { status } = await getJSON('/api/ccsp')
    expect(status).toBe(200)
  })

  test('/api/ccsp totalAcv is a number (0 if no data in CI)', async () => {
    const { body } = await getJSON('/api/ccsp')
    expect(typeof body.totalAcv).toBe('number')
    expect(body.totalAcv).toBeGreaterThanOrEqual(0)
  })

  test('/api/ccsp byQuarter is an array', async () => {
    const { body } = await getJSON('/api/ccsp')
    expect(Array.isArray(body.byQuarter)).toBe(true)
  })
})

// ── Customer pipeline endpoint ────────────────────────────────────────────────

test.describe('Customer pipeline endpoint', () => {
  test('GET /customer/:name/pipeline returns 200 for known customer', async () => {
    const { status } = await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/pipeline`)
    expect(status).toBe(200)
  })

  test('/customer/:name/pipeline has totalAcv number', async () => {
    const { body } = await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/pipeline`)
    expect(typeof body.totalAcv).toBe('number')
    expect(body.totalAcv).toBeGreaterThanOrEqual(0)
  })

  test('/customer/:name/pipeline has openCount number', async () => {
    const { body } = await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/pipeline`)
    expect(typeof body.openCount).toBe('number')
    expect(body.openCount).toBeGreaterThanOrEqual(0)
  })

  test('/customer/:name/pipeline has opps and closedOpps arrays', async () => {
    const { body } = await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/pipeline`)
    expect(Array.isArray(body.opps)).toBe(true)
    expect(Array.isArray(body.closedOpps)).toBe(true)
  })
})
