import { test, expect } from '@playwright/test'

const SHOT_DIR = '/tmp/quinn-20260501-l4-removal'

const PORTS = [
  { port: 7776, name: 'test' },
  { port: 7777, name: 'prod' },
]

for (const { port, name } of PORTS) {
  test.describe(`L4 removal — ${name} (${port})`, () => {
    test(`setup page on ${name}`, async ({ page }) => {
      const errors: string[] = []
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
      page.on('pageerror', e => errors.push('pageerror: ' + e.message))

      await page.goto(`http://localhost:${port}/dashboard/setup`)
      await page.waitForLoadState('networkidle')
      // give async lazy chunks a moment
      await page.waitForTimeout(800)
      await page.screenshot({ path: `${SHOT_DIR}/setup-${port}.png`, fullPage: true })

      const bodyText = (await page.locator('body').textContent()) || ''
      const headings = await page.locator('h1, h2, h3, h4').allTextContents()

      console.log(`SETUP_${port}_headings:`, JSON.stringify(headings))
      console.log(`SETUP_${port}_text_len:`, bodyText.length)
      console.log(`SETUP_${port}_console_errors:`, JSON.stringify(errors))

      // Must appear
      const must = [
        /Region/i,
        /Pods?/i,
        /Red Hat (OAuth|offline)|offline token/i,
        /Google Drive/i,
        /Connections/i,
        /AEs?.+Customers?|AEs? & Customers/i,
        /AI.*(Intelligence|Settings)/i,
      ]
      for (const re of must) {
        const ok = re.test(bodyText)
        console.log(`SETUP_${port}_must_${re}: ${ok}`)
      }

      // Must NOT appear
      const mustNot = [
        { label: 'Data Sources', re: /Data Sources/i },
        { label: 'Refresh Timer', re: /Refresh Timer/i },
        { label: 'Automation & Limits', re: /Automation\s*&\s*Limits|Automation and Limits/i },
        { label: 'Tableau URL field', re: /Tableau\s*URL/i },
        { label: 'Step 5 of 5 Data Sources', re: /Step\s*5\s*of\s*5[^\n]{0,40}Data Sources/i },
      ]
      for (const { label, re } of mustNot) {
        const found = re.test(bodyText)
        console.log(`SETUP_${port}_mustNOT_${label}: ${found ? 'FAIL_PRESENT' : 'OK_ABSENT'}`)
      }
    })

    test(`admin page on ${name}`, async ({ page }) => {
      const errors: string[] = []
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
      page.on('pageerror', e => errors.push('pageerror: ' + e.message))

      await page.goto(`http://localhost:${port}/dashboard/admin`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(800)
      await page.screenshot({ path: `${SHOT_DIR}/admin-${port}.png`, fullPage: true })

      const bodyText = (await page.locator('body').textContent()) || ''
      const headings = await page.locator('h1, h2, h3, h4').allTextContents()

      console.log(`ADMIN_${port}_headings:`, JSON.stringify(headings))
      console.log(`ADMIN_${port}_text_len:`, bodyText.length)
      console.log(`ADMIN_${port}_console_errors:`, JSON.stringify(errors))

      // Must appear
      const must = [
        { label: 'RH Cases', re: /RH Cases/i },
        { label: 'Run Now', re: /Run Now/i },
        { label: 'Scheduler', re: /Scheduler/i },
      ]
      for (const { label, re } of must) {
        console.log(`ADMIN_${port}_must_${label}: ${re.test(bodyText) ? 'OK' : 'FAIL_MISSING'}`)
      }

      // Must NOT appear
      const mustNot = [
        { label: 'CCSP scrape', re: /CCSP/i },
        { label: 'SF Pipeline', re: /SF Pipeline|Salesforce/i },
        { label: 'Browser Sessions', re: /Browser Sessions/i },
        { label: 'Open VNC', re: /Open VNC|VNC Login/i },
        { label: 'SessionHealthPanel/Tableau', re: /Session Health|Tableau/i },
      ]
      for (const { label, re } of mustNot) {
        const found = re.test(bodyText)
        console.log(`ADMIN_${port}_mustNOT_${label}: ${found ? 'FAIL_PRESENT' : 'OK_ABSENT'}`)
      }
    })
  })
}
