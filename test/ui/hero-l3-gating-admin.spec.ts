/**
 * BKL-HERO-05..13 — AdminPage L3 hero-mode gating.
 *
 * Mocks /api/node-role to { isL3Only: true } and verifies that the
 * Admin page hides every L4-only surface:
 *   - BKL-HERO-09: break-glass warning banner
 *   - BKL-HERO-11: RH Cases + CCSP scrape triggers (SF Pipeline stays)
 *   - BKL-HERO-12: Browser Sessions section
 *   - BKL-HERO-10: RH Portal + Tableau/CCSP health tiles
 *   - BKL-HERO-13: CCSP + RH Cases scheduler rows
 *
 * Tagged @destructive so it runs against the test container (port 7776)
 * via the `test` project grep. No state mutation — only DOM assertions
 * with stubbed /api/node-role.
 *
 * Project: --project=test (7776).
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

const ADMIN_PATH = '/dashboard/admin'

async function mockNodeRole(page: Page, isL3Only: boolean) {
  await page.route('**/api/node-role', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ isL3Only }),
    })
  )
}

async function waitForAdminReady(page: Page) {
  await page.waitForSelector('h1:has-text("Admin")', { timeout: 10_000 }).catch(() => {})
}

test.describe('@destructive BKL-HERO-05..13: AdminPage L3 gating', () => {
  test('T1 — break-glass warning banner absent on L3 (BKL-HERO-09)', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(ADMIN_PATH)
    await waitForAdminReady(page)

    await expect(page.locator('text=Break-glass page.')).toHaveCount(0)
  })

  test('T2 — RH Cases scrape trigger absent on L3, SF Pipeline present (BKL-HERO-11)', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(ADMIN_PATH)
    await waitForAdminReady(page)

    // RH Cases ScrapeSection is unmounted entirely on L3.
    const sections = page.locator('h2:has-text("Manual Scrape Triggers")').locator('..')
    await expect(sections.locator('text=RH Cases')).toHaveCount(0)
    // SF Pipeline must remain — it's L3-safe.
    await expect(page.locator('text=SF Pipeline').first()).toBeVisible({ timeout: 10_000 })
  })

  test('T3 — CCSP scrape trigger absent on L3 (BKL-HERO-11)', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(ADMIN_PATH)
    await waitForAdminReady(page)

    // The "Open VNC Login" button only exists inside the CCSP ScrapeSection.
    await expect(page.locator('button:has-text("Open VNC Login")')).toHaveCount(0)
  })

  test('T4 — Browser Sessions section absent on L3 (BKL-HERO-12)', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(ADMIN_PATH)
    await waitForAdminReady(page)

    await expect(page.locator('h2:has-text("Browser Sessions")')).toHaveCount(0)
  })

  test('T5 — RH Portal + Tableau/CCSP health tiles absent on L3 (BKL-HERO-10)', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(ADMIN_PATH)
    await waitForAdminReady(page)

    // SessionHealthPanel renders these tile labels only when not L3.
    const healthPanel = page.locator('h2:has-text("Data Source Health")').locator('..')
    await expect(healthPanel.locator('text=RH Portal')).toHaveCount(0)
    await expect(healthPanel.locator('text=Tableau / CCSP')).toHaveCount(0)
    // Salesforce tile is unaffected.
    await expect(healthPanel.locator('text=Salesforce').first()).toBeVisible({ timeout: 10_000 })
  })

  test('T6 — CCSP + RH Cases scheduler rows absent on L3 (BKL-HERO-13)', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(ADMIN_PATH)
    await waitForAdminReady(page)

    const scheduler = page.locator('h2:has-text("Scheduler Config")').locator('..')
    await expect(scheduler.locator('text=CCSP')).toHaveCount(0)
    await expect(scheduler.locator('text=RH Cases interval')).toHaveCount(0)
    await expect(scheduler.locator('text=RH Cases')).toHaveCount(0)
    // Territory + SF Pipeline rows must remain.
    await expect(scheduler.locator('text=Territory').first()).toBeVisible({ timeout: 10_000 })
    await expect(scheduler.locator('text=SF Pipeline').first()).toBeVisible()
  })
})
