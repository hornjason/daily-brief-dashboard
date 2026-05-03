/**
 * src/rh-auth.ts
 * Red Hat Portal browser session state machine.
 * Uses a persistent Chromium profile (launchPersistentContext) so cookies
 * survive browser restarts the same way a regular Chrome profile does.
 */

import { chromium } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { closeScrapeContext, adoptScrapeContext } from './rh-scraper.ts'
// adoptSfContext/adoptSupportableContext/adoptCcspContext delegated to ScraperRegistry.adoptAll()
import { closeSupportableContext } from './supportable-scraper.ts'
import { closeCcspContext } from './ccsp-scraper.ts'
import { ScraperRegistry } from './scraper-registry.ts'
import { resetAllCircuitBreakers } from './scraper-manager.ts'
import { BASE_CHROMIUM_ARGS, sanitizeChromiumProfile } from './browser-utils.ts'
import { recordSessionEstablished } from './settings-api.ts'

const RH_PORTAL_URL = 'https://access.redhat.com/support/cases/#/case/list'
const LOGIN_POLL_INTERVAL_MS = 2_000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
// Fallback TTL used only when no KEYCLOAK_SESSION cookie expiry can be read.
const RH_SESSION_TTL_FALLBACK_MS = 12 * 60 * 60 * 1000 // 12 hours

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
  sessionExpiresAt: string | null  // ISO timestamp from Keycloak cookie, null if unreadable
  lastScraped: string | null
  caseCount: number
  loginInProgress: boolean
  loginTimedOut: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function isPortalUrl(url: string): boolean {
  // Accept any authenticated RH page — SSO redirects may land on root or management pages
  // before the support cases path is fully loaded. Exclude the SSO login page itself.
  return url.includes('access.redhat.com') && !url.includes('sso.redhat.com') && !url.includes('/auth/realms')
}

async function cleanupBrowser(): Promise<void> {
  // BKL-CONN: cleanupBrowser ONLY closes the browser context. Module-level flags
  // (loginInProgress, loginTimedOut) are caller-owned. Each call site must set
  // the flags it needs BEFORE invoking cleanupBrowser. Resetting flags here
  // re-opened a race window during the awaited ctx.close() where a concurrent
  // start request could pass the loginInProgress guard.
  const ctx = activeContext
  activeContext = null
  activePage = null
  if (ctx) {
    try {
      // Close all open pages before closing the context to prevent orphaned blank tabs in VNC
      for (const p of ctx.pages()) {
        try { await p.close() } catch { /* already closed */ }
      }
      await ctx.close()
    } catch { /* already closed */ }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read the real KEYCLOAK_SESSION cookie expiry from Playwright's session-state.json.
 * Returns the earliest expiry timestamp (ms) across sso.redhat.com and auth.redhat.com,
 * or null if the file is missing or contains no Keycloak cookies with explicit expiry.
 * Falls back to the loggedInAt marker + RH_SESSION_TTL_FALLBACK_MS when null.
 */
function readKeycloakExpiry(profileDir: string): number | null {
  try {
    const statePath = resolve(profileDir, 'session-state.json')
    if (!existsSync(statePath)) return null
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as { cookies?: Array<{ name: string; domain: string; expires: number }> }
    const cookies = state.cookies ?? []
    const expiries = cookies
      .filter(c => c.name === 'KEYCLOAK_SESSION' && c.expires > 0)
      .map(c => c.expires * 1000) // Playwright stores seconds, convert to ms
    return expiries.length ? Math.min(...expiries) : null
  } catch {
    return null
  }
}

/**
 * Return true if the RH Portal session has expired.
 * Prefers the real KEYCLOAK_SESSION cookie expiry from session-state.json.
 * Falls back to loggedInAt marker + 12h TTL if cookie data is unavailable.
 */
function isSessionExpired(sessionPath: string, profileDir: string): boolean {
  try {
    const keycloakExpiry = readKeycloakExpiry(profileDir)
    if (keycloakExpiry !== null) return Date.now() > keycloakExpiry

    // Fallback: use loggedInAt marker + fixed TTL
    const raw = readFileSync(sessionPath, 'utf-8')
    const parsed = JSON.parse(raw) as { loggedInAt?: string }
    if (!parsed.loggedInAt) return false
    const ts = Date.parse(parsed.loggedInAt)
    return !Number.isNaN(ts) && Date.now() - ts > RH_SESSION_TTL_FALLBACK_MS
  } catch {
    return false
  }
}

/**
 * BKL-UX113: Read the open-case count from the cases.json cache so the tile
 * (fed by getRhStatus) stays in sync with the popout (which reads cases.json
 * directly). Falls back to lastCaseCount when the path is not supplied or the
 * cache cannot be read. Filter matches fetchCases() in src/redhat.ts — excludes
 * closed/resolved so both surfaces count the same "open" set.
 */
function readCaseCountFromCache(casesPath: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(casesPath, 'utf-8')) as { cases?: Array<{ status?: string }> }
    const cases = Array.isArray(raw.cases) ? raw.cases : []
    return cases.filter((ca) => {
      const s = (ca.status ?? '').toLowerCase()
      return !s.includes('closed') && !s.includes('resolved')
    }).length
  } catch {
    return null
  }
}

