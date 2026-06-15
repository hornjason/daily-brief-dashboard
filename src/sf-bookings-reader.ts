/**
 * src/sf-bookings-reader.ts — BKL-SF-01
 *
 * Reads subscription data from a Salesforce bookings GSheet and maps it to
 * SupportableResult[] so the existing writeSubscriptionSheet() pipeline works
 * unchanged. Zero impact to scraper, sheets.ts, or dashboard.
 *
 * Column mapping (SF → Supportable CSV_HEADERS):
 *   PRODUCT_DESCRIPTION           → Product Description
 *   PRODUCT_QUANTITY              → Quantity
 *   OPPORTUNITY_LINE_START_DATE   → Start Date
 *   OPPORTUNITY_LINE_END_DATE     → End Date
 *   PRODUCT_FORECAST_OFFERING_GROUP → Ordered Item
 *   PRODUCT_CODE                  → Internal Sku
 *   OPPORTUNITY_TERRITORY_NAME    → AE territory filter (matches tableauTerritories in aes.json)
 *   ACCOUNT_NAME / ACCOUNT_SALES_GROUP_NAME / ACCOUNT_GLOBAL_SALES_GROUP_NAME → customer matching
 *   Status derived: endDate > today → "Active", else "Expired"
 *
 * Name matching: 2-tier lookup (ACCOUNT_NAME first as most specific entity):
 *   1. ACCOUNT_NAME (billing entity)
 *   2. ACCOUNT_SALES_GROUP_NAME (sales entity)
 *
 * Territory filtering: when AE tableauTerritories provided, only rows matching
 * those territory codes are considered — eliminates cross-AE false matches.
 *
 * Usage:
 *   const raw = await fetchSfBookingsRaw(sheetId)
 *   const results = mapSfBookingsToCustomers(raw, aeCustomers, false, ae.tableauTerritories)
 *   await writeSubscriptionSheet(results, aeName, driveFolderId, existingSheetId)
 */

import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { driveClient } from './lib/drive-client.ts'
import type { SupportableResult } from './supportable-scraper.ts'
import type { Customer } from './types.ts'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CACHE_DIR = process.env.CACHE_DIR ?? resolve(process.cwd(), 'data/cache')
const RAW_CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 hours — BKL-INGEST-01: aligned with 4-level cache hierarchy L1 TTL

// ── POD sheet discovery from shared Drive folder ──────────────────────────────

/**
 * List all Google Sheets in the shared POD bookings folder.
 * Returns { name, displayName, sheetId }[].
 * displayName strips boilerplate suffixes ("POD", "Subscriptions", "SF Bookings", year patterns)
 * so dropdowns show clean labels like "Northwest" instead of "Northwest POD - Subscriptions".
 */
export async function listPodBookingSheets(folderId: string): Promise<Array<{ name: string; displayName: string; sheetId: string; modifiedTime?: string }>> {
  // ADR-0016: drive-client supplies supportsAllDrives unconditionally.
  // Top-level first; if empty, descend one level into subfolders.
  let pairs = await driveClient.listSpreadsheetsUnder(folderId, { maxDepth: 0 })
  if (pairs.length === 0) {
    pairs = await driveClient.listSpreadsheetsUnder(folderId, { maxDepth: 1 })
  }

  return pairs.map((pair) => {
    const raw = pair.name
    const displayName = raw
      .replace(/\b(POD|SF Bookings|Bookings|Subscriptions|Subscription|Report|Export|Sheet|Data)\b/gi, '')
      .replace(/\b\d{4}\b/g, '')       // strip years
      .replace(/[-–—|:]+/g, ' ')       // strip separators
      .replace(/\s{2,}/g, ' ')
      .trim()
      || raw  // fallback to raw if everything was stripped
    return { name: raw, displayName, sheetId: pair.id, modifiedTime: (pair as any).modifiedTime as string | undefined }
  })
}

/**
 * Match a list of territory strings against discovered POD sheets.
 * Uses word-level matching so "WESTCOM NORTHWEST" matches "Northwest POD - Subscriptions".
 * Returns the sheetId of the first matching sheet, or null.
 */
