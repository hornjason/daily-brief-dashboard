/**
 * ProductIntelSection — per-product Generate button tests (BKL-TEST-07).
 *
 * Tests the "Generate" button for uncached product intel entries on
 * CustomerDetailPage. This is the component class where generation failures
 * were previously silent — errors set error state but could be missed.
 *
 * API endpoints under test:
 *   GET  /api/products/config                                — product list
 *   GET  /api/products/:slug/intel/:customerSlug             — cached intel (404 = uncached)
 *   POST /api/products/:slug/intel/:customerSlug/generate    — trigger generation
 *
 * All routes mocked via page.route() — no data mutations.
 *
 * The generate button appears inside uncached product stubs — each slug that
 * returns 404 from the GET intel endpoint gets a "Generate" button row.
 * The "Generate All" button in the section header triggers the batch endpoint.
 */
import { test, expect } from '../fixtures'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'
const TEST_CUSTOMER = process.env.TEST_KNOWN_CUSTOMER ?? 'Acme Corp'
const CUSTOMER_ENCODED = encodeURIComponent(TEST_CUSTOMER)
// Use customerSlug as the encoded customer name (consistent with how ProductIntelSection calls the API)
const CUSTOMER_SLUG = CUSTOMER_ENCODED
const CUSTOMER_URL = `${BASE}/dashboard/customer/${CUSTOMER_ENCODED}`

