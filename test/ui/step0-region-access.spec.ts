/**
 * BKL-HERO-01 Phase 1 — Step 0 Region & Pod Access UI tests.
 *
 * Tests the Step0RegionAccess component end-to-end against the test container
 * (port 7776). The seed config has West Commercial + Central Enterprise – TOLA
 * as selectable regions, no East regions, and no `enabledRegions` key — so
 * Step 0 renders on first load.
 *
 * Snapshot/restore wraps every test to keep settings.json clean — POSTing
 * to /api/regions/access mutates the file.
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'
const SETUP_URL = `${BASE}/dashboard/setup`

test.describe('@destructive BKL-HERO-01 Phase 1 — Step 0 Region & Pod Access', () => {
  test.beforeEach(async ({ request }) => {
    try {
      const r = await request.post(`${BASE}/api/__test/snapshot`)
      const d = await r.json().catch(() => ({}))
      if (!d.ok) console.warn(`[step0 beforeEach] snapshot not-ok: ${JSON.stringify(d)}`)
    } catch (e) {
      console.warn(`[step0 beforeEach] snapshot skipped: ${e}`)
    }
  })

  test.afterEach(async ({ request }) => {
    try {
      const r = await request.post(`${BASE}/api/__test/restore`, { data: { force: true } })
      const d = await r.json().catch(() => ({}))
      if (!d.ok) console.error(`[step0 afterEach] restore failed: ${JSON.stringify(d)}`)
    } catch (e) {
      console.error(`[step0 afterEach] restore error: ${e}`)
    }
  })

  test('renders Step 0 with West and TOLA selectable, no East', async ({ page }) => {
    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })

    const step0 = page.getByTestId('step0-region-access')
    await expect(step0).toBeVisible({ timeout: 10_000 })

    // West Commercial selectable
    const west = page.getByTestId('region-row-west-commercial')
    await expect(west).toBeVisible()
    await expect(page.getByTestId('region-checkbox-west-commercial')).toBeEnabled()

    // TOLA selectable
    const tola = page.getByTestId('region-row-central-enterprise-tola')
    await expect(tola).toBeVisible()
    await expect(page.getByTestId('region-checkbox-central-enterprise-tola')).toBeEnabled()

    // No East regions in seed
    await expect(page.getByTestId('region-row-east-commercial')).toHaveCount(0)
    await expect(page.getByTestId('region-row-east-enterprise')).toHaveCount(0)
  })

  test('expand and collapse a region', async ({ page }) => {
    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('step0-region-access')).toBeVisible({ timeout: 10_000 })

    const toggle = page.getByTestId('region-toggle-west-commercial')
    // Initially collapsed: no pod checkboxes visible for any West pod
    const podCheckboxes = page.locator('[data-testid^="pod-checkbox-west-commercial."]')
    await expect(podCheckboxes.first()).not.toBeVisible()

    // Expand
    await toggle.click()
    await expect(podCheckboxes.first()).toBeVisible({ timeout: 3000 })

    // Collapse again
    await toggle.click()
    await expect(podCheckboxes.first()).not.toBeVisible({ timeout: 3000 })
  })

  test('individual pod checkbox updates selection', async ({ page }) => {
    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('step0-region-access')).toBeVisible({ timeout: 10_000 })

    // Expand West
    await page.getByTestId('region-toggle-west-commercial').click()

    const podKey = 'west-commercial.WEST_COMM_CORP_NORTHWEST'
    const checkbox = page.getByTestId(`pod-checkbox-${podKey}`)
    await expect(checkbox).toBeVisible({ timeout: 3000 })

    // Check it
    await checkbox.check()
    await expect(checkbox).toBeChecked()

    // Counter reflects selection
    await expect(page.getByTestId('step0-counter')).toContainText('1 pod selected')
  })

  test('Save & Next disabled until ≥1 pod selected, enabled once selected', async ({ page }) => {
    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('step0-region-access')).toBeVisible({ timeout: 10_000 })

    const save = page.getByTestId('step0-save')
    await expect(save).toBeDisabled()

    // Expand and check a pod
    await page.getByTestId('region-toggle-west-commercial').click()
    await page.getByTestId('pod-checkbox-west-commercial.WEST_COMM_CORP_NORTHWEST').check()

    await expect(save).toBeEnabled()
  })

  test('successful save — POST fires and Step 0 collapses to summary', async ({ page }) => {
    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('step0-region-access')).toBeVisible({ timeout: 10_000 })

    // Select a pod
    await page.getByTestId('region-toggle-west-commercial').click()
    await page.getByTestId('pod-checkbox-west-commercial.WEST_COMM_CORP_NORTHWEST').check()

    // Watch the POST
    const postPromise = page.waitForResponse(r =>
      r.url().includes('/api/regions/access') && r.request().method() === 'POST',
    )
    await page.getByTestId('step0-save').click()
    const res = await postPromise
    expect(res.status()).toBe(200)

    // Summary state is visible and contains the pod label
    const summary = page.getByTestId('step0-summary')
    await expect(summary).toBeVisible({ timeout: 5000 })
    await expect(summary).toContainText('Northwest Corp')
  })

  test('Edit link reopens the Step 0 form', async ({ page }) => {
    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('step0-region-access')).toBeVisible({ timeout: 10_000 })

    // Save once
    await page.getByTestId('region-toggle-west-commercial').click()
    await page.getByTestId('pod-checkbox-west-commercial.WEST_COMM_CORP_NORTHWEST').check()
    await page.getByTestId('step0-save').click()

    const summary = page.getByTestId('step0-summary')
    await expect(summary).toBeVisible({ timeout: 5000 })

    // Click Edit
    await page.getByTestId('step0-edit').click()

    // Form is back
    await expect(page.getByTestId('step0-region-access')).toBeVisible({ timeout: 3000 })
    await expect(page.getByTestId('step0-save')).toBeVisible()
  })

  test('TOLA region — single-pod auto-select when region checked, no pod sub-UI', async ({ page }) => {
    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('step0-region-access')).toBeVisible({ timeout: 10_000 })

    // Check the TOLA region header
    await page.getByTestId('region-checkbox-central-enterprise-tola').check()

    // Save & Next becomes enabled because the lone pod auto-selected
    await expect(page.getByTestId('step0-save')).toBeEnabled()

    // Counter reflects 1 pod selected
    await expect(page.getByTestId('step0-counter')).toContainText('1 pod selected')

    // Expand TOLA — no pod checkbox should be rendered (single-territory message instead)
    await page.getByTestId('region-toggle-central-enterprise-tola').click()
    const tolaPodCheckbox = page.getByTestId('pod-checkbox-central-enterprise-tola.CENTRAL_ENT_TOLA')
    await expect(tolaPodCheckbox).toHaveCount(0)
  })

  test('Coming Soon region — checkbox disabled, reason visible when expanded', async ({ page }) => {
    // Inject a synthetic "Coming Soon" region into the catalog response so the
    // visual + disabled-checkbox path is covered even when seed has none.
    await page.route('**/api/regions/catalog', async (route) => {
      const upstream = await route.fetch()
      const body = await upstream.json()
      const next = {
        regions: [
          ...body.regions,
          {
            id: 'east-commercial',
            label: 'East Commercial',
            selectable: false,
            comingSoonReason: 'Missing: sfReportId on any pod',
            pods: [],
          },
        ],
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(next),
      })
    })

    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('step0-region-access')).toBeVisible({ timeout: 10_000 })

    const east = page.getByTestId('region-row-east-commercial')
    await expect(east).toBeVisible()
    await expect(page.getByTestId('region-checkbox-east-commercial')).toBeDisabled()

    // Expand and verify the reason text appears
    await page.getByTestId('region-toggle-east-commercial').click()
    const reason = page.getByTestId('region-coming-soon-reason-east-commercial')
    await expect(reason).toBeVisible({ timeout: 3000 })
    await expect(reason).toContainText('sfReportId')
  })
})
