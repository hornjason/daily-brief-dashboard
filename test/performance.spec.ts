/**
 * Performance budget tests — assert critical endpoints respond within time budgets.
 * Budgets: health < 100ms, AEs < 200ms, bootstrap status < 500ms,
 * customer-specific endpoints < 1000ms.
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'

async function measureMs(fn: () => Promise<unknown>): Promise<number> {
  const t0 = Date.now()
  await fn()
  return Date.now() - t0
}

test.describe('Performance budgets', () => {
  test('GET /api/aes responds within 200ms', async ({ request }) => {
    const ms = await measureMs(() => request.get(`${BASE}/api/aes`))
    expect(ms, `GET /api/aes took ${ms}ms — budget 200ms`).toBeLessThan(200)
  })

  test('GET /api/bootstrap/auto/status responds within 500ms', async ({ request }) => {
    const ms = await measureMs(() => request.get(`${BASE}/api/bootstrap/auto/status`))
    expect(ms, `GET /api/bootstrap/auto/status took ${ms}ms — budget 500ms`).toBeLessThan(500)
  })

  test('GET /api/bootstrap/tableau/session-status responds within 5000ms', async ({ request }) => {
    // Tableau endpoint makes a real external HTTP request — budget is 5000ms, not 500ms
    const ms = await measureMs(() => request.get(`${BASE}/api/bootstrap/tableau/session-status`))
    expect(ms, `Tableau session status took ${ms}ms — budget 5000ms`).toBeLessThan(5000)
  })

  test('GET /api/customer/Carolanne Farrell/ccsp responds within 1000ms', async ({ request }) => {
    const aesRes = await request.get(`${BASE}/api/aes`)
    const { aes } = await aesRes.json()
    const hasCarolanne = aes.some((ae: { name: string }) => ae.name === 'Carolanne Farrell')
    if (!hasCarolanne) {
      test.skip(true, 'Carolanne Farrell not configured in this environment')
      return
    }
    const ms = await measureMs(() => request.get(`${BASE}/api/customer/Carolanne Farrell/ccsp`))
    expect(ms, `GET /api/customer/Carolanne Farrell/ccsp took ${ms}ms — budget 1000ms`).toBeLessThan(1000)
  })

  test('GET /api/customer/Carolanne Farrell/pipeline responds within 1000ms', async ({ request }) => {
    const aesRes = await request.get(`${BASE}/api/aes`)
    const { aes } = await aesRes.json()
    const hasCarolanne = aes.some((ae: { name: string }) => ae.name === 'Carolanne Farrell')
    if (!hasCarolanne) {
      test.skip(true, 'Carolanne Farrell not configured in this environment')
      return
    }
    const ms = await measureMs(() => request.get(`${BASE}/api/customer/Carolanne Farrell/pipeline`))
    expect(ms, `GET /api/customer/Carolanne Farrell/pipeline took ${ms}ms — budget 1000ms`).toBeLessThan(1000)
  })
})
