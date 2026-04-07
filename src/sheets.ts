import { google } from 'googleapis'
import { resolve } from 'path'
import { makeAuth, withQuotaRetry } from './google.ts'
import type { Customer, SheetRow, ProductSubscription } from './types.ts'
import { aes, patchAe } from './server-state.ts'

const CONFIG_DIR_PATH   = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const SHEETS_TOKEN_PATH = process.env.SHEETS_TOKEN ?? resolve(CONFIG_DIR_PATH, '.sheets-token.json')
const GDRIVE_TOKEN_PATH = process.env.GDRIVE_TOKEN ?? resolve(CONFIG_DIR_PATH, '.gdrive-server-credentials.json')

// In-process cache: rootId → spreadsheet IDs (5 min TTL)
const rootSpreadsheetsCache = new Map<string, { ids: string[]; expires: number }>()

function getParentFolderIds(): string[] {
  const raw = process.env.AE_PARENT_FOLDER_IDS ?? process.env.AE_PARENT_FOLDER_ID ?? ''
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

// Find all spreadsheets under a root folder at any depth using BFS folder traversal.
// Uses 'in parents' (direct children) at each level — proven reliable vs 'in ancestors'
// which can silently return empty on some Drive configurations.
async function getSpreadsheetIdsUnderRoot(
  drive: ReturnType<typeof google.drive>,
  rootId: string,
): Promise<string[]> {
  const cached = rootSpreadsheetsCache.get(rootId)
  if (cached && Date.now() < cached.expires) return cached.ids

  const ids: string[] = []
  const folderQueue: string[] = [rootId]
  const visited = new Set<string>([rootId])

  while (folderQueue.length > 0) {
    const folderId = folderQueue.shift()!

    // Spreadsheets directly in this folder
    const sheetsRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
      fields: 'files(id)', pageSize: 100,
    }).catch(() => ({ data: { files: [] as { id?: string }[] } }))
    for (const f of (sheetsRes.data.files ?? [])) {
      if (f.id) ids.push(f.id)
    }

    // Shortcuts pointing to spreadsheets
    const shortcutRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.shortcut' and trashed = false`,
      fields: 'files(id,shortcutDetails)', pageSize: 100,
    }).catch(() => ({ data: { files: [] as any[] } }))
    for (const f of (shortcutRes.data.files ?? [])) {
      const targetMime = f.shortcutDetails?.targetMimeType ?? ''
      const targetId   = f.shortcutDetails?.targetId ?? ''
      if (targetMime === 'application/vnd.google-apps.spreadsheet' && targetId) ids.push(targetId)
    }

    // Subfolders to visit next
    const foldersRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)', pageSize: 100,
    }).catch(() => ({ data: { files: [] as { id?: string }[] } }))
    for (const f of (foldersRes.data.files ?? [])) {
      if (f.id && !visited.has(f.id)) {
        visited.add(f.id)
        folderQueue.push(f.id)
      }
    }
  }

  rootSpreadsheetsCache.set(rootId, { ids, expires: Date.now() + 5 * 60_000 })
  return ids
}

// ── Tab-to-customer matching ───────────────────────────────────────────────────

// Strip legal entity suffixes and punctuation so "A10 Networks, Inc." matches "A10 NETWORKS"
export function normalizeForMatch(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|corp|ltd|co|corporation|incorporated|limited|company|lp|llp|plc|gmbh|bv|sa|ag)\b\.?/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// True if tabName and customerName refer to the same entity.
// Bidirectional substring for names > 4 chars; word-boundary for short names to prevent
// "EBS" from matching "Webster" or similar mid-word substring collisions.
export function tabMatchesCustomer(tabName: string, customerName: string): boolean {
  const normTab  = normalizeForMatch(tabName)
  const normCust = normalizeForMatch(customerName)
  if (!normTab || !normCust) return false
  if (normTab === normCust) return true
  // Short names (≤ 4 chars): require whole-word match inside the other string
  if (normCust.length <= 4 || normTab.length <= 4) {
    const shorter = normCust.length <= normTab.length ? normCust : normTab
    const longer  = normCust.length <= normTab.length ? normTab  : normCust
    return new RegExp(`(^|\\s)${shorter}(\\s|$)`).test(longer)
  }
  return normTab.includes(normCust) || normCust.includes(normTab)
}

