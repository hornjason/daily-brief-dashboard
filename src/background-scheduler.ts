import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'fs'
import { renameSync } from 'node:fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { customers, aes, patchAe, CUSTOMERS_PATH } from './server-state.ts'
import { refreshAll, refreshSubscriptions, refreshCCSP, refreshPipeline } from './refresh-engine.ts'
import { runRhScrapeWithState, runSfSyncForAes, _rhScrapeRunning, _sfSyncRunning, ccspInFlight, setLastSkipReason } from './scraper-manager.ts'
import { getSfAuthStatus } from './sf-auth.ts'
import { getRefreshIntervals, DEFAULT_REFRESH_INTERVALS, getSchedulerConfig, updateSchedulerField } from './settings-api.ts'
import { lastScraped, recordScrapeExpired, getRhStatus } from './rh-auth.ts'
import { initScrapeContext, getScrapeContext, closeScrapeContext } from './rh-scraper.ts'
import { adoptSfContext, initSfSyncFromCache } from './sf-scraper.ts'
import { adoptSupportableContext, runSupportableDiscoverAndScrape, writeSupportableSheet, supportableScrapeRunning } from './supportable-scraper.ts'
import { adoptCcspContext, runCcspScrape, writeCcspSheet, ccspScrapeRunning } from './ccsp-scraper.ts'
import { syncTerritorySheet } from './territory-sync.ts'
import { initDriveWatcher, checkDriveChanges } from './drive-watcher.ts'
import { captureSnapshot, writeSnapshot } from './kpi-history.ts'
import { briefCachePath, readBriefCache, readSheetCache, readPipelineCache, readCCSPCache, writeBriefCache, cleanOrphanedCacheFiles } from './cache-layer.ts'
import { isBriefConfigured, fetchCustomerMeetings, fetchCustomerEmails, fetchCustomerDocs, generateBrief } from './customer.ts'
import { writeCustomerDocsCorpus } from './customer-docs-corpus.ts'
import { fetchCustomerCases, fetchCustomerSubscriptions } from './redhat.ts'
import { fetchCustomerSheetData } from './sheets.ts'
import { initStatusStore, recordOutcome, getStatus } from './scraper-status-store.ts'
import { renderBriefHtml } from './email-template.ts'
import { sendBriefEmail } from './email-sender.ts'
import { sanitizeErr, normalizeForQuery, liveProbe } from './utils.ts'
import { isBootstrapRunning } from './bootstrap-orchestrator.ts'
import { writeSyncStateFlow, todaySyncRan } from './sync-state.ts'
import { isPrimary as nodeIsPrimary } from './lib/node-role.ts'

// ── BKL-SYNC-L3-02: Primary-node predicate — gates L4 writer scheduler paths ──
// NODE_ROLE=primary → this node is the L4 leader (Mac Mini sync daemon).
// NODE_ROLE unset   → hero install, L3-only; must NOT register L4 writer schedulers
// or the catch-up block (they throw on every hero restart when NODE_ROLE is unset).
// Read once at module load via the node-role policy module (single source of truth, issue #10).
const isPrimary = nodeIsPrimary()

// ── BKL-M49: Scraper queue — serialise browser-context scrapers ─────────────
// All scrapers share one BrowserContext (SSO constraint). Running them
// concurrently causes "Target page, context or browser has been closed" errors.
// The queue ensures at most one browser-consuming scraper runs at a time.

export interface ScraperTask {
  name: string             // human-readable label for logging
  run: () => Promise<void> // the actual scraper function
  source: 'startup' | 'scheduled' | 'heartbeat' | 'manual'
  enqueuedAt: number       // Date.now() when enqueued
}

const _scraperQueue: ScraperTask[] = []
let _scraperQueueRunning = false  // true while a task from the queue is executing

/** Check all four scraper mutex flags + bootstrap — returns true if ANY browser scraper is active.
 *  BKL-W2-17: includes isBootstrapRunning() so scheduled scrapers wait while bootstrap runs. */
function isAnyScraperRunning(): boolean {
  return _rhScrapeRunning || _sfSyncRunning || ccspScrapeRunning || ccspInFlight || supportableScrapeRunning || isBootstrapRunning()
}

/**
 * Enqueue a scraper task. If nothing is running, it starts immediately.
 * Duplicate tasks (same name) are coalesced — if the same scraper is already
 * queued, the new request is dropped to avoid piling up.
 */
export function enqueueScraperTask(task: ScraperTask): void {
  // Coalesce: skip if same scraper name is already pending in queue
  if (_scraperQueue.some(t => t.name === task.name)) {
    console.log(`[scraper-queue] ${task.name} already queued — skipping duplicate (source: ${task.source})`)
    return
  }
  _scraperQueue.push(task)
  const position = _scraperQueue.length
  console.log(`[scraper-queue] ${task.name} queued (source: ${task.source}), position ${position}`)
  runNextInQueue()
}

/** Pop the next task off the queue and run it, if nothing else is running. */
function runNextInQueue(): void {
  if (_scraperQueueRunning) return
  if (isAnyScraperRunning()) {
    // A scraper started outside the queue (e.g. legacy direct call) is still running.
    // We'll retry on the next heartbeat tick or when the current task finishes.
    if (_scraperQueue.length > 0) {
      console.log(`[scraper-queue] waiting — a scraper is still running (${_scraperQueue.length} tasks pending)`)
    }
    return
  }
  const task = _scraperQueue.shift()
  if (!task) return

  const waitMs = Date.now() - task.enqueuedAt
  console.log(`[scraper-queue] starting ${task.name} (waited ${Math.round(waitMs / 1000)}s, ${_scraperQueue.length} remaining)`)
  _scraperQueueRunning = true

  task.run()
    .catch(e => console.error(`[scraper-queue] ${task.name} failed:`, e?.message ?? e))
    .finally(() => {
      _scraperQueueRunning = false
      console.log(`[scraper-queue] ${task.name} finished (${_scraperQueue.length} remaining)`)
      // Process next task after a brief yield to let mutex flags settle
      setTimeout(() => runNextInQueue(), 500)
    })
}

/** Get current queue state — exposed for status endpoints and admin visibility. */
export function getScraperQueueStatus(): { running: string | null; pending: string[]; isAnyRunning: boolean } {
  const runningTask = _scraperQueueRunning ? 'active' : null
  return {
    running: runningTask,
    pending: _scraperQueue.map(t => t.name),
    isAnyRunning: isAnyScraperRunning(),
  }
}

/**
 * Flush all 4 scrapers immediately after RH re-authentication.
 * Ordering: RH first (account numbers needed by Supportable), then SF and CCSP
 * (can start after RH since they don't depend on RH account numbers), Supportable last
 * (depends on RH account numbers being populated).
 * Coalesce guard in enqueueScraperTask prevents duplicates if already queued.
 */
export async function flushScrapersAfterAuth(): Promise<void> {
  console.log('[scraper-queue] post-auth flush: enqueueing all 4 scrapers')

  // RH first — populates account numbers consumed by Supportable
  // BKL-BOOT-SCRAPE-ORDER-01: skip if no AEs configured (same guard as catch-up and heartbeat)
  if (aes && aes.length > 0) {
    enqueueScraperTask({
      name: 'rh-cases',
      run: async () => {
        await runRhScrapeWithState()
        updateSchedulerField('rhLastRun', new Date().toISOString())
      },
      source: 'manual',
      enqueuedAt: Date.now(),
    })
  } else {
    console.log('[scraper-queue] post-auth flush: no AEs configured — skipping rh-cases')
  }

  // SF pipeline — independent of RH, can queue after RH
  const { aes: capturedAes } = await import('./server-state.ts')
  if (capturedAes.some((a: any) => !!a.sfReportId)) {
    enqueueScraperTask({
      name: 'sf-pipeline',
      run: async () => {
        await runSfSyncForAes(capturedAes)
      },
      source: 'manual',
      enqueuedAt: Date.now(),
    })
  }

  // CCSP — independent of RH, can queue after RH
  const ccspConfig = getSchedulerConfig()
  if (ccspConfig.ccspEnabled) {
    enqueueScraperTask({
      name: 'ccsp',
      run: async () => {
        const { aes: aesForCcsp } = await import('./server-state.ts')
        await runCcspScrape(aesForCcsp)
        updateSchedulerField('ccspLastRun', new Date().toISOString())
      },
      source: 'manual',
      enqueuedAt: Date.now(),
    })
  }

  // Supportable last — depends on RH account numbers
  // BKL-G30 Gap 6: probe VPN before enqueueing to avoid silent DNS failures
  const suppConfig = getSchedulerConfig()
  if (suppConfig.supportableEnabled) {
    const suppVpnOk = await liveProbe('https://supportable.corp.redhat.com:4443/', 'supportable-vpn', 5000)
    if (!suppVpnOk) {
      console.warn('[scraper-queue:supportable] VPN not reachable — skipping post-auth Supportable enqueue')
    } else {
    enqueueScraperTask({
      name: 'supportable',
      run: async () => {
        const { customers: currentCustomers, aes: currentAes } = await import('./server-state.ts')
        if (currentCustomers.length > 0) {
          const results = await runSupportableDiscoverAndScrape(
            currentCustomers,
            (done, total, name, accountNumbers) => {
              // Persist newly discovered account numbers to customers.json
              const existing = currentCustomers.find(cx => cx.name === name)
              if (existing && accountNumbers.length > 0) {
                const merged = new Set([...(existing.accountNumbers ?? []), ...accountNumbers])
                existing.accountNumbers = [...merged]
                try {
                  const tmpPath = CUSTOMERS_PATH + '.tmp'
                  writeFileSync(tmpPath, JSON.stringify({ customers: currentCustomers }, null, 2), { mode: 0o600 })
                  renameSync(tmpPath, CUSTOMERS_PATH)
                } catch {}
              }
            },
          )
          // Split results by AE and write a sheet per AE
          for (const ae of currentAes) {
            const aeResults = results.filter(r => {
              const cx = currentCustomers.find(c => c.name === r.customerName)
              return cx?.ae === ae.name
            })
            if (aeResults.length > 0 && aeResults.some(r => r.accountNumbers.length > 0)) {
              try {
                const spreadsheetId = await writeSupportableSheet(aeResults, ae.name, ae.driveFolderId, ae.supportableSheetId || undefined)
                patchAe(ae.name, { supportableSheetId: spreadsheetId })
              } catch (e: any) {
                console.warn(`[scraper-queue:supportable] sheet write failed for ${ae.name}:`, sanitizeErr(e))
              }
            }
          }
          await refreshSubscriptions().catch(() => {})
          updateSchedulerField('supportableLastRun', new Date().toISOString())
        }
      },
      source: 'manual',
      enqueuedAt: Date.now(),
    })
    } // end else (suppVpnOk)
  }
}

