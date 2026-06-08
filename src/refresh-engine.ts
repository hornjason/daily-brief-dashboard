import { readFileSync } from 'fs'
import { resolve } from 'path'
import { Hono } from 'hono'
import { google } from 'googleapis'
import type { Customer } from './types.ts'
import { aes, customers } from './server-state.ts'
import { readSheetCache, writeSheetCache, readCCSPCache, writeCCSPCache, readPipelineCache, writePipelineCache } from './cache-layer.ts'
import { fetchCustomerSheetData, batchFetchSubscriptions, parseCcspRows } from './sheets.ts'
import type { CCSPRecord } from './sheets.ts'
import { parsePipelineRows } from './pipeline.ts'
import { checkFilesModified } from './drive-watcher.ts'
import { recordSfSyncSuccess } from './sf-scraper.ts'
import { recordOutcome } from './scraper-status-store.ts'
import { recordCcspRefreshAt } from './ccsp-scraper.ts'
import { recordSupportableRefreshAt } from './supportable-scraper.ts'
import { emitCacheLevel } from './ingest-events.js'
import { FeatureModuleRegistry } from './feature-module-registry.ts'
import { normalizeSettings } from './region-config.ts'
import { parseCsvToSfReport } from './csv-parse.ts'
import { discoverL3Csv, readL3CsvRaw } from './lib/l3-csv-reader.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'

// ── Cache hierarchy constants (BKL-INGEST-10) ──────────────────────────────
// L1 disk-cache TTL: if the local cache is younger than this, skip the L2
// Drive API check entirely. The canonical cache hierarchy is:
//   L1 (disk) → L2 (Drive modifiedTime) → L3 (live fetch)
// Each tier must be tried in order, cheapest first.
const INGEST_L1_TTL_MS = 24 * 60 * 60 * 1000

// ── Settings.json reader (ADR-019) ─────────────────────────────────────────
import { CONFIG_DIR } from './lib/paths.ts'

const CONFIG_DIR_REFRESH = CONFIG_DIR
const SETTINGS_PATH_REFRESH = resolve(CONFIG_DIR_REFRESH, 'settings.json')

function readSettingsJson(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH_REFRESH, 'utf-8'))
  } catch {
    return {}
  }
}

// ── Module state ────────────────────────────────────────────────────────────
let SHEETS_SYNC_PATH = ''

export function initRefreshEngine(sheetsSyncPath: string): void {
  SHEETS_SYNC_PATH = sheetsSyncPath
}

// ── Batch subscription refresh (BKL-AE-03) ────────────────────────────────
// Groups customers by their AE's subscriptionSheetId and fetches all tabs
// from each sheet in a single batchGet call (~3 API calls instead of ~30).

async function batchRefreshSubscriptions(): Promise<{ refreshed: number; errors: string[] }> {
  const errors: string[] = []
  let refreshed = 0

  // Group customers by their AE's subscriptionSheetId
  const sheetGroups = new Map<string, Customer[]>()
  const customersWithOverride: Customer[] = []

  for (const customer of customers) {
    // Per-customer supportableFileId overrides — handle individually
    if (customer.supportableFileId) {
      customersWithOverride.push(customer)
      continue
    }

    // Find which AE this customer belongs to
    const ae = aes.find(a => a.name === customer.ae)
    if (!ae?.subscriptionSheetId) continue

    const group = sheetGroups.get(ae.subscriptionSheetId) ?? []
    group.push(customer)
    sheetGroups.set(ae.subscriptionSheetId, group)
  }

  // Batch path: one batchGet per unique AE sheet
  for (const [sheetId, groupCustomers] of sheetGroups) {
    try {
      const resultMap = await batchFetchSubscriptions(sheetId, groupCustomers)
      for (const [customerName, rows] of resultMap) {
        // Guard: don't overwrite populated cache with empty — quota failure returns [] silently
        if (rows.length === 0 && (readSheetCache(customerName)?.rows?.length ?? 0) > 0) {
          console.log(`[refresh:batch] ${customerName}: got 0 rows but cache has data — keeping existing cache`)
          refreshed++
          continue
        }
        writeSheetCache(customerName, rows)
        refreshed++
      }
    } catch (e: any) {
      errors.push(`batch ${sheetId}: ${e.message}`)
      // If batch fails, don't lose the whole group — errors are logged but we continue
    }
  }

  // Individual path: customers with per-customer supportableFileId override
  for (const customer of customersWithOverride) {
    try {
      const rows = await fetchCustomerSheetData(customer)
      if (rows.length === 0 && (readSheetCache(customer.name)?.rows?.length ?? 0) > 0) {
        console.log(`[refresh:batch] ${customer.name}: got 0 rows but cache has data — keeping existing cache`)
        refreshed++
        continue
      }
      writeSheetCache(customer.name, rows)
      refreshed++
    } catch (e: any) {
      errors.push(`${customer.name}: ${e.message}`)
    }
    // Stagger only for individual calls
    await new Promise(r => setTimeout(r, 750))
  }

  return { refreshed, errors }
}

