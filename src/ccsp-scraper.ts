import { setLivePageBusy, getScrapeContext, ensureBrowserHealthy } from "./rh-scraper.ts"
import { isPrimary } from './lib/node-role.ts'
import { parseTerritoryParts, getUniquePodFilters } from './lib/territory.ts'
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
// BKL-ARCH-SCRAPER-08: CCSP uses Tableau-domain cookie subset format { cookies, savedAt }
// intentionally — only Tableau SSO cookies are needed for login-bypass; the full
// storageState() used by RH and SF would include unrelated origins and bloat the file.
async function saveTableauSession(ctx: BrowserContext): Promise<void> {
  try {
    await closeTableauTabs(ctx, 'saveTableauSession')
    // #437: Use ctx.cookies() instead of ctx.storageState() — we only need cookies,
    // not localStorage. storageState() hangs >30s enumerating localStorage across iframes.
    const cookies = await safeCookieOp(ctx, 'saveTableauSession cookies', c => c.cookies(), [])
    const tableauCookies = cookies.filter(c => c.domain.includes('tableau.com') || c.domain.includes('online.tableau'))
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
    const existing = await safeCookieOp(ctx, 'restoreTableauSession ctx.cookies', c => c.cookies(), [])
    const hasLiveTableau = existing.some(c => c.domain.includes('tableau.com') || c.domain.includes('online.tableau'))
    if (hasLiveTableau) {
      console.log('[ccsp] shared context already has Tableau cookies — skipping disk restore')
      return
    }
    const saved = JSON.parse(readFileSync(TABLEAU_SESSION_PATH, 'utf-8'))
    if (!saved.cookies?.length) return
    console.log('[ccsp] restoreTableauSession: injecting disk cookies into context')
    await safeCookieOp(ctx, 'restoreTableauSession ctx.addCookies', c => c.addCookies(saved.cookies), undefined as void)
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
import { markRunning, recordOutcome, getScraperStatus } from './scraper-status-store.ts'
import { ScraperRegistry } from './scraper-registry.ts'
import { parseCsvToObjects } from './csv-parse.ts'
import { filterRowsForAe, warnFilterColumnGaps } from './ccsp-row-filter.ts'
import { tryMemoryCache, tryDriveCache, writeCaches } from './ccsp-cache.ts'
import { fetchPodCsv } from './ccsp-tableau-fetch.ts'
import { assertLiveScrapeAllowed } from './scraper-utils.ts'

// BKL-ARCH-17: `findEl` and `waitForVizReady` removed — sole callers were
// `applyFilter` and the inline POD pre-scrape navigation, both replaced by
// `fetchPodCsv` (src/ccsp-tableau-fetch.ts) which owns its own iframe-aware
// element lookup and viz-ready polling.

// -- Module state -------------------------------------------------------------

export let ccspScrapeRunning = false
export let ccspScrapeStartedAt: number | null = null

/**
 * BKL-ARCH-SCRAPER-03: scraper-status-store is the single source of truth.
 * Refresh callers in refresh-engine.ts now invoke recordOutcome('ccsp', …)
 * directly before this hook, so this function is intentionally a no-op kept
 * for back-compat with existing call sites and unit-test mocks.
 */
export function recordCcspRefreshAt(): void {
  // intentional no-op (see jsdoc)
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
    // #632: Check ALL unique pods — multi-pod AEs need cache hits for every pod
    const uniquePods = getUniquePodFilters(territories)
    if (uniquePods.length === 0) return false
    const today = new Date().toISOString().slice(0, 10)
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })
    for (const podFilter of uniquePods) {
      if (!podFilter.pod) return false
      const cacheFileName = `CCSP-${podFilter.pod}-${today}.csv`
      const listRes = await withQuotaRetry(
        () => drive.files.list({
          q: `name = '${cacheFileName}' and '${podBookingsFolderId}' in parents and trashed = false`,
          fields: 'files(id, name)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
        'CCSP L3 existence check',
      )
      if (!listRes.data.files || listRes.data.files.length === 0) return false
    }
    return true
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

// Issue #15 Step 3: _tableauSessionExpired flag and accessors moved to
// src/ccsp-tableau-fetch.ts (single owner of the SSO recovery handshake).
// Re-export for backward compatibility — bootstrap-orchestrator.ts and
// scraper-manager.ts continue to import from './ccsp-scraper.ts'.
export { consumeTableauSessionExpired, peekTableauSessionExpired } from './ccsp-tableau-fetch.ts'
// BKL-ARCH-17: setTableauSessionExpired no longer imported — fetchPodCsv owns the flag now.

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

// BKL-ARCH-17: `dumpDom` removed — sole owner is now src/ccsp-tableau-fetch.ts.

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
// BKL-ARCH-17: `applyFilter` removed — was zero-caller after URL-based filtering
// replaced UI dropdown clicks; URL filters now live in fetchPodCsv.

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

  // #632: Derive UNIQUE pod filter sets from ALL territories — multi-pod AEs
  // need separate cache lookups and live fetches for each pod.
  const uniquePodFilters = validTerritories.length > 0
    ? getUniquePodFilters(validTerritories)
    : []

  // Issue #15 Step 2: cache tiers extracted to src/ccsp-cache.ts.
  //   Tier 1 — in-memory POD cache (BKL-PERF-02, BKL-PERF-04, BKL-INGEST-03).
  //   Tier 2 — Drive POD cache CCSP-<pod>-<date>.csv (BKL-PERF-03).
  // Both return full POD-wide rows; this orchestrator post-filters per AE.

  // Tier 1: in-memory cache — try ALL pods; if every pod hits, merge and return.
  if (uniquePodFilters.length > 0) {
    let allMemHit = true
    const memRows: Record<string, string>[] = []
    let memPeriod: string | undefined
    for (const podFilter of uniquePodFilters) {
      if (!podFilter.pod) { allMemHit = false; break }
      const mem = await tryMemoryCache(podFilter.pod)
      if (mem.hit && mem.rows) {
        memRows.push(...mem.rows)
        memPeriod = memPeriod ?? mem.period
      } else {
        allMemHit = false
        break
      }
    }
    if (allMemHit && memRows.length > 0) {
      const filtered = filterRowsForAe(memRows, validTerritories, quarters)
      console.log(`[ccsp] ${ae.name}: using cached POD data (${uniquePodFilters.length} pod(s)) — ${filtered.length} rows (memory tier)`)
      return { aeName: ae.name, rows: filtered, accountPeriod: memPeriod ?? label }
    }
  }

  // Tier 2: Drive cache — try ALL pods; if every pod hits, merge and return.
  if (podBookingsFolderId && uniquePodFilters.length > 0) {
    let allDrvHit = true
    const drvRows: Record<string, string>[] = []
    let drvPeriod: string | undefined
    for (const podFilter of uniquePodFilters) {
      if (!podFilter.pod) { allDrvHit = false; break }
      const drv = await tryDriveCache(podFilter.pod, podBookingsFolderId)
      if (drv.hit && drv.rows) {
        drvRows.push(...drv.rows)
        drvPeriod = drvPeriod ?? drv.period
      } else {
        allDrvHit = false
        break
      }
    }
    if (allDrvHit && drvRows.length > 0) {
      const before = drvRows.length
      const rows = filterRowsForAe(drvRows, validTerritories, quarters)
      console.log(`[ccsp] ${ae.name}: Drive cache filter (${uniquePodFilters.length} pod(s), territory+quarter): ${before} → ${rows.length} rows`)
      return { aeName: ae.name, rows, accountPeriod: drvPeriod ?? label }
    }
  }

  // IS_LEADER guard — non-leader instances cap at L3; only leader may do live Tableau scrape (L4)
  if (!isPrimary()) {
    console.log(`[ccsp] ${ae.name}: non-leader instance — L4 (live Tableau scrape) not permitted; returning empty`)
    return { aeName: ae.name, rows: [], accountPeriod: label }
  }

  // -- Live Tableau fetch (Issue #15 Step 3 — extracted to ccsp-tableau-fetch.ts) -----
  // #632: Fetch CSV for EACH unique pod and merge rows. Different pods may have
  // different Tableau filter params (Region, Segment, Subregion, POD).
  // BKL-CCSP-05: territory string drives Region/Segment/POD derivation.
  const effectivePodFilters = uniquePodFilters.length > 0
    ? uniquePodFilters
    : [{ pod: '', subregion: '', segment: 'Commercial', subsegment: 'Commercial', region: 'NA_COMM_COMMERCIAL' }]

  let rows: Record<string, string>[] = []
  for (const territoryFilters of effectivePodFilters) {
    let podRows: Record<string, string>[] = []
    try {
      console.log(`[ccsp] ${ae.name}: fetching pod ${territoryFilters.pod || '(default)'}`)
      const fetched = await fetchPodCsv({
        page,
        aeName: ae.name,
        territoryFilters,
        validTerritories,
        years,
        quarters,
      })
      podRows = fetched.rows
      rows.push(...podRows)
      // Save freshened Tableau cookies after successful manual login during the fetch.
      if (fetched.loggedInDuringFetch && _ctx) {
        await saveTableauSession(_ctx)
      }
    } catch (e: any) {
      console.warn(`[ccsp] ${ae.name}: live Tableau fetch failed for pod ${territoryFilters.pod}: ${e.message}`)
      // If there's only one pod, propagate the error as before
      if (effectivePodFilters.length === 1) throw e
      // For multi-pod, log and continue — partial data is better than none
    }

    // Issue #15 Step 2: cache write-back per pod (uses this pod's rows only)
    //   - BKL-PERF-02 / BKL-PERF-04: in-memory POD-keyed cache.
    //   - BKL-PERF-03: Drive cache write CCSP-<pod>-<today>.csv.
    //   - REG-CCSP-DUP-01: stale-sibling deletion.
    //   - BKL-INGEST-03: stamps driveFileId onto in-memory entry post-write.
    if (podRows.length > 0 && territoryFilters.pod) {
      await writeCaches(territoryFilters.pod, podRows, label, podBookingsFolderId)
    }
  }

  // Post-filter by territory and quarter — download returns full POD dataset.
  // Issue #15 Step 1: pure filter in filterRowsForAe; column-gap diagnostics
  // in warnFilterColumnGaps (csv_summary_view regression signal preserved).
  if (rows.length > 0) {
    warnFilterColumnGaps(rows, validTerritories, ae.name)
    const before = rows.length
    rows = filterRowsForAe(rows, validTerritories, quarters)
    console.log(`[ccsp] ${ae.name}: post-fetch filter (territory+quarter ${quarters.join(',')}): ${before} → ${rows.length} rows`)
  }

  if (rows.length === 0) {
    console.warn(`[ccsp] ${ae.name}: could not extract data — returning empty result`)
  }
  return { aeName: ae.name, rows, accountPeriod: label }
}

// -- Public scrape entry point ------------------------------------------------

export async function runCcspScrape(aes: AE[]): Promise<CcspResult[]> {
  // BKL-INGEST-04 / BKL-ARCH-SCRAPER-06: live-scrape guard extracted to scraper-utils.ts
  assertLiveScrapeAllowed('ccsp-scraper')

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
  let scrapeError: Error | null = null
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

    if (_ctx) saveTableauSession(_ctx).catch(() => {})
    return results

  } catch (e: any) {
    scrapeError = e
    throw e
  } finally {
    // ScraperStatusStore: record outcome
    const totalRows = results.reduce((sum, r) => sum + r.rows.length, 0)
    recordOutcome('ccsp', {
      success: !scrapeError,
      recordCount: totalRows,
      durationMs: Date.now() - _ccspTelemetryStart,
      error: scrapeError ? sanitizeErr(scrapeError) : undefined,
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
  // BKL-INGEST-04 / BKL-ARCH-SCRAPER-06: live-scrape guard extracted to scraper-utils.ts
  assertLiveScrapeAllowed('ccsp-scraper')

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
    // BKL-ARCH-17: Tableau navigation, SSO recovery, CSV download, and response
    // classification all live in fetchPodCsv (src/ccsp-tableau-fetch.ts). The
    // shared BrowserContext is owned upstream — we pass `page` (ADR-015 invariant).
    let rows: Record<string, string>[] = []
    const fetched = await fetchPodCsv({
      page,
      aeName: 'pod-l4',
      territoryFilters: seedFilters,
      validTerritories: validSeedTerritories,
      years,
      quarters,
    })
    rows = fetched.rows
    if (fetched.loggedInDuringFetch && _ctx) {
      await saveTableauSession(_ctx)
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
 *
 * BKL-ARCH-14: When `quarters` is provided and non-empty, delegates to the shared
 * pure filter `filterRowsForAe` (territory + quarter). When `quarters` is absent
 * or empty, retains the original territory-only behavior — `filterRowsForAe` with
 * an empty quarters array would filter out ALL rows (empty Set match), so we MUST
 * NOT pass `[]` through. Existing 3-arg callers continue to get territory-only
 * filtering unchanged.
 */
export function filterCcspRowsForAe(
  rawRows: Record<string, string>[],
  period: string,
  ae: AE,
  quarters?: string[],
): CcspResult {
  const territories = (ae.tableauTerritories ?? []).filter(t => /^[A-Z0-9_]+$/.test(t))
  if (territories.length === 0 || rawRows.length === 0) {
    return { aeName: ae.name, rows: [], accountPeriod: period }
  }

  // BKL-ARCH-14: Delegate to shared pure filter when quarters supplied — this
  // matches the territory + quarter window applied to live and cache-tier paths.
  if (quarters && quarters.length > 0) {
    const before = rawRows.length
    const rows = filterRowsForAe(rawRows, territories, quarters)
    console.log(`[ccsp] ${ae.name}: territory+quarter filter from cache: ${before} → ${rows.length} rows`)
    return { aeName: ae.name, rows, accountPeriod: period }
  }

  // Territory-only fallback — preserves pre-BKL-ARCH-14 behavior for callers
  // that don't pass `quarters` (or pass an empty array).
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

// ── BKL-ARCH-02: register the ccsp descriptor with the registry ───────────────
ScraperRegistry.register({
  name: 'ccsp',
  adopt: (ctx) => { adoptCcspContext(ctx) },
  getInMemoryLastSync: () => getScraperStatus('ccsp').lastSuccess,
  getInMemoryLastError: () => getScraperStatus('ccsp').lastError,
  getInMemoryIsRunning: () => ccspScrapeRunning,
})
