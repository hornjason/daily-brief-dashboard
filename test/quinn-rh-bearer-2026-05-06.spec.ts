// Quinn QA session 2026-05-06-quinn-rh-cases-bearer
// Read-only fresh-user browser walkthrough of pages affected by RH bearer changes.
// Prod 7777 / --project=ci

import { test, expect } from '@playwright/test'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'

const SCREENSHOT_DIR = '/tmp/quinn-rh-bearer-2026-05-06'

function capture(page: import('@playwright/test').Page) {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 500) errors.push(`5xx ${r.status()} ${r.url()}`)
  })
  return errors
}

test.describe('Quinn RH bearer post-deploy — 2026-05-06 (ci/7777)', () => {
  test('Dashboard root renders without 5xx or console errors', async ({ page }) => {
    const errors = capture(page)
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-dashboard.png`, fullPage: true })
    await expect(page.locator('body')).toBeVisible()
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('Customers list page loads', async ({ page }) => {
    const errors = capture(page)
    await page.goto(`${BASE}/dashboard/customers`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-customers.png`, fullPage: true })
    await expect(page.locator('body')).toBeVisible()
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('RH Cases page loads without 5xx or blank state crash', async ({ page }) => {
    const errors = capture(page)
    // Try the most likely RH cases route paths
    const candidates = ['/dashboard/cases', '/dashboard/rh-cases', '/dashboard/rh', '/dashboard']
    let landed = ''
    for (const c of candidates) {
      const res = await page.goto(`${BASE}${c}`, { waitUntil: 'networkidle' }).catch(() => null)
      if (res && res.status() < 400) { landed = c; break }
    }
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-rh-cases.png`, fullPage: true })
    expect(landed, 'at least one candidate route landed').not.toBe('')
    expect(errors.filter(e => e.startsWith('5xx')), `5xx errors: ${errors.join('\n')}`).toEqual([])
  })

  test('Admin page loads', async ({ page }) => {
    const errors = capture(page)
    await page.goto(`${BASE}/dashboard/admin`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: `${SCREENSHOT_DIR}/04-admin.png`, fullPage: true })
    await expect(page.locator('body')).toBeVisible()
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('Real customer detail page loads (uses live first customer)', async ({ page, request }) => {
    const errors = capture(page)
    const accRes = await request.get(`${BASE}/api/accounts`)
    const acc = await accRes.json()
    const cust = (acc.customers ?? [])[0]
    test.skip(!cust, 'no customers')
    // Try multiple slug shapes used by the app
    const slug = cust.slug ?? cust.name
    await page.goto(`${BASE}/dashboard/customer/${encodeURIComponent(slug)}`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: `${SCREENSHOT_DIR}/05-customer-detail.png`, fullPage: true })
    expect(errors.filter(e => e.startsWith('5xx'))).toEqual([])
  })

  test('RH transport status confirms bearer mode', async ({ request }) => {
    const r = await request.get(`${BASE}/api/status/rh-token`)
    expect(r.ok()).toBeTruthy()
    const body = await r.json()
    expect(body.transport).toBe('bearer')
    expect(body.authMode).toBe('bearer')
  })

  test('Scrapes status has rh transport and rh-cases breaker closed', async ({ request }) => {
    const r = await request.get(`${BASE}/api/status/scrapes`)
    expect(r.ok()).toBeTruthy()
    const body = await r.json()
    expect(body.rh.transport).toBe('bearer')
    expect(body.rh.lastError).toBeNull()
    expect(body.circuitBreakers['rh-cases'].state).toBe('closed')
  })
})
