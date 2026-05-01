// ── BKL-BACKUP-01: Config Backup Sheet ──────────────────────────────────────
// Auto-backs up aes.json, customers.json, and data-sources.json to a Google Sheet.
// Fire-and-forget by design — never blocks a save, never throws to callers.

import { google } from 'googleapis'
import { readFileSync } from 'fs'
import { writeJsonAtomic, writeFileAtomic } from './lib/atomic-write.ts'
import { resolve } from 'path'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'

const CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const AES_PATH = resolve(CONFIG_DIR, 'aes.json')
const CUSTOMERS_PATH = resolve(CONFIG_DIR, 'customers.json')
const DATA_SOURCES_PATH = resolve(CONFIG_DIR, 'data-sources.json')

const TAB_NAMES = ['AE Registry', 'Customers', 'Data Sources', 'Restore Log'] as const

let _lastBackupAt: string | null = null
let _backupDebounceTimer: ReturnType<typeof setTimeout> | null = null
const BACKUP_DEBOUNCE_MS = 10_000 // Coalesce rapid saves into one backup every 10s

// ── Public API ──────────────────────────────────────────────────────────────

/** Read backupSheetId from data-sources.json. Returns null if not set. */
export function getBackupSheetId(): string | null {
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    return ds.backupSheetId ?? null
  } catch {
    return null
  }
}

/** Write backupSheetId into data-sources.json. */
export function setBackupSheetId(id: string): void {
  try {
    let ds: Record<string, unknown> = {}
    try { ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8')) } catch {}
    ds.backupSheetId = id
    writeJsonAtomic(DATA_SOURCES_PATH, ds)
  } catch (e: any) {
    console.warn('[backup] failed to persist backupSheetId:', e.message)
  }
}

/** Return the last backup timestamp (in-memory). */
export function getLastBackupTimestamp(): string | null {
  return _lastBackupAt
}

/**
 * Find an existing "PAI Config Backup" sheet in the folder, or create one.
 * Prevents duplicate backup sheets accumulating across config wipes.
 */
export async function createBackupSheet(parentFolderId: string): Promise<string> {
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  // Search for existing backup sheet before creating a new one
  const existing = await drive.files.list({
    q: `name = 'appBackup' and '${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
    fields: 'files(id,name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 1,
  }).catch(() => null)

  if (existing?.data.files?.length) {
    const existingId = existing.data.files[0].id!
    console.log(`[backup] Reusing existing Config Backup sheet: ${existingId}`)
    return existingId
  }

  const created = await drive.files.create({
    requestBody: {
      name: 'appBackup',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [parentFolderId],
    },
    supportsAllDrives: true,
    fields: 'id',
  })

  const spreadsheetId = created.data.id!
  const sheets = google.sheets({ version: 'v4', auth })

  // Rename the default "Sheet1" to the first tab name, then add the remaining tabs
  const meta = await sheets.spreadsheets.get({ spreadsheetId })
  const defaultSheetId = meta.data.sheets?.[0]?.properties?.sheetId ?? 0

  const requests: any[] = [
    { updateSheetProperties: { properties: { sheetId: defaultSheetId, title: TAB_NAMES[0] }, fields: 'title' } },
  ]
  for (let i = 1; i < TAB_NAMES.length; i++) {
    requests.push({ addSheet: { properties: { title: TAB_NAMES[i] } } })
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } })

  console.log(`[backup] Config Backup sheet created: ${spreadsheetId}`)
  return spreadsheetId
}

/**
 * Debounced backup — coalesces rapid saves into one Sheets API call.
 * Fire-and-forget: call this from save hooks; it returns immediately.
 */
export function backupNow(): Promise<{ ok: boolean; timestamp: string }> {
  return new Promise((resolve) => {
    if (_backupDebounceTimer) clearTimeout(_backupDebounceTimer)
    _backupDebounceTimer = setTimeout(() => {
      _backupDebounceTimer = null
      _backupNowImmediate().then(resolve).catch(() => resolve({ ok: false, timestamp: '' }))
    }, BACKUP_DEBOUNCE_MS)
  })
}

/**
 * Immediate backup — called by the debounce timer and by the manual API endpoint.
 * Backs up aes.json, customers.json, and data-sources.json to the backup sheet.
 */
export async function _backupNowImmediate(): Promise<{ ok: boolean; timestamp: string }> {
  const sheetId = getBackupSheetId()
  if (!sheetId) {
    console.warn('[backup] no backupSheetId configured — skipping backup')
    return { ok: false, timestamp: '' }
  }

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const sheets = google.sheets({ version: 'v4', auth })
  const timestamp = new Date().toISOString()

  const files: { tab: string; path: string }[] = [
    { tab: 'AE Registry', path: AES_PATH },
    { tab: 'Customers', path: CUSTOMERS_PATH },
    { tab: 'Data Sources', path: DATA_SOURCES_PATH },
  ]

  for (const { tab, path } of files) {
    try {
      const raw = readFileSync(path, 'utf-8')
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `'${tab}'!A1:B2`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [
            ['Last Updated', timestamp],
            ['Data', raw],
          ],
        },
      })
    } catch (e: any) {
      console.warn(`[backup] failed to backup ${tab}:`, e.message)
    }
  }

  // Log the restore event
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'Restore Log'!A1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['backup', timestamp, 'auto']],
      },
    })
  } catch { /* non-critical */ }

  _lastBackupAt = timestamp
  console.log(`[backup] Config backed up at ${timestamp}`)
  return { ok: true, timestamp }
}

/**
 * Restore aes.json, customers.json, and data-sources.json from the backup sheet.
 * Returns which sections were restored.
 */
export async function restoreFromBackup(): Promise<{ ok: boolean; sections: string[]; errors: string[] }> {
  const sheetId = getBackupSheetId()
  if (!sheetId) return { ok: false, sections: [], errors: ['No backup sheet configured'] }

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const sheets = google.sheets({ version: 'v4', auth })

  const files: { tab: string; path: string }[] = [
    { tab: 'AE Registry', path: AES_PATH },
    { tab: 'Customers', path: CUSTOMERS_PATH },
    { tab: 'Data Sources', path: DATA_SOURCES_PATH },
  ]

  const sections: string[] = []
  const errors: string[] = []
  const timestamp = new Date().toISOString()

  for (const { tab, path } of files) {
    try {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tab}'!A1:B2`,
      })
      const rows = resp.data.values ?? []
      if (rows.length < 2 || !rows[1]?.[1]) {
        errors.push(`${tab}: no data in backup`)
        continue
      }
      const jsonBlob = rows[1][1]
      // Validate it's parseable JSON before writing
      JSON.parse(jsonBlob)
      writeFileAtomic(path, jsonBlob)
      sections.push(tab)
    } catch (e: any) {
      errors.push(`${tab}: ${e.message}`)
    }
  }

  // Log the restore event
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'Restore Log'!A1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['restore', timestamp, sections.join(', ')]],
      },
    })
  } catch { /* non-critical */ }

  console.log(`[backup] Restored sections: ${sections.join(', ')}`)
  return { ok: sections.length > 0, sections, errors }
}