export function matchPodSheet(
  sheets: Array<{ name: string; sheetId: string }>,
  territories: string[],
): string | null {
  for (const territory of territories) {
    // Split on non-alpha chars including underscore (territory codes use _ as separator)
    const words = territory.toLowerCase().split(/[\W_]+/).filter(w => w.length > 3)
    // Generate adjacent-pair compounds to handle fused sheet names like "NorthCentral"
    const segments = territory.replace(/_TERR\d+$/i, '').toLowerCase().split('_').filter(s => s.length > 2)
    const compounds = segments.slice(0, -1).map((_, i) => segments[i] + segments[i + 1])

    // Score each sheet by sum of matched word lengths — longer words are more distinctive
    // (e.g. "northwest"=9 beats "comm"=4+"corp"=4 for WEST_COMM_CORP_NORTHWEST_TERR01)
    let best: { sheetId: string; score: number } | null = null
    for (const s of sheets) {
      const sLower = s.name.toLowerCase()
      let score = 0
      for (const w of words) {
        if (new RegExp(`\\b${w}\\b`).test(sLower)) score += w.length
      }
      for (const c of compounds) {
        if (sLower.includes(c)) score += c.length
      }
      if (score > 0 && (!best || score > best.score)) best = { sheetId: s.sheetId, score }
    }
    if (best) return best.sheetId
  }
  return null
}

// ── Name normalizer + matcher ─────────────────────────────────────────────────

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    // Strip "/..." suffixes from names like "EBAY/PAYPAL" → "EBAY"
    .replace(/\/\S+/g, '')
    // Strip legal entity abbreviations (LLC, LLP, LL, LP, PLC)
    .replace(/\bl\.?l\.?c\.?\b|\bl\.?l\.?p\.?\b|\bll\b|\bl\.?p\.?\b|\bp\.?l\.?c\.?\b/g, '')
    // Strip common corporate noise words (bank/bancorporation for Zions/FirstBank)
    .replace(/\binc\.?\b|\bcorp\.?\b|\bcorporation\b|\bbancorporation\b|\bbank\b|\bltd\.?\b|\bco\.?\b|\bholding[s]?\b|\binternational\b|\bcompany\b|\bthe\b|\battn\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Normalize then strip all spaces — catches "first bank" vs "firstbank" compound differences */
function normNoSpace(s: string): string { return normalizeName(s).replace(/\s/g, '') }

function nameSimilarity(a: string, b: string): number {
  // Token size ≥ 3 to filter out noise like "ca", "na" state/region qualifiers
  const tokens = (s: string) => new Set(normalizeName(s).split(' ').filter(t => t.length >= 3))
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let overlap = 0
  for (const t of ta) if (tb.has(t)) overlap++
  return overlap / Math.max(ta.size, tb.size)
}

/** Find which customer in our list best matches a given sheet name. Returns null if no good match. */
function matchCustomer(sheetName: string, customers: Customer[]): Customer | null {
  const normSheet = normalizeName(sheetName)
  const normSheetNS = normNoSpace(sheetName)

  // 1. Exact normalized match on name or any alias (with or without spaces)
  for (const c of customers) {
    const allNames = [c.name, ...(c.aliases ?? [])]
    for (const n of allNames) {
      if (normalizeName(n) === normSheet) return c
      if (normNoSpace(n) === normSheetNS && normSheetNS.length >= 4) return c
    }
  }

  // 2. Fuzzy match on name or any alias — threshold 0.6
  let best: { customer: Customer; score: number } | null = null
  for (const c of customers) {
    const allNames = [c.name, ...(c.aliases ?? [])]
    for (const n of allNames) {
      const score = nameSimilarity(n, sheetName)
      if (score >= 0.6 && (!best || score > best.score)) {
        best = { customer: c, score }
      }
    }
  }
  return best?.customer ?? null
}

/** Convert an all-caps SF name to readable title case, stripping legal noise.
 *  "SHUTTERFLY, LLC" → "Shutterfly"  |  "FRED HUTCHINSON CANCER CENTER" → "Fred Hutchinson Cancer Center"
 */
function sanitizeName(s: string): string {
  const cleaned = normalizeName(s)  // strips suffixes, lowercases, normalizes spaces
  return cleaned.replace(/\b\w/g, c => c.toUpperCase())
}

// ── Main exports ──────────────────────────────────────────────────────────────

export interface SfBookingsRawData {
  headers: string[]
  dataRows: string[][]
}

export interface SfBookingsReadResult {
  results: SupportableResult[]
  /** Customer names that had at least one non-CCSP row matched */
  matched: string[]
  /** Customer names with no rows found in the sheet */
  unmatched: string[]
  /** Customer names that appear in the SF sheet but ONLY with CCSP opportunities */
  ccspOnly: string[]
  /** Sheet names that couldn't be mapped to any customer */
  unmappedSheetNames: string[]
}

export interface SfBookingsDerivedResult {
  results: SupportableResult[]
  /** Customers with at least one non-CCSP subscription row */
  matched: string[]
  /** Net-new customers discovered in the sheet — not in existingCustomers — upsert into customers.json */
  newCustomers: Customer[]
  /** Existing sf-bookings customers missing their SF canonical name as alias — upsert aliases */
  aliasedCustomers: Customer[]
  /** Customer names with ONLY CCSP rows in this territory */
  ccspOnly: string[]
}

/**
 * Fetch raw rows from the SF bookings GSheet — cached locally for 1 hour to avoid quota burns.
 * Force-refresh by passing forceRefresh=true.
 */
export async function fetchSfBookingsRaw(sheetId: string, forceRefresh = false): Promise<SfBookingsRawData> {
  const cacheFile = resolve(CACHE_DIR, `sf-bookings-raw-${sheetId}.json`)

  // Return cached data if fresh
  if (!forceRefresh && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf-8'))
      if (Date.now() - cached.fetchedAt < RAW_CACHE_TTL_MS) {
        console.log(`[sf-bookings] using cached sheet data (${Math.round((Date.now() - cached.fetchedAt) / 60_000)}m old)`)
        return { headers: cached.headers, dataRows: cached.dataRows }
      }
    } catch { /* ignore corrupt cache, re-fetch */ }
  }

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const sheets = google.sheets({ version: 'v4', auth })
  console.log(`[sf-bookings] fetching sheet ${sheetId}…`)
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'A:AE' })
  const rows = res.data.values ?? []
  if (rows.length < 2) throw new Error('SF bookings sheet appears empty')

  const data: SfBookingsRawData = {
    headers: (rows[0] as string[]).map(h => h.trim()),
    dataRows: rows.slice(1) as string[][],
  }

  // Write to cache
  try {
    writeFileSync(cacheFile, JSON.stringify({ ...data, fetchedAt: Date.now() }))
  } catch { /* non-fatal */ }

  return data
}

