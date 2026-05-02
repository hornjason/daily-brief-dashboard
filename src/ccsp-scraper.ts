import { setLivePageBusy, getScrapeContext, ensureBrowserHealthy } from "./rh-scraper.ts"
import { isPrimary } from './lib/node-role.ts'
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
import { resolve } from 'node:path'
import { normalizeSettings } from './region-config.ts'
import { closeTableauTabs, safeCookieOp } from './browser-utils.ts'

const TABLEAU_SESSION_PATH = `${process.env.RH_PROFILE_DIR ?? '/data/rh-profile'}/tableau-session.json`

/** Save Tableau-domain cookies from the active context to disk so they survive container restarts. */
async function saveTableauSession(ctx: BrowserContext): Promise<void> {
  try {
    await closeTableauTabs(ctx, 'saveTableauSession')
    const state = await safeCookieOp(ctx, 'saveTableauSession storageState', c => c.storageState(), { cookies: [], origins: [] })
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
    // Close stale Tableau pages before CDP calls — open Tableau tabs with live WebSocket
    // connections cause ctx.cookies() and ctx.addCookies() to hang indefinitely (BKL-CONN-TABLEAU-CCSP-HANG-01).
    await closeTableauTabs(ctx, 'restoreTableauSession')
    // Only inject disk cookies if the shared context has no live Tableau session.
    // After Option B login (SSO in shared context), the context already has the right
    // cookies — overwriting them with a stale file would break the live session.
    console.log('[ccsp] restoreTableauSession: checking context cookies')
    const existing = await Promise.race([
      ctx.cookies(),
      new Promise<Awaited<ReturnType<typeof ctx.cookies>>>((resolve) =>
        setTimeout(() => { console.warn('[ccsp] restoreTableauSession: ctx.cookies() timed out after 10s — falling through to disk restore'); resolve([]) }, 10_000)
      ),
    ])
    const hasLiveTableau = existing.some(c => c.domain.includes('tableau.com') || c.domain.includes('online.tableau'))
    if (hasLiveTableau) {
      console.log('[ccsp] shared context already has Tableau cookies — skipping disk restore')
      return
    }
    const saved = JSON.parse(readFileSync(TABLEAU_SESSION_PATH, 'utf-8'))
    if (!saved.cookies?.length) return
    console.log('[ccsp] restoreTableauSession: injecting disk cookies into context')
    await Promise.race([
      ctx.addCookies(saved.cookies),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          console.warn('[ccsp] restoreTableauSession: ctx.addCookies() timed out after 10s — skipping inject')
          resolve()
        }, 10_000)
      ),
    ])
    console.log(`[ccsp] restored ${saved.cookies.length} Tableau cookies from disk (saved ${saved.savedAt})`)
  } catch (e: any) {
    console.warn(`[ccsp] could not restore Tableau session: ${e.message}`)
  }
}

import type { BrowserContext, Page, ElementHandle, Download } from '@playwright/test'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from './google.ts'
import type { AE } from './types.ts'
import { sanitizeErr, sanitizeCell } from './utils.ts'
import { patchAe } from './server-state.ts'
import { markRunning, recordOutcome } from './scraper-status-store.ts'
import { parseCsvToObjects } from './csv-parse.ts'
import { filterRowsForAe } from './ccsp-row-filter.ts'
import { tryMemoryCache, tryDriveCache, writeCaches } from './ccsp-cache.ts'

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

/**
 * BKL-BOOT-SCRAPE-ORDER-01: L3 existence check — does today's `CCSP-${pod}-${YYYY-MM-DD}.csv`
 * exist in the POD's Subscription Data Drive folder? Used by bootstrap to skip the heavy
 * L4 Tableau scrape when an L3 cache is already on Drive.
 *
 * Mirrors the exact lookup used in scrapeOneAe (line ~455 of this file): same filename
 * convention, same Drive query. Does NOT download or parse — existence only.
 *
 * Returns true only on a confirmed Drive hit. Returns false on miss, error, or missing inputs
 * — callers fall through to the normal L1→L2→L3→L4 path inside runCcspScrape.
 */
export async function checkCcspL3Exists(ae: AE, podBookingsFolderId: string | undefined): Promise<boolean> {
  if (!podBookingsFolderId) return false
  const territories = (ae.tableauTerritories ?? []).filter(Boolean)
  if (territories.length === 0) return false
  try {
    const podName = parseTerritoryParts(territories[0]).pod
    if (!podName) return false
    const today = new Date().toISOString().slice(0, 10)
    const cacheFileName = `CCSP-${podName}-${today}.csv`
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })
    const listRes = await withQuotaRetry(
      () => drive.files.list({
        q: `name = '${cacheFileName}' and '${podBookingsFolderId}' in parents and trashed = false`,
        fields: 'files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      'CCSP L3 existence check',
    )
    return Boolean(listRes.data.files && listRes.data.files.length > 0)
  } catch (e: any) {
    // Fail-open to false: on any Drive error, defer to runCcspScrape's own resilient path
    console.warn('[ccsp] checkCcspL3Exists: Drive error — falling through to L4:', e?.message ?? e)
    return false
  }
}
const STALE_MUTEX_MS = 15 * 60 * 1000  // 15 minutes

