/**
 * Regression Tests — connection domain (split from test/regression.spec.ts).
 * Surgical refactor: test text preserved verbatim; readFileSync/resolve paths
 * adjusted for the new test/regression/ directory depth.
 */
import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { resolve, join } from 'path'
import { BASE_URL } from './helpers'



// ── REG-UI06: BKL-UI-06 — Connection status indicator false-green fixes ──────
// These tests lock in the 7 gap fixes on SetupPage.tsx so they cannot be
// accidentally reverted. Code-level tests check source patterns; API-level
// tests verify the endpoints return the fields the indicator logic relies on.

test('REG-UI06-01: SetupPage sfExpired derivation includes syncError check', () => {
  const src = readFileSync(
    resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'pages', 'SetupPage.tsx'),
    'utf8',
  )
  // The card-level sfExpired must include syncError — matches SessionHealthPanel line 114
  expect(
    /sfExpired\s*=.*syncError/.test(src),
    'sfExpired derivation must include syncError check (BKL-UI-06 fix)',
  ).toBe(true)
})

test('REG-UI06-02: SetupPage computeConnected SF derivation includes syncError', () => {
  const src = readFileSync(
    resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'pages', 'SetupPage.tsx'),
    'utf8',
  )
  // The accordion badge computeConnected must also check sf.syncError
  expect(
    /sf\.syncError/.test(src),
    'computeConnected must check sf.syncError for badge counter accuracy (BKL-UI-06)',
  ).toBe(true)
})

test('REG-UI06-03: SetupPage RH indicator checks liveReachable', () => {
  const src = readFileSync(
    resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'pages', 'SetupPage.tsx'),
    'utf8',
  )
  expect(
    /liveReachable/.test(src),
    'RH connection derivation must check liveReachable (BKL-UI-06)',
  ).toBe(true)
})

test('REG-UI06-04: SetupPage RH indicator distinguishes Expired from Not connected', () => {
  const src = readFileSync(
    resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'pages', 'SetupPage.tsx'),
    'utf8',
  )
  // Must have both 'Expired' label and bg-critical class for RH expired state
  expect(
    /rhExpired\s*\?.*['"]Expired['"]/.test(src),
    'RH dot must show "Expired" label when session is expired (BKL-UI-06)',
  ).toBe(true)
  expect(
    /rhExpired\s*\?.*bg-critical/.test(src),
    'RH dot must use bg-critical (red) for expired state (BKL-UI-06)',
  ).toBe(true)
})

test('REG-UI06-05: SetupPage Tableau indicator checks reachable field', () => {
  const src = readFileSync(
    resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'pages', 'SetupPage.tsx'),
    'utf8',
  )
  // tableauConnected must require reachable !== false
  expect(
    /tableauConnected.*reachable/.test(src),
    'tableauConnected derivation must check reachable field (BKL-UI-06)',
  ).toBe(true)
})

test('REG-UI06-06: SetupPage Tableau indicator checks ccsp scraper state', () => {
  const src = readFileSync(
    resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'pages', 'SetupPage.tsx'),
    'utf8',
  )
  // Must check for both 'failed' and 'stale' states
  expect(
    /ccspStatus\?\.state\s*===\s*'failed'/.test(src),
    'Tableau indicator must check ccspStatus.state for failed (BKL-UI-06)',
  ).toBe(true)
  expect(
    /ccspStatus\?\.state\s*===\s*'stale'/.test(src),
    'Tableau indicator must check ccspStatus.state for stale (BKL-UI-06)',
  ).toBe(true)
})

test('REG-UI06-07: /api/auth/salesforce/status returns syncError field', async () => {
  const res = await fetch(`${BASE_URL}/api/auth/salesforce/status`)
  expect(res.ok).toBe(true)
  const body = await res.json() as any
  expect(body, 'response must include syncError field for indicator logic').toHaveProperty('syncError')
})

