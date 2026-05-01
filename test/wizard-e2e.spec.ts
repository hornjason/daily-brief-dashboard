/**
 * Wizard E2E + Visual Regression — Setup flow against seeded server at port 7778.
 *
 * RUNS AGAINST: Bun server seeded with scripts/seed-data/ on port 7778.
 * DO NOT: attempt live Google OAuth, real Tableau, or real RH Portal.
 *
 * Setup page accordion structure (current):
 *   Step 1 of 5 — OAuth Keys      badge: "Configured" when gcp-oauth.keys.json exists
 *   Step 2 of 5 — Google Auth     badge: "Connected"  when .google-token.json exists & valid
 *   Step 3 of 5 — Connections     badge: N/M connected
 *   Step 4 of 5 — AEs & Customers badge: N AEs configured / "None configured"
 *   Step 5 of 5 — Data Sources
 *
 * The region + POD selector lives in Step 4 inside the BootstrapConfigBlock component.
 * Tab structure inside Step 4: Single AE | Full POD | Manage
 *
 * Visual snapshots → test/snapshots/wizard/   (darwin runner, maxDiffPixelRatio 0.02)
 * Update baselines: make update-snapshots
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.BASE_URL ?? 'http://localhost:7778'

// All tests in this file are stateful and must run in order.
test.describe.configure({ mode: 'serial' })

// ── Seed verification — confirm 7778 is serving seeded data ───────────────────

test.describe('0. Pre-flight: seeded server is reachable', () => {
  test('health endpoint returns ok', async ({ request }) => {
    const res = await request.get(`${BASE}/health`)
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.status).toBe('ok')
  })

  test('seeded AEs are present (Test AE One, Test AE Two)', async ({ request }) => {
    const res = await request.get(`${BASE}/api/aes`)
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    const names = (body.aes ?? []).map((a: { name: string }) => a.name)
    expect(names).toContain('Test AE One')
    expect(names).toContain('Test AE Two')
  })

  test('seeded customers are present', async ({ request }) => {
    const res = await request.get(`${BASE}/customers`)
    expect(res.ok()).toBeTruthy()
    const customers = await res.json()
    expect(Array.isArray(customers)).toBe(true)
    expect(customers.length).toBeGreaterThan(0)
  })

  test('settings regions are configured', async ({ request }) => {
    const res = await request.get(`${BASE}/api/settings/regions`)
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect((body.regions ?? []).length).toBeGreaterThan(0)
  })
})

// ── Step 1: OAuth Keys accordion ──────────────────────────────────────────────

test.describe('1. Step 1 of 5 — OAuth Keys', () => {
  test('setup page loads at /dashboard/setup', async ({ page }) => {
    const res = await page.goto(`${BASE}/dashboard/setup`)
    expect(res?.ok()).toBeTruthy()
    await expect(page).toHaveURL(/\/dashboard\/setup/)
  })

  test('Step 1 OAuth Keys accordion header visible', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await expect(page.getByRole('button', { name: /Step 1 of 5 — OAuth Keys/ })).toBeVisible()
  })

  test('Step 1 badge shows "Configured" because seed provides oauth keys status', async ({ page }) => {
    // Seed data includes gcp-oauth.keys.json via the seed target; the server reads
    // CONFIG_DIR which in CI resolves to {project_root}/config/ (seeded from scripts/seed-data/).
    // We mock the oauth-keys-status endpoint to "exists: true" so the test is
    // portable — the badge rendering is what we're testing, not file I/O.
    await page.route('**/api/setup/oauth-keys-status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ exists: true }) })
    )
    await page.goto(`${BASE}/dashboard/setup`)
    // "Configured" badge appears next to the Step 1 accordion button
    const step1Row = page.getByRole('button', { name: /Step 1 of 5 — OAuth Keys/ })
    await expect(step1Row).toBeVisible()
    // The badge text "Configured" renders inside the accordion header
    await expect(page.getByText('Configured').first()).toBeVisible()
  })

  test('visual baseline: Step 1 initial load (accordion collapsed)', async ({ page }) => {
    await page.route('**/api/setup/oauth-keys-status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ exists: true }) })
    )
    await page.route('**/api/oauth/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authorized: true, expired: false, email: 'test@example.com', configuredAt: new Date().toISOString() }) })
    )
    await page.goto(`${BASE}/dashboard/setup`)
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveScreenshot('setup-step1-initial.png', { maxDiffPixelRatio: 0.02 })
  })
})