/**
 * Map pre-fetched SF bookings rows to SupportableResult[] for a specific customer list.
 * Call fetchSfBookingsRaw() once, then call this per AE.
 *
 * @param raw        - pre-fetched sheet data from fetchSfBookingsRaw()
 * @param customers  - AE's customer list to match against
 * @param activeOnly - filter to rows where End Date > today (default: false — expired rows included with Status="Expired")
 * @param territories - AE's tableauTerritories codes; when provided, only matching territory rows are included
 */
export function mapSfBookingsToCustomers(
  raw: SfBookingsRawData,
  customers: Customer[],
  activeOnly = false,
  territories?: string[],
): SfBookingsReadResult {
  const { headers, dataRows } = raw

  // Column index helpers
  const col = (name: string) => headers.indexOf(name)
  const globalIdx    = col('ACCOUNT_GLOBAL_SALES_GROUP_NAME')
  const salesIdx     = col('ACCOUNT_SALES_GROUP_NAME')
  const acctIdx      = col('ACCOUNT_NAME')
  const prodDescIdx  = col('PRODUCT_DESCRIPTION')
  const qtyIdx       = col('PRODUCT_QUANTITY')
  const startIdx     = col('OPPORTUNITY_LINE_START_DATE')
  const endIdx       = col('OPPORTUNITY_LINE_END_DATE')
  const skuIdx       = col('PRODUCT_CODE')
  const offeringIdx  = col('PRODUCT_FORECAST_OFFERING_GROUP')
  const oppNameIdx   = col('OPPORTUNITY_NAME_H')
  const territoryIdx = col('OPPORTUNITY_TERRITORY_NAME')

  const territorySet = territories?.length ? new Set(territories) : null

  const today = new Date()

  // ── Group rows by customer ─────────────────────────────────────────────────
  // Map: customer.name → rows[]
  const customerRowMap = new Map<string, Record<string, string>[]>()
  // Track customers who appear in the SF sheet but only via CCSP opps
  const customerCcspHits = new Map<string, number>()   // total CCSP rows matched
  const unmappedSheetNames = new Set<string>()

  for (const row of dataRows) {
    const globalName = (row[globalIdx] ?? '').trim()
    const salesName  = (row[salesIdx] ?? '').trim()
    const acctName   = (row[acctIdx] ?? '').trim()
    const endDateStr = (row[endIdx] ?? '').trim()
    const prodDesc   = (row[prodDescIdx] ?? '').trim()

    // Skip rows without a product description
    if (!prodDesc) continue

    // Territory filter — when AE territories are specified, skip rows for other territories
    if (territorySet && territoryIdx >= 0) {
      const rowTerritory = (row[territoryIdx] ?? '').trim()
      if (rowTerritory && !territorySet.has(rowTerritory)) continue
    }

    // Skip ALL CCSP opportunities — captured by ccsp-scraper regardless of expiry.
    // Track which customers appear ONLY via CCSP rows so we can label them.
    const oppName = (row[oppNameIdx] ?? '').trim()
    if (oppName.toLowerCase().includes('ccsp')) {
      // Still run the name match to track this customer had a CCSP presence
      let ccspMatchedCustomer: Customer | null = null
      for (const name of [acctName, salesName]) {
        if (!name) continue
        ccspMatchedCustomer = matchCustomer(name, customers)
        if (ccspMatchedCustomer) break
      }
      if (ccspMatchedCustomer) {
        customerCcspHits.set(ccspMatchedCustomer.name, (customerCcspHits.get(ccspMatchedCustomer.name) ?? 0) + 1)
      }
      continue
    }

    // Determine active/expired status from end date
    const isExpired = endDateStr ? new Date(endDateStr) <= today : false
    if (activeOnly && isExpired) continue

    // Try to match customer using 2-tier lookup.
    // Order: ACCOUNT_NAME first (most specific billing entity), then sales group.
    // This ensures Lifetouch Inc. rows go to "Lifetouch" rather than "Shutterfly" even though
    // both share the same ACCOUNT_SALES_GROUP_NAME = "SHUTTERFLY, LLC".
    let matched: Customer | null = null
    for (const name of [acctName, salesName]) {
      if (!name) continue
      matched = matchCustomer(name, customers)
      if (matched) break
    }

    if (!matched) {
      // Log unmapped at global level only (avoid noise from subsidiary variants)
      if (globalName) unmappedSheetNames.add(globalName)
      continue
    }

    // Build Supportable-format row (matches CSV_HEADERS exactly)
    const supportableRow: Record<string, string> = {
      'Name':                globalName || salesName || acctName,
      'Customer Number':     '',
      'Account Number':      '',
      'Country':             '',
      'First Name':          '',
      'Last Name':           '',
      'Login':               '',
      'Email':               '',
      'Phone Num':           '',
      'Internal Sku':        (row[skuIdx] ?? '').trim(),
      'Ordered Item':        (row[offeringIdx] ?? '').trim(),
      'Product Description': prodDesc,
      'Quantity':            (row[qtyIdx] ?? '').trim(),
      'Status':              isExpired ? 'Expired' : 'Active',
      'Start Date':          (row[startIdx] ?? '').trim(),
      'End Date':            endDateStr,
      'Contract#':           '',
      'Cust PO Number':      '',
      'End Customer PO':     '',
    }

    if (!customerRowMap.has(matched.name)) {
      customerRowMap.set(matched.name, [])
    }
    customerRowMap.get(matched.name)!.push(supportableRow)
  }

  // ── Build SupportableResult[] ──────────────────────────────────────────────
  const results: SupportableResult[] = []
  const matched: string[] = []
  const unmatched: string[] = []
  const ccspOnly: string[] = []

  for (const customer of customers) {
    const rows = customerRowMap.get(customer.name)
    if (rows && rows.length > 0) {
      results.push({ customerName: customer.name, accountNumbers: customer.accountNumbers ?? [], rows })
      matched.push(customer.name)
      console.log(`[sf-bookings] ${customer.name}: ${rows.length} rows`)
    } else {
      results.push({ customerName: customer.name, accountNumbers: customer.accountNumbers ?? [], rows: [] })
      // Distinguish: appeared in sheet ONLY as CCSP vs genuinely absent
      if (customerCcspHits.has(customer.name)) {
        ccspOnly.push(customer.name)
        console.log(`[sf-bookings] ${customer.name}: CCSP only (${customerCcspHits.get(customer.name)} CCSP rows)`)
      } else {
        unmatched.push(customer.name)
        console.log(`[sf-bookings] ${customer.name}: no rows found in sheet`)
      }
    }
  }

  console.log(`[sf-bookings] matched ${matched.length}/${customers.length} customers (${ccspOnly.length} CCSP-only, ${unmatched.length} not found)`)

  return {
    results,
    matched,
    unmatched,
    ccspOnly,
    unmappedSheetNames: [...unmappedSheetNames].sort(),
  }
}

