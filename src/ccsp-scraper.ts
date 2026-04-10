import { setLivePageBusy } from "./rh-scraper.ts"
/**
 * src/ccsp-scraper.ts
 *
 * Scrapes Cloud Consumption (CCSP) data from the Tableau dashboard
 * (https://10ay.online.tableau.com — requires Red Hat SSO).
 *
 * Flow per AE:
 *   1. Navigate to the base Cloud Consumption Summary dashboard
 *   2. Apply filters: Super Geo=AMERICAS, Geo=NA_COMM,
 *      Region=NA_COMM_COMMERCIAL, Segment=Commercial,
 *      Year + Quarter = dynamic rolling 1-year window (previous FY + current FY)
 *   3. Apply per-AE Account Territory filter (derived: POD and
 *      Subregion are parsed from the territory string)
 *   4. Navigate to Raw Data tab
 *   5. Download CSV via Tableau's Download button
 *   6. Parse CSV and write to Google Sheet in AE's Drive folder
 *
 * Territory values are stored in aes.json as tableauTerritories[].
 * Example: ["WEST_COMM_CORP_NORTHWEST_TERR01"]
 * POD  = first 4 segments: WEST_COMM_CORP_NORTHWEST
 * Sub  = first 3 segments: WEST_COMM_CORP
 *
 * The shared browser context from Red Hat SSO login is reused so
 * Tableau's SSO passthrough works without re-authentication.
 */

// Portal URL (for reference / manual navigation)
// View: OverallCloudConsumptionDashboard / CloudConsumption tab
// Note: Tableau appends ?:iid=N to session URLs — strip it; the base path is what matters
const TABLEAU_BASE_URL = 'https://10ay.online.tableau.com/#/site/redhatanalytics/views/OverallCloudConsumptionDashboard/CloudConsumption'

// Direct embed URL — used for URL-based filtering (filter params must precede any hash fragment).
// Tableau Cloud processes ?FilterName=Value on /t/site/views/... URLs server-side.
// This renders the viz without the outer portal shell and applies all filters before the viz loads.
const TABLEAU_EMBED_BASE = 'https://10ay.online.tableau.com/t/redhatanalytics/views/OverallCloudConsumptionDashboard/CloudConsumption'

import { readFileSync, writeFileSync, existsSync } from 'fs'

const TABLEAU_SESSION_PATH = `${process.env.RH_PROFILE_DIR ?? '/data/rh-profile'}/tableau-session.json`

/** Save Tableau-domain cookies from the active context to disk so they survive container restarts. */
async function saveTableauSession(ctx: BrowserContext): Promise<void> {
  try {
    const state = await ctx.storageState()
    const tableauCookies = state.cookies.filter(c => c.domain.includes('tableau.com') || c.domain.includes('online.tableau'))
    if (tableauCookies.length === 0) return
    writeFileSync(TABLEAU_SESSION_PATH, JSON.stringify({ cookies: tableauCookies, savedAt: new Date().toISOString() }), { mode: 0o600 })
    console.log(`[ccsp] saved ${tableauCookies.length} Tableau cookies to disk`)
  } catch (e: any) {
    console.warn(`[ccsp] could not save Tableau session: ${e.message}`)
  }
}

/** Restore Tableau-domain cookies into the active context from disk. */
async function restoreTableauSession(ctx: BrowserContext): Promise<void> {
  try {
    if (!existsSync(TABLEAU_SESSION_PATH)) return
    const saved = JSON.parse(readFileSync(TABLEAU_SESSION_PATH, 'utf-8'))
    if (!saved.cookies?.length) return
    await ctx.addCookies(saved.cookies)
    console.log(`[ccsp] restored ${saved.cookies.length} Tableau cookies from disk (saved ${saved.savedAt})`)
  } catch (e: any) {
    console.warn(`[ccsp] could not restore Tableau session: ${e.message}`)
  }
}

import type { BrowserContext, Page, ElementHandle } from '@playwright/test'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from './google.ts'
import type { AE } from './types.ts'
import { sanitizeErr, sanitizeCell } from './utils.ts'
import { patchAe } from './server-state.ts'
import { markRunning, recordOutcome } from './scraper-status-store.ts'
import { parseCsvToObjects } from './csv-parse.ts'

