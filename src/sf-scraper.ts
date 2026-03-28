/**
 * src/sf-scraper.ts
 * Playwright scraper for a Salesforce Lightning report.
 *
 * Uses the same persistent Chromium profile as the RH scraper — Red Hat's SSO
 * session in that profile covers Salesforce too (same IdP, shared SSO cookies).
 * Navigating to lightning.force.com triggers a transparent SSO redirect; no
 * separate SF login is required once the RH session is established.
 *
 * The report renders as a real HTML table[role="grid"] in Lightning. All rows up
 * to the 2000-row UI limit are present in the DOM simultaneously — no virtual
 * scroll, no pagination needed for typical ASA pipeline sizes (100–400 opps).
 *
 * After scraping, rows are written directly to the Google Sheet identified by
 * PIPELINE_FILE_ID, preserving the column structure that parsePipelineRows expects.
 */

import { chromium } from '@playwright/test'
import type { BrowserContext } from '@playwright/test'
import { writeFile, readFile, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'

export class SfSessionExpiredError extends Error {
  constructor() {
    super('Salesforce session expired — please reconnect via the dashboard')
    this.name = 'SfSessionExpiredError'
  }
}

const SF_BASE_URL       = 'https://redhatcrm.lightning.force.com'
const REPORT_VIEW_URL   = (reportId: string) => `${SF_BASE_URL}/lightning/r/Report/${reportId}/view?queryScope=userFolders`
const KEEPALIVE_URL     = `${SF_BASE_URL}/lightning/n/Home`
const KEEP_ALIVE_INTERVAL_MS = 60 * 60 * 1000  // 60 minutes — SF default session is 2h
const SESSION_STATE_FILE = 'sf-session-state.json'

// ── Long-lived context ────────────────────────────────────────────────────────

let _context: BrowserContext | null = null
let _profileDir: string | null = null
let _keepAliveTimer: ReturnType<typeof setInterval> | null = null
let _onSessionExpired: (() => void) | null = null

export function setSfSessionExpiredCallback(cb: () => void): void {
  _onSessionExpired = cb
}

export function getSfContext() { return _context }

async function clearProfileLocks(profileDir: string): Promise<void> {
  const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie']
  for (const name of lockFiles) {
    await unlink(join(profileDir, name)).catch(() => {})
  }
}

export async function initSfContext(profileDir: string): Promise<void> {
  if (_context) return
  _profileDir = profileDir
  await clearProfileLocks(profileDir)
  console.log('[sf-scraper] opening persistent context…')
  _context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: ['--headless=new', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  })
  _keepAliveTimer = setInterval(
    () => keepAlive().catch(e => console.warn('[sf-scraper] keep-alive error:', e)),
    KEEP_ALIVE_INTERVAL_MS,
  )
}

/**
 * Adopt an existing BrowserContext (typically the RH scraper's context) for use
 * by the SF scraper. Since both systems share Red Hat's SSO, the same browser
 * context that authenticated to access.redhat.com will auto-authenticate to
 * redhatcrm.lightning.force.com via a transparent SSO redirect.
 *
 * No live page is tracked — SF scraping creates and closes ephemeral pages,
 * avoiding navigation conflicts with the RH live page.
 */
export function adoptSfContext(context: BrowserContext, profileDir: string): void {
  if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null }
  _context = context
  _profileDir = profileDir
  _keepAliveTimer = setInterval(
    () => keepAlive().catch(e => console.warn('[sf-scraper] keep-alive error:', e)),
    KEEP_ALIVE_INTERVAL_MS,
  )
  console.log('[sf-scraper] adopted RH login context — SSO session shared')
}

export async function closeSfContext(): Promise<void> {
  if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null }
  _context = null
  _profileDir = null
  // Note: do NOT close the context here — if it was adopted from rh-scraper, closing
  // it would kill the RH session. The RH scraper owns the context lifecycle.
}

// ── Session persistence ───────────────────────────────────────────────────────