// True if tabName matches the customer's canonical name, sheetTab override, or any alias.
export function tabMatchesAny(tabName: string, customer: Customer): boolean {
  const names = [customer.sheetTab ?? customer.name, ...(customer.aliases ?? [])]
  return names.some(n => tabMatchesCustomer(tabName, n))
}

// ── Normalizers ───────────────────────────────────────────────────────────────

function normalizeElmerFormat(rows: SheetRow[]): ProductSubscription[] {
  // Two-row pattern: parent row (SKU starts with '--') has Status/dates, no Qty.
  // Child row has real SKU and Qty. Both share the same Subscription#.
  const headers = Object.keys(rows[0] ?? {})
  const statusKey = headers.find((h) => h.toLowerCase().startsWith('status')) ?? ''

  const groups: Record<string, { parent: SheetRow | null; child: SheetRow | null }> = {}
  for (const row of rows) {
    const sub = row['Subscription#']
    if (!sub) continue
    if (!groups[sub]) groups[sub] = { parent: null, child: null }
    if ((row['SKU'] ?? '').startsWith('--')) groups[sub].parent = row
    else groups[sub].child = row
  }

  return Object.values(groups)
    .filter(({ parent }) => parent != null)
    .map(({ parent, child }) => ({
      sku:                parent!['SKU'].replace(/^--/, '') || (child?.['SKU'] ?? ''),
      productDescription: parent!['Product Description'] ?? '',
      quantity:           parseInt(child?.['Qty'] ?? '0') || 0,
      status:             (parent![statusKey] ?? '').trim(),
      startDate:          parent!['Start Date'] ?? undefined,
      endDate:            parent!['End Date'] ?? undefined,
    }))
    .filter((p) => p.productDescription)
}