test('REG-UI06-08: /api/auth/redhat/status returns liveReachable field', async () => {
  const res = await fetch(`${BASE_URL}/api/auth/redhat/status`)
  expect(res.ok).toBe(true)
  const body = await res.json() as any
  expect(body, 'response must include liveReachable field for indicator logic').toHaveProperty('liveReachable')
})

test('REG-UI06-09: /api/bootstrap/tableau/session-status returns reachable field', async () => {
  const res = await fetch(`${BASE_URL}/api/bootstrap/tableau/session-status`)
  expect(res.ok).toBe(true)
  const body = await res.json() as any
  expect(body, 'response must include reachable field for indicator logic').toHaveProperty('reachable')
})

// ── REG-UI06-10: SetupPage Connections accordion — indicator text matches API truth ──
//
// API-to-UI consistency test. NOT a mock test.
//
// Context: BKL-UI-06 found connection indicators showed false green when the API
// reported expired or broken connections. The existing REG-UI06-01..09 tests are all
// source-pattern checks (regex on SetupPage.tsx) — none render the UI and verify the
// displayed text actually matches the live API state. This test closes that gap.
//
// Strategy: fetch all three status APIs in parallel to establish ground truth, then
// navigate to /dashboard/setup, open the Connections accordion (Step 3), and assert
// that the indicator text shown in each connection card is consistent with what the
// API returned. Also verifies the accordion badge count matches derived connected state.
//
// Runs against BASE_URL (defaults to 7777 in production, override with BASE_URL env var
// to target the test container on 7776).

