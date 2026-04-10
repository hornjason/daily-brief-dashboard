/**
 * src/restore-routes.ts — BKL-RESTORE-01
 *
 * Rebuilds dashboard cache from Google Sheets without re-scraping.
 * Given a valid aes.json with supportableSheetId, pipelineSheetId, and
 * ccspSheetId per AE, reads those sheets and restores:
 *   - customers.json (from Supportable "Accounts" tab)
 *   - {slug}-sheets.json (from per-customer Supportable tabs)
 *   - ccsp-data.json (from CCSP sheet)
 *   - pipeline-data.json (from Pipeline sheet)
 *
 * Does NOT restore: cases.json (live-only), daily briefs (AI-generated),
 * intelligence files, or any scraper state.
 */

import { writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import type { Hono } from 'hono'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from './google.ts'
import { aes, customers, saveCustomers } from './server-state.ts'
import { toSlug, sheetCachePath, invalidateCCSPCache, isCCSPCacheStale } from './cache-layer.ts'
import { normalizeRows } from './sheets.ts'
import { parsePipelineRows } from './pipeline.ts'
import type { Customer, SheetRow, ProductSubscription } from './types.ts'
import type { CCSPRecord } from './sheets.ts'
import type { PipelineRecord } from './pipeline.ts'
import { sanitizeErr, sanitizeText } from './utils.ts'

// ── Module state ─────────────────────────────────────────────────────────────
let CACHE_DIR = ''

export function initRestoreRoutes(opts: { cacheDir: string }): void {
  CACHE_DIR = opts.cacheDir
}

// ── Atomic write helper ──────────────────────────────────────────────────────
function atomicWriteJSON(filePath: string, data: unknown): void {
  const tmp = filePath + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, filePath)
}

// ── Result types ─────────────────────────────────────────────────────────────
interface AERestoreResult {
  ae: string
  status: 'ok' | 'error' | 'skipped'
  customers?: number
  subscriptionFiles?: number
  error?: string
}

interface RestoreResponse {
  ok: boolean
  total: number
  results: AERestoreResult[]
}

// ── Restore logic per AE ─────────────────────────────────────────────────────

async function restoreFromSupportableSheet(
  sheets: ReturnType<typeof google.sheets>,
  sheetId: string,
  aeName: string,
): Promise<{
  customers: Array<{ name: string; accountNumbers: string[] }>
  subscriptionFiles: number
}> {
  // 1. Get all tab names
  const meta = await withQuotaRetry(
    () => sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: 'sheets.properties.title',
    }),
    `restore-meta ${aeName}`,
  )
  const tabTitles = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')

  // 2. Read "Accounts" tab — columns: Account Name, Account ID(s), Alias
  if (!tabTitles.includes('Accounts')) {
    throw new Error('No "Accounts" tab found in Supportable sheet')
  }

  const accountsRes = await withQuotaRetry(
    () => sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Accounts!A:C',
    }),
    `restore-accounts ${aeName}`,
  )
  const accountRows = accountsRes.data.values ?? []
  if (accountRows.length < 2) {
    throw new Error('Accounts tab has 0 data rows — skipping AE')
  }

  // Parse Accounts tab: header row + data rows
  const headers = (accountRows[0] ?? []).map(String)
  const nameIdx = headers.findIndex(h => h.toLowerCase().includes('account name') || h.toLowerCase() === 'name')
  const idIdx = headers.findIndex(h => h.toLowerCase().includes('account id'))
  if (nameIdx < 0) throw new Error('No "Account Name" column found in Accounts tab')

  const restoredCustomers: Array<{ name: string; accountNumbers: string[] }> = []

  for (const row of accountRows.slice(1)) {
    const name = String(row[nameIdx] ?? '').trim()
    if (!name) continue
    const rawIds = idIdx >= 0 ? String(row[idIdx] ?? '').trim() : ''
    // Account IDs are comma-separated in the cell
    const accountNumbers = rawIds
      .split(/[,;\s]+/)
      .map(s => s.trim())
      .filter(s => /^\d{4,12}$/.test(s))
    restoredCustomers.push({ name, accountNumbers })
  }

  // 3. Read per-customer tabs and write sheet cache files
  let subscriptionFiles = 0
  const customerTabs = tabTitles.filter(t => t !== 'Accounts')

  for (const tab of customerTabs) {
    const safeTabName = tab.replace(/'/g, "''")  // escape single quotes for A1 notation
    const dataRes = await withQuotaRetry(
      () => sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${safeTabName}'!A:Z`,
      }),
      `restore-tab ${tab}`,
    )
    const rows = dataRes.data.values ?? []
    if (rows.length < 2) continue

    const tabHeaders = (rows[0] ?? []).map(String)
    const sheetRows: SheetRow[] = rows.slice(1)
      .map(row => {
        const obj: SheetRow = {}
        tabHeaders.forEach((h, i) => { obj[h] = String(row[i] ?? '') })
        return obj
      })
      .filter(row => Object.values(row).some(v => v.trim()))

    const normalized = normalizeRows(sheetRows, tab)
    if (normalized.length === 0) continue

    // Write to cache — use resolve() + toSlug() for safe path construction
    const slug = toSlug(tab)
    if (!slug) continue
    const cachePath = resolve(CACHE_DIR, `${slug}-sheets.json`)
    atomicWriteJSON(cachePath, { rows: normalized, cachedAt: new Date().toISOString() })
    subscriptionFiles++
  }

  return { customers: restoredCustomers, subscriptionFiles }
}

