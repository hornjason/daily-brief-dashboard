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
import { writeJsonAtomicAsync } from './lib/atomic-write.ts'
import { resolve, dirname, join } from 'node:path'
import type { SupportCase } from './types.ts'
import { BASE_CHROMIUM_ARGS, safeCookieOp } from './browser-utils.ts'
import { notify, sanitizeErr } from './utils.ts'

// ── BKL-M50c: Auto-recovery state ───────────────────────────────────────────
let _recoveryInProgress = false
let _recoveryAttempts = 0
const MAX_RECOVERY_ATTEMPTS = 5
const RECOVERY_BACKOFF_BASE_MS = 1_000  // 1s, 2s, 4s, 8s, 16s

/** Flag set when auto-recovery fails after max attempts — dashboard can surface degraded state */
export let browserDegraded = false
export let browserDegradedReason: string | null = null

// ── BKL-M50c context recycling state ─────────────────────────────────────────
let _scrapesSinceRecycle = 0
const RECYCLE_AFTER_SCRAPES = 50
const RECYCLE_HEAP_THRESHOLD_BYTES = 1.5 * 1024 * 1024 * 1024  // 1.5 GB

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
  /** Optional callback checked between accounts — return true to abort early */
  shouldCancel?: () => boolean
  /** BKL-UX55: reverse map accountNumber → customerName for stamping cases at scrape time */
  accountToCustomer?: Map<string, string>
}

// ── Long-lived context + page ─────────────────────────────────────────────────

let _context: BrowserContext | null = null
let _livePage: Page | null = null   // the authenticated page — reused to keep sessionStorage alive
let _profileDir: string | null = null
let _keepAliveTimer: ReturnType<typeof setInterval> | null = null
let _onSessionExpired: (() => void) | null = null
// BKL-M50c: fires after auto-recovery so sister scrapers (Supportable/CCSP/SF) can re-adopt the new context
let _onContextRecovered: ((ctx: BrowserContext, profileDir: string) => void) | null = null
let _cachedToken: string | null = null   // captured Bearer JWT from intercepted page requests
let _livePageBusy = false  // set true while external flows (e.g. Tableau login) use the live page
let _livePageBusyAt = 0    // timestamp when busy flag was set — auto-clears after 3 minutes
let _intentionalClose = false  // set before deliberate closeScrapeContext() calls to suppress auto-recovery
let _discoverPage: Page | null = null  // reused across discoverAccountNumberByName() calls — avoids per-customer navigation

/** Register a callback to invoke when the keep-alive detects session expiry. */
export function setSessionExpiredCallback(cb: () => void): void {
  _onSessionExpired = cb
}

/** Register a callback invoked after auto-recovery restores the browser context.
 *  Used by rh-auth.ts to re-adopt sister scrapers that hold stale context references. */
export function setContextRecoveryCallback(cb: (ctx: BrowserContext, profileDir: string) => void): void {
  _onContextRecovered = cb
}

/**
 * Called by sf-auth.ts after SF auth ends (timeout/cancel/error) to restore
 * the RH scraper context without reopening the VNC login flow.
 */
export async function reopenScrapeContextFromAuth(profileDir: string): Promise<void> {
  _intentionalClose = false
  await _autoRecover(profileDir)
}

/**
 * Mark the live page as busy (used by another flow like Tableau login).
 * While busy, the keep-alive will skip full-page navigation to avoid
 * stealing the page from the user.
 */
export function setLivePageBusy(busy: boolean): void { _livePageBusy = busy }
export function isLivePageBusy(): boolean { return _livePageBusy }

/**
 * BKL-CONN-TABLEAU-CTX-01: lightweight liveness probe for the scraper anchor page.
 * Returns true iff _livePage exists, isn't closed, and responds to a trivial
 * evaluate within 2s. Callers (status routes, health checks) can use this to
 * detect a corrupted renderer without driving any real work through the page.
 */
export async function isLivePageHealthy(): Promise<boolean> {
  const page = _livePage
  if (!page || page.isClosed()) return false
  let tid: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      page.evaluate(() => 1),
      new Promise((_, reject) => { tid = setTimeout(() => reject(new Error('timeout')), 2000) }),
    ])
    return true
  } catch {
    return false
  } finally {
    clearTimeout(tid)
  }
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
  // BKL-UX69: don't open a new context while the RH Portal login browser is
  // in progress — prevents SingletonLock race with startLoginBrowser().
  // Lazy import to avoid a static circular dependency (rh-auth imports from this file).
  try {
    const { getRhStatus } = await import('./rh-auth.ts')
    if (getRhStatus('').loginInProgress) {
      console.log('[rh-scraper] skipping context open — login in progress')
      return
    }
  } catch { /* rh-auth unavailable — proceed */ }
  _profileDir = profileDir
  await clearProfileLocks(profileDir)
  console.log('[rh-scraper] opening persistent context…')
  _context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    acceptDownloads: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--ignore-certificate-errors',
      ...BASE_CHROMIUM_ARGS,
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  })
  // Restore session cookies persisted from a previous run
  await restoreSessionCookies()

  // BKL-M50c: Attach browser disconnected handler for auto-recovery
  _attachDisconnectedHandler(_context, profileDir)

  // Reset degraded state on successful context init
  browserDegraded = false
  browserDegradedReason = null
  _recoveryAttempts = 0
  _scrapesSinceRecycle = 0

  _keepAliveTimer = setInterval(
    () => keepAlive().catch(e => console.warn('[rh-scraper] keep-alive error:', e)),
    KEEP_ALIVE_INTERVAL_MS,
  )
}

// ── BKL-M50c: Auto-recovery on browser disconnect ──────────────────────────

function _attachDisconnectedHandler(ctx: BrowserContext, profileDir: string): void {
  const browser = ctx.browser()
  if (browser) {
    // BKL-CONN-SF-ADOPT-01: capture ctx in closure and identity-check at fire
    // time. Without this, a stale disconnect from an old ctx (recycle path,
    // SF auth flow, recovery sequences) would invoke _autoRecover and wipe
    // a newly-adopted _context. Now stale handlers no-op when a different
    // ctx has taken over.
    const attachedCtx = ctx
    browser.on('disconnected', () => {
      if (_context !== attachedCtx) {
        console.log('[rh-scraper] browser disconnected — stale handler (different ctx now active), skipping')
        return
      }
      if (_intentionalClose) {
        console.log('[rh-scraper] browser disconnected — intentional close, skipping auto-recovery')
        _intentionalClose = false
        return
      }
      console.warn('[rh-scraper] browser disconnected — initiating auto-recovery')
      _autoRecover(profileDir).catch(e =>
        console.error('[rh-scraper] auto-recovery failed:', e?.message ?? e)
      )
    })
  }
}

