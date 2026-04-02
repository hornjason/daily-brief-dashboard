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
} from './scraper-manager.ts'
import {
  runSfPipelineSync,
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
  lastSupportableScrape,
  lastSupportableError,
  supportableStatusMessage,
} from './supportable-scraper.ts'
import type { SupportableCustomer } from './supportable-scraper.ts'
import {
  runCcspScrape,
  writeCcspSheet,
  ccspScrapeRunning,
  lastCcspScrape,
  lastCcspError,
} from './ccsp-scraper.ts'
import { getRefreshIntervals } from './settings-api.ts'
import { refreshSubscriptions, refreshCCSP, refreshPipeline } from './refresh-engine.ts'

// ── Shared helpers ──────────────────────────────────────────────────────────

const sanitizeErr = (e: any): string =>
  String(e?.message ?? e).slice(0, 200).replace(/\/[^\s:]+\.(ts|js)/g, '[file]')

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
  app.post('/api/scrape/rh', async (c) => {
    if (_rhScrapeRunning) return c.json({ scraper: 'rh', status: 'busy', error: 'RH scrape already in progress' }, 409)
    runRhScrapeWithState().catch((e: any) => console.error('[scrape:rh] trigger failed:', sanitizeErr(e)))
    return c.json({ scraper: 'rh', started: true })
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
    if (supportableScrapeRunning) return c.json({ scraper: 'supportable', status: 'busy', error: 'Scrape already in progress' }, 409)

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

    // Run async — client polls /api/scrape/supportable/status
    ;(async () => {
      try {
        const results = await runSupportableScrape(scrapeCustomers)

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
      } catch (e: any) {
        console.error('[scrape:supportable] failed:', sanitizeErr(e))
      }
    })()

    return c.json({ started: true })
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
  app.post('/api/scrape/supportable/discover', async (c) => {
    if (supportableScrapeRunning) return c.json({ scraper: 'supportable', status: 'busy', error: 'Scrape already in progress' }, 409)

    const body = await c.req.json<{ aeName?: string; customer?: string }>().catch(() => ({}))
    const aeName = (body.aeName ?? '').trim()
    const customerFilter = (body.customer ?? '').trim()

    if (!aeName)               return c.json({ error: 'aeName is required' }, 400)
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

    // Run async — client polls /api/scrape/supportable/status
    ;(async () => {
      try {
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
      } catch (e: any) {
        console.error('[scrape:discover] failed:', sanitizeErr(e))
      }
    })()

    return c.json({ started: true, customerCount: aeCustomers.length })
  })

  // ╭──────────────────────────────────────────────────────────────────────────╮
  // │  CCSP (Tableau)                                                         │
  // ╰──────────────────────────────────────────────────────────────────────────╯

  // POST /api/scrape/ccsp — full pipeline: Tableau scrape → sheet → cache
  app.post('/api/scrape/ccsp', async (c) => {
    // ARCHITECTURE.md §9: check BOTH mutex guards
    if (ccspScrapeRunning || ccspInFlight) return c.json({ scraper: 'ccsp', status: 'busy', error: 'CCSP scrape already in progress' }, 409)

    const eligibleAes = aes.filter(a => a.tableauTerritories?.length && a.driveFolderId)
    if (!eligibleAes.length) return c.json({ error: 'No AEs with tableauTerritories and driveFolderId configured' }, 400)

    setCcspInFlight(true)

    // Run async — client polls /api/scrape/ccsp/status
    ;(async () => {
      try {
        const results = await runCcspScrape(eligibleAes)
        for (const ae of eligibleAes) {
          const aeResults = results.filter(r => r.aeName === ae.name)
          const spreadsheetId = await writeCcspSheet(aeResults, ae.name, ae.driveFolderId, ae.ccspSheetId || undefined)
          patchAe(ae.name, { ccspSheetId: spreadsheetId })
          console.log(`[scrape:ccsp] sheet ready for ${ae.name}: ${spreadsheetId}`)
        }

        // Stage 2: refresh local cache from the sheets we just wrote
        await refreshCCSP().catch(e => console.warn('[scrape:ccsp] cache refresh failed:', sanitizeErr(e)))
      } catch (e: any) {
        console.error('[scrape:ccsp] failed:', sanitizeErr(e))
      } finally {
        setCcspInFlight(false)
      }
    })()

    return c.json({ started: true, aeCount: eligibleAes.length })
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
  app.post('/api/scrape/salesforce', async (c) => {
    const aesWithSf = aes.filter(a => a.sfReportId && a.driveFolderId)
    if (!aesWithSf.length && !SF_REPORT_ID) return c.json({ error: 'No AEs with sfReportId configured' }, 400)

    // Stale-mutex auto-release
    if (_sfSyncRunning && _sfSyncStartedAt && (Date.now() - _sfSyncStartedAt > 15 * 60 * 1000)) {
      console.warn('[scrape:salesforce] stale mutex detected — auto-releasing after 15 min')
      setSfSyncRunning(false)
      setSfSyncStartedAt(null)
    }
    if (_sfSyncRunning) return c.json({ scraper: 'salesforce', status: 'busy', error: 'SF sync already in progress' }, 409)

    setSfSyncRunning(true)
    setSfSyncStartedAt(Date.now())
    setSfSyncCancelRequested(false)
    setSfSyncLastError(null)

    ;(async () => {
      for (const ae of aesWithSf) {
        if (_sfSyncCancelRequested) {
          console.log(`[scrape:salesforce] cancel requested — stopping before ${ae.name}`)
          break
        }
        try {
          let sheetId = ae.pipelineSheetId
          if (!sheetId) {
            sheetId = await createPipelineSheet(ae.name, ae.driveFolderId)
            patchAe(ae.name, { pipelineSheetId: sheetId })
          }
          await runSfPipelineSync(ae.sfReportId!, RH_PROFILE_DIR, sheetId)
        } catch (e: any) {
          if (e instanceof SfSessionExpiredError) {
            console.warn('[scrape:salesforce] SF session expired during sync')
            setSfSyncLastError('SF session expired during sync')
          } else {
            console.error(`[scrape:salesforce] error for ${ae.name}:`, sanitizeErr(e))
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
          runSfPipelineSync(SF_REPORT_ID, RH_PROFILE_DIR, envSheetId).catch((e: any) => console.error('[scrape:salesforce] env fallback failed:', sanitizeErr(e)))
        }
      }
    })().catch((e: any) => {
      console.error('[scrape:salesforce] block error:', sanitizeErr(e))
      setSfSyncLastError(sanitizeErr(e))
    }).finally(() => {
      setSfSyncRunning(false)
      setSfSyncStartedAt(null)
      setSfSyncCancelRequested(false)
      // Stage 2: refresh local cache from the sheets we just wrote (BKL-M18)
      refreshPipeline().catch(e => console.warn('[scrape:salesforce] post-sync cache refresh failed:', sanitizeErr(e)))
    })

    return c.json({ started: true, aes: aesWithSf.map(a => a.name) })
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
  // │  POST /api/scrape/all — run all four in safe sequence                   │
  // ╰──────────────────────────────────────────────────────────────────────────╯

  app.post('/api/scrape/all', async (c) => {
    const results: ScrapeResult[] = []

    const scrapers: { name: ScrapeResult['scraper']; run: () => Promise<ScrapeResult> }[] = [
      {
        name: 'rh',
        run: async () => {
          const start = Date.now()
          if (_rhScrapeRunning) return { scraper: 'rh', status: 'busy', recordsWritten: 0, sheetUpdated: false, cacheUpdated: false, error: 'Already running', durationMs: 0 }
          try {
            await runRhScrapeWithState()
            return { scraper: 'rh', status: 'ok', recordsWritten: 0, sheetUpdated: false, cacheUpdated: true, error: null, durationMs: Date.now() - start }
          } catch (e: any) {
            return { scraper: 'rh', status: 'error', recordsWritten: 0, sheetUpdated: false, cacheUpdated: false, error: sanitizeErr(e), durationMs: Date.now() - start }
          }
        },
      },
      {
        name: 'supportable',
        run: async () => {
          const start = Date.now()
          if (supportableScrapeRunning) return { scraper: 'supportable', status: 'busy', recordsWritten: 0, sheetUpdated: false, cacheUpdated: false, error: 'Already running', durationMs: 0 }
          const { customers } = await import('./server-state.ts')
          if (!customers.length) return { scraper: 'supportable', status: 'skipped', recordsWritten: 0, sheetUpdated: false, cacheUpdated: false, error: 'No customers configured', durationMs: 0 }
          for (const ae of aes) {
            const aeCustomers = customers.filter(cu => cu.ae === ae.name && cu.accountNumbers?.length)
            if (!aeCustomers.length) continue
            try {
              const scrapeResults = await runSupportableScrape(aeCustomers as SupportableCustomer[])
              await writeSupportableSheet(scrapeResults, ae.name, ae.driveFolderId, ae.supportableSheetId || undefined)
            } catch (e: any) {
              console.warn(`[scrape:all:supportable] ${ae.name} failed:`, sanitizeErr(e))
            }
          }
          await refreshSubscriptions().catch(() => {})
          return { scraper: 'supportable', status: 'ok', recordsWritten: 0, sheetUpdated: true, cacheUpdated: true, error: null, durationMs: Date.now() - start }
        },
      },
      {
        name: 'ccsp',
        run: async () => {
          const start = Date.now()
          if (ccspScrapeRunning || ccspInFlight) return { scraper: 'ccsp', status: 'busy', recordsWritten: 0, sheetUpdated: false, cacheUpdated: false, error: 'Already running', durationMs: 0 }
          const eligibleAes = aes.filter(a => a.tableauTerritories?.length && a.driveFolderId)
          if (!eligibleAes.length) return { scraper: 'ccsp', status: 'skipped', recordsWritten: 0, sheetUpdated: false, cacheUpdated: false, error: 'No eligible AEs', durationMs: 0 }
          setCcspInFlight(true)
          try {
            const ccspResults = await runCcspScrape(eligibleAes)
            for (const ae of eligibleAes) {
              const aeResults = ccspResults.filter(r => r.aeName === ae.name)
              const sheetId = await writeCcspSheet(aeResults, ae.name, ae.driveFolderId, ae.ccspSheetId || undefined)
              patchAe(ae.name, { ccspSheetId: sheetId })
            }
            await refreshCCSP().catch(() => {})
            return { scraper: 'ccsp', status: 'ok', recordsWritten: 0, sheetUpdated: true, cacheUpdated: true, error: null, durationMs: Date.now() - start }
          } catch (e: any) {
            return { scraper: 'ccsp', status: 'error', recordsWritten: 0, sheetUpdated: false, cacheUpdated: false, error: sanitizeErr(e), durationMs: Date.now() - start }
          } finally {
            setCcspInFlight(false)
          }
        },
      },
      {
        name: 'salesforce',
        run: async () => {
          const start = Date.now()
          if (_sfSyncRunning) return { scraper: 'salesforce', status: 'busy', recordsWritten: 0, sheetUpdated: false, cacheUpdated: false, error: 'Already running', durationMs: 0 }
          const aesWithSf = aes.filter(a => a.sfReportId && a.driveFolderId)
          if (!aesWithSf.length) return { scraper: 'salesforce', status: 'skipped', recordsWritten: 0, sheetUpdated: false, cacheUpdated: false, error: 'No AEs with sfReportId', durationMs: 0 }
          setSfSyncRunning(true)
          setSfSyncStartedAt(Date.now())
          try {
            for (const ae of aesWithSf) {
              let sheetId = ae.pipelineSheetId
              if (!sheetId) {
                sheetId = await createPipelineSheet(ae.name, ae.driveFolderId)
                patchAe(ae.name, { pipelineSheetId: sheetId })
              }
              await runSfPipelineSync(ae.sfReportId!, RH_PROFILE_DIR, sheetId)
            }
            await refreshPipeline().catch(() => {})
            return { scraper: 'salesforce', status: 'ok', recordsWritten: 0, sheetUpdated: true, cacheUpdated: true, error: null, durationMs: Date.now() - start }
          } catch (e: any) {
            return { scraper: 'salesforce', status: 'error', recordsWritten: 0, sheetUpdated: false, cacheUpdated: false, error: sanitizeErr(e), durationMs: Date.now() - start }
          } finally {
            setSfSyncRunning(false)
            setSfSyncStartedAt(null)
          }
        },
      },
    ]

    // Sequential — shared browser context (ARCHITECTURE.md §1)
    for (const scraper of scrapers) {
      const result = await scraper.run()
      results.push(result)
    }

    return c.json({ results })
  })
}
