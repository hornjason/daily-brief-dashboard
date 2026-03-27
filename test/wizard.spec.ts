/**
 * Setup Wizard E2E Tests
 *
 * Requires the server to be running:
 *   bun run server.ts &
 * Or against the container:
 *   podman run --rm -p 7777:7777 localhost/daily-brief-dashboard
 *
 * Run:
 *   bun run test:e2e
 */
import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'

// ── Step order and labels ─────────────────────────────────────────────────────

test.describe('Setup Wizard step order', () => {
  test('wizard loads and shows 7 steps', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    // 7 step indicator circles (numbered 1-7; completed steps show a check icon)
    const stepCircles = page.locator('.rounded-full').filter({ hasText: /^[1-7]$/ })
    await expect(stepCircles).toHaveCount(7)
  })

  test('all 7 step labels are present', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    for (const label of ['OAuth Keys', 'Google Auth', 'Accounts', 'Domains', 'AI Provider', 'Red Hat Portal', 'Launch']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible()
    }
  })

  test('step 1 (index 0) is OAuth Keys', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    const stepLabels = await page
      .getByText(/OAuth Keys|Google Auth|Accounts|Domains|AI Provider|Red Hat Portal|Launch/)
      .allTextContents()
    expect(stepLabels[0]).toContain('OAuth Keys')
  })

  test('step 2 (index 1) is Google Auth — not Accounts', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    const stepLabels = await page
      .getByText(/OAuth Keys|Google Auth|Accounts|Domains|AI Provider|Red Hat Portal|Launch/)
      .allTextContents()
    // Critical ordering check — this would have caught the step-swap bug
    expect(stepLabels[1]).toContain('Google Auth')
    expect(stepLabels[1]).not.toContain('Accounts')
  })

  test('step 3 (index 2) is Accounts', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    const stepLabels = await page
      .getByText(/OAuth Keys|Google Auth|Accounts|Domains|AI Provider|Red Hat Portal|Launch/)
      .allTextContents()
    expect(stepLabels[2]).toContain('Accounts')
  })

  test('step 5 (index 4) is AI Provider', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    const stepLabels = await page
      .getByText(/OAuth Keys|Google Auth|Accounts|Domains|AI Provider|Red Hat Portal|Launch/)
      .allTextContents()
    expect(stepLabels[4]).toContain('AI Provider')
  })

  test('step 6 (index 5) is Red Hat Portal', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    const stepLabels = await page
      .getByText(/OAuth Keys|Google Auth|Accounts|Domains|AI Provider|Red Hat Portal|Launch/)
      .allTextContents()
    expect(stepLabels[5]).toContain('Red Hat Portal')
  })

  test('step 7 (index 6) is Launch', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    const stepLabels = await page
      .getByText(/OAuth Keys|Google Auth|Accounts|Domains|AI Provider|Red Hat Portal|Launch/)
      .allTextContents()
    expect(stepLabels[6]).toContain('Launch')
  })
})

// ── Active step indicator ─────────────────────────────────────────────────────

test.describe('Setup Wizard active step styling', () => {
  test('first step has active ring styling on load', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup?step=0`)
    // Active step circle has ring-2 ring-indigo-400 classes
    const activeCircle = page.locator('.ring-2').first()
    await expect(activeCircle).toBeVisible()
  })

  test('active step label is white text', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup?step=0`)
    // Step 0 active — its label span uses text-white
    const oauthLabel = page.getByText('OAuth Keys', { exact: true })
    await expect(oauthLabel).toHaveClass(/text-white/)
  })
})

// ── Step 0: OAuth Keys validation ─────────────────────────────────────────────

test.describe('Setup Wizard step 0 — OAuth Keys', () => {
  test.beforeEach(async ({ page }) => {
    // Serve oauth-keys-status as not-configured so Step 0 content is visible
    await page.route('**/api/setup/oauth-keys-status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ exists: false }) })
    )
    await page.goto(`${BASE_URL}/dashboard/setup?step=0`)
  })

  test('Save Keys button is disabled when textarea is empty', async ({ page }) => {
    const saveBtn = page.getByRole('button', { name: /Save Keys/i })
    await expect(saveBtn).toBeDisabled()
  })

  test('Save Keys button enables after typing in textarea', async ({ page }) => {
    const textarea = page.locator('textarea')
    await textarea.fill('{"web": {"client_id": "x", "client_secret": "y"}}')
    const saveBtn = page.getByRole('button', { name: /Save Keys/i })
    await expect(saveBtn).toBeEnabled()
  })

  test('invalid JSON shows error message', async ({ page }) => {
    const textarea = page.locator('textarea')
    await textarea.fill('not valid json {{{')
    await page.getByRole('button', { name: /Save Keys/i }).click()
    // JSON.parse throws SyntaxError — error rendered in text-red-400 element
    const errorEl = page.locator('.text-red-400').first()
    await expect(errorEl).toBeVisible()
  })

  test('valid JSON with missing OAuth shape shows server validation error', async ({ page }) => {
    // JSON parses fine but lacks client_id/client_secret — server returns 400
    await page.route('**/api/setup/upload-oauth-keys', route =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Missing client_id or client_secret' }),
      })
    )
    const textarea = page.locator('textarea')
    await textarea.fill('{"foo": "bar"}')
    await page.getByRole('button', { name: /Save Keys/i }).click()
    await expect(page.getByText(/Missing client_id or client_secret/)).toBeVisible()
  })

  test('OAuth keys input mechanism is present (textarea or file input)', async ({ page }) => {
    const hasInput = await page.locator('textarea, input[type="file"]').count()
    expect(hasInput).toBeGreaterThan(0)
  })
})

// ── Step 0 navigation gating ──────────────────────────────────────────────────

