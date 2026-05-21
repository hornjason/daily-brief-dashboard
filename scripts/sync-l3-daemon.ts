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
import { initScrapeContext, getScrapeContext, recoverScrapeContext } from '../src/rh-scraper.ts'
import { adoptCcspContext } from '../src/ccsp-scraper.ts'
import { initSfContext } from '../src/sf-scraper.ts'
import { sendBriefEmail } from '../src/email-sender.ts'
import { syncAllPods } from './sync-pod-l3.ts'
import { scrapeSalesHub } from './scrape-saleshub.ts'
import { syncSalesHubToDrive } from './sync-saleshub-drive.ts'
import { isPrimary } from '../src/lib/node-role.ts'
import { isContextHealthy, canContextRender } from './sync-l3-daemon-utils.ts'
import { adoptSfContext } from '../src/sf-scraper.ts'

// ── Guard: primary node only ──────────────────────────────────────────────────

if (!isPrimary()) {
  console.error('[sync-daemon] NODE_ROLE must be primary — exiting')
  process.exit(1)
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PROFILE_DIR = process.env.RH_PROFILE_DIR ?? '/data/rh-profile'
// BKL-KEEPALIVE-VIZ-01: Use direct viz embed URL (/t/ not /#/) to actually load the viz.
// The dashboard shell (/#/) doesn't keep the viz session alive — must hit the viz directly.
const TABLEAU_VIZ_URL = 'https://10ay.online.tableau.com/t/redhatanalytics/views/OverallCloudConsumptionDashboard/CloudConsumption'
const SF_BASE_URL = 'https://redhatcrm.lightning.force.com/lightning/page/home'
const KEEPALIVE_INTERVAL_MS = 2 * 60 * 60 * 1000  // 2 hours
const ALERT_EMAIL = 'jhorn@redhat.com'

// BKL-SYNC-CHROME-LEAK Layer 4: Proactive recycle constants
const RECYCLE_INTERVAL_MS = 12 * 60 * 60 * 1000  // 12 hours
// BKL-SYNC-CHROME-LEAK Bonus: Memory threshold for proactive recycle
const RSS_THRESHOLD_BYTES = 3 * 1024 * 1024 * 1024  // 3 GB

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
 * Search for a VISIBLE element across all frames (mirrors ccsp-tableau-fetch.ts findEl).
 * Tableau renders viz inside iframes — page.$() only searches main document.
 */
async function findEl(page: any, selector: string): Promise<any> {
  for (const frame of page.frames()) {
    try {
      const el = await frame.$(selector)
      if (el && (await el.isVisible().catch(() => false))) return el
    } catch {
      /* frame may have navigated away */
    }
  }
  return null
}

/**
 * Wait for Tableau viz to render — mirrors ccsp-tableau-fetch.ts waitForVizReady.
 * Returns true if Raw Data tab appears (viz rendered), false if timeout.
 */
async function waitForVizReady(page: any, maxWaitMs = 45_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    const el = await findEl(page, 'text="Raw Data"')
    if (el) {
      console.log(`[sync-daemon] keepalive: viz ready — Raw Data tab visible (${Math.round((Date.now() - start) / 1000)}s)`)
      return true
    }
    await page.waitForTimeout(1_000)
  }
  console.warn(`[sync-daemon] keepalive: viz not ready after ${maxWaitMs / 1000}s`)
  return false
}

/**
 * Visit Tableau and SF Lightning home pages to refresh SSO cookies.
 * Mirrors the exact validation flow from ccsp-tableau-fetch.ts fetchPodCsv:
 *   1. Navigate to viz URL
 *   2. Wait for networkidle (non-fatal)
 *   3. Check for login wall (URL + form detection)
 *   4. Wait for viz to render (Raw Data tab visible)
 *   5. Navigate to SF
 * Throws on login wall or viz render failure.
 */
