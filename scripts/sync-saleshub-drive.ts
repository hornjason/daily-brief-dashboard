/**
 * scripts/sync-saleshub-drive.ts — Sync scraped SalesHub data to Google Drive
 *
 * Uploads product JSON files and creates Google Drive shortcuts for
 * Google Docs/Slides URLs found during scraping.
 *
 * Target: "SalesHub" subfolder inside the L4 data folder (podBookingsFolderId).
 */

import { google } from 'googleapis'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from '../src/google.ts'
import type { SalesHubProduct } from './scrape-saleshub.ts'

const CACHE_DIR = process.env.CACHE_DIR ?? '/data/cache'
const CONFIG_DIR = process.env.CONFIG_DIR ?? '/data/config'
const SALESHUB_CACHE = resolve(CACHE_DIR, 'saleshub')
const SALESHUB_FOLDER_NAME = 'SalesHub'

function getL4FolderId(): string | null {
  try {
    const settings = JSON.parse(readFileSync(resolve(CONFIG_DIR, 'settings.json'), 'utf-8'))
    const regions = settings.regions ?? []
    for (const r of regions) {
      if (r.podBookingsFolderId) return r.podBookingsFolderId
    }
  } catch {}
  return null
}

async function findOrCreateFolder(
  drive: any,
  parentId: string,
  folderName: string,
): Promise<string> {
  const listRes = await withQuotaRetry(
    () => drive.files.list({
      q: `name = '${folderName}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    }),
    `find folder ${folderName}`,
  )

  const existing = listRes.data.files ?? []
  if (existing.length > 0 && existing[0].id) {
    console.log(`[sync-saleshub-drive] Found existing "${folderName}" folder: ${existing[0].id}`)
    return existing[0].id
  }

  const createRes = await withQuotaRetry(
    () => drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      supportsAllDrives: true,
      fields: 'id',
    }),
    `create folder ${folderName}`,
  )

  const newId = createRes.data.id
  console.log(`[sync-saleshub-drive] Created "${folderName}" folder: ${newId}`)
  return newId
}

async function uploadJsonFile(
  drive: any,
  folderId: string,
  fileName: string,
  content: string,
): Promise<void> {
  // Delete existing file with same name
  try {
    const listRes = await withQuotaRetry(
      () => drive.files.list({
        q: `name = '${fileName}' and '${folderId}' in parents and trashed = false`,
        fields: 'files(id)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      `list ${fileName}`,
    )
    for (const f of listRes.data.files ?? []) {
      if (f.id) await drive.files.delete({ fileId: f.id, supportsAllDrives: true }).catch(() => {})
    }
  } catch {}

  await withQuotaRetry(
    () => drive.files.create({
      requestBody: {
        name: fileName,
        mimeType: 'application/json',
        parents: [folderId],
      },
      media: { mimeType: 'application/json', body: content },
      supportsAllDrives: true,
      fields: 'id',
    }),
    `upload ${fileName}`,
  )
}

async function createDriveShortcut(
  drive: any,
  folderId: string,
  name: string,
  targetUrl: string,
): Promise<void> {
  // Extract file ID from Google Docs/Slides URL
  const fileIdMatch = targetUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)
  if (!fileIdMatch) return

  const targetFileId = fileIdMatch[1]

  // Check if shortcut already exists
  try {
    const listRes = await withQuotaRetry(
      () => drive.files.list({
        q: `name = '${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`,
        fields: 'files(id)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      `check shortcut ${name}`,
    )
    if ((listRes.data.files ?? []).length > 0) return // already exists
  } catch {}

  try {
    await withQuotaRetry(
      () => drive.files.create({
        requestBody: {
          name,
          mimeType: 'application/vnd.google-apps.shortcut',
          shortcutDetails: { targetId: targetFileId },
          parents: [folderId],
        },
        supportsAllDrives: true,
        fields: 'id',
      }),
      `create shortcut ${name}`,
    )
  } catch (e: any) {
    console.warn(`[sync-saleshub-drive] Shortcut creation failed for "${name}": ${e.message}`)
  }
}

export async function syncSalesHubToDrive(): Promise<{ uploaded: number; shortcuts: number }> {
  const l4FolderId = getL4FolderId()
  if (!l4FolderId) {
    console.warn('[sync-saleshub-drive] No L4 folder ID found in settings.json — skipping Drive sync')
    return { uploaded: 0, shortcuts: 0 }
  }

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  if (!auth) {
    console.warn('[sync-saleshub-drive] No Google auth available — skipping Drive sync')
    return { uploaded: 0, shortcuts: 0 }
  }

  const drive = google.drive({ version: 'v3', auth })

  // Create SalesHub folder
  const saleshubFolderId = await findOrCreateFolder(drive, l4FolderId, SALESHUB_FOLDER_NAME)

  let uploaded = 0
  let shortcuts = 0

  // Upload product JSON files
  if (!existsSync(SALESHUB_CACHE)) {
    console.warn('[sync-saleshub-drive] No saleshub cache directory — run scraper first')
    return { uploaded: 0, shortcuts: 0 }
  }

  const jsonFiles = readdirSync(SALESHUB_CACHE).filter(f => f.endsWith('.json'))
  console.log(`[sync-saleshub-drive] Syncing ${jsonFiles.length} files to Drive…`)

  for (const fileName of jsonFiles) {
    const filePath = resolve(SALESHUB_CACHE, fileName)
    const content = readFileSync(filePath, 'utf-8')

    await uploadJsonFile(drive, saleshubFolderId, fileName, content)
    uploaded++

    // For product files, create shortcuts for Google Docs/Slides URLs
    // Skip index files and the knowledge file (they don't have googleDocsUrls)
    if (fileName !== 'saleshub-products.json' && fileName !== 'saleshub-knowledge.json') {
      try {
        const product: SalesHubProduct = JSON.parse(content)
        for (const url of product.googleDocsUrls ?? []) {
          const shortcutName = `${product.name} — ${url.includes('presentation') ? 'Slides' : 'Doc'}`
          await createDriveShortcut(drive, saleshubFolderId, shortcutName, url)
          shortcuts++
        }
      } catch {}
    }

    // Rate limit courtesy
    await new Promise(r => setTimeout(r, 200))
  }

  console.log(`[sync-saleshub-drive] Done — ${uploaded} files uploaded, ${shortcuts} shortcuts created`)
  return { uploaded, shortcuts }
}

if (import.meta.main) {
  syncSalesHubToDrive().catch(err => {
    console.error('[sync-saleshub-drive] Fatal:', err)
    process.exit(1)
  })
}