// ── ntfy.sh push notification helper ─────────────────────────────────────────
const _NTFY_TOPIC_SCHED = process.env.NTFY_TOPIC ?? 'asa-command-center'
async function notify(title: string, message: string, priority: 'default' | 'high' | 'urgent' = 'default'): Promise<void> {
  try {
    await fetch(`https://ntfy.sh/${_NTFY_TOPIC_SCHED}`, {
      method: 'POST',
      headers: { 'Title': title.slice(0, 64), 'Priority': priority, 'Content-Type': 'text/plain' },
      body: message.slice(0, 512),
    })
  } catch (e: any) {
    console.warn('[ntfy] scheduler notification failed:', e?.message ?? e)
  }
}

// ── BKL-INGEST-06: Retry helper for scheduled scrape failures ────────────────
// When a scheduled scrape's run callback throws, scheduleRetry() re-enqueues
// the same task after a back-off delay (5m → 10m → 15m). After all delays
// are exhausted, fires an urgent ntfy push so a human can intervene via VNC.
//
// The retry wrapper rethrows after scheduling the retry so the scraper queue's
// failure logging path still records the error — the queue's catch handler
// only logs, it does not act on the error.
export const RETRY_DELAYS = [5 * 60_000, 10 * 60_000, 15 * 60_000]

export function scheduleRetry(name: string, run: () => Promise<void>, delays: number[], attempt: number): void {
  if (attempt >= delays.length) {
    // All retries exhausted — notify urgently so a human can investigate via VNC.
    notify(`${name} sync failed`, `Scheduled sync failed after ${delays.length} retries — check VNC`, 'urgent').catch(() => {})
    return
  }
  const delay = delays[attempt]
  console.warn(`[${name}] retry ${attempt + 1}/${delays.length} in ${Math.round(delay / 60_000)}m`)
  setTimeout(() => {
    enqueueScraperTask({
      name,
      run: async () => {
        try {
          await run()
        } catch (e: any) {
          console.warn(`[${name}] retry ${attempt + 1} failed: ${e?.message ?? e}`)
          scheduleRetry(name, run, delays, attempt + 1)
          throw e
        }
      },
      source: 'scheduled',
      enqueuedAt: Date.now(),
    })
  }, delay)
}

// ── Session health watchdog state ────────────────────────────────────────────
let _lastWatchdogSessionExpired = false
const _alertedScrapers: Set<string> = new Set()

// RH session path used by watchdog — set during initBackgroundScheduler
let _watchdogRhSessionPath = ''

// ── Configurable timer management (BKL-M19: heartbeat pattern) ──────────────
// Bun's setInterval is unreliable for intervals > ~1h (see ADR-007).
// Instead of raw setInterval, we track last-run timestamps and check them
// on each 15-min heartbeat tick — same pattern as the RH scraper (Timer 3).

let _subscriptionsLastRun = 0
let _ccspLastRun = 0
let _heartbeatStarted = false

export function rescheduleRefreshTimers(intervals: typeof DEFAULT_REFRESH_INTERVALS): void {
  // Reset last-run timestamps so the next heartbeat tick picks up new intervals.
  // Setting to Date.now() means "just ran" — first refresh fires after the configured interval.
  _subscriptionsLastRun = Date.now()
  _ccspLastRun = Date.now()

  if (customers.length === 0) return

  // Clean orphaned cache files when customer list changes (BKL-M26)
  cleanOrphanedCacheFiles(customers.map(c => c.name))

  console.log(`[timers] subscriptions=${intervals.subscriptions}m ccsp=${intervals.ccsp}m (heartbeat)`)
}

// ── Pipeline daily sync at 2am ET ───────────────────────────────────────────
// SF report is generated at 1am ET daily; we sync at 2am ET to ensure it's ready.
// Uses setTimeout + reschedule loop (container-safe — no system cron available).

export function nextEt2amUtc(now?: Date): Date {
  const _now = now ?? new Date()
  // Derive ET UTC offset by comparing actual UTC ms with "ET time treated as UTC" ms.
  // This correctly handles EST vs EDT without hardcoding the offset.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const p: Record<string, number> = {}
  for (const part of fmt.formatToParts(_now)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  // etOffsetMs = how many ms ahead UTC is vs ET local time
  const etAsIfUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  const etOffsetMs  = _now.getTime() - etAsIfUtcMs   // e.g. 4*3600*1000 during EDT

  // "Today at 2am ET" expressed as UTC
  let target = new Date(Date.UTC(p.year, p.month - 1, p.day, 2, 0, 0) + etOffsetMs)
  // If already past, roll to tomorrow
  if (target.getTime() <= _now.getTime()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000)
  }
  return target
}

/** Returns the next UTC Date representing the next 1:45am ET. Same pattern as nextEt2amUtc. */
export function nextEt145amUtc(now?: Date): Date {
  const _now = now ?? new Date()
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const p: Record<string, number> = {}
  for (const part of fmt.formatToParts(_now)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  const etAsIfUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  const etOffsetMs  = _now.getTime() - etAsIfUtcMs
  let target = new Date(Date.UTC(p.year, p.month - 1, p.day, 1, 45, 0) + etOffsetMs)
  if (target.getTime() <= _now.getTime()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000)
  }
  return target
}

/** Returns the next UTC Date representing the next 6:30am ET. Same pattern as nextEt2amUtc. */
export function nextEt630amUtc(now?: Date): Date {
  const _now = now ?? new Date()
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const p: Record<string, number> = {}
  for (const part of fmt.formatToParts(_now)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  const etAsIfUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  const etOffsetMs  = _now.getTime() - etAsIfUtcMs
  let target = new Date(Date.UTC(p.year, p.month - 1, p.day, 6, 30, 0) + etOffsetMs)
  if (target.getTime() <= _now.getTime()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000)
  }
  return target
}

/** Returns the next UTC Date representing the next 7:00am ET. Same pattern as nextEt2amUtc. */
export function nextEt7amUtc(now?: Date): Date {
  const _now = now ?? new Date()
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const p: Record<string, number> = {}
  for (const part of fmt.formatToParts(_now)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  const etAsIfUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  const etOffsetMs  = _now.getTime() - etAsIfUtcMs
  let target = new Date(Date.UTC(p.year, p.month - 1, p.day, 7, 0, 0) + etOffsetMs)
  if (target.getTime() <= _now.getTime()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000)
  }
  return target
}

/** Returns the next UTC Date representing the next 8:00am ET. Same pattern as nextEt2amUtc. */
export function nextEt8amUtc(now?: Date): Date {
  const _now = now ?? new Date()
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const p: Record<string, number> = {}
  for (const part of fmt.formatToParts(_now)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  const etAsIfUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  const etOffsetMs  = _now.getTime() - etAsIfUtcMs
  let target = new Date(Date.UTC(p.year, p.month - 1, p.day, 8, 0, 0) + etOffsetMs)
  if (target.getTime() <= _now.getTime()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000)
  }
  return target
}

// ── KPI daily snapshot at 8:00am ET (R05) ───────────────────────────────────

export function scheduleKpiSnapshot(): void {
  const msUntil = nextEt8amUtc().getTime() - Date.now()
  console.log(`[kpi-snapshot] next snapshot in ${Math.round(msUntil / 60_000)}m (8:00am ET)`)
  setTimeout(async () => {
    try {
      const { customers: currentCustomers } = await import('./server-state.ts')
      // BKL-G11: Fetch calendar for meeting counts
      let meetingsToday = 0
      let meetingsThisWeek = 0
      try {
        const { fetchCalendar } = await import('./google.ts')
        const events = await fetchCalendar(currentCustomers)
        const customerEvents = events.filter((ev: any) => ev.customers && ev.customers.length > 0)
        const todayStr = new Date().toDateString()
        const now = new Date()
        const dayOfWeek = now.getDay()
        const monday = new Date(now)
        monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1))
        monday.setHours(0, 0, 0, 0)
        const sunday = new Date(monday)
        sunday.setDate(monday.getDate() + 7)
        meetingsToday = customerEvents.filter((ev: any) => new Date(ev.start).toDateString() === todayStr).length
        meetingsThisWeek = customerEvents.filter((ev: any) => { const d = new Date(ev.start); return d >= monday && d < sunday }).length
      } catch { /* calendar not configured or unavailable */ }
      const snapshot = captureSnapshot(currentCustomers.length, meetingsToday, meetingsThisWeek)
      writeSnapshot(snapshot)
      console.log(`[kpi-snapshot] daily snapshot captured: ${snapshot.date} — ${snapshot.metrics.totalCases} cases, ${snapshot.metrics.customerCount} customers`)
    } catch (e: any) {
      console.error('[kpi-snapshot] failed to capture snapshot:', e?.message ?? e)
    }
    scheduleKpiSnapshot()  // reschedule for next day
  }, msUntil)
}

