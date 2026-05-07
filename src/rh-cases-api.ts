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

// SOLR expression for name-based discovery — adds case_account_name so we can
// verify that returned docs actually belong to the customer (defends against
// SOLR's permissive prefix matching). Same fl set as the account-number path
// otherwise — the cases we return must be display-equivalent to bearer-fetched.
const SOLR_DISCOVERY_EXPRESSION =
  'sort=case_lastModifiedDate%20desc' +
  '&fl=case_number,case_summary,case_status,case_severity,case_accountNumber,case_account_name,case_product,case_lastModifiedDate,case_createdDate,case_owner'

// Legal-entity tokens stripped from name-match comparison — copied verbatim
// from rh-scraper.ts:1159 (the in-page evaluate()) so the bearer path matches
// the browser path identically. Update both call sites if this list changes.
const LEGAL_WORDS = new Set([
  'INC',
  'LLC',
  'LLP',
  'LTD',
  'LP',
  'CORP',
  'CO',
  'PLC',
  'ATTN',
  'LL',
])

/**
 * Normalize a company name for word-containment matching.
 * Mirrors `normName` at rh-scraper.ts:1154 exactly. Do not diverge — the two
 * implementations must produce the same output for the same input or hero
 * (bearer) and Mac Mini (browser) discovery will resolve different accounts
 * for the same customer.
 */
function normName(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normLower(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

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
  case_account_name?: string
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

export interface DiscoverByNameResult {
  accountNumbers: string[]
  cases: SolrCase[]
}

/**
 * Discover RH account numbers for a customer by company name, using the
 * Bearer-token SOLR cases endpoint. This is the bearer-transport equivalent
 * of `discoverAccountNumberByName` in src/rh-scraper.ts (the browser-based
 * sidebar autocomplete + in-page case-API call).
 *
 * Why this exists:
 *   Hero installs (NODE_ROLE unset) have an offline token but no browser
 *   profile / Playwright. Without this, hero installs that boot fresh with
 *   customers that lack `accountNumbers` cannot bootstrap their cases.
 *
 * Algorithm:
 *   1. Normalize the alias with normLower() → lowercase, A-Z0-9 only, single-spaced
 *   2. Drop legal-entity tokens (INC, LLC, etc.) and 1-char tokens → searchWords
 *   3. Build a 4-variant OR query on the first non-legal word of the original alias:
 *      `case_account_name:Word* OR case_account_name:WORD* OR case_account_name:word* OR ...`
 *      Covers all common SOLR storage casings (camelCase brands like CrowdStrike need
 *      exact case — SOLR wildcards are case-sensitive).
 *   4. Attempt 1: for every doc whose normLower(case_account_name) contains ALL searchWords
 *      → collect accountNumber. This filters out SOLR's permissive prefix over-matching.
 *   5. Attempt 2 (fires only if attempt 1 empty AND first word ≥7 chars): re-filter docs
 *      using first word only. Handles compound names stored without the second component
 *      (e.g. "OmniVision Technologies" stored as "Omnivision" in SOLR).
 *   6. Validate accountNumbers against /^\d{4,12}$/ before returning.
 *
 * Returns ALL matching cases (not just the ones tied to a valid account
 * number) so the caller can fold them into `nameDiscoveredCases` for display
 * — same shape as the browser path emits via `DiscoverResult.cases`.
 *
 * Note: bearer transport runs on hero — no `assertPrimary()` /
 * `assertLiveScrapeAllowed()` guard here. Those guards exist on the browser
 * path because Tableau/CCSP scrapes are leader-only; SOLR cases are not.
 */
export async function discoverAccountNumbersByName(
  alias: string,
  rows = 100,
): Promise<DiscoverByNameResult> {
  // normLower used for response-side word-containment matching (case-insensitive).
  const searchedNorm = normLower(alias)
  const searchWords = searchedNorm
    .split(' ')
    .filter((w) => w.length > 1 && !LEGAL_WORDS.has(w.toUpperCase()))

  if (searchWords.length === 0) {
    return { accountNumbers: [], cases: [] }
  }

  // Build query: first non-legal word from alias, 4 casing variants (covers camelCase brands)
  const origWords = alias
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 1 && !LEGAL_WORDS.has(w.toUpperCase()))

  if (origWords.length === 0) return { accountNumbers: [], cases: [] }

  const word = origWords[0]
  const variants = [...new Set([
    word,                                                        // original case
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(), // titlecase
    word.toUpperCase(),                                          // uppercase
    word.toLowerCase(),                                          // lowercase
  ])]
  const q = variants.map((v) => `case_account_name:${v}*`).join(' OR ')

  const token = await getToken()

  const body = {
    q,
    start: 0,
    rows,
    partnerSearch: false,
    expression: SOLR_DISCOVERY_EXPRESSION,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  let json: { response?: { docs?: SolrDoc[] } }
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
      throw new Error(`RH SOLR discover ${res.status}: ${text.slice(0, 300)}`)
    }
    json = await res.json() as typeof json
  } finally {
    clearTimeout(timer)
  }

  const docs: SolrDoc[] = json?.response?.docs ?? []

  const seenNums = new Set<string>()
  const matchedDocs: SolrDoc[] = []

  for (const doc of docs) {
    const storedNameLower = normLower(doc.case_account_name ?? '')
    if (!storedNameLower) continue
    // Word-containment match: every significant word from the query alias
    // must appear in the stored account name (case-insensitive). Defends against
    // SOLR's prefix promiscuity (e.g. "big ten*" matches "big tennis courts").
    if (!searchWords.every((w) => storedNameLower.includes(w))) continue

    matchedDocs.push(doc)
    const n = doc.case_accountNumber
    if (n != null) {
      const validNum = /^\d{4,12}$/.test(String(n).trim())
        ? String(n).trim()
        : null
      if (validNum) seenNums.add(validNum)
    }
  }

  // Attempt 2: first word only if ≥7 chars (brand name — safe single-word fallback)
  // Fires when attempt 1 returned empty AND the first significant word is long enough
  // to be a specific brand name (not a common word like "Robert" or "Fred").
  if (matchedDocs.length === 0 && searchWords[0]?.length >= 7) {
    const firstWord = searchWords[0]
    for (const doc of docs) {
      const sn = normLower(doc.case_account_name ?? '')
      if (!sn) continue
      if (!sn.includes(firstWord)) continue
      matchedDocs.push(doc)
      const n = doc.case_accountNumber
      if (n != null) {
        const validNum = /^\d{4,12}$/.test(String(n).trim()) ? String(n).trim() : null
        if (validNum) seenNums.add(validNum)
      }
    }
  }

  const cases: SolrCase[] = matchedDocs.map((d) => ({
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
    accountNumbers: Array.from(seenNums),
    cases,
  }
}