const CCSP_DEBUG = process.env.CCSP_DEBUG === 'true'

const PER_AE_TIMEOUT_MS = 6 * 60_000  // 6 minutes — accommodates SSO wait + viz load

let _ctx: BrowserContext | null = null

// Issue #15 Step 2: in-memory + Drive cache moved to src/ccsp-cache.ts.
// `_podCsvCache` and `POD_CSV_CACHE_TTL_MS` are now owned there (single owner).

// BKL-UX79: Signal from scraper → bootstrap-orchestrator that Tableau SSO expired.
// When scrapeOneAe lands on the login page, it sets this flag so the next
// /api/bootstrap/tableau/session-status call invalidates its cache and re-probes.
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
 * BKL-CCSP-04: Selects last 4 completed calendar quarters only.
 * Tableau only has data for completed quarters — the current in-progress quarter
 * is excluded because its data is incomplete.
 *
 * Example (today = April 2026, Q2 in progress):
 *   last completed = Q1 2026
 *   quarters = ['2025-Q2', '2025-Q3', '2025-Q4', '2026-Q1']
 *   years    = ['FY2025', 'FY2026']
 */
export function getRollingFyWindow(): { years: string[]; quarters: string[]; label: string } {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1 // 1-12

  // Calendar quarter (1-4) based on month
  const currentCalQ = Math.ceil(month / 3)

  // Last completed quarter — exclude current in-progress quarter
  let lastQ = currentCalQ - 1
  let lastYear = year
  if (lastQ === 0) { lastQ = 4; lastYear = year - 1 }

  // Build last 4 completed quarters going backwards from lastQ
  const quarters: string[] = []
  let q = lastQ
  let y = lastYear
  for (let i = 0; i < 4; i++) {
    quarters.unshift(`${y}-Q${q}`)
    q--
    if (q === 0) { q = 4; y-- }
  }

  // Tableau Year filter uses "FYYYYYYY" prefix format (e.g. "FY2025", "FY2026").
  // RH FY starts Feb 1: Q1 spans Jan (previous FY) + Feb-Mar (current FY).
  // For Q1, include both adjacent FYs — Tableau filters are OR-based.
  const fySet = new Set<string>()
  for (const qtr of quarters) {
    const qY = parseInt(qtr.split('-Q')[0], 10)
    const qNum = parseInt(qtr.split('-Q')[1], 10)
    if (qNum === 1) {
      fySet.add(`FY${qY - 1}`)
      fySet.add(`FY${qY}`)
    } else {
      fySet.add(`FY${qY}`)
    }
  }
  const years = [...fySet].sort()

  const label = `${quarters[0]} – ${quarters[quarters.length - 1]}`
  console.log(`[ccsp] window: years=[${years.join(', ')}] quarters=[${quarters.join(', ')}] label="${label}"`)
  return { years, quarters, label }
}

/**
 * Derive POD, Subregion, Segment, Subsegment, and Region from a territory string.
 *
 * Commercial (5-part): WEST_COMM_CORP_NORTHWEST_TERR01
 *   subregion = WEST_COMM_CORP         (first 3 segments)
 *   pod       = WEST_COMM_CORP_NORTHWEST  (first 4, no suffix)
 *   segment   = Commercial
 *   region    = NA_COMM_COMMERCIAL
 *
 * Enterprise (4-part): CENTRAL_ENT_TOLA_TERR02
 *   subregion = CENTRAL_ENT_TOLA       (first 3 segments)
 *   pod       = CENTRAL_ENT_TOLA_POD   (first 3 + _POD suffix — required by Tableau)
 *   segment   = Enterprise
 *   region    = CENTRAL                (first segment)
 */
