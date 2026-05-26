/**
 * Product Drive Corpus Ingest — Wave 4 Phase 2a
 *
 * Reads product presentation decks from a Google Drive folder, resolves
 * shortcuts to actual files, exports plain text, and caches a text corpus
 * for downstream AI summarization.
 *
 * Key design points:
 *  - Drive folders may contain SHORTCUTS (not native files). Shortcuts carry
 *    shortcutDetails.targetId (actual file) and shortcutDetails.targetMimeType.
 *  - Staleness check: if a file's modifiedTime is unchanged vs cache, reuse
 *    cached textContent to avoid redundant Drive API calls.
 *  - Max 10 files per corpus, sorted modifiedTime DESC (newest first).
 *  - Each file's text capped at 15000 chars.
 *  - Cache: data/cache/product-intel/{slug}-drive-corpus.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { loadProductConfig } from './product-release-radar.ts'
import { CACHE_DIR as BASE_CACHE_DIR } from './lib/paths.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DriveCorpusFile {
  fileId: string        // shortcut's targetId (actual file)
  name: string
  mimeType: string      // target mime type
  modifiedTime: string  // shortcut's modifiedTime (used for staleness)
  textContent: string   // up to 8000 chars
}

export interface DriveCorpus {
  slug: string
  files: DriveCorpusFile[]
  corpusHash: string    // sha256 of all textContent concatenated
  extractedAt: string
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const CACHE_DIR = resolve(BASE_CACHE_DIR, 'product-intel')

const TEXT_CAP  = 15_000
const MAX_FILES = 10

// ── Cache helpers ─────────────────────────────────────────────────────────────

function corpusCachePath(slug: string): string {
  return resolve(CACHE_DIR, `${slug}-drive-corpus.json`)
}

export function getCachedDriveCorpus(slug: string): DriveCorpus | null {
  const p = corpusCachePath(slug)
  try {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, 'utf-8')) as DriveCorpus
    }
  } catch {}
  return null
}

function writeDriveCorpusCache(corpus: DriveCorpus): void {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(corpusCachePath(corpus.slug), JSON.stringify(corpus, null, 2), { mode: 0o600 })
}

// ── Core ingest ───────────────────────────────────────────────────────────────

/**
 * Refresh the Drive text corpus for a product slug.
 *
 * Returns null when:
 *  - The product has no driveFolder configured
 *  - Drive API throws
 *  - No exportable files are found in the folder
 */
