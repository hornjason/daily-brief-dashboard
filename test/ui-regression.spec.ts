/**
 * UI Regression Tests — visual and interactive regressions for BKL items
 *
 * These tests verify UI-only fixes that require browser-level validation.
 * Tagged @live where they need real data from a running server.
 *
 * Requires the server to be running:
 *   bun run server.ts &
 *
 * Run:
 *   npx playwright test test/ui-regression.spec.ts
 */
import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'

// Helper: find a customer name from the live API
async function getCustomerByCondition(
  page: import('@playwright/test').Page,
  condition: (c: any) => boolean
): Promise<string | null> {
  const res = await page.request.get(`${BASE_URL}/api/accounts`)
  if (!res.ok()) return null
  const data = await res.json()
  const match = data.customers?.find(condition)
  return match?.name ?? null
}

// ── UI-REG-001: Sidebar sticky scroll on customer detail (BKL-UX-sidebar-scroll) ──

test.describe('UI-REG-001: Sidebar sticky on customer detail', () => {
  test('sidebar aside stays visible after scrolling down 1000px', async ({ page }) => {
    // Find a customer with data
    const customerName = await getCustomerByCondition(page, (c: any) => c.name === 'Applied Medical')
    test.skip(!customerName, 'No customer named Applied Medical found')

    await page.goto(`${BASE_URL}/dashboard/customer/${encodeURIComponent(customerName!)}`)
    await page.waitForLoadState('networkidle')

    // Verify aside element exists
    const aside = page.locator('aside')
    await expect(aside).toBeVisible({ timeout: 10000 })

    // Scroll down 1000px
    await page.evaluate(() => window.scrollTo(0, 1000))
    await page.waitForTimeout(500)

    // The aside should still be in the viewport (sticky positioning)
    const isInViewport = await page.evaluate(() => {
      const el = document.querySelector('aside')
      if (!el) return false
      const rect = el.getBoundingClientRect()
      // At least part of the aside should be visible in the viewport
      return rect.top < window.innerHeight && rect.bottom > 0
    })

    expect(isInViewport).toBe(true)

    // Verify sticky positioning
    const position = await page.evaluate(() => {
      const el = document.querySelector('aside')
      if (!el) return 'none'
      return getComputedStyle(el).position
    })

    expect(position).toBe('sticky')
  })
})

// ── UI-REG-002: Morning Summary starts collapsed (BKL-UX-morning-min) ──