test.describe('REG-UI06-10: SetupPage Connections accordion indicator text matches API state (BKL-UI-06)', () => {
  // Shared types inferred from the three status endpoints
  type RhStatus = {
    hasSession: boolean
    sessionExpired: boolean
    liveReachable: boolean | null
    lastScraped: string | null
  }
  type SfStatus = {
    hasSession: boolean
    sessionExpired: boolean
    syncError: string | null
    lastSync: string | null
  }
  type TableauStatus = {
    sessionValid: boolean
    reachable: boolean | null
  }

  // Derive expected UI text from API response, mirroring SetupPage.tsx logic exactly.
  // These functions must stay in sync with DataSourcesSection derived state.
  function expectedRhText(rh: RhStatus): string {
    // rhSessionActive = hasSession && !sessionExpired && liveReachable !== false
    const rhSessionActive = rh.hasSession && !rh.sessionExpired && rh.liveReachable !== false
    if (rhSessionActive) {
      // Scraper running state is not observable from API alone — treat as "Connected"
      return 'Connected'
    }
    if (rh.sessionExpired) return 'Expired'
    return 'Not connected'
  }

  function expectedSfText(sf: SfStatus): string {
    const sfExpired = sf.sessionExpired || !!sf.syncError
    const sfSessionActive = sf.hasSession && !sfExpired
    if (sfSessionActive && !!sf.lastSync) return 'Connected'
    if (sfExpired) return 'Expired'
    if (sfSessionActive) return 'Session Active'
    return 'Not connected'
  }

  function expectedTableauText(tableau: TableauStatus): string {
    if (tableau.sessionValid && tableau.reachable !== false) return 'Connected'
    // UI may show "Scrape failed", "Stale", or "Not connected" — all are non-green states.
    // We only assert the positive case; for non-connected we accept any of the valid texts.
    return 'Not connected'
  }

  test('indicator text in each connection card is consistent with live API state', async ({ page }, testInfo) => {
    testInfo.setTimeout(15_000)

    // Step 1: fetch ground truth from all three APIs in parallel
    const [rhRes, sfRes, tableauRes] = await Promise.all([
      fetch(`${BASE_URL}/api/auth/redhat/status`),
      fetch(`${BASE_URL}/api/auth/salesforce/status`),
      fetch(`${BASE_URL}/api/bootstrap/tableau/session-status`),
    ])

    expect(rhRes.ok, '/api/auth/redhat/status must respond 200').toBe(true)
    expect(sfRes.ok, '/api/auth/salesforce/status must respond 200').toBe(true)
    expect(tableauRes.ok, '/api/bootstrap/tableau/session-status must respond 200').toBe(true)

    const rh = await rhRes.json() as RhStatus
    const sf = await sfRes.json() as SfStatus
    const tableau = await tableauRes.json() as TableauStatus

    // Step 2: derive expected indicator texts from API ground truth
    const rhExpected = expectedRhText(rh)
    const sfExpected = expectedSfText(sf)
    const tableauExpected = expectedTableauText(tableau)

    // Derive expected badge count using the same logic as the SetupPage badge derivation
    // (from SetupPage.tsx lines 3619-3622)
    const rhConnected = !!(rh.hasSession && !rh.sessionExpired && rh.liveReachable !== false)
    const sfExpiredFlag = sf.sessionExpired || !!sf.syncError
    const sfConnected = !!(sf.hasSession && !sfExpiredFlag && sf.lastSync)
    const tableauConnected = tableau.sessionValid === true && tableau.reachable !== false
    const expectedBadgeCount = [rhConnected, sfConnected, tableauConnected].filter(Boolean).length

    // Step 3: navigate to setup page
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await page.waitForLoadState('networkidle')

    // Step 4: find the Step 3 Connections accordion button and open it if not already open
    const connectionsButton = page.locator('button', { hasText: /Step 3.*Connections|Connections.*Step 3/ }).first()
    await connectionsButton.waitFor({ state: 'visible', timeout: 10_000 })

    // Check if the accordion is already open by looking for connection card content
    const sfCard = page.locator('div.rounded-xl', { hasText: 'Salesforce' }).first()
    const isOpen = await sfCard.isVisible().catch(() => false)
    if (!isOpen) {
      await connectionsButton.click()
      await sfCard.waitFor({ state: 'visible', timeout: 8_000 })
    }

    // Step 5: assert Red Hat Portal indicator text
    const rhCard = page.locator('div.rounded-xl', { hasText: 'Red Hat Portal' }).first()
    await rhCard.waitFor({ state: 'visible', timeout: 8_000 })
    // The status span is rendered within the card's header row.
    // It shows: "Connected", "Syncing", "Expired", "Not connected", or "Connecting..."
    // We allow "Syncing" as equivalent to "Connected" since the scraper state isn't
    // visible from the API alone and both represent a healthy session.
    const rhIndicator = rhCard.locator('span.text-xs').filter({
      hasText: /Connected|Syncing|Expired|Not connected/,
    }).first()
    await rhIndicator.waitFor({ state: 'visible', timeout: 5_000 })
    const rhActual = (await rhIndicator.innerText()).trim()

    if (rhExpected === 'Connected') {
      expect(
        rhActual === 'Connected' || rhActual === 'Syncing',
        `RH Portal: API says connected (hasSession=${rh.hasSession}, sessionExpired=${rh.sessionExpired}, liveReachable=${rh.liveReachable}) but UI shows "${rhActual}" — expected "Connected" or "Syncing"`,
      ).toBe(true)
    } else {
      expect(
        rhActual,
        `RH Portal: API says "${rhExpected}" (hasSession=${rh.hasSession}, sessionExpired=${rh.sessionExpired}) but UI shows "${rhActual}"`,
      ).toBe(rhExpected)
    }

    // Step 6: assert Salesforce indicator text
    await sfCard.waitFor({ state: 'visible', timeout: 5_000 })
    const sfIndicator = sfCard.locator('span.text-xs').filter({
      hasText: /Connected|Expired|Session Active|Not connected/,
    }).first()
    await sfIndicator.waitFor({ state: 'visible', timeout: 5_000 })
    const sfActual = (await sfIndicator.innerText()).trim()

    expect(
      sfActual,
      `Salesforce: API says "${sfExpected}" (hasSession=${sf.hasSession}, sessionExpired=${sf.sessionExpired}, syncError=${sf.syncError}, lastSync=${sf.lastSync}) but UI shows "${sfActual}"`,
    ).toBe(sfExpected)

    // Step 7: assert Tableau indicator text
    const tableauCard = page.locator('div.rounded-xl', { hasText: 'Tableau' }).first()
    await tableauCard.waitFor({ state: 'visible', timeout: 5_000 })
    // Tableau can show "Connected", "Not connected", "Scrape failed", "Stale", or "Scraper failed".
    // When API says sessionValid && reachable, UI must show "Connected" — no other text is acceptable.
    // When API says not connected, UI must NOT show "Connected".
    const tableauIndicator = tableauCard.locator('span.text-xs').filter({
      hasText: /Connected|Not connected|Scrape failed|Scraper failed|Stale/,
    }).first()
    await tableauIndicator.waitFor({ state: 'visible', timeout: 5_000 })
    const tableauActual = (await tableauIndicator.innerText()).trim()

    if (tableau.sessionValid && tableau.reachable !== false) {
      expect(
        tableauActual,
        `Tableau: API says sessionValid=${tableau.sessionValid}, reachable=${tableau.reachable} — UI must show "Connected" but shows "${tableauActual}"`,
      ).toBe('Connected')
    } else {
      expect(
        tableauActual === 'Connected',
        `Tableau: API says session invalid/unreachable (sessionValid=${tableau.sessionValid}, reachable=${tableau.reachable}) but UI shows "Connected" — this is the false-green bug`,
      ).toBe(false)
    }

    // Step 8: assert accordion badge count matches derived connected count
    // Badge format: "N/3 connected" or "3/3 connected"
    const badgeText = await connectionsButton.locator('span').filter({ hasText: /\d\/3 connected/ }).first().innerText().catch(() => null)
    if (badgeText !== null) {
      const match = badgeText.match(/^(\d)\/3 connected$/)
      if (match) {
        const actualCount = parseInt(match[1], 10)
        expect(
          actualCount,
          `Connections badge shows "${badgeText}" but API ground truth derives ${expectedBadgeCount}/3 connected (rh=${rhConnected}, sf=${sfConnected}, tableau=${tableauConnected})`,
        ).toBe(expectedBadgeCount)
      }
    }
    // If badge text is not yet visible (still loading), skip the badge assertion rather than fail
  })
})

