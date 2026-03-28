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
 * A keep-alive loop fires every 8 minutes. It first attempts a lightweight hybrid
 * path — calling keycloak.updateToken() via page.evaluate to reset the SSO session
 * idle timer, then verifying with a cheap hydra API ping (no full page navigation).
 * If the Keycloak adapter is unavailable, it falls back to a full page navigation.
 * Storage state is persisted to disk after each successful keep-alive so container
 * restarts can restore session state without a fresh login.
 */

import { chromium } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { writeFile, mkdir, readFile, unlink, rename } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
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
let _onSessionExpired: (() => void) | null = null
let _cachedToken: string | null = null   // captured Bearer JWT from intercepted page requests

/** Register a callback to invoke when the keep-alive detects session expiry. */
export function setSessionExpiredCallback(cb: () => void): void {
  _onSessionExpired = cb
}

const KEEP_ALIVE_INTERVAL_MS = 8 * 60 * 1000 // 8 minutes — well before SSO 30-min idle timeout
const SESSION_STATE_FILE = 'session-state.json'

/** Remove Chromium's SingletonLock/Socket/Cookie files left by a previous (crashed or killed) container. */
async function clearProfileLocks(profileDir: string): Promise<void> {
  const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie']
  for (const name of lockFiles) {
    await unlink(join(profileDir, name)).catch(() => {})
  }
}

export async function initScrapeContext(profileDir: string): Promise<void> {
  if (_context) return // already open
  _profileDir = profileDir
  await clearProfileLocks(profileDir)
  console.log('[rh-scraper] opening persistent context…')
  _context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: ['--headless=new', '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors'],
    ignoreDefaultArgs: ['--enable-automation'],
  })
  // Restore session cookies persisted from a previous run
  await restoreSessionCookies()
  _keepAliveTimer = setInterval(
    () => keepAlive().catch(e => console.warn('[rh-scraper] keep-alive error:', e)),
    KEEP_ALIVE_INTERVAL_MS,
  )
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
  // Capture Bearer tokens from outgoing requests — used by keepAlive() hybrid path
  livePage.on('request', req => {
    const auth = req.headers()['authorization']
    if (auth?.startsWith('Bearer ')) { _cachedToken = auth.slice(7) }
  })
  _keepAliveTimer = setInterval(
    () => keepAlive().catch(e => console.warn('[rh-scraper] keep-alive error:', e)),
    KEEP_ALIVE_INTERVAL_MS,
  )
  console.log('[rh-scraper] adopted login context — live page session preserved')
}

/** Returns the active context, or null if no session is open. */
export function getScrapeContext() { return _context }

/** Returns the live authenticated page, or null if no session is open. */
export function getLivePage() { return _livePage }

export async function closeScrapeContext(): Promise<void> {
  if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null }
  const ctx = _context
  _context = null
  _livePage = null
  _profileDir = null
  _cachedToken = null
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

/**
 * Restore session cookies from the persisted state file into the active context.
 * Called on startup so container restarts can resume an existing authenticated session
 * without requiring a fresh login.
 */
async function restoreSessionCookies(): Promise<void> {
  if (!_context || !_profileDir) return
  const statePath = resolve(_profileDir, SESSION_STATE_FILE)
  try {
    const raw = await readFile(statePath, 'utf-8')
    const state = JSON.parse(raw)
    if (Array.isArray(state?.cookies) && state.cookies.length > 0) {
      await _context.addCookies(state.cookies)
      console.log(`[rh-scraper] restored ${state.cookies.length} session cookies from disk`)
    }
  } catch {
    // No state file yet (first run) or parse error — non-fatal, proceed without cookies
  }
}

// ── Keep-alive loop ───────────────────────────────────────────────────────────
//
// Fires every 8 minutes. Attempts a hybrid lightweight path first: calls
// keycloak.updateToken() in the live page to reset the SSO idle timer without
// a full page navigation, then verifies with a cheap hydra API ping.
// Falls back to full page navigation if the Keycloak adapter is unavailable.

