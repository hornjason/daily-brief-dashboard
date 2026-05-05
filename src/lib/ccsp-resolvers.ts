// CCSP source resolvers — extracted from fetchCCSPData (BKL-ARCH-06).
//
// fetchCCSPData was a 211-line function with three implicit per-sheet fallback
// strategies. This module exposes them as composable CcspSourceResolver
// implementations that can be unit-tested with mock Sheets clients.
//
// Resolvers are NOT top-level alternatives — they form a per-sheet fallback
// chain inside fetchCCSPData's main loop:
//
//   KnownSheetResolver       → fast path: read knownTab directly
//   TabDiscoveryResolver     → fallback: scan all tabs of same spreadsheet
//   DriveFolderResolver      → fallback: scan AE's Drive folder for alt sheet
//
// The chain runs until a resolver returns rows (≥2). parseCcspRows is then
// called once on the result to turn rows into CCSPRecord[].
//
// All Drive/Sheets I/O is injected via CcspResolverContext so tests can
// substitute mock clients with no real network.

import type { sheets_v4 } from 'googleapis'
import { withQuotaRetry } from '../google.ts'
import type { CCSPRecord } from '../sheets.ts'

// ── Interface ────────────────────────────────────────────────────────────────

export interface CcspResolverContext {
  /** The spreadsheet ID under examination on this iteration. */
  spreadsheetId: string
  /** The tab name passed by the fast path (typically "CCSP Data"). */
  knownTab: string
  /** AE name from caller's aeMap, when fetchCCSPData was given AE-tagged pairs. */
  aeName?: string
  /** Authenticated Sheets client (real or mock). */
  sheets: sheets_v4.Sheets
  /** Lookup the AE's drive folder + canonical name (for DriveFolderResolver). */
  lookupAe?: (
    spreadsheetId: string,
    aeName: string | undefined,
  ) => { name?: string; driveFolderId?: string } | undefined
  /** Persist a found alternative sheet ID back to aes.json. */
  patchAe?: (name: string, fields: { ccspSheetId: string }) => void
  /** List spreadsheet IDs under a Drive folder. */
  listSpreadsheetsUnder?: (folderId: string) => Promise<string[]>
}

export interface CcspSourceResolver {
  name: string
  /** Returns raw sheet rows if this resolver has data, null if it can't help. */
  resolve(ctx: CcspResolverContext): Promise<unknown[][] | null>
}

// ── KnownSheetResolver ───────────────────────────────────────────────────────
// Fast path. Reads the caller-supplied tab on the caller-supplied spreadsheet.
// Returns rows if ≥2 (header + at least one data row); null otherwise.

export const KnownSheetResolver: CcspSourceResolver = {
  name: 'known-sheet',
  async resolve(ctx) {
    const { spreadsheetId, knownTab, sheets } = ctx
    const safeTab = knownTab.replace(/'/g, "''")
    const dataRes = await withQuotaRetry(
      () => sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${safeTab}'!A:AM`,
      }),
      `ccsp-read ${spreadsheetId}`,
    ).catch((e: any) => {
      console.warn(`[ccsp-read] sheet ${spreadsheetId} tab '${knownTab}' read failed: ${e?.message} — will attempt tab discovery`)
      return null
    })
    const rows = (dataRes?.data.values ?? []) as unknown[][]
    if (rows.length >= 2) return rows
    return null
  },
}

// ── TabDiscoveryResolver ─────────────────────────────────────────────────────
// Fetches the spreadsheet's full tab list. Tries any tab with "ccsp" in the
// name first (excluding the already-failed knownTab). Falls back to all
// remaining tabs. Returns the first tab whose data has ≥2 rows.

