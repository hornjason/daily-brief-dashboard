/**
 * BKL-HERO-18 — Customer detail page L3 hero-mode gating.
 *
 * Six L4-only UI elements must be absent when /api/node-role returns
 * { isL3Only: true }:
 *   1. Cases stat badge (header)
 *   2. Cloud$ stat badge (header)
 *   3. Pipeline stat badge (header)
 *   4. CloudSpendCard (left column)
 *   5. PipelineCard (left column)
 *   6. CasesSection (right sidebar)
 *
 * Pattern matches test/ui/hero-l3-gating-dashboard.spec.ts (BKL-HERO-20).
 *
 * Tagged @destructive so it runs against the test container (port 7776)
 * via the `test` project grep. State is not mutated — only /api/node-role
 * is stubbed to control the gate.
 *
 * Project: --project=test (7776).
 */
import { test, expect, type Page } from '@playwright/test'

// "Acme Corp" is the canonical seed customer on 7776 (data/seed/customers.json).
const CUSTOMER_PATH = `/dashboard/customer/${encodeURIComponent('Acme Corp')}`

async function mockNodeRole(page: Page, isL3Only: boolean) {
  await page.route('**/api/node-role', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ isL3Only }),
    })
  )
}

async function waitForCustomerPageReady(page: Page) {
  await page.waitForSelector('main', { timeout: 10_000 }).catch(() => {})
  // Allow header stat badges + body cards to attempt mount
  await page.waitForTimeout(1_500)
}

test.describe('@destructive BKL-HERO-18: Customer detail L3 gating', () => {
  test.describe.configure({ mode: 'serial' })

  test('T1 — Cases stat badge absent on L3 hero install', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(CUSTOMER_PATH)
    await waitForCustomerPageReady(page)

    // StatBadge component renders the label as visible text
    await expect(page.locator('header').getByText('Cases', { exact: true })).toHaveCount(0)
  })

  test('T2 — Cloud$ stat badge absent on L3 hero install', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(CUSTOMER_PATH)
    await waitForCustomerPageReady(page)

    await expect(page.getByText('Cloud$', { exact: true })).toHaveCount(0)
  })

  test('T3 — Pipeline stat badge absent on L3 hero install', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(CUSTOMER_PATH)
    await waitForCustomerPageReady(page)

    // Header badge label is "Pipeline"; Open Pipeline section heading is in PipelineCard
    await expect(page.locator('header').getByText('Pipeline', { exact: true })).toHaveCount(0)
  })

  test('T4 — CloudSpendCard absent on L3 hero install', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(CUSTOMER_PATH)
    await waitForCustomerPageReady(page)

    // CloudSpendCard renders the section heading "Cloud Spend (CCSP)"
    await expect(page.locator('text=Cloud Spend (CCSP)')).toHaveCount(0)
  })

  test('T5 — PipelineCard absent on L3 hero install', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(CUSTOMER_PATH)
    await waitForCustomerPageReady(page)

    // PipelineCard renders an "Open Pipeline" heading
    await expect(page.locator('h2:has-text("Open Pipeline")')).toHaveCount(0)
  })

  test('T6 — CasesSection absent on L3 hero install', async ({ page }) => {
    await mockNodeRole(page, true)
    await page.goto(CUSTOMER_PATH)
    await waitForCustomerPageReady(page)

    // CasesSection renders a "Support Cases" or "Cases" heading in the aside
    await expect(page.locator('aside').getByRole('heading', { name: /support cases|^cases$/i })).toHaveCount(0)
  })

  test('T7 — L4 parity: header Pipeline badge present when isL3Only=false', async ({ page }) => {
    await mockNodeRole(page, false)
    await page.goto(CUSTOMER_PATH)
    await waitForCustomerPageReady(page)

    // Sanity: gate works in reverse — header Pipeline stat badge mounts on L4
    // regardless of whether seed CCSP data exists (badge renders with $0 fallback).
    await expect(page.locator('header').getByText('Pipeline', { exact: true })).toHaveCount(1)
  })
})
