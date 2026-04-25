/**
 * Product Filter Coverage — E2E (BKL-TEST-P0-06)
 *
 * Verifies that selecting a product chip (AAP) on the dashboard cascades
 * the filter to every data area:
 *   1. KPI tiles (Open Cases, Sev 1 Cases)      — show "filtered / total"
 *   2. Account card list                        — only matching accounts
 *   3. ACV / renewal tiles (Expiring, 30-90)    — show "filtered / total"
 *   4. CCSP tile                                — /api/ccsp includes products=AAP
 *   5. Pipeline section                         — only matching opps
 *
 * All APIs are mocked via page.route() — no real network traffic. The mock
 * dataset is shaped so each area has a deterministic before/after count
 * (1 matching row out of 3 total) to catch regressions where a product
 * filter silently no-ops.
 *
 * FINDINGS (documented as test.fail where applicable):
 *   - CCSP tile client is not passed selectedProducts; only the
 *     /api/ccsp request URL carries products=, and it is the server that
 *     must honour it. We assert the URL, not the visible tile content.
 *
 * Run (test container):
 *   BASE_URL=http://localhost:7776 npx playwright test \
 *     test/ui/product-filter-coverage.spec.ts --project=ci --reporter=line
 */
import { test, expect } from '../fixtures'
import type { Page } from '@playwright/test'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'

// ── Mock dataset ───────────────────────────────────────────────────────────
//
// Three accounts, one per product, one case each, one opp each, one
// renewal-imminent subscription each. A filter on "AAP" should collapse
// every area from 3 to 1.

const TODAY = new Date()
const NEAR_EOL = new Date(TODAY.getTime() + 15 * 86_400_000).toISOString() // 15 days  → red
const MID_EOL  = new Date(TODAY.getTime() + 60 * 86_400_000).toISOString() // 60 days  → amber
const LATE_EOL = new Date(TODAY.getTime() + 80 * 86_400_000).toISOString() // 80 days  → amber

const ACCOUNTS = [
  {
    name: 'Aap Widgets Inc',
    domain: 'aap.example.com',
    accountNumbers: [1001],
    ae: 'Test AE',
    segment: 'Commercial',
    productCount: 1,
    totalLicenses: 100,
    cachedAt: TODAY.toISOString(),
    products: [
      {
        sku: 'MCT9999',
        productDescription: 'Red Hat Ansible Automation Platform, Standard',
        quantity: 100,
        status: 'active',
        endDate: NEAR_EOL,
      },
    ],
  },
  {
    name: 'Ocp Systems Ltd',
    domain: 'ocp.example.com',
    accountNumbers: [1002],
    ae: 'Test AE',
    segment: 'Commercial',
    productCount: 1,
    totalLicenses: 200,
    cachedAt: TODAY.toISOString(),
    products: [
      {
        sku: 'MCT8888',
        productDescription: 'Red Hat OpenShift Container Platform, Premium',
        quantity: 200,
        status: 'active',
        endDate: MID_EOL,
      },
    ],
  },
  {
    name: 'Rhel Shop Corp',
    domain: 'rhel.example.com',
    accountNumbers: [1003],
    ae: 'Test AE',
    segment: 'Commercial',
    productCount: 1,
    totalLicenses: 300,
    cachedAt: TODAY.toISOString(),
    products: [
      {
        sku: 'MCT7777',
        productDescription: 'Red Hat Enterprise Linux Server, Premium',
        quantity: 300,
        status: 'active',
        endDate: LATE_EOL,
      },
    ],
  },
]