async function doKeepalive(): Promise<void> {
  const ctx = getScrapeContext()
  if (!ctx) {
    throw new Error('No browser context available for keepalive')
  }

  const page = await ctx.newPage()
  try {
    // Tableau keepalive — hit the actual viz page (/t/ embed URL) not the dashboard shell
    console.log('[sync-daemon] keepalive: navigating Tableau viz…')
    const tableauUrl = process.env.TABLEAU_VIZ_URL ?? TABLEAU_VIZ_URL
    await page.goto(tableauUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    // Wait for SSO redirect chain to complete before checking URL.
    // Tableau redirects through sso.online.tableau.com even when logged in — need to wait
    // for it to redirect back to 10ay.online.tableau.com before validating.
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {
      console.warn('[sync-daemon] keepalive: networkidle timed out — continuing anyway')
    })
    await page.waitForTimeout(5_000)  // give SSO redirect chain time to complete

    // Check if URL settled on viz page or stuck on login
    let currentUrl = page.url()
    console.log(`[sync-daemon] keepalive: URL after navigation: ${currentUrl}`)

    // Detect login page — same check as CCSP scraper
    const isLoginPage =
      !currentUrl.includes('10ay.online.tableau.com') ||
      currentUrl.includes('/auth') ||
      currentUrl.includes('/login') ||
      currentUrl.includes('/SSO') ||
      (await page
        .$('input[type="password"], input#username, [data-testid="login"]')
        .then(el => !!el)
        .catch(() => false))

    if (isLoginPage) {
      // Auto-fill email if TABLEAU_USER_EMAIL is set (mirrors ccsp-tableau-fetch.ts)
      const tableauUserEmail = process.env.TABLEAU_USER_EMAIL ?? ''
      if (tableauUserEmail) {
        console.log(`[sync-daemon] keepalive: SSO login detected — auto-filling email ${tableauUserEmail}`)
        try {
          const emailInput = await page.$('input[name="email"], input[type="email"], input[placeholder*="mail" i], input[name="identifier"], input[name="username"]')
            .catch(() => null)
          if (emailInput) {
            const currentVal = await emailInput.inputValue().catch(() => '')
            if (!currentVal) {
              await emailInput.fill(tableauUserEmail)
              await page.waitForTimeout(300)
              const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Next"), button:has-text("Log in")')
                .catch(() => null)
              if (submitBtn) {
                await submitBtn.click().catch(() => {})
              } else {
                await emailInput.press('Enter').catch(() => {})
              }
              console.log('[sync-daemon] keepalive: auto-filled email and submitted')
              // Wait for SSO to redirect back
              await page.waitForTimeout(10_000)
              currentUrl = page.url()
              console.log(`[sync-daemon] keepalive: URL after email submit: ${currentUrl}`)
            }
          }
        } catch (e: any) {
          console.warn(`[sync-daemon] keepalive: email auto-fill failed: ${e.message}`)
        }
      } else {
        throw new Error(`Tableau session expired — login required (URL: ${currentUrl}, no TABLEAU_USER_EMAIL set)`)
      }
    }

    // Wait for viz to render (Raw Data tab visible) — the authoritative check
    // If this succeeds, session is valid regardless of any transient SSO redirects
    console.log('[sync-daemon] keepalive: waiting for viz to render…')
    const vizReady = await waitForVizReady(page)
    if (!vizReady) {
      throw new Error('Tableau viz failed to render — Raw Data tab never appeared')
    }

    // SF keepalive — use domcontentloaded (faster, networkidle times out)
    console.log('[sync-daemon] keepalive: navigating Salesforce…')
    await page.goto(SF_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(2_000)  // brief wait for SF to settle
    const sfFinal = page.url()
    if (sfFinal.includes('login') || sfFinal.includes('sso') || sfFinal.includes('auth/login')) {
      throw new Error(`SF session expired — redirected to ${sfFinal}`)
    }

    // BKL-SYNC-CHROME-LEAK Bonus: Memory monitoring — trigger proactive recycle on high RSS
    const rss = process.memoryUsage().rss
    const rssMB = Math.round(rss / 1024 / 1024)
    if (rss > RSS_THRESHOLD_BYTES) {
      console.warn(`[sync-daemon] keepalive: RSS ${rssMB}MB exceeds ${Math.round(RSS_THRESHOLD_BYTES / 1024 / 1024)}MB threshold — triggering proactive recycle`)
      await page.close().catch(() => {})
      await proactiveRecycle()
      return
    }
    console.log(`[sync-daemon] keepalive: RSS ${rssMB}MB (threshold: ${Math.round(RSS_THRESHOLD_BYTES / 1024 / 1024)}MB)`)

    // BKL-#223: RH context health probe — detect dead/unresponsive browser contexts
    // After ~6 days uptime, the RH Portal browser context (Playwright BrowserContext)
    // can silently die — the Chromium process becomes unresponsive. The SSO cookies
    // on disk are still valid, so recovery just re-initializes from saved state.
    console.log('[sync-daemon] keepalive: probing RH context health…')
    const rhHealthy = await isContextHealthy(ctx, 5000)
    if (!rhHealthy) {
      console.warn('[sync-daemon] keepalive: RH context dead — attempting auto-recovery')
      try {
        await recoverScrapeContext()
        console.log('[sync-daemon] keepalive: RH context recovered from saved cookies')
        // Re-adopt CCSP context after recovery
        const recoveredCtx = getScrapeContext()
        if (recoveredCtx) {
          adoptCcspContext(recoveredCtx)
          console.log('[sync-daemon] keepalive: CCSP re-adopted after RH recovery')
        }
      } catch (e: any) {
        const errorMsg = `RH context recovery FAILED: ${e?.message ?? e}`
        console.error(`[sync-daemon] keepalive: ${errorMsg}`)
        // Send alert email on recovery failure
        await sendBriefEmail(
          'ALERT: Sync Daemon RH Context Recovery Failed',
          `<h2>RH Browser Context Recovery Failed</h2>
          <p>The sync daemon detected a dead RH Portal browser context during keepalive and attempted auto-recovery, but recovery failed after all retry attempts.</p>
          <p><strong>Error:</strong> ${e?.message ?? e}</p>
          <p>Manual intervention required. Restart the pai-sync-l3 container to restore browser context.</p>
          <pre>podman restart pai-sync-l3</pre>`,
        ).catch(emailErr => console.error('[sync-daemon] alert email failed:', emailErr))
        throw new Error(errorMsg)
      }
    }

    console.log('[sync-daemon] keepalive: OK (Tableau viz rendered + SF home loaded + RH context healthy)')
  } finally {
    // VNC observation delay — wait 15s before closing so you can watch the navigation
    console.log('[sync-daemon] keepalive: holding page open for 15s (VNC observation)…')
    await new Promise(resolve => setTimeout(resolve, 15_000))
    await page.close().catch(() => {})
  }
}

// ── BKL-SYNC-CHROME-LEAK Layer 4: Proactive browser recycle ─────────────────

/**
 * Proactively recycle the browser: persist session state, close browser,
 * kill orphan Chrome processes, re-init context, and re-adopt sister scrapers.
 * Prevents Chrome memory bloat from accumulating over 48h+ uptime.
 */
async function proactiveRecycle(): Promise<void> {
  console.log('[sync-daemon] proactiveRecycle: starting browser recycle…')
  const { closeScrapeContext, initScrapeContext: reinitCtx, getScrapeContext: getCtx } = await import('../src/rh-scraper.ts')
  const { closeSfContext } = await import('../src/sf-scraper.ts')

  try {
    // 1. Persist session state (cookies) to disk before closing
    const ctx = getCtx()
    if (ctx) {
      try {
        const state = await ctx.storageState()
        const { writeFileSync } = await import('node:fs')
        writeFileSync(`${PROFILE_DIR}/session-state.json`, JSON.stringify(state), { mode: 0o600 })
        console.log('[sync-daemon] proactiveRecycle: session state persisted')
      } catch (e: any) {
        console.warn(`[sync-daemon] proactiveRecycle: session persist failed: ${e?.message}`)
      }
    }

    // 2. Close browser contexts properly
    await closeScrapeContext().catch(() => {})
    await closeSfContext().catch(() => {})

    // 3. Kill any remaining Chrome processes (safety net)
    try {
      const { execSync } = await import('node:child_process')
      execSync('pkill -f "chromium|chrome" 2>/dev/null || true', { timeout: 5_000 })
      console.log('[sync-daemon] proactiveRecycle: orphan Chrome processes killed')
    } catch { /* non-fatal */ }

    // 4. Brief pause for process cleanup
    await new Promise(r => setTimeout(r, 2_000))

    // 5. Re-init scrape context from persisted profile
    await reinitCtx(PROFILE_DIR)
    const newCtx = getCtx()
    if (!newCtx) {
      console.error('[sync-daemon] proactiveRecycle: failed to re-init browser context')
      return
    }

    // 6. Re-adopt sister scrapers (CCSP, SF)
    adoptCcspContext(newCtx)
    try {
      await initSfContext(PROFILE_DIR)
    } catch (e: any) {
      console.warn(`[sync-daemon] proactiveRecycle: SF re-init warning: ${e?.message}`)
    }

    console.log('[sync-daemon] proactiveRecycle: browser recycled successfully')
  } catch (e: any) {
    console.error(`[sync-daemon] proactiveRecycle: failed: ${e?.message ?? e}`)
  }
}

// ── Sync cycle ────────────────────────────────────────────────────────────────

async function runSyncCycle(): Promise<void> {
  console.log('[sync-daemon] starting daily sync cycle…')

  // BKL-SYNC-CHROME-LEAK Layer 3: Pre-sync rendering health check.
  // If the browser can respond to IPC but can't render, recycle before syncing.
  const ctx = getScrapeContext()
  if (ctx) {
    const canRender = await canContextRender(ctx)
    if (!canRender) {
      console.warn('[sync-daemon] pre-sync render check FAILED — recycling browser before sync')
      await proactiveRecycle()
    } else {
      console.log('[sync-daemon] pre-sync render check passed')
    }
  }

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

  // ADR-006 §2 H5 — Boot cleanup: delete any stale trigger files from a prior run.
  // Prevents replaying a trigger that was written before the last daemon restart.
  const CACHE_DIR = process.env.CACHE_DIR ?? '/data/cache'
  const TRIGGER_FILE = `${CACHE_DIR}/sync-trigger`
  const KEEPALIVE_TRIGGER_FILE = `${CACHE_DIR}/keepalive-trigger`
  const SALESHUB_TRIGGER_FILE = `${CACHE_DIR}/saleshub-trigger`

  if (existsSync(TRIGGER_FILE)) {
    try {
      unlinkSync(TRIGGER_FILE)
      console.log('[sync-daemon] deleted stale sync trigger file from prior run')
    } catch (e: any) {
      console.warn('[sync-daemon] could not delete stale sync trigger file:', e.message)
    }
  }

  if (existsSync(KEEPALIVE_TRIGGER_FILE)) {
    try {
      unlinkSync(KEEPALIVE_TRIGGER_FILE)
      console.log('[sync-daemon] deleted stale keepalive trigger file from prior run')
    } catch (e: any) {
      console.warn('[sync-daemon] could not delete stale keepalive trigger file:', e.message)
    }
  }

  if (existsSync(SALESHUB_TRIGGER_FILE)) {
    try {
      unlinkSync(SALESHUB_TRIGGER_FILE)
      console.log('[sync-daemon] deleted stale saleshub trigger file from prior run')
    } catch (e: any) {
      console.warn('[sync-daemon] could not delete stale saleshub trigger file:', e.message)
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

  // Timer 3: keepalive trigger — poll every 30s for /data/cache/keepalive-trigger
  setInterval(async () => {
    if (!existsSync(KEEPALIVE_TRIGGER_FILE)) return
    // Delete trigger BEFORE running keepalive (atomic consumption)
    try {
      unlinkSync(KEEPALIVE_TRIGGER_FILE)
    } catch (e: any) {
      console.error('[sync-daemon] failed to delete keepalive trigger file:', e.message)
      return
    }
    console.log('[sync-daemon] keepalive trigger file detected — running immediate keepalive')
    try {
      await doKeepalive()
      console.log('[sync-daemon] keepalive trigger: OK')
    } catch (e: any) {
      console.error('[sync-daemon] keepalive trigger: FAILED —', e.message)
    }
  }, 30_000)

  // Timer 4: SalesHub scrape trigger — poll every 30s for /data/cache/saleshub-trigger
  // ADR-030: scrapes all product pages from saleshub.redhat.com DocCenter
  let saleshubRunning = false
  setInterval(async () => {
    if (!existsSync(SALESHUB_TRIGGER_FILE)) return
    if (saleshubRunning) {
      console.log('[sync-daemon] saleshub trigger fired but scrape already running — discarding')
      try { unlinkSync(SALESHUB_TRIGGER_FILE) } catch { /* best-effort */ }
      return
    }
    try {
      unlinkSync(SALESHUB_TRIGGER_FILE)
    } catch (e: any) {
      console.error('[sync-daemon] failed to delete saleshub trigger file:', e.message)
      return
    }
    console.log('[sync-daemon] saleshub trigger detected — starting scrape')
    saleshubRunning = true
    try {
      const products = await scrapeSalesHub()
      console.log(`[sync-daemon] saleshub scrape complete — ${products.length} products`)
      // Sync scraped data to Drive L4 folder
      const driveResult = await syncSalesHubToDrive()
      console.log(`[sync-daemon] saleshub Drive sync — ${driveResult.uploaded} files, ${driveResult.shortcuts} shortcuts`)
    } catch (e: any) {
      console.error('[sync-daemon] saleshub scrape failed:', e.message)
    } finally {
      saleshubRunning = false
    }
  }, 30_000)

  // Timer 5: BKL-SYNC-CHROME-LEAK Layer 4 — proactive browser recycle every 12h
  setInterval(async () => {
    console.log('[sync-daemon] scheduled 12h browser recycle starting…')
    try {
      await proactiveRecycle()
      console.log('[sync-daemon] scheduled 12h browser recycle: OK')
    } catch (e: any) {
      console.error('[sync-daemon] scheduled 12h browser recycle: FAILED —', e?.message ?? e)
    }
  }, RECYCLE_INTERVAL_MS)

  // Timer 5: daily sync at 5:30am ET
  scheduleNextSync()
}

main().catch(err => {
  console.error('[sync-daemon] fatal startup error:', err)
  process.exit(1)
})
