import { existsSync } from 'fs'
import type { Hono } from 'hono'
import { aes, patchAe } from './server-state.ts'
import { recordScrapeSuccess, recordScrapeExpired, lastScraped } from './rh-auth.ts'
import { runRhScrape, SessionExpiredError, closeScrapeContext } from './rh-scraper.ts'
import { runSfPipelineSync, createPipelineSheet, getSfContext, listSfReports, lastSfSync, lastSfRowCount } from './sf-scraper.ts'
import { getSfAuthStatus } from './sf-auth.ts'
import { supportableScrapeRunning, lastSupportableScrape, lastSupportableError } from './supportable-scraper.ts'
import { ccspScrapeRunning, lastCcspScrape, lastCcspError } from './ccsp-scraper.ts'
import { getRefreshIntervals } from './settings-api.ts'
import { refreshPipeline } from './refresh-engine.ts'

// ── Shared helpers (duplicated from server.ts to avoid circular dep) ────────

const sanitizeErr = (e: any): string =>
  String(e?.message ?? e).slice(0, 200).replace(/\/[^\s:]+\.(ts|js)/g, '[file]')

// ── ntfy.sh push notification helper ────────────────────────────────────────
const NTFY_TOPIC = process.env.NTFY_TOPIC ?? 'pai-notifications'
async function notify(title: string, message: string, priority: 'default' | 'high' | 'urgent' = 'default'): Promise<void> {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { 'Title': title.slice(0, 64), 'Priority': priority, 'Content-Type': 'text/plain' },
      body: message.slice(0, 512),
    })
  } catch (e: any) {
    console.warn('[ntfy] notification failed:', e?.message ?? e)
  }
}

// ── BKL-T04: Live probe with 30s cache ──────────────────────────────────────
const _probeCache = new Map<string, { result: boolean; at: number }>()
const PROBE_TTL_MS = 30_000

async function sfLiveProbe(): Promise<boolean> {
  const key = 'sf'
  const cached = _probeCache.get(key)
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.result
  try {
    const res = await fetch('https://redhatcrm.lightning.force.com/lightning/n/Home', {
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    })
    const alive = res.status < 400
    _probeCache.set(key, { result: alive, at: Date.now() })
    return alive
  } catch {
    _probeCache.set(key, { result: false, at: Date.now() })
    return false
  }
}

// ── Module state (injected at init) ─────────────────────────────────────────
let RH_SESSION_PATH = ''
let RH_PROFILE_DIR = ''
let RH_CASES_CACHE_PATH = ''
let SF_SESSION_PATH = ''
let SF_REPORT_ID = ''

export function initScraperManager(opts: {
  rhSessionPath: string
  rhProfileDir: string
  rhCasesCachePath: string
  sfSessionPath: string
  sfReportId: string
}): void {
  RH_SESSION_PATH = opts.rhSessionPath
  RH_PROFILE_DIR = opts.rhProfileDir
  RH_CASES_CACHE_PATH = opts.rhCasesCachePath
  SF_SESSION_PATH = opts.sfSessionPath
  SF_REPORT_ID = opts.sfReportId
}

// ── Scraper state ───────────────────────────────────────────────────────────

// Guards the full CCSP scrape+write pipeline (ccspScrapeRunning only covers Playwright phase)
export let ccspInFlight = false

// RH scraper state
export let _rhScrapeRunning = false
export let _rhScrapeStartedAt: number | null = null
export let _rhScrapeCancelRequested = false
export let _rhScrapeLastError: string | null = null
const RH_STALE_MUTEX_MS = 15 * 60 * 1000  // 15 min auto-release — same as CCSP/Supportable

// SF sync state
export let _sfSyncRunning = false
export let _sfSyncStartedAt: number | null = null
export let _sfSyncCancelRequested = false
export let _sfSyncLastError: string | null = null

// ── Setters for cross-module state mutation (ESM live bindings) ─────────────

export function setCcspInFlight(v: boolean): void { ccspInFlight = v }
export function setRhScrapeCancelRequested(v: boolean): void { _rhScrapeCancelRequested = v }
export function setSfSyncRunning(v: boolean): void { _sfSyncRunning = v }
export function setSfSyncStartedAt(v: number | null): void { _sfSyncStartedAt = v }
export function setSfSyncCancelRequested(v: boolean): void { _sfSyncCancelRequested = v }
export function setSfSyncLastError(v: string | null): void { _sfSyncLastError = v }

