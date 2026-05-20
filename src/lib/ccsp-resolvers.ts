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

// ── ColumnMapping & pattern detection ───────────────────────────────────────
// When Tableau exports the summary view instead of Raw Data, headers may be
// misaligned or entirely wrong. detectColumnsByPattern scans actual data values
// to infer column positions using regex patterns and scoring, independent of
// header text.

export interface ColumnMapping {
  accountName?: number
  quarter?: number
  closeDate?: number
  partner?: number
  acvPlus?: number
}

// Pattern matchers — each returns true if value matches the expected data type.

/** Fiscal quarter: 2025-Q1, 2026-Q4, etc. */
const isQuarterValue = (v: string): boolean => /^\d{4}-Q[1-4]$/.test(v)

/** Date in M/D/YYYY or MM/DD/YYYY format */
const isDateValue = (v: string): boolean => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v)

/** Date in YYYY-MM-DD format */
const isIsoDateValue = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v)

/** Cloud partner keyword (case-insensitive) */
const isPartnerValue = (v: string): boolean => {
  const lower = v.toLowerCase()
  return lower.includes('amazon') || lower.includes('aws') ||
    lower.includes('google') || lower.includes('microsoft') ||
    lower === 'other'
}

/** Salesforce ID pattern: 15-18 char alphanumeric */
const isSalesforceId = (v: string): boolean => /^[0-9A-Za-z]{15,18}$/.test(v)

/** Numeric value that could be ACV — allows $, commas, decimals. Prefers decimals. */
const isAcvValue = (v: string): boolean => {
  const cleaned = v.replace(/[$,\s]/g, '')
  if (!cleaned) return false
  // Must be entirely numeric (digits and optional decimal point only)
  if (!/^[\d.]+$/.test(cleaned)) return false
  const num = parseFloat(cleaned)
  return !isNaN(num) && num > 0
}

/** Check if value contains a decimal point (prefer for ACV over integers) */
const hasDecimal = (v: string): boolean => v.includes('.')

/**
 * Detect column positions by scanning data row values for recognizable patterns.
 * Returns a ColumnMapping if at least accountName + acvPlus are detected, null otherwise.
 *
 * Minimum confidence: a pattern must match >= 50% of non-empty values in a column
 * to be assigned to that column.
 */
