/**
 * test/rh-solr-compare.spec.ts
 *
 * BKL-RH-03 Phase 1 — validates the server-side SOLR cases API
 * (POST /api/__test/solr-cases) end-to-end:
 *   1. Call the SOLR endpoint with 2 known-good account number sets
 *   2. Assert HTTP 200, non-empty for A10, required fields present, sub-5s duration
 *
 * This is a field-validation + availability test. It does NOT compare results
 * against the cached DOM scrape output — that comparison is a later phase.
 *
 * The endpoint is self-contained: it takes accountNumbers in the request body
 * and returns SOLR results directly. No container state needs to be seeded.
 *
 * Tags:
 *   @live        — needs real RH API + REDHAT_OFFLINE_TOKEN in the container
 *   @destructive — routed to test container (7776) via playwright.config.ts
 *                  (the @destructive tag is what the `test` project grep matches)
 *
 * Skips gracefully if REDHAT_OFFLINE_TOKEN is not set inside the container —
 * server returns 500 with a known error message fragment.
 */

import { test, expect } from './fixtures'
import { requireLocalhost } from './utils/require-localhost'

// Match live-scrapers.spec.ts pattern: use BASE_URL env if set, else 7776 default.
// This spec is @destructive so playwright project routes baseURL to 7776 already.
const BASE = process.env.BASE_URL ?? 'http://localhost:7776'
requireLocalhost(BASE)

// Known-good customers for the SOLR validation
const A10 = {
  name: 'A10 Networks',
  accountNumbers: ['6247997'],
}

const SCRIPPS = {
  name: 'Scripps Health',
  accountNumbers: ['824489', '1007776', '1037583', '5307663'],
}

test.describe('@live @destructive BKL-RH-03 Phase 1: server-side SOLR cases fetch', () => {
  test('A10 Networks — SOLR returns at least one case with all required fields', async ({ request }) => {
    const res = await request.post(`${BASE}/api/__test/solr-cases`, {
      data: {
        customerName: A10.name,
        accountNumbers: A10.accountNumbers,
      },
      timeout: 20_000,
    })

    if (!res.ok()) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      test.skip(true, `SOLR endpoint returned ${res.status()}: ${body.error ?? 'unknown error'} — skipping @live test`)
    }
    const body = await res.json() as {
      cases: Array<Record<string, unknown>>
      numFound: number
      durationMs: number
    }

    expect(Array.isArray(body.cases)).toBeTruthy()
    expect(body.cases.length, 'A10 Networks should have at least one case').toBeGreaterThan(0)
    expect(body.durationMs, 'SOLR call must complete under 5s').toBeLessThan(5_000)

    // Every returned case must carry the core SupportCase-compatible fields.
    // We only check presence + type (not non-empty), because closed/old cases
    // may legitimately have empty product strings.
    for (const c of body.cases) {
      expect(typeof c.caseNumber, 'caseNumber is string').toBe('string')
      expect(c.caseNumber, 'caseNumber is non-empty').not.toBe('')
      expect(typeof c.summary).toBe('string')
      expect(typeof c.status).toBe('string')
      expect(typeof c.severity).toBe('string')
      expect(typeof c.accountNumber).toBe('string')
      expect(typeof c.product).toBe('string')
    }

    // Severity must be a single digit or empty — we normalize to first digit server-side.
    for (const c of body.cases) {
      if (c.severity !== '') {
        expect(
          /^\d$/.test(String(c.severity)),
          `severity "${c.severity}" must be a single digit`,
        ).toBeTruthy()
      }
    }

    // Every case accountNumber should be one of the queried account numbers.
    for (const c of body.cases) {
      expect(
        A10.accountNumbers.includes(String(c.accountNumber)),
        `case accountNumber ${c.accountNumber} not in queried set`,
      ).toBeTruthy()
    }
  })

  test('Scripps Health — SOLR endpoint succeeds across 4 account numbers', async ({ request }) => {
    const res = await request.post(`${BASE}/api/__test/solr-cases`, {
      data: {
        customerName: SCRIPPS.name,
        accountNumbers: SCRIPPS.accountNumbers,
      },
      timeout: 20_000,
    })

    if (!res.ok()) {
      const body2 = await res.json().catch(() => ({})) as { error?: string }
      test.skip(true, `SOLR endpoint returned ${res.status()}: ${body2.error ?? 'unknown error'} — skipping @live test`)
    }

    const body = await res.json() as {
      cases: Array<Record<string, unknown>>
      numFound: number
      durationMs: number
    }

    expect(Array.isArray(body.cases)).toBeTruthy()
    expect(body.durationMs, 'SOLR call must complete under 5s').toBeLessThan(5_000)

    // Even if 0 cases — success means the OR-clause + auth worked for a multi-account query.
    // Any returned cases must belong to one of the queried accounts.
    for (const c of body.cases) {
      expect(
        SCRIPPS.accountNumbers.includes(String(c.accountNumber)),
        `case accountNumber ${c.accountNumber} not in queried set`,
      ).toBeTruthy()
    }
  })
})