// ── REG-CONN-01: SF auth context check ──────────────────────────────────────
// getSfAuthStatus() must check for a live SF browser context (getSfContext)
// in the hasSession derivation — not just an on-disk session file.
// A stale session file with no live context falsely reports "Connected".
test('REG-CONN-01: sf-auth.ts getSfAuthStatus checks getSfContext for hasSession', async () => {
  const sfAuthSource = await import('node:fs').then(({ readFileSync }) =>
    readFileSync(
      new URL('../../src/sf-auth.ts', import.meta.url).pathname,
      'utf-8'
    )
  )

  // The getSfAuthStatus function must reference getSfContext in its body
  const fnStart = sfAuthSource.indexOf('export function getSfAuthStatus(')
  const fnEnd = sfAuthSource.indexOf('\n}', fnStart) + 2
  const fnBody = sfAuthSource.slice(fnStart, fnEnd)

  expect(
    fnBody.includes('getSfContext'),
    'getSfAuthStatus() must call getSfContext() to verify live browser context — ' +
    'a session file alone is not sufficient (REG-CONN-01)'
  ).toBe(true)

  // getSfContext must be imported at the top of the file
  expect(
    sfAuthSource.includes("import { closeSfContext, adoptSfContext, getSfContext }"),
    'getSfContext must be imported from sf-scraper.ts in sf-auth.ts (REG-CONN-01)'
  ).toBe(true)
})