// ── CCSP daily scrape at 6:30am ET ──────────────────────────────────────────

const CCSP_CACHE_PATH = resolve(process.env.DATA_DIR ?? 'data', 'cache', 'ccsp-data.json')
const CCSP_DELTA_PATH = resolve(process.env.DATA_DIR ?? 'data', 'cache', 'ccsp-delta.json')

async function runCcspScrapeWithDelta(aesToScrape: any[]): Promise<void> {
  // BKL-SUP-02: Defer CCSP if Supportable is actively scraping (session collision guard)
  if (supportableScrapeRunning) {
    console.log('[ccsp-sync] supportable scrape in progress — deferring CCSP to avoid session collision')
    return
  }
  // Read previous cache before scrape
  let prevRecords: any[] = []
  if (existsSync(CCSP_CACHE_PATH)) {
    try { prevRecords = JSON.parse(readFileSync(CCSP_CACHE_PATH, 'utf-8')).records ?? [] } catch {}
  }

  let ccspResults: any[]
  try {
    ccspResults = await runCcspScrape(aesToScrape)
  } catch (e: any) {
    // BKL-INGEST-09: Mark CCSP failed in sync-state so late startup detection knows this flow ran (and failed)
    writeSyncStateFlow('ccsp', 'failed')
    throw e
  }

  // FIX N5: Write CCSP sheets per eligible AE and refresh cache
  const eligibleAes = aesToScrape.filter((a: any) => a.tableauTerritories?.length && a.driveFolderId)
  for (const ae of eligibleAes) {
    const aeResults = ccspResults.filter((r: any) => r.aeName === ae.name)
    try {
      const spreadsheetId = await writeCcspSheet(aeResults, ae.name, ae.driveFolderId, ae.ccspSheetId || undefined)
      patchAe(ae.name, { ccspSheetId: spreadsheetId })
    } catch (e: any) {
      console.warn(`[ccsp-sync] sheet write failed for ${ae.name}:`, sanitizeErr(e))
    }
  }
  await refreshCCSP().catch((e: any) => console.warn('[ccsp-sync] cache refresh failed:', sanitizeErr(e)))

  // BKL-INGEST-09: Mark CCSP ok in sync-state after successful scrape + cache refresh
  writeSyncStateFlow('ccsp', 'ok')

  // Read new cache after scrape
  let newRecords: any[] = []
  if (existsSync(CCSP_CACHE_PATH)) {
    try { newRecords = JSON.parse(readFileSync(CCSP_CACHE_PATH, 'utf-8')).records ?? [] } catch {}
  }

  // BKL-M21: Post-scrape validation — warn if scraped records seem partial
  const { customers: currentCustomersForValidation } = await import('./server-state.ts')
  const expectedCustomerCount = currentCustomersForValidation.length
  const scrapedCustomerNames = new Set(newRecords.map((r: any) => r.accountName).filter(Boolean))
  if (scrapedCustomerNames.size < expectedCustomerCount * 0.5 && expectedCustomerCount > 0) {
    console.warn(`[scraper-validation] WARNING: CCSP scraped ${scrapedCustomerNames.size} customers but expected ~${expectedCustomerCount} — possible partial scrape`)
  }

  // Compute per-customer delta (field is accountName, value is acvPlus)
  const prevMap = new Map<string, number>()
  for (const row of prevRecords) {
    if (row.accountName) prevMap.set(row.accountName, (prevMap.get(row.accountName) ?? 0) + (row.acvPlus ?? 0))
  }
  const newMap = new Map<string, number>()
  for (const row of newRecords) {
    if (row.accountName) newMap.set(row.accountName, (newMap.get(row.accountName) ?? 0) + (row.acvPlus ?? 0))
  }
  const allCustomers = new Set([...prevMap.keys(), ...newMap.keys()])
  const deltas = Array.from(allCustomers).map(customer => ({
    customer,
    prev: prevMap.get(customer) ?? 0,
    curr: newMap.get(customer) ?? 0,
    change: (newMap.get(customer) ?? 0) - (prevMap.get(customer) ?? 0),
  })).filter(d => d.change !== 0)

  const delta = { computedAt: new Date().toISOString(), deltas }
  writeFileSync(CCSP_DELTA_PATH, JSON.stringify(delta, null, 2), { mode: 0o600 })
  console.log(`[ccsp-sync] delta written: ${deltas.length} customers changed`)
}

export function scheduleCcspSync(): void {
  const msUntil = nextEt630amUtc().getTime() - Date.now()
  console.log(`[ccsp-sync] next run in ${Math.round(msUntil / 60_000)}m (6:30am ET)`)
  setTimeout(async () => {
    const ccspConfig = getSchedulerConfig()
    if (!ccspConfig.ccspEnabled) {
      console.log('[ccsp-sync] CCSP sync disabled — skipping')
      scheduleCcspSync()
      return
    }
    console.log('[ccsp-sync] starting scheduled CCSP scrape…')
    try {
      // Tableau session pre-flight: try fetching base URL, skip if dead
      const tableauBase = process.env.TABLEAU_BASE_URL
      if (tableauBase) {
        try {
          const probe = await fetch(tableauBase, { signal: AbortSignal.timeout(8_000), redirect: 'manual' })
          // A redirect to auth/signin means session is dead
          if (probe.status >= 300 && probe.status < 400) {
            const loc = probe.headers.get('location') ?? ''
            if (loc.includes('signin') || loc.includes('auth')) {
              const reason = 'Tableau session expired. Reconnect via dashboard.'
              console.warn(`[scheduler] SKIPPED: CCSP sync — ${reason}`)
              setLastSkipReason('ccsp', reason)
              // BKL-M50f: surface skip in scraper status store
              recordOutcome('ccsp', { success: false, error: `Scheduled scrape skipped — session expired` })
              scheduleCcspSync()
              return
            }
          }
        } catch {
          const reason = 'Tableau probe failed (unreachable). Reconnect via dashboard.'
          console.warn(`[scheduler] SKIPPED: CCSP sync — ${reason}`)
          setLastSkipReason('ccsp', reason)
          // BKL-M50f: surface skip in scraper status store
          recordOutcome('ccsp', { success: false, error: `Scheduled scrape skipped — session expired` })
          scheduleCcspSync()
          return
        }
      }

      const { aes } = await import('./server-state.ts')
      if (!aes.length) {
        console.log('[ccsp-sync] no AEs configured — skipping')
        scheduleCcspSync()
        return
      }

      // BKL-SUP-02: Defer scheduled CCSP if Supportable is actively scraping (session collision guard)
      if (supportableScrapeRunning) {
        console.log('[ccsp-sync] supportable scrape in progress — deferring scheduled CCSP to avoid session collision')
        scheduleCcspSync()
        return
      }

      // BKL-M49: Enqueue through scraper queue instead of running directly
      // BKL-INGEST-06: Wrap run with retry — failures re-enqueue with 5m→10m→15m back-off.
      // Note: runCcspScrapeWithDelta already calls writeSyncStateFlow('ccsp', ok|failed)
      // internally — do NOT add duplicate sync-state writes here.
      const capturedAes = aes
      const ccspRun = async () => {
        await runCcspScrapeWithDelta(capturedAes)
        updateSchedulerField('ccspLastRun', new Date().toISOString())
        console.log('[ccsp-sync] CCSP scrape complete')
      }
      enqueueScraperTask({
        name: 'ccsp',
        run: async () => {
          try {
            await ccspRun()
          } catch (e: any) {
            console.warn('[ccsp-sync] scrape failed — scheduling retry:', e?.message ?? e)
            scheduleRetry('ccsp', ccspRun, RETRY_DELAYS, 0)
            throw e
          }
        },
        source: 'scheduled',
        enqueuedAt: Date.now(),
      })
    } catch (e: any) {
      console.error('[ccsp-sync] error:', e?.message ?? e)
    }
    scheduleCcspSync()  // reschedule for next day
  }, msUntil)
}

// ── Supportable daily batch rotation at 7am ET (ADR-008) ────────────────────

const BATCH_STATE_PATH = resolve(process.env.DATA_DIR ?? 'data', 'config', 'batch-state.json')

function readBatchState(): { batchIndex: number; lastBatchRun: string | null } {
  try {
    if (existsSync(BATCH_STATE_PATH)) {
      return JSON.parse(readFileSync(BATCH_STATE_PATH, 'utf-8'))
    }
  } catch {}
  return { batchIndex: 0, lastBatchRun: null }
}

function writeBatchState(state: { batchIndex: number; lastBatchRun: string | null }): void {
  writeFileSync(BATCH_STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 })
}

async function probeVpn(): Promise<boolean> {
  try {
    await fetch('https://supportable.corp.redhat.com', { signal: AbortSignal.timeout(8_000), redirect: 'manual' })
    return true
  } catch {
    return false
  }
}

