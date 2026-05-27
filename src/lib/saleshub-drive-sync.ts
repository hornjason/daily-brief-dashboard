/**
 * SalesHub Drive Sync — L3 download path (Issue #442)
 *
 * Downloads saleshub-knowledge.json from the "SalesHub" subfolder on
 * Google Drive (written there by the Mac Mini's sync-saleshub-drive.ts)
 * and writes it to the local config/ directory so the knowledge loader
 * picks it up.
 *
 * This closes the data flow gap where hero/laptop containers only had
 * the stale baked-in config-templates version.
 *
 * All Drive calls are wrapped in try/catch — if download fails for any
 * reason, the caller falls back to whatever is already on disk
 * (config/ or config-templates/).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from '../google.ts'
import { CONFIG_DIR } from './paths.ts'

const SALESHUB_FOLDER_NAME = 'SalesHub'
const KNOWLEDGE_FILE_NAME = 'saleshub-knowledge.json'

/**
 * Read settings.json and extract the first podBookingsFolderId from regions.
 * This is the L4 parent folder under which the "SalesHub" subfolder lives.
 */
function getPodBookingsFolderId(): string | null {
  try {
    const settingsPath = resolve(CONFIG_DIR, 'settings.json')
    if (!existsSync(settingsPath)) return null
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const regions = settings.regions ?? []
    for (const r of regions) {
      if (r.podBookingsFolderId) return r.podBookingsFolderId
    }
  } catch {}
  return null
}

/**
 * Download saleshub-knowledge.json from Google Drive's "SalesHub" subfolder.
 *
 * Flow:
 *   1. Read podBookingsFolderId from settings.json
 *   2. Find "SalesHub" child folder under that parent
 *   3. Find saleshub-knowledge.json in the SalesHub folder
 *   4. Download contents via alt=media
 *   5. Write to CONFIG_DIR/saleshub-knowledge.json
 *
 * Returns true on success, false on any failure (caller falls back to disk).
 */
export async function downloadSaleshubFromDrive(): Promise<boolean> {
  const parentFolderId = getPodBookingsFolderId()
  if (!parentFolderId) {
    console.log('[saleshub-drive-sync] No podBookingsFolderId in settings — skipping Drive download')
    return false
  }

  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    // Step 1: Find the "SalesHub" subfolder under the pod bookings folder
    const folderListRes = await withQuotaRetry(
      () => drive.files.list({
        q: `name = '${SALESHUB_FOLDER_NAME}' and '${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      '[saleshub-drive-sync] find SalesHub folder',
    )

    const saleshubFolderId = folderListRes.data.files?.[0]?.id
    if (!saleshubFolderId) {
      console.log('[saleshub-drive-sync] No SalesHub folder found under podBookingsFolderId — skipping')
      return false
    }

    // Step 2: Find saleshub-knowledge.json in the SalesHub folder
    const fileListRes = await withQuotaRetry(
      () => drive.files.list({
        q: `name = '${KNOWLEDGE_FILE_NAME}' and '${saleshubFolderId}' in parents and trashed = false`,
        fields: 'files(id, name, modifiedTime)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      '[saleshub-drive-sync] find saleshub-knowledge.json',
    )

    const knowledgeFileId = fileListRes.data.files?.[0]?.id
    if (!knowledgeFileId) {
      console.log('[saleshub-drive-sync] No saleshub-knowledge.json found in SalesHub folder — skipping')
      return false
    }

    const modifiedTime = fileListRes.data.files?.[0]?.modifiedTime ?? 'unknown'

    // Step 3: Download the file content
    const contentRes = await withQuotaRetry(
      () => drive.files.get(
        { fileId: knowledgeFileId, alt: 'media', supportsAllDrives: true } as any,
        { responseType: 'text' },
      ),
      '[saleshub-drive-sync] download saleshub-knowledge.json',
    )

    const content = typeof contentRes.data === 'string'
      ? contentRes.data
      : JSON.stringify(contentRes.data, null, 2)

    // Step 4: Validate it's real JSON before writing
    const parsed = JSON.parse(content)
    if (!parsed.tdps && !parsed.salesPlays && !parsed.tactics) {
      console.warn('[saleshub-drive-sync] Downloaded file does not look like valid SalesHub knowledge — skipping write')
      return false
    }

    // Step 5: Write to config dir
    mkdirSync(CONFIG_DIR, { recursive: true })
    const destPath = resolve(CONFIG_DIR, KNOWLEDGE_FILE_NAME)
    writeFileSync(destPath, content)

    const tdpCount = parsed.tdps?.length ?? 0
    const playCount = parsed.salesPlays?.length ?? 0
    const tacticCount = parsed.tactics?.length ?? 0
    console.log(
      `[saleshub-drive-sync] Downloaded saleshub-knowledge.json from Drive (${tdpCount} TDPs, ${playCount} plays, ${tacticCount} tactics, modified: ${modifiedTime})`,
    )
    return true
  } catch (e: any) {
    console.warn(`[saleshub-drive-sync] Drive download failed — falling back to disk: ${e.message}`)
    return false
  }
}
