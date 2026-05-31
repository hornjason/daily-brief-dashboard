/**
 * SalesHub Drive Sync — L3 download path (Issues #442, #507)
 *
 * Downloads saleshub-knowledge.json from the "SalesHub" subfolder on
 * Google Drive (written there by the Mac Mini's sync-saleshub-drive.ts)
 * and writes it to the local config/ directory so the knowledge loader
 * picks it up.
 *
 * #507: Also lists all files in the SalesHub Drive folder recursively,
 * extracts text from Google Docs/Slides, and writes a drive-content.json
 * cache for the saleshub-content module to emit as signals.
 *
 * All Drive calls are wrapped in try/catch — if download fails for any
 * reason, the caller falls back to whatever is already on disk
 * (config/ or config-templates/).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from '../google.ts'
import { CONFIG_DIR, CACHE_DIR } from './paths.ts'
import type { DriveContentFile, DriveContentCache } from './saleshub-content.ts'

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

// ── Google Workspace MIME types that support text export ─────────────────

const EXPORTABLE_MIME_TYPES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.spreadsheet',
])

/**
 * Build a user-friendly Drive URL from file ID and MIME type.
 */
function buildDriveUrl(fileId: string, mimeType: string): string {
  if (mimeType === 'application/vnd.google-apps.document') {
    return `https://docs.google.com/document/d/${fileId}`
  }
  if (mimeType === 'application/vnd.google-apps.presentation') {
    return `https://docs.google.com/presentation/d/${fileId}`
  }
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    return `https://docs.google.com/spreadsheets/d/${fileId}`
  }
  return `https://drive.google.com/file/d/${fileId}`
}

/**
 * List all files in the SalesHub Drive folder recursively,
 * extract text from Google Docs/Slides, and write to drive-content.json cache.
 *
 * GitHub Issue #507 — replaces knowledge JSON reading for saleshub-content-module.
 *
 * Flow:
 *   1. Find the "SalesHub" subfolder under podBookingsFolderId
 *   2. Recursively list all files in all subfolders
 *   3. For Google Docs/Slides: export text via Drive API
 *   4. Write results to data/cache/saleshub/drive-content.json
 *
 * Returns the cache object on success, null on failure.
 */
export async function listSaleshubDriveFiles(): Promise<DriveContentCache | null> {
  const parentFolderId = getPodBookingsFolderId()
  if (!parentFolderId) {
    console.log('[saleshub-drive-sync] No podBookingsFolderId in settings — skipping Drive file listing')
    return null
  }

  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    // Step 1: Find the "SalesHub" subfolder
    const folderListRes = await withQuotaRetry(
      () => drive.files.list({
        q: `name = '${SALESHUB_FOLDER_NAME}' and '${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      '[saleshub-drive-sync] find SalesHub folder for file listing',
    )

    const saleshubFolderId = folderListRes.data.files?.[0]?.id
    if (!saleshubFolderId) {
      console.log('[saleshub-drive-sync] No SalesHub folder found — skipping file listing')
      return null
    }

    // Step 2: Recursively list all subfolders and files
    const allFiles: DriveContentFile[] = []

    async function listFolder(folderId: string, folderName: string): Promise<void> {
      let pageToken: string | undefined
      do {
        const res = await withQuotaRetry(
          () => drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
            pageSize: 100,
            pageToken,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          }),
          `[saleshub-drive-sync] list files in ${folderName}`,
        )

        for (const file of res.data.files ?? []) {
          if (!file.id || !file.name) continue

          // Recurse into subfolders
          if (file.mimeType === 'application/vnd.google-apps.folder') {
            await listFolder(file.id, file.name)
            continue
          }

          allFiles.push({
            name: file.name,
            mimeType: file.mimeType ?? 'application/octet-stream',
            driveUrl: buildDriveUrl(file.id, file.mimeType ?? ''),
            driveId: file.id,
            size: file.size ? parseInt(file.size, 10) : null,
            modifiedTime: file.modifiedTime ?? new Date().toISOString(),
            parentFolder: folderName,
            extractedText: null, // filled in step 3
          })
        }

        pageToken = res.data.nextPageToken ?? undefined
      } while (pageToken)
    }

    // List the immediate subfolders of SalesHub (product-named folders)
    const subfolderRes = await withQuotaRetry(
      () => drive.files.list({
        q: `'${saleshubFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      '[saleshub-drive-sync] list SalesHub subfolders',
    )

    // Also list files directly in the SalesHub root folder
    await listFolder(saleshubFolderId, 'SalesHub')

    // Step 3: Extract text from Google Docs/Slides via export API
    let withText = 0
    for (const file of allFiles) {
      if (!EXPORTABLE_MIME_TYPES.has(file.mimeType)) continue

      try {
        const exportRes = await withQuotaRetry(
          () => drive.files.export(
            { fileId: file.driveId, mimeType: 'text/plain' },
            { responseType: 'text' },
          ),
          `[saleshub-drive-sync] export text from ${file.name}`,
        )

        const text = typeof exportRes.data === 'string'
          ? exportRes.data.trim()
          : String(exportRes.data).trim()

        if (text.length > 0) {
          file.extractedText = text
          withText++
        }
      } catch (e: any) {
        console.warn(`[saleshub-drive-sync] Failed to export text from ${file.name}: ${e.message}`)
        // Continue — metadata-only is fine
      }
    }

    // Step 4: Write cache file
    const cache: DriveContentCache = {
      files: allFiles,
      lastSynced: new Date().toISOString(),
      totalFiles: allFiles.length,
      withText,
    }

    const cacheDir = resolve(CACHE_DIR, 'saleshub')
    mkdirSync(cacheDir, { recursive: true })
    const cachePath = resolve(cacheDir, 'drive-content.json')
    writeFileSync(cachePath, JSON.stringify(cache, null, 2))

    console.log(
      `[saleshub-drive-sync] Listed ${allFiles.length} files from SalesHub Drive folder (${withText} with extracted text)`,
    )

    return cache
  } catch (e: any) {
    console.warn(`[saleshub-drive-sync] Drive file listing failed: ${e.message}`)
    return null
  }
}