// ── Full data refresh ───────────────────────────────────────────────────────

export async function refreshAll(): Promise<{ sheets: number; ccsp: boolean; errors: string[] }> {
  const errors: string[] = []

  // 1. Subscription sheet data for every customer (batch path — BKL-AE-03)
  const { refreshed: sheetsRefreshed, errors: sheetErrors } = await batchRefreshSubscriptions()
  errors.push(...sheetErrors)

  // 2. CCSP — ADR-019: delegate to refreshCCSP which uses CSV discovery
  let ccspOk = false
  try {
    await refreshCCSP(true)
    ccspOk = true
  } catch (e: any) { errors.push(`ccsp: ${e.message}`) }

  console.log(`[refresh] sheets=${sheetsRefreshed}/${customers.length} ccsp=${ccspOk} errors=${errors.length}`)
  return { sheets: sheetsRefreshed, ccsp: ccspOk, errors }
}

// ── Per-source refresh functions ────────────────────────────────────────────

export async function refreshSubscriptions(force = false): Promise<void> {
  // Check if Supportable source sheet has changed before re-fetching all customers
  if (!force) {
    // L1 cache check (BKL-INGEST-10) — if ALL customers' sheet caches are < 24h,
    // no Drive call needed. L1 must be consulted before any external call.
    const now = Date.now()
    const allCustomersCached = customers.length > 0 && customers.every(cu => {
      const c = readSheetCache(cu.name)
      return c?.cachedAt && (now - new Date(c.cachedAt).getTime()) < INGEST_L1_TTL_MS
    })
    if (allCustomersCached) {
      console.log('[refresh:subscriptions] L1 cache fresh for all customers — skipping Drive check')
      emitCacheLevel({ ae: null, flow: 'sfBookings', level: 1 })
      FeatureModuleRegistry.updateStatus('subscriptions', { lastChecked: new Date().toISOString() })
      return
    }
    try {
      const syncConfig = JSON.parse(readFileSync(SHEETS_SYNC_PATH, 'utf-8')) as { fileId?: string }
      if (syncConfig.fileId) {
        // Use oldest sheet cachedAt as the baseline — if the source file is newer, all customers refresh
        const timestamps = customers.map(cu => readSheetCache(cu.name)?.cachedAt).filter(Boolean) as string[]
        const oldestCachedAt = timestamps.length ? timestamps.reduce((a, b) => a < b ? a : b) : null
        if (oldestCachedAt) {
          const changed = await checkFilesModified([syncConfig.fileId], oldestCachedAt)
          if (!changed) { console.log(`[refresh:subscriptions] skipped — source file unchanged`); return }
        }
      }
    } catch {
      // If we can't check, proceed with refresh
    }
  }
  // Batch path (BKL-AE-03): one batchGet per AE sheet instead of N individual reads
  const { refreshed, errors } = await batchRefreshSubscriptions()
  if (errors.length) {
    for (const err of errors) console.warn(`[refresh:subscriptions] ${err}`)
  }
  const totalRows = customers.reduce((sum, cu) => sum + (readSheetCache(cu.name)?.rows?.length ?? 0), 0)
  recordOutcome('supportable', { success: true, recordCount: totalRows })
  FeatureModuleRegistry.recordOutcome('subscriptions', { success: true, recordCount: totalRows })
  recordSupportableRefreshAt()
  console.log(`[refresh:subscriptions] done (${refreshed}/${customers.length} customers, batch mode)`)
}

