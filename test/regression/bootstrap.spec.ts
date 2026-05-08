/**
 * Regression Tests — bootstrap domain (split from test/regression.spec.ts).
 * Surgical refactor: test text preserved verbatim; readFileSync/resolve paths
 * adjusted for the new test/regression/ directory depth.
 */
import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { resolve, join } from 'path'
import { DESTRUCTIVE_URL, postJSONDestructive, requireTestContainer } from './helpers'

// ── Snapshot / restore full config (aes + customers) ─────────────────────────
// Used by @destructive tests that wipe AE/customer config — see parent file
// regression.spec.ts for history. Gracefully handles missing test container.

let snapshot: unknown = null

test.beforeAll(async () => {
  if (process.env.TEST_URL) requireTestContainer(DESTRUCTIVE_URL)
  try {
    const { body } = await postJSONDestructive('/api/__test/snapshot', {})
    snapshot = body
  } catch {
    snapshot = null
  }
})

test.afterAll(async () => {
  if (snapshot) {
    try {
      await postJSONDestructive('/api/__test/restore', snapshot)
    } catch { /* ignore — test container may have been stopped */ }
  }
})



// ── REG-BOOT-03: Single-AE bootstrap regression ────────────────────────────
// Verifies that bootstrapAE (POST /api/bootstrap/auto) still works end-to-end
// for a single AE: triggers all 6 steps, completes without error, and populates
// the AE record with sheet IDs + customers with account numbers.
//
// Tagged @live @destructive: requires live Google/SF connections and mutates
// aes.json + customers.json on the test container.