/**
 * Territory-first derivation — SF sheet IS the source of truth for customer names.
 *
 * Instead of matching a pre-existing customer list against the sheet, this filters
 * the sheet by territory and derives the customer list from what's actually there.
 * Existing customers are used only to preserve known names and accountNumbers.
 *
 * @param raw              - pre-fetched sheet data
 * @param territories      - AE territory codes to filter rows by
 * @param existingCustomers - existing customers.json entries for this AE (name/accountNumber preservation)
 * @param aeName           - AE name to assign to net-new customers
 * @param activeOnly       - if true, only include active subscriptions
 */
export function deriveSfCustomersByTerritory(
  raw: SfBookingsRawData,
  territories: string[],
  existingCustomers: Customer[],
  aeName: string,
  activeOnly = false,
): SfBookingsDerivedResult {
  const { headers, dataRows } = raw as SfBookingsRawData

  const col = (name: string) => headers.indexOf(name)
  const globalIdx    = col('ACCOUNT_GLOBAL_SALES_GROUP_NAME')
  const salesIdx     = col('ACCOUNT_SALES_GROUP_NAME')
  const acctIdx      = col('ACCOUNT_NAME')
  const prodDescIdx  = col('PRODUCT_DESCRIPTION')
  const qtyIdx       = col('PRODUCT_QUANTITY')
  const startIdx     = col('OPPORTUNITY_LINE_START_DATE')
  const endIdx       = col('OPPORTUNITY_LINE_END_DATE')
  const skuIdx       = col('PRODUCT_CODE')
  const offeringIdx  = col('PRODUCT_FORECAST_OFFERING_GROUP')
  const oppNameIdx   = col('OPPORTUNITY_NAME_H')
  const territoryIdx = col('OPPORTUNITY_TERRITORY_NAME')

  const territorySet = new Set(territories)
  const today = new Date()

  // Map: normalizedGroupKey → { resolvedCustomer, rows[], ccspRowCount }
  // sfCanonicalName = global > sales > acct (for grouping/deduplication)
  // sfSearchName    = acct > sales (most specific real name for RH Portal search)
  const groups = new Map<string, { customer: Customer | null; sfCanonicalName: string; sfSearchName: string; rows: Record<string, string>[]; ccspRows: number }>()

  for (const row of dataRows) {
    const globalName = (row[globalIdx] ?? '').trim()
    const salesName  = (row[salesIdx] ?? '').trim()
    const acctName   = (row[acctIdx] ?? '').trim()
    const prodDesc   = (row[prodDescIdx] ?? '').trim()
    const endDateStr = (row[endIdx] ?? '').trim()

    if (!prodDesc) continue

    // Territory filter
    if (territoryIdx >= 0) {
      const rowTerritory = (row[territoryIdx] ?? '').trim()
      if (!rowTerritory || !territorySet.has(rowTerritory)) continue
    }

    // Canonical grouping name: account > sales (ACCOUNT_NAME is what AEs see and matches portal)
    const canonicalName = acctName || salesName
    if (!canonicalName) continue
    const groupKey = normalizeName(canonicalName)
    if (!groupKey) continue

    // Initialise group if first time seeing this customer
    if (!groups.has(groupKey)) {
      // Try to match an existing customer so we preserve their name + accountNumbers
      const existingMatch = matchCustomer(canonicalName, existingCustomers)
      const sfSearchName = acctName || salesName
      groups.set(groupKey, { customer: existingMatch, sfCanonicalName: canonicalName, sfSearchName, rows: [], ccspRows: 0 })
    }

    const group = groups.get(groupKey)!

    // CCSP rows — count but don't add to subscription rows
    const oppName = (row[oppNameIdx] ?? '').trim()
    if (oppName.toLowerCase().includes('ccsp')) {
      group.ccspRows++
      continue
    }

    const isExpired = endDateStr ? new Date(endDateStr) <= today : false
    if (activeOnly && isExpired) continue

    group.rows.push({
      'Name':                canonicalName,
      'Customer Number':     '',
      'Account Number':      '',
      'Country':             '',
      'First Name':          '',
      'Last Name':           '',
      'Login':               '',
      'Email':               '',
      'Phone Num':           '',
      'Internal Sku':        (row[skuIdx] ?? '').trim(),
      'Ordered Item':        (row[offeringIdx] ?? '').trim(),
      'Product Description': prodDesc,
      'Quantity':            (row[qtyIdx] ?? '').trim(),
      'Status':              isExpired ? 'Expired' : 'Active',
      'Start Date':          (row[startIdx] ?? '').trim(),
      'End Date':            endDateStr,
      'Contract#':           '',
      'Cust PO Number':      '',
      'End Customer PO':     '',
    })
  }

  // ── Build results ─────────────────────────────────────────────────────────
  const results: SupportableResult[] = []
  const matched: string[] = []
  const ccspOnly: string[] = []
  const newCustomers: Customer[] = []
  const aliasedCustomers: Customer[] = []

  for (const [, group] of groups) {
    // Determine display name: existing customer name takes priority; fall back to sanitized SF name
    const displayName = group.customer?.name ?? sanitizeName(group.sfCanonicalName)
    const accountNumbers = group.customer?.accountNumbers ?? []

    if (group.rows.length > 0) {
      results.push({ customerName: displayName, accountNumbers, rows: group.rows })
      matched.push(displayName)
      console.log(`[sf-bookings] ${displayName}: ${group.rows.length} rows`)
    } else if (group.ccspRows > 0) {
      // CCSP-only — include with empty rows so customer still appears in dashboard
      results.push({ customerName: displayName, accountNumbers, rows: [] })
      ccspOnly.push(displayName)
      console.log(`[sf-bookings] ${displayName}: CCSP only (${group.ccspRows} CCSP rows)`)
    }
    // else: group had rows but all were filtered (activeOnly) — skip entirely

    if (!group.customer) {
      // Net-new: upsert into customers.json — sfSearchName (acct > sales > global) as alias for RH discovery
      newCustomers.push({ name: displayName, ae: aeName, importedFrom: 'sf-bookings', aliases: [group.sfSearchName] })
    } else if (group.customer.importedFrom === 'sf-bookings') {
      // Existing sf-bookings customer — replace alias[0] with sfSearchName for RH scraper
      const existingAliases = group.customer.aliases ?? []
      if (existingAliases[0] !== group.sfSearchName) {
        group.customer.aliases = [group.sfSearchName, ...existingAliases.filter(a => a !== group.sfSearchName)]
        aliasedCustomers.push(group.customer)
      }
    }
  }

  console.log(`[sf-bookings] ${aeName}: ${matched.length} customers with subs, ${ccspOnly.length} CCSP-only, ${newCustomers.length} new, ${aliasedCustomers.length} alias-updated`)
  return { results, matched, newCustomers, aliasedCustomers, ccspOnly }
}

