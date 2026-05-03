/**
 * AdminPage — silent failure regression tests (BKL-TEST-07).
 *
 * Two action buttons on /dashboard/admin used to silently swallow server failures:
 *   1. "Generate All" in BatchIntelligenceSection
 *      → POST /api/intelligence/generate-all
 *   2. "Run Now" on RH Cases ScrapeSection
 *      → POST /api/scrape/rh
 *
 * Before this fix a non-2xx response left the user with no DOM feedback — the
 * button just stopped spinning. These tests assert visible error text on the
 * page after a mocked 500 response.
 *
 * All routes are mocked via page.route() — no real server mutations.
 * Tagged @destructive so the `test` Playwright project routes to the test
 * container (7776), keeping prod (7777) untouched.
 */
import { test, expect } from '../fixtures'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'
const ADMIN_URL = `${BASE}/dashboard/admin`

/** Install passthrough mocks for the GET endpoints AdminPage hits on mount. */
async function mockAdminGets(page: import('@playwright/test').Page) {
  await page.route('**/api/scraper-status', r =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        scrapers: {
          'rh-cases': { state: 'idle', lastSuccess: null, lastError: null },
          ccsp: { state: 'idle', lastSuccess: null, lastError: null },
        },
        circuitBreakers: {},
        queue: { running: null, pending: [], isAnyRunning: false },
        browserRestartNeeded: false,
        rhDiscoveryProgress: null,
      }),
    })
  )
  await page.route('**/api/settings/refresh', r => {
    if (r.request().method() === 'GET') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          intervals: { subscriptions: 60, ccsp: 60, rhScrape: 60 },
          schedulerConfig: { rhEnabled: true, rhLastRun: null },
        }),
      })
    }
    return r.fallback()
  })
  await page.route('**/api/admin/gemini-usage', r =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        todayInputTokens: 0,
        todayOutputTokens: 0,
        todayCostUsd: 0,
        monthInputTokens: 0,
        monthOutputTokens: 0,
        monthCostUsd: 0,
        totalCalls: 0,
        byCallType: {},
      }),
    })
  )
  await page.route('**/api/settings/ai', r => {
    if (r.request().method() === 'GET') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ config: { intelligenceEnabled: true, docClassifyMaxAgeDays: 0 } }),
      })
    }
    return r.fallback()
  })
  await page.route('**/api/intelligence/status', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'idle' }) })
  )
  await page.route('**/api/intelligence/generate-all/status', r =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        running: false,
        total: 0,
        completed: 0,
        failed: 0,
        startedAt: null,
        completedAt: null,
        errors: [],
      }),
    })
  )
  // ConfigBackup, NotebookLM, ProductSources, DomainInference, ScrapeHistory
  // are below the fold — let any extra GETs 404 silently rather than crashing the page.
  await page.route('**/api/notebooklm/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) })
  )
  await page.route('**/api/products/config', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
  )
  await page.route('**/api/admin/scrape-history', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [] }) })
  )
  await page.route('**/api/admin/domain-inference/status', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ running: false }) })
  )
  await page.route('**/api/admin/config-backup/status', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ exists: false }) })
  )
}

test.describe('AdminPage — silent failure regression (BKL-TEST-07) @destructive', () => {
  test('REG-ADM-01: 500 from /api/intelligence/generate-all surfaces error near Generate All button', async ({ page }) => {
    await mockAdminGets(page)
    await page.route('**/api/intelligence/generate-all', r => {
      if (r.request().method() === 'POST') {
        return r.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Internal pipeline failure' }),
        })
      }
      return r.fallback()
    })

    await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' })

    const btn = page.locator('button', { hasText: 'Generate All' })
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await btn.click()

    // Error must surface in the DOM — no silent failure
    const err = page.getByTestId('batch-intel-start-error')
    await expect(err).toBeVisible({ timeout: 5_000 })
    await expect(err).toContainText(/Internal pipeline failure|Failed/i)
  })

  test('REG-ADM-02: 500 from /api/scrape/rh surfaces per-scraper error near Run Now button', async ({ page }) => {
    await mockAdminGets(page)
    await page.route('**/api/scrape/rh', r => {
      if (r.request().method() === 'POST') {
        return r.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Scrape trigger rejected' }),
        })
      }
      return r.fallback()
    })

    await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' })

    const btn = page.locator('button', { hasText: 'Run Now' }).first()
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await btn.click()

    const err = page.getByTestId('scrape-trigger-error-rh')
    await expect(err).toBeVisible({ timeout: 5_000 })
    await expect(err).toContainText(/Scrape trigger rejected|Trigger failed/i)
  })

  test('REG-ADM-03: prior trigger error clears when Run Now is clicked again', async ({ page }) => {
    await mockAdminGets(page)
    let attempt = 0
    await page.route('**/api/scrape/rh', r => {
      if (r.request().method() === 'POST') {
        attempt++
        if (attempt === 1) {
          return r.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Scrape trigger rejected' }),
          })
        }
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ queued: true }),
        })
      }
      return r.fallback()
    })

    await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' })

    const btn = page.locator('button', { hasText: 'Run Now' }).first()
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await btn.click()

    const err = page.getByTestId('scrape-trigger-error-rh')
    await expect(err).toBeVisible({ timeout: 5_000 })

    // Second click — error must clear because the request now succeeds
    await btn.click()
    await expect(err).toHaveCount(0, { timeout: 5_000 })
  })
})
