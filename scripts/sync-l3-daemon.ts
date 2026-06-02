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
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { initScrapeContext, getScrapeContext, recoverScrapeContext } from '../src/rh-scraper.ts'
import { adoptCcspContext } from '../src/ccsp-scraper.ts'
// initSfContext removed — SF now adopts the RH headed context (BKL-VNC-BLACK)
import { sendBriefEmail } from '../src/email-sender.ts'
import { syncAllPods } from './sync-pod-l3.ts'
import { scrapeSalesHub } from './scrape-saleshub.ts'
import { syncSalesHubToDrive } from './sync-saleshub-drive.ts'
import { enrichSolutionPlays } from './enrich-solution-plays.ts'
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
// #447: Recycle mutex timeout — if proactiveRecycle() doesn't finish within this window,
// the mutex is released and a container restart is recommended via alert email.
const RECYCLE_TIMEOUT_MS = 90_000  // 90 seconds
// #497: Hard timeout for keepalive — if doKeepalive() hangs on a dead browser
// (ctx.newPage() or page.close() never resolves), the mutex is released after this window.
const KEEPALIVE_TIMEOUT_MS = 120_000  // 120 seconds

// ── #447: Cross-timer recycle mutex ──────────────────────────────────────────
// Prevents concurrent proactiveRecycle() / recoverScrapeContext() calls from
// Timer 1 (keepalive), Timer 5 (12h recycle), and scheduled sync (pre-sync check).
let recycleRunning = false
/** Exported for testing only */
export function _getRecycleRunning(): boolean { return recycleRunning }

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
  // #497 AC-4: Track whether keepalive succeeded — only do VNC observation delay on success
  let succeeded = false
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
      const isRhExternalLogin = currentUrl.includes('sso.redhat.com') || currentUrl.includes('redhat-external')
      if (isRhExternalLogin) {
        // RH external SSO (customer portal) — needs rhn-gps username
        const rhUsername = process.env.RH_SSO_USERNAME ?? 'rhn-gps-jhorn'
        console.log(`[sync-daemon] keepalive: RH external login detected — auto-filling ${rhUsername}`)
        try {
          const loginInput = await page.$('input#username, input[name="username"], input[name="login"]').catch(() => null)
          if (loginInput) {
            await loginInput.fill(rhUsername)
            await page.waitForTimeout(300)
            const nextBtn = await page.$('button#login-show-step2, button:has-text("Next"), input[type="submit"]').catch(() => null)
            if (nextBtn) await nextBtn.click().catch(() => {})
            else await loginInput.press('Enter').catch(() => {})
            await page.waitForTimeout(10_000)
            currentUrl = page.url()
            console.log(`[sync-daemon] keepalive: URL after RH login submit: ${currentUrl}`)
          }
        } catch (e: any) {
          console.warn(`[sync-daemon] keepalive: RH login auto-fill failed: ${e.message}`)
        }
      } else {
        // Tableau SSO — auto-fill email
        const tableauUserEmail = process.env.TABLEAU_USER_EMAIL ?? ''
        if (tableauUserEmail) {
          console.log(`[sync-daemon] keepalive: Tableau SSO login detected — auto-filling email ${tableauUserEmail}`)
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
      // #447 AC-2: Check recycleRunning before calling recoverScrapeContext().
      // If a recycle is in progress, skip recovery (don't throw — let finally release keepaliveRunning).
      if (recycleRunning) {
        console.log('[sync-daemon] keepalive: recycle in progress — skipping RH recovery')
        return
      }
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

    // #497 AC-4: Mark keepalive as succeeded — VNC observation delay will only fire on success
    succeeded = true

    // Verify RH SSO session is actually authenticated (not just browser alive)
    // Re-fetch context — recovery may have replaced it
    const verifyCtx = getScrapeContext()
    if (!verifyCtx) throw new Error('No browser context available for RH SSO verification')
    console.log('[sync-daemon] keepalive: verifying RH SSO session…')
    const rhPage = await verifyCtx.newPage()
    try {
      await rhPage.goto('https://access.redhat.com/support/cases/#/case/list', {
        waitUntil: 'load', timeout: 30_000,
      })
      if (!rhPage.url().includes('access.redhat.com/support')) {
        await rhPage.waitForURL('**/access.redhat.com/support/**', { timeout: 15_000 }).catch(() => {})
      }
      if (rhPage.url().includes('access.redhat.com/support')) {
        console.log('[sync-daemon] keepalive: RH SSO session verified — authenticated')
      } else if (rhPage.url().includes('sso.redhat.com')) {
        // Try auto-fill
        const rhUsername = process.env.RH_SSO_USERNAME ?? 'rhn-gps-jhorn'
        console.log(`[sync-daemon] keepalive: RH SSO login page — auto-filling ${rhUsername}`)
        const loginInput = await rhPage.$('input#username, input[name="username"], input[name="login"]').catch(() => null)
        if (loginInput) {
          await loginInput.fill(rhUsername)
          await rhPage.waitForTimeout(300)
          const nextBtn = await rhPage.$('button#login-show-step2, button:has-text("Next"), input[type="submit"]').catch(() => null)
          if (nextBtn) await nextBtn.click().catch(() => {})
          else await loginInput.press('Enter').catch(() => {})
          await rhPage.waitForURL('**/access.redhat.com/**', { timeout: 15_000 }).catch(() => {})
        }
        if (rhPage.url().includes('access.redhat.com/support')) {
          console.log('[sync-daemon] keepalive: RH SSO auto-login succeeded')
        } else {
          throw new Error(`RH SSO session expired — needs password/MFA (URL: ${rhPage.url()})`)
        }
      } else {
        throw new Error(`RH SSO session expired — unexpected URL: ${rhPage.url()}`)
      }
    } finally {
      await rhPage.close().catch(() => {})
    }

    console.log('[sync-daemon] keepalive: OK (Tableau viz + SF home + RH SSO all verified)')
  } finally {
    // #497 AC-4: Only wait for VNC observation on success — skip delay when keepalive failed
    if (succeeded) {
      console.log('[sync-daemon] keepalive: holding page open for 15s (VNC observation)…')
      await new Promise(resolve => setTimeout(resolve, 15_000))
    } else {
      console.log('[sync-daemon] keepalive: skipping VNC delay (keepalive failed)')
    }
    // #497 AC-3: Wrap page.close() in 5s timeout — dead browsers can hang on close()
    await Promise.race([
      page.close().catch(() => {}),
      new Promise<void>(r => setTimeout(r, 5_000)),
    ])
  }
}

