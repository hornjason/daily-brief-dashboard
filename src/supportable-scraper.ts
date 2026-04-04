/**
 * src/supportable-scraper.ts
 *
 * Scrapes subscription entitlement data from the Supportable portal
 * (https://supportable.corp.redhat.com — requires VPN).
 *
 * Flow per account number:
 *   1. Navigate to the APEX app (first account only — handles SSO redirect)
 *   2. Fill Account Number input (P0_ACCOUNT_NUMBER) → click Go
 *   3. Click Export tab → navigates to page 22 (SalesReport layout)
 *   4. Select "Sales Export Format" saved report
 *   5. Actions → Download → CSV → intercept Playwright download event
 *   6. Parse CSV, filter to Status=Active rows
 *   7. Navigate back to landing page for next account number
 *
 * All account numbers for a customer are aggregated into a single tab.
 * The final Google Sheet has an "Accounts" summary tab (first) followed
 * by one tab per customer containing their aggregated subscription rows.
 *
 * Architecture (council decision 2026-04-03):
 *   - Discovery: up to 3 parallel pages (read-only HTML parsing, no downloads)
 *   - Subscription scraping: strictly sequential (one page, one account)
 *   - Parallel APEX tabs crash Chromium under container memory constraints
 *     (2GB shm, 8GB mem). Sequential is the only reliable architecture.
 */

import type { BrowserContext, Page } from '@playwright/test'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from './google.ts'
import type { AE } from './types.ts'
import { parseCsvToObjects } from './csv-parse.ts'
import { SUBSCRIPTION_COLUMN_PATTERNS, parseHtmlTable, stripLegalSuffix, buildNameCandidates } from './supportable-extract.ts'

const SUPPORTABLE_URL = 'https://supportable.corp.redhat.com:4443/pls/rhapplications/f?p=304:1'
/** Get this page's own Supportable landing URL (respects app 305, 306, etc from New Session) */
function getPageLandingUrl(page: Page): string {
  const appNum = page.url().match(/f\?p=(\d+)/)?.[1] ?? '304'
  return SUPPORTABLE_URL.replace('f?p=304:', `f?p=${appNum}:`)
}
const SUPPORTABLE_DEBUG = process.env.SUPPORTABLE_DEBUG === 'true'

import { setLivePageBusy } from './rh-scraper.ts'
import { sanitizeErr, sanitizeCell } from './utils.ts'
import { markRunning, recordOutcome } from './scraper-status-store.ts'

// ── Module state ──────────────────────────────────────────────────────────────

export let lastSupportableScrape: string | null = null
export let lastSupportableError:  string | null = null
export let supportableScrapeRunning = false
export let supportableStatusMessage: string | null = null
export let supportableScrapeStartedAt: number | null = null

// A run that has been stuck for this long is assumed crashed — mutex auto-resets
const STALE_MUTEX_MS = 15 * 60 * 1000  // 15 minutes

// Session heartbeat: APEX sessions expire after ~30 min of inactivity.
// Track last navigation time and periodically touch the portal to keep alive.
const SESSION_HEARTBEAT_MS = 25 * 60 * 1000  // 25 minutes
let lastNavigationTime = 0

/**
 * If more than SESSION_HEARTBEAT_MS has elapsed since last Supportable navigation,
 * briefly navigate to the portal landing page to keep the APEX session alive.
 */
async function sessionHeartbeat(page: Page): Promise<void> {
  if (Date.now() - lastNavigationTime < SESSION_HEARTBEAT_MS) return
  console.log(`[supportable] session heartbeat — refreshing APEX session`)
  await page.goto(getPageLandingUrl(page), { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
  await page.waitForTimeout(1_000)
  lastNavigationTime = Date.now()
}

// Max parallel pages for discovery only (read-only HTML parsing, no downloads).
// Subscription scraping is strictly sequential — see file header comment.
const DISCOVERY_PARALLEL = 3

// Wall-clock limit per account — fires before the 30s download timeout can accumulate
const PER_ACCOUNT_TIMEOUT_MS = 90_000  // 90 seconds

// Fresh page every N accounts to prevent V8 heap growth from detached DOM nodes
const ACCOUNTS_PER_PAGE_CYCLE = 10

let _ctx: BrowserContext | null = null

export function adoptSupportableContext(ctx: BrowserContext): void {
  _ctx = ctx
  console.log('[supportable] adopted shared browser context')
}

export function closeSupportableContext(): void {
  _ctx = null
  console.log('[supportable] browser context released')
}

// ── Discovery session creation via "New Session" button ──────────────────────

/**
 * Create isolated APEX sessions for parallel discovery (name search only).
 * Each "New Session" click opens a popup with a new app instance (304 → 305 → 306),
 * giving each session its own server-side state — no contention on P0_CUSTOMER_NAME.
 * Capped at DISCOVERY_PARALLEL (3) to stay within container memory limits.
 */
async function createDiscoverySessions(count: number): Promise<Page[]> {
  count = Math.min(count, DISCOVERY_PARALLEL)
  if (!_ctx) throw new Error('Browser context not available — re-authenticate via Setup page')
  if (count <= 0) return []

  const pages: Page[] = []

  // First page: navigate normally (gets app 304)
  const page1 = await _ctx.newPage()
  await page1.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page1.waitForTimeout(2000)
  pages.push(page1)

  const firstApp = page1.url().match(/f\?p=(\d+)/)?.[1] ?? '304'
  console.log(`[supportable] session 1: app=${firstApp} (primary)`)

  // Additional pages: click "New Session" on page1 to spawn isolated APEX apps
  for (let i = 1; i < count; i++) {
    try {
      // Verify "New Session" link exists before clicking
      const newSessionLink = await page1.$('a:has-text("New Session")')
      if (!newSessionLink) {
        console.warn(`[supportable] "New Session" link not found — stopping at ${pages.length} sessions`)
        break
      }

      const popupPromise = _ctx.waitForEvent('page', { timeout: 10_000 })
      await newSessionLink.click()
      const newPage = await popupPromise
      await newPage.waitForLoadState('domcontentloaded', { timeout: 15_000 })
      await newPage.waitForTimeout(1500)

      const appId = newPage.url().match(/f\?p=(\d+)/)?.[1] ?? '?'
      console.log(`[supportable] session ${i + 1}: app=${appId}`)
      pages.push(newPage)
    } catch (e: any) {
      console.warn(`[supportable] failed to create session ${i + 1}: ${e.message} — stopping at ${pages.length} sessions`)
      break
    }
  }

  console.log(`[supportable] created ${pages.length} parallel APEX sessions (apps ${firstApp}-${parseInt(firstApp) + pages.length - 1})`)
  return pages
}

/**
 * Close all pages in a session list, swallowing errors.
 */
async function closeDiscoveryPages(pages: Page[]): Promise<void> {
  for (const p of pages) {
    await p.close().catch(() => {})
  }
}

// ── DOM diagnostics ───────────────────────────────────────────────────────────

async function dumpDom(page: Page, label: string): Promise<void> {
  try {
    const info = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input, button, a, [role="tab"]'))
        .slice(0, 40)
        .map(el => ({
          tag:   el.tagName.toLowerCase(),
          id:    el.id ?? '',
          value: ((el as HTMLInputElement).value ?? '').slice(0, 50),
          text:  (el.textContent ?? '').trim().slice(0, 50),
          cls:   el.className.slice(0, 80),
        }))
      return { url: location.href, els }
    })
    console.log(`[supportable:dom] ${label} — ${info.url}\n` +
      info.els.map(e => `  <${e.tag}> id="${e.id}" value="${e.value}" text="${e.text}" class="${e.cls}"`).join('\n'))
  } catch (e: any) {
    console.warn(`[supportable:dom] dump failed (${label}): ${e.message}`)
  }
}

