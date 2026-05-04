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
import { BASE_CHROMIUM_ARGS, sanitizeChromiumProfile, closeTableauTabs, safeCookieOp } from './browser-utils.ts'
import { getScrapeContext, setLivePageBusy } from './rh-scraper.ts'

const TABLEAU_AUTH_PROFILE_DIR = process.env.TABLEAU_AUTH_PROFILE_DIR ?? '/data/rh-profile-tableau-auth'
const TABLEAU_SESSION_PATH = `${process.env.RH_PROFILE_DIR ?? '/data/rh-profile'}/tableau-session.json`
const TABLEAU_URL = 'https://10ay.online.tableau.com/#/site/redhatanalytics/views/OverallCloudConsumptionDashboard/CloudConsumption'
const LOGIN_POLL_INTERVAL_MS = 2_000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const TABLEAU_COOKIE_AGE_MS = parseInt(process.env.TABLEAU_COOKIE_AGE_MS ?? '') || 8 * 60 * 60 * 1000  // 8 hours — same as Tableau SSO TTL (env-overridable)
// Match ccsp-scraper.ts cookie filter exactly (line 48): includes('tableau.com') || includes('online.tableau')
const TABLEAU_COOKIE_DOMAINS = ['tableau.com', 'online.tableau']
const TABLEAU_USER_EMAIL = process.env.TABLEAU_USER_EMAIL ?? ''

let activeContext: BrowserContext | null = null
let activePage: Page | null = null
let loginInProgress = false
let _activeSsoPopupHandler: ((page: Page) => void) | null = null

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
  if (_activeSsoPopupHandler && ctx) {
    try { ctx.off('page', _activeSsoPopupHandler) } catch { /* ignore */ }
    _activeSsoPopupHandler = null
  }
  // loginInProgress and setLivePageBusy are cleared AFTER tab cleanup (below) —
  // releasing before tabs are closed allows concurrent CCSP scrapes to slip through
  // and hit ctx.cookies() with Tableau tabs still present (BKL-CONN-TABLEAU-CCSP-HANG-01).
  let harvested = false
  if (!ctx || !page) {
    loginInProgress = false
    setLivePageBusy(false)
    return false
  }
  if (opts.harvest) {
    try {
      const state = await safeCookieOp(ctx, '_closeContext harvest', c => c.storageState(), { cookies: [], origins: [] })
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
  // Close any Tableau dashboard tabs opened by SSO that were not activePage.
  // These tabs are left open after waitForTableauLogin() returns, causing ctx.cookies()
  // to hang in restoreTableauSession when CCSP scrape runs immediately after.
  if (ctx) {
    const isSsoTab = (u: string) =>
      u.startsWith('https://10ay.online.tableau.com') && u.includes('/site/') && u.includes('/views/')
    for (const p of ctx.pages()) {
      if (p === page) continue  // activePage is closed below
      try {
        if (isSsoTab(p.url())) {
          await p.close()
          console.log('[tableau-auth] closed SSO Tableau dashboard tab')
        }
      } catch { /* ignore — tab may already be closed */ }
    }
  }
  // Close only our page — never close the shared context
  try { await page.close() } catch { /* already closed */ }
  // Release mutex after all cleanup — any concurrent access before this point
  // would encounter open Tableau tabs and potentially hang on ctx.cookies().
  loginInProgress = false
  setLivePageBusy(false)
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

    // Clear Tableau cookies so SSO always starts fresh — prevents old/seeded cookies
    // from navigating directly to the dashboard and falsely triggering login detection.
    await closeTableauTabs(sharedCtx, 'startTableauLoginBrowser')
    const existingCookies = await safeCookieOp(sharedCtx, 'startTableauLoginBrowser cookies', c => c.cookies(), [])
    const nonTableauCookies = existingCookies.filter(c =>
      !TABLEAU_COOKIE_DOMAINS.some(d => c.domain.includes(d))
    )
    await safeCookieOp(sharedCtx, 'startTableauLoginBrowser clearCookies', c => c.clearCookies(), undefined)
    if (nonTableauCookies.length > 0) await safeCookieOp(sharedCtx, 'startTableauLoginBrowser addCookies', c => c.addCookies(nonTableauCookies), undefined)

    const page = await sharedCtx.newPage()
    activePage = page

    // Track any new page the SSO flow opens (popup, new tab) and redirect it back
    // to TABLEAU_URL so focus stays on the Tableau login flow, not an orphaned tab.
    _activeSsoPopupHandler = (newPage: Page) => {
      if (!loginInProgress) return
      if (newPage === activePage) return
      console.log('[tableau-auth] SSO opened new tab — letting it proceed (auth may need it)')
    }
    sharedCtx.on('page', _activeSsoPopupHandler)

    page.goto(TABLEAU_URL).catch((e: any) => {
      console.warn('[tableau-auth] initial navigation failed:', e?.message ?? e)
    })
    console.log('[tableau-auth] shared context Chromium launched — visible at localhost:6080')
  } catch (e) {
    loginInProgress = false
    setLivePageBusy(false)
    // Unregister popup handler before clearing activeContext
    if (_activeSsoPopupHandler && sharedCtx) {
      try { sharedCtx.off('page', _activeSsoPopupHandler) } catch { /* ignore */ }
      _activeSsoPopupHandler = null
    }
    activeContext = null
    // Close any page we opened into the shared context before losing the reference
    if (activePage) { try { await activePage.close() } catch { /* ignore */ } }
    activePage = null
    throw e
  }
}

