/**
 * Bootstrap recovery UI tests.
 *
 * Tests bootstrap state machine edge cases using page.route() to mock
 * API responses. Covers in-progress, error, completed, reload persistence,
 * and reset button flows.
 */
import { test, expect } from '../fixtures'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'
const SETUP_URL = `${BASE}/dashboard/setup`

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockBootstrapStatus(page: import('@playwright/test').Page, payload: Record<string, unknown>) {
  return page.route('**/api/bootstrap/auto/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    })
  )
}

// ── Bootstrap in-progress state ─────────────────────────────────────────────

test.describe('Bootstrap in-progress state', () => {
  test('shows progress UI when bootstrap is running', async ({ page }) => {
    await mockBootstrapStatus(page, {
      running: true,
      aeName: 'Test AE',
      steps: [
        { name: 'Create Drive Folder', status: 'done' },
        { name: 'Create Customer Folders', status: 'running' },
        { name: 'Discover Account Numbers', status: 'pending' },
        { name: 'Create Supportable Sheet', status: 'pending' },
        { name: 'Create CCSP Sheet', status: 'pending' },
        { name: 'Sync Pipeline Sheet', status: 'pending' },
      ],
      completedAt: null,
      error: null,
      resources: {},
    })

    await page.goto(SETUP_URL)
    await expect(page).toHaveURL(/setup/)

    // The progress container should be visible (aria-live="polite" region)
    const progressRegion = page.locator('[aria-live="polite"]')
    await expect(progressRegion).toBeVisible()

    // Header should show "Setting up Test AE..." (not "complete")
    await expect(progressRegion.locator('text=Setting up Test AE')).toBeVisible()

    // All 6 step names should be rendered in the step list
    await expect(page.locator('text=Create Drive Folder')).toBeVisible()
    await expect(page.locator('text=Create Customer Folders')).toBeVisible()
    await expect(page.locator('text=Discover Account Numbers')).toBeVisible()
    await expect(page.locator('text=Create Supportable Sheet')).toBeVisible()
    await expect(page.locator('text=Create CCSP Sheet')).toBeVisible()
    await expect(page.locator('text=Sync Pipeline Sheet')).toBeVisible()

    // The running step should have a spinner icon (Loader2 with animate-spin)
    const spinnerIcon = page.locator('.animate-spin')
    await expect(spinnerIcon).toBeVisible()

    // The running step text should have white font-medium styling
    const runningStepText = page.locator('span.text-white.font-medium', { hasText: 'Create Customer Folders' })
    await expect(runningStepText).toBeVisible()

    // The running step row should have a highlighted background
    const runningRow = page.locator('div.bg-slate-800\\/60')
    await expect(runningRow).toBeVisible()

    // Done step should have emerald text
    const doneStepText = page.locator('span.text-emerald-300', { hasText: 'Create Drive Folder' })
    await expect(doneStepText).toBeVisible()

    // Pending steps should have muted slate text
    const pendingStepText = page.locator('span.text-slate-500', { hasText: 'Discover Account Numbers' })
    await expect(pendingStepText).toBeVisible()

    // No completion text should appear while running
    await expect(page.locator('text=All done')).not.toBeVisible()
    await expect(page.locator('text=Setup complete')).not.toBeVisible()
    await expect(page.locator('text=Completed with errors')).not.toBeVisible()
  })
})

// ── Bootstrap error state ───────────────────────────────────────────────────

test.describe('Bootstrap error state', () => {
  test('shows error UI when a step has failed', async ({ page }) => {
    await mockBootstrapStatus(page, {
      running: false,
      aeName: 'Test AE',
      steps: [
        { name: 'Create Drive Folder', status: 'done' },
        { name: 'Create Customer Folders', status: 'error', error: 'Drive API quota exceeded' },
        { name: 'Discover Account Numbers', status: 'pending' },
      ],
      completedAt: new Date().toISOString(),
      error: 'Drive API quota exceeded',
      resources: {},
    })

    await page.goto(SETUP_URL)
    await expect(page).toHaveURL(/setup/)

    // The progress container should render
    const progressRegion = page.locator('[aria-live="polite"]')
    await expect(progressRegion).toBeVisible()

    // Header should indicate errors, not clean completion
    await expect(page.locator('text=finished with errors')).toBeVisible()

    // The failed step name should be rendered in red
    const errorStepText = page.locator('span.text-red-400', { hasText: 'Create Customer Folders' })
    await expect(errorStepText).toBeVisible()

    // The error icon should have a red border (border-red-500 on the icon wrapper)
    const errorIcon = page.locator('span.border-red-500')
    await expect(errorIcon).toBeVisible()

    // Completion card should show the error-state variant (amber border)
    const errorCard = page.locator('div.border-amber-700')
    await expect(errorCard).toBeVisible()

    // Error completion message should be visible
    await expect(page.locator('text=Completed with errors')).toBeVisible()

    // "All done! Resources are ready." should NOT appear in error state
    await expect(page.locator('text=All done! Resources are ready.')).not.toBeVisible()

    // "Clear stuck state" button should be visible when hasError is true
    const clearButton = page.locator('button', { hasText: 'Clear stuck state' })
    await expect(clearButton).toBeVisible()
  })
})

