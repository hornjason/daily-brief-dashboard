/**
 * scripts/scrape-saleshub.ts — SalesHub DocCenter API content indexer (#448)
 *
 * API-based content discovery for Red Hat SalesHub (Seismic platform):
 *   1. Navigate to DocCenter once -> capture Bearer token (10s)
 *   2. Query API with WithAggregation -> discover TDPs, Plays, Tactics from facets
 *   3. For each TDP + Play: query with content type filter -> get document metadata
 *   4. Download high-value documents -> upload to Google Drive -> record Drive file IDs
 *   5. Build knowledge JSON with documents[] per TDP/Play (driveFileId + driveUrl, no extractedContent)
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

// ── API-based Document Download (#448) ────────────────────────────────────────
// Seismic download API endpoints (from developer.seismic.com documentation):
//   GET /integration/v2/teamsites/{teamsiteId}/files/{contentId}/content  (current version)
//   GET /integration/v2/teamsites/{teamsiteId}/files/{contentId}/versions/{versionId}/content  (specific version)
// Gateway mapping at saleshub.redhat.com unknown — probe multiple paths.

const SALESHUB_BASE = 'https://saleshub.redhat.com'

/**
 * Build candidate download URLs from documented Seismic API + gateway variants.
 */
function buildDownloadUrls(teamsiteId: string, contentId: string, versionId: string): string[] {
  return [
    // Pattern matching the working search API: /gateway/services/{service}/tenants/redhat/api/services/{service}/v1/...
    `${SALESHUB_BASE}/gateway/services/library/tenants/redhat/api/services/library/v1/files/${contentId}/versions/${versionId}/download`,
    `${SALESHUB_BASE}/gateway/services/library/tenants/redhat/api/services/library/v2/files/${contentId}/versions/${versionId}/download`,
    `${SALESHUB_BASE}/gateway/services/content/tenants/redhat/api/services/content/v1/files/${contentId}/versions/${versionId}/download`,
    `${SALESHUB_BASE}/gateway/services/content/tenants/redhat/api/services/content/v2/files/${contentId}/versions/${versionId}/download`,
    // Documented Seismic API paths through gateway
    `${SALESHUB_BASE}/gateway/services/integration/v2/teamsites/${teamsiteId}/files/${contentId}/versions/${versionId}/content`,
    `${SALESHUB_BASE}/gateway/services/integration/v2/teamsites/${teamsiteId}/files/${contentId}/content`,
    // DocCenter-specific paths
    `${SALESHUB_BASE}/gateway/services/doccenter/tenants/redhat/api/services/doccenter/v1/files/${contentId}/download`,
    `${SALESHUB_BASE}/gateway/services/doccenter/tenants/redhat/api/v1/contents/${contentId}/download`,
  ]
}

/**
 * Discover the working download URL pattern by probing a sample document.
 * First tries documented Seismic API paths. If all fail, intercepts browser
 * download to capture the actual URL pattern used by the DocCenter SPA.
 */
