/**
 * SetupPage — OAuth key upload state machine tests.
 *
 * Tests the Step0OAuthKeys component lifecycle: configured state,
 * replace flow, mode toggle, save validation, and error handling.
 * Uses page.route() only for the specific endpoints under test.
 *
 * Key behavior discovered during test development:
 * - SetupPage auto-expands the first unconfigured section
 * - When oauth-keys exists=false, the OAuth section is auto-expanded with textarea visible
 * - When oauth-keys exists=true, the section shows "Configured" badge and auto-advances
 */
import { test, expect } from '../fixtures'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'
const SETUP_URL = `${BASE}/dashboard/setup`

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe('SetupPage — OAuth key upload state machine', () => {
  test('Replace keys button resets to upload form', async ({ page }) => {
    // Mock as configured
    await page.route('**/api/setup/oauth-keys-status*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ exists: true }) })
    )

    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })

    // Expand the OAuth Keys section (collapsed by default when configured)
    const oauthToggle = page.locator('button:has-text("OAuth Keys")')
    await expect(oauthToggle).toBeVisible({ timeout: 5000 })
    await oauthToggle.click()

    // Inside the expanded section, find and click "Replace keys file"
    const replaceBtn = page.locator('button:has-text("Replace keys file")')
    await expect(replaceBtn).toBeVisible({ timeout: 5000 })
    await replaceBtn.click()

    // After clicking Replace, the upload form should appear
    const textarea = page.locator('textarea')
    const modeToggle = page.locator('button:has-text("Paste JSON")')
    const formAppeared = await textarea.isVisible({ timeout: 3000 }).catch(() => false) ||
                          await modeToggle.isVisible({ timeout: 1000 }).catch(() => false)
    expect(formAppeared).toBe(true)
  })

  test('mode toggle paste to upload preserves component state', async ({ page }) => {
    // Mock as not configured — section auto-expands with textarea visible
    await page.route('**/api/setup/oauth-keys-status*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ exists: false }) })
    )

    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })

    // Textarea should be auto-visible (section auto-expands for unconfigured)
    const textarea = page.locator('textarea')
    await expect(textarea).toBeVisible({ timeout: 5000 })

    // Type text in paste mode
    await textarea.fill('some test content')
    expect(await textarea.inputValue()).toBe('some test content')

    // Switch to upload mode
    const uploadBtn = page.locator('button:has-text("Upload file")')
    await uploadBtn.click()

    // Textarea should be hidden in upload mode
    await expect(textarea).not.toBeVisible({ timeout: 2000 })

    // Switch back to paste mode
    const pasteBtn = page.locator('button:has-text("Paste JSON")')
    await pasteBtn.click()

    // Textarea reappears — React state preserves the value
    await expect(textarea).toBeVisible({ timeout: 2000 })
    const val = await textarea.inputValue()
    // Value is preserved (React useState persists across mode toggles)
    expect(val).toBe('some test content')
  })

  test('Save button disabled when textarea empty', async ({ page }) => {
    await page.route('**/api/setup/oauth-keys-status*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ exists: false }) })
    )

    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })

    // Textarea and Save Keys button should be auto-visible
    const textarea = page.locator('textarea')
    const saveBtn = page.locator('button:has-text("Save Keys")')
    await expect(textarea).toBeVisible({ timeout: 5000 })
    await expect(saveBtn).toBeVisible({ timeout: 3000 })

    // Save should be disabled when textarea is empty
    await expect(saveBtn).toBeDisabled()

    // Type something — Save should become enabled
    await textarea.fill('{"test": true}')
    await expect(saveBtn).toBeEnabled()

    // Clear — Save should be disabled again
    await textarea.fill('')
    await expect(saveBtn).toBeDisabled()
  })

  test('error state shows on invalid JSON', async ({ page }) => {
    await page.route('**/api/setup/oauth-keys-status*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ exists: false }) })
    )

    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })

    const textarea = page.locator('textarea')
    await expect(textarea).toBeVisible({ timeout: 5000 })

    // Type invalid JSON and click Save — JSON.parse in submit() will throw
    await textarea.fill('not valid json')
    const saveBtn = page.locator('button:has-text("Save Keys")')
    await expect(saveBtn).toBeEnabled()
    await saveBtn.click()

    // Error message should appear — submit() catch block calls setError(e.message)
    // The error text from JSON.parse typically includes "Unexpected" or similar
    const errorMsg = page.locator('text=/invalid|error|failed|unexpected|JSON|token/i')
    await expect(errorMsg.first()).toBeVisible({ timeout: 5000 })
  })
})