/**
 * Try multiple strategies to select CSV format in the APEX download dialog.
 * Returns true if a CSV format element was clicked.
 */
async function selectCsvFormat(page: Page): Promise<boolean> {
  const csvEl = await page.$('.a-IRR-dlg-dlType-CSV, [data-type="CSV"]')
  if (csvEl) { await csvEl.click(); await page.waitForTimeout(500); return true }

  const csvLabel = await page.$('label:has-text("CSV"), span:has-text("CSV"), a:has-text("CSV")')
  if (csvLabel) { await csvLabel.click(); await page.waitForTimeout(500); return true }

  const csvRadio = await page.$('input[type="radio"][value="CSV"], input[type="radio"][value="csv"]')
  if (csvRadio) { await csvRadio.click(); await page.waitForTimeout(500); return true }

  const selectWithCsv = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll('select'))
    for (const sel of selects) {
      const opt = Array.from(sel.options).find(o =>
        o.text.toLowerCase().includes('csv') || o.value.toLowerCase().includes('csv')
      )
      if (opt) return { id: sel.id, value: opt.value }
    }
    return null
  })
  if (selectWithCsv?.id) {
    // Use attribute selector to handle APEX IDs that may contain colons or other special chars
    await page.selectOption(`select[id="${selectWithCsv.id}"]`, selectWithCsv.value)
    await page.waitForTimeout(500)
    return true
  }

  const anyCSV = await page.$('text=CSV')
  if (anyCSV) { await anyCSV.click(); await page.waitForTimeout(500) }

  // Verify something was actually selected — APEX may have rendered CSV element
  // but not registered the click (e.g. overlays, animation in progress)
  const csvVerified = await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]:checked'))
    if (radios.some(r => (r as HTMLInputElement).value.toLowerCase().includes('csv'))) return true
    const selects = Array.from(document.querySelectorAll('select'))
    if (selects.some(s => s.value.toLowerCase().includes('csv'))) return true
    const active = document.querySelector('.a-IRR-dlg-dlType--active')
    if (active?.textContent?.toLowerCase().includes('csv')) return true
    return false
  }).catch(() => false)

  if (csvVerified) return true
  console.warn('[supportable] selectCsvFormat: no CSV format confirmed selected — proceeding anyway')
  return false
}

// ── Per-account scrape ────────────────────────────────────────────────────────

