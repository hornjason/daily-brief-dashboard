import { test } from '@playwright/test'

test('Q1 sidebar inventory on /dashboard/products', async ({ page }) => {
  const errors: string[] = []
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))

  await page.goto('http://localhost:7777/dashboard/products')
  await page.waitForLoadState('networkidle')
  await page.screenshot({ path: '/tmp/quinn-20260429-node-role/products.png', fullPage: true })

  const asideCount = await page.locator('aside').count()
  console.log('Q1_aside_count:', asideCount)
  const links = await page.locator('aside a').all()
  console.log('Q1_aside_link_count:', links.length)
  for (const l of links) {
    const aria = await l.getAttribute('aria-label')
    const href = await l.getAttribute('href')
    const text = (await l.textContent())?.trim().slice(0, 40)
    console.log(`Q1_link href=${href} aria=${aria} text="${text}"`)
  }
  console.log('Q1_console_errors:', JSON.stringify(errors))
})

test('Q2 dashboard load + customer cards', async ({ page }) => {
  const errors: string[] = []
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))

  await page.goto('http://localhost:7777/dashboard')
  await page.waitForLoadState('networkidle')
  await page.screenshot({ path: '/tmp/quinn-20260429-node-role/dashboard.png', fullPage: true })

  const customerLinks = await page.locator('a[href*="/customer/"]').count()
  const cards = await page.locator('[data-testid="customer-card"], .customer-card').count()
  console.log('Q2_customer_anchor_count:', customerLinks)
  console.log('Q2_customer_card_count:', cards)
  console.log('Q2_console_errors:', JSON.stringify(errors))
})

test('Q3 admin page load + connection cards', async ({ page }) => {
  const errors: string[] = []
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))

  await page.goto('http://localhost:7777/dashboard/admin')
  await page.waitForLoadState('networkidle')
  await page.screenshot({ path: '/tmp/quinn-20260429-node-role/admin.png', fullPage: true })

  const headings = await page.locator('h1, h2, h3').allTextContents()
  console.log('Q3_headings:', JSON.stringify(headings))
  const main = await page.locator('main').textContent()
  console.log('Q3_main_snippet:', (main || '').slice(0, 1500))
  console.log('Q3_console_errors:', JSON.stringify(errors))
})

test('Q4 customer detail page load (first customer)', async ({ page }) => {
  const errors: string[] = []
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))

  await page.goto('http://localhost:7777/dashboard')
  await page.waitForLoadState('networkidle')
  const firstCustomer = page.locator('a[href*="/customer/"]').first()
  const href = await firstCustomer.getAttribute('href')
  console.log('Q4_first_customer_href:', href)
  if (href) {
    await firstCustomer.click()
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: '/tmp/quinn-20260429-node-role/customer-detail.png', fullPage: true })
    const h = await page.locator('h1, h2').allTextContents()
    console.log('Q4_detail_headings:', JSON.stringify(h))
  }
  console.log('Q4_console_errors:', JSON.stringify(errors))
})
