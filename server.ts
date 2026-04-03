import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bodyLimit } from 'hono/body-limit'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { writeFileSync as writeFileSyncRaw, renameSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { fetchEmail, fetchDrive, fetchCalendar, makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './src/google.ts'
import { fetchCases } from './src/redhat.ts'
import { generateBrief, getBriefProvider, isBriefConfigured } from './src/customer.ts'
import type { AE } from './src/types.ts'
import { rebuildFolderMap, getWatcherState } from './src/drive-watcher.ts'
import { startLoginBrowser, cancelLoginBrowser, getRhStatus, recordScrapeExpired } from './src/rh-auth.ts'
import { closeScrapeContext, getScrapeContext, getLivePage, setSessionExpiredCallback } from './src/rh-scraper.ts'

import { runSfPipelineSync, getSfContext } from './src/sf-scraper.ts'
import { startSfLoginBrowser, cancelSfLoginBrowser } from './src/sf-auth.ts'
import { runSupportableScrape, writeSupportableSheet, supportableScrapeRunning } from './src/supportable-scraper.ts'
import type { SupportableCustomer } from './src/supportable-scraper.ts'
import { runCcspScrape, writeCcspSheet, ccspScrapeRunning } from './src/ccsp-scraper.ts'
import { initCacheLayer, registerCacheRoutes, readSheetCache } from './src/cache-layer.ts'
import { initSettingsApi, registerSettingsRoutes } from './src/settings-api.ts'
// ── M02 extracted modules ───────────────────────────────────────────────────
import { loadServerState, aes, customers, saveAes, setAes, setCustomers, patchAe, AES_PATH, CUSTOMERS_PATH } from './src/server-state.ts'
import { initRefreshEngine, registerRefreshRoutes, refreshSubscriptions, refreshCCSP, refreshPipeline } from './src/refresh-engine.ts'
import { initScraperManager, registerScraperRoutes, runRhScrapeWithState, runSfSyncForAes, ccspInFlight, setCcspInFlight } from './src/scraper-manager.ts'
import { initScrapeApi, registerScrapeRoutes } from './src/scrape-api.ts'
import { rescheduleRefreshTimers, initBackgroundScheduler, enqueueScraperTask } from './src/background-scheduler.ts'
import { initDashboardRoutes, registerDashboardRoutes } from './src/dashboard-routes.ts'
// ── M03 extracted modules ───────────────────────────────────────────────────
import { registerBootstrapRoutes, startAccountDiscovery } from './src/bootstrap-orchestrator.ts'
// ── M04 extracted modules ───────────────────────────────────────────────────
import { registerSheetImportRoutes } from './src/sheet-import.ts'
import { registerDriveSourcesRoutes } from './src/drive-sources.ts'
import { sanitizeErr, sanitizeText, isValidDriveFolderId, notify, liveProbe } from './src/utils.ts'
// ── M05 extracted modules ───────────────────────────────────────────────────
import { initSetupRoutes, registerSetupRoutes } from './src/setup-routes.ts'
import { initCustomerRoutes, registerCustomerRoutes } from './src/customer-routes.ts'

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

const SRV_CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, 'config')
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
initDashboardRoutes({ cacheDir: CACHE_DIR, rhCasesCachePath: RH_CASES_CACHE_PATH, dataSourcesPath: DATA_SOURCES_PATH })
initSettingsApi(DATA_SOURCES_PATH)
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

const app = new Hono()

// BKL-M05: Display-oriented normalizer — differs from normalizeForMatch by stripping state codes, parentheticals, and applying title case (needed for Drive folder names).
/**
 * Normalize a customer name for use as a Drive folder name and search key.
 * Strips state suffixes, legal entity suffixes, and parentheticals; applies title case.
 * Input:  "DROPBOX, INC. - CA"  →  Output: "Dropbox"
 * Input:  "FRED HUTCHINSON CANCER CENTER"  →  Output: "Fred Hutchinson Cancer Center"
 * Input:  "A10 NETWORKS, INC."  →  Output: "A10 Networks"
 */
function normalizeCustomerName(raw: string): string {
  let name = raw.trim()
  // Strip state suffix " - XX" or " - XX/XX"
  name = name.replace(/\s+-\s+[A-Z]{2}(\/[A-Z]{2})?$/, '')
  // Strip parentheticals like "(REI)" or "(HostGator)"
  name = name.replace(/\s*\([^)]*\)\s*$/, '')
  // Strip legal entity suffixes (with or without leading comma)
  const legalSuffixes = [
    /,?\s+L\.?L\.?P\.?$/i,
    /,?\s+P\.?T\.?Y\.?\s+LTD\.?$/i,
    /,?\s+L\.?P\.?$/i,
    /,?\s+INC\.?$/i,
    /,?\s+LLC\.?$/i,
    /,?\s+LTD\.?$/i,
    /,?\s+CORP\.?$/i,
    /,?\s+CO\.?$/i,
    /,?\s+PLC\.?$/i,
  ]
  for (const re of legalSuffixes) name = name.replace(re, '')
  name = name.trim().replace(/,+$/, '').trim()
  // Title case: preserve words with digits (A10, H2O) or internal dots (U.S.) or already mixed case
  name = name.split(/\s+/).map(word => {
    if (/\d/.test(word) || /[a-z]/.test(word) || /\.[a-zA-Z]/.test(word)) return word
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  }).join(' ')
  return name
}


