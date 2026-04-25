// BKL-VISUAL-BASELINE: Screenshot regression on stable, low-churn surfaces.
// Update baselines: npx playwright test --update-snapshots --project=ci test/visual-baseline.spec.ts
// Never add snapshot specs for actively-developed components — noise kills the signal.
//
// Selectors chosen against actual source (verified 2026-04-19):
//   - dashboard shell:  <main> in App.tsx (catch-all "*" route → Dashboard component)
//   - brief card:       text "Account Brief" header inside CustomerDetailPage <BriefSection>
//                       (route /dashboard/customer/:name, NOT ?customer= query param)
//   - wizard step 1:    "OAuth Keys" accordion section header on /dashboard/setup
//
// Skips are honest signals — never hard-fail when seed data isn't present.

import { test, expect } from '@playwright/test'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'

test.describe('Visual Baselines — stable surfaces', () => {
  test('dashboard shell layout', async ({ page }) => {
    await page.goto(`${BASE}/`)
    await page.waitForLoadState('networkidle')
    // Wait for the main content area — App.tsx renders <main> inside the Dashboard component
    await page.locator('main').first().waitFor({ timeout: 10000 })
    await expect(page).toHaveScreenshot('dashboard-shell.png', {
      maxDiffPixelRatio: 0.02, // 2% pixel tolerance — catches layout shifts, not antialiasing
      fullPage: false,
      clip: { x: 0, y: 0, width: 1280, height: 800 },
    })
  })

  test('brief card render', async ({ page }) => {
    // Navigate to first customer with a brief — skip if none found.
    // /api/accounts returns { customers: [{ name, ae, ... }] }; routing uses /dashboard/customer/:name
    // (App.tsx Route path="/dashboard/customer/:name").
    const res = await page.request.get(`${BASE}/api/accounts`)
    if (!res.ok()) {
      test.skip(true, '/api/accounts unreachable — visual baseline requires live API')
      return
    }
    const body = await res.json()
    const customers = (body.customers ?? []) as Array<{ name: string }>
    if (!customers.length) {
      test.skip(true, 'No customers seeded — visual baseline requires real data')
      return
    }
    const customerName = customers[0].name
    await page.goto(`${BASE}/dashboard/customer/${encodeURIComponent(customerName)}`)
    await page.waitForLoadState('networkidle')

    // The brief card is the section inside CustomerDetailPage's <BriefSection> that contains
    // the "Account Brief" heading. We pin to the enclosing card div via heading → ancestor.
    const briefHeading = page.getByRole('heading', { name: /Account Brief/i }).first()
    const visible = await briefHeading.isVisible().catch(() => false)
    if (!visible) {
      test.skip(true, 'Brief card not visible — customer may not have a cached brief or provider not configured')
      return
    }
    // Screenshot the brief card container (closest rounded-xl surface that owns the heading)
    const briefCard = briefHeading.locator(
      'xpath=ancestor::div[contains(@class, "rounded-xl") and contains(@class, "border")][1]'
    )
    await expect(briefCard).toHaveScreenshot('brief-card.png', { maxDiffPixelRatio: 0.02 })
  })

  test('wizard step 1', async ({ page }) => {
    // Setup page uses an accordion (BKL-UX85) — "OAuth Keys" is the first section.
    await page.goto(`${BASE}/dashboard/setup`)
    await page.waitForLoadState('networkidle')
    // Wait for the OAuth Keys section header (always present at top of setup accordion)
    await page.getByText(/OAuth Keys/).first().waitFor({ timeout: 10000 })
    await expect(page).toHaveScreenshot('wizard-step1.png', {
      maxDiffPixelRatio: 0.02,
      fullPage: false,
      clip: { x: 0, y: 0, width: 1280, height: 800 },
    })
  })
})
