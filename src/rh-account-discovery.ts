/**
 * src/rh-account-discovery.ts
 *
 * Discovers Red Hat account numbers by calling the portal's internal
 * accounts API (the same endpoint the case filter typeahead uses).
 *
 * Uses page.evaluate() + fetch() so the browser's session cookies are
 * automatically included — no UI interaction or selector fragility.
 *
 * Strategy per customer:
 *   1. Search the API with customer name (and aliases as fallback).
 *   2. For each candidate account number returned, check if it has ≥ 1
 *      open support case by navigating to the filtered cases URL.
 *   3. Record every account number that has cases.
 */

import type { Page } from '@playwright/test'

const CASES_BASE = 'https://access.redhat.com/support/cases/#/case/list'
const ACCOUNTS_API = 'https://access.redhat.com/hydra/rest/accounts/'

export interface DiscoveryResult {
  customerName: string
  searchTerm: string
  accountNumbers: string[]   // numbers with ≥ 1 case
  allCandidates: Array<{ name: string; accountNumber: string }>
}

interface AccountItem {
  accountNumber: string
  name: string
}

/**
 * Search the portal accounts API for accounts matching `nameLike`.
 * Uses the active browser session cookies via fetch() inside page.evaluate().
 */
async function fetchAccountCandidates(
  page: Page,
  nameLike: string,
): Promise<AccountItem[]> {
  const params = new URLSearchParams({
    fields: 'accountNumber,name',
    limit: '60',
    accountNumberNotNull: 'true',
    nameLike,
  })
  const url = `${ACCOUNTS_API}?${params}`

  const data = await page.evaluate(async (apiUrl: string) => {
    const res = await fetch(apiUrl, { credentials: 'include' })
    if (!res.ok) return null
    return res.json()
  }, url)

  if (!data?.items) return []
  return (data.items as AccountItem[]).map(item => ({
    name: String(item.name ?? ''),
    accountNumber: String(item.accountNumber ?? ''),
  })).filter(item => item.accountNumber)
}

/**
 * Navigate to the cases URL filtered by account number and count rows.
 * Returns the case count (0 if none or error).
 */
async function countCasesForAccount(page: Page, accountNumber: string): Promise<number> {
  const url =
    `${CASES_BASE}` +
    `?query=accountNumber%3A%20(%22${accountNumber}%22)%20orderBy%20severity%20asc` +
    `&p=1&size=100&searchType=basic`

  await page.goto(url, { waitUntil: 'load', timeout: 30_000 })

  // Allow SSO transparent renewal
  if (!page.url().includes('access.redhat.com/support')) {
    await page.waitForURL('**/access.redhat.com/support/**', { timeout: 15_000 }).catch(() => {})
  }
  if (!page.url().includes('access.redhat.com/support')) {
    throw new Error('Session expired during discovery')
  }

  await page.waitForSelector('table tbody tr', { timeout: 12_000 }).catch(() => {})
  await page.waitForTimeout(5_000)

  return page.evaluate(() => {
    let valid = 0
    for (const row of document.querySelectorAll('table tbody tr')) {
      if (row.querySelector('a[href*="/case/"]')) valid++
    }
    return valid
  })
}

/**
 * Build ordered search terms: full name first, then first significant word,
 * then aliases.
 */
function searchTerms(name: string, aliases: string[]): string[] {
  const terms: string[] = []
  const candidates = [name, ...aliases]
  for (const c of candidates) {
    const clean = c.trim()
    if (!terms.includes(clean)) terms.push(clean)
    const firstWord = clean.split(/\s+/)[0]
    if (firstWord.length >= 4 && !terms.includes(firstWord)) terms.push(firstWord)
  }
  return terms
}

/**
 * Discover account numbers for a single customer using an authenticated page.
 */
export async function discoverAccountNumbers(
  page: Page,
  customerName: string,
  aliases: string[] = [],
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    customerName,
    searchTerm: '',
    accountNumbers: [],
    allCandidates: [],
  }

  // Ensure we're on the portal (session cookies active)
  if (!page.url().includes('access.redhat.com')) {
    await page.goto(CASES_BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(3_000)
    if (!page.url().includes('access.redhat.com/support')) {
      console.warn(`[account-discovery] ${customerName}: session not active`)
      return result
    }
  }

  const terms = searchTerms(customerName, aliases)

  for (const term of terms) {
    console.log(`[account-discovery] ${customerName}: searching API for "${term}"`)
    result.searchTerm = term

    let candidates: AccountItem[] = []
    try {
      candidates = await fetchAccountCandidates(page, term)
    } catch (e: any) {
      console.warn(`[account-discovery] ${customerName}: API error — ${e.message}`)
      continue
    }

    if (candidates.length === 0) {
      console.log(`[account-discovery] ${customerName}: no accounts found for "${term}"`)
      continue
    }

    result.allCandidates = candidates.map(c => ({ name: c.name, accountNumber: c.accountNumber }))
    console.log(`[account-discovery] ${customerName}: ${candidates.length} candidate(s) from API`)

    for (const candidate of candidates) {
      if (result.accountNumbers.includes(candidate.accountNumber)) continue

      let caseCount = 0
      try {
        caseCount = await countCasesForAccount(page, candidate.accountNumber)
      } catch (e: any) {
        console.warn(`[account-discovery] ${customerName}: error checking ${candidate.accountNumber} — ${e.message}`)
        continue
      }

      if (caseCount >= 1) {
        console.log(`[account-discovery] ✓ ${customerName}: ${candidate.accountNumber} (${candidate.name}) — ${caseCount} case(s)`)
        result.accountNumbers.push(candidate.accountNumber)
      } else {
        console.log(`[account-discovery] ✗ ${customerName}: ${candidate.accountNumber} (${candidate.name}) — 0 cases`)
      }
    }

    if (result.accountNumbers.length > 0) break
  }

  if (result.accountNumbers.length === 0) {
    console.log(`[account-discovery] ${customerName}: no accounts with cases found`)
  }

  return result
}
