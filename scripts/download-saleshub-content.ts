/**
 * scripts/download-saleshub-content.ts — Download key SalesHub documents
 *
 * Searches for high-value content (cheatsheets, customer decks, email templates,
 * battlecards) via the Seismic search API, downloads each file, and uploads
 * to organized Google Drive folders.
 *
 * Runs on Mac Mini L4 daemon — requires authenticated SalesHub session.
 */

import { chromium } from '@playwright/test'
import type { Page } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from '../src/google.ts'

const PROFILE_DIR = process.env.RH_PROFILE_DIR ?? '/data/rh-profile'
const CACHE_DIR = process.env.CACHE_DIR ?? '/data/cache'
const CONFIG_DIR = process.env.CONFIG_DIR ?? '/data/config'
const DOWNLOAD_DIR = resolve(CACHE_DIR, 'saleshub', 'downloads')
const PROFILE_VERSION_ID = '1d1918e9-b5b0-4428-b8fc-87e02ad44156'

const KEY_PATTERNS = [
  'customer facing deck',
  'cheatsheet',
  'elevator pitch',
  'baseline discovery questions',
  'customer outcomes in action',
  'email template',
  'intro deck',
]

interface SearchDoc {
  name: string
  contentId: string
  versionId: string
  format: string
}

function getL4FolderId(): string | null {
  try {
    const settings = JSON.parse(readFileSync(resolve(CONFIG_DIR, 'settings.json'), 'utf-8'))
    for (const r of settings.regions ?? []) {
      if (r.podBookingsFolderId) return r.podBookingsFolderId
    }
  } catch {}
  return null
}

