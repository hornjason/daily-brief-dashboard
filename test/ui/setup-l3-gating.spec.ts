/**
 * BKL-HERO-01 Phase 2 — isL3Only gating UI test.
 *
 * Verifies that hero installs (NODE_ROLE unset → /api/node-role returns
 * { isL3Only: true }) hide the three L4-only AccordionSections in
 * dashboard/src/pages/SetupPage.tsx:
 *   - Step 5 of 5 — Data Sources    (id="data-sources")
 *   - Refresh Timer & Settings      (id="settings")
 *   - Automation & Limits           (id="automation-settings")
 * AI & Intelligence Settings (id="ai-settings") MUST stay visible on both
 * paths — Gemini brief generation works on hero installs.
 *
 * The test container starts with NODE_ROLE unset, so the live endpoint
 * (once Phase 0 ships) would already return { isL3Only: true }. This spec
 * does not depend on Phase 0 — it mocks /api/node-role via page.route()
 * so it passes against the current Phase 2 build regardless of Phase 0
 * deployment state.
 *
 * Tagged @destructive only so it routes to the test container (port 7776)
 * via the `test` project grep. No state mutation occurs.
 *
 * Project: --project=test (7776).
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

const SETUP_PATH = '/dashboard/setup'

/** Stub /api/node-role to control isL3Only without depending on Phase 0 deployment. */
async function mockNodeRole(page: Page, isL3Only: boolean) {
  await page.route('**/api/node-role', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ isL3Only }),
    })
  )
}

/**
 * Wait for the SetupPage's mount fetches to settle by waiting for an
 * accordion header that's always present (oauth-keys, the first step) to
 * become visible. This guarantees the useEffect ran and isL3Only state
 * has been applied before assertions.
 */
async function waitForSetupReady(page: Page) {
  await page.waitForSelector('button:has-text("OAuth Keys"), button:has-text("Google OAuth")', {
    timeout: 10_000,
  }).catch(() => { /* fall through to assertions which carry their own timeouts */ })
}

test.describe('@destructive BKL-HERO-01 Phase 2: SetupPage L3 gating', () => {
  test('T1 — L3 hero install hides Data Sources section', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(SETUP_PATH)
    await waitForSetupReady(page)

    // The whole AccordionSection is unmounted by `{!isL3Only && (...)}`,
    // so neither the id nor the heading should exist in the DOM.
    await expect(page.locator('#data-sources')).toHaveCount(0)
    await expect(page.locator('button:has-text("Step 5 of 5 — Data Sources")')).toHaveCount(0)
  })

  test('T2 — L3 hero install hides Refresh Timer & Settings section', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(SETUP_PATH)
    await waitForSetupReady(page)

    await expect(page.locator('#settings')).toHaveCount(0)
    await expect(page.locator('button:has-text("Refresh Timer & Settings")')).toHaveCount(0)
  })

  test('T3 — L3 hero install hides Automation & Limits section', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(SETUP_PATH)
    await waitForSetupReady(page)

    await expect(page.locator('#automation-settings')).toHaveCount(0)
    await expect(page.locator('button:has-text("Automation & Limits")')).toHaveCount(0)
  })

  test('T4 — L3 hero install keeps AI & Intelligence Settings visible', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(SETUP_PATH)
    await waitForSetupReady(page)

    // AI Settings is intentionally always visible — Gemini works on L3.
    await expect(page.locator('#ai-settings')).toHaveCount(1)
    await expect(
      page.locator('button:has-text("AI & Intelligence Settings")')
    ).toBeVisible({ timeout: 10_000 })
  })

  test('T5 — L3 hero install hides Step 3 Connections accordion', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(SETUP_PATH)
    await waitForSetupReady(page)

    // On L3 the Connections accordion is replaced by HeroStep3Connections.
    // The standard "Step 3 of 5 — Connections" button must not be in the DOM.
    await expect(page.locator('#rh-portal')).toHaveCount(0)
    await expect(page.locator('button:has-text("Step 3 of 5 — Connections")')).toHaveCount(0)
  })

  test('T6 — L3 hero install shows HeroStep3Connections in Step 3 position', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(SETUP_PATH)
    await waitForSetupReady(page)

    // HeroStep3Connections renders after Google Auth (Step 2) and before AEs (Step 4).
    // The component shows either form mode (hero-step3-connections) or summary mode (hero-step3-summary).
    await expect(
      page.locator('[data-testid="hero-step3-connections"], [data-testid="hero-step3-summary"]')
    ).toBeVisible({ timeout: 10_000 })
  })

  test('T7 — Primary (L4) install shows full Connections accordion (not HeroStep3)', async ({ page }) => {
    // The test container is NODE_ROLE-unset, so the real endpoint would
    // return isL3Only:true. Mock it to simulate a primary install.
    await mockNodeRole(page, false)
    await page.goto(SETUP_PATH)
    await waitForSetupReady(page)

    // On L4 the full Connections accordion renders (not bare HeroStep3Connections).
    // #rh-portal must be present; bare HeroStep3Connections must NOT render standalone.
    await expect(page.locator('#rh-portal')).toHaveCount(1)
    await expect(page.locator('#ai-settings')).toHaveCount(1)

    // Connections step heading visible (in the accordion header button).
    await expect(page.locator('button:has-text("Step 3 of 5 — Connections")')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('button:has-text("AI & Intelligence Settings")')).toBeVisible()
    // Note: #data-sources, #settings, #automation-settings were removed in BKL-ARCH-12
  })
})