/**
 * Convenience wrapper: fetch + map in one call (single-AE use).
 * For syncing all AEs, use fetchSfBookingsRaw() + mapSfBookingsToCustomers() directly.
 */
export async function readSfBookingsSheet(
  sheetId: string,
  customers: Customer[],
  activeOnly = false,
  territories?: string[],
): Promise<SfBookingsReadResult> {
  const raw = await fetchSfBookingsRaw(sheetId)
  return mapSfBookingsToCustomers(raw, customers, activeOnly, territories)
}

// ── Master sheet detection (Issue #816) ─────────────────────────────────────

export interface MasterSheetInfo {
  name: string
  displayName: string
  sheetId: string
  modifiedTime?: string
}

export function detectMasterSheets(
  sheets: Array<{ name: string; displayName: string; sheetId: string; modifiedTime?: string }>,
): MasterSheetInfo[] {
  const masters = sheets.filter(s => /^master\b/i.test(s.name))
  if (masters.length > 1) {
    console.warn(`[master-ingest] WARNING: ${masters.length} master sheets found: ${masters.map(m => m.name).join(', ')}`)
  }
  return masters.sort((a, b) => {
    if (!a.modifiedTime && !b.modifiedTime) return 0
    if (!a.modifiedTime) return 1
    if (!b.modifiedTime) return -1
    return b.modifiedTime.localeCompare(a.modifiedTime)
  })
}

export function formatMasterIngestSummary(stats: {
  totalTerritories: number
  totalRows: number
  overwritten: string[]
  created: string[]
  skipped: string[]
}): string {
  return `[master-ingest] Processed ${stats.totalTerritories} territories, ${stats.totalRows} rows. Overwritten: ${stats.overwritten.join(', ') || 'none'}. Created: ${stats.created.join(', ') || 'none'}. Skipped: ${stats.skipped.join(', ') || 'none'}.`
}
