/**
 * src/rh-scraper.ts
 * Headless Playwright scraper for Red Hat support cases.
 *
 * Uses a persistent Chromium profile and keeps the context alive between scrape
 * runs — the same way a regular Chrome profile stays logged in. Short-lived
 * portal cookies (TAsessionID, ~30-90 min) are renewed transparently by the RH
 * SSO layer as long as the longer-lived rh_sso_session cookie (~14 h) is valid.
 *
 * After login the original browser page is kept alive and reused for scraping.
 * This preserves the page's sessionStorage (PKCE state, SSO tokens) which is
 * required for transparent session renewal. New pages in the same context lack
 * this sessionStorage and trigger a full re-authentication redirect.
 *
 * A keep-alive loop navigates the live page every 12 minutes to refresh
 * TAsessionID before it expires. Storage state is persisted to disk after
 * each successful visit so container restarts can restore session state.
 */

import { chromium } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
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

// ── Long-lived context + page ─────────────────────────────────────────────────

let _context: BrowserContext | null = null
let _livePage: Page | null = null   // the authenticated page — reused to keep sessionStorage alive
let _profileDir: string | null = null
let _keepAliveTimer: ReturnType<typeof setInterval> | null = null

const KEEP_ALIVE_INTERVAL_MS = 12 * 60 * 1000 // 12 minutes — before TAsessionID expires
const SESSION_STATE_FILE = 'session-state.json'

export async function initScrapeContext(profileDir: string): Promise<void> {
  if (_context) return // already open
  _profileDir = profileDir
  console.log('[rh-scraper] opening persistent context…')
  _context = await chromium.launchPersistentContext(profileDir, { headless: true })
  _keepAliveTimer = setInterval(() => keepAlive().catch(() => {}), KEEP_ALIVE_INTERVAL_MS)
}

/**
 * Adopt an already-authenticated BrowserContext + Page from the login flow.
 * The live page is reused for scraping to preserve its sessionStorage (PKCE
 * state, SSO tokens). Closing the page before scraping loses that state and
 * causes transparent SSO renewal to fail on any newly-created page.
 */
export function adoptScrapeContext(context: BrowserContext, profileDir: string, livePage: Page): void {
  if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null }
  // Close any previously held page before replacing
  _livePage?.close().catch(() => {})
  _context = context
  _livePage = livePage
  _profileDir = profileDir
  _keepAliveTimer = setInterval(() => keepAlive().catch(() => {}), KEEP_ALIVE_INTERVAL_MS)
  console.log('[rh-scraper] adopted login context — live page session preserved')
}

export async function closeScrapeContext(): Promise<void> {
  if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null }
  const ctx = _context
  _context = null
  _livePage = null
  _profileDir = null
  if (ctx) {
    try { await ctx.close() } catch { /* already closed */ }
  }
}

// ── Session state persistence ─────────────────────────────────────────────────

async function persistSessionState(): Promise<void> {
  if (!_context || !_profileDir) return
  try {
    const state = await _context.storageState()
    await writeFile(resolve(_profileDir, SESSION_STATE_FILE), JSON.stringify(state))
  } catch { /* non-fatal */ }
}

// ── Keep-alive loop ───────────────────────────────────────────────────────────
//
// Navigates the live page every 12 minutes to refresh TAsessionID and keep
// sessionStorage tokens current. Reuses _livePage if available so session
// storage is preserved; falls back to a new page if no live page exists.

async function keepAlive(): Promise<void> {
  if (!_context) return
  const usingLivePage = !!_livePage
  const page = _livePage ?? await _context.newPage().catch(() => null)
  if (!page) return
  try {
    await page.goto('https://access.redhat.com/support/cases/#/case/list', {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    })
    if (!page.url().includes('access.redhat.com/support')) {
      await page.waitForURL('**/access.redhat.com/support/**', { timeout: 10_000 }).catch(() => {})
    }
    if (page.url().includes('access.redhat.com/support')) {
      console.log('[rh-scraper] keep-alive: session active')
      await persistSessionState()
    } else {
      console.warn('[rh-scraper] keep-alive: session expired — reconnect via dashboard')
    }
  } catch {
    // Non-fatal — next scrape will detect expiry via checkForSessionExpiry
  } finally {
    if (!usingLivePage) await page.close().catch(() => {})
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

  // Reuse the live authenticated page if available — it retains sessionStorage
  // (PKCE state) that new pages lack. Only create a new page as fallback.
  const usingLivePage = !!_livePage
  const page = _livePage ?? await context.newPage()

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
    // If we created a new page (not the live page), close it.
    // If we used the live page, leave it open — it holds the session state.
    if (!usingLivePage) await page.close().catch(() => {})
  }

  // Persist session state after a successful scrape
  await persistSessionState()

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