/**
 * Search for a VISIBLE element across all frames in the page.
 * Tableau renders viz filters inside the "Data Visualization" iframe — page.$()
 * only searches the main document. Also checks isVisible() to avoid returning
 * hidden/loading elements that cause click() timeouts.
 */
async function findEl(page: Page, selector: string): Promise<ElementHandle<Element> | null> {
  for (const frame of page.frames()) {
    try {
      const el = await frame.$(selector)
      if (el && await el.isVisible().catch(() => false)) return el
    } catch { /* frame may have navigated away */ }
  }
  return null
}

/**
 * Wait for the Tableau viz to render (Raw Data tab visible = viz is ready).
 * Polls every 1s up to maxWaitMs. Returns true when ready.
 */
async function waitForVizReady(page: Page, aeName: string, maxWaitMs = 45_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    const el = await findEl(page, 'text="Raw Data"')
    if (el) {
      console.log(`[ccsp] ${aeName}: viz ready — Raw Data tab visible (${Math.round((Date.now() - start) / 1000)}s)`)
      return true
    }
    await page.waitForTimeout(1_000)
  }
  console.warn(`[ccsp] ${aeName}: viz not ready after ${maxWaitMs / 1000}s — proceeding anyway`)
  return false
}

// -- Module state -------------------------------------------------------------

export let lastCcspScrape: string | null = null
export let lastCcspError:  string | null = null
export let ccspScrapeRunning = false
export let ccspScrapeStartedAt: number | null = null

/** Called by refresh-engine after a sheet-based CCSP cache write (no browser scrape needed). */
export function recordCcspRefreshAt(): void {
  lastCcspScrape = new Date().toISOString()
}
const STALE_MUTEX_MS = 15 * 60 * 1000  // 15 minutes

const CCSP_DEBUG = process.env.CCSP_DEBUG === 'true'

const PER_AE_TIMEOUT_MS = 120_000  // 2 minutes

let _ctx: BrowserContext | null = null

export function adoptCcspContext(ctx: BrowserContext): void {
  _ctx = ctx
  console.log('[ccsp] adopted shared browser context')
  restoreTableauSession(ctx).catch(() => {})
}

export function closeCcspContext(): void {
  _ctx = null
  console.log('[ccsp] browser context released')
}

// -- Result type --------------------------------------------------------------

export interface CcspResult {
  aeName:       string
  rows:         Record<string, string>[]
  accountPeriod: string   // e.g. "2025-Q1 – 2026-Q4" (dynamic rolling window)
}

// -- Helpers ------------------------------------------------------------------

/** Convert a ReadableStream to string */
async function streamToText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/** Dump DOM info for debugging Tableau page state */
async function dumpDom(page: Page, label: string): Promise<void> {
  const dumpFrame = async (frameUrl: string, frameLabel: string, evaluate: (fn: () => any) => Promise<any>) => {
    try {
      const info = await evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, a, [role="button"], iframe, [class*="download"], [class*="toolbar"], [class*="filter"], [aria-label]'))
          .slice(0, 50)
          .map((el: any) => ({
            tag:   el.tagName.toLowerCase(),
            id:    el.id ?? '',
            title: el.getAttribute('title') ?? '',
            aria:  el.getAttribute('aria-label') ?? '',
            text:  (el.textContent ?? '').trim().slice(0, 60),
            cls:   el.className?.toString().slice(0, 80) ?? '',
          }))
        return { url: location.href, els }
      })
      console.log(`[ccsp:dom] ${frameLabel} -- ${info.url}\n` +
        info.els.map((e: any) => `  <${e.tag}> id="${e.id}" title="${e.title}" aria="${e.aria}" text="${e.text}" class="${e.cls}"`).join('\n'))
    } catch (e: any) {
      console.warn(`[ccsp:dom] dump failed (${frameLabel}): ${e.message}`)
    }
  }

  await dumpFrame(page.url(), `${label}:main`, (fn) => page.evaluate(fn))

  const frames = page.frames().filter(f => f !== page.mainFrame())
  for (let i = 0; i < Math.min(frames.length, 3); i++) {
    const frame = frames[i]
    await dumpFrame(frame.url(), `${label}:frame${i}`, (fn) => frame.evaluate(fn))
  }
}