/** Salesforce report/object ID — alphanumeric only, 15-18 chars. */
function isValidSfId(value: unknown): boolean {
  if (typeof value !== 'string') return true
  if (value === '') return true
  return /^[A-Za-z0-9]{15,18}$/.test(value)
}

/**
 * BKL-F07: Extract a bare SF report ID from a full Salesforce URL or return as-is if already bare.
 * Handles Lightning URLs (/lightning/r/Report/ID/view), Classic (/ID), and path variants.
 * Returns the extracted ID or the original string if no URL pattern matched.
 */
function extractSfReportId(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  // Already a bare ID — return as-is
  if (/^[A-Za-z0-9]{15,18}$/.test(trimmed)) return trimmed
  // URL pattern — extract last path segment that looks like a SF ID
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const segments = url.pathname.split('/').filter(Boolean)
      // Walk segments in reverse to find the ID (handles /view suffix, etc.)
      for (let i = segments.length - 1; i >= 0; i--) {
        if (/^[A-Za-z0-9]{15,18}$/.test(segments[i])) return segments[i]
      }
    } catch { /* not a valid URL — fall through */ }
  }
  // Not a URL and not a bare ID — return as-is (will fail validation downstream)
  return trimmed
}

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
app.get('/health', (c) => {
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, 'package.json'), 'utf-8'))
  return c.json({
    status: 'ok',
    version: pkg.version ?? '0.0.0',
    timestamp: new Date().toISOString(),
    aes: aes.length,
    customers: customers.length,
    session: !!getScrapeContext(),
    sfSession: !!getSfContext(),
    ccspSession: !!getScrapeContext(),   // ccsp shares RH SSO context
  })
})

registerCacheRoutes(app)
registerDashboardRoutes(app)
registerSetupRoutes(app)
registerCustomerRoutes(app)

// Redirect root to command center
app.get('/', (c) => c.redirect('/dashboard'))

// Customer list for landing page
app.get('/customers', (c) => c.json(customers))

// ── Google OAuth + Setup wizard routes (extracted to src/setup-routes.ts) ──

// ── Red Hat Portal auth endpoints ────────────────────────────────────────────

// GET /api/auth/redhat/status — Session health, scrape timestamps, login state
app.get('/api/auth/redhat/status', async (c) => {
  const status = getRhStatus(RH_SESSION_PATH)
  // hasSession requires both a session file AND a live browser context —
  // the file persists across restarts but the context must be active to scrape
  const liveReachable = await liveProbe('https://access.redhat.com/support/cases', 'rh')
  return c.json({ ...status, hasSession: status.hasSession && getScrapeContext() !== null, liveReachable })
})

