import { readFileSync } from 'fs'
import type { Hono } from 'hono'
import { aes, customers } from './server-state.ts'
import { readSheetCache, writeSheetCache, readCCSPCache, writeCCSPCache, readPipelineCache, writePipelineCache } from './cache-layer.ts'
import { fetchCustomerSheetData, fetchCCSPData } from './sheets.ts'
import { fetchPipelineData } from './pipeline.ts'
import { checkFilesModified } from './drive-watcher.ts'

// ── Module state ────────────────────────────────────────────────────────────
let SHEETS_SYNC_PATH = ''

export function initRefreshEngine(sheetsSyncPath: string): void {
  SHEETS_SYNC_PATH = sheetsSyncPath
}

// ── Full data refresh ───────────────────────────────────────────────────────

export async function refreshAll(): Promise<{ sheets: number; ccsp: boolean; errors: string[] }> {
  const errors: string[] = []
  let sheetsRefreshed = 0

  // 1. Subscription sheet data for every customer
  const supportableSheetIds = aes.map(a => a.supportableSheetId).filter((id): id is string => Boolean(id))
  for (const customer of customers) {
    try {
      const rows = await fetchCustomerSheetData(customer, supportableSheetIds.length ? supportableSheetIds : undefined)
      // Guard: don't overwrite populated cache with empty — quota failure returns [] silently
      if (rows.length === 0 && (readSheetCache(customer.name)?.rows?.length ?? 0) > 0) {
        console.log(`[refresh:all] ${customer.name}: got 0 rows but cache has data — keeping existing cache`)
        sheetsRefreshed++
        continue
      }
      writeSheetCache(customer.name, rows)
      sheetsRefreshed++
    } catch (e: any) {
      errors.push(`${customer.name}: ${e.message}`)
    }
  }

  // 2. CCSP
  let ccspOk = false
  try {
    const { records, fileIds } = await fetchCCSPData(aes.map(a => a.ccspSheetId).filter(Boolean) as string[])
    if (records.length === 0 && (readCCSPCache()?.records?.length ?? 0) > 0) {
      console.log(`[refresh:all] ccsp: got 0 records but cache has data — keeping existing cache`)
      ccspOk = true
    } else {
      writeCCSPCache(records, fileIds)
      ccspOk = true
    }
  } catch (e: any) { errors.push(`ccsp: ${e.message}`) }

  console.log(`[refresh] sheets=${sheetsRefreshed}/${customers.length} ccsp=${ccspOk} errors=${errors.length}`)
  return { sheets: sheetsRefreshed, ccsp: ccspOk, errors }
}

// ── Per-source refresh functions ────────────────────────────────────────────

export async function refreshSubscriptions(): Promise<void> {
  // Check if Supportable source sheet has changed before re-fetching all customers
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
  // Collect all known supportable sheet IDs from AE config — avoids BFS + quota-burning all-sheet scan
  const supportableSheetIds = aes.map(a => a.supportableSheetId).filter((id): id is string => Boolean(id))
  for (const customer of customers) {
    try {
      const rows = await fetchCustomerSheetData(customer, supportableSheetIds.length ? supportableSheetIds : undefined)
      // Guard: don't overwrite a populated cache with empty results — quota failure returns [] silently
      if (rows.length === 0 && (readSheetCache(customer.name)?.rows?.length ?? 0) > 0) {
        console.log(`[refresh:subscriptions] ${customer.name}: got 0 rows but cache has data — keeping existing cache`)
        continue
      }
      writeSheetCache(customer.name, rows)
    } catch (e: any) {
      console.warn(`[refresh:subscriptions] ${customer.name}: ${e.message}`)
    }
  }
  console.log(`[refresh:subscriptions] done (${customers.length} customers)`)
}

export async function refreshCCSP(): Promise<void> {
  try {
    const cached = readCCSPCache()
    if (cached?.fileIds?.length && cached.cachedAt) {
      const changed = await checkFilesModified(cached.fileIds, cached.cachedAt)
      if (!changed) { console.log(`[refresh:ccsp] skipped — source files unchanged`); return }
    }
    const { records, fileIds } = await fetchCCSPData(aes.map(a => a.ccspSheetId).filter(Boolean) as string[])
    // Guard: don't overwrite populated cache with empty — quota failure returns [] silently
    if (records.length === 0 && (readCCSPCache()?.records?.length ?? 0) > 0) {
      console.log(`[refresh:ccsp] got 0 records but cache has data — keeping existing cache`)
      return
    }
    writeCCSPCache(records, fileIds)
    console.log(`[refresh:ccsp] done`)
  } catch (e: any) {
    console.warn(`[refresh:ccsp] ${e.message}`)
  }
}

export async function refreshPipeline(): Promise<void> {
  try {
    const pipelineIds = aes.map(a => a.pipelineSheetId).filter((id): id is string => Boolean(id))
    const cached = readPipelineCache()
    // Only use staleness check if cached fileIds exactly match current AE sheet IDs.
    // If AEs were re-bootstrapped (new sheet IDs), cached.fileIds will differ — force refresh.
    const cachedMatchesCurrent = cached?.fileIds?.length &&
      pipelineIds.length === cached.fileIds.length &&
      pipelineIds.every(id => cached.fileIds!.includes(id))
    if (cachedMatchesCurrent && cached!.cachedAt) {
      const changed = await checkFilesModified(cached!.fileIds!, cached!.cachedAt)
      if (!changed) { console.log(`[refresh:pipeline] skipped — source files unchanged`); return }
    }
    const { records, fileIds } = await fetchPipelineData(pipelineIds.length ? pipelineIds : undefined)
    // Guard: don't overwrite populated cache with empty — quota/network failure returns [] silently
    if (records.length === 0 && (readPipelineCache()?.records?.length ?? 0) > 0) {
      console.log(`[refresh:pipeline] got 0 records but cache has data — keeping existing cache`)
      return
    }
    writePipelineCache(records, fileIds)
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
    await refreshPipeline()
    return c.json({ ok: true, refreshedAt: new Date().toISOString() })
  })
  app.post('/api/refresh/subscriptions', async (c) => {
    await refreshSubscriptions()
    return c.json({ ok: true, refreshedAt: new Date().toISOString() })
  })
  app.post('/api/refresh/ccsp', async (c) => {
    await refreshCCSP()
    return c.json({ ok: true, refreshedAt: new Date().toISOString() })
  })
}