const CASES = [
  {
    caseNumber: 'CASE-AAP-001',
    summary: 'AAP playbook failure',
    status: 'Waiting on Red Hat',
    severity: '1',
    accountNumber: '1001',
    daysOpen: 2,
    product: 'Red Hat Ansible Automation Platform',
    customerName: 'Aap Widgets Inc',
  },
  {
    caseNumber: 'CASE-OCP-001',
    summary: 'OCP node NotReady',
    status: 'Waiting on Red Hat',
    severity: '2',
    accountNumber: '1002',
    daysOpen: 4,
    product: 'Red Hat OpenShift Container Platform',
    customerName: 'Ocp Systems Ltd',
  },
  {
    caseNumber: 'CASE-RHEL-001',
    summary: 'RHEL kernel panic',
    status: 'Waiting on Red Hat',
    severity: '3',
    accountNumber: '1003',
    daysOpen: 6,
    product: 'Red Hat Enterprise Linux',
    customerName: 'Rhel Shop Corp',
  },
]

const KPIS = {
  openCasesTotal: 3,
  sev1Count: 1,
  meetingsToday: 0,
  meetingsThisWeek: 0,
  renewalsWithin90Days: 3,
  totalAccounts: 3,
  totalProducts: 3,
  totalLicenses: 600,
}

const PIPELINE = {
  totalAcv: 300_000,
  openCount: 3,
  renewalAcv: 0,
  newAcv: 300_000,
  byStage: [{ stage: 'Commit', acv: 300_000, count: 3 }],
  byOwner: [{ owner: 'Test AE', acv: 300_000, count: 3 }],
  byQuarterStage: [],
  topOpps: [
    {
      oppNumber: 'OPP-AAP',
      accountName: 'Aap Widgets Inc',
      oppName: 'AAP Expansion',
      acv: 100_000,
      closeDate: NEAR_EOL,
      forecastCategory: 'Commit',
      owner: 'Test AE',
      renewal: false,
      offeringGroup: 'AAP',
      probability: 80,
      products: ['Red Hat Ansible Automation Platform'],
    },
    {
      oppNumber: 'OPP-OCP',
      accountName: 'Ocp Systems Ltd',
      oppName: 'OCP Expansion',
      acv: 100_000,
      closeDate: MID_EOL,
      forecastCategory: 'Commit',
      owner: 'Test AE',
      renewal: false,
      offeringGroup: 'OCP',
      probability: 80,
      products: ['Red Hat OpenShift Container Platform'],
    },
    {
      oppNumber: 'OPP-RHEL',
      accountName: 'Rhel Shop Corp',
      oppName: 'RHEL Renewal',
      acv: 100_000,
      closeDate: LATE_EOL,
      forecastCategory: 'Commit',
      owner: 'Test AE',
      renewal: true,
      offeringGroup: 'RHEL',
      probability: 80,
      products: ['Red Hat Enterprise Linux'],
    },
  ],
  closedOpps: [],
  techWinsNeeded: [],
  cachedAt: TODAY.toISOString(),
}

// Minimal CCSP payload — the spec only asserts that the request URL carries
// products=AAP, not the rendered tile content.
const CCSP = {
  totalAcv: 0,
  cachedAt: TODAY.toISOString(),
  byCustomer: [],
  byQuarter: [],
  byPartner: [],
  byAE: [],
}

// ── Route setup ────────────────────────────────────────────────────────────

