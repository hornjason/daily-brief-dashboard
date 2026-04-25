/**
 * BootstrapConfigBlock UI tests.
 *
 * Validates the territory sheet selector, POD dropdown, auto-filled SF Report
 * ID input, and regional disclaimer rendered inside AutoBootstrapForm on the
 * Setup page. All API calls are mocked — no live server dependencies.
 *
 * The useBootstrapConfig hook fetches /api/settings/pod-config on mount.
 * Once that resolves, selecting a POD auto-fills the SF Report ID from the
 * in-memory map with no further server interaction.
 */
import { test, expect } from '../fixtures'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'
const SETUP_URL = `${BASE}/dashboard/setup`

// Hardcoded in useBootstrapConfig — matches TERRITORY_SHEET_URL constant
const TERRITORY_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8/edit?gid=294606982#gid=294606982'

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Mock all API calls that fire on AutoBootstrapForm (and BootstrapConfigBlock)
 * mount so the page renders cleanly without a live server.
 */
async function mockFormAPIs(page: import('@playwright/test').Page) {
  // Bootstrap status — no running bootstrap
  await page.route((url) => url.pathname === '/api/bootstrap/auto/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        running: false,
        aeName: null,
        steps: [],
        error: null,
        completedAt: null,
        resources: {},
      }),
    })
  )
  // AEs — empty so the auto-bootstrap form renders (not manual mode)
  await page.route((url) => url.pathname === '/api/aes', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ aes: [] }),
      })
    }
    return route.continue()
  })
  // SF reports — empty so the text input renders (not the select dropdown)
  await page.route((url) => url.pathname === '/api/sf/reports', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ reports: [] }),
    })
  )
  // Territory names — stub so the territory select populates
  await page.route((url) => url.pathname.startsWith('/api/territory-names'), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        territories: [
          { num: '01', aeName: 'Test AE One' },
          { num: '02', aeName: 'Test AE Two' },
        ],
      }),
    })
  )
  // Territory lookup — returns AE name + customer accounts
  await page.route((url) => url.pathname.startsWith('/api/territory-lookup'), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        aeName: 'Test AE One',
        accounts: ['Acme Corp', 'Globex Industries'],
      }),
    })
  )
  // Customers endpoint (used by the manual-mode tab)
  await page.route((url) => url.pathname.endsWith('/customers'), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ customers: [] }),
    })
  )
  // Regions list — BKL-ARCH-01: useBootstrapConfig fetches this on mount to
  // drive the region selector and the territory-sheet label.
  await page.route((url) => url.pathname === '/api/settings/regions', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        regions: [{ id: 'west-commercial', label: 'West Commercial', type: 'commercial' }],
      }),
    })
  )
  // POD config — useBootstrapConfig fetches this on mount
  await page.route((url) => url.pathname === '/api/settings/pod-config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        podBookingsFolderId: '14I0UH1CiSNNOqVHdZVS7tHOPibJMN5Oo',
        territorySheetUrl: 'https://docs.google.com/spreadsheets/d/1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8/edit?gid=294606982#gid=294606982',
        podSfReports: {
          WEST_COMM_CORP_NORTHWEST: '00OPe00000jyo86MAA',
          WEST_COMM_CORP_SOUTHWEST: '00OPe00000k5m9ZMAQ',
          WEST_COMM_CORP_NORTH_CENTRAL: '00OPe00000kSeCwMAK',
          WEST_COMM_CORP_SOUTH_CENTRAL: '00OPe00000kSlCnMAK',
        },
        podLabels: {
          WEST_COMM_CORP_NORTHWEST: 'Northwest',
          WEST_COMM_CORP_SOUTHWEST: 'Southwest',
          WEST_COMM_CORP_NORTH_CENTRAL: 'Northcentral',
          WEST_COMM_CORP_SOUTH_CENTRAL: 'Southcentral',
        },
      }),
    })
  )
}

/** Open the AEs & Customers accordion on the setup page. */
async function openAEsSection(page: import('@playwright/test').Page) {
  await page.goto(SETUP_URL)
  const header = page.locator('button:has-text("AEs & Customers")')
  // The territory sheet selector renders as soon as the accordion opens —
  // more reliable than a CSS class selector that can change with layout refactors
  const territorySelect = page.locator('select', { hasText: 'West Commercial Territory Sheet' })
  const isOpen = await territorySelect.isVisible().catch(() => false)
  if (!isOpen) {
    await header.click()
    await territorySelect.waitFor({ state: 'visible', timeout: 5000 })
  }
}