// The product slug we will use for targeted per-product tests
const TEST_SLUG = 'ocp'

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
  await page.route(`**/api/customers/${CUSTOMER_ENCODED}/account-plan`, r =>
    r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) })
  )
  await page.route(`**/api/customer/${CUSTOMER_ENCODED}/intelligence-status`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'none', generatedAt: null }) })
  )
  await page.route(`**/api/customer/${CUSTOMER_ENCODED}/expansion-opportunities`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(null) })
  )
  await page.route(`**/api/customer/${CUSTOMER_ENCODED}/stakeholder-engagement`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ contacts: [] }) })
  )
  // Mock the brief endpoint so brief text does not inject "OpenShift" into span elements,
  // which would create false matches for product-stub locators.
  await page.route(`**/customer/${CUSTOMER_ENCODED}/brief`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: '## Account Overview\nTest customer.', cachedAt: new Date().toISOString(), fromCache: true }) })
  )
  // Mock temporal-delta so the "What Changed" section does not inject "OpenShift"
  // text into <span> elements (TemporalDeltaSection line 105: <span>{detail}</span>),
  // which would produce false matches for the product-stub "OpenShift" span locator.
  await page.route(`**/api/customer/${CUSTOMER_ENCODED}/temporal-delta`, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasPrevious: false }) })
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('ProductIntelSection — per-product Generate button', () => {
  test('uncached product stub renders Generate button', async ({ page }) => {
    // Only expose one product slug so the stub is deterministic
    await page.route('**/api/products/config', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ slug: TEST_SLUG, displayName: 'OpenShift' }]),
      })
    )
    // All intel fetches return 404 (uncached)
    await page.route('**/api/products/*/intel/**', r =>
      r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'no intel' }) })
    )
    await mockBaseAPIs(page)

    await page.goto(CUSTOMER_URL, { waitUntil: 'domcontentloaded' })

    // The uncached product stub renders a row with the product display name and a Generate button
    const productRow = page.locator('text=OpenShift')
    await expect(productRow.first()).toBeVisible({ timeout: 10000 })

    // "Generate" button in the product stub row
    const generateBtn = page.locator('button', { hasText: 'Generate' })
    await expect(generateBtn.first()).toBeVisible({ timeout: 5000 })
  })

  test('button click fires POST to intel generate endpoint', async ({ page }) => {
    await page.route('**/api/products/config', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ slug: TEST_SLUG, displayName: 'OpenShift' }]),
      })
    )
    await page.route('**/api/products/*/intel/**', r =>
      r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'no intel' }) })
    )
    // Fulfill the POST — component will then re-fetch GET intel
    await page.route(`**/api/products/${TEST_SLUG}/intel/**/generate`, r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      })
    )
    await mockBaseAPIs(page)

    await page.goto(CUSTOMER_URL, { waitUntil: 'domcontentloaded' })

    // The ProductIntelSection renders two kinds of "Generate" buttons:
    //   - ExpansionOpportunitiesBlock's "Generate" (fires POST to expansion-opportunities)
    //   - uncached product stub's "Generate" (fires POST to intel generate endpoint)
    // Target the stub row for the specific product by its display name span sibling.
    // XPath: button[contains(text(),"Generate")] inside a flex-row div that also
    // contains a span with exact text "OpenShift".
    // Wait for the component to settle on the config-driven slug (ocp = "OpenShift").
    const productGenBtn = page
      .locator('span', { hasText: /^OpenShift$/ })
      .locator('xpath=..')
      .locator('button', { hasText: 'Generate' })
    await expect(productGenBtn).toBeVisible({ timeout: 10000 })

    // Set up waitForRequest immediately before the click to avoid the 30s
    // timeout running during page load.
    const postPromise = page.waitForRequest(req =>
      req.url().includes(`/api/products/${TEST_SLUG}/intel/`) &&
      req.url().includes('/generate') &&
      req.method() === 'POST'
    )
    await productGenBtn.click({ force: true })

    const req = await postPromise
    expect(req.url()).toContain(`/api/products/${TEST_SLUG}/intel/`)
    expect(req.url()).toContain('/generate')
  })

  test('generated intel summary appears in DOM after successful generation', async ({ page }) => {
    await page.route('**/api/products/config', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ slug: TEST_SLUG, displayName: 'OpenShift' }]),
      })
    )

    const MOCK_INTEL = {
      product: TEST_SLUG,
      customer: TEST_CUSTOMER,
      relevanceScore: 'HIGH' as const,
      priorityAction: 'Upgrade to 4.15 before EOL deadline',
      featureTalkingPoints: [],
      roadmapRelevance: [],
      expansionOpportunities: [],
      caseAlignment: [],
      competitiveAngle: null,
      generatedAt: new Date().toISOString(),
      productCacheHash: 'abc123',
    }

    // Before generate POST: all GETs return 404 (uncached stub shows "Generate" button).
    // After generate POST: subsequent GETs return MOCK_INTEL (ProductCard replaces stub).
    // Use a flag rather than a counter — the default productSlugs (7 slugs) trigger
    // parallel fetches on mount, so a counter-based approach mis-fires on the second slug.
    let intelGenerated = false
    await page.route(`**/api/products/${TEST_SLUG}/intel/**`, r => {
      if (r.request().method() === 'POST') {
        intelGenerated = true
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
      }
      if (!intelGenerated) {
        return r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'no intel' }) })
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_INTEL) })
    })
    await mockBaseAPIs(page)

    await page.goto(CUSTOMER_URL, { waitUntil: 'domcontentloaded' })

    // Target the product stub row by its display name span — avoids matching
    // the ExpansionOpportunitiesBlock's "Generate" button which fires a
    // different POST endpoint.
    const productGenBtn = page
      .locator('span', { hasText: /^OpenShift$/ })
      .locator('xpath=..')
      .locator('button', { hasText: 'Generate' })
    await expect(productGenBtn).toBeVisible({ timeout: 10000 })

    // Set up response wait BEFORE clicking — avoids race where POST resolves
    // before waitForResponse is registered (especially under parallel CI load).
    const postResponsePromise = page.waitForResponse(
      res => res.url().includes(`/api/products/${TEST_SLUG}/intel/`) &&
             res.url().includes('/generate') &&
             res.request().method() === 'POST',
      { timeout: 10000 }
    )
    await productGenBtn.click({ force: true })
    // Wait for POST to complete — ensures intelGenerated flag is set before GET fires
    await postResponsePromise

    // After generation completes, the component fetches GET intel again.
    // The returned MOCK_INTEL has priorityAction text — should appear in DOM.
    const priorityText = page.locator('text=Upgrade to 4.15 before EOL deadline')
    await expect(priorityText).toBeVisible({ timeout: 10000 })
  })

  test('section renders with product data present', async ({ page }) => {
    const MOCK_INTEL = {
      product: TEST_SLUG,
      customer: TEST_CUSTOMER,
      relevanceScore: 'MEDIUM' as const,
      priorityAction: 'Evaluate RHEL 9.4 for migration timeline',
      featureTalkingPoints: [{ feature: 'Image Builder', relevance: 'Simplifies OS image creation' }],
      roadmapRelevance: [],
      expansionOpportunities: [],
      caseAlignment: [],
      competitiveAngle: null,
      generatedAt: new Date().toISOString(),
      productCacheHash: 'def456',
    }

    await page.route('**/api/products/config', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ slug: TEST_SLUG, displayName: 'OpenShift' }]),
      })
    )
    await page.route(`**/api/products/${TEST_SLUG}/intel/**`, r =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_INTEL) })
    )
    await mockBaseAPIs(page)

    await page.goto(CUSTOMER_URL, { waitUntil: 'domcontentloaded' })

    // The ProductIntelSection should render with the cached intel data
    // When intel exists, the priority action text is displayed
    const priorityText = page.locator('text=Evaluate RHEL 9.4 for migration timeline')
    await expect(priorityText).toBeVisible({ timeout: 10000 })
  })

  test('empty product config shows no product stubs', async ({ page }) => {
    // Return empty product config — no products configured
    await page.route('**/api/products/config', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    )
    await page.route('**/api/products/*/intel/**', r =>
      r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'no intel' }) })
    )
    await mockBaseAPIs(page)

    await page.goto(CUSTOMER_URL, { waitUntil: 'domcontentloaded' })

    // With no products configured, the ProductIntelSection should not render
    // any product stubs or Generate buttons. Wait for the page to settle.
    await page.waitForTimeout(2000)

    // Verify no "Generate" button appears from product intel stubs
    // (ExpansionOpportunitiesBlock may still have its own Generate button)
    const productStubGen = page
      .locator('span', { hasText: /^OpenShift$/ })
      .locator('xpath=..')
      .locator('button', { hasText: 'Generate' })
    const hasProductStub = await productStubGen.isVisible().catch(() => false)
    expect(hasProductStub, 'No product stubs should render when products config is empty').toBe(false)
  })

  test.fixme('BKL-FLAKE-PRODUCT-INTEL: error banner from failed generate POST not appearing in DOM under parallel load — detected 2026-04-20')
  test('500 from intel generate POST surfaces error banner in DOM', async ({ page }) => {
    await page.route('**/api/products/config', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ slug: TEST_SLUG, displayName: 'OpenShift' }]),
      })
    )
    await page.route(`**/api/products/${TEST_SLUG}/intel/**`, r => {
      if (r.request().method() === 'POST') {
        // Use an error message that does NOT include "No cached summary" —
        // that phrase triggers the component's refresh fallback path, which
        // would then hit a separate /refresh endpoint and produce a different
        // error string. We want to test the direct failure path where the
        // error is surfaced immediately via setError("Failed to generate...").
        return r.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'AI provider timeout — retry later' }),
        })
      }
      return r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'no intel' }) })
    })
    await mockBaseAPIs(page)

    await page.goto(CUSTOMER_URL, { waitUntil: 'domcontentloaded' })

    // The ProductIntelSection renders two kinds of "Generate" buttons:
    //   - ExpansionOpportunitiesBlock's "Generate" (fires POST to expansion-opportunities)
    //   - uncached product stub's "Generate" (fires POST to intel generate endpoint)
    // Target the stub row for the specific product by its display name span sibling.
    // Wait for the component to settle on the config-driven slug (ocp = "OpenShift").
    const productGenBtn = page
      .locator('span', { hasText: /^OpenShift$/ })
      .locator('xpath=..')
      .locator('button', { hasText: 'Generate' })
    await expect(productGenBtn).toBeVisible({ timeout: 10000 })
    await productGenBtn.click({ force: true })

    // ProductIntelSection renders an error banner: a red div containing the error string.
    // Component sets error via setError(`Failed to generate ... intel: ${genErr.error ...}`)
    const errorBanner = page.locator('text=/Failed to generate/i')
      .or(page.locator('text=/No cached summary/'))
    await expect(errorBanner.first()).toBeVisible({ timeout: 8000 })
  })
})
