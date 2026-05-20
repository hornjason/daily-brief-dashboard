import { existsSync, readFileSync, unlinkSync } from 'fs'
import { resolve } from 'node:path'
import { writeJsonAtomicAsync } from './lib/atomic-write.ts'
import { Hono } from 'hono'
import { aes, patchAe } from './server-state.ts'
import { recordScrapeStart, recordScrapeSuccess, recordScrapeExpired, lastScraped } from './rh-auth.ts'
import { runRhScrape, SessionExpiredError, closeScrapeContext, browserDegraded, browserDegradedReason, discoverAccountNumberByName, closeDiscoverPage, writeCasesCache, setContextRecoveryCallback, _rhScrapeRunning, _rhScrapeStartedAt } from './rh-scraper.ts'
// BKL-ARCH-SCRAPER-04 Wave 3: Re-export RH inner mutex bindings so existing
// consumers (scrape-api.ts, background-scheduler.ts, setup-routes.ts) keep
// importing them from scraper-manager.ts without changes. ESM live bindings
// preserve up-to-date values across the re-export chain.
export { _rhScrapeRunning, _rhScrapeStartedAt } from './rh-scraper.ts'
// BKL-RH-03 Phase 2 (ADR-014): Bearer transport for recurring case refresh
import { BearerCaseClient, getConfiguredTransport } from './case-client.ts'
// BKL-RH-03 Phase 3: Bearer-transport account-number discovery (hero, no browser)
import { discoverAccountNumbersByName } from './rh-cases-api.ts'
import type { SupportCase } from './types.ts'
import { runSfPipelineSync, scrapeSfReport, writePipelineSheet, createPipelineSheet, getSfContext, listSfReports, recordSfSyncSuccess, SfSessionExpiredError, adoptSfContext } from './sf-scraper.ts'
import { recordScrapeFailure as recordConnectionFailure, recordScrapeSuccess as recordConnectionSuccess } from './connections/scrape-outcome.ts'
import { getSfAuthStatus } from './sf-auth.ts'
import { supportableScrapeRunning } from './supportable-scraper.ts'
import { ccspScrapeRunning, adoptCcspContext, peekTableauSessionExpired } from './ccsp-scraper.ts'
import { getRefreshIntervals } from './settings-api.ts'
import { getAutomationConfig } from './ai-config.ts'
import { refreshPipeline } from './refresh-engine.ts'
import { sanitizeErr } from './utils.ts'
import { stampProvenance, mergeProvenance, resolveDiscoveryResult } from './account-provenance-healer.ts'
import { APP_VERSION } from './admin-routes.ts'
import { deriveConfidence, ConnectionHealthSchema } from './connection-health.ts'
import { markRunning, recordOutcome, getScraperStatus, getUnifiedStatus } from './scraper-status-store.ts'
import { FeatureModuleRegistry } from './feature-module-registry.ts'
import { ScraperRegistry } from './scraper-registry.ts'

// ── BKL-M50e: Scraper telemetry + history ──────────────────────────────────

