// ── Unified Scrape API (BKL-M25) ────────────────────────────────────────────
// Replaces fragmented /api/bootstrap/* and /api/auth/*/sync endpoints with
// a unified /api/scrape/* layer. Each endpoint runs the full pipeline:
// source → Google Sheets → local cache.
import { writeFileSync, mkdirSync, readFileSync } from 'fs'
import { writeJsonAtomic, writeFileAtomic } from './lib/atomic-write.ts'
import { resolve } from 'path'
import type { Hono } from 'hono'
import {
  normalizeSettings,
  getRegionById,
  flattenPodSfReports,
  flattenPodLabels,
  type RegionConfig,
} from './region-config.ts'
import { aes, customers, patchAe, patchCustomer, saveCustomers, CUSTOMERS_PATH } from './server-state.ts'
import { createOrUpdateNotebook, isNotebookLmEnabled } from './notebooklm.ts'
import { lastScraped } from './rh-auth.ts'
import { getConfiguredTransport } from './case-client.ts'
import {
  runRhScrapeWithState,
  ccspInFlight,
  _rhScrapeRunning,
  _rhScrapeLastError,
  _rhDiscoveryProgress,
  _sfSyncRunning,
  _sfSyncStartedAt,
  _sfSyncCancelRequested,
  _sfSyncLastError,
  // Setters for cross-module state mutation
  setCcspInFlight,
  setRhScrapeCancelRequested,
  setSfSyncRunning,
  setSfSyncStartedAt,
  setSfSyncCancelRequested,
  setSfSyncLastError,
  // BKL-M50e: Telemetry
  recordScrapeResult,
  getTelemetryLog,
  getTelemetrySummary,
  // Circuit breaker management
  resetCircuitBreaker,
  getCircuitBreakerStates,
} from './scraper-manager.ts'
import {
  runSfPipelineSync,
  scrapeSfReport,
  writePipelineSheet,
  createPipelineSheet,
  SfSessionExpiredError,
  recordSfSyncSuccess,
} from './sf-scraper.ts'
import {
  writeSubscriptionSheet,
} from './supportable-scraper.ts'
import {
  runCcspScrape,
  writeCcspSheet,
  ccspScrapeRunning,
  ccspScrapeStartedAt,
} from './ccsp-scraper.ts'
import { getRefreshIntervals, getAutomationConfig } from './settings-api.ts'
import { refreshCCSP, refreshPipeline } from './refresh-engine.ts'
import { readSheetCache, readCCSPCache, readPipelineCache } from './cache-layer.ts'
import { enqueueScraperTask, getScraperQueueStatus } from './scraper-queue.ts'
import { sanitizeErr } from './utils.ts'
import { isPrimary } from './lib/node-role.ts'
import { safeCookieOp } from './browser-utils.ts'
import { fetchSfBookingsRaw, deriveSfCustomersByTerritory, listPodBookingSheets, matchPodSheet, detectMasterSheets, formatMasterIngestSummary } from './sf-bookings-reader.ts'
import { getStatus, getScraperStatus, markRunning, recordOutcome, getUnifiedStatus } from './scraper-status-store.ts'
import { SETTINGS_PATH } from './drive-config-sync.ts'
import { getScrapeContext, discoverAccountNumberByName, ensureBrowserHealthy } from './rh-scraper.ts'
import { driveClient } from './lib/drive-client.ts'
import { CONFIG_DIR, DATA_CONFIG_DIR } from './lib/paths.ts'
import { FeatureModuleRegistry } from './feature-module-registry.ts'

// ── BKL-M58 (part 3): Wall-clock timeout helper for discover tasks ────────────
/** Rejects after `ms` milliseconds with an informative error. */
function wallTimeout(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`[scrape] ${label} exceeded ${Math.round(ms / 60000)}min wall-clock timeout`)), ms)
  )
}

// ── BKL-W2-13: Browser crash detection via telemetry ────────────────────────

const BROWSER_CRASH_PATTERNS = [
  'Target page',
  'context or browser',
  'Playwright',
  'browser has been closed',
]

/** Returns true when the last 5 telemetry entries (across all services) are all
 *  errors whose message matches a browser-crash pattern. This indicates the shared
 *  Playwright browser context has died and scrapers cannot recover without restart. */
function detectBrowserCrash(): boolean {
  const log = getTelemetryLog()
  // Flatten all services into a single sorted list
  const all = Object.values(log).flat()
  if (all.length < 3) return false
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const last5 = all.slice(-5)
  if (last5.length < 5) return false
  return last5.every(entry => {
    if (entry.status !== 'failure' && entry.status !== 'timeout') return false
    if (!entry.error) return false
    return BROWSER_CRASH_PATTERNS.some(p => entry.error!.includes(p))
  })
}

// ── Standardized response shape ─────────────────────────────────────────────

export interface ScrapeResult {
  scraper: 'rh-cases' | 'ccsp' | 'sf-pipeline'
  status: 'ok' | 'partial' | 'error' | 'busy' | 'skipped'
  recordsWritten: number
  accountsScraped?: number
  accountsExpected?: number
  sheetUpdated: boolean
  cacheUpdated: boolean
  error: string | null
  durationMs: number
}

// ── Module state (injected at init) ─────────────────────────────────────────

let RH_PROFILE_DIR = ''
let SF_REPORT_ID = ''

export function initScrapeApi(opts: {
  rhProfileDir: string
  sfReportId: string
}): void {
  RH_PROFILE_DIR = opts.rhProfileDir
  SF_REPORT_ID = opts.sfReportId
}

// ── Route registration ──────────────────────────────────────────────────────

