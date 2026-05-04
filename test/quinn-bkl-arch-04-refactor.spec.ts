// BKL-ARCH-04 Quinn regression — verify SetupPage refactor (AEsCustomersSection extraction)
// did not introduce regressions. Pure-render checks only — no state mutation.
// Run: npx playwright test test/quinn-bkl-arch-04-refactor.spec.ts --project=test

import { test, expect } from '@playwright/test'

const BASE = process.env.TEST_URL ?? 'http://localhost:7776'

test.describe('BKL-ARCH-04: SetupPage refactor regression', () => {
  test('Setup wizard loads without console errors and renders steps', async ({ page }) => {
    const errors: string[] = []
    const pageErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto(`${BASE}/dashboard/setup`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: '/tmp/quinn-arch04/01-setup.png', fullPage: true })

    // Wizard frame must render
    await expect(page.locator('text=/Setup|Wizard|Step/i').first()).toBeVisible({ timeout: 10_000 })

    expect(pageErrors, `pageerrors: ${pageErrors.join('\n')}`).toEqual([])
    expect(errors, `console.errors: ${errors.join('\n')}`).toEqual([])
  })

  test('AEs & Customers section renders (extracted component import works)', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

    await page.goto(`${BASE}/dashboard/setup`, { waitUntil: 'networkidle' })

    // Try to expand the AEs & Customers section — it may be collapsed
    const aeSection = page.locator('text=/AEs.*Customers|Add AE|Account Executive/i').first()
    await expect(aeSection).toBeVisible({ timeout: 10_000 })

    // Click any accordion/section header for AEs if collapsed
    const aeHeader = page.getByRole('button', { name: /AEs.*Customers/i }).first()
    if (await aeHeader.count() > 0 && await aeHeader.isVisible().catch(() => false)) {
      await aeHeader.click().catch(() => {})
    }

    await page.screenshot({ path: '/tmp/quinn-arch04/02-aes-customers.png', fullPage: true })

    // Critical: no JS error from broken import / missing prop
    expect(errors, `errors: ${errors.join('\n')}`).toEqual([])
  })

  test('Main dashboard route loads without errors', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: '/tmp/quinn-arch04/03-dashboard.png', fullPage: true })

    expect(errors, `errors: ${errors.join('\n')}`).toEqual([])
  })

  test('Admin route loads without errors', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

    await page.goto(`${BASE}/dashboard/admin`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: '/tmp/quinn-arch04/04-admin.png', fullPage: true })

    expect(errors, `errors: ${errors.join('\n')}`).toEqual([])
  })

  test('subscriptionSheetId rename — no supportableSheetId references in served bundle', async ({ request }) => {
    // BKL-DATA-AE-SUPPORTABLE-SHEET-ID-01 verification: rename should be complete.
    // Fetch the index HTML and main JS bundle, confirm old token is absent.
    const indexRes = await request.get(`${BASE}/dashboard/`)
    expect(indexRes.ok()).toBeTruthy()
    const indexHtml = await indexRes.text()
    expect(indexHtml).not.toContain('supportableSheetId')

    // Pull every script src, check each
    const scriptSrcs = Array.from(indexHtml.matchAll(/<script[^>]+src="([^"]+)"/g)).map((m) => m[1])
    for (const src of scriptSrcs) {
      const url = src.startsWith('http') ? src : `${BASE}${src.startsWith('/') ? src : '/' + src}`
      const res = await request.get(url)
      if (!res.ok()) continue
      const body = await res.text()
      expect(body, `bundle ${url} still contains supportableSheetId`).not.toContain('supportableSheetId')
    }
  })
})
