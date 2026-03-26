/**
 * src/rh-scraper.ts
 * Headless Playwright scraper for Red Hat support cases.
 *
 * Uses a persistent Chromium profile and keeps the context alive between scrape
 * runs — the same way a regular Chrome profile stays logged in. Short-lived
 * portal cookies (TAsessionID, ~30-90 min) are renewed transparently by the RH
 * SSO layer as long as the longer-lived rh_sso_session cookie (~14 h) is valid.
 * Closing the context between scrapes discards in-memory cookies and breaks that
 * renewal flow, so we keep one context open for the server's lifetime.
 */

import { chromium } from '@playwright/test'
import type { BrowserContext } from '@playwright/test'
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import type { SupportCase } from './types.ts'

export class SessionExpiredError extends Error {
  constructor() {
    super('Red Hat session expired — please reconnect via the dashboard')
    this.name = 'SessionExpiredError'
  }
}

export interface ScrapeOptions {
  accountNumbers: string[]
  profileDir: string
  cachePath: string
}

// ── Long-lived context ────────────────────────────────────────────────────────

let _context: BrowserContext | null = null

export async function initScrapeContext(profileDir: string): Promise<void> {
  if (_context) return // already open
  console.log('[rh-scraper] opening persistent context…')
  _context = await chromium.launchPersistentContext(profileDir, { headless: true })
}

export async function closeScrapeContext(): Promise<void> {
  const ctx = _context
  _context = null
  if (ctx) {
    try { await ctx.close() } catch { /* already closed */ }
  }
}

// ── Session expiry detection ──────────────────────────────────────────────────
//
// RH portal transparently renews TAsessionID via SSO when it expires — the
// browser is briefly at sso.redhat.com before redirecting back.  We must NOT
// treat that redirect as a login requirement.  Only throw SessionExpiredError
// when the SSO page actually requires user interaction (login form visible).

async function checkForSessionExpiry(page: { url(): string; waitForURL(p: string, o?: any): Promise<void> }): Promise<void> {
  const url = page.url()
  // If already on the portal, nothing to do
  if (url.includes('access.redhat.com/support')) return

  // May be mid-redirect (login page or SSO) — wait up to 20 s for the portal to appear.
  // Transparent SSO renewal resolves here; a true expired session stays on SSO/login.
  await page.waitForURL('**/access.redhat.com/support/**', { timeout: 20_000 }).catch(() => {})

  if (!page.url().includes('access.redhat.com/support')) {
    throw new SessionExpiredError()
  }
}

// ── Main scrape function ──────────────────────────────────────────────────────

export async function runRhScrape(options: ScrapeOptions): Promise<SupportCase[]> {
  const { accountNumbers, profileDir, cachePath } = options

  // Ensure long-lived context is open
  await initScrapeContext(profileDir)
  const context = _context!
  const page = await context.newPage()

  const allCases: SupportCase[] = []

  try {
    for (const accountNum of accountNumbers) {
      const url =
        `https://access.redhat.com/support/cases/#/case/list` +
        `?query=accountNumber%3A%20(%22${accountNum}%22)%20orderBy%20severity%20asc` +
        `&p=1&size=100&searchType=basic`

      await page.goto(url, { waitUntil: 'load', timeout: 30_000 })

      // Allow transparent SSO renewal; throw only if login form appears
      await checkForSessionExpiry(page)

      // Wait for Angular table to fully render.
      // The portal renders a partial row quickly then loads the rest over ~6-7s.
      await page.waitForSelector('table tbody tr', { timeout: 15_000 }).catch(() => {})
      await page.waitForTimeout(7000)

      const cases = await page.evaluate((acctNum: string) => {
        const results: Array<{
          caseNumber: string
          summary: string
          status: string
          severity: string
          accountNumber: string
          product: string
        }> = []

        const rows = document.querySelectorAll('table tbody tr')
        for (const row of rows) {
          const caseLink = row.querySelector('a[href*="/case/"]') as HTMLAnchorElement | null
          if (!caseLink) continue

          const caseNumber = caseLink.textContent?.trim() ?? ''
          if (!/^\d{7,10}$/.test(caseNumber)) continue

          const cells = Array.from(row.querySelectorAll('td')).map(
            (td) => td.textContent?.trim() ?? ''
          )

          // Portal columns (verified, 14 total):
          // [0]=checkbox [1]=case# [2]=summary [3]=opened-by [4]=modified [5]=severity [6]=status [8]=product
          results.push({
            caseNumber,
            summary: cells[2] ?? '',
            status: cells[6] ?? '',
            severity: cells[5] ?? '',
            product: cells[8] ?? '',
            accountNumber: acctNum,
          })
        }

        return results
      }, accountNum)

      for (const c of cases) {
        const severityNum = String(c.severity).match(/^(\d)/)?.[1] ?? c.severity
        allCases.push({
          caseNumber: c.caseNumber,
          summary: c.summary,
          status: c.status,
          severity: severityNum,
          accountNumber: c.accountNumber,
          daysOpen: 0,
          product: c.product || undefined,
        } satisfies SupportCase)
      }

      console.log(`[rh-scraper] account ${accountNum}: ${cases.length} cases`)
    }
  } finally {
    // Close the page but NOT the context — keep it alive for session renewal
    await page.close().catch(() => {})
  }

  // Write cache
  await mkdir(dirname(cachePath), { recursive: true })
  await writeFile(
    cachePath,
    JSON.stringify({
      scrapedAt: new Date().toISOString(),
      accounts: accountNumbers,
      cases: allCases,
    }, null, 2)
  )

  return allCases
}
