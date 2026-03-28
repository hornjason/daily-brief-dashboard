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
import { writeFileSync, existsSync } from 'node:fs'
import { closeScrapeContext, adoptScrapeContext } from './rh-scraper.ts'
import { closeSfContext, adoptSfContext } from './sf-scraper.ts'

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
  return {
    hasSession: existsSync(sessionPath),
    sessionExpired: sfSessionExpired,
    loginInProgress,
    loginTimedOut,
  }
}

async function cleanupBrowser(): Promise<void> {
  const ctx = activeContext
  activeContext = null
  loginInProgress = false
  if (ctx) {
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

  await cleanupBrowser()

  // Release profile lock so the headed browser can open the same profile
  closeSfContext()         // clear SF keep-alive timer
  await closeScrapeContext()  // close RH headless context, clear profile lock

  loginInProgress = true
  loginTimedOut = false

  let context: BrowserContext
  try {
    context = await chromium.launchPersistentContext(profileDir, { headless: false })
  } catch (e) {
    loginInProgress = false
    throw e
  }

  activeContext = context
  const sfPage = await context.newPage()

  // Navigate to SF login
  sfPage.goto(SF_LOGIN_URL).catch(() => {})
  console.log('[sf-auth] headed browser opened — navigating to SF login')

  ;(async () => {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, LOGIN_POLL_INTERVAL_MS))
      if (!loginInProgress || activeContext !== context) return

      try {
        const url = sfPage.url()

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
            writeFileSync(sessionPath, JSON.stringify({ loggedInAt: new Date().toISOString() }))

            const ctx = activeContext!
            activeContext = null
            loginInProgress = false

            // Re-adopt for both scrapers. adoptScrapeContext also calls adoptSfContext
            // internally (wired in rh-auth.ts), but we call both explicitly here.
            adoptScrapeContext(ctx, profileDir, rhPage)
            adoptSfContext(ctx, profileDir)
            onComplete?.()
            return
          } else {
            // RH portal didn't load — still adopt for SF only
            console.warn('[sf-auth] RH portal did not load after SF login — SF only')
            writeFileSync(sessionPath, JSON.stringify({ loggedInAt: new Date().toISOString() }))
            const ctx = activeContext!
            activeContext = null
            loginInProgress = false
            adoptSfContext(ctx, profileDir)
            onComplete?.()
            return
          }
        }
      } catch {
        console.log('[sf-auth] browser closed or navigation error — cleaning up')
        await cleanupBrowser()
        return
      }
    }

    loginTimedOut = true
    loginInProgress = false
    console.warn('[sf-auth] SF login timed out')
    await cleanupBrowser()
  })()
}

export async function cancelSfLoginBrowser(): Promise<void> {
  loginInProgress = false
  await cleanupBrowser()
}