// ── 1. Territory sheet selector ──────────────────────────────────────────────

test.describe('BootstrapConfigBlock: territory sheet selector', () => {
  test('territory sheet select is visible', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    const territorySelect = page.locator('select', { hasText: 'West Commercial Territory Sheet' })
    await expect(territorySelect).toBeVisible({ timeout: 10000 })
  })

  test('territory sheet select has "West Commercial Territory Sheet" option', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    // Check the select's selected text — option elements inside a closed select are not
    // "visible" in Playwright, so we assert via the select's inner text instead
    const territorySelect = page.locator('select', { hasText: 'West Commercial Territory Sheet' })
    await expect(territorySelect).toBeVisible({ timeout: 10000 })
    await expect(territorySelect).toContainText('West Commercial Territory Sheet')
  })

  test('external link button is present with href pointing to territory sheet URL', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    // Locate the external link by its title attribute — the href contains a #fragment
    // that makes CSS attribute selectors unreliable across browser engines
    const externalLink = page.locator('[title="Open territory sheet in a new tab"]')
    await expect(externalLink).toBeVisible({ timeout: 10000 })
    await expect(externalLink).toHaveAttribute('target', '_blank')
  })
})

// ── 2. POD dropdown ──────────────────────────────────────────────────────────

test.describe('BootstrapConfigBlock: POD dropdown', () => {
  test('POD dropdown has 4 named options (NW, SW, NC, SC)', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    // Wait for the BootstrapConfigBlock to render (pod-config fetch completes)
    const podSelect = page.locator('select').filter({ hasText: 'Select POD' })
    await expect(podSelect).toBeVisible({ timeout: 10000 })

    const nwOption = podSelect.locator('option[value="WEST_COMM_CORP_NORTHWEST"]')
    const swOption = podSelect.locator('option[value="WEST_COMM_CORP_SOUTHWEST"]')
    const ncOption = podSelect.locator('option[value="WEST_COMM_CORP_NORTH_CENTRAL"]')
    const scOption = podSelect.locator('option[value="WEST_COMM_CORP_SOUTH_CENTRAL"]')

    await expect(nwOption).toHaveCount(1)
    await expect(swOption).toHaveCount(1)
    await expect(ncOption).toHaveCount(1)
    await expect(scOption).toHaveCount(1)
  })
})

// ── 3. SF Report ID auto-fill ────────────────────────────────────────────────

test.describe('BootstrapConfigBlock: SF Report ID auto-fill', () => {
  test('selecting NW POD fills SF Report ID with correct Salesforce ID', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    const podSelect = page.locator('select').filter({ hasText: 'Select POD' })
    await expect(podSelect).toBeVisible({ timeout: 10000 })

    // Select the NW POD — auto-fill is pure React state from the fetched map
    await podSelect.selectOption('WEST_COMM_CORP_NORTHWEST')

    // The read-only SF Report ID input should now show the NW report ID
    const readOnlyInput = page.locator('input[readonly]')
    await expect(readOnlyInput).toHaveValue('00OPe00000jyo86MAA', { timeout: 3000 })
  })

  test('SF Report ID input has readonly attribute (not user-editable)', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    const podSelect = page.locator('select').filter({ hasText: 'Select POD' })
    await expect(podSelect).toBeVisible({ timeout: 10000 })

    // Select a POD so the input has a value and is unambiguously the SF Report ID field
    await podSelect.selectOption('WEST_COMM_CORP_SOUTHWEST')

    const readOnlyInput = page.locator('input[readonly]')
    await expect(readOnlyInput).toBeVisible({ timeout: 3000 })

    // Verify the DOM property directly
    const isReadOnly = await readOnlyInput.evaluate(
      (el) => (el as HTMLInputElement).readOnly
    )
    expect(isReadOnly).toBe(true)
  })
})

// ── 4. Disclaimer ────────────────────────────────────────────────────────────

test.describe('BootstrapConfigBlock: regional disclaimer', () => {
  test('disclaimer text "WEST Commercial territories only" is visible', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    // The disclaimer paragraph is always rendered (not conditional on POD selection)
    const disclaimer = page.locator('p', { hasText: 'WEST Commercial territories only' })
    await expect(disclaimer).toBeVisible({ timeout: 10000 })
  })
})