test.describe('Setup Wizard step 0 — navigation gating', () => {
  test('Next is blocked and hint shown when OAuth keys not uploaded', async ({ page }) => {
    await page.route('**/api/setup/oauth-keys-status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ exists: false }) })
    )
    await page.goto(`${BASE_URL}/dashboard/setup?step=0`)
    // Hint text appears when keys not configured
    await expect(page.getByText(/Upload OAuth keys to continue/i)).toBeVisible()
    // Next button is not rendered when gated (only shown when canGoNext is true)
    await expect(page.getByRole('button', { name: /Next/i })).toHaveCount(0)
  })

  test('Back button is disabled on step 0', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup?step=0`)
    const backBtn = page.getByRole('button', { name: /Back/i })
    await expect(backBtn).toBeDisabled()
  })
})

// ── Step 2: Accounts (Sheets import) gating ───────────────────────────────────

test.describe('Setup Wizard step 2 — Accounts gating', () => {
  test.beforeEach(async ({ page }) => {
    // Stub data-sources/status to return empty folders list
    await page.route('**/api/data-sources/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ folders: [] }) })
    )
  })

  test('Add folder button is disabled when URL input is empty', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup?step=2`)
    // The Add button next to the URL input
    const addBtn = page.getByRole('button', { name: /^Add$/i })
    await expect(addBtn).toBeDisabled()
  })

  test('Add folder button enables after typing a URL', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup?step=2`)
    await page.locator('input[type="text"]').fill('https://drive.google.com/drive/folders/abc123')
    const addBtn = page.getByRole('button', { name: /^Add$/i })
    await expect(addBtn).toBeEnabled()
  })

  test('hint shown when accounts not yet imported', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup?step=2`)
    await expect(page.getByText(/Import accounts to continue/i)).toBeVisible()
  })
})

// ── Step 5: Red Hat Portal ─────────────────────────────────────────────────────

test.describe('Setup Wizard step 5 — Red Hat Portal', () => {
  test('Connect Red Hat Portal button visible when not connected', async ({ page }) => {
    await page.route('**/api/auth/redhat/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        hasSession: false, sessionExpired: false, lastScraped: null,
        caseCount: 0, loginInProgress: false, loginTimedOut: false,
      }) })
    )
    await page.goto(`${BASE_URL}/dashboard/setup?step=5`)
    await expect(page.getByRole('button', { name: /Connect Red Hat Portal/i })).toBeVisible()
  })

  test('clicking Connect fires POST /api/auth/redhat/start and shows waiting state', async ({ page }) => {
    await page.route('**/api/auth/redhat/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        hasSession: false, sessionExpired: false, lastScraped: null,
        caseCount: 0, loginInProgress: false, loginTimedOut: false,
      }) })
    )
    let startCalled = false
    await page.route('**/api/auth/redhat/start', route => {
      startCalled = true
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) })
    })
    await page.goto(`${BASE_URL}/dashboard/setup?step=5`)
    await page.getByRole('button', { name: /Connect Red Hat Portal/i }).click()
    // Waiting state shows "Browser window opened"
    await expect(page.getByText(/Browser window opened/i)).toBeVisible()
    expect(startCalled).toBe(true)
  })

  test('loginTimedOut status shows timeout warning', async ({ page }) => {
    // Initial status: connecting state (loginInProgress)
    await page.route('**/api/auth/redhat/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        hasSession: false, sessionExpired: false, lastScraped: null,
        caseCount: 0, loginInProgress: true, loginTimedOut: true,
      }) })
    )
    await page.route('**/api/auth/redhat/start', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) })
    )
    await page.goto(`${BASE_URL}/dashboard/setup?step=5`)
    // Trigger connecting state first
    await page.getByRole('button', { name: /Connect Red Hat Portal/i }).click()
    await expect(page.getByText(/Login timed out/i)).toBeVisible()
  })

  test('error from start API shows inline error message', async ({ page }) => {
    await page.route('**/api/auth/redhat/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        hasSession: false, sessionExpired: false, lastScraped: null,
        caseCount: 0, loginInProgress: false, loginTimedOut: false,
      }) })
    )
    await page.route('**/api/auth/redhat/start', route =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Login already in progress' }),
      })
    )
    await page.goto(`${BASE_URL}/dashboard/setup?step=5`)
    await page.getByRole('button', { name: /Connect Red Hat Portal/i }).click()
    await expect(page.getByText(/Login already in progress/i)).toBeVisible()
  })

  test('connected state shows "Red Hat Portal Connected"', async ({ page }) => {
    await page.route('**/api/auth/redhat/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        hasSession: true, sessionExpired: false, lastScraped: null,
        caseCount: 0, loginInProgress: false, loginTimedOut: false,
      }) })
    )
    await page.goto(`${BASE_URL}/dashboard/setup?step=5`)
    await expect(page.getByText(/Red Hat Portal Connected/i)).toBeVisible()
  })

  test('Cancel button appears while connecting and clears state', async ({ page }) => {
    await page.route('**/api/auth/redhat/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        hasSession: false, sessionExpired: false, lastScraped: null,
        caseCount: 0, loginInProgress: false, loginTimedOut: false,
      }) })
    )
    await page.route('**/api/auth/redhat/start', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) })
    )
    await page.route('**/api/auth/redhat/session', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) })
    )
    await page.goto(`${BASE_URL}/dashboard/setup?step=5`)
    await page.getByRole('button', { name: /Connect Red Hat Portal/i }).click()
    await expect(page.getByRole('button', { name: /Cancel/i })).toBeVisible()
    await page.getByRole('button', { name: /Cancel/i }).click()
    // After cancel, Connect button is back
    await expect(page.getByRole('button', { name: /Connect Red Hat Portal/i })).toBeVisible()
  })
})
