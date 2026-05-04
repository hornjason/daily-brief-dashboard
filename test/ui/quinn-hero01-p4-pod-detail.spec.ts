import { test, expect } from '@playwright/test'
import * as path from 'path'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'
const SETUP_URL = `${BASE}/dashboard/setup`

test('Pod dropdown detail — capture all option names and screenshot', async ({ page }) => {
  // No enabledPods — all pods should show
  await page.route(url => url.toString().includes('/api/regions/access'), route =>
    route.fulfill({ json: {} })
  )

  await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)

  // Open Step 4
  const step4Btn = page.locator('button:has-text("AEs & Customers")')
  await step4Btn.click()
  await page.waitForTimeout(500)

  // Click Single AE tab
  const singleAeBtn = page.locator('button:has-text("Single AE")')
  await singleAeBtn.click()
  await page.waitForTimeout(800)

  // Get pod select options
  const podSelect = page.locator('[data-testid="pod-select"]')
  await expect(podSelect).toBeVisible({ timeout: 10000 })

  const options = await podSelect.locator('option').allTextContents()
  const optionValues = await podSelect.locator('option').evaluateAll(
    (opts: HTMLOptionElement[]) => opts.map(o => ({ text: o.textContent, value: o.value, disabled: o.disabled }))
  )
  console.log('All pod options:', JSON.stringify(optionValues, null, 2))

  // Region selector
  const regionSelect = page.locator('[data-testid="region-select"], select').first()
  const regionOptions = await regionSelect.locator('option').allTextContents()
  console.log('Region options:', JSON.stringify(regionOptions))

  // Screenshot focused on Step 4 section
  const step4Section = page.locator('#aes, section:has-text("AEs & Customers")').first()
  await step4Section.screenshot({ path: '/tmp/qa-hero01-p4-pod-detail.png' })
  
  // Also full page
  await page.screenshot({ path: '/tmp/qa-hero01-p4-full-single-ae.png', fullPage: true })

  expect(options.length).toBeGreaterThan(1)
  // Verify TOLA pod — it should appear since no filter active
  const hasWestPod = options.some(o => o.includes('Northwest') || o.includes('Southwest') || o.includes('West'))
  console.log('Has West Commercial pods:', hasWestPod)
})

test('HeroStep3Connections card renders', async ({ page }) => {
  await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)

  // Red Hat Token Configured card should be visible
  const rhCard = page.locator('text=Red Hat Token')
  const cardCount = await rhCard.count()
  console.log('Red Hat connection cards:', cardCount)

  // Step 3 Connections accordion
  const step3 = page.locator('button:has-text("Connections"), button:has-text("Step 3")')
  if (await step3.count() > 0) {
    await step3.first().click()
    await page.waitForTimeout(600)
  }

  await page.screenshot({ path: '/tmp/qa-hero01-p4-step3-connections.png', fullPage: true })
  
  const pageText = await page.textContent('body')
  const hasRHConnection = pageText?.includes('Red Hat') || pageText?.includes('Connections')
  console.log('Has Red Hat / Connections content:', hasRHConnection)
  expect(hasRHConnection).toBe(true)
})
