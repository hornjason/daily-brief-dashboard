/**
 * BKL-HERO-01 Phase 3 — hero step 3 connections UI tests.
 *
 * Tests the HeroStep3Connections component on the setup page.
 * The test container has NODE_ROLE unset → isL3Only=true → component renders.
 *
 * Tagged @destructive — runs against the test container (7776).
 * Note: The "bad token shows error" test makes a real SSO call (via the API),
 * so it needs network access and may take up to 15s.
 */
import { test, expect } from '@playwright/test'

/** Wait for the component to leave loading state, then return true if in summary mode. */
async function waitForComponent(page: any): Promise<boolean> {
  // Wait for either the form or the summary to appear (loading state has neither)
  await expect(
    page.locator('[data-testid="hero-step3-connections"], [data-testid="hero-step3-summary"]'),
  ).toBeVisible({ timeout: 10000 })
  return page.locator('[data-testid="hero-step3-summary"]').isVisible()
}

/** Navigate to setup and ensure component is in form mode (click Edit if needed). */
async function goToFormMode(page: any): Promise<void> {
  await page.goto('/dashboard/setup')
  const inSummary = await waitForComponent(page)
  if (inSummary) {
    await page.locator('[data-testid="rh-token-edit"]').click()
    // Wait for form to appear after clicking Edit
    await expect(page.locator('[data-testid="rh-token-input"]')).toBeVisible({ timeout: 5000 })
  }
}

test.describe('@destructive hero step 3 connections', () => {
  test.describe.configure({ mode: 'serial' })

  test('renders token form or summary on setup page when isL3Only', async ({ page }) => {
    await page.goto('/dashboard/setup')
    // Either summary (token already configured) or the form section should be visible
    await expect(
      page.locator('[data-testid="hero-step3-connections"], [data-testid="hero-step3-summary"]'),
    ).toBeVisible({ timeout: 10000 })
  })

  test('textarea and save button present in form mode', async ({ page }) => {
    await goToFormMode(page)
    await expect(page.locator('[data-testid="rh-token-input"]')).toBeVisible()
    await expect(page.locator('[data-testid="rh-token-save"]')).toBeVisible()
  })

  test('save button disabled when input is empty', async ({ page }) => {
    await goToFormMode(page)
    // Clear the textarea — it starts empty
    const input = page.locator('[data-testid="rh-token-input"]')
    await input.fill('')
    await expect(page.locator('[data-testid="rh-token-save"]')).toBeDisabled()
  })

  test('bad token shows error message', async ({ page }) => {
    await goToFormMode(page)
    await page.locator('[data-testid="rh-token-input"]').fill('bad-token-for-test')
    await page.locator('[data-testid="rh-token-save"]').click()
    await expect(page.locator('[data-testid="rh-token-error"]')).toBeVisible({ timeout: 15000 })
  })

  test('help link present in form mode', async ({ page }) => {
    await goToFormMode(page)
    await expect(page.locator('[data-testid="rh-token-help"]')).toBeVisible()
  })
})
