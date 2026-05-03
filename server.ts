import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bodyLimit } from 'hono/body-limit'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { renameSync } from 'fs'
import { resolve } from 'path'
import { fetchEmail, fetchDrive, fetchCalendar } from './src/google.ts'
import { fetchCases, getTokenTelemetry } from './src/redhat.ts'
import { fetchCasesViaSolr } from './src/rh-cases-api.ts'
import { getConfiguredTransport } from './src/case-client.ts'
import type { Customer } from './src/types.ts'
import { startLoginBrowser, cancelLoginBrowser, getRhStatus, recordScrapeExpired } from './src/rh-auth.ts'
import { closeScrapeContext, getScrapeContext, getLivePage, setSessionExpiredCallback, setContextRecoveryCallback } from './src/rh-scraper.ts'

import { runSfPipelineSync, getSfContext, adoptSfContext, initSfSyncFromCache } from './src/sf-scraper.ts'
import { startSfLoginBrowser, cancelSfLoginBrowser } from './src/sf-auth.ts'
import { runSupportableScrape, writeSupportableSheet, supportableScrapeRunning, adoptSupportableContext } from './src/supportable-scraper.ts'
import type { SupportableCustomer } from './src/supportable-scraper.ts'
import { runCcspScrape, writeCcspSheet, ccspScrapeRunning, adoptCcspContext } from './src/ccsp-scraper.ts'
import { initCacheLayer, createCacheRouter, readSheetCache, readPipelineCache } from './src/cache-layer.ts'
import { initSettingsApi, createSettingsRouter } from './src/settings-api.ts'
import { createNodeRoleRouter } from './src/node-role-routes.ts'
import { createRegionAccessRouter } from './src/region-access-routes.ts'
import { initAuthRoutes, createAuthRouter } from './src/auth-routes.ts'
// ── M02 extracted modules ───────────────────────────────────────────────────
import { loadServerState, aes, customers, setAes, setCustomers, patchAe, AES_PATH, CUSTOMERS_PATH } from './src/server-state.ts'
import { initRefreshEngine, createRefreshRouter, refreshSubscriptions, refreshCCSP, refreshPipeline } from './src/refresh-engine.ts'
import { initScraperManager, createScraperRouter, runRhScrapeWithState, runSfSyncForAes, ccspInFlight, setCcspInFlight, setSfSyncLastError } from './src/scraper-manager.ts'
import { initScrapeApi, registerScrapeRoutes } from './src/scrape-api.ts'
import { rescheduleRefreshTimers, initBackgroundScheduler, enqueueScraperTask, scheduleProductIntelRefresh } from './src/background-scheduler.ts'
import { initDashboardRoutes, createDashboardRouter } from './src/dashboard-routes.ts'
// ── M03 extracted modules ───────────────────────────────────────────────────
import { createBootstrapRouter, resetBootstrapStates } from './src/bootstrap-orchestrator.ts'
// ── M04 extracted modules ───────────────────────────────────────────────────
import { createSheetImportRouter } from './src/sheet-import.ts'
import { createDriveSourcesRouter } from './src/drive-sources.ts'
import { sanitizeErr, isValidDriveFolderId, notify, liveProbe } from './src/utils.ts'
import { deriveConfidence, ConnectionHealthSchema } from './src/connection-health.ts'
// ── M05 extracted modules ───────────────────────────────────────────────────
import { initSetupRoutes, createSetupRouter, runStartupDriveMerge } from './src/setup-routes.ts'
// ── BKL-ARCH-10: AE management routes ───────────────────────────────────────
import { initAeRoutes, createAeRouter } from './src/ae-routes.ts'
// ── BKL-ARCH-12: Admin / monitoring / Drive routes ───────────────────────────
import { initAdminRoutes, createAdminRouter } from './src/admin-routes.ts'
import { initCustomerRoutes, createCustomerRouter } from './src/customer-routes.ts'
import { createProductIntelRouter } from './src/product-intel-routes.ts'
import { initRestoreRoutes, createRestoreRouter } from './src/restore-routes.ts'
import { createBackupRouter } from './src/backup-routes.ts'
import { initJobPersistence } from './src/account-intelligence.ts'
// ── BKL-UX52: Multi-pod support ───────────────────────────────────────────
import { readPodConfig, getAeNamesForPod } from './src/pod-config.ts'
import { computeAllAttentionScores } from './src/attention-score.ts'
// ── Region config (for parentFolderId / Drive distribution) ───────────────
import { onCacheLevel, offCacheLevel, type IngestCacheEvent } from './src/ingest-events.js'
import { onAIEvent, offAIEvent, type AIIntelEvent } from './src/ai-events.js'

// Safety net: log unhandled promise rejections instead of crashing Bun
// (council decision 2026-04-03 — Playwright download promises can reject after page death)
process.on('unhandledRejection', (reason: any) => {
  console.error('[server] unhandled rejection:', reason?.message ?? reason)
})

// ── Load shared state from server-state.ts ──────────────────────────────────
loadServerState()