// ── BKL-SYNC-CHROME-LEAK Layer 4: Proactive browser recycle ─────────────────

/**
 * Proactively recycle the browser: persist session state, close browser,
 * kill orphan Chrome processes, re-init context, and re-adopt sister scrapers.
 * Prevents Chrome memory bloat from accumulating over 48h+ uptime.
 */
async function proactiveRecycle(): Promise<void> {
  // #447 AC-1: Mutex guard — only one recycle runs at a time.
  // Second concurrent callers skip immediately with a log message.
  if (recycleRunning) {
    console.log('[sync-daemon] proactiveRecycle: SKIPPED — another recycle is already in progress')
    return
  }
  recycleRunning = true

  // #447 AC-5: Hard timeout — if recycle doesn't complete within 90s,
  // release the mutex and recommend container restart via alert email.
  const timeoutPromise = new Promise<'timeout'>(resolve =>
    setTimeout(() => resolve('timeout'), RECYCLE_TIMEOUT_MS)
  )

  const recycleWork = async (): Promise<'done'> => {
    console.log('[sync-daemon] proactiveRecycle: starting browser recycle…')
    const { closeScrapeContext, initScrapeContext: reinitCtx, getScrapeContext: getCtx } = await import('../src/rh-scraper.ts')
    const { closeSfContext } = await import('../src/sf-scraper.ts')

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
      throw new Error('proactiveRecycle: failed to re-init browser context')
    }

    // 6. Re-adopt sister scrapers (CCSP, SF) — all share the RH headed context
    adoptCcspContext(newCtx)
    adoptSfContext(newCtx, PROFILE_DIR)

    console.log('[sync-daemon] proactiveRecycle: browser recycled successfully')
    return 'done'
  }

  try {
    const result = await Promise.race([recycleWork(), timeoutPromise])
    if (result === 'timeout') {
      console.error(`[sync-daemon] proactiveRecycle: TIMED OUT after ${RECYCLE_TIMEOUT_MS / 1000}s — releasing mutex`)
      await sendBriefEmail(
        ALERT_EMAIL,
        `ALERT: Sync Daemon Recycle Timeout — ${new Date().toISOString().slice(0, 10)}`,
        `<html><body>
          <h2>Browser Recycle Timed Out</h2>
          <p>proactiveRecycle() did not complete within ${RECYCLE_TIMEOUT_MS / 1000}s.</p>
          <p>The recycle mutex has been released but the browser state may be inconsistent.</p>
          <p><strong>Recommended action:</strong> restart the pai-sync-l3 container.</p>
          <pre>podman restart pai-sync-l3</pre>
        </body></html>`,
      ).catch(emailErr => console.error('[sync-daemon] recycle timeout alert email failed:', emailErr))
    }
  } catch (e: any) {
    console.error(`[sync-daemon] proactiveRecycle: failed: ${e?.message ?? e}`)
    throw e
  } finally {
    recycleRunning = false
  }
}

