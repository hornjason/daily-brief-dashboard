/**
 * Dashboard empty-state UI tests.
 *
 * Validates graceful behavior when the dashboard loads with empty cache —
 * the state immediately after bootstrap when Google Sheets have data but
 * local data/cache/ has no JSON files yet.
 *
 * All mocking uses page.route() — no real config or server state is mutated.
 */
import { test, expect } from '../fixtures'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'

// ── Shared mock helpers ─────────────────────────────────────────────────────

const EMPTY_PIPELINE = {
  totalAcv: 0,
  openCount: 0,
  renewalAcv: 0,
  newAcv: 0,
  byStage: [],
  byOwner: [],
  byQuarterStage: [],
  topOpps: [],
  closedOpps: [],
  techWinsNeeded: [],
  cachedAt: null,
}

const EMPTY_CCSP = {
  totalAcv: 0,
  cachedAt: null,
  sourceWarning: false,
  byCustomer: [],
  byQuarter: [],
  byPartner: [],
}

const EMPTY_ACCOUNTS = { customers: [] }

const EMPTY_KPIS = {
  sev1Count: 0,
  meetingsToday: 0,
  meetingsThisWeek: 0,
  openCaseCount: 0,
  totalPipelineAcv: 0,
}

const EMPTY_CASES = { cases: [], totalCount: 0 }
const EMPTY_CALENDAR = { events: [] }

const SCRAPE_STATUS = {
  supportable: { lastSync: null, lastError: null, isRunning: false, isStale: true },
  ccsp: { lastSync: null, lastError: null, isRunning: false, isStale: true },
  rh: { lastSync: null, lastError: null, isRunning: false, isStale: true },
  salesforce: { lastSync: null, lastError: null, isRunning: false, isStale: true },
}

const RH_STATUS = {
  hasSession: false,
  sessionExpired: false,
  lastScraped: null,
  caseCount: 0,
  loginInProgress: false,
  loginTimedOut: false,
}

const HEALTH = { ok: true, aes: 1 }

/**
 * Intercept all dashboard data endpoints with empty/zero responses.
 * Call this before page.goto() to ensure the dashboard sees only empty data.
 */
async function mockAllEndpointsEmpty(page: import('@playwright/test').Page) {
  await page.route('**/api/pipeline*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_PIPELINE),
    })
  )

  await page.route('**/api/ccsp*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_CCSP),
    })
  )

  await page.route('**/api/accounts*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_ACCOUNTS),
    })
  )

  await page.route('**/api/kpis*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_KPIS),
    })
  )

  await page.route('**/api/cases/**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_CASES),
    })
  )

  await page.route('**/api/calendar*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_CALENDAR),
    })
  )

  await page.route('**/api/status/scrapes*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SCRAPE_STATUS),
    })
  )

  await page.route('**/api/auth/redhat/status*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(RH_STATUS),
    })
  )

  await page.route('**/health*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(HEALTH),
    })
  )

  // SSE /events stream — send complete immediately with no section data
  await page.route('**/events', route =>
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: `event: complete\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`,
    })
  )
}

// ── Test 1: Pipeline section — empty state ──────────────────────────────────

test.describe('Dashboard empty state — Pipeline', () => {
  test('renders pipeline section gracefully with zero data', async ({ page }) => {
    await mockAllEndpointsEmpty(page)
    await page.goto(`${BASE_URL}/dashboard`)

    // The pipeline section container should be present
    const pipelineSection = page.locator('#section-pipeline')
    await expect(pipelineSection).toBeVisible()

    // The "Open Pipeline" heading should render
    await expect(pipelineSection.getByText('Open Pipeline')).toBeVisible()

    // Should show $0 for total ACV (fmt(0) = "$0")
    await expect(pipelineSection.getByText('$0').first()).toBeVisible()

    // Should show "0 opportunities"
    await expect(pipelineSection.getByText('0 opportunities')).toBeVisible()

    // The "No opportunities" text appears in the top-opps panel when topOpps is empty
    await expect(pipelineSection.getByText('No opportunities')).toBeVisible()

    // No "undefined" or "[object Object]" text anywhere in the section
    const pipelineText = await pipelineSection.textContent()
    expect(pipelineText).not.toContain('undefined')
    expect(pipelineText).not.toContain('[object Object]')
  })
})

// ── Test 2: Cloud Spend section — empty state ───────────────────────────────

