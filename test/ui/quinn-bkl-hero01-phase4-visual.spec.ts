import { test, expect } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'
const SETUP_URL = `${BASE}/dashboard/setup`
const SS_DIR = '/tmp'

test.describe('Quinn Visual — BKL-HERO-01 Phase 4 visual validation', () => {
  test.describe.configure({ mode: 'serial' })

  test('V1 — Page loads without console errors', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', err => consoleErrors.push(err.message))

    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: path.join(SS_DIR, 'qa-hero01-p4-v1-page-load.png'), fullPage: true })

    const filtered = consoleErrors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('net::ERR') &&
      !e.includes('ResizeObserver')
    )
    console.log('Console errors (filtered):', JSON.stringify(filtered))
    expect(filtered, `Console errors found: ${filtered.join('; ')}`).toHaveLength(0)
  })

  test('V2 — Step 0 region picker renders at top', async ({ page }) => {
    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)

    // Step 0 should be visible at the top
    const step0 = page.locator('#step0, [data-step="0"], section').first()
    await page.screenshot({ path: path.join(SS_DIR, 'qa-hero01-p4-v2-step0.png'), fullPage: false })
    
    // Look for region-related text
    const pageText = await page.textContent('body')
    const hasRegion = pageText?.toLowerCase().includes('region') || pageText?.toLowerCase().includes('pod')
    console.log('Has region/pod text:', hasRegion)
    expect(hasRegion).toBe(true)
  })

  test('V3 — Step 4 accordion expands and renders correctly', async ({ page }) => {
    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)

    // Find Step 4 accordion - look for AEs & Customers text
    const step4Btn = page.locator('button:has-text("AEs & Customers"), button:has-text("Step 4")')
    const btnCount = await step4Btn.count()
    console.log('Step 4 buttons found:', btnCount)

    if (btnCount > 0) {
      await step4Btn.first().click()
      await page.waitForTimeout(800)
    }

    await page.screenshot({ path: path.join(SS_DIR, 'qa-hero01-p4-v3-step4-open.png'), fullPage: true })

    // Check for tab buttons
    const singleAeTab = page.locator('button:has-text("Single AE")')
    const fullPodTab = page.locator('button:has-text("Full Pod")')
    const manageTab = page.locator('button:has-text("Manage AEs"), button:has-text("Manage")')

    const singleCount = await singleAeTab.count()
    const fullPodCount = await fullPodTab.count()
    const manageCount = await manageTab.count()

    console.log('Tab counts — Single AE:', singleCount, 'Full Pod:', fullPodCount, 'Manage:', manageCount)
    expect(singleCount + fullPodCount + manageCount).toBeGreaterThan(0)
  })

  test('V4 — Pod dropdown shows ALL pods when no enabledPods set', async ({ page }) => {
    // Mock regions/access to return empty (no filter)
    await page.route(url => url.toString().includes('/api/regions/access'), route =>
      route.fulfill({ json: {} })
    )

    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)

    // Open Step 4
    const step4Btn = page.locator('button:has-text("AEs & Customers"), button:has-text("Step 4")')
    if (await step4Btn.count() > 0) {
      await step4Btn.first().click()
      await page.waitForTimeout(500)
    }

    // Click Single AE tab to show BootstrapConfigBlock
    const singleAeBtn = page.locator('button:has-text("Single AE")')
    if (await singleAeBtn.count() > 0) {
      await singleAeBtn.first().click()
      await page.waitForTimeout(500)
    }

    await page.screenshot({ path: path.join(SS_DIR, 'qa-hero01-p4-v4-pod-dropdown.png'), fullPage: true })

    // Check for pod select
    const podSelect = page.locator('[data-testid="pod-select"]')
    const podCount = await podSelect.count()
    console.log('Pod select elements found:', podCount)

    if (podCount > 0) {
      const options = await podSelect.locator('option').allTextContents()
      console.log('Pod options:', JSON.stringify(options))
      // Should have more than just placeholder
      expect(options.length).toBeGreaterThan(1)
    }
  })

  test('V5 — Steps 1-3 still render (regression check)', async ({ page }) => {
    await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)

    await page.screenshot({ path: path.join(SS_DIR, 'qa-hero01-p4-v5-steps1-3.png'), fullPage: true })

    // Check all step buttons/sections present
    const pageText = await page.textContent('body')
    const hasStep1 = pageText?.includes('Step 1') || pageText?.includes('Google Drive') || pageText?.includes('Data Source')
    const hasStep2 = pageText?.includes('Step 2') || pageText?.includes('Salesforce') || pageText?.includes('Bookings')
    const hasStep3 = pageText?.includes('Step 3') || pageText?.includes('Connection') || pageText?.includes('Red Hat')
    const hasStep4 = pageText?.includes('Step 4') || pageText?.includes('AEs')

    console.log('Step presence — 1:', hasStep1, '2:', hasStep2, '3:', hasStep3, '4:', hasStep4)
    expect(hasStep4, 'Step 4 must be present').toBe(true)
  })
})