export function scheduleSupportableSync(): void {
  const msUntil = nextEt7amUtc().getTime() - Date.now()
  console.log(`[supportable-sync] next batch run in ${Math.round(msUntil / 60_000)}m (7:00am ET)`)
  setTimeout(async () => {
    const suppConfig = getSchedulerConfig()
    if (!suppConfig.supportableEnabled) {
      console.log('[supportable-sync] Supportable sync disabled — skipping')
      scheduleSupportableSync()
      return
    }
    // VPN probe: retry every 15 min until 9am ET
    const nineAmEt = (() => {
      const ref = new Date()
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      })
      const p: Record<string, number> = {}
      for (const part of fmt.formatToParts(ref)) {
        if (part.type !== 'literal') p[part.type] = Number(part.value)
      }
      const etAsIfUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
      const etOffsetMs = ref.getTime() - etAsIfUtcMs
      const target = new Date(Date.UTC(p.year, p.month - 1, p.day, 9, 0, 0) + etOffsetMs)
      return target.getTime() < Date.now() ? new Date(target.getTime() + 86_400_000) : target
    })()

    let vpnOk = await probeVpn()
    while (!vpnOk && Date.now() < nineAmEt.getTime()) {
      console.warn('[supportable-sync] VPN probe failed — retrying in 15m')
      await new Promise(r => setTimeout(r, 15 * 60_000))
      if (Date.now() >= nineAmEt.getTime()) break
      vpnOk = await probeVpn()
    }
    if (!vpnOk) {
      const reason = 'VPN unreachable by 9am ET. Connect VPN and trigger manual sync.'
      console.error(`[scheduler] SKIPPED: Supportable sync — ${reason}`)
      setLastSkipReason('supportable', reason)
      // BKL-M50f: surface skip in scraper status store
      recordOutcome('supportable', { success: false, error: `Scheduled scrape skipped — session expired` })
      scheduleSupportableSync()
      return
    }

    try {
      const { customers: currentCustomers } = await import('./server-state.ts')
      if (!currentCustomers.length) {
        console.log('[supportable-sync] no customers configured — skipping')
        scheduleSupportableSync()
        return
      }

      const state = readBatchState()
      const batchIdx = state.batchIndex % 3
      const batch = currentCustomers.filter((_: any, i: number) => i % 3 === batchIdx)
      console.log(`[supportable-sync] batch ${batchIdx}: ${batch.length} customers`)

      // BKL-M49: Enqueue through scraper queue instead of running directly
      if (batch.length > 0) {
        const capturedBatch = batch
        const capturedBatchIdx = batchIdx
        enqueueScraperTask({
          name: 'supportable',
          run: async () => {
            const results = await runSupportableDiscoverAndScrape(capturedBatch)

            // BKL-M21: Post-scrape validation — warn if batch results seem partial
            const customersWithAccounts = capturedBatch.filter((c: any) => c.accountNumbers?.length > 0).length
            const expectedWithAccounts = capturedBatch.length
            if (customersWithAccounts < expectedWithAccounts * 0.5 && expectedWithAccounts > 0) {
              console.warn(`[scraper-validation] WARNING: Supportable batch discovered accounts for ${customersWithAccounts}/${expectedWithAccounts} customers — possible partial scrape`)
            }

            // FIX N1: Split results by AE and write a sheet per AE
            for (const ae of aes) {
              const aeResults = results.filter(r => {
                const cx = customers.find(c => c.name === r.customerName)
                return cx?.ae === ae.name
              })
              if (aeResults.length > 0 && aeResults.some(r => r.accountNumbers.length > 0)) {
                try {
                  const spreadsheetId = await writeSupportableSheet(aeResults, ae.name, ae.driveFolderId, ae.supportableSheetId || undefined)
                  patchAe(ae.name, { supportableSheetId: spreadsheetId })
                } catch (e: any) {
                  console.warn(`[supportable-sync] sheet write failed for ${ae.name}:`, sanitizeErr(e))
                }
              }
            }
            await refreshSubscriptions().catch(() => {})

            writeBatchState({ batchIndex: (capturedBatchIdx + 1) % 3, lastBatchRun: new Date().toISOString() })
            updateSchedulerField('supportableLastRun', new Date().toISOString())
            console.log(`[supportable-sync] batch ${capturedBatchIdx} complete — next batch: ${(capturedBatchIdx + 1) % 3}`)
          },
          source: 'scheduled',
          enqueuedAt: Date.now(),
        })
      } else {
        writeBatchState({ batchIndex: (batchIdx + 1) % 3, lastBatchRun: new Date().toISOString() })
      }
    } catch (e: any) {
      console.error('[supportable-sync] error:', e?.message ?? e)
      // Still increment batch index on error so we don't retry same batch indefinitely
      const state = readBatchState()
      writeBatchState({ batchIndex: ((state.batchIndex % 3) + 1) % 3, lastBatchRun: new Date().toISOString() })
    }
    scheduleSupportableSync()  // reschedule for next day
  }, msUntil)
}

// ── Territory sheet daily sync at 1:45am ET ─────────────────────────────────

const TERRITORY_NOTIFICATIONS_PATH = resolve(process.env.DATA_DIR ?? 'data', 'cache', 'territory-notifications.json')

interface TerritoryNotification {
  type: 'removal' | 'reassignment'
  customer: string
  ae: string
  detectedAt: string
}

export function scheduleTerritorySync(): void {
  const msUntil = nextEt145amUtc().getTime() - Date.now()
  console.log(`[territory-sync] next run in ${Math.round(msUntil / 60_000)}m (1:45am ET)`)
  setTimeout(async () => {
    const terrConfig = getSchedulerConfig()
    if (!terrConfig.territoryEnabled) {
      console.log('[territory-sync] Territory sync disabled — skipping')
      scheduleTerritorySync()
      return
    }
    console.log('[territory-sync] starting territory sheet sync…')
    try {
      // Pre-flight: check Google auth token exists
      const tokenPath = process.env.GOOGLE_UNIFIED_TOKEN_PATH
      if (tokenPath && !existsSync(tokenPath)) {
        console.warn('[territory-sync] Google auth token missing — skipping')
        scheduleTerritorySync()
        return
      }

      const { aes, customers: currentCustomers, CUSTOMERS_PATH } = await import('./server-state.ts')
      if (!aes.length) {
        console.log('[territory-sync] no AEs configured — skipping')
        scheduleTerritorySync()
        return
      }

      const result = await syncTerritorySheet(aes, currentCustomers)

      // Auto-add new customers
      if (result.toAdd.length > 0) {
        console.log(`[territory-sync] adding ${result.toAdd.length} new customers`)
        const { writeFileSync: writeFileSyncRaw, renameSync } = await import('fs')
        const updated = [...currentCustomers, ...result.toAdd]
        const tmpPath = CUSTOMERS_PATH + '.tmp'
        writeFileSyncRaw(tmpPath, JSON.stringify({ customers: updated }, null, 2), { mode: 0o600 })
        renameSync(tmpPath, CUSTOMERS_PATH)
        // Update in-memory state
        const { setCustomers } = await import('./server-state.ts')
        setCustomers(updated)
        console.log(`[territory-sync] customers updated: ${result.toAdd.map((c: any) => c.name).join(', ')}`)
      }

      // Write removal/reassignment notifications (never auto-delete)
      if (result.toRemove.length > 0) {
        let existing: { updatedAt: string; pending: TerritoryNotification[] } = { updatedAt: '', pending: [] }
        try {
          if (existsSync(TERRITORY_NOTIFICATIONS_PATH)) {
            existing = JSON.parse(readFileSync(TERRITORY_NOTIFICATIONS_PATH, 'utf-8'))
          }
        } catch {}
        const newNotifications: TerritoryNotification[] = result.toRemove.map((c: any) => ({
          type: 'removal' as const,
          customer: c.name,
          ae: c.ae,
          detectedAt: new Date().toISOString(),
        }))
        // Dedup: don't add notifications already pending for same customer
        const existingKeys = new Set(existing.pending.map((n: any) => `${n.customer}::${n.ae}`))
        const fresh = newNotifications.filter((n: any) => !existingKeys.has(`${n.customer}::${n.ae}`))
        const updated = {
          updatedAt: new Date().toISOString(),
          pending: [...existing.pending, ...fresh],
        }
        writeFileSync(TERRITORY_NOTIFICATIONS_PATH, JSON.stringify(updated, null, 2), { mode: 0o600 })
        console.log(`[territory-sync] ${fresh.length} new removal notifications written`)
      }

      updateSchedulerField('territoryLastRun', new Date().toISOString())
      console.log(`[territory-sync] complete: +${result.toAdd.length} added, ${result.toRemove.length} flagged for review, ${result.unchanged.length} unchanged`)
    } catch (e: any) {
      console.error('[territory-sync] error:', e?.message ?? e)
    }
    scheduleTerritorySync()  // reschedule for next day
  }, msUntil)
}

let _sfSessionPathForScheduler = ''

