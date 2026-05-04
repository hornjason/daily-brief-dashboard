import { test } from '@playwright/test'

const SHOT_DIR = '/tmp/quinn-20260501-l4-removal'

for (const port of [7776, 7777]) {
  test(`port ${port} — open Step 4, expand AE editor, inspect for Tableau URL`, async ({ page }) => {
    const errors: string[] = []
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', e => errors.push('pageerror: ' + e.message))

    await page.goto(`http://localhost:${port}/dashboard/setup`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1200)

    // Open Step 4
    const step4 = page.getByRole('button', { name: /Step 4 of 5/i }).first()
    if (await step4.count() > 0) {
      await step4.click()
      await page.waitForTimeout(600)
    } else {
      console.log(`${port}_no_step4_button`)
    }

    await page.screenshot({ path: `${SHOT_DIR}/setup-${port}-step4-open.png`, fullPage: true })

    // Click [Edit] on the first AE row
    const editBtn = page.getByRole('button', { name: /^\[?Edit\]?$/i }).first()
    if (await editBtn.count() > 0) {
      await editBtn.click()
      await page.waitForTimeout(600)
    } else {
      // try a chevron/expand pattern
      const expand = page.locator('button[aria-label*="edit" i], button[title*="edit" i]').first()
      if (await expand.count() > 0) await expand.click().catch(() => {})
      await page.waitForTimeout(600)
    }

    await page.screenshot({ path: `${SHOT_DIR}/setup-${port}-step4-ae-edit.png`, fullPage: true })

    // Look for Tableau URL field
    const bodyText = (await page.locator('body').textContent()) || ''
    const tableauInputs = await page.locator('input[placeholder*="Tableau" i]').count()
    const tableauLabels = await page.locator('label:has-text("Tableau URL")').count()
    const allLabels = await page.locator('label').allTextContents()
    const allInputPlaceholders = await page.locator('input').evaluateAll(els =>
      (els as HTMLInputElement[]).map(e => e.placeholder).filter(Boolean)
    )

    console.log(`${port}_text_len:`, bodyText.length)
    console.log(`${port}_tableau_input_count:`, tableauInputs)
    console.log(`${port}_tableau_label_count:`, tableauLabels)
    console.log(`${port}_has_Tableau_URL_text:`, /Tableau URL/i.test(bodyText))
    console.log(`${port}_has_Tableau_anywhere:`, /Tableau/i.test(bodyText))
    console.log(`${port}_labels_with_tableau:`, JSON.stringify(allLabels.filter(l => /tableau/i.test(l))))
    console.log(`${port}_placeholders_with_tableau:`, JSON.stringify(allInputPlaceholders.filter(p => /tableau/i.test(p))))
    console.log(`${port}_console_errors:`, JSON.stringify(errors))
  })
}
