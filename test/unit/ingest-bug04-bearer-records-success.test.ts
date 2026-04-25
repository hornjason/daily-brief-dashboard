// BKL-BUG-04: Regression test — BearerCaseClient.fetchCases() must call
// recordScrapeSuccess() on success so lastScraped/sessionExpired stay in sync
// with the browser path in rh-scraper.ts.
//
// Without this, Bearer-transport scrapes populate cases but the RH Portal
// status tile reports lastScraped=null forever, making the dashboard look
// broken and making the onboarding pre-flight misread "connected" as stale.
//
// Mocks fetchCasesViaSolr so the test exercises BearerCaseClient in isolation
// — no network, no SOLR, no Bearer-token exchange.

import { test, expect, describe, beforeEach, mock } from 'bun:test'

// Mock fetchCasesViaSolr BEFORE importing case-client so BearerCaseClient
// picks up the mocked module. 3 fake SOLR docs, all open, all distinct.
mock.module('../../src/rh-cases-api.ts', () => ({
  fetchCasesViaSolr: async (_accts: string[], _rows?: number) => ({
    cases: [
      {
        caseNumber: '03000001',
        summary: 'fake open case 1',
        status: 'Waiting on Red Hat',
        severity: '3',
        accountNumber: '123456',
        product: 'OpenShift',
        createdDate: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        lastModifiedDate: new Date().toISOString(),
        owner: 'tester',
      },
      {
        caseNumber: '03000002',
        summary: 'fake open case 2',
        status: 'Waiting on Customer',
        severity: '4',
        accountNumber: '123456',
        product: 'RHEL',
        createdDate: new Date(Date.now() - 5 * 86_400_000).toISOString(),
        lastModifiedDate: new Date().toISOString(),
        owner: 'tester',
      },
      {
        caseNumber: '03000003',
        summary: 'fake open case 3',
        status: 'In Progress',
        severity: '2',
        accountNumber: '123456',
        product: 'OpenShift',
        createdDate: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        lastModifiedDate: new Date().toISOString(),
        owner: 'tester',
      },
    ],
    numFound: 3,
    durationMs: 5,
  }),
}))

// Import AFTER mock is registered so the BearerCaseClient sees the mocked
// fetchCasesViaSolr, not the real one.
const { BearerCaseClient } = await import('../../src/case-client.ts')
const rhAuth = await import('../../src/rh-auth.ts')

describe('BKL-BUG-04: BearerCaseClient.fetchCases records scrape success', () => {
  beforeEach(() => {
    // rh-auth module state is shared across tests — reset the observable
    // exports via the public API so each test starts from a known state.
    // recordScrapeExpired() flips rhSessionExpired=true; recordScrapeSuccess()
    // resets it. We reset here so the "no regression" assertion is meaningful.
    rhAuth.recordScrapeExpired()
  })

  test('lastScraped is updated after a successful Bearer fetch', async () => {
    // Sanity: before the call, either null or a prior stamp — not the one we
    // are about to write. We capture the pre-call value and assert the
    // post-call value is (a) not null and (b) not equal to the pre-call value
    // when the pre-call value is non-null.
    const before = rhAuth.lastScraped

    const client = new BearerCaseClient()
    const cases = await client.fetchCases(['123456'])

    expect(cases.length).toBe(3)
    expect(rhAuth.lastScraped).not.toBeNull()
    // Stamp must be an ISO string
    expect(typeof rhAuth.lastScraped).toBe('string')
    expect(() => new Date(rhAuth.lastScraped as string).toISOString()).not.toThrow()

    // If there was a pre-call stamp, the new one must be >= it (success
    // always advances the timestamp, never regresses).
    if (before) {
      expect(
        new Date(rhAuth.lastScraped as string).getTime(),
      ).toBeGreaterThanOrEqual(new Date(before).getTime())
    }
  })

  test('sessionExpired is cleared after a successful Bearer fetch', async () => {
    // beforeEach just flipped rhSessionExpired=true via recordScrapeExpired().
    // A successful fetchCases() must clear it — otherwise the RH tile would
    // continue showing "expired" even after a good Bearer scrape.
    const client = new BearerCaseClient()
    await client.fetchCases(['123456'])

    // getRhStatus needs a session path; we pass a path that does not exist
    // so hasSession=false and the only remaining signal is sessionExpired.
    // sessionExpired is the OR of rhSessionExpired (module state) and
    // (hasSession && cookie-expiry) — with hasSession=false the second half
    // collapses to false, so sessionExpired reflects the module flag we care
    // about.
    const status = rhAuth.getRhStatus('/tmp/does-not-exist-rh-session.json')
    expect(status.sessionExpired).toBe(false)
  })

  test('empty accountNumbers array short-circuits without touching scrape state', async () => {
    // fetchCases returns [] early when given no accounts. recordScrapeSuccess
    // must NOT fire in this path — writing "lastScraped=now" on an empty call
    // would misrepresent the last real scrape time.
    // Flip sessionExpired on so we can observe whether the empty path cleared it.
    rhAuth.recordScrapeExpired()
    const before = rhAuth.lastScraped

    const client = new BearerCaseClient()
    const cases = await client.fetchCases([])

    expect(cases.length).toBe(0)
    // Unchanged — empty path did NOT call recordScrapeSuccess
    expect(rhAuth.lastScraped).toBe(before)
    const status = rhAuth.getRhStatus('/tmp/does-not-exist-rh-session.json')
    expect(status.sessionExpired).toBe(true)
  })
})