// POST /api/auth/redhat/start — Launch headed browser for RH portal login
app.post('/api/auth/redhat/start', async (c) => {
  try {
    await startLoginBrowser(RH_SESSION_PATH, RH_PROFILE_DIR, () => {
      // BKL-S12: Run pre-warm as async, then hide browser AFTER it completes or times out.
      // onComplete is fire-and-forget from rh-auth.ts — making it async is safe (caller doesn't await).
      ;(async () => {
        // Pre-warm Supportable session in background immediately after RH login.
        // The auth.redhat.com SSO session is fresh — navigating to Supportable now
        // auto-completes SSO and saves the Supportable session cookie to the profile,
        // so subsequent headless bootstrap runs can access Supportable without re-auth.
        const ctx = getScrapeContext()
        if (ctx) {
          const SUPPORTABLE_PREWARM_URL = 'https://supportable.corp.redhat.com:4443/pls/rhapplications/f?p=304:1'
          const prewarm = (async () => {
            const p = await ctx.newPage()
            try {
              await p.goto(SUPPORTABLE_PREWARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
              if (!p.url().includes('supportable.corp.redhat.com')) {
                await p.waitForURL(/supportable\.corp\.redhat\.com/, { timeout: 30_000 }).catch(() => {})
              }
              console.log(`[supportable] pre-warm complete — session established (${p.url().includes('supportable') ? 'ok' : 'may need manual login'})`)
            } catch (e: any) {
              console.warn('[supportable] pre-warm failed:', e.message)
            } finally {
              await p.close().catch(() => {})
            }
          })()
          // Wait for pre-warm to settle (cap at 32s) before hiding browser — BKL-S12
          await Promise.race([prewarm, new Promise<void>(r => setTimeout(r, 32_000))])
        }
        // Pre-warm complete (or skipped/timed out) — now safe to hide the VNC window
        getLivePage()?.goto('about:blank').catch(() => {})
        console.log('[rh-auth] onComplete: enqueueing all scrapers after re-auth')
        enqueueScraperTask({
          name: 'rh-cases',
          run: () => runRhScrapeWithState(),
          source: 'manual',
          enqueuedAt: Date.now(),
        })
        const sfAes = aes.filter(a => a.sfReportId)
        if (sfAes.length) {
          enqueueScraperTask({
            name: 'sf-pipeline',
            run: async () => { await runSfSyncForAes(sfAes) },
            source: 'manual',
            enqueuedAt: Date.now(),
          })
        }
        enqueueScraperTask({
          name: 'supportable',
          run: async () => {
            if (supportableScrapeRunning) { console.log('[rh-auth] supportable: busy — skipping'); return }
            for (const ae of aes) {
              const aeCustomers = customers.filter(cu => cu.ae === ae.name && cu.accountNumbers?.length)
              if (!aeCustomers.length) continue
              try {
                const results = await runSupportableScrape(aeCustomers as SupportableCustomer[])
                const sheetId = await writeSupportableSheet(results, ae.name, ae.driveFolderId, ae.supportableSheetId || undefined)
                if (sheetId) patchAe(ae.name, { supportableSheetId: sheetId })
              } catch (e: any) {
                console.warn(`[rh-auth:supportable] ${ae.name} failed:`, e?.message ?? e)
              }
            }
            await refreshSubscriptions().catch(() => {})
          },
          source: 'manual',
          enqueuedAt: Date.now(),
        })
        const ccspAes = aes.filter(a => a.tableauTerritories?.length && a.driveFolderId)
        if (ccspAes.length) {
          enqueueScraperTask({
            name: 'ccsp',
            run: async () => {
              if (ccspScrapeRunning || ccspInFlight) { console.log('[rh-auth] ccsp: busy — skipping'); return }
              setCcspInFlight(true)
              try {
                const results = await runCcspScrape(ccspAes)
                for (const ae of ccspAes) {
                  const aeResults = results.filter(r => r.aeName === ae.name)
                  const sheetId = await writeCcspSheet(aeResults, ae.name, ae.driveFolderId, ae.ccspSheetId || undefined)
                  patchAe(ae.name, { ccspSheetId: sheetId })
                }
                await refreshCCSP().catch(() => {})
              } finally {
                setCcspInFlight(false)
              }
            },
            source: 'manual',
            enqueuedAt: Date.now(),
          })
        }
      })().catch((e: any) => console.error('[supportable] pre-warm block error:', e?.message ?? e))
    })
    return c.json({ started: true })
  } catch (e: any) {
    return c.json({ error: 'Login failed — check Red Hat Portal connection' }, 409)
  }
})

// DELETE /api/auth/redhat/session — Cancel in-progress login
app.delete('/api/auth/redhat/session', async (c) => {
  await cancelLoginBrowser()
  return c.json({ cancelled: true })
})

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

    if ('error' in tableData) return c.json({ customerName, fieldId, inputFields, tableData })

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

// ── Salesforce login endpoints (kept in server.ts — depend on startSfLoginBrowser) ──

// POST /api/auth/salesforce/start — launch headed browser for SF login
// The SSO button auto-clicks; the SAML flow completes without user interaction
// as long as the RH SSO session is active in the profile.
app.post('/api/auth/salesforce/start', async (c) => {
  try {
    await startSfLoginBrowser(SF_SESSION_PATH, RH_PROFILE_DIR, () => {
      // Auto-trigger a pipeline sync for each configured AE after login
      const aesWithSf = aes.filter(a => a.sfReportId && a.driveFolderId)
      if (aesWithSf.length) {
        runSfSyncForAes(aesWithSf)
      } else if (SF_REPORT_ID && process.env.PIPELINE_FILE_ID) {
        // Fallback to env vars for backwards compatibility
        runSfPipelineSync(SF_REPORT_ID, RH_PROFILE_DIR, process.env.PIPELINE_FILE_ID).catch((e: any) => console.error('[sf-sync] env fallback failed:', e?.message ?? e))
      }
    })
    return c.json({ started: true })
  } catch (e: any) {
    return c.json({ error: 'Login failed — check Salesforce connection' }, 409)
  }
})

// DELETE /api/auth/salesforce/session — cancel in-progress login
app.delete('/api/auth/salesforce/session', async (c) => {
  await cancelSfLoginBrowser()
  return c.json({ cancelled: true })
})

// ── Scraper routes (M02 — registered from scraper-manager.ts) ──────────────
registerScraperRoutes(app)

// ── Unified scrape API (BKL-M25 — registered from scrape-api.ts) ───────────
registerScrapeRoutes(app)

// ── Auto-bootstrap + Tableau routes (M03 — registered from bootstrap-orchestrator.ts) ──
registerBootstrapRoutes(app)

// ── Drive data-sources + Sheet import routes (M04 — registered from drive-sources.ts + sheet-import.ts) ──
registerDriveSourcesRoutes(app)
registerSheetImportRoutes(app)


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

// ── Version API ───────────────────────────────────────────────────────────────

const APP_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, 'package.json'), 'utf-8'))
    return pkg.version ?? '1.0.0'
  } catch { return '1.0.0' }
})()

