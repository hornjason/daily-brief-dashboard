import { test, expect } from '@playwright/test'

/**
 * Quinn — BKL-HERO-01 Prod audit (7777, NODE_ROLE=primary / L4 install)
 *
 * Verifies:
 *  1. /dashboard loads without JS errors
 *  2. /dashboard/setup loads without JS errors
 *  3. Refresh Timer accordion section IS present (L4 → settings section visible)
 *  4. hero-open-dashboard button does NOT appear on 7777
 */

const PROD = 'http://localhost:7777'

test.describe('BKL-HERO-01 prod audit — 7777 L4', () => {
  test.describe.configure({ mode: 'serial' })

  test('P1 — /dashboard loads without JS errors', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', err => consoleErrors.push(err.message))

    await page.goto(`${PROD}/dashboard`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: '/tmp/qa-7777-dashboard.png', fullPage: false })

    const filtered = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('net::ERR') && !e.includes('ResizeObserver')
    )
    console.log('Console errors (7777/dashboard):', JSON.stringify(filtered))
    expect(filtered, `Console errors on /dashboard: ${filtered.join('; ')}`).toHaveLength(0)
  })

  test('P2 — /dashboard/setup loads without JS errors', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', err => consoleErrors.push(err.message))

    await page.goto(`${PROD}/dashboard/setup`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: '/tmp/qa-7777-setup.png', fullPage: false })

    const filtered = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('net::ERR') && !e.includes('ResizeObserver')
    )
    console.log('Console errors (7777/setup):', JSON.stringify(filtered))
    expect(filtered, `Console errors on /dashboard/setup: ${filtered.join('; ')}`).toHaveLength(0)
  })

  test('P3 — Refresh Timer / Settings accordion IS present on 7777 (L4 install)', async ({ page }) => {
    await page.goto(`${PROD}/dashboard/setup`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)

    // L4 install renders the settings / refresh timer section
    // The accordion section header text includes "Refresh Timer" or "Settings"
    const bodyText = await page.textContent('body')
    const hasRefreshTimer = bodyText?.toLowerCase().includes('refresh timer') ||
                            bodyText?.toLowerCase().includes('refresh interval') ||
                            bodyText?.toLowerCase().includes('scrape interval')
    console.log('Has refresh timer text:', hasRefreshTimer, '| Body snippet:', bodyText?.slice(0, 500))
    expect(hasRefreshTimer, 'Refresh Timer section should be visible on L4 (7777)').toBe(true)
  })

  test('P4 — hero-open-dashboard button does NOT appear on 7777', async ({ page }) => {
    await page.goto(`${PROD}/dashboard/setup`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)

    const heroBtn = page.locator('[data-testid="hero-open-dashboard"]')
    const count = await heroBtn.count()
    console.log('hero-open-dashboard count on 7777:', count)
    expect(count, 'hero-open-dashboard must NOT appear on L4/prod install').toBe(0)
  })
})