export function schedulePipelineSync(sfSessionPath?: string): void {
  if (sfSessionPath) _sfSessionPathForScheduler = sfSessionPath
  const next   = nextEt2amUtc()
  const now    = new Date()
  const msUntil = next.getTime() - now.getTime()
  const hUntil  = Math.round(msUntil / 1000 / 60 / 60 * 10) / 10
  console.log(`[pipeline-sync] next run at ${next.toISOString()} (${hUntil}h from now)`)

  setTimeout(async () => {
    const pipeConfig = getSchedulerConfig()
    if (!pipeConfig.sfPipelineEnabled) {
      console.log('[pipeline-sync] Pipeline sync disabled — skipping')
      schedulePipelineSync()
      return
    }
    try {
      console.log('[pipeline-sync] starting daily 2am ET sync')
      // Guard: skip full SF scrape if no active session — cache refresh still runs
      const sfStatus = _sfSessionPathForScheduler
        ? getSfAuthStatus(_sfSessionPathForScheduler)
        : { hasSession: false }
      if (!sfStatus.hasSession) {
        const reason = 'Salesforce session expired. Reconnect via dashboard.'
        console.warn(`[scheduler] SKIPPED: Pipeline sync — ${reason}`)
        setLastSkipReason('salesforce', reason)
        await refreshPipeline()
      } else {
        // BKL-T06 / BKL-G30 Gap 3: SF Lightning pre-flight — gates the scrape (was log-only)
        let sfProbeOk = false
        try {
          const probe = await fetch('https://redhatcrm.lightning.force.com/lightning/n/Home', {
            signal: AbortSignal.timeout(8_000),
            redirect: 'manual',
          })
          if (probe.status >= 400) {
            const reason = `SF Lightning returned ${probe.status} — session may be expired`
            console.warn(`[pipeline-sync] SF pre-flight: ${reason}`)
            setLastSkipReason('salesforce', reason)
          } else {
            console.log('[pipeline-sync] SF pre-flight: Lightning reachable')
            sfProbeOk = true
          }
        } catch (e: any) {
          const reason = `SF pre-flight probe failed: ${e?.message ?? e}`
          console.warn(`[pipeline-sync] ${reason}`)
          setLastSkipReason('salesforce', reason)
        }

        // BKL-M49: Enqueue SF pipeline sync through scraper queue (gated on probe)
        // BKL-INGEST-06: Wrap run with retry — failures re-enqueue with 5m→10m→15m back-off.
        // BKL-INGEST-09 sync-state writes happen inside pipelineRun so a successful
        // retry still marks 'ok'; the outer catch only adds retry scheduling and rethrow.
        if (sfProbeOk) {
          const { aes: capturedAes } = await import('./server-state.ts')
          const pipelineRun = async () => {
            try {
              await runSfSyncForAes(capturedAes)
              // BKL-INGEST-09: Mark pipeline ok in sync-state after successful sync
              writeSyncStateFlow('pipeline', 'ok')
            } catch (e: any) {
              // BKL-INGEST-09: Mark pipeline failed so late startup detection knows this ran
              writeSyncStateFlow('pipeline', 'failed')
              throw e
            }
          }
          enqueueScraperTask({
            name: 'sf-pipeline',
            run: async () => {
              try {
                await pipelineRun()
              } catch (e: any) {
                console.warn('[pipeline-sync] scrape failed — scheduling retry:', e?.message ?? e)
                scheduleRetry('sf-pipeline', pipelineRun, RETRY_DELAYS, 0)
                throw e
              }
            },
            source: 'scheduled',
            enqueuedAt: Date.now(),
          })
        }
      }
      updateSchedulerField('sfPipelineLastRun', new Date().toISOString())
    } catch (e: any) {
      console.warn(`[pipeline-sync] error: ${e.message}`)
    }
    schedulePipelineSync()  // reschedule for next day
  }, msUntil)
}

// ── Email delivery scheduler (BKL-E06) ───────────────────────────────────────
// Reads email-settings.json on each cycle (supports live config changes).
// At delivery time: aggregates cached data → renderBriefHtml() → sendBriefEmail().

const EMAIL_SETTINGS_PATH_SCHED = resolve(process.env.DATA_DIR ?? 'data', 'config', 'email-settings.json')

interface EmailSettingsSched {
  enabled: boolean
  deliveryTime: string   // "HH:MM"
  timezone: string       // IANA tz, e.g. "America/New_York"
  schedule: string       // "daily" | "weekdays"
  recipientEmail: string
  sections: { meetings: boolean; emails: boolean; cases: boolean; pipeline: boolean; brief: boolean }
}

const DEFAULT_EMAIL_SETTINGS_SCHED: EmailSettingsSched = {
  enabled: false,
  deliveryTime: '07:00',
  timezone: 'America/New_York',
  schedule: 'weekdays',
  recipientEmail: '',
  sections: { meetings: true, emails: true, cases: true, pipeline: true, brief: true },
}

function readEmailSettingsSched(): EmailSettingsSched {
  try {
    if (existsSync(EMAIL_SETTINGS_PATH_SCHED)) {
      return { ...DEFAULT_EMAIL_SETTINGS_SCHED, ...JSON.parse(readFileSync(EMAIL_SETTINGS_PATH_SCHED, 'utf-8')) }
    }
  } catch {}
  return { ...DEFAULT_EMAIL_SETTINGS_SCHED }
}

/** Returns ms until next delivery based on HH:MM in the configured timezone. */
function msUntilEmailDelivery(settings: EmailSettingsSched): number {
  const now = new Date()
  const tz = settings.timezone || 'America/New_York'
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const p: Record<string, number> = {}
  for (const part of fmt.formatToParts(now)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  // Parse HH:MM delivery time
  const [hh, mm] = (settings.deliveryTime || '07:00').split(':').map(Number)
  const etAsIfUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  const tzOffsetMs = now.getTime() - etAsIfUtcMs
  let target = new Date(Date.UTC(p.year, p.month - 1, p.day, hh, mm, 0) + tzOffsetMs)
  // If already past, schedule for tomorrow
  if (target.getTime() <= now.getTime()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000)
  }
  return target.getTime() - now.getTime()
}

export function scheduleEmailDelivery(): void {
  // Re-read config on each cycle to pick up live settings changes
  const settings = readEmailSettingsSched()

  if (!settings.enabled || !settings.recipientEmail) {
    // Email delivery disabled — reschedule check in 1 hour to pick up future config changes
    setTimeout(() => scheduleEmailDelivery(), 60 * 60 * 1000)
    return
  }

  const msUntil = msUntilEmailDelivery(settings)
  console.log(`[email-delivery] next delivery in ${Math.round(msUntil / 60_000)}m to ${settings.recipientEmail}`)

  setTimeout(async () => {
    // Re-read config at delivery time (user may have changed settings)
    const liveSettings = readEmailSettingsSched()

    if (!liveSettings.enabled || !liveSettings.recipientEmail) {
      console.log('[email-delivery] delivery skipped — email disabled or no recipient')
      scheduleEmailDelivery()
      return
    }

    // Weekdays-only check
    if (liveSettings.schedule === 'weekdays') {
      const tz = liveSettings.timezone || 'America/New_York'
      const day = new Date().toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' })
      if (day === 'Sat' || day === 'Sun') {
        console.log('[email-delivery] delivery skipped — weekend (schedule=weekdays)')
        scheduleEmailDelivery()
        return
      }
    }

    try {
      const { customers: currentCustomers } = await import('./server-state.ts')

      // Aggregate cached briefs into BriefEmailData
      const today = new Date()
      const dateDisplay = today.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: liveSettings.timezone || 'America/New_York',
      })

      // Gather customer briefs from cache
      const customerBriefs = currentCustomers
        .map((c: any) => {
          const brief = readBriefCache(c.name)
          return brief ? { customerName: c.name, briefText: brief.text } : null
        })
        .filter((b): b is { customerName: string; briefText: string } => b !== null)

      // Gather pipeline from cache
      const pipelineCache = readPipelineCache()
      const pipeline = (pipelineCache?.records ?? []).slice(0, 10).map((r: any) => ({
        dealName: r.opportunityName ?? r.accountName ?? 'Unknown',
        customer: r.accountName ?? '',
        stage: r.stage ?? '',
        value: r.amount ? `$${Number(r.amount).toLocaleString()}` : '$0',
        changeType: 'steady' as const,
        sfLink: r.sfLink,
      }))

      const briefData = {
        dateDisplay,
        meetings: [],
        emails: [],
        cases: [],
        pipeline,
        customerBriefs,
        sections: liveSettings.sections,
      }

      const html = renderBriefHtml(briefData)
      const subject = `Morning Brief — ${dateDisplay}`
      await sendBriefEmail(liveSettings.recipientEmail, subject, html)
      console.log(`[email-delivery] brief sent to ${liveSettings.recipientEmail}`)
    } catch (e: any) {
      console.error('[email-delivery] failed:', e?.message ?? e)
    }

    scheduleEmailDelivery()  // reschedule for next cycle
  }, msUntil)
}

// ── Startup account number validation ───────────────────────────────────────

/**
 * Validate cached account numbers on startup.
 * Warns if any customer has suspiciously many accounts (likely false positives
 * from a Supportable APEX name search that wasn't properly capped).
 * Auto-clears accounts if count > 50 (too high to be legitimate).
 */