test.describe('UI-REG-002: Morning Summary collapsed on load', () => {
  test('Morning Summary signal list is not expanded when >3 signals exist', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`)
    await page.waitForLoadState('networkidle')

    // Wait for morning summary to load
    await page.waitForTimeout(2000)

    // Check if the Morning Summary section exists and has signals
    const summaryHeader = page.locator('h3:has-text("Morning Summary")')
    const headerVisible = await summaryHeader.isVisible().catch(() => false)
    test.skip(!headerVisible, 'Morning Summary section not present')

    // The toggle button has aria-expanded — check that it's collapsed (false)
    const toggleBtn = page.locator('button[aria-expanded]').filter({ hasText: 'Morning Summary' })
    const toggleVisible = await toggleBtn.isVisible().catch(() => false)
    test.skip(!toggleVisible, 'Morning Summary toggle button not found')

    // When >3 signals, the button should have aria-expanded="false" (collapsed)
    const ariaExpanded = await toggleBtn.getAttribute('aria-expanded')
    expect(ariaExpanded).toBe('false')

    // Additionally: the chevron-down icon should be visible (indicates collapsed state)
    // and the full signal cards (with severity bars) should NOT be rendered
    const signalCards = page.locator('#section-morning .space-y-2 button')
    const signalCardCount = await signalCards.count()
    expect(signalCardCount).toBe(0)
  })
})

// ── UI-REG-003: No empty segment badge (BKL-REG-15/17) ──

test.describe('UI-REG-003: Segment badge absent when no segment', () => {
  test('customer without segment shows no empty grey badge', async ({ page }) => {
    // Find a customer without segment
    const customerName = await getCustomerByCondition(
      page,
      (c: any) => !c.segment || c.segment.trim() === ''
    )
    test.skip(!customerName, 'No customer without segment found')

    await page.goto(`${BASE_URL}/dashboard/customer/${encodeURIComponent(customerName!)}`)
    await page.waitForLoadState('networkidle')

    // The header area should have the customer name and health badge
    await expect(page.locator(`h1:has-text("${customerName}")`)).toBeVisible()

    // There should be NO empty segment badge element
    // Use evaluate to check for any visible empty badge-like elements near the header
    const hasEmptySegmentBadge = await page.evaluate(() => {
      const h1 = document.querySelector('h1')
      if (!h1) return false
      // Look in the header area for segment-related elements
      const parent = h1.parentElement
      if (!parent) return false
      const allElements = parent.querySelectorAll('span, div')
      for (const el of allElements) {
        const text = (el.textContent || '').trim()
        const cls = el.className || ''
        // Check for empty visible elements that look like segment badges
        if ((cls.includes('segment') || cls.includes('badge')) && text === '' && el.offsetWidth > 0) {
          return true
        }
      }
      return false
    })

    expect(hasEmptySegmentBadge).toBe(false)
  })
})

// ── UI-REG-004: Admin nav item in sidebar (BKL-REG-12) ──

test.describe('UI-REG-004: Admin nav item exists', () => {
  test('sidebar has distinct Admin item that navigates to /dashboard/admin', async ({ page }) => {
    // Use a wide viewport to ensure sidebar is visible
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(`${BASE_URL}/dashboard`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Find the Admin link (it's an <a> inside the nav)
    const adminLink = page.locator('a[href*="admin"]')
    await expect(adminLink.first()).toBeVisible({ timeout: 10000 })

    // Click the Admin nav item
    await adminLink.first().click()
    await page.waitForURL('**/dashboard/admin', { timeout: 5000 })

    // Verify we navigated to the admin page
    expect(page.url()).toContain('/dashboard/admin')
  })

  test('Settings nav item does NOT navigate to /dashboard/admin', async ({ page }) => {
    // Use a wide viewport to ensure sidebar is visible
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(`${BASE_URL}/dashboard`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Find the Settings button
    const settingsButton = page.getByRole('button', { name: 'Settings' })
    await expect(settingsButton).toBeVisible({ timeout: 10000 })

    // Click Settings
    await settingsButton.click()
    await page.waitForTimeout(1000)

    // Should NOT be at /dashboard/admin
    expect(page.url()).not.toContain('/dashboard/admin')
  })
})

// ── UI-REG-005: Account Portfolio controls (BKL-REG-16) ──

test.describe('UI-REG-005: Account Portfolio has search and filters', () => {
  test('portfolio section contains search input, AE filter, and view controls', async ({ page }) => {
    // Use a wide viewport to ensure sidebar is visible
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(`${BASE_URL}/dashboard`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Navigate to accounts view (use exact + aria-label to avoid matching AE account buttons)
    const accountsButton = page.locator('button[aria-label="Accounts"]')
    await expect(accountsButton).toBeVisible({ timeout: 10000 })
    await accountsButton.click()
    await page.waitForTimeout(2000)

    // Verify Account Portfolio heading exists
    const portfolioHeading = page.locator('h2:has-text("Account Portfolio")')
    await expect(portfolioHeading).toBeVisible({ timeout: 10000 })

    // Search bar should be present
    const searchInput = page.locator('input[placeholder*="Search"]')
    await expect(searchInput).toBeVisible()

    // AE filter dropdown should be present
    const aeFilter = page.locator('select, [role="combobox"]').filter({ hasText: /AE|All AEs/ })
    const aeFilterVisible = await aeFilter.isVisible().catch(() => false)
    expect(aeFilterVisible).toBe(true)

    // View toggle buttons should be present (at least "By AE" and one other)
    const viewButtons = page.locator('button:has-text("By AE"), button:has-text("List"), button:has-text("All"), button:has-text("Triage")')
    const viewCount = await viewButtons.count()
    expect(viewCount).toBeGreaterThanOrEqual(2)
  })
})

// ── UI-REG-006: Pod banner case count matches KPI tile (BKL-REG-08) ──

test.describe('UI-REG-006: Pod banner case count matches KPI', () => {
  test('banner open cases count equals KPI tile Open Cases count', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`)
    await page.waitForLoadState('networkidle')

    // Wait for data to load
    await page.waitForTimeout(3000)

    // Extract banner case count (e.g., "52 open cases")
    const bannerText = await page.locator('text=/\\d+ open cases/').textContent()
    const bannerCount = bannerText ? parseInt(bannerText.match(/(\d+) open cases/)?.[1] ?? '0') : 0

    // Extract KPI tile case count
    // The KPI tile has "Open Cases" label with a number above it
    const kpiSection = page.locator('text="Open Cases"').locator('..')
    const kpiText = await kpiSection.textContent()
    // Extract the number from the KPI tile text
    const kpiMatch = kpiText?.match(/^(\d+)/)
    const kpiCount = kpiMatch ? parseInt(kpiMatch[1]) : -1

    expect(bannerCount).toBe(kpiCount)
  })
})

// ── UI-REG-007: Product Intelligence section not collapsed on NONE (BKL-REG-14) ──

