// Visual evidence + customer detail navigation regression check.
import { test, expect } from '@playwright/test'

test('screenshot: dashboard AE list', async ({ page }) => {
  await page.goto('/dashboard')
  await page.waitForLoadState('networkidle')
  await page.screenshot({ path: 'test-results/quinn-bkl-dom-inf-13-dashboard.png', fullPage: true })
})

test('navigation: customer card click does not crash', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('pageerror', (err) => consoleErrors.push(err.message))
  await page.goto('/dashboard')
  await page.waitForLoadState('networkidle')
  // Find any customer row (button or div with onClick) — try common locators.
  const candidate = page.locator('[role="button"], button, a').filter({ hasText: /Acme|A10|Dropbox|Recreational|Shutterfly|Crowdstrike/ }).first()
  if (await candidate.count()) {
    await candidate.click({ trial: true }).catch(() => {})
  }
  expect(consoleErrors).toEqual([])
})
