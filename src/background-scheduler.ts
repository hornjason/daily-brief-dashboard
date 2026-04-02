import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { customers } from './server-state.ts'
import { refreshAll, refreshSubscriptions, refreshCCSP, refreshPipeline } from './refresh-engine.ts'
import { runRhScrapeWithState, runSfSyncForAes } from './scraper-manager.ts'
import { getSfAuthStatus } from './sf-auth.ts'
import { getRefreshIntervals, DEFAULT_REFRESH_INTERVALS, getSchedulerConfig, updateSchedulerField } from './settings-api.ts'
import { lastScraped } from './rh-auth.ts'
import { initScrapeContext, getScrapeContext, closeScrapeContext } from './rh-scraper.ts'
import { adoptSfContext } from './sf-scraper.ts'
import { adoptSupportableContext, runSupportableDiscoverAndScrape } from './supportable-scraper.ts'
import { adoptCcspContext, runCcspScrape } from './ccsp-scraper.ts'
import { syncTerritorySheet } from './territory-sync.ts'
import { initDriveWatcher, checkDriveChanges } from './drive-watcher.ts'
import { captureSnapshot, writeSnapshot } from './kpi-history.ts'
import { briefCachePath, readBriefCache, readSheetCache, readPipelineCache, readCCSPCache, writeBriefCache, cleanOrphanedCacheFiles } from './cache-layer.ts'
import { isBriefConfigured, fetchCustomerMeetings, fetchCustomerEmails, fetchCustomerDocs, generateBrief } from './customer.ts'
import { fetchCustomerCases, fetchCustomerSubscriptions } from './redhat.ts'
import { fetchCustomerSheetData } from './sheets.ts'

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

async function runCcspScrapeWithDelta(aes: any[]): Promise<void> {
  // Read previous cache before scrape
  let prevRecords: any[] = []
  if (existsSync(CCSP_CACHE_PATH)) {
    try { prevRecords = JSON.parse(readFileSync(CCSP_CACHE_PATH, 'utf-8')).records ?? [] } catch {}
  }

  await runCcspScrape(aes)

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
              console.warn('[ccsp-sync] Tableau session dead (redirect to auth) — skipping scheduled scrape')
              scheduleCcspSync()
              return
            }
          }
        } catch {
          console.warn('[ccsp-sync] Tableau probe failed — skipping scheduled scrape')
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

      await runCcspScrapeWithDelta(aes)
      updateSchedulerField('ccspLastRun', new Date().toISOString())
      console.log('[ccsp-sync] CCSP scrape complete')
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
      console.error('[supportable-sync] VPN unreachable by 9am ET — skipping today\'s batch')
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

      if (batch.length > 0) {
        await runSupportableDiscoverAndScrape(batch)

        // BKL-M21: Post-scrape validation — warn if batch results seem partial
        const customersWithAccounts = batch.filter((c: any) => c.accountNumbers?.length > 0).length
        const expectedWithAccounts = batch.length
        if (customersWithAccounts < expectedWithAccounts * 0.5 && expectedWithAccounts > 0) {
          console.warn(`[scraper-validation] WARNING: Supportable batch discovered accounts for ${customersWithAccounts}/${expectedWithAccounts} customers — possible partial scrape`)
        }
      }

      writeBatchState({ batchIndex: (batchIdx + 1) % 3, lastBatchRun: new Date().toISOString() })
      updateSchedulerField('supportableLastRun', new Date().toISOString())
      console.log(`[supportable-sync] batch ${batchIdx} complete — next batch: ${(batchIdx + 1) % 3}`)
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
        console.warn('[pipeline-sync] no SF session — skipping source scrape, cache refresh only')
        await refreshPipeline()
      } else {
        // BKL-T06: Lightweight pre-flight — verify SF Lightning is reachable (session alive != report accessible)
        try {
          const probe = await fetch('https://redhatcrm.lightning.force.com/lightning/n/Home', {
            signal: AbortSignal.timeout(8_000),
            redirect: 'manual',
          })
          if (probe.status >= 400) {
            console.warn(`[pipeline-sync] SF pre-flight: Lightning returned ${probe.status} — session may be expired`)
          } else {
            console.log('[pipeline-sync] SF pre-flight: Lightning reachable')
          }
        } catch (e: any) {
          console.warn('[pipeline-sync] SF pre-flight probe failed:', e?.message ?? e)
        }

        // Full chain: SF → GSheet → local cache
        import('./server-state.ts').then(({ aes }) => runSfSyncForAes(aes))
        // Refresh cache from GSheet after a brief delay for the scrape to start writing
        setTimeout(() => refreshPipeline().catch((e: any) => console.warn('[pipeline-sync] cache refresh error:', e.message)), 60_000)
      }
      updateSchedulerField('sfPipelineLastRun', new Date().toISOString())
    } catch (e: any) {
      console.warn(`[pipeline-sync] error: ${e.message}`)
    }
    schedulePipelineSync()  // reschedule for next day
  }, msUntil)
}

