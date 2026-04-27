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
 * Used by session-status probe instead of opening a browser tab.
 */
export async function checkTableauSessionFromCookies(): Promise<boolean> {
  try {
    if (!existsSync(TABLEAU_SESSION_PATH)) return false
    const saved = JSON.parse(readFileSync(TABLEAU_SESSION_PATH, 'utf-8'))
    if (!saved.cookies?.length || !saved.savedAt) return false
    const age = Date.now() - Date.parse(saved.savedAt)
    return age < TABLEAU_COOKIE_AGE_MS
  } catch {
    return false
  }
}

async function _closeContext(opts: { harvest: boolean }): Promise<boolean> {
  const ctx = activeContext
  activeContext = null
  activePage = null
  loginInProgress = false
  let harvested = false
  if (!ctx) return false
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
  try {
    for (const p of ctx.pages()) {
      await p.close().catch(() => {})
    }
    await ctx.close()
  } catch { /* already closed */ }
  return harvested
}

/**
 * Launch an isolated headed Chromium to the Tableau login page.
 * The headed window appears in VNC at localhost:6080.
 * Call waitForTableauLogin() to poll for success.
 */
export async function startTableauLoginBrowser(): Promise<void> {
  if (loginInProgress) throw new Error('Tableau login already in progress')

  // Race-free: set flag BEFORE any await
  loginInProgress = true

  // Close any stale isolated context from a prior aborted run
  if (activeContext) {
    await _closeContext({ harvest: false })
    loginInProgress = true  // re-set after _closeContext clears it
  }

  try {
    mkdirSync(TABLEAU_AUTH_PROFILE_DIR, { recursive: true })
    try {
      unlinkSync(join(TABLEAU_AUTH_PROFILE_DIR, 'SingletonLock'))
      console.warn('[tableau-auth] stale lock file removed')
    } catch { /* fine — file may not exist */ }
    sanitizeChromiumProfile(TABLEAU_AUTH_PROFILE_DIR)

    const ctx = await chromium.launchPersistentContext(TABLEAU_AUTH_PROFILE_DIR, {
      headless: false,
      args: [...BASE_CHROMIUM_ARGS],
    })

    activeContext = ctx
    const page = await ctx.newPage()
    activePage = page

    page.goto(TABLEAU_URL).catch((e: any) => {
      console.warn('[tableau-auth] initial navigation failed:', e?.message ?? e)
    })
    console.log('[tableau-auth] isolated Chromium launched — visible at localhost:6080')
  } catch (e) {
    loginInProgress = false
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
      const onTableau = url.startsWith('https://10ay.online.tableau.com')
      if (!onTableau) continue

      // Stability check: wait 500ms then re-confirm
      await new Promise(r => setTimeout(r, 500))
      if (page.url() !== url) continue

      const noLoginForm = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('input[type="password"], input#username, [data-testid="login"]'))
        return !els.some(el => {
          const s = window.getComputedStyle(el)
          return s.display !== 'none' && s.visibility !== 'hidden' && (el as HTMLElement).offsetParent !== null
        })
      }).catch(() => false)

      if (noLoginForm) {
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
