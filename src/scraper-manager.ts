import { existsSync, readFileSync } from 'fs'
import { writeFile, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { aes, patchAe } from './server-state.ts'
import { recordScrapeStart, recordScrapeSuccess, recordScrapeExpired, lastScraped } from './rh-auth.ts'
import { runRhScrape, SessionExpiredError, closeScrapeContext, browserDegraded, browserDegradedReason, discoverAccountNumberByName, closeDiscoverPage, writeCasesCache } from './rh-scraper.ts'
// BKL-RH-03 Phase 2 (ADR-014): Bearer transport for recurring case refresh
import { BearerCaseClient, getConfiguredTransport } from './case-client.ts'
import type { SupportCase } from './types.ts'
import { runSfPipelineSync, scrapeSfReport, writePipelineSheet, createPipelineSheet, getSfContext, listSfReports, lastSfSync, lastSfRowCount, recordSfSyncSuccess } from './sf-scraper.ts'
import { getSfAuthStatus } from './sf-auth.ts'
import { supportableScrapeRunning, lastSupportableScrape, lastSupportableError } from './supportable-scraper.ts'
import { ccspScrapeRunning, lastCcspScrape, lastCcspError } from './ccsp-scraper.ts'
import { getRefreshIntervals, getAutomationConfig } from './settings-api.ts'
import { refreshPipeline } from './refresh-engine.ts'
import { sanitizeErr } from './utils.ts'
import { deriveConfidence, ConnectionHealthSchema } from './connection-health.ts'
import { markRunning, recordOutcome, getScraperStatus } from './scraper-status-store.ts'

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

// BKL-SR03-F1: threshold/cooldownMs are read lazily via getter functions so that
// changes saved through POST /api/settings/automation take effect on the live
// breakers without a container restart. Do NOT bake config values into instance
// fields at construction — the previous shape (readonly threshold/cooldownMs +
// values pulled once at module init) is the bug this fix exists to prevent.
class CircuitBreaker {
  private _failureCount = 0
  private _openedAt: number | null = null
  private _lastFailure: string | null = null
  _sessionExpired = false
  _sessionExpiredAt: number | null = null
  readonly name: string
  private readonly _getThreshold: () => number
  private readonly _getCooldownMs: () => number

  constructor(
    name: string,
    getThreshold: () => number = () => 3,
    getCooldownMs: () => number = () => 5 * 60 * 1000,
  ) {
    this.name = name
    this._getThreshold = getThreshold
    this._getCooldownMs = getCooldownMs
  }

  /** Current threshold — read lazily from config every call (BKL-SR03-F1). */
  get threshold(): number {
    return this._getThreshold()
  }

  /** Current cooldownMs — read lazily from config every call (BKL-SR03-F1). */
  get cooldownMs(): number {
    return this._getCooldownMs()
  }

  /** Returns true if the circuit is open (service should be skipped). */
  isOpen(): boolean {
    // Session-expiry pin: hold open for 4 hours after a SessionExpiredError
    if (this._sessionExpired) {
      const elapsed = Date.now() - (this._sessionExpiredAt ?? 0)
      if (elapsed < 4 * 60 * 60 * 1000) {
        return true
      }
      // 4-hour window elapsed — clear the pin and fall through to normal logic
      this._sessionExpired = false
      this._sessionExpiredAt = null
      console.log(`[circuit-breaker] ${this.name}: session-expiry pin cleared after 4h — allowing retry`)
    }
    const threshold = this._getThreshold()
    const cooldownMs = this._getCooldownMs()
    if (this._failureCount < threshold) return false
    // Check if cooldown has elapsed — if so, allow a retry (half-open)
    if (this._openedAt && (Date.now() - this._openedAt) >= cooldownMs) {
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
    this._sessionExpired = false
    this._sessionExpiredAt = null
  }

  recordFailure(reason: string, sessionExpired = false): void {
    this._failureCount++
    this._lastFailure = reason
    if (sessionExpired) {
      this._sessionExpired = true
      this._sessionExpiredAt = Date.now()
      console.warn(`[circuit-breaker] ${this.name}: session-expiry pin set — held open for 4h`)
    }
    const threshold = this._getThreshold()
    const cooldownMs = this._getCooldownMs()
    if (this._failureCount >= threshold) {
      this._openedAt = Date.now()
      console.warn(`[circuit-breaker] ${this.name}: OPEN after ${this._failureCount} failures — cooldown ${cooldownMs / 1000}s (last: ${reason})`)
    } else {
      console.warn(`[circuit-breaker] ${this.name}: failure ${this._failureCount}/${threshold} (${reason})`)
    }
  }

  getState(): { name: string; state: 'closed' | 'open' | 'half-open'; failures: number; lastFailure: string | null } {
    let state: 'closed' | 'open' | 'half-open' = 'closed'
    const threshold = this._getThreshold()
    const cooldownMs = this._getCooldownMs()
    if (this._failureCount >= threshold) {
      state = (this._openedAt && (Date.now() - this._openedAt) >= cooldownMs) ? 'half-open' : 'open'
    }
    return { name: this.name, state, failures: this._failureCount, lastFailure: this._lastFailure }
  }
}

// BKL-SR03-F1: Pass getter functions (not values) so each breaker re-reads the
// live AutomationConfig on every check. This is what makes the "Save" button on
// the Automation settings page take effect immediately for circuit breakers.
const _thresholdGetter   = (): number => getAutomationConfig().circuitBreakerThreshold
const _cooldownMsGetter  = (): number => getAutomationConfig().circuitBreakerCooldownMs
const circuitBreakers = {
  rh: new CircuitBreaker('rh', _thresholdGetter, _cooldownMsGetter),
  ccsp: new CircuitBreaker('ccsp', _thresholdGetter, _cooldownMsGetter),
  supportable: new CircuitBreaker('supportable', _thresholdGetter, _cooldownMsGetter),
  salesforce: new CircuitBreaker('salesforce', _thresholdGetter, _cooldownMsGetter),
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
    if (cb.getState().failures > 0 || cb._sessionExpired) {
      cb.recordSuccess()
      console.log(`[circuit-breaker] ${name}: reset by auth event`)
    }
  }
}

// ── BKL-M50c: Wall-clock timeout wrapper ─────────────────────────────────────

const DEFAULT_SCRAPE_TIMEOUT_MS = () => getAutomationConfig().defaultScrapeTimeoutMs
const RH_SCRAPE_TIMEOUT_MS = () => getAutomationConfig().rhScrapeTimeoutMs

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
export let _rhDiscoveryProgress: { done: number; total: number; current: string | null } | null = null
const RH_STALE_MUTEX_MS = 15 * 60 * 1000  // 15 min auto-release — same as CCSP/Supportable

// SF probe timestamp — records when sfLiveProbe last ran in the status endpoint
let _sfProbeTimestamp: string | null = null

// SF sync state
export let _sfSyncRunning = false
export let _sfSyncStartedAt: number | null = null
export let _sfSyncCancelRequested = false
export let _sfSyncLastError: string | null = null
let _sfTotalRows = 0

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

  // Collect account numbers from customers config; discover missing ones by name
  const serverState = await import('./server-state.ts')
  let accountNumbers = serverState.customers
    .flatMap((c) => (c.accountNumbers ?? []).map(String))
    .filter(Boolean)

  // Discover account numbers for all customers that don't have them yet.
  // Uses POST /hydra/rest/search/v2/cases with account_name: Solr field.
  // For customers without account numbers: search by full name.
  // Primary goal = find cases. Bonus = discover account numbers for future runs.
  // Cases found via name search are folded directly into nameDiscoveredCases for display.
  const needsDiscovery = serverState.customers.filter((c) => !c.accountNumbers?.length)
  const nameDiscoveredCases: import('./rh-scraper.ts').DiscoverResult['cases'] = []
  if (needsDiscovery.length > 0) {
    console.log(`[rh-scraper] name-searching portal for ${needsDiscovery.length} customers without account numbers…`)
    _rhDiscoveryProgress = { done: 0, total: needsDiscovery.length, current: null }
    const newNums: string[] = []
    // BKL-RH-PERF-01: per-customer timing instrumentation
    const discoveryWallStart = Date.now()
    let customersSkipped = 0
    let customersSearched = 0
    let totalSearchMs = 0
    for (const customer of needsDiscovery) {
      try {
        // BKL-RH-PERF-01: Negative cache — skip tombstoned customers until TTL expires
        const now = new Date()
        if ((customer as any).discoveryStatus === 'unresolvable' && (customer as any).discoverySkippedUntil) {
          if (new Date((customer as any).discoverySkippedUntil) > now) {
            console.log(`[rh-scraper] skipping "${customer.name}" — tombstoned until ${(customer as any).discoverySkippedUntil}`)
            _rhDiscoveryProgress = { ..._rhDiscoveryProgress!, done: _rhDiscoveryProgress!.done + 1, current: null }
            customersSkipped++
            continue
          }
          // TTL expired — clear status and retry
          serverState.patchCustomer(customer.name, { discoveryStatus: undefined, discoverySkippedUntil: undefined, discoveryFailures: 0 })
        }

        // Use SF canonical alias (full name from source sheet) for portal search.
        // Always use FULL name (with INC, LLC, Corp etc.) — avoids false positives from
        // accounts in different regions or owned by different account teams.
        const searchName = (customer as any).aliases?.[0] ?? customer.name
        const searchSource = (customer as any).aliases?.[0] ? 'alias' : 'name'
        _rhDiscoveryProgress = { ..._rhDiscoveryProgress!, current: customer.name }
        const discoverStart = Date.now()
        const { accountNumbers: nums, cases: discoveredCases } = await discoverAccountNumberByName(searchName, RH_PROFILE_DIR)
        const discoverMs = Date.now() - discoverStart
        customersSearched++
        totalSearchMs += discoverMs
        console.log(`[rh-scraper] searching portal for "${searchName}" [${searchSource}] (display: "${customer.name}") — ${discoverMs}ms`)

        // Fold any cases found into the result set — cases are the primary goal
        // BKL-UX55: Stamp customerName on name-discovered cases since we know the customer from the loop
        if (discoveredCases.length > 0) {
          nameDiscoveredCases.push(...discoveredCases.map(c => ({ ...c, customerName: customer.name })))
          console.log(`[rh-scraper] ${customer.name}: found ${discoveredCases.length} cases via name search`)
        }

        // Bonus: save discovered account numbers for future batch scrapes.
        // No cap — sidebar autocomplete returns real accounts (ground truth), not false positives.
        // Multi-entity companies like Microchip Technology legitimately have 7+ account numbers.
        if (nums.length > 0) {
          // BKL-RH-PERF-01: Clear failure count on successful discovery
          serverState.patchCustomer(customer.name, { accountNumbers: nums, discoveryFailures: 0, discoveryStatus: undefined, discoverySkippedUntil: undefined })
          newNums.push(...nums)
          console.log(`[rh-scraper] ${customer.name}: saved account numbers ${nums.join(', ')}`)
        } else if (discoveredCases.length === 0) {
          // BKL-RH-PERF-01: Negative cache — increment failure count, tombstone after 3
          const failures = ((customer as any).discoveryFailures ?? 0) + 1
          if (failures >= 3) {
            const skippedUntil = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
            serverState.patchCustomer(customer.name, {
              discoveryFailures: failures,
              discoveryStatus: 'unresolvable',
              discoverySkippedUntil: skippedUntil,
            })
            console.log(`[rh-scraper] "${customer.name}" tombstoned after ${failures} failures — skipping until ${skippedUntil}`)
          } else {
            serverState.patchCustomer(customer.name, { discoveryFailures: failures })
            console.log(`[rh-scraper] "${customer.name}" — failure ${failures}/3`)
          }
        }
      } catch (e: any) {
        if (e instanceof SessionExpiredError) throw e
        console.warn(`[rh-scraper] name discovery error for "${customer.name}": ${e?.message ?? e}`)
      }
      _rhDiscoveryProgress = { ..._rhDiscoveryProgress!, done: _rhDiscoveryProgress!.done + 1, current: null }
    }
    _rhDiscoveryProgress = null
    accountNumbers = [...new Set([...accountNumbers, ...newNums])]
    const discoveryWallMs = Date.now() - discoveryWallStart
    const avgMs = customersSearched > 0 ? Math.round(totalSearchMs / customersSearched) : 0
    console.log(`[rh-scraper] name search done — ${newNums.length} new account numbers, ${nameDiscoveredCases.length} cases found`)
    console.log(`[rh-scraper] discovery stats: wall=${discoveryWallMs}ms, skipped=${customersSkipped}, searched=${customersSearched}, avg=${avgMs}ms/customer`)
    await closeDiscoverPage()  // free the reused tab — no longer needed for discovery
  }

  // If no account numbers at all, we still may have name-discovered cases to cache
  if (accountNumbers.length === 0) {
    if (nameDiscoveredCases.length > 0) {
      console.log(`[rh-scraper] no account numbers but ${nameDiscoveredCases.length} name-search cases — caching those`)
      // Write name-discovered cases directly (no batch scrape needed)
      const { mkdir, writeFile, rename } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      await mkdir(dirname(RH_CASES_CACHE_PATH), { recursive: true })
      const tmpPath = RH_CASES_CACHE_PATH + '.tmp'
      await writeFile(tmpPath, JSON.stringify({ scrapedAt: new Date().toISOString(), accounts: [], cases: nameDiscoveredCases }, null, 2), { mode: 0o600 })
      await rename(tmpPath, RH_CASES_CACHE_PATH)
      recordOutcome('rh-cases', { success: true, recordCount: nameDiscoveredCases.length })
    } else {
      console.log('[rh-scraper] no account numbers and no name-search cases — nothing to cache')
      recordOutcome('rh-cases', { success: true, recordCount: 0 })
    }
    return
  }

  _rhScrapeRunning = true
  _rhScrapeStartedAt = Date.now()
  _rhScrapeCancelRequested = false

  const _rhTelemetryStart = Date.now()
  markRunning('rh-cases')
  recordScrapeStart() // BKL-UX60: clear sessionExpired at scrape start
  try {
    console.log(`[rh-scraper] scraping ${accountNumbers.length} accounts…`)
    // BKL-UX55: Build reverse map accountNumber → customerName for stamping cases
    const accountToCustomer = new Map<string, string>()
    for (const c of serverState.customers) {
      for (const num of c.accountNumbers ?? []) {
        accountToCustomer.set(String(num), c.name)
      }
    }
    // BKL-RH-03 Phase 2 (ADR-014): dual-transport branch for case refresh.
    //   'bearer'  — server-side SOLR via Bearer token (no browser); default.
    //   'browser' — legacy Playwright path; emergency revert via RH_CASES_TRANSPORT=browser.
    // Bootstrap/discovery above is browser-only (unchanged) — only this recurring
    // refresh batch is transport-switchable.
    const transport = getConfiguredTransport()
    console.log(`[scraper-manager] rh-cases transport=${transport}`)

    let cases: SupportCase[]
    if (transport === 'bearer') {
      const client = new BearerCaseClient()
      const fetchedCases = await withTimeout(
        client.fetchCases(accountNumbers, accountToCustomer),
        RH_SCRAPE_TIMEOUT_MS(),
        'RH case scrape (bearer)',
      )
      // Stale-overwrite guard (mirrors rh-scraper.ts:927-940): if Bearer
      // returns 0 cases, prefer keeping a populated cache over wiping it to
      // zero. A 401 / network blip must never silently empty production data.
      if (fetchedCases.length === 0) {
        try {
          const { readFileSync: rfs } = await import('node:fs')
          const existing = JSON.parse(rfs(RH_CASES_CACHE_PATH, 'utf-8'))
          if (Array.isArray(existing?.cases) && existing.cases.length > 0) {
            console.warn(
              `[scraper-manager/bearer] stale-overwrite guard: bearer returned 0 cases but cache has ${existing.cases.length} — keeping existing cache`,
            )
            cases = existing.cases
          } else {
            cases = fetchedCases
            await writeCasesCache(RH_CASES_CACHE_PATH, accountNumbers, cases)
          }
        } catch {
          cases = fetchedCases
          await writeCasesCache(RH_CASES_CACHE_PATH, accountNumbers, fetchedCases)
        }
      } else {
        cases = fetchedCases
        await writeCasesCache(RH_CASES_CACHE_PATH, accountNumbers, cases)
      }
    } else {
      // BKL-M50c: Wrap with wall-clock timeout to prevent 7+ min stalls
      cases = await withTimeout(
        runRhScrape({
          accountNumbers,
          profileDir: RH_PROFILE_DIR,
          cachePath: RH_CASES_CACHE_PATH,
          shouldCancel: () => _rhScrapeCancelRequested,
          accountToCustomer,
        }),
        RH_SCRAPE_TIMEOUT_MS(),
        'RH case scrape (browser)',
      )
    }
    // Merge name-discovered cases (customers with no account number) into batch results.
    // Dedup by caseNumber so batch wins if the same case appears in both.
    if (nameDiscoveredCases.length > 0) {
      const batchNums = new Set(cases.map(c => c.caseNumber))
      const newFromName = nameDiscoveredCases.filter(c => !batchNums.has(c.caseNumber))
      if (newFromName.length > 0) {
        cases.push(...newFromName.map(c => ({
          caseNumber: c.caseNumber,
          summary: c.summary,
          status: c.status,
          severity: c.severity,
          accountNumber: c.accountNumber,
          customerName: c.customerName,
          daysOpen: 0,
          product: c.product,
          casesSource: c.casesSource,
        })))
        // Re-write cache with merged results
        const { mkdir: mkdirMerge, writeFile: writeFileMerge, rename: renameMerge } = await import('node:fs/promises')
        const { dirname: dirnameMerge } = await import('node:path')
        await mkdirMerge(dirnameMerge(RH_CASES_CACHE_PATH), { recursive: true })
        const tmpMerge = RH_CASES_CACHE_PATH + '.tmp'
        await writeFileMerge(tmpMerge, JSON.stringify({ scrapedAt: new Date().toISOString(), accounts: accountNumbers, cases }, null, 2), { mode: 0o600 })
        await renameMerge(tmpMerge, RH_CASES_CACHE_PATH)
        console.log(`[rh-scraper] merged ${newFromName.length} name-search cases into cache (total: ${cases.length})`)
      }
    }

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

    // ScraperStatusStore: record success
    recordOutcome('rh-cases', {
      success: true,
      recordCount: cases.length,
      durationMs: Date.now() - _rhTelemetryStart,
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

    // ScraperStatusStore: record failure
    recordOutcome('rh-cases', {
      success: false,
      durationMs: Date.now() - _rhTelemetryStart,
      error: sanitizeErr(e),
    })

    if (e instanceof SessionExpiredError) {
      _rhScrapeLastError = 'Session expired — reconnect via dashboard'
      recordScrapeExpired()
      circuitBreakers.rh.recordFailure('session expired', true)
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
  // BKL-SUP-02: Defer SF sync while Supportable is scraping (session collision guard)
  if (supportableScrapeRunning) {
    console.log('[sf-sync] supportable scrape in progress — deferring SF sync to avoid session collision')
    return Promise.resolve()
  }
  if (_sfSyncRunning) return Promise.resolve()
  _sfSyncRunning = true
  _sfSyncStartedAt = Date.now()
  _sfSyncCancelRequested = false
  _sfSyncLastError = null
  _sfTotalRows = 0
  markRunning('sf-pipeline')
  return (async () => {
    const _sfTelemetryStart = Date.now()

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

        // FIX BKL-W2-15: Count rows once per unique report, not once per AE write
        _sfTotalRows += data.rows.length

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

    // Update exported status so /api/scrape/salesforce/status reflects the run
    if (!_sfSyncLastError && _sfTotalRows > 0) recordSfSyncSuccess(_sfTotalRows)

    // BKL-M50e: Record telemetry for SF sync
    recordScrapeResult({
      timestamp: new Date().toISOString(),
      service: 'salesforce',
      durationMs: Date.now() - _sfTelemetryStart,
      recordCount: _sfTotalRows,
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
    // ScraperStatusStore: record outcome (success or failure)
    // Note: _sfTelemetryStart is not in scope here — use updatedAt only
    recordOutcome('sf-pipeline', {
      success: !_sfSyncLastError,
      recordCount: _sfTotalRows,
      error: _sfSyncLastError ?? undefined,
    })
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
    _sfProbeTimestamp = new Date().toISOString()
    const healthFields = ConnectionHealthSchema.parse({
      transport: 'browser' as const,
      lastProbe: _sfProbeTimestamp,
      degradedReason: null,
      confidence: deriveConfidence(_sfProbeTimestamp),
    })
    return c.json({
      ...getSfAuthStatus(SF_SESSION_PATH),
      lastSync: lastSfSync,
      rowCount: lastSfRowCount,
      syncError: _sfSyncLastError,
      sessionExpired: !!(_sfSyncLastError?.toLowerCase().includes('session expired')),
      reportConfigured: !!SF_REPORT_ID || aes.some(a => !!a.sfReportId),
      sheetConfigured: !!process.env.PIPELINE_FILE_ID,
      liveReachable,
      ...healthFields,
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

    // FIX C1: Fall back to ScraperStatusStore.lastSuccess when in-memory variable is null (survives restart)
    const rhStatus = getScraperStatus('rh-cases')
    const supportableStatus = getScraperStatus('supportable')
    const ccspStatus = getScraperStatus('ccsp')
    const sfStatus = getScraperStatus('sf-pipeline')

    return c.json({
      supportable: {
        lastSync:    lastSupportableScrape ?? supportableStatus.lastSuccess ?? null,
        lastError:   lastSupportableError ? lastSupportableError.slice(0, 200).replace(/\/[^\s:]+\.(ts|js)/g, '[file]') : null,
        isRunning:   supportableScrapeRunning,
        isStale:     isStale(lastSupportableScrape ?? supportableStatus.lastSuccess ?? null, 24 * 60),
        recordCount: supportableStatus.recordCount ?? null,
      },
      ccsp: {
        lastSync:    lastCcspScrape ?? ccspStatus.lastSuccess ?? null,
        lastError:   lastCcspError ? lastCcspError.slice(0, 200).replace(/\/[^\s:]+\.(ts|js)/g, '[file]') : null,
        isRunning:   ccspScrapeRunning || ccspInFlight,
        isStale:     isStale(lastCcspScrape ?? ccspStatus.lastSuccess ?? null, intervals.ccsp),
        recordCount: ccspStatus.recordCount ?? null,
      },
      rh: {
        lastSync:    lastScraped ?? rhStatus.lastSuccess ?? null,
        lastError:   _rhScrapeLastError,
        isRunning:   _rhScrapeRunning,
        isStale:     isStale(lastScraped ?? rhStatus.lastSuccess ?? null, intervals.rhScrape),
        recordCount: rhStatus.recordCount ?? null,
        // BKL-RH-03 Phase 2 (ADR-014): expose active transport to dashboard
        transport:   process.env.RH_CASES_TRANSPORT ?? 'bearer',
      },
      salesforce: {
        lastSync:    lastSfSync ?? sfStatus.lastSuccess ?? null,
        lastError:   _sfSyncLastError,
        isRunning:   _sfSyncRunning,
        isStale:     isStale(lastSfSync ?? sfStatus.lastSuccess ?? null, 24 * 60),
        recordCount: sfStatus.recordCount ?? null,
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