export function getRhStatus(sessionPath: string, casesPath?: string, profileDir?: string): RhStatus {
  const hasSession = existsSync(sessionPath)
  const resolvedProfileDir = profileDir ?? dirname(sessionPath)
  // Session is expired if a scrape failed (rhSessionExpired) OR the real
  // KEYCLOAK_SESSION cookie has expired (prefers cookie expiry over fixed TTL).
  const sessionExpired = rhSessionExpired || (hasSession && isSessionExpired(sessionPath, resolvedProfileDir))
  // Surface raw Keycloak cookie expiry as ISO string for health-check consumers.
  const expiryMs = readKeycloakExpiry(resolvedProfileDir)
  const sessionExpiresAt = expiryMs ? new Date(expiryMs).toISOString() : null
  // BKL-UX113: Prefer the disk cache count so the RH tile never diverges from
  // the popout. lastCaseCount remains the fallback — module state resets to 0
  // on server restart before any scrape has run, but cases.json persists.
  const diskCount = casesPath ? readCaseCountFromCache(casesPath) : null
  return {
    hasSession,
    sessionExpired,
    sessionExpiresAt,
    lastScraped,
    caseCount: diskCount ?? lastCaseCount,
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

  // BKL-UX69: Set loginInProgress BEFORE releasing the profile lock so the
  // rh-scraper heartbeat observes it and skips opening a new context during
  // the SingletonLock window. The if-guard at the top of startLoginBrowser
  // already handles re-entry, so moving this up is safe.
  loginInProgress = true
  loginTimedOut = false

  // Release profile dir lock so the headed login browser can use it
  await closeScrapeContext()
  // Null out CCSP/Supportable context refs so "Run Now" during auth gets a clear error
  // instead of crashing with "Target page, context or browser has been closed"
  closeSupportableContext()
  closeCcspContext()

  // Remove stale SingletonLock before launching — prevents "profile locked by another process"
  // error if a previous Chromium was killed uncleanly or the scrape context was force-closed.
  try { unlinkSync(join(profileDir, 'SingletonLock')) } catch { /* file doesn't exist — fine */ }

  // Sanitize Chromium profile preferences to suppress the "Restore pages?" bubble
  sanitizeChromiumProfile(profileDir)

  // launchPersistentContext creates profileDir if it doesn't exist
  let context: BrowserContext
  let page: Page
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: ['--ignore-certificate-errors', ...BASE_CHROMIUM_ARGS],
    })
    page = await context.newPage()
  } catch (e) {
    loginInProgress = false
    throw e
  }

  activeContext = context
  activePage = page

  // Navigate to portal (non-blocking — login happens async).
  // BKL-UX68: log navigation failures instead of silently swallowing them.
  // The background polling loop still handles timeout via loginTimedOut, but
  // at least the underlying error (profile lock, network, timeout) now surfaces in logs.
  page.goto(RH_PORTAL_URL).catch((e: any) => {
    console.warn('[rh-auth] navigation to portal failed:', e?.message ?? e)
  })

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
          // Debounce: redirect chains may momentarily touch access.redhat.com before SSO.
          // Re-check after 500ms to confirm URL is stable.
          await new Promise(r => setTimeout(r, 500))
          const stableUrl = page.url()
          if (!isPortalUrl(stableUrl)) continue
          // URL confirmed stable — login complete

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

          // BKL-ARCH-02: single registry call replaces per-scraper adopt block.
          // SF, Supportable (retired — skipped), and CCSP share the same SSO session.
          ScraperRegistry.adoptAll(ctx, profileDir, livePage)

          // BKL-UX94: Open a blank tab so VNC clears after login. Awaited so VNC reliably shows blank.
          try {
            const blankPage = await ctx.newPage()
            await blankPage.bringToFront()
            await blankPage.goto('about:blank').catch((e: any) => {
              console.warn('[rh-auth] about:blank navigation failed:', e?.message ?? e)
            })
          } catch (e: any) {
            console.warn('[rh-auth] blank tab open failed:', e?.message ?? e)
          }

          recordSessionEstablished('rh-portal')
          recordSessionEstablished('salesforce')

          // Cold-start recovery: reset all circuit breakers that accumulated
          // failures while auth was stale (e.g. overnight laptop sleep)
          resetAllCircuitBreakers()
          console.log('[rh-auth] auth restored — circuit breakers reset, all scrapers re-adopted')

          onComplete?.()

          // Post-auth flush: enqueue all 4 scrapers immediately instead of waiting
          // up to 15 minutes for the next heartbeat tick.
          // Lazy import to avoid circular dependency (background-scheduler imports rh-auth).
          import('./background-scheduler.ts').then(({ flushScrapersAfterAuth }) => {
            flushScrapersAfterAuth().catch((e: any) => {
              console.warn('[rh-auth] post-auth flush error:', e?.message ?? e)
            })
          }).catch((e: any) => {
            console.warn('[rh-auth] post-auth flush import error:', e?.message ?? e)
          })
          return
        }
      } catch {
        // Page closed by user or navigation error
        console.log('[rh-auth] Browser closed or navigation error — cleaning up')
        // Caller-owned flags: cleanupBrowser no longer resets these.
        loginInProgress = false
        await cleanupBrowser()
        return
      }
    }

    // Timed out — caller-owned flags: cleanupBrowser no longer resets these.
    // Keep loginTimedOut = true so UI can surface timeout state; clear in-progress.
    console.log('[rh-auth] Login timed out after 5 minutes')
    loginTimedOut = true
    loginInProgress = false
    await cleanupBrowser()
  })()
}

/**
 * Cancel an in-progress login session.
 */
export async function cancelLoginBrowser(): Promise<void> {
  // Caller-owned flags: cleanupBrowser no longer resets these.
  loginInProgress = false
  loginTimedOut = false
  await cleanupBrowser()
}

/**
 * BKL-UX60: Clear sessionExpired at the start of a scrape run so the frontend
 * doesn't show "Not connected" while a scrape is actively running.
 */
export function recordScrapeStart(): void {
  rhSessionExpired = false
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

// ── BKL-ARCH-02: register the rh-cases descriptor ────────────────────────────
// Co-located here (not rh-scraper.ts) because lastScraped and rhSessionExpired
// are owned by this module; rh-scraper does not import rh-auth (one-way dep).
ScraperRegistry.register({
  name: 'rh-cases',
  adopt: (ctx, profileDir, livePage) => {
    if (!livePage) {
      console.warn('[rh-auth] rh-cases adopt called without livePage — skipping')
      return
    }
    adoptScrapeContext(ctx, profileDir, livePage)
  },
  getInMemoryLastSync: () => lastScraped,
  getInMemoryLastError: () => (rhSessionExpired ? 'rh session expired' : null),
  getInMemoryIsRunning: () => false,
})
