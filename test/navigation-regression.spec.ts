/**
 * Navigation Regression Tests — cross-page navigation via sidebar
 *
 * Regression for BKL-W4-QA1: user navigated to /dashboard/products then
 * clicked a sidebar nav item and stayed on the product page instead of
 * navigating back to the dashboard.
 *
 * These are browser-level tests using Playwright page interactions.
 *
 * Requires the server to be running:
 *   bun run server.ts &
 * Or against the container:
 *   podman run --rm -p 7777:7777 localhost/daily-brief-dashboard
 *
 * Run:
 *   npx playwright test test/navigation-regression.spec.ts
 */
import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'

// ── NAV-REG-001: From products page back to dashboard via sidebar nav ────────

test.describe('NAV-REG-001: Sidebar nav items navigate away from /dashboard/products', () => {
  const sidebarNavLabels = [
    'Morning Summary',
    'Command Center',
    'Pipeline',
    'Cloud Spend',
    'Calendar',
    'Accounts',
  ]

  for (const label of sidebarNavLabels) {
    test(`clicking "${label}" from /dashboard/products navigates to /dashboard`, async ({ page }) => {
      // Start on the products page
      await page.goto(`${BASE_URL}/dashboard/products`)
      await page.waitForLoadState('networkidle')

      // Verify we are on the products page
      expect(page.url()).toContain('/dashboard/products')

      // Click the sidebar nav item by its aria-label
      const navButton = page.locator(`aside button[aria-label="${label}"]`)
      await navButton.click()

      // Should navigate away from products to the main dashboard
      await page.waitForURL('**/dashboard', { timeout: 5000 })
      expect(page.url()).not.toContain('/dashboard/products')
    })
  }
})

// ── NAV-REG-002: Settings button navigates away from products page ───────────

test.describe('NAV-REG-002: Settings navigates away from /dashboard/products', () => {
  test('clicking Settings from /dashboard/products navigates to /dashboard/admin', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/products`)
    await page.waitForLoadState('networkidle')

    expect(page.url()).toContain('/dashboard/products')

    const settingsLink = page.locator('aside a[aria-label="Settings"]')
    await settingsLink.click()

    await page.waitForURL('**/dashboard/admin', { timeout: 5000 })
    expect(page.url()).toContain('/dashboard/admin')
  })
})

// ── NAV-REG-003: Products and Setup links navigate correctly ─────────────────

test.describe('NAV-REG-003: Products and Setup links navigate correctly from dashboard', () => {
  test('Products link navigates from /dashboard to /dashboard/products', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`)
    await page.waitForLoadState('networkidle')

    const productsLink = page.locator('aside a[aria-label="Products"]')
    await productsLink.click()

    await page.waitForURL('**/dashboard/products', { timeout: 5000 })
    expect(page.url()).toContain('/dashboard/products')
  })

  test('Setup link navigates from /dashboard to /dashboard/setup', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`)
    await page.waitForLoadState('networkidle')

    const setupLink = page.locator('aside a[aria-label="Setup"]')
    await setupLink.click()

    await page.waitForURL('**/dashboard/setup', { timeout: 5000 })
    expect(page.url()).toContain('/dashboard/setup')
  })

  test.skip('Products link navigates from /dashboard/setup to /dashboard/products', async ({ page }) => {
    // BKL-Q06: Setup page does not render the main Sidebar — sidebar nav not available on /setup route
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await page.waitForLoadState('networkidle')

    const productsLink = page.locator('aside a[aria-label="Products"]')
    await productsLink.click()

    await page.waitForURL('**/dashboard/products', { timeout: 5000 })
    expect(page.url()).toContain('/dashboard/products')
  })
})

// ── NAV-REG-004: Active state CSS after navigation ───────────────────────────

test.describe('NAV-REG-004: Active nav item has correct CSS class after navigation', () => {
  test('after navigating to dashboard, a sidebar nav item has the active accent class', async ({ page }) => {
    // Start on products, navigate back via a sidebar item
    await page.goto(`${BASE_URL}/dashboard/products`)
    await page.waitForLoadState('networkidle')

    const commandCenterBtn = page.locator('aside button[aria-label="Command Center"]')
    await commandCenterBtn.click()

    await page.waitForURL('**/dashboard', { timeout: 5000 })

    // The active nav item should have the accent color class
    await expect(commandCenterBtn).toHaveClass(/text-accent/)
  })

  test('Command Center button shows active class when on /dashboard', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`)
    await page.waitForLoadState('networkidle')

    // Command Center button should have the active accent styling when on /dashboard
    const commandCenterBtn = page.locator('aside button[aria-label="Command Center"]')
    await expect(commandCenterBtn).toHaveClass(/text-accent/)
  })
})

// ── NAV-REG-005: Customer detail back to dashboard ───────────────────────────

test.describe('NAV-REG-005: Navigation from customer detail page', () => {
  // BKL-Q06: CustomerDetailPage does not render the main Sidebar nav — skipped until sidebar added
  test.skip('sidebar nav items are visible on customer detail page', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/customer/TestCustomer`)
    await page.waitForLoadState('networkidle')

    const sidebar = page.locator('aside')
    await expect(sidebar).toBeVisible()

    const morningBtn = page.locator('aside button[aria-label="Morning Summary"]')
    await expect(morningBtn).toBeVisible()
  })

  test.skip('Products link works from customer detail page', async ({ page }) => {
    // BKL-Q06: CustomerDetailPage does not render the main Sidebar nav
    await page.goto(`${BASE_URL}/dashboard/customer/TestCustomer`)
    await page.waitForLoadState('networkidle')

    const productsLink = page.locator('aside a[aria-label="Products"]')
    await productsLink.click()

    await page.waitForURL('**/dashboard/products', { timeout: 5000 })
    expect(page.url()).toContain('/dashboard/products')
  })
})
