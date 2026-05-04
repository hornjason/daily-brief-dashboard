/**
 * BKL-ARCH-09 — Auth route module.
 *
 * Extracts the 5 auth route handlers (3 RH + 2 SF) from server.ts into a
 * standalone module following the established initXRoutes(opts) +
 * createXRouter(): Hono factory pattern.
 *
 * Routes registered:
 *   GET    /api/auth/redhat/status       — RH session health, scrape state, login probe
 *   POST   /api/auth/redhat/start        — Launch headed browser for RH portal login
 *   DELETE /api/auth/redhat/session      — Cancel in-progress RH login
 *   POST   /api/auth/salesforce/start    — Launch headed browser for SF login (NODE_ROLE=primary only)
 *   DELETE /api/auth/salesforce/session  — Cancel in-progress SF login (NODE_ROLE=primary only)
 *
 * SF routes are gated by NODE_ROLE === 'primary' — hero installs (NODE_ROLE
 * unset) must not expose SF auth endpoints since L4 scraping is leader-only.
 *
 * Pure structural refactor — zero behavior changes from the in-server
 * versions, except probeTimestamps.rh became the module-local rhLastProbe
 * (probeTimestamps.sf was dead code and dropped).
 */
import { Hono } from 'hono'
import { getRhStatus, startLoginBrowser, cancelLoginBrowser } from './rh-auth.ts'
import { startSfLoginBrowser, cancelSfLoginBrowser } from './sf-auth.ts'
import { getConfiguredTransport } from './case-client.ts'
import { deriveConfidence, ConnectionHealthSchema } from './connection-health.ts'
import { liveProbe } from './utils.ts'
import { getScrapeContext, getLivePage } from './rh-scraper.ts'
import { runRhScrapeWithState, runSfSyncForAes, ccspInFlight, setCcspInFlight, setSfSyncLastError } from './scraper-manager.ts'
import { aes, customers, patchAe } from './server-state.ts'
import { runSupportableScrape, writeSubscriptionSheet, supportableScrapeRunning } from './supportable-scraper.ts'
import { runCcspScrape, writeCcspSheet, ccspScrapeRunning } from './ccsp-scraper.ts'
import { refreshSubscriptions, refreshCCSP } from './refresh-engine.ts'
import { enqueueScraperTask } from './background-scheduler.ts'
import type { SupportableCustomer } from './supportable-scraper.ts'
import { isPrimary } from './lib/node-role.ts'

// ── Module state ─────────────────────────────────────────────────────────────
let RH_SESSION_PATH = ''
let RH_PROFILE_DIR = ''
let RH_CASES_CACHE_PATH = ''
let SF_SESSION_PATH = ''

/** Module-level RH live-reachability probe timestamp — set by GET /api/auth/redhat/status. */
let rhLastProbe: string | null = null

export function initAuthRoutes(opts: {
  rhSessionPath: string
  rhProfileDir: string
  rhCasesCachePath: string
  sfSessionPath: string
}): void {
  RH_SESSION_PATH = opts.rhSessionPath
  RH_PROFILE_DIR = opts.rhProfileDir
  RH_CASES_CACHE_PATH = opts.rhCasesCachePath
  SF_SESSION_PATH = opts.sfSessionPath
}