async function scrapeOneAccount(
  page: Page,
  accountNumber: string,
  isFirst: boolean,
): Promise<{ rows: Record<string, string>[]; page: Page }> {

  if (isFirst) {
    console.log(`[supportable] navigating to portal…`)
    lastNavigationTime = Date.now()
    await page.goto(getPageLandingUrl(page), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(3_000)
    if (SUPPORTABLE_DEBUG) await dumpDom(page, 'landing')

    const onSso = !page.url().includes('supportable.corp.redhat.com')
    if (onSso) {
      console.log(`[supportable] SSO redirect detected (${page.url()}) — waiting for SSO to resolve…`)

      // The APEX SSO callback may call window.close() on the page after completing auth.
      // Race: either the page navigates back to Supportable, OR the page closes.
      let pageClosedByApex = false
      const pageClosePromise = new Promise<void>(resolve => { page.once('close', () => { pageClosedByApex = true; resolve() }) })
      const urlResolvedPromise = page.waitForURL(/supportable\.corp\.redhat\.com/, { timeout: 300_000 }).catch(() => {})
      await Promise.race([urlResolvedPromise, pageClosePromise])

      if (pageClosedByApex) {
        console.log('[supportable] page closed by APEX after SSO — opening fresh page from context')
        page = await _ctx!.newPage()
      }

      // Navigate fresh to the Supportable landing page (session is now in profile)
      console.log('[supportable] navigating fresh to portal after SSO')
      await page.goto(getPageLandingUrl(page), { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3_000)
      if (SUPPORTABLE_DEBUG) await dumpDom(page, 'post-sso-fresh')
    } else {
      // SSO popup (legacy path)
      const popup = await page.waitForEvent('popup', { timeout: 3_000 }).catch(() => null)
      if (popup) {
        console.log(`[supportable] SSO popup detected — waiting for user to complete via VNC at :6080`)
        await popup.waitForEvent('close', { timeout: 300_000 }).catch(() => {})
        console.log('[supportable] SSO popup closed — navigating fresh to portal')
        await page.goto(getPageLandingUrl(page), { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForTimeout(3_000)
        if (SUPPORTABLE_DEBUG) await dumpDom(page, 'post-sso-fresh')
      } else {
        console.log('[supportable] no SSO — session active')
      }
    }

    if (!page.url().includes('supportable.corp.redhat.com')) {
      throw new Error(`SSO login did not complete — still at ${page.url()}`)
    }
  }

  // ── Fill account number ───────────────────────────────────────────────────
  await page.fill('input#P0_ACCOUNT_NUMBER', accountNumber)
  console.log(`[supportable] filled account# ${accountNumber}`)

  // ── Click Go ──────────────────────────────────────────────────────────────
  await page.click('button.button-alt1')
  // Race networkidle vs Export tab appearing — Export tab means page is ready
  await Promise.race([
    page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {}),
    page.waitForSelector('a:has-text("Export")', { timeout: 8_000 }).catch(() => {}),
  ])

  // ── Dismiss APEX error dialog if present (Go triggered server error) ──────
  // Under parallel load APEX may surface an error overlay. Dismiss and throw
  // so the retry loop opens a fresh page rather than proceeding in bad state.
  const apexErrAfterGo = await page.$('button.a-Error-button').catch(() => null)
  if (apexErrAfterGo) {
    console.warn(`[supportable] account ${accountNumber}: APEX error after Go — dismissing and retrying`)
    await apexErrAfterGo.click().catch(() => {})
    await page.waitForTimeout(500)
    throw new Error(`APEX error dialog after Go on account ${accountNumber}`)
  }

  // APEX does JS redirects after Go — probe evaluate before touching DOM
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await page.evaluate(() => 'PROBE_OK')
      break
    } catch {
      console.log(`[supportable] account Go: page still navigating (attempt ${attempt + 1}) — waiting…`)
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
      await page.waitForTimeout(3_000)
    }
  }
  console.log(`[supportable] Go clicked — on ${page.url()}`)

  // ── Click Export tab → navigates to page 22 (SalesReport layout) ──────────
  // After Go, APEX async-renders account detail content on page 1. For most
  // accounts this is < 2s (already covered by the waitForTimeout above). For
  // slow accounts (or inline Customer Info panel accounts like REI/Shutterfly),
  // it can take 5–12s more. Wait up to 12s for any Export anchor to appear.
  //
  // Inline accounts show TWO Export anchors on page 1:
  //   (1) product family table's inline "Export" link (appears first in DOM)
  //   (2) tab row "Export" tab → navigates to page 22  ← correct target
  // Always take the LAST Export anchor — for normal accounts there's only one;
  // for inline accounts this skips the product-table anchor and gets the tab.
  await page.waitForSelector('a:has-text("Export")', { timeout: 12_000 }).catch(() => null)
  const exportLinks = await page.$$('a:has-text("Export")')
  if (exportLinks.length === 0) {
    if (SUPPORTABLE_DEBUG) await dumpDom(page, 'no-export-tab')
    throw new Error(`Account ${accountNumber} not found in APEX (no Export tab after 12s)`)
  }
  await exportLinks[exportLinks.length - 1].click()
  // Race networkidle vs saved_reports dropdown appearing — dropdown means Export page loaded
  await Promise.race([
    page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {}),
    page.waitForSelector('select[id*="_saved_reports"]', { timeout: 5_000 }).catch(() => {}),
  ])
  console.log(`[supportable] Export tab clicked — on ${page.url()}`)

  // ── Select "Sales Export Format" saved report ─────────────────────────────
  const reportSelId = await page.evaluate(() => {
    const sel = document.querySelector('select[id*="_saved_reports"]') as HTMLSelectElement | null
    return sel?.id ?? null
  })
  if (reportSelId) {
    const salesVal = await page.evaluate((id: string) => {
      const sel = document.getElementById(id) as HTMLSelectElement | null
      const opt = Array.from(sel?.options ?? []).find(o =>
        o.text.toLowerCase().includes('sales export') || o.text.toLowerCase().includes('sales')
      )
      return opt?.value ?? null
    }, reportSelId)
    if (salesVal) {
      await page.selectOption(`select[id="${reportSelId}"]`, salesVal)
      // Race networkidle vs Actions button appearing — Actions means report loaded
      await Promise.race([
        page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {}),
        page.waitForSelector('button.a-IRR-button--actions', { timeout: 8_000 }).catch(() => {}),
      ])
      // Extra settle for APEX to finish rendering report data (parallel sessions may be slower)
      await page.waitForTimeout(2_000)
      console.log(`[supportable] selected Sales Export Format report`)
    }
  }

  // ── Dismiss APEX error dialog if present (Export tab or report select triggered it)
  const apexErrBeforeDownload = await page.$('button.a-Error-button').catch(() => null)
  if (apexErrBeforeDownload) {
    console.warn(`[supportable] account ${accountNumber}: APEX error before download — dismissing and retrying`)
    await apexErrBeforeDownload.click().catch(() => {})
    await page.waitForTimeout(500)
    throw new Error(`APEX error dialog before download on account ${accountNumber}`)
  }

  // ── Path B: Extract subscription data from page HTML (no DOM interaction) ──
  // page.content() returns a string — no element clicks, no attachment issues.
  // This is the primary extraction path; CSV download is the fallback.
  try {
    const html = await page.content()
    const htmlRows = parseHtmlTable(html)
    if (htmlRows.length > 0) {
      // Apply same Status=Active filter as the CSV path
      const statusKey = Object.keys(htmlRows[0]).find(k => k.toLowerCase() === 'status') ?? 'Status'
      const activeRows = htmlRows.filter(r => (r[statusKey] ?? '').toLowerCase() === 'active')
      console.log(`[supportable] account ${accountNumber}: HTML extraction: ${activeRows.length} active rows (${htmlRows.length} total)`)

      // Navigate back to landing for next account
      await page.goto(getPageLandingUrl(page), { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(1_500)
      lastNavigationTime = Date.now()

      return { rows: activeRows, page }
    }
    console.log(`[supportable] account ${accountNumber}: HTML extraction found 0 rows — falling back to CSV download`)
  } catch (htmlErr: any) {
    console.warn(`[supportable] account ${accountNumber}: HTML extraction failed (${htmlErr.message}) — falling back to CSV download`)
  }

  // ── Fallback: Download Active rows as CSV via Actions → Download ──────────
  // APEX filter step removed: the dialog it opens intercepts pointer events and
  // blocks the subsequent Actions button click, causing 120s timeouts at scale.
  // Status=Active filtering is applied in code after download.
  // Register the download listener BEFORE clicking Actions — APEX may fire
  // the download event immediately when the CSV format icon is clicked.
  // Promise containment: .catch at creation prevents unhandled rejection if page dies mid-download
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null)

  // Wait for Actions button to be fully interactive (not just present in DOM)
  const actionsBtn = await page.waitForSelector('button.a-IRR-button--actions', { timeout: 10_000 }).catch(() => null)
  if (!actionsBtn) {
    if (SUPPORTABLE_DEBUG) await dumpDom(page, 'no-actions-btn')
    throw new Error(`Actions button not found for account ${accountNumber}`)
  }
  // Small settle — APEX may still be attaching event handlers
  await page.waitForTimeout(1_500)
  await actionsBtn.click()
  await page.waitForTimeout(1_500)

  const downloadLink = await page.waitForSelector(
    'li a:has-text("Download"), [role="menuitem"]:has-text("Download")',
    { timeout: 8_000 }
  ).catch(() => null)
  if (!downloadLink) {
    if (SUPPORTABLE_DEBUG) await dumpDom(page, 'no-download-menuitem')
    throw new Error(`Download menu item not found for account ${accountNumber}`)
  }
  await downloadLink.click()
  await page.waitForTimeout(2_000)

  const csvFormatSelected = await selectCsvFormat(page)
  if (!csvFormatSelected) {
    if (SUPPORTABLE_DEBUG) await dumpDom(page, 'csv-format-selection')
    throw new Error(`Could not select CSV format for account ${accountNumber}`)
  }

  // APEX sometimes fires the download immediately on CSV icon click — check quickly
  let download: Awaited<typeof downloadPromise>
  const quickCheck = await Promise.race([
    downloadPromise.then(d => ({ d, fired: d !== null })),
    page.waitForTimeout(500).then(() => ({ d: null as null, fired: false })),
  ])
  if (quickCheck.fired && quickCheck.d) {
    download = quickCheck.d
  } else {
    // Dialog Download button — jQuery UI primary button, class "ui-button--hot"
    const dlButton = await page.waitForSelector(
      'button.ui-button--hot, button.a-Button--hot, ' +
      '.ui-dialog-buttonpane button:has-text("Download"), ' +
      '.a-IRR-dlg button:has-text("Download")',
      { timeout: 5_000 }
    ).catch(() => null)
    if (!dlButton) {
      if (SUPPORTABLE_DEBUG) await dumpDom(page, 'no-download-button')
      throw new Error(`Download dialog button not found for account ${accountNumber}`)
    }
    await dlButton.click()
    download = await downloadPromise
  }
  if (!download) throw new Error(`CSV download failed for account ${accountNumber} — page may have died`)
  console.log(`[supportable] account ${accountNumber}: CSV download — ${download.suggestedFilename()}`)

  // Check for server-side download failure before attempting to stream
  const dlFailure = await download.failure()
  if (dlFailure) throw new Error(`Download failed for account ${accountNumber}: ${dlFailure}`)

  // Read the download stream into a buffer
  const readable = await download.createReadStream()
  if (!readable) throw new Error(`Could not create read stream for account ${accountNumber}`)
  const chunks: Buffer[] = []
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const csvText = Buffer.concat(chunks).toString('utf-8')
  console.log(`[supportable] account ${accountNumber}: CSV ${csvText.length} bytes`)

  // Parse CSV and filter to active subscriptions
  // Use case-insensitive header lookup in case Supportable changes capitalisation
  const allCsvRows = parseCsvToObjects(csvText)
  const statusKey = Object.keys(allCsvRows[0] ?? {}).find(k => k.toLowerCase() === 'status') ?? 'Status'
  const activeRows = allCsvRows.filter(r => (r[statusKey] ?? '').toLowerCase() === 'active')
  console.log(`[supportable] account ${accountNumber}: ${activeRows.length} active rows (${allCsvRows.length} total)`)

  // ── Navigate back to landing for next account ────────────────────────────
  // Full navigation clears all APEX state — no need to click the Reset button first.
  await page.goto(getPageLandingUrl(page), { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(1_500)
  lastNavigationTime = Date.now()

  return { rows: activeRows, page }
}

// ── Customer name search (account discovery via P0_CUSTOMER_NAME) ─────────────

/**
 * Search Supportable by customer name using the P0_CUSTOMER_NAME wildcard field.
 * Appends % to the name for LIKE matching. Filters results to rows where
 * Country = USA or Web AND Entl Active Cnt > 0.
 *
 * Assumes page is already on the Supportable landing page (SSO already resolved).
 * Returns unique Customer Number values (RH account numbers).
 */
async function discoverAccountNumbersByName(
  page: Page,
  customerName: string,
  supportableName?: string,
): Promise<string[]> {
  // Fill Customer Name with wildcard — try known field IDs
  let fieldId = 'P0_CUSTOMER_NAME'
  for (const candidate of ['P0_CUSTOMER_NAME', 'P0_CUST_NAME', 'P0_CUSTOMER']) {
    const el = await page.$(`input#${candidate}`).catch(() => null)
    if (el) { fieldId = candidate; break }
  }

  // Build ordered list of search terms to try. First hit wins.
  // Handles punctuation mismatches: "Bespin Global U.S." → "Bespin Global US"
  const candidates = buildNameCandidates(customerName, supportableName)

  for (let ci = 0; ci < candidates.length; ci++) {
    const searchTerm = candidates[ci]
    const isRetry = ci > 0

    // Navigate back to this page's OWN app landing page for retries
    // (apps 305-308 from "New Session" must not go back to 304)
    if (isRetry) {
      const appNum = page.url().match(/f\?p=(\d+)/)?.[1] ?? '304'
      const landingUrl = SUPPORTABLE_URL.replace('f?p=304:', `f?p=${appNum}:`)
      await page.goto(landingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
      await page.waitForTimeout(1_500)
    }

    await page.fill(`input#${fieldId}`, `${searchTerm}%`)
    console.log(`[supportable] name-search: filled #${fieldId} with "${searchTerm}%" (candidate ${ci + 1}/${candidates.length}${isRetry ? ' — retry' : ''})`)

    await page.click('button.button-alt1')
    console.log(`[supportable] name-search: Go clicked — on ${page.url().slice(0, 80)}`)
    // Race: results table appearing (fast) vs networkidle (slow fallback)
    await Promise.race([
      page.waitForSelector('table th', { timeout: 10_000 }).catch(() => {}),
      page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {}),
    ])
    // Short settle — APEX may still be rendering, but table header means data is coming
    await page.waitForTimeout(1_500)

    // APEX does multiple JS redirects after submit — probe evaluate before scraping
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.evaluate(() => 'PROBE_OK')
        break
      } catch {
        console.log(`[supportable] name-search: results page still navigating (attempt ${attempt + 1}) — waiting…`)
        await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
        await page.waitForTimeout(1_500)
      }
    }

    // Path B for discovery: parse account numbers from page.content() HTML
    // instead of page.evaluate() DOM interaction — safe for parallel execution
    let html = await page.content().catch(() => '')
    const accountNumbers: string[] = []

    // DIAG: log HTML size and whether key patterns are present
    const hasCustomerInfo = html.includes('Customer Information')
    const hasTableTh = (html.match(/<th/gi) ?? []).length
    const tableCount = (html.match(/<table/gi) ?? []).length
    console.log(`[supportable] name-search: HTML diag for "${searchTerm}%": ${html.length} chars, ${tableCount} tables, ${hasTableTh} <th> elements, customerInfo=${hasCustomerInfo}`)

    // Try 0: detect detail page (APEX auto-navigated to single customer view)
    // When a search matches exactly one customer, APEX skips the results list
    // and goes directly to the Customer Information detail page.
    // APEX renders the panel structure (labels) before populating values via AJAX,
    // so we must wait for digit data to appear near "Account Number" before extracting.
    if (hasCustomerInfo) {
      // Wait for account number data to populate (APEX loads values async)
      const DATA_WAIT_MS = 8_000
      const dataLoaded = await page.waitForFunction(
        () => {
          // Look for any digit sequence (5+ digits) in the page body — indicates data populated
          const body = document.body?.innerText ?? ''
          return /\b\d{5,12}\b/.test(body) && body.includes('Account Number')
        },
        { timeout: DATA_WAIT_MS },
      ).then(() => true).catch(() => false)

      if (dataLoaded) {
        html = await page.content().catch(() => '')
        console.log(`[supportable] name-search: detail page data loaded after wait — re-read ${html.length} chars`)
      } else {
        console.warn(`[supportable] name-search: detail page data did NOT load within ${DATA_WAIT_MS}ms`)
      }

      // Extract account number from detail page — flexible patterns for APEX HTML
      // Pattern 1: Account Number label in td/th, value in adjacent td (handles spans/whitespace)
      const detailAcct = html.match(/Account\s*Number:?\s*<\/(?:td|th|span|b|label)[^>]*>[\s\S]{0,200}?(\d{5,12})/i)
      if (detailAcct?.[1]) {
        console.log(`[supportable] name-search: "${searchTerm}%" → detail page (single match), account# ${detailAcct[1]}`)
        return [detailAcct[1]]
      }
      // Pattern 2: Account Number as plain text label followed by digits (no HTML tag between)
      const plainAcct = html.match(/Account\s*Number:?\s*(\d{5,12})/i)
      if (plainAcct?.[1]) {
        console.log(`[supportable] name-search: "${searchTerm}%" → detail page plain match, account# ${plainAcct[1]}`)
        return [plainAcct[1]]
      }
      // Pattern 3: use page.evaluate to extract from the live DOM (safe read-only operation)
      const domAcct = await page.evaluate(() => {
        const allTds = Array.from(document.querySelectorAll('td, th'))
        for (const td of allTds) {
          if (/Account\s*Number/i.test(td.textContent ?? '')) {
            // Check next sibling cell or next element for a digit value
            const next = td.nextElementSibling
            const val = next?.textContent?.trim() ?? ''
            const m = val.match(/(\d{5,12})/)
            if (m) return m[1]
            // Check parent row for any digit cell after this one
            const row = td.closest('tr')
            if (row) {
              const cells = Array.from(row.querySelectorAll('td'))
              const idx = cells.indexOf(td as HTMLTableCellElement)
              for (let j = idx + 1; j < cells.length; j++) {
                const cm = cells[j].textContent?.trim().match(/(\d{5,12})/)
                if (cm) return cm[1]
              }
            }
          }
        }
        return null
      }).catch(() => null)
      if (domAcct) {
        console.log(`[supportable] name-search: "${searchTerm}%" → detail page DOM extract, account# ${domAcct}`)
        return [domAcct]
      }
    }

    // Try 1: find the results table with Customer Number column
    const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) ?? []
    let foundCustNumTable = false
    for (const tableHtml of tableMatches) {
      const thMatch = tableHtml.match(/<th[^>]*>([\s\S]*?)<\/th>/gi) ?? []
      const headers = thMatch.map(h => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      const custNumIdx = headers.findIndex(h => /customer\s*number/i.test(h))
      if (custNumIdx < 0) continue
      foundCustNumTable = true
      const countryIdx = headers.findIndex(h => /^country$/i.test(h))
      const entlIdx = headers.findIndex(h => /entl.*active/i.test(h))

      let filteredByCountry = 0
      let filteredByEntl = 0
      let totalDataRows = 0
      const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) ?? []
      for (const rowHtml of rowMatches.slice(1)) {
        const tdMatch = rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) ?? []
        const cells = tdMatch.map(td => td.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim())
        if (cells.length < headers.length - 2) continue
        totalDataRows++
        const country = countryIdx >= 0 ? cells[countryIdx] : ''
        const entlActive = entlIdx >= 0 ? parseInt(cells[entlIdx] ?? '0', 10) : 1
        if (country && country !== 'Web' && country !== 'USA') { filteredByCountry++; continue }
        if (entlIdx >= 0 && entlActive === 0) { filteredByEntl++; continue }
        const acct = cells[custNumIdx]?.replace(/\s/g, '')
        if (acct && /^\d{4,12}$/.test(acct) && !accountNumbers.includes(acct)) {
          accountNumbers.push(acct)
        }
      }
      if (totalDataRows > 0 && accountNumbers.length === 0) {
        console.log(`[supportable] name-search: "${searchTerm}%" table had ${totalDataRows} rows but all filtered: ${filteredByCountry} by country, ${filteredByEntl} by entl`)
      }
      if (accountNumbers.length > 0) break
    }

    // Log headers when no Customer Number column found in any table
    // (reuse headers already extracted in the loop above to avoid re-parsing)
    if (!foundCustNumTable && accountNumbers.length === 0 && !hasCustomerInfo && tableMatches.length > 0) {
      // Extract headers only from the first table with <th> elements (likely the data table)
      for (const t of tableMatches) {
        const ths = t.match(/<th[^>]*>([\s\S]*?)<\/th>/gi) ?? []
        const hdrs = ths.map(h => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(h => h.length > 0)
        if (hdrs.length > 0) {
          console.log(`[supportable] name-search: "${searchTerm}%" no Customer Number column found. Headers: [${hdrs.slice(0, 20).join(', ')}]`)
          break
        }
      }
    }

    // Try 2: direct-match fallback — scan for "Account Number:" label in HTML
    if (accountNumbers.length === 0) {
      const directMatch = html.match(/Account\s*Number:?\s*<\/td>\s*<td[^>]*>\s*(\d{5,10})\s*</i)
      const directAccountNumber = directMatch?.[1] ?? ''

      if (directAccountNumber) {
        console.log(`[supportable] name-search: "${searchTerm}%" → direct match, account# ${directAccountNumber}`)
        return [directAccountNumber]
      }
    }

    // Debug: dump HTML to file on failure for post-mortem analysis
    if (accountNumbers.length === 0 && process.env.SUPPORTABLE_DEBUG) {
      const debugDir = `${process.env.CACHE_DIR ?? '/tmp'}/debug`
      const debugFile = `${debugDir}/supportable-${searchTerm.replace(/[^a-zA-Z0-9]/g, '_')}-${Date.now()}.html`
      try {
        const { mkdirSync, writeFileSync } = await import('fs')
        mkdirSync(debugDir, { recursive: true })
        writeFileSync(debugFile, html, { mode: 0o600 })
        console.log(`[supportable] name-search: debug HTML dumped to ${debugFile}`)
      } catch {}
    }

    // Sanity cap: if a broad search returns too many accounts, it's a false positive
    // (e.g. "Taylor%" matching every company with "Taylor" in the name).
    // Reject and try the next candidate instead.
    const MAX_ACCOUNTS_PER_CUSTOMER = 20
    if (accountNumbers.length > MAX_ACCOUNTS_PER_CUSTOMER) {
      console.warn(`[supportable] name-search: "${searchTerm}%" → ${accountNumbers.length} accounts (exceeds ${MAX_ACCOUNTS_PER_CUSTOMER} cap) — likely false positive, skipping`)
      continue  // try next candidate
    }

    console.log(`[supportable] name-search: "${searchTerm}%" → ${accountNumbers.length} account(s): [${accountNumbers.join(', ')}]`)
    if (accountNumbers.length > 0) return accountNumbers
    // 0 results — try next candidate
  }

  return []
}