// ── Sync cycle ────────────────────────────────────────────────────────────────

const SYNC_STATUS_FILE = resolve(process.env.CACHE_DIR ?? '/data/cache', 'sync-cycle-status.json')

async function runSyncCycle(): Promise<void> {
  console.log('[sync-daemon] starting daily sync cycle…')

  // BKL-SYNC-CHROME-LEAK Layer 3: Pre-sync rendering health check.
  // If the browser can respond to IPC but can't render, recycle before syncing.
  const ctx = getScrapeContext()
  if (ctx) {
    const canRender = await canContextRender(ctx)
    if (!canRender) {
      // #447 AC-3: If a recycle is already in progress, wait up to 60s for it to finish,
      // then retry the render check. Only call proactiveRecycle() if no recycle is running.
      if (recycleRunning) {
        console.log('[sync-daemon] pre-sync render check FAILED but recycle already in progress — waiting up to 60s')
        const waitStart = Date.now()
        while (recycleRunning && Date.now() - waitStart < 60_000) {
          await new Promise(r => setTimeout(r, 2_000))
        }
        if (recycleRunning) {
          console.error('[sync-daemon] pre-sync: recycle still running after 60s — skipping sync cycle')
          return
        }
        // Retry render check after recycle completed
        const retryCtx = getScrapeContext()
        if (retryCtx) {
          const canRenderRetry = await canContextRender(retryCtx)
          if (!canRenderRetry) {
            console.error('[sync-daemon] pre-sync render check still FAILED after recycle — calling proactiveRecycle()')
            try {
              await proactiveRecycle()
            } catch (recycleErr: any) {
              console.error('[sync-daemon] pre-sync recycle FAILED — skipping sync cycle:', recycleErr?.message ?? recycleErr)
              return
            }
          } else {
            console.log('[sync-daemon] pre-sync render check passed after waiting for recycle')
          }
        }
      } else {
        console.warn('[sync-daemon] pre-sync render check FAILED — recycling browser before sync')
        try {
          await proactiveRecycle()
        } catch (recycleErr: any) {
          console.error('[sync-daemon] pre-sync recycle FAILED — skipping sync cycle, will retry next cycle:', recycleErr?.message ?? recycleErr)
          return
        }
      }
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
    writeFileSync(SYNC_STATUS_FILE, JSON.stringify({
      lastRun: new Date().toISOString(),
      status: errorCount > 0 ? 'partial' : 'ok',
      errors: errorCount,
      totalPods: result.results.length,
    }))
  } catch (e: any) {
    console.error('[sync-daemon] sync cycle threw unexpectedly:', e.message)
    writeFileSync(SYNC_STATUS_FILE, JSON.stringify({
      lastRun: new Date().toISOString(),
      status: 'failed',
      error: e.message,
    }))
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

  // SF adopts the RH headed context — no separate Chrome launch
  const rhCtx = getScrapeContext()
  if (rhCtx) {
    adoptSfContext(rhCtx, PROFILE_DIR)
    console.log('[sync-daemon] SF context adopted from RH')
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
  const KEEPALIVE_STATUS_FILE = `${CACHE_DIR}/keepalive-status.json`
  let keepaliveRunning = false
  // AC-1/AC-5: Track keepalive state for sync-on-auth trigger.
  // Initialized to true so the first successful keepalive after daemon start
  // does NOT falsely trigger a sync (only recovery from failure triggers sync).
  let lastKeepaliveOk = true
  setInterval(async () => {
    if (keepaliveRunning) {
      console.log('[sync-daemon] keepalive skipped — previous keepalive still running')
      return
    }
    keepaliveRunning = true
    try {
      // #497 AC-1: Wrap doKeepalive() in Promise.race with hard timeout.
      // When the browser is dead, ctx.newPage() or page.close() can hang forever —
      // the await never settles, so the finally block never fires and keepaliveRunning
      // stays true forever. This pattern matches proactiveRecycle() (lines 351-423).
      const keepaliveTimeout = new Promise<'timeout'>(resolve =>
        setTimeout(() => resolve('timeout'), KEEPALIVE_TIMEOUT_MS)
      )
      const result = await Promise.race([
        doKeepalive().then(() => 'done' as const),
        keepaliveTimeout,
      ])
      if (result === 'timeout') {
        // #497 AC-2: Timeout fired — browser is likely dead/unresponsive
        throw new Error(`keepalive timed out after ${KEEPALIVE_TIMEOUT_MS / 1000}s — browser may be dead`)
      }
      // AC-2/AC-3: If previous keepalive failed, auth was restored (likely via VNC re-auth).
      // Write the sync trigger file to kick off an immediate sync.
      if (!lastKeepaliveOk) {
        console.log("[sync-daemon] auth restored — triggering immediate sync")
        writeFileSync(TRIGGER_FILE, new Date().toISOString())
      }
      // AC-4: Mark keepalive as healthy
      lastKeepaliveOk = true
      console.log('[sync-daemon] keepalive OK')
      writeFileSync(KEEPALIVE_STATUS_FILE, JSON.stringify({
        lastRun: new Date().toISOString(),
        status: 'ok',
        intervalMs: KEEPALIVE_INTERVAL_MS,
        nextExpected: new Date(Date.now() + KEEPALIVE_INTERVAL_MS).toISOString(),
      }))
    } catch (e: any) {
      // AC-4: Mark keepalive as failed so next success triggers sync
      lastKeepaliveOk = false
      console.error('[sync-daemon] keepalive FAILED:', e.message)
      writeFileSync(KEEPALIVE_STATUS_FILE, JSON.stringify({
        lastRun: new Date().toISOString(),
        status: 'failed',
        error: e.message,
        intervalMs: KEEPALIVE_INTERVAL_MS,
        nextExpected: new Date(Date.now() + KEEPALIVE_INTERVAL_MS).toISOString(),
      }))
      try {
        await sendBriefEmail(
          ALERT_EMAIL,
          `L3 Sync Daemon - Keepalive Failed ${new Date().toISOString().slice(0, 10)}`,
          `<html><body><p>The SSO keepalive failed — sessions may expire before the next sync.</p><pre>${e.message}</pre></body></html>`,
        )
      } catch (emailErr: any) {
        console.error('[sync-daemon] keepalive alert email failed:', emailErr.message)
      }
    } finally {
      keepaliveRunning = false
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
    if (keepaliveRunning) {
      console.log('[sync-daemon] keepalive trigger fired but keepalive already running — discarding')
      return
    }
    keepaliveRunning = true
    console.log('[sync-daemon] keepalive trigger file detected — running immediate keepalive')
    try {
      await doKeepalive()
      console.log('[sync-daemon] keepalive trigger: OK')
      writeFileSync(KEEPALIVE_STATUS_FILE, JSON.stringify({
        lastRun: new Date().toISOString(),
        status: 'ok',
        source: 'trigger',
        intervalMs: KEEPALIVE_INTERVAL_MS,
        nextExpected: new Date(Date.now() + KEEPALIVE_INTERVAL_MS).toISOString(),
      }))
    } catch (e: any) {
      console.error('[sync-daemon] keepalive trigger: FAILED —', e.message)
      writeFileSync(KEEPALIVE_STATUS_FILE, JSON.stringify({
        lastRun: new Date().toISOString(),
        status: 'failed',
        source: 'trigger',
        error: e.message,
        intervalMs: KEEPALIVE_INTERVAL_MS,
        nextExpected: new Date(Date.now() + KEEPALIVE_INTERVAL_MS).toISOString(),
      }))
    } finally {
      keepaliveRunning = false
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
      const result = await scrapeSalesHub()
      const { products, knowledge } = result
      console.log(`[sync-daemon] saleshub scrape complete — ${products.length} products, ${knowledge.tdps.length} TDPs, ${knowledge.tactics.length} tactics, ${knowledge.salesPlays.length} plays`)
      const driveResult = await syncSalesHubToDrive()
      console.log(`[sync-daemon] saleshub Drive sync — ${driveResult.uploaded} files, ${driveResult.shortcuts} shortcuts`)
      const enrichResult = enrichSolutionPlays()
      console.log(`[sync-daemon] saleshub enrichment — ${enrichResult.enriched}/${enrichResult.total} plays enriched`)
      await sendBriefEmail(
        ALERT_EMAIL,
        `SalesHub Sync Complete — ${new Date().toISOString().slice(0, 10)}`,
        `<html><body>
          <h2>SalesHub Scrape + Drive Sync Complete</h2>
          <h3>Knowledge Base Stats</h3>
          <p><strong>Products scraped:</strong> ${products.length}</p>
          <p><strong>TDPs extracted:</strong> ${knowledge.tdps.length}</p>
          <p><strong>Sales Tactics extracted:</strong> ${knowledge.tactics.length}</p>
          <p><strong>Sales Plays extracted:</strong> ${knowledge.salesPlays.length}</p>
          <h3>Drive Sync</h3>
          <p><strong>Files uploaded to Drive:</strong> ${driveResult.uploaded}</p>
          <p><strong>Google Drive shortcuts created:</strong> ${driveResult.shortcuts}</p>
          <h3>Enrichment</h3>
          <p><strong>Solution plays enriched:</strong> ${enrichResult.enriched}/${enrichResult.total}</p>
          <p>Knowledge base saved to <code>/data/cache/saleshub/saleshub-knowledge.json</code> and synced to the SalesHub folder in Drive.</p>
        </body></html>`,
      ).catch(emailErr => console.warn('[sync-daemon] saleshub success email failed:', emailErr.message))
    } catch (e: any) {
      console.error('[sync-daemon] saleshub scrape failed:', e.message)
      await sendBriefEmail(
        ALERT_EMAIL,
        `ALERT: SalesHub Sync Failed — ${new Date().toISOString().slice(0, 10)}`,
        `<html><body>
          <h2>SalesHub Scrape Failed</h2>
          <p><strong>Error:</strong> ${e?.message ?? e}</p>
          <p>Check daemon logs: <code>make sync-logs</code></p>
        </body></html>`,
      ).catch(emailErr => console.warn('[sync-daemon] saleshub failure email failed:', emailErr.message))
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
