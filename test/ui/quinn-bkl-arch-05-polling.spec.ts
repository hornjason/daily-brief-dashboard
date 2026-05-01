/**
 * Quinn QA — BKL-ARCH-05 verification (usePolledStatus migration).
 *
 * Read-only smoke against 7777. Verifies the polling contexts that were
 * migrated to the new usePolledStatus hook still load status data on mount
 * without console errors and without infinite loading skeletons.
 */
import { test, expect } from '../fixtures'
import * as fs from 'node:fs'

const CUSTOMER = 'A10 Networks'

function captureConsole(page: import('@playwright/test').Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  return errors
}

test.describe('BKL-ARCH-05 — usePolledStatus migration smoke', () => {
  test('Customer detail loads with AccountIntelligence + AccountPlan panels', async ({ page }) => {
    const errors = captureConsole(page)
    await page.goto(`/dashboard/customer/${encodeURIComponent(CUSTOMER)}`, { waitUntil: 'domcontentloaded' })

    await expect(page.locator('text=Account Intelligence').first()).toBeVisible({ timeout: 15000 })
    await expect(page.locator('text=Account Plan').first()).toBeVisible({ timeout: 15000 })

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
    await page.screenshot({ path: '/tmp/qa-arch05-customer-detail.png', fullPage: true })

    const polledErrors = errors.filter((e) => /usePolledStatus|polling|aborted/i.test(e))
    expect(polledErrors, `unexpected console errors: ${polledErrors.join(' | ')}`).toEqual([])
  })

  test('Setup page renders without polling errors and screenshot for review', async ({ page }) => {
    const errors = captureConsole(page)
    await page.goto('/dashboard/setup', { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
    await page.screenshot({ path: '/tmp/qa-arch05-setup.png', fullPage: true })
    const text = await page.locator('body').innerText()
    fs.writeFileSync('/tmp/qa-arch05-setup.txt', text)
    expect(text.length).toBeGreaterThan(100)
    const polledErrors = errors.filter((e) => /usePolledStatus|polling/i.test(e))
    expect(polledErrors).toEqual([])
  })

  test('Admin page renders without polling errors and screenshot for review', async ({ page }) => {
    const errors = captureConsole(page)
    await page.goto('/dashboard/admin', { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
    await page.screenshot({ path: '/tmp/qa-arch05-admin.png', fullPage: true })
    const text = await page.locator('body').innerText()
    fs.writeFileSync('/tmp/qa-arch05-admin.txt', text)
    expect(text.length).toBeGreaterThan(100)
    const polledErrors = errors.filter((e) => /usePolledStatus|polling/i.test(e))
    expect(polledErrors).toEqual([])
  })
})
