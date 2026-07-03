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
        fields: 'files(id, name, modifiedTime)',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      '[saleshub-product-drive-sync] list product folders',
    )

    const allFolders = foldersRes.data.files ?? []
    if (allFolders.length === 0) {
      console.log('[saleshub-product-drive-sync] No product subfolders found — skipping')
      return { downloaded: 0, products: [] }
    }

    // Deduplicate folders that map to the same slug (old slugified name vs new display name)
    const bySlug = new Map<string, typeof allFolders>()
    for (const f of allFolders) {
      if (!f.id || !f.name) continue
      const s = slugify(f.name)
      const arr = bySlug.get(s) ?? []
      arr.push(f)
      bySlug.set(s, arr)
    }

    const productFolders: typeof allFolders = []
    for (const [slug, group] of bySlug) {
      if (group.length === 1) {
        productFolders.push(group[0])
        continue
      }
      // Multiple folders map to the same slug — find newest file modifiedTime in each
      let best = group[0]
      let bestTime = ''
      for (const folder of group) {
        const filesRes = await withQuotaRetry(
          () => drive.files.list({
            q: `'${folder.id}' in parents and trashed = false`,
            fields: 'files(modifiedTime)',
            orderBy: 'modifiedTime desc',
            pageSize: 1,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          }),
          `[saleshub-product-drive-sync] check newest file in "${folder.name}"`,
        )
        const newest = filesRes.data.files?.[0]?.modifiedTime ?? ''
        if (newest > bestTime) {
          bestTime = newest
          best = folder
        }
      }
      const skipped = group.filter(f => f.id !== best.id).map(f => f.name).join(', ')
      console.warn(`[saleshub-product-drive-sync] Duplicate Drive folders for ${slug}: keeping ${best.name}, skipping ${skipped}`)
      productFolders.push(best)
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

    // Remove stale slugified-name folder if display name differs from slug
    const slugifiedName = slugify(productName)
    if (slugifiedName !== productName) {
      const staleFolderId = await findFolder(drive, productsFolderId, slugifiedName)
      if (staleFolderId) {
        await withQuotaRetry(
          () => drive.files.delete({ fileId: staleFolderId, supportsAllDrives: true }),
          `[saleshub-product-drive-sync] delete stale folder "${slugifiedName}"`,
        )
        console.log(`[saleshub-product-drive-sync] Deleted stale slugified folder "${slugifiedName}"`)
      }
    }

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
 * Phase 5 (#972): Verify every item from _product-source.json exists in Drive.
 *
 * Walks each section, checks for matching file/shortcut/webloc by name.
 * Returns a verification report with PRESENT / MISSING / NAME MISMATCH.
 */
export async function generateDriveVerification(
  productSlug: string,
  productSource: {
    sections: Record<string, {
      title: string
      items: Array<{ name: string; format?: string }>
    }>
  },
  productFolderId: string,
): Promise<object> {
  const verification: {
    productSlug: string
    verifiedAt: string
    driveFolderId: string
    sections: Record<string, {
      title: string
      expected: Array<{ name: string; format?: string }>
      found: Array<{ name: string; driveFileId: string; driveType: string }>
      missing: Array<{ name: string; reason: string }>
      extra: Array<{ name: string; driveFileId: string }>
    }>
    summary: {
      totalExpected: number
      totalFound: number
      totalMissing: number
      totalExtra: number
      coveragePercent: number
    }
  } = {
    productSlug,
    verifiedAt: new Date().toISOString(),
    driveFolderId: productFolderId,
    sections: {},
    summary: { totalExpected: 0, totalFound: 0, totalMissing: 0, totalExtra: 0, coveragePercent: 0 },
  }

  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    // List ALL files in the product folder (including subfolders)
    const allDriveFiles: Array<{ id: string; name: string; mimeType: string; parents: string[] }> = []

    async function listFilesRecursive(folderId: string) {
      let pageToken: string | undefined
      do {
        const res = await withQuotaRetry(
          () => drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: 'nextPageToken, files(id, name, mimeType, parents)',
            pageSize: 200,
            pageToken,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          }),
          `[drive-verification] list files in ${folderId}`,
        )
        for (const f of res.data.files ?? []) {
          if (!f.id || !f.name) continue
          allDriveFiles.push({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType ?? '',
            parents: (f.parents as string[]) ?? [],
          })
          // Recurse into subfolders
          if (f.mimeType === 'application/vnd.google-apps.folder') {
            await listFilesRecursive(f.id)
          }
        }
        pageToken = res.data.nextPageToken ?? undefined
      } while (pageToken)
    }

    await listFilesRecursive(productFolderId)

    // Build name lookup (lowercase, trimmed)
    const driveFilesByName = new Map<string, { id: string; name: string; mimeType: string }>()
    const matchedDriveIds = new Set<string>()
    for (const f of allDriveFiles) {
      if (f.mimeType === 'application/vnd.google-apps.folder') continue
      const key = f.name
        .replace(/\.(webloc|url|json|png|pdf|pptx|docx)$/i, '')
        .toLowerCase()
        .trim()
      if (!driveFilesByName.has(key)) {
        driveFilesByName.set(key, { id: f.id, name: f.name, mimeType: f.mimeType })
      }
    }

    let totalExpected = 0
    let totalFound = 0
    let totalMissing = 0

    for (const [sectionKey, section] of Object.entries(productSource.sections)) {
      const expected = section.items.map(i => ({ name: i.name, format: i.format }))
      const found: Array<{ name: string; driveFileId: string; driveType: string }> = []
      const missing: Array<{ name: string; reason: string }> = []

      for (const item of section.items) {
        const nameKey = item.name.toLowerCase().trim().slice(0, 80)
        const match = driveFilesByName.get(nameKey)

        if (match) {
          const driveType = match.mimeType.includes('shortcut') ? 'shortcut'
            : match.name.endsWith('.webloc') ? 'webloc'
            : 'file'
          found.push({ name: item.name, driveFileId: match.id, driveType })
          matchedDriveIds.add(match.id)
          totalFound++
        } else {
          missing.push({ name: item.name, reason: 'no matching Drive entry' })
          totalMissing++
        }
        totalExpected++
      }

      // Find extra files in Drive not in source
      const extra: Array<{ name: string; driveFileId: string }> = []

      verification.sections[sectionKey] = {
        title: section.title,
        expected,
        found,
        missing,
        extra,
      }
    }

    // Extra files: files in Drive not matched to any source item
    const extraFiles: Array<{ name: string; driveFileId: string }> = []
    for (const f of allDriveFiles) {
      if (f.mimeType === 'application/vnd.google-apps.folder') continue
      if (matchedDriveIds.has(f.id)) continue
      // Skip data files
      if (f.name.startsWith('_')) continue
      extraFiles.push({ name: f.name, driveFileId: f.id })
    }

    verification.summary = {
      totalExpected,
      totalFound,
      totalMissing,
      totalExtra: extraFiles.length,
      coveragePercent: totalExpected > 0
        ? Math.round((totalFound / totalExpected) * 1000) / 10
        : 100,
    }

    console.log(`[drive-verification] ${productSlug}: ${totalFound}/${totalExpected} found (${verification.summary.coveragePercent}%), ${totalMissing} missing, ${extraFiles.length} extra`)
  } catch (e: any) {
    console.warn(`[drive-verification] Verification failed for "${productSlug}": ${e.message}`)
  }

  return verification
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

    // Find or create product folder by display name (matches uploadProductToDrive)
    const productName = manifest.productName ?? productSlug
    const productFolderId = await findOrCreateFolder(drive, productsFolderId, productName)

    await uploadOrUpdateJson(drive, productFolderId, '_pipeline-manifest.json', manifest)
    console.log(`[saleshub-product-drive-sync] Uploaded manifest for "${productName}" to Drive`)
  } catch (e: any) {
    console.warn(`[saleshub-product-drive-sync] Manifest upload failed for "${productSlug}": ${e.message}`)
  }
}