export function detectColumnsByPattern(rows: unknown[][]): ColumnMapping | null {
  if (rows.length < 2) return null

  const dataRows = rows.slice(1)
  if (dataRows.length === 0) return null

  // Determine the max column count across all rows
  const maxCols = Math.max(...rows.map((r) => r.length))
  if (maxCols === 0) return null

  // Score each column for each pattern type
  const scores: Record<keyof ColumnMapping, { col: number; ratio: number }[]> = {
    accountName: [],
    quarter: [],
    closeDate: [],
    partner: [],
    acvPlus: [],
  }

  for (let col = 0; col < maxCols; col++) {
    let quarterHits = 0, dateHits = 0, partnerHits = 0, acvHits = 0, decimalHits = 0, sfIdHits = 0
    let nonEmpty = 0
    // Track strings that are NOT matched by other patterns — candidate account names
    let textOnlyHits = 0

    for (const row of dataRows) {
      const raw = String(row[col] ?? '').trim()
      if (!raw) continue
      nonEmpty++

      const matchedQuarter = isQuarterValue(raw)
      const matchedDate = isDateValue(raw) || isIsoDateValue(raw)
      const matchedPartner = isPartnerValue(raw)
      const matchedAcv = isAcvValue(raw)
      const matchedSfId = isSalesforceId(raw)

      if (matchedQuarter) quarterHits++
      if (matchedDate) dateHits++
      if (matchedPartner) partnerHits++
      if (matchedAcv) {
        acvHits++
        if (hasDecimal(raw)) decimalHits++
      }
      if (matchedSfId) sfIdHits++

      // Account name heuristic: non-empty string that doesn't match other patterns (including SF IDs)
      if (!matchedQuarter && !matchedDate && !matchedPartner && !matchedAcv && !matchedSfId) {
        textOnlyHits++
      }
    }

    if (nonEmpty === 0) continue
    const MIN_CONFIDENCE = 0.5

    if (quarterHits / nonEmpty >= MIN_CONFIDENCE) {
      scores.quarter.push({ col, ratio: quarterHits / nonEmpty })
    }
    if (dateHits / nonEmpty >= MIN_CONFIDENCE) {
      scores.closeDate.push({ col, ratio: dateHits / nonEmpty })
    }
    if (partnerHits / nonEmpty >= MIN_CONFIDENCE) {
      scores.partner.push({ col, ratio: partnerHits / nonEmpty })
    }
    if (acvHits / nonEmpty >= MIN_CONFIDENCE) {
      // Boost score for columns with decimal values (prefer ACV over Quantity)
      const decimalBoost = decimalHits > 0 ? 0.1 * (decimalHits / acvHits) : 0
      scores.acvPlus.push({ col, ratio: (acvHits / nonEmpty) + decimalBoost })
    }
    if (textOnlyHits / nonEmpty >= MIN_CONFIDENCE) {
      scores.accountName.push({ col, ratio: textOnlyHits / nonEmpty })
    }
  }

  // Assign columns: pick highest-ratio candidate for each type, avoiding conflicts
  const mapping: ColumnMapping = {}
  const used = new Set<number>()

  // Priority: quarter and date are most distinctive, then partner, then ACV, then account name
  const assignBest = (key: keyof ColumnMapping) => {
    const candidates = scores[key]
      .filter((c) => !used.has(c.col))
      .sort((a, b) => b.ratio - a.ratio)
    if (candidates.length > 0) {
      mapping[key] = candidates[0].col
      used.add(candidates[0].col)
    }
  }

  assignBest('quarter')
  assignBest('closeDate')
  assignBest('partner')
  assignBest('acvPlus')
  assignBest('accountName')

  // Require at least accountName + acvPlus to be useful
  if (mapping.accountName === undefined || mapping.acvPlus === undefined) return null

  return mapping
}