export const TabDiscoveryResolver: CcspSourceResolver = {
  name: 'tab-discovery',
  async resolve(ctx) {
    const { spreadsheetId, knownTab, sheets } = ctx
    let allTabs: string[]
    try {
      const meta = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties.title',
      })
      allTabs = (meta.data.sheets ?? []).map((s) => s.properties?.title ?? '')
    } catch (e: any) {
      console.warn(`[ccsp-read] tab discovery error for ${spreadsheetId}: ${e?.message}`)
      return null
    }
    console.log(`[ccsp-read] sheet ${spreadsheetId} tabs found: [${allTabs.join(', ')}]`)

    // First: try any tab with 'ccsp' in name (different from the failed knownTab)
    const ccspNamedTab = allTabs.find((t) => t.toLowerCase().includes('ccsp') && t !== knownTab)
    const tabsToTry = ccspNamedTab ? [ccspNamedTab] : allTabs.filter((t) => t !== knownTab)

    for (const tab of tabsToTry) {
      const safeTab = tab.replace(/'/g, "''")
      const retryRes = await withQuotaRetry(
        () => sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `'${safeTab}'!A:AM`,
        }),
        `ccsp-read retry ${spreadsheetId}`,
      ).catch(() => null)
      const retryRows = (retryRes?.data.values ?? []) as unknown[][]
      if (retryRows.length >= 2) {
        console.log(`[ccsp-read] tab discovery succeeded with '${tab}'`)
        return retryRows
      }
    }
    return null
  },
}

// ── DriveFolderResolver ──────────────────────────────────────────────────────
// Last-resort fallback: looks up the AE's driveFolderId, scans for alternative
// CCSP spreadsheets (filename contains "ccsp"), and reads the first one with
// data. On success, patches aes.json so the next run uses the alt sheet
// directly via the fast path.

const SHEET_ID_RE = /^[a-zA-Z0-9_-]{20,60}$/

export const DriveFolderResolver: CcspSourceResolver = {
  name: 'drive-folder',
  async resolve(ctx) {
    const { spreadsheetId, aeName, sheets, lookupAe, patchAe, listSpreadsheetsUnder } = ctx
    if (!lookupAe || !listSpreadsheetsUnder) return null

    const aeEntry = lookupAe(spreadsheetId, aeName)
    const driveFolderId = aeEntry?.driveFolderId
    if (!driveFolderId) return null

    console.warn(`[ccsp-read] known sheet empty — searching AE Drive folder ${driveFolderId} for alternative CCSP sheet`)
    let candidateIds: string[]
    try {
      candidateIds = await listSpreadsheetsUnder(driveFolderId)
    } catch (e: any) {
      console.warn(`[ccsp-read] Drive folder search failed for ${driveFolderId}: ${e?.message}`)
      return null
    }

    const candidateMeta = await Promise.all(
      candidateIds.map((id) =>
        sheets.spreadsheets.get({
          spreadsheetId: id,
          fields: 'properties.title,sheets.properties.title',
        })
          .then((res) => ({
            id,
            fileName: (res.data.properties?.title ?? '').toLowerCase(),
            tabs: (res.data.sheets ?? []).map((s) => s.properties?.title ?? ''),
          }))
          .catch(() => ({ id, fileName: '', tabs: [] as string[] })),
      ),
    )

    for (const { id, fileName, tabs } of candidateMeta) {
      if (id === spreadsheetId) continue        // already tried this one
      if (!fileName.includes('ccsp')) continue
      const ccspTabName = tabs.find((t) => t.toLowerCase().includes('ccsp'))
      if (!ccspTabName) continue

      const safeTab = ccspTabName.replace(/'/g, "''")
      const altRes = await withQuotaRetry(
        () => sheets.spreadsheets.values.get({
          spreadsheetId: id,
          range: `'${safeTab}'!A:AM`,
        }),
        `ccsp-read alt ${id}`,
      ).catch(() => null)
      const candidateRows = (altRes?.data.values ?? []) as unknown[][]
      if (candidateRows.length >= 2 && SHEET_ID_RE.test(id)) {
        console.log(`[ccsp-read] found alternative CCSP sheet ${id} in AE folder — using instead`)
        // Persist so next run uses the correct sheet directly
        const nameForPatch = aeName ?? aeEntry?.name
        if (nameForPatch && patchAe) patchAe(nameForPatch, { ccspSheetId: id })
        return candidateRows
      }
    }

    console.warn(`[ccsp-read] no alternative CCSP sheet found in AE folder — skipping`)
    return null
  },
}

// ── Resolver chain ───────────────────────────────────────────────────────────

export const DEFAULT_CCSP_RESOLVER_CHAIN: CcspSourceResolver[] = [
  KnownSheetResolver,
  TabDiscoveryResolver,
  DriveFolderResolver,
]

/**
 * Run the resolver chain until one returns rows. Returns null if all resolvers
 * return null.
 */
export async function runResolverChain(
  ctx: CcspResolverContext,
  chain: CcspSourceResolver[] = DEFAULT_CCSP_RESOLVER_CHAIN,
): Promise<unknown[][] | null> {
  for (const resolver of chain) {
    const rows = await resolver.resolve(ctx)
    if (rows && rows.length >= 2) return rows
  }
  return null
}

// ── parseCcspRows ────────────────────────────────────────────────────────────
// Pure function — no I/O. Takes raw sheet rows (header row + data rows), does
// flexible column detection, and returns CCSPRecord[].
//
// Column detection notes:
//   - acctCol: Tableau Raw Data uses "Account Name"; summary views may use
//     "Account", "Customer Name", or "Company".
//   - acvCol:  may be "ACV Plus", "ACV+", or "ACVPlus".
//   - productOfferingGroup: column S (index 18) — absent in older sheets.

function normalizePartner(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower.includes('amazon') || lower.includes('aws')) return 'AWS'
  if (lower.includes('google')) return 'Google'
  if (lower.includes('microsoft')) return 'Microsoft'
  return 'Other'
}