async function keepAlive(): Promise<void> {
  if (!_context) return

  // ── Attempt 1: Hybrid lightweight path (no page navigation) ─────────────────
  // Ask the Keycloak JS adapter to refresh its token — this resets the SSO session
  // idle timer server-side without a full page load. Extracts the fresh token so
  // the hydra ping can include it in an Authorization header for stronger auth.
  if (_livePage) {
    try {
      const { refreshed, token } = await _livePage.evaluate<{ refreshed: boolean; token: string | null }>(async () => {
        const kc = (window as any).keycloak ?? (window as any).__keycloak
        if (!kc?.updateToken) return { refreshed: false, token: null }
        try {
          await kc.updateToken(60)
          return { refreshed: true, token: (kc.token as string | null) ?? null }
        } catch {
          return { refreshed: false, token: null }
        }
      }).catch(() => ({ refreshed: false, token: null }))

      if (refreshed) {
        if (token) _cachedToken = token  // keep module-level token current

        const alive = await _livePage.evaluate<boolean>(async (bearerToken: string | null) => {
          try {
            const init: RequestInit = { credentials: 'include' }
            if (bearerToken) init.headers = { Authorization: `Bearer ${bearerToken}` }
            const res = await fetch(
              'https://access.redhat.com/hydra/rest/accounts/?fields=accountNumber&limit=1',
              init,
            )
            return res.ok || res.status === 400
          } catch { return false }
        }, _cachedToken).catch(() => false)

        if (alive) {
          console.log('[rh-scraper] keep-alive: token refreshed via Keycloak adapter')
          await persistSessionState()
          return
        }
      }
    } catch { /* fall through to page nav */ }
  }

  // ── Attempt 2: Full page navigation fallback ─────────────────────────────────
  const usingLivePage = !!_livePage
  const page = _livePage ?? await _context.newPage().catch(() => null)
  if (!page) return
  try {
    await page.goto('https://access.redhat.com/support/cases/#/case/list', {
      waitUntil: 'load',
      timeout: 30_000,
    })
    if (!page.url().includes('access.redhat.com/support')) {
      await page.waitForURL('**/access.redhat.com/support/**', { timeout: 20_000 }).catch(() => {})
    }
    if (page.url().includes('access.redhat.com/support')) {
      console.log('[rh-scraper] keep-alive: session active (page nav)')
      await persistSessionState()
    } else {
      console.warn('[rh-scraper] keep-alive: session expired — reconnect via dashboard')
      _onSessionExpired?.()
    }
  } catch (e: any) {
    console.warn('[rh-scraper] keep-alive: page nav failed —', e?.message ?? e)
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
  if (!_context) throw new Error('[rh-scraper] failed to open browser context')
  const context = _context

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
      // waitForSelector fires on the first row (may be a skeleton/loading row).
      // The content sentinel then waits for a real case number link to appear,
      // which means Angular has finished populating that row's cells.
      // Closed cases also have valid case links, so the sentinel fires quickly
      // for any account with cases — open or closed.
      await page.waitForSelector('table tbody tr', { timeout: 15_000 }).catch(() => {})
      await page.waitForFunction(
        () => {
          const link = document.querySelector('a[href*="/case/"]')
          return link !== null && /^\d{7,10}$/.test(link.textContent?.trim() ?? '')
        },
        { timeout: 12_000 },
      ).catch(() => {
        // Timed out — no case number links appeared (genuinely empty portal or very slow).
        // Fall through with whatever the DOM has.
      })

      // DEBUG: log what the page sees
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
          const status = cells[6] ?? ''
          if (status.toLowerCase() === 'closed') continue  // skip closed cases

          results.push({
            caseNumber,
            summary: cells[2] ?? '',
            status,
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

      // Warn if the table had rows but all were skipped — helps distinguish
      // "all cases legitimately Closed" from "parser broken / column drift"
      if (cases.length === 0) {
        const rowCount = await page.evaluate(() =>
          document.querySelectorAll('table tbody tr').length
        ).catch(() => 0)
        if (rowCount > 0) {
          console.warn(
            `[rh-scraper] account ${accountNum}: ${rowCount} table rows found but 0 kept ` +
            `— all may be Closed, or column indices may have drifted`,
          )
        }
      }
    }
  } finally {
    // If we created a new page (not the live page), close it.
    // If we used the live page, leave it open — it holds the session state.
    if (!usingLivePage) await page.close().catch(() => {})
  }

  // Persist session state after a successful scrape
  await persistSessionState()

  // Write cache atomically — write to .tmp first then rename so a crash mid-write
  // never produces a corrupt cache file that reads as 0 cases.
  await mkdir(dirname(cachePath), { recursive: true })
  const tmpPath = cachePath + '.tmp'
  await writeFile(
    tmpPath,
    JSON.stringify({
      scrapedAt: new Date().toISOString(),
      accounts: accountNumbers,
      cases: allCases,
    }, null, 2),
  )
  await rename(tmpPath, cachePath)

  return allCases
}
