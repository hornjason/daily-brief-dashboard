import { test, expect } from '@playwright/test'

/**
 * BKL-HERO-01 Phase 5 — "Open Dashboard" button placement for L3 hero installs.
 *
 * Test env: 7776, NODE_ROLE unset (L3), seed data has 2 AEs.
 * We mock /api/regions/access to control enabledPods state.
 */

test.describe('@destructive BKL-HERO-01 Phase 5: hero Open Dashboard button', () => {
  test.describe.configure({ mode: 'serial' })

  test('T1 — L3 + AEs present: Open Dashboard button visible after AEs section', async ({ page }) => {
    // Seed data has 2 AEs — aeCount > 0 should be true
    await page.goto('/dashboard/setup')
    // Wait for AE count to load
    await page.waitForTimeout(1500)
    const btn = page.locator('[data-testid="hero-open-dashboard"]')
    await expect(btn).toBeVisible({ timeout: 10000 })
    // Verify it links to /dashboard
    const link = btn.locator('a')
    await expect(link).toHaveAttribute('href', '/dashboard')
    await expect(link).toContainText('Open Dashboard')
  })

  test('T2 — L3 + AEs present: button does NOT appear inside Refresh Timer section', async ({ page }) => {
    // On L3 the Refresh Timer section is hidden entirely, so the L4 Open Dashboard
    // inside it should never appear
    await page.goto('/dashboard/setup')
    await page.waitForTimeout(1500)
    // The L4 button lives inside the "settings" AccordionSection which is hidden on L3
    const settingsSection = page.locator('[data-testid="accordion-settings"], #accordion-settings')
    await expect(settingsSection).toHaveCount(0)
  })

  test('T3 — button has correct href and styling', async ({ page }) => {
    await page.goto('/dashboard/setup')
    await page.waitForTimeout(1500)
    const link = page.locator('[data-testid="hero-open-dashboard"] a')
    await expect(link).toBeVisible({ timeout: 10000 })
    await expect(link).toHaveAttribute('href', '/dashboard')
    // Verify it carries the accent styling (not a plain text link)
    const classes = await link.getAttribute('class') ?? ''
    expect(classes).toContain('bg-accent')
  })
})