/** Extract Tableau territory segment from a full Tableau dashboard URL. */
function extractTableauTerritory(url: string): string | null {
  // URL form: .../CloudConsumption/{guid}/{territory}?...
  const match = url.match(/\/CloudConsumption\/[^/]+\/([^?#]+)/)
  return match?.[1] ?? null
}

// ── Cache helpers ─────────────────────────────────────────────────────────────
const CACHE_DIR = process.env.CACHE_DIR ?? resolve(import.meta.dir, 'cache')
mkdirSync(CACHE_DIR, { recursive: true })

const SHEETS_SYNC_PATH = process.env.CONFIG_DIR
  ? resolve(process.env.CONFIG_DIR, 'sheets-sync.json')
  : resolve(import.meta.dir, 'config/sheets-sync.json')

const DATA_SOURCES_PATH = process.env.CONFIG_DIR
  ? resolve(process.env.CONFIG_DIR, 'data-sources.json')
  : resolve(import.meta.dir, 'config/data-sources.json')

// Load data-sources config (sets AE_PARENT_FOLDER_IDS from saved setup)
try {
  const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
  // Support both new array format and old single-folder format
  const folders: { folderId: string }[] = ds.aeFolders ?? (ds.aeFolderID ? [{ folderId: ds.aeFolderID }] : [])
  const ids = folders.map((f: { folderId: string }) => f.folderId).filter(Boolean)
  if (ids.length) {
    if (!process.env.AE_PARENT_FOLDER_IDS) process.env.AE_PARENT_FOLDER_IDS = ids.join(',')
    if (!process.env.AE_PARENT_FOLDER_ID) process.env.AE_PARENT_FOLDER_ID = ids[0]
  }
} catch (e: any) { console.warn('[startup] could not read AE folder IDs:', e.message) }

// Load REDHAT_OFFLINE_TOKEN from data-sources.json if not already set via .env
// (BKL-RH-UX-01: allows token to be saved via the UI without requiring a container restart)
try {
  const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
  const persisted = typeof ds.redhatOfflineToken === 'string' ? ds.redhatOfflineToken : null
  if (persisted && !process.env.REDHAT_OFFLINE_TOKEN) {
    process.env.REDHAT_OFFLINE_TOKEN = persisted
    console.log('[startup] REDHAT_OFFLINE_TOKEN loaded from data-sources.json')
  }
} catch { /* file missing at startup — skip silently */ }

const SRV_CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, 'config')
const SETTINGS_PATH = resolve(SRV_CONFIG_DIR, 'settings.json')
const SHEETS_TOKEN_PATH_SRV = process.env.SHEETS_TOKEN
  ?? resolve(SRV_CONFIG_DIR, '.sheets-token.json')
const GDRIVE_TOKEN_PATH_SRV = process.env.GDRIVE_TOKEN
  ?? resolve(SRV_CONFIG_DIR, '.gdrive-server-credentials.json')


const RH_SESSION_PATH = process.env.RH_SESSION
  ?? resolve(SRV_CONFIG_DIR, '.rh-session.json')
const RH_PROFILE_DIR = process.env.RH_PROFILE_DIR
  ?? resolve(SRV_CONFIG_DIR, '.rh-chrome-profile')
const RH_CASES_CACHE_PATH = resolve(CACHE_DIR, 'cases.json')
initCacheLayer(CACHE_DIR, RH_CASES_CACHE_PATH)
initSfSyncFromCache(readPipelineCache)
initJobPersistence(CACHE_DIR)
initDashboardRoutes({ cacheDir: CACHE_DIR, rhCasesCachePath: RH_CASES_CACHE_PATH, dataSourcesPath: DATA_SOURCES_PATH })
initSettingsApi(DATA_SOURCES_PATH, SETTINGS_PATH)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'your-admin@example.com'
const SF_REPORT_ID   = process.env.SF_REPORT_ID ?? ''
const SF_SESSION_PATH = process.env.SF_SESSION
  ?? resolve(SRV_CONFIG_DIR, '.sf-session.json')
initSetupRoutes({
  srvConfigDir: SRV_CONFIG_DIR,
  cacheDir: CACHE_DIR,
  customersPath: CUSTOMERS_PATH,
  sheetsSyncPath: SHEETS_SYNC_PATH,
  dataSourcesPath: DATA_SOURCES_PATH,
  adminEmail: ADMIN_EMAIL,
})
initCustomerRoutes({ cacheDir: CACHE_DIR, customersPath: CUSTOMERS_PATH })
initRestoreRoutes({ cacheDir: CACHE_DIR })
initAuthRoutes({
  rhSessionPath: RH_SESSION_PATH,
  rhProfileDir: RH_PROFILE_DIR,
  rhCasesCachePath: RH_CASES_CACHE_PATH,
  sfSessionPath: SF_SESSION_PATH,
})
initAeRoutes({ cacheDir: CACHE_DIR, settingsPath: SETTINGS_PATH })
initAdminRoutes({ sheetsTokenPath: SHEETS_TOKEN_PATH_SRV })

const app = new Hono()

// ── Private helpers moved to src/ae-routes.ts (BKL-ARCH-10) ─────────────────
// normalizeCustomerName, isValidSfId, extractSfReportId

// ── Request body size limit ───────────────────────────────────────────────────
// Uses actual stream measurement — not spoofable via missing Content-Length header

app.use('*', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }))

// ── Security headers middleware ───────────────────────────────────────────────

app.use('*', async (c, next) => {
  await next()
  c.header('X-Frame-Options', 'DENY')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'")
})

// Health check — used by container health probes and smoke tests
app.get('/health', (c) => c.json({
  status: 'ok',
  timestamp: new Date().toISOString(),
  aes: aes.length,
  customers: customers.length,
  session: !!getScrapeContext(),
  sfSession: !!getSfContext(),
  ccspSession: !!getScrapeContext(),   // ccsp shares RH SSO context
}))

app.route('/', createCacheRouter())
app.route('/', createDashboardRouter())
app.route('/', createSetupRouter())
app.route('/', createCustomerRouter())
// ── Wave 4: Product Intelligence routes ─────────────────────────────────────
app.route('/', createProductIntelRouter())
app.route('/', createRestoreRouter())
app.route('/', createAuthRouter())
app.route('/', createAeRouter())
app.route('/', createAdminRouter())

// Redirect root to command center
app.get('/', (c) => c.redirect('/dashboard'))

// Customer list for landing page — includes confidenceScore placeholder (BKL-AI28)
app.get('/customers', (c) => c.json(customers.filter(cu => !cu.inactive).map(cu => ({ ...cu, confidenceScore: null }))))

// ── Google OAuth + Setup wizard routes (extracted to src/setup-routes.ts) ──

// ── Red Hat Portal auth endpoints (extracted to src/auth-routes.ts) ──────────

// POST /api/auth/redhat/sync — REMOVED (BKL-M25): use POST /api/scrape/rh instead
// POST /api/auth/redhat/discover — REMOVED: account discovery uses Supportable APEX only (POST /api/scrape/supportable/discover)