async function restoreFromCCSPSheet(
  sheets: ReturnType<typeof google.sheets>,
  sheetId: string,
  aeName: string,
): Promise<CCSPRecord[]> {
  // Try "CCSP Data" tab first, fall back to any tab containing "ccsp"
  const meta = await withQuotaRetry(
    () => sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: 'sheets.properties.title',
    }),
    `restore-ccsp-meta ${aeName}`,
  )
  const tabTitles = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')
  const ccspTab = tabTitles.find(t => t === 'CCSP Data')
    ?? tabTitles.find(t => t.toLowerCase().includes('ccsp'))
  if (!ccspTab) return []

  const safeTab = ccspTab.replace(/'/g, "''")
  const dataRes = await withQuotaRetry(
    () => sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${safeTab}'!A:AM`,
    }),
    `restore-ccsp ${aeName}`,
  )
  const rows = dataRes.data.values ?? []
  if (rows.length < 2) return []

  const headers = (rows[0] ?? []).map((h: unknown) => String(h ?? '').trim())
  const acctCol = headers.findIndex(h => {
    const lower = h.toLowerCase()
    return lower === 'account name' || lower === 'account' || lower === 'customer name' || lower === 'company'
  })
  const qtrCol = headers.findIndex(h => h.toLowerCase().includes('fiscal year quarter'))
  const closeDateCol = headers.findIndex(h => h.toLowerCase() === 'opportunity close date')
  const partnerCol = headers.findIndex(h => h.toLowerCase().includes('financial partner'))
  const acvCol = headers.findIndex(h => {
    const lower = h.toLowerCase()
    return lower === 'acv plus' || lower === 'acv+' || lower === 'acvplus'
  })

  if (acctCol < 0 || acvCol < 0) return []

  const normalizePartner = (raw: string): string => {
    const lower = raw.toLowerCase()
    if (lower.includes('amazon') || lower.includes('aws')) return 'AWS'
    if (lower.includes('google')) return 'Google'
    if (lower.includes('microsoft')) return 'Microsoft'
    return 'Other'
  }

  const records: CCSPRecord[] = []
  for (const row of rows.slice(1)) {
    const acvStr = String(row[acvCol] ?? '').replace(/[$,]/g, '').trim()
    const acv = parseFloat(acvStr)
    if (!acv || isNaN(acv)) continue

    records.push({
      accountName: String(row[acctCol] ?? '').trim(),
      quarter: qtrCol >= 0 ? String(row[qtrCol] ?? '').trim() : '',
      closeDate: closeDateCol >= 0 ? String(row[closeDateCol] ?? '').trim() : '',
      cloudPartner: partnerCol >= 0 ? normalizePartner(String(row[partnerCol] ?? '')) : 'Other',
      acvPlus: acv,
      ae: aeName,
    })
  }

  return records
}

