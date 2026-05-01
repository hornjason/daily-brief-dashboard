import { readFileSync } from 'fs'
import { Hono } from 'hono'
import type { Customer } from './types.ts'
import { aes, customers } from './server-state.ts'
import { readSheetCache, writeSheetCache, readCCSPCache, writeCCSPCache, readPipelineCache, writePipelineCache, isCCSPCacheStale } from './cache-layer.ts'
import { fetchCustomerSheetData, fetchCCSPData, batchFetchSubscriptions } from './sheets.ts'
import { fetchPipelineData } from './pipeline.ts'
import { checkFilesModified } from './drive-watcher.ts'
import { recordSfSyncSuccess } from './sf-scraper.ts'
import { recordOutcome } from './scraper-status-store.ts'
import { recordCcspRefreshAt } from './ccsp-scraper.ts'
import { recordSupportableRefreshAt } from './supportable-scraper.ts'
import { emitCacheLevel } from './ingest-events.js'

// ── Cache hierarchy constants (BKL-INGEST-10) ──────────────────────────────
// L1 disk-cache TTL: if the local cache is younger than this, skip the L2
// Drive API check entirely. The canonical cache hierarchy is:
//   L1 (disk) → L2 (Drive modifiedTime) → L3 (live fetch)
// Each tier must be tried in order, cheapest first.
const INGEST_L1_TTL_MS = 24 * 60 * 60 * 1000

// ── Module state ────────────────────────────────────────────────────────────
let SHEETS_SYNC_PATH = ''

export function initRefreshEngine(sheetsSyncPath: string): void {
  SHEETS_SYNC_PATH = sheetsSyncPath
}

// ── Batch subscription refresh (BKL-AE-03) ────────────────────────────────
// Groups customers by their AE's supportableSheetId and fetches all tabs
// from each sheet in a single batchGet call (~3 API calls instead of ~30).