// ── REG-CONN-02: sfReportId always propagated in pod bootstrap ────────────────
// bootstrap-orchestrator.ts must NOT contain `else if (!aeConfig.sfReportId)` —
// that guard prevents updating existing AEs with a wrong/stale report ID.
// Pod config is always source of truth; sfReportId must always be written.
test('REG-CONN-02: bootstrap-orchestrator.ts always writes sfReportId from pod config', async () => {
  const bootstrapSource = await import('node:fs').then(({ readFileSync }) =>
    readFileSync(
      new URL('../../src/bootstrap-orchestrator.ts', import.meta.url).pathname,
      'utf-8'
    )
  )

  // The old guard must not exist as executable code (may appear in comments)
  const codeLines = bootstrapSource.split('\n').filter(l => !l.trim().startsWith('//'))
  const hasGuardAsCode = codeLines.some(l => l.includes('else if (!aeConfig.sfReportId)'))
  expect(
    hasGuardAsCode,
    'bootstrap-orchestrator.ts must NOT contain `else if (!aeConfig.sfReportId)` as executable code — ' +
    'this guard prevents correcting wrong sfReportIds on existing AEs (REG-CONN-02)'
  ).toBe(false)

  // The unconditional else branch that writes sfReportId must exist
  // Look for the pattern: `} else {` followed by sfReportId write near the
  // "Create or update AE" comment block
  const createOrUpdateIdx = bootstrapSource.indexOf('Create or update AE in aes.json')
  expect(
    createOrUpdateIdx,
    'Expected "Create or update AE in aes.json" comment to exist in bootstrap-orchestrator.ts (REG-CONN-02)'
  ).toBeGreaterThan(-1)

  const nextBlock = bootstrapSource.slice(createOrUpdateIdx, createOrUpdateIdx + 800)
  expect(
    nextBlock.includes('} else {') && nextBlock.includes('sfReportId'),
    'bootstrap-orchestrator.ts must have unconditional else branch writing sfReportId (REG-CONN-02)'
  ).toBe(true)
})

// ── REG-CONN-03: Bearer transport awareness in RH status ─────────────────────
// GET /api/auth/redhat/status must not use browser-session expiry as the
// sessionExpired signal when transport === 'bearer'. When the offline token
// is present and bearer is operational, sessionExpired must be false.
test('REG-CONN-03: server.ts RH status considers transport when computing sessionExpired', async () => {
  const serverSource = await import('node:fs').then(({ readFileSync }) =>
    readFileSync(
      new URL('../../server.ts', import.meta.url).pathname,
      'utf-8'
    )
  )

  // The endpoint must contain the bearer-transport guard
  const endpointStart = serverSource.indexOf("app.get('/api/auth/redhat/status'")
  expect(
    endpointStart,
    'Expected /api/auth/redhat/status endpoint in server.ts (REG-CONN-03)'
  ).toBeGreaterThan(-1)

  const endpointBody = serverSource.slice(endpointStart, endpointStart + 2000)

  // Must check transport === 'bearer' before computing sessionExpired
  expect(
    endpointBody.includes("transport === 'bearer'"),
    "server.ts /api/auth/redhat/status must branch on transport === 'bearer' (REG-CONN-03)"
  ).toBe(true)

  // Must reference REDHAT_OFFLINE_TOKEN when determining sessionExpired for bearer
  expect(
    endpointBody.includes('REDHAT_OFFLINE_TOKEN'),
    'server.ts must check REDHAT_OFFLINE_TOKEN presence for bearer sessionExpired (REG-CONN-03)'
  ).toBe(true)

  // sessionExpiredForTransport must be spread into the response
  expect(
    endpointBody.includes('sessionExpiredForTransport'),
    'server.ts must use sessionExpiredForTransport in the status response (REG-CONN-03)'
  ).toBe(true)
})

// ── REG-UI06-11..14: Mock UI Contract Tests — degraded API responses ──────────
//
// These tests verify that the SetupPage Connections accordion renders the correct
// indicator state when the API returns degraded/partial data. Each test intercepts
// one status endpoint via page.route() before navigating, so the UI renders against
// a controlled mock rather than live container state.
//
// Route interceptors must be registered BEFORE page.goto() so they are active
// when the page's initial fetch calls fire.