// -- Filter helpers -----------------------------------------------------------

/**
 * CCSP Tableau year + quarter window.
 *
 * RH fiscal year convention in Tableau: FY[N] = Feb[N] – Jan[N+1]
 *   April 2026 → FY2026 (Feb 2026 – Jan 2027)
 *   January 2026 → FY2025 (Feb 2025 – Jan 2026)
 *
 * Selects: current FY + previous FY (matches Jason's manual Tableau selection).
 * Quarters: all 4 quarters of previous calendar year + current calendar year
 *           quarters up to (and including) the current calendar quarter.
 *
 * Example (today = April 2026):
 *   years    = ['FY2025', 'FY2026']
 *   quarters = ['2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4', '2026-Q1', '2026-Q2']
 */
export function getRollingFyWindow(): { years: string[]; quarters: string[]; label: string } {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1 // 1-12

  // RH FY starts Feb 1: if Jan, we're still in previous FY
  const currentFY = month >= 2 ? year : year - 1
  const previousFY = currentFY - 1
  const years = [`FY${previousFY}`, `FY${currentFY}`]

  // Calendar quarter (1-4) based on month
  const currentCalQ = Math.ceil(month / 3)

  // All 4 quarters of previous calendar year + current year up to current quarter
  const quarters: string[] = []
  for (let q = 1; q <= 4; q++) quarters.push(`${previousFY}-Q${q}`)
  for (let q = 1; q <= currentCalQ; q++) quarters.push(`${currentFY}-Q${q}`)

  const label = `${quarters[0]} – ${quarters[quarters.length - 1]}`
  console.log(`[ccsp] window: years=[${years.join(', ')}] quarters=[${quarters.join(', ')}] label="${label}"`)
  return { years, quarters, label }
}

/**
 * Derive POD and Subregion from a territory string.
 * "WEST_COMM_CORP_NORTHWEST_TERR01" → pod="WEST_COMM_CORP_NORTHWEST", sub="WEST_COMM_CORP"
 */
function parseTerritoryParts(territory: string): { pod: string; subregion: string } {
  const parts = territory.split('_')
  // Territory format: REGION_SEG_TYPE_POD_TERR##
  // POD = everything except the last segment (TERR##)
  // Subregion = first 3 segments (REGION_SEG_TYPE)
  const pod = parts.slice(0, -1).join('_')
  const subregion = parts.slice(0, 3).join('_')
  return { pod, subregion }
}

/**
 * Apply a single Tableau filter dropdown.
 * Clicks the dropdown, deselects All, selects the target values, clicks Apply.
 */
async function applyFilter(
  page: Page,
  label: string,
  values: string[],
  aeName: string,
): Promise<boolean> {
  // Tableau filter dropdowns are identified by their label text.
  // Use findEl() so we search all frames — Tableau renders filters inside an iframe.
  const trigger = await findEl(page, `[aria-label="${label}"], select[title*="${label}"]`)
  if (!trigger) {
    // Try finding by nearby text
    const byText = await findEl(page, `text="${label}"`)
    if (!byText) {
      // Filter not found = dashboard has changed or filters aren't loaded yet.
      return false
    }
    // Click the parent dropdown
    const parent = await byText.$('xpath=ancestor::div[contains(@class,"filter") or contains(@class,"dropdown")][1]')
    if (!parent) {
      return false
    }
    await parent.click()
  } else {
    await trigger.click()
  }
  await page.waitForTimeout(800)

  // Deselect (All) first if checked
  const allOption = await findEl(page, 'text="(All)"')
  if (allOption) {
    const checkbox = await allOption.$('xpath=preceding-sibling::input[@type="checkbox"] | ancestor::label/input')
    const checked = await checkbox?.isChecked()
    if (checked) await allOption.click()
    await page.waitForTimeout(300)
  }

  // Select each target value
  for (const val of values) {
    const opt = await findEl(page, `text="${val}"`)
    if (opt) {
      await opt.click()
      await page.waitForTimeout(300)
    } else {
      console.warn(`[ccsp] ${aeName}: filter option "${val}" not found in "${label}"`)
    }
  }

  // Click Apply
  const applyBtn = await findEl(page, 'button:has-text("Apply"), input[value="Apply"]')
  if (applyBtn) await applyBtn.click()
  await page.waitForTimeout(1_500)
  return true
}

