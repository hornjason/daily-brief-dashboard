// ── BKL-DRIVE-BACKUP-API-01: Drive Config/settings.json sync helpers ────────
//
// Centralizes the duplicated logic for finding the Drive Config/ folder under
// a parentFolderId, reading/writing Config/settings.json there, and applying
// fetched settings to the local file. Previously inlined in 4 places:
//   - settings-api.ts (GET /api/settings/from-drive)
//   - setup-routes.ts (runStartupDriveMerge)
//   - scrape-api.ts (POST /api/sf-bookings/pod-folder Drive sync block)
//   - ae-routes.ts (POST validate-folder Config/ + settings.json write)
//
// Public surface:
//   - resolveConfigFolderId(parentFolderId)  → cached scaffold lookup → Drive list fallback
//   - writeSettingsToDrive(parentFolderId)   → upsert Config/settings.json from local file
//   - readSettingsFromDrive(parentFolderId)  → fetch Config/settings.json contents
//   - applySettingsToLocal(parsed)           → atomic write to local SETTINGS_PATH
//
// Errors are thrown so callers can decide how to surface them.
//
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { isValidDriveFolderId } from './utils.ts'
import { readScaffoldCache, writeScaffoldCache } from './bootstrap-orchestrator.ts'

/** Local path to settings.json — mirrors the SETTINGS_PATH pattern used by callers. */
export const SETTINGS_PATH = resolve(
  process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config'),
  'settings.json',
)

/**
 * Resolve the Drive Config/ folder ID under `parentFolderId`.
 *
 * Strategy:
 *   1. Check `readScaffoldCache()[parentFolderId].configFolderId` — if it
 *      passes `isValidDriveFolderId`, return immediately (zero Drive calls).
 *   2. Fall back to a Drive `files.list` query for a Config/ folder under
 *      parentFolderId.
 *   3. On Drive hit, only call `writeScaffoldCache` if BOTH configFolderId
 *      AND productsFolderId are known — partial writes are blocked by
 *      `writeScaffoldCache`'s ID-validation guard, so don't bother trying
 *      with an empty productsFolderId.
 *
 * Returns null when no Config/ folder is found (caller decides whether
 * that's a 404 or a no-op).
 */
export async function resolveConfigFolderId(parentFolderId: string): Promise<string | null> {
  if (!parentFolderId) return null

  // Fast path: cache hit
  const cached = readScaffoldCache()[parentFolderId]?.configFolderId
  if (cached && isValidDriveFolderId(cached)) return cached

  // Slow path: Drive list
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })
  const listRes = await drive.files.list({
    q: `'${parentFolderId}' in parents and name='Config' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  const configFolderId = listRes.data.files?.[0]?.id ?? null
  if (!configFolderId) return null

  // Best-effort cache hydration: only persist when both halves of the scaffold are known.
  // (writeScaffoldCache validates both IDs and silently skips on a partial write.)
  const existingProductsFolderId = readScaffoldCache()[parentFolderId]?.productsFolderId
  if (existingProductsFolderId && isValidDriveFolderId(existingProductsFolderId)) {
    writeScaffoldCache(parentFolderId, { configFolderId, productsFolderId: existingProductsFolderId })
  }
  return configFolderId
}

/**
 * Upsert the local SETTINGS_PATH file to Drive at Config/settings.json.
 * Caller is responsible for catching errors if the sync is best-effort.
 *
 * Returns the Drive fileId of the written settings.json.
 */
export async function writeSettingsToDrive(parentFolderId: string): Promise<{ fileId: string }> {
  if (!parentFolderId) throw new Error('parentFolderId is required')
  const configFolderId = await resolveConfigFolderId(parentFolderId)
  if (!configFolderId) throw new Error('Config/ folder not resolvable under parentFolderId')

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  // Read current local settings contents (raw bytes — preserve any keys we don't normalize).
  let body: string
  try {
    body = readFileSync(SETTINGS_PATH, 'utf-8')
  } catch {
    body = '{}'
  }

  // Look up an existing settings.json under Config/
  const existing = await drive.files.list({
    q: `'${configFolderId}' in parents and name='settings.json' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })

  if (existing.data.files?.length) {
    const fileId = existing.data.files[0].id!
    await drive.files.update({
      fileId,
      requestBody: {},
      media: { mimeType: 'application/json', body },
    })
    return { fileId }
  }

  const created = await drive.files.create({
    requestBody: { name: 'settings.json', parents: [configFolderId] },
    media: { mimeType: 'application/json', body },
    supportsAllDrives: true,
    fields: 'id',
  })
  const fileId = created.data.id
  if (!fileId) throw new Error('Drive files.create returned no id')
  return { fileId }
}

/**
 * Read Config/settings.json from Drive under `parentFolderId` and return
 * its parsed JSON body. Throws when:
 *   - Config/ folder is not resolvable
 *   - settings.json file is missing under Config/
 *   - Drive returns a non-JSON response
 */
export async function readSettingsFromDrive(parentFolderId: string): Promise<Record<string, unknown>> {
  if (!parentFolderId) throw new Error('parentFolderId is required')
  const configFolderId = await resolveConfigFolderId(parentFolderId)
  if (!configFolderId) throw new Error('Config/ folder not found under parentFolderId')

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })
  const fileList = await drive.files.list({
    q: `'${configFolderId}' in parents and name='settings.json' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  const fileId = fileList.data.files?.[0]?.id
  if (!fileId) throw new Error('Config/settings.json not found in Drive')

  const content = await drive.files.get({ fileId, alt: 'media' } as any)
  // googleapis returns the parsed body in `data` for alt=media when the file
  // is JSON-typed. Defensive: if it's a string, parse it.
  const data = content.data
  if (typeof data === 'string') {
    try { return JSON.parse(data) as Record<string, unknown> }
    catch { throw new Error('Config/settings.json contained invalid JSON') }
  }
  if (data && typeof data === 'object') return data as Record<string, unknown>
  throw new Error('Config/settings.json returned an unexpected type')
}

/** Atomic write to the local SETTINGS_PATH — caller decides what `parsed` contains. */
export function applySettingsToLocal(parsed: Record<string, unknown>): void {
  writeJsonAtomic(SETTINGS_PATH, parsed)
}