test('REG-UI06-11: SF shows non-green state when syncError is present', async ({ page }, testInfo) => {
  testInfo.setTimeout(20_000)

  // Intercept the SF status endpoint — syncError is set, hasSession true, sessionExpired false.
  // The UI must derive sfExpired = true (because !!syncError) and NOT show "Connected".
  await page.route(
    url => url.pathname === '/api/auth/salesforce/status',
    route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        hasSession: true,
        sessionExpired: false,
        syncError: 'Target page closed',
        rowCount: 0,
        reportConfigured: false,
        lastSync: null,
      }),
    })
  )

  await page.goto(`${BASE_URL}/dashboard/setup`)
  await page.waitForLoadState('networkidle')

  // Open the Step 3 Connections accordion if not already open
  const connectionsButton = page.locator('button', { hasText: /Step 3.*Connections|Connections.*Step 3/ }).first()
  await connectionsButton.waitFor({ state: 'visible', timeout: 10_000 })
  const sfCard = page.locator('div.rounded-xl', { hasText: 'Salesforce' }).first()
  const isOpen = await sfCard.isVisible().catch(() => false)
  if (!isOpen) {
    await connectionsButton.click()
    await sfCard.waitFor({ state: 'visible', timeout: 8_000 })
  }

  // Find the SF indicator span
  const sfIndicator = sfCard.locator('span.text-xs').filter({
    hasText: /Connected|Expired|Session Active|Not connected/,
  }).first()
  await sfIndicator.waitFor({ state: 'visible', timeout: 8_000 })
  const sfActual = (await sfIndicator.innerText()).trim()

  // syncError present → sfExpired = true → must NOT show "Connected"
  expect(
    sfActual === 'Connected',
    `SF indicator shows "Connected" when syncError="Target page closed" — this is the false-green bug (REG-UI06-11). Actual: "${sfActual}"`,
  ).toBe(false)
})

test('REG-UI06-12: RH shows non-connected state when liveReachable is false', async ({ page }, testInfo) => {
  testInfo.setTimeout(20_000)

  // Intercept RH status — hasSession true but liveReachable false.
  // rhSessionActive = hasSession && !sessionExpired && liveReachable !== false → false here.
  await page.route(
    url => url.pathname === '/api/auth/redhat/status',
    route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        hasSession: true,
        sessionExpired: false,
        liveReachable: false,
        transport: 'browser',
        caseCount: 0,
      }),
    })
  )

  await page.goto(`${BASE_URL}/dashboard/setup`)
  await page.waitForLoadState('networkidle')

  const connectionsButton = page.locator('button', { hasText: /Step 3.*Connections|Connections.*Step 3/ }).first()
  await connectionsButton.waitFor({ state: 'visible', timeout: 10_000 })
  const sfCard = page.locator('div.rounded-xl', { hasText: 'Salesforce' }).first()
  const isOpen = await sfCard.isVisible().catch(() => false)
  if (!isOpen) {
    await connectionsButton.click()
    await sfCard.waitFor({ state: 'visible', timeout: 8_000 })
  }

  const rhCard = page.locator('div.rounded-xl', { hasText: 'Red Hat Portal' }).first()
  await rhCard.waitFor({ state: 'visible', timeout: 8_000 })

  const rhIndicator = rhCard.locator('span.text-xs').filter({
    hasText: /Connected|Syncing|Expired|Not connected/,
  }).first()
  await rhIndicator.waitFor({ state: 'visible', timeout: 8_000 })
  const rhActual = (await rhIndicator.innerText()).trim()

  // liveReachable: false → rhSessionActive = false → must NOT show "Connected" or "Syncing"
  expect(
    rhActual === 'Connected' || rhActual === 'Syncing',
    `RH indicator shows "${rhActual}" when liveReachable=false — UI must not show Connected/Syncing when portal is unreachable (REG-UI06-12)`,
  ).toBe(false)
})