export function parseCcspRows(
  rows: unknown[][],
  spreadsheetId: string,
  aeName?: string,
): CCSPRecord[] {
  if (rows.length < 2) return []

  const headers = (rows[0] ?? []).map((h: unknown) => String(h ?? '').trim())
  const acctCol = headers.findIndex((h) => {
    const lower = h.toLowerCase()
    return lower === 'account name' || lower === 'account' || lower === 'customer name' || lower === 'company'
  })
  const qtrCol = headers.findIndex((h) => h.toLowerCase().includes('fiscal year quarter'))
  const closeDateCol = headers.findIndex((h) => h.toLowerCase() === 'opportunity close date')
  const partnerCol = headers.findIndex((h) => h.toLowerCase().includes('financial partner'))
  const acvCol = headers.findIndex((h) => {
    const lower = h.toLowerCase()
    return lower === 'acv plus' || lower === 'acv+' || lower === 'acvplus'
  })

  if (acctCol < 0) {
    console.warn(`[ccsp] sheet ${spreadsheetId}: no account name column found (tried: account name, account, customer name, company). Headers: [${headers.join(', ')}]. This usually means the Tableau scraper downloaded the summary view instead of Raw Data.`)
  }
  if (acvCol < 0) {
    console.warn(`[ccsp] sheet ${spreadsheetId}: no ACV column found (tried: acv plus, acv+, acvplus). Headers: [${headers.join(', ')}]`)
  }
  if (acctCol < 0 || acvCol < 0) return []

  const records: CCSPRecord[] = []
  for (const row of rows.slice(1)) {
    const acvStr = String(row[acvCol] ?? '').replace(/[$,]/g, '').trim()
    const acv = parseFloat(acvStr)
    if (!acv || isNaN(acv)) continue

    const productOfferingGroupRaw = String(row[18] ?? '').trim()
    records.push({
      accountName: String(row[acctCol] ?? '').trim(),
      quarter: qtrCol >= 0 ? String(row[qtrCol] ?? '').trim() : '',
      closeDate: closeDateCol >= 0 ? String(row[closeDateCol] ?? '').trim() : '',
      cloudPartner: partnerCol >= 0 ? normalizePartner(String(row[partnerCol] ?? '')) : 'Other',
      acvPlus: acv,
      ...(aeName ? { ae: aeName } : {}),
      ...(productOfferingGroupRaw ? { productOfferingGroup: productOfferingGroupRaw } : {}),
    })
  }
  return records
}
