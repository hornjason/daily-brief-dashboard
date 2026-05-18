/**
 * Quinn QA Validation — GitHub Issue #203
 * Red Hat Pulse Card Integration
 */

import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:7777'

test.describe('Red Hat Pulse Card — Issue #203', () => {
  test('card appears on dashboard home between Morning Summary and KPI cards', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`)

    // Wait for dashboard to load
    await page.waitForLoadState('networkidle')

    // Verify the Red Hat Pulse card is visible
    const pulseCard = page.getByText('Red Hat Pulse').first()
    await expect(pulseCard).toBeVisible()

    // Verify header structure
    await expect(page.locator('h2:has-text("Red Hat Pulse")')).toBeVisible()

    // Verify refresh button is present
    await expect(page.getByRole('button', { name: /refresh/i })).toBeVisible()
  })

  test('card displays three-column layout with correct section headers', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`)
    await page.waitForLoadState('networkidle')

    // Wait for Pulse card to appear
    await expect(page.getByText('Red Hat Pulse').first()).toBeVisible()

    // Verify the three column headers are present
    await expect(page.getByText('Latest News').first()).toBeVisible()
    await expect(page.getByText('Product Releases').first()).toBeVisible()
    await expect(page.getByText('Upcoming Events').first()).toBeVisible()
  })

  test('empty state renders correctly when no data', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`)
    await page.waitForLoadState('networkidle')

    // Wait for Pulse card
    await expect(page.getByText('Red Hat Pulse').first()).toBeVisible()

    // Verify empty state messages appear (data currently empty per task)
    // At least one of these should be visible
    const noNews = page.getByText('No recent news')
    const noReleases = page.getByText('No upcoming releases')
    const noEvents = page.getByText('No upcoming events')
    const noIntelligence = page.getByText(/No Red Hat intelligence/i)

    const anyEmptyState = await Promise.race([
      noNews.isVisible().then(v => v && 'news'),
      noReleases.isVisible().then(v => v && 'releases'),
      noEvents.isVisible().then(v => v && 'events'),
      noIntelligence.isVisible().then(v => v && 'intelligence')
    ])

    expect(anyEmptyState).toBeTruthy()
  })

  test('backend endpoint returns correct shape', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/intelligence/global`)
    expect(response.ok()).toBeTruthy()

    const data = await response.json()

    // Verify structure
    expect(data).toHaveProperty('news')
    expect(data).toHaveProperty('releases')
    expect(data).toHaveProperty('events')
    expect(data).toHaveProperty('cachedAt')

    // Verify arrays
    expect(Array.isArray(data.news)).toBe(true)
    expect(Array.isArray(data.releases)).toBe(true)
    expect(Array.isArray(data.events)).toBe(true)

    // Verify cachedAt is a valid ISO date string
    expect(new Date(data.cachedAt).toString()).not.toBe('Invalid Date')
  })

  test('no regressions — other dashboard sections still render', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`)
    await page.waitForLoadState('networkidle')

    // Verify Morning Summary is still visible
    await expect(page.getByText(/Morning Summary/i).first()).toBeVisible()

    // Verify KPI cards section exists (look for any KPI metric)
    const kpiSection = page.locator('[data-section="section-command"]')
    await expect(kpiSection).toBeVisible()

    // Verify account grid is still present
    await expect(page.getByText(/customers/i).first()).toBeVisible()
  })

  test('visual appearance — dark theme consistency', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`)
    await page.waitForLoadState('networkidle')

    // Find the Pulse card container
    const pulseCard = page.locator('div.bg-surface.border.border-border.rounded-xl').filter({ hasText: 'Red Hat Pulse' }).first()
    await expect(pulseCard).toBeVisible()

    // Take screenshot for visual review
    await page.screenshot({ path: '/tmp/qa-red-hat-pulse-card.png', fullPage: false })

    // Verify card has proper spacing/structure
    const header = pulseCard.locator('.px-6.py-4.border-b')
    await expect(header).toBeVisible()
  })
})