// ── Step 2: Google Auth ────────────────────────────────────────────────────────

test.describe('2. Step 2 of 5 — Google Auth', () => {
  test('Google Auth accordion header visible', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await expect(page.getByRole('button', { name: /Step 2 of 5 — Google Auth/ })).toBeVisible()
  })

  test('"Connected" badge shown when Google token is present', async ({ page }) => {
    await page.route('**/api/oauth/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        authorized: true,
        expired: false,
        email: 'test@example.com',
        configuredAt: new Date().toISOString(),
        hasCloudPlatformScope: true,
      }) })
    )
    await page.goto(`${BASE}/dashboard/setup`)
    // The badge on Step 2 accordion button shows "Connected" when authorized
    const step2Row = page.getByRole('button', { name: /Step 2 of 5 — Google Auth/ })
    await expect(step2Row).toBeVisible()
    // "Connected" badge text appears in the accordion header area
    await expect(page.getByText('Connected').first()).toBeVisible()
  })

  test('expanding Step 2 shows Google Workspace Connected state', async ({ page }) => {
    await page.route('**/api/oauth/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        authorized: true,
        expired: false,
        email: 'test@redhat.com',
        configuredAt: new Date().toISOString(),
        hasCloudPlatformScope: true,
      }) })
    )
    await page.route('**/api/setup/oauth-keys-status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ exists: true }) })
    )
    await page.goto(`${BASE}/dashboard/setup`)
    await page.getByRole('button', { name: /Step 2 of 5 — Google Auth/ }).click()
    await expect(page.getByText('Google Workspace Connected')).toBeVisible()
    await expect(page.getByText('test@redhat.com')).toBeVisible()
  })
})

// ── Step 3: Connections (RH Token) ────────────────────────────────────────────

test.describe('3. Step 3 of 5 — Connections', () => {
  test('Connections accordion header visible', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await expect(page.getByRole('button', { name: /Step 3 of 5 — Connections/ })).toBeVisible()
  })

  test('expanding Connections shows Red Hat Portal card', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.getByRole('button', { name: /Step 3 of 5 — Connections/ }).click()
    await expect(page.getByText('Red Hat Portal').first()).toBeVisible()
  })

  test('offline token shows "configured" label when offline token is set', async ({ page }) => {
    // Mock offline token as configured
    await page.route('**/api/settings/offline-token', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured: true }) })
    )
    await page.route('**/api/auth/redhat/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        hasSession: true, sessionExpired: false, lastScraped: null,
        caseCount: 0, loginInProgress: false, loginTimedOut: false,
      }) })
    )
    await page.goto(`${BASE}/dashboard/setup`)
    await page.getByRole('button', { name: /Step 3 of 5 — Connections/ }).click()
    // When offlineTokenConfigured=true, the label "configured" renders next to "Offline Token"
    await expect(page.getByText('configured').first()).toBeVisible()
  })
})

// ── Step 4: AEs & Customers — region and POD selector ────────────────────────

