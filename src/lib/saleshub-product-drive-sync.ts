/**
 * SalesHub Product Drive Sync — L3 download/upload path (GitHub Issue #819)
 *
 * Syncs per-product JSON files (_product.json, _enriched.json) between
 * Google Drive's "SalesHub Products" folder and the local
 * config-templates/saleshub-products/{slug}/ directory.
 *
 * Follows the same patterns as saleshub-drive-sync.ts:
 *   - podBookingsFolderId from settings.json
 *   - makeAuth + withQuotaRetry for Drive API calls
 *   - supportsAllDrives: true on all calls
 *   - try/catch with warn — never throws
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { Readable } from 'stream'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from '../google.ts'
import { CONFIG_DIR } from './paths.ts'

const PRODUCTS_FOLDER_NAME = 'SalesHub Products'

// ── Helpers ─────────────────────────────────────────────────────────────────

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

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function getProductsTemplateDir(): string {
  if (process.env.CONFIG_DIR) {
    return resolve(process.env.CONFIG_DIR, '..', 'config-templates', 'saleshub-products')
  }
  return resolve('config-templates', 'saleshub-products')
}

/**
 * Find a subfolder by name under a parent folder.
 * Returns the folder ID, or null if not found.
 */
async function findFolder(
  drive: ReturnType<typeof google.drive>,
  parentId: string,
  folderName: string,
): Promise<string | null> {
  const res = await withQuotaRetry(
    () => drive.files.list({
      q: `name = '${folderName.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    }),
    `[saleshub-product-drive-sync] find folder "${folderName}"`,
  )
  return res.data.files?.[0]?.id ?? null
}

/**
 * Find or create a subfolder under a parent folder.
 * Returns the folder ID.
 */
async function findOrCreateFolder(
  drive: ReturnType<typeof google.drive>,
  parentId: string,
  folderName: string,
): Promise<string> {
  const existing = await findFolder(drive, parentId, folderName)
  if (existing) return existing

  const created = await withQuotaRetry(
    () => drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id',
      supportsAllDrives: true,
    }),
    `[saleshub-product-drive-sync] create folder "${folderName}"`,
  )
  return created.data.id!
}

/**
 * Upload or update a JSON file in a Drive folder.
 * If a file with the same name exists, updates it; otherwise creates new.
 */
async function uploadOrUpdateJson(
  drive: ReturnType<typeof google.drive>,
  folderId: string,
  fileName: string,
  content: object,
): Promise<string> {
  // Check if file already exists
  const listRes = await withQuotaRetry(
    () => drive.files.list({
      q: `name = '${fileName}' and '${folderId}' in parents and trashed = false`,
      fields: 'files(id)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    }),
    `[saleshub-product-drive-sync] find "${fileName}"`,
  )

  const existingId = listRes.data.files?.[0]?.id
  const media = {
    mimeType: 'application/json',
    body: JSON.stringify(content, null, 2),
  }

  if (existingId) {
    await withQuotaRetry(
      () => drive.files.update({
        fileId: existingId,
        media,
        supportsAllDrives: true,
      }),
      `[saleshub-product-drive-sync] update "${fileName}"`,
    )
    return existingId
  }

  const createRes = await withQuotaRetry(
    () => drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
      },
      media,
      fields: 'id',
      supportsAllDrives: true,
    }),
    `[saleshub-product-drive-sync] create "${fileName}"`,
  )
  return createRes.data.id!
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface DownloadResult {
  downloaded: number
  products: string[]
}

/**
 * Download product data from the "SalesHub Products" folder on Google Drive.
 *
 * For each product subfolder:
 *   - Downloads _product.json if it exists
 *   - Downloads _enriched.json if it exists
 *   - Writes both to config-templates/saleshub-products/{slug}/
 *
 * Returns { downloaded, products } on success.
 */
export async function downloadProductsFromDrive(): Promise<DownloadResult> {
  const parentFolderId = getPodBookingsFolderId()
  if (!parentFolderId) {
    console.log('[saleshub-product-drive-sync] No podBookingsFolderId in settings — skipping')
    return { downloaded: 0, products: [] }
  }

  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    // Find "SalesHub Products" folder
    const productsFolderId = await findFolder(drive, parentFolderId, PRODUCTS_FOLDER_NAME)
    if (!productsFolderId) {
      console.log('[saleshub-product-drive-sync] No "SalesHub Products" folder found — skipping')
      return { downloaded: 0, products: [] }
    }

    // List all child folders (each is a product)
    const foldersRes = await withQuotaRetry(
      () => drive.files.list({
        q: `'${productsFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      '[saleshub-product-drive-sync] list product folders',
    )

    const productFolders = foldersRes.data.files ?? []
    if (productFolders.length === 0) {
      console.log('[saleshub-product-drive-sync] No product subfolders found — skipping')
      return { downloaded: 0, products: [] }
    }

    const templatesDir = getProductsTemplateDir()
    let downloaded = 0
    const products: string[] = []

    for (const folder of productFolders) {
      if (!folder.id || !folder.name) continue
      const slug = slugify(folder.name)
      const localDir = resolve(templatesDir, slug)
      mkdirSync(localDir, { recursive: true })

      // List files in this product folder
      const filesRes = await withQuotaRetry(
        () => drive.files.list({
          q: `'${folder.id}' in parents and trashed = false and (name = '_product.json' or name = '_enriched.json')`,
          fields: 'files(id, name)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
        `[saleshub-product-drive-sync] list files in "${folder.name}"`,
      )

      for (const file of filesRes.data.files ?? []) {
        if (!file.id || !file.name) continue

        try {
          const contentRes = await withQuotaRetry(
            () => drive.files.get(
              { fileId: file.id!, alt: 'media', supportsAllDrives: true } as any,
              { responseType: 'text' },
            ),
            `[saleshub-product-drive-sync] download "${file.name}" from "${folder.name}"`,
          )

          const content = typeof contentRes.data === 'string'
            ? contentRes.data
            : JSON.stringify(contentRes.data, null, 2)

          // Validate JSON before writing
          JSON.parse(content)
          writeFileSync(resolve(localDir, file.name), content)
          downloaded++
        } catch (e: any) {
          console.warn(`[saleshub-product-drive-sync] Failed to download "${file.name}" from "${folder.name}": ${e.message}`)
        }
      }

      products.push(folder.name)
    }

    console.log(
      `[saleshub-product-drive-sync] Downloaded ${downloaded} files for ${products.length} products`,
    )
    return { downloaded, products }
  } catch (e: any) {
    console.warn(`[saleshub-product-drive-sync] Drive download failed: ${e.message}`)
    return { downloaded: 0, products: [] }
  }
}

/**
 * Upload product data to Drive.
 *
 * Finds or creates the product subfolder under "SalesHub Products",
 * then uploads _product.json and optionally _enriched.json.
 *
 * Returns the Drive folder ID on success, null on failure.
 */
export async function uploadProductToDrive(
  productSlug: string,
  productJson: object,
  enrichedJson?: object,
): Promise<string | null> {
  const parentFolderId = getPodBookingsFolderId()
  if (!parentFolderId) {
    console.log('[saleshub-product-drive-sync] No podBookingsFolderId — cannot upload')
    return null
  }

  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    // Find or create "SalesHub Products" folder
    const productsFolderId = await findOrCreateFolder(drive, parentFolderId, PRODUCTS_FOLDER_NAME)

    // Find or create product subfolder (use the display name from _product.json if available)
    const productName = (productJson as any).name ?? productSlug
    const productFolderId = await findOrCreateFolder(drive, productsFolderId, productName)

    // Upload _product.json
    await uploadOrUpdateJson(drive, productFolderId, '_product.json', productJson)

    // Upload _enriched.json if provided
    if (enrichedJson) {
      await uploadOrUpdateJson(drive, productFolderId, '_enriched.json', enrichedJson)
    }

    console.log(`[saleshub-product-drive-sync] Uploaded product "${productName}" to Drive`)
    return productFolderId
  } catch (e: any) {
    console.warn(`[saleshub-product-drive-sync] Upload failed for "${productSlug}": ${e.message}`)
    return null
  }
}

/**
 * Create section subfolders for a product on Drive.
 *
 * Returns a mapping of section name to Drive folder ID.
 */
export async function createProductSectionFolders(
  productSlug: string,
  sections: string[],
): Promise<Record<string, string>> {
  const parentFolderId = getPodBookingsFolderId()
  if (!parentFolderId) {
    console.log('[saleshub-product-drive-sync] No podBookingsFolderId — cannot create section folders')
    return {}
  }

  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    // Find "SalesHub Products" folder
    const productsFolderId = await findFolder(drive, parentFolderId, PRODUCTS_FOLDER_NAME)
    if (!productsFolderId) {
      console.warn('[saleshub-product-drive-sync] No "SalesHub Products" folder — cannot create sections')
      return {}
    }

    // Find product folder by slug (list folders and match)
    const foldersRes = await withQuotaRetry(
      () => drive.files.list({
        q: `'${productsFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      '[saleshub-product-drive-sync] list product folders for section creation',
    )

    const productFolder = (foldersRes.data.files ?? []).find(
      f => f.name && slugify(f.name) === productSlug,
    )

    if (!productFolder?.id) {
      console.warn(`[saleshub-product-drive-sync] Product folder not found for slug "${productSlug}"`)
      return {}
    }

    // Create section subfolders
    const result: Record<string, string> = {}
    for (const section of sections) {
      const folderId = await findOrCreateFolder(drive, productFolder.id, section)
      result[section] = folderId
    }

    console.log(
      `[saleshub-product-drive-sync] Created ${Object.keys(result).length} section folders for "${productSlug}"`,
    )
    return result
  } catch (e: any) {
    console.warn(`[saleshub-product-drive-sync] Section folder creation failed: ${e.message}`)
    return {}
  }
}

const MIME_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export async function uploadProductFilesToDrive(
  productSlug: string,
  downloadsDir: string,
): Promise<{ uploaded: number; errors: number }> {
  const parentFolderId = getPodBookingsFolderId()
  if (!parentFolderId) return { uploaded: 0, errors: 0 }

  let uploaded = 0, errors = 0
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    const productsFolderId = await findOrCreateFolder(drive, parentFolderId, PRODUCTS_FOLDER_NAME)
    const productFolderId = await findOrCreateFolder(drive, productsFolderId, productSlug)

    if (!existsSync(downloadsDir)) return { uploaded: 0, errors: 0 }

    const sectionDirs = readdirSync(downloadsDir, { withFileTypes: true }).filter(d => d.isDirectory())

    for (const sectionDir of sectionDirs) {
      const sectionPath = resolve(downloadsDir, sectionDir.name)
      const sectionFolderId = await findOrCreateFolder(drive, productFolderId, sectionDir.name)

      const files = readdirSync(sectionPath).filter(f => !f.startsWith('.'))
      for (const file of files) {
        try {
          const filePath = resolve(sectionPath, file)
          const ext = file.split('.').pop()?.toLowerCase() ?? ''
          const mimeType = MIME_MAP[ext] ?? 'application/octet-stream'
          const content = readFileSync(filePath)

          // Delete existing file with same name to prevent duplicates
          const existing = await withQuotaRetry(() => drive.files.list({
            q: `name = '${file.replace(/'/g, "\\'")}' and '${sectionFolderId}' in parents and trashed = false`,
            fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true,
          }), `check ${file}`)
          for (const f of existing.data.files ?? []) {
            if (f.id) await drive.files.delete({ fileId: f.id, supportsAllDrives: true }).catch(() => {})
          }

          await withQuotaRetry(() => drive.files.create({
            requestBody: { name: file, parents: [sectionFolderId] },
            media: { mimeType, body: Readable.from(content) },
            supportsAllDrives: true, fields: 'id',
          }), `upload ${file}`)

          uploaded++
        } catch (e: any) {
          console.warn(`[saleshub-product-drive-sync] Upload failed for ${file}: ${e.message?.slice(0, 60)}`)
          errors++
        }
        await new Promise(r => setTimeout(r, 200))
      }
    }

    console.log(`[saleshub-product-drive-sync] Uploaded ${uploaded} files for "${productSlug}" (${errors} errors)`)
  } catch (e: any) {
    console.warn(`[saleshub-product-drive-sync] File upload failed: ${e.message}`)
  }
  return { uploaded, errors }
}

/**
 * Upload _pipeline-manifest.json to the product's Drive folder (#874 PR 3).
 *
 * Makes the manifest visible across nodes (Mac Mini + hero installs).
 * Fails silently with a warning — the local copy is sufficient.
 */
export async function uploadManifestToDrive(
  productSlug: string,
  manifest: import('./pipeline-manifest.ts').PipelineManifest,
): Promise<void> {
  const parentFolderId = getPodBookingsFolderId()
  if (!parentFolderId) {
    console.log('[saleshub-product-drive-sync] No podBookingsFolderId — skipping manifest upload')
    return
  }

  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    // Find or create "SalesHub Products" folder
    const productsFolderId = await findOrCreateFolder(drive, parentFolderId, PRODUCTS_FOLDER_NAME)

    // Find or create product folder by slug
    const productFolderId = await findOrCreateFolder(drive, productsFolderId, productSlug)

    await uploadOrUpdateJson(drive, productFolderId, '_pipeline-manifest.json', manifest)
    console.log(`[saleshub-product-drive-sync] Uploaded manifest for "${productSlug}" to Drive`)
  } catch (e: any) {
    console.warn(`[saleshub-product-drive-sync] Manifest upload failed for "${productSlug}": ${e.message}`)
  }
}