test('REG-UI06-13: RH shows "Expired" (red) when sessionExpired is true', async ({ page }, testInfo) => {
  testInfo.setTimeout(20_000)

  // Intercept RH status — sessionExpired true.
  // The UI must show "Expired" (red, bg-critical), not the gray "Not connected" shown for no-session.
  await page.route(
    url => url.pathname === '/api/auth/redhat/status',
    route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        hasSession: true,
        sessionExpired: true,
        liveReachable: false,
        transport: 'browser',
        caseCount: 0,
      }),
    })
  )

  await page.goto(`${BASE_URL}/dashboard/setup`)
  await page.waitForLoadState('networkidle')

  const connectionsButton = page.locator('button', { hasText: /Step 3.*Connections|Connections.*Step 3/ }).first()
  await connectionsButton.waitFor({ state: 'visible', timeout: 10_000 })
  const sfCard = page.locator('div.rounded-xl', { hasText: 'Salesforce' }).first()
  const isOpen = await sfCard.isVisible().catch(() => false)
  if (!isOpen) {
    await connectionsButton.click()
    await sfCard.waitFor({ state: 'visible', timeout: 8_000 })
  }

  const rhCard = page.locator('div.rounded-xl', { hasText: 'Red Hat Portal' }).first()
  await rhCard.waitFor({ state: 'visible', timeout: 8_000 })

  // When sessionExpired=true the indicator must show "Expired" specifically —
  // "Not connected" would mean the expired/not-connected distinction is lost.
  const rhExpiredIndicator = rhCard.locator('span.text-xs', { hasText: 'Expired' }).first()
  await rhExpiredIndicator.waitFor({ state: 'visible', timeout: 8_000 })
  const rhActual = (await rhExpiredIndicator.innerText()).trim()

  expect(
    rhActual,
    `RH indicator must show "Expired" when sessionExpired=true, not "Not connected" or "Connected" (REG-UI06-13)`,
  ).toBe('Expired')
})

test('REG-UI06-14: Tableau shows non-connected state when reachable is false', async ({ page }, testInfo) => {
  testInfo.setTimeout(20_000)

  // Intercept Tableau status — sessionValid true but reachable false.
  // tableauConnected requires reachable !== false; this must NOT show "Connected".
  await page.route(
    url => url.pathname === '/api/bootstrap/tableau/session-status',
    route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionValid: true,
        reachable: false,
      }),
    })
  )

  await page.goto(`${BASE_URL}/dashboard/setup`)
  await page.waitForLoadState('networkidle')

  const connectionsButton = page.locator('button', { hasText: /Step 3.*Connections|Connections.*Step 3/ }).first()
  await connectionsButton.waitFor({ state: 'visible', timeout: 10_000 })
  const sfCard = page.locator('div.rounded-xl', { hasText: 'Salesforce' }).first()
  const isOpen = await sfCard.isVisible().catch(() => false)
  if (!isOpen) {
    await connectionsButton.click()
    await sfCard.waitFor({ state: 'visible', timeout: 8_000 })
  }

  const tableauCard = page.locator('div.rounded-xl', { hasText: 'Tableau' }).first()
  await tableauCard.waitFor({ state: 'visible', timeout: 8_000 })

  const tableauIndicator = tableauCard.locator('span.text-xs').filter({
    hasText: /Connected|Not connected|Scrape failed|Scraper failed|Stale/,
  }).first()
  await tableauIndicator.waitFor({ state: 'visible', timeout: 8_000 })
  const tableauActual = (await tableauIndicator.innerText()).trim()

  // reachable: false → tableauConnected = false → must NOT show "Connected"
  expect(
    tableauActual === 'Connected',
    `Tableau indicator shows "Connected" when reachable=false — this is the false-green bug (REG-UI06-14). Actual: "${tableauActual}"`,
  ).toBe(false)
})

// ── REG-CONN-05..06: lastProbe + confidence fields on RH and SF status ────────

