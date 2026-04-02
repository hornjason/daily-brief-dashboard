/**
 * src/rh-account-discovery.ts
 *
 * ⚠️  DEPRECATED — NOT IMPORTED ANYWHERE. Do not import or recreate.
 * Account discovery uses Supportable APEX only (POST /api/scrape/supportable/discover).
 * See CLAUDE.md §Supportable Discovery Rules.
 *
 * Discovers Red Hat account numbers using the portal's SOLR cases search API.
 *
 * Strategy (per customer):
 *   POST /hydra/rest/search/v2/cases with:
 *     q = 'account_name: "CustomerName" AND NOT case_status: Closed'
 *   Extract unique case_accountNumber values from all returned docs.
 *
 *   No portal page navigation — a single API call per name/alias.
 *   If the primary name returns 0 results, aliases are tried in order.
 */

import type { Page } from '@playwright/test'

const CASES_BASE   = 'https://access.redhat.com/support/cases/#/case/list'
const CASES_SEARCH = 'https://access.redhat.com/hydra/rest/search/v2/cases'
const RH_CLIENT    = 'Portal%20Case%20Management%202.44.57'

// Minimal SOLR expression: only the fields we need, no heavy facets
const DISCOVERY_EXPRESSION =
  'sort=case_lastModifiedDate%20desc' +
  '&fl=case_accountNumber%2Ccase_account_name%2Ccase_status' +
  '&fq=%7B!tag%3Dc_product%7D*%3A*'

export interface DiscoveryResult {
  customerName: string
  searchTerm: string
  accountNumbers: string[]   // unique account numbers with ≥ 1 open case
  allCandidates: Array<{ name: string; accountNumber: string }>
}

/**
 * Call the SOLR cases API to find cases matching the given account name.
 * Returns all unique case_accountNumber values in the first 200 results.
 * Includes all statuses — open and closed — so we find every account number
 * the customer has ever used. The scraper filters by status later.
 */
async function searchOpenCasesByAccountName(
  page: Page,
  accountName: string,
): Promise<{ accountNumbers: string[]; numFound: number }> {
  // SOLR phrase query — exact account name match, all case statuses
  const escaped = accountName.replace(/"/g, '\\"')
  const q = `account_name: "${escaped}"`

  const apiResult = await page.evaluate(
    async ({
      q,
      expression,
      url,
    }: { q: string; expression: string; url: string }) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            q,
            start: 0,
            rows: 200,
            partnerSearch: false,
            expression,
          }),
        })
        if (!res.ok) return { error: `HTTP ${res.status}` }
        return { data: await res.json() }
      } catch (e: any) {
        return { error: String(e?.message ?? e) }
      }
    },
    {
      q,
      expression: DISCOVERY_EXPRESSION,
      url: `${CASES_SEARCH}?redhat_client=${RH_CLIENT}`,
    },
  )

  if ('error' in apiResult) throw new Error(apiResult.error as string)

  const docs: any[] = (apiResult as any).data?.response?.docs ?? []
  const numFound: number = (apiResult as any).data?.response?.numFound ?? 0
  const accountNumbers = [
    ...new Set(
      docs
        .map((d: any) => String(d.case_accountNumber ?? ''))
        .filter(Boolean),
    ),
  ]

  return { accountNumbers, numFound }
}

/**
 * Discover account numbers for a single customer using an authenticated page.
 *
 * Tries the primary name first; if 0 results, falls back to aliases in order.
 * Collects ALL unique account numbers found (no early exit within a name).
 */
export async function discoverAccountNumbers(
  page: Page,
  customerName: string,
  aliases: string[] = [],
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    customerName,
    searchTerm: customerName,
    accountNumbers: [],
    allCandidates: [],
  }

  // Ensure session cookies are active by being on the portal domain
  if (!page.url().includes('access.redhat.com')) {
    await page.goto(CASES_BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(3_000)
    if (!page.url().includes('access.redhat.com/support')) {
      console.warn(`[account-discovery] ${customerName}: session not active`)
      return result
    }
  }

  const namesToTry = [customerName, ...aliases]

  for (const name of namesToTry) {
    result.searchTerm = name
    console.log(`[account-discovery] ${customerName}: searching SOLR for "${name}"`)

    let accountNumbers: string[] = []
    let numFound = 0
    try {
      ;({ accountNumbers, numFound } = await searchOpenCasesByAccountName(page, name))
    } catch (e: any) {
      console.warn(`[account-discovery] ${customerName}: SOLR error for "${name}" — ${e.message}`)
      continue
    }

    console.log(
      `[account-discovery] ${customerName}: "${name}" → numFound=${numFound}, ` +
      `accounts=[${accountNumbers.join(', ') || 'none'}]`,
    )

    for (const acct of accountNumbers) {
      if (!result.accountNumbers.includes(acct)) {
        result.accountNumbers.push(acct)
        result.allCandidates.push({ name, accountNumber: acct })
      }
    }

    // Primary name found results — no need to try aliases
    if (result.accountNumbers.length > 0 && name === customerName) break
  }

  if (result.accountNumbers.length === 0) {
    console.log(`[account-discovery] ${customerName}: no open cases found`)
  } else {
    console.log(
      `[account-discovery] ✓ ${customerName}: accounts [${result.accountNumbers.join(', ')}]`,
    )
  }

  return result
}