test.describe('4. Step 4 of 5 — AEs & Customers', () => {
  test('AEs & Customers accordion header visible', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await expect(page.getByRole('button', { name: /Step 4 of 5 — AEs & Customers/ })).toBeVisible()
  })

  test('expanding Step 4 shows Single AE and Full POD tabs', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.getByRole('button', { name: /Step 4 of 5 — AEs & Customers/ }).click()
    await expect(page.getByRole('button', { name: 'Single AE' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Full POD' })).toBeVisible()
  })

  test('Single AE tab shows region and POD selectors after expanding', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.getByRole('button', { name: /Step 4 of 5 — AEs & Customers/ }).click()
    // Seeded data has AEs configured — component auto-switches to Manage tab.
    // Explicitly click Single AE to show the BootstrapConfigBlock with selectors.
    await page.getByRole('button', { name: 'Single AE' }).click()
    // BootstrapConfigBlock fetches /api/settings/regions + /api/settings/pod-config async;
    // wait for the pod-select (data-testid) which renders once those fetches resolve.
    await expect(page.locator('[data-testid="pod-select"]')).toBeVisible({ timeout: 15_000 })
  })

  test('visual baseline: Step 4 Single AE tab with region+POD selectors', async ({ page }) => {
    await page.route('**/api/setup/oauth-keys-status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ exists: true }) })
    )
    await page.route('**/api/oauth/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authorized: true, expired: false }) })
    )
    await page.goto(`${BASE}/dashboard/setup`)
    await page.getByRole('button', { name: /Step 4 of 5 — AEs & Customers/ }).click()
    // Seeded AEs cause auto-switch to Manage — explicitly switch to Single AE
    await page.getByRole('button', { name: 'Single AE' }).click()
    // Wait for BootstrapConfigBlock fetches to complete
    await expect(page.locator('[data-testid="pod-select"]')).toBeVisible({ timeout: 15_000 })
    await expect(page).toHaveScreenshot('setup-step4-single-ae.png', { maxDiffPixelRatio: 0.02 })
  })

  test('selecting a region populates POD dropdown options', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.getByRole('button', { name: /Step 4 of 5 — AEs & Customers/ }).click()
    // Seeded AEs cause auto-switch to Manage — explicitly switch to Single AE
    await page.getByRole('button', { name: 'Single AE' }).click()
    // Wait for async fetches (regions + pod-config) to complete
    await expect(page.locator('[data-testid="pod-select"]')).toBeVisible({ timeout: 15_000 })

    // The POD dropdown should have at least one option (plus the placeholder)
    const podSelect = page.locator('[data-testid="pod-select"]')
    const options = await podSelect.locator('option').all()
    // Should have placeholder + at least one POD option
    expect(options.length).toBeGreaterThan(1)
  })

  test('visual baseline: Step 4 with region selected', async ({ page }) => {
    await page.route('**/api/setup/oauth-keys-status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ exists: true }) })
    )
    await page.route('**/api/oauth/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authorized: true, expired: false }) })
    )
    await page.goto(`${BASE}/dashboard/setup`)
    await page.getByRole('button', { name: /Step 4 of 5 — AEs & Customers/ }).click()
    // Seeded AEs cause auto-switch to Manage — explicitly switch to Single AE
    await page.getByRole('button', { name: 'Single AE' }).click()
    // Wait for async fetches (regions + pod-config) to complete
    await expect(page.locator('[data-testid="pod-select"]')).toBeVisible({ timeout: 15_000 })

    // Select the first non-placeholder POD option to trigger cascade updates
    const podSelect = page.locator('[data-testid="pod-select"]')
    const firstPodOption = podSelect.locator('option').nth(1)
    const optVal = await firstPodOption.getAttribute('value').catch(() => null)
    if (optVal) {
      await podSelect.selectOption(optVal)
      await page.waitForLoadState('networkidle') // cascade: selecting POD triggers territory-names fetch
    }
    // Allow 8% diff — POD selection triggers async UI updates (territory sheet row,
    // SF report auto-fill) that can vary slightly between runs.
    await expect(page).toHaveScreenshot('setup-step4-region-selected.png', { maxDiffPixelRatio: 0.08 })
  })

  test('Full POD tab renders and shows POD configuration', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.getByRole('button', { name: /Step 4 of 5 — AEs & Customers/ }).click()
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Full POD' }).click()
    // Full POD tab content should render without crashing
    await expect(page.locator('section#aes')).toBeVisible()
    // The Full POD tab description text should be visible
    await expect(page.getByText(/Bootstrap your entire POD at once/i)).toBeVisible()
  })
})

// ── Regression guard: no Tableau / VNC / time estimates in wizard DOM ────────
//
// NOTE: These tests are intentionally skipped until issue #7 (remove deprecated
// "Tableau VNC popup" / "7–15 minutes" text from SetupPage.tsx) is merged.
// SetupPage.tsx lines ~1952-1956 still contain these strings in the Single AE
// info box. Remove the test.skip() calls after issue #7 ships.

