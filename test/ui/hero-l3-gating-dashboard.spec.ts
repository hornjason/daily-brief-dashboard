/**
 * BKL-HERO-05, BKL-HERO-06, BKL-HERO-07, BKL-HERO-20 — Dashboard L3 hero-mode gating.
 *
 *   - BKL-HERO-05: RhSessionBanner hidden on L3 hero installs.
 *   - BKL-HERO-06: "Connect Red Hat Portal in Settings" KPI hint hidden on L3.
 *   - BKL-HERO-07: Cloud Spend section absent on L3; present on L4.
 *   - BKL-HERO-20: L4-only Admin/Setup sections absent — CI purity gate.
 *
 * Tagged @destructive so it runs against the test container (port 7776)
 * via the `test` project grep. State is not mutated — only /api/node-role
 * and /api/auth/redhat/status are stubbed to control banner conditions.
 *
 * Project: --project=test (7776).
 */
import { test, expect, type Page } from '@playwright/test'

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
  test.describe.configure({ mode: 'serial' })
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

// ── BKL-HERO-20: L4 sections absent from hero image (CI purity gate) ─────────
//
// These tests run on 7776 (hero image) and assert that L4-only UI sections
// are not present. If a worktree merge accidentally re-adds these sections,
// CI catches it before the Quinn human gate.

test.describe('@destructive BKL-HERO-20: L4 sections absent from hero image', () => {
  test('T10 — Admin page has no "Browser Sessions" section (BKL-HERO-20)', async ({ page }) => {
    await page.goto('/dashboard/admin')
    await page.waitForSelector('main', { timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(1_000)

    // h2 heading would reappear if Browser Sessions section is re-added
    await expect(page.locator('h2:has-text("Browser Sessions")')).toHaveCount(0)
    await expect(page.locator('text=Browser Sessions').first()).toHaveCount(0)
  })

  test('T11 — Admin page has no "Salesforce Pipeline" scrape trigger (BKL-HERO-20)', async ({ page }) => {
    await page.goto('/dashboard/admin')
    await page.waitForSelector('main', { timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(1_000)

    await expect(page.locator('text=Salesforce Pipeline')).toHaveCount(0)
  })

  test('T12 — Setup page has no "Data Sources" section (BKL-HERO-20)', async ({ page }) => {
    await page.goto('/dashboard/setup')
    await page.waitForSelector('main', { timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(1_000)

    await expect(page.locator('text=Data Sources')).toHaveCount(0)
  })

  test('T13 — Setup page has no "Refresh Timer & Settings" section (BKL-HERO-20)', async ({ page }) => {
    await page.goto('/dashboard/setup')
    await page.waitForSelector('main', { timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(1_000)

    await expect(page.locator('text=Refresh Timer & Settings')).toHaveCount(0)
  })

  test('T14 — Setup page has no "Automation & Limits" section (BKL-HERO-20)', async ({ page }) => {
    await page.goto('/dashboard/setup')
    await page.waitForSelector('main', { timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(1_000)

    await expect(page.locator('text=Automation & Limits')).toHaveCount(0)
  })
})
