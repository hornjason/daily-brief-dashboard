/**
 * BKL-ARCH-12 — Admin / monitoring / Drive route module.
 *
 * Extracts 8 admin and monitoring route handlers from server.ts into a
 * standalone module following the established createXRouter(): Hono factory pattern.
 *
 * Routes registered:
 *   GET  /api/status/telemetry           — summary stats per scraper service
 *   GET  /api/status/telemetry/history   — full per-service scrape log (last 100)
 *   GET  /api/admin/gemini-usage         — Gemini cost tracker summary
 *   GET  /api/version                    — application version from package.json
 *   GET  /api/drive-watcher/status       — Drive watcher state
 *   POST /api/drive-watcher/rebuild      — rebuild Drive folder map
 *   GET  /api/drive/ls/:folderId         — list Drive folder contents (diagnostic)
 *   GET  /debug/sheet-tabs/:fileId       — list sheet tabs for a file (non-production only)
 *
 * Pure structural refactor — zero behavior changes from the in-server versions.
 * APP_VERSION computation moved from server.ts module scope into this module.
 */
import { Hono } from 'hono'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { getTelemetrySummary, getTelemetryLog } from './scraper-manager.ts'
import { getGeminiUsageSummary } from './gemini-cost-tracker.ts'
import { getWatcherState, rebuildFolderMap } from './drive-watcher.ts'
import { customers } from './server-state.ts'
import { sanitizeErr, isValidDriveFolderId } from './utils.ts'
import { isPrimary } from './lib/node-role.ts'
import { shouldShowUpdate } from './lib/version-utils.ts'

// ── Module state ─────────────────────────────────────────────────────────────
let SHEETS_TOKEN_PATH = ''

export function initAdminRoutes(opts: { sheetsTokenPath: string }): void {
  SHEETS_TOKEN_PATH = opts.sheetsTokenPath
}

// ── Update check cache (24 hours) ────────────────────────────────────────────
interface UpdateCheckResult {
  updateAvailable: boolean
  currentVersion: string
  latestVersion: string
  releaseUrl: string
}

let updateCheckCache: { result: UpdateCheckResult; timestamp: number } | null = null
const UPDATE_CHECK_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours in ms

// ── APP_VERSION (moved from server.ts) ───────────────────────────────────────
export const APP_VERSION: string = (() => {
  try {
    // __dirname is not available in ESM — use import.meta.dir (Bun-specific)
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, '..', 'package.json'), 'utf-8'))
    return pkg.version ?? '1.0.0'
  } catch { return '1.0.0' }
})()

// ── Route factory ─────────────────────────────────────────────────────────────

export function createAdminRouter(): Hono {
  const r = new Hono()

  // GET /api/status/telemetry — summary stats per service (last run, success rate, avg duration)
  r.get('/api/status/telemetry', (c) => c.json(getTelemetrySummary()))

  // GET /api/status/telemetry/history — full per-service scrape log (last 100 per service)
  r.get('/api/status/telemetry/history', (c) => c.json(getTelemetryLog()))

  // GET /api/admin/gemini-usage — Gemini cost tracker summary (BKL-M52)
  r.get('/api/admin/gemini-usage', (c) => {
    return c.json(getGeminiUsageSummary())
  })

  // GET /api/version — application version
  r.get('/api/version', (c) => {
    const imageTag = process.env.IMAGE_TAG ?? 'dev'
    return c.json({ version: APP_VERSION, imageTag })
  })

  // GET /api/updates/check — check for newer version on GitHub (24h cache)
  r.get('/api/updates/check', async (c) => {
    // Check cache first
    const now = Date.now()
    if (updateCheckCache && (now - updateCheckCache.timestamp) < UPDATE_CHECK_CACHE_TTL) {
      return c.json(updateCheckCache.result)
    }

    try {
      // Fetch latest release from GitHub
      const res = await fetch('https://api.github.com/repos/hornjason/asaCommandCenter/releases/latest', {
        headers: { 'User-Agent': 'DailyBriefDashboard' },
      })

      if (!res.ok) {
        // Graceful degradation: if GitHub API unreachable, return no update
        return c.json({
          updateAvailable: false,
          currentVersion: APP_VERSION,
          latestVersion: APP_VERSION,
          releaseUrl: '',
        })
      }

      const data = await res.json() as { tag_name?: string; html_url?: string }
      const latestVersion = data.tag_name ?? APP_VERSION
      const releaseUrl = data.html_url ?? ''

      const result: UpdateCheckResult = {
        updateAvailable: shouldShowUpdate(APP_VERSION, latestVersion),
        currentVersion: APP_VERSION,
        latestVersion,
        releaseUrl,
      }

      // Update cache
      updateCheckCache = { result, timestamp: now }

      return c.json(result)
    } catch (e) {
      // Graceful degradation: if fetch fails, return no update (no error)
      return c.json({
        updateAvailable: false,
        currentVersion: APP_VERSION,
        latestVersion: APP_VERSION,
        releaseUrl: '',
      })
    }
  })

  // GET /api/drive-watcher/status — Drive watcher state
  r.get('/api/drive-watcher/status', (c) => {
    const state = getWatcherState()
    if (!state) return c.json({ enabled: false, folderMap: [], lastChecked: null, builtAt: null })
    return c.json({
      enabled: state.enabled,
      folderMap: state.folderMap,
      lastChecked: state.lastChecked ?? null,
      builtAt: state.builtAt,
    })
  })

  // POST /api/drive-watcher/rebuild — rebuild Drive folder map
  r.post('/api/drive-watcher/rebuild', async (c) => {
    if (!isPrimary()) return c.json({ error: 'Not available on hero nodes' }, 404)
    const parentIds = (process.env.AE_PARENT_FOLDER_IDS ?? process.env.AE_PARENT_FOLDER_ID ?? '').split(',').filter(Boolean)
    try {
      const folderMap = await rebuildFolderMap(customers, parentIds)
      return c.json({ rebuilt: true, folders: folderMap.length, map: folderMap })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/drive/ls/:folderId — diagnostic: list contents of a Drive folder by ID
  r.get('/api/drive/ls/:folderId', async (c) => {
    const folderId = c.req.param('folderId')
    // BKL-SEC-20: validate before interpolating into Drive query string
    if (!isValidDriveFolderId(folderId)) return c.json({ error: 'Invalid folder ID' }, 400)
    try {
      const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
      const drive = google.drive({ version: 'v3', auth })
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id,name,mimeType,modifiedTime)',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      })
      return c.json({ folderId, items: res.data.files ?? [] })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /debug/sheet-tabs/:fileId — list sheet tabs (non-production only)
  r.get('/debug/sheet-tabs/:fileId', async (c) => {
    if (process.env.NODE_ENV === 'production') return c.json({ error: 'Not available' }, 404)
    const fileId = c.req.param('fileId')
    if (!/^[a-zA-Z0-9_-]{10,60}$/.test(fileId ?? '')) return c.json({ error: 'Invalid file ID' }, 400)
    const { makeAuth: _makeAuth } = await import('./google.ts')
    const { google: _google } = await import('googleapis')
    const auth = _makeAuth(SHEETS_TOKEN_PATH)
    const sheets = _google.sheets({ version: 'v4', auth })
    try {
      const res = await sheets.spreadsheets.get({ spreadsheetId: fileId, fields: 'sheets.properties.title' })
      const tabs = (res.data.sheets ?? []).map((s: any) => s.properties?.title ?? '')
      return c.json({ fileId, tabs })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  return r
}