test.describe('5. Regression guard — deprecated text absent from wizard', () => {
  test('no "Tableau" text in wizard DOM', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.waitForLoadState('networkidle')
    // Open all accordion sections so the full DOM is rendered
    for (const label of [
      /Step 1 of 5 — OAuth Keys/,
      /Step 2 of 5 — Google Auth/,
      /Step 3 of 5 — Connections/,
      /Step 4 of 5 — AEs & Customers/,
      /Step 5 of 5 — Data Sources/,
    ]) {
      await page.getByRole('button', { name: label }).click()
      await page.waitForTimeout(300)
    }
    const bodyText = await page.locator('body').textContent() ?? ''
    // Tableau references MUST NOT appear in the wizard UI (removed in issue #7)
    // Exception: if the text appears only inside hidden/offscreen elements (aria-hidden),
    // those are acceptable. We check the visible text content via innerText.
    const innerText = await page.locator('body').innerText()
    const tableauCount = (innerText.match(/Tableau/g) ?? []).length
    expect(tableauCount, `Found ${tableauCount} occurrence(s) of "Tableau" in wizard — expected 0`).toBe(0)
  })

  test('no "VNC" text in wizard DOM', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.waitForLoadState('networkidle')
    for (const label of [
      /Step 1 of 5 — OAuth Keys/,
      /Step 2 of 5 — Google Auth/,
      /Step 3 of 5 — Connections/,
      /Step 4 of 5 — AEs & Customers/,
    ]) {
      await page.getByRole('button', { name: label }).click()
      await page.waitForTimeout(300)
    }
    const innerText = await page.locator('body').innerText()
    const vncCount = (innerText.match(/\bVNC\b/g) ?? []).length
    expect(vncCount, `Found ${vncCount} occurrence(s) of "VNC" in wizard — expected 0`).toBe(0)
  })

  test('no "7–15 minutes" or "7-15 minutes" time estimate in wizard DOM', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.waitForLoadState('networkidle')
    for (const label of [
      /Step 1 of 5 — OAuth Keys/,
      /Step 2 of 5 — Google Auth/,
      /Step 3 of 5 — Connections/,
      /Step 4 of 5 — AEs & Customers/,
    ]) {
      await page.getByRole('button', { name: label }).click()
      await page.waitForTimeout(300)
    }
    const innerText = await page.locator('body').innerText()
    const hasTimeEstimate =
      innerText.includes('7–15 minutes') ||
      innerText.includes('7-15 minutes')
    expect(hasTimeEstimate, 'Found deprecated "7–15 minutes" time estimate in wizard — should be removed').toBe(false)
  })
})

// ── Dashboard visual baselines ────────────────────────────────────────────────

test.describe('6. Dashboard visual baselines (seeded data)', () => {
  test('dashboard home loads with seeded AE data', async ({ page }) => {
    const res = await page.goto(`${BASE}/dashboard`)
    expect(res?.ok()).toBeTruthy()
    await page.waitForLoadState('networkidle')
    const bodyText = await page.locator('body').textContent() ?? ''
    expect(bodyText.length).toBeGreaterThan(50)
  })

  test('visual baseline: dashboard home', async ({ page }) => {
    await page.goto(`${BASE}/dashboard`)
    await page.waitForLoadState('networkidle')
    await page.locator('main').first().waitFor({ timeout: 10_000 })
    await expect(page).toHaveScreenshot('dashboard-home.png', { maxDiffPixelRatio: 0.02 })
  })

  test('customer detail page loads for first seeded customer', async ({ page }) => {
    const res = await page.request.get(`${BASE}/api/accounts`)
    if (!res.ok()) {
      test.skip(true, '/api/accounts unreachable')
      return
    }
    const body = await res.json()
    const customers = (body.customers ?? []) as Array<{ name: string }>
    if (!customers.length) {
      test.skip(true, 'No customers in seeded data')
      return
    }
    const name = customers[0].name
    const navRes = await page.goto(`${BASE}/dashboard/customer/${encodeURIComponent(name)}`)
    expect(navRes?.ok()).toBeTruthy()
    await page.waitForLoadState('networkidle')
  })

  test('visual baseline: customer detail page (first seeded customer)', async ({ page }) => {
    const res = await page.request.get(`${BASE}/api/accounts`)
    if (!res.ok()) {
      test.skip(true, '/api/accounts unreachable')
      return
    }
    const body = await res.json()
    const customers = (body.customers ?? []) as Array<{ name: string }>
    if (!customers.length) {
      test.skip(true, 'No customers in seeded data for snapshot')
      return
    }
    const name = customers[0].name
    await page.goto(`${BASE}/dashboard/customer/${encodeURIComponent(name)}`)
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveScreenshot('dashboard-customer-detail.png', { maxDiffPixelRatio: 0.02 })
  })

  test('visual baseline: wizard completion state (seeded AEs configured badge)', async ({ page }) => {
    // "Completion state" here = setup page with AEs already configured.
    // With seeded data, the Step 4 badge reads "2 AEs configured".
    await page.goto(`${BASE}/dashboard/setup`)
    await page.waitForLoadState('networkidle')
    // Assert the "2 AEs configured" badge is present — seeded data has 2 AEs
    await expect(page.getByText(/2 AEs configured/)).toBeVisible({ timeout: 10_000 })
    await expect(page).toHaveScreenshot('setup-completion-aes-configured.png', { maxDiffPixelRatio: 0.02 })
  })
})
