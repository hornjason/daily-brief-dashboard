/**
 * src/ccsp-tableau-fetch.ts — Issue #15 Step 3
 *
 * Live Tableau fetch path for one POD's CCSP CSV.
 *
 * Owns:
 *   - URL construction against TABLEAU_EMBED_BASE
 *   - page.goto() + login-wall detection
 *   - 5-minute SSO recovery handshake (the human logs in via VNC)
 *   - The `_tableauSessionExpired` flag lifecycle (set, clear, accessors)
 *   - Tableau "Working on it" wait
 *   - CSV download via page.waitForEvent('download')
 *   - parseCsvToObjects() + response classification
 *
 * Does NOT own:
 *   - The shared BrowserContext (ADR-015): caller passes a `page` already
 *     created via `_ctx.newPage()` upstream in `runCcspScrape`. This module
 *     never calls getScrapeContext() or launchPersistentContext.
 *   - The `ccspScrapeRunning || ccspInFlight` mutex: stays in runCcspScrape.
 *   - Cookie save/restore: caller (ccsp-scraper) manages it via the shared ctx.
 *
 * The orchestrator post-filters the returned `rows` per AE via
 * `filterRowsForAe` (src/ccsp-row-filter.ts). This module returns the
 * full unfiltered POD-wide row set plus a classification tag.
 *
 * SCRAPER-RULES.md / ADR-015 invariants preserved: no context creation here.
 */

import type { Page, ElementHandle } from '@playwright/test'
import { readFileSync } from 'fs'
import { parseCsvToObjects } from './csv-parse.ts'
import { parseTerritoryParts } from './ccsp-scraper.ts'

// Direct embed URL — used for URL-based filtering (filter params must precede any hash fragment).
// Tableau Cloud processes ?FilterName=Value on /t/site/views/... URLs server-side.
// This renders the viz without the outer portal shell and applies all filters before the viz loads.
const TABLEAU_EMBED_BASE =
  'https://10ay.online.tableau.com/t/redhatanalytics/views/OverallCloudConsumptionDashboard/CloudConsumption'

const CCSP_DEBUG = process.env.CCSP_DEBUG === 'true'

// -- _tableauSessionExpired state (single owner) ------------------------------

// BKL-UX79: Signal from scraper → bootstrap-orchestrator that Tableau SSO expired.
// When the live navigation lands on the login page, this flag is set so the next
// /api/bootstrap/tableau/session-status call invalidates its cache and re-probes.
//
// Lifecycle (matches pre-extraction behavior in ccsp-scraper.ts exactly):
//   - set(true)  when SSO/login wall detected after navigation
//   - set(false) when login completes successfully inside the wait window
//   - left set(true) when the 5-min wait deadline passes without login
//   - consumed(false) by the bootstrap-orchestrator status endpoint
let _tableauSessionExpired = false

/** Called by the session-status endpoint to check and consume the expired flag. */
export function consumeTableauSessionExpired(): boolean {
  const v = _tableauSessionExpired
  _tableauSessionExpired = false
  return v
}

/** Non-consuming read — safe for polling status endpoints that may be called repeatedly. */
export function peekTableauSessionExpired(): boolean {
  return _tableauSessionExpired
}

/** Set the expired flag — used by callers that detect the login wall outside of fetchPodCsv. */
export function setTableauSessionExpired(value: boolean): void {
  _tableauSessionExpired = value
}

// -- Internal helpers (mirror ccsp-scraper) -----------------------------------

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
      if (el && (await el.isVisible().catch(() => false))) return el
    } catch {
      /* frame may have navigated away */
    }
  }
  return null
}

/** Wait for the Tableau viz to render (Raw Data tab visible = viz is ready). */
async function waitForVizReady(page: Page, aeName: string, maxWaitMs = 45_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    const el = await findEl(page, 'text="Raw Data"')
    if (el) {
      console.log(
        `[ccsp-tableau] ${aeName}: viz ready — Raw Data tab visible (${Math.round((Date.now() - start) / 1000)}s)`,
      )
      return true
    }
    await page.waitForTimeout(1_000)
  }
  console.warn(`[ccsp-tableau] ${aeName}: viz not ready after ${maxWaitMs / 1000}s — proceeding anyway`)
  return false
}

