import { readFileSync } from 'fs'
import type { Hono } from 'hono'
import type { Customer } from './types.ts'
import { aes, customers } from './server-state.ts'
import { readSheetCache, writeSheetCache, readCCSPCache, writeCCSPCache, readPipelineCache, writePipelineCache } from './cache-layer.ts'
import { fetchCustomerSheetData, fetchCCSPData, batchFetchSubscriptions } from './sheets.ts'
import { fetchPipelineData } from './pipeline.ts'
import { checkFilesModified } from './drive-watcher.ts'
import { recordSfSyncSuccess } from './sf-scraper.ts'
import { recordOutcome } from './scraper-status-store.ts'
import { recordCcspRefreshAt } from './ccsp-scraper.ts'
import { recordSupportableRefreshAt } from './supportable-scraper.ts'

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
    if (records.length === 0 && (readCCSPCache()?.records?.length ?? 0) > 0) {
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
    if (!force) {
      const cached = readCCSPCache()
      const currentSheetIds = aes.filter(a => a.ccspSheetId).map(a => a.ccspSheetId!)
      // Mirror pipeline staleness check: if AE sheet IDs don't match cached fileIds, force refresh
      const cachedMatchesCurrent = cached?.fileIds?.length &&
        currentSheetIds.length === cached.fileIds.length &&
        currentSheetIds.every(id => cached.fileIds!.includes(id))
      if (cachedMatchesCurrent && cached!.cachedAt) {
        const changed = await checkFilesModified(cached!.fileIds!, cached!.cachedAt)
        if (!changed) { console.log(`[refresh:ccsp] skipped — source files unchanged`); return }
      }
    }
    const { records, fileIds } = await fetchCCSPData(aes.filter(a => a.ccspSheetId).map(a => ({ sheetId: a.ccspSheetId!, aeName: a.name })))
    // Guard: don't overwrite populated cache with empty — quota failure returns [] silently
    if (records.length === 0 && (readCCSPCache()?.records?.length ?? 0) > 0) {
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
    recordSfSyncSuccess(records.length)
    console.log(`[refresh:pipeline] done`)
  } catch (e: any) {
    console.warn(`[refresh:pipeline] ${e.message}`)
  }
}

// ── Route registration ──────────────────────────────────────────────────────

export function registerRefreshRoutes(app: Hono): void {
  app.post('/api/refresh', async (c) => {
    const result = await refreshAll()
    return c.json({ ...result, refreshedAt: new Date().toISOString() })
  })
  app.post('/api/refresh/pipeline', async (c) => {
    await refreshPipeline(true)
    return c.json({ ok: true, refreshedAt: new Date().toISOString() })
  })
  app.post('/api/refresh/subscriptions', async (c) => {
    await refreshSubscriptions(true)
    return c.json({ ok: true, refreshedAt: new Date().toISOString() })
  })
  app.post('/api/refresh/ccsp', async (c) => {
    await refreshCCSP(true)
    return c.json({ ok: true, refreshedAt: new Date().toISOString() })
  })
}