function normalizeFlatFormat(rows: SheetRow[], customerName?: string): ProductSubscription[] {
  // One row per subscription (possibly per user). Columns vary slightly:
  // - 'Internal Sku' or 'Ordered Item' for the SKU code
  // - 'Quantity' or 'Qty' for count
  const headers = Object.keys(rows[0] ?? {})
  const statusKey = headers.find((h) => h.toLowerCase().startsWith('status')) ?? ''
  const skuKey    = headers.find((h) => h === 'Internal Sku') ?? headers.find((h) => h === 'Ordered Item') ?? ''
  const qtyKey    = headers.find((h) => h.toLowerCase() === 'quantity') ?? headers.find((h) => h.toLowerCase() === 'qty') ?? ''

  // If a 'Name' column exists and the tab contains multiple customers (e.g. mislabeled tab),
  // filter to only rows belonging to the customer we're looking for.
  // Check if any column that looks like a customer/account name identifier exists
  const nameColKey = headers.find((h) => h === 'Name') ?? headers.find((h) => h === '')
  // Strip punctuation before splitting so "A10 NETWORKS, INC." → ["networks"] not ["networks,"]
  const custLower = (customerName?.toLowerCase() ?? '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  const custWords = custLower.split(' ').filter((w) => w.length > 3) // meaningful words only
  const uniqueNameVals = nameColKey !== undefined
    ? new Set(rows.map((r) => (r[nameColKey] ?? '').toLowerCase().trim()).filter(Boolean))
    : new Set<string>()
  // Only filter by Name when the tab has multiple distinct customer names (multi-customer tab).
  // If uniqueNameVals.size === 1 the tab is already single-customer (tab match already scoped it).
  const shouldFilterByName = nameColKey !== undefined && uniqueNameVals.size > 1 && custWords.length > 0

  function rowMatchesCustomer(rowName: string): boolean {
    const rn = rowName.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    // Any meaningful word from the customer name appears in the row name, or vice versa
    return custWords.some((w) => rn.includes(w))
  }

  return rows
    .filter((r) => {
      if (!r['Product Description']?.trim()) return false
      if (shouldFilterByName) {
        const rowName = (r[nameColKey!] ?? '').toLowerCase().trim()
        return rowMatchesCustomer(rowName)
      }
      return true
    })
    .map((r) => ({
      sku:                r[skuKey] ?? '',
      productDescription: r['Product Description'] ?? '',
      quantity:           parseInt(r[qtyKey] ?? '0') || 0,
      status:             (r[statusKey] ?? '').trim(),
      startDate:          r['Start Date'] ?? undefined,
      endDate:            r['End Date'] ?? undefined,
    }))
}

export function normalizeRows(rows: SheetRow[], customerName?: string): ProductSubscription[] {
  if (!rows.length) return []
  const headers = Object.keys(rows[0])
  const raw = headers.includes('Subscription#')
    ? normalizeElmerFormat(rows)
    : normalizeFlatFormat(rows, customerName)

  // Filter to ACTIVE only, then aggregate quantities per SKU
  const skuMap = new Map<string, ProductSubscription>()
  for (const p of raw) {
    if (p.status.toUpperCase() !== 'ACTIVE') continue
    const existing = skuMap.get(p.sku)
    if (existing) existing.quantity += p.quantity
    else skuMap.set(p.sku, { ...p })
  }
  return Array.from(skuMap.values())
}

// ── Batch fetch (BKL-AE-03) ──────────────────────────────────────────────────

/**
 * Fetch subscription data for multiple customers from a single spreadsheet
 * using one batchGet call instead of N individual gets.
 * Returns a map of customerName → ProductSubscription[].
 */
export async function batchFetchSubscriptions(
  spreadsheetId: string,
  customers: Customer[],
  knownSupportableSheetIds?: string[],
): Promise<Map<string, ProductSubscription[]>> {
  const result = new Map<string, ProductSubscription[]>()
  if (!customers.length) return result

  const sheetsAuth = makeAuth(SHEETS_TOKEN_PATH)
  const sheets = google.sheets({ version: 'v4', auth: sheetsAuth })

  // Step 1: Get all tab names from this spreadsheet (same as fetchCustomerSheetData)
  let titles: string[]
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties.title',
    })
    titles = (meta.data.sheets ?? []).map((s) => s.properties?.title ?? '')
  } catch {
    // If we can't read the spreadsheet metadata, return empty for all customers
    for (const c of customers) result.set(c.name, [])
    return result
  }

  // Step 2: Match each customer to their tab using the same logic as fetchCustomerSheetData
  // Track which customers matched which tabs for the batchGet response mapping
  const rangeToCustomers: { range: string; customer: Customer; tabName: string }[] = []

  for (const customer of customers) {
    // Per-customer override file ID takes precedence — skip batch for these
    if (customer.supportableFileId) continue

    const matchedTabs = titles.filter((t) => tabMatchesAny(t, customer))
    if (!matchedTabs.length) {
      result.set(customer.name, [])
      continue
    }

    // Use the first matching tab (same as fetchCustomerSheetData which iterates and returns first with data)
    for (const tab of matchedTabs) {
      rangeToCustomers.push({
        range: `'${tab}'!A:Z`,
        customer,
        tabName: tab,
      })
    }
  }

  // Step 3: If no ranges matched, return what we have (empty arrays)
  if (!rangeToCustomers.length) return result

  // Step 4: Single batchGet call for all matched ranges
  const ranges = rangeToCustomers.map((r) => r.range)
  let valueRanges: any[]
  try {
    const batchRes = await withQuotaRetry(
      () => sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges }),
      `batch-subscriptions-read ${spreadsheetId}`,
    )
    valueRanges = batchRes.data.valueRanges ?? []
  } catch (e: any) {
    console.warn(`[sheets] batchGet failed for ${spreadsheetId}: ${e.message}`)
    for (const c of customers) if (!result.has(c.name)) result.set(c.name, [])
    return result
  }

  // Step 5: Map each valueRange back to its customer and parse rows
  // Track which customers already have data (first matching tab with data wins)
  const customerHasData = new Set<string>()

  for (let i = 0; i < valueRanges.length && i < rangeToCustomers.length; i++) {
    const { customer } = rangeToCustomers[i]
    if (customerHasData.has(customer.name)) continue

    const rows = valueRanges[i]?.values ?? []
    if (rows.length < 2) continue

    // Same row-parsing logic as fetchCustomerSheetData
    const headers = (rows[0] ?? []).map(String)
    const sheetRows: SheetRow[] = rows.slice(1)
      .map((row: any[]) => {
        const obj: SheetRow = {}
        headers.forEach((h: string, idx: number) => { obj[h] = String(row[idx] ?? '') })
        return obj
      })
      .filter((row: SheetRow) => Object.values(row).some((v: string) => v.trim()))

    const normalized = normalizeRows(sheetRows, customer.name)
    if (normalized.length > 0) {
      result.set(customer.name, normalized)
      customerHasData.add(customer.name)
    }
  }

  // Customers with no data get empty array
  for (const c of customers) {
    if (!result.has(c.name)) result.set(c.name, [])
  }

  return result
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function fetchCustomerSheetRaw(customer: Customer): Promise<{ tab: string; headers: string[]; rows: SheetRow[] }> {
  const sheetsAuth = makeAuth(SHEETS_TOKEN_PATH)
  const sheets = google.sheets({ version: 'v4', auth: sheetsAuth })

  let spreadsheetIds: string[]
  if (customer.supportableFileId) {
    spreadsheetIds = [customer.supportableFileId]
  } else {
    const rootIds = getParentFolderIds()
    if (!rootIds.length) return { tab: '', headers: [], rows: [] }
    const driveAuth = makeAuth(GDRIVE_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth: driveAuth })
    spreadsheetIds = []
    for (const rootId of rootIds) {
      spreadsheetIds.push(...await getSpreadsheetIdsUnderRoot(drive, rootId))
    }
  }
  const allMeta = await Promise.all(
    spreadsheetIds.map((id) =>
      sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties.title' })
        .then((res) => ({ id, titles: (res.data.sheets ?? []).map((s) => s.properties?.title ?? '') }))
        .catch(() => ({ id, titles: [] as string[] }))
    )
  )

  for (const { id: spreadsheetId, titles } of allMeta) {
    const matchedTab = titles.find((t) => tabMatchesAny(t, customer))
    if (!matchedTab) continue

    const dataRes = await withQuotaRetry(
      () => sheets.spreadsheets.values.get({ spreadsheetId, range: `'${matchedTab}'!A:Z` }),
      `sheet-raw-read ${customer.name}`,
    )
    const rows = dataRes.data.values ?? []
    if (rows.length < 2) continue

    const headers = (rows[0] ?? []).map(String)
    const sheetRows: SheetRow[] = rows.slice(1)
      .map((row) => {
        const obj: SheetRow = {}
        headers.forEach((h, i) => { obj[h] = String(row[i] ?? '') })
        return obj
      })
      .filter((row) => Object.values(row).some((v) => v.trim()))

    return { tab: matchedTab, headers, rows: sheetRows }
  }

  return { tab: 'No matching tab found', headers: [], rows: [] }
}