export function createAuthRouter(): Hono {
  const r = new Hono()

  // GET /api/auth/redhat/status — Session health, scrape timestamps, login state
  r.get('/api/auth/redhat/status', async (c) => {
    // BKL-UX113: pass RH_CASES_CACHE_PATH so caseCount reads from cases.json —
    // keeps the RH Portal tile in sync with the popout (both now read the same
    // source of truth instead of diverging between module state and disk cache).
    const status = getRhStatus(RH_SESSION_PATH, RH_CASES_CACHE_PATH, RH_PROFILE_DIR)
    // hasSession requires both a session file AND a live browser context —
    // the file persists across restarts but the context must be active to scrape
    const liveReachable = await liveProbe('https://access.redhat.com/support/cases', 'rh')
    rhLastProbe = new Date().toISOString()
    // BKL-INFRA-03: Surface the configured transport so the onboarding pre-flight
    // can distinguish Bearer (no browser session required) from browser (requires
    // a live Chromium context + valid SSO cookie).
    const transport = getConfiguredTransport()
    // REG-CONN-03: When transport is 'bearer', sessionExpired reflects whether the
    // offline token is available — not whether the browser session/KEYCLOAK cookie
    // is alive. The auth pre-flight passes via bearer token; browser session state
    // is irrelevant and should not trigger "Session Expired" on the connections panel.
    const sessionExpiredForTransport = transport === 'bearer'
      ? !process.env.REDHAT_OFFLINE_TOKEN
      : status.sessionExpired
    const healthFields = ConnectionHealthSchema.parse({
      transport,
      lastProbe: rhLastProbe,
      degradedReason: null,
      confidence: deriveConfidence(rhLastProbe),
    })
    return c.json({
      ...status,
      hasSession: status.hasSession && getScrapeContext() !== null,
      sessionExpired: sessionExpiredForTransport,
      liveReachable,
      ...healthFields,
    })
  })

  // POST /api/auth/redhat/start — Launch headed browser for RH portal login
  r.post('/api/auth/redhat/start', async (c) => {
    try {
      await startLoginBrowser(RH_SESSION_PATH, RH_PROFILE_DIR, () => {
        // BKL-S12: Run pre-warm as async, then hide browser AFTER it completes or times out.
        // onComplete is fire-and-forget from rh-auth.ts — making it async is safe (caller doesn't await).
        ;(async () => {
          // Supportable pre-warm removed — SUPPORTABLE_DISABLED=true permanently.
          // Hide the VNC window immediately after RH Portal login.
          getLivePage()?.goto('about:blank').catch(() => {})
          console.log('[rh-auth] onComplete: enqueueing all scrapers after re-auth')
          enqueueScraperTask({
            name: 'rh-cases',
            run: () => runRhScrapeWithState(),
            source: 'manual',
            enqueuedAt: Date.now(),
          })
          if (isPrimary()) {
            const sfAes = aes.filter(a => a.sfReportId)
            if (sfAes.length) {
              enqueueScraperTask({
                name: 'sf-pipeline',
                run: async () => { await runSfSyncForAes(sfAes) },
                source: 'manual',
                enqueuedAt: Date.now(),
              })
            }
          }
          enqueueScraperTask({
            name: 'supportable',
            run: async () => {
              if (supportableScrapeRunning) { console.log('[rh-auth] supportable: busy — skipping'); return }
              for (const ae of aes) {
                const aeCustomers = customers.filter(cu => !cu.inactive && cu.ae === ae.name && cu.accountNumbers?.length)
                if (!aeCustomers.length) continue
                try {
                  const results = await runSupportableScrape(aeCustomers as SupportableCustomer[])
                  const sheetId = await writeSubscriptionSheet(results, ae.name, ae.driveFolderId, ae.subscriptionSheetId || undefined)
                  if (sheetId) patchAe(ae.name, { subscriptionSheetId: sheetId })
                } catch (e: any) {
                  console.warn(`[rh-auth:supportable] ${ae.name} failed:`, e?.message ?? e)
                }
              }
              await refreshSubscriptions().catch(() => {})
            },
            source: 'manual',
            enqueuedAt: Date.now(),
          })
          if (isPrimary()) {
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
          }
        })().catch((e: any) => console.error('[supportable] pre-warm block error:', e?.message ?? e))
      })
      return c.json({ started: true })
    } catch (e: any) {
      return c.json({ error: 'Login failed — check Red Hat Portal connection' }, 409)
    }
  })

  // DELETE /api/auth/redhat/session — Cancel in-progress login
  r.delete('/api/auth/redhat/session', async (c) => {
    await cancelLoginBrowser()
    return c.json({ cancelled: true })
  })

  // ── Salesforce login endpoints ────────────────────────────────────────────
  // BKL-SYNC-L3-02: SF login browser and scrape trigger are L4 operations.
  // Hero installs (NODE_ROLE unset) must not expose these endpoints.
  if (isPrimary()) {
    // POST /api/auth/salesforce/start — launch headed browser for SF login
    // The SSO button auto-clicks; the SAML flow completes without user interaction
    // as long as the RH SSO session is active in the profile.
    r.post('/api/auth/salesforce/start', async (c) => {
      // Guard: SF login depends on the RH SSO context being live. Without it,
      // launching SF login closes the (already absent) RH context for nothing
      // and leaves both connections broken until manual recovery.
      if (!getScrapeContext()) {
        return c.json({ error: 'No RH session — connect Red Hat Portal first' }, 400)
      }
      try {
        await startSfLoginBrowser(SF_SESSION_PATH, RH_PROFILE_DIR, () => {
          setSfSyncLastError(null)  // BKL-UX94: clear stale error so sessionExpired resets immediately after login
          // BKL-BOOT-SCRAPE-ORDER-01: SF auth completing only establishes the session.
          // Data sync is driven by bootstrap, not auth — do not add scraping here.
          // Previously this fired runSfSyncForAes() which kicked off a heavy Lightning
          // report scrape concurrent with bootstrap CCSP, crashing the shared Chromium.
          console.log('[sf-auth] session established — data sync deferred to bootstrap/scheduler')
        })
        return c.json({ started: true })
      } catch (e: any) {
        return c.json({ error: 'Login failed — check Salesforce connection' }, 409)
      }
    })

    // DELETE /api/auth/salesforce/session — cancel in-progress login
    r.delete('/api/auth/salesforce/session', async (c) => {
      await cancelSfLoginBrowser(RH_PROFILE_DIR)
      return c.json({ cancelled: true })
    })
  }

  return r
}