export function validateCachedAccountNumbers(): void {
  const { customers: currentCustomers, CUSTOMERS_PATH } = require('./server-state.ts')
  const flagged: string[] = []
  let autoCleared = false

  for (const c of currentCustomers) {
    const count = c.accountNumbers?.length ?? 0
    if (count > 50) {
      console.warn(`[startup-validation] AUTO-CLEARING ${c.name}: ${count} account numbers exceeds safety limit (likely false positive)`)
      c.accountNumbers = []
      autoCleared = true
      flagged.push(`${c.name} (${count} → 0)`)
    } else if (count > 20) {
      console.warn(`[startup-validation] WARNING: ${c.name} has ${count} cached account numbers — verify these are legitimate`)
      flagged.push(`${c.name} (${count})`)
    }
  }

  if (autoCleared && currentCustomers.length > 0) {
    try {
      const { writeFileSync, renameSync } = require('node:fs')
      const tmpPath = CUSTOMERS_PATH + '.tmp'
      writeFileSync(tmpPath, JSON.stringify({ customers: currentCustomers }, null, 2), { mode: 0o600 })
      renameSync(tmpPath, CUSTOMERS_PATH)
      console.warn(`[startup-validation] Cleared bad account numbers and saved customers.json`)
    } catch (e: any) {
      console.warn(`[startup-validation] Failed to save cleared accounts: ${e?.message}`)
    }
  } else if (autoCleared && currentCustomers.length === 0) {
    console.warn('[startup-validation] SKIPPED disk write — currentCustomers is empty, refusing to overwrite customers.json')
  }

  if (flagged.length === 0) {
    console.log(`[startup-validation] Account numbers OK — all ${currentCustomers.length} customers within limits`)
  } else {
    console.warn(`[startup-validation] Flagged customers: ${flagged.join(', ')}`)
  }
}

// ── Sheet ID health check ──────────────────────────────────────────────────────
// Verifies each AE's configured sheet IDs are accessible to the OAuth token.
// Runs 5s after startup, fire-and-forget. Problems surface in container logs
// rather than silently serving stale or missing data.
async function runSheetHealthCheck(): Promise<void> {
  try {
    const { google } = await import('googleapis')
    const { makeAuth } = await import('./google.ts')
    const auth = makeAuth('__unused__')  // makeAuth uses unified token if it exists, __unused__ is never read
    const sheets = google.sheets({ version: 'v4', auth })
    const checks: { ae: string; type: string; id: string }[] = []
    for (const ae of aes) {
      if (ae.ccspSheetId)        checks.push({ ae: ae.name, type: 'ccsp',        id: ae.ccspSheetId })
      if (ae.pipelineSheetId)    checks.push({ ae: ae.name, type: 'pipeline',    id: ae.pipelineSheetId })
      if (ae.supportableSheetId) checks.push({ ae: ae.name, type: 'supportable', id: ae.supportableSheetId })
    }
    if (checks.length === 0) {
      console.log('[sheet-health] no sheet IDs configured — skipping health check')
      return
    }
    for (const { ae, type, id } of checks) {
      try {
        await sheets.spreadsheets.get({ spreadsheetId: id, fields: 'spreadsheetId' })
        console.log(`[sheet-health] ✓ ${ae} ${type}: accessible`)
      } catch (e: any) {
        console.warn(`[sheet-health] ✗ ${ae} ${type}: UNREACHABLE (${id}) — ${e?.message}`)
      }
    }
  } catch (e: any) {
    console.warn('[sheet-health] check failed:', e?.message)
  }
}

// ── Startup background tasks ────────────────────────────────────────────────

const RH_SCRAPE_TICK_MS = 15 * 60 * 1000  // tick interval — short intervals are reliable in Bun
const DRIVE_WATCHER_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