export interface ScrapeLogEntry {
  timestamp: string
  service: 'rh-cases' | 'ccsp' | 'supportable' | 'sf-pipeline'
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
    console.warn('[telemetry] failed to load scrape log:', sanitizeErr(e))
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
    await writeJsonAtomicAsync(SCRAPE_LOG_PATH, obj, { mode: 0o600 })
  } catch (e: any) {
    console.warn('[telemetry] failed to persist scrape log:', sanitizeErr(e))
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
  for (const service of ['rh-cases', 'ccsp', 'supportable', 'sf-pipeline']) {
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
//
// BKL-ARCH-06 issue #52: CircuitBreaker class + named breakers + reset
// functions live in `./scrape-state.ts`. Auth files (rh-auth.ts, sf-auth.ts)
// import `resetAllCircuitBreakers` from there directly to break the prior
// `scraper-manager → rh-auth → scraper-manager` cycle. We re-export the same
// names below so existing callers in scrape-api.ts and elsewhere keep working
// unchanged.
import {
  circuitBreakers,
  getCircuitBreakerStates,
  resetCircuitBreaker,
  resetAllCircuitBreakers,
  registerResetAllHook,
} from './scrape-state.ts'
export { getCircuitBreakerStates, resetCircuitBreaker, resetAllCircuitBreakers } from './scrape-state.ts'

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
    console.warn('[ntfy] notification failed:', sanitizeErr(e))
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
    'rh-cases': _lastSkipReasons.get('rh-cases') ?? null,
    ccsp: _lastSkipReasons.get('ccsp') ?? null,
    supportable: _lastSkipReasons.get('supportable') ?? null,
    'sf-pipeline': _lastSkipReasons.get('sf-pipeline') ?? null,
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

  // BKL-CONN-SF-AUTO-01: Wire the RH context recovery callback so that when
  // the shared Chromium context is auto-recovered or recycled, sister scrapers
  // (SF and CCSP) re-adopt the new live context instead of holding stale refs.
  // BKL-ARCH-02 Phase 1b: drive the re-adoption through ScraperRegistry so the
  // policy lives in one place. Skip:
  //   • retired descriptors (supportable — permanently disabled per CLAUDE.md)
  //   • the rh-cases descriptor itself (this callback is fired BY rh-scraper
  //     during its own context recovery — re-adopting would loop back into it)
  //   • sf-pipeline when getSfContext() === ctx (already on this ctx).
  setContextRecoveryCallback((ctx, profileDir) => {
    for (const d of ScraperRegistry.list()) {
      if (d.retired) continue
      if (d.name === 'rh-cases') continue
      if (d.name === 'sf-pipeline' && getSfContext() === ctx) continue
      try {
        d.adopt(ctx, profileDir)
      } catch (e: any) {
        console.warn(`[scraper-manager] ${d.name} re-adopt failed:`, e?.message ?? e)
      }
    }
  })
}

// ── Scraper state ───────────────────────────────────────────────────────────

// Guards the full CCSP scrape+write pipeline (ccspScrapeRunning only covers Playwright phase)
export let ccspInFlight = false

// RH scraper state
// BKL-ARCH-SCRAPER-04 Wave 3: _rhScrapeRunning and _rhScrapeStartedAt are now
// owned by rh-scraper.ts and re-exported above. The orchestration layer holds
// only the cancel/last-error/discovery-progress fields it actually drives.
export let _rhScrapeCancelRequested = false
export let _rhScrapeLastError: string | null = null
export let _rhDiscoveryProgress: { done: number; total: number; current: string | null } | null = null

// SF probe timestamp — records when sfLiveProbe last ran in the status endpoint
let _sfProbeTimestamp: string | null = null

// SF sync state
export let _sfSyncRunning = false
export let _sfSyncStartedAt: number | null = null
export let _sfSyncCancelRequested = false
export let _sfSyncLastError: string | null = null
// BKL-CONN-ARCH-01: track sf session expiry as a typed flag, not a string match
// over the last error message. Set only on SfSessionExpiredError or on the
// second consecutive failure (grace period via scrape-outcome.ts).
export let _sfSessionExpired = false
let _sfTotalRows = 0

// BKL-ARCH-06 issue #52: When auth re-establishes and resetAllCircuitBreakers()
// fires from rh-auth or sf-auth, also clear our `_sfSessionExpired` flag here.
// The flag lives in this module (scrape-api / status routes use the live
// binding), but resetAllCircuitBreakers now lives in scrape-state.ts to break
// the circular dep. The hook gives scrape-state.ts a way to call back without
// re-importing this file.
registerResetAllHook(() => { _sfSessionExpired = false })

// ── Setters for cross-module state mutation (ESM live bindings) ─────────────

export function setCcspInFlight(v: boolean): void { ccspInFlight = v }
export function setRhScrapeCancelRequested(v: boolean): void { _rhScrapeCancelRequested = v }
export function setSfSyncRunning(v: boolean): void { _sfSyncRunning = v }
export function setSfSyncStartedAt(v: number | null): void { _sfSyncStartedAt = v }
export function setSfSyncCancelRequested(v: boolean): void { _sfSyncCancelRequested = v }
export function setSfSyncLastError(v: string | null): void { _sfSyncLastError = v }

/** BKL-UX-WIPE-CONN-RESET-01: Delete session marker files so connection status resets to not-connected after wipe. */
export function clearSessionFiles(): void {
  // BKL-UX-WIPE-CONN-RESET-03: log on failure so silent unlink errors are visible
  try { if (RH_SESSION_PATH && existsSync(RH_SESSION_PATH)) unlinkSync(RH_SESSION_PATH) }
  catch (e) { console.warn('[clearSessionFiles] failed to unlink RH session:', sanitizeErr(e)) }
  try { if (SF_SESSION_PATH && existsSync(SF_SESSION_PATH)) unlinkSync(SF_SESSION_PATH) }
  catch (e) { console.warn('[clearSessionFiles] failed to unlink SF session:', sanitizeErr(e)) }
  // BKL-UX-WIPE-CONN-RESET-02: also clear Tableau + content-RH session files
  const tableauPath = RH_PROFILE_DIR ? resolve(RH_PROFILE_DIR, 'tableau-session.json') : ''
  const contentRhPath = RH_PROFILE_DIR ? resolve(RH_PROFILE_DIR, 'content-rh-session.json') : ''
  try { if (tableauPath && existsSync(tableauPath)) unlinkSync(tableauPath) }
  catch (e) { console.warn('[clearSessionFiles] failed to unlink Tableau session:', sanitizeErr(e)) }
  try { if (contentRhPath && existsSync(contentRhPath)) unlinkSync(contentRhPath) }
  catch (e) { console.warn('[clearSessionFiles] failed to unlink content-RH session:', sanitizeErr(e)) }
}

// ── RH scrape orchestration ─────────────────────────────────────────────────

export async function runRhScrapeWithState(): Promise<void> {
  // BKL-M50c: Circuit breaker check
  if (circuitBreakers['rh-cases'].isOpen()) {
    const state = circuitBreakers['rh-cases'].getState()
    console.warn(`[rh-scraper] circuit breaker OPEN (${state.failures} failures) — skipping scrape`)
    return
  }

  // BKL-ARCH-SCRAPER-04 Wave 3: read-only check — runRhScrape owns its own mutex
  // (set/release inside the function body, including stale auto-release). The
  // outer orchestration layer just early-returns to avoid duplicate scheduling.
  if (_rhScrapeRunning) {
    console.log('[rh-scraper] inner mutex already set — skipping orchestration layer'); return
  }

  // BKL-RH-TRANSPORT-GUARD: Session file is only required for browser transport.
  // Bearer transport authenticates via REDHAT_OFFLINE_TOKEN — a missing
  // .rh-session.json must not block a bearer-mode scrape.
  // Resolve transport first, gate the session-file check on browser only.
  const transportForDiscovery = getConfiguredTransport()
  if (transportForDiscovery === 'browser' && !existsSync(RH_SESSION_PATH)) return

  // Collect account numbers from customers config; discover missing ones by name
  const serverState = await import('./server-state.ts')
  let accountNumbers = serverState.customers
    .flatMap((c) => (c.accountNumbers ?? []).map(String))
    .filter(Boolean)

  // Discover account numbers for all customers that don't have them yet.
  // Transport-aware (BKL-RH-03 Phase 3):
  //   - browser → existing Playwright sidebar autocomplete (Mac Mini leader)
  //   - bearer  → SOLR discoverAccountNumbersByName (hero, no browser)
  const needsDiscovery = serverState.customers
  const nameDiscoveredCases: import('./rh-scraper.ts').DiscoverResult['cases'] = []
  if (transportForDiscovery === 'browser' && needsDiscovery.length > 0) {
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
          // #82: Stamp provenance on browser-discovered account numbers, preserving manual entries
          const provenance = stampProvenance(nums, 'rh-scraper', APP_VERSION)
          const mergedProvenance = mergeProvenance(customer.accountProvenance, provenance)
          serverState.patchCustomer(customer.name, { accountNumbers: nums, accountProvenance: mergedProvenance, discoveryFailures: 0, discoveryStatus: undefined, discoverySkippedUntil: undefined })
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

  // BKL-RH-03 Phase 3: Bearer-transport discovery for hero installs.
  // No browser available — use Bearer-token SOLR via discoverAccountNumbersByName.
  // Mirrors the browser block above for the result-handling shape (patchCustomer +
  // accountNumbers union + nameDiscoveredCases stamping) without the negative-cache
  // tombstone path (kept browser-only for now to limit Phase 3 surface area).
  if (transportForDiscovery === 'bearer' && needsDiscovery.length > 0) {
    console.log(`[rh-scraper] bearer-discovering ${needsDiscovery.length} customers without account numbers…`)
    for (const customer of needsDiscovery) {
      const searchName = (customer as any).aliases?.[0] ?? customer.name
      try {
        const result = await discoverAccountNumbersByName(searchName)
        if (result.accountNumbers.length > 0) {
          const existing = (customer.accountNumbers ?? []).map(String)
          const merged = [...new Set([...existing, ...result.accountNumbers])]
          // #82: Stamp provenance on bearer-discovered account numbers, preserving manual entries
          const provenance = stampProvenance(result.accountNumbers, 'rh-cases-api', APP_VERSION)
          const mergedProvenance = mergeProvenance(customer.accountProvenance, provenance)
          serverState.patchCustomer(customer.name, { accountNumbers: merged, accountProvenance: mergedProvenance })
          accountNumbers = [...new Set([...accountNumbers, ...merged])]
          console.log(`[rh-scraper] bearer discovery: "${customer.name}" → ${merged.join(', ')}`)
        } else {
          // #82: When discovery returns 0 and customer has stale provenance,
          // clear the stale automated accounts (they were likely wrong).
          const clearPatch = resolveDiscoveryResult(customer, [], APP_VERSION)
          if (clearPatch) {
            serverState.patchCustomer(customer.name, clearPatch)
            console.log(`[rh-scraper] bearer discovery: "${customer.name}" → 0 results, cleared ${(customer.accountNumbers ?? []).length} stale accounts (preserved ${clearPatch.accountNumbers.length} manual)`)
          } else {
            console.log(`[rh-scraper] bearer discovery: "${customer.name}" → no account numbers found (0 cases or no name match)`)
          }
        }
        if (result.cases.length > 0) {
          nameDiscoveredCases.push(...result.cases.map(c => ({ ...c, customerName: customer.name })))
        }
      } catch (e: any) {
        console.warn(`[rh-scraper] bearer discovery error for "${customer.name}": ${e?.message ?? e}`)
      }
    }
  }

  // If no account numbers at all, we still may have name-discovered cases to cache
  if (accountNumbers.length === 0) {
    if (nameDiscoveredCases.length > 0) {
      console.log(`[rh-scraper] no account numbers but ${nameDiscoveredCases.length} name-search cases — caching those`)
      // Write name-discovered cases directly (no batch scrape needed)
      await writeJsonAtomicAsync(RH_CASES_CACHE_PATH, { scrapedAt: new Date().toISOString(), accounts: [], cases: nameDiscoveredCases }, { mode: 0o600 })
      recordOutcome('rh-cases', { success: true, recordCount: nameDiscoveredCases.length })
      FeatureModuleRegistry.recordOutcome('rh-cases', { success: true, recordCount: nameDiscoveredCases.length })
    } else {
      console.log('[rh-scraper] no account numbers and no name-search cases — nothing to cache')
      recordOutcome('rh-cases', { success: true, recordCount: 0 })
      FeatureModuleRegistry.recordOutcome('rh-cases', { success: true, recordCount: 0 })
    }
    return
  }

  // BKL-ARCH-SCRAPER-04 Wave 3: mutex set/release now lives inside runRhScrape.
  // Orchestration layer only manages cancel-request flag.
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
        cases.push(...newFromName.map(c => {
          const cWithName = c as typeof c & { customerName?: string }
          return {
            caseNumber: c.caseNumber,
            summary: c.summary,
            status: c.status,
            severity: c.severity,
            accountNumber: c.accountNumber,
            customerName: cWithName.customerName,
            daysOpen: 0,
            product: c.product,
            casesSource: c.casesSource,
          }
        }))
        // Re-write cache with merged results
        await writeJsonAtomicAsync(RH_CASES_CACHE_PATH, { scrapedAt: new Date().toISOString(), accounts: accountNumbers, cases }, { mode: 0o600 })
        console.log(`[rh-scraper] merged ${newFromName.length} name-search cases into cache (total: ${cases.length})`)
      }
    }

    _rhScrapeLastError = null
    recordScrapeSuccess(cases.length)
    circuitBreakers['rh-cases'].recordSuccess()

    // BKL-M50e: Record telemetry
    recordScrapeResult({
      timestamp: new Date().toISOString(),
      service: 'rh-cases',
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
    FeatureModuleRegistry.recordOutcome('rh-cases', { success: true, recordCount: cases.length })
    // BKL-CONN-ARCH-01: clear failure count for connection-state grace tracking
    recordConnectionSuccess('rh')

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
      service: 'rh-cases',
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
    FeatureModuleRegistry.recordOutcome('rh-cases', { success: false, error: sanitizeErr(e) })

    // BKL-CONN-ARCH-01: track outcome through scrape-outcome.ts. Auth signals
    // (SessionExpiredError) expire immediately; other errors require 2
    // consecutive failures before treating as expired (grace period).
    const outcome = recordConnectionFailure('rh', e)

    if (e instanceof SessionExpiredError) {
      _rhScrapeLastError = 'Session expired — reconnect via dashboard'
      recordScrapeExpired()
      circuitBreakers['rh-cases'].recordFailure('session expired', true)
      await closeScrapeContext() // discard expired context so next login gets a clean one
      console.warn('[rh-scraper] session expired — reconnect via dashboard')
      notify('Red Hat Session Expired', 'Session expired during case scrape — reconnect via dashboard', 'high').catch(() => {})
    } else {
      _rhScrapeLastError = sanitizeErr(e)
      circuitBreakers['rh-cases'].recordFailure(sanitizeErr(e))
      console.warn('[rh-scraper]', sanitizeErr(e))
      // Only flip RH to expired on the second consecutive non-auth failure.
      if (outcome.shouldExpire) {
        console.warn(`[rh-scraper] ${outcome.failureCount} consecutive failures — treating as session expired`)
        recordScrapeExpired()
      }
    }
  } finally {
    // BKL-ARCH-SCRAPER-04 Wave 3: mutex release lives inside runRhScrape's own
    // finally (browser path). Orchestration layer only resets cancel flag.
    // Note: bearer transport branch (BKL-RH-03 Phase 2) does not enter
    // runRhScrape and therefore does not flip _rhScrapeRunning during the
    // bearer-only scrape — see BACKLOG observation in this commit.
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
  // Guard: no SF context means no session — skip immediately rather than navigate to SF,
  // hit the login page, and throw SfSessionExpiredError (which flips _sfSessionExpired=true
  // even when the user has never logged in). This prevents startup scrapes from overwriting
  // a fresh login with a false "session expired" signal.
  if (!getSfContext()) {
    console.log('[sf-sync] no SF session — skipping sync until connected')
    return Promise.resolve()
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
            // BKL-CONN-ARCH-01: route through scrape-outcome for grace-period
            // tracking. Sheet-write errors are not auth signals, so this only
            // expires after 2 consecutive failures.
            const outcome = recordConnectionFailure('sf', e)
            if (outcome.shouldExpire) _sfSessionExpired = true
          }
        }
      } catch (e: any) {
        console.warn(`[sf-sync] SF scrape failed for report ${reportId}:`, sanitizeErr(e))
        _sfSyncLastError = sanitizeErr(e)
        // BKL-CONN-ARCH-01: SfSessionExpiredError flips us to expired
        // immediately; other errors only after the second consecutive failure.
        const outcome = recordConnectionFailure('sf', e)
        if (outcome.shouldExpire) _sfSessionExpired = true
      }
    }

    // Update exported status so /api/scrape/salesforce/status reflects the run
    if (!_sfSyncLastError && _sfTotalRows > 0) {
      recordSfSyncSuccess(_sfTotalRows)
      // BKL-CONN-ARCH-01: clear failure count + sessionExpired flag on success
      recordConnectionSuccess('sf')
      _sfSessionExpired = false
    }

    // BKL-M50e: Record telemetry for SF sync
    recordScrapeResult({
      timestamp: new Date().toISOString(),
      service: 'sf-pipeline',
      durationMs: Date.now() - _sfTelemetryStart,
      recordCount: _sfTotalRows,
      status: _sfSyncLastError ? 'failure' : 'success',
      error: _sfSyncLastError ?? undefined,
    })
  })().catch((e: any) => {
    console.error('[server] SF login callback error:', sanitizeErr(e))
    _sfSyncLastError = sanitizeErr(e)
    // BKL-CONN-ARCH-01: track outer-promise failures through scrape-outcome too
    const outcome = recordConnectionFailure('sf', e)
    if (outcome.shouldExpire) _sfSessionExpired = true
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
// BKL-M25: Scrape-specific routes moved to src/scrape-api.ts (createScrapeRouter).
// Routes kept here are auth/status helpers that are NOT scrape triggers.

export function createScraperRouter(): Hono {
  const router = new Hono()

  // GET /api/auth/salesforce/status — auth + sync status for SF (kept: auth surface)
  router.get('/api/auth/salesforce/status', async (c) => {
    // BKL-T04: Live session probe — verifies SF is actually reachable, not just flagged
    const liveReachable = await sfLiveProbe()
    _sfProbeTimestamp = new Date().toISOString()
    const healthFields = ConnectionHealthSchema.parse({
      transport: 'browser' as const,
      lastProbe: _sfProbeTimestamp,
      degradedReason: null,
      confidence: deriveConfidence(_sfProbeTimestamp),
    })
    const sfAuthStatus = getSfAuthStatus(SF_SESSION_PATH)
    // BKL-ARCH-SCRAPER-03: read SF status from store (single source of truth)
    const sfUnifiedStatus = getUnifiedStatus('sf-pipeline')
    const sfStoreStatus = getScraperStatus('sf-pipeline')
    return c.json({
      ...sfAuthStatus,
      lastSync: sfUnifiedStatus.lastSync,
      rowCount: sfStoreStatus.recordCount ?? 0,
      syncError: _sfSyncLastError,
      // BKL-CONN-ARCH-01: typed expired flag (set by SfSessionExpiredError or
      // 2 consecutive failures via scrape-outcome.ts) — replaces string match.
      // BKL-CONN-DATA-RESET-01: sessionExpired only meaningful when a session exists.
      // Without hasSession=true, _sfSessionExpired is a stale flag from a prior run
      // (e.g. after data-only wipe deletes sf-session.json) — don't surface it as "expired."
      sessionExpired: sfAuthStatus.hasSession ? _sfSessionExpired : false,
      reportConfigured: !!SF_REPORT_ID || aes.some(a => !!a.sfReportId),
      sheetConfigured: !!process.env.PIPELINE_FILE_ID,
      liveReachable,
      ...healthFields,
    })
  })

  // GET /api/sf/reports — list available SF pipeline reports (requires active SF session)
  router.get('/api/sf/reports', async (c) => {
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

  // GET /api/status/scrapes — per-scraper sync status (lastSync, lastError, isRunning, isStale)
  // Used by the dashboard to show staleness indicators per data section.
  router.get('/api/status/scrapes', (c) => {
    const intervals = getRefreshIntervals()
    const now = Date.now()

    function isStale(lastSync: string | null, intervalMinutes: number): boolean {
      if (!lastSync) return true
      return (now - new Date(lastSync).getTime()) > intervalMinutes * 2 * 60 * 1000
    }

    // BKL-ARCH-02 Phase 1b: lastSync resolution moved into getUnifiedStatus()
    // (in-memory hint ?? store.lastSuccess ?? null). Other fields are kept as
    // they were so /api/status/scrapes JSON shape stays byte-identical.
    const rhUnified   = getUnifiedStatus('rh-cases')
    const ccspUnified = getUnifiedStatus('ccsp')
    const sfUnified   = getUnifiedStatus('sf-pipeline')
    const ccspStatus  = getScraperStatus('ccsp')
    const rhStatus    = getScraperStatus('rh-cases')
    const sfStatus    = getScraperStatus('sf-pipeline')

    return c.json({
      // BKL-ARCH-SCRAPER-09-FOLLOW-01: 'supportable' block removed — permanently disabled
      ccsp: {
        lastSync:      ccspUnified.lastSync,
        lastError:     ccspUnified.lastError,
        isRunning:     ccspScrapeRunning || ccspInFlight,
        isStale:       isStale(ccspUnified.lastSync, intervals.ccsp),
        recordCount:          ccspStatus.recordCount ?? null,
        tableauSessionExpired: peekTableauSessionExpired(),
      },
      rh: {
        lastSync:    rhUnified.lastSync,
        lastError:   _rhScrapeLastError,
        isRunning:   _rhScrapeRunning,
        isStale:     isStale(rhUnified.lastSync, intervals.rhScrape),
        recordCount: rhStatus.recordCount ?? null,
        // BKL-RH-03 Phase 2 (ADR-014): expose active transport to dashboard
        transport:   process.env.RH_CASES_TRANSPORT ?? 'bearer',
      },
      salesforce: {
        lastSync:    sfUnified.lastSync,
        lastError:   _sfSyncLastError,
        isRunning:   _sfSyncRunning,
        isStale:     isStale(sfUnified.lastSync, 24 * 60),
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

  return router
}

// ── Exported for use in server.ts login callbacks ───────────────────────────
// These are used by the POST /api/auth/salesforce/start and POST /api/auth/redhat/start
// routes that remain in server.ts (they depend on startLoginBrowser callbacks).

export { runSfSyncForAes }
