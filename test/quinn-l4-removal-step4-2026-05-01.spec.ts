import { test } from '@playwright/test'

const SHOT_DIR = '/tmp/quinn-20260501-l4-removal'

test('prod setup — open all accordion steps and inspect for forbidden + required content', async ({ page }) => {
  const errors: string[] = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))

  await page.goto('http://localhost:7777/dashboard/setup')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)

  // Click each accordion-step button to expand
  const stepButtons = page.getByRole('button').filter({ hasText: /Step \d|AI & Intelligence|Connections/i })
  const n = await stepButtons.count()
  console.log('step_buttons:', n)
  for (let i = 0; i < n; i++) {
    try {
      const btn = stepButtons.nth(i)
      const txt = (await btn.textContent()) || ''
      console.log(`step_btn_${i}:`, txt.replace(/\s+/g, ' ').slice(0, 60))
      await btn.click({ timeout: 2000 }).catch(() => {})
      await page.waitForTimeout(400)
    } catch {}
  }

  await page.screenshot({ path: `${SHOT_DIR}/setup-7777-all-expanded.png`, fullPage: true })

  // Click [Edit] within Step 4 to open AE editor
  const editBtn = page.getByRole('button', { name: /^\[?Edit\]?$/ }).first()
  if (await editBtn.count() > 0) {
    await editBtn.click().catch(() => {})
    await page.waitForTimeout(800)
  }
  await page.screenshot({ path: `${SHOT_DIR}/setup-7777-ae-editor.png`, fullPage: true })

  const bodyText = (await page.locator('body').textContent()) || ''
  console.log('full_text_len:', bodyText.length)

  const must = [
    { label: 'Step_0_Region_Pods', re: /Region.{0,40}Pod|Pod.{0,40}Region|Step 0/i },
    { label: 'Step_1_OAuth', re: /Step 1.{0,40}OAuth/i },
    { label: 'Step_2_Google_Auth', re: /Step 2.{0,40}Google/i },
    { label: 'Step_3_Connections', re: /Step 3|Connections/i },
    { label: 'RH_offline_token', re: /offline token|Red Hat OAuth|RH OAuth/i },
    { label: 'Google_Drive_text', re: /Google Drive|Drive folder/i },
    { label: 'Step_4_AEs_Customers', re: /Step 4.{0,40}AEs/i },
    { label: 'AI_Intelligence_section', re: /AI & Intelligence/i },
  ]
  for (const { label, re } of must) {
    console.log(`MUST_${label}: ${re.test(bodyText) ? 'OK' : 'FAIL_MISSING'}`)
  }

  const mustNot = [
    { label: 'Data_Sources_visible', re: /Data Sources/i },
    { label: 'Refresh_Timer', re: /Refresh Timer/i },
    { label: 'Automation_Limits', re: /Automation\s*&\s*Limits|Automation and Limits/i },
    { label: 'Tableau_URL_label', re: /Tableau URL/i },
    { label: 'Step_5_Data_Sources', re: /Step 5/i },
  ]
  for (const { label, re } of mustNot) {
    console.log(`MUSTNOT_${label}: ${re.test(bodyText) ? 'FAIL_PRESENT' : 'OK_ABSENT'}`)
  }

  const tableauInputs = await page.locator('input[placeholder*="Tableau" i]').count()
  console.log('tableau_input_count:', tableauInputs)
  const tableauLabels = await page.locator('label').filter({ hasText: /Tableau URL/i }).count()
  console.log('tableau_label_count:', tableauLabels)

  // Headings inventory
  const headings = await page.locator('h1, h2, h3, h4').allTextContents()
  console.log('headings:', JSON.stringify(headings))

  console.log('console_errors:', JSON.stringify(errors))
})

test('test container 7776 — same expansion on fresh state', async ({ page }) => {
  const errors: string[] = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))

  await page.goto('http://localhost:7776/dashboard/setup')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)

  const stepButtons = page.getByRole('button').filter({ hasText: /Step \d|AI & Intelligence|Connections|Region|Pods/i })
  const n = await stepButtons.count()
  console.log('7776_step_buttons:', n)
  for (let i = 0; i < n; i++) {
    try {
      const btn = stepButtons.nth(i)
      const txt = (await btn.textContent()) || ''
      console.log(`7776_step_btn_${i}:`, txt.replace(/\s+/g, ' ').slice(0, 60))
      await btn.click({ timeout: 2000 }).catch(() => {})
      await page.waitForTimeout(400)
    } catch {}
  }

  await page.screenshot({ path: `${SHOT_DIR}/setup-7776-all-expanded.png`, fullPage: true })

  const bodyText = (await page.locator('body').textContent()) || ''
  console.log('7776_full_text_len:', bodyText.length)
  console.log('7776_has_Step_0_Region:', /Region.{0,30}Pod|Step 0/i.test(bodyText))
  console.log('7776_has_Step_3_Connections:', /Step 3|Connections/i.test(bodyText))
  console.log('7776_has_Tableau_URL_label:', /Tableau URL/i.test(bodyText))
  console.log('7776_has_Data_Sources:', /Data Sources/i.test(bodyText))
  console.log('7776_has_Refresh_Timer:', /Refresh Timer/i.test(bodyText))
  console.log('7776_has_Automation_Limits:', /Automation\s*&\s*Limits/i.test(bodyText))
  console.log('7776_console_errors:', JSON.stringify(errors))
})