// ── Bootstrap completed with resources ──────────────────────────────────────

test.describe('Bootstrap completed state', () => {
  test('shows completion UI with step details when all steps done', async ({ page }) => {
    await mockBootstrapStatus(page, {
      running: false,
      aeName: 'Test AE',
      steps: [
        { name: 'Create Drive Folder', status: 'done', detail: 'Folder abc123' },
        { name: 'Create Customer Folders', status: 'done', detail: '5 folders created' },
        { name: 'Discover Account Numbers', status: 'done', detail: '5/5 matched' },
        { name: 'Create Supportable Sheet', status: 'done', detail: 'Sheet abc123' },
        { name: 'Create CCSP Sheet', status: 'done', detail: 'Sheet def456' },
        { name: 'Sync Pipeline Sheet', status: 'done', detail: 'Sheet ghi789' },
      ],
      completedAt: new Date().toISOString(),
      error: null,
      resources: {
        driveFolderUrl: 'https://drive.google.com/drive/folders/abc123',
        supportableSheetUrl: 'https://docs.google.com/spreadsheets/d/abc123',
        ccspSheetUrl: 'https://docs.google.com/spreadsheets/d/def456',
      },
    })

    await page.goto(SETUP_URL)
    await expect(page).toHaveURL(/setup/)

    // Header should show clean completion
    await expect(page.locator('text=Setup complete')).toBeVisible()

    // All 6 steps should show emerald (done) text
    const doneSteps = page.locator('span.text-emerald-300')
    await expect(doneSteps).toHaveCount(6)

    // All 6 done icons should have emerald borders
    const doneIcons = page.locator('span.border-emerald-500')
    await expect(doneIcons).toHaveCount(6)

    // Completion card should show success variant (emerald border)
    const successCard = page.locator('div.border-emerald-700')
    await expect(successCard).toBeVisible()

    // Success message
    await expect(page.locator('text=All done! Resources are ready.')).toBeVisible()

    // Step details should be rendered in the completion card
    // The UI renders done steps with details as: "StepName: detail"
    await expect(page.locator('text=Create Drive Folder')).toBeVisible()
    await expect(page.locator('text=Folder abc123')).toBeVisible()
    await expect(page.locator('text=5 folders created')).toBeVisible()
    await expect(page.locator('text=Sheet abc123')).toBeVisible()

    // No error text should appear
    await expect(page.locator('text=Completed with errors')).not.toBeVisible()
    await expect(page.locator('text=finished with errors')).not.toBeVisible()

    // "Add another AE" button should be visible (onReset is passed when completedAt && !running)
    const addAnotherButton = page.locator('button', { hasText: 'Add another AE' })
    await expect(addAnotherButton).toBeVisible()

    // "Edit AE / customers" link should be visible
    const editLink = page.locator('a[href="#aes"]', { hasText: 'Edit AE' })
    await expect(editLink).toBeVisible()
  })

  // Resource links are rendered as plain text spans, not as <a> tags with href.
  // When the UI is updated to render clickable resource links, enable this test.
  test.skip('resource URLs are rendered as clickable links', async ({ page }) => {
    // TODO: Enable when SetupPage renders resource URLs as <a href="..."> tags
    // instead of plain text spans. Currently step.detail is rendered inside a
    // <span className="text-slate-300"> with no anchor wrapping.
    //
    // Expected assertions when implemented:
    // await expect(page.locator('a[href*="drive.google.com"]')).toBeVisible()
    // await expect(page.locator('a[href*="docs.google.com"]')).toHaveCount(2)
  })
})

// ── Page reload during bootstrap ────────────────────────────────────────────

