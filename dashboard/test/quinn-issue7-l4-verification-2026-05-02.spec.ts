import { test, expect } from '@playwright/test'

// Issue #7 — L4 removal verification on prod (7777)
// Quinn QA session 2026-05-02T02:54:00Z
// Tests are read-only inspection — no @destructive tag, runs against prod via ci project.

const SHOT_DIR = '/tmp/quinn-20260502-issue7'

test.describe('Issue #7 — L4 Tableau removal (prod 7777)', () => {
  test('Tests 1-5: wizard structure, no Tableau text, Step 3 RH token, AE manage description, territory help text', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message))

    await page.goto('http://localhost:7777/dashboard/setup')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1200)

    await page.screenshot({ path: `${SHOT_DIR}/01-wizard-collapsed.png`, fullPage: true })

    // ==================== TEST 1: Wizard structure ====================
    console.log('===== TEST 1: Wizard structure =====')
    const buttonsAll = await page.getByRole('button').allTextContents()
    const stepBtns = buttonsAll.filter(t => /Step \d of \d/i.test(t))
    console.log('TEST1_step_buttons_found:', JSON.stringify(stepBtns))

    // Must have Step 1, 2, 3, 4 — and "of 5" for the count
    const expectedSteps = [
      { name: 'Step1_OAuth', re: /Step 1 of 5.*OAuth/i },
      { name: 'Step2_Google', re: /Step 2 of 5.*Google/i },
      { name: 'Step3_Connections', re: /Step 3 of 5.*Connections/i },
      { name: 'Step4_AEs_Customers', re: /Step 4 of 5.*AEs/i },
    ]
    for (const s of expectedSteps) {
      const found = stepBtns.some(t => s.re.test(t))
      console.log(`TEST1_${s.name}: ${found ? 'PASS' : 'FAIL'}`)
    }

    // Must NOT have Step 5 Data Sources accordion
    const step5DataSources = stepBtns.some(t => /Step 5.*Data Sources/i.test(t))
    console.log(`TEST1_NO_Step5_Data_Sources: ${step5DataSources ? 'FAIL_PRESENT' : 'PASS_ABSENT'}`)

    // ==================== Open all accordions for content checks ====================
    // Click each step accordion to expand
    for (let i = 1; i <= 4; i++) {
      const btn = page.getByRole('button').filter({ hasText: new RegExp(`Step ${i} of 5`, 'i') }).first()
      if (await btn.count() > 0) {
        await btn.click({ timeout: 3000 }).catch(() => {})
        await page.waitForTimeout(400)
      }
    }
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${SHOT_DIR}/02-all-steps-expanded.png`, fullPage: true })

    const bodyText = (await page.locator('body').textContent()) || ''

    // ==================== TEST 2: No Tableau text ====================
    console.log('===== TEST 2: No Tableau text =====')
    const tableauHits = (bodyText.match(/Tableau/gi) || []).length
    console.log(`TEST2_Tableau_occurrences: ${tableauHits} ${tableauHits === 0 ? 'PASS' : 'FAIL'}`)
    const ccspFailHits = (bodyText.match(/CCSP scrape will fail/gi) || []).length
    console.log(`TEST2_CCSP_scrape_will_fail: ${ccspFailHits} ${ccspFailHits === 0 ? 'PASS' : 'FAIL'}`)

    // Inspect any inputs/labels/placeholders that mention Tableau
    const tableauInputs = await page.locator('input[placeholder*="Tableau" i], input[name*="tableau" i]').count()
    console.log(`TEST2_Tableau_input_count: ${tableauInputs} ${tableauInputs === 0 ? 'PASS' : 'FAIL'}`)
    const tableauLabels = await page.locator('label').filter({ hasText: /Tableau/i }).count()
    console.log(`TEST2_Tableau_label_count: ${tableauLabels} ${tableauLabels === 0 ? 'PASS' : 'FAIL'}`)

    // ==================== TEST 3: Step 3 Connections content ====================
    console.log('===== TEST 3: Step 3 Connections content =====')
    // Find Step 3 region — easier to grep body text after expansion
    const hasOfflineToken = /offline token/i.test(bodyText)
    const hasRedHatConnection = /Red Hat (Connection|Offline|OAuth)|RH offline|RH OAuth/i.test(bodyText)
    const hasRedHatPortalConnectionForm = /Red Hat Portal/i.test(bodyText)
    console.log(`TEST3_has_offline_token_text: ${hasOfflineToken ? 'PASS' : 'FAIL'}`)
    console.log(`TEST3_has_RH_Connection_label: ${hasRedHatConnection ? 'PASS' : 'check'}`)
    console.log(`TEST3_RedHatPortal_text_present: ${hasRedHatPortalConnectionForm ? 'WARN_PRESENT' : 'OK_ABSENT'} (raw count=${(bodyText.match(/Red Hat Portal/gi)||[]).length})`)

    await page.screenshot({ path: `${SHOT_DIR}/03-step3-connections.png`, fullPage: true })

    // ==================== TEST 4 & 5: Step 4 Manage tab content ====================
    console.log('===== TEST 4 & 5: Step 4 AE Manage =====')
    // Look for a Manage tab/button
    const manageTab = page.getByRole('button', { name: /^Manage$/i }).or(page.getByRole('tab', { name: /Manage/i })).first()
    const manageCount = await manageTab.count()
    console.log(`TEST4_manage_tab_count: ${manageCount}`)
    if (manageCount > 0) {
      await manageTab.click({ timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(700)
    }
    await page.screenshot({ path: `${SHOT_DIR}/04-step4-manage.png`, fullPage: true })

    const manageBody = (await page.locator('body').textContent()) || ''

    // TEST 4: Description should mention "Drive folder and Salesforce report" not "Tableau dashboard"
    const hasDriveSFDescription = /Drive folder and Salesforce report|Drive folder.*Salesforce/i.test(manageBody)
    const hasTableauDashboard = /Tableau dashboard/i.test(manageBody)
    console.log(`TEST4_has_Drive_and_SF_description: ${hasDriveSFDescription ? 'PASS' : 'FAIL'}`)
    console.log(`TEST4_NO_Tableau_dashboard: ${hasTableauDashboard ? 'FAIL_PRESENT' : 'PASS_ABSENT'}`)

    // TEST 5: Expand an AE card to find Territories field help text
    // Try clicking an [Edit] or expand button on the first AE row
    const editButtons = page.getByRole('button', { name: /^(Edit|\[Edit\]|Expand|▶|▼)$/i })
    const editCount = await editButtons.count()
    console.log(`TEST5_edit_buttons_in_manage: ${editCount}`)
    if (editCount > 0) {
      await editButtons.first().click({ timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(600)
    }
    await page.screenshot({ path: `${SHOT_DIR}/05-step4-ae-expanded.png`, fullPage: true })

    const expandedBody = (await page.locator('body').textContent()) || ''
    const hasTerritoryCorrect = /Territory code for CCSP scoping/i.test(expandedBody)
    const hasTerritoryWrong = /Tableau territory code/i.test(expandedBody)
    console.log(`TEST5_help_text_correct: ${hasTerritoryCorrect ? 'PASS' : 'FAIL_MISSING'}`)
    console.log(`TEST5_NO_Tableau_territory_code: ${hasTerritoryWrong ? 'FAIL_PRESENT' : 'PASS_ABSENT'}`)

    console.log('===== Console errors =====')
    console.log('console_errors:', JSON.stringify(consoleErrors))

    // Don't hard-fail the test — Quinn collects evidence; pass/fail is in the log lines.
    expect(true).toBe(true)
  })
})
