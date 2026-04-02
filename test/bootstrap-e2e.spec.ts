/**
 * Bootstrap E2E Test — Full wizard-driven bootstrap for Carolanne Farrell.
 *
 * !! READ THIS FIRST — THE AUTHORITATIVE FLOW !!
 *
 * Customer names DO NOT come from manual entry or customers.json edits.
 * They come from the territory Google Sheet via the POD + Territory dropdown.
 *
 * Full flow:
 *   1. Setup page → AEs & Customers section
 *   2. Fill SF Report ID
 *   3. Select POD (e.g. WEST_COMM_CORP_NORTHWEST)
 *   4. Select Territory number (e.g. 01) → live lookup fires → auto-fills AE name + customer list from territory sheet
 *   5. Enter parent Drive folder URL (where bootstrap creates the AE subfolder)
 *   6. Click "Set Up AE" → triggers POST /api/bootstrap/auto automatically
 *   7. Bootstrap runs 6 steps: Drive folder → Customer folders →
 *      Supportable discovery+scrape → Supportable sheet → CCSP sheet → Pipeline sheet
 *
 * Test fixtures: test/config/test-fixtures.json
 *   - parentDriveFolderUrl — the parent folder where bootstrap creates the AE folder
 *   - aes[] — AE names, POD/territory, SF report IDs to test with (never wiped by resets)
 *
 * Prerequisites before running:
 *   1. aes.json reset to {"aes": []} — no pre-existing AEs
 *   2. customers.json reset to {"customers": []}
 *   3. Cache cleared: delete all files in data/cache/
 *   4. RH Portal connected, Salesforce connected, Tableau session valid, VPN on
 *   5. Google auth active (Drive + Sheets write scope)
 *   6. Restart server after config changes: podman restart pai-dashboard (or make rebuild)
 *
 * Run: npx playwright test test/bootstrap-e2e.spec.ts --timeout=600000
 *
 * NOTE: This test mutates aes.json and customers.json intentionally.
 * Do NOT run in parallel with other suites.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'

const fixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname!, 'config/test-fixtures.json'), 'utf-8')
)
const { parentDriveFolderUrl, aes: testAes } = fixtures.bootstrap
const targetAe = testAes[0] // Carolanne Farrell

// Bootstrap can take up to 20 minutes (SF pipeline sync is the slow step)
test.setTimeout(1_200_000)

// Must run serially — each phase depends on the previous phase completing
test.describe.configure({ mode: 'serial' })

// ── Pre-flight checks ─────────────────────────────────────────────────────────

test.describe('0. Pre-flight: connections and clean state', () => {
  test('RH Portal session is active', async ({ request }) => {
    const res = await request.get(`${BASE}/api/auth/redhat/status`)
    const body = await res.json()
    expect(body.hasSession, 'RH Portal not connected — connect first').toBe(true)
    expect(body.sessionExpired).toBe(false)
  })

  test('Salesforce session is active and report configured', async ({ request }) => {
    const res = await request.get(`${BASE}/api/auth/salesforce/status`)
    const body = await res.json()
    expect(body.hasSession, 'Salesforce not connected — connect first').toBe(true)
    expect(body.reportConfigured, 'Salesforce report not configured').toBe(true)
  })

  test('Tableau session is valid', async ({ request }) => {
    const res = await request.get(`${BASE}/api/bootstrap/tableau/session-status`)
    const body = await res.json()
    expect(body.sessionValid, 'Tableau not logged in — connect via Setup page first').toBe(true)
  })

  test('Supportable VPN is reachable', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/supportable/check`)
    const body = await res.json()
    expect(body.reachable, 'VPN not active — connect to Red Hat VPN first').toBe(true)
  })

  test('cache is empty before bootstrap', async ({ request }) => {
    const res = await request.get(`${BASE}/api/cache/status`)
    const body = await res.json()
    expect(body.ccsp.lastModified, 'Cache not cleared — delete all files in data/cache/ first').toBeNull()
    expect(body.pipeline.lastModified).toBeNull()
    expect(body.rh_cases.lastModified).toBeNull()
  })

  test('no AEs configured (clean slate)', async ({ request }) => {
    const res = await request.get(`${BASE}/api/aes`)
    const { aes } = await res.json()
    expect(aes.length, 'aes.json not cleared — reset to {"aes": []} and restart server').toBe(0)
  })

  test('customers list is empty (clean slate)', async ({ request }) => {
    const res = await request.get(`${BASE}/customers`)
    const customers = await res.json()
    expect(Array.isArray(customers), '/customers did not return an array').toBe(true)
    expect(customers.length, 'customers.json not cleared — reset to {"customers": []}').toBe(0)
  })
})

// ── Wizard UI flow ────────────────────────────────────────────────────────────

test.describe('1. Wizard: territory lookup populates AE name + customers from sheet', () => {
  test('Setup page loads and AEs section is accessible', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await expect(page.getByText('AEs & Customers')).toBeVisible({ timeout: 10_000 })
  })

  test('POD dropdown loads territory options after selection', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.getByText('AEs & Customers').click()

    const podSelect = page.locator('select').first()
    await podSelect.waitFor({ state: 'visible', timeout: 10_000 })
    await podSelect.selectOption(targetAe.pod)

    const terrSelect = page.locator('select').nth(1)
    await expect(terrSelect).not.toBeDisabled({ timeout: 15_000 })
  })

  test('selecting territory triggers live lookup — AE name and customer list auto-fill', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.getByText('AEs & Customers').click()

    // Select POD
    const podSelect = page.locator('select').first()
    await podSelect.waitFor({ state: 'visible', timeout: 10_000 })
    await podSelect.selectOption(targetAe.pod)

    // Wait for territory dropdown to populate, then select territory
    const terrSelect = page.locator('select').nth(1)
    await expect(terrSelect).not.toBeDisabled({ timeout: 15_000 })
    await terrSelect.selectOption(targetAe.territory)

    // Live lookup fires — AE name fills (placeholder "Jane Smith")
    const aeNameInput = page.locator('input[placeholder="Jane Smith"]')
    await expect(aeNameInput).not.toHaveValue('', { timeout: 20_000 })

    // Customer names textarea fills from territory sheet
    const customerTextarea = page.locator('textarea').first()
    await expect(customerTextarea).not.toHaveValue('', { timeout: 20_000 })

    const customers = await customerTextarea.inputValue()
    expect(customers.split('\n').filter(Boolean).length).toBeGreaterThan(0)
  })
})

// ── Bootstrap trigger via Set Up AE button ───────────────────────────────────

test.describe('2. Bootstrap: triggered by Set Up AE button', () => {
  test('filling form and clicking Set Up AE starts bootstrap', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.getByText('AEs & Customers').click()

    // Fill SF Report ID
    await page.locator('input[placeholder*="00OPe"]').fill(targetAe.sfReportId)

    // Select POD + territory
    const podSelect = page.locator('select').first()
    await podSelect.selectOption(targetAe.pod)
    const terrSelect = page.locator('select').nth(1)
    await expect(terrSelect).not.toBeDisabled({ timeout: 15_000 })
    await terrSelect.selectOption(targetAe.territory)

    // Wait for live lookup to auto-fill AE name + customers
    const aeNameInput = page.locator('input[placeholder="Jane Smith"]')
    await expect(aeNameInput).not.toHaveValue('', { timeout: 20_000 })
    const customerTextarea = page.locator('textarea').first()
    await expect(customerTextarea).not.toHaveValue('', { timeout: 20_000 })

    // Fill parent Drive folder URL
    const folderInput = page.locator('input[placeholder*="drive.google.com"], input[placeholder*="folder"], input[placeholder*="Drive"]').first()
    if (await folderInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await folderInput.fill(parentDriveFolderUrl)
    }

    // Button should now be enabled
    const setupBtn = page.getByRole('button', { name: /set up ae/i })
    await expect(setupBtn).toBeEnabled({ timeout: 10_000 })
    await setupBtn.click()

    // Bootstrap progress UI should appear — unique "Setting up <name>…" header only renders after bootstrap starts
    await expect(page.getByText(/Setting up .+…/i)).toBeVisible({ timeout: 15_000 })
  })

  test('bootstrap API confirms running after Set Up AE click', async ({ request }) => {
    // Poll briefly — serial mode means this runs right after the click test
    let body: any
    for (let i = 0; i < 6; i++) {
      const res = await request.get(`${BASE}/api/bootstrap/auto/status`)
      body = await res.json()
      if (body.running || body.completedAt) break
      await new Promise(r => setTimeout(r, 2_000))
    }
    expect(body.running || body.completedAt, 'Bootstrap did not start within 12 seconds of clicking Set Up AE').toBeTruthy()
  })
})

// ── Wait for completion ───────────────────────────────────────────────────────

test.describe('3. Bootstrap: all 6 steps complete without error', () => {
  test('all 6 steps reach done status within 20 minutes', async ({ request }) => {
    const deadline = Date.now() + 20 * 60 * 1000
    let status: any

    while (Date.now() < deadline) {
      const res = await request.get(`${BASE}/api/bootstrap/auto/status`)
      status = await res.json()
      if (status.completedAt || (!status.running && status.steps.length > 0)) break
      await new Promise(r => setTimeout(r, 5_000))
    }

    expect(status.error, `Bootstrap error: ${status.error}`).toBeNull()
    expect(status.completedAt).toBeTruthy()

    const steps = status.steps as Array<{ status: string; name?: string }>
    expect(steps).toHaveLength(6)
    for (const step of steps) {
      expect(step.status, `Step "${step.name}" ended with: ${step.status}`).toBe('done')
    }
  })
})

// ── Post-bootstrap validation ─────────────────────────────────────────────────

test.describe('4. Post-bootstrap: sheets, cache, and customer data populated', () => {
  test('AE was created with Drive folder and all three sheet IDs', async ({ request }) => {
    const res = await request.get(`${BASE}/api/aes`)
    const { aes } = await res.json()
    const ae = aes.find((a: any) => a.name === targetAe.name)
    expect(ae, `${targetAe.name} not found in aes after bootstrap`).toBeDefined()
    expect(ae.driveFolderId, 'driveFolderId missing — Drive folder not created').toBeTruthy()
    expect(ae.supportableSheetId, 'supportableSheetId missing').toBeTruthy()
    expect(ae.ccspSheetId, 'ccspSheetId missing').toBeTruthy()
    expect(ae.pipelineSheetId, 'pipelineSheetId missing').toBeTruthy()
  })

  test('CCSP and pipeline scrapes ran during bootstrap', async ({ request }) => {
    // Bootstrap writes directly to Google Sheets — local cache is populated on the next dashboard load.
    // Validate via scrape status timestamps which ARE set during bootstrap steps 5 and 6.
    const res = await request.get(`${BASE}/api/status/scrapes`)
    const body = await res.json()
    expect(body.ccsp.lastSync, 'CCSP scrape never ran during bootstrap').toBeTruthy()
    expect(body.salesforce.lastSync, 'Pipeline (Salesforce) sync never ran during bootstrap').toBeTruthy()
  })

  test('customers have account numbers from Supportable discovery', async ({ request }) => {
    const res = await request.get(`${BASE}/customers`)
    const customers = await res.json()
    const withAccounts = customers.filter((c: any) => (c.accountNumbers?.length ?? 0) > 0)
    expect(withAccounts.length, 'No customers have account numbers — Supportable discovery failed').toBeGreaterThan(0)
  })

  test('scrape status shows Supportable and CCSP synced', async ({ request }) => {
    const res = await request.get(`${BASE}/api/status/scrapes`)
    const body = await res.json()
    expect(body.supportable.lastSync, 'Supportable never synced').toBeTruthy()
    expect(body.ccsp.lastSync, 'CCSP never synced').toBeTruthy()
  })
})
