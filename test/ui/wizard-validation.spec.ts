/**
 * Wizard input validation UI tests.
 *
 * Validates the AutoBootstrapForm inside the AEs & Customers accordion
 * on the Setup page. Covers disabled submit button for empty fields,
 * SF Report ID format validation on blur, Drive folder URL validation
 * via the server endpoint, territory lookup failure handling, and
 * error-clearing behavior on field edits.
 *
 * All API calls are mocked via page.route() — no real server calls needed
 * beyond page load. Tests never actually submit the form.
 */
import { test, expect } from '../fixtures'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'
const SETUP_URL = `${BASE}/dashboard/setup`

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Mock all API calls that fire on AutoBootstrapForm mount so the form
 * renders cleanly without requiring a live server with Salesforce/Google.
 */
async function mockFormAPIs(page: import('@playwright/test').Page) {
  // Bootstrap status — no running bootstrap
  await page.route('**/api/bootstrap/auto/status', (route) =>
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
  // AEs — empty so the auto-bootstrap form shows (not manual mode)
  await page.route('**/api/aes', (route) => {
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
  await page.route('**/api/sf/reports', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ reports: [] }),
    })
  )
  // Territory names — stub with one option so the territory select populates
  await page.route('**/api/territory-names**', (route) =>
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
  await page.route('**/api/territory-lookup**', (route) =>
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
  await page.route('**/customers', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ customers: [] }),
    })
  )
}

/** Open the AEs & Customers accordion on the setup page. */
async function openAEsSection(page: import('@playwright/test').Page) {
  await page.goto(SETUP_URL)
  // Click the AEs & Customers accordion header to expand it
  const header = page.locator('button:has-text("AEs & Customers")')
  // If it is already open (section content visible), skip clicking
  const sectionContent = page.locator('#aes .pt-4')
  const isOpen = await sectionContent.isVisible().catch(() => false)
  if (!isOpen) {
    await header.click()
    await sectionContent.waitFor({ state: 'visible', timeout: 5000 })
  }
}

/** Locate the "Set Up AE" submit button. */
function submitButton(page: import('@playwright/test').Page) {
  return page.locator('button', { hasText: 'Set Up AE' })
}

// ── 1. Submit button disabled when required fields are empty ───────────────

test.describe('Wizard validation: required fields gate the submit button', () => {
  test('submit button is disabled when all fields are empty', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    const btn = submitButton(page)
    await expect(btn).toBeVisible({ timeout: 10000 })
    await expect(btn).toBeDisabled()
  })

  test('submit button stays disabled with only AE name filled', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    const btn = submitButton(page)
    await expect(btn).toBeVisible({ timeout: 10000 })

    // Fill AE name only
    const aeInput = page.locator('input[placeholder="Jane Smith"]')
    await aeInput.fill('Test Engineer')

    // SF Report ID, territory, and customers are still empty
    await expect(btn).toBeDisabled()
  })

  test('submit button stays disabled when territory is selected but SF Report ID is empty', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    const btn = submitButton(page)
    await expect(btn).toBeVisible({ timeout: 10000 })

    // Select POD
    const podSelect = page.locator('select').filter({ hasText: 'Select POD' })
    await podSelect.selectOption('WEST_COMM_CORP_NORTHWEST')

    // Wait for territory options from mock, then select one
    await page.waitForTimeout(1000)
    const terrSelect = page.locator('select').filter({ hasText: 'Select' }).last()
    const options = terrSelect.locator('option')
    const count = await options.count()
    if (count > 1) {
      const value = await options.nth(1).getAttribute('value')
      if (value) await terrSelect.selectOption(value)
    }

    // Territory lookup auto-fills AE name + customers, but SF Report ID is empty
    await page.waitForTimeout(1500)
    await expect(btn).toBeDisabled()
  })

  test('submit button stays disabled when customers textarea is cleared', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    const btn = submitButton(page)
    await expect(btn).toBeVisible({ timeout: 10000 })

    // Fill AE name
    await page.locator('input[placeholder="Jane Smith"]').fill('Test Engineer')
    // Fill SF Report ID
    await page.locator('input[placeholder="00OPe000001abcDEF"]').fill('00OPe00000isU2zMAE')
    // Select POD + territory
    await page.locator('select').filter({ hasText: 'Select POD' }).selectOption('WEST_COMM_CORP_NORTHWEST')
    await page.waitForTimeout(1000)
    const terrSelect = page.locator('select').filter({ hasText: 'Select' }).last()
    const options = terrSelect.locator('option')
    const count = await options.count()
    if (count > 1) {
      const value = await options.nth(1).getAttribute('value')
      if (value) await terrSelect.selectOption(value)
    }
    await page.waitForTimeout(1500)

    // Clear the customer textarea that was auto-filled by territory lookup
    await page.locator('textarea').fill('')

    // canStart requires customerNames.length > 0
    await expect(btn).toBeDisabled()
  })
})

// ── 2. SF Report ID format validation on blur ──────────────────────────────