// ── Public scrape entry point ─────────────────────────────────────────────────

export interface SupportableCustomer {
  name: string
  accountNumbers: string[]
}

export interface SupportableResult {
  customerName:   string
  accountNumbers: string[]
  rows:           Record<string, string>[]
}

export async function runSupportableScrape(
  customers: SupportableCustomer[],
): Promise<SupportableResult[]> {
  if (supportableScrapeRunning) {
    if (supportableScrapeStartedAt && (Date.now() - supportableScrapeStartedAt > STALE_MUTEX_MS)) {
      console.warn(`[supportable] stale mutex (${Math.round((Date.now() - supportableScrapeStartedAt) / 60_000)}m) — resetting`)
      supportableScrapeRunning = false; setLivePageBusy(false)
      supportableScrapeStartedAt = null
    } else {
      throw new Error('Supportable scrape already in progress')
    }
  }
  if (!_ctx) throw new Error('No browser context — connect Red Hat Portal first')

  supportableScrapeRunning = true
  supportableScrapeStartedAt = Date.now()
  lastSupportableError = null
  supportableStatusMessage = 'Connecting to Supportable…'
  markRunning('supportable')
  const _supportableTelemetryStart = Date.now()
  let page = await _ctx.newPage()
  const results: SupportableResult[] = []
  let isFirst = true

  try {
    for (let i = 0; i < customers.length; i++) {
      const customer = customers[i]
      supportableStatusMessage = `Scraping ${customer.name} (${i + 1}/${customers.length})…`
      const allRows: Record<string, string>[] = []

      for (const accountNumber of customer.accountNumbers) {
        try {
          const result = await scrapeOneAccount(page, accountNumber, isFirst)
          allRows.push(...result.rows)
          page = result.page  // may be a fresh page after SSO
          isFirst = false
        } catch (e: any) {
          console.warn(`[supportable] ${customer.name}/${accountNumber}: ${e.message}`)
        }
      }

      console.log(`[supportable] ${customer.name}: ${allRows.length} total rows across ${customer.accountNumbers.length} account(s)`)
      results.push({ customerName: customer.name, accountNumbers: customer.accountNumbers, rows: allRows })
    }

    lastSupportableScrape = new Date().toISOString()
    supportableStatusMessage = null
    return results

  } catch (e: any) {
    lastSupportableError = sanitizeErr(e)
    supportableStatusMessage = null
    throw e
  } finally {
    await page.close().catch(() => {})
    // ScraperStatusStore: record outcome
    const totalRows = results.reduce((sum, r) => sum + r.rows.length, 0)
    recordOutcome('supportable', {
      success: !lastSupportableError,
      recordCount: totalRows,
      durationMs: Date.now() - _supportableTelemetryStart,
      error: lastSupportableError ?? undefined,
    })
    supportableScrapeRunning = false; setLivePageBusy(false)
    supportableScrapeStartedAt = null
  }
}