export function registerScrapeRoutes(app: Hono): void {

  // ╭──────────────────────────────────────────────────────────────────────────╮
  // │  RH Portal cases                                                        │
  // ╰──────────────────────────────────────────────────────────────────────────╯

  // POST /api/scrape/rh — full pipeline: scrape RH Portal cases → local cache
  // BKL-M49: Manual triggers go through the scraper queue
  // Manual "Run Now" overrides circuit breaker — user is explicitly requesting a run
  app.post('/api/scrape/rh', async (c) => {
    // Bearer transport does not need a browser session — skip health check
    if (getConfiguredTransport() !== 'bearer') {
      try { await ensureBrowserHealthy() } catch (e: any) { return c.json({ error: sanitizeErr(e) }, 503) }
    }
    if (_rhScrapeRunning) return c.json({ scraper: 'rh-cases', status: 'busy', error: 'RH scrape already in progress' }, 409)
    resetCircuitBreaker('rh-cases')
    markRunning('rh-cases')  // BKL-ADM01: set state synchronously before the task runs
    enqueueScraperTask({
      name: 'rh-cases',
      run: () => runRhScrapeWithState(),
      source: 'manual',
      enqueuedAt: Date.now(),
    })
    return c.json({ scraper: 'rh-cases', started: true, queued: true })
  })

  // GET /api/scrape/rh/status
  app.get('/api/scrape/rh/status', (c) => {
    const intervals = getRefreshIntervals()
    const now = Date.now()
    const store = getScraperStatus('rh-cases')
    // BKL-ARCH-02 Phase 1b: lastSync now resolves through getUnifiedStatus, which
    // applies the inMemoryHint ?? store.lastSuccess ?? null fallback consistently
    // with /api/status/scrapes (FIX C1). Previously this endpoint exposed only the
    // in-memory `lastScraped` and silently returned null after a container restart
    // even when the store had a real lastSuccess.
    const lastSync = getUnifiedStatus('rh-cases').lastSync
    return c.json({
      isRunning: _rhScrapeRunning,
      lastSync:  lastSync,
      lastError: _rhScrapeLastError,
      isStale:   !lastSync || (now - new Date(lastSync).getTime()) > intervals.rhScrape * 2 * 60 * 1000,
      // ScraperStatusStore fields for unified freshness tracking
      lastRun:       store.lastRun,
      lastSuccess:   store.lastSuccess,
      storeLastError: store.lastError,
      recordCount:   store.recordCount,
      state:         store.state,
    })
  })

  // DELETE /api/scrape/rh/cancel
  app.delete('/api/scrape/rh/cancel', (c) => {
    if (!_rhScrapeRunning) return c.json({ ok: false, reason: 'No RH scrape in progress' })
    setRhScrapeCancelRequested(true)
    console.log('[scrape:rh] cancel requested via API')
    return c.json({ ok: true })
  })

  // GET /api/scrape/rh/debug-fields?name=X — return raw Solr fields for first doc matching name
  app.get('/api/scrape/rh/debug-fields', async (c) => {
    const name = c.req.query('name') ?? ''
    if (!name) return c.json({ error: 'name query param required' }, 400)
    const ctx = getScrapeContext()
    if (!ctx) return c.json({ error: 'no browser context' }, 503)
    const page = await ctx.newPage()
    try {
      await page.goto('https://access.redhat.com/support/cases/#/case/list', { waitUntil: 'load', timeout: 30_000 })
      const solrName = name.replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const raw = await page.evaluate(async (n: string) => {
        const body = { q: `account_name: "${n}"`, start: 0, rows: 3, partnerSearch: false, expression: 'fl=*' }
        const resp = await fetch('/hydra/rest/search/v2/cases?redhat_client=Portal%20Case%20Management&account_number=901532',
          { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        if (!resp.ok) return { error: `HTTP ${resp.status}`, docs: [] }
        const data = await resp.json() as { response?: { docs?: any[]; numFound?: number } }
        return { numFound: data?.response?.numFound ?? 0, docs: data?.response?.docs ?? [] }
      }, solrName)
      return c.json(raw)
    } finally {
      await page.close().catch(() => {})
    }
  })

  // POST /api/scrape/rh/test-discover — run name discovery for specific customers (test only, no writes)
  // Body: { customers: string[] } — list of SF alias names to search
  app.post('/api/scrape/rh/test-discover', async (c) => {
    try { await ensureBrowserHealthy() } catch (e: any) { return c.json({ error: sanitizeErr(e) }, 503) }
    const body = await c.req.json<{ customers?: string[] }>().catch(() => ({} as { customers?: string[] }))
    const names: string[] = Array.isArray(body.customers) ? body.customers : []
    if (names.length === 0) return c.json({ error: 'customers array required' }, 400)
    if (names.length > 10) return c.json({ error: 'max 10 customers per test run' }, 400)
    const results: Array<{ name: string; accountNumbers: string[]; cases: number; caseList: any[]; error?: string }> = []
    for (const name of names) {
      try {
        const { accountNumbers, cases } = await discoverAccountNumberByName(name, RH_PROFILE_DIR)
        results.push({ name, accountNumbers, cases: cases.length, caseList: cases })
        console.log(`[scrape/rh/test-discover] "${name}": ${accountNumbers.length} accts, ${cases.length} cases`)
      } catch (e: any) {
        results.push({ name, accountNumbers: [], cases: 0, caseList: [], error: sanitizeErr(e) })
        console.warn(`[scrape/rh/test-discover] "${name}" error: ${sanitizeErr(e)}`)
      }
    }
    return c.json({ results })
  })

  // ╭──────────────────────────────────────────────────────────────────────────╮
  // │  CCSP (Tableau)                                                         │
  // ╰──────────────────────────────────────────────────────────────────────────╯

  if (isPrimary()) {
  // POST /api/scrape/ccsp — full pipeline: Tableau scrape → sheet → cache
  // BKL-M49: Manual triggers go through the scraper queue
  // Manual "Run Now" overrides circuit breaker
  app.post('/api/scrape/ccsp', async (c) => {
    try { await ensureBrowserHealthy() } catch (e: any) { return c.json({ error: sanitizeErr(e) }, 503) }
    // Stale-mutex auto-release: if the flag has been stuck for >15 min (container restart, crash),
    // let the request through — runCcspScrape() will reset the mutex internally.
    const ccspStale = ccspScrapeRunning && ccspScrapeStartedAt &&
      (Date.now() - ccspScrapeStartedAt > 15 * 60 * 1000)
    if (ccspStale) console.warn(`[scrape:ccsp] stale mutex detected (${Math.round((Date.now() - ccspScrapeStartedAt!) / 60000)}min) — allowing request through`)
    // ARCHITECTURE.md §9: check BOTH mutex guards (skip if stale)
    if ((ccspScrapeRunning || ccspInFlight) && !ccspStale) return c.json({ scraper: 'ccsp', status: 'busy', error: 'CCSP scrape already in progress' }, 409)
    resetCircuitBreaker('ccsp')

    const eligibleAes = aes.filter(a => a.tableauTerritories?.length && a.driveFolderId)
    if (!eligibleAes.length) return c.json({ error: 'No AEs with tableauTerritories and driveFolderId configured' }, 400)

    markRunning('ccsp')  // BKL-ADM01: set state synchronously before the task runs
    enqueueScraperTask({
      name: 'ccsp',
      run: async () => {
        setCcspInFlight(true)
        const _ccspTelemetryStart = Date.now()
        let recordCount = 0
        try {
          const results = await runCcspScrape(eligibleAes)
          recordCount = results.length
          for (const ae of eligibleAes) {
            const aeResults = results.filter(r => r.aeName === ae.name)
            const spreadsheetId = await writeCcspSheet(aeResults, ae.name, ae.driveFolderId, ae.ccspSheetId || undefined)
            patchAe(ae.name, { ccspSheetId: spreadsheetId })
            console.log(`[scrape:ccsp] sheet ready for ${ae.name}: ${spreadsheetId}`)
          }
          // Stage 2: refresh local cache from the sheets we just wrote
          await refreshCCSP().catch(e => console.warn('[scrape:ccsp] cache refresh failed:', sanitizeErr(e)))

          // BKL-M50e: Record telemetry
          recordScrapeResult({
            timestamp: new Date().toISOString(),
            service: 'ccsp',
            durationMs: Date.now() - _ccspTelemetryStart,
            recordCount,
            status: 'success',
          })
        } catch (e: any) {
          recordScrapeResult({
            timestamp: new Date().toISOString(),
            service: 'ccsp',
            durationMs: Date.now() - _ccspTelemetryStart,
            recordCount: 0,
            status: 'failure',
            error: sanitizeErr(e),
          })
          throw e
        } finally {
          setCcspInFlight(false)
        }
      },
      source: 'manual',
      enqueuedAt: Date.now(),
    })

    return c.json({ started: true, aeCount: eligibleAes.length, queued: true })
  })
  } // NODE_ROLE primary guard — CCSP scrape is L4 only

  // GET /api/scrape/ccsp/status
  app.get('/api/scrape/ccsp/status', (c) => {
    const store = getScraperStatus('ccsp')
    const ccspCache = readCCSPCache()
    return c.json({
      running:    ccspScrapeRunning || ccspInFlight,
      // BKL-ARCH-02 Phase 1b: defer the in-memory ?? store.lastSuccess fallback
      // to getUnifiedStatus(); cache.cachedAt remains the preferred source
      // (covers the first request after container restart when in-memory is null).
      lastScrape: ccspCache?.cachedAt ?? getUnifiedStatus('ccsp').lastSync,
      lastError:  getUnifiedStatus('ccsp').lastError,
      // ScraperStatusStore fields for unified freshness tracking
      lastRun:       store.lastRun,
      lastSuccess:   store.lastSuccess,
      storeLastError: store.lastError,
      recordCount:   ccspCache?.records?.length ?? store.recordCount,
      state:         store.state,
    })
  })

  // ╭──────────────────────────────────────────────────────────────────────────╮
  // │  Salesforce pipeline (primary node only — BKL-SYNC-L3-02)              │
  // ╰──────────────────────────────────────────────────────────────────────────╯

  if (isPrimary()) {
  // POST /api/scrape/salesforce — full pipeline: SF report → sheet → cache
  // BKL-M49: Manual triggers go through the scraper queue
  // Manual "Run Now" overrides circuit breaker
  app.post('/api/scrape/salesforce', async (c) => {
    resetCircuitBreaker('sf-pipeline')
    const aesWithSf = aes.filter(a => a.sfReportId && a.driveFolderId)
    if (!aesWithSf.length && !SF_REPORT_ID) return c.json({ error: 'No AEs with sfReportId configured' }, 400)

    // Stale-mutex auto-release
    if (_sfSyncRunning && _sfSyncStartedAt && (Date.now() - _sfSyncStartedAt > 15 * 60 * 1000)) {
      console.warn('[scrape:salesforce] stale mutex detected — auto-releasing after 15 min')
      setSfSyncRunning(false)
      setSfSyncStartedAt(null)
    }
    if (_sfSyncRunning) return c.json({ scraper: 'sf-pipeline', status: 'busy', error: 'SF sync already in progress' }, 409)

    markRunning('sf-pipeline')  // BKL-ADM01: set state synchronously before the task runs
    enqueueScraperTask({
      name: 'sf-pipeline',
      run: async () => {
        setSfSyncRunning(true)
        setSfSyncStartedAt(Date.now())
        setSfSyncCancelRequested(false)
        setSfSyncLastError(null)
        const _sfTelemetryStart = Date.now()
        let totalRows = 0

        try {
          // BKL-F11: Group AEs by sfReportId — scrape each unique report once
          const reportToAes = new Map<string, typeof aesWithSf>()
          for (const ae of aesWithSf) {
            const reportId = ae.sfReportId!
            if (!reportToAes.has(reportId)) reportToAes.set(reportId, [])
            reportToAes.get(reportId)!.push(ae)
          }

          for (const [reportId, reportAes] of reportToAes) {
            if (_sfSyncCancelRequested) {
              console.log(`[scrape:salesforce] cancel requested — stopping before report ${reportId}`)
              break
            }

            if (reportAes.length > 1) {
              console.log(`[scrape:salesforce] Report ${reportId} shared by ${reportAes.length} AEs — scraping once, writing to ${reportAes.length} sheets`)
            }

            try {
              // Scrape once per unique report
              const data = await scrapeSfReport(reportId, RH_PROFILE_DIR)

              // BKL-SF-01: Find "Opportunity Territory Name" column for territory-based AE filtering
              const territoryIdx = data.headers.findIndex(h => /opportunity.*territory.*name/i.test(h))
              // Fallback: "Opportunity Owner" column for legacy name-based filtering
              const ownerIdx = data.headers.findIndex(h => h === 'Opportunity Owner')
              if (territoryIdx === -1 && ownerIdx === -1) {
                console.warn(`[scrape:salesforce] neither "Opportunity Territory Name" nor "Opportunity Owner" column found — writing all rows to every AE sheet (no filtering)`)
              } else if (territoryIdx !== -1) {
                console.log(`[scrape:salesforce] using territory-based filtering (column index ${territoryIdx})`)
              } else {
                console.warn(`[scrape:salesforce] "Opportunity Territory Name" column not found — falling back to owner name matching`)
              }

              // Fan out: write to each AE's pipeline sheet
              for (const ae of reportAes) {
                if (_sfSyncCancelRequested) {
                  console.log(`[scrape:salesforce] cancel requested — stopping before writing for ${ae.name}`)
                  break
                }
                try {
                  let sheetId = ae.pipelineSheetId
                  if (!sheetId) {
                    sheetId = await createPipelineSheet(ae.name, ae.driveFolderId)
                    patchAe(ae.name, { pipelineSheetId: sheetId })
                  }
                  // BKL-SF-01: Filter rows by territory (primary) or owner name (fallback)
                  let filteredRows: string[][]
                  if (territoryIdx !== -1 && ae.tableauTerritories?.length) {
                    // Primary path: match on "Opportunity Territory Name" column
                    const aeTerritoriesLower = ae.tableauTerritories.map(t => t.toLowerCase())
                    filteredRows = data.rows.filter(row => {
                      const territory = (row[territoryIdx] ?? '').toLowerCase()
                      return aeTerritoriesLower.some(t => territory === t || territory.includes(t))
                    })
                  } else if (ownerIdx !== -1) {
                    // Fallback: name-based prefix match (legacy behavior)
                    const aeFirstName = ae.name.split(' ')[0].toLowerCase()
                    filteredRows = data.rows.filter(row => {
                      const tokens = (row[ownerIdx] ?? '').toLowerCase().split(/\s+/)
                      return tokens.some(t => t.startsWith(aeFirstName) || aeFirstName.startsWith(t))
                    })
                  } else {
                    // No filtering columns available — include all rows
                    filteredRows = data.rows
                  }
                  const filteredData = { headers: data.headers, rows: filteredRows, droppedColumns: data.droppedColumns }
                  await writePipelineSheet(filteredData, sheetId)
                  totalRows += filteredRows.length
                  console.log(`[scrape:salesforce] wrote ${filteredRows.length} rows to ${ae.name}'s pipeline sheet (filtered from ${data.rows.length} total via ${territoryIdx !== -1 && ae.tableauTerritories?.length ? 'territory' : ownerIdx !== -1 ? 'owner-name' : 'none'})`)
                } catch (e: any) {
                  if (e instanceof SfSessionExpiredError) {
                    console.warn('[scrape:salesforce] SF session expired during sync')
                    setSfSyncLastError('SF session expired during sync')
                  } else {
                    console.error(`[scrape:salesforce] error writing for ${ae.name}:`, sanitizeErr(e))
                    setSfSyncLastError(sanitizeErr(e))
                  }
                }
              }
            } catch (e: any) {
              if (e instanceof SfSessionExpiredError) {
                console.warn('[scrape:salesforce] SF session expired during sync')
                setSfSyncLastError('SF session expired during sync')
              } else {
                console.error(`[scrape:salesforce] scrape failed for report ${reportId}:`, sanitizeErr(e))
                setSfSyncLastError(sanitizeErr(e))
              }
            }
          }

          // Fallback: env vars for backwards compatibility
          const envSheetId = process.env.PIPELINE_FILE_ID ?? ''
          if (!_sfSyncCancelRequested && !aesWithSf.length && SF_REPORT_ID && envSheetId) {
            if (!/^[a-zA-Z0-9_-]{10,}$/.test(envSheetId)) {
              console.warn('[scrape:salesforce] PIPELINE_FILE_ID env var failed format validation — skipping legacy fallback')
            } else {
              await runSfPipelineSync(SF_REPORT_ID, RH_PROFILE_DIR, envSheetId).catch((e: any) => console.error('[scrape:salesforce] env fallback failed:', sanitizeErr(e)))
            }
          }
        } finally {
          setSfSyncRunning(false)
          setSfSyncStartedAt(null)
          setSfSyncCancelRequested(false)

          // BKL-M50e: Record telemetry
          recordScrapeResult({
            timestamp: new Date().toISOString(),
            service: 'sf-pipeline',
            durationMs: Date.now() - _sfTelemetryStart,
            recordCount: totalRows,
            status: _sfSyncLastError ? 'failure' : 'success',
            error: _sfSyncLastError ?? undefined,
          })

          // Update legacy in-memory status (powers /api/status/scrapes isStale check)
          if (!_sfSyncLastError && totalRows > 0) recordSfSyncSuccess(totalRows)

          // ScraperStatusStore: record outcome with actual row count
          recordOutcome('sf-pipeline', {
            success: !_sfSyncLastError,
            recordCount: totalRows,
            durationMs: Date.now() - _sfTelemetryStart,
            error: _sfSyncLastError ?? undefined,
          })

          // Stage 2: refresh local cache from the sheets we just wrote (BKL-M18)
          await refreshPipeline().catch(e => console.warn('[scrape:salesforce] post-sync cache refresh failed:', sanitizeErr(e)))
        }
      },
      source: 'manual',
      enqueuedAt: Date.now(),
    })

    return c.json({ started: true, aes: aesWithSf.map(a => a.name), queued: true })
  })

  // DELETE /api/scrape/salesforce/cancel
  app.delete('/api/scrape/salesforce/cancel', (c) => {
    if (!_sfSyncRunning) return c.json({ ok: false, reason: 'No SF sync in progress' })
    setSfSyncCancelRequested(true)
    console.log('[scrape:salesforce] cancel requested via API')
    return c.json({ ok: true })
  })
  } // end NODE_ROLE === 'primary' guard for SF pipeline routes

  // GET /api/scrape/salesforce/status — read-only, available on all nodes
  app.get('/api/scrape/salesforce/status', (c) => {
    const store = getScraperStatus('sf-pipeline')
    // BKL-ARCH-02 Phase 1b: lastSync resolution centralised in getUnifiedStatus
    // (in-memory hint ?? store.lastSuccess ?? null). Same fallback the legacy
    // call site composed inline.
    return c.json({
      isRunning: _sfSyncRunning,
      lastSync:  getUnifiedStatus('sf-pipeline').lastSync,
      lastError: _sfSyncLastError,
      // ScraperStatusStore fields for unified freshness tracking
      lastRun:       store.lastRun,
      lastSuccess:   store.lastSuccess,
      storeLastError: store.lastError,
      recordCount:   store.recordCount,
      state:         store.state,
    })
  })

  // ╭──────────────────────────────────────────────────────────────────────────╮
  // │  POST /api/scrape/all — run all four in safe sequence via queue         │
  // ╰──────────────────────────────────────────────────────────────────────────╯
  // BKL-M49: Enqueue all four scrapers as a single compound task through the
  // scraper queue. They run sequentially within the task (same as before),
  // but now respect the global queue so they don't collide with other triggers.

  app.post('/api/scrape/all', async (c) => {
    try { await ensureBrowserHealthy() } catch (e: any) { return c.json({ error: sanitizeErr(e) }, 503) }
    enqueueScraperTask({
      name: 'all-scrapers',
      run: async () => {
        const scrapers: { name: string; run: () => Promise<void> }[] = [
          {
            name: 'rh-cases',
            run: async () => {
              if (_rhScrapeRunning) { console.log('[scrape:all] rh-cases: busy — skipping'); return }
              await runRhScrapeWithState()
            },
          },
        ]

        if (isPrimary()) {
          scrapers.push(
          {
            name: 'ccsp',
            run: async () => {
              // Stale-mutex passthrough: if stuck >15 min, let runCcspScrape() handle reset
              const ccspStaleAll = ccspScrapeRunning && ccspScrapeStartedAt &&
                (Date.now() - ccspScrapeStartedAt > 15 * 60 * 1000)
              if ((ccspScrapeRunning || ccspInFlight) && !ccspStaleAll) { console.log('[scrape:all] ccsp: busy — skipping'); return }
              const eligibleAes = aes.filter(a => a.tableauTerritories?.length && a.driveFolderId)
              if (!eligibleAes.length) { console.log('[scrape:all] ccsp: no eligible AEs — skipping'); return }
              setCcspInFlight(true)
              const _ccspTelemetryStart = Date.now()
              let recordCount = 0
              try {
                const ccspResults = await runCcspScrape(eligibleAes)
                recordCount = ccspResults.length
                for (const ae of eligibleAes) {
                  const aeResults = ccspResults.filter(r => r.aeName === ae.name)
                  const sheetId = await writeCcspSheet(aeResults, ae.name, ae.driveFolderId, ae.ccspSheetId || undefined)
                  patchAe(ae.name, { ccspSheetId: sheetId })
                }
                await refreshCCSP().catch(() => {})
                recordScrapeResult({
                  timestamp: new Date().toISOString(),
                  service: 'ccsp',
                  durationMs: Date.now() - _ccspTelemetryStart,
                  recordCount,
                  status: 'success',
                })
              } catch (e: any) {
                recordScrapeResult({
                  timestamp: new Date().toISOString(),
                  service: 'ccsp',
                  durationMs: Date.now() - _ccspTelemetryStart,
                  recordCount: 0,
                  status: 'failure',
                  error: sanitizeErr(e),
                })
                throw e
              } finally {
                setCcspInFlight(false)
              }
            },
          },
          {
            name: 'sf-pipeline',
            run: async () => {
              if (_sfSyncRunning) { console.log('[scrape:all] sf-pipeline: busy — skipping'); return }
              const aesWithSf = aes.filter(a => a.sfReportId && a.driveFolderId)
              if (!aesWithSf.length) { console.log('[scrape:all] sf-pipeline: no AEs — skipping'); return }
              setSfSyncRunning(true)
              setSfSyncStartedAt(Date.now())
              const _sfTelemetryStart = Date.now()
              let totalRows = 0
              try {
                // BKL-F11: Group AEs by sfReportId — scrape each unique report once
                const reportToAes = new Map<string, typeof aesWithSf>()
                for (const ae of aesWithSf) {
                  const reportId = ae.sfReportId!
                  if (!reportToAes.has(reportId)) reportToAes.set(reportId, [])
                  reportToAes.get(reportId)!.push(ae)
                }

                for (const [reportId, reportAes] of reportToAes) {
                  if (reportAes.length > 1) {
                    console.log(`[scrape:all:salesforce] Report ${reportId} shared by ${reportAes.length} AEs — scraping once`)
                  }
                  const data = await scrapeSfReport(reportId, RH_PROFILE_DIR)
                  // BKL-F11: Find "Opportunity Owner" column index for per-AE filtering
                  const ownerIdx = data.headers.findIndex(h => h === 'Opportunity Owner')
                  if (ownerIdx === -1) {
                    console.warn(`[scrape:all:salesforce] "Opportunity Owner" column not found in headers — writing all rows to every AE sheet (no filtering)`)
                  }
                  for (const ae of reportAes) {
                    let sheetId = ae.pipelineSheetId
                    if (!sheetId) {
                      sheetId = await createPipelineSheet(ae.name, ae.driveFolderId)
                      patchAe(ae.name, { pipelineSheetId: sheetId })
                    }
                    // BKL-F11/F11b: Filter rows to this AE's opportunities only (exact word-token match, case-insensitive)
                    const aeFirstName = ae.name.split(' ')[0].toLowerCase()
                    const filteredRows = ownerIdx !== -1
                      ? data.rows.filter(row => (row[ownerIdx] ?? '').toLowerCase().split(/\s+/).includes(aeFirstName))
                      : data.rows
                    const filteredData = { headers: data.headers, rows: filteredRows, droppedColumns: data.droppedColumns }
                    await writePipelineSheet(filteredData, sheetId)
                    totalRows += filteredRows.length
                  }
                }
                await refreshPipeline().catch(() => {})

                // BKL-M50e: Record telemetry
                recordScrapeResult({
                  timestamp: new Date().toISOString(),
                  service: 'sf-pipeline',
                  durationMs: Date.now() - _sfTelemetryStart,
                  recordCount: totalRows,
                  status: 'success',
                })
              } catch (e: any) {
                recordScrapeResult({
                  timestamp: new Date().toISOString(),
                  service: 'sf-pipeline',
                  durationMs: Date.now() - _sfTelemetryStart,
                  recordCount: totalRows,
                  status: 'failure',
                  error: sanitizeErr(e),
                })
                throw e
              } finally {
                setSfSyncRunning(false)
                setSfSyncStartedAt(null)
              }
            },
          },
          )
        }

        // Sequential — shared browser context (ARCHITECTURE.md s1)
        for (const scraper of scrapers) {
          try {
            console.log(`[scrape:all] starting ${scraper.name}`)
            await scraper.run()
            console.log(`[scrape:all] ${scraper.name} complete`)
          } catch (e: any) {
            console.error(`[scrape:all] ${scraper.name} error:`, sanitizeErr(e))
          }
        }
      },
      source: 'manual',
      enqueuedAt: Date.now(),
    })

    return c.json({ started: true, queued: true })
  })

  // GET /api/scrape/queue — queue status for admin visibility (BKL-M49)
  app.get('/api/scrape/queue', (c) => {
    return c.json(getScraperQueueStatus())
  })

  // ╭──────────────────────────────────────────────────────────────────────────╮
  // │  BKL-M50e: Scraper telemetry                                           │
  // ╰──────────────────────────────────────────────────────────────────────────╯

  // GET /api/scrape/telemetry — full scrape history log with summary stats
  app.get('/api/scrape/telemetry', (c) => {
    return c.json({
      log: getTelemetryLog(),
      summary: getTelemetrySummary(),
    })
  })

  // GET /api/scraper-status — centralized status map from ScraperStatusStore
  // Returns ScraperStatusMap with staleness applied per scraper threshold,
  // plus circuit breaker states and scheduler queue state.
  app.get('/api/scraper-status', async (c) => {
    return c.json({
      scrapers: getStatus(),
      circuitBreakers: getCircuitBreakerStates(),
      queue: getScraperQueueStatus(),
      browserRestartNeeded: detectBrowserCrash(),
      rhDiscoveryProgress: _rhDiscoveryProgress,
    })
  })

  // ── Browser management endpoints ─────────────────────────────────────────

  /** Restart the shared Playwright browser context without a full container rebuild.
   *  Kills zombie Chrome processes, signals the scraper queue to relaunch the context. */
  app.post('/api/browser/restart', async (c) => {
    try {
      // Kill any zombie/stuck chrome processes
      Bun.spawnSync(['pkill', '-f', 'chrome'], { stderr: 'ignore' })
      await new Promise(r => setTimeout(r, 1_500))
      return c.json({ ok: true, message: 'Browser processes killed — context will relaunch on next scrape' })
    } catch (e: any) {
      return c.json({ ok: false, error: sanitizeErr(e) }, 500)
    }
  })

  /** Open a Chromium window to the Tableau login page in the VNC display.
   *  Use this when the Tableau session has expired and you need to re-authenticate. */
  app.post('/api/browser/open-tableau-login', async (c) => {
    // BKL-HERO-21: guard — Chromium only installed in L4 image
    if (!isPrimary()) return c.json({ error: 'Not available on hero nodes' }, 404)
    try {
      const TABLEAU_LOGIN = 'https://10ay.online.tableau.com/#/site/redhatanalytics/signin'
      // Launch Chromium directly on the VNC display for manual login
      Bun.spawn(
        ['/ms-playwright/chromium-1208/chrome-linux/chrome',
          '--no-sandbox', '--disable-dev-shm-usage',
          `--display=${process.env.DISPLAY ?? ':99'}`,
          TABLEAU_LOGIN],
        { env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':99' } }
      )
      return c.json({ ok: true, message: 'Opening Tableau login in VNC browser — connect to http://localhost:6080 to authenticate' })
    } catch (e: any) {
      return c.json({ ok: false, error: sanitizeErr(e) }, 500)
    }
  })

  /** Save content.redhat.com cookies from the shared browser context for use in product intelligence scraping. */
  app.post('/api/browser/save-content-rh-session', async (c) => {
    try {
      const ctx = getScrapeContext()
      if (!ctx) return c.json({ ok: false, error: 'No active browser context — connect Red Hat Portal first' }, 400)
      const state = await safeCookieOp(ctx, 'save-content-rh-session storageState', c => c.storageState(), { cookies: [], origins: [] })
      const contentRhCookies = state.cookies.filter(ck => ck.domain.includes('content.redhat.com') || ck.domain.includes('.redhat.com'))
      if (contentRhCookies.length === 0) return c.json({ ok: false, error: 'No content.redhat.com cookies found — open VNC and log in at content.redhat.com first' }, 400)
      const profileDir = process.env.RH_PROFILE_DIR ?? '/data/rh-profile'
      mkdirSync(profileDir, { recursive: true })
      const sessionPath = resolve(profileDir, 'content-rh-session.json')
      writeFileAtomic(sessionPath, JSON.stringify({ cookies: contentRhCookies, savedAt: new Date().toISOString() }))
      return c.json({ ok: true, cookieCount: contentRhCookies.length, savedAt: new Date().toISOString() })
    } catch (e: any) {
      return c.json({ ok: false, error: sanitizeErr(e) }, 500)
    }
  })

  // ── BKL-AI11: NotebookLM routes ─────────────────────────────────────────────

  // GET /api/notebooklm/status — is the feature enabled?
  app.get('/api/notebooklm/status', (c) => c.json({
    enabled: isNotebookLmEnabled(),
    message: isNotebookLmEnabled()
      ? 'NotebookLM integration active'
      : 'Set NOTEBOOKLM_ENABLED=true in .env and ensure Discovery Engine API is enabled in GCP',
  }))

  // POST /api/customer/:name/notebook — create or update notebook for one customer
  app.post('/api/customer/:name/notebook', async (c) => {
    if (!isNotebookLmEnabled()) {
      return c.json({ error: 'NotebookLM not enabled — set NOTEBOOKLM_ENABLED=true in .env' }, 503)
    }
    const name = decodeURIComponent(c.req.param('name'))
    const customer = customers.find(cu => cu.name === name)
    if (!customer) return c.json({ error: 'Customer not found' }, 404)
    if (!customer.driveFolderId) {
      return c.json({ error: 'Customer has no Drive folder — run bootstrap first' }, 400)
    }

    try {
      // List Drive files in customer folder
      const { google } = await import('googleapis')
      const { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } = await import('./google.ts')
      const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
      const drive = google.drive({ version: 'v3', auth })
      const driveRes = await drive.files.list({
        q: `'${customer.driveFolderId}' in parents and trashed=false`,
        fields: 'files(id,name,mimeType,modifiedTime)',
        pageSize: 100,
      })
      const driveFiles = (driveRes.data.files ?? [])
        .filter(f => f.id && f.name)
        .map(f => ({ id: f.id!, name: f.name!, modifiedTime: f.modifiedTime ?? undefined }))

      const result = await createOrUpdateNotebook(customer, driveFiles)
      patchCustomer(name, { notebookId: result.notebookId, notebookUrl: result.notebookUrl })
      return c.json({ success: true, ...result })
    } catch (e: any) {
      console.error(`[notebooklm] create/update failed for ${name}:`, sanitizeErr(e))
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // POST /api/admin/notebooks/create-all — batch create notebooks for all customers
  app.post('/api/admin/notebooks/create-all', async (c) => {
    if (!isNotebookLmEnabled()) {
      return c.json({ error: 'NotebookLM not enabled — set NOTEBOOKLM_ENABLED=true in .env' }, 503)
    }

    const eligible = customers.filter(cu => cu.driveFolderId)
    const results: Array<{ name: string; status: 'ok' | 'error'; notebookUrl?: string; error?: string }> = []

    for (const customer of eligible) {
      try {
        const { google } = await import('googleapis')
        const { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } = await import('./google.ts')
        const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
        const drive = google.drive({ version: 'v3', auth })
        const driveRes = await drive.files.list({
          q: `'${customer.driveFolderId}' in parents and trashed=false`,
          fields: 'files(id,name,mimeType,modifiedTime)',
          pageSize: 100,
        })
        const driveFiles = (driveRes.data.files ?? [])
          .filter(f => f.id && f.name)
          .map(f => ({ id: f.id!, name: f.name!, modifiedTime: f.modifiedTime ?? undefined }))

        const result = await createOrUpdateNotebook(customer, driveFiles)
        patchCustomer(customer.name, { notebookId: result.notebookId, notebookUrl: result.notebookUrl })
        results.push({ name: customer.name, status: 'ok', notebookUrl: result.notebookUrl })
      } catch (e: any) {
        const msg = sanitizeErr(e)
        console.error(`[notebooklm] create-all failed for ${customer.name}:`, msg)
        results.push({ name: customer.name, status: 'error', error: msg })
      }
    }

    const ok = results.filter(r => r.status === 'ok').length
    return c.json({ total: eligible.length, ok, failed: eligible.length - ok, results })
  })

  // ── GET /api/sf-bookings/pod-sheets — list available POD sheets from Drive folder ──
  // BKL-UX75: Accepts optional ?folderId= query param so the UI can fetch sheets
  // immediately after the user validates a folder, before settings.json is written.
  // Falls back to settings.json → podBookingsFolderId if no param is provided.
  app.get('/api/sf-bookings/pod-sheets', async (c) => {
    const LOCAL_SETTINGS_PATH = resolve(CONFIG_DIR, 'settings.json')
    let podBookingsFolderId: string | null = c.req.query('folderId') ?? null
    const regionId = c.req.query('region') ?? undefined
    if (!podBookingsFolderId) {
      try {
        const raw = readFileSync(SETTINGS_PATH, 'utf-8')
        const settings = normalizeSettings(JSON.parse(raw))
        const region = getRegionById(settings, regionId)
        podBookingsFolderId = region.podBookingsFolderId || null
      } catch { /* no settings */ }
    }
    if (!podBookingsFolderId) return c.json({ sheets: [] })
    try {
      const sheets = await listPodBookingSheets(podBookingsFolderId)
      return c.json({ sheets: sheets.map(s => ({ name: s.name, displayName: s.displayName, sheetId: s.sheetId })) })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 400)
    }
  })

  // ── POST /api/sf-bookings/pod-folder — persist podBookingsFolderId to settings.json ──
  // BKL-UX75: Called by Setup UI after the user validates a Drive folder, so subsequent
  // loads (and sf-bookings-sync) find the folder without manual settings.json editing.
  app.post('/api/sf-bookings/pod-folder', async (c) => {
    let body: { folderId?: string; podKey?: string }
    try { body = await c.req.json() } catch { body = {} }
    const folderId = (body.folderId ?? '').trim()
    const podKey = (body.podKey ?? '').trim()
    if (!folderId) return c.json({ error: 'folderId required' }, 400)
    const LOCAL_SETTINGS_PATH = resolve(CONFIG_DIR, 'settings.json')
    try {
      mkdirSync(CONFIG_DIR, { recursive: true })
      let settings: Record<string, unknown> = {}
      try { settings = JSON.parse(readFileSync(LOCAL_SETTINGS_PATH, 'utf-8')) } catch { /* new file */ }
      // If podKey provided, write to the matching region (region-aware, BKL-UX93-fix).
      // Fall back to flat root for backwards compatibility when no podKey is given.
      if (podKey) {
        const normalized = normalizeSettings(settings)
        const region = normalized.regions.find((r: any) => podKey in (r.pods ?? {}))
        if (region) {
          // Mutate the matching region in the original settings object
          const regions = (settings.regions ?? []) as any[]
          const idx = regions.findIndex((r: any) => podKey in (r.pods ?? {}))
          if (idx >= 0) regions[idx].podBookingsFolderId = folderId
        }
      } else {
        settings.podBookingsFolderId = folderId
      }
      writeJsonAtomic(LOCAL_SETTINGS_PATH, settings)

      // After local save succeeds, sync updated settings to Drive Config/settings.json (best-effort)
      try {
        const { writeSettingsToDrive } = await import('./drive-config-sync.ts')
        const updatedRaw = JSON.parse(readFileSync(LOCAL_SETTINGS_PATH, 'utf-8'))
        const updatedSettings = normalizeSettings(updatedRaw)
        const parentFolderId = updatedSettings.regions[0]?.parentFolderId
        if (parentFolderId) {
          await writeSettingsToDrive(parentFolderId)
        }
      } catch (driveErr: any) {
        console.warn('[sf-bookings/pod-folder] Drive settings sync error (non-fatal):', sanitizeErr(driveErr))
      }

      return c.json({ ok: true, podBookingsFolderId: folderId })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/settings/pod-config — POD-scoped config for the Setup UI ────
  // BKL-ARCH-01: Region-aware. Accepts ?region=<id>, defaults to first region
  // for backward compat. Returns flat podSfReports/podLabels maps for the
  // requested region so the frontend can keep its existing shape.
  app.get('/api/settings/pod-config', (c) => {
    const regionId = c.req.query('region') ?? undefined
    let podBookingsFolderId: string | null = null
    let parentFolderId: string = ''
    let podSfReports: Record<string, string> = {}
    let podLabels: Record<string, string> = {}
    let territorySheetUrl: string | null = null
    try {
      const raw = readFileSync(SETTINGS_PATH, 'utf-8')
      const settings = normalizeSettings(JSON.parse(raw))
      const region = getRegionById(settings, regionId)
      podBookingsFolderId = region.podBookingsFolderId || null
      parentFolderId = region.parentFolderId || ''
      territorySheetUrl = region.territorySheetUrl || null
      const visiblePods = Object.fromEntries(
        Object.entries(region.pods).filter(([_, p]) => !p.hidden)
      ) as typeof region.pods
      const visibleRegion = { ...region, pods: visiblePods }
      podSfReports = flattenPodSfReports(visibleRegion)
      podLabels = flattenPodLabels(visibleRegion)
    } catch { /* no settings file yet — return empty defaults */ }
    return c.json({ podBookingsFolderId, parentFolderId, podSfReports, podLabels, territorySheetUrl })
  })

  // ── POST /api/settings/parent-folder — save parentFolderId separately from podBookingsFolderId ──
  // BKL-HERO-PARENT-FOLDER-CONFUSION: parentFolderId (CommandCenter root for AE folders)
  // is semantically distinct from podBookingsFolderId (Subscription Data folder for L3 CSVs).
  app.post('/api/settings/parent-folder', async (c) => {
    try {
      const body = await c.req.json<{ folderId?: string; region?: string }>()
      const folderId = typeof body.folderId === 'string' ? body.folderId.trim() : ''
      const regionId = typeof body.region === 'string' ? body.region : undefined
      const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
      const normalized = normalizeSettings(settings)
      const region = getRegionById(normalized, regionId)

      // Write parentFolderId to the matching region in settings.json
      if (Array.isArray(settings.regions)) {
        const idx = settings.regions.findIndex((r: any) => r.id === region.id)
        if (idx >= 0) settings.regions[idx].parentFolderId = folderId
      } else {
        settings.parentFolderId = folderId
      }
      writeJsonAtomic(SETTINGS_PATH, settings)

      // Best-effort Drive config sync
      try {
        const { writeSettingsToDrive } = await import('./drive-config-sync.ts')
        if (folderId) {
          await writeSettingsToDrive(folderId)
        }
      } catch (driveErr: any) {
        console.warn('[settings/parent-folder] Drive settings sync error (non-fatal):', sanitizeErr(driveErr))
      }

      return c.json({ ok: true, parentFolderId: folderId })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/settings/regions — list available regions for the UI selector ──
  // BKL-ARCH-01. Returns a lightweight list (id, label, type) so the frontend
  // can render a region dropdown without pulling per-region pod config.
  app.get('/api/settings/regions', (c) => {
    const LOCAL_SETTINGS_PATH = resolve(CONFIG_DIR, 'settings.json')
    try {
      const raw = readFileSync(LOCAL_SETTINGS_PATH, 'utf-8')
      const settings = normalizeSettings(JSON.parse(raw))
      const regions = settings.regions.map(r => ({ id: r.id, label: r.label, type: r.type }))
      return c.json({ regions })
    } catch {
      return c.json({ regions: [] })
    }
  })

  // ── POST /api/wizard/setup-region — BKL-ONBOARD-10 ───────────────────────
  // Creates (or returns existing) region from a Google Sheets territory URL.
  // Idempotent on territorySheetUrl.
  app.post('/api/wizard/setup-region', async (c) => {
    try {
      let body: { sheetUrl?: unknown; label?: unknown; sfReportId?: unknown }
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON' }, 400)
      }
      const sheetUrl = typeof body.sheetUrl === 'string' ? body.sheetUrl : ''
      const label = typeof body.label === 'string' ? body.label : ''
      const sfReportId = typeof body.sfReportId === 'string' ? body.sfReportId : ''

      if (!sheetUrl.includes('/spreadsheets/d/')) {
        return c.json({ error: 'sheetUrl must be a Google Sheets URL' }, 400)
      }
      if (!label) {
        return c.json({ error: 'label required' }, 400)
      }
      if (!sfReportId) {
        return c.json({ error: 'sfReportId required' }, 400)
      }

      const match = sheetUrl.match(/\/spreadsheets\/d\/([^/]+)/)
      if (!match) {
        return c.json({ error: 'sheetUrl must be a Google Sheets URL' }, 400)
      }
      const regionId = match[1]
      // Slug guard — baseline requirement (SECURITY-BASELINE.md cache-path-slug-guards)
      if (!regionId || /[^a-zA-Z0-9_-]/.test(regionId)) {
        return c.json({ error: 'sheetUrl contains invalid spreadsheet ID' }, 400)
      }

      const LOCAL_SETTINGS_PATH = resolve(CONFIG_DIR, 'settings.json')
      mkdirSync(CONFIG_DIR, { recursive: true })
      let settings: Record<string, unknown> = {}
      try {
        settings = JSON.parse(readFileSync(LOCAL_SETTINGS_PATH, 'utf-8'))
      } catch { /* new file */ }

      const normalized = normalizeSettings(settings)
      const found = normalized.regions.find(r => r.territorySheetUrl === sheetUrl)
      if (found) {
        return c.json({ success: true, regionId: found.id })
      }

      const newRegion: RegionConfig = {
        id: regionId,
        label,
        type: 'commercial',
        territorySheetUrl: sheetUrl,
        podBookingsFolderId: '',
        parentFolderId: '',
        pods: {},
      }

      const regions = Array.isArray(settings.regions) ? settings.regions : []
      settings.regions = [...regions, newRegion]
      writeJsonAtomic(LOCAL_SETTINGS_PATH, settings)

      return c.json({ success: true, regionId })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/wizard/seed-sheets — BKL-ONBOARD-10 ─────────────────────────
  // Returns the built-in seed territory sheet URLs.
  app.get('/api/wizard/seed-sheets', (c) => {
    return c.json({
      sheets: [
        'https://docs.google.com/spreadsheets/d/1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8/edit?gid=294606982#gid=294606982',
        'https://docs.google.com/spreadsheets/d/1p5nM6NNB-vCnaoKxyThnR1zuj_e_80WqzmWh-RsODlQ/edit?gid=409386986#gid=409386986',
        'https://docs.google.com/spreadsheets/d/111gcacXSkB4uNrDNQAuL7fvcS6YQi_6Wfl9hhffJsU0/edit?gid=1703062703#gid=1703062703',
      ],
    })
  })

  // ── POST /api/scrape/sf-bookings-sync — BKL-SF-01 ────────────────────────
  // Reads Salesforce bookings GSheets (discovered from Drive folder in settings.json) and
  // writes subscription data into each AE's Supportable sheet.
  //
  // Body: { aeNames?: string[] }
  //   aeNames  — optional list of AE names to sync (defaults to all AEs)
  app.post('/api/scrape/sf-bookings-sync', async (c) => {
    let body: { aeNames?: string[]; region?: string }
    try { body = await c.req.json() } catch { body = {} }

    const { aeNames, region: regionId } = body

    // BKL-ARCH-01: Region-aware folder lookup. Defaults to first region when no id provided.
    const LOCAL_SETTINGS_PATH = resolve(CONFIG_DIR, 'settings.json')
    let podBookingsFolderId: string | null = null
    try {
      const raw = readFileSync(SETTINGS_PATH, 'utf-8')
      const settings = normalizeSettings(JSON.parse(raw))
      const region = getRegionById(settings, regionId)
      podBookingsFolderId = region.podBookingsFolderId || null
    } catch { /* no settings file */ }

    if (!podBookingsFolderId) {
      return c.json({ error: 'podBookingsFolderId not configured in settings.json' }, 400)
    }

    // Discover POD sheets from Drive folder — { name, sheetId }[]
    let podSheets: Array<{ name: string; sheetId: string }> = []
    try {
      podSheets = await listPodBookingSheets(podBookingsFolderId)
      console.log(`[sf-bookings-sync] found ${podSheets.length} POD sheet(s) in folder: ${podSheets.map(s => s.name).join(', ')}`)
    } catch (e: any) {
      return c.json({ error: `Failed to list POD sheets from Drive folder: ${sanitizeErr(e)}` }, 500)
    }

    if (!podSheets.length) {
      return c.json({ error: 'No sheets found in podBookingsFolderId — check folder contents' }, 400)
    }

    const targetAes = aeNames?.length
      ? aes.filter(ae => aeNames.includes(ae.name))
      : aes

    if (!targetAes.length) return c.json({ error: 'No matching AEs found' }, 400)

    const summary: Array<{
      ae: string
      customersTotal: number
      customersMatched: number
      customersEmpty: number
      sheetId: string | null
      error?: string
    }> = []

    // Fetch each POD sheet once — cached per sheetId to avoid quota burns
    const rawDataCache = new Map<string, Awaited<ReturnType<typeof fetchSfBookingsRaw>>>()

    // Helper: resolve which POD sheet to use for an AE based on tableauTerritories
    function resolveSheetForAe(territories: string[]): string | null {
      return matchPodSheet(podSheets, territories)
    }

    for (let aeIdx = 0; aeIdx < targetAes.length; aeIdx++) {
      // Pace sheet writes to stay under Sheets API quota (300 writes/min/user as of 2026-04-08).
      // writeSubscriptionSheet makes ~3-4 API calls per AE; 3s gives ~20 AEs/min headroom.
      if (aeIdx > 0) await new Promise(r => setTimeout(r, 3_000))

      const ae = targetAes[aeIdx]
      const territories = ae.tableauTerritories ?? []

      if (!territories.length) {
        console.warn(`[sf-bookings-sync] ${ae.name}: no tableauTerritories configured — skipping`)
        summary.push({ ae: ae.name, customersTotal: 0, customersMatched: 0, customersEmpty: 0, sheetId: null, error: 'No territories configured' })
        continue
      }

      const aeSheetId = resolveSheetForAe(territories)
      if (!aeSheetId) {
        console.warn(`[sf-bookings-sync] ${ae.name}: no podBookingsSheet matches territories [${territories.join(', ')}] — skipping`)
        summary.push({ ae: ae.name, customersTotal: 0, customersMatched: 0, customersEmpty: 0, sheetId: null, error: 'No matching POD sheet for territories' })
        continue
      }

      try {
        // Fetch POD sheet (cached per sheetId — one fetch per POD, reused across AEs)
        if (!rawDataCache.has(aeSheetId)) {
          console.log(`[sf-bookings-sync] fetching POD sheet ${aeSheetId}`)
          rawDataCache.set(aeSheetId, await fetchSfBookingsRaw(aeSheetId))
        }
        const rawData = rawDataCache.get(aeSheetId)!

        // SF sheet is the source of truth — derive customer list from the sheet by territory.
        // existingCustomers passed only to preserve known names + accountNumbers.
        const existingCustomers = customers.filter(cu => cu.ae === ae.name)
        console.log(`[sf-bookings-sync] ${ae.name}: deriving customers from sheet (territories: ${territories.join(', ')})`)

        const { results, matched, newCustomers, aliasedCustomers, ccspOnly } = deriveSfCustomersByTerritory(
          rawData, territories, existingCustomers, ae.name, false,
        )

        // Upsert net-new customers + alias updates into customers.json
        if (newCustomers.length > 0 || aliasedCustomers.length > 0) {
          const allCustomers = [...customers]
          for (const nc of newCustomers) {
            if (!allCustomers.some(c => c.name === nc.name)) {
              allCustomers.push(nc)
              console.log(`[sf-bookings-sync] new customer: ${nc.name} (${ae.name})`)
            }
          }
          for (const ac of aliasedCustomers) {
            const idx = allCustomers.findIndex(c => c.name === ac.name)
            if (idx !== -1) allCustomers[idx] = ac
            console.log(`[sf-bookings-sync] alias updated: ${ac.name} → ${ac.aliases?.join(', ')}`)
          }
          saveCustomers(allCustomers)

          // Create Drive subfolders for net-new customers
          if (ae.driveFolderId) {
            for (const nc of newCustomers) {
              try {
                const folderId = await driveClient.ensureChildFolder(ae.driveFolderId, nc.name)
                patchCustomer(nc.name, { driveFolderId: folderId })
                console.log(`[sf-bookings-sync] customer folder created: ${nc.name} (${folderId})`)
              } catch (e: any) {
                console.warn(`[sf-bookings-sync] customer folder creation failed for ${nc.name}: ${e.message}`)
              }
            }
          }
        }

        // Persist CCSP-only flag
        for (const name of ccspOnly) patchCustomer(name, { ccspCustomer: true })
        for (const name of matched) patchCustomer(name, { ccspCustomer: false })

        if (results.length === 0) {
          console.warn(`[sf-bookings-sync] ${ae.name}: no customers found — skipping sheet write`)
          summary.push({
            ae: ae.name,
            customersTotal: 0,
            customersMatched: 0,
            customersEmpty: 0,
            sheetId: ae.subscriptionSheetId ?? null,
            error: 'No customers found — sheet not updated',
          })
          continue
        }

        const spreadsheetId = await writeSubscriptionSheet(
          results,
          ae.name,
          ae.driveFolderId,
          ae.subscriptionSheetId || undefined,
        )

        if (!ae.subscriptionSheetId) {
          patchAe(ae.name, { subscriptionSheetId: spreadsheetId })
        }

        console.log(`[sf-bookings-sync] ${ae.name}: ${matched.length} customers, ${newCustomers.length} new, ${aliasedCustomers.length} alias-updated → sheet ${spreadsheetId}`)
        summary.push({
          ae: ae.name,
          customersTotal: results.length,
          customersMatched: matched.length,
          customersEmpty: results.length - matched.length,
          sheetId: spreadsheetId,
        })
      } catch (e: any) {
        const msg = sanitizeErr(e)
        console.error(`[sf-bookings-sync] ${ae.name}: error — ${msg}`)
        summary.push({
          ae: ae.name,
          customersTotal: 0,
          customersMatched: 0,
          customersEmpty: 0,
          sheetId: null,
          error: msg,
        })
      }
    }

    const totalMatched = summary.reduce((s, r) => s + r.customersMatched, 0)
    const totalCustomers = summary.reduce((s, r) => s + r.customersTotal, 0)
    return c.json({ aes: targetAes.length, customersTotal: totalCustomers, customersMatched: totalMatched, summary })
  })

  // ── POST /api/master-ingest — Issue #816 ──────────────────────────────────
  // Reads a master subscription Google Sheet, splits by territory using
  // deriveSfCustomersByTerritory(), and overwrites per-POD subscription sheets.
  app.post('/api/master-ingest', async (c) => {
    let body: { regionId?: string }
    try { body = await c.req.json() } catch { body = {} }

    let podBookingsFolderId: string | null = null
    try {
      const raw = readFileSync(SETTINGS_PATH, 'utf-8')
      const settings = normalizeSettings(JSON.parse(raw))
      const region = getRegionById(settings, body.regionId)
      podBookingsFolderId = region.podBookingsFolderId || null
    } catch { /* no settings */ }

    if (!podBookingsFolderId) {
      return c.json({ error: 'podBookingsFolderId not configured' }, 400)
    }

    let podSheets: Array<{ name: string; displayName: string; sheetId: string; modifiedTime?: string }> = []
    try {
      podSheets = await listPodBookingSheets(podBookingsFolderId)
    } catch (e: any) {
      return c.json({ error: `Failed to list sheets: ${sanitizeErr(e)}` }, 500)
    }

    const masters = detectMasterSheets(podSheets)
    if (!masters.length) {
      return c.json({ error: 'No master sheet found in pod bookings folder' }, 404)
    }

    const masterSheet = masters[0]
    console.log(`[master-ingest] using master sheet: "${masterSheet.name}" (${masterSheet.sheetId})`)

    let masterRaw: Awaited<ReturnType<typeof fetchSfBookingsRaw>>
    try {
      masterRaw = await fetchSfBookingsRaw(masterSheet.sheetId, true)
    } catch (e: any) {
      return c.json({ error: `Failed to read master sheet: ${sanitizeErr(e)}` }, 500)
    }

    const overwritten: string[] = []
    const created: string[] = []
    const skipped: string[] = []
    let totalRows = 0

    for (let aeIdx = 0; aeIdx < aes.length; aeIdx++) {
      if (aeIdx > 0) await new Promise(r => setTimeout(r, 3_000))

      const ae = aes[aeIdx]
      const territories = ae.tableauTerritories ?? []

      if (!territories.length) {
        skipped.push(ae.name)
        continue
      }

      const existingCustomers = customers.filter(cu => cu.ae === ae.name)
      const { results, matched, newCustomers, aliasedCustomers, ccspOnly } = deriveSfCustomersByTerritory(
        masterRaw, territories, existingCustomers, ae.name, false,
      )

      if (results.length === 0) {
        console.log(`[master-ingest] ${ae.name}: 0 customers from master — skipping`)
        skipped.push(ae.name)
        continue
      }

      const hasRows = results.some(r => r.rows.length > 0)
      if (!hasRows) {
        const existingCacheHasData = existingCustomers.some(cu => {
          const cache = readSheetCache(cu.name)
          return cache && cache.rows.length > 0
        })
        if (existingCacheHasData) {
          console.warn(`[master-ingest] ${ae.name}: 0 subscription rows but existing cache has data — skipping (stale guard)`)
          skipped.push(ae.name)
          continue
        }
      }

      if (newCustomers.length > 0 || aliasedCustomers.length > 0) {
        const allCustomers = [...customers]
        for (const nc of newCustomers) {
          if (!allCustomers.some(c => c.name === nc.name)) {
            allCustomers.push(nc)
            console.log(`[master-ingest] new customer: ${nc.name} (${ae.name})`)
          }
        }
        for (const ac of aliasedCustomers) {
          const idx = allCustomers.findIndex(c => c.name === ac.name)
          if (idx !== -1) allCustomers[idx] = ac
        }
        saveCustomers(allCustomers)

        if (ae.driveFolderId) {
          for (const nc of newCustomers) {
            try {
              const folderId = await driveClient.ensureChildFolder(ae.driveFolderId, nc.name)
              patchCustomer(nc.name, { driveFolderId: folderId })
            } catch (e: any) {
              console.warn(`[master-ingest] folder creation failed for ${nc.name}: ${e.message}`)
            }
          }
        }
      }

      for (const name of ccspOnly) patchCustomer(name, { ccspCustomer: true })
      for (const name of matched) patchCustomer(name, { ccspCustomer: false })

      try {
        const spreadsheetId = await writeSubscriptionSheet(
          results,
          ae.name,
          ae.driveFolderId,
          ae.subscriptionSheetId || undefined,
        )

        if (!ae.subscriptionSheetId) {
          patchAe(ae.name, { subscriptionSheetId: spreadsheetId })
          created.push(ae.name)
        } else {
          overwritten.push(ae.name)
        }

        totalRows += results.reduce((sum, r) => sum + r.rows.length, 0)
        console.log(`[master-ingest] ${ae.name}: ${matched.length} customers → sheet ${spreadsheetId}`)
      } catch (e: any) {
        console.error(`[master-ingest] ${ae.name}: write failed — ${sanitizeErr(e)}`)
        skipped.push(ae.name)
      }
    }

    const summaryMsg = formatMasterIngestSummary({
      totalTerritories: aes.length - skipped.length,
      totalRows,
      overwritten,
      created,
      skipped,
    })
    console.log(summaryMsg)

    try {
      const statusPath = resolve(process.env.CACHE_DIR ?? 'data/cache', 'master-ingest-status.json')
      writeFileSync(statusPath, JSON.stringify({
        lastIngestAt: new Date().toISOString(),
        masterSheetId: masterSheet.sheetId,
        masterSheetName: masterSheet.name,
        overwritten,
        created,
        skipped,
        totalRows,
      }))
    } catch { /* non-fatal */ }

    return c.json({
      masterSheet: masterSheet.name,
      totalTerritories: aes.length - skipped.length,
      totalRows,
      overwritten,
      created,
      skipped,
    })
  })

  // ── SalesHub Knowledge Base status + refresh (ADR-030 Slice 5) ──────────────

  app.get('/api/saleshub/status', (c) => {
    const { getKnowledgeStats } = require('./lib/saleshub-knowledge-loader.ts')
    const stats = getKnowledgeStats()
    const staleDays = stats.scrapedAt
      ? Math.floor((Date.now() - new Date(stats.scrapedAt).getTime()) / (1000 * 60 * 60 * 24))
      : -1
    return c.json({
      ...stats,
      staleDays,
      freshness: staleDays < 0 ? 'unknown' : staleDays < 7 ? 'fresh' : staleDays < 30 ? 'stale' : 'expired',
    })
  })

  app.get('/api/saleshub/coverage', (c) => {
    const { getKnowledgeCoverage } = require('./lib/saleshub-knowledge-loader.ts')
    const coverage = getKnowledgeCoverage()
    return c.json(coverage)
  })

  app.post('/api/saleshub/refresh', async (c) => {
    if (isPrimary()) {
      // Primary/Mac Mini: trigger the full SalesHub scrape
      const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
      const { writeFileSync } = require('fs')
      const { resolve } = require('path')
      try {
        writeFileSync(resolve(CACHE_DIR, 'saleshub-trigger'), '')
        FeatureModuleRegistry.recordOutcome('saleshub', { success: true })
        return c.json({ ok: true, message: 'SalesHub scrape triggered — check logs for progress' })
      } catch (e: any) {
        FeatureModuleRegistry.recordOutcome('saleshub', { success: false, error: e.message })
        return c.json({ error: `Failed to write trigger: ${e.message}` }, 500)
      }
    }

    // Hero/L3 installs: download from Drive first, then re-read from disk
    try {
      const { downloadSaleshubFromDrive } = require('./lib/saleshub-drive-sync.ts')
      let driveDownloaded = false
      try {
        driveDownloaded = await downloadSaleshubFromDrive()
      } catch (e: any) {
        console.warn(`[scrape-api] SalesHub Drive download failed — falling back to disk: ${e.message}`)
      }
      const { resetKnowledgeCache, getKnowledgeStats } = require('./lib/saleshub-knowledge-loader.ts')
      resetKnowledgeCache()
      const stats = getKnowledgeStats()
      const totalRecords = stats.tdpCount + stats.salesPlayCount + stats.tacticCount
      FeatureModuleRegistry.recordOutcome('saleshub', {
        success: true,
        recordCount: totalRecords,
      })
      const source = driveDownloaded ? 'Drive' : 'disk'
      return c.json({
        ok: true,
        message: `SalesHub knowledge reloaded from ${source}: ${stats.tdpCount} TDPs, ${stats.salesPlayCount} plays, ${stats.tacticCount} tactics`,
        stats,
      })
    } catch (e: any) {
      FeatureModuleRegistry.recordOutcome('saleshub', { success: false, error: e.message })
      return c.json({ error: `Failed to reload SalesHub knowledge: ${e.message}` }, 500)
    }
  })
}