function _attachPageCrashHandler(page: Page): void {
  page.on('crash', () => {
    console.error('[rh-scraper] page crashed (renderer process killed) — will recover on next scrape')
  })
}

async function _autoRecover(profileDir: string): Promise<void> {
  if (_recoveryInProgress) {
    console.log('[rh-scraper] recovery already in progress — skipping')
    return
  }
  _recoveryInProgress = true

  try {
    // Save storage state before closing if context is still accessible
    await persistSessionState().catch(() => {})

    // Clear stale references
    if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null }
    _context = null
    _livePage = null

    while (_recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
      const backoffMs = RECOVERY_BACKOFF_BASE_MS * Math.pow(2, _recoveryAttempts)
      _recoveryAttempts++
      console.log(`[rh-scraper] recovery attempt ${_recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS} (backoff: ${backoffMs}ms)`)

      await new Promise(r => setTimeout(r, backoffMs))

      try {
        await clearProfileLocks(profileDir)
        const ctx = await chromium.launchPersistentContext(profileDir, {
          headless: false,
          args: [
            '--disable-blink-features=AutomationControlled',
            '--ignore-certificate-errors',
            ...BASE_CHROMIUM_ARGS,
          ],
          ignoreDefaultArgs: ['--enable-automation'],
        })

        _context = ctx
        _profileDir = profileDir

        // Restore cookies from persisted state
        await restoreSessionCookies()

        // Re-attach disconnect handler
        _attachDisconnectedHandler(ctx, profileDir)

        // Restart keep-alive timer
        _keepAliveTimer = setInterval(
          () => keepAlive().catch(e => console.warn('[rh-scraper] keep-alive error:', e)),
          KEEP_ALIVE_INTERVAL_MS,
        )

        browserDegraded = false
        browserDegradedReason = null
        _recoveryAttempts = 0
        console.log('[rh-scraper] auto-recovery succeeded — browser context restored')

        // BKL-M50c gap 1: verify session is still valid after relaunch
        await keepAlive().catch(e => console.warn('[rh-scraper] post-recovery session check failed:', e?.message))

        // BKL-M50c gap 2: re-adopt sister scrapers that hold dead context references
        if (_onContextRecovered && _context && _profileDir) {
          try { _onContextRecovered(_context, _profileDir) }
          catch (e: any) { console.warn('[rh-scraper] context recovery callback error:', e?.message) }
          console.log('[rh-scraper] auto-recovery: sister scrapers re-adopted')
        }

        return
      } catch (e: any) {
        console.warn(`[rh-scraper] recovery attempt ${_recoveryAttempts} failed:`, e?.message ?? e)
      }
    }

    // All attempts exhausted
    browserDegraded = true
    browserDegradedReason = `Auto-recovery failed after ${MAX_RECOVERY_ATTEMPTS} attempts — reconnect manually via dashboard`
    console.error(`[rh-scraper] ${browserDegradedReason}`)
    // BKL-M50c: notify user via ntfy only after all attempts fail
    notify(
      'Browser context degraded',
      `Chromium disconnected and auto-recovery failed after ${MAX_RECOVERY_ATTEMPTS} attempts. Open the dashboard and reconnect manually.`,
      'urgent',
    ).catch(() => {})
  } finally {
    _recoveryInProgress = false
  }
}

/**
 * Pre-flight guard: confirms the browser context is alive and responsive.
 * Callers get a fast 503 instead of a cryptic mid-scrape crash.
 */
export async function ensureBrowserHealthy(): Promise<void> {
  if (!_context) throw new Error('Browser not initialized — connect via the dashboard first')
  if (browserDegraded) throw new Error(browserDegradedReason ?? 'Browser is in degraded state')
  try {
    await _context.pages()[0]?.evaluate('1')
  } catch {
    // Page eval failed — browser process is likely dead. Attempt recovery.
    if (_profileDir) {
      await _autoRecover(_profileDir)
      if (browserDegraded) throw new Error(browserDegradedReason ?? 'Browser recovery failed')
    } else {
      throw new Error('Browser not responsive and no profile dir available for recovery')
    }
  }
}

/**
 * Adopt an already-authenticated BrowserContext + Page from the login flow.
 * The live page is reused for scraping to preserve its sessionStorage (PKCE
 * state, SSO tokens). Closing the page before scraping loses that state and
 * causes transparent SSO renewal to fail on any newly-created page.
 */
export function adoptScrapeContext(context: BrowserContext, profileDir: string, livePage: Page): void {
  console.log('[rh-scraper] adoptScrapeContext called — context valid:', !!context, 'livePage closed:', livePage.isClosed())
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

  // BKL-M50c: Attach crash/disconnect handlers
  _attachPageCrashHandler(livePage)
  _attachDisconnectedHandler(context, profileDir)
  browserDegraded = false
  browserDegradedReason = null
  _recoveryAttempts = 0
  _scrapesSinceRecycle = 0

  // BKL-ARCH-SCRAPER-07: fire recovery callback so CCSP/SF re-adopt the fresh context
  // immediately on login handoff, not lazily on their next scrape cycle.
  if (_onContextRecovered) {
    try { _onContextRecovered(context, profileDir) } catch { /* ignore — adoption is best-effort */ }
  }

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

/** Close and discard the reused discover page (call after discovery loop finishes). */
export async function closeDiscoverPage(): Promise<void> {
  if (_discoverPage && !_discoverPage.isClosed()) {
    await _discoverPage.close().catch(() => {})
  }
  _discoverPage = null
}

export async function closeScrapeContext(): Promise<void> {
  if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null }
  const ctx = _context
  _context = null
  _livePage = null
  _discoverPage = null
  _profileDir = null
  _cachedToken = null
  if (ctx) {
    _intentionalClose = true  // suppress auto-recovery on deliberate close
    try { await ctx.close() } catch { _intentionalClose = false /* already closed */ }
  }
}

// ── Session state persistence ─────────────────────────────────────────────────

