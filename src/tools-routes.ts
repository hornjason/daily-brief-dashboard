// src/tools-routes.ts
// GitHub Issue #148 — Upload artifact API and artifact listing
// Provides two endpoints:
//   POST /api/customer/:name/tools/upload — accepts file, writes to customer Drive folder
//   GET /api/customer/:name/tools/artifacts — lists uploaded artifacts

import { Hono } from 'hono'
import { Readable } from 'stream'
import { google } from 'googleapis'
import { customers } from './server-state'
import { findCustomerDriveFolder } from './lib/customer-folder'
import { sanitizeErr } from './utils'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google'
import { createOrUpdateNotebook } from './notebooklm'

export function createToolsRouter() {
  const router = new Hono()

  // POST /api/customer/:name/tools/upload
  // Accepts multipart form data with a file, writes to customer Drive folder under Account Intelligence subfolder
  router.post('/api/customer/:name/tools/upload', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))

    // Find customer in customers array (case-insensitive lookup)
    const customer = customers.find(cu => cu.name.toLowerCase() === customerName.toLowerCase())
    if (!customer) {
      return c.json({ error: `Customer '${customerName}' not found` }, 404)
    }

    try {
      // Resolve customer Drive folder via findCustomerDriveFolder pattern
      const customerFolderId = await findCustomerDriveFolder(customer)

      // Ensure Account Intelligence subfolder exists
      const intelligenceFolderId = await ensureIntelligenceSubfolder(customerFolderId)

      // Parse multipart form data
      const formData = await c.req.formData()
      const file = formData.get('file') as File
      if (!file) {
        return c.json({ error: 'No file provided in form data' }, 400)
      }

      // Upload to Drive using drive.files.create()
      // NOTE: This is NOT upsertDoc — we're uploading PDFs/PPTXs with their original MIME type
      const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
      const drive = google.drive({ version: 'v3', auth })

      const fileBuffer = Buffer.from(await file.arrayBuffer())
      const response = await drive.files.create({
        requestBody: {
          name: file.name,
          parents: [intelligenceFolderId],
        },
        media: {
          mimeType: file.type,
          body: Readable.from(fileBuffer),
        },
        fields: 'id,name,mimeType,webViewLink,modifiedTime',
        supportsAllDrives: true,
      })

      const fileData = response.data
      if (!fileData.id) {
        throw new Error('Drive API returned no file ID')
      }

      console.log(`[tools-upload] Uploaded ${file.name} to ${customerName} Account Intelligence folder: ${fileData.id}`)

      // NotebookLM sync (feature-flagged, non-blocking)
      let syncedToNotebook = false
      if (process.env.NOTEBOOKLM_ENABLED === 'true') {
        try {
          // List all files in intelligence subfolder
          const fileList = await drive.files.list({
            q: `'${intelligenceFolderId}' in parents and trashed = false`,
            fields: 'files(id,name,modifiedTime)',
            orderBy: 'modifiedTime desc',
            pageSize: 100,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          })

          const driveFiles = (fileList.data.files ?? []).map(f => ({
            id: f.id ?? '',
            name: f.name ?? '',
            modifiedTime: f.modifiedTime ?? '',
          }))

          await createOrUpdateNotebook(customer, driveFiles)
          syncedToNotebook = true
          console.log(`[tools-upload] Synced ${driveFiles.length} files to NotebookLM for ${customerName}`)
        } catch (e: any) {
          console.warn(`[tools-upload] NotebookLM sync failed for ${customerName}:`, e?.message ?? e)
        }
      }

      return c.json({
        fileId: fileData.id,
        fileName: fileData.name ?? file.name,
        webViewLink: fileData.webViewLink ?? `https://drive.google.com/file/d/${fileData.id}/view`,
        mimeType: fileData.mimeType ?? file.type,
        uploadedAt: fileData.modifiedTime ?? new Date().toISOString(),
        syncedToNotebook,
      })
    } catch (e: any) {
      console.error(`[tools-upload] Failed to upload file for ${customerName}:`, sanitizeErr(e))
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/customer/:name/tools/artifacts
  // Lists files in the customer's Account Intelligence subfolder
  router.get('/api/customer/:name/tools/artifacts', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))

    // Find customer in customers array (case-insensitive lookup)
    const customer = customers.find(cu => cu.name.toLowerCase() === customerName.toLowerCase())
    if (!customer) {
      return c.json({ error: `Customer '${customerName}' not found` }, 404)
    }

    try {
      // Resolve customer Drive folder
      const customerFolderId = await findCustomerDriveFolder(customer)

      // Find Account Intelligence subfolder (don't create if it doesn't exist)
      const intelligenceFolderId = await findIntelligenceSubfolder(customerFolderId)
      if (!intelligenceFolderId) {
        return c.json({ artifacts: [] })
      }

      // List files in the subfolder
      const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
      const drive = google.drive({ version: 'v3', auth })

      const response = await drive.files.list({
        q: `'${intelligenceFolderId}' in parents and trashed = false`,
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
        orderBy: 'modifiedTime desc',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      })

      const files = response.data.files ?? []
      const artifacts = files.map(f => ({
        id: f.id ?? '',
        name: f.name ?? '',
        mimeType: f.mimeType ?? '',
        modifiedTime: f.modifiedTime ?? '',
        webViewLink: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
      }))

      return c.json({ artifacts })
    } catch (e: any) {
      console.error(`[tools-artifacts] Failed to list artifacts for ${customerName}:`, sanitizeErr(e))
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  return router
}

// ── Helper functions matching account-intelligence.ts pattern ──────────────

async function ensureIntelligenceSubfolder(customerFolderId: string): Promise<string> {
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  // Check for existing subfolder
  const existing = await drive.files.list({
    q: `'${customerFolderId}' in parents and name = 'Account Intelligence' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })

  if (existing.data.files?.length && existing.data.files[0].id) {
    console.log(`[tools-routes] Found existing Account Intelligence subfolder`)
    return existing.data.files[0].id
  }

  // Create new subfolder
  const created = await drive.files.create({
    requestBody: {
      name: 'Account Intelligence',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [customerFolderId],
    },
    fields: 'id',
    supportsAllDrives: true,
  })

  if (!created.data.id) throw new Error('Failed to create Account Intelligence subfolder')
  console.log(`[tools-routes] Created Account Intelligence subfolder: ${created.data.id}`)
  return created.data.id
}

async function findIntelligenceSubfolder(customerFolderId: string): Promise<string | null> {
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  const existing = await drive.files.list({
    q: `'${customerFolderId}' in parents and name = 'Account Intelligence' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })

  return existing.data.files?.[0]?.id ?? null
}