async function installRoutes(page: Page) {
  // Core data
  await page.route('**/api/accounts**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ customers: ACCOUNTS }) })
  )
  await page.route('**/api/kpis**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(KPIS) })
  )
  await page.route('**/api/cases/all**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ cases: CASES, totalCount: CASES.length }) })
  )
  await page.route('**/api/pipeline**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PIPELINE) })
  )
  await page.route('**/api/ccsp**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CCSP) })
  )
  await page.route('**/api/calendar**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events: [] }) })
  )
  await page.route('**/api/morning-summary**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ signals: [] }) })
  )
  await page.route('**/api/pods**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pods: [] }) })
  )
  await page.route('**/api/scraper-status**', r =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        scrapers: {
          'rh-cases':    { state: 'ok', lastSuccess: TODAY.toISOString(), lastError: null },
          ccsp:          { state: 'ok', lastSuccess: TODAY.toISOString(), lastError: null },
          supportable:   { state: 'ok', lastSuccess: TODAY.toISOString(), lastError: null },
          'sf-pipeline': { state: 'ok', lastSuccess: TODAY.toISOString(), lastError: null },
        },
        supportableReachable: true,
      }),
    })
  )
  await page.route('**/api/health-scores**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
  )
  await page.route('**/api/products/alerts**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
  )
  await page.route('**/api/products/config**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
  )
  // Priority action endpoint fired per-account — fulfill with empty action
  await page.route('**/api/customer/*/priority-action**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ action: null }) })
  )
  // KPI history / sparklines — empty snapshots
  await page.route('**/api/kpi-history**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ snapshots: [] }) })
  )
  // RH auth status — already logged in, nothing to prompt
  await page.route('**/api/auth/redhat/status**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasSession: true, sessionExpired: false, lastScraped: TODAY.toISOString(), isRunning: false }) })
  )
  await page.route('**/health', r => {
    if (r.request().url().includes('/api/health')) return r.fallback()
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', aes: 1, customers: 3, session: true }) })
  })
}

async function selectAapChip(page: Page) {
  const chipBar = page.locator('[aria-label="Filter by product"]')
  await expect(chipBar).toBeVisible({ timeout: 5000 })

  // The bar contains "All Products" + discovered labels (RHEL/OCP/AAP only per App.tsx)
  const aapChip = chipBar.getByRole('button', { name: 'AAP', exact: true })
  await expect(aapChip).toBeVisible({ timeout: 2000 })
  await aapChip.click()
  await expect(aapChip).toHaveClass(/ring-accent/)

  // Let the React tree settle after filter toggles
  await page.waitForTimeout(300)
}

