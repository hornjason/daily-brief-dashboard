/**
 * scripts/sync-l3-daemon.ts — BKL-SYNC-L3-01
 *
 * Long-running L3 sync daemon. Guards that NODE_ROLE=primary before starting.
 * Manages two recurring tasks:
 *   1. SSO keepalive every 2h — navigates Tableau + SF to keep cookies alive
 *   2. Daily pod sync at 5:30am ET — calls syncAllPods() from sync-pod-l3.ts
 *
 * Start:    NODE_ROLE=primary bun scripts/sync-l3-daemon.ts
 * Container: launched via `make sync-up` with NODE_ROLE=primary in env.
 */

import { resolve } from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
import { initScrapeContext, getScrapeContext } from '../src/rh-scraper.ts'
import { adoptCcspContext } from '../src/ccsp-scraper.ts'
import { initSfContext } from '../src/sf-scraper.ts'
import { sendBriefEmail } from '../src/email-sender.ts'
import { syncAllPods } from './sync-pod-l3.ts'
import { isPrimary } from '../src/lib/node-role.ts'

// ── Guard: primary node only ──────────────────────────────────────────────────

if (!isPrimary()) {
  console.error('[sync-daemon] NODE_ROLE must be primary — exiting')
  process.exit(1)
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PROFILE_DIR = process.env.RH_PROFILE_DIR ?? '/data/rh-profile'
const TABLEAU_URL = 'https://10ay.online.tableau.com/#/site/redhatanalytics/views/OverallCloudConsumptionDashboard/CloudConsumption'
const SF_BASE_URL = 'https://redhatcrm.lightning.force.com/lightning/n/Home'
const KEEPALIVE_INTERVAL_MS = 2 * 60 * 60 * 1000  // 2 hours
const ALERT_EMAIL = 'jhorn@redhat.com'

// ── Time helpers ──────────────────────────────────────────────────────────────

/**
 * Returns milliseconds until the next 09:30 UTC (= 5:30am ET standard / 5:30am ET DST at 09:30).
 * If 09:30 UTC has already passed today, schedules for tomorrow.
 */
export function getMsUntil530amET(): number {
  const now = new Date()
  const target = new Date(now)
  target.setUTCHours(9, 30, 0, 0)

  if (target.getTime() <= now.getTime()) {
    // Already past 09:30 UTC today — schedule for tomorrow
    target.setUTCDate(target.getUTCDate() + 1)
  }

  return target.getTime() - now.getTime()
}

// ── SSO keepalive ─────────────────────────────────────────────────────────────

/**
 * Visit Tableau and SF Lightning home pages to refresh SSO cookies.
 * Throws on navigation redirect to login — indicates session is dead.
 */
async function doKeepalive(): Promise<void> {
  const ctx = getScrapeContext()
  if (!ctx) {
    throw new Error('No browser context available for keepalive')
  }

  const page = await ctx.newPage()
  try {
    // Tableau keepalive
    console.log('[sync-daemon] keepalive: navigating Tableau…')
    const tableauUrl = process.env.TABLEAU_BASE_URL ?? TABLEAU_URL
    const tableauResp = await page.goto(tableauUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const tableauFinal = page.url()
    if (tableauFinal.includes('signin') || tableauFinal.includes('auth') || (tableauResp?.status() ?? 200) >= 400) {
      throw new Error(`Tableau session expired — redirected to ${tableauFinal}`)
    }

    // SF keepalive
    console.log('[sync-daemon] keepalive: navigating Salesforce…')
    await page.goto(SF_BASE_URL, { waitUntil: 'networkidle', timeout: 30_000 })
    const sfFinal = page.url()
    if (sfFinal.includes('login') || sfFinal.includes('sso') || sfFinal.includes('auth/login')) {
      throw new Error(`SF session expired — redirected to ${sfFinal}`)
    }

    console.log('[sync-daemon] keepalive: OK (Tableau + SF)')
  } finally {
    await page.close().catch(() => {})
  }
}

// ── Sync cycle ────────────────────────────────────────────────────────────────

async function runSyncCycle(): Promise<void> {
  console.log('[sync-daemon] starting daily sync cycle…')
  try {
    const result = await syncAllPods()
    const errorCount = result.results.filter(r => r.status === 'error').length
    if (errorCount > 0) {
      console.warn(`[sync-daemon] sync cycle completed with ${errorCount} error(s)`)
    } else {
      console.log('[sync-daemon] sync cycle completed successfully')
    }
  } catch (e: any) {
    console.error('[sync-daemon] sync cycle threw unexpectedly:', e.message)
    try {
      await sendBriefEmail(
        ALERT_EMAIL,
        `L3 Sync Daemon - Fatal Error ${new Date().toISOString().slice(0, 10)}`,
        `<html><body><p>The sync cycle threw a fatal error:</p><pre>${e.message}</pre></body></html>`,
      )
    } catch (emailErr: any) {
      console.error('[sync-daemon] alert email failed:', emailErr.message)
    }
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

function scheduleNextSync(): void {
  const ms = getMsUntil530amET()
  const minutes = Math.round(ms / 60_000)
  console.log(`[sync-daemon] next sync in ${minutes}m (${new Date(Date.now() + ms).toISOString()})`)

  setTimeout(async () => {
    await runSyncCycle()
    scheduleNextSync()  // reschedule for tomorrow
  }, ms)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[sync-daemon] starting — NODE_ROLE=primary, profile=${PROFILE_DIR}`)

  // Init browser contexts — RH shared context (Tableau + SF share the same persistent profile)
  console.log('[sync-daemon] initializing browser contexts…')
  try {
    await initScrapeContext(PROFILE_DIR)
    const ctx = getScrapeContext()
    if (ctx) adoptCcspContext(ctx)
    console.log('[sync-daemon] RH browser context initialized')
  } catch (e: any) {
    console.error('[sync-daemon] RH context init failed:', e.message)
    process.exit(1)
  }

  try {
    await initSfContext(PROFILE_DIR)
    console.log('[sync-daemon] SF context initialized')
  } catch (e: any) {
    // SF init failure is non-fatal at startup — SF shares the RH profile
    console.warn('[sync-daemon] SF context init warning (non-fatal):', e.message)
  }

  // ADR-006 §2 H5 — Boot cleanup: delete any stale trigger file from a prior run.
  // Prevents replaying a trigger that was written before the last daemon restart.
  const CACHE_DIR = process.env.CACHE_DIR ?? '/data/cache'
  const TRIGGER_FILE = `${CACHE_DIR}/sync-trigger`
  if (existsSync(TRIGGER_FILE)) {
    try {
      unlinkSync(TRIGGER_FILE)
      console.log('[sync-daemon] deleted stale trigger file from prior run')
    } catch (e: any) {
      console.warn('[sync-daemon] could not delete stale trigger file:', e.message)
    }
  }

  console.log('[sync-daemon] started — keepalive every 2h, sync at 5:30am ET')

  // Timer 1: SSO keepalive every 2h
  setInterval(async () => {
    try {
      await doKeepalive()
      console.log('[sync-daemon] keepalive OK')
    } catch (e: any) {
      console.error('[sync-daemon] keepalive FAILED:', e.message)
      try {
        await sendBriefEmail(
          ALERT_EMAIL,
          `L3 Sync Daemon - Keepalive Failed ${new Date().toISOString().slice(0, 10)}`,
          `<html><body><p>The SSO keepalive failed — sessions may expire before the next sync.</p><pre>${e.message}</pre></body></html>`,
        )
      } catch (emailErr: any) {
        console.error('[sync-daemon] keepalive alert email failed:', emailErr.message)
      }
    }
  }, KEEPALIVE_INTERVAL_MS)

  // Timer 2: file-based trigger — poll every 30s for /data/cache/sync-trigger
  // Lets external callers request an immediate sync using the daemon's already-initialized
  // browser contexts (avoids Chromium SingletonLock conflicts from separate processes).
  // ADR-006 §2 H3: trigger file is deleted BEFORE sync starts (atomic consumption — prevents
  // duplicate trigger if sync takes longer than the 30s polling interval).
  // ADR-006 §2 H4: concurrent guard via syncRunning — trigger discarded if sync in progress.
  let syncRunning = false
  setInterval(async () => {
    if (!existsSync(TRIGGER_FILE)) return
    // H4: if a sync is already running when the trigger fires, log and discard.
    if (syncRunning) {
      console.log('[sync-daemon] trigger fired but sync already running — discarding')
      try { unlinkSync(TRIGGER_FILE) } catch { /* best-effort cleanup */ }
      return
    }
    // H3: delete trigger BEFORE starting sync (atomic consumption).
    try {
      unlinkSync(TRIGGER_FILE)
    } catch (e: any) {
      console.error('[sync-daemon] failed to delete trigger file:', e.message)
      return
    }
    console.log('[sync-daemon] trigger file detected — running immediate sync')
    syncRunning = true
    try {
      const result = await syncAllPods()
      const ok = result.results.filter(r => r.status === 'ok').length
      const skipped = result.results.filter(r => r.status === 'skipped').length
      const errors = result.results.filter(r => r.status === 'error').length
      console.log(`[sync-daemon] trigger sync complete — ok=${ok} skipped=${skipped} errors=${errors}`)
    } catch (e: any) {
      console.error('[sync-daemon] trigger sync threw unexpectedly:', e.message)
    } finally {
      syncRunning = false
    }
  }, 30_000)

  // Timer 3: daily sync at 5:30am ET
  scheduleNextSync()
}

main().catch(err => {
  console.error('[sync-daemon] fatal startup error:', err)
  process.exit(1)
})