async function persistSessionState(): Promise<void> {
  if (!_context || !_profileDir) return
  try {
    const state = await safeCookieOp(_context, 'rh-scraper persistSessionState storageState', c => c.storageState(), { cookies: [], origins: [] })
    await writeFile(resolve(_profileDir, SESSION_STATE_FILE), JSON.stringify(state), { mode: 0o600 })
  } catch (e: any) {
    console.warn(`[rh-scraper] persistSessionState failed: ${sanitizeErr(e)}`)
  }
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

  // Skip keep-alive entirely while another flow (e.g. Tableau login) is using the
  // live page. Navigating or evaluating JS on the live page would steal it away
  // from the user mid-interaction. The keep-alive will fire again on its next tick.
  if (_livePageBusy) {
    console.log('[rh-scraper] keep-alive: skipped — live page busy (external login flow)')
    return
  }

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

        const alive = await _livePage.evaluate<boolean, string | null>(async (bearerToken: string | null) => {
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
  // BKL-INGEST-04: L4 live-scrape guard — blocks live scrape in test environment.
  // Must be the first check, before any browser/network work.
  if (process.env.DISALLOW_LIVE_SCRAPE === '1') {
    throw new Error('[rh-scraper] DISALLOW_LIVE_SCRAPE=1 — live scrape blocked in test environment')
  }

  const { accountNumbers, profileDir, cachePath, shouldCancel, accountToCustomer } = options

  // Ensure long-lived context is open
  await initScrapeContext(profileDir)
  if (!_context) throw new Error('[rh-scraper] failed to open browser context')
  const context = _context

  // Always use a fresh page for scraping — _livePage is reserved for auth flows.
  // Using _livePage caused a race: auth cleanup navigates it to about:blank while
  // the batch query tries to load, interrupting the navigation.
  // Fresh pages inherit cookies from the shared BrowserContext (SSO session),
  // so PKCE sessionStorage is not needed for cases API queries.
  const page = await context.newPage()
  const usingLivePage = false

  const allCases: SupportCase[] = []
  const seenCaseNumbers = new Set<string>()  // dedup guard — portal paginates through same rows

  // ── Batch query helpers ───────────────────────────────────────────────────
  const BATCH_CHUNK_SIZE = 25   // accounts per OR-query (keeps URL under ~4 KB)
  const BATCH_PAGE_SIZE = 500   // max rows per portal page

  function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size))
    }
    return chunks
  }

  /** Wait for Angular table to render real case number links. */
  async function waitForTable(p: Page): Promise<void> {
    await p.waitForSelector('table tbody tr', { timeout: 15_000 }).catch(() => {})
    await p.waitForFunction(
      () => {
        const link = document.querySelector('a[href*="/case/"]')
        return link !== null && /^\d{7,10}$/.test(link.textContent?.trim() ?? '')
      },
      { timeout: 12_000 },
    ).catch(() => {
      // Timed out — genuinely empty or very slow. Fall through.
    })
  }

  /**
   * Extract all cases from the current portal page DOM.
   * When chunkAccountNums is provided, the account number is resolved from the
   * table's Account Number column. When acctNumOverride is provided (single-
   * account fallback), that value is stamped on every row.
   */
  async function extractCasesFromPage(
    p: Page,
    chunkAccountNums: string[] | null,
    acctNumOverride: string | null,
  ): Promise<Array<{
    caseNumber: string
    summary: string
    status: string
    severity: string
    accountNumber: string
    product: string
    columnSource: 'header' | 'fallback'
  }>> {
    return p.evaluate(
      (args: { chunkAccountNums: string[] | null; acctNumOverride: string | null }) => {
        const results: Array<{
          caseNumber: string
          summary: string
          status: string
          severity: string
          accountNumber: string
          product: string
          columnSource: 'header' | 'fallback'
        }> = []

        // -- Resolve column indices from header row --------------------------
        const HEADER_MAP: Record<string, string[]> = {
          summary:       ['Summary', 'Case Summary', 'Subject'],
          status:        ['Status', 'Case Status'],
          severity:      ['Severity'],
          product:       ['Product', 'Product Name'],
          accountNumber: ['Account', 'Account Number', 'Account #'],
        }

        function buildIndexMap(): Map<string, number> | null {
          const headerRow = document.querySelector('table thead tr, table tr:first-child')
          if (!headerRow) return null
          const ths = Array.from(headerRow.querySelectorAll('th, td'))
          if (ths.length < 4) return null

          const indexMap = new Map<string, number>()
          for (const [key, candidates] of Object.entries(HEADER_MAP)) {
            for (let i = 0; i < ths.length; i++) {
              const text = ths[i].textContent?.trim() ?? ''
              if (candidates.some(c => text.toLowerCase().includes(c.toLowerCase()))) {
                indexMap.set(key, i)
                break
              }
            }
          }
          return indexMap.size >= 2 ? indexMap : null
        }

        const headerIndexMap = buildIndexMap()

        // Hardcoded fallback indices (verified portal layout, 14 columns):
        // [0]=checkbox [1]=case# [2]=summary [3]=opened-by [4]=modified [5]=severity [6]=status [7]=account [8]=product
        const FALLBACK: Record<string, number> = { summary: 2, status: 6, severity: 5, accountNumber: 7, product: 8 }

        const columnSource: 'header' | 'fallback' = headerIndexMap ? 'header' : 'fallback'
        // Diagnostic: log what columns were found
        const headerRow = document.querySelector('table thead tr, table tr:first-child')
        const headerTexts = headerRow ? Array.from(headerRow.querySelectorAll('th, td')).map(h => h.textContent?.trim()) : []
        console.log(`[rh-scraper] table headers (${columnSource}): ${headerTexts.join(' | ')}`)
        if (headerIndexMap) {
          const entries = Array.from(headerIndexMap.entries()).map(([k,v]) => `${k}=${v}`).join(', ')
          console.log(`[rh-scraper] column map: ${entries}`)
        }
        const col = (key: string): number =>
          headerIndexMap?.get(key) ?? FALLBACK[key] ?? -1

        // Build a Set of valid account numbers for batch queries so we can
        // validate the extracted account number against the chunk.
        const validAccounts = args.chunkAccountNums
          ? new Set(args.chunkAccountNums)
          : null

        // -- Extract rows ---------------------------------------------------
        const rows = document.querySelectorAll('table tbody tr')
        for (const row of rows) {
          const caseLink = row.querySelector('a[href*="/case/"]') as HTMLAnchorElement | null
          if (!caseLink) continue

          const caseNumber = caseLink.textContent?.trim() ?? ''
          if (!/^\d{7,10}$/.test(caseNumber)) continue

          const cells = Array.from(row.querySelectorAll('td')).map(
            (td) => td.textContent?.trim() ?? ''
          )

          const status = cells[col('status')] ?? ''
          if (status.toLowerCase() === 'closed') continue

          // Resolve account number
          let accountNumber = args.acctNumOverride ?? ''
          if (!accountNumber) {
            // Primary: scan ALL cells for a value matching one of the chunk's known account numbers.
            // The Portal has hidden columns — account number is in the cells but not in visible headers.
            if (validAccounts) {
              for (const cell of cells) {
                const cleaned = cell.replace(/\D/g, '')
                if (cleaned && validAccounts.has(cleaned)) {
                  accountNumber = cleaned
                  break
                }
              }
            }
            // Fallback: header-detected Account column
            if (!accountNumber && headerIndexMap?.has('accountNumber')) {
              const acctCol = headerIndexMap.get('accountNumber')!
              const rawAcct = (cells[acctCol] ?? '').replace(/\D/g, '')
              if (/^\d{5,12}$/.test(rawAcct)) {
                accountNumber = rawAcct
              }
            }
          }

          results.push({
            caseNumber,
            summary:  cells[col('summary')]   ?? '',
            status,
            severity: cells[col('severity')]  ?? '',
            product:  cells[col('product')]   ?? '',
            accountNumber,
            columnSource,
          })
        }

        // Attach diagnostic info for server-side logging
        if (results.length > 0) {
          const firstRow = document.querySelector('table tbody tr')
          const firstLink = firstRow?.querySelector('a[href*="/case/"]') as HTMLAnchorElement | null
          ;(results as any)._diag = {
            columnSource,
            headers: headerTexts,
            indexMap: headerIndexMap ? Object.fromEntries(headerIndexMap) : null,
            firstRowCells: Array.from(firstRow?.querySelectorAll('td') ?? []).map(td => td.textContent?.trim()?.slice(0, 30)),
            firstCaseHref: firstLink?.href ?? 'NO LINK',
            firstCaseHrefAttr: firstLink?.getAttribute('href') ?? 'NO ATTR',
          }
        }
        return results
      },
      { chunkAccountNums, acctNumOverride },
    )
  }

  /** Push extracted cases into allCases with severity normalization. */
  function pushCases(
    cases: Array<{
      caseNumber: string; summary: string; status: string
      severity: string; accountNumber: string; product: string
    }>,
  ): void {
    // Log diagnostic from first chunk
    const diag = (cases as any)?._diag
    if (diag) {
      console.log(`[rh-scraper] column source: ${diag.columnSource}`)
      console.log(`[rh-scraper] headers: ${diag.headers?.join(' | ')}`)
      console.log(`[rh-scraper] index map: ${JSON.stringify(diag.indexMap)}`)
      console.log(`[rh-scraper] first row cells: ${diag.firstRowCells?.join(' | ')}`)
      console.log(`[rh-scraper] first case href: ${diag.firstCaseHref}`)
      console.log(`[rh-scraper] first case href attr: ${diag.firstCaseHrefAttr}`)
    }
    for (const c of cases) {
      if (seenCaseNumbers.has(c.caseNumber)) continue  // skip duplicate (pagination overlap)
      seenCaseNumbers.add(c.caseNumber)
      const severityNum = String(c.severity).match(/^(\d)/)?.[1] ?? c.severity
      const customerName = accountToCustomer?.get(c.accountNumber) ?? undefined
      allCases.push({
        caseNumber: c.caseNumber,
        summary: c.summary,
        status: c.status,
        severity: severityNum,
        accountNumber: c.accountNumber,
        daysOpen: 0,
        product: c.product || undefined,
        customerName,
      } satisfies SupportCase)
    }
  }

  // ── Batch scrape (primary path) with per-account fallback ──────────────
  try {
    let batchSucceeded = false
    try {
      const chunks = chunkArray(accountNumbers, BATCH_CHUNK_SIZE)
      console.log(
        `[rh-scraper] batch query: ${accountNumbers.length} accounts in ${chunks.length} chunk(s) ` +
        `(${BATCH_CHUNK_SIZE} per chunk)`,
      )

      for (let ci = 0; ci < chunks.length; ci++) {
        if (shouldCancel?.()) {
          console.log(`[rh-scraper] cancel requested — returning ${allCases.length} cases scraped so far`)
          break
        }

        const chunk = chunks[ci]
        const orClause = chunk.map(n => `"${n}"`).join(' OR ')
        const query = `accountNumber: (${orClause}) orderBy severity asc`
        const encodedQuery = encodeURIComponent(query)
        const batchStartMs = Date.now()

        // Page through results — portal may cap rows per page
        let pageNum = 1
        let chunkCaseCount = 0

        while (true) {
          const url =
            `https://access.redhat.com/support/cases/#/case/list` +
            `?query=${encodedQuery}` +
            `&p=${pageNum}&size=${BATCH_PAGE_SIZE}&searchType=basic`

          await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
          await checkForSessionExpiry(page)
          await waitForTable(page)

          // Diagnostic: dump first row's structure before extraction
          if (ci === 0 && pageNum === 1) {
            const domDiag = await page.evaluate(() => {
              const headerRow = document.querySelector('table thead tr, table tr:first-child')
              const headers = headerRow ? Array.from(headerRow.querySelectorAll('th, td')).map(h => h.textContent?.trim()?.slice(0, 25)) : []
              const firstRow = document.querySelector('table tbody tr')
              const cells = firstRow ? Array.from(firstRow.querySelectorAll('td')).map(td => td.textContent?.trim()?.slice(0, 25)) : []
              const firstLink = firstRow?.querySelector('a[href*="/case/"]') as HTMLAnchorElement | null
              return { headers, cells, href: firstLink?.getAttribute('href') ?? 'NO LINK', cellCount: cells.length }
            }).catch(() => ({ headers: [], cells: [], href: 'ERROR', cellCount: 0 }))
            console.log(`[rh-scraper] DIAG headers (${domDiag.headers.length}): ${domDiag.headers.join(' | ')}`)
            console.log(`[rh-scraper] DIAG cells (${domDiag.cellCount}): ${domDiag.cells.join(' | ')}`)
            console.log(`[rh-scraper] DIAG first case href: ${domDiag.href}`)
          }

          const cases = await extractCasesFromPage(page, chunk, null)
          chunkCaseCount += cases.length
          pushCases(cases)

          // Check total DOM rows to decide if there's another page
          const totalRowsOnPage = await page.evaluate(() =>
            document.querySelectorAll('table tbody tr').length
          ).catch(() => 0)

          // If less than BATCH_PAGE_SIZE rows rendered, we've seen all results
          if (totalRowsOnPage < BATCH_PAGE_SIZE) break

          // Safety: don't paginate indefinitely
          if (pageNum >= 10) {
            console.warn(`[rh-scraper] batch chunk ${ci + 1}: hit pagination limit (10 pages)`)
            break
          }

          pageNum++
        }

        const elapsedSec = ((Date.now() - batchStartMs) / 1000).toFixed(1)
        // Count unique accounts that returned cases in this chunk
        const chunkCases = allCases.slice(allCases.length - chunkCaseCount)
        const accountsWithCases = new Set(chunkCases.map(c => c.accountNumber)).size
        console.log(
          `[rh-scraper] batch chunk ${ci + 1}/${chunks.length}: ${chunkCaseCount} cases ` +
          `across ${accountsWithCases} accounts (${elapsedSec}s, ${pageNum} page(s))`,
        )

        // BKL-RH-01: Starvation detection — if chunk hit the pagination limit AND some
        // accounts in this chunk returned 0 cases, a high-volume account likely filled
        // all pages. Re-query each starved account individually to recover their cases.
        if (pageNum >= 10 && accountsWithCases < chunk.length) {
          const seenInChunk = new Set(chunkCases.map(c => c.accountNumber).filter(Boolean))
          const starvedAccounts = chunk.filter(n => !seenInChunk.has(n))
          if (starvedAccounts.length > 0) {
            console.warn(
              `[rh-scraper] starvation detected in chunk ${ci + 1}: ${starvedAccounts.length} accounts got 0 cases — re-querying individually`,
            )
            for (const acct of starvedAccounts) {
              if (shouldCancel?.()) break
              const singleQuery = encodeURIComponent(`accountNumber: ("${acct}") orderBy severity asc`)
              let singlePage = 1
              let singleCount = 0
              while (true) {
                const url =
                  `https://access.redhat.com/support/cases/#/case/list` +
                  `?query=${singleQuery}&p=${singlePage}&size=${BATCH_PAGE_SIZE}&searchType=basic`
                await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
                await checkForSessionExpiry(page)
                await waitForTable(page)
                const recovered = await extractCasesFromPage(page, [acct], null)
                singleCount += recovered.length
                pushCases(recovered)
                const rows = await page.evaluate(() => document.querySelectorAll('table tbody tr').length).catch(() => 0)
                if (rows < BATCH_PAGE_SIZE || singlePage >= 10) break
                singlePage++
              }
              console.log(`[rh-scraper] starvation recovery: ${acct} → ${singleCount} cases (${singlePage} page(s))`)
            }
          }
        }
      }

      // ── Post-batch: log any unresolved account numbers ──────────────────
      // The cell scanner (above) should resolve most/all accounts.
      // If any remain unresolved, log them but don't do per-account queries
      // (that would take 35 × 5s = 175s, defeating the batch purpose).
      const unresolved = allCases.filter(c => !c.accountNumber)
      if (unresolved.length > 0) {
        console.warn(`[rh-scraper] ${unresolved.length} cases have no account number after batch (cell scan didn't match)`)
        for (const c of unresolved) {
          console.warn(`[rh-scraper]   case ${c.caseNumber}: no matching account in chunk`)
        }
      } else {
        console.log(`[rh-scraper] all cases resolved to accounts`)
      }

      batchSucceeded = true
    } catch (batchErr: any) {
      // If session expired, re-throw — don't fall back
      if (batchErr instanceof SessionExpiredError) throw batchErr

      console.warn(
        `[rh-scraper] batch query failed — falling back to per-account loop:`,
        batchErr?.message ?? batchErr,
      )
    }

    // ── Per-account fallback (if batch failed) ──────────────────────────────
    if (!batchSucceeded) {
      allCases.length = 0  // clear any partial batch results

      for (const accountNum of accountNumbers) {
        if (shouldCancel?.()) {
          console.log(`[rh-scraper] cancel requested — returning ${allCases.length} cases scraped so far`)
          break
        }
        const url =
          `https://access.redhat.com/support/cases/#/case/list` +
          `?query=accountNumber%3A%20(%22${accountNum}%22)%20orderBy%20severity%20asc` +
          `&p=1&size=100&searchType=basic`

        await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
        await checkForSessionExpiry(page)
        await waitForTable(page)

        const cases = await extractCasesFromPage(page, null, accountNum)

        const columnSource = cases[0]?.columnSource ?? 'fallback'
        console.log(`[rh-scraper] account ${accountNum}: ${cases.length} cases (columns via ${columnSource})`)

        pushCases(cases)

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
    }
  } finally {
    // If we created a new page (not the live page), close it.
    // If we used the live page, leave it open — it holds the session state.
    if (!usingLivePage) await page.close().catch(() => {})
  }

  // Persist session state after a successful scrape
  await persistSessionState()

  // BKL-M50c: Context recycling — prevent memory leaks from long-running contexts
  _scrapesSinceRecycle++
  const heapUsed = process.memoryUsage().heapUsed
  if (_scrapesSinceRecycle >= RECYCLE_AFTER_SCRAPES || heapUsed > RECYCLE_HEAP_THRESHOLD_BYTES) {
    const heapMB = Math.round(heapUsed / 1024 / 1024)
    console.log(`[browser] Context recycling after ${_scrapesSinceRecycle} scrapes (heap: ${heapMB}MB)`)
    try {
      await persistSessionState()
      const oldCtx = _context
      _context = null
      _livePage = null
      if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null }
      if (oldCtx) await oldCtx.close().catch(() => {})
      // Reopen with saved state
      if (_profileDir) {
        await clearProfileLocks(_profileDir)
        _context = await chromium.launchPersistentContext(_profileDir, {
          headless: false,
          args: [
            '--disable-blink-features=AutomationControlled',
            '--ignore-certificate-errors',
            ...BASE_CHROMIUM_ARGS,
          ],
          ignoreDefaultArgs: ['--enable-automation'],
        })
        await restoreSessionCookies()
        _attachDisconnectedHandler(_context, _profileDir)
        _keepAliveTimer = setInterval(
          () => keepAlive().catch(e => console.warn('[rh-scraper] keep-alive error:', e)),
          KEEP_ALIVE_INTERVAL_MS,
        )
        _scrapesSinceRecycle = 0
        console.log(`[browser] Context recycled successfully (heap was ${heapMB}MB)`)
        // BKL-CONN-SF-AUTO-01: notify sister scrapers (SF, CCSP) so they
        // re-adopt the new live context. Without this, SF holds a dead ref
        // until manual VNC re-login. Mirrors the _autoRecover hook fire above.
        if (_onContextRecovered && _context && _profileDir) {
          try { _onContextRecovered(_context, _profileDir) }
          catch (e: any) { console.warn('[rh-scraper] context recovery callback error:', e?.message) }
          console.log('[rh-scraper] recycle: sister scrapers re-adopted')
        }
      }
    } catch (e: any) {
      console.error('[browser] Context recycling failed:', e?.message ?? e)
    }
  }

  // BKL-M50 G5: Stale-overwrite guard — don't overwrite good cached cases with
  // empty results (e.g. session expired silently mid-scrape). Same pattern used
  // by Supportable, CCSP, and Pipeline scrapers in refresh-engine.ts.
  if (allCases.length === 0) {
    try {
      const existing = JSON.parse(await readFile(cachePath, 'utf-8'))
      if (Array.isArray(existing?.cases) && existing.cases.length > 0) {
        console.warn(
          `[rh-scraper] stale-overwrite guard: scraped 0 cases but cache has ${existing.cases.length}` +
          ` — keeping existing cache (possible silent session expiry)`,
        )
        return allCases
      }
    } catch {
      // No existing cache or parse error — safe to write empty results
    }
  }

  // Write cache atomically — write to .tmp first then rename so a crash mid-write
  // never produces a corrupt cache file that reads as 0 cases.
  await writeJsonAtomicAsync(cachePath, {
    scrapedAt: new Date().toISOString(),
    accounts: accountNumbers,
    cases: allCases,
  }, { mode: 0o600 })

  return allCases
}