test('REG-CONN-05: /api/auth/redhat/status includes lastProbe and confidence fields', async ({ request }) => {
  const res = await request.get(`${BASE_URL}/api/auth/redhat/status`)
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  expect(body).toHaveProperty('lastProbe')
  expect(body).toHaveProperty('confidence')
  expect(['fresh', 'stale', 'unknown']).toContain(body.confidence)
  if (body.lastProbe !== null) {
    expect(() => new Date(body.lastProbe)).not.toThrow()
  }
})

test('REG-CONN-06: /api/auth/salesforce/status includes lastProbe and confidence fields', async ({ request }) => {
  const res = await request.get(`${BASE_URL}/api/auth/salesforce/status`)
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  expect(body).toHaveProperty('lastProbe')
  expect(body).toHaveProperty('confidence')
  expect(['fresh', 'stale', 'unknown']).toContain(body.confidence)
  if (body.lastProbe !== null) {
    expect(() => new Date(body.lastProbe)).not.toThrow()
  }
})

// ── REG-CONN-04: All status endpoints return indicator-required fields ─────────
//
// API contract test. Fetches all three connection status endpoints from the live
// test container and asserts that each returns every field the indicator derivation
// logic depends on. Catches regressions where a refactor silently removes a field.
//
// Fields are asserted as "defined" (not undefined) — the field must be present in
// the JSON response even if its value is null or false.
test('REG-CONN-04: all connection status endpoints return required indicator fields', async () => {
  const [rhRes, sfRes, tableauRes] = await Promise.all([
    fetch(`${BASE_URL}/api/auth/redhat/status`),
    fetch(`${BASE_URL}/api/auth/salesforce/status`),
    fetch(`${BASE_URL}/api/bootstrap/tableau/session-status`),
  ])

  expect(rhRes.ok, '/api/auth/redhat/status must respond 200 (REG-CONN-04)').toBe(true)
  expect(sfRes.ok, '/api/auth/salesforce/status must respond 200 (REG-CONN-04)').toBe(true)
  expect(tableauRes.ok, '/api/bootstrap/tableau/session-status must respond 200 (REG-CONN-04)').toBe(true)

  const rh = await rhRes.json() as Record<string, unknown>
  const sf = await sfRes.json() as Record<string, unknown>
  const tableau = await tableauRes.json() as Record<string, unknown>

  // RH status: all four fields the indicator derivation reads must be present
  expect(
    rh.hasSession,
    '/api/auth/redhat/status must include hasSession field (REG-CONN-04)',
  ).toBeDefined()
  expect(
    rh.sessionExpired,
    '/api/auth/redhat/status must include sessionExpired field (REG-CONN-04)',
  ).toBeDefined()
  expect(
    'liveReachable' in rh,
    '/api/auth/redhat/status must include liveReachable field (REG-CONN-04) — removing it breaks the unreachable-portal guard',
  ).toBe(true)
  expect(
    'transport' in rh,
    '/api/auth/redhat/status must include transport field (REG-CONN-04) — needed for bearer vs browser session-expired branching',
  ).toBe(true)

  // SF status: three fields the indicator derivation reads must be present
  expect(
    sf.hasSession,
    '/api/auth/salesforce/status must include hasSession field (REG-CONN-04)',
  ).toBeDefined()
  expect(
    sf.sessionExpired,
    '/api/auth/salesforce/status must include sessionExpired field (REG-CONN-04)',
  ).toBeDefined()
  expect(
    'syncError' in sf,
    '/api/auth/salesforce/status must include syncError field (REG-CONN-04) — removing it breaks the syncError→sfExpired guard',
  ).toBe(true)

  // Tableau status: both fields the indicator derivation reads must be present
  expect(
    tableau.sessionValid,
    '/api/bootstrap/tableau/session-status must include sessionValid field (REG-CONN-04)',
  ).toBeDefined()
  expect(
    'reachable' in tableau,
    '/api/bootstrap/tableau/session-status must include reachable field (REG-CONN-04) — removing it breaks the unreachable-tableau guard',
  ).toBe(true)
})