// ── parseCcspRows ────────────────────────────────────────────────────────────
// Pure function — no I/O. Takes raw sheet rows (header row + data rows), does
// flexible column detection, and returns CCSPRecord[].
//
// Column detection strategy (two-pass):
//   1. Try header-based detection (fast path — existing behavior)
//   2. If headers fail (missing accountName or ACV), fall back to pattern detection
//   3. Log mismatches between header and pattern results for debugging
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

  // ── Pass 1: header-based detection (fast path) ──────────────────────────
  const headers = (rows[0] ?? []).map((h: unknown) => String(h ?? '').trim())
  const headerAcctCol = headers.findIndex((h) => {
    const lower = h.toLowerCase()
    return lower === 'account name' || lower === 'account' || lower === 'customer name' || lower === 'company'
  })
  const headerQtrCol = headers.findIndex((h) => h.toLowerCase().includes('fiscal year quarter'))
  const headerCloseDateCol = headers.findIndex((h) => h.toLowerCase() === 'opportunity close date')
  const headerPartnerCol = headers.findIndex((h) => h.toLowerCase().includes('financial partner'))
  const headerAcvCol = headers.findIndex((h) => {
    const lower = h.toLowerCase()
    return lower === 'acv plus' || lower === 'acv+' || lower === 'acvplus'
  })

  const headerDetectionSucceeded = headerAcctCol >= 0 && headerAcvCol >= 0

  // ── Pass 2: pattern-based fallback ──────────────────────────────────────
  let acctCol = headerAcctCol
  let qtrCol = headerQtrCol
  let closeDateCol = headerCloseDateCol
  let partnerCol = headerPartnerCol
  let acvCol = headerAcvCol
  let usedPatternDetection = false

  if (!headerDetectionSucceeded) {
    const patternMapping = detectColumnsByPattern(rows)
    if (patternMapping && patternMapping.accountName !== undefined && patternMapping.acvPlus !== undefined) {
      acctCol = patternMapping.accountName ?? -1
      qtrCol = patternMapping.quarter ?? -1
      closeDateCol = patternMapping.closeDate ?? -1
      partnerCol = patternMapping.partner ?? -1
      acvCol = patternMapping.acvPlus ?? -1
      usedPatternDetection = true

      console.warn(`[ccsp] sheet ${spreadsheetId}: header detection failed — using pattern-based column detection. ` +
        `Headers: [${headers.join(', ')}]. ` +
        `Pattern mapping: acct=${acctCol}, qtr=${qtrCol}, date=${closeDateCol}, partner=${partnerCol}, acv=${acvCol}`)
    }
  }

  // Log header/pattern mismatches when both are available (for debugging)
  if (headerDetectionSucceeded && !usedPatternDetection) {
    const patternMapping = detectColumnsByPattern(rows)
    if (patternMapping) {
      const mismatches: string[] = []
      if (patternMapping.accountName !== undefined && patternMapping.accountName !== headerAcctCol)
        mismatches.push(`acct: header=${headerAcctCol} pattern=${patternMapping.accountName}`)
      if (patternMapping.acvPlus !== undefined && patternMapping.acvPlus !== headerAcvCol)
        mismatches.push(`acv: header=${headerAcvCol} pattern=${patternMapping.acvPlus}`)
      if (patternMapping.quarter !== undefined && patternMapping.quarter !== headerQtrCol)
        mismatches.push(`qtr: header=${headerQtrCol} pattern=${patternMapping.quarter}`)
      if (patternMapping.closeDate !== undefined && patternMapping.closeDate !== headerCloseDateCol)
        mismatches.push(`date: header=${headerCloseDateCol} pattern=${patternMapping.closeDate}`)
      if (patternMapping.partner !== undefined && patternMapping.partner !== headerPartnerCol)
        mismatches.push(`partner: header=${headerPartnerCol} pattern=${patternMapping.partner}`)
      if (mismatches.length > 0) {
        console.warn(`[ccsp] sheet ${spreadsheetId}: header/pattern column mismatch detected: ${mismatches.join('; ')}. Using pattern-based mapping to correct misalignment.`)
        // Override with pattern-detected columns when mismatch detected
        acctCol = patternMapping.accountName ?? acctCol
        qtrCol = patternMapping.quarter ?? qtrCol
        closeDateCol = patternMapping.closeDate ?? closeDateCol
        partnerCol = patternMapping.partner ?? partnerCol
        acvCol = patternMapping.acvPlus ?? acvCol
        usedPatternDetection = true
      }
    }
  }

  if (acctCol < 0) {
    console.warn(`[ccsp] sheet ${spreadsheetId}: no account name column found (tried: header detection + pattern detection). Headers: [${headers.join(', ')}]. This usually means the Tableau scraper downloaded the summary view instead of Raw Data.`)
  }
  if (acvCol < 0) {
    console.warn(`[ccsp] sheet ${spreadsheetId}: no ACV column found (tried: header detection + pattern detection). Headers: [${headers.join(', ')}]`)
  }
  if (acctCol < 0 || acvCol < 0) return []

  const records: CCSPRecord[] = []
  const dataRows = rows.slice(1)
  let skippedInvalidAcv = 0

  for (const row of dataRows) {
    const acvStr = String(row[acvCol] ?? '').replace(/[$,]/g, '').trim()
    const acv = parseFloat(acvStr)
    if (!acv || isNaN(acv)) {
      skippedInvalidAcv++
      continue
    }

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

  // Diagnostic logging when returning 0 records from non-empty input (issue #303)
  if (records.length === 0 && dataRows.length > 0) {
    console.warn(`[ccsp] sheet ${spreadsheetId}: parseCcspRows returned 0 records from ${dataRows.length} data rows. ` +
      `Headers: [${headers.slice(0, 10).join(', ')}${headers.length > 10 ? '...' : ''}]. ` +
      `First data row: [${dataRows[0]?.slice(0, 10).map(v => String(v ?? '').slice(0, 20)).join(', ')}${(dataRows[0]?.length ?? 0) > 10 ? '...' : ''}]. ` +
      `Skipped ${skippedInvalidAcv} rows due to invalid/missing ACV.`)
  }

  return records
}
