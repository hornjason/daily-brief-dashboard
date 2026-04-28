/**
 * src/tableau-auth.ts
 * Tableau browser session manager — isolated from the shared scrape context.
 *
 * Uses launchPersistentContext with a SEPARATE profile directory so the Tableau
 * SSO chain (Okta → Red Hat IDP → Tableau Online) runs in a completely separate
 * Chromium process. This prevents renderer corruption of the shared scrape context
 * that caused CCSP to hang after every Tableau login (BKL-CONN-TABLEAU-CTX-01).
 *
 * Cookie harvest: on successful login, Tableau-domain cookies are written to
 * TABLEAU_SESSION_PATH (same file ccsp-scraper.ts reads via restoreTableauSession).
 */
import { chromium } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BASE_CHROMIUM_ARGS, sanitizeChromiumProfile } from './browser-utils.ts'
import { getScrapeContext, setLivePageBusy } from './rh-scraper.ts'

const TABLEAU_AUTH_PROFILE_DIR = process.env.TABLEAU_AUTH_PROFILE_DIR ?? '/data/rh-profile-tableau-auth'
const TABLEAU_SESSION_PATH = `${process.env.RH_PROFILE_DIR ?? '/data/rh-profile'}/tableau-session.json`
const TABLEAU_URL = 'https://10ay.online.tableau.com/#/site/redhatanalytics/views/OverallCloudConsumptionDashboard/CloudConsumption'
const LOGIN_POLL_INTERVAL_MS = 2_000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const TABLEAU_COOKIE_AGE_MS = parseInt(process.env.TABLEAU_COOKIE_AGE_MS ?? '') || 8 * 60 * 60 * 1000  // 8 hours — same as Tableau SSO TTL (env-overridable)
// Match ccsp-scraper.ts cookie filter exactly (line 48): includes('tableau.com') || includes('online.tableau')
const TABLEAU_COOKIE_DOMAINS = ['tableau.com', 'online.tableau']

let activeContext: BrowserContext | null = null
let activePage: Page | null = null
let loginInProgress = false

export function isTableauLoginInProgress(): boolean {
  return loginInProgress
}

/**
 * Check if Tableau session cookies on disk are present and fresh.
 * Used as a fast pre-check before launching the live probe.
 */
export async function checkTableauSessionFromCookies(): Promise<boolean> {
  try {
    if (!existsSync(TABLEAU_SESSION_PATH)) return false
    const saved = JSON.parse(readFileSync(TABLEAU_SESSION_PATH, 'utf-8'))
    if (!saved.cookies?.length || !saved.savedAt) return false
    const age = Date.now() - Date.parse(saved.savedAt)
    if (age >= TABLEAU_COOKIE_AGE_MS) return false
    // XSRF-TOKEN alone is not a valid auth session — require at least one auth cookie
    const authCookies = saved.cookies.filter((c: any) => c.name !== 'XSRF-TOKEN')
    return authCookies.length > 0
  } catch {
    return false
  }
}

/**
 * Live probe: launch a headless isolated browser, restore saved cookies, navigate to
 * the CCSP dashboard URL, and confirm we land on 10ay.online.tableau.com without hitting
 * the SSO login wall. Returns true only if the session is genuinely active.
 * Uses the isolated TABLEAU_AUTH_PROFILE_DIR — zero shared-context risk.
 */