/** Dump DOM info for debugging Tableau page state (CCSP_DEBUG only). */
async function dumpDom(page: Page, label: string): Promise<void> {
  const dumpFrame = async (
    frameUrl: string,
    frameLabel: string,
    evaluate: (fn: () => any) => Promise<any>,
  ) => {
    try {
      const info = await evaluate(() => {
        const els = Array.from(
          document.querySelectorAll(
            'button, a, [role="button"], iframe, [class*="download"], [class*="toolbar"], [class*="filter"], [aria-label]',
          ),
        )
          .slice(0, 50)
          .map((el: any) => ({
            tag: el.tagName.toLowerCase(),
            id: el.id ?? '',
            title: el.getAttribute('title') ?? '',
            aria: el.getAttribute('aria-label') ?? '',
            text: (el.textContent ?? '').trim().slice(0, 60),
            cls: el.className?.toString().slice(0, 80) ?? '',
          }))
        return { url: location.href, els }
      })
      console.log(
        `[ccsp-tableau:dom] ${frameLabel} -- ${info.url}\n` +
          info.els
            .map(
              (e: any) =>
                `  <${e.tag}> id="${e.id}" title="${e.title}" aria="${e.aria}" text="${e.text}" class="${e.cls}"`,
            )
            .join('\n'),
      )
    } catch (e: any) {
      console.warn(`[ccsp-tableau:dom] dump failed (${frameLabel}): ${e.message}`)
    }
  }

  await dumpFrame(page.url(), `${label}:main`, fn => page.evaluate(fn))
  const frames = page.frames().filter(f => f !== page.mainFrame())
  for (let i = 0; i < Math.min(frames.length, 3); i++) {
    const frame = frames[i]
    await dumpFrame(frame.url(), `${label}:frame${i}`, fn => frame.evaluate(fn))
  }
}

// -- Public types -------------------------------------------------------------

export interface TableauFetchInput {
  page: Page
  aeName: string
  territoryFilters: ReturnType<typeof parseTerritoryParts>
  validTerritories: string[]
  years: string[]
  quarters: string[]
}

export interface TableauFetchResult {
  rows: Record<string, string>[]
  classification: 'csv_ok' | 'csv_empty' | 'auth_redirect' | 'csv_zero_rows' | 'csv_summary_view'
  /** Hook so the caller (orchestrator) can save the freshened Tableau cookies post-login. */
  loggedInDuringFetch: boolean
}

// -- Live fetch ---------------------------------------------------------------

/**
 * Navigate to Tableau, recover SSO if needed, and download the POD CSV.
 *
 * Returns the full unfiltered POD-wide row set plus a classification tag
 * describing the response shape. The orchestrator is responsible for
 * (a) writing caches and (b) post-filtering territory + quarter via
 * `filterRowsForAe`.
 *
 * Throws when the 5-minute SSO recovery deadline passes without login.
 *
 * SCRAPER-RULES preservation:
 *   - Does NOT acquire the shared BrowserContext — caller passes `page`.
 *   - Does NOT engage the CCSP mutex — caller (`runCcspScrape`) holds it.
 *   - Owns _tableauSessionExpired set/clear so consumeTableauSessionExpired
 *     accessors see a consistent flag.
 */