async function batchRefreshSubscriptions(): Promise<{ refreshed: number; errors: string[] }> {
  const errors: string[] = []
  let refreshed = 0

  // Group customers by their AE's supportableSheetId
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
    if (!ae?.supportableSheetId) continue

    const group = sheetGroups.get(ae.supportableSheetId) ?? []
    group.push(customer)
    sheetGroups.set(ae.supportableSheetId, group)
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

  // 2. CCSP
  let ccspOk = false
  try {
    const { records, fileIds } = await fetchCCSPData(aes.filter(a => a.ccspSheetId).map(a => ({ sheetId: a.ccspSheetId!, aeName: a.name })))
    // BKL-CCSP-03: check if AE set changed — if so, don't keep stale cache even if new fetch is empty
    const aeSetChanged = isCCSPCacheStale(aes.filter(a => a.ccspSheetId).map(a => a.ccspSheetId!))
    if (records.length === 0 && (readCCSPCache()?.records?.length ?? 0) > 0 && !aeSetChanged) {
      console.log(`[refresh:all] ccsp: got 0 records but cache has data — keeping existing cache`)
      ccspOk = true
    } else {
      writeCCSPCache(records, fileIds)
      recordOutcome('ccsp', { success: true, recordCount: records.length })
      recordCcspRefreshAt()
      ccspOk = true
    }
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
  recordSupportableRefreshAt()
  console.log(`[refresh:subscriptions] done (${refreshed}/${customers.length} customers, batch mode)`)
}

export async function refreshCCSP(force = false): Promise<void> {
  try {
    const currentSheetIds = aes.filter(a => a.ccspSheetId).map(a => a.ccspSheetId!)
    let aeSetChanged = false
    if (!force) {
      // L1 cache check (BKL-INGEST-10) — if CCSP disk cache < 24h AND fileIds match,
      // no Drive call needed. L1 must be consulted before any external call.
      const now = Date.now()
      const l1Cached = readCCSPCache()
      if (l1Cached?.cachedAt && (now - new Date(l1Cached.cachedAt).getTime()) < INGEST_L1_TTL_MS) {
        const l1MatchesCurrent = l1Cached.fileIds?.length === currentSheetIds.length &&
          currentSheetIds.every(id => l1Cached.fileIds!.includes(id))
        if (l1MatchesCurrent) {
          const ageHours = Math.round((now - new Date(l1Cached.cachedAt).getTime()) / 3_600_000 * 10) / 10
          console.log(`[refresh:ccsp] L1 cache fresh (${ageHours}h old) — skipping Drive check`)
          emitCacheLevel({ ae: null, flow: 'ccsp', level: 1 })
          return
        }
      }
      const cached = readCCSPCache()
      // Mirror pipeline staleness check: if AE sheet IDs don't match cached fileIds, force refresh
      const cachedMatchesCurrent = cached?.fileIds?.length &&
        currentSheetIds.length === cached.fileIds.length &&
        currentSheetIds.every(id => cached.fileIds!.includes(id))
      aeSetChanged = !cachedMatchesCurrent
      if (cachedMatchesCurrent && cached!.cachedAt) {
        const changed = await checkFilesModified(cached!.fileIds!, cached!.cachedAt)
        if (!changed) { console.log(`[refresh:ccsp] skipped — source files unchanged`); return }
      }
      if (aeSetChanged) {
        console.log(`[refresh:ccsp] AE set changed — forcing full refresh (BKL-CCSP-03)`)
      }
    }
    const { records, fileIds } = await fetchCCSPData(aes.filter(a => a.ccspSheetId).map(a => ({ sheetId: a.ccspSheetId!, aeName: a.name })))
    // Guard: don't overwrite populated cache with empty — quota failure returns [] silently
    // BKL-CCSP-03: bypass guard when AE set changed — 0 records is valid for a new AE set
    if (records.length === 0 && (readCCSPCache()?.records?.length ?? 0) > 0 && !aeSetChanged && !force) {
      console.log(`[refresh:ccsp] got 0 records but cache has data — keeping existing cache`)
      return
    }
    writeCCSPCache(records, fileIds)
    recordOutcome('ccsp', { success: true, recordCount: records.length })
    recordCcspRefreshAt()
    console.log(`[refresh:ccsp] done`)
  } catch (e: any) {
    console.warn(`[refresh:ccsp] ${e.message}`)
  }
}

export async function refreshPipeline(force = false): Promise<void> {
  try {
    const pipelineIds = aes.map(a => a.pipelineSheetId).filter((id): id is string => Boolean(id))
    const cached = readPipelineCache()
    if (!force) {
      // L1 cache check (BKL-INGEST-10) — if pipeline disk cache < 24h AND fileIds
      // match, no Drive call needed. L1 must be consulted before any external call.
      const now = Date.now()
      if (cached?.cachedAt && (now - new Date(cached.cachedAt).getTime()) < INGEST_L1_TTL_MS) {
        const l1MatchesCurrent = cached.fileIds?.length === pipelineIds.length &&
          pipelineIds.every(id => cached.fileIds!.includes(id))
        if (l1MatchesCurrent) {
          const ageHours = Math.round((now - new Date(cached.cachedAt).getTime()) / 3_600_000 * 10) / 10
          console.log(`[refresh:pipeline] L1 cache fresh (${ageHours}h old) — skipping Drive check`)
          emitCacheLevel({ ae: null, flow: 'sfPipeline', level: 1 })
          return
        }
      }
      // Only use staleness check if cached fileIds exactly match current AE sheet IDs.
      // If AEs were re-bootstrapped (new sheet IDs), cached.fileIds will differ — force refresh.
      const cachedMatchesCurrent = cached?.fileIds?.length &&
        pipelineIds.length === cached.fileIds.length &&
        pipelineIds.every(id => cached.fileIds!.includes(id))
      if (cachedMatchesCurrent && cached!.cachedAt) {
        const changed = await checkFilesModified(cached!.fileIds!, cached!.cachedAt)
        if (!changed) { console.log(`[refresh:pipeline] skipped — source files unchanged`); return }
      }
    }
    const { records, fileIds } = await fetchPipelineData(pipelineIds.length ? pipelineIds : undefined)
    // Guard: don't overwrite populated cache with empty — quota/network failure returns [] silently
    if (records.length === 0 && (readPipelineCache()?.records?.length ?? 0) > 0) {
      console.log(`[refresh:pipeline] got 0 records but cache has data — keeping existing cache`)
      return
    }
    writePipelineCache(records, fileIds)
    recordOutcome('sf-pipeline', { success: true, recordCount: records.length })
    // NOTE: recordSfSyncSuccess is intentionally NOT called here — this path only reads
    // from Google Sheets, not from Salesforce. Only the actual SF browser scrape calls it.
    console.log(`[refresh:pipeline] done`)
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
  return router
}
