/**
 * AccountIntelligencePanel — Generate Intelligence button tests (BKL-TEST-07).
 *
 * Tests the visibility and behavior of the generate button on CustomerDetailPage
 * for the account intelligence panel. Failures in this flow were previously silent;
 * these tests verify that errors surface in the DOM rather than disappearing.
 *
 * API endpoints under test:
 *   POST /api/customer/:name/generate-intelligence — triggers generation job
 *   GET  /api/customer/:name/intelligence-status   — polls job state
 *
 * All routes mocked via page.route() — no real server calls, no data mutations.
 *
 * The AccountIntelligencePanel is collapsed by default. Each test expands it
 * before interacting with the generate button.
 */
import { test, expect } from '../fixtures'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'
const TEST_CUSTOMER = process.env.TEST_KNOWN_CUSTOMER ?? 'Acme Corp'
const CUSTOMER_ENCODED = encodeURIComponent(TEST_CUSTOMER)
const CUSTOMER_URL = `${BASE}/dashboard/customer/${CUSTOMER_ENCODED}`

// ── Shared page setup ────────────────────────────────────────────────────────

/**
 * Install mocks for every endpoint CustomerDetailPage fetches on load.
 * Without these, network errors crash the React tree before SSE events arrive.
 * Also installs the EventSource mock so SSE fires quickly and stably.
 */
async function mockBaseAPIs(page: import('@playwright/test').Page) {
  // SSE mock — plain JS constructor, avoids bun .toString() TypeScript preservation issues
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
  await page.route(`**/api/customers/${CUSTOMER_ENCODED}/account-plan`, r =>
    r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) })
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

// ── Helper: expand the AccountIntelligencePanel ──────────────────────────────

async function expandIntelPanel(page: import('@playwright/test').Page) {
  // The panel header contains "Account Intelligence Docs" — click to expand
  const header = page.locator('button', { hasText: 'Account Intelligence Docs' })
  await expect(header).toBeVisible({ timeout: 10000 })
  await header.click()
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('AccountIntelligencePanel — Generate Intelligence button', () => {
  test('button click fires POST to generate-intelligence', async ({ page }) => {
    // Mount-time status: no prior generation
    await page.route(`**/api/customer/${CUSTOMER_ENCODED}/intelligence-status`, r =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'none', generatedAt: null }) })
    )
    await mockBaseAPIs(page)

    // Intercept the POST so we can assert it was sent
    const postPromise = page.waitForRequest(req =>
      req.url().includes(`/api/customer/${CUSTOMER_ENCODED}/generate-intelligence`) &&
      req.method() === 'POST'
    )
    // Fulfill generate call — return started (use predicate to match ?force=true query param)
    await page.route(
      url => String(url).includes(`/api/customer/${CUSTOMER_ENCODED}/generate-intelligence`),
      r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ started: true, jobId: 'test-job-1' }) })
    )

    await page.goto(CUSTOMER_URL, { waitUntil: 'domcontentloaded' })
    await expandIntelPanel(page)

    // Button renders "Generate Intelligence" when no prior docs exist
    const btn = page.locator('button', { hasText: 'Generate Intelligence' })
    await expect(btn).toBeVisible({ timeout: 5000 })
    await btn.click({ force: true })

    // Assert POST was sent
    const req = await postPromise
    expect(req.url()).toContain(`/api/customer/${CUSTOMER_ENCODED}/generate-intelligence`)
  })

  test('running state becomes visible in DOM after generation starts', async ({ page }) => {
    let statusCallCount = 0

    // First call returns 'running', subsequent calls return 'complete'
    await page.route(`**/api/customer/${CUSTOMER_ENCODED}/intelligence-status`, r => {
      statusCallCount++
      if (statusCallCount === 1) {
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'none', generatedAt: null }) })
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'running', step: 'identifying industry' }) })
    })
    await mockBaseAPIs(page)

    // Generate endpoint returns started immediately (predicate matches ?force=true query param)
    await page.route(
      url => String(url).includes(`/api/customer/${CUSTOMER_ENCODED}/generate-intelligence`),
      r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ started: true, jobId: 'test-job-1' }) })
    )

    await page.goto(CUSTOMER_URL, { waitUntil: 'domcontentloaded' })
    await expandIntelPanel(page)

    const btn = page.locator('button', { hasText: 'Generate Intelligence' })
    await expect(btn).toBeVisible({ timeout: 5000 })
    await btn.click({ force: true })

    // The component sets generating=true immediately on click, which shows the running
    // indicator (animate-spin icon + step text) inside the panel body.
    // The button disappears while isRunning is true (component hides it).
    await expect(btn).not.toBeVisible({ timeout: 5000 })

    // Running text from component: status.step or 'Starting...'
    const runningText = page.locator('text=Starting...').or(page.locator('text=identifying industry'))
    await expect(runningText.first()).toBeVisible({ timeout: 5000 })
  })

  test('500 error from generate-intelligence surfaces error message in DOM', async ({ page }) => {
    await page.route(`**/api/customer/${CUSTOMER_ENCODED}/intelligence-status`, r =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'none', generatedAt: null }) })
    )
    await mockBaseAPIs(page)

    // Return 500 with a JSON error body (component calls ?force=true — match via predicate)
    await page.route(
      url => String(url).includes(`/api/customer/${CUSTOMER_ENCODED}/generate-intelligence`),
      r => r.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Internal server error during intelligence generation' }),
      })
    )

    await page.goto(CUSTOMER_URL, { waitUntil: 'domcontentloaded' })
    await expandIntelPanel(page)

    const btn = page.locator('button', { hasText: 'Generate Intelligence' })
    await expect(btn).toBeVisible({ timeout: 5000 })
    await btn.click({ force: true })

    // Component renders: <span>{status?.error ?? 'Generation failed'}</span>
    // The error div has class text-warning and contains AlertCircle icon
    const errorMsg = page.locator('text=Internal server error during intelligence generation')
      .or(page.locator('text=Generation failed'))
      .or(page.locator('text=/Server error 500/'))
    await expect(errorMsg.first()).toBeVisible({ timeout: 5000 })
  })
})
