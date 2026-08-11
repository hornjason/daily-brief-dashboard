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
import { readFileSync, readdirSync, unlinkSync, statSync } from 'fs'
import { resolve, join } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { getTelemetrySummary, getTelemetryLog } from './scraper-manager.ts'
import { getGeminiUsageSummary } from './gemini-cost-tracker.ts'
import { getWatcherState, rebuildFolderMap } from './drive-watcher.ts'
import { customers, aes } from './server-state.ts'
import { sanitizeErr, isValidDriveFolderId } from './utils.ts'
import { isPrimary } from './lib/node-role.ts'
import { shouldShowUpdate } from './lib/version-utils.ts'
import { runPurgeInactiveMigration } from './migrate-purge-inactive.ts'
import { syncTerritorySheet } from './territory-sync.ts'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { getAccountTeam, persistTeamCache } from './account-team.ts'
import { toSlug } from './cache-layer.ts'
import { computeDealAttribution } from './lib/deal-attribution.ts'
import { getHealthResults } from './startup-health-probe.ts'
import { generateTerritoryPartners, readTerritoryPartners, seedPartnersFromEcosystem } from './lib/territory-partner-generator.ts'
import { enrichTerritoryPartners } from './lib/partner-catalog-scraper.ts'

// ── Module state ─────────────────────────────────────────────────────────────
let SHEETS_TOKEN_PATH = ''
let CACHE_DIR = ''