app.get('/api/version', (c) => c.json({ version: APP_VERSION }))

// ── AE Config API ─────────────────────────────────────────────────────────────

app.get('/api/aes', (c) => c.json({ aes }))

app.post('/api/aes', async (c) => {
  try {
    const body = await c.req.json() as { aes: AE[] }
    if (!Array.isArray(body.aes)) return c.json({ error: 'aes must be an array' }, 400)
    if (body.aes.length > 50) return c.json({ error: 'aes array exceeds maximum of 50 entries' }, 400)

    // Validate each AE entry
    for (let i = 0; i < body.aes.length; i++) {
      const ae = body.aes[i]
      const name = sanitizeText(ae.name)
      if (!name) return c.json({ error: `aes[${i}].name is invalid or contains disallowed characters` }, 400)
      // BKL-F07: Accept full Salesforce URLs — extract bare ID before validation
      if (ae.sfReportId) ae.sfReportId = extractSfReportId(ae.sfReportId)
      if (ae.sfReportId && !isValidSfId(ae.sfReportId)) return c.json({ error: `aes[${i}].sfReportId must be a valid Salesforce report URL or 15-18 character ID` }, 400)
      if (Array.isArray(ae.tableauTerritories)) {
        for (const t of ae.tableauTerritories) {
          if (typeof t !== 'string' || t.length > 100) return c.json({ error: `aes[${i}].tableauTerritories entry exceeds 100 characters` }, 400)
        }
      }
      // Extract folder ID from full Google Drive URL if provided
      const rawFolderId = ae.driveFolderId ?? ''
      const folderIdMatch = rawFolderId.match(/\/folders\/([a-zA-Z0-9_-]{20,})/)
      const driveFolderId = folderIdMatch ? folderIdMatch[1] : rawFolderId.trim()
      // Write whitelisted fields only — drop anything not in the schema
      body.aes[i] = {
        name,
        driveFolderId,
        sfReportId:           ae.sfReportId           ?? '',
        tableauTerritories:   ae.tableauTerritories   ?? [],
        tableauUrl:           ae.tableauUrl           ?? undefined,
        supportableSheetId:   ae.supportableSheetId   ?? undefined,
        pipelineSheetId:      ae.pipelineSheetId      ?? undefined,
        ccspSheetId:          ae.ccspSheetId          ?? undefined,
      }
      // Strip undefined values to keep JSON clean
      Object.keys(body.aes[i]).forEach(k => (body.aes[i] as any)[k] === undefined && delete (body.aes[i] as any)[k])
    }

    saveAes(body.aes)
    // Rebuild flat customer list with denormalized ae names
    try {
      const raw = JSON.parse(readFileSync(CUSTOMERS_PATH, 'utf-8'))
      setCustomers(raw.customers ?? [])
    } catch (e: any) { console.warn('[wizard] customers reload failed:', e.message) }
    return c.json({ ok: true, count: aes.length })
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

app.post('/api/aes/validate-folder', async (c) => {
  try {
    const { folderUrl } = await c.req.json() as { folderUrl: string }
    const match = folderUrl?.match(/\/folders\/([\w-]+)/)
    if (!match) return c.json({ error: 'Could not extract folder ID from URL' }, 400)
    const folderId = match[1]
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })
    const res = await drive.files.get({
      fileId: folderId,
      supportsAllDrives: true,
      fields: 'id,name,mimeType',
    })
    if (res.data.mimeType !== 'application/vnd.google-apps.folder') {
      return c.json({ error: 'URL does not point to a folder' }, 400)
    }
    return c.json({ folderId, folderName: res.data.name ?? folderId })
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 400)
  }
})