// ── RH scrape orchestration ─────────────────────────────────────────────────

export async function runRhScrapeWithState(): Promise<void> {
  if (_rhScrapeRunning) {
    if (_rhScrapeStartedAt && (Date.now() - _rhScrapeStartedAt) > RH_STALE_MUTEX_MS) {
      console.warn(`[rh-scraper] stale mutex detected (${Math.round((Date.now() - _rhScrapeStartedAt) / 60000)}min) — auto-releasing`)
      _rhScrapeRunning = false
      _rhScrapeStartedAt = null
    } else {
      console.log('[rh-scraper] already running — skipping'); return
    }
  }
  if (!existsSync(RH_SESSION_PATH)) return

  // Collect account numbers from customers config — check before setting flag to avoid leak
  const { customers } = await import('./server-state.ts')
  const accountNumbers = customers
    .flatMap((c) => (c.accountNumbers ?? []).map(String))
    .filter(Boolean)

  if (accountNumbers.length === 0) {
    console.log('[rh-scraper] no account numbers configured — skipping')
    return
  }

  _rhScrapeRunning = true
  _rhScrapeStartedAt = Date.now()
  _rhScrapeCancelRequested = false

  try {
    console.log(`[rh-scraper] scraping ${accountNumbers.length} accounts…`)
    const cases = await runRhScrape({
      accountNumbers,
      profileDir: RH_PROFILE_DIR,
      cachePath: RH_CASES_CACHE_PATH,
      shouldCancel: () => _rhScrapeCancelRequested,
    })
    _rhScrapeLastError = null
    recordScrapeSuccess(cases.length)

    // BKL-M21: Post-scrape account count validation — warn if results seem partial
    const expectedAccounts = accountNumbers.length
    const scrapedAccounts = new Set(cases.map(c => c.accountNumber)).size
    if (scrapedAccounts < expectedAccounts * 0.5) {
      console.warn(`[scraper-validation] WARNING: scraped cases for ${scrapedAccounts} accounts but expected ~${expectedAccounts} — possible partial scrape`)
    }

    console.log(`[rh-scraper] done — ${cases.length} cases cached`)
    notify('RH Cases Synced', `${cases.length} support cases cached`).catch(() => {})
  } catch (e: any) {
    if (e instanceof SessionExpiredError) {
      _rhScrapeLastError = 'Session expired — reconnect via dashboard'
      recordScrapeExpired()
      await closeScrapeContext() // discard expired context so next login gets a clean one
      console.warn('[rh-scraper] session expired — reconnect via dashboard')
      notify('Red Hat Session Expired', 'Session expired during case scrape — reconnect via dashboard', 'high').catch(() => {})
    } else {
      _rhScrapeLastError = sanitizeErr(e)
      console.warn('[rh-scraper]', sanitizeErr(e))
    }
  } finally {
    _rhScrapeRunning = false
    _rhScrapeStartedAt = null
    _rhScrapeCancelRequested = false
  }
}

// ── SF sync helper (shared between login callback and sync route) ───────────

function runSfSyncForAes(aesWithSf: typeof aes): void {
  if (_sfSyncRunning && _sfSyncStartedAt && (Date.now() - _sfSyncStartedAt > 15 * 60 * 1000)) {
    console.warn('[sf-sync] stale mutex in login callback — auto-releasing')
    _sfSyncRunning = false
    _sfSyncStartedAt = null
  }
  if (_sfSyncRunning) return
  _sfSyncRunning = true
  _sfSyncStartedAt = Date.now()
  _sfSyncCancelRequested = false
  _sfSyncLastError = null
  ;(async () => {
    for (const ae of aesWithSf) {
      if (_sfSyncCancelRequested) {
        console.log(`[sf-sync] cancel requested — stopping before ${ae.name}`)
        break
      }
      try {
        let sheetId = ae.pipelineSheetId
        if (!sheetId) {
          sheetId = await createPipelineSheet(ae.name, ae.driveFolderId)
          patchAe(ae.name, { pipelineSheetId: sheetId })
        }
        await runSfPipelineSync(ae.sfReportId!, RH_PROFILE_DIR, sheetId)
      } catch (e: any) {
        console.warn(`[server] SF sync failed for ${ae.name}:`, sanitizeErr(e))
        _sfSyncLastError = sanitizeErr(e)
      }
    }
  })().catch((e: any) => {
    console.error('[server] SF login callback error:', sanitizeErr(e))
    _sfSyncLastError = sanitizeErr(e)
  }).finally(() => {
    _sfSyncRunning = false
    _sfSyncStartedAt = null
    _sfSyncCancelRequested = false
    // Populate local pipeline cache from the newly-written sheet (BKL-M18)
    refreshPipeline().catch(e => console.warn('[sf-sync] post-sync pipeline cache refresh failed:', sanitizeErr(e)))
  })
}