export function initBackgroundScheduler(opts: {
  rhSessionPath: string
  rhProfileDir: string
  sfSessionPath?: string
}): void {

  // Capture RH session path for session health watchdog
  _watchdogRhSessionPath = opts.rhSessionPath

  // Load persisted scraper status so state survives container restarts
  initStatusStore()

  // Seed lastSfSync from pipeline cache so it survives container restarts
  initSfSyncFromCache(readPipelineCache)

  // Async sheet health check — fire and forget, runs 5s after startup
  setTimeout(() => runSheetHealthCheck(), 5000)

  // Validate cached account numbers — warn/clear false positives before scrapes start
  validateCachedAccountNumbers()

  // On startup: run a full refresh, then schedule per-source timers
  if (customers.length > 0) {
    refreshAll().catch((e: any) => console.error('[refresh] startup refresh failed:', e?.message ?? e))
    rescheduleRefreshTimers(getRefreshIntervals())
  }

  // L4 writer schedulers — primary node only (BKL-SYNC-L3-02)
  if (isPrimary) {
    // Territory syncs daily at 1:45am ET (before pipeline at 2am)
    scheduleTerritorySync()

    // Pipeline syncs daily at 2am ET (SF report generated at 1am ET)
    schedulePipelineSync(opts.sfSessionPath)

    // CCSP scrape daily at 6:30am ET
    scheduleCcspSync()
  }

  // Supportable batch rotation daily at 7am ET (ADR-008)
  scheduleSupportableSync()

  // KPI daily snapshot at 8am ET (R05 — after all morning syncs complete)
  scheduleKpiSnapshot()

  // Email brief delivery — scheduled per user config (BKL-E06)
  scheduleEmailDelivery()

  // BKL-INGEST-09 / BKL-SYNC-L3-02: Late startup catch-up — primary node only.
  // Hero installs must NOT run catch-up: no L4 credentials, throws on every restart.
  if (isPrimary && !todaySyncRan()) {
    console.log('[sync-state] today\'s sync has not run — scheduling catch-up in 60s')
    setTimeout(() => {
      // Re-check in case another startup path already triggered a sync during the 60s window
      if (todaySyncRan()) {
        console.log('[sync-state] catch-up: sync ran during stabilisation window — skipping')
        return
      }
      // BKL-BOOT-SCRAPE-ORDER-01: Top-level guard — if no AEs are configured yet
      // (fresh container, before bootstrap), skip ALL catch-up scrapes entirely.
      // Without this guard, catch-up fires CCSP/pipeline against an empty AE list
      // while the user is mid-bootstrap, racing the shared Chromium context.
      import('./server-state.ts').then(({ aes: catchupAes }) => {
        if (!catchupAes || catchupAes.length === 0) {
          console.log('[sync-state] catch-up skipped — no AEs configured yet')
          return
        }
        console.log('[sync-state] catch-up: triggering CCSP and Pipeline via queue (source: startup)')
        // CCSP catch-up: reuse existing enqueue pattern — only if ccspEnabled
        const ccspCfg = getSchedulerConfig()
        if (ccspCfg.ccspEnabled) {
          enqueueScraperTask({
            name: 'ccsp',
            run: async () => {
              await runCcspScrapeWithDelta(catchupAes)
              updateSchedulerField('ccspLastRun', new Date().toISOString())
              console.log('[sync-state] catch-up: CCSP scrape complete')
            },
            source: 'startup',
            enqueuedAt: Date.now(),
          })
        }
        // Pipeline catch-up: reuse existing enqueue pattern — only if sfPipelineEnabled and session present
        const pipeCfg = getSchedulerConfig()
        if (pipeCfg.sfPipelineEnabled) {
          enqueueScraperTask({
            name: 'sf-pipeline',
            run: async () => {
              try {
                await runSfSyncForAes(catchupAes)
                writeSyncStateFlow('pipeline', 'ok')
              } catch (e: any) {
                writeSyncStateFlow('pipeline', 'failed')
                throw e
              }
            },
            source: 'startup',
            enqueuedAt: Date.now(),
          })
        }
      }).catch(e => console.warn('[sync-state] catch-up: server-state import failed:', e?.message))
    }, 60_000)
  } else {
    console.log('[sync-state] today\'s sync already ran — skipping catch-up')
  }

  // Cold-start auth-gate: On startup, wait 10s for Xvfb + Chrome to stabilise,
  // then init context. Before enqueueing scrapes, verify the session is actually
  // valid by checking if RH portal loads. If stale (overnight laptop sleep),
  // skip the initial scrape and log clearly — user will VNC in and re-auth,
  // which triggers circuit breaker reset + immediate scrape enqueue via rh-auth.ts.
  if (existsSync(opts.rhSessionPath)) {
    setTimeout(async () => {
      console.log('[scraper-queue] startup: initialising browser context…')
      await initScrapeContext(opts.rhProfileDir)
      const ctx = getScrapeContext()
      if (ctx) {
        adoptSfContext(ctx, opts.rhProfileDir)
        adoptSupportableContext(ctx)
        adoptCcspContext(ctx)

        // Auth pre-flight: check if the session is actually valid
        try {
          const testPage = await ctx.newPage()
          const response = await testPage.goto('https://access.redhat.com/support/cases', {
            waitUntil: 'domcontentloaded', timeout: 15_000,
          })
          const finalUrl = testPage.url()
          await testPage.close()

          const onLoginPage = finalUrl.includes('sso.redhat.com') || finalUrl.includes('auth.redhat.com/auth/realms')
          if (onLoginPage) {
            // Confirmed redirect to SSO login — session is expired
            recordScrapeExpired()
            console.warn('[scraper-queue] startup: auth pre-flight FAILED — session expired (redirected to login). Skipping startup scrape. VNC in to re-authenticate.')
          } else {
            // On RH Portal or mid-SSO bounce with valid session — assume valid
            console.log(`[scraper-queue] startup: auth pre-flight PASSED — session valid (url: ${finalUrl}), enqueueing scrape`)
            enqueueScraperTask({
              name: 'rh-cases',
              run: () => runRhScrapeWithState(),
              source: 'startup',
              enqueuedAt: Date.now(),
            })
          }
        } catch (e: any) {
          // Navigation error (timeout, Xvfb not ready, network blip) — do NOT mark session
          // expired. A browser crash is not evidence the session is invalid. Leave
          // rhSessionExpired untouched so the UI stays at its last known state.
          console.warn(`[scraper-queue] startup: auth pre-flight error — ${e?.message ?? e}. Skipping startup scrape (session state unchanged).`)
        }
      }
    }, 10_000)
  }

  // ── Unified 15-min heartbeat tick (BKL-M19) ──────────────────────────────
  // Bun's setInterval is unreliable for intervals > ~1h (ADR-007).
  // A single 15-min tick checks elapsed time for all three background refreshes:
  //   - RH scraper (Timer 3) — already used this pattern
  //   - Subscriptions (Timer 1) — converted from raw setInterval
  //   - CCSP (Timer 2) — converted from raw setInterval
  if (!_heartbeatStarted) {
    _heartbeatStarted = true
    setInterval(() => {
      const intervals = getRefreshIntervals()
      const schedulerCfg = getSchedulerConfig()
      const now = Date.now()

      // Timer 3: RH scraper — enqueue through scraper queue (BKL-M49)
      if (!schedulerCfg.rhEnabled) {
        console.log('[rh-scraper] tick: RH Cases disabled — skipping')
      } else if (!aes || aes.length === 0) {
        console.log('[rh-scraper] tick: no AEs configured — skipping')
      } else {
        const rhIntervalMs = intervals.rhScrape * 60 * 1000
        const rhLastMs = lastScraped ? new Date(lastScraped).getTime() : 0
        const rhElapsed = now - rhLastMs
        if (rhElapsed >= rhIntervalMs) {
          console.log(`[rh-scraper] tick: ${Math.round(rhElapsed / 60_000)}m since last scrape — enqueueing`)
          enqueueScraperTask({
            name: 'rh-cases',
            run: async () => {
              await runRhScrapeWithState()
              updateSchedulerField('rhLastRun', new Date().toISOString())
            },
            source: 'heartbeat',
            enqueuedAt: Date.now(),
          })
        } else {
          console.log(`[rh-scraper] tick: next scrape in ${Math.round((rhIntervalMs - rhElapsed) / 60_000)}m`)
        }
      }

      // BKL-M49: Drain queue on each heartbeat tick — if a scraper finished
      // between ticks and there are pending tasks, kick off the next one.
      runNextInQueue()

      // Timer 1: Subscriptions refresh
      if (customers.length > 0) {
        const subIntervalMs = intervals.subscriptions * 60 * 1000
        const subElapsed = now - _subscriptionsLastRun
        if (subElapsed >= subIntervalMs) {
          console.log(`[refresh] tick: subscriptions due (${Math.round(subElapsed / 60_000)}m elapsed) — triggering`)
          _subscriptionsLastRun = now
          refreshSubscriptions().catch((e: any) => console.error('[refresh] subscriptions failed:', e?.message ?? e))
        }
      }

      // Timer 2: CCSP refresh
      if (customers.length > 0) {
        const ccspIntervalMs = intervals.ccsp * 60 * 1000
        const ccspElapsed = now - _ccspLastRun
        if (ccspElapsed >= ccspIntervalMs) {
          console.log(`[refresh] tick: CCSP due (${Math.round(ccspElapsed / 60_000)}m elapsed) — triggering`)
          _ccspLastRun = now
          refreshCCSP().catch((e: any) => console.error('[refresh] CCSP failed:', e?.message ?? e))
        }
      }

      // ── Session health watchdog ─────────────────────────────────────────────
      // Runs on every heartbeat tick. Fires static ntfy alerts (no interpolation
      // of session tokens, cookies, or raw error objects — SECURITY-BASELINE §sanitizeErr).
      if (_watchdogRhSessionPath) {
        const rhStatus = getRhStatus(_watchdogRhSessionPath)

        if (rhStatus.sessionExpired && !_lastWatchdogSessionExpired) {
          notify('RH Session Expired', 'Red Hat Portal session expired — log in via VNC to restore scraping', 'high').catch(() => {})
        }
        if (rhStatus.loginTimedOut && !_lastWatchdogSessionExpired) {
          notify('RH Login Timed Out', 'Login attempt timed out — retry via dashboard Connect button', 'high').catch(() => {})
        }
        _lastWatchdogSessionExpired = rhStatus.sessionExpired
      }

      // Consecutive failure alerting — fire once per scraper crossing the threshold
      const scraperStatus = getStatus()
      for (const [scraperName, entry] of Object.entries(scraperStatus)) {
        if (entry.consecutiveFailures >= 5) {
          if (!_alertedScrapers.has(scraperName)) {
            _alertedScrapers.add(scraperName)
            // SECURITY: scraper key (internal enum) + failure count (integer) only — no error strings
            // safeError intentionally omitted: sanitizeErr cannot guarantee account numbers/hostnames
            // are stripped from all error paths. Check server logs for error details.
            notify(
              `Scraper Failing: ${scraperName}`,
              `${scraperName} has failed ${entry.consecutiveFailures} consecutive times. Check server logs for details.`,
              'high',
            ).catch(() => {})
          }
        } else if (entry.consecutiveFailures === 0) {
          // Scraper recovered — clear the alert so it can fire again if it fails later
          _alertedScrapers.delete(scraperName)
        }
      }
    }, RH_SCRAPE_TICK_MS)
  }

  // ── Drive watcher — init and background polling ──────────────────────────

  ;(async () => {
    const parentIds = (process.env.AE_PARENT_FOLDER_IDS ?? process.env.AE_PARENT_FOLDER_ID ?? '')
      .split(',').filter(Boolean)
    if (!parentIds.length) return
    try {
      await initDriveWatcher(customers, parentIds)
    } catch (e: any) {
      console.warn('[drive-watcher] startup init failed:', e.message)
    }
  })()

  setInterval(async () => {
    try {
      const affected = await checkDriveChanges()
      for (const customerName of affected) {
        const cachePath = briefCachePath(customerName)
        try {
          unlinkSync(cachePath)
          console.log(`[drive-watcher] invalidated brief cache for ${customerName}`)
        } catch {
          // Cache file may not exist — that's fine
        }
      }
    } catch (e: any) {
      console.warn('[drive-watcher] interval check failed:', e.message)
    }
  }, DRIVE_WATCHER_INTERVAL_MS)

  // On startup: background pre-generation of today's briefs for customers missing cache
  // Rate-limited to 1 customer per 10 seconds to avoid Drive API quota exhaustion
  ;(async () => {
    if (!customers.length || !isBriefConfigured()) return
    const missing = customers.filter((c) => !readBriefCache(c.name))
    if (!missing.length) return
    console.log(`[brief-pregen] starting background generation for ${missing.length} customers…`)
    for (const customer of missing) {
      // Re-check in case a user request already generated this brief while we were waiting
      if (readBriefCache(customer.name)) continue
      try {
        const cachedSheet = readSheetCache(customer.name)
        const [meetings, emails, docs, cases, subscriptions, products] = await Promise.all([
          fetchCustomerMeetings(customer).catch(() => []),
          fetchCustomerEmails(customer).catch(() => []),
          fetchCustomerDocs(customer).catch(() => []),
          fetchCustomerCases(customer).catch(() => []),
          fetchCustomerSubscriptions(customer).catch(() => []),
          cachedSheet ? Promise.resolve(cachedSheet.rows) : fetchCustomerSheetData(customer).catch(() => []),
        ])
        // Wave 5: cache customer Drive docs corpus for product intel use
        const customerSlug = customer.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
        writeCustomerDocsCorpus(customerSlug, docs)

        // AI18-R1d: use normalizeForQuery (same as customer-routes.ts) to match "Acme Corp" ↔ "Acme Corporation"
        const customerNeedle = normalizeForQuery(customer.name)
        const pipelineRecords = (readPipelineCache()?.records ?? []).filter(r => normalizeForQuery(r.accountName).includes(customerNeedle) || customerNeedle.includes(normalizeForQuery(r.accountName)))
        const ccspRecords = (readCCSPCache()?.records ?? []).filter(r => normalizeForQuery(r.accountName).includes(customerNeedle) || customerNeedle.includes(normalizeForQuery(r.accountName)))
        // BKL-ADR013-P2: compute input fingerprint so pre-generated briefs match on next request.
        const fingerprintSource = JSON.stringify({
          emails: emails.map(e => `${e.date}|${e.from}|${e.subject}`),
          meetings: meetings.map(m => `${m.start}|${m.title}`),
          docs: docs.map(d => d.id ?? `${d.name}|${d.modifiedTime ?? ''}`),
          cases: cases.map(r => r.caseNumber),
          subscriptions: subscriptions.map(s => `${s.subscriptionNumber}|${s.status}|${s.endDate}`),
          products: products.map(p => `${p.sku}|${p.status}|${p.endDate ?? ''}`),
          pipeline: pipelineRecords.map(r => r.oppId ?? r.oppNumber ?? r.accountName),
          ccsp: ccspRecords.map(r => `${r.accountName}|${r.cloudPartner}|${r.quarter ?? ''}`),
        })
        const inputFingerprint = createHash('sha256').update(fingerprintSource).digest('hex')
        const text = await generateBrief(customer, meetings, emails, docs, cases, subscriptions, products, pipelineRecords, ccspRecords)
        const lastEmail = emails?.[0]?.date ? new Date(emails[0].date) : undefined
        const lastMeeting = meetings?.[0]?.start ? new Date(meetings[0].start) : undefined
        const lastActivity = [lastEmail, lastMeeting].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0]
        // BKL-AI-FP-09: build corpus snapshot for delta detection on next miss
        const corpusSnapshot: Record<string, string> = {}
        for (const d of docs) { if (d.id) corpusSnapshot[d.id] = d.modifiedTime ?? '' }
        writeBriefCache(customer.name, text, lastActivity, inputFingerprint, corpusSnapshot)
        console.log(`[brief-pregen] ${customer.name}: done`)
      } catch (e: any) {
        console.warn(`[brief-pregen] ${customer.name}: ${e.message}`)
      }
      // 10-second gap between customers to stay within Drive API quota
      await new Promise((r) => setTimeout(r, 10_000))
    }
    console.log('[brief-pregen] complete')
  })()

  // BKL-STARTUP-01: On cold start, seed missing product-intel summary caches.
  // make rebuild wipes data/cache/product-intel/{slug}-summary.json files.
  // The weekly scheduler only re-seeds on Sunday 6am ET — anything missing
  // before that window causes Generate buttons to silently fail.
  // Fire-and-forget: non-blocking, runs 15s after startup to let server stabilise.
  setTimeout(async () => {
    try {
      const { loadProductConfig, getCachedSummary, refreshAllProducts } = await import('./product-release-radar.ts')
      const products = loadProductConfig()
      if (!products.length) return
      const missing = products.filter(p => !getCachedSummary(p.slug))
      if (!missing.length) {
        console.log('[product-intel] startup: all product summary caches present — no seed needed')
        return
      }
      console.log(`[product-intel] startup: ${missing.length}/${products.length} product summary caches missing — seeding in background`)
      await refreshAllProducts()
      console.log('[product-intel] startup: product summary cache seed complete')
    } catch (e: any) {
      console.error('[product-intel] startup: product summary cache seed failed:', e?.message ?? e)
    }

    // BKL-FEAT-STARTUP-SEED-01: seed missing product feature caches after the
    // summary seed completes. Mirrors the summary seeder pattern — fire-and-
    // forget, env-guarded, only seeds products with no existing feature cache
    // file. Without this, /products page Generate buttons silently fail until
    // the next scheduled refresh.
    if (process.env.GOOGLE_CLOUD_PROJECT) {
      try {
        const { loadProductConfig } = await import('./product-release-radar.ts')
        const { getFeatureCache, refreshAllFeatures } = await import('./product-feature-radar.ts')
        const products = loadProductConfig()
        const featureMissingProducts = products.filter(p => getFeatureCache(p.slug) === null)
        if (featureMissingProducts.length > 0) {
          console.log(`[product-intel] startup: seeding features for ${featureMissingProducts.length}/${products.length} products`)
          refreshAllFeatures().catch((e: any) => console.error('[product-intel] startup feature seed failed:', e?.message ?? e))
        } else {
          console.log('[product-intel] startup: all product feature caches present — no seed needed')
        }
      } catch (e: any) {
        console.error('[product-intel] startup: feature seed error:', e?.message ?? e)
      }
    }

    // BKL-UX-PRODUCT-FOLDER-CONFIG-01 (D): auto-refresh Drive corpus for
    // products with a configured driveFolder when no cached corpus exists or
    // the cached corpus is older than 24h. Ensures files dropped into
    // product folders are picked up at next restart without a manual
    // "Refresh Slides" click. Fire-and-forget per product.
    try {
      const { loadProductConfig } = await import('./product-release-radar.ts')
      const { getCachedDriveCorpus, refreshDriveCorpus } = await import('./product-drive-ingest.ts')
      const products = loadProductConfig().filter(p => !!p.driveFolder)
      const STALE_MS = 24 * 60 * 60 * 1000
      const now = Date.now()
      let triggered = 0
      for (const p of products) {
        const cached = getCachedDriveCorpus(p.slug)
        const stale = !cached || (cached.extractedAt && (now - new Date(cached.extractedAt).getTime() > STALE_MS))
        if (stale) {
          triggered++
          refreshDriveCorpus(p.slug).catch((e: any) => console.error(`[product-intel] startup corpus refresh failed for ${p.slug}:`, e?.message ?? e))
        }
      }
      if (triggered > 0) {
        console.log(`[product-intel] startup: triggered Drive corpus refresh for ${triggered}/${products.length} product(s) with stale or missing corpus`)
      }
    } catch (e: any) {
      console.error('[product-intel] startup: corpus refresh error:', e?.message ?? e)
    }
  }, 15_000)

  // Graceful shutdown — close Chromium so it doesn't orphan in containers
  async function shutdown() {
    console.log('[shutdown] closing browser context…')
    await closeScrapeContext().catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT',  shutdown)
}