app.get('/api/config', (c) => {
  return c.json({
    briefProvider: getBriefProvider(),
    briefConfigured: isBriefConfigured(),
  })
})

app.get('/api/config/test', async (c) => {
  if (!isBriefConfigured()) {
    return c.json({ ok: false, error: `LLM_PROVIDER=${getBriefProvider()} is not configured. Check your .env file.` })
  }
  try {
    const result = await generateBrief(
      { name: 'Test Account', ae: 'Test', domain: '', accountNumbers: [], segment: '', region: '' } as any,
      [], [], [], [], [], []
    )
    return c.json({ ok: true, provider: getBriefProvider(), preview: result.slice(0, 120) })
  } catch (e: any) {
    return c.json({ ok: false, error: sanitizeErr(e) })
  }
})

// GET /api/accounts — All customers with cached sheet data merged
app.get('/api/accounts', (c) => {
  const result = customers.map((customer) => {
    const cached = readSheetCache(customer.name)
    const products = cached?.rows ?? []
    const distinctProducts = new Set(products.map((p) => p.productDescription)).size
    const totalLicenses = products.reduce((sum, p) => sum + p.quantity, 0)

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
    }
  })
  return c.json({ customers: result })
})

// ── Setup wizard routes (extracted to src/setup-routes.ts) ───────────────────