// -- Per-AE scrape ------------------------------------------------------------

async function scrapeOneAe(page: Page, ae: AE): Promise<CcspResult> {
  const territories = ae.tableauTerritories ?? []
  const validTerritories = territories.filter(t => {
    if (!/^[A-Z0-9_]+$/.test(t)) {
      console.warn(`[ccsp] skipping invalid territory string: "${t}"`)
      return false
    }
    return true
  })

  // -- Build URL with filters pre-applied -------------------------------------
  // Tableau Cloud supports URL-based filtering (?FilterName=Value) — this is
  // far more reliable than clicking UI filter dropdowns inside deeply-nested
  // iframes (Main page → Data Visualization iframe → primaryContent iframe).
  const { years, quarters, label } = getRollingFyWindow()
  const filterParams = new URLSearchParams()
  filterParams.set('Super Geo', 'AMERICAS')
  filterParams.set('Geo', 'NA_COMM')
  filterParams.set('Region', 'NA_COMM_COMMERCIAL')
  filterParams.set('Segment', 'Commercial')
  filterParams.set('Year', years.join(','))
  filterParams.set('Quarter', quarters.join(','))
  if (validTerritories.length > 0) {
    const { pod, subregion } = parseTerritoryParts(validTerritories[0])
    filterParams.set('Subregion', subregion)
    filterParams.set('POD', pod)
    filterParams.set('Account Territory', validTerritories.join(','))
  }
  // Direct embed URL — filter params MUST be on /t/site/views/... (not on the #/site/... hash URL,
  // where ?params would be inside the hash fragment and ignored by the server).
  const tableauUrl = `${TABLEAU_EMBED_BASE}?${filterParams}`
  console.log(`[ccsp] ${ae.name}: navigating with pre-applied filters...`)

  await page.goto(tableauUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {
    console.warn(`[ccsp] ${ae.name}: networkidle timed out — continuing anyway`)
  })
  await page.waitForTimeout(3_000)

  // Detect login wall — Tableau redirects to SSO/login when session is invalid
  const currentUrl = page.url()
  const isLoginPage = !currentUrl.includes('10ay.online.tableau.com') ||
    currentUrl.includes('/auth') || currentUrl.includes('/login') ||
    await page.$('input[type="password"], input#username, [data-testid="login"]').then(el => !!el).catch(() => false)
  if (isLoginPage) {
    console.warn(`[ccsp] ${ae.name}: Tableau session not active (on login page: ${currentUrl}) — skipping scrape`)
    throw new Error('Tableau session required — log in via the VNC window and retry')
  }

  console.log(`[ccsp] ${ae.name}: page loaded, waiting for viz to render...`)
  if (CCSP_DEBUG) await dumpDom(page, `${ae.name}-loaded`)

  // Wait for Raw Data tab to appear — indicates viz has fully rendered
  await waitForVizReady(page, ae.name)

  // -- Navigate to Raw Data tab -----------------------------------------------
  await page.waitForTimeout(2_000)
  const rawDataTab = await findEl(page, 'text="Raw Data"')
  if (rawDataTab) {
    console.log(`[ccsp] ${ae.name}: clicking Raw Data tab`)
    await rawDataTab.click()
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(3_000)
  } else {
    console.warn(`[ccsp] ${ae.name}: Raw Data tab not found — attempting download from current view`)
  }

  // Log URL after tab click — if still on CloudConsumption, force the RawData view path.
  // Tableau's Vizql sometimes changes the viz inside the iframe without updating the
  // top-level page URL (especially on the 2nd+ AE in the same session).
  let postTabUrl = page.url()
  if (postTabUrl.includes('/CloudConsumption') && rawDataTab) {
    console.log(`[ccsp] ${ae.name}: URL still on CloudConsumption after Raw Data click — using RawData path`)
    postTabUrl = postTabUrl.replace('/CloudConsumption', '/RawData')
  }
  console.log(`[ccsp] ${ae.name}: URL after tab: ${postTabUrl}`)

  // -- Extract data -----------------------------------------------------------
  let rows: Record<string, string>[] = []

  // Strategy 1: direct .csv URL — Tableau Cloud serves CSV when you navigate to
  // /t/site/views/workbook/view.csv?FilterName=Value (server-side, no UI dialog).
  // Handles both hash (#/site/...) and direct (/t/site/...) URL formats.
  try {
    let viewBase: string | null = null
    if (postTabUrl.match(/\/t\/[^/]+\/views\//)) {
      // Direct /t/ format: https://10ay.../t/site/views/workbook/view?...
      viewBase = postTabUrl.split('?')[0]
    } else {
      // Hash format: https://10ay.../#/site/site/views/workbook/view — convert to /t/ format
      const m = postTabUrl.match(/#\/site\/([^/]+)\/views\/([^?#]+)/)
      if (m) viewBase = `https://10ay.online.tableau.com/t/${m[1]}/views/${m[2]}`
    }
    if (viewBase && !viewBase.endsWith('.csv')) {
      const csvUrl = `${viewBase}.csv?${filterParams}`
      console.log(`[ccsp] ${ae.name}: trying direct CSV URL...`)
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30_000 }),
        page.goto(csvUrl, { waitUntil: 'commit', timeout: 30_000 }).catch(() => {}),
      ])
      const csvText = await streamToText(await download.createReadStream())
      rows = parseCsvToObjects(csvText)
      console.log(`[ccsp] ${ae.name}: direct CSV: ${rows.length} rows (unfiltered)`)

      // Post-filter by territory and quarter — Tableau's .csv endpoint ignores URL filter params
      // and returns the full pod/subregion + all-time data set.
      if (rows.length > 0) {
        // Territory filter — column "Account Territory Name"
        if (validTerritories.length > 0) {
          const terrColName = Object.keys(rows[0]).find(k => {
            const norm = k.toLowerCase().replace(/\s+/g, ' ').trim()
            return norm === 'account territory name' || norm === 'account territory'
          })
          if (terrColName) {
            const terrSet = new Set(validTerritories)
            const before = rows.length
            rows = rows.filter(r => terrSet.has((r[terrColName] ?? '').trim()))
            console.log(`[ccsp] ${ae.name}: territory filter: ${before} → ${rows.length} rows`)
          } else {
            console.warn(`[ccsp] ${ae.name}: no territory column found — skipping territory filter. Columns: ${Object.keys(rows[0]).join(', ')}`)
          }
        }

        // Quarter filter — column "Opportunity fiscal Year Quarter" (format: "2026-Q1")
        const qtrColName = Object.keys(rows[0]).find(k =>
          k.toLowerCase().replace(/\s+/g, ' ').trim().includes('fiscal year quarter')
        )
        if (qtrColName) {
          const qtrSet = new Set(quarters)
          const before = rows.length
          rows = rows.filter(r => qtrSet.has((r[qtrColName] ?? '').trim()))
          console.log(`[ccsp] ${ae.name}: quarter filter (${quarters.join(',')}): ${before} → ${rows.length} rows`)
        } else {
          console.warn(`[ccsp] ${ae.name}: no quarter column found — skipping quarter filter`)
        }
      }
    }
  } catch (e: any) {
    console.warn(`[ccsp] ${ae.name}: direct CSV failed: ${e.message} — scraping table`)
  }

  // Strategy 2: DOM table scraping — extract the visible data table directly
  // from the viz iframe. Works for all rows visible in the viewport; Tableau
  // renders data tables as ARIA grids ([role="grid"] / [role="row"]) in the
  // primaryContent iframe. This is the reliable fallback.
  if (rows.length === 0) {
    try {
      // Re-navigate if we left the view for the .csv attempt
      if (!page.url().includes('OverallCloudConsumptionDashboard')) {
        await page.goto(`${TABLEAU_EMBED_BASE}?${filterParams}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await page.waitForTimeout(5_000)
        await waitForVizReady(page, ae.name, 30_000)
        const tab2 = await findEl(page, 'text="Raw Data"')
        if (tab2) { await tab2.click(); await page.waitForTimeout(3_000) }
      }

      for (const frame of page.frames()) {
        const extracted = await frame.evaluate(() => {
          // Tableau uses ARIA grid roles for data tables
          const grids = Array.from(document.querySelectorAll('[role="grid"], table'))
          for (const grid of grids) {
            const headerCells = Array.from(grid.querySelectorAll('[role="columnheader"], th'))
            if (headerCells.length === 0) continue
            const headers = headerCells.map(h => h.textContent?.trim() ?? '')

            const dataRows: Record<string, string>[] = []
            const rowEls = Array.from(grid.querySelectorAll('[role="row"]:not(:has([role="columnheader"])), tr'))
            for (const row of rowEls) {
              const cells = Array.from(row.querySelectorAll('[role="gridcell"], td'))
              if (cells.length === 0) continue
              const obj: Record<string, string> = {}
              cells.forEach((cell, i) => { obj[headers[i] ?? `col${i}`] = cell.textContent?.trim() ?? '' })
              dataRows.push(obj)
            }
            if (dataRows.length > 0) return dataRows
          }
          return null
        }).catch(() => null)

        if (extracted?.length) {
          rows = extracted
          console.log(`[ccsp] ${ae.name}: DOM scrape: ${rows.length} rows from table`)
          break
        }
      }

      if (rows.length === 0) console.warn(`[ccsp] ${ae.name}: DOM table scrape found no rows`)
    } catch (e: any) {
      console.warn(`[ccsp] ${ae.name}: DOM scrape failed: ${e.message}`)
    }
  }

  if (rows.length === 0) {
    if (CCSP_DEBUG) await dumpDom(page, `${ae.name}-no-data`)
    console.warn(`[ccsp] ${ae.name}: could not extract data — returning empty result`)
  }
  return { aeName: ae.name, rows, accountPeriod: label }
}

// -- Public scrape entry point ------------------------------------------------

export async function runCcspScrape(aes: AE[]): Promise<CcspResult[]> {
  if (ccspScrapeRunning) {
    if (ccspScrapeStartedAt && (Date.now() - ccspScrapeStartedAt > STALE_MUTEX_MS)) {
      console.warn(`[ccsp] stale mutex detected (${Math.round((Date.now() - ccspScrapeStartedAt) / 60000)}min) — auto-releasing`)
      ccspScrapeRunning = false; setLivePageBusy(false)
      ccspScrapeStartedAt = null
    } else {
      throw new Error('CCSP scrape already in progress')
    }
  }
  if (!_ctx) throw new Error('No browser context — connect Red Hat Portal first')

  ccspScrapeRunning = true; setLivePageBusy(true)
  ccspScrapeStartedAt = Date.now()
  lastCcspError = null
  markRunning('ccsp')
  const _ccspTelemetryStart = Date.now()

  const results: CcspResult[] = []

  try {
    for (const ae of aes) {
      if (!ae.tableauTerritories?.length) {
        console.warn(`[ccsp] ${ae.name}: no tableauTerritories configured — skipping`)
        continue
      }
      if (!ae.driveFolderId) {
        console.warn(`[ccsp] ${ae.name}: no driveFolderId configured — skipping`)
        continue
      }

      if (!_ctx) throw new Error('Browser context not available — re-authenticate via Setup page')
      // BKL-ADM02: health-check the context before use — a non-null but closed context
      // throws "Target page, context or browser has been closed" on newPage().
      try {
        await _ctx.pages()  // lightweight liveness probe; throws if context is closed
      } catch {
        _ctx = null
        throw new Error('Browser context is closed — re-authenticate via Setup page and retry')
      }
      const page = await _ctx.newPage()
      const scrapePromise = scrapeOneAe(page, ae)
      scrapePromise.catch(() => {})  // suppress orphaned rejection if timeout fires first
      try {
        const result = await Promise.race([
          scrapePromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`AE scrape timed out after ${PER_AE_TIMEOUT_MS / 1000}s`)), PER_AE_TIMEOUT_MS)
          ),
        ])
        results.push(result)
      } catch (e: any) {
        console.warn(`[ccsp] ${ae.name}: ${e.message}`)
        results.push({ aeName: ae.name, rows: [], accountPeriod: getRollingFyWindow().label })
      } finally {
        await page.close().catch(() => {})
      }
    }

    lastCcspScrape = new Date().toISOString()
    if (_ctx) saveTableauSession(_ctx).catch(() => {})
    return results

  } catch (e: any) {
    lastCcspError = sanitizeErr(e)
    throw e
  } finally {
    // ScraperStatusStore: record outcome
    const totalRows = results.reduce((sum, r) => sum + r.rows.length, 0)
    recordOutcome('ccsp', {
      success: !lastCcspError,
      recordCount: totalRows,
      durationMs: Date.now() - _ccspTelemetryStart,
      error: lastCcspError ?? undefined,
    })
    ccspScrapeRunning = false; setLivePageBusy(false)
    ccspScrapeStartedAt = null
  }
}

// -- Google Sheets writer -----------------------------------------------------

/**
 * Creates or updates a Google Sheet named "[AE Name] CCSP" in the AE's
 * Drive folder. If existingSheetId is provided, clears and rewrites it.
 * Returns the spreadsheet ID.
 */
export async function writeCcspSheet(
  results: CcspResult[],
  aeName: string,
  driveFolderId: string,
  existingSheetId?: string,
): Promise<string> {
  const auth   = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const sheets = google.sheets({ version: 'v4', auth })
  const drive  = google.drive({ version: 'v3', auth })

  if (!driveFolderId || !/^[a-zA-Z0-9_-]{10,}$/.test(driveFolderId)) {
    throw new Error(`[ccsp] invalid driveFolderId: "${driveFolderId}"`)
  }

  // BKL-S17: check for empty results BEFORE clearing the existing sheet.
  // Previously the sheet was cleared first, then the empty-rows guard fired —
  // leaving a blank sheet when the Tableau scrape returned 0 rows.
  const allRows = results.flatMap(r => r.rows)
  if (allRows.length === 0 && existingSheetId) {
    console.warn(`[ccsp] ${aeName}: 0 rows returned — skipping write to protect existing sheet data (BKL-S17)`)
    return existingSheetId
  }

  let spreadsheetId: string

  if (existingSheetId) {
    // Clear existing sheet and rewrite
    spreadsheetId = existingSheetId
    console.log(`[ccsp] reusing existing sheet: ${spreadsheetId}`)

    let meta
    try {
      meta = await sheets.spreadsheets.get({ spreadsheetId })
    } catch (err: any) {
      const code = err?.code ?? err?.response?.status
      const msg = (err?.message ?? '').toLowerCase()
      if (code === 404 || msg.includes('not found') || msg.includes('404')) {
        console.warn(`[ccsp] existing sheet ${spreadsheetId} not found (404) — creating new`)
        return writeCcspSheet(results, aeName, driveFolderId, undefined)
      }
      throw err
    }

    // Get existing sheet tabs so we can clear them
    const existingSheets = meta.data.sheets ?? []

    // Delete all tabs except the first, then rename/clear the first
    const requests: any[] = []
    for (let i = existingSheets.length - 1; i > 0; i--) {
      requests.push({ deleteSheet: { sheetId: existingSheets[i].properties!.sheetId } })
    }
    if (requests.length > 0) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } })
    }

    // Clear the first sheet
    const firstTab = existingSheets[0]?.properties?.title ?? 'Sheet1'
    await withQuotaRetry(
      () => sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${firstTab}'!A:ZZ` }),
      'clear CCSP',
    ).catch(() => {})

    // Rename first sheet to "CCSP Data"
    const firstSheetId = existingSheets[0]?.properties?.sheetId
    if (firstSheetId != null) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ updateSheetProperties: {
            properties: { sheetId: firstSheetId, title: 'CCSP Data' },
            fields: 'title',
          }}],
        },
      })
    }
  } else {
    // Create new spreadsheet in AE's Drive folder
    // Note: bootstrap registers the correct sheet ID in aes.json — no Drive search needed here.
    const created = await drive.files.create({
      requestBody: {
        name: `${aeName} CCSP`,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        parents: [driveFolderId],
      },
      supportsAllDrives: true,
      fields: 'id',
    })
    spreadsheetId = created.data.id!
    console.log(`[ccsp] created spreadsheet: ${spreadsheetId} in folder ${driveFolderId}`)

    // Rename "Sheet1" → "CCSP Data" immediately so all subsequent writes use the correct name
    const meta0 = await sheets.spreadsheets.get({ spreadsheetId })
    const firstSheet0 = meta0.data.sheets?.[0]
    if (firstSheet0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ updateSheetProperties: {
            properties: { sheetId: firstSheet0.properties!.sheetId, title: 'CCSP Data' },
            fields: 'title',
          }}],
        },
      })
    }
  }

  // allRows already computed above (before sheet clear), reuse it.
  // The existingSheetId + 0 rows case was handled by the early return above.

  if (allRows.length === 0) {
    // First-run / genuinely empty — write placeholder
    await withQuotaRetry(
      () => sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'CCSP Data!A1',
        valueInputOption: 'RAW',
        requestBody: { values: [['No CCSP data available', '', `Scraped: ${new Date().toISOString()}`]] },
      }),
      'CCSP placeholder',
    )
    console.log(`[ccsp] ${aeName}: no data — wrote placeholder`)
    return spreadsheetId
  }

  // Collect all unique headers across all rows
  const headerSet = new Set<string>()
  for (const row of allRows) {
    for (const key of Object.keys(row)) {
      headerSet.add(key)
    }
  }
  const headers = Array.from(headerSet)

  // BKL-M51: Validate that scraped data has required columns before writing.
  // The Tableau .csv endpoint sometimes returns the summary view (4 cols: Metric cal,
  // Opportunity Close Fiscal Year, Opportunity fiscal Year Quarter, ACV plus) instead
  // of the Raw Data view (~32 cols including Account Name). Writing truncated data
  // overwrites the good data in the sheet and breaks fetchCCSPData() column detection.
  const hasAccountCol = headers.some(h => {
    const lower = h.toLowerCase()
    return lower === 'account name' || lower === 'account' || lower === 'customer name' || lower === 'company'
  })
  const hasAcvCol = headers.some(h => {
    const lower = h.toLowerCase()
    return lower === 'acv plus' || lower === 'acv+' || lower === 'acvplus'
  })
  if (!hasAccountCol || !hasAcvCol) {
    const missing = [!hasAccountCol && 'Account Name', !hasAcvCol && 'ACV Plus'].filter(Boolean).join(', ')
    console.warn(`[ccsp] ${aeName}: scraped data missing required columns (${missing}). Got ${headers.length} columns: [${headers.join(', ')}]. Skipping sheet write to protect existing data. This usually means the Tableau .csv endpoint returned the summary view instead of Raw Data.`)
    if (existingSheetId) return spreadsheetId
    // For new sheets, still write so the sheet exists (but log the warning)
  }

  // Build sheet data: headers + rows (sanitize data rows to prevent formula injection)
  const sheetData: string[][] = [
    headers,
    ...allRows.map(row => headers.map(h => sanitizeCell(row[h] ?? ''))),
  ]

  // Only write if we have required columns (or this is a brand new sheet with no existing data to protect)
  if (hasAccountCol && hasAcvCol) {
    await withQuotaRetry(
      () => sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'CCSP Data'!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: sheetData },
      }),
      'CCSP Data tab',
    )
    console.log(`[ccsp] ${aeName}: wrote ${allRows.length} rows (${headers.length} columns) to CCSP Data tab`)
  }

  return spreadsheetId
}