// ── CCSP Cloud Spend ──────────────────────────────────────────────────────────

export interface CCSPRecord {
  accountName: string
  quarter: string       // e.g. "2025-Q1"
  closeDate: string
  cloudPartner: string  // normalized: "AWS" | "Google" | "Microsoft" | "Other"
  acvPlus: number
  ae?: string           // AE name — set when fetched via { sheetId, aeName } pairs
  productOfferingGroup?: string  // column S (index 18) — e.g. "RHEL"; optional, absent in older sheet formats
}

function normalizePartner(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower.includes('amazon') || lower.includes('aws')) return 'AWS'
  if (lower.includes('google')) return 'Google'
  if (lower.includes('microsoft')) return 'Microsoft'
  return 'Other'
}

export async function fetchCCSPData(
  knownSheetIds?: string[] | { sheetId: string; aeName: string }[],
): Promise<{ records: CCSPRecord[]; fileIds: string[] }> {
  const sheetsAuth = makeAuth(SHEETS_TOKEN_PATH)
  const sheets = google.sheets({ version: 'v4', auth: sheetsAuth })

  const allRecords: CCSPRecord[] = []
  const ccspFileIds: string[] = []

  // Detect whether caller passed AE-tagged pairs or plain string IDs
  const aeMap = new Map<string, string>() // sheetId → aeName
  let resolvedIds: string[] | undefined
  if (knownSheetIds?.length) {
    if (typeof knownSheetIds[0] === 'string') {
      resolvedIds = knownSheetIds as string[]
    } else {
      const pairs = knownSheetIds as { sheetId: string; aeName: string }[]
      resolvedIds = pairs.map(p => p.sheetId)
      for (const p of pairs) aeMap.set(p.sheetId, p.aeName)
    }
  }

  // Fast path: use known sheet IDs directly (avoids expensive Drive BFS traversal
  // which silently returns empty when Sheets API quota is hit).
  let spreadsheetIdTabPairs: { spreadsheetId: string; ccspTab: string }[]

  if (resolvedIds?.length) {
    spreadsheetIdTabPairs = resolvedIds.map(id => ({ spreadsheetId: id, ccspTab: 'CCSP Data' }))
  } else {
    // Fallback: BFS scan of parent folder (expensive, quota-sensitive)
    const rootIds = getParentFolderIds()
    if (!rootIds.length) return { records: [], fileIds: [] }

    const driveAuth = makeAuth(GDRIVE_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth: driveAuth })

    const spreadsheetIds: string[] = []
    for (const rootId of rootIds) {
      spreadsheetIds.push(...await getSpreadsheetIdsUnderRoot(drive, rootId))
    }

    const allMeta = await Promise.all(
      spreadsheetIds.map((id) =>
        sheets.spreadsheets.get({ spreadsheetId: id, fields: 'properties.title,sheets.properties.title' })
          .then((res) => ({
            id,
            fileName: (res.data.properties?.title ?? '').toLowerCase(),
            titles: (res.data.sheets ?? []).map((s) => s.properties?.title ?? ''),
          }))
          .catch(() => ({ id, fileName: '', titles: [] as string[] }))
      )
    )

    spreadsheetIdTabPairs = []
    for (const { id, fileName, titles } of allMeta) {
      const ccspTab = titles.find((t) => t.toLowerCase().includes('ccsp'))
        ?? (fileName.includes('ccsp') ? (titles[0] ?? null) : null)
      if (ccspTab) spreadsheetIdTabPairs.push({ spreadsheetId: id, ccspTab })
    }
  }

  for (const { spreadsheetId, ccspTab } of spreadsheetIdTabPairs) {
    ccspFileIds.push(spreadsheetId)

    const dataRes = await withQuotaRetry(
      () => sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${ccspTab}'!A:AM`,  // A:AM = 39 cols — covers 32-col Tableau CSV with room to spare
      }),
      `ccsp-read ${spreadsheetId}`,
    ).catch((e: any) => { console.warn(`[ccsp-read] sheet ${spreadsheetId} tab '${ccspTab}' read failed: ${e?.message} — will attempt tab discovery`); return null })

    let rows = dataRes?.data.values ?? []
    // Trigger tab discovery when: (a) fast-path tab returned <2 rows, or (b) fast-path tab threw an error (tab doesn't exist)
    if ((rows.length < 2 || !dataRes) && resolvedIds?.length) {
      console.warn(`[ccsp-read] fast-path sheet ${spreadsheetId} tab '${ccspTab}' returned <2 rows — attempting tab discovery`)
      try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' })
        const allTabs = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')
        console.log(`[ccsp-read] sheet ${spreadsheetId} tabs found: [${allTabs.join(', ')}]`)
        // First: try any tab with 'ccsp' in name (but different from fast-path tab that already failed)
        const ccspNamedTab = allTabs.find(t => t.toLowerCase().includes('ccsp') && t !== ccspTab)
        // Fallback: try all remaining tabs (header validation will reject wrong-format tabs)
        const tabsToTry = ccspNamedTab ? [ccspNamedTab] : allTabs.filter(t => t !== ccspTab)
        for (const tab of tabsToTry) {
          const safeTab = tab.replace(/'/g, "''")
          const retryRes = await withQuotaRetry(
            () => sheets.spreadsheets.values.get({ spreadsheetId, range: `'${safeTab}'!A:AM` }),
            `ccsp-read retry ${spreadsheetId}`,
          ).catch(() => null)
          const retryRows = retryRes?.data.values ?? []
          if (retryRows.length >= 2) {
            console.log(`[ccsp-read] tab discovery succeeded with '${tab}'`)
            rows = retryRows
            break
          }
        }
      } catch (e: any) { console.warn(`[ccsp-read] tab discovery error for ${spreadsheetId}: ${e?.message}`) }
    }

    // Drive-folder fallback: known sheet was empty AND tab discovery within it also failed.
    // Look up the AE's driveFolderId and search it for an alternative CCSP spreadsheet.
    if (rows.length < 2 && resolvedIds?.length) {
      const aeName = aeMap.get(spreadsheetId)
      const aeEntry = aeName
        ? aes.find(a => a.name === aeName)
        : aes.find(a => a.ccspSheetId === spreadsheetId)
      const driveFolderId = aeEntry?.driveFolderId
      if (driveFolderId) {
        console.warn(`[ccsp-read] known sheet empty — searching AE Drive folder ${driveFolderId} for alternative CCSP sheet`)
        try {
          const driveAuth = makeAuth(GDRIVE_TOKEN_PATH)
          const drive = google.drive({ version: 'v3', auth: driveAuth })
          const candidateIds = await getSpreadsheetIdsUnderRoot(drive, driveFolderId)

          // Filter: only spreadsheets with "ccsp" in the filename
          const candidateMeta = await Promise.all(
            candidateIds.map(id =>
              sheets.spreadsheets.get({ spreadsheetId: id, fields: 'properties.title,sheets.properties.title' })
                .then(res => ({
                  id,
                  fileName: (res.data.properties?.title ?? '').toLowerCase(),
                  tabs: (res.data.sheets ?? []).map(s => s.properties?.title ?? ''),
                }))
                .catch(() => ({ id, fileName: '', tabs: [] as string[] }))
            )
          )

          let altSheetId: string | null = null
          let altTab: string | null = null
          let altRows: unknown[][] = []

          for (const { id, fileName, tabs } of candidateMeta) {
            if (id === spreadsheetId) continue  // skip the sheet we already know is empty
            if (!fileName.includes('ccsp')) continue
            const ccspTabName = tabs.find(t => t.toLowerCase().includes('ccsp'))
            if (!ccspTabName) continue

            const safeTab = ccspTabName.replace(/'/g, "''")
            const altRes = await withQuotaRetry(
              () => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `'${safeTab}'!A:AM` }),
              `ccsp-read alt ${id}`,
            ).catch(() => null)
            const candidateRows = altRes?.data.values ?? []
            if (candidateRows.length >= 2) {
              altSheetId = id
              altTab = ccspTabName
              altRows = candidateRows
              break
            }
          }

          const SHEET_ID_RE = /^[a-zA-Z0-9_-]{20,60}$/
          if (altSheetId && altTab && altRows.length >= 2 && SHEET_ID_RE.test(altSheetId)) {
            console.log(`[ccsp-read] found alternative CCSP sheet ${altSheetId} in AE folder — using instead`)
            rows = altRows
            // Persist so next run uses the correct sheet directly
            const nameForPatch = aeName ?? aeEntry?.name
            if (nameForPatch) patchAe(nameForPatch, { ccspSheetId: altSheetId })
          } else {
            console.warn(`[ccsp-read] no alternative CCSP sheet found in AE folder — skipping`)
          }
        } catch (e: any) {
          console.warn(`[ccsp-read] Drive folder search failed for ${driveFolderId}: ${e?.message}`)
        }
      }
    }

    if (rows.length < 2) {
      console.warn(`[ccsp-read] sheet ${spreadsheetId}: all tabs returned <2 rows — skipping`)
      continue
    }

    const headers = (rows[0] ?? []).map((h: unknown) => String(h ?? '').trim())
    // Flexible column detection — Tableau CSV headers vary between Raw Data and summary views.
    // Raw Data: "Account Name", summary: may be "Account" or missing entirely.
    const acctCol      = headers.findIndex((h) => {
      const lower = h.toLowerCase()
      return lower === 'account name' || lower === 'account' || lower === 'customer name' || lower === 'company'
    })
    const qtrCol       = headers.findIndex((h) => h.toLowerCase().includes('fiscal year quarter'))
    const closeDateCol = headers.findIndex((h) => h.toLowerCase() === 'opportunity close date')
    const partnerCol   = headers.findIndex((h) => h.toLowerCase().includes('financial partner'))
    const acvCol       = headers.findIndex((h) => {
      const lower = h.toLowerCase()
      return lower === 'acv plus' || lower === 'acv+' || lower === 'acvplus'
    })

    if (acctCol < 0) {
      console.warn(`[ccsp] sheet ${spreadsheetId}: no account name column found (tried: account name, account, customer name, company). Headers: [${headers.join(', ')}]. This usually means the Tableau scraper downloaded the summary view instead of Raw Data.`)
    }
    if (acvCol < 0) {
      console.warn(`[ccsp] sheet ${spreadsheetId}: no ACV column found (tried: acv plus, acv+, acvplus). Headers: [${headers.join(', ')}]`)
    }
    if (acctCol < 0 || acvCol < 0) continue

    for (const row of rows.slice(1)) {
      const acvStr = String(row[acvCol] ?? '').replace(/[$,]/g, '').trim()
      const acv = parseFloat(acvStr)
      if (!acv || isNaN(acv)) continue

      const productOfferingGroupRaw = String(row[18] ?? '').trim()
      allRecords.push({
        accountName:  String(row[acctCol] ?? '').trim(),
        quarter:      qtrCol >= 0 ? String(row[qtrCol] ?? '').trim() : '',
        closeDate:    closeDateCol >= 0 ? String(row[closeDateCol] ?? '').trim() : '',
        cloudPartner: partnerCol >= 0 ? normalizePartner(String(row[partnerCol] ?? '')) : 'Other',
        acvPlus:      acv,
        ...(aeMap.has(spreadsheetId) ? { ae: aeMap.get(spreadsheetId)! } : {}),
        ...(productOfferingGroupRaw ? { productOfferingGroup: productOfferingGroupRaw } : {}),
      })
    }
  }

  return { records: allRecords, fileIds: ccspFileIds }
}