async function discoverDownloadUrlPattern(
  page: Page,
  sampleDoc: DocCenterDocument,
  authCtx: { auth: string; headers: Record<string, string> },
): Promise<string | null> {
  const contentId = (sampleDoc as any).contentId ?? ''
  const versionId = sampleDoc.versionId ?? ''
  const teamsiteId = authCtx.headers.teamsiteid ?? '1'

  console.log(`[scrape-saleshub] Probing download URLs for "${sampleDoc.name}" (content=${contentId}, version=${versionId}, teamsite=${teamsiteId})...`)

  // Phase 1: Try documented API endpoints via page.evaluate (in-browser fetch)
  const candidates = buildDownloadUrls(teamsiteId, contentId, versionId)
  for (const url of candidates) {
    try {
      const result = await page.evaluate(async (args) => {
        try {
          const res = await fetch(args.url, {
            headers: {
              Authorization: args.auth,
              profileversionid: args.pvid,
              teamsiteid: args.tsid,
            },
          })
          const ct = res.headers.get('content-type') ?? ''
          if (!res.ok) return { ok: false, status: res.status, ct }
          if (ct.includes('text/html') || ct.includes('application/json')) return { ok: false, status: res.status, ct }
          const size = parseInt(res.headers.get('content-length') ?? '0') || 0
          return { ok: true, status: res.status, ct, size }
        } catch (e: any) { return { ok: false, status: -1, ct: '', error: e.message } }
      }, { url, auth: authCtx.auth, pvid: DOCCENTER_PROFILE, tsid: teamsiteId })

      console.log(`[scrape-saleshub]   ${url.replace(SALESHUB_BASE, '')} → ${result.status} (${result.ct || 'no-ct'})`)

      if (result.ok) {
        const pattern = url
          .replace(contentId, '{contentId}')
          .replace(versionId, '{versionId}')
          .replace(teamsiteId, '{teamsiteId}')
        console.log(`[scrape-saleshub] ✓ Working download pattern found!`)
        return pattern
      }
    } catch {}
  }

  // Phase 2: Intercept browser download to discover actual URL
  console.log(`[scrape-saleshub] API probe failed — intercepting browser download...`)
  let discoveredUrl: string | null = null

  const requestHandler = (req: any) => {
    const url = req.url()
    if ((url.includes('download') || url.includes('content') || url.includes('file')) &&
        (url.includes(contentId) || url.includes(versionId)) &&
        !url.includes('search') && !url.includes('results')) {
      discoveredUrl = url
      console.log(`[scrape-saleshub] Intercepted download URL: ${url}`)
    }
  }
  page.on('request', requestHandler)

  try {
    const docUrl = `${SALESHUB_BASE}/apps/doccenter/${DOCCENTER_PROFILE}/doc/${versionId}`
    await page.goto(docUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(5_000)

    const dlBtn = page.locator('button:has-text("Download"), a:has-text("Download"), [aria-label="Download"]').first()
    if (await dlBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const downloadPromise = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null)
      await dlBtn.click()
      const download = await downloadPromise
      if (download) await download.cancel().catch(() => {})
      await page.waitForTimeout(2_000)
    }
  } catch (e: any) {
    console.warn(`[scrape-saleshub] Browser probe failed: ${e.message?.slice(0, 100)}`)
  }

  page.removeListener('request', requestHandler)

  if (discoveredUrl) {
    const pattern = discoveredUrl
      .replace(contentId, '{contentId}')
      .replace(versionId, '{versionId}')
      .replace(teamsiteId, '{teamsiteId}')
    console.log(`[scrape-saleshub] ✓ Browser-intercepted download pattern: ${pattern}`)
    return pattern
  }

  console.warn(`[scrape-saleshub] ✗ No download pattern discovered — downloads will be skipped`)
  return null
}

/**
 * Download a single document via the discovered download URL pattern.
 * Uses page.evaluate to fetch within the browser's authenticated context.
 */
