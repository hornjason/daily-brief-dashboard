// ── Drive data-source routes (M04 — extracted from server.ts) ───────────────
import { Hono } from 'hono'
import { readFileSync, writeFileSync as writeFileSyncRaw } from 'fs'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth } from './google.ts'
import { customers, CUSTOMERS_PATH } from './server-state.ts'
import { discoverAccountsFromFolders } from './account-discovery.ts'
import { sanitizeErr } from './utils.ts'
import { mergeCustomers, readExistingCustomers } from './customer-merge.ts'

// ── Path constants (module-scoped) ──────────────────────────────────────────
const SRV_CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const GDRIVE_TOKEN_PATH_SRV = process.env.GDRIVE_TOKEN
  ?? resolve(SRV_CONFIG_DIR, '.gdrive-server-credentials.json')
const DATA_SOURCES_PATH_MODULE = process.env.CONFIG_DIR
  ? resolve(process.env.CONFIG_DIR, 'data-sources.json')
  : resolve(import.meta.dir, '../config/data-sources.json')

// ── Route registration ──────────────────────────────────────────────────────

export function createDriveSourcesRouter(): Hono {
  const router = new Hono()
  // GET /api/data-sources/status — List connected AE folders
  router.get('/api/data-sources/status', (c) => {
    try {
      const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH_MODULE, 'utf-8'))
      // Migrate old single-folder format
      const folders = ds.aeFolders ?? (ds.aeFolderID ? [{ folderId: ds.aeFolderID, folderName: ds.folderName ?? null, connectedAt: ds.connectedAt ?? null }] : [])
      return c.json({ folders })
    } catch {
      return c.json({ folders: [] })
    }
  })

  // POST /api/data-sources/check-files — Check each connected AE folder for required files
  // Returns per-folder presence of [AE Name] Supportable, CCSP, and Pipeline files.
  router.post('/api/data-sources/check-files', async (c) => {
    const parentIds = (process.env.AE_PARENT_FOLDER_IDS ?? process.env.AE_PARENT_FOLDER_ID ?? '').split(',').filter(Boolean)
    if (!parentIds.length) return c.json({ error: 'No AE folders connected.' }, 400)

    try {
      const auth  = makeAuth(GDRIVE_TOKEN_PATH_SRV)
      const drive = google.drive({ version: 'v3', auth })

      const results: {
        aeName: string
        folderId: string
        supportable: { found: boolean; fileName?: string }
        ccsp:        { found: boolean; fileName?: string }
        pipeline:    { found: boolean; fileName?: string }
      }[] = []

      for (const parentId of parentIds) {
        // Get the connected folder's own name so we can check direct children first
        const selfMeta = await drive.files.get({ fileId: parentId, fields: 'id,name' }).catch(() => ({ data: { name: '' } }))
        const selfName = ((selfMeta.data as any).name ?? '').trim()
        const selfNameLower = selfName.toLowerCase()

        // Check direct spreadsheet children (native sheets + shortcuts to sheets)
        const [selfSheetsRes, selfShortcutsRes] = await Promise.all([
          drive.files.list({
            q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
            fields: 'files(id,name)', pageSize: 50,
          }).catch(() => ({ data: { files: [] as any[] } })),
          drive.files.list({
            q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.shortcut' and trashed = false`,
            fields: 'files(id,name,shortcutDetails)', pageSize: 50,
          }).catch(() => ({ data: { files: [] as any[] } })),
        ])

        const selfFiles: { name: string }[] = [
          ...((selfSheetsRes.data as any).files ?? []),
          ...((selfShortcutsRes.data as any).files ?? []).filter((f: any) =>
            (f.shortcutDetails?.targetMimeType ?? '').includes('spreadsheet')
          ),
        ]
        const selfNameOf = (suffix: string) =>
          selfFiles.find(f => f.name.toLowerCase().startsWith(selfNameLower) && f.name.toLowerCase().includes(suffix.toLowerCase()))

        // If the connected folder itself contains the required files, treat it as the AE folder
        if (selfFiles.some(f => f.name.toLowerCase().startsWith(selfNameLower))) {
          const supportableFile = selfNameOf('supportable')
          const ccspFile        = selfNameOf('ccsp')
          const pipelineFile    = selfNameOf('pipeline')
          results.push({
            aeName: selfName,
            folderId: parentId,
            supportable: { found: !!supportableFile, fileName: supportableFile?.name },
            ccsp:        { found: !!ccspFile,        fileName: ccspFile?.name },
            pipeline:    { found: !!pipelineFile,    fileName: pipelineFile?.name },
          })
          continue
        }

        // Otherwise scan subfolders (for a root folder containing multiple AE folders)
        const foldersRes = await drive.files.list({
          q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: 'files(id,name)', pageSize: 50,
        }).catch(() => ({ data: { files: [] as any[] } }))

        for (const aeFolder of ((foldersRes.data as any).files ?? [])) {
          if (!aeFolder.id) continue
          const aeName = (aeFolder.name ?? '').trim()
          const aeNameLower = aeName.toLowerCase()

          const [sheetsRes, shortcutsRes] = await Promise.all([
            drive.files.list({
              q: `'${aeFolder.id}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
              fields: 'files(id,name)', pageSize: 50,
            }).catch(() => ({ data: { files: [] as any[] } })),
            drive.files.list({
              q: `'${aeFolder.id}' in parents and mimeType = 'application/vnd.google-apps.shortcut' and trashed = false`,
              fields: 'files(id,name,shortcutDetails)', pageSize: 50,
            }).catch(() => ({ data: { files: [] as any[] } })),
          ])

          const files: { name: string }[] = [
            ...((sheetsRes.data as any).files ?? []),
            ...((shortcutsRes.data as any).files ?? []).filter((f: any) =>
              (f.shortcutDetails?.targetMimeType ?? '').includes('spreadsheet')
            ),
          ]
          const nameOf = (suffix: string) =>
            files.find(f => f.name.toLowerCase().startsWith(aeNameLower) && f.name.toLowerCase().includes(suffix.toLowerCase()))

          const supportableFile = nameOf('supportable')
          const ccspFile        = nameOf('ccsp')
          const pipelineFile    = nameOf('pipeline')

          results.push({
            aeName,
            folderId: aeFolder.id,
            supportable: { found: !!supportableFile, fileName: supportableFile?.name },
            ccsp:        { found: !!ccspFile,        fileName: ccspFile?.name },
            pipeline:    { found: !!pipelineFile,    fileName: pipelineFile?.name },
          })
        }
      }

      return c.json({ results })
    } catch (e: any) {
      return c.json({ error: 'Drive file check failed — try again' }, 500)
    }
  })

  // POST /api/data-sources/add-folder — Connect an AE Drive folder
  router.post('/api/data-sources/add-folder', async (c) => {
    const { folderUrl } = await c.req.json<{ folderUrl: string }>()
    if (!folderUrl) return c.json({ error: 'folderUrl required' }, 400)

    const m = folderUrl.match(/\/folders\/([a-zA-Z0-9_-]{20,})/)
    const folderId = m ? m[1] : folderUrl.trim()
    if (!folderId) return c.json({ error: 'Could not extract folder ID from URL' }, 400)
    if (!m && !/^[a-zA-Z0-9_-]{25,60}$/.test(folderId)) return c.json({ error: 'Invalid folder ID or URL format' }, 400)

    try {
      const auth = makeAuth(GDRIVE_TOKEN_PATH_SRV)
      const drive = google.drive({ version: 'v3', auth })
      const meta = await drive.files.get({ fileId: folderId, fields: 'name' })
      const folderName = meta.data.name ?? ''

      const [foldersRes, sheetsRes] = await Promise.all([
        drive.files.list({ q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, fields: 'files(id)', pageSize: 50 }),
        drive.files.list({ q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`, fields: 'files(id)', pageSize: 50 }),
      ])

      // Load + migrate existing config
      let existing: { aeFolders: { folderId: string; folderName: string; connectedAt: string }[] } = { aeFolders: [] }
      try {
        const raw = JSON.parse(readFileSync(DATA_SOURCES_PATH_MODULE, 'utf-8'))
        existing.aeFolders = raw.aeFolders ?? (raw.aeFolderID ? [{ folderId: raw.aeFolderID, folderName: raw.folderName ?? '', connectedAt: raw.connectedAt ?? '' }] : [])
      } catch {}

      const connectedAt = new Date().toISOString()
      existing.aeFolders = existing.aeFolders.filter(f => f.folderId !== folderId)
      existing.aeFolders.push({ folderId, folderName, connectedAt })

      writeFileSyncRaw(DATA_SOURCES_PATH_MODULE, JSON.stringify(existing, null, 2), { mode: 0o600 })

      const allIds = existing.aeFolders.map(f => f.folderId)
      process.env.AE_PARENT_FOLDER_IDS = allIds.join(',')
      process.env.AE_PARENT_FOLDER_ID = allIds[0]

      return c.json({ ok: true, folderId, folderName, subfolderCount: (foldersRes.data.files ?? []).length, spreadsheetCount: (sheetsRes.data.files ?? []).length, connectedAt, totalFolders: existing.aeFolders.length })
    } catch (e: any) {
      return c.json({ error: 'Failed to connect Drive folder — check folder permissions' }, 500)
    }
  })

  // DELETE /api/data-sources/remove-folder — Remove a connected AE folder
  router.delete('/api/data-sources/remove-folder', async (c) => {
    const { folderId } = await c.req.json<{ folderId: string }>()
    if (!folderId) return c.json({ error: 'folderId required' }, 400)
    if (!/^[a-zA-Z0-9_-]{10,}$/.test(folderId)) return c.json({ error: 'Invalid folder ID format' }, 400)

    let existing: { aeFolders: { folderId: string; folderName: string; connectedAt: string }[] } = { aeFolders: [] }
    try {
      const raw = JSON.parse(readFileSync(DATA_SOURCES_PATH_MODULE, 'utf-8'))
      existing.aeFolders = raw.aeFolders ?? []
    } catch {}

    existing.aeFolders = existing.aeFolders.filter(f => f.folderId !== folderId)
    writeFileSyncRaw(DATA_SOURCES_PATH_MODULE, JSON.stringify(existing, null, 2), { mode: 0o600 })

    const allIds = existing.aeFolders.map(f => f.folderId)
    process.env.AE_PARENT_FOLDER_IDS = allIds.join(',')
    process.env.AE_PARENT_FOLDER_ID = allIds[0] ?? ''

    return c.json({ ok: true, remaining: existing.aeFolders.length })
  })

  // GET /api/data-sources/preview — Scan connected AE folders, report what was found
  router.get('/api/data-sources/preview', async (c) => {
    const parentIds = (process.env.AE_PARENT_FOLDER_IDS ?? process.env.AE_PARENT_FOLDER_ID ?? '').split(',').filter(Boolean)
    if (!parentIds.length) return c.json({ aeFolders: [] })

    try {
      const auth   = makeAuth(GDRIVE_TOKEN_PATH_SRV)
      const drive  = google.drive({ version: 'v3', auth })
      const sheets = google.sheets({ version: 'v4', auth })

      const result: {
        aeFolderName: string
        pipelineSheets: { name: string; rowCount: number }[]
        ccspFound: boolean
        customerTabs: string[]
      }[] = []

      for (const parentId of parentIds) {
        const foldersRes = await drive.files.list({
          q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: 'files(id,name)', pageSize: 50,
        }).catch(() => ({ data: { files: [] as any[] } }))

        for (const aeFolder of (foldersRes.data.files ?? [])) {
          if (!aeFolder.id) continue

          const sheetsRes = await drive.files.list({
            q: `'${aeFolder.id}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
            fields: 'files(id,name)', pageSize: 20,
          }).catch(() => ({ data: { files: [] as any[] } }))

          const pipelineSheets: { name: string; rowCount: number }[] = []
          let ccspFound = false
          const customerTabs: string[] = []

          for (const f of (sheetsRes.data.files ?? [])) {
            if (!f.id) continue
            const isPipeline = f.name?.toLowerCase().includes('pipeline') ?? false

            const meta = await sheets.spreadsheets.get({ spreadsheetId: f.id, fields: 'sheets.properties.title' })
              .catch(() => null)
            const tabs = (meta?.data.sheets ?? []).map((s: any) => s.properties?.title ?? '')

            if (isPipeline) {
              const valRes = await sheets.spreadsheets.values.get({ spreadsheetId: f.id, range: 'A1:A5000' }).catch(() => null)
              pipelineSheets.push({ name: f.name ?? '', rowCount: Math.max(0, (valRes?.data.values?.length ?? 1) - 1) })
            }

            for (const tab of tabs) {
              if (tab.toLowerCase().includes('ccsp')) ccspFound = true
              else if (!isPipeline) customerTabs.push(tab)
            }
          }

          result.push({ aeFolderName: aeFolder.name ?? '', pipelineSheets, ccspFound, customerTabs })
        }
      }

      return c.json({ aeFolders: result })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // POST /api/sheets/bootstrap-preview — Preview accounts discovered from AE folders or explicit URL.
  // Discovery order: (1) pipeline file by name, (2) explicit fileId, (3) territory spreadsheet tabs.
  router.post('/api/sheets/bootstrap-preview', async (c) => {
    const body = await c.req.json<{ fileId?: string }>().catch(() => ({} as { fileId?: string }))
    const parentIds = (process.env.AE_PARENT_FOLDER_IDS ?? process.env.AE_PARENT_FOLDER_ID ?? '').split(',').filter(Boolean)

    if (!parentIds.length && !body.fileId) {
      return c.json({ error: 'Connect AE folders in Step 1 or paste a pipeline sheet URL.' }, 400)
    }

    try {
      const auth   = makeAuth(GDRIVE_TOKEN_PATH_SRV)
      const drive  = google.drive({ version: 'v3', auth })
      const sheets = google.sheets({ version: 'v4', auth })

      const { accounts, source } = await discoverAccountsFromFolders(drive, sheets, parentIds, body.fileId)
      if (!accounts.length) return c.json({ error: 'No accounts found. Check your folder connection or paste a pipeline URL.' }, 400)

      accounts.sort((a, b) => a.name.localeCompare(b.name))
      return c.json({ accounts, source })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // POST /api/sheets/bootstrap — Import discovered accounts into customers.json.
  router.post('/api/sheets/bootstrap', async (c) => {
    const body = await c.req.json<{ fileId?: string }>().catch(() => ({} as { fileId?: string }))
    const parentIds = (process.env.AE_PARENT_FOLDER_IDS ?? process.env.AE_PARENT_FOLDER_ID ?? '').split(',').filter(Boolean)

    if (!parentIds.length && !body.fileId) {
      return c.json({ error: 'Connect AE folders in Step 1 or paste a pipeline sheet URL.' }, 400)
    }

    try {
      const auth   = makeAuth(GDRIVE_TOKEN_PATH_SRV)
      const drive  = google.drive({ version: 'v3', auth })
      const sheets = google.sheets({ version: 'v4', auth })

      const { accounts, source } = await discoverAccountsFromFolders(drive, sheets, parentIds, body.fileId)
      if (!accounts.length) return c.json({ error: 'No accounts found. Check your folder connection or paste a pipeline URL.' }, 400)

      accounts.sort((a, b) => a.name.localeCompare(b.name))
      const incoming = accounts.map(a => ({ name: a.name, ae: a.ae, domain: '', segment: a.segment ?? '', region: '', accountNumbers: [], ...(a.aliases?.length ? { aliases: a.aliases } : {}), ...(a.supportableFileId ? { supportableFileId: a.supportableFileId } : {}) }))
      // BKL-G27: preserve AI-enriched fields that live only in customers.json
      const existing = readExistingCustomers(CUSTOMERS_PATH)
      const imported = mergeCustomers(incoming as Record<string, any>[], existing)
      writeJsonAtomic(CUSTOMERS_PATH, { customers: imported })
      customers.splice(0, customers.length, ...imported as any[])
      return c.json({ imported: imported.length, source })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  return router
}