test.describe('Wizard validation: SF Report ID format check', () => {
  test('shows error for invalid SF Report ID on blur', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    const sfInput = page.locator('input[placeholder="00OPe000001abcDEF"]')
    const isSfInput = await sfInput.isVisible().catch(() => false)
    if (!isSfInput) {
      // SF field rendered as <select> (Salesforce reports loaded) — skip
      test.skip()
      return
    }

    await sfInput.fill('not-a-report-id')
    await sfInput.blur()

    // onBlur validates: /^00O[a-zA-Z0-9]{12,15}$/
    // Shows: "Must start with 00O and be 15–18 characters"
    const errorMsg = page.locator('p.text-critical', { hasText: /Must start with 00O/ })
    await expect(errorMsg).toBeVisible({ timeout: 3000 })

    // Input should have critical border class
    await expect(sfInput).toHaveClass(/border-critical/)
  })

  test('shows error for SF Report ID with special characters', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    const sfInput = page.locator('input[placeholder="00OPe000001abcDEF"]')
    const isSfInput = await sfInput.isVisible().catch(() => false)
    if (!isSfInput) {
      test.skip()
      return
    }

    // Has 00O prefix but contains non-alphanumeric chars
    await sfInput.fill('00O!@#$%^&*()_+')
    await sfInput.blur()

    const errorMsg = page.locator('p.text-critical', { hasText: /Must start with 00O/ })
    await expect(errorMsg).toBeVisible({ timeout: 3000 })
  })

  test('shows error for too-short SF Report ID', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    const sfInput = page.locator('input[placeholder="00OPe000001abcDEF"]')
    const isSfInput = await sfInput.isVisible().catch(() => false)
    if (!isSfInput) {
      test.skip()
      return
    }

    await sfInput.fill('00O123')
    await sfInput.blur()

    const errorMsg = page.locator('p.text-critical', { hasText: /Must start with 00O/ })
    await expect(errorMsg).toBeVisible({ timeout: 3000 })
  })

  test('no error for valid SF Report ID format', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    const sfInput = page.locator('input[placeholder="00OPe000001abcDEF"]')
    const isSfInput = await sfInput.isVisible().catch(() => false)
    if (!isSfInput) {
      test.skip()
      return
    }

    // 00OPe00000isU2zMAE matches /^00O[a-zA-Z0-9]{12,15}$/
    await sfInput.fill('00OPe00000isU2zMAE')
    await sfInput.blur()

    const errorMsg = page.locator('p.text-critical', { hasText: /Must start with 00O/ })
    await expect(errorMsg).not.toBeVisible({ timeout: 2000 })
    await expect(sfInput).not.toHaveClass(/border-critical/)
  })

  test('SF Report ID error clears when user edits the field', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    const sfInput = page.locator('input[placeholder="00OPe000001abcDEF"]')
    const isSfInput = await sfInput.isVisible().catch(() => false)
    if (!isSfInput) {
      test.skip()
      return
    }

    // Trigger the error
    await sfInput.fill('bad')
    await sfInput.blur()
    await expect(page.locator('p.text-critical', { hasText: /Must start with 00O/ })).toBeVisible({ timeout: 3000 })

    // Edit the field — onChange calls setSfReportIdError(null)
    await sfInput.fill('00OPe00000isU2zMAE')

    // Error should clear immediately on change
    await expect(page.locator('p.text-critical', { hasText: /Must start with 00O/ })).not.toBeVisible({ timeout: 2000 })
  })
})

// ── 3. Parent Drive Folder URL validation ──────────────────────────────────