test.describe('Bootstrap persistence across reload', () => {
  test('progress state survives page reload (fetched from API)', async ({ page }) => {
    const runningState = {
      running: true,
      aeName: 'Test AE',
      steps: [
        { name: 'Create Drive Folder', status: 'done' },
        { name: 'Create Customer Folders', status: 'running' },
        { name: 'Discover Account Numbers', status: 'pending' },
      ],
      completedAt: null,
      error: null,
      resources: {},
    }

    await mockBootstrapStatus(page, runningState)
    await page.goto(SETUP_URL)
    await expect(page).toHaveURL(/setup/)

    // Verify running state is displayed before reload
    await expect(page.locator('text=Setting up Test AE')).toBeVisible()
    const spinnerBeforeReload = page.locator('.animate-spin')
    await expect(spinnerBeforeReload).toBeVisible()

    // Reload — the mock route persists across navigation within the same page context
    await page.reload()
    await expect(page).toHaveURL(/setup/)

    // After reload, running state should still be displayed (fetched from mocked API)
    await expect(page.locator('text=Setting up Test AE')).toBeVisible()

    // The running step should still show as running with a spinner
    const spinnerAfterReload = page.locator('.animate-spin')
    await expect(spinnerAfterReload).toBeVisible()

    // The running step text should still have active styling
    const runningStepAfterReload = page.locator('span.text-white.font-medium', { hasText: 'Create Customer Folders' })
    await expect(runningStepAfterReload).toBeVisible()

    // Pending step should still show as pending (not reset to some other state)
    const pendingStepAfterReload = page.locator('span.text-slate-500', { hasText: 'Discover Account Numbers' })
    await expect(pendingStepAfterReload).toBeVisible()

    // Verify the API was called again after a second reload
    const responsePromise = page.waitForResponse('**/api/bootstrap/auto/status', { timeout: 5000 }).catch(() => null)
    await page.reload()
    const response = await responsePromise
    if (response) {
      const data = await response.json()
      expect(data.running).toBe(true)
      expect(data.steps).toHaveLength(3)
    }
  })
})

// ── Reset button ────────────────────────────────────────────────────────────

test.describe('Bootstrap reset', () => {
  test('clear-stuck-state button is visible and calls reset endpoint in error state', async ({ page }) => {
    await mockBootstrapStatus(page, {
      running: false,
      aeName: 'Test AE',
      steps: [
        { name: 'Create Drive Folder', status: 'done' },
        { name: 'Create Customer Folders', status: 'error', error: 'Failed' },
        { name: 'Discover Account Numbers', status: 'pending' },
      ],
      completedAt: new Date().toISOString(),
      error: 'Failed',
      resources: {},
    })

    // Mock the reset endpoint
    let resetCalled = false
    await page.route('**/api/bootstrap/auto/reset', (route) => {
      resetCalled = true
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      })
    })

    await page.goto(SETUP_URL)
    await expect(page).toHaveURL(/setup/)

    // The "Clear stuck state" button should be visible (rendered when hasError is true)
    const clearButton = page.locator('button', { hasText: 'Clear stuck state' })
    await expect(clearButton).toBeVisible()
    await expect(clearButton).toBeEnabled()

    // Click the button and verify it calls the reset endpoint
    const responsePromise = page.waitForResponse(
      (resp) => resp.url().includes('/api/bootstrap/auto/reset'),
      { timeout: 5000 }
    )

    await clearButton.click()
    const response = await responsePromise

    expect(resetCalled).toBe(true)
    expect(response.status()).toBe(200)
  })

  test('add-another-AE button is visible in completed-no-error state but not clear-stuck', async ({ page }) => {
    await mockBootstrapStatus(page, {
      running: false,
      aeName: 'Test AE',
      steps: [
        { name: 'Create Drive Folder', status: 'done', detail: 'OK' },
        { name: 'Create Customer Folders', status: 'done', detail: 'OK' },
        { name: 'Discover Account Numbers', status: 'done', detail: '3/3 matched' },
      ],
      completedAt: new Date().toISOString(),
      error: null,
      resources: {},
    })

    await page.goto(SETUP_URL)
    await expect(page).toHaveURL(/setup/)

    // "Add another AE" should be visible (onReset is passed)
    const addAnotherButton = page.locator('button', { hasText: 'Add another AE' })
    await expect(addAnotherButton).toBeVisible()

    // "Clear stuck state" should NOT be visible (no errors)
    const clearButton = page.locator('button', { hasText: 'Clear stuck state' })
    await expect(clearButton).not.toBeVisible()
  })
})
