/**
 * BKL-HERO-05, BKL-HERO-06 — Dashboard L3 hero-mode gating.
 *
 *   - BKL-HERO-05: RhSessionBanner hidden on L3 hero installs.
 *   - BKL-HERO-06: "Connect Red Hat Portal in Settings" KPI hint hidden on L3.
 *   - Parity: on L4 (isL3Only:false), banner renders when RH session is missing.
 *
 * Tagged @destructive so it runs against the test container (port 7776)
 * via the `test` project grep. State is not mutated — only /api/node-role
 * and /api/auth/redhat/status are stubbed to control banner conditions.
 *
 * Project: --project=test (7776).
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

const DASHBOARD_PATH = '/dashboard'

async function mockNodeRole(page: Page, isL3Only: boolean) {
  await page.route('**/api/node-role', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ isL3Only }),
    })
  )
}

/**
 * Force a "no RH session" state so the banner *would* render on L4 —
 * lets us verify the L3 gate is what suppresses it on hero installs.
 */
async function mockRhStatusNoSession(page: Page) {
  await page.route('**/api/auth/redhat/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        hasSession: false,
        sessionExpired: false,
        lastScraped: null,
        caseCount: 0,
        loginInProgress: false,
        loginTimedOut: false,
      }),
    })
  )
}

async function waitForDashboardReady(page: Page) {
  // Top bar / sidebar mount before KPI data; the page main grid is a stable anchor.
  await page.waitForSelector('main', { timeout: 10_000 }).catch(() => {})
}

test.describe('@destructive BKL-HERO-05/06: Dashboard L3 gating', () => {
  test('T1 — RhSessionBanner absent on L3 hero install (BKL-HERO-05)', async ({ page }) => {
    await mockNodeRole(page, true)
    await mockRhStatusNoSession(page)
    await page.goto(DASHBOARD_PATH)
    await waitForDashboardReady(page)

    // Banner copy is unique enough to assert against directly.
    await expect(page.locator('text=Red Hat Portal not connected')).toHaveCount(0)
    await expect(page.locator('text=Red Hat session expired')).toHaveCount(0)
  })

  test('T2 — "Connect Red Hat Portal in Settings" hint absent on L3 (BKL-HERO-06)', async ({ page }) => {
    await mockNodeRole(page, true)
    await mockRhStatusNoSession(page)
    await page.goto(DASHBOARD_PATH)
    await waitForDashboardReady(page)

    await expect(
      page.locator('text=Connect Red Hat Portal in Settings to sync support cases')
    ).toHaveCount(0)
  })

  test('T7 — L4 install renders the RhSessionBanner when no RH session (parity)', async ({ page }) => {
    await mockNodeRole(page, false)
    await mockRhStatusNoSession(page)
    await page.goto(DASHBOARD_PATH)
    await waitForDashboardReady(page)

    await expect(
      page.locator('text=Red Hat Portal not connected')
    ).toBeVisible({ timeout: 10_000 })
  })

  test('T8 — Cloud Spend section absent on L3 hero install (BKL-HERO-07)', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(DASHBOARD_PATH)
    await waitForDashboardReady(page)

    await expect(page.locator('#section-cloudspend')).toHaveCount(0)
    await expect(page.locator('text=Cloud Spend (CCSP)')).toHaveCount(0)
  })

  test('T9 — Cloud Spend section present on L4 install (BKL-HERO-07 parity)', async ({ page }) => {
    await mockNodeRole(page, false)
    await page.goto(DASHBOARD_PATH)
    await waitForDashboardReady(page)
    // Wait for data fetch to settle; section renders when accounts exist
    await expect(page.locator('#section-cloudspend')).toBeVisible({ timeout: 10_000 })
  })
})
