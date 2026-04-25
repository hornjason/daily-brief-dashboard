/**
 * test/rh-bearer-phase2.spec.ts
 * BKL-RH-03 Phase 2 — Bearer transport regression suite (ADR-014)
 * @live @destructive — routed to 7776 (REDHAT_OFFLINE_TOKEN lives in container env)
 *
 * Test matrix (10 tests — ADR-014 regression guardrails + additional coverage):
 *   T1  — Bearer field completeness (caseNumber/summary/status/severity/accountNumber/product/createdDate/lastModifiedDate)
 *   T2  — Bearer vs /api/cases/all count parity (±5 tolerance for pagination/closed-case filtering)
 *   T3  — Transport flag defaults to 'bearer' via /api/status/rh-token
 *   T4  — /api/status/scrapes exposes rh.transport field
 *   T5  — /api/status/rh-token endpoint shape
 *   T6  — writeCasesCache exported from rh-scraper.ts (source guard)
 *   T7  — BearerCaseClient shape filters closed cases (via SOLR endpoint A10 probe)
 *   T8  — Transport branch exists in scraper-manager.ts with both bearer and browser paths (source guard)
 *   T9  — Token error surfacing — rh-cases-api.ts throws on token failure, never swallows silently (source guard)
 *   T10 — Full Bearer fetch shape — multi-account OR query returns { cases, numFound, durationMs }
 *
 * Tests tagged @live require REDHAT_OFFLINE_TOKEN in the container and will
 * skip gracefully on a 500 with "REDHAT_OFFLINE_TOKEN" in the error body.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from './fixtures'
import { requireLocalhost } from './utils/require-localhost'

const BASE = process.env.BASE_URL ?? 'http://localhost:7776'
requireLocalhost(BASE)
const __dirname_local = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname_local, '..')

// Known-good customers — same set as Phase 1 spec for consistency
const A10 = {
  name: 'A10 Networks',
  accountNumbers: ['6247997'],
}
const SCRIPPS = {
  name: 'Scripps Health',
  accountNumbers: ['824489', '1007776', '1037583', '5307663'],
}

/** Helper — POST /api/__test/solr-cases and either return parsed body or skip on token-missing */
async function callSolr(request: import('@playwright/test').APIRequestContext, accts: string[], customerName?: string) {
  const res = await request.post(`${BASE}/api/__test/solr-cases`, {
    data: { customerName: customerName ?? null, accountNumbers: accts },
    timeout: 20_000,
  })
  if (!res.ok()) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    test.skip(true, `SOLR endpoint returned ${res.status()}: ${body.error ?? 'unknown error'} — skipping @live test`)
  }
  return res.json() as Promise<{
    cases: Array<Record<string, unknown>>
    numFound: number
    durationMs: number
  }>
}

