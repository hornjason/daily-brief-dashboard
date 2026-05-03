/**
 * SF Pipeline Sync Now — regression tests (BKL-TEST-SF-SYNC-BANNER-01, BKL-TEST-SF-SYNC-ERROR-01).
 *
 * The "Sync Now" button on /dashboard/setup (Step 3 — Connections) POSTs to
 * /api/scrape/sf-bookings-sync. On success, a green banner with the matched
 * row count appears and auto-clears after 8 seconds. On failure, a red error
 * banner appears and stays until the next click (res.ok gate — BKL-TEST-07 standard).
 *
 * Routes are mocked via page.route() — no real server mutations.
 * Tagged @destructive so the `test` Playwright project routes to 7776.
 */
import { test, expect } from '../fixtures'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'
const SETUP_URL = `${BASE}/dashboard/setup`

/** Stub all mount-time GETs needed for SetupPage to render without crashing */
async function mockSetupGets(page: import('@playwright/test').Page) {
  // Simulate L4 install so the rh-portal accordion (and SF Pipeline Sync panel inside it) renders.
  await page.route('**/api/node-role', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isL3Only: false }) })
  )
  // RH token check
  await page.route('**/api/settings/offline-token', r =>
    r.request().method() === 'GET'
      ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true }) })
      : r.fallback()
  )
  // Auth status endpoints
  await page.route('**/api/auth/redhat/status', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasSession: false, sessionExpired: false, lastScraped: null }) })
  )
  await page.route('**/api/auth/salesforce/status', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasSession: true, lastSync: '2026-05-01T00:00:00Z', syncError: null, sessionExpired: false }) })
  )
  await page.route('**/api/bootstrap/tableau/session-status', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reachable: false, sessionValid: false }) })
  )
  // AEs + customers (needed by Step 4)
  await page.route('**/api/aes', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ aes: [] }) })
  )
  await page.route('**/api/accounts', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ customers: [] }) })
  )
  // Status endpoints
  await page.route('**/api/status/scrapes', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ccsp: null }) })
  )
  await page.route('**/api/scraper-status', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scrapers: {}, circuitBreakers: {}, queue: { running: null, pending: [], isAnyRunning: false }, browserRestartNeeded: false, rhDiscoveryProgress: null }) })
  )
  // Settings and other GETs
  await page.route('**/api/settings/**', r =>
    r.request().method() === 'GET'
      ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) })
      : r.fallback()
  )
  await page.route('**/api/sf/reports', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
  )
  await page.route('**/api/products/config', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
  )
  // Suppress Step 0 "first boot" overlay (enabledRegions key must be present to signal non-first-boot).
  await page.route('**/api/regions/access', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabledRegions: [], enabledPods: [] }) })
  )
}

test.describe('SF Pipeline Sync Now — success banner (BKL-TEST-SF-SYNC-BANNER-01) @destructive', () => {
  test('REG-SF-SYNC-01: success response surfaces Sync complete banner with row count', async ({ page }) => {
    await mockSetupGets(page)
    await page.route('**/api/scrape/sf-bookings-sync', r => {
      if (r.request().method() === 'POST') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ aes: 1, customersTotal: 47, customersMatched: 47, summary: [] }),
        })
      }
      return r.fallback()
    })

    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })

    // Open Step 3 — Connections section (it's an accordion)
    // Wait for Step 3 accordion to render (it only appears after /api/node-role responds with isL3Only:false).
    const step3 = page.locator('button, [role="button"]').filter({ hasText: /Step 3.*Connections|Connections/ }).first()
    await expect(step3).toBeVisible({ timeout: 10_000 })
    if (!await page.getByTestId('sf-sync-btn').isVisible()) await step3.click()

    const syncBtn = page.getByTestId('sf-sync-btn')
    await expect(syncBtn).toBeVisible({ timeout: 10_000 })
    await syncBtn.click()

    const banner = page.getByTestId('sf-sync-success')
    await expect(banner).toBeVisible({ timeout: 5_000 })
    await expect(banner).toContainText(/Sync complete/i)
    await expect(banner).toContainText('47')
  })

  test('REG-SF-SYNC-02: success banner auto-clears after 8 seconds', async ({ page }) => {
    await mockSetupGets(page)
    await page.route('**/api/scrape/sf-bookings-sync', r => {
      if (r.request().method() === 'POST') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ aes: 1, customersTotal: 10, customersMatched: 10, summary: [] }),
        })
      }
      return r.fallback()
    })

    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })

    // Wait for Step 3 accordion to render (it only appears after /api/node-role responds with isL3Only:false).
    const step3 = page.locator('button, [role="button"]').filter({ hasText: /Step 3.*Connections|Connections/ }).first()
    await expect(step3).toBeVisible({ timeout: 10_000 })
    if (!await page.getByTestId('sf-sync-btn').isVisible()) await step3.click()

    const syncBtn = page.getByTestId('sf-sync-btn')
    await expect(syncBtn).toBeVisible({ timeout: 10_000 })
    await syncBtn.click()

    const banner = page.getByTestId('sf-sync-success')
    await expect(banner).toBeVisible({ timeout: 5_000 })

    // Banner must disappear within 10s (8s timer + 2s buffer)
    await expect(banner).toHaveCount(0, { timeout: 10_000 })
  })
})

test.describe('SF Pipeline Sync Now — error state (BKL-TEST-SF-SYNC-ERROR-01) @destructive', () => {
  test('REG-SF-SYNC-03: 500 from /api/scrape/sf-bookings-sync surfaces error near Sync Now button', async ({ page }) => {
    await mockSetupGets(page)
    await page.route('**/api/scrape/sf-bookings-sync', r => {
      if (r.request().method() === 'POST') {
        return r.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'SF bookings sync failed' }),
        })
      }
      return r.fallback()
    })

    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })

    // Wait for Step 3 accordion to render (it only appears after /api/node-role responds with isL3Only:false).
    const step3 = page.locator('button, [role="button"]').filter({ hasText: /Step 3.*Connections|Connections/ }).first()
    await expect(step3).toBeVisible({ timeout: 10_000 })
    if (!await page.getByTestId('sf-sync-btn').isVisible()) await step3.click()

    const syncBtn = page.getByTestId('sf-sync-btn')
    await expect(syncBtn).toBeVisible({ timeout: 10_000 })
    await syncBtn.click()

    const err = page.getByTestId('sf-sync-error')
    await expect(err).toBeVisible({ timeout: 5_000 })
    await expect(err).toContainText(/SF bookings sync failed|Sync failed/i)
  })
})