/**
 * Combined bootstrap flow: for each customer name, discover account numbers via
 * P0_CUSTOMER_NAME wildcard search, then immediately scrape subscriptions for
 * those accounts — all in a single Supportable session.
 *
 * Returns SupportableResult[] with both accountNumbers and subscription rows populated.
 * The caller can write account numbers to customers.json and pass results directly
 * to writeSupportableSheet() without a second Supportable visit.
 *
 * onProgress callback fires after each customer completes.
 */
export async function runSupportableDiscoverAndScrape(
  customers: Array<{ name: string; supportableName?: string }>,
  onProgress?: (done: number, total: number, name: string, accountNumbers: string[], rowCount: number) => void,
  onStatus?: (msg: string) => void,
): Promise<SupportableResult[]> {
  if (supportableScrapeRunning) {
    if (supportableScrapeStartedAt && (Date.now() - supportableScrapeStartedAt > STALE_MUTEX_MS)) {
      console.warn(`[supportable] stale mutex (${Math.round((Date.now() - supportableScrapeStartedAt) / 60_000)}m) — resetting`)
      supportableScrapeRunning = false; setLivePageBusy(false)
      supportableScrapeStartedAt = null
    } else {
      throw new Error('Supportable scrape already in progress')
    }
  }
  if (!_ctx) throw new Error('No browser context — connect Red Hat Portal first')

  supportableScrapeRunning = true
  supportableScrapeStartedAt = Date.now()
  lastSupportableError = null
  supportableStatusMessage = 'Connecting to Supportable…'
  markRunning('supportable')
  const _discoverTelemetryStart = Date.now()

  const _onStatus = (msg: string) => {
    supportableStatusMessage = msg
    onStatus?.(msg)
  }

  const results: SupportableResult[] = []

  try {
    if (!_ctx) throw new Error('Browser context not available — re-authenticate via Setup page')
    let ssoPage = await _ctx.newPage()
    // ── Phase 0: SSO authentication ───────────────────────────────────────────
    console.log(`[supportable] discover+scrape: navigating to portal…`)
    _onStatus('connecting to Supportable…')
    lastNavigationTime = Date.now()
    await ssoPage.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await ssoPage.waitForSelector('input#P0_CUSTOMER_NAME, input#P0_ACCOUNT_NUMBER', { timeout: 5_000 }).catch(() => {
      return ssoPage.waitForTimeout(2_000)
    })

    if (!ssoPage.url().includes('supportable.corp.redhat.com')) {
      console.log(`[supportable] SSO redirect detected — waiting for authentication (up to 5 min)…`)
      _onStatus('SSO authentication — complete login in VNC if prompted…')
      let pageClosedByApex = false
      const closePromise = new Promise<void>(resolve => { ssoPage.once('close', () => { pageClosedByApex = true; resolve() }) })
      await Promise.race([
        ssoPage.waitForURL(/supportable\.corp\.redhat\.com/, { timeout: 300_000 }).catch(() => {}),
        closePromise,
      ])
      if (pageClosedByApex) ssoPage = await _ctx.newPage()
      _onStatus('SSO complete — loading Supportable…')
      await ssoPage.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await ssoPage.waitForSelector('input#P0_CUSTOMER_NAME, input#P0_ACCOUNT_NUMBER', { timeout: 5_000 }).catch(() => {
        return ssoPage.waitForTimeout(2_000)
      })
    }

    if (!ssoPage.url().includes('supportable.corp.redhat.com')) {
      throw new Error(`SSO login did not complete — still at ${ssoPage.url()}`)
    }

    // Close the SSO page — we'll create isolated sessions for actual work
    await ssoPage.close().catch(() => {})

    // Tell RH keep-alive to skip page navigation while we're scraping
    setLivePageBusy(true)

    // ── Phase 1: Parallel discovery using "New Session" isolation ─────────────
    // Split customers needing discovery across parallel APEX sessions.
    console.log(`[supportable] discover+scrape: session active — discovering ${customers.length} customers`)
    _onStatus(`session active — discovering ${customers.length} customers…`)

    interface DiscoveredCustomer { customerName: string; accountNumbers: string[] }
    const discovered: DiscoveredCustomer[] = new Array(customers.length)

    // Separate cached vs needs-discovery customers
    interface DiscoveryJob { originalIndex: number; name: string; supportableName?: string }
    const discoveryJobs: DiscoveryJob[] = []
    for (let di = 0; di < customers.length; di++) {
      const cached = (customers[di] as any).accountNumbers
      if (Array.isArray(cached) && cached.length > 0) {
        console.log(`[supportable] ${customers[di].name}: using ${cached.length} cached account numbers (skipping discovery)`)
        discovered[di] = { customerName: customers[di].name, accountNumbers: cached }
      } else {
        discoveryJobs.push({ originalIndex: di, name: customers[di].name, supportableName: customers[di].supportableName })
      }
    }

    let discoveryPages: Page[] = []

    if (discoveryJobs.length > 0) {
      // Create parallel sessions for discovery — cap at discoveryJobs.length
      const discoverySessionCount = Math.min(DISCOVERY_PARALLEL, discoveryJobs.length)
      _onStatus(`creating ${discoverySessionCount} parallel discovery sessions…`)
      discoveryPages = await createDiscoverySessions(discoverySessionCount)

      // Distribute discovery jobs across sessions
      let discoveryJobIndex = 0
      async function discoveryWorker(workerId: number, page: Page): Promise<void> {
        try {
          while (discoveryJobIndex < discoveryJobs.length) {
            const job = discoveryJobs[discoveryJobIndex++]
            _onStatus(`Discovering: ${job.name} (${discoveryJobIndex}/${discoveryJobs.length})…`)

            // Navigate to landing page before each search
            await page.goto(getPageLandingUrl(page), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e: any) => {
              console.warn(`[supportable] discover-worker-${workerId}: pre-nav failed for "${job.name}": ${e.message}`)
            })
            await page.waitForTimeout(1_500)

            let accountNumbers: string[] = []
            try {
              accountNumbers = await discoverAccountNumbersByName(page, job.name, job.supportableName)
            } catch (e: any) {
              console.warn(`[supportable] discover-worker-${workerId}: name search failed for "${job.name}": ${e.message}`)
            }
            discovered[job.originalIndex] = { customerName: job.name, accountNumbers }
            console.log(`[supportable] discover-worker-${workerId}: "${job.name}" → ${accountNumbers.length} account(s)`)
          }
        } catch (e: any) {
          console.warn(`[supportable] discover-worker-${workerId}: unexpected exit — ${e.message}`)
        }
      }

      await Promise.all(discoveryPages.map((page, i) => discoveryWorker(i, page)))
      // DON'T close discovery pages — reuse them for scrape phase
      // Navigate each back to their own landing page so they're ready for scraping
      await Promise.all(discoveryPages.map(async (page) => {
        await page.goto(getPageLandingUrl(page), { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
        await page.waitForTimeout(1_000)
      }))
      console.log(`[supportable] discovery phase complete — all ${customers.length} customers resolved, ${discoveryPages.length} sessions reused for scraping`)
    }

    // Fill in any gaps (should not happen, but defensive)
    for (let di = 0; di < customers.length; di++) {
      if (!discovered[di]) {
        discovered[di] = { customerName: customers[di].name, accountNumbers: [] }
      }
    }

    // ── Phase 2: Build flat job queue ─────────────────────────────────────────
    interface ScrapeJob { customerName: string; accountNumber: string; customerIndex: number }
    const jobs: ScrapeJob[] = []
    for (let ci = 0; ci < discovered.length; ci++) {
      for (const acct of discovered[ci].accountNumbers) {
        jobs.push({ customerName: discovered[ci].customerName, accountNumber: acct, customerIndex: ci })
      }
    }

    const customerRows: Record<string, string>[][] = discovered.map(() => [])
    const accountsDone: number[] = discovered.map(() => 0)
    let customersDone = 0

    // ── Phase 3: Sequential subscription scrape (one page, one account) ──────
    // Close discovery pages — subscription scrape uses its own page lifecycle
    await closeDiscoveryPages(discoveryPages)

    if (!_ctx) throw new Error('Browser context not available — re-authenticate via Setup page')

    let scrapePage = await _ctx.newPage()
    let accountsOnCurrentPage = 0

    console.log(`[supportable] scrape: ${jobs.length} account(s) across ${discovered.length} customers — sequential mode`)

    for (let ji = 0; ji < jobs.length; ji++) {
      const job = jobs[ji]
      supportableStatusMessage = `Scraping ${job.customerName} (${ji + 1}/${jobs.length})…`
      console.log(`[supportable] scrape: ${job.customerName}/${job.accountNumber} (${ji + 1}/${jobs.length})`)

      // Fresh page every N accounts to prevent V8 heap growth from detached DOM nodes
      if (accountsOnCurrentPage >= ACCOUNTS_PER_PAGE_CYCLE) {
        console.log(`[supportable] page lifecycle: recycling after ${accountsOnCurrentPage} accounts`)
        await scrapePage.goto('about:blank').catch(() => {})
        await scrapePage.close().catch(() => {})
        if (!_ctx) { console.warn('[supportable] scrape: context gone — aborting'); break }
        scrapePage = await _ctx.newPage()
        accountsOnCurrentPage = 0
      }

      await sessionHeartbeat(scrapePage)

      let succeeded = false
      for (let attempt = 1; attempt <= 2 && !succeeded; attempt++) {
        try {
          if (attempt > 1) {
            console.log(`[supportable] scrape: retry ${job.accountNumber} (attempt ${attempt})`)
            await scrapePage.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            await scrapePage.waitForTimeout(2_000)
          }

          const scrapePromise = scrapeOneAccount(scrapePage, job.accountNumber, ji === 0 && attempt === 1)
          scrapePromise.catch(() => {})  // prevent unhandled rejection if timeout wins
          let timeoutId: ReturnType<typeof setTimeout>
          const result = await Promise.race([
            scrapePromise,
            new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error(`wall-clock timeout (${PER_ACCOUNT_TIMEOUT_MS / 1000}s)`)), PER_ACCOUNT_TIMEOUT_MS)
            }),
          ])
          clearTimeout(timeoutId!)
          customerRows[job.customerIndex].push(...result.rows)
          scrapePage = result.page
          succeeded = true
        } catch (e: any) {
          console.warn(`[supportable] scrape: ${job.customerName}/${job.accountNumber} attempt ${attempt}: ${e.message}`)
          const alive = await scrapePage.evaluate(() => true).catch(() => false)
          if (!alive) {
            console.warn(`[supportable] scrape: page died — creating fresh page`)
            await scrapePage.close().catch(() => {})
            if (!_ctx) { console.warn('[supportable] scrape: context gone — aborting'); break }
            scrapePage = await _ctx.newPage()
            accountsOnCurrentPage = 0
          } else {
            await scrapePage.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
            await scrapePage.waitForTimeout(1_500)
          }
        }
      }

      accountsOnCurrentPage++
      accountsDone[job.customerIndex]++
      if (accountsDone[job.customerIndex] === discovered[job.customerIndex].accountNumbers.length) {
        customersDone++
        const { customerName, accountNumbers } = discovered[job.customerIndex]
        const rows = customerRows[job.customerIndex]
        console.log(`[supportable] discover+scrape: ✓ "${customerName}": ${accountNumbers.length} acct(s), ${rows.length} subscription rows`)
        onProgress?.(customersDone, customers.length, customerName, accountNumbers, rows.length)
      }
    }

    // Clean up scrape page
    await scrapePage.goto('about:blank').catch(() => {})
    await scrapePage.close().catch(() => {})

    // ── Phase 4: Assemble results in original customer order ──────────────────
    // Fire onProgress for any customers that had 0 accounts (skipped the worker loop)
    for (let ci = 0; ci < discovered.length; ci++) {
      const { customerName, accountNumbers } = discovered[ci]
      const rows = customerRows[ci]
      results.push({ customerName, accountNumbers, rows })
      if (accountNumbers.length === 0) {
        customersDone++
        onProgress?.(customersDone, customers.length, customerName, [], 0)
      }
    }

    lastSupportableScrape = new Date().toISOString()
    supportableStatusMessage = null
    return results

  } catch (e: any) {
    lastSupportableError = sanitizeErr(e)
    supportableStatusMessage = null
    throw e
  } finally {
    // ScraperStatusStore: record outcome
    const totalRows = results.reduce((sum, r) => sum + r.rows.length, 0)
    recordOutcome('supportable', {
      success: !lastSupportableError,
      recordCount: totalRows,
      durationMs: Date.now() - _discoverTelemetryStart,
      error: lastSupportableError ?? undefined,
    })
    supportableScrapeRunning = false; setLivePageBusy(false)
    supportableScrapeStartedAt = null
  }
}