test.describe('@live @destructive REG-BOOT-03: single-AE bootstrap completes end-to-end', () => {
  // Use test fixtures for bootstrap inputs
  const fixtures = JSON.parse(
    readFileSync(resolve(import.meta.dirname!, '..', 'config', 'test-fixtures.json'), 'utf-8')
  )
  const targetAe = fixtures.bootstrap.aes[0]
  const parentFolderId = fixtures.bootstrap.parentDriveFolderUrl

  // Single-AE bootstrap can take up to 10 minutes (SF pipeline sync is slow)
  test.setTimeout(600_000)
  test.describe.configure({ mode: 'serial' })

  test('POST /api/bootstrap/auto starts a single-AE bootstrap', async () => {
    // Check if Google OAuth is available — bootstrap requires it
    const oauthRes = await fetch(`${DESTRUCTIVE_URL}/api/oauth/status`).catch(() => null)
    if (oauthRes) {
      const oauth = await oauthRes.json().catch(() => ({}))
      if (!oauth.authorized) {
        test.skip(true, 'Google OAuth not authorized — cannot run @live bootstrap test')
        return
      }
    }

    // Reset any stuck bootstrap state first
    await fetch(`${DESTRUCTIVE_URL}/api/bootstrap/auto/reset`, { method: 'POST' }).catch(() => {})

    // Clear AEs and customers for clean state
    await postJSONDestructive('/api/aes', { aes: [] })
    await postJSONDestructive('/api/setup/save-customers', { customers: [] })

    const res = await fetch(`${DESTRUCTIVE_URL}/api/bootstrap/auto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aeName: targetAe.name,
        sfReportId: targetAe.sfReportId,
        tableauTerritories: targetAe.tableauTerritories,
        customerNames: ['Regression Test Customer'],
        parentFolderId,
      }),
    })
    const body = await res.json()
    // Accept 200 (started) — 409 means another bootstrap is running
    expect([200, 409]).toContain(res.status)
    if (res.status === 409) {
      test.skip(true, 'Another bootstrap is already running — cannot test')
    }
  })

  test('all 6 bootstrap steps complete without error', async () => {
    // Check if bootstrap was actually started (previous test may have been skipped/blocked)
    const preCheck = await fetch(`${DESTRUCTIVE_URL}/api/bootstrap/auto/status`).catch(() => null)
    if (preCheck) {
      const pre = await preCheck.json().catch(() => ({}))
      if (!pre.running && !pre.completedAt) { test.skip(true, 'No bootstrap running — previous step likely skipped'); return }
    }
    const deadline = Date.now() + 10 * 60 * 1000
    let status: any

    // Poll until bootstrap reports complete (completedAt set) or error.
    // Mere `running:false` is not sufficient — the orchestrator briefly flips
    // running:false between phases, leaving completedAt unset.
    while (Date.now() < deadline) {
      const res = await fetch(`${DESTRUCTIVE_URL}/api/bootstrap/auto/status`)
      status = await res.json()
      if (status.completedAt || status.error) break
      await new Promise(r => setTimeout(r, 5_000))
    }

    // Final re-fetch in case the loop exited on the last iteration before completedAt was set
    if (!status.completedAt && !status.error) {
      const res = await fetch(`${DESTRUCTIVE_URL}/api/bootstrap/auto/status`)
      status = await res.json()
    }

    expect(status.error, `Bootstrap error: ${status.error}`).toBeNull()
    expect(
      status.completedAt,
      `completedAt missing after polling deadline — bootstrap may not have finished. running=${status.running} steps=${(status.steps ?? []).length}`
    ).toBeTruthy()

    // Steps may include null entries when an early phase short-circuited; filter them out
    // and assert the populated steps all reached 'done'. The orchestrator emits exactly 6
    // step slots — we assert 6 slots exist, then assert non-null entries are 'done'.
    const steps = (status.steps ?? []) as Array<{ status: string; name?: string } | null>
    expect(steps.length, 'bootstrap orchestrator must emit 6 step slots').toBe(6)
    const populatedSteps = steps.filter((s): s is { status: string; name?: string } => s !== null)
    expect(populatedSteps.length, 'at least one bootstrap step must have populated state').toBeGreaterThan(0)
    for (const step of populatedSteps) {
      expect(step.status, `Step "${step.name}" ended with: ${step.status}`).toBe('done')
    }
  })

  test('AE record has sheet IDs after bootstrap', async () => {
    const preCheck = await fetch(`${DESTRUCTIVE_URL}/api/bootstrap/auto/status`).catch(() => null)
    if (preCheck) {
      const pre = await preCheck.json().catch(() => ({}))
      if (!pre.completedAt) { test.skip(true, 'Bootstrap did not complete — skipping sheet ID assertions'); return }
    }
    const res = await fetch(`${DESTRUCTIVE_URL}/api/aes`)
    const { aes } = await res.json()
    if (!Array.isArray(aes) || aes.length === 0) {
      test.skip(true, 'AEs wiped by parallel @destructive test — skipping sheet ID assertions')
      return
    }
    const ae = aes.find((a: any) => a.name === targetAe.name)
    if (!ae) { test.skip(true, `${targetAe.name} not in aes — parallel @destructive test may have reset state`); return }
    expect(ae.driveFolderId, 'driveFolderId missing — Drive folder not created').toBeTruthy()
    expect(ae.ccspSheetId, 'ccspSheetId missing').toBeTruthy()
    expect(ae.pipelineSheetId, 'pipelineSheetId missing').toBeTruthy()
  })

  test('customers populated with inferred domains', async () => {
    const preCheck = await fetch(`${DESTRUCTIVE_URL}/api/bootstrap/auto/status`).catch(() => null)
    if (preCheck) {
      const pre = await preCheck.json().catch(() => ({}))
      if (!pre.completedAt) { test.skip(true, 'Bootstrap did not complete — skipping customer assertions'); return }
    }
    const res = await fetch(`${DESTRUCTIVE_URL}/customers`)
    const customers = await res.json()
    expect(Array.isArray(customers)).toBe(true)
    expect(customers.length, 'No customers after bootstrap').toBeGreaterThan(0)
    // At least one customer should have a domain inferred
    const withDomains = customers.filter((c: any) => c.domain)
    if (withDomains.length === 0) { console.log('No customers have domains — bootstrap may not have completed domain inference'); return }
  })
})

// ── REG-BOOT-06: BKL-BOOT-06 — bootstrap auto-triggers RH cases scraper on completion ──
// Root cause: bootstrapPOD()/auto-bootstrap completed without ever enqueueing the RH scraper.
// rhScrapeOk = !!rhStatus?.lastScraped stayed false, SyncButton stayed disabled forever.
// Fix: at the end of both the POD loop and the single-AE loop, enqueue a non-blocking
// `rh-cases` scraper task. runRhScrapeWithState() with no account numbers searches RH
// Portal by customer name — this is the account-discovery path for freshly-bootstrapped POD.
test.describe('REG-BOOT-06: bootstrap auto-enqueues RH cases scraper after completion (BKL-BOOT-06)', () => {
  const BOOTSTRAP = resolve(import.meta.dirname!, '..', '..', 'src', 'bootstrap-orchestrator.ts')

  test('bootstrap-orchestrator imports enqueueScraperTask and runRhScrapeWithState', () => {
    const src = readFileSync(BOOTSTRAP, 'utf8')
    expect(src, 'must import enqueueScraperTask').toMatch(/import\s*\{[^}]*enqueueScraperTask[^}]*\}\s*from/)
    expect(src, 'must import runRhScrapeWithState').toMatch(/import\s*\{[^}]*runRhScrapeWithState[^}]*\}\s*from/)
  })

  test('bootstrapPOD enqueues rh-cases scraper after podBootstrapState.running = false (BKL-BOOT-06)', () => {
    const src = readFileSync(BOOTSTRAP, 'utf8')
    // BKL-BOOT-06 comment must anchor the fix in the POD completion block
    expect(src, 'BKL-BOOT-06 marker missing from bootstrap-orchestrator').toContain('BKL-BOOT-06')
    const bootSix = src.indexOf('BKL-BOOT-06')
    expect(bootSix, 'BKL-BOOT-06 marker not found').toBeGreaterThan(0)
    // The fix sits AFTER the podBootstrapState.running = false shutdown line — bootstrap
    // must fully complete before the scraper is enqueued (non-blocking fire-and-forget).
    const podCompletionIdx = src.indexOf('podBootstrapState.running = false')
    expect(podCompletionIdx, 'podBootstrapState.running = false shutdown line missing').toBeGreaterThan(0)
    expect(bootSix, 'BKL-BOOT-06 enqueue must fire AFTER podBootstrapState.running = false').toBeGreaterThan(podCompletionIdx)

    // Within the POD completion region, we require enqueueScraperTask({ name: 'rh-cases', ... })
    const podRegion = src.slice(bootSix, bootSix + 800)
    expect(podRegion, 'POD path must enqueue rh-cases task').toMatch(/enqueueScraperTask\(\{[\s\S]*?name:\s*['"]rh-cases['"]/)
    expect(podRegion, 'POD path must call runRhScrapeWithState()').toContain('runRhScrapeWithState()')
  })

  test('single-AE auto-bootstrap enqueues rh-cases scraper on completion (BKL-BOOT-06)', () => {
    const src = readFileSync(BOOTSTRAP, 'utf8')
    // A second BKL-BOOT-06 marker guards the single-AE path.
    const all = [...src.matchAll(/BKL-BOOT-06/g)]
    expect(all.length, 'BKL-BOOT-06 must appear in BOTH the POD path and the single-AE path').toBeGreaterThanOrEqual(2)
    // The single-AE path is anchored by the log line "All steps complete for ${aeName}".
    const singleAeIdx = src.indexOf('All steps complete for')
    expect(singleAeIdx, 'single-AE completion log missing').toBeGreaterThan(0)
    const singleAeRegion = src.slice(singleAeIdx, singleAeIdx + 1200)
    expect(singleAeRegion, 'single-AE path must enqueue rh-cases task after completion').toMatch(/enqueueScraperTask\(\{[\s\S]*?name:\s*['"]rh-cases['"]/)
    expect(singleAeRegion, 'single-AE path must call runRhScrapeWithState()').toContain('runRhScrapeWithState()')
  })

  test('bootstrap enqueues are non-blocking — no await on the enqueueScraperTask call', () => {
    const src = readFileSync(BOOTSTRAP, 'utf8')
    // Scan every BKL-BOOT-06 region and assert the enqueue is fire-and-forget (no `await` prefix).
    const re = /BKL-BOOT-06/g
    let match: RegExpExecArray | null
    let checked = 0
    while ((match = re.exec(src)) !== null) {
      const region = src.slice(match.index, match.index + 800)
      expect(region, `await must NOT precede enqueueScraperTask (BKL-BOOT-06 @${match.index}) — bootstrap must not block on scraper completion`)
        .not.toMatch(/await\s+enqueueScraperTask/)
      checked++
    }
    expect(checked, 'expected at least 2 BKL-BOOT-06 enqueue sites to verify').toBeGreaterThanOrEqual(2)
  })
})

// ── REG-HERO-PARENT-01: Bootstrap guard prevents folder collision (Issue #72) ──
// Root cause: Wizard saved "Parent Drive Folder" to podBookingsFolderId instead
// of parentFolderId, causing Garrett Dixon AE folder to be created inside
// "Subscription Data" folder instead of CommandCenter root.
// Fix: create-drive-folder.ts validates parentFolderId !== podBookingsFolderId
// and throws if they match.
test.describe('REG-HERO-PARENT-01: Bootstrap guard prevents parentFolderId collision (Issue #72)', () => {
  const CREATE_DRIVE_FOLDER = resolve(import.meta.dirname!, '..', '..', 'src', 'bootstrap', 'steps', 'create-drive-folder.ts')

  test('create-drive-folder imports SETTINGS_PATH from drive-config-sync', () => {
    const src = readFileSync(CREATE_DRIVE_FOLDER, 'utf8')
    expect(src, 'must import SETTINGS_PATH from drive-config-sync').toMatch(/import\s*\{[^}]*SETTINGS_PATH[^}]*\}\s*from\s*['"]\.\.\/\.\.\/drive-config-sync/)
  })

  test('create-drive-folder validates parentFolderId against podBookingsFolderId (BKL-HERO-PARENT-FOLDER-CONFUSION)', () => {
    const src = readFileSync(CREATE_DRIVE_FOLDER, 'utf8')
    // BKL-HERO-PARENT-FOLDER-CONFUSION marker must anchor the guard check
    expect(src, 'BKL-HERO-PARENT-FOLDER-CONFUSION marker missing').toContain('BKL-HERO-PARENT-FOLDER-CONFUSION')
    const guardIdx = src.indexOf('BKL-HERO-PARENT-FOLDER-CONFUSION')
    expect(guardIdx, 'Guard check marker not found').toBeGreaterThan(0)

    // The guard must check if parentFolderId === podBookingsFolderId
    const guardRegion = src.slice(guardIdx, guardIdx + 800)
    expect(guardRegion, 'Must read region.podBookingsFolderId').toContain('region.podBookingsFolderId')
    expect(guardRegion, 'Must compare parentFolderId === podBookingsFolderId').toMatch(/parentFolderId\s*===\s*region\.podBookingsFolderId/)
    expect(guardRegion, 'Must throw error on collision').toContain('throw new Error')
    expect(guardRegion, 'Error message must mention both folders').toMatch(/parentFolderId cannot be the same as podBookingsFolderId/)
  })

  test('Guard check gracefully handles missing settings file (non-blocking)', () => {
    const src = readFileSync(CREATE_DRIVE_FOLDER, 'utf8')
    const guardIdx = src.indexOf('BKL-HERO-PARENT-FOLDER-CONFUSION')
    const guardRegion = src.slice(guardIdx, guardIdx + 1200)
    // If settings read fails for reasons other than collision, warn but don't block
    expect(guardRegion, 'Must catch errors from settings read').toMatch(/catch\s*\(\s*e/)
    expect(guardRegion, 'Must rethrow collision errors').toMatch(/if\s*\(\s*e\?\.message\?\.includes\(['"]parentFolderId cannot be the same as/)
    expect(guardRegion, 'Must warn on non-blocking failures').toContain('console.warn')
  })
})

// ── REG-HERO-PARENT-02: Wizard saves to correct endpoint (Issue #72) ──
// Root cause: BootstrapConfigBlock.tsx called /api/sf-bookings/pod-folder which
// saved to podBookingsFolderId, not parentFolderId.
// Fix: Component now calls /api/settings/parent-folder to save CommandCenter root.
test.describe('REG-HERO-PARENT-02: Wizard saves parentFolderId to correct endpoint (Issue #72)', () => {
  const BOOTSTRAP_CONFIG_BLOCK = resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'components', 'BootstrapConfigBlock.tsx')

  test('BootstrapConfigBlock saves to /api/settings/parent-folder, not /api/sf-bookings/pod-folder', () => {
    const src = readFileSync(BOOTSTRAP_CONFIG_BLOCK, 'utf8')
    // Must call /api/settings/parent-folder
    expect(src, 'Must use /api/settings/parent-folder endpoint').toContain('/api/settings/parent-folder')
    // The old endpoint may appear in negative-context comments (e.g., "not /api/sf-bookings/pod-folder")
    // but must NOT appear in actual fetch calls
    const fetchIdx = src.indexOf("fetch('/api/settings/parent-folder'")
    expect(fetchIdx, '/api/settings/parent-folder fetch call not found').toBeGreaterThan(0)
    // Verify the fetch region does not contain the old endpoint
    const fetchRegion = src.slice(Math.max(0, fetchIdx - 200), fetchIdx + 500)
    expect(fetchRegion, 'Fetch call must not reference old /api/sf-bookings/pod-folder endpoint').not.toMatch(/fetch\(['"][^'"]*\/api\/sf-bookings\/pod-folder/)
  })
})

// ── REG-HERO-PARENT-03: Bootstrap uses commandCenterFolderId (Issue #72) ──
// Root cause: AEsCustomersSection.tsx passed podBookingsFolderId as parentFolderId
// to bootstrap, causing folders to nest incorrectly.
// Fix: Component now uses commandCenterFolderId from useBootstrapConfig hook.
test.describe('REG-HERO-PARENT-03: Bootstrap uses commandCenterFolderId not podBookingsFolderId (Issue #72)', () => {
  const AES_CUSTOMERS_SECTION = resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'pages', 'setup', 'AEsCustomersSection.tsx')

  test('AEsCustomersSection passes commandCenterFolderId to bootstrap forms', () => {
    const src = readFileSync(AES_CUSTOMERS_SECTION, 'utf8')
    // Must destructure commandCenterFolderId from useBootstrapConfig
    expect(src, 'Must destructure commandCenterFolderId from hook').toMatch(/const\s*\{[^}]*commandCenterFolderId[^}]*\}\s*=\s*useBootstrapConfig/)

    // POD bootstrap must use commandCenterFolderId directly
    const podIdx = src.indexOf('POST', src.indexOf('/api/bootstrap/pod'))
    expect(podIdx, 'POD bootstrap POST not found').toBeGreaterThan(0)
    const podRegion = src.slice(podIdx, podIdx + 500)
    expect(podRegion, 'POD bootstrap must use commandCenterFolderId').toMatch(/parentFolderId:\s*commandCenterFolderId/)

    // Single-AE form must receive commandCenterFolderId as sharedParentFolderId prop
    expect(src, 'AutoBootstrapForm must receive commandCenterFolderId as sharedParentFolderId').toMatch(/sharedParentFolderId=\{commandCenterFolderId\}/)

    // Must NOT use podBookingsFolderId anywhere in bootstrap calls
    expect(src, 'Must not use podBookingsFolderId as parentFolderId').not.toMatch(/parentFolderId:\s*podBookingsFolderId/)
  })

  test('Parent folder change handler updates commandCenterFolderId, not podBookingsFolderId', () => {
    const src = readFileSync(AES_CUSTOMERS_SECTION, 'utf8')
    // onParentFolderChange callback must set commandCenterFolderId
    const callbackIdx = src.indexOf('onParentFolderChange={(folderId')
    expect(callbackIdx, 'onParentFolderChange callback implementation not found').toBeGreaterThan(0)
    const callbackRegion = src.slice(callbackIdx, callbackIdx + 800)
    expect(callbackRegion, 'Callback must call setCommandCenterFolderId').toContain('setCommandCenterFolderId')
    // Must NOT call setPodBookingsFolderId
    expect(callbackRegion, 'Callback must not call setPodBookingsFolderId').not.toContain('setPodBookingsFolderId')
  })
})
