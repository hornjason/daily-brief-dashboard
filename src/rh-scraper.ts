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
import { BASE_CHROMIUM_ARGS } from './browser-utils.ts'
import { notify } from './utils.ts'

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
 * Mark the live page as busy (used by another flow like Tableau login).
 * While busy, the keep-alive will skip full-page navigation to avoid
 * stealing the page from the user.
 */
export function setLivePageBusy(busy: boolean): void { _livePageBusy = busy }

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
    browser.on('disconnected', () => {
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

  // BKL-M50c: Attach crash/disconnect handlers
  _attachPageCrashHandler(livePage)
  _attachDisconnectedHandler(context, profileDir)
  browserDegraded = false
  browserDegradedReason = null
  _recoveryAttempts = 0
  _scrapesSinceRecycle = 0

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
    _intentionalClose = true  // suppress auto-recovery on deliberate close
    try { await ctx.close() } catch { _intentionalClose = false /* already closed */ }
  }
}

// ── Session state persistence ─────────────────────────────────────────────────

async function persistSessionState(): Promise<void> {
  if (!_context || !_profileDir) return
  try {
    const state = await _context.storageState()
    await writeFile(resolve(_profileDir, SESSION_STATE_FILE), JSON.stringify(state), { mode: 0o600 })
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
  const { accountNumbers, profileDir, cachePath, shouldCancel } = options

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
        const accountsWithCases = new Set(
          allCases.slice(allCases.length - chunkCaseCount).map(c => c.accountNumber)
        ).size
        console.log(
          `[rh-scraper] batch chunk ${ci + 1}/${chunks.length}: ${chunkCaseCount} cases ` +
          `across ${accountsWithCases} accounts (${elapsedSec}s, ${pageNum} page(s))`,
        )
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
  await mkdir(dirname(cachePath), { recursive: true })
  const tmpPath = cachePath + '.tmp'
  await writeFile(
    tmpPath,
    JSON.stringify({
      scrapedAt: new Date().toISOString(),
      accounts: accountNumbers,
      cases: allCases,
    }, null, 2),
    { mode: 0o600 },
  )
  await rename(tmpPath, cachePath)

  return allCases
}
