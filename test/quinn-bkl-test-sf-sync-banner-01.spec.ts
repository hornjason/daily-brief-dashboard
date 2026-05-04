/**
 * BKL-TEST-SF-SYNC-BANNER-01 — SF Pipeline Sync panel spot-check.
 *
 * Validates that the "SF Pipeline Sync" panel added to SetupPage.tsx
 * (Step 3 of 5 — Connections accordion) renders correctly on production.
 *
 * Non-destructive: does NOT click the Sync Now button.
 * Targets: production (7777) via ci project.
 */

import { test, expect } from './fixtures'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'

test('BKL-TEST-SF-SYNC-BANNER-01 — SF Pipeline Sync panel renders in Step 3 accordion', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    if (msg.text().includes('/api/briefs/pregen')) return
    consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => {
    const msg = err.message ?? String(err)
    if (msg.includes('/api/briefs/pregen')) return
    consoleErrors.push(`pageerror: ${msg}`)
  })

  // Navigate to setup page
  await page.goto(`${BASE}/dashboard/setup`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.screenshot({ path: '/tmp/qa-sf-sync-01-setup-load.png' })

  // Assert no console errors on initial load
  expect(
    consoleErrors,
    `Console errors on setup page load: ${consoleErrors.join(' | ')}`,
  ).toHaveLength(0)

  // Open Step 3 of 5 — Connections accordion by clicking its header
  const accordionHeader = page.getByText('Step 3 of 5 — Connections').first()
  await expect(accordionHeader).toBeVisible({ timeout: 10_000 })
  await accordionHeader.click()

  // Brief settle for accordion animation
  await page.waitForLoadState('domcontentloaded')
  await page.screenshot({ path: '/tmp/qa-sf-sync-02-step3-open.png' })

  // SF Pipeline Sync label must be visible
  await expect(page.getByText('SF Pipeline Sync')).toBeVisible({ timeout: 10_000 })

  // Sync Now button must be present, visible, enabled, and carry the correct test ID
  const syncBtn = page.locator('[data-testid="sf-sync-btn"]')
  await expect(syncBtn).toBeVisible({ timeout: 10_000 })
  await expect(syncBtn).toHaveText('Sync Now')
  await expect(syncBtn).toBeEnabled()

  await page.screenshot({ path: '/tmp/qa-sf-sync-03-panel-confirmed.png' })

  // Success banner must NOT be visible in initial state (no sync triggered)
  const successBanner = page.locator('[data-testid="sf-sync-success"]')
  await expect(successBanner).toHaveCount(0)

  // Final console error check
  expect(
    consoleErrors,
    `Console errors after accordion interaction: ${consoleErrors.join(' | ')}`,
  ).toHaveLength(0)
})
