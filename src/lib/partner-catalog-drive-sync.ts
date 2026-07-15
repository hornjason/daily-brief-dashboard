/**
 * Partner Catalog Drive Sync — L3 download/upload path (Issue #998)
 *
 * Downloads territory-partners.json from the "Territory Partners"
 * subfolder on Google Drive and writes it to the local cache directory
 * so the partner catalog module picks it up. Also uploads the local
 * file back to Drive for Mac Mini → hero sync.
 *
 * Follows the same pattern as ecosystem-catalog-drive-sync.ts.
 *
 * All Drive calls are wrapped in try/catch — if download fails for any
 * reason, the caller falls back to whatever is already on disk.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from '../google.ts'
import { CONFIG_DIR, CACHE_DIR } from './paths.ts'

const TERRITORY_PARTNERS_FOLDER_NAME = 'Territory Partners'
const TERRITORY_PARTNERS_FILENAME = 'territory-partners.json'

/**
 * Read settings.json and extract the first podBookingsFolderId from regions.
 * This is the L4 parent folder under which the "Territory Partners" subfolder lives.
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
 * Download territory-partners.json from Google Drive's
 * "Territory Partners" subfolder.
 *
 * Flow:
 *   1. Read podBookingsFolderId from settings.json
 *   2. Find "Territory Partners" child folder under that parent
 *   3. Find territory-partners.json in the folder
 *   4. Download the file, validate (must be a non-empty array)
 *   5. Write to data/cache/territory-partners.json
 *
 * Returns true if the file was downloaded, false on failure or missing.
 */
export async function downloadTerritoryPartnersFromDrive(): Promise<boolean> {
  const parentFolderId = getPodBookingsFolderId()
  if (!parentFolderId) {
    console.log('[partner-catalog-drive-sync] No podBookingsFolderId in settings — skipping Drive download')
    return false
  }

  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    // Step 1: Find the "Territory Partners" subfolder under the pod bookings folder
    const folderListRes = await withQuotaRetry(
      () => drive.files.list({
        q: `name = '${TERRITORY_PARTNERS_FOLDER_NAME}' and '${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      '[partner-catalog-drive-sync] find Territory Partners folder',
    )

    const territoryFolderId = folderListRes.data.files?.[0]?.id
    if (!territoryFolderId) {
      console.log('[partner-catalog-drive-sync] No Territory Partners folder found under podBookingsFolderId — skipping')
      return false
    }

    // Step 2: Find territory-partners.json in the folder
    const fileListRes = await withQuotaRetry(
      () => drive.files.list({
        q: `name = '${TERRITORY_PARTNERS_FILENAME}' and '${territoryFolderId}' in parents and mimeType = 'application/json' and trashed = false`,
        fields: 'files(id, name, modifiedTime)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      '[partner-catalog-drive-sync] find territory-partners.json',
    )

    const fileId = fileListRes.data.files?.[0]?.id
    if (!fileId) {
      console.log('[partner-catalog-drive-sync] No territory-partners.json found in Territory Partners folder — skipping')
      return false
    }

    // Step 3: Download the file
    const contentRes = await withQuotaRetry(
      () => drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true } as any,
        { responseType: 'text' },
      ),
      '[partner-catalog-drive-sync] download territory-partners.json',
    )

    const content = typeof contentRes.data === 'string'
      ? contentRes.data
      : JSON.stringify(contentRes.data, null, 2)

    // Step 4: Validate — must be a non-empty array
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.warn('[partner-catalog-drive-sync] territory-partners.json is not a non-empty array — skipping')
      return false
    }

    // Step 5: Write to local cache directory
    mkdirSync(CACHE_DIR, { recursive: true })
    const destPath = resolve(CACHE_DIR, TERRITORY_PARTNERS_FILENAME)
    writeFileSync(destPath, content)
    console.log(`[partner-catalog-drive-sync] Downloaded territory-partners.json (${parsed.length} partners) from Drive`)
    return true
  } catch (e: any) {
    console.warn(`[partner-catalog-drive-sync] Drive download failed — falling back to disk: ${e.message}`)
    return false
  }
}

/**
 * Upload territory-partners.json to Google Drive's
 * "Territory Partners" subfolder.
 *
 * Flow:
 *   1. Read podBookingsFolderId from settings.json
 *   2. Find or create "Territory Partners" child folder under that parent
 *   3. Read local data/cache/territory-partners.json
 *   4. Upload/update the file in the Drive folder
 *
 * Returns true on success, false on failure.
 */
export async function uploadTerritoryPartnersToDrive(): Promise<boolean> {
  const parentFolderId = getPodBookingsFolderId()
  if (!parentFolderId) {
    console.log('[partner-catalog-drive-sync] No podBookingsFolderId in settings — skipping Drive upload')
    return false
  }

  const localPath = resolve(CACHE_DIR, TERRITORY_PARTNERS_FILENAME)
  if (!existsSync(localPath)) {
    console.log('[partner-catalog-drive-sync] No local territory-partners.json to upload')
    return false
  }

  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    // Step 1: Find or create the "Territory Partners" subfolder
    const folderListRes = await withQuotaRetry(
      () => drive.files.list({
        q: `name = '${TERRITORY_PARTNERS_FOLDER_NAME}' and '${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      '[partner-catalog-drive-sync] find Territory Partners folder for upload',
    )

    let territoryFolderId = folderListRes.data.files?.[0]?.id

    if (!territoryFolderId) {
      // Create the folder
      const createRes = await withQuotaRetry(
        () => drive.files.create({
          requestBody: {
            name: TERRITORY_PARTNERS_FOLDER_NAME,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentFolderId],
          },
          fields: 'id',
          supportsAllDrives: true,
        }),
        '[partner-catalog-drive-sync] create Territory Partners folder',
      )
      territoryFolderId = createRes.data.id!
      console.log(`[partner-catalog-drive-sync] Created Territory Partners folder: ${territoryFolderId}`)
    }

    // Step 2: Read local file
    const content = readFileSync(localPath, 'utf-8')

    // Step 3: Check if file already exists on Drive
    const existingFileRes = await withQuotaRetry(
      () => drive.files.list({
        q: `name = '${TERRITORY_PARTNERS_FILENAME}' and '${territoryFolderId}' in parents and mimeType = 'application/json' and trashed = false`,
        fields: 'files(id)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      '[partner-catalog-drive-sync] check existing territory-partners.json',
    )

    const existingFileId = existingFileRes.data.files?.[0]?.id

    if (existingFileId) {
      // Update existing file
      await withQuotaRetry(
        () => drive.files.update({
          fileId: existingFileId,
          media: {
            mimeType: 'application/json',
            body: content,
          },
          supportsAllDrives: true,
        }),
        '[partner-catalog-drive-sync] update territory-partners.json on Drive',
      )
      console.log('[partner-catalog-drive-sync] Updated territory-partners.json on Drive')
    } else {
      // Create new file
      await withQuotaRetry(
        () => drive.files.create({
          requestBody: {
            name: TERRITORY_PARTNERS_FILENAME,
            mimeType: 'application/json',
            parents: [territoryFolderId!],
          },
          media: {
            mimeType: 'application/json',
            body: content,
          },
          fields: 'id',
          supportsAllDrives: true,
        }),
        '[partner-catalog-drive-sync] create territory-partners.json on Drive',
      )
      console.log('[partner-catalog-drive-sync] Created territory-partners.json on Drive')
    }

    return true
  } catch (e: any) {
    console.warn(`[partner-catalog-drive-sync] Drive upload failed: ${e.message}`)
    return false
  }
}