// POST /api/test/accountname-search — Call search/v2/cases API directly with accountName SOLR query
// Body: { customers: string[] }
app.post('/api/test/accountname-search', async (c) => {
  if (process.env.NODE_ENV === 'production') return c.json({ error: 'Not available' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const customers: string[] = body.customers ?? ['A10 Networks', 'Dropbox', 'Crowdstrike']
  const ctx = getScrapeContext()
  if (!ctx) return c.json({ error: 'No active RH session' }, 409)
  const page = getLivePage() ?? await ctx.newPage()

  // Ensure we're on the portal so cookies are active
  if (!page.url().includes('access.redhat.com')) {
    await page.goto('https://access.redhat.com/support/cases/#/case/list', {
      waitUntil: 'domcontentloaded', timeout: 30_000,
    }).catch(() => {})
    await page.waitForTimeout(3_000)
  }

  const results: Record<string, any> = {}

  // Use the exact expression captured from portal network traffic
  const EXPRESSION = 'sort=case_lastModifiedDate%20desc&facet=true&facet.mincount=0&facet.pivot.mincount=0&facet.sort=index&f.case_product.facet.limit=-1&f.case_version.facet.pivot.limit=-1&f.case_version.facet.pivot.mincount=1&fl=case_createdByName%2Ccase_createdDate%2Ccase_lastModifiedDate%2Ccase_lastModifiedByName%2Cid%2Curi%2Ccase_summary%2Ccase_status%2Ccase_product%2Ccase_version%2Ccase_accountNumber%2Ccase_number%2Ccase_contactName%2Ccase_owner%2Ccase_severity%2Ccase_last_public_update_date%2Ccase_last_public_update_by%2Ccase_customer_escalation%2Ccase_folderName%2Ccase_alternate_id%2Ccase_type%2Ccase_closedDate&facet.field=%7B!ex%3Dc_product%7Dcase_product&facet.field=%7B!ex%3Dc_severity%7Dcase_severity&facet.field=%7B!ex%3Dc_status%7Dcase_status&facet.field=%7B!ex%3Dc_type%7Dcase_type&facet.pivot=%7B!ex%3Dc_product%7Dcase_product%2Ccase_version&fq=%7B!tag%3Dc_product%7D*%3A*'

  // Test queries: get all fields to discover the account name field name, then try variants
  const testQueries = customers.flatMap(name => [
    { label: `${name} [all-fields sample]`, q: '*:*', fl: '*' },
    { label: `${name} [accountName]`, q: `accountName: "${name}"`, fl: null },
    { label: `${name} [case_accountName]`, q: `case_accountName: "${name}"`, fl: null },
    { label: `${name} [account_name]`, q: `account_name: "${name}"`, fl: null },
    { label: `${name} [contactName]`, q: `contactName: "${name}"`, fl: null },
  ])

  for (const { label, q, fl } of testQueries) {
    const apiResult = await page.evaluate(async ({ q, fl, expression }: { q: string; fl: string | null; expression: string }) => {
      try {
        // Build expression: if fl override provided, replace the fl= portion
        let expr = expression
        if (fl) {
          expr = expr.replace(/fl=[^&]+/, `fl=${encodeURIComponent(fl)}`)
        }
        const res = await fetch(
          `https://access.redhat.com/hydra/rest/search/v2/cases?redhat_client=Portal%20Case%20Management%202.44.57&account_number=901532`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q, start: 0, rows: 2, partnerSearch: false, expression: expr }),
          }
        )
        const text = await res.text()
        if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
        return { data: JSON.parse(text) }
      } catch (e: any) {
        return { error: sanitizeErr(e) }
      }
    }, { q, fl: fl ?? null, expression: EXPRESSION })

    if (apiResult.error) { results[label] = { error: apiResult.error }; continue }

    const data = apiResult.data
    const docs: any[] = data?.response?.docs ?? []
    const numFound: number = data?.response?.numFound ?? 0
    const accountNumbers = [...new Set(docs.map((d: any) => d.case_accountNumber).filter(Boolean))]

    results[label] = {
      numFound,
      docCount: docs.length,
      accountNumbers,
      // For wildcard/all-fields queries: show sorted field names for discovery
      allFieldNames: fl ? docs.flatMap((d: any) => Object.keys(d)).filter((v, i, a) => a.indexOf(v) === i).sort() : undefined,
      sampleDoc: fl ? docs[0] ?? null : undefined,
    }

    // Skip wildcard for remaining customers (only needed once to confirm API works)
    if (q === '*:*' && Object.keys(results).length >= 1) {
      // Continue testing accountName/case_accountName queries for all customers
    }
  }

  return c.json(results)
})

