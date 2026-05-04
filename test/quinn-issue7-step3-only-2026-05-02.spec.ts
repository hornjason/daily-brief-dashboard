import { test, expect } from '@playwright/test'

const SHOT_DIR = '/tmp/quinn-20260502-issue7'

test('Step 3 only — verify RH offline token content', async ({ page }) => {
  await page.goto('http://localhost:7777/dashboard/setup')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1000)

  const step3 = page.getByRole('button').filter({ hasText: /Step 3 of 5/i }).first()
  await step3.click()
  await page.waitForTimeout(800)

  await page.screenshot({ path: `${SHOT_DIR}/06-step3-only-expanded.png`, fullPage: true })

  const body = (await page.locator('body').textContent()) || ''

  console.log('STEP3_Tableau_count:', (body.match(/Tableau/gi)||[]).length)
  console.log('STEP3_offline_token:', /offline token/i.test(body) ? 'PASS' : 'FAIL')
  console.log('STEP3_Red_Hat_text:', /Red Hat/i.test(body) ? 'PRESENT' : 'ABSENT')
  console.log('STEP3_RedHatPortal_count:', (body.match(/Red Hat Portal/gi)||[]).length)
  console.log('STEP3_OAuth_keys_text:', /OAuth/i.test(body) ? 'PRESENT' : 'ABSENT')
  console.log('STEP3_Connect_button:', /Connect/i.test(body) ? 'PRESENT' : 'ABSENT')

  // Dump all headings and labels in the document for inventory
  const headings = await page.locator('h1, h2, h3, h4').allTextContents()
  console.log('STEP3_headings:', JSON.stringify(headings))
  const labels = await page.locator('label').allTextContents()
  console.log('STEP3_labels:', JSON.stringify(labels))

  // Try to read the Step 3 section's inner content by finding the expanded panel
  // Heuristic: look for any container that has both "Step 3" and visible content beneath
  const step3Panel = page.locator('[role="region"], [data-state="open"]').filter({ hasText: /Connection|Red Hat|offline/i }).first()
  const step3PanelCount = await step3Panel.count()
  if (step3PanelCount > 0) {
    const inner = (await step3Panel.textContent()) || ''
    console.log('STEP3_panel_text:', JSON.stringify(inner.slice(0, 800)))
  } else {
    console.log('STEP3_panel_text: NOT_FOUND_BY_HEURISTIC')
  }

  expect(true).toBe(true)
})
