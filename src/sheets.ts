import { google } from 'googleapis'
import { resolve } from 'path'
import { makeAuth } from './google.ts'
import type { Customer, SheetRow, ProductSubscription } from './types.ts'

const CI_CONFIG         = resolve(import.meta.dir, '../../CustomerIntelligence/config')
const SHEETS_TOKEN_PATH = process.env.SHEETS_TOKEN ?? `${CI_CONFIG}/.sheets-token.json`
const GDRIVE_TOKEN_PATH = process.env.GDRIVE_TOKEN ?? `${CI_CONFIG}/.gdrive-server-credentials.json`

// In-process caches (5 min TTL each)
const aeFolderCache   = new Map<string, { id: string;    expires: number }>()
const aeSheetIdsCache = new Map<string, { ids: string[]; expires: number }>()

async function getSpreadsheetIds(drive: ReturnType<typeof google.drive>, folderId: string): Promise<string[]> {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and (mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false`,
    fields: 'files(id,mimeType,shortcutDetails)',
    pageSize: 50,
  })
  const ids: string[] = []
  for (const f of res.data.files ?? []) {
    if (f.mimeType === 'application/vnd.google-apps.spreadsheet') {
      ids.push(f.id!)
    } else if (f.mimeType === 'application/vnd.google-apps.shortcut') {
      const target = (f as any).shortcutDetails
      if (target?.targetMimeType === 'application/vnd.google-apps.spreadsheet') {
        ids.push(target.targetId)
      }
    }
  }
  return ids
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

function normalizeFlatFormat(rows: SheetRow[]): ProductSubscription[] {
  // One row per subscription (possibly per user). Columns vary slightly:
  // - 'Internal Sku' or 'Ordered Item' for the SKU code
  // - 'Quantity' or 'Qty' for count
  const headers = Object.keys(rows[0] ?? {})
  const statusKey = headers.find((h) => h.toLowerCase().startsWith('status')) ?? ''
  const skuKey    = headers.find((h) => h === 'Internal Sku') ?? headers.find((h) => h === 'Ordered Item') ?? ''
  const qtyKey    = headers.find((h) => h.toLowerCase() === 'quantity') ?? headers.find((h) => h.toLowerCase() === 'qty') ?? ''

  return rows
    .filter((r) => r['Product Description']?.trim())
    .map((r) => ({
      sku:                r[skuKey] ?? '',
      productDescription: r['Product Description'] ?? '',
      quantity:           parseInt(r[qtyKey] ?? '0') || 0,
      status:             (r[statusKey] ?? '').trim(),
      startDate:          r['Start Date'] ?? undefined,
      endDate:            r['End Date'] ?? undefined,
    }))
}

function normalizeRows(rows: SheetRow[]): ProductSubscription[] {
  if (!rows.length) return []
  const headers = Object.keys(rows[0])
  const raw = headers.includes('Subscription#')
    ? normalizeElmerFormat(rows)
    : normalizeFlatFormat(rows)

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
  const aeFirstName = (customer.ae ?? '').split(' ')[0]?.toLowerCase() ?? ''
  if (!aeFirstName) return { tab: '', headers: [], rows: [] }
  const parentId = process.env.AE_PARENT_FOLDER_ID
  if (!parentId) return { tab: '', headers: [], rows: [] }

  const driveAuth  = makeAuth(GDRIVE_TOKEN_PATH)
  const sheetsAuth = makeAuth(SHEETS_TOKEN_PATH)
  const drive  = google.drive({ version: 'v3', auth: driveAuth })
  const sheets = google.sheets({ version: 'v4', auth: sheetsAuth })

  const foldersRes = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)', pageSize: 50,
  })
  const aeFolder = (foldersRes.data.files ?? []).find((f) => f.name?.toLowerCase().includes(aeFirstName))
  if (!aeFolder?.id) return { tab: 'AE folder not found', headers: [], rows: [] }

  const spreadsheetIds = await getSpreadsheetIds(drive, aeFolder.id)
  const customerLower = customer.sheetTab?.toLowerCase() ?? customer.name.toLowerCase()

  const allMeta = await Promise.all(
    spreadsheetIds.map((id) =>
      sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties.title' })
        .then((res) => ({ id, titles: (res.data.sheets ?? []).map((s) => s.properties?.title ?? '') }))
        .catch(() => ({ id, titles: [] as string[] }))
    )
  )

  for (const { id: spreadsheetId, titles } of allMeta) {
    const matchedTab = titles.find((t) => t.toLowerCase().includes(customerLower))
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

export async function fetchCustomerSheetData(customer: Customer): Promise<ProductSubscription[]> {
  const aeFirstName = (customer.ae ?? '').split(' ')[0]?.toLowerCase() ?? ''
  if (!aeFirstName) return []

  const parentId = process.env.AE_PARENT_FOLDER_ID
  if (!parentId) return []

  // Create auth clients once per call
  const driveAuth  = makeAuth(GDRIVE_TOKEN_PATH)
  const sheetsAuth = makeAuth(SHEETS_TOKEN_PATH)
  const drive  = google.drive({ version: 'v3', auth: driveAuth })
  const sheets = google.sheets({ version: 'v4', auth: sheetsAuth })

  // Step 1: Find the AE folder in Drive (cached 5 min)
  const folderKey = `${parentId}:${aeFirstName}`
  const cachedFolder = aeFolderCache.get(folderKey)
  let aeFolderId: string

  if (cachedFolder && Date.now() < cachedFolder.expires) {
    aeFolderId = cachedFolder.id
  } else {
    const foldersRes = await drive.files.list({
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name)', pageSize: 50,
    })
    const aeFolder = (foldersRes.data.files ?? []).find((f) =>
      f.name?.toLowerCase().includes(aeFirstName)
    )
    if (!aeFolder?.id) return []
    aeFolderId = aeFolder.id
    aeFolderCache.set(folderKey, { id: aeFolderId, expires: Date.now() + 5 * 60_000 })
  }

  // Step 2: Get all spreadsheet IDs in AE folder, including shortcuts (cached 5 min)
  const cachedIds = aeSheetIdsCache.get(aeFolderId)
  let spreadsheetIds: string[]

  if (cachedIds && Date.now() < cachedIds.expires) {
    spreadsheetIds = cachedIds.ids
  } else {
    spreadsheetIds = await getSpreadsheetIds(drive, aeFolderId)
    aeSheetIdsCache.set(aeFolderId, { ids: spreadsheetIds, expires: Date.now() + 5 * 60_000 })
  }

  if (spreadsheetIds.length === 0) return []

  // Step 3: Fetch tab lists from all spreadsheets in parallel, find customer tab
  const customerLower = customer.sheetTab?.toLowerCase() ?? customer.name.toLowerCase()

  const allMeta = await Promise.all(
    spreadsheetIds.map((id) =>
      sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties.title' })
        .then((res) => ({ id, titles: (res.data.sheets ?? []).map((s) => s.properties?.title ?? '') }))
        .catch(() => ({ id, titles: [] as string[] }))
    )
  )

  for (const { id: spreadsheetId, titles } of allMeta) {
    const matchedTab = titles.find((t) => t.toLowerCase().includes(customerLower))
    if (!matchedTab) continue

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

    return normalizeRows(sheetRows)
  }

  return []
}
