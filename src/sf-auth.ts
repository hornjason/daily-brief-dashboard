/**
 * src/sf-auth.ts
 * Salesforce browser session state machine.
 *
 * Opens a headed Chromium browser to the SF login page, auto-clicks the
 * "Log in with Red Hat Associate Internal Login" SSO button, and waits for
 * the SAML flow to complete. Since the RH SSO session is already established
 * in the persistent profile, the SSO redirect completes without user interaction.
 *
 * After SF login success, navigates to the RH portal so the same context can
 * be re-adopted by both the RH scraper and the SF scraper. This avoids the need
 * for two browser instances — one context, one profile, both scrapers.
 */

import { chromium } from '@playwright/test'
import type { BrowserContext } from '@playwright/test'
import { writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { closeScrapeContext, adoptScrapeContext, reopenScrapeContextFromAuth } from './rh-scraper.ts'
import { closeSfContext, adoptSfContext, getSfContext } from './sf-scraper.ts'
import { adoptSupportableContext, closeSupportableContext } from './supportable-scraper.ts'
import { adoptCcspContext, closeCcspContext } from './ccsp-scraper.ts'
import { resetAllCircuitBreakers } from './scraper-manager.ts'
import { BASE_CHROMIUM_ARGS, sanitizeChromiumProfile } from './browser-utils.ts'
import { recordSessionEstablished } from './settings-api.ts'

const SF_LOGIN_URL   = 'https://redhatcrm.my.salesforce.com'
const RH_PORTAL_URL  = 'https://access.redhat.com/support/cases/#/case/list'
const LOGIN_TIMEOUT_MS       = 5 * 60 * 1000  // 5 minutes
const LOGIN_POLL_INTERVAL_MS = 2_000

let activeContext: BrowserContext | null = null
let loginInProgress = false
let loginTimedOut = false
export let sfSessionExpired = false

export interface SfAuthStatus {
  hasSession: boolean
  sessionExpired: boolean
  loginInProgress: boolean
  loginTimedOut: boolean
}

export function getSfAuthStatus(sessionPath: string): SfAuthStatus {
  // REG-CONN-01: hasSession requires both a session file AND a live SF browser
  // context — mirrors how /api/auth/redhat/status handles RH in server.ts.
  // A stale session file with no live context should report hasSession: false.
  return {
    hasSession: existsSync(sessionPath) && getSfContext() !== null,
    sessionExpired: sfSessionExpired,
    loginInProgress,
    loginTimedOut,
  }
}

async function cleanupBrowser(): Promise<void> {
  // BKL-CONN: cleanupBrowser ONLY closes the browser context. Module-level flags
  // (loginInProgress, loginTimedOut, sfSessionExpired) are caller-owned. Each call
  // site must set the flags it needs BEFORE invoking cleanupBrowser. Resetting flags
  // here re-opened a race window during the awaited ctx.close() where a concurrent
  // start request could pass the loginInProgress guard.
  const ctx = activeContext
  activeContext = null
  if (ctx) {
    // Close all open pages before closing the context to prevent orphaned blank tabs in VNC
    for (const p of ctx.pages()) {
      await p.close().catch(() => {})
    }
    try { await ctx.close() } catch { /* already closed */ }
  }
}

/**
 * Launch a headed browser to the SF login page.
 *
 * Flow:
 *  1. Release the RH/SF headless profile lock (closeScrapeContext + closeSfContext)
 *  2. Open headed browser → SF login
 *  3. Auto-click "Log in with Red Hat Associate Internal Login" (SSO button)
 *  4. Wait for landing on lightning.force.com
 *  5. Navigate a page to the RH portal (SSO auto-auths since same session)
 *  6. adoptScrapeContext + adoptSfContext — both scrapers share the same context
 */
export async function startSfLoginBrowser(
  sessionPath: string,
  profileDir: string,
  onComplete?: () => void,
): Promise<void> {
  if (loginInProgress) throw new Error('SF login already in progress')

  // Hoist flag set BEFORE any await — closes the race window where a second
  // start request slips past the guard during cleanup. cleanupBrowser no longer
  // resets these flags (caller-owned), so a single set here suffices.
  loginInProgress = true
  sfSessionExpired = false
  loginTimedOut = false

  await cleanupBrowser()

  // Release profile lock so the headed browser can open the same profile
  closeSfContext()         // clear SF keep-alive timer
  await closeScrapeContext()  // close RH headless context, clear profile lock
  // Null out CCSP/Supportable context refs so "Run Now" during auth gets a clear error
  closeSupportableContext()
  closeCcspContext()

  // Remove stale SingletonLock — prevents "profile locked by another process" error
  // if the previous context (RH Portal) didn't release it cleanly.
  try { unlinkSync(join(profileDir, 'SingletonLock')) } catch { /* fine — file may not exist */ }

  // Sanitize Chromium profile preferences to suppress the "Restore pages?" bubble
  sanitizeChromiumProfile(profileDir)

  let context: BrowserContext
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: [...BASE_CHROMIUM_ARGS],
    })
  } catch (e) {
    loginInProgress = false
    throw e
  }

  activeContext = context

  // Clear all pages auto-opened by Chromium from profile history (e.g. RH portal case list tabs).
  // Navigate to about:blank instead of closing — preserves browser-level session cookies.
  for (const p of context.pages()) {
    await p.goto('about:blank').catch((e: any) => {
      console.warn('[sf-auth] failed to blank existing page:', e?.message ?? e)
    })
  }

  const sfPage = await context.newPage()
  await sfPage.bringToFront()

  // Navigate to SF login — await with short timeout so VNC shows SF not RH portal.
  // Poll loop retries if navigation fails (url === 'about:blank' branch at line ~130).
  await sfPage.goto(SF_LOGIN_URL, { timeout: 8_000 }).catch((e: any) => {
    console.warn('[sf-auth] initial SF navigation:', e?.message ?? e)
  })
  console.log('[sf-auth] headed browser opened — navigating to SF login')

  let retryInFlight = false

  ;(async () => {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, LOGIN_POLL_INTERVAL_MS))
      if (!loginInProgress || activeContext !== context) return

      try {
        const url = sfPage.url()

        // Retry navigation if it failed on first attempt (profile lock timing window).
        // Guard with retryInFlight so consecutive poll ticks don't pile up overlapping gotos.
        if (url === 'about:blank') {
          if (!retryInFlight) {
            retryInFlight = true
            sfPage.goto(SF_LOGIN_URL, { timeout: 8_000 }).catch((e: any) => {
              console.warn('[sf-auth] navigation retry failed:', e?.message ?? e)
            }).finally(() => { retryInFlight = false })
          }
          continue
        }

        // Auto-click SSO button while on the login page
        if (url.includes('salesforce.com') && !url.includes('lightning.force.com')) {
          const ssoBtn = sfPage.locator('a:has-text("Red Hat Associate Internal Login"), button:has-text("Red Hat Associate Internal Login")')
          const count = await ssoBtn.count().catch(() => 0)
          if (count > 0) {
            console.log('[sf-auth] SSO button found — clicking…')
            await ssoBtn.first().click().catch(() => {})
          }
        }

        // SF login complete — now navigate to RH portal to re-establish RH scraper session
        if (url.startsWith('https://redhatcrm.lightning.force.com')) {
          console.log('[sf-auth] SF login confirmed — navigating to RH portal to re-adopt RH scraper')
          sfSessionExpired = false

          // Open a new page for RH portal — same context has SSO cookies so it auto-auths
          const rhPage = await context.newPage()
          await rhPage.goto(RH_PORTAL_URL, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})

          // Wait up to 20s for RH portal URL to appear
          if (!rhPage.url().includes('access.redhat.com/support')) {
            await rhPage.waitForURL('**/access.redhat.com/support/**', { timeout: 20_000 }).catch(() => {})
          }

          if (rhPage.url().includes('access.redhat.com/support')) {
            console.log('[sf-auth] RH portal confirmed — adopting shared context for both scrapers')
            writeFileSync(sessionPath, JSON.stringify({ loggedInAt: new Date().toISOString() }), { mode: 0o600 })

            const ctx = activeContext!
            // BKL-UX94: clear VNC after login — blank tab BEFORE nulling refs so
            // we still have ctx if blank tab fails.
            try {
              const blankPage = await ctx.newPage()
              await blankPage.bringToFront()
              await blankPage.goto('about:blank').catch((e: any) => {
                console.warn('[sf-auth] about:blank navigation failed:', e?.message ?? e)
              })
            } catch (e: any) {
              console.warn('[sf-auth] blank tab open failed:', e?.message ?? e)
            }
            await sfPage.close().catch(() => {})
            activeContext = null

            // Re-adopt for all scrapers sharing this SSO context
            adoptScrapeContext(ctx, profileDir, rhPage)
            adoptSfContext(ctx, profileDir)
            adoptSupportableContext(ctx)
            adoptCcspContext(ctx)
            recordSessionEstablished('rh-portal')
            recordSessionEstablished('salesforce')

            // Cold-start recovery: reset circuit breakers accumulated during stale auth
            resetAllCircuitBreakers()
            // BKL-CONN-UI: flip loginInProgress AFTER context adoption so the UI never
            // observes the gap where loginInProgress=false but hasSession=false.
            loginInProgress = false
            console.log('[sf-auth] auth restored — circuit breakers reset, all scrapers re-adopted')

            onComplete?.()
            return
          } else {
            // RH portal didn't load — still adopt for SF only
            console.warn('[sf-auth] RH portal did not load after SF login — SF only')
            writeFileSync(sessionPath, JSON.stringify({ loggedInAt: new Date().toISOString() }), { mode: 0o600 })
            const ctx = activeContext!
            // BKL-UX94: clear VNC after login — blank tab BEFORE nulling refs so
            // we still have ctx if blank tab fails.
            try {
              const blankPage = await ctx.newPage()
              await blankPage.bringToFront()
              await blankPage.goto('about:blank').catch((e: any) => {
                console.warn('[sf-auth] about:blank navigation failed:', e?.message ?? e)
              })
            } catch (e: any) {
              console.warn('[sf-auth] blank tab open failed:', e?.message ?? e)
            }
            await sfPage.close().catch(() => {})
            activeContext = null
            sfSessionExpired = false
            // BKL-CONN-SINGLETON: ctx is still alive — adopt the SAME live ctx for
            // the RH scraper instead of calling reopenScrapeContextFromAuth (which
            // would launch a second Chromium against the same profileDir and race
            // on SingletonLock). Mirrors the happy path above. RH scraper will
            // re-navigate on its next scrape cycle.
            adoptScrapeContext(ctx, profileDir, rhPage)
            adoptSfContext(ctx, profileDir)
            adoptSupportableContext(ctx)
            adoptCcspContext(ctx)
            // Still reset SF circuit breaker even if RH portal didn't load
            resetAllCircuitBreakers()
            // BKL-CONN-UI: flip loginInProgress AFTER context adoption so the UI never
            // observes the gap where loginInProgress=false but hasSession=false.
            loginInProgress = false
            onComplete?.()
            return
          }
        }
      } catch {
        console.log('[sf-auth] browser closed or navigation error — cleaning up')
        // Caller-owned flags: cleanupBrowser no longer resets these.
        loginInProgress = false
        // BKL-CONN-SINGLETON: cleanupBrowser FIRST (closes ctx + releases profile
        // lock), THEN reopenScrapeContextFromAuth (which launches a new Chromium
        // against profileDir). Reverse order races on SingletonLock.
        await cleanupBrowser()
        await reopenScrapeContextFromAuth(profileDir).catch((e: any) => {
          console.warn('[sf-auth] RH context recovery after browser close failed:', e?.message ?? e)
        })
        return
      }
    }

    // Caller-owned flags: cleanupBrowser no longer resets these. Keep loginTimedOut
    // = true so the UI can surface the timeout state; clear in-progress + expired.
    loginTimedOut = true
    loginInProgress = false
    sfSessionExpired = false
    console.warn('[sf-auth] SF login timed out')
    // BKL-CONN-SINGLETON: cleanupBrowser FIRST so the active ctx is closed and
    // profileDir lock is released before reopenScrapeContextFromAuth launches a
    // new Chromium on the same profile. Reverse order races on SingletonLock.
    await cleanupBrowser()
    await reopenScrapeContextFromAuth(profileDir).catch((e: any) => {
      console.warn('[sf-auth] RH context recovery after timeout failed:', e?.message ?? e)
    })
  })()
}

export async function cancelSfLoginBrowser(profileDir: string): Promise<void> {
  // Caller-owned flags: cleanupBrowser no longer resets these.
  loginInProgress = false
  loginTimedOut = false
  sfSessionExpired = false
  await cleanupBrowser()
  await reopenScrapeContextFromAuth(profileDir).catch((e: any) => {
    console.warn('[sf-auth] RH context recovery after cancel failed:', e?.message ?? e)
  })
}
