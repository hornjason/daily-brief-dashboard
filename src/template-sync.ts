// -- #1017: Hub-and-spoke account plan template sync from Google Drive --------
//
// Extends the cache-first lookup pattern from drive-config-sync.ts:47 (resolveConfigFolderId).
//
// Public surface:
//   - resolveTemplatePath(filename)          -> cache-first path (download cache -> baked-in fallback)
//   - syncTemplatesFromDrive(parentFolderId) -> download all templates from Drive to local cache
//   - getTemplateStatus()                    -> list cached template files with metadata
//   - seedTemplatesToDrive(parentFolderId)   -> upload baked-in templates to Drive (initial setup)
//
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { resolveConfigFolderId } from './drive-config-sync.ts'
import { isValidDriveFolderId } from './utils.ts'
import { CACHE_DIR } from './lib/paths.ts'

// -- Paths --------------------------------------------------------------------

/** Baked-in templates shipped with the container image */
const APP_TEMPLATE_DIR = resolve(import.meta.dir, '../config/account-plan')

/** Local download cache for Drive-synced templates */
const TEMPLATE_CACHE_DIR = resolve(CACHE_DIR, 'account-plan-templates')

// -- Manifest type ------------------------------------------------------------

interface TemplateManifest {
  version: string
  lastUpdated: string
  templatesFolderId: string | null
  files: Record<string, { description: string; required: boolean }>
}

function readManifest(): TemplateManifest {
  const cachedPath = resolve(TEMPLATE_CACHE_DIR, 'manifest.json')
  const bakedPath = resolve(APP_TEMPLATE_DIR, 'manifest.json')
  const path = existsSync(cachedPath) ? cachedPath : bakedPath
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as TemplateManifest
  } catch {
    return { version: '0.0.0', lastUpdated: '', templatesFolderId: null, files: {} }
  }
}

// -- resolveTemplatePath: cache-first with baked-in fallback ------------------

/**
 * Resolve a template file path. Checks the download cache first, falls back
 * to the baked-in config/account-plan/ directory.
 *
 * Returns the absolute path to the file, or null if not found in either location.
 */
export function resolveTemplatePath(filename: string): string | null {
  // 1. Check download cache
  const cachedPath = resolve(TEMPLATE_CACHE_DIR, filename)
  if (existsSync(cachedPath)) {
    const stat = statSync(cachedPath)
    if (stat.size > 0) return cachedPath
  }

  // 2. Fall back to baked-in
  const bakedPath = resolve(APP_TEMPLATE_DIR, filename)
  if (existsSync(bakedPath)) return bakedPath

  return null
}

// -- Drive folder resolution --------------------------------------------------

/**
 * Find or create the "Account Plan Templates" subfolder under Config/.
 * Uses the same cache-first pattern as resolveConfigFolderId.
 */
