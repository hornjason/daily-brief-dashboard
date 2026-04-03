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
import type { BrowserContext, Page, Frame, Download } from '@playwright/test'
import { writeFile, readFile, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from './google.ts'
import { sanitizeCell } from './utils.ts'
import { BASE_CHROMIUM_ARGS } from './browser-utils.ts'

export class SfSessionExpiredError extends Error {
  constructor() {
    super('Salesforce session expired — please reconnect via the dashboard')
    this.name = 'SfSessionExpiredError'
  }
}

const SF_BASE_URL       = 'https://redhatcrm.lightning.force.com'
const REPORT_VIEW_URL   = (reportId: string) => `${SF_BASE_URL}/lightning/r/Report/${reportId}/view?queryScope=userFolders`
const KEEPALIVE_URL     = `${SF_BASE_URL}/lightning/n/Home`
const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000  // 10 minutes — more aggressive to prevent session drops
const SESSION_STATE_FILE = 'sf-session-state.json'

// ── CSV helpers (same pattern as supportable-scraper.ts) ─────────────────────

/**
 * Split CSV text into logical lines, keeping quoted fields that contain
 * embedded newlines intact (RFC 4180 multi-line field support).
 */
function splitCsvLines(text: string): string[] {
  const lines: string[] = []
  let current = ''
  let inQuotes = false
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes
    if (ch === '\n' && !inQuotes) {
      if (current.trim()) lines.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) lines.push(current)
  return lines
}

/** Parse one CSV line into field values, handling double-quoted fields and escaped quotes (""). */
function parseCsvRow(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current.trim())
  return fields
}

/** Parse full CSV text into { headers, rows } matching SfReportRow shape. */
function parseCsvToSfReport(text: string): { headers: string[]; rows: string[][] } {
  // Strip UTF-8 BOM
  const clean = text.startsWith('\uFEFF') ? text.slice(1) : text
  const lines = splitCsvLines(clean)
  if (lines.length === 0) return { headers: [], rows: [] }

  const headers = parseCsvRow(lines[0])
  const rows: string[][] = []
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvRow(lines[i])
    // Skip empty rows and SF summary/footer rows (fewer fields than headers)
    if (row.length >= headers.length - 1 && row.some(c => c.length > 0)) {
      // Pad short rows to match header length
      while (row.length < headers.length) row.push('')
      rows.push(row)
    }
  }
  return { headers, rows }
}

/**
 * Attempt CSV export from a Salesforce Lightning report page.
 * Tries multiple UI paths to find and click the Export button.
 * Returns the parsed CSV data or null if export fails.
 *
 * SF Lightning report export UI (as of Spring '26):
 *   - Kebab/dropdown menu near report header → "Export" → format modal → "Export" button
 *   - The format modal lets you pick "Formatted Report" or "Details Only" and format (xlsx/csv)
 */