// POST /api/test/supportable-customer-search — Search Supportable by customer name, return account numbers
// Body: { customerName: string }  e.g. { customerName: "Dropbox" }
app.post('/api/test/supportable-customer-search', async (c) => {
  if (process.env.NODE_ENV === 'production') return c.json({ error: 'Not available' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const customerName: string = body.customerName ?? 'Dropbox'
  const ctx = getScrapeContext()
  if (!ctx) return c.json({ error: 'No active RH session' }, 409)

  const SUPPORTABLE_URL = 'https://supportable.corp.redhat.com:4443/pls/rhapplications/f?p=304:1'
  let page = await ctx.newPage()

  try {
    // Mirror the existing Supportable scraper's navigation + SSO handling exactly
    await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(3_000)

    if (!page.url().includes('supportable.corp.redhat.com')) {
      // SSO redirect — page will navigate back or close
      let pageClosedByApex = false
      const closePromise = new Promise<void>(resolve => { page.once('close', () => { pageClosedByApex = true; resolve() }) })
      await Promise.race([
        page.waitForURL(/supportable\.corp\.redhat\.com/, { timeout: 120_000 }).catch(() => {}),
        closePromise,
      ])
      if (pageClosedByApex) page = await ctx.newPage()
      // Fresh navigation after SSO
      await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3_000)
    }

    if (!page.url().includes('supportable.corp.redhat.com')) {
      await page.close()
      return c.json({ error: 'Supportable SSO failed', url: page.url() }, 409)
    }

    // Fill Customer Name field — APEX naming convention: P0_CUSTOMER_NAME
    // Wildcard % matches any suffix (standard Oracle LIKE syntax)
    let fieldId = 'P0_CUSTOMER_NAME'
    let filled = false
    for (const candidate of ['P0_CUSTOMER_NAME', 'P0_CUST_NAME', 'P0_CUSTOMER']) {
      const el = await page.$(`input#${candidate}`).catch(() => null)
      if (el) { fieldId = candidate; filled = true; break }
    }
    if (!filled) {
      // Dump visible inputs to help identify the right field
      const inputDump = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input')).map(el => ({
          id: el.id, name: (el as HTMLInputElement).name,
          label: document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() ?? '',
        })).filter(f => f.id || f.name)
      ).catch(() => [])
      await page.close()
      return c.json({ error: 'Customer Name input not found — try one of these IDs', inputDump })
    }

    await page.fill(`input#${fieldId}`, `${customerName}%`)
    console.log(`[test/supportable] Filled #${fieldId} with "${customerName}%"`)
    await page.click('button.button-alt1')
    // APEX does a server-side POST + redirect chain — wait for full settle
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(5_000)

    // Scrape the results table — retry if APEX is still navigating
    let tableData: any = null
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        tableData = await page.evaluate(() => { return 'PROBE_OK' })
        break
      } catch {
        console.log(`[test/supportable] results page still navigating (attempt ${attempt + 1}) — waiting…`)
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
        await page.waitForTimeout(3_000)
      }
    }
    if (!tableData) { await page.close(); return c.json({ error: 'Results page never settled after 4 attempts' }) }

    tableData = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'))
      // APEX IR result tables use <th> headers — search for party/customer/entl headers
      for (const t of tables) {
        const ths = Array.from(t.querySelectorAll('th'))
          .map(el => el.textContent?.trim().replace(/\s+/g, ' ') ?? '')
        if (ths.some(h => /party.?number|customer.?number|entl/i.test(h))) {
          const rownumIdx = ths.indexOf('Rownum')
          const rows = Array.from(t.querySelectorAll('tr')).slice(1).flatMap(tr => {
            const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim().replace(/\s+/g, ' ') ?? '')
            // Skip APEX count rows and empty rows — data rows have a numeric Rownum cell
            if (!cells.some(c => c)) return []
            if (rownumIdx >= 0 && !/^\d+$/.test(cells[rownumIdx] ?? '')) return []
            if (cells.length < ths.length - 2) return []  // too few cells
            const obj: Record<string, string> = {}
            ths.forEach((h, i) => { obj[h] = cells[i] ?? '' })
            return [obj]
          })
          return { headers: ths, rows }
        }
      }
      // Debug: show what tables exist and their header structures
      return {
        error: `No results table found (${tables.length} tables)`,
        tableCount: tables.length,
        tableDebug: tables.slice(0, 8).map(t => ({
          cls: t.className.slice(0, 60),
          ths: Array.from(t.querySelectorAll('th')).slice(0, 6).map(th => th.textContent?.trim().slice(0, 30) ?? ''),
        })),
      }
    })

    await page.close()

    if ('error' in tableData) return c.json({ customerName, fieldId, tableData })

    // Filter: Country = Web or USA, Entl Active Cnt > 0
    const filtered = (tableData.rows as Record<string, string>[]).filter(row => {
      const country = (row['Country'] ?? '').trim()
      const entlActive = parseInt(row['Entl Active Cnt'] ?? row['Entl\nActive\nCnt'] ?? '0', 10)
      return (country === 'Web' || country === 'USA') && entlActive > 0
    })

    const accountNumbers = [...new Set(
      filtered.map(r => r['Customer Number'] ?? r['CustomerNumber'] ?? '').filter(Boolean)
    )]

    return c.json({
      customerName,
      fieldId,
      totalRows: (tableData.rows as any[]).length,
      filteredRows: filtered.length,
      accountNumbers,
      headers: tableData.headers,
      allRows: (tableData.rows as any[]).slice(0, 10),
    })
  } catch (e: any) {
    await page.close().catch(() => {})
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// ── Salesforce login endpoints (extracted to src/auth-routes.ts) ─────────────

// ── Scraper routes (M02 — registered from scraper-manager.ts) ──────────────
app.route('/', createScraperRouter())

// ── Unified scrape API (BKL-M25 — registered from scrape-api.ts) ───────────
registerScrapeRoutes(app)

// ── BKL-M50e: Scraper telemetry routes (extracted to src/admin-routes.ts — BKL-ARCH-12)

// ── Auto-bootstrap + Tableau routes (M03 — registered from bootstrap-orchestrator.ts) ──
app.route('/', createBootstrapRouter())

// ── Drive data-sources + Sheet import routes (M04 — registered from drive-sources.ts + sheet-import.ts) ──
app.route('/', createDriveSourcesRouter())
app.route('/', createSheetImportRouter())


// ── Dashboard API endpoints ──────────────────────────────────────────────────

// GET /api/config — Dashboard configuration and provider status
// ── Territory notifications API ───────────────────────────────────────────────

app.get('/api/territory/notifications', async (c) => {
  const notifPath = resolve(process.env.DATA_DIR ?? 'data', 'cache', 'territory-notifications.json')
  try {
    if (!existsSync(notifPath)) return c.json({ updatedAt: null, pending: [] })
    const data = JSON.parse(readFileSync(notifPath, 'utf-8'))
    return c.json(data)
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// ── Config backup routes (BKL-BACKUP-01) ────────────────────────────────────
app.route('/', createBackupRouter())

// ── Gemini cost tracking + Version API (extracted to src/admin-routes.ts — BKL-ARCH-12)

// ── AE Config API (extracted to src/ae-routes.ts) ────────────────────────────

// GET /api/settings/from-drive, /api/config, /api/config/test (extracted to src/settings-api.ts — BKL-ARCH-11)

// ── BKL-UX52: Pod configuration endpoint ─────────────────────────────────────
app.get('/api/pods', (c) => {
  const pods = readPodConfig(DATA_SOURCES_PATH, aes)
  return c.json({ pods: pods.map(p => ({ id: p.id, name: p.name, aeNames: p.aeNames })) })
})

// GET /api/accounts — All customers with cached sheet data merged
// BKL-UX52: Accepts ?pod=<id> to filter by pod; adds attentionScore + attentionReasons
app.get('/api/accounts', (c) => {
  const podId = c.req.query('pod') ?? undefined

  // Determine which AE names to include based on pod filter
  let aeNamesToInclude: Set<string> | null = null
  if (podId) {
    const pods = readPodConfig(DATA_SOURCES_PATH, aes)
    const names = getAeNamesForPod(pods, podId)
    aeNamesToInclude = new Set(names)
  }

  // Filter customers by pod (AE membership)
  let filteredCustomers = customers.filter(cu => !cu.inactive)
  if (aeNamesToInclude) {
    filteredCustomers = filteredCustomers.filter(cu => cu.ae && aeNamesToInclude!.has(cu.ae))
  }

  // Compute attention scores for filtered customers
  let allCases: any[] = []
  try {
    const raw = JSON.parse(readFileSync(RH_CASES_CACHE_PATH, 'utf-8'))
    allCases = raw.cases ?? []
  } catch { /* no cases cache */ }

  const pipelineData = readPipelineCache()
  const allPipeline = pipelineData?.records ?? []

  const attentionScores = computeAllAttentionScores(filteredCustomers, allCases, allPipeline)

  const result = filteredCustomers.map((customer) => {
    const cached = readSheetCache(customer.name)
    const products = cached?.rows ?? []
    const distinctProducts = new Set(products.map((p) => p.productDescription)).size
    const totalLicenses = products.reduce((sum, p) => sum + p.quantity, 0)
    const attention = attentionScores.get(customer.name)

    return {
      name: customer.name,
      domain: customer.domain ?? '',
      accountNumbers: customer.accountNumbers ?? [],
      ae: customer.ae ?? '',
      segment: customer.segment ?? '',
      products,
      productCount: distinctProducts,
      totalLicenses,
      cachedAt: cached?.cachedAt ?? null,
      ccspCustomer: customer.ccspCustomer ?? false,
      attentionScore: attention?.attentionScore ?? 0,
      attentionReasons: attention?.attentionReasons ?? [],
      needsManualDomain: customer.needsManualDomain ?? false,
    }
  })
  return c.json({ customers: result })
})

// ── Setup wizard routes (extracted to src/setup-routes.ts) ───────────────────

// ── Customer data routes (extracted to src/customer-routes.ts) ───────────────

// ── Serve React dashboard SPA ────────────────────────────────────────────────
const DASHBOARD_DIST = resolve(import.meta.dir, 'dashboard/dist')
const DOCS_DIR = resolve(import.meta.dir, 'docs')

// Serve static assets from dashboard build
app.get('/dashboard', async (c) => {
  const indexPath = resolve(DASHBOARD_DIST, 'index.html')
  if (existsSync(indexPath)) {
    return new Response(Bun.file(indexPath), {
      headers: { 'Content-Type': 'text/html' },
    })
  }
  return c.text('Dashboard not built. Run: cd dashboard && bun run build', 404)
})

app.get('/dashboard/*', async (c) => {
  let path = c.req.path.replace('/dashboard', '')
  if (!path || path === '/') path = '/index.html'
  const filePath = resolve(DASHBOARD_DIST, path.startsWith('/') ? path.slice(1) : path)

  // Path containment — ensure resolved path stays within DASHBOARD_DIST
  if (!filePath.startsWith(DASHBOARD_DIST + '/') && filePath !== DASHBOARD_DIST) {
    return c.text('Not found', 404)
  }

  // Try to serve the file, fall back to index.html for SPA routing
  try {
    if (existsSync(filePath) && !filePath.endsWith('/') && Bun.file(filePath).size > 0) {
      const file = Bun.file(filePath)
      const ext = filePath.split('.').pop() ?? ''
      const mimeTypes: Record<string, string> = {
        html: 'text/html',
        js: 'application/javascript',
        css: 'text/css',
        json: 'application/json',
        svg: 'image/svg+xml',
        png: 'image/png',
        ico: 'image/x-icon',
      }
      return new Response(file, {
        headers: { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream' },
      })
    }
    // SPA fallback — serve index.html for any unmatched path under /dashboard
    const indexPath = resolve(DASHBOARD_DIST, 'index.html')
    if (existsSync(indexPath)) {
      return new Response(Bun.file(indexPath), {
        headers: { 'Content-Type': 'text/html' },
      })
    }
    return c.text('Dashboard not built. Run: cd dashboard && bun run build', 404)
  } catch {
    return c.text('Dashboard not built. Run: cd dashboard && bun run build', 404)
  }
})

// /docs/* — serve markdown setup guides from the docs/ directory
app.get('/docs/:file', async (c) => {
  const file = c.req.param('file')
  // Only allow .md files; reject path traversal
  if (!file.endsWith('.md') || file.includes('/') || file.includes('..')) {
    return c.text('Not found', 404)
  }
  const filePath = resolve(DOCS_DIR, file)
  if (!filePath.startsWith(DOCS_DIR + '/')) return c.text('Not found', 404)
  if (existsSync(filePath)) {
    return new Response(Bun.file(filePath), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  }
  return c.text('Not found', 404)
})

// /admin — serve SPA shell (React Router handles the route client-side)
app.get('/admin', async (c) => {
  const indexPath = resolve(DASHBOARD_DIST, 'index.html')
  if (existsSync(indexPath)) {
    return new Response(Bun.file(indexPath), { headers: { 'Content-Type': 'text/html' } })
  }
  return c.text('Dashboard not built. Run: cd dashboard && bun run build', 404)
})

// ── Customer detail routes (extracted to src/customer-routes.ts) ─────────────

app.route('/', createSettingsRouter({ rescheduleRefreshTimers }))

// BKL-HERO-01 Phase 0 — node-role + region-access endpoints
app.route('/', createNodeRoleRouter())
app.route('/', createRegionAccessRouter({ settingsPath: SETTINGS_PATH }))

// ── /api/env/gemini-model, /api/settings/email (extracted to src/settings-api.ts — BKL-ARCH-11)

// ── Drive watcher + drive/ls endpoints (extracted to src/admin-routes.ts — BKL-ARCH-12)

// ── Refresh routes (M02 — registered from refresh-engine.ts) ────────────────
app.route('/', createRefreshRouter())

// ── debug/sheet-tabs route (extracted to src/admin-routes.ts — BKL-ARCH-12)

// SSE data stream — each section fires as its promise resolves
app.get('/events', (c) => {
  return streamSSE(c, async (stream) => {
    const sections: Array<[string, () => Promise<any>]> = [
      ['calendar', () => fetchCalendar(customers)],
      ['email',    () => fetchEmail(customers)],
      ['cases',    fetchCases],
      ['drive',    () => fetchDrive(customers)],
    ]

    await Promise.all(
      sections.map(async ([name, fetcher]) => {
        try {
          const data = await fetcher()
          await stream.writeSSE({
            event: 'section',
            data: JSON.stringify({ section: name, data }),
          })
        } catch (err: any) {
          await stream.writeSSE({
            event: 'section',
            data: JSON.stringify({ section: name, error: err.message }),
          })
        }
      })
    )

    await stream.writeSSE({
      event: 'complete',
      data: JSON.stringify({ timestamp: new Date().toISOString() }),
    })
  })
})

app.get('/api/ingest/events', (c) => {
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'connected',
      data: JSON.stringify({ timestamp: new Date().toISOString() }),
    })

    const handler = async (event: IngestCacheEvent) => {
      try {
        await stream.writeSSE({ event: 'cache-level', data: JSON.stringify(event) })
      } catch {
        // write failed — client gone; remove listener so it doesn't accumulate
        offCacheLevel(handler)
      }
    }

    onCacheLevel(handler)

    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener('abort', () => {
        offCacheLevel(handler)
        resolve()
      }, { once: true })
    })
  })
})