async function restoreFromPipelineSheet(
  sheets: ReturnType<typeof google.sheets>,
  sheetId: string,
  _aeName: string,
): Promise<PipelineRecord[]> {
  try {
    const res = await withQuotaRetry(
      () => sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: 'Pipeline!A1:Z5000',
      }),
      `restore-pipeline ${_aeName}`,
    )
    const rows = (res.data.values ?? []) as string[][]
    return parsePipelineRows(rows)
  } catch (e: any) {
    // Tab name might differ — try discovering the actual tab
    try {
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: sheetId,
        fields: 'sheets.properties.title',
      })
      const tabTitles = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')
      const pipelineTab = tabTitles.find(t => t.toLowerCase().includes('pipeline'))
      if (!pipelineTab) throw new Error('No pipeline tab found')

      const safeTab = pipelineTab.replace(/'/g, "''")
      const res = await withQuotaRetry(
        () => sheets.spreadsheets.values.get({
          spreadsheetId: sheetId,
          range: `'${safeTab}'!A1:Z5000`,
        }),
        `restore-pipeline-retry ${_aeName}`,
      )
      return parsePipelineRows((res.data.values ?? []) as string[][])
    } catch {
      throw e  // rethrow original error
    }
  }
}

// ── Route registration ──────────────────────────────────────────────────────