async function resolveTemplatesFolderId(parentFolderId: string): Promise<string | null> {
  if (!parentFolderId || !isValidDriveFolderId(parentFolderId)) return null

  const configFolderId = await resolveConfigFolderId(parentFolderId)
  if (!configFolderId) return null

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  // Look for existing "Account Plan Templates" folder
  const listRes = await drive.files.list({
    q: `'${configFolderId}' in parents and name='Account Plan Templates' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })

  if (listRes.data.files?.length) {
    return listRes.data.files[0].id!
  }

  // Create it
  const created = await drive.files.create({
    requestBody: {
      name: 'Account Plan Templates',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [configFolderId],
    },
    supportsAllDrives: true,
    fields: 'id',
  })
  return created.data.id ?? null
}

// -- Seed templates to Drive --------------------------------------------------

/**
 * Upload baked-in template files to Drive. Idempotent -- skips files that
 * already exist by name in the target folder.
 */
export async function seedTemplatesToDrive(parentFolderId: string): Promise<{ seeded: string[]; skipped: string[] }> {
  const templatesFolderId = await resolveTemplatesFolderId(parentFolderId)
  if (!templatesFolderId) throw new Error('Could not resolve or create Account Plan Templates folder')

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  // List existing files in the templates folder
  const existing = await drive.files.list({
    q: `'${templatesFolderId}' in parents and trashed=false`,
    fields: 'files(name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  const existingNames = new Set((existing.data.files ?? []).map(f => f.name))

  // Files to seed from baked-in dir
  const filesToSeed = readdirSync(APP_TEMPLATE_DIR).filter(f =>
    /\.(md|json|txt|pdf)$/.test(f)
  )

  const seeded: string[] = []
  const skipped: string[] = []

  for (const filename of filesToSeed) {
    if (existingNames.has(filename)) {
      skipped.push(filename)
      continue
    }

    const filePath = resolve(APP_TEMPLATE_DIR, filename)

    if (filename.endsWith('.pdf')) {
      const pdfBuffer = readFileSync(filePath)
      await drive.files.create({
        requestBody: { name: filename, parents: [templatesFolderId] },
        media: { mimeType: 'application/pdf', body: Buffer.from(pdfBuffer) as any },
        supportsAllDrives: true,
        fields: 'id',
      })
    } else {
      const content = readFileSync(filePath, 'utf-8')
      const mimeType = filename.endsWith('.json') ? 'application/json' : 'text/plain'
      await drive.files.create({
        requestBody: { name: filename, parents: [templatesFolderId] },
        media: { mimeType, body: content },
        supportsAllDrives: true,
        fields: 'id',
      })
    }
    seeded.push(filename)
  }

  // Update manifest with folder ID
  const manifest = readManifest()
  manifest.templatesFolderId = templatesFolderId
  manifest.lastUpdated = new Date().toISOString()
  const manifestPath = resolve(APP_TEMPLATE_DIR, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  console.log(`[template-sync] Seeded ${seeded.length} templates to Drive, skipped ${skipped.length}`)
  return { seeded, skipped }
}

// -- Sync templates from Drive to local cache ---------------------------------

interface SyncResult {
  synced: number
  files: string[]
  templatesFolderId: string
}

/**
 * Download all template files from the Drive "Account Plan Templates" folder
 * into the local cache directory.
 */
export async function syncTemplatesFromDrive(parentFolderId: string): Promise<SyncResult> {
  const templatesFolderId = await resolveTemplatesFolderId(parentFolderId)
  if (!templatesFolderId) throw new Error('Account Plan Templates folder not found in Drive')

  mkdirSync(TEMPLATE_CACHE_DIR, { recursive: true })

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  const listRes = await drive.files.list({
    q: `'${templatesFolderId}' in parents and trashed=false`,
    fields: 'files(id, name, mimeType, modifiedTime)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })

  const files = listRes.data.files ?? []
  const synced: string[] = []

  for (const file of files) {
    if (!file.id || !file.name) continue

    try {
      const content = await drive.files.get(
        { fileId: file.id, alt: 'media' } as any,
        { responseType: 'arraybuffer' }
      )

      const outputPath = resolve(TEMPLATE_CACHE_DIR, file.name)
      const data = content.data
      if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
        writeFileSync(outputPath, Buffer.from(data as ArrayBuffer))
      } else if (typeof data === 'string') {
        writeFileSync(outputPath, data, 'utf-8')
      } else if (typeof data === 'object') {
        writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8')
      }
      synced.push(file.name)
    } catch (e: any) {
      console.warn(`[template-sync] Failed to download ${file.name}: ${e.message}`)
    }
  }

  // Update cached manifest
  const manifestPath = resolve(TEMPLATE_CACHE_DIR, 'manifest.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      manifest.templatesFolderId = templatesFolderId
      manifest.lastUpdated = new Date().toISOString()
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    } catch { /* non-fatal */ }
  }

  console.log(`[template-sync] Synced ${synced.length} templates from Drive`)
  return { synced: synced.length, files: synced, templatesFolderId }
}

// -- Template status ----------------------------------------------------------

interface TemplateFileInfo {
  name: string
  source: 'cache' | 'baked-in'
  size: number
  modifiedAt: string
}

interface TemplateStatus {
  files: TemplateFileInfo[]
  cacheDir: string
  bakedDir: string
  manifest: TemplateManifest
}

/**
 * Get status of all known template files.
 */
export function getTemplateStatus(): TemplateStatus {
  const manifest = readManifest()
  const knownFiles = Object.keys(manifest.files)

  const cacheFiles = existsSync(TEMPLATE_CACHE_DIR)
    ? readdirSync(TEMPLATE_CACHE_DIR)
    : []
  const bakedFiles = existsSync(APP_TEMPLATE_DIR)
    ? readdirSync(APP_TEMPLATE_DIR)
    : []

  const allNames = new Set([...knownFiles, ...cacheFiles, ...bakedFiles])
  const files: TemplateFileInfo[] = []

  for (const name of allNames) {
    const cachedPath = resolve(TEMPLATE_CACHE_DIR, name)
    const bakedPath = resolve(APP_TEMPLATE_DIR, name)

    if (existsSync(cachedPath)) {
      const stat = statSync(cachedPath)
      files.push({
        name,
        source: 'cache',
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      })
    } else if (existsSync(bakedPath)) {
      const stat = statSync(bakedPath)
      files.push({
        name,
        source: 'baked-in',
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      })
    }
  }

  return {
    files: files.sort((a, b) => a.name.localeCompare(b.name)),
    cacheDir: TEMPLATE_CACHE_DIR,
    bakedDir: APP_TEMPLATE_DIR,
    manifest,
  }
}