export function parseTerritoryParts(territory: string): {
  pod: string; subregion: string; segment: string; subsegment: string; region: string
} {
  if (!/^[A-Z0-9_]+$/i.test(territory)) {
    throw new Error(`Invalid territory format: ${territory}`)
  }
  const parts = territory.split('_')
  const segType = parts[1] ?? ''
  const isEnterprise = segType === 'ENT'

  const subregion = parts.slice(0, 3).join('_')
  // Enterprise PODs carry a _POD suffix in Tableau; commercial do not
  const pod = isEnterprise ? subregion + '_POD' : parts.slice(0, -1).join('_')
  const segment = isEnterprise ? 'Enterprise' : 'Commercial'
  const region = isEnterprise ? (parts[0] ?? 'CENTRAL') : 'NA_COMM_COMMERCIAL'

  return { pod, subregion, segment, subsegment: segment, region }
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

async function scrapeOneAe(page: Page, ae: AE, podBookingsFolderId?: string): Promise<CcspResult> {
  const territories = ae.tableauTerritories ?? []
  const validTerritories = territories.filter(t => {
    if (!/^[A-Z0-9_]+$/.test(t)) {
      console.warn(`[ccsp] skipping invalid territory string: "${t}"`)
      return false
    }
    return true
  })

  // Compute rolling window up front — used by both cache and live paths
  const { years, quarters, label } = getRollingFyWindow()

  // Issue #15 Step 2: cache tiers extracted to src/ccsp-cache.ts.
  //   Tier 1 — in-memory POD cache (BKL-PERF-02, BKL-PERF-04, BKL-INGEST-03).
  //   Tier 2 — Drive POD cache CCSP-<pod>-<date>.csv (BKL-PERF-03).
  // Both return full POD-wide rows; this orchestrator post-filters per AE.
  const currentPod = validTerritories.length > 0 ? parseTerritoryParts(validTerritories[0]).pod : ''

  // Tier 1: in-memory cache (gated on pod match + Drive modifiedTime freshness).
  if (validTerritories.length > 0 && currentPod) {
    const mem = await tryMemoryCache(currentPod)
    if (mem.hit && mem.rows) {
      const filtered = filterRowsForAe(mem.rows, validTerritories, quarters)
      console.log(`[ccsp] ${ae.name}: using cached POD data — ${filtered.length} rows (memory tier)`)
      return { aeName: ae.name, rows: filtered, accountPeriod: mem.period ?? label }
    }
  }

  // Tier 2: Drive cache. Only runs on memory miss.
  if (podBookingsFolderId && validTerritories.length > 0 && currentPod) {
    const drv = await tryDriveCache(currentPod, podBookingsFolderId)
    if (drv.hit && drv.rows) {
      const before = drv.rows.length
      const rows = filterRowsForAe(drv.rows, validTerritories, quarters)
      console.log(`[ccsp] ${ae.name}: Drive cache filter (territory+quarter): ${before} → ${rows.length} rows`)
      return { aeName: ae.name, rows, accountPeriod: drv.period ?? label }
    }
  }

  // IS_LEADER guard — non-leader instances cap at L3; only leader may do live Tableau scrape (L4)
  if (!isPrimary()) {
    console.log(`[ccsp] ${ae.name}: non-leader instance — L4 (live Tableau scrape) not permitted; returning empty`)
    return { aeName: ae.name, rows: [], accountPeriod: label }
  }

  // -- Build URL with filters pre-applied -------------------------------------
  // Tableau Cloud supports URL-based filtering (?FilterName=Value) — this is
  // far more reliable than clicking UI filter dropdowns inside deeply-nested
  // iframes (Main page → Data Visualization iframe → primaryContent iframe).
  // BKL-CCSP-05: Derive Segment, Region, POD from territory string — hardcoded Commercial
  // filters returned 0 rows for Enterprise (TOLA) territories.
  const territoryFilters = validTerritories.length > 0
    ? parseTerritoryParts(validTerritories[0])
    : { pod: '', subregion: '', segment: 'Commercial', subsegment: 'Commercial', region: 'NA_COMM_COMMERCIAL' }

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
    // BKL-CCSP-CSV-01: Account Territory filter removed — .csv endpoint returns empty ("\n")
    // when territory filter is applied. POD + Subregion scope the viz correctly;
    // territory filtering is applied client-side after download.
  }
  // Direct embed URL — filter params MUST be on /t/site/views/... (not on the #/site/... hash URL,
  // where ?params would be inside the hash fragment and ignored by the server).
  const tableauUrl = `${TABLEAU_EMBED_BASE}?${filterParams.toString().replace(/%2C/gi, ',')}`
  console.log(`[ccsp] ${ae.name}: navigating with pre-applied filters (no territory filter)...`)

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
    console.log(`[ccsp] ${ae.name}: Tableau SSO detected — waiting up to 5 min for manual login via VNC`)
    _tableauSessionExpired = true
    const deadline = Date.now() + 5 * 60 * 1000
    let loggedIn = false
    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000)
      const url = page.url()
      if (!url.startsWith('https://10ay.online.tableau.com')) continue
      await page.waitForTimeout(1_500)
      if (page.url() !== url) continue
      const noLoginForm = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('input[type="password"], input#username, [data-testid="login"]'))
        return !els.some(el => {
          const s = window.getComputedStyle(el)
          return s.display !== 'none' && s.visibility !== 'hidden' && (el as HTMLElement).offsetParent !== null
        })
      }).catch(() => false)
      const hasTableauContent = await page.$('.tab-glassPane, iframe[id^="tableau"]').then(el => !!el).catch(() => false)
      if (noLoginForm && hasTableauContent) {
        console.log(`[ccsp] ${ae.name}: Tableau login detected — saving cookies and continuing`)
        if (_ctx) await saveTableauSession(_ctx)
        _tableauSessionExpired = false
        loggedIn = true
        break
      }
    }
    if (!loggedIn) {
      console.warn(`[ccsp] ${ae.name}: Tableau login timed out after 5 min — skipping scrape`)
      _tableauSessionExpired = true
      throw new Error('Tableau session required — log in via the VNC window and retry')
    }
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
    // Tableau shows "Working on it" modal (Processing request → Computing models → Preparing result)
    // Wait for it to disappear before attempting download
    await page.waitForSelector('text="Working on it"', { timeout: 10_000 }).catch(() => {})
    await page.waitForSelector('text="Working on it"', { state: 'hidden', timeout: 60_000 }).catch(() => {})
    await page.waitForTimeout(2_000)
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

  // Strategy: Direct server-side CSV URL using TABLEAU_EMBED_BASE (/t/site/views/... format).
  // BKL-CCSP-CSV-01 fix: The old popup download approach failed because Salesforce SSO
  // doesn't pass through in popup windows. The original .csv URL approach returned "\n"
  // because it was built from page.url() (fragment #/site/... format) instead of
  // TABLEAU_EMBED_BASE (server /t/site/... format). The server ignores fragment URLs.
  try {
    // Construct direct CSV URL using server-side /t/site/views/... path (NOT page.url() which returns fragment)
    // BKL-CCSP-CSV-01: Year filter (FY2025,FY2026) returns "\n" from CSV endpoint — the endpoint
    // uses a different Year value format than the UI. Quarter filter already constrains the window.
    const rawDataBase = TABLEAU_EMBED_BASE.replace('/CloudConsumption', '/RawData')
    // BKL-CCSP-CSV-01: Segment/Subsegment=Commercial cause 0 rows for CORP territories — Tableau's
    // data uses different Subsegment values per POD (e.g. 'Corporate' not 'Commercial').
    // POD + Subregion already uniquely scope the data; Quarter scopes the time window.
    // Diagnostic confirmed: pod-only filter returns 7715 rows; full filter returns 0.
    const csvFilterParams = new URLSearchParams()
    if (validTerritories.length > 0) {
      csvFilterParams.set('Subregion', territoryFilters.subregion)
      csvFilterParams.set('POD', territoryFilters.pod)
    }
    csvFilterParams.set('Quarter', quarters.join(','))
    const csvParams = csvFilterParams.toString().replace(/%2C/gi, ',')  // Tableau needs literal commas
    const csvUrl = `${rawDataBase}.csv?${csvParams}`

    console.log(`[ccsp] ${ae.name}: fetching CSV from ${csvUrl}`)

    let csvPath: string | null = null
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        page.goto(csvUrl, { waitUntil: 'commit', timeout: 30_000 }).catch(() => {}),
      ])
      csvPath = await download.path()
      console.log(`[ccsp] ${ae.name}: download captured at ${csvPath}`)
    } catch (e: any) {
      console.warn(`[ccsp] ${ae.name}: CSV download failed: ${e.message}`)
    }

    if (csvPath) {
      const csvText = readFileSync(csvPath, 'utf8')
      rows = parseCsvToObjects(csvText)
      // Classify response so "0 rows" failures are diagnosable (BKL-CONN-TABLEAU-CTX-01)
      if (rows.length === 0) {
        const trimmed = csvText.trim()
        if (trimmed === '' || trimmed === '\n') {
          console.warn(`[ccsp] ${ae.name}: csv_empty — endpoint returned blank body (filter mismatch or auth)`)
        } else if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
          console.warn(`[ccsp] ${ae.name}: auth_redirect — CSV endpoint returned HTML (SSO redirect, session invalid in shared context)`)
        } else {
          console.warn(`[ccsp] ${ae.name}: csv_zero_rows — parsed 0 rows from non-empty body: ${trimmed.slice(0, 120)}`)
        }
      } else {
        const firstRow = rows[0] ?? {}
        const cols = Object.keys(firstRow)
        const hasAccount = cols.some(c => /account|customer|company/i.test(c))
        const hasAcv = cols.some(c => /acv/i.test(c))
        if (!hasAccount || !hasAcv) {
          console.warn(`[ccsp] ${ae.name}: csv_summary_view — ${rows.length} rows but missing required columns; cols: [${cols.slice(0, 8).join(', ')}]`)
        } else {
          console.log(`[ccsp] ${ae.name}: csv_ok — ${rows.length} rows (unfiltered POD)`)
        }
      }
    }

    // Re-navigate to main Tableau view so next AE scrape starts cleanly
    await page.goto(tableauUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})

    // Issue #15 Step 2: cache write-back (memory + Drive) extracted to src/ccsp-cache.ts.
    //   - BKL-PERF-02 / BKL-PERF-04: in-memory POD-keyed cache.
    //   - BKL-PERF-03: Drive cache write CCSP-<pod>-<today>.csv.
    //   - REG-CCSP-DUP-01: stale-sibling deletion.
    //   - BKL-INGEST-03: stamps driveFileId onto in-memory entry post-write.
    if (rows.length > 0 && validTerritories.length > 0) {
      const writePod = parseTerritoryParts(validTerritories[0]).pod
      await writeCaches(writePod, rows, label, podBookingsFolderId)
    }

    // Post-filter by territory and quarter — download returns full POD dataset
    // Issue #15 Step 1: extracted to filterRowsForAe (pure). Diagnostic warnings
    // for missing columns stay here (out of the pure function).
    if (rows.length > 0) {
      const beforeKeys = Object.keys(rows[0])
      const hasTerrCol = beforeKeys.some(k => {
        const norm = k.toLowerCase().replace(/\s+/g, ' ').trim()
        return norm === 'account territory name' || norm === 'account territory'
      })
      const hasQtrCol = beforeKeys.some(k =>
        k.toLowerCase().replace(/\s+/g, ' ').trim().includes('fiscal year quarter')
      )
      if (validTerritories.length > 0 && !hasTerrCol) {
        console.warn(`[ccsp] ${ae.name}: no territory column found — skipping territory filter. Columns: ${beforeKeys.join(', ')}`)
      }
      if (!hasQtrCol) {
        console.warn(`[ccsp] ${ae.name}: no quarter column found — skipping quarter filter`)
      }
      const before = rows.length
      rows = filterRowsForAe(rows, validTerritories, quarters)
      console.log(`[ccsp] ${ae.name}: post-fetch filter (territory+quarter ${quarters.join(',')}): ${before} → ${rows.length} rows`)
    }
  } catch (e: any) {
    console.warn(`[ccsp] ${ae.name}: CSV download failed: ${e.message}`)
  }

  if (rows.length === 0) {
    if (CCSP_DEBUG) await dumpDom(page, `${ae.name}-no-data`)
    console.warn(`[ccsp] ${ae.name}: could not extract data — returning empty result`)
  }
  return { aeName: ae.name, rows, accountPeriod: label }
}

