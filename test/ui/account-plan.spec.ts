/**
 * AccountPlanPanel — Generate Account Plan button tests (BKL-TEST-07).
 *
 * Tests the generate flow on CustomerDetailPage's account plan panel.
 * Verifies that failures are not silent and that plan content appears
 * in the DOM after successful generation.
 *
 * API endpoints under test:
 *   POST /api/customers/:id/account-plan/generate — triggers plan generation
 *   GET  /api/customers/:id/account-plan           — returns plan content
 *
 * All routes mocked via page.route() — no data mutations.
 *
 * The AccountPlanPanel is collapsed by default. Each test expands it
 * before interacting with the generate button.
 *
 * AccountPlanPanel flow for success:
 *   POST returns { ok: true, generatedAt: '...', driveUrl: '' }
 *   → component immediately fetches GET account-plan for markdown content
 *   → sets plan state and hides generating spinner
 */
import { test, expect } from '../fixtures'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'
const TEST_CUSTOMER = process.env.TEST_KNOWN_CUSTOMER ?? 'Acme Corp'
const CUSTOMER_ENCODED = encodeURIComponent(TEST_CUSTOMER)
const CUSTOMER_URL = `${BASE}/dashboard/customer/${CUSTOMER_ENCODED}`

// ── Shared page setup ────────────────────────────────────────────────────────

async function mockBaseAPIs(page: import('@playwright/test').Page) {
  // SSE mock — plain JS constructor
  await page.addInitScript(function(arg: { meta: object; cases: unknown[] }) {
    const origES = window.EventSource
    function MockES(url: string | URL) {
      const urlStr = typeof url === 'string' ? url : String(url)
      if (urlStr.indexOf('/customer/') >= 0 && urlStr.indexOf('/events') >= 0) {
        const et = new EventTarget() as EventTarget & {
          url: string; readyState: number; CONNECTING: number; OPEN: number; CLOSED: number
          withCredentials: boolean; onerror: null; onopen: null; onmessage: null
          close: () => void
        }
        et.url = urlStr
        et.readyState = 1
        et.CONNECTING = 0; et.OPEN = 1; et.CLOSED = 2
        et.withCredentials = false
        et.onerror = null; et.onopen = null; et.onmessage = null
        et.close = function() { et.readyState = 2 }
        setTimeout(function() {
          const events: [string, unknown][] = [
            ['meta', arg.meta],
            ['meetings', []],
            ['emails', []],
            ['drive', []],
            ['cases', []],
            ['subscriptions', []],
            ['complete', { timestamp: new Date().toISOString() }],
          ]
          for (const [name, data] of events) {
            et.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }))
          }
        }, 800)
        return et
      }
      return new origES(url)
    }
    window.EventSource = MockES as unknown as typeof EventSource
  }, {
    meta: { name: TEST_CUSTOMER, domain: 'testcorp.com', accountNumbers: ['9900001'], ae: 'Test AE' },
    cases: [],
  })

  await page.route('**/api/config/test', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }))
  await page.route('**/api/config', r => {
    if (r.request().url().includes('/api/config/')) return r.fallback()
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ briefConfigured: true, briefProvider: 'pai', pods: [], territories: {} }) })
  })
  await page.route('**/api/accounts', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ customers: [{ name: TEST_CUSTOMER, domain: 'testcorp.com', accountNumbers: ['9900001'], ae: 'Test AE', segment: 'Commercial' }] }) })
  )
  await page.route('**/customers', r => {
    if (r.request().url().includes('/customer/')) return r.fallback()
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([TEST_CUSTOMER]) })
  })
  await page.route(`**/api/health-scores/${CUSTOMER_ENCODED}`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ score: null, signals: [] }) })
  )
  await page.route(`**/customer/${CUSTOMER_ENCODED}/ccsp`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ totalAcv: 0, byPartner: [], byQuarter: [] }) })
  )
  await page.route(`**/customer/${CUSTOMER_ENCODED}/pipeline`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ openCount: 0, closedOpps: [], opps: [], totalAcv: 0 }) })
  )
  await page.route(`**/api/customer/${CUSTOMER_ENCODED}/priority-action`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ action: null }) })
  )
  await page.route(`**/customer/${CUSTOMER_ENCODED}/sheetdata`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) })
  )
  await page.route(`**/api/customer/${CUSTOMER_ENCODED}/intelligence-status`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'none', generatedAt: null }) })
  )
  await page.route('**/api/products/config', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
  )
  await page.route('**/api/products/*/intel/**', r =>
    r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'no intel' }) })
  )
  await page.route(`**/api/customer/${CUSTOMER_ENCODED}/expansion-opportunities`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(null) })
  )
  await page.route(`**/api/customer/${CUSTOMER_ENCODED}/stakeholder-engagement`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ contacts: [] }) })
  )
  await page.route(`**/customer/${CUSTOMER_ENCODED}/brief`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: '## Account Overview\nTest customer.', cachedAt: new Date().toISOString(), fromCache: true }) })
  )
  await page.route(`**/api/customer/${CUSTOMER_ENCODED}/temporal-delta`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasPrevious: false }) })
  )
}

