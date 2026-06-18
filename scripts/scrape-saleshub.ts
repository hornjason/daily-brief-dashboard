/**
 * scripts/scrape-saleshub.ts — SalesHub DocCenter API content indexer (#448)
 *
 * API-based content discovery for Red Hat SalesHub (Seismic platform):
 *   1. Navigate to DocCenter once -> capture Bearer token (10s)
 *   2. Query API with WithAggregation -> discover TDPs, Plays, Tactics from facets
 *   3. For each TDP + Play: query with content type filter -> get document metadata
 *   4. Download high-value documents -> upload to Google Drive -> record Drive file IDs
 *   5. Build knowledge JSON with documents[] per TDP/Play (driveFileId + driveUrl + extractedContent)
 *   6. Write knowledge JSON to cache + config-templates
 *
 * Replaces the previous multi-pass page scraper (Passes 1-3, ~15 min).
 * Total runtime: ~2 minutes (API calls + downloads).
 *
 * Uses session-state.json cookies from the daemon's browser profile to
 * authenticate via a separate Chromium instance (avoids profile lock).
 *
 * Output:
 *   /data/cache/saleshub/saleshub-knowledge.json full knowledge base
 *   config-templates/saleshub-knowledge.json (for container distribution)
 *
 * Called by sync-l3-daemon.ts via saleshub-trigger file mechanism.
 */