// ── Customer data routes (extracted to src/customer-routes.ts) ───────────────

// ── Serve React dashboard SPA ────────────────────────────────────────────────
const DASHBOARD_DIST = resolve(import.meta.dir, 'dashboard/dist')

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

// /admin — serve SPA shell (React Router handles the route client-side)
app.get('/admin', async (c) => {
  const indexPath = resolve(DASHBOARD_DIST, 'index.html')
  if (existsSync(indexPath)) {
    return new Response(Bun.file(indexPath), { headers: { 'Content-Type': 'text/html' } })
  }
  return c.text('Dashboard not built. Run: cd dashboard && bun run build', 404)
})

// ── Customer detail routes (extracted to src/customer-routes.ts) ─────────────

registerSettingsRoutes(app, { rescheduleRefreshTimers })

// ── Email delivery settings (BKL-E05) ────────────────────────────────────────

const EMAIL_SETTINGS_PATH = resolve(process.env.DATA_DIR ?? 'data', 'config', 'email-settings.json')

interface EmailSettings {
  enabled: boolean
  deliveryTime: string
  timezone: string
  schedule: string
  recipientEmail: string
  sections: {
    meetings: boolean
    emails: boolean
    cases: boolean
    pipeline: boolean
    brief: boolean
  }
}

const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  enabled: false,
  deliveryTime: '07:00',
  timezone: 'America/New_York',
  schedule: 'weekdays',
  recipientEmail: '',
  sections: { meetings: true, emails: true, cases: true, pipeline: true, brief: true },
}

function readEmailSettings(): EmailSettings {
  try {
    if (existsSync(EMAIL_SETTINGS_PATH)) {
      return { ...DEFAULT_EMAIL_SETTINGS, ...JSON.parse(readFileSync(EMAIL_SETTINGS_PATH, 'utf-8')) }
    }
  } catch {}
  return { ...DEFAULT_EMAIL_SETTINGS }
}

app.get('/api/settings/email', (c) => {
  return c.json(readEmailSettings())
})

app.put('/api/settings/email', async (c) => {
  try {
    const body = await c.req.json<Partial<EmailSettings>>().catch(() => ({}))
    const current = readEmailSettings()

    // Validate deliveryTime
    if (body.deliveryTime != null) {
      if (typeof body.deliveryTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.deliveryTime)) {
        return c.json({ error: 'deliveryTime must be HH:MM format' }, 400)
      }
    }
    // Validate timezone
    if (body.timezone != null) {
      if (typeof body.timezone !== 'string' || body.timezone.length < 2 || body.timezone.length > 50) {
        return c.json({ error: 'Invalid timezone' }, 400)
      }
      try { Intl.DateTimeFormat(undefined, { timeZone: body.timezone }) }
      catch { return c.json({ error: 'Invalid timezone identifier' }, 400) }
    }
    // Validate schedule
    if (body.schedule != null) {
      if (!['daily', 'weekdays'].includes(body.schedule as string)) {
        return c.json({ error: 'schedule must be "daily" or "weekdays"' }, 400)
      }
    }
    // Validate email
    if (body.recipientEmail != null) {
      if (typeof body.recipientEmail !== 'string' || (body.recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.recipientEmail))) {
        return c.json({ error: 'Invalid email address format' }, 400)
      }
    }

    const updated: EmailSettings = {
      enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
      deliveryTime: body.deliveryTime ?? current.deliveryTime,
      timezone: body.timezone ?? current.timezone,
      schedule: (body.schedule as string) ?? current.schedule,
      recipientEmail: body.recipientEmail ?? current.recipientEmail,
      sections: body.sections ? { ...current.sections, ...body.sections } : current.sections,
    }

    // Ensure config dir exists
    mkdirSync(resolve(process.env.DATA_DIR ?? 'data', 'config'), { recursive: true })
    const tmpPath = EMAIL_SETTINGS_PATH + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(updated, null, 2), { mode: 0o600 })
    renameSync(tmpPath, EMAIL_SETTINGS_PATH)
    return c.json(updated)
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// ── Drive watcher endpoints ───────────────────────────────────────────────────

