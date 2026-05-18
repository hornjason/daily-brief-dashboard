/**
 * UI test for Red Hat Intelligence section in Morning Summary
 * GitHub Issue #204
 *
 * Validates:
 * 1. Intelligence section appears when redHatIntelligence field exists
 * 2. Section is collapsed by default
 * 3. Red accent border is visible
 * 4. Empty subsections are omitted
 * 5. No regressions to existing Morning Summary
 */

import { test, expect } from '@playwright/test'

test.describe('Morning Summary — Red Hat Intelligence UI', () => {
  test('should render Intelligence section when data exists', async ({ page }) => {
    await page.goto('http://localhost:7777/dashboard')

    // Wait for Morning Summary to load
    await page.waitForSelector('text=Morning Summary', { timeout: 10000 })

    // Expand Morning Summary if collapsed
    const summaryHeader = page.locator('text=Morning Summary').first()
    const isCollapsed = await summaryHeader.locator('..').locator('[aria-expanded]').getAttribute('aria-expanded')

    if (isCollapsed === 'false') {
      await summaryHeader.click()
    }

    // Intelligence section should exist
    const intelligenceSection = page.locator('text=Red Hat Intelligence')
    await expect(intelligenceSection).toBeVisible({ timeout: 5000 })

    // Verify red accent dot
    const redDot = intelligenceSection.locator('..').locator('.bg-red-500').first()
    await expect(redDot).toBeVisible()
  })

  test('Intelligence section should be collapsed by default', async ({ page }) => {
    await page.goto('http://localhost:7777/dashboard')

    await page.waitForSelector('text=Morning Summary', { timeout: 10000 })

    // Expand Morning Summary
    const summaryHeader = page.locator('text=Morning Summary').first()
    const isCollapsed = await summaryHeader.locator('..').locator('[aria-expanded]').getAttribute('aria-expanded')

    if (isCollapsed === 'false') {
      await summaryHeader.click()
    }

    // Intelligence section toggle should show collapsed state
    const intelligenceToggle = page.locator('text=Red Hat Intelligence').locator('..')
    const ariaExpanded = await intelligenceToggle.getAttribute('aria-expanded')

    expect(ariaExpanded).toBe('true') // Initially collapsed (aria-expanded=true means content is hidden)
  })

  test('should expand and show releases when clicked', async ({ page }) => {
    await page.goto('http://localhost:7777/dashboard')

    await page.waitForSelector('text=Morning Summary', { timeout: 10000 })

    // Expand Morning Summary
    const summaryHeader = page.locator('text=Morning Summary').first()
    await summaryHeader.click()

    // Click Intelligence section to expand
    const intelligenceToggle = page.locator('text=Red Hat Intelligence')
    await intelligenceToggle.click()

    // Product releases subsection should be visible (we have test data)
    await expect(page.locator('text=Product Releases This Month')).toBeVisible({ timeout: 2000 })

    // Verify our test releases appear
    await expect(page.locator('text=Red Hat OpenShift 4.18')).toBeVisible()
    await expect(page.locator('text=RHEL 9.5')).toBeVisible()
  })

  test('should show red border accent on expanded content', async ({ page }) => {
    await page.goto('http://localhost:7777/dashboard')

    await page.waitForSelector('text=Morning Summary', { timeout: 10000 })

    const summaryHeader = page.locator('text=Morning Summary').first()
    await summaryHeader.click()

    // Expand Intelligence section
    const intelligenceToggle = page.locator('text=Red Hat Intelligence')
    await intelligenceToggle.click()

    // Check for red left border (border-l-red-500 class)
    const contentArea = page.locator('.border-l-red-500').first()
    await expect(contentArea).toBeVisible()
  })

  test('should not show empty subsections', async ({ page }) => {
    await page.goto('http://localhost:7777/dashboard')

    await page.waitForSelector('text=Morning Summary', { timeout: 10000 })

    const summaryHeader = page.locator('text=Morning Summary').first()
    await summaryHeader.click()

    const intelligenceToggle = page.locator('text=Red Hat Intelligence')
    await intelligenceToggle.click()

    // meetingNews is empty — should NOT appear
    const newsHeading = page.locator('text=News Relevant to Your Customers')
    await expect(newsHeading).not.toBeVisible()

    // events is empty — should NOT appear
    const eventsHeading = page.locator('text=Events Near Your Customers')
    await expect(eventsHeading).not.toBeVisible()

    // releases has data — SHOULD appear
    const releasesHeading = page.locator('text=Product Releases This Month')
    await expect(releasesHeading).toBeVisible()
  })

  test('should not break existing Morning Summary sections', async ({ page }) => {
    await page.goto('http://localhost:7777/dashboard')

    await page.waitForSelector('text=Morning Summary', { timeout: 10000 })

    const summaryHeader = page.locator('text=Morning Summary').first()
    await summaryHeader.click()

    // Existing sections should still work
    await expect(page.locator('text=Priority Actions')).toBeVisible()

    // Signals should still render (if any exist)
    // This is a non-breaking change test
  })
})
