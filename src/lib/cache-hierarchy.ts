/**
 * BKL-CACHE-HIER-01 — 4-level cache hierarchy helpers (CCSP + SF pipeline).
 *
 * Extracted from src/bootstrap-orchestrator.ts (BKL-ARCH-08) without behavioral
 * changes. The hierarchy:
 *   Level 1: on-disk local cache, cachedAt < 24h → use directly (no Drive)
 *   Level 2: AE Drive sheet (ccspSheetId / pipelineSheetId / subscriptionSheetId),
 *            modifiedTime < 24h → read rows
 *   Level 3: Subscription Data folder CSV < 24h (existing scraper paths)
 *   Level 4: fresh source pull (Tableau / Salesforce) — existing paths
 *
 * Every helper is non-fatal: any failure returns null/false so the caller can
 * fall through to the next level.
 */
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from '../google.ts'
import { readPipelineCache, readCCSPCache } from '../cache-layer.ts'
import type { SfReportRow } from '../sf-scraper.ts'
import { sanitizeErr } from '../utils.ts'

/** BKL-CACHE-HIER-01: 24h threshold shared by every Level 1/Level 2 check. */
export const CACHE_HIER_FRESH_MS = 24 * 60 * 60 * 1000

/**
 * BKL-CACHE-HIER-01: Level 1 check for SF pipeline — on-disk `pipeline-data.json`
 * is fresh (cachedAt < 24h) AND includes this AE's pipelineSheetId in fileIds.
 * Non-fatal: any failure returns false and the caller falls through.
 */
export function isPipelineDiskCacheFreshForAe(pipelineSheetId: string | undefined): boolean {
  if (!pipelineSheetId) return false
  try {
    const cached = readPipelineCache()
    if (!cached?.cachedAt) return false
    const age = Date.now() - new Date(cached.cachedAt).getTime()
    if (!Number.isFinite(age) || age >= CACHE_HIER_FRESH_MS) return false
    const fileIds = cached.fileIds ?? []
    return fileIds.includes(pipelineSheetId)
  } catch {
    return false
  }
}

/**
 * BKL-CACHE-HIER-01: Level 1 check for CCSP — on-disk `ccsp-data.json`
 * is fresh (cachedAt < 24h) AND includes this AE's ccspSheetId in fileIds.
 * Non-fatal: any failure returns false and the caller falls through.
 */
export function isCcspDiskCacheFreshForAe(ccspSheetId: string | undefined): boolean {
  if (!ccspSheetId) return false
  try {
    const cached = readCCSPCache()
    if (!cached?.cachedAt) return false
    const age = Date.now() - new Date(cached.cachedAt).getTime()
    if (!Number.isFinite(age) || age >= CACHE_HIER_FRESH_MS) return false
    const fileIds = cached.fileIds ?? []
    return fileIds.includes(ccspSheetId)
  } catch {
    return false
  }
}

/**
 * BKL-CACHE-HIER-01: Level 2 helper — fetch a Drive file's modifiedTime.
 * Uses drive.files.get with fields: 'id,modifiedTime' — the lightest possible call.
 * Returns null on any failure (non-fatal, caller falls through to Level 3).
 */
export async function getSheetModifiedTime(sheetId: string): Promise<Date | null> {
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    if (!auth) return null
    const drive = google.drive({ version: 'v3', auth })
    const res = await withQuotaRetry(
      () => drive.files.get({ fileId: sheetId, fields: 'id,modifiedTime', supportsAllDrives: true }),
      'cache-hier modifiedTime',
    )
    const mt = res.data.modifiedTime
    if (!mt) return null
    const d = new Date(mt)
    return isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}

/**
 * BKL-CACHE-HIER-01: Level 2 read for an AE's existing CCSP sheet.
 * The sheet is already parsed + territory-filtered by a prior bootstrap run — no CSV
 * parsing or territory filter needed. Returns rows as Record<string, string>[] matching
 * the shape runCcspScrape() would emit (so downstream writers/normalizers are identical).
 * Returns null on any failure — caller falls through to Level 3 non-fatally.
 */
export async function readCcspFromAeSheet(ccspSheetId: string): Promise<Record<string, string>[] | null> {
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    if (!auth) return null
    const sheets = google.sheets({ version: 'v4', auth })
    // CCSP sheet tab is always 'CCSP Data' (writeCcspSheet enforces this).
    const res = await withQuotaRetry(
      () => sheets.spreadsheets.values.get({ spreadsheetId: ccspSheetId, range: `'CCSP Data'!A:AM` }),
      'cache-hier CCSP sheet read',
    )
    const raw = (res.data.values ?? []) as string[][]
    if (raw.length < 2) return null
    const headers = raw[0].map(h => String(h ?? ''))
    const out: Record<string, string>[] = []
    for (let i = 1; i < raw.length; i++) {
      const row = raw[i]
      if (!row || !row.some(v => v != null && String(v).trim() !== '')) continue
      const obj: Record<string, string> = {}
      for (let c = 0; c < headers.length; c++) {
        obj[headers[c]] = String(row[c] ?? '')
      }
      out.push(obj)
    }
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/**
 * BKL-CACHE-HIER-01: Level 2 read for an AE's existing SF Pipeline sheet.
 * The sheet is already parsed from a prior SF report scrape — no browser session
 * needed. Returns data as the SfReportRow shape runSfPipelineSyncFromData expects
 * (headers + rows). Returns null on any failure — caller falls through to Level 3.
 */
export async function readPipelineFromAeSheet(pipelineSheetId: string): Promise<SfReportRow | null> {
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    if (!auth) return null
    const sheets = google.sheets({ version: 'v4', auth })
    // SF pipeline scraper always writes to a 'Pipeline' tab (see fetchPipelineData).
    const res = await withQuotaRetry(
      () => sheets.spreadsheets.values.get({ spreadsheetId: pipelineSheetId, range: `'Pipeline'!A1:Z5000` }),
      'cache-hier Pipeline sheet read',
    )
    const raw = (res.data.values ?? []) as string[][]
    if (raw.length < 2) return null
    const headers = raw[0].map(h => String(h ?? ''))
    const rows: string[][] = []
    for (let i = 1; i < raw.length; i++) {
      const row = raw[i]
      if (!row || !row.some(v => v != null && String(v).trim() !== '')) continue
      rows.push(row.map(c => String(c ?? '')))
    }
    return rows.length > 0 ? { headers, rows } : null
  } catch {
    return null
  }
}