export function initAdminRoutes(opts: { sheetsTokenPath: string; cacheDir: string }): void {
  SHEETS_TOKEN_PATH = opts.sheetsTokenPath
  CACHE_DIR = opts.cacheDir
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

export function _resetUpdateCheckCacheForTesting(): void {
  updateCheckCache = null
}

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

  // GET /api/admin/health — startup health probe results (#746)
  r.get('/api/admin/health', (c) => c.json(getHealthResults()))

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
    const force = c.req.query('force') === 'true'
    const now = Date.now()
    if (!force && updateCheckCache && (now - updateCheckCache.timestamp) < UPDATE_CHECK_CACHE_TTL) {
      return c.json(updateCheckCache.result)
    }

    // MUST use public repo — no auth token, hero installs are unauthenticated
    const url = 'https://api.github.com/repos/hornjason/daily-brief-dashboard/releases/latest'
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'DailyBriefDashboard' },
      })

      if (!res.ok) {
        console.warn('[update-check] GitHub API returned ' + res.status + ' for ' + url)
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

      updateCheckCache = { result, timestamp: now }

      return c.json(result)
    } catch (e) {
      console.warn('[update-check] fetch failed:', e)
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

  // POST /api/admin/migrate/purge-inactive — ADR-018: one-time migration to purge inactive customers
  r.post('/api/admin/migrate/purge-inactive', (c) => {
    try {
      const result = runPurgeInactiveMigration(CACHE_DIR)
      return c.json(result)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── Cache management (issue #117) ──────────────────────────────────────────

  const PROTECTED_FILES = new Set([
    'cases.json', 'ccsp-data.json', 'pipeline-data.json',
    'intelligence-jobs.json', 'morning-synthesis.json',
  ])

  const isProtected = (filename: string): boolean =>
    PROTECTED_FILES.has(filename) ||
    filename.endsWith('-sheets.json') ||
    filename.startsWith('.') ||
    filename.endsWith('.token') || filename.endsWith('.session')

  const categorizeFile = (filename: string): string | null => {
    if (isProtected(filename)) return null
    if (filename.endsWith('-meetings.json')) return 'meetings'
    if (filename.endsWith('-emails.json')) return 'emails'
    if (/^.+-20\d{2}-\d{2}-\d{2}\.json$/.test(filename)) return 'briefs'
    return null
  }

  const countFilesRecursive = (dir: string): { count: number; oldestAt: string | null; newestAt: string | null } => {
    let count = 0
    let oldestMs = Infinity
    let newestMs = -Infinity
    try {
      const walk = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue
          const full = join(d, entry.name)
          if (entry.isDirectory()) { walk(full); continue }
          if (!entry.name.endsWith('.json')) continue
          count++
          try {
            const mt = statSync(full).mtimeMs
            if (mt < oldestMs) oldestMs = mt
            if (mt > newestMs) newestMs = mt
          } catch { /* skip */ }
        }
      }
      walk(dir)
    } catch { /* dir may not exist */ }
    return {
      count,
      oldestAt: count > 0 ? new Date(oldestMs).toISOString() : null,
      newestAt: count > 0 ? new Date(newestMs).toISOString() : null,
    }
  }

  r.get('/api/admin/cache/status', (c) => {
    const cats: Record<string, { count: number; oldestAt: string | null; newestAt: string | null }> = {
      briefs: { count: 0, oldestAt: null, newestAt: null },
      meetings: { count: 0, oldestAt: null, newestAt: null },
      emails: { count: 0, oldestAt: null, newestAt: null },
      productIntel: { count: 0, oldestAt: null, newestAt: null },
      industryAnalysis: { count: 0, oldestAt: null, newestAt: null },
    }

    try {
      const files = readdirSync(CACHE_DIR)
      for (const file of files) {
        const cat = categorizeFile(file)
        if (!cat) continue
        try {
          const mt = statSync(resolve(CACHE_DIR, file)).mtimeMs
          const iso = new Date(mt).toISOString()
          cats[cat].count++
          if (!cats[cat].oldestAt || iso < cats[cat].oldestAt!) cats[cat].oldestAt = iso
          if (!cats[cat].newestAt || iso > cats[cat].newestAt!) cats[cat].newestAt = iso
        } catch { cats[cat].count++ }
      }
    } catch { /* CACHE_DIR may not exist */ }

    cats.productIntel = countFilesRecursive(resolve(CACHE_DIR, 'product-intel'))
    cats.industryAnalysis = countFilesRecursive(resolve(CACHE_DIR, 'industry-analysis'))

    return c.json(cats)
  })

  r.post('/api/admin/cache/clear', async (c) => {
    const body = await c.req.json<{ types?: string[] }>().catch(() => ({ types: [] as string[] }))
    const types: string[] = body.types ?? []
    const validTypes = new Set(['briefs', 'meetings', 'emails', 'productIntel', 'industryAnalysis', 'all'])
    const requested = types.filter((t: string) => validTypes.has(t))
    if (requested.length === 0) return c.json({ error: 'No valid types provided' }, 400)

    const isAll = requested.includes('all')
    const targetCats = isAll ? ['briefs', 'meetings', 'emails', 'productIntel', 'industryAnalysis'] : requested
    let cleared = 0

    if (targetCats.some((t: string) => ['briefs', 'meetings', 'emails'].includes(t))) {
      try {
        const files = readdirSync(CACHE_DIR)
        for (const file of files) {
          const cat = categorizeFile(file)
          if (!cat || !targetCats.includes(cat)) continue
          try { unlinkSync(resolve(CACHE_DIR, file)); cleared++ } catch { /* skip */ }
        }
      } catch { /* dir missing */ }
    }

    const clearDir = (subdir: string) => {
      const dir = resolve(CACHE_DIR, subdir)
      try {
        const walk = (d: string) => {
          for (const entry of readdirSync(d, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) continue
            const full = join(d, entry.name)
            if (!resolve(full).startsWith(resolve(dir))) continue
            if (entry.isDirectory()) { walk(full); continue }
            try { unlinkSync(full); cleared++ } catch { /* skip */ }
          }
        }
        walk(dir)
      } catch { /* dir missing */ }
    }

    if (targetCats.includes('productIntel')) clearDir('product-intel')
    if (targetCats.includes('industryAnalysis')) clearDir('industry-analysis')

    return c.json({ cleared, types: targetCats })
  })

  // POST /api/admin/territory-sync — trigger territory sync on demand
  r.post('/api/admin/territory-sync', async (c) => {
    if (aes.length === 0) return c.json({ error: 'No AEs configured' }, 400)
    try {
      const result = await syncTerritorySheet(aes, customers)
      if (result.teamData && Object.keys(result.teamData).length > 0) {
        persistTeamCache(result.teamData)
      }
      return c.json({
        added: result.toAdd.length,
        removed: result.toRemove.length,
        unchanged: result.unchanged.length,
        teamMembers: result.teamData ? Object.keys(result.teamData).length : 0,
      })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/customer/:name/team — resolved account team for a customer
  r.get('/api/customer/:name/team', (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find(cu => cu.name.toLowerCase() === rawName.toLowerCase())
      || customers.find(cu => toSlug(cu.name) === rawName)
    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    const productsParam = c.req.query('products')
    const filter = productsParam ? { products: productsParam.split(',').map(p => p.trim()) } : undefined
    const team = getAccountTeam(customer, filter)
    return c.json({ customer: customer.name, ae: customer.ae, team })
  })

  // GET /api/admin/territory-partners — list territory partners (#995)
  r.get('/api/admin/territory-partners', (c) => {
    try {
      const partners = readTerritoryPartners()
      return c.json(partners)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // POST /api/admin/territory-partners/refresh — seed from ecosystem + pipeline (#1002, #1001)
  r.post('/api/admin/territory-partners/refresh', (c) => {
    try {
      // Primary source: ecosystem catalog (130+ partners with resources)
      const ecoPartners = seedPartnersFromEcosystem()
      // Secondary: merge pipeline-extracted partners for loaded customers
      const customerNames = customers.map(cu => cu.name)
      const pipelinePartners = generateTerritoryPartners(undefined, undefined, customerNames)
      // Ecosystem seeding already wrote the file; pipeline merge wrote again
      // Return the final count
      return c.json({ count: pipelinePartners.length, ecosystemSeeded: ecoPartners.length })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // POST /api/admin/territory-partners/enrich — catalog.redhat.com enrichment (#997)
  r.post('/api/admin/territory-partners/enrich', async (c) => {
    try {
      const enriched = await enrichTerritoryPartners()
      return c.json({ enriched })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/admin/deal-attribution — deal outcome tracking (#614)
  // Returns attribution data across all customers: which deals had prior intelligence activity
  r.get('/api/admin/deal-attribution', (c) => {
    const allCustomers = customers
    const allAttributions = []
    let dealsWithIntel = 0

    for (const customer of allCustomers) {
      const slug = toSlug(customer.name)
      const attributions = computeDealAttribution(slug, CACHE_DIR)
      for (const attr of attributions) {
        allAttributions.push(attr)
        if (attr.attributionScore !== 'none') dealsWithIntel++
      }
    }

    const breakdown = { strong: 0, moderate: 0, weak: 0, none: 0 }
    for (const attr of allAttributions) {
      breakdown[attr.attributionScore]++
    }

    return c.json({
      totalDeals: allAttributions.length,
      dealsWithPriorIntelligence: dealsWithIntel,
      attributionBreakdown: breakdown,
      deals: allAttributions,
    })
  })

  return r
}
