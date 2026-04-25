/**
 * src/rh-cases-api.ts
 *
 * BKL-RH-03 Phase 1 — Server-side SOLR cases fetch using Bearer token.
 *
 * Why this exists:
 *   Today, cases come from browser-based scraping of access.redhat.com (rh-scraper.ts).
 *   That path is stable but heavy — requires Playwright, browser context, SSO cookies.
 *   This module is an alternative path that fetches the same SOLR cases endpoint
 *   using the offline-token → Bearer exchange we already do in src/redhat.ts.
 *   NO browser required.
 *
 * Scope of Phase 1:
 *   Fetch-only. Validates the API path works, returns the same fields the DOM
 *   scraper emits, and confirms Bearer-auth has sufficient privileges to reach
 *   account cases. No wiring into the production data flow — that is a later phase.
 *
 * Do NOT import from rh-scraper.ts / scrape-api.ts / rh-scraper-extract.ts.
 * This module is additive and isolated.
 */

import { getToken } from './redhat.ts'

const CASES_SEARCH_URL =
  'https://access.redhat.com/hydra/rest/search/v2/cases?redhat_client=Portal%20Case%20Management%202.44.57'

const SOLR_EXPRESSION =
  'sort=case_lastModifiedDate%20desc' +
  '&fl=case_number,case_summary,case_status,case_severity,case_accountNumber,case_product,case_lastModifiedDate,case_createdDate,case_owner'

export interface SolrCase {
  caseNumber: string
  summary: string
  status: string
  severity: string        // first digit only ("1", "2", "3", "4")
  accountNumber: string
  product: string
  createdDate: string
  lastModifiedDate: string
  owner: string
}

export interface SolrCasesResult {
  cases: SolrCase[]
  numFound: number
  durationMs: number
}

interface SolrDoc {
  case_number?: string | number
  case_summary?: string
  case_status?: string
  case_severity?: string | number
  case_accountNumber?: string | number
  case_product?: string | string[]
  case_createdDate?: string
  case_lastModifiedDate?: string
  case_owner?: string
}

/**
 * Extract the first digit of a severity string.
 *   "1 (Urgent)" → "1"
 *   "3 (Normal)" → "3"
 *   4           → "4"
 *   ""          → ""
 */
function normalizeSeverity(sev: unknown): string {
  if (sev == null) return ''
  const s = String(sev)
  const m = s.match(/\d/)
  return m ? m[0] : ''
}

/**
 * SOLR returns multi-valued fields as arrays. Pick first value, coerce to string.
 */
function firstString(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) return v.length > 0 ? String(v[0]) : ''
  return String(v)
}

/**
 * Fetch support cases for a set of account numbers using the SOLR cases API.
 *
 * Uses Bearer-token auth from getToken() in src/redhat.ts (offline-token exchange).
 * Returns fields matching SupportCase shape used elsewhere in the app.
 *
 * @param accountNumbers  List of RH account numbers to query
 * @param rows            Max rows to return (default 100)
 */
export async function fetchCasesViaSolr(
  accountNumbers: string[],
  rows = 100,
): Promise<SolrCasesResult> {
  const started = Date.now()

  // Filter to non-empty, digit-only account numbers (defensive); cap at 1000 to bound SOLR query size (BKL-SEC-13)
  const accts = accountNumbers
    .map((a) => String(a ?? '').trim())
    .filter((a) => /^\d+$/.test(a))
    .slice(0, 1000)

  if (accts.length === 0) {
    return { cases: [], numFound: 0, durationMs: Date.now() - started }
  }

  const token = await getToken()

  const q = `case_accountNumber:(${accts.join(' OR ')})`
  const body = {
    q,
    start: 0,
    rows,
    partnerSearch: false,
    expression: SOLR_EXPRESSION,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  let json: { response?: { docs?: SolrDoc[]; numFound?: number } }
  try {
    const res = await fetch(CASES_SEARCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`RH SOLR cases ${res.status}: ${text.slice(0, 300)}`)
    }
    json = await res.json() as typeof json
  } finally {
    clearTimeout(timer)
  }

  const docs: SolrDoc[] = json?.response?.docs ?? []
  const numFound: number = json?.response?.numFound ?? docs.length

  const cases: SolrCase[] = docs.map((d) => ({
    caseNumber: firstString(d.case_number),
    summary: firstString(d.case_summary),
    status: firstString(d.case_status),
    severity: normalizeSeverity(d.case_severity),
    accountNumber: firstString(d.case_accountNumber),
    product: firstString(d.case_product),
    createdDate: firstString(d.case_createdDate),
    lastModifiedDate: firstString(d.case_lastModifiedDate),
    owner: firstString(d.case_owner),
  }))

  return {
    cases,
    numFound,
    durationMs: Date.now() - started,
  }
}
