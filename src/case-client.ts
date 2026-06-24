/**
 * src/case-client.ts
 * BKL-RH-03 Phase 2 — CaseClient interface (ADR-014)
 *
 * Abstraction boundary between the recurring-refresh orchestrator in
 * scraper-manager.ts and the two concrete transports that can fetch cases:
 *
 *   - BearerCaseClient   — server-side SOLR via Bearer token (no browser)
 *   - browser path       — retained as DR in rh-scraper.ts, invoked directly
 *                          via the 'browser' branch in scraper-manager.ts
 *
 * Cap: exactly 2 implementations total. The browser path is kept in-place in
 * rh-scraper.ts rather than wrapped in a BrowserCaseClient class so the
 * existing stale-overwrite guard + auto-recovery + keep-alive logic stays
 * untouched (ADR-014 "Browser Path Retirement" — warm, not dead).
 *
 * Any proposal for a third transport signals the abstraction is wrong and
 * should be stopped at code review.
 */
import type { SupportCase } from './types.ts'
import { fetchCasesViaSolr } from './rh-cases-api.ts'
import { recordScrapeSuccess } from './rh-auth.ts'

export interface CaseClient {
  readonly authMode: 'bearer' | 'browser'
  fetchCases(
    accountNumbers: string[],
    accountToCustomer?: Map<string, string>,
  ): Promise<SupportCase[]>
}

/**
 * Bearer-token implementation. Calls fetchCasesViaSolr() under the hood,
 * filters out closed cases, de-dupes by caseNumber, computes daysOpen from
 * createdDate, and stamps customerName from the provided reverse map.
 *
 * Shape of returned SupportCase is identical to the browser path in
 * rh-scraper.ts:rh-scraper-extract.ts — verified field-by-field against
 * src/types.ts SupportCase.
 */
export class BearerCaseClient implements CaseClient {
  readonly authMode = 'bearer' as const

  async fetchCases(
    accountNumbers: string[],
    accountToCustomer?: Map<string, string>,
  ): Promise<SupportCase[]> {
    if (accountNumbers.length === 0) return []
    const started = Date.now()
    const { cases: solrCases, numFound, durationMs } =
      await fetchCasesViaSolr(accountNumbers, 500)

    const seen = new Set<string>()
    const now = Date.now()
    const out: SupportCase[] = []
    for (const c of solrCases) {
      if (!c.caseNumber || seen.has(c.caseNumber)) continue
      if ((c.status ?? '').toLowerCase().includes('closed')) continue
      seen.add(c.caseNumber)
      const created = c.createdDate ? new Date(c.createdDate).getTime() : now
      const daysOpen = Math.max(0, Math.floor((now - created) / 86_400_000))
      const supportCase: SupportCase = {
        caseNumber: c.caseNumber,
        summary: c.summary,
        status: c.status,
        severity: c.severity,
        accountNumber: c.accountNumber,
        daysOpen,
        product: c.product || undefined,
        customerName: accountToCustomer?.get(c.accountNumber),
        casesSource: 'account_number',
        description: c.description || undefined,
        contactName: c.contactName || undefined,
      }
      out.push(supportCase)
    }

    console.log(
      `[case-client/bearer] ${out.length} open cases across ${accountNumbers.length} accounts ` +
      `(numFound=${numFound}, solr=${durationMs}ms, wall=${Date.now() - started}ms)`
    )
    // BKL-BUG-04: Mirror what the browser path does on success — stamp
    // lastScraped and clear rhSessionExpired so the RH Portal status tile
    // and the onboarding pre-flight both see the Bearer scrape as "live".
    recordScrapeSuccess(out.length)
    return out
  }
}

/**
 * Read the RH_CASES_TRANSPORT env var. Default is 'bearer' per ADR-014 —
 * Bearer is the primary refresh transport. Set RH_CASES_TRANSPORT=browser
 * for emergency revert (no rebuild required; restart picks up the change).
 */
export function getConfiguredTransport(): 'bearer' | 'browser' {
  const v = (process.env.RH_CASES_TRANSPORT ?? 'bearer').toLowerCase()
  return v === 'browser' ? 'browser' : 'bearer'
}
