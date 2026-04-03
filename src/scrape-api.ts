// ── Unified Scrape API (BKL-M25) ────────────────────────────────────────────
// Replaces fragmented /api/bootstrap/* and /api/auth/*/sync endpoints with
// a unified /api/scrape/* layer. Each endpoint runs the full pipeline:
// source → Google Sheets → local cache.
import { writeFileSync as writeFileSyncRaw, renameSync } from 'fs'
import type { Hono } from 'hono'
import { aes, customers, patchAe, CUSTOMERS_PATH } from './server-state.ts'
import { lastScraped } from './rh-auth.ts'
import {
  runRhScrapeWithState,
  ccspInFlight,
  _rhScrapeRunning,
  _rhScrapeLastError,
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
  lastSfSync,
  lastSfRowCount,
  sfSyncError,
} from './sf-scraper.ts'
import {
  runSupportableScrape,
  runSupportableDiscoverAndScrape,
  writeSupportableSheet,
  supportableScrapeRunning,
  supportableScrapeStartedAt,
  lastSupportableScrape,
  lastSupportableError,
  supportableStatusMessage,
} from './supportable-scraper.ts'
import type { SupportableCustomer } from './supportable-scraper.ts'
import {
  runCcspScrape,
  writeCcspSheet,
  ccspScrapeRunning,
  ccspScrapeStartedAt,
  lastCcspScrape,
  lastCcspError,
} from './ccsp-scraper.ts'
import { getRefreshIntervals } from './settings-api.ts'
import { refreshSubscriptions, refreshCCSP, refreshPipeline } from './refresh-engine.ts'
import { enqueueScraperTask, getScraperQueueStatus } from './background-scheduler.ts'
import { sanitizeErr } from './utils.ts'
import { getStatus } from './scraper-status-store.ts'

// ── Standardized response shape ─────────────────────────────────────────────