export async function refreshCCSP(force = false): Promise<void> {
  try {
    const cached = readCCSPCache()

    // L1 cache check (BKL-INGEST-10)
    if (!force && cached?.cachedAt) {
      const now = Date.now()
      if ((now - new Date(cached.cachedAt).getTime()) < INGEST_L1_TTL_MS) {
        const ageHours = Math.round((now - new Date(cached.cachedAt).getTime()) / 3_600_000 * 10) / 10
        console.log(`[refresh:ccsp] L1 cache fresh (${ageHours}h old) — skipping`)
        emitCacheLevel({ ae: null, flow: 'ccsp', level: 1 })
        FeatureModuleRegistry.updateStatus('ccsp', { lastChecked: new Date().toISOString() })
        return
      }
    }

    // ADR-019: CSV discovery from Drive (replaces sheet-based fetch)
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const driveApi = google.drive({ version: 'v3', auth })
    const settings = readSettingsJson()
    const normalized = normalizeSettings(settings)

    const allRecords: CCSPRecord[] = []
    const discoveredFileIds: string[] = []

    for (const region of normalized.regions) {
      const folderId = region.podBookingsFolderId
      if (!folderId) continue
      for (const podKey of Object.keys(region.pods ?? {})) {
        const csv = await discoverL3Csv(folderId, 'CCSP-', podKey, driveApi)
        if (!csv) { console.warn(`[refresh:ccsp] no CSV found for ${podKey}`); continue }

        // Change detection: skip if CSV hasn't changed since last cache
        if (!force && cached?.cachedAt && new Date(csv.modifiedTime) <= new Date(cached.cachedAt)) {
          console.log(`[refresh:ccsp] ${podKey} CSV unchanged — skipping`)
          continue
        }

        const csvText = await readL3CsvRaw(csv.fileId, driveApi)
        const { headers, rows } = parseCsvToSfReport(csvText)
        const parsed = parseCcspRows([headers, ...rows], csv.fileId)

        // ADR-019: CCSP CSVs are POD-level — filter to bootstrapped customers only
        // and attribute each record to its AE (matches pipeline filterToAEs behavior)
        const beforeFilter = parsed.length
        const matched: CCSPRecord[] = []
        const unmatched: string[] = []

        for (const rec of parsed) {
          const recName = (rec.accountName ?? '').toLowerCase()
          const custMatch = customers.find(cu => {
            const cuName = cu.name.toLowerCase()
            return recName.includes(cuName) || cuName.includes(recName)
          })
          if (!custMatch) {
            unmatched.push(rec.accountName)
            continue
          }
          if (custMatch.ae) rec.ae = custMatch.ae
          matched.push(rec)
        }

        allRecords.push(...matched)
        discoveredFileIds.push(csv.fileId)

        // Diagnostic logging when customer filter removes all records (issue #303)
        if (beforeFilter > 0 && matched.length === 0) {
          console.warn(`[refresh:ccsp] ${podKey} CSV: customer filter removed all ${beforeFilter} records. ` +
            `Unmatched accounts: [${unmatched.slice(0, 5).join(', ')}${unmatched.length > 5 ? `... (${unmatched.length - 5} more)` : ''}]. ` +
            `Bootstrapped customers: [${customers.map(c => c.name).slice(0, 5).join(', ')}${customers.length > 5 ? `... (${customers.length - 5} more)` : ''}]`)
        } else if (beforeFilter > 0) {
          console.log(`[refresh:ccsp] ${podKey} CSV: ${matched.length}/${beforeFilter} records matched bootstrapped customers`)
        }
      }
    }

    // Guard: never write zero records (#305)
    // Case 1: Cache has data — don't overwrite with empty (unless force)
    // Case 2: CSVs exist but parse returned 0 — likely parser issue, keep existing or skip
    if (allRecords.length === 0) {
      if (discoveredFileIds.length > 0) {
        console.warn(`[refresh:ccsp] parsed 0 records from ${discoveredFileIds.length} CSVs — possible parser issue, keeping existing cache`)
      }
      return  // Never write zero records to cache
    }

    writeCCSPCache(allRecords, discoveredFileIds)
    recordOutcome('ccsp', { success: true, recordCount: allRecords.length })
    FeatureModuleRegistry.recordOutcome('ccsp', { success: true, recordCount: allRecords.length })
    recordCcspRefreshAt()
    console.log(`[refresh:ccsp] done — ${allRecords.length} records from ${discoveredFileIds.length} CSVs`)
  } catch (e: any) {
    console.warn(`[refresh:ccsp] ${e.message}`)
  }
}