export async function fetchPodCsv(input: TableauFetchInput): Promise<TableauFetchResult> {
  const { page, aeName, territoryFilters, validTerritories, years, quarters } = input

  // -- Build URL with filters pre-applied -------------------------------------
  // Tableau Cloud supports URL-based filtering (?FilterName=Value) — far more
  // reliable than clicking UI filter dropdowns inside deeply-nested iframes
  // (Main page → Data Visualization iframe → primaryContent iframe).
  // BKL-CCSP-05: Segment, Region, POD derived from territory string.
  const filterParams = new URLSearchParams()
  filterParams.set('Super Geo', 'AMERICAS')
  filterParams.set('Geo', 'NA_COMM')
  filterParams.set('Region', territoryFilters.region)
  filterParams.set('Segment', territoryFilters.segment)
  filterParams.set('Subsegment', territoryFilters.subsegment)
  filterParams.set('Year', years.join(','))
  filterParams.set('Quarter', quarters.join(','))
  if (validTerritories.length > 0) {
    filterParams.set('Subregion', territoryFilters.subregion)
    filterParams.set('POD', territoryFilters.pod)
    // BKL-CCSP-CSV-01: Account Territory filter removed — .csv endpoint returns "\n"
    // when territory filter is applied. POD + Subregion scope the viz correctly;
    // territory filtering is applied client-side after download.
  }
  // Filter params MUST be on /t/site/views/... (not on the #/site/... hash URL,
  // where ?params would be inside the hash fragment and ignored by the server).
  const tableauUrl = `${TABLEAU_EMBED_BASE}?${filterParams.toString().replace(/%2C/gi, ',')}`
  console.log(`[ccsp-tableau] ${aeName}: navigating with pre-applied filters (no territory filter)...`)

  await page.goto(tableauUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {
    console.warn(`[ccsp-tableau] ${aeName}: networkidle timed out — continuing anyway`)
  })
  await page.waitForTimeout(3_000)

  // -- Detect login wall — Tableau redirects to SSO/login when session is invalid
  const currentUrl = page.url()
  const isLoginPage =
    !currentUrl.includes('10ay.online.tableau.com') ||
    currentUrl.includes('/auth') ||
    currentUrl.includes('/login') ||
    (await page
      .$('input[type="password"], input#username, [data-testid="login"]')
      .then(el => !!el)
      .catch(() => false))

  let loggedInDuringFetch = false

  if (isLoginPage) {
    console.log(`[ccsp-tableau] ${aeName}: Tableau SSO detected — waiting up to 5 min for manual login via VNC`)
    _tableauSessionExpired = true
    const deadline = Date.now() + 5 * 60 * 1000
    let loggedIn = false
    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000)
      const url = page.url()
      if (!url.startsWith('https://10ay.online.tableau.com')) continue
      await page.waitForTimeout(1_500)
      if (page.url() !== url) continue
      const noLoginForm = await page
        .evaluate(() => {
          const els = Array.from(
            document.querySelectorAll('input[type="password"], input#username, [data-testid="login"]'),
          )
          return !els.some(el => {
            const s = window.getComputedStyle(el)
            return (
              s.display !== 'none' && s.visibility !== 'hidden' && (el as HTMLElement).offsetParent !== null
            )
          })
        })
        .catch(() => false)
      const hasTableauContent = await page
        .$('.tab-glassPane, iframe[id^="tableau"]')
        .then(el => !!el)
        .catch(() => false)
      if (noLoginForm && hasTableauContent) {
        console.log(`[ccsp-tableau] ${aeName}: Tableau login detected — continuing`)
        _tableauSessionExpired = false
        loggedIn = true
        loggedInDuringFetch = true
        break
      }
    }
    if (!loggedIn) {
      console.warn(`[ccsp-tableau] ${aeName}: Tableau login timed out after 5 min — skipping scrape`)
      _tableauSessionExpired = true
      throw new Error('Tableau session required — log in via the VNC window and retry')
    }
  }

  console.log(`[ccsp-tableau] ${aeName}: page loaded, waiting for viz to render...`)
  if (CCSP_DEBUG) await dumpDom(page, `${aeName}-loaded`)

  // Wait for Raw Data tab to appear — indicates viz has fully rendered
  await waitForVizReady(page, aeName)

  // -- Navigate to Raw Data tab -----------------------------------------------
  await page.waitForTimeout(2_000)
  const rawDataTab = await findEl(page, 'text="Raw Data"')
  if (rawDataTab) {
    console.log(`[ccsp-tableau] ${aeName}: clicking Raw Data tab`)
    await rawDataTab.click()
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
    // Tableau shows "Working on it" modal (Processing → Computing → Preparing).
    // Wait for it to disappear before attempting download.
    await page.waitForSelector('text="Working on it"', { timeout: 10_000 }).catch(() => {})
    await page
      .waitForSelector('text="Working on it"', { state: 'hidden', timeout: 60_000 })
      .catch(() => {})
    await page.waitForTimeout(2_000)
  } else {
    console.warn(`[ccsp-tableau] ${aeName}: Raw Data tab not found — attempting download from current view`)
  }

  // Log URL after tab click — if still on CloudConsumption, force the RawData view path.
  // Tableau's Vizql sometimes changes the viz inside the iframe without updating the
  // top-level page URL (especially on the 2nd+ AE in the same session).
  let postTabUrl = page.url()
  if (postTabUrl.includes('/CloudConsumption') && rawDataTab) {
    console.log(`[ccsp-tableau] ${aeName}: URL still on CloudConsumption after Raw Data click — using RawData path`)
    postTabUrl = postTabUrl.replace('/CloudConsumption', '/RawData')
  }
  console.log(`[ccsp-tableau] ${aeName}: URL after tab: ${postTabUrl}`)

  // -- Extract data -----------------------------------------------------------
  let rows: Record<string, string>[] = []
  let classification: TableauFetchResult['classification'] = 'csv_empty'

  // Strategy: Direct server-side CSV URL using TABLEAU_EMBED_BASE (/t/site/views/... format).
  // BKL-CCSP-CSV-01 fix: The old popup download approach failed because Salesforce SSO
  // doesn't pass through in popup windows. The original .csv URL approach returned "\n"
  // because it was built from page.url() (fragment #/site/... format) instead of
  // TABLEAU_EMBED_BASE (server /t/site/... format). The server ignores fragment URLs.
  try {
    const rawDataBase = TABLEAU_EMBED_BASE.replace('/CloudConsumption', '/RawData')
    // BKL-CCSP-CSV-01: Year filter (FY2025,FY2026) returns "\n" from CSV endpoint — endpoint
    // uses a different Year value format than the UI. Quarter filter already constrains the window.
    // Segment/Subsegment=Commercial cause 0 rows for CORP territories — Tableau's data uses
    // different Subsegment values per POD ('Corporate' not 'Commercial').
    // POD + Subregion already uniquely scope the data; Quarter scopes the time window.
    // Diagnostic confirmed: pod-only filter returns 7715 rows; full filter returns 0.
    const csvFilterParams = new URLSearchParams()
    if (validTerritories.length > 0) {
      csvFilterParams.set('Subregion', territoryFilters.subregion)
      csvFilterParams.set('POD', territoryFilters.pod)
    }
    csvFilterParams.set('Quarter', quarters.join(','))
    const csvParams = csvFilterParams.toString().replace(/%2C/gi, ',') // Tableau needs literal commas
    const csvUrl = `${rawDataBase}.csv?${csvParams}`

    console.log(`[ccsp-tableau] ${aeName}: fetching CSV from ${csvUrl}`)

    let csvPath: string | null = null
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        page.goto(csvUrl, { waitUntil: 'commit', timeout: 30_000 }).catch(() => {}),
      ])
      csvPath = await download.path()
      console.log(`[ccsp-tableau] ${aeName}: download captured at ${csvPath}`)
    } catch (e: any) {
      console.warn(`[ccsp-tableau] ${aeName}: CSV download failed: ${e.message}`)
    }

    if (csvPath) {
      const csvText = readFileSync(csvPath, 'utf8')
      rows = parseCsvToObjects(csvText)
      // Classify response so "0 rows" failures are diagnosable (BKL-CONN-TABLEAU-CTX-01)
      if (rows.length === 0) {
        const trimmed = csvText.trim()
        if (trimmed === '' || trimmed === '\n') {
          classification = 'csv_empty'
          console.warn(
            `[ccsp-tableau] ${aeName}: csv_empty — endpoint returned blank body (filter mismatch or auth)`,
          )
        } else if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
          classification = 'auth_redirect'
          console.warn(
            `[ccsp-tableau] ${aeName}: auth_redirect — CSV endpoint returned HTML (SSO redirect, session invalid in shared context)`,
          )
        } else {
          classification = 'csv_zero_rows'
          console.warn(
            `[ccsp-tableau] ${aeName}: csv_zero_rows — parsed 0 rows from non-empty body: ${trimmed.slice(0, 120)}`,
          )
        }
      } else {
        const firstRow = rows[0] ?? {}
        const cols = Object.keys(firstRow)
        const hasAccount = cols.some(c => /account|customer|company/i.test(c))
        const hasAcv = cols.some(c => /acv/i.test(c))
        if (!hasAccount || !hasAcv) {
          classification = 'csv_summary_view'
          console.warn(
            `[ccsp-tableau] ${aeName}: csv_summary_view — ${rows.length} rows but missing required columns; cols: [${cols.slice(0, 8).join(', ')}]`,
          )
        } else {
          classification = 'csv_ok'
          console.log(`[ccsp-tableau] ${aeName}: csv_ok — ${rows.length} rows (unfiltered POD)`)
        }
      }
    }

    // Re-navigate to main Tableau view so next AE scrape starts cleanly
    await page.goto(tableauUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
  } catch (e: any) {
    console.warn(`[ccsp-tableau] ${aeName}: CSV download failed: ${e.message}`)
  }

  if (rows.length === 0 && CCSP_DEBUG) {
    await dumpDom(page, `${aeName}-no-data`)
  }

  return { rows, classification, loggedInDuringFetch }
}