/**
 * Search the RH portal by customer name to discover account numbers.
 * Primary strategy (sidebar autocomplete):
 *  1. Navigate to the cases list page
 *  2. Type the customer name into the "Accounts" filter input in the left sidebar
 *  3. Wait for the autocomplete dropdown — entries look like "Company Name (1234567)"
 *  4. Extract all account numbers from parens using regex \((\d{4,12})\)
 *  5. Return { accountNumbers, cases: [] } — cases scraped separately by account number
 *
 * Fallback (case API):
 *  If sidebar approach fails (selector not found, no dropdown, 0 results),
 *  fall back to POST /hydra/rest/search/v2/cases with account_name: Solr query.
 *  Fallback extracts account numbers only — does not populate cases array.
 */
export type DiscoverResult = {
  accountNumbers: string[]
  cases: Array<{ caseNumber: string; summary: string; status: string; severity: string; accountNumber: string; product?: string; createdDate?: string; casesSource?: 'name_match' | 'account_number' }>
}

export async function discoverAccountNumberByName(
  customerName: string,
  profileDir: string,
): Promise<DiscoverResult> {
  if (process.env.DISALLOW_LIVE_SCRAPE === '1') {
    throw new Error('[rh-scraper] DISALLOW_LIVE_SCRAPE=1 — live scrape blocked in test environment')
  }
  await initScrapeContext(profileDir)
  if (!_context) return { accountNumbers: [], cases: [] }

  // Reuse discover page across calls — avoids full portal navigation + 4s render wait per customer.
  // First call creates the page and navigates; subsequent calls reuse the already-rendered page.
  let page = _discoverPage
  let isNewPage = false
  if (!page || page.isClosed()) {
    page = await _context.newPage()
    _discoverPage = page
    isNewPage = true
  }

  try {
    if (isNewPage) {
      await page.goto('https://access.redhat.com/support/cases/#/case/list', {
        waitUntil: 'load',
        timeout: 30_000,
      })
      if (!page.url().includes('access.redhat.com')) throw new SessionExpiredError()
    }

    // ── Primary: sidebar account filter autocomplete ──────────────────────────
    // The portal cases list has an "Accounts" filter in the left sidebar. Typing a
    // company name into it fires a lookup and shows a dropdown of matching accounts
    // with their numbers in parens: "Microchip Technology Inc. (5559614)".
    // This is ground truth — works even for accounts with zero open cases.
    let sidebarNums: string[] = []
    let sidebarSucceeded = false
    // ── Fix #2: HTTP-first case-API pre-call ─────────────────────────────────
    // Runs BEFORE sidebar UI — pure HTTP fetch inside the authenticated page context.
    // For direct end-customers: returns their own account numbers → skip sidebar entirely.
    // For resellers (Insight Direct pattern): returns end-customer cases (still useful),
    // but not the reseller's own account numbers → continue to sidebar for those.
    const solrName = customerName.replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
    const apiPreResult = await page.evaluate(async (name: string) => {
      type RawDoc = {
        case_accountNumber?: string | number
        case_account_name?: string
        case_number?: string | number
        case_summary?: string
        case_status?: string
        case_severity?: string | number
        case_product?: string
        case_createdDate?: string
      }
      type CaseEntry = { caseNumber: string; summary: string; status: string; severity: string; accountNumber: string; product?: string; createdDate?: string; casesSource: 'name_match' }
      const body = {
        q: `account_name: "${name}"`,
        start: 0,
        rows: 100,
        partnerSearch: false,
        expression: 'fl=case_accountNumber,case_account_name,case_number,case_summary,case_status,case_severity,case_product,case_createdDate',
      }
      const normName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
      const searchedNorm = normName(name)
      const seenNums = new Set<string>()
      const seenCaseNums = new Set<string>()
      const seenCases: CaseEntry[] = []
      const LEGAL_WORDS = new Set(['INC', 'LLC', 'LLP', 'LTD', 'LP', 'CORP', 'CO', 'PLC', 'ATTN', 'LL'])
      const processDoc = (doc: RawDoc) => {
        const caseNum = doc.case_number != null ? String(doc.case_number).trim() : null
        if (caseNum && !seenCaseNums.has(caseNum)) {
          const n = doc.case_accountNumber
          const validNum = n != null && /^\d{4,12}$/.test(String(n).trim()) ? String(n).trim() : null
          seenCaseNums.add(caseNum)
          seenCases.push({ caseNumber: caseNum, summary: doc.case_summary ?? '', status: doc.case_status ?? '', severity: doc.case_severity != null ? String(doc.case_severity) : '', accountNumber: validNum ?? (n != null ? String(n) : ''), product: doc.case_product, createdDate: doc.case_createdDate, casesSource: 'name_match' })
        }
        const storedName = normName(doc.case_account_name ?? '')
        const searchWords = searchedNorm.split(' ').filter(w => w.length > 1 && !LEGAL_WORDS.has(w))
        if (searchWords.length === 0) return
        if (!searchWords.every(w => storedName.includes(w))) return
        const n = doc.case_accountNumber
        const validNum = n != null && /^\d{4,12}$/.test(String(n).trim()) ? String(n).trim() : null
        if (validNum) seenNums.add(validNum)
      }
      const resp1 = await fetch('/hydra/rest/search/v2/cases?redhat_client=Portal%20Case%20Management&account_number=901532', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      let total = 0
      if (resp1.ok) { const d1 = await resp1.json() as { response?: { docs?: RawDoc[] } }; const docs1 = d1?.response?.docs ?? []; total += docs1.length; for (const doc of docs1) processDoc(doc) }
      else if (resp1.status === 401) return { error: 'HTTP 401' as const, nums: [] as string[], total: 0, cases: [] as CaseEntry[] }
      const resp2 = await fetch('/hydra/rest/search/v2/cases?redhat_client=Portal%20Case%20Management', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (resp2.ok) { const d2 = await resp2.json() as { response?: { docs?: RawDoc[] } }; const docs2 = d2?.response?.docs ?? []; total += docs2.length; for (const doc of docs2) processDoc(doc) }
      return { error: null, nums: Array.from(seenNums), total, cases: seenCases }
    }, solrName)

    let prefetchedCases: DiscoverResult['cases'] = []
    if (apiPreResult.error === 'HTTP 401') throw new SessionExpiredError()
    if (!apiPreResult.error) {
      prefetchedCases = apiPreResult.cases
      if (apiPreResult.nums.length > 0) {
        // Direct end-customer: API found their own account numbers — skip sidebar entirely
        console.log(`[rh-scraper/discover] "${customerName}" → HTTP-first hit (${apiPreResult.total} docs, ${apiPreResult.cases.length} cases, accts=[${apiPreResult.nums.join(', ')}])`)
        return { accountNumbers: apiPreResult.nums, cases: apiPreResult.cases }
      }
      console.log(`[rh-scraper/discover] "${customerName}" → HTTP-first (${apiPreResult.total} docs, ${apiPreResult.cases.length} cases, no matching accts — sidebar next)`)
    }

    try {
      if (isNewPage) {
        // Wait for portal to fully render on first navigation only — filter panel
        // takes time after navigation; skip on reused page (already rendered)
        await page.waitForTimeout(4_000)
      }

      // Ensure the filter panel is open — it has a toggle button that collapses/expands it.
      // The toggle shows "Collapse filter section" when open, "Expand" when closed.
      // If panel is collapsed, click to open it.
      const filterPanelToggle = page.locator([
        '[aria-label*="filter section" i]',
        '[title*="filter section" i]',
        '[aria-label*="collapse filter" i]',
        '[aria-label*="expand filter" i]',
      ].join(', ')).first()
      const panelToggleVisible = await filterPanelToggle.isVisible({ timeout: 2_000 }).catch(() => false)
      if (panelToggleVisible) {
        const label = (await filterPanelToggle.getAttribute('aria-label').catch(() => '')) ?? ''
        const title = (await filterPanelToggle.getAttribute('title').catch(() => '')) ?? ''
        if ((label + title).toLowerCase().includes('expand')) {
          await filterPanelToggle.click()
          await page.waitForTimeout(1_000)
          console.log(`[rh-scraper/discover] sidebar: expanded filter panel`)
        }
      }

      // The "Search for an account" input is the Accounts section typeahead toggle.
      // On a fresh page it is directly visible. Clicking it opens the dropdown showing
      // account entries with numbers: "Company Name (1234567)".
      // Confirmed from live portal screenshot: input[placeholder="Search for an account"]
      const accountInput = page.locator('input[placeholder="Search for an account"]').first()
      const inputVisible = await accountInput.isVisible({ timeout: 5_000 }).catch(() => false)
      console.log(`[rh-scraper/discover] sidebar: account input visible=${inputVisible}`)

      if (inputVisible) {
        await accountInput.click()
        // fill() implicitly focuses the element — no fixed wait needed after click
        // Normalize search input: replace hyphens with spaces so "HOSPITAL-SAN DIEGO"
        // matches portal entries like "Hospital San Diego"
        const normalizedSearchName = customerName.replace(/-/g, ' ')
        await accountInput.fill(normalizedSearchName)

        // BKL-RH-PERF-01: Wait for dropdown results instead of fixed delay.
        // Fires immediately when results appear (fast path) or falls through after 2s (slow/empty path).
        const dropdownWaitSelector = '[role="option"], [role="menuitem"], li.pf-v6-c-menu__item, li.pf-v6-c-select__menu-item, [role="listbox"] li, .pf-v5-c-select__menu li'
        const waitForDropdown = () => page.waitForFunction(
          (sel: string) => document.querySelectorAll(sel).length > 0,
          dropdownWaitSelector,
          { timeout: 2_000 }
        ).catch(() => {})
        await waitForDropdown()

        // Read dropdown items — PF v6 renders them as list items with account name + number in parens.
        // Confirmed from live portal: entries look like "First American Financial Corporation (12653942)"
        // Use broad selectors to capture whatever list structure PF v6 renders
        const dropdownSelectors = [
          '[role="option"]',
          '[role="menuitem"]',
          'li.pf-v6-c-menu__item',
          'li.pf-v6-c-select__menu-item',
          '[role="listbox"] li',
          'ul[role="listbox"] li',
          '.pf-v5-c-select__menu li',  // PF v5 fallback
        ]

        let dropdownItems = null
        for (const sel of dropdownSelectors) {
          try {
            await page.waitForSelector(sel, { timeout: 500 })
            const count = await page.locator(sel).count()
            if (count > 0) {
              dropdownItems = page.locator(sel)
              console.log(`[rh-scraper/discover] sidebar: dropdown appeared via "${sel}" (${count} items)`)
              break
            }
          } catch {
            // selector not found within timeout — try next
          }
        }

        if (dropdownItems) {
          const allText = await dropdownItems.allTextContents()
          const seenNums = new Set<string>()
          for (const text of allText) {
            const matches = [...text.matchAll(/\((\d{4,12})\)/g)]
            for (const m of matches) seenNums.add(m[1])
          }
          sidebarNums = Array.from(seenNums)
          sidebarSucceeded = sidebarNums.length > 0
          console.log(`[rh-scraper/discover] "${customerName}" → sidebar autocomplete: accts=[${sidebarNums.join(', ')}] (from ${allText.length} dropdown items)`)
        } else {
          console.log(`[rh-scraper/discover] "${customerName}" — sidebar dropdown did not appear, will fallback`)
        }

        // ── Second attempt: suffix-stripped search with exact-match filter ─────
        // If full name returned no dropdown, strip legal entity suffixes (INC, LLC,
        // CORP, LTD) and search again. Filter results so only account names that
        // exactly match the stripped target are kept — prevents "Applied Medical
        // Resources" from being grabbed when searching for "Applied Medical".
        if (!sidebarSucceeded) {
          const strippedName = customerName
            .replace(/[\s,.]*(LIMITED\s+PARTNERSHIP|INCORPORATED|CORPORATION|L\.L\.C\.|L\.P\.|INC\.|LLC\.|CORP\.|LTD\.|INC|LLC|CORP|LTD|LP)\s*[.,]?\s*$/i, '')
            .trim()
          const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
          const strippedNorm = normalize(strippedName)
          const fullNorm = normalize(customerName)
          if (strippedNorm !== fullNorm) {
            await accountInput.fill(strippedName)
            await waitForDropdown()
            let dropdownItems2 = null
            for (const sel of dropdownSelectors) {
              try {
                await page.waitForSelector(sel, { timeout: 500 })
                const count = await page.locator(sel).count()
                if (count > 0) { dropdownItems2 = page.locator(sel); break }
              } catch { /* try next */ }
            }
            if (dropdownItems2) {
              const allText2 = await dropdownItems2.allTextContents()
              const exactNums = new Set<string>()
              for (const text of allText2) {
                // Parse "Company Name (1234567)" → extract and normalize account name
                const nameMatch = text.match(/^(.*?)\s*\(\d{4,12}\)/)
                const acctRaw = nameMatch ? nameMatch[1].trim() : text
                const acctNorm = normalize(
                  acctRaw.replace(/[\s,.]*(LIMITED\s+PARTNERSHIP|INCORPORATED|CORPORATION|L\.L\.C\.|L\.P\.|INC\.|LLC\.|CORP\.|LTD\.|INC|LLC|CORP|LTD|LP)\s*[.,]?\s*$/i, '').trim()
                )
                if (acctNorm !== strippedNorm) continue  // skip non-matching companies
                const nums = [...text.matchAll(/\((\d{4,12})\)/g)]
                for (const m of nums) exactNums.add(m[1])
              }
              const exactArr = Array.from(exactNums)
              if (exactArr.length > 0) {
                sidebarNums = exactArr
                sidebarSucceeded = true
                console.log(`[rh-scraper/discover] "${customerName}" → stripped sidebar ("${strippedName}"): accts=[${exactArr.join(', ')}]`)
              } else {
                console.log(`[rh-scraper/discover] "${customerName}" → stripped sidebar ("${strippedName}"): no exact matches from ${allText2.length} items`)
              }
            } else {
              console.log(`[rh-scraper/discover] "${customerName}" → stripped sidebar ("${strippedName}"): dropdown did not appear`)
            }

            // ── Pass 3: strip geographic/country suffixes (USA, US, America, Canada) ──────
            // For companies like "Insight Direct Usa, Inc." → "Insight Direct"
            // Portal may not autocomplete "Insight Direct Usa" but will autocomplete "Insight Direct"
            if (!sidebarSucceeded) {
              const coreNorm = normalize(
                strippedName.replace(/[\s,]*(usa|u\.s\.a|us|america|canada|international|global)\s*$/i, '').trim()
              )
              if (coreNorm !== strippedNorm && coreNorm.length >= 4) {
                const coreName = strippedName.replace(/[\s,]*(usa|u\.s\.a|us|america|canada|international|global)\s*$/i, '').trim()
                await accountInput.fill(coreName)
                await waitForDropdown()
                let dropdownItems3 = null
                for (const sel of dropdownSelectors) {
                  try {
                    await page.waitForSelector(sel, { timeout: 500 })
                    const count = await page.locator(sel).count()
                    if (count > 0) { dropdownItems3 = page.locator(sel); break }
                  } catch { /* try next */ }
                }
                if (dropdownItems3) {
                  const allText3 = await dropdownItems3.allTextContents()
                  const coreNums = new Set<string>()
                  for (const text of allText3) {
                    const nameMatch = text.match(/^(.*?)\s*\(\d{4,12}\)/)
                    const acctRaw = nameMatch ? nameMatch[1].trim() : text
                    const acctNorm = normalize(
                      acctRaw.replace(/[\s,.]*(LIMITED\s+PARTNERSHIP|INCORPORATED|CORPORATION|L\.L\.C\.|L\.P\.|INC\.|LLC\.|CORP\.|LTD\.|INC|LLC|CORP|LTD|LP)\s*[.,]?\s*$/i, '')
                        .replace(/[\s,]*(usa|u\.s\.a|us|america|canada|international|global)\s*$/i, '').trim()
                    )
                    // Match entries whose core name starts with our core search term
                    if (!acctNorm.startsWith(coreNorm)) continue
                    const nums = [...text.matchAll(/\((\d{4,12})\)/g)]
                    for (const m of nums) coreNums.add(m[1])
                  }
                  const coreArr = Array.from(coreNums)
                  if (coreArr.length > 0) {
                    sidebarNums = coreArr
                    sidebarSucceeded = true
                    console.log(`[rh-scraper/discover] "${customerName}" → core sidebar ("${coreName}"): accts=[${coreArr.join(', ')}]`)
                  } else {
                    console.log(`[rh-scraper/discover] "${customerName}" → core sidebar ("${coreName}"): no matches from ${allText3.length} items`)
                  }
                } else {
                  console.log(`[rh-scraper/discover] "${customerName}" → core sidebar ("${coreName}"): dropdown did not appear`)
                }
              }
            }
          }
        }
      } else {
        console.log(`[rh-scraper/discover] "${customerName}" — sidebar account input not found, will fallback`)
      }
    } catch (sidebarErr: any) {
      console.log(`[rh-scraper/discover] "${customerName}" — sidebar attempt failed: ${sidebarErr?.message ?? sidebarErr}`)
    }

    if (sidebarSucceeded) {
      // Merge HTTP-first cases (name_match) with sidebar-found account numbers
      return { accountNumbers: sidebarNums, cases: prefetchedCases }
    }

    // Both HTTP-first and sidebar failed to find account numbers — return whatever cases the API found
    console.log(`[rh-scraper/discover] "${customerName}" → sidebar+API both done (${prefetchedCases.length} cases from HTTP-first, no accts)`)
    return { accountNumbers: [], cases: prefetchedCases }
  } catch (e: any) {
    if (e instanceof SessionExpiredError) {
      _discoverPage = null  // context will be closed; don't try to reuse
      throw e
    }
    // On unexpected error discard the page so next call starts fresh
    _discoverPage = null
    await page.close().catch(() => {})
    console.warn(`[rh-scraper] name discovery failed for "${customerName}": ${e?.message ?? e}`)
    return { accountNumbers: [], cases: [] }
  }
  // NOTE: page intentionally NOT closed — reused for next customer in the discovery loop
}

/**
 * BKL-RH-03 Phase 2 (ADR-014): atomic cache writer shared between the browser
 * path (used inline in runRhScrape) and the Bearer path (called from
 * scraper-manager.ts when BearerCaseClient returns cases).
 *
 * Additive export only — the browser path continues to use its own inline
 * write logic unchanged. Same on-disk format, same mode (0o600), same .tmp +
 * rename atomic pattern. Kept here so both transports produce byte-compatible
 * cache files and a transport swap requires no downstream reader changes.
 */
export async function writeCasesCache(
  cachePath: string,
  accountNumbers: string[],
  cases: SupportCase[],
): Promise<void> {
  await writeJsonAtomicAsync(cachePath, { scrapedAt: new Date().toISOString(), accounts: accountNumbers, cases }, { mode: 0o600 })
}
