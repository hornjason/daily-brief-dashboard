/**
 * BKL-HERO-02 — Region Access section on Admin page.
 *
 * Verifies the Region Access section renders correctly on /dashboard/admin.
 * Uses the live 7776 test container — no mocking needed.
 * Seed data has enabledRegions/enabledPods set, so Step0RegionAccess should
 * render in summary mode (Edit button visible) or form mode.
 *
 * Tagged @destructive — runs against the test container (7776).
 */
import { test, expect } from '@playwright/test'

test.describe('Admin page — Region Access section @destructive', () => {
  test('T1: Admin page has a Region Access section', async ({ page }) => {
    await page.goto('/dashboard/admin')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('[data-testid="admin-region-access"]')).toBeVisible({ timeout: 10000 })
  })

  test('T2: Region Access section renders the Step0RegionAccess component', async ({ page }) => {
    await page.goto('/dashboard/admin')
    await page.waitForLoadState('networkidle')

    const section = page.locator('[data-testid="admin-region-access"]')
    await expect(section).toBeVisible({ timeout: 10000 })

    // The component renders either summary mode (Edit button) or form mode (checkboxes).
    // Wait for the loading state to resolve first.
    await expect(section.locator('p').filter({ hasText: 'Loading...' })).toHaveCount(0, { timeout: 8000 }).catch(() => {
      // Loading may already be gone — that's fine
    })

    // Either a summary state or an Edit button (summary mode) should be present,
    // OR the catalog form is showing. The component always renders one of these.
    const hasSummaryOrForm = await section
      .locator('button, input[type="checkbox"]')
      .first()
      .isVisible({ timeout: 8000 })
      .catch(() => false)

    expect(hasSummaryOrForm).toBe(true)
  })

  test('T3: Region Access section heading is visible', async ({ page }) => {
    await page.goto('/dashboard/admin')
    await page.waitForLoadState('networkidle')

    const section = page.locator('[data-testid="admin-region-access"]')
    await expect(section).toBeVisible({ timeout: 10000 })
    await expect(section.locator('h2', { hasText: 'Region Access' })).toBeVisible({ timeout: 5000 })
  })
})