// -- Public scrape entry point ------------------------------------------------

export async function runCcspScrape(aes: AE[]): Promise<CcspResult[]> {
  // BKL-INGEST-04: L4 live-scrape guard — blocks live Tableau scrape in test environment.
  // Must be the first check, before any browser/network work.
  if (process.env.DISALLOW_LIVE_SCRAPE === '1') {
    throw new Error('[ccsp-scraper] DISALLOW_LIVE_SCRAPE=1 — live scrape blocked in test environment')
  }

  if (!isPrimary()) {
    console.log('[ccsp] NODE_ROLE not primary — this instance will cap at L3 for all AEs')
  }

  // Re-sync context in case RH scraper recycled it (every 50 scrapes).
  // If the shared context was replaced, _ctx is a stale reference — refresh it.
  const liveCtx = getScrapeContext()
  if (liveCtx && liveCtx !== _ctx) {
    console.log('[ccsp] context recycled by RH scraper — re-adopting')
    _ctx = liveCtx
  }
  // Always refresh Tableau cookies at scrape start — picks up any fresh login
  // that completed after context was adopted (e.g. user logged in via VNC).
  if (_ctx) await restoreTableauSession(_ctx)

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

  // BKL-PERF-03: Read podBookingsFolderId for Drive cache check/write in scrapeOneAe
  const SETTINGS_PATH_CCSP = resolve(process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config'), 'settings.json')
  let podBookingsFolderId = ''
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH_CCSP, 'utf-8'))
    podBookingsFolderId = normalizeSettings(raw).regions[0]?.podBookingsFolderId ?? ''
  } catch { /* non-fatal — proceed without Drive cache */ }

  const results: CcspResult[] = []

  try {
    for (const ae of aes) {
      console.log(`[ccsp] runCcspScrape: processing AE ${ae.name}`)
      if (!ae.tableauTerritories?.length) {
        console.warn(`[ccsp] ${ae.name}: no tableauTerritories configured — skipping`)
        continue
      }
      if (!ae.driveFolderId) {
        console.warn(`[ccsp] ${ae.name}: no driveFolderId configured — skipping`)
        continue
      }

      if (!_ctx) throw new Error('Browser context not available — re-authenticate via Setup page')
      // BKL-ADM02: _ctx.pages() does NOT throw on a closed context (it returns []).
      // Use newPage() as the real liveness probe — it throws if context is closed.
      let page: Page
      try {
        page = await Promise.race([
          _ctx.newPage(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('newPage() timed out after 30s — browser context unresponsive')), 30_000)
          ),
        ])
        console.log(`[ccsp] ${ae.name}: new page created OK`)
      } catch (e: any) {
        _ctx = null
        // BKL-STAB-02: trigger rh-scraper auto-recovery so the shared context is rebuilt
        // and adoptCcspContext fires via the registered setContextRecoveryCallback, re-wiring _ctx.
        // Do not block or rethrow recovery errors — the retryable error below signals the queue.
        console.warn('[ccsp] browser context unresponsive — triggering auto-recovery')
        try { await ensureBrowserHealthy() } catch { /* recovery in progress or context unavailable */ }
        throw new Error(`Browser context is closed or unresponsive (${e.message}) — context recovery triggered, retry in progress`)
      }
      const scrapePromise = scrapeOneAe(page, ae, podBookingsFolderId || undefined)
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

