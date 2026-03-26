import { google } from 'googleapis'
import { resolve } from 'path'
import { makeAuth } from './google.ts'
import type { Customer, SheetRow, ProductSubscription } from './types.ts'

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
// Bidirectional: tab⊆customer OR customer⊆tab (after normalization).
export function tabMatchesCustomer(tabName: string, customerName: string): boolean {
  const normTab  = normalizeForMatch(tabName)
  const normCust = normalizeForMatch(customerName)
  if (!normTab || !normCust) return false
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

    const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${matchedTab}'!A:Z` })
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
}

function normalizePartner(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower.includes('amazon') || lower.includes('aws')) return 'AWS'
  if (lower.includes('google')) return 'Google'
  if (lower.includes('microsoft')) return 'Microsoft'
  return 'Other'
}

export async function fetchCCSPData(): Promise<{ records: CCSPRecord[]; fileIds: string[] }> {
  const rootIds = getParentFolderIds()
  if (!rootIds.length) return { records: [], fileIds: [] }

  const driveAuth  = makeAuth(GDRIVE_TOKEN_PATH)
  const sheetsAuth = makeAuth(SHEETS_TOKEN_PATH)
  const drive  = google.drive({ version: 'v3', auth: driveAuth })
  const sheets = google.sheets({ version: 'v4', auth: sheetsAuth })

  const allRecords: CCSPRecord[] = []
  const ccspFileIds: string[] = []

  // Collect all spreadsheets under each root (recursive, cached)
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

  for (const { id: spreadsheetId, fileName, titles } of allMeta) {
    // Match if any tab is named "ccsp..." OR the spreadsheet file itself is named "ccsp..."
    const ccspTab = titles.find((t) => t.toLowerCase().includes('ccsp'))
      ?? (fileName.includes('ccsp') ? (titles[0] ?? null) : null)
    if (!ccspTab) continue
    ccspFileIds.push(spreadsheetId)

    const dataRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${ccspTab}'!A:Z`,
    }).catch(() => null)
    if (!dataRes) continue

    const rows = dataRes.data.values ?? []
    if (rows.length < 2) continue

    const headers = (rows[0] ?? []).map((h: unknown) => String(h ?? '').trim())
    const acctCol      = headers.findIndex((h) => h.toLowerCase() === 'account name')
    const qtrCol       = headers.findIndex((h) => h.toLowerCase().includes('fiscal year quarter'))
    const closeDateCol = headers.findIndex((h) => h.toLowerCase() === 'opportunity close date')
    const partnerCol   = headers.findIndex((h) => h.toLowerCase().includes('financial partner'))
    const acvCol       = headers.findIndex((h) => h.toLowerCase() === 'acv plus')

    if (acctCol < 0 || acvCol < 0) continue

    for (const row of rows.slice(1)) {
      const acvStr = String(row[acvCol] ?? '').replace(/[$,]/g, '').trim()
      const acv = parseFloat(acvStr)
      if (!acv || isNaN(acv)) continue

      allRecords.push({
        accountName:  String(row[acctCol] ?? '').trim(),
        quarter:      qtrCol >= 0 ? String(row[qtrCol] ?? '').trim() : '',
        closeDate:    closeDateCol >= 0 ? String(row[closeDateCol] ?? '').trim() : '',
        cloudPartner: partnerCol >= 0 ? normalizePartner(String(row[partnerCol] ?? '')) : 'Other',
        acvPlus:      acv,
      })
    }
  }

  return { records: allRecords, fileIds: ccspFileIds }
}

export async function fetchCustomerSheetData(customer: Customer): Promise<ProductSubscription[]> {
  const sheetsAuth = makeAuth(SHEETS_TOKEN_PATH)
  const sheets = google.sheets({ version: 'v4', auth: sheetsAuth })

  // Use the known Supportable file ID directly if stored — avoids scanning all files
  let spreadsheetIds: string[]
  if (customer.supportableFileId) {
    spreadsheetIds = [customer.supportableFileId]
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
      const dataRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${matchedTab}'!A:Z`,
      })
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
export async function fetchCustomerAccountNumbers(customer: Customer): Promise<string[]> {
  const sheetsAuth = makeAuth(SHEETS_TOKEN_PATH)
  const sheets = google.sheets({ version: 'v4', auth: sheetsAuth })

  let spreadsheetIds: string[]
  if (customer.supportableFileId) {
    spreadsheetIds = [customer.supportableFileId]
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

    const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${matchedTab}'!A:Z` }).catch(() => null)
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
