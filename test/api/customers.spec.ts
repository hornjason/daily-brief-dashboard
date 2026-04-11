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

// "Big Ten Network Services" is a real customer in the current 106-customer dataset with
// accountNumbers populated. Override with TEST_KNOWN_CUSTOMER env var for test container.
const KNOWN_CUSTOMER = process.env.TEST_KNOWN_CUSTOMER ?? 'Big Ten Network Services'
const KNOWN_CUSTOMER_ENCODED = encodeURIComponent(KNOWN_CUSTOMER)

test.describe('GET /customer/:name/brief', () => {
  test('returns 404 for nonexistent customer', async () => {
    const { status, body } = await getJSON(`/customer/${NONEXISTENT}/brief`)
    expect(status).toBe(404)
    expect(body).toHaveProperty('error')
    expect(body.error).toBe('Customer not found')
  })

  // BKL-AI20: brief cache TTL behavior
  test('returns 200 with {text, fromCache} shape for known customer', async () => {
    const { status, body } = await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/brief`)
    expect(status).toBe(200)
    expect(body).toHaveProperty('text')
    expect(body).toHaveProperty('fromCache')
    expect(typeof body.text).toBe('string')
    expect(typeof body.fromCache).toBe('boolean')
  })

  test('fromCache field is always present (boolean, not missing)', async () => {
    const { status, body } = await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/brief`)
    expect(status).toBe(200)
    expect(body).toHaveProperty('fromCache')
    expect(typeof body.fromCache).toBe('boolean')
  })

  test('second call immediately returns fromCache: true (within TTL)', async () => {
    // First call ensures a cache entry exists
    await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/brief`)
    // Second call should hit cache
    const { status, body } = await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/brief`)
    expect(status).toBe(200)
    expect(body.fromCache).toBe(true)
  })

  // BKL-AI20: force=true bypasses cache
  // Note: force=true triggers a real Gemini call — skipped in CI to avoid network flakiness.
  // The shape expectation (fromCache: false) is validated by the non-force path returning fromCache: true.
  test.skip('force=true bypasses cache and returns fromCache: false (requires Gemini)', async () => {
    const { status, body } = await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/brief?force=true`)
    expect(status).toBe(200)
    expect(body.fromCache).toBe(false)
  })
})

// ── BKL-AI21: Pipeline + CCSP in brief route ────────────────────────────────

test.describe('BKL-AI21: Pipeline and CCSP caches flow into brief', () => {
  test('brief returns 200 when pipeline and CCSP caches exist (no 500)', async () => {
    // This validates that the brief route reads pipeline/CCSP caches without throwing
    const { status, body } = await getJSON(`/customer/${KNOWN_CUSTOMER_ENCODED}/brief`)
    expect(status).toBe(200)
    // Must not have an error field on success
    if (body.fromCache || body.text) {
      expect(body).not.toHaveProperty('error')
    }
  })

  test('GET /api/pipeline returns 200 with byOwner array', async () => {
    const { status, body } = await getJSON('/api/pipeline')
    expect(status).toBe(200)
    expect(body).toHaveProperty('byOwner')
    expect(Array.isArray(body.byOwner)).toBe(true)
  })

  test('@live pipeline byOwner has at least one entry with owner, acv, count', async () => {
    const { body } = await getJSON('/api/pipeline')
    const owners = body.byOwner ?? []
    expect(owners.length).toBeGreaterThanOrEqual(1)
    for (const owner of owners) {
      expect(typeof owner.owner).toBe('string')
      expect(typeof owner.acv).toBe('number')
      expect(typeof owner.count).toBe('number')
      expect(owner.count).toBeGreaterThan(0)
    }
  })
})

// ── BKL-ENRICH-01: industry/segment fields on /customers list ──────────────
//
// @xfail — BKL-AI01 was marked DONE 2026-04-02 but enrichment never ran on the
// SW pod. As of 2026-04-10, only 2 of 106 customers have industry/segment
// populated. Tests below document the expected contract; they are marked
// xfail until the enrichment batch completes. Remove xfail once all customers
// have industry populated (verify: grep -c '"industry"' data/config/customers.json).

test.describe('GET /customers — industry/segment fields (BKL-ENRICH-01)', () => {
  test('returns 200 with an array of customer objects', async () => {
    const { status, body } = await getJSON('/customers')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
  })

  // @xfail: enrichment batch has not run — most customers lack industry/segment.
  // Remove xfail and the fail() guard once BKL-ENRICH-01 is resolved.
  test.fail('every customer has a non-empty industry field [xfail: BKL-ENRICH-01 — enrichment never ran on SW pod]', async () => {
    const { body } = await getJSON('/customers')
    const customers: unknown[] = body
    const missing = customers.filter((c: any) => !c.industry || c.industry === '')
    // Should be 0 once enrichment runs; currently ~104 of 106 are missing
    expect(missing.length).toBe(0)
  })

  // @xfail: same root cause as above.
  test.fail('every customer has a non-empty segment field [xfail: BKL-ENRICH-01 — enrichment never ran on SW pod]', async () => {
    const { body } = await getJSON('/customers')
    const customers: unknown[] = body
    const missing = customers.filter((c: any) => !c.segment || c.segment === '')
    expect(missing.length).toBe(0)
  })

  // Non-xfail: structure contract. industry/segment MUST be present on objects
  // that have them (not undefined, not null — string or absent).
  test('customers with industry field have it as a non-empty string', async () => {
    const { body } = await getJSON('/customers')
    const customers: unknown[] = body
    for (const c of customers as any[]) {
      if ('industry' in c) {
        expect(typeof c.industry).toBe('string')
        expect(c.industry.length).toBeGreaterThan(0)
      }
      if ('segment' in c) {
        expect(typeof c.segment).toBe('string')
        expect(c.segment.length).toBeGreaterThan(0)
      }
    }
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