// -- BKL-PERF-02: POD-level pre-scrape + per-AE filter -----------------------

/**
 * Scrape the full CCSP POD data in one Tableau navigation.
 * The CSV endpoint returns all territories — use filterCcspRowsForAe() per AE.
 * Use this in POD bootstrap to avoid one browser navigation per AE.
 */
/**
 * seedTerritories: pass the first AE's territories so Tableau renders the viz correctly.
 * The CSV endpoint ignores territory params and returns full POD data regardless —
 * seedTerritories are only used to get a working Tableau page load.
 */
export async function scrapePodCcspRaw(seedTerritories: string[] = [], driveFolderId?: string): Promise<{ rows: Record<string, string>[]; period: string }> {
  // BKL-INGEST-04: L4 live-scrape guard — blocks live Tableau scrape in test environment.
  // Must be the first check, before any browser/network work.
  if (process.env.DISALLOW_LIVE_SCRAPE === '1') {
    throw new Error('[ccsp-scraper] DISALLOW_LIVE_SCRAPE=1 — live scrape blocked in test environment')
  }

  if (!isPrimary()) {
    console.log('[ccsp] scrapePodCcspRaw: non-leader instance — L4 not permitted; returning empty')
    return { rows: [], period: getRollingFyWindow().label }
  }

  if (!_ctx) throw new Error('No browser context — connect Red Hat Portal first')
  // BKL-ADM02: _ctx.pages() does NOT throw on a closed context (it returns []).
  // The real liveness probe is newPage() below — wrapped in try-catch.

  const { years, quarters, label } = getRollingFyWindow()
  const validSeedTerritories = seedTerritories.filter(t => /^[A-Z0-9_]+$/.test(t))

  // -- Drive cache check: skip Tableau if today's CCSP POD CSV already exists --
  const podName = validSeedTerritories.length > 0
    ? parseTerritoryParts(validSeedTerritories[0]).pod
    : 'UNKNOWN'
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const cacheFileName = `CCSP-${podName}-${today}.csv`

  if (driveFolderId) {
    try {
      const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
      const drive = google.drive({ version: 'v3', auth })
      const listRes = await withQuotaRetry(
        () => drive.files.list({
          q: `name = '${cacheFileName}' and '${driveFolderId}' in parents and trashed = false`,
          fields: 'files(id, name)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
        'CCSP Drive cache check',
      )
      const cacheFile = listRes.data.files?.[0]
      if (cacheFile?.id) {
        console.log(`[ccsp] POD pre-scrape: found Drive cache file ${cacheFileName} (${cacheFile.id}) — downloading`)
        const dlRes = await withQuotaRetry(
          () => drive.files.get({ fileId: cacheFile.id!, alt: 'media', supportsAllDrives: true }, { responseType: 'text' }),
          'CCSP Drive cache download',
        )
        const csvText = typeof dlRes.data === 'string' ? dlRes.data : String(dlRes.data)
        const cachedRows = parseCsvToObjects(csvText)
        if (cachedRows.length > 0) {
          console.log(`[ccsp] POD pre-scrape: Drive cache hit — ${cachedRows.length} rows from ${cacheFileName}`)
          return { rows: cachedRows, period: label }
        }
        console.warn(`[ccsp] POD pre-scrape: Drive cache file had 0 rows — proceeding to Tableau`)
      }
    } catch (e: any) {
      console.warn(`[ccsp] POD pre-scrape: Drive cache check failed: ${e.message} — proceeding to Tableau`)
    }
  }
  // BKL-CCSP-05: Derive Segment, Region from seed territory — hardcoded Commercial
  // filters returned 0 rows for Enterprise (TOLA) territories.
  const seedFilters = validSeedTerritories.length > 0
    ? parseTerritoryParts(validSeedTerritories[0])
    : { pod: '', subregion: '', segment: 'Commercial', subsegment: 'Commercial', region: 'NA_COMM_COMMERCIAL' }

  const filterParams = new URLSearchParams()
  filterParams.set('Super Geo', 'AMERICAS')
  filterParams.set('Geo', 'NA_COMM')
  filterParams.set('Region', seedFilters.region)
  filterParams.set('Segment', seedFilters.segment)
  filterParams.set('Subsegment', seedFilters.subsegment)
  filterParams.set('Year', years.join(','))
  filterParams.set('Quarter', quarters.join(','))
  // Use seed territory to scope Tableau viz to the right POD — download returns full POD data.
  // BKL-CCSP-CSV-01: Account Territory filter removed — breaks .csv endpoint.
  if (validSeedTerritories.length > 0) {
    filterParams.set('Subregion', seedFilters.subregion)
    filterParams.set('POD', seedFilters.pod)
  }

  let page: Page
  try {
    page = await Promise.race([
      _ctx.newPage(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('newPage() timed out after 30s — browser context unresponsive')), 30_000)
      ),
    ])
    console.log(`[ccsp] scrapePodCcspRaw: new page created OK`)
  } catch (e: any) {
    _ctx = null
    throw new Error(`Browser context is closed or unresponsive (${e.message}) — re-authenticate via Setup page and retry`)
  }
  try {
    const tableauUrl = `${TABLEAU_EMBED_BASE}?${filterParams.toString().replace(/%2C/gi, ',')}`
    console.log(`[ccsp] POD pre-scrape: navigating for full dataset…`)
    await page.goto(tableauUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {
      console.warn(`[ccsp] POD pre-scrape: networkidle timed out — continuing`)
    })
    await page.waitForTimeout(3_000)

    await waitForVizReady(page, 'POD')
    await page.waitForTimeout(2_000)

    const rawDataTab = await findEl(page, 'text="Raw Data"')
    if (rawDataTab) {
      await rawDataTab.click()
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
      await page.waitForTimeout(3_000)
    }

    let postTabUrl = page.url()
    if (postTabUrl.includes('/CloudConsumption') && rawDataTab) {
      postTabUrl = postTabUrl.replace('/CloudConsumption', '/RawData')
    }

    let rows: Record<string, string>[] = []
    // BKL-CCSP-CSV-01 fix: Direct server-side CSV URL using TABLEAU_EMBED_BASE
    // (/t/site/views/... format). The old download button approach failed because
    // popup SSO doesn't pass through. The .csv URL works when built from the
    // server-side path, not from page.url() (which returns fragment #/site/... format).
    try {
      const rawDataBase = TABLEAU_EMBED_BASE.replace('/CloudConsumption', '/RawData')
      // BKL-CCSP-CSV-01: Use only Quarter + POD filters — Segment/Subsegment cause 0 rows for CORP territories
      const csvFilterParamsPod = new URLSearchParams()
      if (podName) csvFilterParamsPod.set('POD', podName)
      csvFilterParamsPod.set('Quarter', quarters.join(','))
      const csvParams = csvFilterParamsPod.toString().replace(/%2C/gi, ',')
      const csvUrl = `${rawDataBase}.csv?${csvParams}`

      console.log(`[ccsp] POD pre-scrape: fetching CSV from ${csvUrl}`)
      let csvPath: string | null = null
      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 60_000 }),
          page.goto(csvUrl, { waitUntil: 'commit', timeout: 30_000 }).catch(() => {}),
        ])
        csvPath = await download.path()
        console.log(`[ccsp] POD pre-scrape: download captured at ${csvPath}`)
      } catch (e: any) {
        console.warn(`[ccsp] POD pre-scrape: CSV download failed: ${e.message}`)
      }

      if (csvPath) {
        const csvText = readFileSync(csvPath, 'utf8')
        rows = parseCsvToObjects(csvText)
        if (rows.length === 0) {
          const trimmed = csvText.trim()
          if (trimmed === '' || trimmed === '\n') {
            console.warn(`[ccsp] POD pre-scrape: csv_empty — blank body (filter mismatch or auth)`)
          } else if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
            console.warn(`[ccsp] POD pre-scrape: auth_redirect — HTML body (SSO redirect, session invalid)`)
          } else {
            console.warn(`[ccsp] POD pre-scrape: csv_zero_rows — 0 rows from non-empty body: ${trimmed.slice(0, 120)}`)
          }
        } else {
          console.log(`[ccsp] POD pre-scrape: csv_ok — ${rows.length} rows`)
        }
      }

      // Re-navigate to main view so context is clean
      await page.goto(tableauUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})

      // Apply quarter filter only — NOT territory filter (that's per-AE client-side)
      if (rows.length > 0) {
        const qtrColName = Object.keys(rows[0]).find(k =>
          k.toLowerCase().replace(/\s+/g, ' ').trim().includes('fiscal year quarter')
        )
        if (qtrColName) {
          const qtrSet = new Set(quarters)
          const before = rows.length
          rows = rows.filter(r => qtrSet.has((r[qtrColName] ?? '').trim()))
          console.log(`[ccsp] POD pre-scrape: ${before} raw rows → ${rows.length} after quarter filter`)
        }
      }
      console.log(`[ccsp] POD pre-scrape: ${rows.length} rows cached for all AEs`)
    } catch (e: any) {
      throw new Error(`POD CCSP pre-scrape failed: ${e.message}`)
    }

    if (rows.length === 0) throw new Error('POD CCSP pre-scrape: 0 rows — Tableau may not be authenticated')

    // -- Drive cache write: persist raw POD rows so subsequent runs skip Tableau --
    if (driveFolderId && rows.length > 0) {
      try {
        const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
        const drive = google.drive({ version: 'v3', auth })
        // REG-CCSP-DUP-01: delete any stale CCSP-<pod>-<date>.csv files for this POD before writing today's
        try {
          const staleRes = await withQuotaRetry(
            () => drive.files.list({
              q: `name contains 'CCSP-${podName}-' and '${driveFolderId}' in parents and trashed = false`,
              fields: 'files(id, name)',
              supportsAllDrives: true,
              includeItemsFromAllDrives: true,
            }),
            'CCSP Drive stale cache list',
          )
          const staleFiles = staleRes.data.files ?? []
          for (const oldFile of staleFiles) {
            if (!oldFile.id || !oldFile.name) continue
            if (!oldFile.name.startsWith(`CCSP-${podName}-`) || !oldFile.name.endsWith('.csv')) continue
            try {
              await drive.files.delete({ fileId: oldFile.id, supportsAllDrives: true })
              console.log(`[ccsp] deleted stale Drive cache ${oldFile.name}`)
            } catch (delErr: any) {
              console.warn(`[ccsp] POD pre-scrape: stale cache delete failed for ${oldFile.name}: ${delErr.message} — non-fatal`)
            }
          }
        } catch (listErr: any) {
          console.warn(`[ccsp] POD pre-scrape: stale cache list failed: ${listErr.message} — non-fatal, proceeding to write`)
        }
        // Build CSV text from rows
        const headers = Object.keys(rows[0])
        const csvLines = [headers.join(',')]
        for (const row of rows) {
          csvLines.push(headers.map(h => {
            const val = row[h] ?? ''
            return val.includes(',') || val.includes('"') || val.includes('\n')
              ? `"${val.replace(/"/g, '""')}"` : val
          }).join(','))
        }
        const csvContent = csvLines.join('\n')
        await withQuotaRetry(
          () => drive.files.create({
            requestBody: {
              name: cacheFileName,
              mimeType: 'text/csv',
              parents: [driveFolderId],
            },
            media: { mimeType: 'text/csv', body: csvContent },
            supportsAllDrives: true,
            fields: 'id',
          }),
          'CCSP Drive cache write',
        )
        console.log(`[ccsp] POD pre-scrape: wrote Drive cache file ${cacheFileName} (${rows.length} rows)`)
      } catch (e: any) {
        console.warn(`[ccsp] POD pre-scrape: Drive cache write failed: ${e.message} — non-fatal`)
      }
    }

    return { rows, period: label }
  } finally {
    await page.close().catch(() => {})
  }
}

/**
 * Filter pre-scraped POD CCSP rows for a specific AE's territories.
 * Use after scrapePodCcspRaw() to get per-AE results without re-scraping.
 */
export function filterCcspRowsForAe(
  rawRows: Record<string, string>[],
  period: string,
  ae: AE
): CcspResult {
  const territories = (ae.tableauTerritories ?? []).filter(t => /^[A-Z0-9_]+$/.test(t))
  if (territories.length === 0 || rawRows.length === 0) {
    return { aeName: ae.name, rows: [], accountPeriod: period }
  }

  let rows = rawRows
  const terrColName = Object.keys(rawRows[0]).find(k => {
    const norm = k.toLowerCase().replace(/\s+/g, ' ').trim()
    return norm === 'account territory name' || norm === 'account territory'
  })
  if (terrColName) {
    const terrSet = new Set(territories)
    const before = rows.length
    rows = rows.filter(r => terrSet.has((r[terrColName] ?? '').trim()))
    console.log(`[ccsp] ${ae.name}: territory filter from cache: ${before} → ${rows.length} rows`)
  } else {
    console.warn(`[ccsp] ${ae.name}: no territory column in cached rows — using all rows`)
  }

  return { aeName: ae.name, rows, accountPeriod: period }
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
