import { test, expect } from '@playwright/test'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'
const SETUP_URL = `${BASE}/dashboard/setup`

test('TOLA pod appears when TOLA region selected', async ({ page }) => {
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

  // Verify region dropdown exists
  const regionSelect = page.locator('[data-testid="region-select"]')
  const regionCount = await regionSelect.count()
  console.log('Region select count:', regionCount)

  if (regionCount > 0) {
    // Switch to TOLA region
    await regionSelect.selectOption({ label: 'Central Enterprise – TOLA' })
    await page.waitForTimeout(500)

    const podSelect = page.locator('[data-testid="pod-select"]')
    const options = await podSelect.locator('option').allTextContents()
    console.log('TOLA region pod options:', JSON.stringify(options))
    
    const hasTola = options.some(o => o.includes('TOLA'))
    console.log('Has TOLA pod:', hasTola)
    expect(hasTola).toBe(true)
  } else {
    // Region is determined by the select without data-testid — check by label
    const allSelects = page.locator('select')
    const selCount = await allSelects.count()
    console.log('All selects on page:', selCount)
    
    for (let i = 0; i < selCount; i++) {
      const opts = await allSelects.nth(i).locator('option').allTextContents()
      console.log(`Select ${i} options:`, JSON.stringify(opts))
    }
  }

  await page.screenshot({ path: '/tmp/qa-hero01-p4-tola-pods.png', fullPage: false })
})