async function gotoDashboard(page: Page) {
  // Force fresh filter state
  await page.addInitScript(() => {
    localStorage.removeItem('product-filter-selected')
    localStorage.setItem('ae-filter-selected', 'all')
    localStorage.setItem('dashboard-view-mode', 'asa')
  })
  await page.goto(`${BASE_URL}/`)
  await page.waitForLoadState('networkidle')
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('Product Filter Coverage — cascade to all data areas', () => {
  test('AAP chip filters KPI tiles (Open Cases, Sev 1)', async ({ page }) => {
    await installRoutes(page)
    await gotoDashboard(page)

    // KPICard shape:
    //   <div class="bg-surface ... gap-4">              ← outer card (not stable)
    //     <div class="w-10 h-10 ...">icon</div>
    //     <div class="min-w-0 flex-1">                   ← inner wrapper
    //       <div class="flex items-center gap-2">
    //         <div class="text-2xl ...">{value}</div>
    //       </div>
    //       <div class="text-sm ...">{label}</div>
    //     </div>
    //   </div>
    //
    // Scope via the inner wrapper so label uniquely pairs with value.
    function tileValue(label: string) {
      // Locate the label span directly (text-sm div with exact label text), then
      // walk up to its KPICard inner wrapper (div.flex-1) and down to the value.
      // Anchoring on the label text is unambiguous — each KPICard has exactly
      // one matching <div class="text-sm ...">{label}</div>.
      return page
        .locator(`div.text-sm:text-is("${label}")`)
        .locator('xpath=..')
        .locator('div.text-2xl')
        .first()
    }

    const openCasesValue = tileValue('Open Cases')
    const sev1Value = tileValue('Sev 1 Cases')

    // Filtered: select AAP and assert "filtered / total" format.
    await selectAapChip(page)

    // Open Cases: 1 AAP-tagged case of 3 total — "1 / 3"
    await expect(openCasesValue).toHaveText(/^1\s*\/\s*3$/, { timeout: 3000 })

    // Sev 1 Cases: 1 AAP-tagged sev1 of 1 total sev1 — "1 / 1"
    await expect(sev1Value).toHaveText(/^1\s*\/\s*1$/, { timeout: 3000 })
  })

  test('AAP chip filters the account card list', async ({ page }) => {
    await installRoutes(page)
    await gotoDashboard(page)

    const accountsSection = page.locator('#section-accounts')
    const cardLinks = accountsSection.locator('a[href^="/dashboard/customer/"]')

    // Baseline — 3 account cards before filter
    await expect(cardLinks).toHaveCount(3, { timeout: 5000 })

    await selectAapChip(page)

    // After filter — only the AAP account remains
    await expect(cardLinks).toHaveCount(1, { timeout: 3000 })
    await expect(cardLinks.first()).toHaveAttribute('href', /Aap%20Widgets%20Inc/)
  })

  test('AAP chip filters the ACV / renewal tiles (Expiring, 30-90)', async ({ page }) => {
    await installRoutes(page)
    await gotoDashboard(page)

    // Renewal tiles show day-count buckets:
    //   AAP end-date 15d  → red   (Expiring Within 30 Days)
    //   OCP end-date 60d  → amber (Renewals in 30-90 Days)
    //   RHEL end-date 80d → amber (Renewals in 30-90 Days)
    // Filter AAP → red 1/1, amber 0/2.

    function tileValue(label: string) {
      // Locate the label span directly (text-sm div with exact label text), then
      // walk up to its KPICard inner wrapper (div.flex-1) and down to the value.
      // Anchoring on the label text is unambiguous — each KPICard has exactly
      // one matching <div class="text-sm ...">{label}</div>.
      return page
        .locator(`div.text-sm:text-is("${label}")`)
        .locator('xpath=..')
        .locator('div.text-2xl')
        .first()
    }

    await selectAapChip(page)

    const expiringValue = tileValue('Expiring Within 30 Days')
    await expect(expiringValue).toHaveText(/^1\s*\/\s*1$/, { timeout: 3000 })

    const renewalsValue = tileValue('Renewals in 30-90 Days')
    await expect(renewalsValue).toHaveText(/^0\s*\/\s*2$/, { timeout: 3000 })
  })

  test('AAP chip causes /api/ccsp request to include products=AAP', async ({ page }) => {
    await installRoutes(page)
    await gotoDashboard(page)

    // Arm the listener BEFORE clicking — the filter toggle triggers a
    // fresh /api/ccsp fetch because ccspQueryStr changes.
    const ccspRequestPromise = page.waitForRequest(
      req => req.url().includes('/api/ccsp') && req.url().includes('products=AAP'),
      { timeout: 5000 },
    )

    await selectAapChip(page)

    const req = await ccspRequestPromise
    expect(req.url()).toContain('products=AAP')
  })

  test('AAP chip filters the Pipeline section to AAP opps only', async ({ page }) => {
    await installRoutes(page)
    await gotoDashboard(page)

    const pipelineSection = page.locator('#section-pipeline')

    // Baseline — 3 opp rows visible (one per account)
    // Opp rows are <button> elements containing the account name.
    const oppRows = pipelineSection.locator('button', {
      has: page.locator('span.text-sm.text-text-primary'),
    })

    // Scope more narrowly to the opps list itself — buttons in the pipeline
    // header / filter chips would otherwise match.
    const aapRow = pipelineSection.locator('button', { hasText: 'Aap Widgets Inc' })
    const ocpRow = pipelineSection.locator('button', { hasText: 'Ocp Systems Ltd' })
    const rhelRow = pipelineSection.locator('button', { hasText: 'Rhel Shop Corp' })

    await expect(aapRow).toHaveCount(1, { timeout: 5000 })
    await expect(ocpRow).toHaveCount(1)
    await expect(rhelRow).toHaveCount(1)

    await selectAapChip(page)

    await expect(aapRow).toHaveCount(1, { timeout: 3000 })
    await expect(ocpRow).toHaveCount(0)
    await expect(rhelRow).toHaveCount(0)

    // Silence unused warning — retained for readability of the baseline intent
    void oppRows
  })
})