export function registerRestoreRoutes(app: Hono): void {
  app.post('/api/admin/restore', async (c) => {
    const startTime = Date.now()
    console.log(`[restore] POST /api/admin/restore started at ${new Date().toISOString()}`)

    let body: { aeNames?: string[] } = {}
    try {
      body = await c.req.json()
    } catch {
      // Empty body is fine — restore all AEs
    }
    // Sanitize aeNames — cap count and clean each name against the trusted AE list
    if (body.aeNames) {
      body.aeNames = body.aeNames
        .slice(0, 50)
        .map(n => sanitizeText(n, 100) ?? '')
        .filter(Boolean)
    }

    if (aes.length === 0) {
      return c.json({ ok: false, total: 0, results: [], error: 'No AEs configured in aes.json' } as RestoreResponse & { error: string }, 400)
    }

    // Ensure cache directory exists
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true })
    }

    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const sheets = google.sheets({ version: 'v4', auth })

    // Filter AEs if subset requested
    const targetAes = body.aeNames?.length
      ? aes.filter(ae => body.aeNames!.includes(ae.name))
      : [...aes]

    if (targetAes.length === 0) {
      return c.json({ ok: false, total: 0, results: [], error: 'No matching AEs found for provided names' } as RestoreResponse & { error: string }, 400)
    }

    const results: AERestoreResult[] = []
    // Accumulate across all AEs before writing global files
    const allCCSPRecords: CCSPRecord[] = []
    const allPipelineRecords: PipelineRecord[] = []
    const customerMergeMap = new Map<string, Customer>()

    // Pre-populate merge map with existing customers
    for (const cu of customers) {
      customerMergeMap.set(cu.name, { ...cu })
    }

    // Process each AE sequentially (per spec — no parallel to avoid quota issues)
    for (const ae of targetAes) {
      console.log(`[restore] processing AE: ${ae.name}`)

      if (!ae.supportableSheetId && !ae.ccspSheetId && !ae.pipelineSheetId) {
        results.push({ ae: ae.name, status: 'skipped', error: 'No sheet IDs configured' })
        continue
      }

      const result: AERestoreResult = { ae: ae.name, status: 'ok' }

      // ── Supportable sheet → customers + subscription cache ──────────────
      if (ae.supportableSheetId) {
        try {
          const supportableResult = await restoreFromSupportableSheet(sheets, ae.supportableSheetId, ae.name)
          result.customers = supportableResult.customers.length
          result.subscriptionFiles = supportableResult.subscriptionFiles

          // Merge into customer map (upsert, don't replace)
          for (const cu of supportableResult.customers) {
            const existing = customerMergeMap.get(cu.name)
            if (existing) {
              // Merge account numbers — union of existing + restored
              const mergedAccounts = [...new Set([
                ...(existing.accountNumbers ?? []),
                ...cu.accountNumbers,
              ])]
              customerMergeMap.set(cu.name, { ...existing, accountNumbers: mergedAccounts, ae: existing.ae ?? ae.name })
            } else {
              customerMergeMap.set(cu.name, { name: cu.name, accountNumbers: cu.accountNumbers, ae: ae.name })
            }
          }

          console.log(`[restore] ${ae.name}: restored ${supportableResult.customers.length} customers, ${supportableResult.subscriptionFiles} subscription files`)
        } catch (e: any) {
          const errMsg = sanitizeErr(e)
          console.error(`[restore] ${ae.name} supportable error: ${errMsg}`)
          result.status = 'error'
          result.error = `Supportable: ${errMsg}`
        }
      }

      // ── CCSP sheet → accumulate records ─────────────────────────────────
      if (ae.ccspSheetId) {
        try {
          const ccspRecords = await restoreFromCCSPSheet(sheets, ae.ccspSheetId, ae.name)
          allCCSPRecords.push(...ccspRecords)
          console.log(`[restore] ${ae.name}: restored ${ccspRecords.length} CCSP records`)
        } catch (e: any) {
          const errMsg = sanitizeErr(e)
          console.error(`[restore] ${ae.name} CCSP error: ${errMsg}`)
          // Don't fail the whole AE for CCSP error — append to error message
          if (result.status === 'error') {
            result.error += `; CCSP: ${errMsg}`
          } else {
            result.status = 'error'
            result.error = `CCSP: ${errMsg}`
          }
        }
      }

      // ── Pipeline sheet → accumulate records ─────────────────────────────
      if (ae.pipelineSheetId) {
        try {
          const pipelineRecords = await restoreFromPipelineSheet(sheets, ae.pipelineSheetId, ae.name)
          allPipelineRecords.push(...pipelineRecords)
          console.log(`[restore] ${ae.name}: restored ${pipelineRecords.length} pipeline records`)
        } catch (e: any) {
          const errMsg = sanitizeErr(e)
          console.error(`[restore] ${ae.name} pipeline error: ${errMsg}`)
          if (result.status === 'error') {
            result.error += `; Pipeline: ${errMsg}`
          } else {
            result.status = 'error'
            result.error = `Pipeline: ${errMsg}`
          }
        }
      }

      results.push(result)
    }

    // ── Write merged customers.json ─────────────────────────────────────────
    const mergedCustomers = Array.from(customerMergeMap.values())
    saveCustomers(mergedCustomers)
    console.log(`[restore] wrote customers.json with ${mergedCustomers.length} customers`)

    // ── Write CCSP cache ────────────────────────────────────────────────────
    const ccspFileIds = targetAes.map(ae => ae.ccspSheetId).filter((id): id is string => Boolean(id))
    if (allCCSPRecords.length > 0) {
      atomicWriteJSON(
        resolve(CACHE_DIR, 'ccsp-data.json'),
        { records: allCCSPRecords, cachedAt: new Date().toISOString(), fileIds: ccspFileIds },
      )
      console.log(`[restore] wrote ccsp-data.json with ${allCCSPRecords.length} records`)
    } else if (isCCSPCacheStale(ccspFileIds)) {
      // BKL-CCSP-03: restore found 0 CCSP records but old cache has stale AE data — invalidate
      invalidateCCSPCache()
      console.log(`[restore] invalidated stale ccsp-data.json (AE set changed, 0 new records)`)
    }

    // ── Write Pipeline cache ────────────────────────────────────────────────
    if (allPipelineRecords.length > 0) {
      // Deduplicate by oppNumber (same logic as pipeline.ts)
      const seen = new Set<string>()
      const deduped = allPipelineRecords.filter(r => {
        const key = r.oppNumber || `${r.accountName}|${r.oppName}|${r.closeDate}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      const pipelineFileIds = targetAes.map(ae => ae.pipelineSheetId).filter((id): id is string => Boolean(id))
      atomicWriteJSON(
        resolve(CACHE_DIR, 'pipeline-data.json'),
        { records: deduped, cachedAt: new Date().toISOString(), fileIds: pipelineFileIds },
      )
      console.log(`[restore] wrote pipeline-data.json with ${deduped.length} records (${allPipelineRecords.length} raw)`)
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const allOk = results.every(r => r.status === 'ok' || r.status === 'skipped')
    console.log(`[restore] completed in ${elapsed}s — ${results.length} AEs processed, ok=${allOk}`)

    return c.json({
      ok: allOk,
      total: results.length,
      results,
    } satisfies RestoreResponse)
  })
}