export async function refreshPipeline(force = false): Promise<void> {
  try {
    const cached = readPipelineCache()

    // L1 cache check (BKL-INGEST-10)
    if (!force && cached?.cachedAt) {
      const now = Date.now()
      if ((now - new Date(cached.cachedAt).getTime()) < INGEST_L1_TTL_MS) {
        const ageHours = Math.round((now - new Date(cached.cachedAt).getTime()) / 3_600_000 * 10) / 10
        console.log(`[refresh:pipeline] L1 cache fresh (${ageHours}h old) — skipping`)
        emitCacheLevel({ ae: null, flow: 'sfPipeline', level: 1 })
        FeatureModuleRegistry.updateStatus('pipeline', { lastChecked: new Date().toISOString() })
        return
      }
    }

    // ADR-019: CSV discovery from Drive (replaces sheet-based fetch)
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const driveApi = google.drive({ version: 'v3', auth })
    const settings = readSettingsJson()
    const normalized = normalizeSettings(settings)

    const allRecords: import('./pipeline.ts').PipelineRecord[] = []
    const discoveredFileIds: string[] = []

    for (const region of normalized.regions) {
      const folderId = region.podBookingsFolderId
      if (!folderId) continue
      for (const podKey of Object.keys(region.pods ?? {})) {
        const csv = await discoverL3Csv(folderId, 'SF-PIPELINE-', podKey, driveApi)
        if (!csv) { console.warn(`[refresh:pipeline] no CSV found for ${podKey}`); continue }

        // Change detection: skip if CSV hasn't changed since last cache
        if (!force && cached?.cachedAt && new Date(csv.modifiedTime) <= new Date(cached.cachedAt)) {
          console.log(`[refresh:pipeline] ${podKey} CSV unchanged — skipping`)
          continue
        }

        const csvText = await readL3CsvRaw(csv.fileId, driveApi)
        const { headers, rows } = parseCsvToSfReport(csvText)
        allRecords.push(...parsePipelineRows([headers, ...rows]))
        discoveredFileIds.push(csv.fileId)
      }
    }

    // Guard: never write zero records (#305)
    // Case 1: Cache has data — don't overwrite with empty (unless force)
    // Case 2: CSVs exist but parse returned 0 — likely parser issue, keep existing or skip
    if (allRecords.length === 0) {
      if (discoveredFileIds.length > 0) {
        console.warn(`[refresh:pipeline] parsed 0 records from ${discoveredFileIds.length} CSVs — possible parser issue, keeping existing cache`)
      }
      return  // Never write zero records to cache
    }

    // Deduplicate by oppNumber (same logic as fetchPipelineData)
    const seen = new Set<string>()
    const deduped = allRecords.filter(r => {
      const key = r.oppNumber || `${r.accountName}|${r.oppName}|${r.closeDate}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    writePipelineCache(deduped, discoveredFileIds)
    recordOutcome('sf-pipeline', { success: true, recordCount: deduped.length })
    FeatureModuleRegistry.recordOutcome('pipeline', { success: true, recordCount: deduped.length })
    console.log(`[refresh:pipeline] done — ${deduped.length} records from ${discoveredFileIds.length} CSVs`)
  } catch (e: any) {
    console.warn(`[refresh:pipeline] ${e.message}`)
  }
}

// ── Route registration ──────────────────────────────────────────────────────

export function createRefreshRouter(): Hono {
  const router = new Hono()
  router.post('/api/refresh', async (c) => {
    const result = await refreshAll()
    return c.json({ ...result, refreshedAt: new Date().toISOString() })
  })
  router.post('/api/refresh/pipeline', async (c) => {
    await refreshPipeline(true)
    return c.json({ ok: true, refreshedAt: new Date().toISOString() })
  })
  router.post('/api/refresh/subscriptions', async (c) => {
    await refreshSubscriptions(true)
    return c.json({ ok: true, refreshedAt: new Date().toISOString() })
  })
  router.post('/api/refresh/ccsp', async (c) => {
    await refreshCCSP(true)
    return c.json({ ok: true, refreshedAt: new Date().toISOString() })
  })
  router.post('/api/refresh/tech-stack', async (c) => {
    let success = 0, failed = 0
    for (const customer of customers) {
      try {
        const mod = FeatureModuleRegistry.get('tech-stack')
        if (mod) await mod.syncNow(customer.name)
        success++
      } catch { failed++ }
    }
    FeatureModuleRegistry.recordOutcome('tech-stack', { success: failed === 0, recordCount: success })
    return c.json({ ok: true, refreshed: success, failed, refreshedAt: new Date().toISOString() })
  })
  router.post('/api/refresh/news', async (c) => {
    try {
      const { newsProvider } = await import('./news-provider.ts')
      let success = 0, failed = 0
      for (const customer of customers) {
        try {
          await newsProvider.searchNews(customer.name)
          success++
        } catch { failed++ }
      }
      FeatureModuleRegistry.recordOutcome('news-radar', { success: failed === 0, recordCount: success })
      return c.json({ ok: true, refreshed: success, failed, refreshedAt: new Date().toISOString() })
    } catch (e: any) {
      FeatureModuleRegistry.recordOutcome('news-radar', { success: false, error: e?.message })
      return c.json({ ok: false, error: e?.message }, 500)
    }
  })
  router.post('/api/refresh/cloud-marketplace', async (c) => {
    const mod = FeatureModuleRegistry.get('cloud-marketplace')
    if (!mod) return c.json({ ok: false, error: 'Module not registered' }, 500)
    try {
      await mod.syncNow('')
      FeatureModuleRegistry.recordOutcome('cloud-marketplace', { success: true })
      return c.json({ ok: true, refreshedAt: new Date().toISOString() })
    } catch (e: any) {
      FeatureModuleRegistry.recordOutcome('cloud-marketplace', { success: false, error: e.message })
      return c.json({ ok: false, error: e.message }, 500)
    }
  })
  router.post('/api/refresh/ecosystem-catalog', async (c) => {
    const mod = FeatureModuleRegistry.get('ecosystem-catalog')
    if (!mod) return c.json({ ok: false, error: 'Module not registered' }, 500)
    try {
      await mod.syncNow('')
      FeatureModuleRegistry.recordOutcome('ecosystem-catalog', { success: true })
      return c.json({ ok: true, refreshedAt: new Date().toISOString() })
    } catch (e: any) {
      FeatureModuleRegistry.recordOutcome('ecosystem-catalog', { success: false, error: e.message })
      return c.json({ ok: false, error: e.message }, 500)
    }
  })
  router.post('/api/refresh/saleshub-content', async (c) => {
    const mod = FeatureModuleRegistry.get('saleshub-content')
    if (!mod) return c.json({ ok: false, error: 'Module not registered' }, 500)
    try {
      await mod.syncNow('')
      return c.json({ ok: true, refreshedAt: new Date().toISOString() })
    } catch (e: any) {
      FeatureModuleRegistry.recordOutcome('saleshub-content', { success: false, error: e.message })
      return c.json({ ok: false, error: e.message }, 500)
    }
  })
  router.post('/api/refresh/rh-product-catalog', async (c) => {
    const mod = FeatureModuleRegistry.get('rh-product-catalog')
    if (!mod) return c.json({ ok: false, error: 'Module not registered' }, 500)
    try {
      await mod.syncNow('')
      FeatureModuleRegistry.recordOutcome('rh-product-catalog', { success: true })
      return c.json({ ok: true, refreshedAt: new Date().toISOString() })
    } catch (e: any) {
      FeatureModuleRegistry.recordOutcome('rh-product-catalog', { success: false, error: e.message })
      return c.json({ ok: false, error: e.message }, 500)
    }
  })
  return router
}