import { chromium } from '@playwright/test'
import type { Page } from '@playwright/test'
import { readFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { Readable } from 'stream'
import { google } from 'googleapis'
import { writeJsonAtomic } from '../src/lib/atomic-write.ts'
import { BASE_CHROMIUM_ARGS } from '../src/browser-utils.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from '../src/google.ts'
import type { SalesHubKnowledge } from './saleshub-knowledge-extraction.ts'
import {
  captureSeismicAuth,
  discoverFacets as discoverContentFacets,
  queryDocuments as queryContentDocuments,
  probeContentSearchApi,
  extractTextFromFile,
  type DocCenterDocument,
} from './saleshub-content-discovery.ts'
import { findOrCreateFolder } from './sync-saleshub-drive.ts'

const PROFILE_DIR = process.env.RH_PROFILE_DIR ?? '/data/rh-profile'
const CACHE_DIR = process.env.CACHE_DIR ?? '/data/cache'
const CONFIG_DIR = process.env.CONFIG_DIR ?? '/data/config'
const OUTPUT_DIR = resolve(CACHE_DIR, 'saleshub')
const DOCCENTER_PROFILE = '1d1918e9-b5b0-4428-b8fc-87e02ad44156'
const CHROMIUM_PATH = '/ms-playwright/chromium-1208/chrome-linux/chrome'

// High-value content types to query and download
const HIGH_VALUE_TYPES = [
  'Business presentation',
  'Cheatsheet',
  'Competitive review',
  'Battlecard',
  'Reference architecture',
  'Campaign guide',
  'Email',
  'Template',
]

// Drive folder structure for organized SalesHub content
const TDP_SUBFOLDER = 'TDPs'
const SALES_PLAY_SUBFOLDER = 'Sales Plays'
const SALESHUB_CONTENT_FOLDER = 'SalesHub Content'

// ── Drive Upload Helper ───────────────────────────────────────────────────────

/**
 * Upload a local file to Google Drive, creating or updating by name match.
 * Returns the Drive file ID and web view link.
 */
export async function uploadFileToDrive(
  drive: any,
  folderId: string,
  filePath: string,
  fileName: string,
): Promise<{ id: string; webViewLink: string }> {
  const buffer = readFileSync(filePath)
  const mimeType = fileName.endsWith('.pdf') ? 'application/pdf'
    : fileName.endsWith('.pptx') ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    : fileName.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : 'application/octet-stream'

  // Check if file already exists (by name) -- update instead of create
  const existing = await withQuotaRetry(
    () => drive.files.list({
      q: `name = '${fileName.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`,
      fields: 'files(id)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    }),
    `check existing ${fileName}`,
  )

  if (existing.data.files?.length > 0) {
    // Update existing file
    const fileId = existing.data.files[0].id
    await withQuotaRetry(
      () => drive.files.update({
        fileId,
        media: { mimeType, body: Readable.from(buffer) },
        supportsAllDrives: true,
      }),
      `update ${fileName}`,
    )
    const meta = await withQuotaRetry(
      () => drive.files.get({ fileId, fields: 'webViewLink', supportsAllDrives: true }),
      `get link ${fileName}`,
    )
    return { id: fileId, webViewLink: meta.data.webViewLink ?? '' }
  }

  // Create new file
  const res = await withQuotaRetry(
    () => drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media: { mimeType, body: Readable.from(buffer) },
      fields: 'id,webViewLink',
      supportsAllDrives: true,
    }),
    `upload ${fileName}`,
  )
  return { id: res.data.id, webViewLink: res.data.webViewLink ?? '' }
}

/**
 * Check if a downloaded file is a real document (not an HTML error page).
 * Returns true if the file appears to be a valid document.
 */
const NON_ENGLISH_PREFIXES = [
  'spanish translation',
  'portuguese translation',
  'korean translation',
  'japanese translation',
  'chinese translation',
  'french translation',
  'german translation',
  'italian translation',
]

function isRealDocument(filePath: string): boolean {
  try {
    const header = readFileSync(filePath).slice(0, 15).toString('utf-8')
    if (header.startsWith('<!DOCTYPE') || header.startsWith('<html') || header.startsWith('<HTML')) {
      return false
    }
    return true
  } catch {
    return false
  }
}

function isEnglishDocument(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  return !NON_ENGLISH_PREFIXES.some(prefix => lower.includes(prefix))
}

// ── Content-Type-Only Bulk Download (#448) ────────────────────────────────────
// Strategy: download by content type only (no TDP/Play filter). One ZIP per
// content type. Simpler and more reliable than filtering by TDP + content type.
// The API metadata already maps each document to its TDP/Play — we match after download.
//
// Council + Context7 research confirmed: Seismic uses signed blob URLs for downloads.
// The Red Hat gateway doesn't proxy the download API. Bulk ZIP via DocCenter UI is
// the only reliable download path. Download URLs use /gateway/services/bss/tenants/redhat/api/download/v1/blob
// with per-request signatures that can't be forged.

const SALESHUB_BASE = 'https://saleshub.redhat.com'

/**
 * Download all documents of a single content type via DocCenter bulk ZIP.
 * No TDP/Play filter — downloads ALL items of that content type, then
 * matches to TDPs/Plays via the API metadata after download.
 *
 * Returns array of local file paths to extracted files.
 */
async function bulkDownloadByContentType(
  page: Page,
  contentType: string,
  outputDir: string,
): Promise<string[]> {
  const safeName = contentType.replace(/[/\\?%*:|"<>\s]+/g, '_')
  const unzipDir = resolve(outputDir, `ContentType_${safeName}`)

  // Skip if already downloaded
  if (existsSync(unzipDir)) {
    try {
      const cached = readdirSync(unzipDir).filter(f => !f.startsWith('.') && !f.startsWith('__'))
      if (cached.length > 0) {
        console.log(`[scrape-saleshub] Skipping "${contentType}" — cached (${cached.length} files)`)
        return cached.map(f => resolve(unzipDir, f))
      }
    } catch {}
  }

  // Navigate to DocCenter fresh (clears previous filters)
  await page.goto(
    `${SALESHUB_BASE}/app/#/doccenter/${DOCCENTER_PROFILE}/main///`,
    { waitUntil: 'domcontentloaded', timeout: 60_000 },
  )
  await page.waitForTimeout(8_000)

  // Expand all content type options — click every "Show more" / "Show N more" link
  // The sidebar initially shows only the top ~10 content types; rest are hidden
  for (let attempt = 0; attempt < 5; attempt++) {
    const showMore = page.getByText(/Show \d+ more/i).first()
    const showMoreSimple = page.getByText('Show more', { exact: false }).first()
    if (await showMore.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await showMore.click()
      console.log(`[scrape-saleshub] Clicked "Show more" (attempt ${attempt + 1})`)
      await page.waitForTimeout(2_000)
    } else if (await showMoreSimple.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await showMoreSimple.click()
      console.log(`[scrape-saleshub] Clicked "Show more" simple (attempt ${attempt + 1})`)
      await page.waitForTimeout(2_000)
    } else {
      break
    }
  }

  // Also scroll the sidebar to ensure all options are rendered
  await page.evaluate(() => {
    const panels = document.querySelectorAll('[class*="filter"], [class*="sidebar"], [class*="facet"], [class*="panel"]')
    panels.forEach(p => {
      p.scrollTop = p.scrollHeight
      setTimeout(() => { p.scrollTop = 0 }, 500)
    })
  })
  await page.waitForTimeout(2_000)

  // Click the content type checkbox
  const ctCheckbox = page.getByText(contentType, { exact: true }).first()
  if (!await ctCheckbox.isVisible({ timeout: 5_000 }).catch(() => false)) {
    // Last resort: try partial match
    const ctPartial = page.getByText(contentType).first()
    if (await ctPartial.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await ctPartial.click()
      console.log(`[scrape-saleshub] Applied content type filter (partial match): "${contentType}"`)
      await page.waitForTimeout(5_000)
    } else {
      console.warn(`[scrape-saleshub] Content type "${contentType}" not visible in sidebar — skipping`)
      return []
    }
  } else {
    await ctCheckbox.click()
    await page.waitForTimeout(5_000)
    console.log(`[scrape-saleshub] Applied content type filter: "${contentType}"`)
  }

  // Select all items
  const masterSelectors = [
    'th input[type="checkbox"]',
    'th [role="checkbox"]',
    'thead input[type="checkbox"]',
    '[class*="header"] input[type="checkbox"]',
    'input[type="checkbox"]',
  ]
  let masterClicked = false
  for (const sel of masterSelectors) {
    const el = page.locator(sel).first()
    if (await el.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await el.click()
      await page.waitForTimeout(1_000)
      const selected = await page.getByText('items selected').isVisible({ timeout: 2_000 }).catch(() => false)
      if (selected) {
        masterClicked = true
        console.log(`[scrape-saleshub] Select-all clicked via "${sel}"`)
        break
      }
    }
  }

  if (!masterClicked) {
    console.warn(`[scrape-saleshub] Could not select all for "${contentType}" — skipping`)
    return []
  }

  // Click Download
  const downloadBtn = page.locator('button:has-text("Download"), [aria-label="Download"], [title="Download"]').first()
  if (!await downloadBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    console.warn(`[scrape-saleshub] Download button not visible for "${contentType}" — skipping`)
    return []
  }

  const downloadPromise = page.waitForEvent('download', { timeout: 300_000 })
  await downloadBtn.click()
  const download = await downloadPromise

  // Save download — could be a ZIP (multi-select) or a single file (1 item selected)
  mkdirSync(unzipDir, { recursive: true })
  const suggestedName = download.suggestedFilename() || `${safeName}.zip`
  const isZip = suggestedName.toLowerCase().endsWith('.zip')
  const savePath = resolve(outputDir, suggestedName)
  await download.saveAs(savePath)
  console.log(`[scrape-saleshub] Download saved: ${suggestedName} (${isZip ? 'ZIP' : 'single file'})`)

  if (isZip) {
    // Unzip multi-select download
    const proc = Bun.spawnSync(['unzip', '-o', '-q', savePath, '-d', unzipDir])
    if (proc.exitCode !== 0) {
      console.warn(`[scrape-saleshub] unzip failed for ${savePath}: ${proc.stderr?.toString()?.slice(0, 100)}`)
      try { unlinkSync(savePath) } catch {}
      return []
    }
    try { unlinkSync(savePath) } catch {}
  } else {
    // Single file download — move directly into unzip dir
    const destPath = resolve(unzipDir, suggestedName)
    const { renameSync } = await import('fs')
    try { renameSync(savePath, destPath) } catch { /* already there */ }
  }

  const files = readdirSync(unzipDir).filter(f => !f.startsWith('.') && !f.startsWith('__'))
  console.log(`[scrape-saleshub] "${contentType}": ${files.length} files extracted`)
  return files.map(f => resolve(unzipDir, f))
}


// ── Types ──────────────────────────────────────────────────────────────────────

export interface SalesHubScrapeResult {
  knowledge: SalesHubKnowledge
}

// ── Main Scrape Function ───────────────────────────────────────────────────────

export async function scrapeSalesHub(): Promise<SalesHubScrapeResult> {
  const sessionStatePath = resolve(PROFILE_DIR, 'session-state.json')
  if (!existsSync(sessionStatePath)) {
    throw new Error(`[scrape-saleshub] No session-state.json at ${sessionStatePath}`)
  }

  const sessionState = JSON.parse(readFileSync(sessionStatePath, 'utf-8'))
  console.log(`[scrape-saleshub] Starting API-based content indexer — ${sessionState.cookies?.length ?? 0} cookies loaded`)

  mkdirSync(OUTPUT_DIR, { recursive: true })

  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: [
      ...BASE_CHROMIUM_ARGS,
      '--disable-blink-features=AutomationControlled',
      '--headless=new',
    ],
  })

  const context = await browser.newContext({
    storageState: sessionState,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })

  try {
    const page = await context.newPage()

    // ── Step 1: Capture Seismic auth token ────────────────────────────────
    console.log('[scrape-saleshub] === Step 1: Capturing Seismic auth ===')
    const authCtx = await captureSeismicAuth(page)
    if (!authCtx) {
      throw new Error('Failed to capture Seismic auth token — SalesHub session may be expired')
    }
    console.log(`[scrape-saleshub] Auth captured (${authCtx.auth.length} chars)`)

    // Respectful wait before API queries
    await page.waitForTimeout(2_000)

    // ── Step 2: Discover taxonomy from API facets ──────────────────────────
    console.log('[scrape-saleshub] === Step 2: Discovering taxonomy from API facets ===')
    const facets = await discoverContentFacets(page, authCtx)
    console.log(`[scrape-saleshub] Facets discovered:`)
    console.log(`  TDPs: ${facets.tdps.join(', ')}`)
    console.log(`  Sales Plays: ${facets.salesPlays.join(', ')}`)
    console.log(`  Sales Tactics: ${facets.salesTactics.join(', ')}`)
    console.log(`  Content Types: ${facets.contentTypes.length} types available`)

    // ── Step 3: Query high-value documents per TDP ────────────────────────
    console.log(`[scrape-saleshub] === Step 3: Querying documents (${HIGH_VALUE_TYPES.join(', ')}) ===`)

    const allDocuments: DocCenterDocument[] = []

    for (const tdp of facets.tdps) {
      const docs = await queryContentDocuments(page, authCtx, { tdp }, HIGH_VALUE_TYPES)
      allDocuments.push(...docs)
      console.log(`[scrape-saleshub] TDP "${tdp}": ${docs.length} documents`)
      await page.waitForTimeout(2_000)
    }

    // ── Step 3b: Query high-value documents per Sales Play ────────────────
    for (const play of facets.salesPlays) {
      const docs = await queryContentDocuments(page, authCtx, { salesPlay: play }, HIGH_VALUE_TYPES)
      allDocuments.push(...docs)
      console.log(`[scrape-saleshub] Play "${play}": ${docs.length} documents`)
      await page.waitForTimeout(2_000)
    }

    // Deduplicate by versionId
    const seen = new Set<string>()
    const uniqueDocs = allDocuments.filter(d => {
      if (seen.has(d.versionId)) return false
      seen.add(d.versionId)
      return true
    })
    console.log(`[scrape-saleshub] Total: ${allDocuments.length} raw, ${uniqueDocs.length} unique documents`)

    // Read lastContentScrape for freshness checks
    let lastContentScrape = ''
    const existingKbPath = resolve(OUTPUT_DIR, 'saleshub-knowledge.json')
    if (existsSync(existingKbPath)) {
      try {
        const existing = JSON.parse(readFileSync(existingKbPath, 'utf-8'))
        lastContentScrape = existing.lastContentScrape ?? ''
      } catch { /* proceed without freshness check */ }
    }

    // Compute newestVersionCreated per TDP and Play from API results
    const newestByTdp: Record<string, string> = {}
    const newestByPlay: Record<string, string> = {}
    for (const doc of uniqueDocs) {
      if (doc.tdp && doc.versionCreated) {
        if (!newestByTdp[doc.tdp] || doc.versionCreated > newestByTdp[doc.tdp]) {
          newestByTdp[doc.tdp] = doc.versionCreated
        }
      }
      if (doc.salesPlay && doc.versionCreated) {
        if (!newestByPlay[doc.salesPlay] || doc.versionCreated > newestByPlay[doc.salesPlay]) {
          newestByPlay[doc.salesPlay] = doc.versionCreated
        }
      }
    }

    // ── Step 4: Bulk ZIP download + upload to Google Drive ─────────────
    console.log(`[scrape-saleshub] === Step 4: Bulk ZIP download + Drive upload ===`)
    const contentDir = resolve(OUTPUT_DIR, 'content')
    mkdirSync(contentDir, { recursive: true })

    // Set up Google Drive auth + folder structure
    let driveEnabled = false
    let drive: any = null
    let tdpFolderIds: Record<string, string> = {}
    let playFolderIds: Record<string, string> = {}

    // Use podBookingsFolderId from settings.json — shared folder, same as existing SalesHub sync
    const settingsPath = resolve(CONFIG_DIR, 'settings.json')
    let sharedFolderId = ''
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      const regions = settings.regions ?? []
      for (const r of regions) {
        if (r.podBookingsFolderId) { sharedFolderId = r.podBookingsFolderId; break }
      }
    } catch {}

    if (sharedFolderId) {
      try {
        const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
        if (auth) {
          drive = google.drive({ version: 'v3', auth })

          // Use existing SalesHub folder, add Content subfolders
          const saleshubRootId = await findOrCreateFolder(drive, sharedFolderId, 'SalesHub')
          const contentRootId = await findOrCreateFolder(drive, saleshubRootId, SALESHUB_CONTENT_FOLDER)
          const tdpRootId = await findOrCreateFolder(drive, contentRootId, TDP_SUBFOLDER)
          const playRootId = await findOrCreateFolder(drive, contentRootId, SALES_PLAY_SUBFOLDER)

          // Create per-TDP subfolders
          for (const tdp of facets.tdps) {
            tdpFolderIds[tdp.toLowerCase()] = await findOrCreateFolder(drive, tdpRootId, tdp)
          }
          // Create per-Play subfolders
          for (const play of facets.salesPlays) {
            playFolderIds[play.toLowerCase()] = await findOrCreateFolder(drive, playRootId, play)
          }

          driveEnabled = true
          console.log(`[scrape-saleshub] Drive folder structure ready under SalesHub/ (${Object.keys(tdpFolderIds).length} TDP folders, ${Object.keys(playFolderIds).length} Play folders)`)
        } else {
          console.warn('[scrape-saleshub] No Google auth available — will download without Drive upload')
        }
      } catch (e: any) {
        console.warn(`[scrape-saleshub] Drive setup failed: ${e.message?.slice(0, 100)} — will download without Drive upload`)
      }
    } else {
      console.warn('[scrape-saleshub] No podBookingsFolderId in settings.json — will download without Drive upload')
    }

    let totalDownloaded = 0, totalUploaded = 0, totalSkipped = 0, totalFailed = 0, totalExtracted = 0

    // Content-type-only bulk download: one ZIP per content type, no TDP/Play filter.
    // This is more reliable than filtering by TDP + content type (avoids sidebar issues).
    // Files are matched to TDPs/Plays from the API metadata after download.
    for (const ct of HIGH_VALUE_TYPES) {
      console.log(`[scrape-saleshub] Bulk downloading content type "${ct}"...`)
      try {
        const localFiles = await bulkDownloadByContentType(page, ct, contentDir)
        console.log(`[scrape-saleshub] "${ct}": ${localFiles.length} files`)

        for (const filePath of localFiles) {
          const fileName = filePath.split('/').pop()!
          if (!isRealDocument(filePath)) {
            console.warn(`[scrape-saleshub] Skipping ${fileName} — HTML error page`)
            try { unlinkSync(filePath) } catch {}
            totalSkipped++
            continue
          }
          if (!isEnglishDocument(fileName)) {
            console.log(`[scrape-saleshub] Skipping ${fileName} — non-English translation`)
            try { unlinkSync(filePath) } catch {}
            totalSkipped++
            continue
          }
          totalDownloaded++

          // Extract text content from the file
          const extractedText = await extractTextFromFile(filePath)
          if (extractedText.length > 0) {
            totalExtracted++
            console.log(`[scrape-saleshub]   📄 ${fileName}: ${extractedText.length} chars extracted`)
          }

          // Match file to a document from API metadata (by name similarity)
          const fileNameLower = fileName.toLowerCase().replace(/\.[^.]+$/, '')
          const matchedDoc = uniqueDocs.find(d => {
            const safeName = d.name.replace(/[/\\?%*:|"<>]/g, '_').toLowerCase()
            return fileNameLower.includes(safeName) || safeName.includes(fileNameLower)
          })

          // Store extracted content in the matched document metadata
          if (matchedDoc && extractedText.length > 0) {
            matchedDoc.extractedContent = extractedText
          }

          // Determine Drive folder from matched doc's TDP or Play
          let folderId = ''
          if (matchedDoc?.tdp) {
            folderId = tdpFolderIds[matchedDoc.tdp.toLowerCase()] ?? ''
          } else if (matchedDoc?.salesPlay) {
            folderId = playFolderIds[matchedDoc.salesPlay.toLowerCase()] ?? ''
          }

          if (driveEnabled && drive && folderId) {
            try {
              const uploadResult = await uploadFileToDrive(drive, folderId, filePath, fileName)
              console.log(`[scrape-saleshub]   + ${fileName} → Drive`)
              if (matchedDoc) {
                ;(matchedDoc as any).driveFileId = uploadResult.id
                ;(matchedDoc as any).driveUrl = uploadResult.webViewLink
              }
              totalUploaded++
            } catch (e: any) {
              console.warn(`[scrape-saleshub] Upload failed: ${fileName}: ${e.message?.slice(0, 80)}`)
              totalFailed++
            }
          } else if (driveEnabled && drive && !folderId) {
            // No TDP/Play match — upload to SalesHub Content root folder
            try {
              const saleshubRootId = await findOrCreateFolder(drive, sharedFolderId, 'SalesHub')
              const contentRootId = await findOrCreateFolder(drive, saleshubRootId, SALESHUB_CONTENT_FOLDER)
              const unfiledId = await findOrCreateFolder(drive, contentRootId, 'Unmatched')
              const uploadResult = await uploadFileToDrive(drive, unfiledId, filePath, fileName)
              console.log(`[scrape-saleshub]   + ${fileName} → Drive (Unmatched)`)
              totalUploaded++
            } catch (e: any) {
              console.warn(`[scrape-saleshub] Upload failed: ${fileName}: ${e.message?.slice(0, 80)}`)
              totalFailed++
            }
          }
        }
      } catch (e: any) {
        console.warn(`[scrape-saleshub] Bulk download failed for "${ct}": ${e.message?.slice(0, 100)}`)
        totalFailed++
      }
      await page.waitForTimeout(3_000)
    }

    console.log(`[scrape-saleshub] Downloads complete: ${totalDownloaded} downloaded, ${totalExtracted} text extracted, ${totalUploaded} uploaded to Drive, ${totalSkipped} skipped, ${totalFailed} failed`)

    await page.close()

    // ── Step 5: Build knowledge base from facets + documents ──────────────
    console.log('[scrape-saleshub] === Step 5: Building knowledge base ===')

    // Build TDP nodes from facet names + documents
    const tdpNodes = facets.tdps.map(name => ({
      name,
      tactics: [] as string[],
      customerWins: [] as Array<{ name: string; description: string }>,
      whatToSay: [] as Array<{ name: string; url: string; type: string }>,
      whatToShare: [] as Array<{ name: string; url: string }>,
      whatToShow: [] as Array<{ name: string; url: string; type: string }>,
      services: [] as Array<{ name: string; description: string }>,
      cheatsheetUrl: '',
      customerDeckUrl: '',
      description: '',
      products: [] as string[],
      extractedContent: '',
      metrics: [] as Array<{ value: string; context: string; source: string }>,
      documents: uniqueDocs.filter(d => d.tdp?.toLowerCase() === name.toLowerCase()).map(d => ({
        name: d.name,
        contentType: d.contentType,
        size: d.size,
        versionId: d.versionId,
        versionCreated: d.versionCreated,
        distributionTerms: d.distributionTerms,
        product: d.product,
        salesStage: d.salesStage,
        driveFileId: (d as any).driveFileId ?? '',
        driveUrl: (d as any).driveUrl ?? '',
        extractedContent: d.extractedContent ?? '',
      })),
    }))

    // Set cheatsheet + customer deck URLs from documents
    for (const tdp of tdpNodes) {
      const cheatsheet = (tdp.documents ?? []).find(d => d.contentType?.toLowerCase().includes('cheatsheet'))
      if (cheatsheet?.versionId) tdp.cheatsheetUrl = `https://saleshub.redhat.com/app/#/doccenter/${DOCCENTER_PROFILE}/doc/${cheatsheet.versionId}`
      const deck = (tdp.documents ?? []).find(d => d.contentType?.toLowerCase().includes('business presentation') && d.name.toLowerCase().includes('customer'))
      if (deck?.versionId) tdp.customerDeckUrl = `https://saleshub.redhat.com/app/#/doccenter/${DOCCENTER_PROFILE}/doc/${deck.versionId}`
    }

    // Build Sales Play nodes from facet names + documents
    const salesPlayNodes = facets.salesPlays.map(name => ({
      name,
      description: '',
      linkedTdps: [] as string[],
      tdpAlignment: [] as string[],
      customerLens: { pain: [] as string[], outcomes: [] as string[], impact: [] as string[] },
      realWorldExamples: [] as Array<{ customer: string; outcome: string }>,
      emailTemplateUrl: '',
      discoveryQuestionsUrl: '',
      introPitchDeckUrl: '',
      personaSection: {
        roles: [] as string[],
        painPoints: [] as string[],
        discoveryQuestions: [] as string[],
        valueProps: [] as string[],
        whatWinsThemOver: [] as string[],
      },
      regionalCampaigns: [] as Array<{ name: string; url: string }>,
      documents: uniqueDocs.filter(d => d.salesPlay?.toLowerCase() === name.toLowerCase()).map(d => ({
        name: d.name,
        contentType: d.contentType,
        size: d.size,
        versionId: d.versionId,
        versionCreated: d.versionCreated,
        distributionTerms: d.distributionTerms,
        product: d.product,
        salesStage: d.salesStage,
        driveFileId: (d as any).driveFileId ?? '',
        driveUrl: (d as any).driveUrl ?? '',
        extractedContent: d.extractedContent ?? '',
      })),
    }))

    // Build Tactic nodes from facet names
    const tacticNodes = facets.salesTactics.map(name => ({
      name,
      parentTdp: '',
      talkTrack: '',
      customerWins: [] as string[],
      whatToSay: [] as string[],
      whatToShare: [] as Array<{ name: string; url: string; type: string }>,
      extractedContent: '',
      metrics: [] as Array<{ value: string; context: string; source: string }>,
    }))

    // Assemble knowledge object
    const knowledge: SalesHubKnowledge = {
      version: 1,
      tdps: tdpNodes,
      salesPlays: salesPlayNodes,
      tactics: tacticNodes,
      products: [],
      scrapedAt: new Date().toISOString(),
      lastContentScrape: new Date().toISOString(),
    } as any

    // Merge with existing knowledge for page content (talk tracks, etc.)
    // Try local cache first, fall back to Drive download (#461)
    let existing: SalesHubKnowledge | null = null
    const existingPath = resolve(OUTPUT_DIR, 'saleshub-knowledge.json')
    if (existsSync(existingPath)) {
      try {
        existing = JSON.parse(readFileSync(existingPath, 'utf-8'))
      } catch {}
    }
    // Fallback: download from Drive if local cache is missing or has no page content
    if (!existing || existing.tdps.every(t => !(t as any).whatToSay?.length && !(t as any).customerWins?.length)) {
      console.log('[scrape-saleshub] Local cache missing or has no page content — trying Drive fallback...')
      try {
        const { downloadSaleshubFromDrive } = await import('../src/lib/saleshub-drive-sync.ts')
        const downloaded = await downloadSaleshubFromDrive()
        if (downloaded && existsSync(existingPath)) {
          existing = JSON.parse(readFileSync(existingPath, 'utf-8'))
          console.log(`[scrape-saleshub] Drive fallback loaded (${existing!.tdps.length} TDPs, ${existing!.salesPlays.length} plays)`)
        }
      } catch (e: any) {
        console.warn(`[scrape-saleshub] Drive fallback failed: ${e.message?.slice(0, 80)}`)
      }
    }

    // TDP name mapping: API facets use short names, page scraper used full names
    const TDP_NAME_MAP: Record<string, string[]> = {
      'ai': ['ai', 'ai platform'],
      'app platform': ['app platform', 'application platform'],
      'automation': ['automation'],
      'virtualization': ['virtualization'],
      'server/cloud os': ['server/cloud os'],
      'container management': ['container management', 'container mgmt'],
    }

    function findExistingTdp(existingTdps: any[], name: string): any | undefined {
      const lower = name.toLowerCase()
      const aliases = TDP_NAME_MAP[lower] ?? [lower]
      return existingTdps.find(t => aliases.includes(t.name.toLowerCase()))
    }

    if (existing) {
      try {
        for (const tdp of knowledge.tdps) {
          const existingTdp = findExistingTdp(existing.tdps, tdp.name)
          if (existingTdp) {
            if (existingTdp.whatToSay?.length && !tdp.whatToSay?.length) tdp.whatToSay = existingTdp.whatToSay
            if (existingTdp.whatToShare?.length && !tdp.whatToShare?.length) tdp.whatToShare = existingTdp.whatToShare
            if (existingTdp.whatToShow?.length && !tdp.whatToShow?.length) tdp.whatToShow = existingTdp.whatToShow
            if (existingTdp.services?.length && !tdp.services?.length) tdp.services = existingTdp.services
            if (existingTdp.customerWins?.length && !tdp.customerWins?.length) tdp.customerWins = existingTdp.customerWins
            if (existingTdp.description && !tdp.description) tdp.description = existingTdp.description
            if (existingTdp.tactics?.length && !tdp.tactics?.length) tdp.tactics = existingTdp.tactics as any
            if (existingTdp.metrics?.length && !tdp.metrics?.length) tdp.metrics = existingTdp.metrics
          }
        }
        for (const play of knowledge.salesPlays) {
          const existingPlay = existing.salesPlays.find(p => p.name.toLowerCase() === play.name.toLowerCase())
          if (existingPlay) {
            if (existingPlay.description && !play.description) play.description = existingPlay.description
            if (existingPlay.tdpAlignment?.length && !play.tdpAlignment?.length) play.tdpAlignment = existingPlay.tdpAlignment
            // Nested objects: check inner arrays, not just outer object
            const oldLens = existingPlay.customerLens as any
            const newLens = play.customerLens as any
            if (oldLens && (oldLens.pain?.length || oldLens.outcomes?.length || oldLens.impact?.length) &&
                !(newLens?.pain?.length || newLens?.outcomes?.length || newLens?.impact?.length)) {
              play.customerLens = existingPlay.customerLens
            }
            if (existingPlay.realWorldExamples?.length && !play.realWorldExamples?.length) play.realWorldExamples = existingPlay.realWorldExamples
            const oldPersona = existingPlay.personaSection as any
            const newPersona = play.personaSection as any
            if (oldPersona?.roles?.length && !newPersona?.roles?.length) play.personaSection = existingPlay.personaSection
            if ((existingPlay as any).emailTemplateUrl && !(play as any).emailTemplateUrl) (play as any).emailTemplateUrl = (existingPlay as any).emailTemplateUrl
            if ((existingPlay as any).discoveryQuestionsUrl && !(play as any).discoveryQuestionsUrl) (play as any).discoveryQuestionsUrl = (existingPlay as any).discoveryQuestionsUrl
            if ((existingPlay as any).introPitchDeckUrl && !(play as any).introPitchDeckUrl) (play as any).introPitchDeckUrl = (existingPlay as any).introPitchDeckUrl
          }
        }
        for (const tactic of knowledge.tactics) {
          const existingTactic = existing.tactics.find(t => t.name.toLowerCase() === tactic.name.toLowerCase())
          if (existingTactic) {
            if (existingTactic.talkTrack && !tactic.talkTrack) tactic.talkTrack = existingTactic.talkTrack
            if (existingTactic.whatToShare?.length && !tactic.whatToShare?.length) tactic.whatToShare = existingTactic.whatToShare
            if (existingTactic.extractedContent && !tactic.extractedContent) tactic.extractedContent = existingTactic.extractedContent
            if (existingTactic.parentTdp && !tactic.parentTdp) tactic.parentTdp = existingTactic.parentTdp
          }
        }
        // Restore products if new has none
        if (!knowledge.products?.length && existing.products?.length) {
          knowledge.products = existing.products
        }
        console.log(`[scrape-saleshub] Merged page content from existing knowledge (${existing.tdps.length} TDPs, ${existing.salesPlays.length} plays, ${existing.tactics.length} tactics)`)
      } catch {
        console.warn('[scrape-saleshub] Could not merge existing knowledge — proceeding with new data only')
      }
    }

    // ── Step 6: Write knowledge base ───────────────────────────────────────
    console.log('[scrape-saleshub] === Step 6: Writing knowledge base ===')

    const knowledgePath = resolve(OUTPUT_DIR, 'saleshub-knowledge.json')
    writeJsonAtomic(knowledgePath, knowledge)

    // Also copy to config-templates for container distribution
    const configTemplatesDir = resolve(process.cwd(), 'config-templates')
    if (existsSync(configTemplatesDir)) {
      const templatePath = resolve(configTemplatesDir, 'saleshub-knowledge.json')
      writeJsonAtomic(templatePath, knowledge)
      console.log(`[scrape-saleshub] Knowledge file also written to ${templatePath}`)
    }

    console.log(`[scrape-saleshub] === INDEXER COMPLETE ===`)
    console.log(`  TDPs: ${knowledge.tdps.length}`)
    console.log(`  Sales Plays: ${knowledge.salesPlays.length}`)
    console.log(`  Tactics: ${knowledge.tactics.length}`)
    console.log(`  Documents: ${totalDownloaded} downloaded, ${totalUploaded} uploaded to Drive, ${totalSkipped} skipped, ${totalFailed} failed`)
    console.log(`  Knowledge file: ${knowledgePath}`)

    return { knowledge }

  } finally {
    await context.close()
    await browser.close()
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = new Set(process.argv.slice(2))

  if (args.has('--help')) {
    console.log(`Usage: bun scripts/scrape-saleshub.ts [flags]
  --facets-only     Show discovered facets (TDPs, Plays, Tactics) and exit
  --no-download     Discover documents but skip downloading/extracting content
  --help            Show this help`)
    process.exit(0)
  }

  scrapeSalesHub()
    .then(result => {
      console.log(`\nSalesHub content indexer completed.`)
      console.log(`Knowledge: ${result.knowledge.tdps.length} TDPs, ${result.knowledge.salesPlays.length} plays, ${result.knowledge.tactics.length} tactics`)
    })
    .catch(err => {
      console.error('[scrape-saleshub] Fatal:', err)
      process.exit(1)
    })
}
