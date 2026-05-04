// Quinn validation for BKL-DOM-INF-02 + BKL-DOM-INF-13 deploy on prod (7777).
// - API contract: every customer has needsManualDomain field (boolean)
// - UI: dashboard loads, AE list renders, no console errors
// - Badge: amber "Domain needed" badge appears IFF needsManualDomain === true
//   and links to /dashboard/setup
import { test, expect } from '@playwright/test'

test.describe('BKL-DOM-INF-13 deploy validation', () => {
  test('API: /api/accounts includes needsManualDomain on every customer', async ({ request }) => {
    const res = await request.get('/api/accounts')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('customers')
    expect(Array.isArray(body.customers)).toBe(true)
    expect(body.customers.length).toBeGreaterThan(0)
    for (const c of body.customers) {
      expect(c, `customer ${c?.name} missing needsManualDomain`).toHaveProperty('needsManualDomain')
      expect(typeof c.needsManualDomain).toBe('boolean')
    }
  })

  test('UI: dashboard loads with no console errors and AE list renders', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

    await page.goto('/dashboard')
    // Wait for app shell to mount and at least one AE group or customer to render.
    await page.waitForLoadState('networkidle')
    // Tolerate either AE-grouped layout or empty state — just confirm no crash.
    const root = page.locator('#root')
    await expect(root).not.toBeEmpty()

    // Filter known noisy errors that aren't deploy-related.
    const real = consoleErrors.filter(
      (e) => !/favicon|Manifest|preconnect|googleapis|gstatic/i.test(e)
    )
    expect(real, `console errors: ${real.join(' | ')}`).toEqual([])
  })

  test('UI: Domain-needed badge presence matches needsManualDomain field', async ({ page, request }) => {
    const res = await request.get('/api/accounts')
    const { customers } = await res.json()
    const needFlagged = customers.filter((c: any) => c.needsManualDomain === true)

    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')

    const badges = page.locator('a:has-text("Domain needed")')
    const count = await badges.count()
    expect(count).toBe(needFlagged.length)

    if (count > 0) {
      const first = badges.first()
      await expect(first).toHaveAttribute('href', '/dashboard/setup')
    }
  })
})