/**
 * BKL-INGEST-02: Level 2 read for an AE's existing Supportable (SF Bookings) sheet.
 * The sheet is already parsed + territory-filtered by a prior bootstrap run — no
 * POD-level SF bookings sheet read needed. Reconstructs SupportableResult[] from
 * the sheet's multi-tab structure:
 *   - 'Accounts' tab → customer names + account numbers
 *   - One tab per customer → subscription rows (CSV_HEADERS format)
 * Returns null on any failure — caller falls through to Level 3 (L3 = read the
 * POD-level SF bookings source sheet via fetchSfBookingsRaw).
 */
export async function readSfBookingsFromAeSheet(subscriptionSheetId: string): Promise<import('../supportable-scraper.ts').SupportableResult[] | null> {
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    if (!auth) return null
    const sheetsClient = google.sheets({ version: 'v4', auth })

    // Read Accounts tab — the directory of customers in this sheet.
    const accountsRes = await withQuotaRetry(
      () => sheetsClient.spreadsheets.values.get({ spreadsheetId: subscriptionSheetId, range: `'Accounts'!A1:C1000` }),
      'cache-hier SF bookings Accounts read',
    )
    const accountsRaw = (accountsRes.data.values ?? []) as string[][]
    if (accountsRaw.length < 2) return null  // header-only or empty

    // Skip header row; row shape is [Account Name, Account ID(s), Alias].
    const accountEntries: Array<{ customerName: string; accountNumbers: string[] }> = []
    for (let i = 1; i < accountsRaw.length; i++) {
      const row = accountsRaw[i] ?? []
      const customerName = String(row[0] ?? '').trim()
      if (!customerName) continue
      const accountNumbers = String(row[1] ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0)
      accountEntries.push({ customerName, accountNumbers })
    }
    if (accountEntries.length === 0) return null

    // Read each customer's subscription tab.
    const results: import('../supportable-scraper.ts').SupportableResult[] = []
    for (const entry of accountEntries) {
      const tab = entry.customerName.slice(0, 100)  // matches writeSubscriptionSheet tab naming
      // Escape single quotes in tab names for Sheets A1 notation (e.g. "O'Reilly" → "O''Reilly").
      // Without this, the range string `'O'Reilly'!A1:ZZ5000` terminates after the first quote
      // and the API returns a 400 for the malformed range.
      const safeTab = tab.replace(/'/g, "''")
      try {
        const tabRes = await withQuotaRetry(
          () => sheetsClient.spreadsheets.values.get({ spreadsheetId: subscriptionSheetId, range: `'${safeTab}'!A1:ZZ5000` }),
          `cache-hier SF bookings tab read (${tab})`,
        )
        const tabRaw = (tabRes.data.values ?? []) as string[][]
        if (tabRaw.length < 1) {
          // Tab missing or empty — include customer with no rows so downstream accounting still sees the match.
          results.push({ customerName: entry.customerName, accountNumbers: entry.accountNumbers, rows: [] })
          continue
        }
        const headers = (tabRaw[0] ?? []).map(h => String(h ?? ''))
        const rows: Record<string, string>[] = []
        for (let i = 1; i < tabRaw.length; i++) {
          const row = tabRaw[i] ?? []
          if (!row.some(v => v != null && String(v).trim() !== '')) continue
          const obj: Record<string, string> = {}
          for (let c = 0; c < headers.length; c++) {
            obj[headers[c]] = String(row[c] ?? '')
          }
          rows.push(obj)
        }
        results.push({ customerName: entry.customerName, accountNumbers: entry.accountNumbers, rows })
      } catch (e: any) {
        // Tab read failed (e.g. deleted, quota) — skip this customer, keep the rest.
        console.warn(`[bootstrap] L2 SF bookings read failed for ${tab}: ${sanitizeErr(e)}`)
        results.push({ customerName: entry.customerName, accountNumbers: entry.accountNumbers, rows: [] })
      }
    }
    return results.length > 0 ? results : null
  } catch (e: any) {
    console.warn(`[bootstrap] L2 SF bookings read failed for sheet ...${subscriptionSheetId.slice(-6)}: ${sanitizeErr(e)}`)
    return null
  }
}
