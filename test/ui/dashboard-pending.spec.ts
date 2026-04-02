/**
 * Dashboard — pending tests for gap backlog items #4 and #6.
 *
 * These are written now as test.skip to be activated when the
 * corresponding features are built. They document expected behavior
 * for per-section refresh buttons and per-section error display.
 */
import { test, expect } from '../fixtures'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'

test.describe('Dashboard — per-section refresh (gap backlog #6)', () => {
  test.skip('Refresh button visible in RH Cases section', async ({ page }) => {
    // Will be enabled when gap backlog #6 is implemented
    await page.goto(`${BASE_URL}/dashboard`)
    await expect(page.getByTestId('rh-cases-refresh')).toBeVisible()
  })

  test.skip('Refresh button triggers cases reload', async ({ page }) => {
    // Will be enabled when gap backlog #6 is implemented
    await page.goto(`${BASE_URL}/dashboard`)
    const refreshBtn = page.getByTestId('rh-cases-refresh')
    let refreshCalled = false
    await page.route('**/api/cases/**', route => { refreshCalled = true; route.continue() })
    await refreshBtn.click()
    expect(refreshCalled).toBe(true)
  })
})

test.describe('Dashboard — error display (gap backlog #4)', () => {
  test.skip('CloudSpend section shows error when API fails', async ({ page }) => {
    // Will be enabled when gap backlog #4 is implemented
    await page.route('**/api/ccsp', route => route.fulfill({ status: 500, body: '{"error":"test"}' }))
    await page.goto(`${BASE_URL}/dashboard`)
    await expect(page.getByTestId('cloudspend-error')).toBeVisible()
  })

  test.skip('Pipeline section shows error when API fails', async ({ page }) => {
    // Will be enabled when gap backlog #4 is implemented
    await page.route('**/api/pipeline', route => route.fulfill({ status: 500, body: '{"error":"test"}' }))
    await page.goto(`${BASE_URL}/dashboard`)
    await expect(page.getByTestId('pipeline-error')).toBeVisible()
  })
})
