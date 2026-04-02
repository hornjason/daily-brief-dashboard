/**
 * src/rh-auth.ts
 * Red Hat Portal browser session state machine.
 * Uses a persistent Chromium profile (launchPersistentContext) so cookies
 * survive browser restarts the same way a regular Chrome profile does.
 */

import { chromium } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { closeScrapeContext, adoptScrapeContext } from './rh-scraper.ts'
import { adoptSfContext } from './sf-scraper.ts'
import { adoptSupportableContext } from './supportable-scraper.ts'

const RH_PORTAL_URL = 'https://access.redhat.com/support/cases/#/case/list'
const LOGIN_POLL_INTERVAL_MS = 2_000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

// ── Module-level state ────────────────────────────────────────────────────────

let activeContext: BrowserContext | null = null
let activePage: Page | null = null
let loginInProgress = false
let loginTimedOut = false
export let rhSessionExpired = false
export let lastScraped: string | null = null
export let lastCaseCount = 0

export interface RhStatus {
  hasSession: boolean
  sessionExpired: boolean
  lastScraped: string | null
  caseCount: number
  loginInProgress: boolean
  loginTimedOut: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPortalUrl(url: string): boolean {
  return url.includes('access.redhat.com/support')
}

async function cleanupBrowser(): Promise<void> {
  const ctx = activeContext
  activeContext = null
  activePage = null
  loginInProgress = false
  if (ctx) {
    try { await ctx.close() } catch { /* already closed */ }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getRhStatus(sessionPath: string): RhStatus {
  return {
    hasSession: existsSync(sessionPath),
    sessionExpired: rhSessionExpired,
    lastScraped,
    caseCount: lastCaseCount,
    loginInProgress,
    loginTimedOut,
  }
}

/**
 * Launch a headed persistent-context browser to the RH portal.
 * Polls page URL every 2s to auto-detect login completion.
 * On login: writes a marker file to sessionPath, closes browser.
 * Cookies persist in profileDir across restarts — same as Chrome.
 */
export async function startLoginBrowser(sessionPath: string, profileDir: string, onComplete?: () => void): Promise<void> {
  if (loginInProgress) {
    throw new Error('Login already in progress')
  }

  await cleanupBrowser()

  // Release profile dir lock so the headed login browser can use it
  await closeScrapeContext()

  loginInProgress = true
  loginTimedOut = false

  // Remove stale SingletonLock before launching — prevents "profile locked by another process"
  // error if a previous Chromium was killed uncleanly or the scrape context was force-closed.
  try { unlinkSync(join(profileDir, 'SingletonLock')) } catch { /* file doesn't exist — fine */ }

  // launchPersistentContext creates profileDir if it doesn't exist
  let context: BrowserContext
  let page: Page
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    page = await context.newPage()
  } catch (e) {
    loginInProgress = false
    throw e
  }

  activeContext = context
  activePage = page

  // Navigate to portal (non-blocking — login happens async)
  page.goto(RH_PORTAL_URL).catch(() => {})

  // Background polling loop — auto-saves marker on login detection
  ;(async () => {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, LOGIN_POLL_INTERVAL_MS))

      // Check if browser was cancelled externally
      if (!loginInProgress || activePage !== page) return

      try {
        const url = page.url()

        if (isPortalUrl(url)) {
          // Logged in — write marker file (cookies live in profileDir automatically)
          writeFileSync(sessionPath, JSON.stringify({ loggedInAt: new Date().toISOString() }), { mode: 0o600 })
          console.log('[rh-auth] Login confirmed — profile:', profileDir)
          rhSessionExpired = false

          // Transfer the live context + page to the scraper without closing.
          // The page retains sessionStorage (PKCE state, SSO tokens) that is
          // required for transparent session renewal. Closing it and opening
          // a new page loses that state and breaks SSO authentication.
          const ctx = activeContext!
          const livePage = activePage! as Page
          activeContext = null
          activePage = null
          loginInProgress = false

          adoptScrapeContext(ctx, profileDir, livePage)
          // SF and Supportable share the same SSO session via the Chromium profile
          adoptSfContext(ctx, profileDir)
          adoptSupportableContext(ctx)
          onComplete?.()
          return
        }
      } catch {
        // Page closed by user or navigation error
        console.log('[rh-auth] Browser closed or navigation error — cleaning up')
        await cleanupBrowser()
        return
      }
    }

    // Timed out
    console.log('[rh-auth] Login timed out after 5 minutes')
    loginTimedOut = true
    await cleanupBrowser()
  })()
}

/**
 * Cancel an in-progress login session.
 */
export async function cancelLoginBrowser(): Promise<void> {
  await cleanupBrowser()
}

/**
 * Update scrape state after a successful run.
 */
export function recordScrapeSuccess(caseCount: number): void {
  rhSessionExpired = false
  lastScraped = new Date().toISOString()
  lastCaseCount = caseCount
}

/**
 * Mark session as expired after a failed scrape.
 */
export function recordScrapeExpired(): void {
  rhSessionExpired = true
}