test.describe('Wizard validation: Parent Drive Folder URL', () => {
  test('shows error when folder validation API rejects the URL', async ({ page }) => {
    await mockFormAPIs(page)
    // Mock the folder validation endpoint to return an error
    await page.route('**/api/aes/validate-folder', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Folder not found' }),
      })
    )
    await openAEsSection(page)

    const folderInput = page.locator('input[placeholder*="Google Drive folder URL"]')
    await expect(folderInput).toBeVisible({ timeout: 10000 })

    await folderInput.fill('not-a-real-url')
    await folderInput.blur()

    // onBlur calls /api/aes/validate-folder; error response shows critical text
    const errorMsg = page.locator('p.text-critical', { hasText: /Folder not found|Drive API/i })
    await expect(errorMsg).toBeVisible({ timeout: 5000 })
    await expect(folderInput).toHaveClass(/border-critical/)
  })

  test('shows success when folder validation API accepts the URL', async ({ page }) => {
    await mockFormAPIs(page)
    await page.route('**/api/aes/validate-folder', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ folderName: 'My AE Folder' }),
      })
    )
    await openAEsSection(page)

    const folderInput = page.locator('input[placeholder*="Google Drive folder URL"]')
    await expect(folderInput).toBeVisible({ timeout: 10000 })

    await folderInput.fill('https://drive.google.com/drive/folders/1BV0uRHei3oRvGYVEXBX_qBB')
    await folderInput.blur()

    // Should show folder name confirmation in success color
    await expect(page.locator('p.text-success', { hasText: 'My AE Folder' })).toBeVisible({ timeout: 5000 })
    await expect(folderInput).toHaveClass(/border-success/)
    await expect(folderInput).not.toHaveClass(/border-critical/)
  })

  test('clears folder validation state when input is emptied', async ({ page }) => {
    await mockFormAPIs(page)
    await page.route('**/api/aes/validate-folder', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Folder not found' }),
      })
    )
    await openAEsSection(page)

    const folderInput = page.locator('input[placeholder*="Google Drive folder URL"]')
    await expect(folderInput).toBeVisible({ timeout: 10000 })

    // Trigger error state
    await folderInput.fill('garbage-url')
    await folderInput.blur()
    await expect(page.locator('p.text-critical', { hasText: /Folder not found/i })).toBeVisible({ timeout: 5000 })

    // Clear the input and blur — onBlur returns early for empty val
    await folderInput.fill('')
    await folderInput.blur()

    // Error should disappear, border should revert to default
    await expect(page.locator('p.text-critical', { hasText: /Folder not found/i })).not.toBeVisible({ timeout: 3000 })
    await expect(folderInput).not.toHaveClass(/border-critical/)
    await expect(folderInput).not.toHaveClass(/border-success/)
  })

  test('rejects URL with folder ID shorter than 10 characters', async ({ page }) => {
    await mockFormAPIs(page)
    // The server rejects short folder IDs via /^[a-zA-Z0-9_-]{10,}$/
    await page.route('**/api/aes/validate-folder', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid folder ID format' }),
      })
    )
    await openAEsSection(page)

    const folderInput = page.locator('input[placeholder*="Google Drive folder URL"]')
    await expect(folderInput).toBeVisible({ timeout: 10000 })

    await folderInput.fill('https://drive.google.com/drive/folders/abc')
    await folderInput.blur()

    const errorMsg = page.locator('p.text-critical', { hasText: /folder|Drive/i })
    await expect(errorMsg).toBeVisible({ timeout: 5000 })

    // Green confirmation should not appear
    await expect(page.locator('p.text-success')).not.toBeVisible()
  })
})

// ── 4. Territory lookup failure handling ────────────────────────────────────

test.describe('Wizard validation: territory lookup failure', () => {
  test('shows error message when territory-lookup API fails', async ({ page }) => {
    await mockFormAPIs(page)
    // Override territory-lookup to return a 500 error
    await page.route('**/api/territory-lookup**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Internal server error' }),
      })
    )
    await openAEsSection(page)

    // Select POD
    await page.locator('select').filter({ hasText: 'Select POD' }).selectOption('WEST_COMM_CORP_NORTHWEST')
    await page.waitForTimeout(1000)

    // Select territory
    const terrSelect = page.locator('select').filter({ hasText: 'Select' }).last()
    const options = terrSelect.locator('option')
    const count = await options.count()
    if (count <= 1) {
      test.skip()
      return
    }
    const value = await options.nth(1).getAttribute('value')
    if (value) await terrSelect.selectOption(value)

    await page.waitForTimeout(2000)

    // The form should show an error message and not crash
    const btn = submitButton(page)
    await expect(btn).toBeVisible()

    // Territory lookup error uses text-critical class; error text is either
    // the server's message or the fallback "Could not load territory data"
    const errorMsg = page.locator('p.text-critical', { hasText: /Internal server error|Could not load territory|territory|connection/i })
    await expect(errorMsg).toBeVisible({ timeout: 5000 })
  })
})

// ── 5. Parent folder is optional — form can submit without it ──────────────

test.describe('Wizard validation: parent folder is optional', () => {
  test('submit button can be enabled without parent folder URL', async ({ page }) => {
    await mockFormAPIs(page)
    await openAEsSection(page)

    const btn = submitButton(page)
    await expect(btn).toBeVisible({ timeout: 10000 })

    // Fill all required fields: AE name, SF Report ID, territory, customers
    await page.locator('input[placeholder="Jane Smith"]').fill('Test Engineer')
    await page.locator('input[placeholder="00OPe000001abcDEF"]').fill('00OPe00000isU2zMAE')

    // Select POD + territory
    await page.locator('select').filter({ hasText: 'Select POD' }).selectOption('WEST_COMM_CORP_NORTHWEST')
    await page.waitForTimeout(1000)
    const terrSelect = page.locator('select').filter({ hasText: 'Select' }).last()
    const options = terrSelect.locator('option')
    const count = await options.count()
    if (count > 1) {
      const value = await options.nth(1).getAttribute('value')
      if (value) await terrSelect.selectOption(value)
    }
    await page.waitForTimeout(1500)

    // Ensure customer textarea has content (auto-filled by territory lookup mock)
    const textarea = page.locator('textarea')
    const customerValue = await textarea.inputValue()
    if (!customerValue.trim()) {
      await textarea.fill('Acme Corp\nGlobex Industries')
    }

    // Parent folder is left blank — the button should be enabled
    // (canStart does not require parentFolderId)
    await expect(btn).toBeEnabled()
  })
})
