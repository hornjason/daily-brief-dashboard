/**
 * src/rh-auth.ts
 * Red Hat Portal browser session state machine.
 * Manages headed Playwright login, session polling, and status tracking.
 */

import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { writeFileSync, existsSync } from 'node:fs'

const RH_PORTAL_URL = 'https://access.redhat.com/support/cases/#/case/list'
const LOGIN_POLL_INTERVAL_MS = 2_000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

// ── Module-level state ────────────────────────────────────────────────────────

let activeBrowser: Browser | null = null
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
  return url.includes('access.redhat.com') && !url.includes('sso.redhat.com')
}

async function cleanupBrowser(): Promise<void> {
  const b = activeBrowser
  activeBrowser = null
  activePage = null
  loginInProgress = false
  if (b) {
    try { await b.close() } catch { /* already closed */ }
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
 * Launch a headed browser to the RH portal.
 * Polls page URL every 2s to auto-detect login completion.
 * On login: saves storageState to sessionPath, closes browser.
 */
export async function startLoginBrowser(sessionPath: string): Promise<void> {
  if (loginInProgress) {
    throw new Error('Login already in progress')
  }

  // Clean up any stale session
  await cleanupBrowser()

  loginInProgress = true
  loginTimedOut = false

  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext()
  const page = await context.newPage()

  activeBrowser = browser
  activePage = page

  // Navigate to portal (non-blocking — login happens async)
  page.goto(RH_PORTAL_URL).catch(() => {})

  // Background polling loop — auto-saves session on login detection
  ;(async () => {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, LOGIN_POLL_INTERVAL_MS))

      // Check if browser was cancelled externally
      if (!loginInProgress || activePage !== page) return

      try {
        const url = page.url()

        if (isPortalUrl(url)) {
          // Logged in — save session
          const state = await context.storageState()
          writeFileSync(sessionPath, JSON.stringify(state, null, 2))
          console.log('[rh-auth] Session saved to', sessionPath)
          rhSessionExpired = false
          await cleanupBrowser()
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