// BKL-AI-FP-04: AI intelligence pipeline events SSE stream
// Mirrors /api/ingest/events pattern — long-lived SSE stream for cache/generation lifecycle events.
app.get('/api/ai/events', (c) => {
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'connected',
      data: JSON.stringify({ timestamp: new Date().toISOString() }),
    })

    const handler = async (event: AIIntelEvent) => {
      try {
        await stream.writeSSE({ event: 'ai-intel', data: JSON.stringify(event) })
      } catch {
        // write failed — client gone; remove listener so it doesn't accumulate
        offAIEvent(handler)
      }
    }

    onAIEvent(handler)

    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener('abort', () => {
        offAIEvent(handler)
        resolve()
      }, { once: true })
    })
  })
})

// Per-source refresh functions extracted to src/refresh-engine.ts (M02)


// Register keep-alive expiry → surface reconnect banner in dashboard
// Guard: if any scraper is actively running, defer context close — killing the shared
// context mid-scrape aborts Supportable, CCSP, and RH scrapers simultaneously.
// The scrapers will fail naturally when the expired session causes their next page
// operation to error; the mutex flags will self-release normally.
import { _rhScrapeRunning } from './src/scraper-manager.ts'
setSessionExpiredCallback(() => {
  recordScrapeExpired()
  notify('Red Hat Session Expired', 'RH Portal session expired — reconnect via dashboard', 'high').catch(() => {})
  if (supportableScrapeRunning || ccspScrapeRunning || _rhScrapeRunning) {
    console.warn('[session] RH session expired during active scrape — deferring context close to avoid mid-scrape abort')
    return
  }
  closeScrapeContext().catch(() => {})
})