async function tryCSVExport(page: Page): Promise<{ headers: string[]; rows: string[][] } | null> {
  const t0 = Date.now()
  console.log('[sf-scraper] CSV export: attempting SF report export…')

  try {
    // Strategy 1: Look for the dropdown/kebab menu button in the report header area
    // SF Lightning reports have a dropdown arrow or kebab (⋮) near the report actions
    const menuSelectors = [
      // Lightning report action dropdown — the primary "Export" button in newer SF
      'button[title="Export"]',
      'a[title="Export"]',
      // Kebab menu / more actions in the report header
      'lightning-button-menu button',
      'button[title="Show more actions"]',
      'button[title="More Actions"]',
      // Report header actions area dropdown
      'lightning-primitive-icon[iconname="utility:down"]',
      'button.slds-button_icon-border-filled',
      // Generic dropdown triggers near report controls
      'div.reportHeader button.slds-button',
    ]

    let exportClicked = false

    // First try direct Export button (some SF orgs show it directly)
    for (const sel of menuSelectors.slice(0, 2)) {
      const btn = page.locator(sel).first()
      if (await btn.count().catch(() => 0) > 0) {
        console.log(`[sf-scraper] CSV export: found direct export button via "${sel}"`)
        // Register download listener BEFORE clicking (SF may trigger download immediately)
        const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
        await btn.click()
        // If this was a direct CSV download link, we might get the download now
        const quickDl = await Promise.race([
          downloadPromise.then(d => d),
          page.waitForTimeout(2_000).then(() => null),
        ])
        if (quickDl) {
          const csvText = await readDownloadToString(quickDl)
          if (csvText && csvText.includes(',')) {
            const result = parseCsvToSfReport(csvText)
            console.log(`[sf-scraper] CSV export: direct download — ${result.rows.length} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
            return result
          }
        }
        exportClicked = true
        break
      }
    }

    // Try opening the kebab/dropdown menu to find Export option inside
    if (!exportClicked) {
      for (const sel of menuSelectors.slice(2)) {
        const btn = page.locator(sel).first()
        if (await btn.count().catch(() => 0) > 0) {
          console.log(`[sf-scraper] CSV export: opening menu via "${sel}"`)
          await btn.click()
          await page.waitForTimeout(1_000)

          // Look for "Export" menu item in the dropdown
          const exportItem = page.locator([
            'lightning-menu-item[value="export"]',
            'a[role="menuitem"]:has-text("Export")',
            'span[role="menuitem"]:has-text("Export")',
            'lightning-menu-item:has-text("Export")',
            '[role="menuitem"]:has-text("Export")',
            'a:has-text("Export")',
          ].join(', ')).first()

          if (await exportItem.count().catch(() => 0) > 0) {
            console.log('[sf-scraper] CSV export: found Export menu item — clicking')
            await exportItem.click()
            await page.waitForTimeout(1_500)
            exportClicked = true
            break
          } else {
            // Close menu and try next selector
            await page.keyboard.press('Escape')
            await page.waitForTimeout(500)
          }
        }
      }
    }

    // Also try: in the report iframe (SF reports can be in an iframe)
    if (!exportClicked) {
      const frames = page.frames()
      for (const frame of frames) {
        if (!frame.url().includes('lightningReportApp') && !frame.url().includes('report')) continue
        for (const sel of menuSelectors) {
          const btn = frame.locator(sel).first()
          if (await btn.count().catch(() => 0) > 0) {
            console.log(`[sf-scraper] CSV export: found button in iframe via "${sel}"`)
            await btn.click()
            await page.waitForTimeout(1_000)

            const exportItem = frame.locator('[role="menuitem"]:has-text("Export"), a:has-text("Export")').first()
            if (await exportItem.count().catch(() => 0) > 0) {
              await exportItem.click()
              await page.waitForTimeout(1_500)
              exportClicked = true
              break
            }
          }
        }
        if (exportClicked) break
      }
    }

    if (!exportClicked) {
      console.log('[sf-scraper] CSV export: no export button/menu found — skipping CSV path')
      return null
    }

    // ── Export modal: select format and trigger download ─────────────────────
    // SF export modal has: "Formatted Report" vs "Details Only" radio, and format dropdown (xlsx/csv)
    // We want "Details Only" + CSV format

    // Select "Details Only" if available (gives raw data without grouping/subtotals)
    const detailsOnly = page.locator([
      'input[value="details"]',
      'label:has-text("Details Only")',
      'span:has-text("Details Only")',
    ].join(', ')).first()
    if (await detailsOnly.count().catch(() => 0) > 0) {
      console.log('[sf-scraper] CSV export: selecting "Details Only"')
      await detailsOnly.click()
      await page.waitForTimeout(500)
    }

    // Select CSV format — try dropdown/radio/select
    let csvSelected = false

    // Try format dropdown (SF Lightning uses a combobox or select)
    const formatDropdown = page.locator([
      'select:has(option[value*="csv"])',
      'select:has(option[value*="CSV"])',
      'lightning-combobox',
      'select[name*="format"]',
      'select[name*="encoding"]',
    ].join(', ')).first()

    if (await formatDropdown.count().catch(() => 0) > 0) {
      // Try selecting CSV option
      const tag = await formatDropdown.evaluate(el => el.tagName.toLowerCase()).catch(() => '')
      if (tag === 'select') {
        const csvOptValue = await formatDropdown.evaluate(el => {
          const select = el as HTMLSelectElement
          const opt = Array.from(select.options).find(o =>
            o.text.toLowerCase().includes('csv') || o.value.toLowerCase().includes('csv')
          )
          return opt?.value ?? null
        }).catch(() => null)

        if (csvOptValue) {
          await formatDropdown.selectOption(csvOptValue)
          csvSelected = true
          console.log('[sf-scraper] CSV export: selected CSV from dropdown')
        }
      }
    }

    // Try clicking a CSV label/radio directly
    if (!csvSelected) {
      const csvLabel = page.locator([
        'label:has-text("CSV")',
        'span:has-text(".csv")',
        'input[value*="csv"]',
        'input[value*="CSV"]',
      ].join(', ')).first()
      if (await csvLabel.count().catch(() => 0) > 0) {
        await csvLabel.click()
        csvSelected = true
        console.log('[sf-scraper] CSV export: selected CSV format via label/radio')
      }
    }

    // If we couldn't explicitly select CSV, proceed anyway — SF default might be xlsx
    // which we can't parse, but it's worth trying
    if (!csvSelected) {
      console.log('[sf-scraper] CSV export: could not explicitly select CSV format — proceeding with default')
    }

    // Register download listener and click the modal's Export/Download button
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })

    const exportBtn = page.locator([
      'button:has-text("Export")',
      'button:has-text("Download")',
      'input[type="submit"][value*="Export"]',
      'button.slds-button_brand',
    ].join(', ')).first()

    if (await exportBtn.count().catch(() => 0) > 0) {
      console.log('[sf-scraper] CSV export: clicking final Export/Download button')
      await exportBtn.click()
    } else {
      console.log('[sf-scraper] CSV export: no Export/Download button in modal — aborting CSV path')
      return null
    }

    // Wait for download
    const download = await downloadPromise.catch(() => null)
    if (!download) {
      console.log('[sf-scraper] CSV export: download event not received within 30s — aborting CSV path')
      return null
    }

    const dlFailure = await download.failure()
    if (dlFailure) {
      console.warn(`[sf-scraper] CSV export: download failed — ${dlFailure}`)
      return null
    }

    const filename = download.suggestedFilename()
    console.log(`[sf-scraper] CSV export: download received — ${filename}`)

    // Check it's actually CSV (not xlsx)
    if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
      console.warn('[sf-scraper] CSV export: got Excel format instead of CSV — falling back to DOM')
      return null
    }

    const csvText = await readDownloadToString(download)
    if (!csvText || csvText.length < 10) {
      console.warn('[sf-scraper] CSV export: empty or too-small download — aborting CSV path')
      return null
    }

    const result = parseCsvToSfReport(csvText)
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`[sf-scraper] CSV export: parsed ${result.rows.length} rows, ${result.headers.length} columns in ${elapsed}s`)

    if (result.rows.length === 0) {
      console.warn('[sf-scraper] CSV export: 0 rows parsed from CSV — falling back to DOM')
      return null
    }

    return result
  } catch (e: any) {
    console.warn(`[sf-scraper] CSV export: failed — ${e?.message ?? e}`)
    return null
  }
}

/** Read a Playwright Download into a UTF-8 string. */
async function readDownloadToString(download: Download): Promise<string | null> {
  try {
    const readable = await download.createReadStream()
    if (!readable) return null
    const chunks: Buffer[] = []
    for await (const chunk of readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks).toString('utf-8')
  } catch {
    return null
  }
}

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
    args: ['--headless=new', '--disable-blink-features=AutomationControlled', ...BASE_CHROMIUM_ARGS],
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
    await writeFile(resolve(_profileDir, SESSION_STATE_FILE), JSON.stringify(state), { mode: 0o600 })
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
  droppedColumns?: string[]
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
  await page.setViewportSize({ width: 3840, height: 20000 })  // Extra wide to capture all report columns without horizontal scroll

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

    // ── PRIMARY PATH: CSV Export (BKL-M56) ────────────────────────────────────
    // Try the SF report's built-in Export button first — downloads CSV in seconds
    // instead of the 11+ minute DOM scroll+parse approach.
    // Falls back to DOM parsing if CSV export fails for any reason.

    const scrapeT0 = Date.now()
    const csvResult = await tryCSVExport(page)

    if (csvResult && csvResult.rows.length > 0) {
      // CSV export succeeded — apply the same KEEP_COLS filter as DOM path
      let { headers, rows: dataRows } = csvResult

      const KEEP_COLS = new Set([
        'Opportunity ID', 'Opportunity Number', 'Account Name', 'Opportunity Name',
        'ACV Opportunity', 'ACV Opportunity Product', 'Close Date', 'Close Month',
        'Forecast Category', 'Opportunity Owner', 'Offering Group', 'Product Code',
        'Opportunity Pod', 'Product Description', 'Renewal', 'Next Steps', 'Industry',
      ])
      const keepIdx = headers.reduce<number[]>((acc, h, i) => {
        if (KEEP_COLS.has(h)) acc.push(i)
        return acc
      }, [])
      const finalHeaders = keepIdx.length >= 3 ? keepIdx.map(i => headers[i]) : headers
      const finalRows    = keepIdx.length >= 3 ? dataRows.map(row => keepIdx.map(i => row[i] ?? '')) : dataRows

      const keptHeaders = new Set(keepIdx.map(i => headers[i]))
      const droppedColumns = keepIdx.length >= 3
        ? headers.filter(h => !keptHeaders.has(h))
        : []
      if (droppedColumns.length > 0) {
        console.warn(`[sf-scraper] CSV path: dropped ${droppedColumns.length} column(s) not in KEEP_COLS: ${droppedColumns.join(', ')}`)
      }

      const elapsed = ((Date.now() - scrapeT0) / 1000).toFixed(1)
      console.log(`[sf-scraper] CSV export: downloaded ${finalRows.length} rows in ${elapsed}s (report ${reportId})`)

      await persistSessionState()
      return { headers: finalHeaders, rows: finalRows, droppedColumns }
    }

    // ── FALLBACK: DOM scroll+parse ──────────────────────────────────────────────
    console.log('[sf-scraper] CSV export path did not succeed — falling back to DOM scroll+parse')

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
    console.log('[sf-scraper] DOM fallback: table found in lightningReportApp frame')

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

    // ── Extract rows from the DOM (single evaluate call for speed) ────────────
    // Previous approach: 686 individual Playwright calls (1-2s each = 10+ min)
    // New approach: one page.evaluate() extracting all rows at once (~1-2s total)
    const rows: string[][] = await targetFrame.evaluate((sel: string) => {
      const trs = Array.from(document.querySelectorAll(sel))
      return trs
        .map(tr => Array.from(tr.querySelectorAll('td, th[scope="row"]')).map(cell => (cell.textContent ?? '').trim()))
        .filter(cells => cells.some(c => c.length > 0))
    }, ROW_SEL).catch(() => [] as string[][])

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

    const keptHeaders = new Set(keepIdx.map(i => headers[i]))
    const droppedColumns = keepIdx.length >= 3
      ? headers.filter(h => !keptHeaders.has(h))
      : []
    if (droppedColumns.length > 0) {
      console.warn(`[sf-scraper] dropped ${droppedColumns.length} column(s) not in KEEP_COLS: ${droppedColumns.join(', ')}`)
    }

    const result = { headers: finalHeaders, rows: finalRows, droppedColumns }
    const domElapsed = ((Date.now() - scrapeT0) / 1000).toFixed(1)
    console.log(`[sf-scraper] DOM fallback: report ${reportId}: ${result.headers.length} columns, ${result.rows.length} data rows (${rows.length} raw) in ${domElapsed}s`)

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
 * Clears and rewrites the "Pipeline" tab on each sync.
 *
 * @param data         Scraped report data
 * @param spreadsheetId  Target sheet ID (from aes.json pipelineSheetId or PIPELINE_FILE_ID env fallback)
 */
export async function writePipelineSheet(data: SfReportRow, sheetIdParam?: string): Promise<void> {
  const spreadsheetId = sheetIdParam ?? process.env.PIPELINE_FILE_ID
  if (!spreadsheetId) throw new Error('[sf-scraper] No pipeline sheet ID — set pipelineSheetId in aes.json or PIPELINE_FILE_ID env')
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

  // BKL-S17: never clear + overwrite with 0 data rows
  if (data.rows.length === 0) {
    console.warn(`[sf-scraper] 0 pipeline rows returned — skipping clear+write to protect existing sheet data (BKL-S17)`)
    return
  }

  const values = [data.headers, ...data.rows.map(row => row.map(sanitizeCell))]

  // Clear then rewrite — use a wide range (A1:AZ) to cover any previous syncs
  // that may have written more columns than the current report has.
  await withQuotaRetry(
    () => sheets.spreadsheets.values.clear({ spreadsheetId, range: `${TAB_NAME}!A1:AZ10000` }),
    'clear pipeline',
  ).catch(() => {})

  await withQuotaRetry(
    () => sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${TAB_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values },
    }),
    'pipeline tab',
  )

  console.log(`[sf-scraper] wrote ${data.rows.length} rows + headers to pipeline sheet ${spreadsheetId} tab "${TAB_NAME}"`)
}

/**
 * Create a new pipeline Google Sheet in the AE's Drive folder.
 * Used on first run when no pipelineSheetId exists in aes.json.
 * Returns the new spreadsheet ID.
 */
export async function createPipelineSheet(aeName: string, driveFolderId: string): Promise<string> {
  if (!driveFolderId || !/^[a-zA-Z0-9_-]{10,}$/.test(driveFolderId)) {
    throw new Error(`[sf-scraper] invalid driveFolderId: "${driveFolderId}"`)
  }
  const auth  = makeAuth(GDRIVE_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })
  const created = await drive.files.create({
    requestBody: {
      name: `${aeName} Pipeline`,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [driveFolderId],
    },
    supportsAllDrives: true,
    fields: 'id',
  })
  console.log(`[sf-scraper] created pipeline sheet for ${aeName}: ${created.data.id}`)
  return created.data.id!
}

// ── Combined sync ─────────────────────────────────────────────────────────────

export let lastSfSync: string | null = null
export let lastSfRowCount = 0
export let sfSyncError: string | null = null

/** Update SF sync status from external callers (e.g. scraper-manager) */
export function recordSfSyncSuccess(rowCount: number): void {
  lastSfSync = new Date().toISOString()
  lastSfRowCount = rowCount
  sfSyncError = null
}

/**
 * Full pipeline sync: scrape SF report → write to Google Sheet.
 * @param reportId    Salesforce report ID (from aes.json sfReportId or SF_REPORT_ID env fallback)
 * @param profileDir  Chromium profile directory
 * @param sheetId     Target pipeline sheet ID (from aes.json pipelineSheetId or PIPELINE_FILE_ID env fallback)
 */
export async function runSfPipelineSync(reportId: string, profileDir: string, sheetId?: string): Promise<number> {
  sfSyncError = null
  try {
    const data = await scrapeSfReport(reportId, profileDir)
    await writePipelineSheet(data, sheetId)
    lastSfSync = new Date().toISOString()
    lastSfRowCount = data.rows.length
    return data.rows.length
  } catch (e: any) {
    sfSyncError = 'SF sync failed'
    throw e
  }
}

export interface SfReportItem {
  id: string
  name: string
  url: string
}

/**
 * List available Salesforce reports using the Analytics REST API.
 * Requires an active SF browser context.
 * Returns reports sorted alphabetically by name, capped at 50.
 */
export async function listSfReports(): Promise<SfReportItem[]> {
  if (!_context) throw new Error('SF session not active — log in via Setup first')

  const BASE = 'https://redhatcrm.lightning.force.com'
  const API_VERSION = 'v59.0'

  const tryFetch = async (listType: string): Promise<SfReportItem[]> => {
    const url = `${BASE}/services/data/${API_VERSION}/analytics/reports?listtype=${listType}`
    const res = await _context!.request.get(url, {
      headers: { 'Accept': 'application/json' },
    })
    if (!res.ok()) return []
    const json = await res.json() as any[]
    if (!Array.isArray(json)) return []
    return json
      .filter(r => r.id && r.name && (!r.reportFormat || r.reportFormat === 'SUMMARY' || r.reportFormat === 'TABULAR'))
      .map(r => ({
        id: r.id as string,
        name: r.name as string,
        url: `${BASE}/lightning/r/Report/${r.id}/view`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 50)
  }

  let reports = await tryFetch('recentlyViewed')
  if (reports.length === 0) {
    reports = await tryFetch('owned')
  }
  return reports
}
