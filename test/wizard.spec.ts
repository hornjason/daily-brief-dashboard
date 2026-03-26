/**
 * Setup Wizard E2E Tests
 *
 * Requires the server to be running:
 *   bun run server.ts &
 * Or against the container:
 *   podman run --rm -p 7777:7777 localhost/daily-brief-dashboard
 *
 * Run:
 *   bun run test:e2e
 */
import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'

test.describe('Setup Wizard step order', () => {
  test('wizard loads and shows 6 steps', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    // 6 step indicator circles
    const stepCircles = page.locator('.rounded-full').filter({ hasText: /^[1-6]$/ })
    await expect(stepCircles).toHaveCount(6)
  })

  test('step 1 (index 0) is OAuth Keys', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    const labels = await page.locator('.rounded-full').evaluateAll((els) =>
      els.map((el) => el.closest('[class]')?.parentElement?.querySelector('span')?.textContent?.trim())
    )
    // Step indicator labels — find the text below each circle
    const stepLabels = await page.getByText(/OAuth Keys|Google Auth|Accounts|Domains|AI Provider|Launch/).allTextContents()
    expect(stepLabels[0]).toContain('OAuth Keys')
  })

  test('step 2 (index 1) is Google Auth — not Accounts', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    const stepLabels = await page.getByText(/OAuth Keys|Google Auth|Accounts|Domains|AI Provider|Launch/).allTextContents()
    // The critical ordering check — this would have caught the step-swap bug
    expect(stepLabels[1]).toContain('Google Auth')
    expect(stepLabels[1]).not.toContain('Accounts')
  })

  test('step 3 (index 2) is Accounts', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    const stepLabels = await page.getByText(/OAuth Keys|Google Auth|Accounts|Domains|AI Provider|Launch/).allTextContents()
    expect(stepLabels[2]).toContain('Accounts')
  })

  test('step 0 is gated — Save Keys button disabled without credentials', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    // The "Save Keys" button should be disabled when textarea is empty
    const saveBtn = page.getByRole('button', { name: /Save Keys/i })
    await expect(saveBtn).toBeDisabled()
  })

  test('step 0 shows OAuth keys input mechanism', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    // Should show the paste textarea or upload tab
    const hasInput = await page.locator('textarea, input[type="file"]').count()
    expect(hasInput).toBeGreaterThan(0)
  })
})
