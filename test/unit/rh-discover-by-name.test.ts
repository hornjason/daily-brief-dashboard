// BKL-RH-03 Phase 3: Bearer-transport account-number discovery.
//
// Tests `discoverAccountNumbersByName` in src/rh-cases-api.ts. The function
// runs on hero installs (no browser) and must:
//   - Match customer aliases against SOLR's permissive prefix results using
//     the same word-containment logic as the browser path (rh-scraper.ts:1154).
//   - Return validated account numbers (/^\d{4,12}$/) and the matching cases.
//
// Mocks getToken() and global fetch so the test exercises the SOLR call shape
// + matching logic in isolation — no network, no offline-token exchange.

import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test'

// Mock token exchange — getToken() returns a stub bearer token.
mock.module('../../src/redhat.ts', () => ({
  getToken: async () => 'stub-bearer-token',
}))

const { discoverAccountNumbersByName } = await import('../../src/rh-cases-api.ts')

// normName + LEGAL_WORDS are not exported — tests below exercise them
// indirectly through discoverAccountNumbersByName, which is the contract
// callers depend on. The two "normalization" tests assert the observable
// outcome: aliases that differ only in punctuation/legal-suffix still match.

const realFetch = globalThis.fetch

function mockSolrFetch(docs: Array<Record<string, unknown>>) {
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({ response: { docs, numFound: docs.length } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch
}

describe('discoverAccountNumbersByName (bearer-transport name matching)', () => {
  beforeEach(() => {
    // each test installs its own fetch mock
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('"Verra Mobility" matches "Verramobility" (punctuation/space stripped)', async () => {
    mockSolrFetch([
      {
        case_number: 'CASE-001',
        case_account_name: 'Verramobility',
        case_accountNumber: '7571757',
        case_summary: 'open issue',
        case_status: 'Waiting on Red Hat',
        case_severity: '3 (Normal)',
        case_product: 'OpenShift',
        case_createdDate: '2026-01-01T00:00:00Z',
        case_lastModifiedDate: '2026-05-01T00:00:00Z',
      },
    ])

    const result = await discoverAccountNumbersByName('Verra Mobility')

    expect(result.accountNumbers).toEqual(['7571757'])
    expect(result.cases.length).toBe(1)
    expect(result.cases[0].caseNumber).toBe('CASE-001')
    expect(result.cases[0].accountNumber).toBe('7571757')
    expect(result.cases[0].severity).toBe('3') // normalizeSeverity → first digit
  })

  test('"Big Ten Network Services" matches "Big Ten Network Services, LLC" (legal suffix stripped)', async () => {
    mockSolrFetch([
      {
        case_number: 'CASE-002',
        case_account_name: 'Big Ten Network Services, LLC',
        case_accountNumber: '5559614',
        case_summary: 'subscription question',
        case_status: 'Closed',
        case_severity: '4',
        case_product: 'RHEL',
        case_createdDate: '2026-02-01T00:00:00Z',
        case_lastModifiedDate: '2026-05-02T00:00:00Z',
      },
    ])

    const result = await discoverAccountNumbersByName('Big Ten Network Services')

    expect(result.accountNumbers).toEqual(['5559614'])
    expect(result.cases.length).toBe(1)
  })

  test('non-matching account name → empty result (word-containment guard)', async () => {
    // SOLR returned a doc whose name does NOT contain every search word.
    // The word-containment match must reject it — defends against SOLR's
    // permissive prefix behavior matching unrelated companies.
    mockSolrFetch([
      {
        case_number: 'CASE-003',
        case_account_name: 'Verra Tennis Courts Inc.',
        case_accountNumber: '9999999',
        case_summary: 'unrelated',
        case_status: 'Open',
        case_severity: '3',
      },
    ])

    const result = await discoverAccountNumbersByName('Verra Mobility')

    expect(result.accountNumbers).toEqual([])
    expect(result.cases).toEqual([])
  })

  test('alias that is only legal words returns empty result (no query)', async () => {
    // No significant words → no SOLR query fired (tested via fetch never
    // being called). Function must short-circuit before reaching network.
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const result = await discoverAccountNumbersByName('LLC, Inc.')

    expect(result.accountNumbers).toEqual([])
    expect(result.cases).toEqual([])
    expect(fetchCalled).toBe(false)
  })

  test('invalid account number format is rejected (only /^\\d{4,12}$/ kept)', async () => {
    mockSolrFetch([
      {
        case_number: 'CASE-004',
        case_account_name: 'Verramobility',
        case_accountNumber: 'NOT-A-NUMBER',
        case_summary: 'invalid acct',
        case_status: 'Open',
        case_severity: '2',
      },
    ])

    const result = await discoverAccountNumbersByName('Verra Mobility')

    // Case is still returned (matched by name) but no account numbers
    // because the SOLR-returned acct fails the digit regex.
    expect(result.accountNumbers).toEqual([])
    expect(result.cases.length).toBe(1)
  })

  test('CamelCase brand: SOLR query contains all 4 casing variants for CrowdStrike', async () => {
    // Verify that the SOLR query string includes the 4 case variants so that
    // SOLR's case-sensitive wildcard matching can find CrowdStrike, CROWDSTRIKE,
    // crowdstrike, and Crowdstrike regardless of how they are stored.
    const queriesSent: string[] = []
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string ?? '{}')
      queriesSent.push(body.q ?? '')
      return new Response(
        JSON.stringify({ response: { docs: [], numFound: 0 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    await discoverAccountNumbersByName('CrowdStrike, Inc.')

    expect(queriesSent.length).toBe(1)
    const q = queriesSent[0]
    // All 4 variants must appear in the query
    expect(q).toContain('case_account_name:CrowdStrike*')
    expect(q).toContain('case_account_name:CROWDSTRIKE*')
    expect(q).toContain('case_account_name:crowdstrike*')
    expect(q).toContain('case_account_name:Crowdstrike*')
  })

  test('attempt 2 single-word fallback fires when attempt 1 empty and first word ≥7 chars', async () => {
    // Attempt 1: searchWords = ['crowdstrike', 'inc'] → 'inc' is legal-stripped → ['crowdstrike']
    // BUT: we mock a doc whose name contains only the first search word in a
    // slightly different suffix form so attempt 1 (all-words) would pass, but
    // this test specifically sets up a case where the doc name does NOT contain
    // all searchWords to exercise the attempt-2 path.
    //
    // Input: alias = 'CrowdTech Security' → searchWords = ['crowdtech', 'security']
    // Doc: case_account_name = 'CrowdTech' (missing 'security') → attempt 1 fails
    // Attempt 2: first word = 'crowdtech' (9 chars ≥ 7) → matches 'crowdtech' → doc collected
    mockSolrFetch([
      {
        case_number: 'CASE-005',
        case_account_name: 'CrowdTech',
        case_accountNumber: '1234567',
        case_summary: 'test case',
        case_status: 'Open',
        case_severity: '2 (High)',
        case_product: 'RHEL',
        case_createdDate: '2026-01-01T00:00:00Z',
        case_lastModifiedDate: '2026-05-01T00:00:00Z',
      },
    ])

    const result = await discoverAccountNumbersByName('CrowdTech Security')

    // Attempt 1 would fail (missing 'security' in stored name).
    // Attempt 2 picks it up via 'crowdtech' (first word, 9 chars ≥ 7).
    expect(result.accountNumbers).toEqual(['1234567'])
    expect(result.cases.length).toBe(1)
  })

  test('attempt 2 does NOT fire when first word is short (<7 chars)', async () => {
    // 'Robert Systems' → searchWords = ['robert', 'systems'] → first word 'robert' = 6 chars
    // Doc only has 'Robert' (missing 'systems') → attempt 1 fails → attempt 2 does NOT fire
    // (too short to be a safe brand-name fallback).
    mockSolrFetch([
      {
        case_number: 'CASE-006',
        case_account_name: 'Robert',
        case_accountNumber: '9876543',
        case_summary: 'short word test',
        case_status: 'Open',
        case_severity: '3',
      },
    ])

    const result = await discoverAccountNumbersByName('Robert Systems')

    // Neither attempt should match — 'robert' is 6 chars, below the ≥7 threshold.
    expect(result.accountNumbers).toEqual([])
    expect(result.cases).toEqual([])
  })
})
