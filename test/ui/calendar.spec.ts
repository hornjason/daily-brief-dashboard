/**
 * COUNCIL-13: Calendar section tests
 *
 * Validates that the #section-calendar element renders on dashboard load,
 * and that empty calendar data shows a meaningful empty-state message.
 *
 * Uses page.route() to mock /api/calendar responses. All tests are
 * non-destructive and target production (BASE_URL / 7777).
 */
import { test } from '../fixtures'
import { expect } from '@playwright/test'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'

test.describe('COUNCIL-13: Calendar section', () => {
  test('section-calendar renders on dashboard load', async ({ page }) => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })

    const calendarSection = page.locator('#section-calendar')
    await expect(calendarSection).toBeVisible({ timeout: 15000 })
  })

  test('CalendarStrip component renders inside the section', async ({ page }) => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })

    const calendarSection = page.locator('#section-calendar')
    await expect(calendarSection).toBeVisible({ timeout: 15000 })

    // CalendarStrip renders an h2 "Open Pipeline" is pipeline, calendar renders Calendar icon
    // or a heading. The CalendarStrip wraps content in a bg-surface rounded-xl container.
    const calendarCard = calendarSection.locator('.bg-surface')
    await expect(calendarCard.first()).toBeVisible({ timeout: 10000 })
  })

  test('empty calendar data shows "No meetings" empty state', async ({ page }) => {
    // Mock calendar endpoints to return empty arrays
    await page.route(url => url.pathname === '/api/calendar', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ events: [] }),
      })
    )
    await page.route(url => url.pathname === '/api/calendar/all', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ events: [] }),
      })
    )
    // Also catch query-param variants: /api/calendar?ae=...
    await page.route(url => url.pathname.startsWith('/api/calendar'), route => {
      if (route.request().url().includes('/api/calendar')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ events: [] }),
        })
      }
      return route.fallback()
    })

    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })

    const calendarSection = page.locator('#section-calendar')
    await expect(calendarSection).toBeVisible({ timeout: 15000 })

    // CalendarStrip renders EmptyState with "No meetings this week" or "No meetings today"
    // when the events array is empty.
    const emptyMessage = calendarSection.locator('text=/No meetings/i')
    await expect(emptyMessage.first()).toBeVisible({ timeout: 10000 })
  })

  test('calendar section is not blank — contains visible child content', async ({ page }) => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })

    const calendarSection = page.locator('#section-calendar')
    await expect(calendarSection).toBeVisible({ timeout: 15000 })

    // The section must not be empty — it should contain at least one visible child
    // (either calendar events or the empty state message)
    const childCount = await calendarSection.locator('*:visible').count()
    expect(childCount, 'Calendar section must contain visible child elements').toBeGreaterThan(0)
  })
})
