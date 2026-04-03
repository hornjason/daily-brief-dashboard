// ── Sheet import helpers & routes (M04 — extracted from server.ts) ──────────
import { Hono } from 'hono'
import { readFileSync, writeFileSync as writeFileSyncRaw, renameSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth } from './google.ts'
import { customers, CUSTOMERS_PATH } from './server-state.ts'
import { sanitizeErr } from './utils.ts'

// ── Path constants (module-scoped) ──────────────────────────────────────────
const SRV_CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const SHEETS_TOKEN_PATH_SRV = process.env.SHEETS_TOKEN
  ?? resolve(SRV_CONFIG_DIR, '.sheets-token.json')
const GDRIVE_TOKEN_PATH_SRV = process.env.GDRIVE_TOKEN
  ?? resolve(SRV_CONFIG_DIR, '.gdrive-server-credentials.json')
const SHEETS_SYNC_PATH = process.env.CONFIG_DIR
  ? resolve(process.env.CONFIG_DIR, 'sheets-sync.json')
  : resolve(import.meta.dir, '../config/sheets-sync.json')

// ── Shared helpers ──────────────────────────────────────────────────────────

// Shared helper: read rows from a sheet and build the customers array
async function importSheetRows(
  fileId: string,
  fileName: string,
  columnMap: Record<string, number | string | null>,
): Promise<{ customers: ReturnType<typeof buildCustomer>[]; syncedAt: string }> {
  const auth = makeAuth(SHEETS_TOKEN_PATH_SRV)
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: fileId, range: 'A2:Z5000' })
  const rows = res.data.values ?? []
  const customers = rows
    .filter((row: any[]) => row.some((cell: string) => cell?.trim()))
    .map((row: string[]) => buildCustomer(row, columnMap))
    .filter((r) => r.name)
  const tmpPath = CUSTOMERS_PATH + '.tmp'
  writeFileSyncRaw(tmpPath, JSON.stringify({ customers }, null, 2))
  renameSync(tmpPath, CUSTOMERS_PATH)
  const syncedAt = new Date().toISOString()
  writeFileSyncRaw(SHEETS_SYNC_PATH, JSON.stringify({ fileId, fileName, columnMap, syncedAt }, null, 2))
  return { customers, syncedAt }
}

function buildCustomer(row: string[], columnMap: Record<string, number | string | null>) {
  const get = (field: string) => {
    const val = columnMap[field]
    if (val == null) return ''
    if (typeof val === 'string') return val.trim()
    return (row[val] ?? '').trim()
  }
  const accountNumbersRaw = get('accountNumbers')
  return {
    name: get('name'),
    domain: get('domain'),
    ae: get('ae'),
    segment: get('segment'),
    region: get('region'),
    accountNumbers: accountNumbersRaw
      ? accountNumbersRaw.split(/[,;]+/).map((s: string) => s.trim()).filter(Boolean)
      : [],
  }
}

export { importSheetRows, buildCustomer }

// ── Route registration ──────────────────────────────────────────────────────

export function registerSheetImportRoutes(app: Hono): void {
  // GET /api/sheets/status — Check if a sheet is connected
  app.get('/api/sheets/status', (c) => {
    try {
      const sync = JSON.parse(readFileSync(SHEETS_SYNC_PATH, 'utf-8'))
      return c.json({ connected: true, fileId: sync.fileId, fileName: sync.fileName, syncedAt: sync.syncedAt })
    } catch {
      return c.json({ connected: false })
    }
  })

  // GET /api/sheets/list — List available Google Sheets from Drive
  app.get('/api/sheets/list', async (c) => {
    try {
      const auth = makeAuth(GDRIVE_TOKEN_PATH_SRV)
      const drive = google.drive({ version: 'v3', auth })
      const res = await drive.files.list({
        q: "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
        fields: 'files(id,name,webViewLink,modifiedTime)',
        orderBy: 'modifiedTime desc',
        pageSize: 20,
      })
      return c.json({ files: res.data.files ?? [] })
    } catch (e: any) {
      return c.json({ files: [], error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/sheets/headers — Read header row from a specific sheet
  app.get('/api/sheets/headers', async (c) => {
    const fileId = c.req.query('fileId')
    if (!fileId) return c.json({ error: 'fileId required' }, 400)
    if (!/^[a-zA-Z0-9_-]{10,60}$/.test(fileId)) return c.json({ error: 'Invalid file ID' }, 400)
    try {
      const auth = makeAuth(SHEETS_TOKEN_PATH_SRV)
      const sheets = google.sheets({ version: 'v4', auth })
      const [meta, res] = await Promise.all([
        sheets.spreadsheets.get({ spreadsheetId: fileId, fields: 'properties.title' }),
        sheets.spreadsheets.values.get({ spreadsheetId: fileId, range: 'A1:Z1' }),
      ])
      const headers = (res.data.values?.[0] ?? []) as string[]
      return c.json({ headers, fileName: meta.data.properties?.title ?? '' })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // POST /api/sheets/import — Import customers from a Google Sheet
  app.post('/api/sheets/import', async (c) => {
    const body = await c.req.json() as { fileId: string; fileName: string; columnMap: Record<string, number | string | null> }
    const { fileId, fileName, columnMap } = body
    if (!fileId || !columnMap) return c.json({ error: 'fileId and columnMap required' }, 400)
    if (!/^[a-zA-Z0-9_-]{10,60}$/.test(fileId)) return c.json({ error: 'Invalid file ID' }, 400)
    const safeFileName = typeof fileName === 'string' ? fileName.slice(0, 200).replace(/[<>]/g, '') : ''
    try {
      const { customers: imported, syncedAt } = await importSheetRows(fileId, safeFileName, columnMap)
      customers.splice(0, customers.length, ...imported)
      return c.json({ imported: imported.length, syncedAt })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // POST /api/sheets/sync — Re-sync from the previously connected sheet
  app.post('/api/sheets/sync', async (c) => {
    let syncConfig: { fileId: string; fileName: string; columnMap: Record<string, number | string | null> }
    try {
      syncConfig = JSON.parse(readFileSync(SHEETS_SYNC_PATH, 'utf-8'))
    } catch {
      return c.json({ error: 'No sheet connected. Use /api/sheets/import first.' }, 400)
    }
    try {
      const { customers: synced, syncedAt } = await importSheetRows(syncConfig.fileId, syncConfig.fileName, syncConfig.columnMap)
      customers.splice(0, customers.length, ...synced)
      return c.json({ synced: synced.length, syncedAt })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })
}