export async function fetchCustomerSheetData(customer: Customer, knownSheetIds?: string[]): Promise<ProductSubscription[]> {
  const sheetsAuth = makeAuth(SHEETS_TOKEN_PATH)
  const sheets = google.sheets({ version: 'v4', auth: sheetsAuth })

  // Priority: per-customer override > AE-level known IDs > Drive BFS
  let spreadsheetIds: string[]
  if (customer.supportableFileId) {
    // Most specific: per-customer pinned file ID (overrides everything)
    spreadsheetIds = [customer.supportableFileId]
  } else if (knownSheetIds?.length) {
    // AE-level fast path: use known sheet IDs directly (avoids BFS + all-sheet quota burn)
    spreadsheetIds = knownSheetIds
  } else {
    const rootIds = getParentFolderIds()
    if (!rootIds.length) return []
    const driveAuth = makeAuth(GDRIVE_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth: driveAuth })
    spreadsheetIds = []
    for (const rootId of rootIds) {
      spreadsheetIds.push(...await getSpreadsheetIdsUnderRoot(drive, rootId))
    }
  }
  if (spreadsheetIds.length === 0) return []

  // Fetch tab lists from all spreadsheets in parallel, find customer tab
  const allMeta = await Promise.all(
    spreadsheetIds.map((id) =>
      sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties.title' })
        .then((res) => ({ id, titles: (res.data.sheets ?? []).map((s) => s.properties?.title ?? '') }))
        .catch(() => ({ id, titles: [] as string[] }))
    )
  )

  for (const { id: spreadsheetId, titles } of allMeta) {
    // All tabs whose name matches the customer's name or any alias
    const matchedTabs = titles.filter((t) => tabMatchesAny(t, customer))
    if (!matchedTabs.length) continue

    for (const matchedTab of matchedTabs) {
      // Step 4: Read and normalize the tab data
      const dataRes = await withQuotaRetry(
        () => sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `'${matchedTab}'!A:Z`,
        }),
        `subscriptions-read ${customer.name}`,
      )
      const rows = dataRes.data.values ?? []
      if (rows.length < 2) continue

      const headers = (rows[0] ?? []).map(String)
      const sheetRows: SheetRow[] = rows.slice(1)
        .map((row) => {
          const obj: SheetRow = {}
          headers.forEach((h, i) => { obj[h] = String(row[i] ?? '') })
          return obj
        })
        .filter((row) => Object.values(row).some((v) => v.trim()))

      const normalized = normalizeRows(sheetRows, customer.name)
      // Only return if we actually got data — otherwise keep looking in other matching tabs
      if (normalized.length > 0) return normalized
    }
  }

  return []
}