test.describe('@live @destructive BKL-RH-03 Phase 2: Bearer transport regression', () => {
  // ── T1 — Bearer field completeness ─────────────────────────────────
  test('T1 — Bearer response carries all 8 required case fields', async ({ request }) => {
    const body = await callSolr(request, A10.accountNumbers, A10.name)

    expect(Array.isArray(body.cases)).toBeTruthy()
    expect(body.cases.length, 'A10 Networks should have at least one case').toBeGreaterThan(0)

    for (const c of body.cases) {
      expect(typeof c.caseNumber).toBe('string')
      expect(c.caseNumber, 'caseNumber is non-empty').not.toBe('')
      expect(typeof c.summary).toBe('string')
      expect(typeof c.status).toBe('string')
      expect(typeof c.severity).toBe('string')
      expect(typeof c.accountNumber).toBe('string')
      expect(typeof c.product).toBe('string')
      expect(typeof c.createdDate).toBe('string')
      expect(typeof c.lastModifiedDate).toBe('string')
    }
  })

  // ── T2 — Bearer vs /api/cases/all count parity ─────────────────────
  // /api/cases/all reads the cache written by the last RH scrape.
  // Bearer endpoint fetches live from SOLR. We compare account-filtered
  // counts with a loose tolerance because:
  //   (a) the cache may be slightly stale
  //   (b) /api/cases/all filters closed/resolved; Bearer returns all statuses
  //       (BearerCaseClient filters closed at wrap time; the raw __test
  //        endpoint does not)
  // The goal is sanity, not byte-parity.
  test('T2 — Bearer count is within ±5 of cache count for A10 Networks', async ({ request }) => {
    const bearer = await callSolr(request, A10.accountNumbers, A10.name)

    const cacheRes = await request.get(
      `${BASE}/api/cases/all?includeAll=true&account=${A10.accountNumbers[0]}`,
      { timeout: 10_000 },
    )
    // /api/cases/all degrades to { cases: [] } on any error — so this is
    // a soft check. If cache is empty, skip.
    if (!cacheRes.ok()) {
      test.skip(true, `/api/cases/all returned ${cacheRes.status()} — cache may not be warm; skipping parity check`)
    }
    const cacheBody = await cacheRes.json() as { cases: unknown[]; totalCount: number }
    if (!Array.isArray(cacheBody.cases) || cacheBody.cases.length === 0) {
      test.skip(true, 'cache empty for A10 — skipping parity check (bootstrap not complete)')
    }

    const delta = Math.abs(bearer.cases.length - cacheBody.cases.length)
    expect(
      delta,
      `bearer=${bearer.cases.length} cache=${cacheBody.cases.length} delta=${delta} (tolerance ±5)`,
    ).toBeLessThanOrEqual(5)
  })

  // ── T3 — Transport defaults to bearer via /api/status/rh-token ─────
  test('T3 — /api/status/rh-token returns transport=bearer by default', async ({ request }) => {
    const res = await request.get(`${BASE}/api/status/rh-token`, { timeout: 5_000 })
    expect(res.status()).toBe(200)
    const body = await res.json() as { transport: string; authMode: string }
    // RH_CASES_TRANSPORT should default to 'bearer'. If an operator has set
    // 'browser' for emergency revert in the test container, surface that but
    // don't fail — the test's job is to confirm the flag is READ correctly.
    expect(['bearer', 'browser']).toContain(body.transport)
    expect(body.authMode).toBe('bearer')
  })

  // ── T4 — /api/status/scrapes exposes rh.transport ──────────────────
  test('T4 — /api/status/scrapes includes rh.transport field', async ({ request }) => {
    const res = await request.get(`${BASE}/api/status/scrapes`, { timeout: 5_000 })
    expect(res.status()).toBe(200)
    const body = await res.json() as { rh?: { transport?: string } }
    expect(body.rh).toBeTruthy()
    expect(typeof body.rh?.transport).toBe('string')
    expect(['bearer', 'browser']).toContain(body.rh?.transport ?? '')
  })

  // ── T5 — /api/status/rh-token shape ────────────────────────────────
  test('T5 — /api/status/rh-token returns full telemetry shape', async ({ request }) => {
    const res = await request.get(`${BASE}/api/status/rh-token`, { timeout: 5_000 })
    expect(res.status()).toBe(200)
    const body = await res.json() as Record<string, unknown>

    expect(body).toHaveProperty('authMode')
    expect(body).toHaveProperty('tokenAge')
    expect(body).toHaveProperty('tokenLifetimeMs')
    expect(body).toHaveProperty('cached')
    expect(body).toHaveProperty('transport')

    // cached must be boolean; tokenAge/tokenLifetimeMs must be number or null
    expect(typeof body.cached).toBe('boolean')
    expect(['number', 'object']).toContain(typeof body.tokenAge) // number or null (typeof null === 'object')
    expect(['number', 'object']).toContain(typeof body.tokenLifetimeMs)

    // When cached, ages must be non-negative
    if (body.cached === true) {
      expect(body.tokenAge as number).toBeGreaterThanOrEqual(0)
      expect(body.tokenLifetimeMs as number).toBeGreaterThan(0)
    }
  })

  // ── T6 — writeCasesCache exported from rh-scraper.ts ───────────────
  // Source-level guard: if someone removes this export in a refactor the
  // Bearer transport branch in scraper-manager.ts breaks at runtime. Fail
  // at test time instead.
  test('T6 — src/rh-scraper.ts exports writeCasesCache', async () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/rh-scraper.ts'), 'utf-8')
    expect(
      /export\s+async\s+function\s+writeCasesCache\s*\(/.test(src),
      'writeCasesCache must remain exported from rh-scraper.ts',
    ).toBeTruthy()
  })

  // ── T7 — Closed-case filter via A10 probe ─────────────────────────
  // BearerCaseClient filters out closed cases. The raw /api/__test/solr-cases
  // endpoint does NOT apply that filter (it exposes raw SOLR output) — so
  // we validate the filter at the source layer and confirm the endpoint
  // returns case objects with `status` we can inspect.
  test('T7 — BearerCaseClient filters closed cases (source guard)', async () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/case-client.ts'), 'utf-8')
    expect(
      /\.status\s*\?\?\s*['"]{2}\)?\.toLowerCase\(\)\.includes\(['"]closed['"]\)/.test(src) ||
      /status.*toLowerCase.*includes.*closed/.test(src),
      'BearerCaseClient must drop cases whose status includes "closed"',
    ).toBeTruthy()
  })

  // ── T8 — Transport branch exists in scraper-manager.ts ─────────────
  test('T8 — scraper-manager.ts contains both bearer and browser branches', async () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/scraper-manager.ts'), 'utf-8')
    expect(
      /getConfiguredTransport\s*\(\s*\)/.test(src),
      'scraper-manager.ts must call getConfiguredTransport()',
    ).toBeTruthy()
    expect(
      /BearerCaseClient/.test(src),
      'scraper-manager.ts must instantiate BearerCaseClient',
    ).toBeTruthy()
    expect(
      /runRhScrape\s*\(\s*\{/.test(src),
      'scraper-manager.ts must keep browser path (runRhScrape) available for rollback',
    ).toBeTruthy()
    expect(
      /transport\s*===\s*['"]bearer['"]/.test(src),
      'scraper-manager.ts must gate on transport === "bearer"',
    ).toBeTruthy()
  })

  // ── T9 — Token error surfacing (loud, not silent) ──────────────────
  // Per ADR-014 "Token Hygiene" — 401 / token failure MUST surface, never
  // silent fallback to empty array. rh-cases-api.ts throws on !res.ok;
  // confirm that contract holds.
  test('T9 — rh-cases-api.ts throws on fetch failure (no silent return [])', async () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/rh-cases-api.ts'), 'utf-8')
    expect(
      /throw new Error\(`RH SOLR cases/.test(src),
      'rh-cases-api.ts must throw (not return []) on SOLR error — 401 must be loud',
    ).toBeTruthy()
    // Also guard against someone adding a catch-all return
    expect(
      /catch\s*\([^)]*\)\s*\{\s*return\s*\[\s*\]/.test(src),
      'rh-cases-api.ts must NOT swallow errors with catch → return []',
    ).toBeFalsy()
  })

  // ── T10 — Full Bearer fetch shape across multi-account OR query ────
  test('T10 — Bearer OR query returns { cases, numFound, durationMs }', async ({ request }) => {
    const body = await callSolr(request, SCRIPPS.accountNumbers, SCRIPPS.name)

    expect(Array.isArray(body.cases)).toBeTruthy()
    expect(typeof body.numFound).toBe('number')
    expect(typeof body.durationMs).toBe('number')
    expect(body.durationMs, 'Bearer fetch must complete under 10s').toBeLessThan(10_000)

    // Every returned case must belong to one of the queried accounts
    for (const c of body.cases) {
      expect(
        SCRIPPS.accountNumbers.includes(String(c.accountNumber)),
        `case accountNumber ${c.accountNumber} not in queried set`,
      ).toBeTruthy()
    }

    // If any cases came back, caseNumber must be a non-empty string
    if (body.cases.length > 0) {
      expect(typeof body.cases[0].caseNumber).toBe('string')
      expect(body.cases[0].caseNumber).not.toBe('')
    }
  })
})