export interface ScrapeResult {
  scraper: 'rh' | 'supportable' | 'ccsp' | 'salesforce'
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
    if (_rhScrapeRunning) return c.json({ scraper: 'rh', status: 'busy', error: 'RH scrape already in progress' }, 409)
    resetCircuitBreaker('rh')
    enqueueScraperTask({
      name: 'rh-cases',
      run: () => runRhScrapeWithState(),
      source: 'manual',
      enqueuedAt: Date.now(),
    })
    return c.json({ scraper: 'rh', started: true, queued: true })
  })

  // GET /api/scrape/rh/status
  app.get('/api/scrape/rh/status', (c) => {
    const intervals = getRefreshIntervals()
    const now = Date.now()
    return c.json({
      isRunning: _rhScrapeRunning,
      lastSync:  lastScraped,
      lastError: _rhScrapeLastError,
      isStale:   !lastScraped || (now - new Date(lastScraped).getTime()) > intervals.rhScrape * 2 * 60 * 1000,
    })
  })

  // DELETE /api/scrape/rh/cancel
  app.delete('/api/scrape/rh/cancel', (c) => {
    if (!_rhScrapeRunning) return c.json({ ok: false, reason: 'No RH scrape in progress' })
    setRhScrapeCancelRequested(true)
    console.log('[scrape:rh] cancel requested via API')
    return c.json({ ok: true })
  })

  // ╭──────────────────────────────────────────────────────────────────────────╮
  // │  Supportable 360                                                        │
  // ╰──────────────────────────────────────────────────────────────────────────╯

  // POST /api/scrape/supportable — full pipeline: APEX scrape → sheet → cache
  app.post('/api/scrape/supportable', async (c) => {
    // Stale-mutex auto-release: if the flag has been stuck for >15 min (container restart, crash),
    // let the request through — runSupportableScrape() will reset the mutex internally.
    const supportableStale = supportableScrapeRunning && supportableScrapeStartedAt &&
      (Date.now() - supportableScrapeStartedAt > 15 * 60 * 1000)
    if (supportableStale) console.warn(`[scrape:supportable] stale mutex detected (${Math.round((Date.now() - supportableScrapeStartedAt!) / 60000)}min) — allowing request through`)
    if (supportableScrapeRunning && !supportableStale) return c.json({ scraper: 'supportable', status: 'busy', error: 'Scrape already in progress' }, 409)

    const body = await c.req.json<{ aeName?: string; customers?: SupportableCustomer[] }>().catch(() => ({}))
    const aeName = (body.aeName ?? '').trim()
    const scrapeCustomers = body.customers ?? []

    if (!aeName)               return c.json({ error: 'aeName is required' }, 400)
    if (!/^[\w\s'.,&()/-]{1,80}$/.test(aeName)) return c.json({ error: 'aeName contains invalid characters' }, 400)
    if (!scrapeCustomers.length) return c.json({ error: 'customers array is required' }, 400)

    for (const cu of scrapeCustomers) {
      if (!cu.name?.trim())           return c.json({ error: `customer name missing` }, 400)
      if (!/^[\w\s'.,&()/-]{1,80}$/.test(cu.name.trim())) return c.json({ error: `customer name contains invalid characters` }, 400)
      if (!cu.accountNumbers?.length) return c.json({ error: `no accountNumbers for "${cu.name}"` }, 400)
      for (const acc of cu.accountNumbers) {
        if (!/^\d{4,12}$/.test(String(acc).trim())) {
          return c.json({ error: `invalid accountNumber "${acc}" for "${cu.name}"` }, 400)
        }
      }
    }

    const aeConfig = aes.find(a => a.name === aeName)

    // BKL-M49: Manual triggers go through the scraper queue
    enqueueScraperTask({
      name: 'supportable',
      run: async () => {
        const _supTelemetryStart = Date.now()
        let recordCount = 0
        try {
          const results = await runSupportableScrape(scrapeCustomers)
          recordCount = results.reduce((sum, r) => sum + (r.subscriptions?.length ?? 0), 0)

          const spreadsheetId = await writeSupportableSheet(
            results,
            aeName,
            aeConfig?.driveFolderId || undefined,
            aeConfig?.supportableSheetId || undefined,
          )

          if (aeConfig) {
            patchAe(aeName, { supportableSheetId: spreadsheetId })
          }

          // Stage 2: refresh local cache from the sheet we just wrote
          await refreshSubscriptions().catch(e => console.warn('[scrape:supportable] cache refresh failed:', sanitizeErr(e)))

          console.log(`[scrape:supportable] sheet ready: ${spreadsheetId}`)

          // BKL-M50e: Record telemetry
          recordScrapeResult({
            timestamp: new Date().toISOString(),
            service: 'supportable',
            durationMs: Date.now() - _supTelemetryStart,
            recordCount,
            status: 'success',
          })
        } catch (e: any) {
          recordScrapeResult({
            timestamp: new Date().toISOString(),
            service: 'supportable',
            durationMs: Date.now() - _supTelemetryStart,
            recordCount: 0,
            status: 'failure',
            error: sanitizeErr(e),
          })
          throw e
        }
      },
      source: 'manual',
      enqueuedAt: Date.now(),
    })

    return c.json({ started: true, queued: true })
  })

  // GET /api/scrape/supportable/status
  app.get('/api/scrape/supportable/status', (c) => {
    return c.json({
      running:       supportableScrapeRunning,
      lastScrape:    lastSupportableScrape,
      lastError:     lastSupportableError ? sanitizeErr(lastSupportableError) : null,
      statusMessage: supportableStatusMessage,
    })
  })

  // POST /api/scrape/supportable/discover — discover account numbers for customers that
  // have none (or re-discover all), then write the sheet and refresh cache.
  // Unlike /api/scrape/supportable, this accepts customers without accountNumbers.
  // When aeName is omitted (e.g. admin "Run Now"), runs for ALL AEs sequentially.
  app.post('/api/scrape/supportable/discover', async (c) => {
    // Stale-mutex auto-release (same pattern as POST /api/scrape/supportable above)
    const supportableStale = supportableScrapeRunning && supportableScrapeStartedAt &&
      (Date.now() - supportableScrapeStartedAt > 15 * 60 * 1000)
    if (supportableStale) console.warn(`[scrape:supportable/discover] stale mutex detected (${Math.round((Date.now() - supportableScrapeStartedAt!) / 60000)}min) — allowing request through`)
    if (supportableScrapeRunning && !supportableStale) return c.json({ scraper: 'supportable', status: 'busy', error: 'Scrape already in progress' }, 409)

    const body = await c.req.json<{ aeName?: string; customer?: string }>().catch(() => ({}))
    const aeName = (body.aeName ?? '').trim()
    const customerFilter = (body.customer ?? '').trim()

    // When no aeName specified (admin "Run Now"), run for all AEs
    if (!aeName) {
      if (!aes.length) return c.json({ error: 'No AEs configured' }, 400)
      resetCircuitBreaker('supportable')
      enqueueScraperTask({
        name: 'supportable',
        run: async () => {
          for (const ae of aes) {
            const aeCustomers = customers.filter(cx => cx.ae === ae.name)
            if (!aeCustomers.length) continue
            const discoverList = aeCustomers.map(cx => ({ name: cx.name, supportableName: cx.supportableName }))
            try {
              const results = await runSupportableDiscoverAndScrape(discoverList, (done, total, name, accountNumbers) => {
                const existing = customers.find(cx => cx.name === name && cx.ae === ae.name)
                if (existing && accountNumbers.length > 0) {
                  const merged = new Set([...(existing.accountNumbers ?? []), ...accountNumbers])
                  existing.accountNumbers = [...merged]
                  try {
                    const tmpPath = CUSTOMERS_PATH + '.tmp'
                    writeFileSyncRaw(tmpPath, JSON.stringify({ customers }, null, 2))
                    renameSync(tmpPath, CUSTOMERS_PATH)
                  } catch {}
                }
              })
              await writeSupportableSheet(results, ae.name, ae.driveFolderId, ae.supportableSheetId || undefined)
            } catch (e: any) { console.warn(`[scrape:discover:all] ${ae.name} failed:`, sanitizeErr(e)) }
          }
          await refreshSubscriptions().catch(() => {})
        },
        source: 'manual',
        enqueuedAt: Date.now(),
      })
      return c.json({ started: true, aeCount: aes.length, queued: true })
    }
    if (!/^[\w\s'.,&()/-]{1,80}$/.test(aeName)) return c.json({ error: 'aeName contains invalid characters' }, 400)
    if (customerFilter && !/^[\w\s'.,&()/-]{1,80}$/.test(customerFilter)) return c.json({ error: 'customer contains invalid characters' }, 400)

    const aeConfig = aes.find(a => a.name === aeName)
    let aeCustomers = customers.filter(cx => cx.ae === aeName)
    if (!aeCustomers.length) return c.json({ error: `No customers found for AE "${aeName}"` }, 400)

    // Optional single-customer filter — for targeted debugging without running all accounts
    if (customerFilter) {
      aeCustomers = aeCustomers.filter(cx => cx.name.toLowerCase() === customerFilter.toLowerCase())
      if (!aeCustomers.length) return c.json({ error: `Customer "${customerFilter}" not found under AE "${aeName}"` }, 400)
    }

    // Build the discover list — include supportableName override if already known
    const discoverList = aeCustomers.map(cx => ({ name: cx.name, supportableName: cx.supportableName }))

    // BKL-M49: Manual triggers go through the scraper queue
    enqueueScraperTask({
      name: 'supportable',
      run: async () => {
        const results = await runSupportableDiscoverAndScrape(
          discoverList,
          (done, total, name, accountNumbers) => {
            // Merge discovered account numbers back into in-memory customers array.
            // Stale-overwrite guard: if discovery returned 0 accounts but the customer
            // already has account numbers on disk, preserve them — a failed name-search
            // must never wipe working account numbers (same pattern as subscription cache guard).
            const existing = customers.find(cx => cx.name === name && cx.ae === aeName)
            if (existing) {
              if (accountNumbers.length > 0) {
                const merged = new Set([...(existing.accountNumbers ?? []), ...accountNumbers])
                existing.accountNumbers = [...merged]
              }
              // If 0 returned, leave existing.accountNumbers unchanged
            }
            // Persist to disk after each customer (only if something changed)
            if (accountNumbers.length > 0) {
              try {
                const tmpPath = CUSTOMERS_PATH + '.tmp'
                writeFileSyncRaw(tmpPath, JSON.stringify({ customers }, null, 2))
                renameSync(tmpPath, CUSTOMERS_PATH)
              } catch (e: any) { console.warn('[scrape:discover] progress write failed:', e.message) }
            }
            console.log(`[scrape:discover] ${done}/${total} ${name}: ${accountNumbers.length} accounts found`)
          },
        )

        // Write fresh sheet with all discovered+scraped results
        const spreadsheetId = await writeSupportableSheet(
          results,
          aeName,
          aeConfig?.driveFolderId || undefined,
          aeConfig?.supportableSheetId || undefined,
        )

        if (aeConfig) {
          patchAe(aeName, { supportableSheetId: spreadsheetId })
        }

        await refreshSubscriptions().catch(e => console.warn('[scrape:discover] cache refresh failed:', sanitizeErr(e)))
        console.log(`[scrape:discover] complete: ${results.filter(r => r.accountNumbers.length > 0).length}/${results.length} matched, sheet: ${spreadsheetId}`)
      },
      source: 'manual',
      enqueuedAt: Date.now(),
    })

    return c.json({ started: true, customerCount: aeCustomers.length, queued: true })
  })

  // ╭──────────────────────────────────────────────────────────────────────────╮
  // │  CCSP (Tableau)                                                         │
  // ╰──────────────────────────────────────────────────────────────────────────╯

  // POST /api/scrape/ccsp — full pipeline: Tableau scrape → sheet → cache
  // BKL-M49: Manual triggers go through the scraper queue
  // Manual "Run Now" overrides circuit breaker
  app.post('/api/scrape/ccsp', async (c) => {
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

  // GET /api/scrape/ccsp/status
  app.get('/api/scrape/ccsp/status', (c) => {
    return c.json({
      running:    ccspScrapeRunning || ccspInFlight,
      lastScrape: lastCcspScrape,
      lastError:  lastCcspError ? sanitizeErr(lastCcspError) : null,
    })
  })

  // ╭──────────────────────────────────────────────────────────────────────────╮
  // │  Salesforce pipeline                                                    │
  // ╰──────────────────────────────────────────────────────────────────────────╯

  // POST /api/scrape/salesforce — full pipeline: SF report → sheet → cache
  // BKL-M49: Manual triggers go through the scraper queue
  // Manual "Run Now" overrides circuit breaker
  app.post('/api/scrape/salesforce', async (c) => {
    resetCircuitBreaker('salesforce')
    const aesWithSf = aes.filter(a => a.sfReportId && a.driveFolderId)
    if (!aesWithSf.length && !SF_REPORT_ID) return c.json({ error: 'No AEs with sfReportId configured' }, 400)

    // Stale-mutex auto-release
    if (_sfSyncRunning && _sfSyncStartedAt && (Date.now() - _sfSyncStartedAt > 15 * 60 * 1000)) {
      console.warn('[scrape:salesforce] stale mutex detected — auto-releasing after 15 min')
      setSfSyncRunning(false)
      setSfSyncStartedAt(null)
    }
    if (_sfSyncRunning) return c.json({ scraper: 'salesforce', status: 'busy', error: 'SF sync already in progress' }, 409)

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
                  await writePipelineSheet(data, sheetId)
                  totalRows += data.rows.length
                  console.log(`[scrape:salesforce] wrote ${data.rows.length} rows to ${ae.name}'s pipeline sheet`)
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
            service: 'salesforce',
            durationMs: Date.now() - _sfTelemetryStart,
            recordCount: totalRows,
            status: _sfSyncLastError ? 'failure' : 'success',
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

  // GET /api/scrape/salesforce/status
  app.get('/api/scrape/salesforce/status', (c) => {
    return c.json({
      isRunning: _sfSyncRunning,
      lastSync:  lastSfSync,
      lastError: _sfSyncLastError,
    })
  })

  // DELETE /api/scrape/salesforce/cancel
  app.delete('/api/scrape/salesforce/cancel', (c) => {
    if (!_sfSyncRunning) return c.json({ ok: false, reason: 'No SF sync in progress' })
    setSfSyncCancelRequested(true)
    console.log('[scrape:salesforce] cancel requested via API')
    return c.json({ ok: true })
  })

  // ╭──────────────────────────────────────────────────────────────────────────╮
  // │  POST /api/scrape/all — run all four in safe sequence via queue         │
  // ╰──────────────────────────────────────────────────────────────────────────╯
  // BKL-M49: Enqueue all four scrapers as a single compound task through the
  // scraper queue. They run sequentially within the task (same as before),
  // but now respect the global queue so they don't collide with other triggers.

  app.post('/api/scrape/all', async (c) => {
    enqueueScraperTask({
      name: 'all-scrapers',
      run: async () => {
        const scrapers: { name: string; run: () => Promise<void> }[] = [
          {
            name: 'rh',
            run: async () => {
              if (_rhScrapeRunning) { console.log('[scrape:all] rh: busy — skipping'); return }
              await runRhScrapeWithState()
            },
          },
          {
            name: 'supportable',
            run: async () => {
              // Stale-mutex passthrough: if stuck >15 min, let runSupportableScrape() handle reset
              const supStale = supportableScrapeRunning && supportableScrapeStartedAt &&
                (Date.now() - supportableScrapeStartedAt > 15 * 60 * 1000)
              if (supportableScrapeRunning && !supStale) { console.log('[scrape:all] supportable: busy — skipping'); return }
              const { customers } = await import('./server-state.ts')
              if (!customers.length) { console.log('[scrape:all] supportable: no customers — skipping'); return }
              const _supTelemetryStart = Date.now()
              let totalRecords = 0
              try {
                for (const ae of aes) {
                  const aeCustomers = customers.filter(cu => cu.ae === ae.name && cu.accountNumbers?.length)
                  if (!aeCustomers.length) continue
                  try {
                    const scrapeResults = await runSupportableScrape(aeCustomers as SupportableCustomer[])
                    totalRecords += scrapeResults.reduce((sum, r) => sum + (r.subscriptions?.length ?? 0), 0)
                    await writeSupportableSheet(scrapeResults, ae.name, ae.driveFolderId, ae.supportableSheetId || undefined)
                  } catch (e: any) {
                    console.warn(`[scrape:all:supportable] ${ae.name} failed:`, sanitizeErr(e))
                  }
                }
                await refreshSubscriptions().catch(() => {})
                recordScrapeResult({
                  timestamp: new Date().toISOString(),
                  service: 'supportable',
                  durationMs: Date.now() - _supTelemetryStart,
                  recordCount: totalRecords,
                  status: 'success',
                })
              } catch (e: any) {
                recordScrapeResult({
                  timestamp: new Date().toISOString(),
                  service: 'supportable',
                  durationMs: Date.now() - _supTelemetryStart,
                  recordCount: 0,
                  status: 'failure',
                  error: sanitizeErr(e),
                })
                throw e
              }
            },
          },
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
            name: 'salesforce',
            run: async () => {
              if (_sfSyncRunning) { console.log('[scrape:all] salesforce: busy — skipping'); return }
              const aesWithSf = aes.filter(a => a.sfReportId && a.driveFolderId)
              if (!aesWithSf.length) { console.log('[scrape:all] salesforce: no AEs — skipping'); return }
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
                  for (const ae of reportAes) {
                    let sheetId = ae.pipelineSheetId
                    if (!sheetId) {
                      sheetId = await createPipelineSheet(ae.name, ae.driveFolderId)
                      patchAe(ae.name, { pipelineSheetId: sheetId })
                    }
                    await writePipelineSheet(data, sheetId)
                    totalRows += data.rows.length
                  }
                }
                await refreshPipeline().catch(() => {})

                // BKL-M50e: Record telemetry
                recordScrapeResult({
                  timestamp: new Date().toISOString(),
                  service: 'salesforce',
                  durationMs: Date.now() - _sfTelemetryStart,
                  recordCount: totalRows,
                  status: 'success',
                })
              } catch (e: any) {
                recordScrapeResult({
                  timestamp: new Date().toISOString(),
                  service: 'salesforce',
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
        ]

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
  // Returns ScraperStatusMap with staleness applied per scraper threshold.
  app.get('/api/scraper-status', (c) => c.json(getStatus()))
}