// BKL-M50c: re-adopt sister scrapers after auto-recovery restores the browser context
setContextRecoveryCallback((ctx, profileDir) => {
  adoptSfContext(ctx, profileDir)
  adoptSupportableContext(ctx)
  adoptCcspContext(ctx)
  console.log('[server] context recovery: SF, Supportable, CCSP re-adopted')
})

// ── M02 module initialization ───────────────────────────────────────────────
initRefreshEngine(SHEETS_SYNC_PATH)
initScraperManager({
  rhSessionPath: RH_SESSION_PATH,
  rhProfileDir: RH_PROFILE_DIR,
  rhCasesCachePath: RH_CASES_CACHE_PATH,
  sfSessionPath: SF_SESSION_PATH,
  sfReportId: SF_REPORT_ID,
})
initScrapeApi({
  rhProfileDir: RH_PROFILE_DIR,
  sfReportId: SF_REPORT_ID,
})

const port = Number(process.env.PORT ?? 7777)
console.log(`\n🗂️  Daily Brief Dashboard`)
console.log(`   http://localhost:${port}`)
console.log(`   http://localhost:${port}/dashboard\n`)

// ── Background scheduler (timers, startup IIFEs, drive watcher) ─────────────
// Account discovery now handled by RH Cases scraper (discoverAccountNumberByName in rh-scraper.ts)

initBackgroundScheduler({
  rhSessionPath: RH_SESSION_PATH,
  rhProfileDir: RH_PROFILE_DIR,
  sfSessionPath: SF_SESSION_PATH,
})

// ── Wave 4: Product Intel weekly refresh (Sunday 6am ET) ────────────────────
scheduleProductIntelRefresh()

// ── Drive config merge (startup, best-effort) ───────────────────────────────
// If parentFolderId is set for any region, fetch Config/settings.json from
// Drive and merge regions[] into local settings.json (Drive wins on regions[]).
void runStartupDriveMerge()