export async function refreshDriveCorpus(slug: string): Promise<DriveCorpus | null> {
  // Look up the product config to get the Drive folder ID
  const products = loadProductConfig()
  const product  = products.find(p => p.slug === slug)
  if (!product) {
    console.warn(`[drive-corpus] unknown product slug: ${slug}`)
    return null
  }

  const folderId = product.driveFolder
  if (!folderId) {
    console.warn(`[drive-corpus] ${slug}: driveFolder is null — skipping`)
    return null
  }

  // Load existing cache for staleness check
  const cached = getCachedDriveCorpus(slug)
  const cacheMap = new Map<string, DriveCorpusFile>(
    (cached?.files ?? []).map(f => [f.fileId, f]),
  )

  let drive: ReturnType<typeof google.drive>
  try {
    drive = google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) })
  } catch (e: any) {
    console.error(`[drive-corpus] ${slug}: auth failed:`, e?.message)
    return null
  }

  // List files in the Drive folder
  let allFiles: any[]
  try {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, modifiedTime, shortcutDetails)',
      pageSize: 20,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    allFiles = res.data.files ?? []
  } catch (e: any) {
    console.error(`[drive-corpus] ${slug}: drive.files.list failed:`, e?.message)
    return null
  }

  // Sort by modifiedTime DESC (newest first), take at most MAX_FILES
  allFiles.sort((a, b) => {
    const ta = a.modifiedTime ?? ''
    const tb = b.modifiedTime ?? ''
    return tb.localeCompare(ta)
  })
  const topFiles = allFiles.slice(0, MAX_FILES)

  const results: DriveCorpusFile[] = []

  for (const file of topFiles) {
    // Resolve shortcuts to their actual target
    const isShortcut = file.mimeType === 'application/vnd.google-apps.shortcut'
    const targetId = isShortcut ? (file.shortcutDetails?.targetId ?? file.id) : file.id
    let targetMimeType = isShortcut ? (file.shortcutDetails?.targetMimeType ?? '') : file.mimeType
    // If shortcut targetMimeType wasn't returned, fetch it from the target file
    if (isShortcut && !targetMimeType) {
      try {
        const meta = await drive.files.get({ fileId: targetId, fields: 'mimeType', supportsAllDrives: true })
        targetMimeType = meta.data.mimeType ?? ''
        console.log(`[drive-corpus] ${slug}: resolved shortcut target mimeType: ${targetMimeType} for ${file.name}`)
      } catch (e: any) {
        console.warn(`[drive-corpus] ${slug}: could not resolve shortcut target for ${file.name}:`, e?.message)
      }
    }
    const modifiedTime = file.modifiedTime ?? ''

    // Determine whether we can export this file type
    const isPresentation = targetMimeType.includes('presentation')
    const isDocument     = targetMimeType.includes('document')
    const isPdf          = targetMimeType === 'application/pdf'

    if (!isPresentation && !isDocument && !isPdf) {
      console.log(`[drive-corpus] ${slug}: skipping unsupported type ${targetMimeType} (${file.name})`)
      continue
    }

    // Staleness check — reuse cached text if modifiedTime unchanged
    const prior = cacheMap.get(targetId)
    if (prior && prior.modifiedTime === modifiedTime && prior.textContent) {
      console.log(`[drive-corpus] ${slug}: cache hit (unchanged) ${file.name}`)
      results.push({
        fileId:      targetId,
        name:        file.name,
        mimeType:    targetMimeType,
        modifiedTime,
        textContent: prior.textContent,
      })
      continue
    }

    // Export the file to plain text
    let textContent = ''
    try {
      if (isPresentation || isDocument) {
        // Google Workspace files: use the Drive export API
        const exportRes = await drive.files.export(
          { fileId: targetId, mimeType: 'text/plain' },
          { responseType: 'text' },
        )
        const raw = typeof exportRes.data === 'string'
          ? exportRes.data
          : String(exportRes.data)
        textContent = raw.replace(/\s{2,}/g, ' ').trim().slice(0, TEXT_CAP)
        console.log(`[drive-corpus] ${slug}: exported ${textContent.length} chars from ${file.name}`)
      } else if (isPdf) {
        // Binary file: download then extract text locally via unpdf
        const pdfRes = await drive.files.get(
          { fileId: targetId, alt: 'media' },
          { responseType: 'arraybuffer' },
        )
        const pdfBytes = Buffer.from(pdfRes.data as ArrayBuffer)
        try {
          const { extractText } = await import('unpdf')
          const u8 = new Uint8Array(pdfBytes.buffer, pdfBytes.byteOffset, pdfBytes.byteLength)
          const { text } = await extractText(u8, { mergePages: true })
          textContent = (text as string).replace(/\s+/g, ' ').trim().slice(0, TEXT_CAP)
          console.log(`[drive-corpus] ${slug}: pdf extracted ${textContent.length} chars from ${file.name}`)
        } catch (pdfErr: any) {
          console.warn(`[drive-corpus] ${slug}: unpdf extraction failed for ${file.name}:`, pdfErr?.message)
        }
      }
    } catch (exportErr: any) {
      console.warn(`[drive-corpus] ${slug}: export failed for ${file.name} (${targetId}):`, exportErr?.message)
      continue
    }

    if (!textContent) continue

    results.push({
      fileId:      targetId,
      name:        file.name,
      mimeType:    targetMimeType,
      modifiedTime,
      textContent,
    })
  }

  if (results.length === 0) {
    console.warn(`[drive-corpus] ${slug}: no exportable files found in folder ${folderId}`)
    return null
  }

  const corpusHash = createHash('sha256')
    .update(results.map(f => f.textContent).join(''))
    .digest('hex')

  const corpus: DriveCorpus = {
    slug,
    files:       results,
    corpusHash,
    extractedAt: new Date().toISOString(),
  }

  writeDriveCorpusCache(corpus)
  console.log(`[drive-corpus] ${slug}: corpus written — ${results.length} files, hash ${corpusHash.slice(0, 12)}`)
  return corpus
}