// ── Google Sheets writer ──────────────────────────────────────────────────────

// Exact column order from the Supportable CSV export
const CSV_HEADERS = [
  'Name', 'Customer Number', 'Account Number', 'Country',
  'First Name', 'Last Name', 'Login', 'Email', 'Phone Num',
  'Internal Sku', 'Ordered Item', 'Product Description', 'Quantity',
  'Status', 'Start Date', 'End Date', 'Contract#', 'Cust PO Number', 'End Customer PO',
]

/**
 * Creates or updates the AE's Supportable Google Sheet.
 *
 * First run (no existingSheetId): creates sheet via Drive API in driveFolderId so it
 * lands in the correct folder. Returns the new spreadsheet ID.
 *
 * Subsequent runs (existingSheetId provided): clears and rewrites data without
 * recreating the file — preserves the sheet ID so bookmarks stay valid.
 *
 * Tabs: "Accounts" summary + one tab per customer with their subscription rows.
 */
export async function writeSupportableSheet(
  results: SupportableResult[],
  aeName: string,
  driveFolderId?: string,
  existingSheetId?: string,
): Promise<string> {
  const auth   = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const sheets = google.sheets({ version: 'v4', auth })

  if (!driveFolderId || !/^[a-zA-Z0-9_-]{10,}$/.test(driveFolderId)) {
    throw new Error(`[supportable] invalid driveFolderId: "${driveFolderId}"`)
  }

  // BKL-S17: never overwrite an existing sheet with empty scrape results
  const hasAnyData = results.some(r => r.accountNumbers.length > 0)
  if (!hasAnyData && existingSheetId) {
    console.warn(`[supportable] ${aeName}: 0 subscription rows returned — skipping write to protect existing sheet data (BKL-S17)`)
    return existingSheetId
  }

  let spreadsheetId: string

  if (existingSheetId) {
    // ── Subsequent run: clear and rewrite existing sheet ──────────────────────
    spreadsheetId = existingSheetId
    console.log(`[supportable] reusing existing sheet ${spreadsheetId}`)

    // Get current sheet tabs to diff against results.
    // If the sheet was manually deleted, fall through to creating a new one.
    let metaRes: Awaited<ReturnType<typeof sheets.spreadsheets.get>>
    try {
      metaRes = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' })
    } catch (e: any) {
      if (e.code === 404 || e.status === 404 || (e.message ?? '').toLowerCase().includes('not found')) {
        console.warn(`[supportable] sheet ${existingSheetId} not found — creating new one`)
        return writeSupportableSheet(results, aeName, driveFolderId, undefined)
      }
      throw e
    }
    const existingTabs = (metaRes.data.sheets ?? []).map(s => s.properties?.title ?? '')
    const requiredTabs = ['Accounts', ...results.map(r => r.customerName.slice(0, 100))]

    // Add missing tabs
    const tabsToAdd = requiredTabs.filter(t => !existingTabs.includes(t))
    // Remove stale tabs (not in required set)
    const tabsToDel = existingTabs.filter(t => !requiredTabs.includes(t))

    if (tabsToAdd.length || tabsToDel.length) {
      const sheetMeta = metaRes.data.sheets ?? []
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            ...tabsToAdd.map(title => ({ addSheet: { properties: { title } } })),
            ...tabsToDel.map(title => {
              const sh = sheetMeta.find(s => s.properties?.title === title)
              return sh ? { deleteSheet: { sheetId: sh.properties!.sheetId! } } : null
            }).filter(Boolean) as object[],
          ],
        },
      })
    }

    // Clear all data tabs (keep header rows)
    for (const tab of requiredTabs) {
      await withQuotaRetry(
        () => sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${tab}'!A1:ZZ` }),
        `clear ${tab}`,
      ).catch(() => {})
    }
  } else {
    // ── First run: create sheet via Drive API with correct parent folder ───────
    const drive = google.drive({ version: 'v3', auth })
    const created = await drive.files.create({
      requestBody: {
        name: `Supportable — ${aeName}`,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        ...(driveFolderId ? { parents: [driveFolderId] } : {}),
      },
      supportsAllDrives: true,
      fields: 'id',
    })
    spreadsheetId = created.data.id!
    console.log(`[supportable] created spreadsheet in folder: ${spreadsheetId}`)

    // Add all tabs in one batchUpdate (sheet starts with one default tab)
    const tabTitles = ['Accounts', ...results.map(r => r.customerName.slice(0, 100))]
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          // Rename the default Sheet1 to Accounts
          { updateSheetProperties: { properties: { sheetId: 0, title: 'Accounts' }, fields: 'title' } },
          // Add remaining tabs
          ...tabTitles.slice(1).map(title => ({ addSheet: { properties: { title } } })),
        ],
      },
    })
  }

  // ── Write Accounts summary tab ─────────────────────────────────────────────
  const accountRows: string[][] = [
    ['Account Name', 'Account ID(s)', 'Alias'],
    ...results.map(r => [sanitizeCell(r.customerName), sanitizeCell(r.accountNumbers.join(', ')), '']),
  ]
  await withQuotaRetry(
    () => sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Accounts!A1',
      valueInputOption: 'RAW',
      requestBody: { values: accountRows },
    }),
    'Accounts tab',
  )
  console.log(`[supportable] wrote Accounts tab (${results.length} customers)`)

  // ── Write per-customer subscription tabs ───────────────────────────────────
  for (const result of results) {
    const tab = result.customerName.slice(0, 100)
    const dataRows: string[][] = [
      CSV_HEADERS,
      ...result.rows.map(row => CSV_HEADERS.map(h => sanitizeCell(row[h] ?? ''))),
    ]
    await withQuotaRetry(
      () => sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${tab}'!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: dataRows },
      }),
      tab,
    )
    console.log(`[supportable] wrote ${result.rows.length} rows → "${tab}"`)
  }

  return spreadsheetId
}
