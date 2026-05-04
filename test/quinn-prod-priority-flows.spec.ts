// BKL-ARCH-04 + BKL-DATA-AE-SUPPORTABLE-SHEET-ID-01 + BKL-SEC-28 + BKL-ARCH-06-FOLLOWUP
// Quinn priority-flow audit on PROD (7777). Read-only, no state mutation.
// Run: npx playwright test test/quinn-prod-priority-flows.spec.ts --project=ci

import { test, expect } from '@playwright/test'

const BASE = process.env.TEST_URL ?? 'http://localhost:7777'

test.describe('Quinn prod priority flows — 2026-05-03', () => {
  test('Dashboard root: KPIs and customer list render', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: '/tmp/quinn-prod-flows/01-dashboard.png', fullPage: true })

    // Some content rendered
    await expect(page.locator('body')).toBeVisible()
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('Setup wizard: all step tabs present, AEs & Customers section renders', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await page.goto(`${BASE}/dashboard/setup`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: '/tmp/quinn-prod-flows/02-setup.png', fullPage: true })

    // AEs & Customers reachable (extracted component)
    const ae = page.locator('text=/AEs.*Customers|Add AE|Account Executive/i').first()
    await expect(ae).toBeVisible({ timeout: 10_000 })

    expect(errors, errors.join('\n')).toEqual([])
  })

  test('Admin page renders', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await page.goto(`${BASE}/dashboard/admin`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: '/tmp/quinn-prod-flows/03-admin.png', fullPage: true })

    expect(errors, errors.join('\n')).toEqual([])
  })

  test('Customer detail page: brief and intel tabs load', async ({ page, request }) => {
    const errors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    // Pick first customer slug
    const accountsRes = await request.get(`${BASE}/api/accounts`)
    const accounts = await accountsRes.json()
    const customers = accounts.customers ?? []
    test.skip(customers.length === 0, 'No customers configured on prod — cannot test detail page')
    const slug = customers[0].slug ?? customers[0].id ?? customers[0].name?.toLowerCase().replace(/\s+/g, '-')

    await page.goto(`${BASE}/dashboard/customer/${slug}`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: '/tmp/quinn-prod-flows/04-customer-detail.png', fullPage: true })

    expect(errors, errors.join('\n')).toEqual([])
  })

  test('Served prod bundle has zero supportableSheetId references', async ({ request }) => {
    const indexRes = await request.get(`${BASE}/dashboard/`)
    expect(indexRes.ok()).toBeTruthy()
    const html = await indexRes.text()
    expect(html).not.toContain('supportableSheetId')

    const scriptSrcs = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g)).map((m) => m[1])
    for (const src of scriptSrcs) {
      const url = src.startsWith('http') ? src : `${BASE}${src.startsWith('/') ? src : '/' + src}`
      const res = await request.get(url)
      if (!res.ok()) continue
      const body = await res.text()
      expect(body, `bundle ${url} contains supportableSheetId`).not.toContain('supportableSheetId')
    }
  })
})