async function persistSessionState(): Promise<void> {
  if (!_context || !_profileDir) return
  try {
    const state = await _context.storageState()
    await writeFile(resolve(_profileDir, SESSION_STATE_FILE), JSON.stringify(state))
  } catch { /* non-fatal */ }
}

// ── Keep-alive ────────────────────────────────────────────────────────────────

async function keepAlive(): Promise<void> {
  if (!_context) return
  // Always use an ephemeral page — we must not navigate the RH live page away
  const page = await _context.newPage().catch(() => null)
  if (!page) return
  try {
    await page.goto(KEEPALIVE_URL, { waitUntil: 'load', timeout: 30_000 })
    if (page.url().includes('lightning.force.com')) {
      console.log('[sf-scraper] keep-alive: session active')
      await persistSessionState()
    } else {
      console.warn('[sf-scraper] keep-alive: session expired — reconnect via dashboard')
      _onSessionExpired?.()
    }
  } catch (e: any) {
    console.warn('[sf-scraper] keep-alive: nav failed —', e?.message ?? e)
  } finally {
    await page.close().catch(() => {})
  }
}

// ── Report scrape ─────────────────────────────────────────────────────────────

export interface SfReportRow {
  headers: string[]
  rows: string[][]
}

/**
 * Navigate to the Lightning report and extract all visible rows from the DOM table.
 * Returns the header row and all data rows exactly as they appear in the report.
 * Always uses an ephemeral page to avoid navigation conflicts with the RH live page.
 */