async function apiDownloadDocument(
  page: Page,
  doc: DocCenterDocument,
  authCtx: { auth: string; headers: Record<string, string> },
  outputDir: string,
  urlPattern: string,
): Promise<string | null> {
  const contentId = (doc as any).contentId ?? ''
  const versionId = doc.versionId ?? ''
  const teamsiteId = authCtx.headers.teamsiteid ?? '1'
  const format = ((doc as any).format ?? '').toLowerCase() || 'pptx'
  const safeName = doc.name.replace(/[/\\?%*:|"<>]/g, '_')
  const fileName = `${safeName}.${format}`
  const localPath = resolve(outputDir, fileName)

  if (existsSync(localPath) && isRealDocument(localPath)) {
    return localPath
  }

  const url = urlPattern
    .replace('{contentId}', contentId)
    .replace('{versionId}', versionId)
    .replace('{teamsiteId}', teamsiteId)

  try {
    const result = await page.evaluate(async (args) => {
      try {
        const res = await fetch(args.url, {
          headers: {
            Authorization: args.auth,
            profileversionid: args.pvid,
            teamsiteid: args.tsid,
          },
        })
        if (!res.ok) return { ok: false, status: res.status }
        const ct = res.headers.get('content-type') ?? ''
        if (ct.includes('text/html')) return { ok: false, status: -1 }
        const buf = await res.arrayBuffer()
        if (buf.byteLength < 500) return { ok: false, status: -2 }
        return { ok: true, data: Array.from(new Uint8Array(buf)), size: buf.byteLength }
      } catch { return { ok: false, status: -3 } }
    }, { url, auth: authCtx.auth, pvid: DOCCENTER_PROFILE, tsid: teamsiteId })

    if (result.ok && result.data) {
      mkdirSync(outputDir, { recursive: true })
      const { writeFileSync } = await import('fs')
      writeFileSync(localPath, Buffer.from(result.data))
      if (isRealDocument(localPath)) return localPath
      try { unlinkSync(localPath) } catch {}
    }
  } catch {}

  return null
}

/**
 * Download all documents for a category (TDP or Sales Play) via the API.
 * Returns array of local file paths for successfully downloaded documents.
 */
async function apiDownloadCategory(
  page: Page,
  docs: DocCenterDocument[],
  authCtx: { auth: string; headers: Record<string, string> },
  categoryName: string,
  outputDir: string,
  urlPattern: string,
): Promise<{ downloaded: string[]; failed: string[] }> {
  const downloaded: string[] = []
  const failed: string[] = []

  for (const doc of docs) {
    if (!isEnglishDocument(doc.name)) {
      console.log(`[scrape-saleshub] Skipping ${doc.name} — non-English translation`)
      continue
    }

    const localPath = await apiDownloadDocument(page, doc, authCtx, outputDir, urlPattern)
    if (localPath) {
      downloaded.push(localPath)
      console.log(`[scrape-saleshub] + ${doc.name} (${doc.contentType})`)
    } else {
      failed.push(doc.name)
      console.warn(`[scrape-saleshub] ✗ ${doc.name} — download failed`)
    }

    await new Promise(r => setTimeout(r, 500))
  }

  return { downloaded, failed }
}

// ── Bulk ZIP Download (fallback) ──────────────────────────────────────────────

/**
 * Navigate to the DocCenter filtered view, select all documents,
 * download as a bulk ZIP (multi_selected.Zip), unzip locally,
 * and return an array of extracted file paths.
 *
 * This is ~10x faster than downloading documents one-at-a-time since it
 * uses the DocCenter's native "select all + Download" feature which
 * produces a single ZIP containing all filtered documents.
 */
async function bulkDownloadFiltered(
  page: Page,
  filterCategory: string,   // 'TDP' or 'Sales Play'
  filterValue: string,       // 'Automation', 'AI-Ready Enterprise', etc.
  contentTypes: string[],    // ['Business presentation', 'Cheatsheet', 'Competitive review']
  outputDir: string,
  opts?: { newestVersionCreated?: string; lastContentScrape?: string },
): Promise<string[]> {
  const safeValue = filterValue.replace(/[/\\?%*:|"<>]/g, '_')
  const unzipDir = resolve(outputDir, `${filterCategory}_${safeValue}`)

  // Skip-if-exists: cached files from previous run
  if (existsSync(unzipDir)) {
    try {
      const cached = readdirSync(unzipDir).filter(f => !f.startsWith('.') && !f.startsWith('__'))
      if (cached.length > 0) {
        console.log(`[scrape-saleshub] Skipping bulk download for "${filterCategory}=${filterValue}" — cached (${cached.length} files)`)
        return cached.map(f => resolve(unzipDir, f))
      }
    } catch { /* proceed with download */ }
  }

  // Freshness check: skip if no documents newer than last scrape
  if (opts?.newestVersionCreated && opts?.lastContentScrape) {
    const newest = new Date(opts.newestVersionCreated).getTime()
    const lastScrape = new Date(opts.lastContentScrape).getTime()
    if (newest <= lastScrape) {
      console.log(`[scrape-saleshub] Skipping bulk download for "${filterCategory}=${filterValue}" — no documents newer than last scrape`)
      return []
    }
  }

  // 1. Navigate to DocCenter main page (fresh start clears previous filters)
  await page.goto(
    `https://saleshub.redhat.com/apps/doccenter/${DOCCENTER_PROFILE}/main///`,
    { waitUntil: 'domcontentloaded', timeout: 60_000 },
  )
  await page.waitForTimeout(8_000)

  // 2. Apply the CATEGORY filter FIRST (TDP or Sales Play)
  const categoryCheckbox = page.getByText(filterValue).first()
  if (await categoryCheckbox.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await categoryCheckbox.click()
    await page.waitForTimeout(5_000)
    // Scroll sidebar to trigger lazy loading of all filter sections
    await page.evaluate(() => {
      const sidebar = document.querySelector('[class*="filter"], [class*="sidebar"], [class*="facet"]')
      if (sidebar) {
        sidebar.scrollTop = sidebar.scrollHeight
        setTimeout(() => { sidebar.scrollTop = 0 }, 500)
      }
      const panels = document.querySelectorAll('[class*="panel"], [class*="aside"], aside')
      panels.forEach(p => { p.scrollTop = p.scrollHeight; setTimeout(() => { p.scrollTop = 0 }, 500) })
    })
    await page.waitForTimeout(3_000)
  } else {
    console.warn(`[scrape-saleshub] Category filter not found: "${filterCategory}=${filterValue}"`)
    return []
  }
  console.log(`[scrape-saleshub] Applied category filter: ${filterCategory}="${filterValue}"`)

  // 2b. Click "Show more" to reveal all content type checkboxes
  try {
    const showMoreLink = page.getByText(/Show \d+ more/i).first()
    const showMoreFallback = page.getByText('Show more').first()
    if (await showMoreLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await showMoreLink.click()
      console.log(`[scrape-saleshub] Clicked "Show more" to expand content type options`)
      await page.waitForTimeout(3_000)
    } else if (await showMoreFallback.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await showMoreFallback.click()
      console.log(`[scrape-saleshub] Clicked "Show more" (fallback)`)
      await page.waitForTimeout(3_000)
    }
  } catch (e: any) {
    console.warn(`[scrape-saleshub] "Show more" click failed: ${e.message} — proceeding`)
  }

  // 3. Apply content type filters (multi-select checkboxes)
  let typesSelected = 0
  for (const ct of contentTypes) {
    const ctLabel = page.getByText(ct).first()
    if (await ctLabel.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await ctLabel.click()
      await page.waitForTimeout(2_000)
      typesSelected++
      console.log(`[scrape-saleshub] Applied content type filter: "${ct}"`)
    } else {
      console.warn(`[scrape-saleshub] Content type not found after category filter: "${ct}"`)
    }
  }
  if (typesSelected === 0) {
    console.warn(`[scrape-saleshub] No content types selected for ${filterCategory}=${filterValue}`)
    return []
  }

  // 4. Select all items — click the master checkbox in the header row
  // The DocCenter uses various checkbox implementations — try multiple approaches
  // From the screenshot: the checkbox is in the column header row, first column
  const masterSelectors = [
    'th input[type="checkbox"]',
    'th [role="checkbox"]',
    'thead input[type="checkbox"]',
    'thead [role="checkbox"]',
    '[class*="header"] input[type="checkbox"]',
    '[class*="header"] [role="checkbox"]',
    '[class*="select-all"]',
    'input[type="checkbox"]',  // first checkbox on page (usually the master)
  ]
  let masterClicked = false
  for (const sel of masterSelectors) {
    const el = page.locator(sel).first()
    if (await el.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await el.click()
      await page.waitForTimeout(1_000)
      // Check if "items selected" text appeared
      const selectedText = await page.getByText('items selected').isVisible({ timeout: 2_000 }).catch(() => false)
      if (selectedText) {
        masterClicked = true
        console.log(`[scrape-saleshub] Master checkbox clicked via "${sel}"`)
        break
      }
    }
  }

  if (!masterClicked) {
    // Last resort: try clicking the very first checkbox-like element in the results area
    const fallbackCheckbox = page.locator('[class*="result"] input[type="checkbox"], [class*="list"] input[type="checkbox"]').first()
    if (await fallbackCheckbox.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await fallbackCheckbox.click()
      await page.waitForTimeout(1_000)
    } else {
      console.warn(`[scrape-saleshub] Master checkbox not found — cannot select all for ${filterCategory}=${filterValue}`)
      return []
    }
  }

  // 5. Click the Download button (appears after selecting items)
  const downloadBtn = page.locator(
    'button:has-text("Download"), [aria-label="Download"], [title="Download"]',
  ).first()
  if (!await downloadBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    console.warn(`[scrape-saleshub] Download button not visible for ${filterCategory}=${filterValue}`)
    return []
  }

  // 6. Wait for the ZIP download event
  const downloadPromise = page.waitForEvent('download', { timeout: 300_000 }) // 5 min for large ZIPs
  await downloadBtn.click()
  const download = await downloadPromise

  // 7. Save ZIP to local temp directory
  const zipPath = resolve(outputDir, `${filterCategory}_${safeValue}.zip`)
  await download.saveAs(zipPath)
  console.log(`[scrape-saleshub] ZIP saved: ${zipPath} (${download.suggestedFilename()})`)

  // 8. Unzip into a subdirectory
  mkdirSync(unzipDir, { recursive: true })
  const proc = Bun.spawnSync(['unzip', '-o', '-q', zipPath, '-d', unzipDir])
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr?.toString()?.slice(0, 200) ?? ''
    console.warn(`[scrape-saleshub] unzip failed for ${zipPath}: ${stderr}`)
    try { unlinkSync(zipPath) } catch {}
    return []
  }

  // 9. List extracted files (skip hidden files and __MACOSX)
  const files = readdirSync(unzipDir).filter(
    f => !f.startsWith('.') && !f.startsWith('__'),
  )
  console.log(`[scrape-saleshub] Extracted ${files.length} files from ZIP`)

  // 10. Clean up ZIP file
  try { unlinkSync(zipPath) } catch {}

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

    let totalDownloaded = 0, totalUploaded = 0, totalSkipped = 0, totalFailed = 0

    // Discover the download URL pattern by probing documented Seismic API paths + browser interception
    let downloadPattern: string | null = null
    if (uniqueDocs.length > 0) {
      downloadPattern = await discoverDownloadUrlPattern(page, uniqueDocs[0], authCtx)
    }
    if (!downloadPattern) {
      console.warn('[scrape-saleshub] No download pattern found — skipping file downloads (metadata still recorded)')
    }

    // API-based download per TDP — download each document individually via HTTP
    if (downloadPattern) {
    for (const tdp of facets.tdps) {
      const tdpDocs = uniqueDocs.filter(d => d.tdp?.toLowerCase() === tdp.toLowerCase())
      if (tdpDocs.length === 0) { console.log(`[scrape-saleshub] TDP "${tdp}": 0 documents — skipping`); continue }
      console.log(`[scrape-saleshub] Downloading TDP "${tdp}": ${tdpDocs.length} documents via API...`)

      const tdpDir = resolve(contentDir, `TDP_${tdp.replace(/[/\\?%*:|"<>]/g, '_')}`)
      const result = await apiDownloadCategory(page, tdpDocs, authCtx, tdp, tdpDir, downloadPattern)

      const folderId = tdpFolderIds[tdp.toLowerCase()]
      for (const filePath of result.downloaded) {
        const fileName = filePath.split('/').pop()!
        totalDownloaded++

        const fileNameLower = fileName.toLowerCase()
        const matchedDoc = uniqueDocs.find(d => {
          const safeName = d.name.replace(/[/\\?%*:|"<>]/g, '_').toLowerCase()
          return fileNameLower.includes(safeName) || safeName.includes(fileNameLower.replace(/\.[^.]+$/, ''))
        })

        if (driveEnabled && drive && folderId) {
          try {
            const uploadResult = await uploadFileToDrive(drive, folderId, filePath, fileName)
            console.log(`[scrape-saleshub]   → Drive (${uploadResult.id})`)
            if (matchedDoc) {
              ;(matchedDoc as any).driveFileId = uploadResult.id
              ;(matchedDoc as any).driveUrl = uploadResult.webViewLink
            }
            totalUploaded++
          } catch (e: any) {
            console.warn(`[scrape-saleshub] Upload failed: ${fileName}: ${e.message?.slice(0, 80)}`)
            totalFailed++
          }
        }
        try { unlinkSync(filePath) } catch {}
      }
      totalFailed += result.failed.length
      console.log(`[scrape-saleshub] TDP "${tdp}": ${result.downloaded.length} downloaded, ${result.failed.length} failed`)
    }

    // API-based download per Sales Play
    for (const play of facets.salesPlays) {
      const playDocs = uniqueDocs.filter(d => d.salesPlay?.toLowerCase() === play.toLowerCase())
      if (playDocs.length === 0) { console.log(`[scrape-saleshub] Play "${play}": 0 documents — skipping`); continue }
      console.log(`[scrape-saleshub] Downloading Play "${play}": ${playDocs.length} documents via API...`)

      const playDir = resolve(contentDir, `Play_${play.replace(/[/\\?%*:|"<>]/g, '_')}`)
      const result = await apiDownloadCategory(page, playDocs, authCtx, play, playDir, downloadPattern)

      const folderId = playFolderIds[play.toLowerCase()]
      for (const filePath of result.downloaded) {
        const fileName = filePath.split('/').pop()!
        totalDownloaded++

        const fileNameLower = fileName.toLowerCase()
        const matchedDoc = uniqueDocs.find(d => {
          const safeName = d.name.replace(/[/\\?%*:|"<>]/g, '_').toLowerCase()
          return fileNameLower.includes(safeName) || safeName.includes(fileNameLower.replace(/\.[^.]+$/, ''))
        })

        if (driveEnabled && drive && folderId) {
          try {
            const uploadResult = await uploadFileToDrive(drive, folderId, filePath, fileName)
            console.log(`[scrape-saleshub]   → Drive (${uploadResult.id})`)
            if (matchedDoc) {
              ;(matchedDoc as any).driveFileId = uploadResult.id
              ;(matchedDoc as any).driveUrl = uploadResult.webViewLink
            }
            totalUploaded++
          } catch (e: any) {
            console.warn(`[scrape-saleshub] Upload failed: ${fileName}: ${e.message?.slice(0, 80)}`)
            totalFailed++
          }
        }
        try { unlinkSync(filePath) } catch {}
      }
      totalFailed += result.failed.length
      console.log(`[scrape-saleshub] Play "${play}": ${result.downloaded.length} downloaded, ${result.failed.length} failed`)
    }

    console.log(`[scrape-saleshub] API downloads complete: ${totalDownloaded} downloaded, ${totalUploaded} uploaded to Drive, ${totalSkipped} skipped, ${totalFailed} failed`)
    } // end if (downloadPattern)

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
      })),
    }))

    // Set cheatsheet + customer deck URLs from documents
    for (const tdp of tdpNodes) {
      const cheatsheet = (tdp.documents ?? []).find(d => d.contentType?.toLowerCase().includes('cheatsheet'))
      if (cheatsheet?.versionId) tdp.cheatsheetUrl = `https://saleshub.redhat.com/apps/doccenter/${DOCCENTER_PROFILE}/doc/${cheatsheet.versionId}`
      const deck = (tdp.documents ?? []).find(d => d.contentType?.toLowerCase().includes('business presentation') && d.name.toLowerCase().includes('customer'))
      if (deck?.versionId) tdp.customerDeckUrl = `https://saleshub.redhat.com/apps/doccenter/${DOCCENTER_PROFILE}/doc/${deck.versionId}`
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
    const existingPath = resolve(OUTPUT_DIR, 'saleshub-knowledge.json')
    if (existsSync(existingPath)) {
      try {
        const existing: SalesHubKnowledge = JSON.parse(readFileSync(existingPath, 'utf-8'))
        // Merge page content from existing into new TDP nodes
        for (const tdp of knowledge.tdps) {
          const existingTdp = existing.tdps.find(t => t.name.toLowerCase() === tdp.name.toLowerCase())
          if (existingTdp) {
            if (existingTdp.whatToSay?.length) tdp.whatToSay = existingTdp.whatToSay
            if (existingTdp.whatToShare?.length) tdp.whatToShare = existingTdp.whatToShare
            if (existingTdp.whatToShow?.length) tdp.whatToShow = existingTdp.whatToShow
            if (existingTdp.services?.length) tdp.services = existingTdp.services
            if (existingTdp.customerWins?.length) tdp.customerWins = existingTdp.customerWins
            if (existingTdp.description) tdp.description = existingTdp.description
            if (existingTdp.tactics?.length) tdp.tactics = existingTdp.tactics as any
          }
        }
        // Merge page content from existing into new Play nodes
        for (const play of knowledge.salesPlays) {
          const existingPlay = existing.salesPlays.find(p => p.name.toLowerCase() === play.name.toLowerCase())
          if (existingPlay) {
            if (existingPlay.description) play.description = existingPlay.description
            if (existingPlay.tdpAlignment?.length) play.tdpAlignment = existingPlay.tdpAlignment
            if (existingPlay.customerLens) play.customerLens = existingPlay.customerLens
            if (existingPlay.realWorldExamples?.length) play.realWorldExamples = existingPlay.realWorldExamples
            if (existingPlay.personaSection?.roles?.length) play.personaSection = existingPlay.personaSection
          }
        }
        // Merge tactic page content
        for (const tactic of knowledge.tactics) {
          const existingTactic = existing.tactics.find(t => t.name.toLowerCase() === tactic.name.toLowerCase())
          if (existingTactic) {
            if (existingTactic.talkTrack) tactic.talkTrack = existingTactic.talkTrack
            if (existingTactic.whatToShare?.length) tactic.whatToShare = existingTactic.whatToShare
            if (existingTactic.extractedContent) tactic.extractedContent = existingTactic.extractedContent
            if (existingTactic.parentTdp) tactic.parentTdp = existingTactic.parentTdp
          }
        }
        console.log(`[scrape-saleshub] Merged page content from existing knowledge (${existing.tdps.length} TDPs, ${existing.salesPlays.length} plays, ${existing.tactics.length} tactics)`)
      } catch {
        console.warn('[scrape-saleshub] Could not merge existing knowledge — starting fresh')
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
