/**
 * Customer-specific API endpoint tests.
 *
 * Validates shape, types, and 404 behavior for all /customer/:name/* routes
 * using Carolanne's live configuration.
 */
import { test, expect, getJSON, CAROLANNE } from '../fixtures'

const CAROLANNE_ENCODED = encodeURIComponent(CAROLANNE.name)
const NONEXISTENT = '__nonexistent_customer_xyz__'

// ── /customer/:name/ccsp ────────────────────────────────────────────────────

test.describe('GET /customer/:name/ccsp', () => {
  test('returns correct shape for known customer', async () => {
    const { status, body } = await getJSON(`/customer/${CAROLANNE_ENCODED}/ccsp`)
    expect(status).toBe(200)

    expect(body).toHaveProperty('totalAcv')
    expect(body).toHaveProperty('byQuarter')
    expect(body).toHaveProperty('byPartner')

    expect(typeof body.totalAcv).toBe('number')
    expect(Array.isArray(body.byQuarter)).toBe(true)
    expect(Array.isArray(body.byPartner)).toBe(true)
  })

  test('totalAcv is a non-negative number', async () => {
    const { body } = await getJSON(`/customer/${CAROLANNE_ENCODED}/ccsp`)
    expect(body.totalAcv).toBeGreaterThanOrEqual(0)
  })

  test('byQuarter entries have {quarter, acv} shape', async () => {
    const { body } = await getJSON(`/customer/${CAROLANNE_ENCODED}/ccsp`)
    for (const entry of body.byQuarter) {
      expect(typeof entry.quarter).toBe('string')
      expect(typeof entry.acv).toBe('number')
    }
  })

  test('byPartner entries have {partner, acv} shape', async () => {
    const { body } = await getJSON(`/customer/${CAROLANNE_ENCODED}/ccsp`)
    for (const entry of body.byPartner) {
      expect(typeof entry.partner).toBe('string')
      expect(typeof entry.acv).toBe('number')
    }
  })

  test('returns zero totals for nonexistent customer (fuzzy match yields nothing)', async () => {
    const { status, body } = await getJSON(`/customer/${NONEXISTENT}/ccsp`)
    // CCSP endpoint does fuzzy matching — nonexistent names return empty, not 404
    expect(status).toBe(200)
    expect(body.totalAcv).toBe(0)
    expect(body.byQuarter).toEqual([])
    expect(body.byPartner).toEqual([])
  })
})

// ── /customer/:name/pipeline ────────────────────────────────────────────────

test.describe('GET /customer/:name/pipeline', () => {
  test('returns correct shape for known customer', async () => {
    const { status, body } = await getJSON(`/customer/${CAROLANNE_ENCODED}/pipeline`)
    expect(status).toBe(200)

    expect(body).toHaveProperty('totalAcv')
    expect(body).toHaveProperty('openCount')
    expect(body).toHaveProperty('opps')
    expect(body).toHaveProperty('closedOpps')

    expect(typeof body.totalAcv).toBe('number')
    expect(typeof body.openCount).toBe('number')
    expect(Array.isArray(body.opps)).toBe(true)
    expect(Array.isArray(body.closedOpps)).toBe(true)
  })

  test('openCount is a non-negative integer', async () => {
    const { body } = await getJSON(`/customer/${CAROLANNE_ENCODED}/pipeline`)
    expect(body.openCount).toBeGreaterThanOrEqual(0)
    expect(Number.isInteger(body.openCount)).toBe(true)
  })

  test('returns zero totals for nonexistent customer (fuzzy match yields nothing)', async () => {
    const { status, body } = await getJSON(`/customer/${NONEXISTENT}/pipeline`)
    // Pipeline endpoint does fuzzy matching — nonexistent names return empty, not 404
    expect(status).toBe(200)
    expect(body.totalAcv).toBe(0)
    expect(body.openCount).toBe(0)
    expect(body.opps).toEqual([])
    expect(body.closedOpps).toEqual([])
  })
})

// ── /customer/:name/events ──────────────────────────────────────────────────

test.describe('GET /customer/:name/events', () => {
  test('returns 404 for nonexistent customer', async () => {
    const { status } = await getJSON(`/customer/${NONEXISTENT}/events`)
    expect(status).toBe(404)
  })

  test.skip('returns SSE stream for known customer (requires configured customers)', async () => {
    // This endpoint returns an SSE stream, not JSON.
    // It requires customers to be in the in-memory list (not just AEs).
    // Skipped because customer list may be empty on clean server state.
  })
})

// ── /customer/:name/brief ───────────────────────────────────────────────────

test.describe('GET /customer/:name/brief', () => {
  test('returns 404 for nonexistent customer', async () => {
    const { status, body } = await getJSON(`/customer/${NONEXISTENT}/brief`)
    expect(status).toBe(404)
    expect(body).toHaveProperty('error')
    expect(body.error).toBe('Customer not found')
  })

  test.skip('returns {text, fromCache} shape for known customer (requires configured customers)', async () => {
    // Brief endpoint requires customer in the in-memory customers list.
    // Skipped when customer list is empty.
  })
})

// ── /customer/:name/sheetdata ───────────────────────────────────────────────

test.describe('GET /customer/:name/sheetdata', () => {
  test('returns 404 or error for nonexistent customer', async () => {
    const { status } = await getJSON(`/customer/${NONEXISTENT}/sheetdata`)
    // Sheetdata endpoint checks customer list — nonexistent returns 404
    expect(status).toBeGreaterThanOrEqual(400)
    expect(status).toBeLessThan(500)
  })

  test.skip('returns 200 for known customer (requires configured customers)', async () => {
    // Sheetdata endpoint requires customer in the in-memory customers list.
    // Skipped when customer list is empty.
  })
})
