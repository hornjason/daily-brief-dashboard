/**
 * Ecosystem Catalog Drive Sync — L3 download path (Issue #462)
 *
 * Downloads ecosystem catalog partner JSON files from the "Ecosystem Catalog"
 * subfolder on Google Drive and writes them to the local cache directory
 * so the ecosystem catalog module picks them up.
 *
 * Follows the same pattern as saleshub-drive-sync.ts.
 *
 * All Drive calls are wrapped in try/catch — if download fails for any
 * reason, the caller falls back to whatever is already on disk.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from '../google.ts'
import { CONFIG_DIR } from './paths.ts'
import { getEcosystemCacheDir } from './ecosystem-catalog.ts'

const ECOSYSTEM_CATALOG_FOLDER_NAME = 'Ecosystem Catalog'

/**
 * Read settings.json and extract the first podBookingsFolderId from regions.
 * This is the L4 parent folder under which the "Ecosystem Catalog" subfolder lives.
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
 * Download all ecosystem catalog JSON files from Google Drive's
 * "Ecosystem Catalog" subfolder.
 *
 * Flow:
 *   1. Read podBookingsFolderId from settings.json
 *   2. Find "Ecosystem Catalog" child folder under that parent
 *   3. List all .json files in the folder
 *   4. Download each file, validate (must have partnerName + solutions array)
 *   5. Write valid files to the ecosystem cache directory
 *
 * Returns true if any files were downloaded, false on failure or empty folder.
 */
export async function downloadEcosystemCatalogFromDrive(): Promise<boolean> {
  const parentFolderId = getPodBookingsFolderId()
  if (!parentFolderId) {
    console.log('[ecosystem-catalog-drive-sync] No podBookingsFolderId in settings — skipping Drive download')
    return false
  }

  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    // Step 1: Find the "Ecosystem Catalog" subfolder under the pod bookings folder
    const folderListRes = await withQuotaRetry(
      () => drive.files.list({
        q: `name = '${ECOSYSTEM_CATALOG_FOLDER_NAME}' and '${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      '[ecosystem-catalog-drive-sync] find Ecosystem Catalog folder',
    )

    const ecosystemFolderId = folderListRes.data.files?.[0]?.id
    if (!ecosystemFolderId) {
      console.log('[ecosystem-catalog-drive-sync] No Ecosystem Catalog folder found under podBookingsFolderId — skipping')
      return false
    }

    // Step 2: List all JSON files in the Ecosystem Catalog folder
    const fileListRes = await withQuotaRetry(
      () => drive.files.list({
        q: `'${ecosystemFolderId}' in parents and mimeType = 'application/json' and trashed = false`,
        fields: 'files(id, name, modifiedTime)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageSize: 200,
      }),
      '[ecosystem-catalog-drive-sync] list JSON files',
    )

    const files = fileListRes.data.files ?? []
    if (files.length === 0) {
      console.log('[ecosystem-catalog-drive-sync] No JSON files found in Ecosystem Catalog folder — skipping')
      return false
    }

    // Ensure local cache directory exists
    const cacheDir = getEcosystemCacheDir()
    mkdirSync(cacheDir, { recursive: true })

    let downloadedCount = 0

    // Step 3: Download and validate each file
    for (const file of files) {
      const fileId = file.id
      const fileName = file.name ?? `${fileId}.json`
      if (!fileId) continue

      try {
        const contentRes = await withQuotaRetry(
          () => drive.files.get(
            { fileId, alt: 'media', supportsAllDrives: true } as any,
            { responseType: 'text' },
          ),
          `[ecosystem-catalog-drive-sync] download ${fileName}`,
        )

        const content = typeof contentRes.data === 'string'
          ? contentRes.data
          : JSON.stringify(contentRes.data, null, 2)

        // Step 4: Validate — must have partnerName and solutions array
        const parsed = JSON.parse(content)
        if (!parsed.partnerName || !Array.isArray(parsed.solutions)) {
          console.warn(`[ecosystem-catalog-drive-sync] ${fileName} missing partnerName or solutions array — skipping`)
          continue
        }

        // Step 5: Write to local cache directory
        const destPath = resolve(cacheDir, fileName)
        writeFileSync(destPath, content)
        downloadedCount++
      } catch (fileErr: any) {
        console.warn(`[ecosystem-catalog-drive-sync] Failed to download ${fileName}: ${fileErr.message}`)
      }
    }

    if (downloadedCount > 0) {
      console.log(`[ecosystem-catalog-drive-sync] Downloaded ${downloadedCount}/${files.length} partner files from Drive`)
      return true
    }

    console.log('[ecosystem-catalog-drive-sync] No valid partner files downloaded from Drive')
    return false
  } catch (e: any) {
    console.warn(`[ecosystem-catalog-drive-sync] Drive download failed — falling back to disk: ${e.message}`)
    return false
  }
}