test.describe('Dashboard empty state — Cloud Spend', () => {
  test('renders cloud spend section gracefully with zero data', async ({ page }) => {
    await mockAllEndpointsEmpty(page)
    await page.goto(`${BASE_URL}/dashboard`)

    const ccspSection = page.locator('#section-cloudspend')
    await expect(ccspSection).toBeVisible()

    // The "Cloud Spend (CCSP)" heading should render
    await expect(ccspSection.getByText('Cloud Spend (CCSP)')).toBeVisible()

    // CloudSpendSection shows an explicit empty state when data has no byCustomer:
    // "No cloud spend data yet." is shown when data is null.
    // When data is present but empty, it shows "$0" total and "0 accounts" and "No data" in sub-panels.
    // With our mock returning a valid object with empty arrays, we get the $0 path.
    await expect(ccspSection.getByText('$0')).toBeVisible()
    await expect(ccspSection.getByText('0 accounts')).toBeVisible()

    // The donut chart area shows "No data" when customers array is empty
    await expect(ccspSection.getByText('No data').first()).toBeVisible()

    // No "undefined" or "[object Object]"
    const ccspText = await ccspSection.textContent()
    expect(ccspText).not.toContain('undefined')
    expect(ccspText).not.toContain('[object Object]')
  })

  test('renders explicit empty message when data is null', async ({ page }) => {
    // Override CCSP to return a shape that triggers data === null in the component.
    // The useApi hook sets data to the parsed response, so we need the endpoint
    // to return something that makes useApi set data to null.
    // Actually, CloudSpendSection receives data prop from useApi. When the API
    // returns valid JSON, data won't be null. The null path triggers if the
    // fetch hasn't completed or truly returned null. Let's test with the API
    // returning an error status instead, which leaves data as null.
    await mockAllEndpointsEmpty(page)

    // Re-override ccsp to return 500 (useApi will set error, data stays null)
    await page.route('**/api/ccsp*', route =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No data' }),
      })
    )

    await page.goto(`${BASE_URL}/dashboard`)

    const ccspSection = page.locator('#section-cloudspend')
    await expect(ccspSection).toBeVisible()

    // With data=null and error set, the error state renders
    // "Failed to load cloud spend data."
    await expect(ccspSection.getByText('Failed to load cloud spend data.')).toBeVisible()

    // No crash — section heading still present
    await expect(ccspSection.getByText('Cloud Spend (CCSP)')).toBeVisible()
  })
})

// ── Test 3: Accounts grid — empty state ─────────────────────────────────────

test.describe('Dashboard empty state — Account Portfolio', () => {
  test('renders account portfolio section with zero accounts', async ({ page }) => {
    await mockAllEndpointsEmpty(page)
    await page.goto(`${BASE_URL}/dashboard`)

    const accountsSection = page.locator('#section-accounts')
    await expect(accountsSection).toBeVisible()

    // The "Account Portfolio" heading should render
    await expect(accountsSection.getByText('Account Portfolio')).toBeVisible()

    // Should show "0 accounts" count
    await expect(accountsSection.getByText('0 accounts')).toBeVisible()

    // No "undefined" or "[object Object]"
    const accountsText = await accountsSection.textContent()
    expect(accountsText).not.toContain('undefined')
    expect(accountsText).not.toContain('[object Object]')
  })
})

// ── Test 4: SSE stream — all sections empty ─────────────────────────────────

test.describe('Dashboard empty state — SSE stream all empty', () => {
  test('page loads fully with empty SSE stream and all sections present', async ({ page }) => {
    await mockAllEndpointsEmpty(page)
    await page.goto(`${BASE_URL}/dashboard`)

    // Wait for the page to settle
    await page.waitForLoadState('networkidle')

    // All major section containers should be present in the DOM
    await expect(page.locator('#section-command')).toBeVisible()
    await expect(page.locator('#section-pipeline')).toBeVisible()
    await expect(page.locator('#section-cloudspend')).toBeVisible()
    await expect(page.locator('#section-calendar')).toBeVisible()
    await expect(page.locator('#section-accounts')).toBeVisible()

    // No "undefined" text anywhere visible on the page
    const bodyText = await page.locator('main').textContent()
    expect(bodyText).not.toContain('undefined')
    expect(bodyText).not.toContain('[object Object]')
    expect(bodyText).not.toContain('NaN')
  })
})

// ── Test 5: Console errors — zero errors on empty dashboard ─────────────────

test.describe('Dashboard empty state — no console errors', () => {
  test('no JavaScript console errors on empty dashboard', async ({ page }) => {
    const consoleErrors: string[] = []

    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text()
        // Filter out expected noise: favicon 404, network errors from mocked routes
        if (text.includes('favicon') || text.includes('net::ERR')) return
        // Filter out React DevTools extension messages
        if (text.includes('DevTools') || text.includes('extension')) return
        consoleErrors.push(text)
      }
    })

    // Also catch unhandled page errors (thrown exceptions)
    const pageErrors: string[] = []
    page.on('pageerror', err => {
      pageErrors.push(err.message)
    })

    await mockAllEndpointsEmpty(page)
    await page.goto(`${BASE_URL}/dashboard`)

    // Wait for all async rendering to settle
    await page.waitForLoadState('networkidle')
    // Additional wait for any deferred React effects
    await page.waitForTimeout(3000)

    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  })
})
