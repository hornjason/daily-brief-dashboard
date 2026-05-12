/**
 * Admin Cache Management tests (issue #117).
 *
 * @destructive — clears cache files, must run against test container (port 7776).
 * Run: npx playwright test test/admin-cache.spec.ts --project=test
 */
import { test, expect } from '@playwright/test'

test.describe('Admin Cache Management @destructive', () => {
  test('GET /api/admin/cache/status returns category counts', async ({ request }) => {
    const res = await request.get('/api/admin/cache/status')
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    for (const key of ['briefs', 'meetings', 'emails', 'productIntel', 'industryAnalysis']) {
      expect(body).toHaveProperty(key)
      expect(typeof body[key].count).toBe('number')
      expect(body[key]).toHaveProperty('oldestAt')
      expect(body[key]).toHaveProperty('newestAt')
    }
  })

  test('POST /api/admin/cache/clear rejects empty types', async ({ request }) => {
    const res = await request.post('/api/admin/cache/clear', {
      data: { types: [] },
    })
    expect(res.status()).toBe(400)
  })

  test('cache management section visible on admin page', async ({ page }) => {
    await page.goto('/dashboard/admin')
    await expect(page.getByText('Cache Management')).toBeVisible()
    await expect(page.getByText('Customer Briefs')).toBeVisible()
    await expect(page.getByText('Clear All Caches')).toBeVisible()
  })
})