// ── Test-only endpoints (never active in production) ──────────────────
if (process.env.NODE_ENV !== 'production') {
  // Snapshot current server config state for test isolation
  // BKL-TEST-03: Snapshot reads from IN-MEMORY arrays, not disk.
  // Disk may be stale (scrapes/bootstrap write to memory before flushing).
  // This prevents Quinn from capturing stale disk state as the "good" snapshot.
  app.post('/api/__test/snapshot', async (c) => {
    try {
      return c.json({
        ok: true,
        aes: { aes: [...aes] },
        customers: { customers: [...customers] },
      })
    } catch (e) {
      return c.json({ error: 'snapshot failed' }, 500)
    }
  })

  // Factory reset for @destructive tests — wipes AEs and customers, preserves credentials
  // Gated by ALLOW_RESET=true so production container never exposes this route
  app.post('/api/__test/reset', async (c) => {
    if (process.env.ALLOW_RESET !== 'true') {
      return c.json({ error: 'Not available — ALLOW_RESET is not set' }, 404)
    }
    try {
      const emptyAes = { aes: [] }
      const emptyCustomers = { customers: [] }
      writeFileSync(AES_PATH + '.tmp', JSON.stringify(emptyAes, null, 2))
      renameSync(AES_PATH + '.tmp', AES_PATH)
      writeFileSync(CUSTOMERS_PATH + '.tmp', JSON.stringify(emptyCustomers, null, 2))
      renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
      setAes([])
      setCustomers([])
      resetBootstrapStates()
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: `Reset failed: ${e instanceof Error ? e.message : String(e)}` }, 500)
    }
  })

  // DOM diagnostic: inspect Accounts filter dropdown DOM on the live RH Portal page
  // FINDINGS (2026-04-09): dropdown is portal-rendered at body level as div.pf-v6-c-menu.pf-m-scrollable
  // input aria-controls="account-selector-dropdown" but that ID does not exist on the menu element
  // list items have role="menuitem" NOT role="option" — query must use `li` not `[role="option"]`
  app.post('/api/__test/dom-inspect', async (c) => {
    try {
      const ctx = getScrapeContext()
      if (!ctx) return c.json({ error: 'No active RH session' }, 409)
      const page = await ctx.newPage()
      try {
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto('https://access.redhat.com/support/cases/#/case/list', {
          waitUntil: 'load',
          timeout: 30_000,
        })
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})

        // Screenshot 1: initial state
        await page.screenshot({ path: '/tmp/diag-step1.png' })

        // Click the menu toggle
        const toggleResult = await page.evaluate(() => {
          const input = document.querySelector('input[placeholder="Search for an account"]') as HTMLInputElement | null
          if (!input) return 'no-input'
          let el: Element | null = input
          while (el) {
            if (el.classList.contains('pf-v6-c-menu-toggle')) {
              ;(el as HTMLElement).click()
              return 'clicked-toggle:' + el.tagName + ' classes=' + el.className.slice(0, 80)
            }
            el = el.parentElement
          }
          const btn = input.closest('button, [role="button"]')
          if (btn) { ;(btn as HTMLElement).click(); return 'clicked-btn' }
          input.focus(); input.click(); return 'clicked-input-directly'
        })
        await page.waitForTimeout(500)

        // Type "A10" to trigger autocomplete
        const inputEl = page.locator('input[placeholder="Search for an account"]').first()
        await inputEl.click()
        await inputEl.fill('A10')
        await page.waitForTimeout(2000)

        // Screenshot 2: with dropdown open
        await page.screenshot({ path: '/tmp/diag-step2.png' })

        // Deep DOM inspection
        const domInfo = await page.evaluate(() => {
          const input = document.querySelector('input[placeholder="Search for an account"]') as HTMLInputElement | null
          if (!input) return { error: 'no input found' }

          const ariaOwns = input.getAttribute('aria-owns')
          const ariaControls = input.getAttribute('aria-controls')
          const ariaExpanded = input.getAttribute('aria-expanded')
          const ariaActivedescendant = input.getAttribute('aria-activedescendant')
          const ariaAutocomplete = input.getAttribute('aria-autocomplete')
          const ariaHaspopup = input.getAttribute('aria-haspopup')

          const parentChain: string[] = []
          let el: Element | null = input.parentElement
          while (el && parentChain.length < 12) {
            const r = el.getBoundingClientRect()
            parentChain.push(
              `${el.tagName.toLowerCase()}` +
              `[id="${el.id}"]` +
              `[class="${el.className?.toString?.()?.slice(0, 100) || ''}"]` +
              `[role="${el.getAttribute('role') || ''}"]` +
              `[aria-expanded="${el.getAttribute('aria-expanded') || ''}"]` +
              ` w=${Math.round(r.width)} h=${Math.round(r.height)}`
            )
            el = el.parentElement
            if (el?.tagName === 'BODY' || el?.tagName === 'HTML') break
          }

          const allListboxes = Array.from(document.querySelectorAll('[role="listbox"]')).map(el => {
            const r = el.getBoundingClientRect()
            const items = Array.from(el.querySelectorAll('[role="option"]'))
            const liItems = Array.from(el.querySelectorAll('li'))
            return {
              id: el.id, tagName: el.tagName.toLowerCase(),
              className: el.className?.toString?.()?.slice(0, 150) || '',
              itemCount_option: items.length, itemCount_li: liItems.length,
              visible: r.width > 0 && r.height > 0, w: Math.round(r.width), h: Math.round(r.height),
              parentTag: el.parentElement?.tagName || '',
              parentId: el.parentElement?.id || '',
              parentClass: el.parentElement?.className?.toString?.()?.slice(0, 80) || '',
              isBodyChild: el.parentElement?.tagName === 'BODY',
              firstItem: items[0]?.textContent?.trim()?.slice(0, 60) || liItems[0]?.textContent?.trim()?.slice(0, 60) || '',
              outerHTMLSlice: el.outerHTML.slice(0, 500),
            }
          })

          const allPfMenus = Array.from(document.querySelectorAll('[class*="pf-v6-c-menu"]')).map(el => {
            const r = el.getBoundingClientRect()
            return {
              id: el.id, tagName: el.tagName.toLowerCase(),
              className: el.className?.toString?.()?.slice(0, 150) || '',
              role: el.getAttribute('role') || '',
              visible: r.width > 0 && r.height > 0, w: Math.round(r.width), h: Math.round(r.height),
              itemCount: el.querySelectorAll('li, [role="option"]').length,
              outerHTMLSlice: el.outerHTML.slice(0, 500),
            }
          })

          let ariaRefDropdown = null
          if (ariaOwns) ariaRefDropdown = document.getElementById(ariaOwns)?.outerHTML?.slice(0, 800)
          if (!ariaRefDropdown && ariaControls) ariaRefDropdown = document.getElementById(ariaControls)?.outerHTML?.slice(0, 800)

          const allToggleEls = Array.from(document.querySelectorAll('[class*="pf-v6-c-menu-toggle"]')).map(el => ({
            tagName: el.tagName.toLowerCase(), id: el.id,
            className: el.className?.toString?.()?.slice(0, 100) || '',
            ariaExpanded: el.getAttribute('aria-expanded'),
            outerHTMLSlice: el.outerHTML.slice(0, 300),
          }))

          // Scan full page for anything with "option" role that is visible
          const visibleOptions = Array.from(document.querySelectorAll('[role="option"]'))
            .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
            .slice(0, 10)
            .map(el => ({
              text: el.textContent?.trim()?.slice(0, 60) || '',
              className: el.className?.toString?.()?.slice(0, 80) || '',
              parentClass: el.parentElement?.className?.toString?.()?.slice(0, 80) || '',
              parentId: el.parentElement?.id || '',
            }))

          // Get listbox parent chain
          const listboxParentChain: string[] = []
          if (allListboxes.length > 0) {
            const lb = document.querySelector('[role="listbox"]')
            let p: Element | null = lb?.parentElement || null
            while (p && listboxParentChain.length < 8) {
              const r = p.getBoundingClientRect()
              listboxParentChain.push(
                `${p.tagName.toLowerCase()}[id="${p.id}"][class="${p.className?.toString?.()?.slice(0, 80) || ''}"] w=${Math.round(r.width)} h=${Math.round(r.height)}`
              )
              p = p.parentElement
              if (p?.tagName === 'BODY' || p?.tagName === 'HTML') break
            }
          }

          // Get actual li items from the listbox
          const listboxItems: string[] = []
          const lb = document.querySelector('[role="listbox"]')
          if (lb) {
            const liEls = Array.from(lb.querySelectorAll('li'))
            listboxItems.push(...liEls.slice(0, 25).map(li => {
              const txt = li.textContent?.trim()?.replace(/\s+/g, ' ')?.slice(0, 80) || ''
              const role = li.getAttribute('role') || ''
              const cls = li.className?.toString?.()?.slice(0, 60) || ''
              return `[role="${role}"][class="${cls}"] "${txt}"`
            }))
          }

          // Check what element has id="account-selector-dropdown"
          const accountSelectorEl = document.getElementById('account-selector-dropdown')
          const accountSelectorInfo = accountSelectorEl ? {
            tagName: accountSelectorEl.tagName.toLowerCase(),
            className: accountSelectorEl.className?.toString?.()?.slice(0, 150) || '',
            role: accountSelectorEl.getAttribute('role') || '',
            id: accountSelectorEl.id,
            parentTag: accountSelectorEl.parentElement?.tagName || '',
            parentClass: accountSelectorEl.parentElement?.className?.toString?.()?.slice(0, 80) || '',
            outerHTMLSlice: accountSelectorEl.outerHTML.slice(0, 400),
          } : null

          // Check the menu-toggle's siblings and nearby elements
          const toggleEl = input.closest('[class*="pf-v6-c-menu-toggle"]')
          const toggleSiblings = toggleEl ? Array.from(toggleEl.parentElement?.children || []).map(el => {
            const r = el.getBoundingClientRect()
            return {
              tagName: el.tagName.toLowerCase(),
              id: el.id,
              className: el.className?.toString?.()?.slice(0, 80) || '',
              role: el.getAttribute('role') || '',
              visible: r.width > 0 && r.height > 0,
              w: Math.round(r.width), h: Math.round(r.height),
              childCount: el.children.length,
            }
          }) : []

          return {
            input: { value: input.value, id: input.id, ariaOwns, ariaControls, ariaExpanded, ariaActivedescendant, ariaAutocomplete, ariaHaspopup },
            parentChain, allListboxes, allPfMenus: allPfMenus.slice(0, 10),
            ariaRefDropdown, allToggleEls: allToggleEls.slice(0, 6), visibleOptions,
            listboxParentChain, listboxItems, accountSelectorInfo, toggleSiblings,
          }
        })

        return c.json({ toggleResult, domInfo, screenshots: ['/tmp/diag-step1.png', '/tmp/diag-step2.png'] })
      } finally {
        await page.close().catch(() => {})
      }
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 500)
    }
  })

  // BKL-RH-03 Phase 1: server-side SOLR cases fetch via Bearer token (no browser).
  // Validates an alternative to the DOM scraper; NOT wired into the production data flow.
  // Additive-only — does not touch rh-scraper.ts / scrape-api.ts / rh-scraper-extract.ts.
  app.post('/api/__test/solr-cases', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as {
        accountNumbers?: unknown
        customerName?: unknown
        rows?: unknown
      }
      const accts = Array.isArray(body.accountNumbers)
        ? body.accountNumbers.map((a) => String(a ?? ''))
        : []
      const rows = typeof body.rows === 'number' && body.rows > 0 ? Math.min(body.rows, 500) : 100
      if (accts.length === 0) {
        return c.json({ error: 'accountNumbers required (non-empty array)' }, 400)
      }
      const result = await fetchCasesViaSolr(accts, rows)
      return c.json({
        ...result,
        customerName: typeof body.customerName === 'string' ? body.customerName : null,
      })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // BKL-RH-03 Phase 2 (ADR-014): token telemetry for HealthProbe.
  // Exposes auth mode, token age, lifetime, cache presence, and configured
  // transport. Never returns the token itself. Safe to call publicly.
  app.get('/api/status/rh-token', (c) => {
    return c.json({
      ...getTokenTelemetry(),
      transport: process.env.RH_CASES_TRANSPORT ?? 'bearer',
    })
  })
}

export default { port, fetch: app.fetch, idleTimeout: 120 }