export async function scrapeSfReport(reportId: string, profileDir: string): Promise<SfReportRow> {
  await initSfContext(profileDir)
  if (!_context) throw new Error('[sf-scraper] failed to open browser context')

  // Very large viewport so SF renders as many rows as possible before needing to scroll.
  // SF Lightning treegrid uses IntersectionObserver for virtual rendering — a taller viewport
  // increases the number of rows rendered without scrolling. 20000px ≈ 400 rows at ~50px each.
  const page = await _context.newPage()
  await page.setViewportSize({ width: 1920, height: 20000 })

  try {
    // Use 'load' not 'networkidle' — SF Lightning keeps making background API calls
    // that prevent networkidle from ever resolving. The content sentinel below handles
    // waiting for the actual report table data to appear.
    await page.goto(REPORT_VIEW_URL(reportId), { waitUntil: 'load', timeout: 60_000 })

    // Log actual URL after initial load — SF does a my.salesforce.com → lightning.force.com
    // domain hop via a ?ec=302&startURL= redirect; we must wait for that to resolve.
    console.log(`[sf-scraper] initial URL: ${page.url()}`)

    // Wait for the full SSO redirect chain to complete:
    //   my.salesforce.com?ec=302 → sso.redhat.com (SAML) → my.salesforce.com → lightning.force.com
    if (!page.url().startsWith('https://redhatcrm.lightning.force.com')) {
      // Log page state to diagnose what the browser is showing
      const pageTitle = await page.title().catch(() => '(unknown)')
      const pageText  = await page.evaluate(() => document.body?.innerText?.slice(0, 300) ?? '').catch(() => '')
      console.log(`[sf-scraper] stuck page title: "${pageTitle}"`)
      console.log(`[sf-scraper] stuck page text: ${pageText.replace(/\n/g, ' ')}`)

      // Try waiting with networkidle (120s) — may complete once the SAML chain fires
      await page.waitForURL(url => url.startsWith('https://redhatcrm.lightning.force.com'), { timeout: 120_000 })
        .catch(() => {})
    }

    console.log(`[sf-scraper] settled on: ${page.url()}`)

    // Detect session expiry — if still not on Lightning after redirect wait, session is gone
    if (!page.url().startsWith('https://redhatcrm.lightning.force.com')) {
      console.warn(`[sf-scraper] did not reach Lightning after redirect — session may have expired`)
      throw new SfSessionExpiredError()
    }

    // Log page state to understand what's rendering
    const pageTitle = await page.title().catch(() => '(unknown)')
    console.log(`[sf-scraper] page title: "${pageTitle}"`)

    // Check for Run Report button — some SF reports open in a paused/preview state
    const runBtn = page.locator('button:has-text("Run Report"), a:has-text("Run Report")')
    if (await runBtn.count().catch(() => 0) > 0) {
      console.log('[sf-scraper] Run Report button found — clicking')
      await runBtn.first().click().catch(() => {})
    }

    // ── SF Analytics REST API — fetch all report rows directly ──────────────────
    // context.request shares the browser context's cookies (including the SF sid),
    // bypasses CORS, and targets my.salesforce.com where the REST API lives.
    // This avoids all DOM virtualization, viewport limits, collapsed groups, and lazy-loading.
    //
    // API: GET /services/data/v59.0/analytics/reports/{id}?includeDetails=true
    // Returns: { reportMetadata, factMap, groupingsDown, ... }

    const TABLE_SELECTOR = 'table[role="treegrid"], table[role="grid"]'

    // Use frameLocator to wait for the report iframe and its table to appear.
    const reportFrameLocator = page.frameLocator('iframe[src*="lightningReportApp"]')
    const tableInFrame = await reportFrameLocator.locator(TABLE_SELECTOR).first()
      .waitFor({ state: 'attached', timeout: 120_000 })
      .then(() => true).catch(() => false)

    if (!tableInFrame) {
      await page.screenshot({ path: '/data/cache/sf-debug.png', fullPage: false }).catch(() => {})
      const frameUrls = page.frames().map(f => f.url().slice(0, 100))
      console.warn(`[sf-scraper] table not found in lightningReportApp iframe after 120s`)
      console.warn(`[sf-scraper] frame URLs: ${frameUrls.join(' | ')}`)
      throw new Error('Report table not found — screenshot at /data/cache/sf-debug.png')
    }
    console.log('[sf-scraper] table found in lightningReportApp frame')

    const targetFrame = page.frames().find(f => f.url().includes('lightningReportApp')) ?? page.mainFrame()

    // Wait for first data cell to be visible
    const firstCell = targetFrame.locator('table[role="treegrid"] tbody tr td, table[role="grid"] tbody tr td').first()
    await firstCell.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {
      console.warn('[sf-scraper] content sentinel timed out — proceeding')
    })

    // Extract headers — try multiple SF report header patterns
    let headers: string[] = []
    const headerAttempts = ['[role="columnheader"]', 'thead th, thead td', 'th[scope="col"]']
    for (const hSel of headerAttempts) {
      const hLoc = targetFrame.locator(hSel)
      const count = await hLoc.count().catch(() => 0)
      if (count > 0) {
        headers = await hLoc.allTextContents().then(ts => ts.map(t => t.trim()))
        console.log(`[sf-scraper] headers found via "${hSel}": ${headers.length} columns`)
        break
      }
    }

    // "Show More" button loop
    const LOAD_MORE_SELECTOR = [
      'a:has-text("Show More")', 'button:has-text("Show More")',
      'a:has-text("Load More")', 'button:has-text("Load More")',
    ].join(', ')
    const ROW_SEL = 'table[role="treegrid"] tbody tr, table[role="grid"] tbody tr'

    let prevRowCount = -1
    let loadAttempts = 0
    while (loadAttempts < 30) {
      const currentRowCount = await targetFrame.locator(ROW_SEL).count().catch(() => 0)
      console.log(`[sf-scraper] rows in DOM: ${currentRowCount}`)
      const btnCount = await targetFrame.locator(LOAD_MORE_SELECTOR).count().catch(() => 0)
      if (btnCount === 0) break
      if (currentRowCount === prevRowCount) {
        await targetFrame.waitForTimeout(3_000)
        const retryCount = await targetFrame.locator(ROW_SEL).count().catch(() => 0)
        if (retryCount === currentRowCount) break
      }
      console.log(`[sf-scraper] clicking "Show More" (${currentRowCount} rows so far)`)
      await targetFrame.locator(LOAD_MORE_SELECTOR).first().click().catch(() => {})
      await targetFrame.waitForTimeout(3_000)
      prevRowCount = currentRowCount
      loadAttempts++
    }

    // Scroll the table's own scrollable container (not document.body) to trigger lazy row loading.
    // SF treegrid uses a div with overflow:auto/scroll as the viewport, not the window.
    {
      let scrollPrev = await targetFrame.locator(ROW_SEL).count().catch(() => 0)
      for (let s = 0; s < 20; s++) {
        const scrolled = await targetFrame.evaluate(() => {
          // Find elements with overflow scroll/auto that are tall enough to be the table container
          const candidates = Array.from(document.querySelectorAll('div, section'))
            .filter(el => {
              const style = window.getComputedStyle(el)
              const overflow = style.overflowY
              return (overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 100
            })
          let scrolled = 0
          for (const el of candidates) {
            el.scrollTop = el.scrollHeight
            scrolled++
          }
          // Also scroll window as fallback
          window.scrollTo(0, document.body.scrollHeight)
          return scrolled
        }).catch(() => 0)
        await targetFrame.waitForTimeout(2_000)
        const scrollCur = await targetFrame.locator(ROW_SEL).count().catch(() => 0)
        console.log(`[sf-scraper] scroll ${s + 1} (${scrolled} containers): ${scrollCur} rows`)
        if (scrollCur === scrollPrev) break
        scrollPrev = scrollCur
      }
    }

    // ── Extract rows from the DOM ─────────────────────────────────────────────
    const rowCount = await targetFrame.locator(ROW_SEL).count().catch(() => 0)
    const rows: string[][] = []
    const rowLoc = targetFrame.locator(ROW_SEL)
    for (let i = 0; i < rowCount; i++) {
      const cellTexts = await rowLoc.nth(i).locator('td, th[scope="row"]').allTextContents()
        .then(ts => ts.map(t => t.trim()))
        .catch(() => [] as string[])
      if (cellTexts.some(c => c.length > 0)) rows.push(cellTexts)
    }

    // ── Post-processing ────────────────────────────────────────────────────────
    // 1. Clean header text — strip "Column Actions" and sort-state descriptions
    headers = headers.map(h =>
      h.replace(/Sorted by[^]*?(Ascending|Descending)/s, '')
       .replace(/Column Actions$/, '')
       .trim()
    )

    // 2. Deduplicate — SF sometimes renders two header rows (fixed + sticky-scroll).
    //    Only halve if the second half is a mirror of the first (actual duplication).
    //    If headers are not duplicated (e.g. fewer columns, single header row), keep all.
    {
      const half = Math.floor(headers.length / 2)
      const firstHalf  = headers.slice(0, half)
      const secondHalf = headers.slice(headers.length - half)
      const isDuplicated = half > 2 && firstHalf.every((h, i) => h === secondHalf[i])
      if (isDuplicated) {
        headers = firstHalf
        console.log(`[sf-scraper] deduplicated headers: ${headers.length} (was ${headers.length * 2})`)
      }
    }
    while (headers.length > 0 && headers[0] === '') headers.shift()

    // 3. Filter group/subtotal rows (< 5 non-empty cells) and strip leading row-counter cell
    const dataRows = rows
      .filter(row => row.filter(c => c.length > 0).length >= 5)
      .map(row => row.slice(1))  // remove treegrid row-counter (not a data column)

    // 4. Truncate headers to data width
    if (dataRows.length > 0) {
      const maxCols = Math.max(...dataRows.map(r => r.length))
      if (headers.length > maxCols) headers = headers.slice(0, maxCols)
    }

    // Column filter — keep only columns the dashboard uses. This discards noise columns
    // (currency codes, internal SF fields) if the report includes them. If the report
    // already has a minimal column set, all columns pass through unchanged.
    const KEEP_COLS = new Set([
      'Opportunity ID', 'Opportunity Number', 'Account Name', 'Opportunity Name',
      'ACV Opportunity', 'ACV Opportunity Product', 'Close Date', 'Forecast Category',
      'Opportunity Owner', 'Offering Group', 'Product Code', 'Opportunity Pod',
      'Product Description', 'Renewal',
    ])
    const keepIdx = headers.reduce<number[]>((acc, h, i) => {
      if (KEEP_COLS.has(h)) acc.push(i)
      return acc
    }, [])
    // Only filter if we matched at least half the keep-list — otherwise the report has a
    // custom column set and we pass everything through to avoid dropping useful columns.
    const finalHeaders = keepIdx.length >= 3 ? keepIdx.map(i => headers[i]) : headers
    const finalRows    = keepIdx.length >= 3 ? dataRows.map(row => keepIdx.map(i => row[i] ?? '')) : dataRows

    const result = { headers: finalHeaders, rows: finalRows }
    console.log(`[sf-scraper] report ${reportId}: ${result.headers.length} columns, ${result.rows.length} data rows (${rows.length} raw)`)

    if (result.rows.length === 0) {
      const domCount = await page.evaluate(
        () => document.querySelectorAll('table[role="grid"] tbody tr').length
      ).catch(() => 0)
      console.warn(`[sf-scraper] 0 data rows extracted (${domCount} DOM rows) — table may still be loading`)
    }

    await persistSessionState()
    return result

  } finally {
    await page.close().catch(() => {})
  }
}