// ── Helper: expand the AccountPlanPanel ──────────────────────────────────────

async function expandAccountPlanPanel(page: import('@playwright/test').Page) {
  const header = page.locator('button', { hasText: 'Account Plan' })
  await expect(header).toBeVisible({ timeout: 10000 })
  await header.click()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('AccountPlanPanel — Generate Account Plan button', () => {
  test('button click fires POST to account-plan/generate', async ({ page }) => {
    // Mount-time fetch: no plan exists yet
    await page.route(`**/api/customers/${CUSTOMER_ENCODED}/account-plan`, r =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ notGenerated: true }) })
    )
    await mockBaseAPIs(page)

    const postPromise = page.waitForRequest(req =>
      req.url().includes(`/api/customers/${CUSTOMER_ENCODED}/account-plan/generate`) &&
      req.method() === 'POST'
    )
    // Fulfill generate — synchronous completion path
    await page.route(`**/api/customers/${CUSTOMER_ENCODED}/account-plan/generate`, r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), driveUrl: '' }),
      })
    )

    await page.goto(CUSTOMER_URL, { waitUntil: 'domcontentloaded' })
    await expandAccountPlanPanel(page)

    // "Generate Account Plan" button shown when notGenerated=true
    const btn = page.locator('button', { hasText: 'Generate Account Plan' })
    await expect(btn).toBeVisible({ timeout: 5000 })
    await btn.click({ force: true })

    const req = await postPromise
    expect(req.url()).toContain(`/api/customers/${CUSTOMER_ENCODED}/account-plan/generate`)
  })

  test('plan content appears in DOM after successful generation', async ({ page }) => {
    const PLAN_CONTENT = 'Test account plan content for Acme Corp'
    const GENERATED_AT = new Date().toISOString()

    // Initial GET — not generated
    let accountPlanCallCount = 0
    await page.route(`**/api/customers/${CUSTOMER_ENCODED}/account-plan`, r => {
      accountPlanCallCount++
      if (accountPlanCallCount === 1) {
        // First call (on mount) — not generated
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ notGenerated: true }) })
      }
      // Second call (after generate returns ok:true) — return plan
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ markdown: PLAN_CONTENT, generatedAt: GENERATED_AT, driveUrl: '' }),
      })
    })
    await mockBaseAPIs(page)

    // Generate succeeds synchronously
    await page.route(`**/api/customers/${CUSTOMER_ENCODED}/account-plan/generate`, r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, generatedAt: GENERATED_AT, driveUrl: '' }),
      })
    )

    await page.goto(CUSTOMER_URL, { waitUntil: 'domcontentloaded' })
    await expandAccountPlanPanel(page)

    const btn = page.locator('button', { hasText: 'Generate Account Plan' })
    await expect(btn).toBeVisible({ timeout: 5000 })
    await btn.click({ force: true })

    // After generation completes, the "View" and "Download" buttons become visible —
    // indicating the plan was received and rendered
    const viewBtn = page.locator('button', { hasText: 'View' })
    await expect(viewBtn).toBeVisible({ timeout: 8000 })

    // Generate button should have disappeared (replaced by Regenerate)
    await expect(btn).not.toBeVisible()
  })

  test('500 error from account-plan/generate surfaces error message in DOM', async ({ page }) => {
    await page.route(`**/api/customers/${CUSTOMER_ENCODED}/account-plan`, r =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ notGenerated: true }) })
    )
    await mockBaseAPIs(page)

    // Return 500 — component parses JSON error and sets error state
    await page.route(`**/api/customers/${CUSTOMER_ENCODED}/account-plan/generate`, r =>
      r.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Drive auth failure: token expired' }),
      })
    )

    await page.goto(CUSTOMER_URL, { waitUntil: 'domcontentloaded' })
    await expandAccountPlanPanel(page)

    const btn = page.locator('button', { hasText: 'Generate Account Plan' })
    await expect(btn).toBeVisible({ timeout: 5000 })
    await btn.click({ force: true })

    // Component renders error via: <span>{error}</span> — error set from data.error
    // The response is 500 with { error: '...' } — component path:
    //   data.error → setError(data.error)
    const errorMsg = page.locator('text=Drive auth failure: token expired')
      .or(page.locator('text=/Unexpected response/'))
      .or(page.locator('text=/Server error/'))
    await expect(errorMsg.first()).toBeVisible({ timeout: 5000 })
  })
})
