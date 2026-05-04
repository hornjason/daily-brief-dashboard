import { test } from '@playwright/test'

const BASE = 'http://localhost:7777'
const CUSTOMER = 'A10 Networks'

test('L4 hit context — what surrounds Cloud Spend / Cases', async ({ page }) => {
  await page.goto(`${BASE}/dashboard/customer/${encodeURIComponent(CUSTOMER)}`, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(1500)

  // Find elements containing the text and capture their parent context
  const cloudEls = page.getByText(/Cloud Spend|Cloud \$/i)
  const cloudCount = await cloudEls.count()
  console.log(`Cloud Spend element count: ${cloudCount}`)
  for (let i = 0; i < cloudCount; i++) {
    const el = cloudEls.nth(i)
    const tag = await el.evaluate(n => (n as Element).tagName)
    const txt = (await el.textContent() || '').slice(0, 120)
    const parentClass = await el.evaluate(n => (n.parentElement as Element)?.className || '')
    console.log(`  [${i}] <${tag}> class="${parentClass}" text="${txt}"`)
  }

  const casesEls = page.getByText(/Open Cases|Support Cases|Recent Cases/i)
  const casesCount = await casesEls.count()
  console.log(`Cases section element count: ${casesCount}`)
  for (let i = 0; i < casesCount; i++) {
    const el = casesEls.nth(i)
    const tag = await el.evaluate(n => (n as Element).tagName)
    const txt = (await el.textContent() || '').slice(0, 120)
    const parentClass = await el.evaluate(n => (n.parentElement as Element)?.className || '')
    console.log(`  [${i}] <${tag}> class="${parentClass}" text="${txt}"`)
  }

  // Check for actual rendered CCSP/Pipeline section components
  const ccspSection = await page.locator('section, div').filter({ hasText: /\$[\d,]+(\.\d+)?\s*(USD|monthly|spend)/i }).count()
  console.log(`Sections with money values matching cloud spend pattern: ${ccspSection}`)
})
