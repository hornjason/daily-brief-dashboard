/**
 * BKL-HERO-01 Phase 1 — Step 0 Region & Pod Access UI tests.
 *
 * Tests the Step0RegionAccess component end-to-end against the test container
 * (port 7776). The seed config has West Commercial + Central Enterprise – TOLA
 * as selectable regions, no East regions, and no `enabledRegions` key — so
 * Step 0 renders on first load.
 *
 * Settings cleanup: POST /api/regions/access mutates settings.json, which the
 * snapshot/restore API does NOT cover (it only handles aes/customers). We reset
 * settings.json by copying the seed file directly on the host before each test.
 * The test container mounts data-test/ as a volume so the host copy is immediately
 * visible to the server on the next request — no restart required.
 */
import { test, expect } from '@playwright/test'
import { copyFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_SETTINGS = resolve(__dirname, '../../scripts/seed-data/settings.json')
const TEST_SETTINGS = resolve(__dirname, '../../data-test/config/settings.json')

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'
const SETUP_URL = `${BASE}/dashboard/setup`

test.describe.configure({ mode: 'serial' })

test.describe('@destructive BKL-HERO-01 Phase 1 — Step 0 Region & Pod Access', () => {
  // Serial mode: tests run on a single worker in order so state resets are safe.
  //
  // beforeEach copies the clean seed settings.json (no enabledRegions key) over
  // the test container's live settings.json via the host-mounted volume. The
  // server reads settings from disk on every request, so the next page load sees
  // the clean state immediately — no server restart required.
  test.beforeEach(async () => {
    try {
      copyFileSync(SEED_SETTINGS, TEST_SETTINGS)
    } catch (e) {
      console.warn(`[step0 beforeEach] settings reset skipped: ${e}`)
    }
  })

  test.afterAll(async () => {
    try {
      copyFileSync(SEED_SETTINGS, TEST_SETTINGS)
    } catch (e) {
      console.warn(`[step0 afterAll] settings cleanup skipped: ${e}`)
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
