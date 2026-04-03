import { existsSync, readFileSync } from 'fs'
import { writeFile, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { aes, patchAe } from './server-state.ts'
import { recordScrapeSuccess, recordScrapeExpired, lastScraped } from './rh-auth.ts'
import { runRhScrape, SessionExpiredError, closeScrapeContext, browserDegraded, browserDegradedReason } from './rh-scraper.ts'
import { runSfPipelineSync, scrapeSfReport, writePipelineSheet, createPipelineSheet, getSfContext, listSfReports, lastSfSync, lastSfRowCount } from './sf-scraper.ts'
import { getSfAuthStatus } from './sf-auth.ts'
import { supportableScrapeRunning, lastSupportableScrape, lastSupportableError } from './supportable-scraper.ts'
import { ccspScrapeRunning, lastCcspScrape, lastCcspError } from './ccsp-scraper.ts'
import { getRefreshIntervals } from './settings-api.ts'
import { refreshPipeline } from './refresh-engine.ts'
import { sanitizeErr } from './utils.ts'

// ── BKL-M50e: Scraper telemetry + history ──────────────────────────────────

export interface ScrapeLogEntry {
  timestamp: string
  service: 'rh' | 'ccsp' | 'supportable' | 'salesforce'
  durationMs: number
  recordCount: number
  status: 'success' | 'failure' | 'skipped' | 'timeout'
  error?: string
}

const SCRAPE_LOG_PATH = resolve(process.env.CACHE_DIR ?? 'data/cache', 'scrape-log.json')
const MAX_ENTRIES_PER_SERVICE = 100

/** In-memory telemetry log, keyed by service for fast lookups. */
const _telemetryLog: Map<string, ScrapeLogEntry[]> = new Map()

/** Load telemetry from disk on startup. */
function loadTelemetryLog(): void {
  try {
    if (!existsSync(SCRAPE_LOG_PATH)) return
    const raw = readFileSync(SCRAPE_LOG_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, ScrapeLogEntry[]>
    for (const [service, entries] of Object.entries(parsed)) {
      if (Array.isArray(entries)) {
        _telemetryLog.set(service, entries.slice(-MAX_ENTRIES_PER_SERVICE))
      }
    }
    console.log('[telemetry] loaded scrape log from disk')
  } catch (e: any) {
    console.warn('[telemetry] failed to load scrape log:', e?.message)
  }
}

// Load on module init
loadTelemetryLog()

/** Persist telemetry to disk atomically with mode 0o600. */
async function persistTelemetryLog(): Promise<void> {
  try {
    const obj: Record<string, ScrapeLogEntry[]> = {}
    for (const [service, entries] of _telemetryLog) {
      obj[service] = entries
    }
    const tmpPath = SCRAPE_LOG_PATH + '.tmp'
    await writeFile(tmpPath, JSON.stringify(obj, null, 2), { mode: 0o600 })
    await rename(tmpPath, SCRAPE_LOG_PATH)
  } catch (e: any) {
    console.warn('[telemetry] failed to persist scrape log:', e?.message)
  }
}

/** Record a scrape result — appends to in-memory log and writes to disk. */
export function recordScrapeResult(entry: ScrapeLogEntry): void {
  const key = entry.service
  if (!_telemetryLog.has(key)) _telemetryLog.set(key, [])
  const list = _telemetryLog.get(key)!
  list.push(entry)
  // Rolling window: trim to last MAX_ENTRIES_PER_SERVICE
  if (list.length > MAX_ENTRIES_PER_SERVICE) {
    _telemetryLog.set(key, list.slice(-MAX_ENTRIES_PER_SERVICE))
  }
  // Fire-and-forget disk write
  persistTelemetryLog().catch(() => {})
}

/** Get all telemetry entries for the API endpoint. */
export function getTelemetryLog(): Record<string, ScrapeLogEntry[]> {
  const obj: Record<string, ScrapeLogEntry[]> = {}
  for (const [service, entries] of _telemetryLog) {
    obj[service] = entries
  }
  return obj
}

/** Get summary stats per service. */
export function getTelemetrySummary(): Record<string, {
  totalRuns: number
  avgDurationMs: number
  successRate: number
  lastRun: ScrapeLogEntry | null
  last5: ScrapeLogEntry[]
}> {
  const summary: Record<string, any> = {}
  for (const service of ['rh', 'ccsp', 'supportable', 'salesforce']) {
    const entries = _telemetryLog.get(service) ?? []
    const successEntries = entries.filter(e => e.status === 'success')
    const avgDuration = successEntries.length > 0
      ? Math.round(successEntries.reduce((sum, e) => sum + e.durationMs, 0) / successEntries.length)
      : 0
    summary[service] = {
      totalRuns: entries.length,
      avgDurationMs: avgDuration,
      successRate: entries.length > 0
        ? Math.round((successEntries.length / entries.length) * 100) / 100
        : 0,
      lastRun: entries.length > 0 ? entries[entries.length - 1] : null,
      last5: entries.slice(-5),
    }
  }
  return summary
}

// ── BKL-M50c: Circuit breaker per service ────────────────────────────────────

class CircuitBreaker {
  private _failureCount = 0
  private _openedAt: number | null = null
  private _lastFailure: string | null = null
  readonly name: string
  readonly threshold: number
  readonly cooldownMs: number

  constructor(name: string, threshold = 3, cooldownMs = 5 * 60 * 1000) {
    this.name = name
    this.threshold = threshold
    this.cooldownMs = cooldownMs
  }

  /** Returns true if the circuit is open (service should be skipped). */
  isOpen(): boolean {
    if (this._failureCount < this.threshold) return false
    // Check if cooldown has elapsed — if so, allow a retry (half-open)
    if (this._openedAt && (Date.now() - this._openedAt) >= this.cooldownMs) {
      console.log(`[circuit-breaker] ${this.name}: cooldown elapsed — allowing retry (half-open)`)
      return false
    }
    return true
  }

  recordSuccess(): void {
    if (this._failureCount > 0) {
      console.log(`[circuit-breaker] ${this.name}: success — resetting (was at ${this._failureCount} failures)`)
    }
    this._failureCount = 0
    this._openedAt = null
    this._lastFailure = null
  }

  recordFailure(reason: string): void {
    this._failureCount++
    this._lastFailure = reason
    if (this._failureCount >= this.threshold) {
      this._openedAt = Date.now()
      console.warn(`[circuit-breaker] ${this.name}: OPEN after ${this._failureCount} failures — cooldown ${this.cooldownMs / 1000}s (last: ${reason})`)
    } else {
      console.warn(`[circuit-breaker] ${this.name}: failure ${this._failureCount}/${this.threshold} (${reason})`)
    }
  }

  getState(): { name: string; state: 'closed' | 'open' | 'half-open'; failures: number; lastFailure: string | null } {
    let state: 'closed' | 'open' | 'half-open' = 'closed'
    if (this._failureCount >= this.threshold) {
      state = (this._openedAt && (Date.now() - this._openedAt) >= this.cooldownMs) ? 'half-open' : 'open'
    }
    return { name: this.name, state, failures: this._failureCount, lastFailure: this._lastFailure }
  }
}

const circuitBreakers = {
  rh: new CircuitBreaker('rh'),
  ccsp: new CircuitBreaker('ccsp'),
  supportable: new CircuitBreaker('supportable'),
  salesforce: new CircuitBreaker('salesforce'),
}

/** Get circuit breaker states for all services — exposed for /api/status endpoint. */
export function getCircuitBreakerStates(): Record<string, ReturnType<CircuitBreaker['getState']>> {
  return {
    rh: circuitBreakers.rh.getState(),
    ccsp: circuitBreakers.ccsp.getState(),
    supportable: circuitBreakers.supportable.getState(),
    salesforce: circuitBreakers.salesforce.getState(),
  }
}

/** Reset a single circuit breaker — used when auth is re-established. */
export function resetCircuitBreaker(service: 'rh' | 'ccsp' | 'supportable' | 'salesforce'): void {
  circuitBreakers[service].recordSuccess()
  console.log(`[circuit-breaker] ${service}: reset by auth event`)
}

/** Reset ALL circuit breakers — called on re-authentication (cold-start recovery). */
export function resetAllCircuitBreakers(): void {
  for (const [name, cb] of Object.entries(circuitBreakers)) {
    if (cb.getState().failures > 0) {
      cb.recordSuccess()
      console.log(`[circuit-breaker] ${name}: reset by auth event`)
    }
  }
}

// ── BKL-M50c: Wall-clock timeout wrapper ─────────────────────────────────────

const DEFAULT_SCRAPE_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes (CCSP, Supportable, SF)
const RH_SCRAPE_TIMEOUT_MS = 10 * 60 * 1000      // 10 minutes (RH iterates 50+ accounts at 3-5s each)

/**
 * Wrap a promise with a wall-clock timeout. If the timeout fires, the promise
 * is abandoned (not cancelled — Playwright operations don't support AbortSignal)
 * and a descriptive error is thrown.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[timeout] ${label} exceeded ${ms / 1000}s wall-clock limit`))
    }, ms)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── ntfy.sh push notification helper ────────────────────────────────────────
const NTFY_TOPIC = process.env.NTFY_TOPIC ?? 'asa-command-center'
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

// ── BKL-M50f: Last skip reason per service ───────────────────────────────────
const _lastSkipReasons = new Map<string, { reason: string; at: string }>()

export function setLastSkipReason(service: string, reason: string): void {
  _lastSkipReasons.set(service, { reason, at: new Date().toISOString() })
}

export function getLastSkipReasons(): Record<string, { reason: string; at: string } | null> {
  return {
    rh: _lastSkipReasons.get('rh') ?? null,
    ccsp: _lastSkipReasons.get('ccsp') ?? null,
    supportable: _lastSkipReasons.get('supportable') ?? null,
    salesforce: _lastSkipReasons.get('salesforce') ?? null,
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
  // BKL-M50c: Circuit breaker check
  if (circuitBreakers.rh.isOpen()) {
    const state = circuitBreakers.rh.getState()
    console.warn(`[rh-scraper] circuit breaker OPEN (${state.failures} failures) — skipping scrape`)
    return
  }

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

  const _rhTelemetryStart = Date.now()
  try {
    console.log(`[rh-scraper] scraping ${accountNumbers.length} accounts…`)
    // BKL-M50c: Wrap with wall-clock timeout to prevent 7+ min stalls
    const cases = await withTimeout(
      runRhScrape({
        accountNumbers,
        profileDir: RH_PROFILE_DIR,
        cachePath: RH_CASES_CACHE_PATH,
        shouldCancel: () => _rhScrapeCancelRequested,
      }),
      RH_SCRAPE_TIMEOUT_MS,
      'RH case scrape',
    )
    _rhScrapeLastError = null
    recordScrapeSuccess(cases.length)
    circuitBreakers.rh.recordSuccess()

    // BKL-M50e: Record telemetry
    recordScrapeResult({
      timestamp: new Date().toISOString(),
      service: 'rh',
      durationMs: Date.now() - _rhTelemetryStart,
      recordCount: cases.length,
      status: 'success',
    })

    // BKL-M21: Post-scrape account count validation — warn if results seem partial
    const expectedAccounts = accountNumbers.length
    const scrapedAccounts = new Set(cases.map(c => c.accountNumber)).size
    if (scrapedAccounts < expectedAccounts * 0.5) {
      console.warn(`[scraper-validation] WARNING: scraped cases for ${scrapedAccounts} accounts but expected ~${expectedAccounts} — possible partial scrape`)
    }

    console.log(`[rh-scraper] done — ${cases.length} cases cached`)
    notify('RH Cases Synced', `${cases.length} support cases cached`).catch(() => {})
  } catch (e: any) {
    // BKL-M50e: Record failure telemetry
    const isTimeout = e?.message?.includes('[timeout]')
    recordScrapeResult({
      timestamp: new Date().toISOString(),
      service: 'rh',
      durationMs: Date.now() - _rhTelemetryStart,
      recordCount: 0,
      status: isTimeout ? 'timeout' : 'failure',
      error: sanitizeErr(e),
    })

    if (e instanceof SessionExpiredError) {
      _rhScrapeLastError = 'Session expired — reconnect via dashboard'
      recordScrapeExpired()
      circuitBreakers.rh.recordFailure('session expired')
      await closeScrapeContext() // discard expired context so next login gets a clean one
      console.warn('[rh-scraper] session expired — reconnect via dashboard')
      notify('Red Hat Session Expired', 'Session expired during case scrape — reconnect via dashboard', 'high').catch(() => {})
    } else {
      _rhScrapeLastError = sanitizeErr(e)
      circuitBreakers.rh.recordFailure(sanitizeErr(e))
      console.warn('[rh-scraper]', sanitizeErr(e))
    }
  } finally {
    _rhScrapeRunning = false
    _rhScrapeStartedAt = null
    _rhScrapeCancelRequested = false
  }
}

// ── SF sync helper (shared between login callback and sync route) ───────────

function runSfSyncForAes(aesWithSf: typeof aes): Promise<void> {
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
  return (async () => {
    const _sfTelemetryStart = Date.now()
    let totalRows = 0

    // BKL-F11: Group AEs by sfReportId to avoid scraping the same report multiple times
    const reportToAes = new Map<string, typeof aesWithSf>()
    for (const ae of aesWithSf) {
      const reportId = ae.sfReportId!
      if (!reportToAes.has(reportId)) reportToAes.set(reportId, [])
      reportToAes.get(reportId)!.push(ae)
    }

    for (const [reportId, reportAes] of reportToAes) {
      if (_sfSyncCancelRequested) {
        console.log(`[sf-sync] cancel requested — stopping before report ${reportId}`)
        break
      }

      if (reportAes.length > 1) {
        console.log(`[sf-sync] Report ${reportId} shared by ${reportAes.length} AEs — scraping once, writing to ${reportAes.length} sheets`)
      }

      try {
        // Scrape once per unique report
        const data = await scrapeSfReport(reportId, RH_PROFILE_DIR)

        // Fan out: write the same data to each AE's pipeline sheet
        for (const ae of reportAes) {
          if (_sfSyncCancelRequested) {
            console.log(`[sf-sync] cancel requested — stopping before writing for ${ae.name}`)
            break
          }
          try {
            let sheetId = ae.pipelineSheetId
            if (!sheetId) {
              sheetId = await createPipelineSheet(ae.name, ae.driveFolderId)
              patchAe(ae.name, { pipelineSheetId: sheetId })
            }
            await writePipelineSheet(data, sheetId)
            totalRows += data.rows.length
            console.log(`[sf-sync] wrote ${data.rows.length} rows to ${ae.name}'s pipeline sheet`)
          } catch (e: any) {
            console.warn(`[sf-sync] sheet write failed for ${ae.name}:`, sanitizeErr(e))
            _sfSyncLastError = sanitizeErr(e)
          }
        }
      } catch (e: any) {
        console.warn(`[sf-sync] SF scrape failed for report ${reportId}:`, sanitizeErr(e))
        _sfSyncLastError = sanitizeErr(e)
      }
    }

    // BKL-M50e: Record telemetry for SF sync
    recordScrapeResult({
      timestamp: new Date().toISOString(),
      service: 'salesforce',
      durationMs: Date.now() - _sfTelemetryStart,
      recordCount: totalRows,
      status: _sfSyncLastError ? 'failure' : 'success',
      error: _sfSyncLastError ?? undefined,
    })
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
      // Circuit breaker states per service
      circuitBreakers: getCircuitBreakerStates(),
      // BKL-M50c: Browser degraded state
      browserDegraded,
      browserDegradedReason,
      // BKL-M50f: Last skip reasons per service
      lastSkipReasons: getLastSkipReasons(),
    })
  })
}

// ── Exported for use in server.ts login callbacks ───────────────────────────
// These are used by the POST /api/auth/salesforce/start and POST /api/auth/redhat/start
// routes that remain in server.ts (they depend on startLoginBrowser callbacks).

export { runSfSyncForAes }