// ── Route registration ──────────────────────────────────────────────────────
// BKL-M25: Scrape-specific routes moved to src/scrape-api.ts (registerScrapeRoutes).
// Routes kept here are auth/status helpers that are NOT scrape triggers.

export function registerScraperRoutes(app: Hono): void {

  // GET /api/auth/salesforce/status — auth + sync status for SF (kept: auth surface)
  app.get('/api/auth/salesforce/status', async (c) => {
    // BKL-T04: Live session probe — verifies SF is actually reachable, not just flagged
    const liveReachable = await sfLiveProbe()
    return c.json({
      ...getSfAuthStatus(SF_SESSION_PATH),
      lastSync: lastSfSync,
      rowCount: lastSfRowCount,
      syncError: _sfSyncLastError,
      reportConfigured: !!SF_REPORT_ID || aes.some(a => !!a.sfReportId),
      sheetConfigured: !!process.env.PIPELINE_FILE_ID,
      liveReachable,
    })
  })

  // GET /api/sf/reports — list available SF pipeline reports (requires active SF session)
  app.get('/api/sf/reports', async (c) => {
    if (!getSfContext()) {
      return c.json({ reports: [], error: 'SF session not active', source: null })
    }
    try {
      const reports = await listSfReports()
      const source = reports.length > 0 ? 'api' : 'empty'
      return c.json({ reports, source })
    } catch (e: any) {
      console.error('[sf/reports] failed:', e.message)
      return c.json({ reports: [], error: 'Failed to fetch report list', source: null })
    }
  })

  // POST /api/auth/supportable/check — VPN reachability probe (no browser tabs)
  app.post('/api/auth/supportable/check', async (c) => {
    try {
      await fetch('https://supportable.corp.redhat.com:4443/pls/rhapplications/f?p=304:1', {
        method: 'HEAD',
        signal: AbortSignal.timeout(8_000),
        redirect: 'manual',
        tls: { rejectUnauthorized: false },
      })
      return c.json({ reachable: true })
    } catch {
      return c.json({ reachable: false })
    }
  })

  // GET /api/status/scrapes — per-scraper sync status (lastSync, lastError, isRunning, isStale)
  // Used by the dashboard to show staleness indicators per data section.
  app.get('/api/status/scrapes', (c) => {
    const intervals = getRefreshIntervals()
    const now = Date.now()

    function isStale(lastSync: string | null, intervalMinutes: number): boolean {
      if (!lastSync) return true
      return (now - new Date(lastSync).getTime()) > intervalMinutes * 2 * 60 * 1000
    }

    return c.json({
      supportable: {
        lastSync:  lastSupportableScrape,
        lastError: lastSupportableError ? lastSupportableError.slice(0, 200).replace(/\/[^\s:]+\.(ts|js)/g, '[file]') : null,
        isRunning: supportableScrapeRunning,
        isStale:   isStale(lastSupportableScrape, 4 * 60),
      },
      ccsp: {
        lastSync:  lastCcspScrape,
        lastError: lastCcspError ? lastCcspError.slice(0, 200).replace(/\/[^\s:]+\.(ts|js)/g, '[file]') : null,
        isRunning: ccspScrapeRunning || ccspInFlight,
        isStale:   isStale(lastCcspScrape, intervals.ccsp),
      },
      rh: {
        lastSync:  lastScraped,
        lastError: _rhScrapeLastError,
        isRunning: _rhScrapeRunning,
        isStale:   isStale(lastScraped, intervals.rhScrape),
      },
      salesforce: {
        lastSync:  lastSfSync,
        lastError: _sfSyncLastError,
        isRunning: _sfSyncRunning,
        isStale:   isStale(lastSfSync, intervals.subscriptions),
      },
    })
  })
}

// ── Exported for use in server.ts login callbacks ───────────────────────────
// These are used by the POST /api/auth/salesforce/start and POST /api/auth/redhat/start
// routes that remain in server.ts (they depend on startLoginBrowser callbacks).

export { runSfSyncForAes }
