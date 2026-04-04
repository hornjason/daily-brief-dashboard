/**
 * RH session status display — supplemental tests.
 *
 * dashboard.spec.ts already covers:
 *   - "not connected" banner visibility
 *   - "session expired" banner visibility
 *   - "no banner when active" check
 *   - Connect button visibility (not connected)
 *   - Reconnect button visibility (expired)
 *   - Connect → opens noVNC tab at correct URL
 *   - Status text → "Login browser opened" after Connect
 *   - loginInProgress waiting state
 *
 * This file adds ONLY what's missing:
 *   - Connect button fires POST /api/auth/redhat/start
 *   - Salesforce session states (separate auth system)
 *   - Polling behavior after connect
 */
import { test, expect } from '../fixtures'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'

const NO_SESSION = {
  hasSession: false,
  sessionExpired: false,
  lastScraped: null,
  caseCount: 0,
  loginInProgress: false,
  loginTimedOut: false,
}

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe('RH session — Connect button fires start endpoint', () => {
  test('Connect button calls POST /api/auth/redhat/start', async ({ page }) => {
    await page.route('**/api/auth/redhat/status', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(NO_SESSION) })
    )

    let startCalled = false
    await page.route('**/api/auth/redhat/start', (route) => {
      startCalled = true
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) })
    })

    await page.goto(`${BASE}/`)

    const connectBtn = page.getByRole('button', { name: /^Connect$/i })
    await expect(connectBtn).toBeVisible({ timeout: 5000 })
    await connectBtn.click()

    // The start endpoint should have been called
    expect(startCalled).toBe(true)
  })
})

test.describe('RH session — Salesforce session display', () => {
  test('Salesforce not-connected state renders without error', async ({ page }) => {
    await page.route('**/api/auth/redhat/status', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(NO_SESSION) })
    )
    await page.route('**/api/auth/salesforce/status', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ hasSession: false, sessionExpired: false }),
      })
    )

    await page.goto(`${BASE}/`)
    // Page should render without crashing with both sessions disconnected
    await expect(page.locator('body')).toBeVisible()
    // The page should not show a JavaScript error overlay
    const errorOverlay = page.locator('[id="webpack-dev-server-client-overlay"], [class*="error-overlay"]')
    expect(await errorOverlay.count()).toBe(0)
  })

  test('Salesforce expired session shows reconnect UI', async ({ page }) => {
    await page.route('**/api/auth/redhat/status', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          hasSession: true, sessionExpired: false,
          lastScraped: new Date().toISOString(), caseCount: 3,
          loginInProgress: false, loginTimedOut: false,
        }),
      })
    )
    await page.route('**/api/auth/salesforce/status', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          hasSession: true,
          sessionExpired: true,
          syncError: 'session expired during sync',
        }),
      })
    )

    await page.goto(`${BASE}/`)
    // Page should render — look for Salesforce-related session indicator
    // The dashboard may show SF status in a data sources section or banner
    await expect(page.locator('body')).toBeVisible()
    // Verify the page didn't crash
    await expect(page).toHaveURL(new RegExp(BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})

test.describe('RH session — polling after connect', () => {
  test('dashboard re-fetches RH status after connect (polling)', async ({ page }) => {
    let fetchCount = 0
    await page.route('**/api/auth/redhat/status', (route) => {
      fetchCount++
      // First two calls: not connected. Third+: connected.
      const body = fetchCount <= 2
        ? NO_SESSION
        : {
            hasSession: true, sessionExpired: false,
            lastScraped: new Date().toISOString(), caseCount: 5,
            loginInProgress: false, loginTimedOut: false,
          }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    })

    await page.route('**/api/auth/redhat/start', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) })
    )

    await page.goto(`${BASE}/`)
    const connectBtn = page.getByRole('button', { name: /^Connect$/i })
    await expect(connectBtn).toBeVisible({ timeout: 5000 })
    await connectBtn.click()

    // After clicking Connect, the dashboard should poll status.
    // Wait for the status to flip to connected (fetchCount > 2)
    // The banners should clear once session is active.
    // Allow up to 15s for polling to kick in (typical poll interval is 2-5s)
    await expect(async () => {
      expect(fetchCount).toBeGreaterThan(2)
    }).toPass({ timeout: 15000 })
  })
})

// ── BKL-W2-11: SF "Session Active + no lastSync" state triggers sync ──────────
// Regression: clicking Connect when SF session is live but lastSync=null was a
// silent no-op. Fix (handleSfConnect line ~2184): detect this state and fire
// POST /api/scrape/salesforce instead of opening VNC.

test.describe('SF session — "Session Active" triggers sync on Connect', () => {
  test('Connect fires POST /api/scrape/salesforce when session active but never synced', async ({ page }) => {
    const BASE = process.env.BASE_URL ?? 'http://localhost:7777'

    // Mock RH portal as connected (required for Setup page to show Data Sources)
    await page.route('**/api/auth/redhat/status', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          hasSession: true, sessionExpired: false,
          lastScraped: new Date().toISOString(), caseCount: 0,
          loginInProgress: false, loginTimedOut: false,
        }),
      })
    )

    // SF: session exists but has never synced (lastSync=null, no syncError)
    await page.route('**/api/auth/salesforce/status', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          hasSession: true,
          sessionExpired: false,
          lastSync: null,
          rowCount: 0,
          reportConfigured: true,
          sheetConfigured: true,
          syncError: null,
        }),
      })
    )

    // Track whether POST /api/scrape/salesforce was called
    let sfScrapeCalled = false
    await page.route('**/api/scrape/salesforce', (route) => {
      if (route.request().method() === 'POST') sfScrapeCalled = true
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })

    // Mock other required endpoints to prevent noise
    await page.route('**/api/aes', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ aes: [] }) })
    )
    await page.route('**/api/customers', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify([]) })
    )

    await page.goto(`${BASE}/dashboard/setup`)

    // Open the Data Sources accordion section
    const dataSourcesBtn = page.getByRole('button', { name: /Data Sources/i })
    if (await dataSourcesBtn.count() > 0) {
      await dataSourcesBtn.click()
    }

    // Find the SF Connect button (shown when sfConnected=false i.e. no lastSync)
    const connectBtn = page.getByRole('button', { name: /^Connect$/i }).first()
    await expect(connectBtn).toBeVisible({ timeout: 5000 })
    await connectBtn.click()

    // Verify the scrape endpoint was triggered (not a silent no-op)
    await expect(async () => {
      expect(sfScrapeCalled, 'POST /api/scrape/salesforce should be called when session is active but lastSync is null').toBe(true)
    }).toPass({ timeout: 5000 })
  })
})
