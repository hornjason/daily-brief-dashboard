import { test, expect } from '@playwright/test'

test('BKL-HERO-01 Phase 2 — extract headings', async ({ page }) => {
  page.on('console', m => { if (m.type()==='error') console.log('CONSOLE-ERR:', m.text())})
  page.on('pageerror', e => console.log('PAGE-ERR:', e.message))
  await page.goto('/dashboard/setup', { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  const headings = await page.locator('h1,h2,h3,h4').allTextContents()
  console.log('HEADINGS:', JSON.stringify(headings, null, 2))
  await page.screenshot({ path: 'test/screenshots/quinn-bkl-hero01-phase2-fullwizard.png', fullPage: true })
})