test.describe('UI-REG-007: Product Intelligence visible despite NONE scores', () => {
  test('product intelligence section remains visible on customer detail', async ({ page }) => {
    const customerName = await getCustomerByCondition(page, (c: any) => c.name === 'Applied Medical')
    test.skip(!customerName, 'No customer named Applied Medical found')

    await page.goto(`${BASE_URL}/dashboard/customer/${encodeURIComponent(customerName!)}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Product Intelligence heading should be visible
    const productIntelHeading = page.locator('h2:has-text("Product Intelligence")')
    await expect(productIntelHeading).toBeVisible({ timeout: 10000 })

    // Even if a product has NONE, the section should still be visible
    // Check that there are product rows (Generate buttons or scored products)
    const productItems = page.locator('button:has-text("Generate"), button:has-text("NONE"), button:has-text("HIGH"), button:has-text("MEDIUM"), button:has-text("LOW")')
    const productCount = await productItems.count()
    expect(productCount).toBeGreaterThanOrEqual(1)

    // The section should not be display:none or visibility:hidden
    const sectionVisible = await productIntelHeading.isVisible()
    expect(sectionVisible).toBe(true)
  })
})

// ── UI-REG-008: SF Sync Now status persists (BKL-REG-18) ──

test.describe('UI-REG-008: SF Sync Now status persists', () => {
  test('sync status shows persisted "Synced Xm ago" text', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await page.waitForLoadState('networkidle')

    // Expand Step 5 - Data Sources
    const step5 = page.locator('button:has-text("Step 5"), button:has-text("Data Sources")')
    const step5Visible = await step5.isVisible().catch(() => false)
    if (step5Visible) {
      await step5.click()
      await page.waitForTimeout(1000)
    }

    // Check if any Sync Now buttons exist
    const syncButtons = page.locator('button:has-text("Sync Now")')
    const syncCount = await syncButtons.count()
    test.skip(syncCount === 0, 'No Sync Now buttons found - data sources not configured')

    // Check that existing sync statuses show persisted text
    const syncStatuses = page.locator('text=/Synced \\d+[mh] ago/')
    const statusCount = await syncStatuses.count()

    // At least one data source should show a persisted sync status
    expect(statusCount).toBeGreaterThanOrEqual(1)

    // Find a non-disabled Sync Now button and click it
    let clickedSync = false
    for (let i = 0; i < syncCount; i++) {
      const btn = syncButtons.nth(i)
      const disabled = await btn.isDisabled()
      if (!disabled) {
        // Record the row text before clicking
        const parentText = await btn.locator('..').locator('..').textContent()

        await btn.click()
        clickedSync = true

        // Wait for sync to start (should show syncing indicator)
        await page.waitForTimeout(3000)

        // The status should still be visible (not disappeared)
        // Either "Syncing" or the persisted "Synced" text should be present
        const statusVisible = await page.locator('text=/Syncing|Synced/').count()
        expect(statusVisible).toBeGreaterThanOrEqual(1)
        break
      }
    }

    test.skip(!clickedSync, 'All Sync Now buttons are disabled - SF session may not be active')
  })
})

// ── UI-REG-009: Per-customer case count in list view (BKL-REG-19) ──

test.describe('UI-REG-009: List view shows name-matched case counts', () => {
  test('customer with cases via name-match shows count > 0 in list view', async ({ page }) => {
    // First, find a customer with no accountNumbers that has name-matched cases
    const accountsRes = await page.request.get(`${BASE_URL}/api/accounts`)
    const accountsData = await accountsRes.json()
    const noAcctCustomers = (accountsData.customers ?? []).filter(
      (c: any) => !c.accountNumbers || c.accountNumbers.length === 0
    )

    const casesRes = await page.request.get(`${BASE_URL}/api/cases/all`)
    const casesData = await casesRes.json()
    const allCases = casesData.cases ?? []
    const caseNameSet = new Set(allCases.map((c: any) => (c.customerName ?? '').toLowerCase()))

    const matchingCustomer = noAcctCustomers.find(
      (c: any) => caseNameSet.has(c.name.toLowerCase())
    )
    test.skip(!matchingCustomer, 'No customer without accountNumbers has a name-matched case')

    // Navigate to dashboard and switch to list view
    await page.goto(`${BASE_URL}/dashboard`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Scroll to accounts section
    const accountsButton = page.locator('button[aria-label="Accounts"]')
    await accountsButton.click()
    await page.waitForTimeout(1000)

    // Switch to list view
    const listButton = page.locator('button:has-text("List")')
    await listButton.click()
    await page.waitForTimeout(1000)

    // Find the customer row in the list
    const customerRow = page.locator(`tr:has-text("${matchingCustomer.name}")`)
    const rowVisible = await customerRow.isVisible().catch(() => false)
    test.skip(!rowVisible, `Customer "${matchingCustomer.name}" not visible in list view`)

    // The Cases column value should be > 0 for this customer
    const casesCell = customerRow.locator('td').last()
    const casesText = await casesCell.textContent()
    const casesCount = parseInt(casesText ?? '0', 10)
    expect(casesCount).toBeGreaterThan(0)
  })
})