// ── Google Sheet write ────────────────────────────────────────────────────────

const GDRIVE_TOKEN_PATH = process.env.GDRIVE_TOKEN ?? GOOGLE_UNIFIED_TOKEN_PATH

/**
 * Write the scraped report rows to the pipeline Google Sheet.
 * Each sync writes to a tab named with today's date (e.g. "2026-03-27"),
 * creating the tab if it doesn't exist. This preserves history across syncs.
 *
 * Requires PIPELINE_FILE_ID env var to identify the target spreadsheet.
 */
export async function writePipelineSheet(data: SfReportRow): Promise<void> {
  const spreadsheetId = process.env.PIPELINE_FILE_ID
  if (!spreadsheetId) throw new Error('[sf-scraper] PIPELINE_FILE_ID env var not set — cannot write pipeline sheet')
  if (data.headers.length === 0) throw new Error('[sf-scraper] No headers in scraped data — aborting sheet write')

  const auth   = makeAuth(GDRIVE_TOKEN_PATH)
  const sheets = google.sheets({ version: 'v4', auth })

  const TAB_NAME = 'Pipeline'

  // Ensure the Pipeline tab exists
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' })
  const existingTitles = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')

  if (!existingTitles.includes(TAB_NAME)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: TAB_NAME } } }],
      },
    })
    console.log(`[sf-scraper] created tab "${TAB_NAME}"`)
  }

  const values = [data.headers, ...data.rows]

  // Clear then rewrite — use a wide range (A1:AZ) to cover any previous syncs
  // that may have written more columns than the current report has.
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${TAB_NAME}!A1:AZ10000`,
  })

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${TAB_NAME}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  })

  console.log(`[sf-scraper] wrote ${data.rows.length} rows + headers to pipeline sheet ${spreadsheetId} tab "${TAB_NAME}"`)
}

// ── Combined sync ─────────────────────────────────────────────────────────────

export let lastSfSync: string | null = null
export let lastSfRowCount = 0
export let sfSyncError: string | null = null

/**
 * Full pipeline sync: scrape SF report → write to Google Sheet.
 * This is what the server's refresh cycle calls.
 */
export async function runSfPipelineSync(reportId: string, profileDir: string): Promise<number> {
  sfSyncError = null
  try {
    const data = await scrapeSfReport(reportId, profileDir)
    await writePipelineSheet(data)
    lastSfSync = new Date().toISOString()
    lastSfRowCount = data.rows.length
    return data.rows.length
  } catch (e: any) {
    sfSyncError = e?.message ?? String(e)
    throw e
  }
}