// ── Product Intelligence weekly refresh — Sunday 6am ET (Wave 4) ─────────────
// Bun's setInterval is unreliable for intervals > ~1h (ADR-007).
// Uses setTimeout + reschedule loop (container-safe).

function nextEtSunday6amUtc(now?: Date): Date {
  const base = now ?? new Date()
  // Determine ET offset: UTC-5 (EST) or UTC-4 (EDT)
  const etOffsetMin = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  })
    .formatToParts(base)
    .find(p => p.type === 'timeZoneName')
    ?.value?.replace('GMT', '') ?? '-5'
  const offsetHours = parseInt(etOffsetMin, 10) || -5
  const offsetMs    = offsetHours * 60 * 60 * 1000

  // Target: next Sunday at 06:00 ET
  const candidate = new Date(base)
  // Find next Sunday
  const dayOfWeek = candidate.getUTCDay() - (offsetHours < 0 ? 0 : 0)
  const daysUntilSunday = ((7 - candidate.getDay()) % 7) || 7
  candidate.setUTCDate(candidate.getUTCDate() + daysUntilSunday)
  // Set to 06:00 ET = 06:00 - offsetHours UTC
  candidate.setUTCHours(6 - offsetHours, 0, 0, 0)
  // If already past, add 7 days
  if (candidate <= base) candidate.setUTCDate(candidate.getUTCDate() + 7)
  return candidate
}

export function scheduleProductIntelRefresh(): void {
  const msUntil = nextEtSunday6amUtc().getTime() - Date.now()
  const hUntil  = Math.round(msUntil / 3_600_000)
  console.log(`[product-intel] next weekly refresh in ${hUntil}h (Sunday 6:00am ET)`)

  setTimeout(async () => {
    console.log('[product-intel] weekly refresh started')
    try {
      const { refreshAllProducts } = await import('./product-release-radar.ts')
      await refreshAllProducts()
      console.log('[product-intel] weekly refresh completed')
      // Extract + enrich features after product refresh
      try {
        const { refreshAllFeatures } = await import('./product-feature-radar.ts')
        await refreshAllFeatures()
        console.log('[product-intel] weekly feature radar refresh completed')
      } catch (featErr: any) {
        console.error('[product-intel] weekly feature radar refresh failed:', featErr?.message ?? featErr)
      }

      // Regenerate per-customer product intel after features are fresh
      try {
        const { buildCustomerIntelContext, generateCustomerProductIntel } = await import('./customer-product-intel.ts')
        const { toSlug: slugify } = await import('./cache-layer.ts')
        const { loadProductConfig, getCachedSummary } = await import('./product-release-radar.ts')
        const { _generatingKeys } = await import('./product-intel-routes.ts') as any
        const { getCachedDriveCorpus } = await import('./product-drive-ingest.ts')

        const productConfigs = loadProductConfig()
        console.log(`[product-intel] weekly customer intel refresh: ${customers.length} customers x ${productConfigs.length} products`)

        for (const customer of customers) {
          const customerSlug = slugify(customer.name)
          try {
            const ctx = await buildCustomerIntelContext(customerSlug)
            for (const product of productConfigs) {
              const summary = getCachedSummary(product.slug)
              if (!summary) continue  // skip products with no cached summary
              const mutexKey = `intel:${product.slug}:${customerSlug}`
              if (_generatingKeys && _generatingKeys.has(mutexKey)) continue  // skip if already generating
              if (_generatingKeys) _generatingKeys.add(mutexKey)
              try {
                const corpus = getCachedDriveCorpus(product.slug)
                const slidesText = corpus ? corpus.files.map((f: any) => f.textContent).join('\n\n') : ''
                const { features: productFeatures, hash: productFeaturesHash } = ctx.productFeaturesFn(product.slug)
                await generateCustomerProductIntel({
                  slug: product.slug,
                  productSummary: summary,
                  slidesText,
                  customerName: ctx.customerName,
                  subscriptions: ctx.subscriptions,
                  supportCases: ctx.supportCases,
                  customerDocsText: ctx.customerDocsText,
                  customerDocsHash: ctx.customerDocsHash,
                  opportunityNote: ctx.opportunityNote,
                  productFeatures,
                  productFeaturesHash,
                })
              } finally {
                if (_generatingKeys) _generatingKeys.delete(mutexKey)
              }
              await new Promise(r => setTimeout(r, 3000))  // 3s between Gemini calls
            }
          } catch (e: any) {
            console.error(`[product-intel] weekly customer intel refresh failed for ${customer.name}:`, e?.message)
          }
        }
        console.log('[product-intel] weekly customer intel refresh completed')
      } catch (intelErr: any) {
        console.error('[product-intel] weekly customer intel refresh failed:', intelErr?.message ?? intelErr)
      }
    } catch (e: any) {
      console.error('[product-intel] weekly refresh failed:', e?.message ?? e)
    }
    scheduleProductIntelRefresh()  // reschedule for next Sunday
  }, msUntil)
}
