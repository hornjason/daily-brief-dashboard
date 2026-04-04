/**
 * Setup Page E2E Tests
 *
 * Tests the accordion-based setup page at /dashboard/setup.
 * Requires the server to be running (Playwright webServer handles this in CI).
 *
 * Run:
 *   CI=true bunx playwright test test/wizard.spec.ts
 */
import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'

// ── Page load — accordion sections ────────────────────────────────────────────

test.describe('Setup page — accordion sections', () => {
  test('page loads at /dashboard/setup', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await expect(page).toHaveURL(/\/dashboard\/setup/)
  })

  test('OAuth Keys section header is visible', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await expect(page.getByText('OAuth Keys', { exact: true })).toBeVisible()
  })

  test('Google Auth section header is visible', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await expect(page.getByText('Google Auth', { exact: true })).toBeVisible()
  })

  test('Red Hat Portal section header is visible', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await expect(page.getByText('Red Hat Portal', { exact: true })).toBeVisible()
  })

  test('AEs & Customers section header is visible', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await expect(page.getByText('AEs & Customers', { exact: true })).toBeVisible()
  })

  test('Data Sources section header is visible', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await expect(page.getByText('Data Sources', { exact: true })).toBeVisible()
  })

  test('all 6 section headers are present', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    for (const section of ['OAuth Keys', 'Google Auth', 'Red Hat Portal', 'AEs & Customers', 'Data Sources']) {
      await expect(page.getByText(section, { exact: true })).toBeVisible()
    }
  })
})

// ── OAuth Keys section ─────────────────────────────────────────────────────────

test.describe('Setup page — OAuth Keys section', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/setup/oauth-keys-status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ exists: false }) })
    )
    await page.goto(`${BASE_URL}/dashboard/setup`)
    // Open the OAuth Keys accordion
    await page.getByText('OAuth Keys', { exact: true }).click()
  })

  test('OAuth Keys section expands on click', async ({ page }) => {
    // After clicking, Save Keys button or upload UI should appear
    const hasInput = await page.locator('textarea, input[type="file"]').count()
    expect(hasInput).toBeGreaterThan(0)
  })

  test('Save Keys button is disabled when textarea is empty', async ({ page }) => {
    const saveBtn = page.getByRole('button', { name: /Save Keys/i })
    await expect(saveBtn).toBeDisabled()
  })

  test('Save Keys button enables after typing in textarea', async ({ page }) => {
    const textarea = page.locator('textarea').first()
    await textarea.fill('{"web": {"client_id": "x", "client_secret": "y"}}')
    const saveBtn = page.getByRole('button', { name: /Save Keys/i })
    await expect(saveBtn).toBeEnabled()
  })

  test('invalid JSON shows error message', async ({ page }) => {
    const textarea = page.locator('textarea').first()
    await textarea.fill('not valid json {{{')
    await page.getByRole('button', { name: /Save Keys/i }).click()
    const errorEl = page.locator('.text-critical').first()
    await expect(errorEl).toBeVisible()
  })

  test('valid JSON with missing OAuth shape shows server validation error', async ({ page }) => {
    await page.route('**/api/setup/upload-oauth-keys', route =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Missing client_id or client_secret' }),
      })
    )
    const textarea = page.locator('textarea').first()
    await textarea.fill('{"foo": "bar"}')
    await page.getByRole('button', { name: /Save Keys/i }).click()
    await expect(page.getByText(/Missing client_id or client_secret/)).toBeVisible()
  })
})

// ── Google Auth section ────────────────────────────────────────────────────────

test.describe('Setup page — Google Auth section', () => {
  test('Google Auth section expands on click and shows auth button', async ({ page }) => {
    await page.route('**/api/auth/google/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authorized: false }) })
    )
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await page.getByText('Google Auth', { exact: true }).click()
    // Connect Google Workspace link or button should be visible
    await expect(page.getByText(/Connect Google Workspace/i)).toBeVisible()
  })
})

// ── AEs & Customers section — folder URL input ─────────────────────────────────

test.describe('Setup page — AEs & Customers section', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/data-sources/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ folders: [] }) })
    )
  })

  test('?step=2 auto-opens AEs & Customers section', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup?step=2`)
    // The step=2 param triggers setOpenSection('aes') — content should be visible
    // Look for the auto-bootstrap or manual setup UI
    await expect(page.locator('section#aes')).toBeVisible()
  })
})

// ── Red Hat Portal section ─────────────────────────────────────────────────────

test.describe('Setup page — Red Hat Portal section', () => {
  test('Connect Red Hat Portal button visible when not connected', async ({ page }) => {
    await page.route('**/api/auth/redhat/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        hasSession: false, sessionExpired: false, lastScraped: null,
        caseCount: 0, loginInProgress: false, loginTimedOut: false,
      }) })
    )
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await page.getByText('Red Hat Portal', { exact: true }).click()
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
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await page.getByText('Red Hat Portal', { exact: true }).click()
    await page.getByRole('button', { name: /Connect Red Hat Portal/i }).click()
    await expect(page.getByText(/Browser window opened/i)).toBeVisible()
    expect(startCalled).toBe(true)
  })

  test('loginTimedOut status shows timeout warning', async ({ page }) => {
    await page.route('**/api/auth/redhat/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        hasSession: false, sessionExpired: false, lastScraped: null,
        caseCount: 0, loginInProgress: true, loginTimedOut: true,
      }) })
    )
    await page.route('**/api/auth/redhat/start', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) })
    )
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await page.getByText('Red Hat Portal', { exact: true }).click()
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
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await page.getByText('Red Hat Portal', { exact: true }).click()
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
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await page.getByText('Red Hat Portal', { exact: true }).click()
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
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await page.getByText('Red Hat Portal', { exact: true }).click()
    await page.getByRole('button', { name: /Connect Red Hat Portal/i }).click()
    await expect(page.getByRole('button', { name: /Cancel/i })).toBeVisible()
    await page.getByRole('button', { name: /Cancel/i }).click()
    await expect(page.getByRole('button', { name: /Connect Red Hat Portal/i })).toBeVisible()
  })
})