// ── Startup background tasks ────────────────────────────────────────────────

const RH_SCRAPE_TICK_MS = 15 * 60 * 1000  // tick interval — short intervals are reliable in Bun
const DRIVE_WATCHER_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

export function initBackgroundScheduler(opts: {
  rhSessionPath: string
  rhProfileDir: string
  sfSessionPath?: string
}): void {

  // On startup: run a full refresh, then schedule per-source timers
  if (customers.length > 0) {
    refreshAll().catch((e: any) => console.error('[refresh] startup refresh failed:', e?.message ?? e))
    rescheduleRefreshTimers(getRefreshIntervals())
  }

  // Territory syncs daily at 1:45am ET (before pipeline at 2am)
  scheduleTerritorySync()

  // Pipeline syncs daily at 2am ET (SF report generated at 1am ET)
  schedulePipelineSync(opts.sfSessionPath)

  // CCSP scrape daily at 6:30am ET
  scheduleCcspSync()

  // Supportable batch rotation daily at 7am ET (ADR-008)
  scheduleSupportableSync()

  // KPI daily snapshot at 8am ET (R05 — after all morning syncs complete)
  scheduleKpiSnapshot()

  // On startup: open persistent scrape context and run initial scrape if session exists
  if (existsSync(opts.rhSessionPath)) {
    setTimeout(async () => {
      await initScrapeContext(opts.rhProfileDir)
      // Share the same browser context with SF and Supportable scrapers
      const ctx = getScrapeContext()
      if (ctx) { adoptSfContext(ctx, opts.rhProfileDir); adoptSupportableContext(ctx); adoptCcspContext(ctx) }
      runRhScrapeWithState().catch((e: any) => console.error("[rh-scraper] unhandled error:", e?.message ?? e))
    }, 5_000)
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

      // Timer 3: RH scraper
      if (!schedulerCfg.rhEnabled) {
        console.log('[rh-scraper] tick: RH Cases disabled — skipping')
      } else {
        const rhIntervalMs = intervals.rhScrape * 60 * 1000
        const rhLastMs = lastScraped ? new Date(lastScraped).getTime() : 0
        const rhElapsed = now - rhLastMs
        if (rhElapsed >= rhIntervalMs) {
          console.log(`[rh-scraper] tick: ${Math.round(rhElapsed / 60_000)}m since last scrape — triggering`)
          runRhScrapeWithState().catch((e: any) => {
            console.error("[rh-scraper] unhandled error:", e?.message ?? e)
          }).then(() => {
            updateSchedulerField('rhLastRun', new Date().toISOString())
          })
        } else {
          console.log(`[rh-scraper] tick: next scrape in ${Math.round((rhIntervalMs - rhElapsed) / 60_000)}m`)
        }
      }

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
        const pipelineRecords = (readPipelineCache()?.records ?? []).filter(r => r.accountName.toLowerCase() === customer.name.toLowerCase())
        const ccspRecords = (readCCSPCache()?.records ?? []).filter(r => r.accountName.toLowerCase() === customer.name.toLowerCase())
        const text = await generateBrief(customer, meetings, emails, docs, cases, subscriptions, products, pipelineRecords, ccspRecords)
        writeBriefCache(customer.name, text)
        console.log(`[brief-pregen] ${customer.name}: done`)
      } catch (e: any) {
        console.warn(`[brief-pregen] ${customer.name}: ${e.message}`)
      }
      // 10-second gap between customers to stay within Drive API quota
      await new Promise((r) => setTimeout(r, 10_000))
    }
    console.log('[brief-pregen] complete')
  })()

  // Graceful shutdown — close Chromium so it doesn't orphan in containers
  async function shutdown() {
    console.log('[shutdown] closing browser context…')
    await closeScrapeContext().catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT',  shutdown)
}