async function findOrCreateFolder(drive: any, parentId: string, name: string): Promise<string> {
  const res = await withQuotaRetry(() => drive.files.list({
    q: `name = '${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true,
  }), `find folder ${name}`)
  if (res.data.files?.length > 0) return res.data.files[0].id
  const create = await withQuotaRetry(() => drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    supportsAllDrives: true, fields: 'id',
  }), `create folder ${name}`)
  return create.data.id
}

export async function downloadSalesHubContent(): Promise<{ downloaded: number; uploaded: number; errors: number }> {
  const sessionState = JSON.parse(readFileSync(resolve(PROFILE_DIR, 'session-state.json'), 'utf-8'))
  mkdirSync(DOWNLOAD_DIR, { recursive: true })

  const browser = await chromium.launch({
    headless: true,
    executablePath: '/ms-playwright/chromium-1208/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--headless=new'],
  })

  const context = await browser.newContext({
    storageState: sessionState,
    acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
  })

  let downloaded = 0
  let uploaded = 0
  let errors = 0

  try {
    // Step 1: Capture auth token
    const page = await context.newPage()
    let auth = '', headers: Record<string, string> = {}
    page.on('request', (req) => {
      if (!auth && req.headers().authorization?.startsWith('Bearer ')) {
        auth = req.headers().authorization
        headers = req.headers()
      }
    })

    await page.goto(`https://saleshub.redhat.com/apps/doccenter/${PROFILE_VERSION_ID}/main///`, {
      waitUntil: 'domcontentloaded', timeout: 60_000,
    })
    await page.waitForTimeout(12_000)

    if (!auth) {
      console.error('[download] Could not capture Seismic auth token')
      await browser.close()
      return { downloaded: 0, uploaded: 0, errors: 1 }
    }

    console.log('[download] Auth captured')

    // Step 2: Search for key documents across all categories
    const searchUrl = `https://saleshub.redhat.com/gateway/services/search/tenants/redhat/api/services/search/v1/results?userId=3d3471b2-b7a5-4241-b3dc-5a461e054eb1&languages=en-us`

    const allDocs: SearchDoc[] = []
    const seenNames = new Set<string>()

    for (const pattern of KEY_PATTERNS) {
      const docs = await page.evaluate(async (args) => {
        const body = {
          SearchTerm: args.pattern,
          Page: { PageIndex: 0, PageSize: 20 },
          Sort: 'Standard',
          Filter: {
            AppType: 'DocCenter',
            SeismicProperties: [{ PropName: 'ProfileVersions', Values: [args.pvid] }],
            ExcludedAppTypes: ['ControlCenter', 'NewsCenter', 'WorkSpace'],
            ExcludeFolder: false,
            Folder: { FolderPath: 'root', ProfileVersionId: args.pvid },
            IncludeSubFolder: true,
          },
          DynamicFilter: { operator: 'and', conditions: [] },
          IncludeAppTypeFacet: true, SortOrder: 'default', EnableMultiFacetSearch: true,
          PermissionWorkflow: { WorkflowType: 'view' },
          Options: { WithAggregation: false, WithDocument: true },
        }
        const res = await fetch(args.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: args.auth, profileversionid: args.pvid, teamsiteid: args.tsid ?? '1' },
          body: JSON.stringify(body),
        })
        const data = await res.json()
        return (data?.ServiceResult?.Documents ?? [])
          .filter((d: any) => d.Format && !['JSON', 'MP4', 'MOV', 'WEBM', 'ZIP', 'PNG', 'YouTube', 'URL'].includes(d.Format))
          .map((d: any) => ({ name: d.Name, contentId: d.ContentId, versionId: d.VersionId, format: d.Format }))
      }, { pattern, url: searchUrl, auth, pvid: PROFILE_VERSION_ID, tsid: headers.teamsiteid })

      for (const doc of docs) {
        if (!seenNames.has(doc.name)) {
          seenNames.add(doc.name)
          allDocs.push(doc)
        }
      }
    }

    console.log(`[download] Found ${allDocs.length} unique key documents to download`)
    await page.close()

    // Step 3: Download each file via browser page context (CAUGS API needs full session)
    // Use page.evaluate to make the CAUGS call from within the authenticated browser
    for (let i = 0; i < allDocs.length; i++) {
      const doc = allDocs[i]
      const filename = `${doc.name}.${doc.format.toLowerCase()}`
      const localPath = resolve(DOWNLOAD_DIR, filename.replace(/[/\\?%*:|"<>]/g, '_'))

      if (existsSync(localPath)) {
        console.log(`[download] (${i + 1}/${allDocs.length}) Skip (cached): ${doc.name}`)
        downloaded++
        continue
      }

      try {
        const fileData = await page.evaluate(async (args) => {
          const caugsRes = await fetch('/gateway/services/caugs/tenants/redhat/v1/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: args.auth },
            body: JSON.stringify({ contentId: args.contentId, versionId: args.versionId }),
          })
          if (!caugsRes.ok) return { error: `CAUGS ${caugsRes.status}` }
          const caugsData = await caugsRes.json()
          const blobUrl = (caugsData as any)?.url ?? (caugsData as any)?.downloadUrl ?? (caugsData as any)?.Url ?? ''
          if (!blobUrl) return { error: 'No blob URL', keys: Object.keys(caugsData as object) }

          const blobRes = await fetch(blobUrl)
          if (!blobRes.ok) return { error: `Blob ${blobRes.status}` }
          const buffer = await blobRes.arrayBuffer()
          // Convert to base64 to pass back to Node
          const bytes = new Uint8Array(buffer)
          let binary = ''
          for (let j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j])
          return { size: buffer.byteLength, base64: btoa(binary) }
        }, { contentId: doc.contentId, versionId: doc.versionId, auth })

        if (fileData.error) {
          console.warn(`[download] (${i + 1}/${allDocs.length}) ✗ ${doc.name}: ${fileData.error}`)
          errors++
        } else if (fileData.base64) {
          writeFileSync(localPath, Buffer.from(fileData.base64, 'base64'))
          console.log(`[download] (${i + 1}/${allDocs.length}) ✓ ${doc.name} (${doc.format}, ${Math.round((fileData.size ?? 0) / 1024)}KB)`)
          downloaded++
        }
      } catch (e: any) {
        console.error(`[download] (${i + 1}/${allDocs.length}) ✗ ${doc.name}: ${e.message?.slice(0, 80)}`)
        errors++
        // If page died, create a new one
        if (e.message?.includes('closed')) {
          try {
            page = await context.newPage()
            await page.goto(`https://saleshub.redhat.com/apps/doccenter/${PROFILE_VERSION_ID}/main///`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
            await page.waitForTimeout(8_000)
            console.log('[download] Recovered page context')
          } catch { break }
        }
      }

      await new Promise(r => setTimeout(r, 300))
    }
    await page.close()

    // Step 4: Upload to Google Drive
    const l4FolderId = getL4FolderId()
    const driveAuth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)

    if (l4FolderId && driveAuth) {
      const drive = google.drive({ version: 'v3', auth: driveAuth })
      const saleshubFolder = await findOrCreateFolder(drive, l4FolderId, 'SalesHub')
      const contentFolder = await findOrCreateFolder(drive, saleshubFolder, 'Key Content')

      const { readdirSync } = await import('fs')
      const files = readdirSync(DOWNLOAD_DIR).filter(f => !f.startsWith('.'))

      console.log(`[download] Uploading ${files.length} files to Drive…`)

      for (const file of files) {
        const filePath = resolve(DOWNLOAD_DIR, file)
        const mimeMap: Record<string, string> = {
          pdf: 'application/pdf',
          pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }
        const ext = file.split('.').pop()?.toLowerCase() ?? ''
        const mimeType = mimeMap[ext] ?? 'application/octet-stream'

        try {
          // Delete existing file with same name
          const existing = await withQuotaRetry(() => drive.files.list({
            q: `name = '${file.replace(/'/g, "\\'")}' and '${contentFolder}' in parents and trashed = false`,
            fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true,
          }), `check ${file}`)
          for (const f of existing.data.files ?? []) {
            if (f.id) await drive.files.delete({ fileId: f.id, supportsAllDrives: true }).catch(() => {})
          }

          const fileContent = readFileSync(filePath)
          await withQuotaRetry(() => drive.files.create({
            requestBody: { name: file, parents: [contentFolder] },
            media: { mimeType, body: require('stream').Readable.from(fileContent) },
            supportsAllDrives: true, fields: 'id',
          }), `upload ${file}`)

          uploaded++
        } catch (e: any) {
          console.warn(`[download] Upload failed for ${file}: ${e.message?.slice(0, 60)}`)
        }

        await new Promise(r => setTimeout(r, 200))
      }

      console.log(`[download] Drive upload complete: ${uploaded} files`)
    } else {
      console.warn('[download] No Drive auth or folder — skipping upload')
    }

  } finally {
    await context.close()
    await browser.close()
  }

  console.log(`[download] Done: ${downloaded} downloaded, ${uploaded} uploaded, ${errors} errors`)
  return { downloaded, uploaded, errors }
}

if (import.meta.main) {
  downloadSalesHubContent().catch(err => {
    console.error('[download] Fatal:', err)
    process.exit(1)
  })
}