export async function probeTableauSession(): Promise<boolean> {
  if (loginInProgress) return false  // don't interfere with active login
  let ctx = null
  try {
    ctx = await chromium.launchPersistentContext(TABLEAU_AUTH_PROFILE_DIR, {
      headless: true,
      args: [...BASE_CHROMIUM_ARGS],
    })
    // Restore saved cookies into probe context
    if (existsSync(TABLEAU_SESSION_PATH)) {
      try {
        const saved = JSON.parse(readFileSync(TABLEAU_SESSION_PATH, 'utf-8'))
        if (saved.cookies?.length) await ctx.addCookies(saved.cookies)
      } catch { /* non-fatal */ }
    }
    const page = await ctx.newPage()
    await page.goto(TABLEAU_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await page.waitForTimeout(2_000)
    const url = page.url()
    return url.startsWith('https://10ay.online.tableau.com') &&
      !url.includes('/auth') && !url.includes('/login')
  } catch {
    return false
  } finally {
    try { await (ctx as any)?.close() } catch { /* ignore */ }
  }
}

async function _closeContext(opts: { harvest: boolean }): Promise<boolean> {
  const ctx = activeContext
  const page = activePage
  activeContext = null
  activePage = null
  loginInProgress = false
  setLivePageBusy(false)
  let harvested = false
  if (!ctx || !page) return false
  if (opts.harvest) {
    try {
      const state = await ctx.storageState()
      const tableauCookies = state.cookies.filter(c =>
        TABLEAU_COOKIE_DOMAINS.some(d => c.domain.includes(d))
      )
      if (tableauCookies.length > 0) {
        writeFileSync(
          TABLEAU_SESSION_PATH,
          JSON.stringify({ cookies: tableauCookies, savedAt: new Date().toISOString() }),
          { mode: 0o600 }
        )
        console.log(`[tableau-auth] harvested ${tableauCookies.length} cookies → ${TABLEAU_SESSION_PATH}`)
        const domains = [...new Set(tableauCookies.map(c => c.domain))].join(', ')
        console.info(`[tableau-auth] harvested ${tableauCookies.length} cookies from domains: ${domains}`)
        harvested = true
      } else {
        console.warn('[tableau-auth] _closeContext: 0 cookies harvested — login may have failed')
      }
    } catch (e: any) {
      console.warn('[tableau-auth] cookie harvest failed:', e?.message ?? e)
    }
  }
  // Close only our page — never close the shared context
  try { await page.close() } catch { /* already closed */ }
  return harvested
}

/**
 * Launch an isolated headed Chromium to the Tableau login page.
 * The headed window appears in VNC at localhost:6080.
 * Call waitForTableauLogin() to poll for success.
 */
export async function startTableauLoginBrowser(): Promise<void> {
  if (loginInProgress) throw new Error('Tableau login already in progress')
  loginInProgress = true

  const sharedCtx = getScrapeContext()
  if (!sharedCtx) {
    loginInProgress = false
    throw new Error('Shared scrape context not ready — initialize browser first')
  }

  try {
    setLivePageBusy(true)
    activeContext = sharedCtx  // reference only — we do NOT own this context
    const page = await sharedCtx.newPage()
    activePage = page

    // Track any new page the SSO flow opens (popup, new tab) and redirect it back
    // to TABLEAU_URL so focus stays on the Tableau login flow, not an orphaned tab.
    sharedCtx.on('page', (newPage) => {
      if (!loginInProgress) return
      console.log('[tableau-auth] SSO opened new tab — redirecting to Tableau login URL')
      newPage.goto(TABLEAU_URL).catch(() => {})
      activePage = newPage
    })

    page.goto(TABLEAU_URL).catch((e: any) => {
      console.warn('[tableau-auth] initial navigation failed:', e?.message ?? e)
    })
    console.log('[tableau-auth] shared context Chromium launched — visible at localhost:6080')
  } catch (e) {
    loginInProgress = false
    setLivePageBusy(false)
    activeContext = null
    activePage = null
    throw e
  }
}

/**
 * Wait for the Tableau login to complete in the isolated context.
 * On success: harvests cookies to TABLEAU_SESSION_PATH, closes context, returns true.
 * On timeout/error: closes context without harvesting, returns false.
 */
export async function waitForTableauLogin(timeoutMs: number = LOGIN_TIMEOUT_MS): Promise<boolean> {
  const page = activePage
  const ctx = activeContext
  if (!page || !ctx) {
    console.warn('[tableau-auth] waitForTableauLogin: no active session')
    return false
  }

  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, LOGIN_POLL_INTERVAL_MS))

    if (!loginInProgress || activePage !== page) return false

    try {
      const url = page.url()
      // Must be on the actual CCSP dashboard URL — not the email entry page or any other
      // 10ay.online.tableau.com page. The email entry page never contains '/site/.../views/'.
      // After successful SSO, Tableau redirects back to the original URL which always has
      // '/site/redhatanalytics/views/' in the path.
      const onCcspDashboard = url.startsWith('https://10ay.online.tableau.com') &&
        url.includes('/site/') && url.includes('/views/')
      if (!onCcspDashboard) continue

      // Stability check: wait 3s then re-confirm URL hasn't changed (still on dashboard)
      await new Promise(r => setTimeout(r, 3_000))
      if (page.url() !== url) continue

      // Positive check: Tableau viz glass pane must be present — confirms viz actually loaded
      const hasVizContent = await page.$('.tab-glassPane, iframe[id^="tableau"], .tab-content')
        .then(el => !!el).catch(() => false)

      if (hasVizContent) {
        console.log('[tableau-auth] login detected — harvesting cookies')
        const harvested = await _closeContext({ harvest: true })
        if (!harvested) return false
        return true
      }
    } catch {
      // Page closed or crashed
      await _closeContext({ harvest: false })
      return false
    }
  }

  console.warn('[tableau-auth] login timed out')
  await _closeContext({ harvest: false })
  return false
}

/** Cancel in-progress login and close the isolated context. */
export async function cancelTableauLoginBrowser(): Promise<void> {
  await _closeContext({ harvest: false })
}