/**
 * Wait for the Tableau login to complete in the isolated context.
 * On success: harvests cookies to TABLEAU_SESSION_PATH, closes context, returns true.
 * On timeout/error: closes context without harvesting, returns false.
 *
 * BKL-CONN-TABLEAU-LOGIN-TIMEOUT-LEAK-01: the main body is wrapped in try/finally so
 * _closeContext is guaranteed to run on every exit path (early return, exception, timeout).
 * `succeeded` is flipped to true only on the success branch so harvest=true fires only
 * when we actually detected a valid Tableau session.
 */
export async function waitForTableauLogin(timeoutMs: number = LOGIN_TIMEOUT_MS): Promise<boolean> {
  const page = activePage
  const ctx = activeContext
  if (!page || !ctx) {
    console.warn('[tableau-auth] waitForTableauLogin: no active session')
    return false
  }

  const deadline = Date.now() + timeoutMs
  let emailAutoFilled = false
  let succeeded = false

  try {
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, LOGIN_POLL_INTERVAL_MS))

      // Auto-fill email if env var is set and we're on the email entry page
      if (!emailAutoFilled && TABLEAU_USER_EMAIL && loginInProgress && page) {
        try {
          const url = page.url()
          const onEmailPage = !url.includes('/site/') || !url.includes('/views/')
          if (onEmailPage) {
            const emailInput = await page.$('input[name="email"], input[type="email"], input[placeholder*="mail" i]')
              .catch(() => null)
            if (emailInput) {
              const currentVal = await emailInput.inputValue().catch(() => '')
              if (!currentVal) {
                await emailInput.fill(TABLEAU_USER_EMAIL)
                await new Promise(r => setTimeout(r, 300))
                const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Next")')
                  .catch(() => null)
                if (submitBtn) {
                  await submitBtn.click().catch(() => {})
                  console.log(`[tableau-auth] auto-filled email ${TABLEAU_USER_EMAIL} and clicked submit`)
                  emailAutoFilled = true
                }
              }
            }
          }
        } catch { /* non-fatal — user can type manually */ }
      }

      if (!loginInProgress) return false

      try {
        // Tableau SSO often opens the final dashboard in a new tab while activePage stays
        // on about:blank. Scan all pages in the context for the dashboard URL pattern and
        // use whichever page matches for both the URL stability check and viz content check.
        const isCcspDashboardUrl = (u: string) =>
          u.startsWith('https://10ay.online.tableau.com') &&
          u.includes('/site/') && u.includes('/views/')

        const dashboardPage = ctx.pages().find(p => {
          try { return isCcspDashboardUrl(p.url()) } catch { return false }
        })
        if (!dashboardPage) continue

        let url = ''
        try { url = dashboardPage.url() } catch { continue }

        // Stability check: wait 3s then re-confirm URL hasn't changed (still on dashboard)
        await new Promise(r => setTimeout(r, 3_000))
        let currentUrl = url
        try { currentUrl = dashboardPage.url() } catch { continue }
        if (currentUrl !== url) continue

        // URL match + 3s stability is sufficient — viz selector checks were false-negative
        // prone across Tableau versions (BKL-CONN-TABLEAU-SSO-TAB-LOOP-01)
        console.log('[tableau-auth] login detected — harvesting cookies')
        succeeded = true  // flip before _closeContext so finally uses harvest=true
        const harvested = await _closeContext({ harvest: true })
        if (!harvested) {
          succeeded = false
          return false
        }
        return true
      } catch (e: any) {
        const msg = e?.message ?? ''
        // Only close session on true destruction — not transient navigation errors
        if (msg.includes('closed') || msg.includes('destroyed') || msg.includes('crashed')) {
          return false  // finally will call _closeContext({ harvest: false })
        }
        // Transient navigation error — log and continue polling
        console.warn('[tableau-auth] poll cycle error (transient — continuing):', msg)
      }
    }

    console.warn('[tableau-auth] wait-for-login: poll cycle timed out — closing context to prevent tab leak')
    return false
  } finally {
    // Guarantee cleanup on every exit path: success (succeeded=true, already closed above),
    // timeout, thrown exception, or early return. _closeContext is idempotent when
    // activeContext is null (lines 105-109: !ctx branch clears flags and returns false).
    await _closeContext({ harvest: succeeded })
  }
}

/** Cancel in-progress login and close the isolated context. */
export async function cancelTableauLoginBrowser(): Promise<void> {
  await _closeContext({ harvest: false })
}
