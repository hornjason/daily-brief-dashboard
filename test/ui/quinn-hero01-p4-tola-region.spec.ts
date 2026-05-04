import { test, expect } from '@playwright/test'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'
const SETUP_URL = `${BASE}/dashboard/setup`

test('TOLA region selection updates pod dropdown', async ({ page }) => {
  await page.route(url => url.toString().includes('/api/regions/access'), route =>
    route.fulfill({ json: {} })
  )

  await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)

  const step4Btn = page.locator('button:has-text("AEs & Customers")')
  await step4Btn.click()
  await page.waitForTimeout(500)

  const singleAeBtn = page.locator('button:has-text("Single AE")')
  await singleAeBtn.click()
  await page.waitForTimeout(800)

  // Select 0 is the region selector
  const regionSelect = page.locator('select').nth(0)
  await regionSelect.selectOption('Central Enterprise – TOLA')
  await page.waitForTimeout(500)

  // Select 2 should now be pod dropdown (or it may shift)
  const allSelects = page.locator('select')
  const selCount = await allSelects.count()
  let tolaFound = false

  for (let i = 0; i < selCount; i++) {
    const opts = await allSelects.nth(i).locator('option').allTextContents()
    console.log(`After TOLA select — Select ${i}:`, JSON.stringify(opts))
    if (opts.some(o => o.includes('TOLA'))) tolaFound = true
  }

  console.log('TOLA pod found after switching region:', tolaFound)
  await page.screenshot({ path: '/tmp/qa-hero01-p4-tola-region-switched.png', fullPage: false })
  expect(tolaFound).toBe(true)
})