// ── Account number discovery ───────────────────────────────────────────────────

// Reads the customer's subscription tab and returns unique account numbers found
// in any column whose header contains "accountnumber" (case-insensitive, spaces/dashes ignored).
export async function fetchCustomerAccountNumbers(customer: Customer, knownSheetIds?: string[]): Promise<string[]> {
  const sheetsAuth = makeAuth(SHEETS_TOKEN_PATH)
  const sheets = google.sheets({ version: 'v4', auth: sheetsAuth })

  // Same priority as fetchCustomerSheetData: per-customer override > AE-level fast path > BFS
  let spreadsheetIds: string[]
  if (customer.supportableFileId) {
    spreadsheetIds = [customer.supportableFileId]
  } else if (knownSheetIds?.length) {
    spreadsheetIds = knownSheetIds
  } else {
    const rootIds = getParentFolderIds()
    if (!rootIds.length) return []
    const driveAuth = makeAuth(GDRIVE_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth: driveAuth })
    spreadsheetIds = []
    for (const rootId of rootIds) {
      spreadsheetIds.push(...await getSpreadsheetIdsUnderRoot(drive, rootId))
    }
  }

  const allMeta = await Promise.all(
    spreadsheetIds.map((id) =>
      sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties.title' })
        .then((res) => ({ id, titles: (res.data.sheets ?? []).map((s) => s.properties?.title ?? '') }))
        .catch(() => ({ id, titles: [] as string[] }))
    )
  )

  for (const { id: spreadsheetId, titles } of allMeta) {
    const matchedTab = titles.find((t) => tabMatchesAny(t, customer))
    if (!matchedTab) continue

    const dataRes = await withQuotaRetry(
      () => sheets.spreadsheets.values.get({ spreadsheetId, range: `'${matchedTab}'!A:Z` }),
      `account-numbers-read ${customer.name}`,
    ).catch(() => null)
    const rows = dataRes?.data.values ?? []
    if (rows.length < 2) continue

    const headers = (rows[0] ?? []).map((h) => String(h ?? '').toLowerCase().replace(/[\s_-]/g, ''))
    const acctIdx = headers.findIndex((h) => h === 'accountnumber' || h === 'accountno' || h === 'account#')
    if (acctIdx < 0) continue

    const nums = new Set<string>()
    for (const row of rows.slice(1)) {
      const val = String(row[acctIdx] ?? '').trim()
      if (val && val !== '0') nums.add(val)
    }
    if (nums.size > 0) return Array.from(nums)
  }

  return []
}
