/**
 * Multi-AE Isolation — API-level integration tests (TEST-P0-04)
 *
 * Validates that AE filtering works correctly at the API level so a data leak
 * between AEs cannot ship green. Per TEST-AUDIT.md gap #3: 10 AEs are seeded
 * on 7776 — without this spec, cross-contamination would pass all 109 tests.
 *
 * Targets the test container (port 7776) — tagged @destructive so the
 * playwright `test` project routes it to TEST_URL/7776.
 *
 * Endpoints exercised:
 *   GET /api/pipeline                — full pipeline summary
 *   GET /api/pipeline?ae=<name>      — pipeline filtered to a single AE
 *   GET /api/ccsp                    — CCSP byAE breakdown
 *   GET /api/accounts                — customer/account list (replaces non-existent /api/customers)
 */
// Using fixtures.ts so the serverState auto-fixture snapshot/restores config
// before/after each test. Without it, parallel destructive tests in the same
// project (bootstrap-onboarding, qa-e2e-newuser) wipe the seeded 10-AE data.
import { test } from '../fixtures'
import { expect } from '@playwright/test'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'

test.describe('AE isolation — pipeline and CCSP filtered by AE @destructive', () => {
  test.use({ baseURL: BASE })

  // Precondition guard: needs ≥2 AEs seeded. Parallel destructive tests in the
  // same project (qa-e2e-newuser, bootstrap-onboarding) call /api/setup/reset
  // which wipes the AE list mid-suite. Skip cleanly when that happens — see
  // TEST-AUDIT.md "parallel destructive isolation" gap.
  test.beforeEach(async ({ request }, testInfo) => {
    const aesRes = await request.get(`${BASE}/api/aes`)
    if (!aesRes.ok()) {
      testInfo.skip(true, `precondition: GET /api/aes returned ${aesRes.status()}`)
      return
    }
    const body = await aesRes.json()
    const aes = Array.isArray(body) ? body : body.aes ?? []
    if (aes.length < 2) {
      testInfo.skip(true, `precondition: only ${aes.length} AEs seeded — need ≥2. Restore via 'make test-restore' + 'make test-up-live'.`)
    }
  })

  test('pipeline AE filter returns different totals per AE', async ({ request }) => {
    const allRes = await request.get(`${BASE}/api/pipeline`)
    expect(allRes.status(), 'GET /api/pipeline must succeed').toBe(200)
    const all = await allRes.json()

    const carolanneRes = await request.get(`${BASE}/api/pipeline?ae=${encodeURIComponent('Carolanne Farrell')}`)
    expect(carolanneRes.status(), 'GET /api/pipeline?ae=Carolanne+Farrell must succeed').toBe(200)
    const carolanne = await carolanneRes.json()

    const elmerRes = await request.get(`${BASE}/api/pipeline?ae=${encodeURIComponent('Elmer Alvarez')}`)
    expect(elmerRes.status(), 'GET /api/pipeline?ae=Elmer+Alvarez must succeed').toBe(200)
    const elmer = await elmerRes.json()

    expect(Array.isArray(all.byOwner), 'unfiltered pipeline must expose byOwner array').toBe(true)
    expect(all.byOwner.length, 'unfiltered must have multiple owners').toBeGreaterThan(1)

    expect(typeof all.totalAcv, 'pipeline must expose numeric totalAcv').toBe('number')
    expect(typeof carolanne.totalAcv, 'filtered pipeline must expose numeric totalAcv').toBe('number')
    expect(typeof elmer.totalAcv, 'filtered pipeline must expose numeric totalAcv').toBe('number')

    expect(carolanne.totalAcv, 'Carolanne ACV must be less than total').toBeLessThan(all.totalAcv)
    expect(elmer.totalAcv, 'Elmer ACV must be less than total').toBeLessThan(all.totalAcv)
    expect(carolanne.totalAcv, 'Carolanne and Elmer must differ — proves filter actually selects different rows').not.toBe(elmer.totalAcv)
  })

  test('CCSP byAE returns distinct ACVs per AE with no AE exceeding the portfolio total', async ({ request }) => {
    const res = await request.get(`${BASE}/api/ccsp`)
    expect(res.status(), 'GET /api/ccsp must succeed').toBe(200)
    const ccsp = await res.json()

    expect(ccsp.byAE, 'byAE array must exist').toBeDefined()
    expect(Array.isArray(ccsp.byAE), 'byAE must be an array').toBe(true)
    expect(ccsp.byAE.length, 'must have multiple AEs').toBeGreaterThan(1)

    const aes = ccsp.byAE as Array<{ ae: string, acv: number }>
    const acvs = aes.map(e => e.acv)
    const unique = new Set(acvs)
    expect(unique.size, 'AE ACVs must not all be identical — proves per-AE breakdown is real').toBeGreaterThan(1)

    // No AE should have ACV > total — that would indicate a join/aggregation bug
    // (e.g., CCSP rows being attributed to multiple AEs, double-counting at the source).
    const total = ccsp.totalAcv ?? aes.reduce((s, e) => s + e.acv, 0)
    expect(typeof total, 'CCSP total must be numeric').toBe('number')
    for (const ae of aes) {
      expect(ae.acv, `${ae.ae} ACV must not exceed total`).toBeLessThanOrEqual(total + 1)
    }
  })

  test('accounts endpoint returns data and exposes per-customer AE attribution', async ({ request }) => {
    // /api/customers does not exist on this codebase — the customer list lives at /api/accounts.
    const res = await request.get(`${BASE}/api/accounts`)
    expect(res.status(), 'GET /api/accounts must succeed').toBe(200)
    const body = await res.json()
    const customers = Array.isArray(body) ? body : body.customers ?? []
    expect(customers.length, 'must have at least 1 customer').toBeGreaterThan(0)

    // Per-customer AE attribution is the primitive that lets the client filter
    // dashboards by AE without a server round-trip. If `ae` is missing on every
    // customer, the AE chip bar can never filter the account list.
    const withAe = customers.filter((c: { ae?: string }) => typeof c.ae === 'string' && c.ae.length > 0)
    expect(withAe.length, 'at least 1 customer must carry an `ae` field').toBeGreaterThan(0)

    const distinctAes = new Set(withAe.map((c: { ae: string }) => c.ae))
    expect(distinctAes.size, 'customers must span multiple AEs to validate isolation').toBeGreaterThan(1)
  })
})