app.get('/api/drive-watcher/status', (c) => {
  const state = getWatcherState()
  if (!state) return c.json({ enabled: false, folderMap: [], lastChecked: null, builtAt: null })
  return c.json({
    enabled: state.enabled,
    folderMap: state.folderMap,
    lastChecked: state.lastChecked ?? null,
    builtAt: state.builtAt,
  })
})

app.post('/api/drive-watcher/rebuild', async (c) => {
  const parentIds = (process.env.AE_PARENT_FOLDER_IDS ?? process.env.AE_PARENT_FOLDER_ID ?? '').split(',').filter(Boolean)
  try {
    const folderMap = await rebuildFolderMap(customers, parentIds)
    return c.json({ rebuilt: true, folders: folderMap.length, map: folderMap })
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// Diagnostic: list contents of a Drive folder by ID
app.get('/api/drive/ls/:folderId', async (c) => {
  const folderId = c.req.param('folderId')
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

// ── Refresh routes (M02 — registered from refresh-engine.ts) ────────────────
registerRefreshRoutes(app)

// ── Sheet data + debug routes (extracted to src/customer-routes.ts) ──────────

app.get('/debug/sheet-tabs/:fileId', async (c) => {
  if (process.env.NODE_ENV === 'production') return c.json({ error: 'Not available' }, 404)
  const fileId = c.req.param('fileId')
  if (!/^[a-zA-Z0-9_-]{10,60}$/.test(fileId ?? '')) return c.json({ error: 'Invalid file ID' }, 400)
  const { makeAuth } = await import('./src/google.ts')
  const { google } = await import('googleapis')
  const auth = makeAuth(SHEETS_TOKEN_PATH_SRV)
  const sheets = google.sheets({ version: 'v4', auth })
  try {
    const res = await sheets.spreadsheets.get({ spreadsheetId: fileId, fields: 'sheets.properties.title' })
    const tabs = (res.data.sheets ?? []).map(s => s.properties?.title ?? '')
    return c.json({ fileId, tabs })
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

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
// Account discovery IIFE extracted to src/bootstrap-orchestrator.ts (M03)
startAccountDiscovery()

initBackgroundScheduler({
  rhSessionPath: RH_SESSION_PATH,
  rhProfileDir: RH_PROFILE_DIR,
  sfSessionPath: SF_SESSION_PATH,
})

// ── Test-only endpoints (never active in production) ──────────────────
if (process.env.NODE_ENV !== 'production') {
  // Snapshot current server config state for test isolation
  app.post('/api/__test/snapshot', async (c) => {
    try {
      let aesRaw: string
      try { aesRaw = readFileSync(AES_PATH, 'utf-8') } catch { aesRaw = '{"aes":[]}' }
      let customersRaw: string
      try { customersRaw = readFileSync(CUSTOMERS_PATH, 'utf-8') } catch { customersRaw = '{"customers":[]}' }
      return c.json({ aes: JSON.parse(aesRaw), customers: JSON.parse(customersRaw) })
    } catch (e) {
      return c.json({ error: 'snapshot failed' }, 500)
    }
  })

  // Restore config state from snapshot (test cleanup)
  app.post('/api/__test/restore', async (c) => {
    try {
      const snap = await c.req.json()
      const aesData = snap.aes ?? { aes: [] }
      const customersData = snap.customers ?? { customers: [] }
      writeFileSync(AES_PATH + '.tmp', JSON.stringify(aesData, null, 2))
      renameSync(AES_PATH + '.tmp', AES_PATH)
      writeFileSync(CUSTOMERS_PATH + '.tmp', JSON.stringify(customersData, null, 2))
      renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
      // Reload in-memory state via setters (can't reassign imported bindings)
      setAes(aesData.aes ?? [])
      setCustomers(customersData.customers ?? [])
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: 'restore failed' }, 500)
    }
  })
}

export default { port, fetch: app.fetch, idleTimeout: 120 }
