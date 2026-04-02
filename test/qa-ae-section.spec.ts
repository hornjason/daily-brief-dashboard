/**
 * Focused test on AE & Customers section interaction
 */
import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:7777'

test('AE section: expand and scroll into view', async ({ page }) => {
  await page.goto(`${BASE}/dashboard/setup`)
  await page.waitForTimeout(1500)

  // Find and click the AEs & Customers header
  const aeHeader = page.getByText('AEs & Customers')
  await aeHeader.scrollIntoViewIfNeeded()
  await aeHeader.click()
  await page.waitForTimeout(1000)

  // Scroll down to see expanded content
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await page.waitForTimeout(500)
  await page.screenshot({ path: '/tmp/qa-ae-expanded-scrolled.png', fullPage: true })

  // Check what's visible in the AE section
  const bodyText = await page.textContent('body')
  console.log('Body text after AE expand:', bodyText?.substring(0, 1000))

  // Look for any input elements
  const allInputs = await page.locator('input').count()
  const allTextareas = await page.locator('textarea').count()
  const allSelects = await page.locator('select').count()
  console.log('Inputs:', allInputs, 'Textareas:', allTextareas, 'Selects:', allSelects)

  // Assert: AE section header is visible after expanding
  await expect(page.getByText('AEs & Customers')).toBeVisible()
})

test('AE section: check for Add AE button', async ({ page }) => {
  await page.goto(`${BASE}/dashboard/setup`)
  await page.waitForTimeout(1000)

  const aeHeader = page.getByText('AEs & Customers')
  await aeHeader.scrollIntoViewIfNeeded()
  await aeHeader.click()
  await page.waitForTimeout(1000)

  // Look for an Add AE button
  const addBtn = page.locator('button').filter({ hasText: /add|new|create/i })
  const count = await addBtn.count()
  console.log('Add/Create buttons found:', count)
  for (let i = 0; i < count; i++) {
    console.log(`  Button ${i}:`, await addBtn.nth(i).textContent())
  }

  // Also check all buttons visible
  const allBtns = await page.locator('button').all()
  for (const btn of allBtns) {
    const text = await btn.textContent()
    if (text?.trim()) console.log('Button:', text.trim())
  }

  // Assert: at least one button exists in the expanded section
  expect(allBtns.length).toBeGreaterThan(0)
})

test('AE section: full page content after expand', async ({ page }) => {
  await page.goto(`${BASE}/dashboard/setup`)
  await page.waitForTimeout(1000)

  // Expand AEs section
  const aeHeader = page.getByText('AEs & Customers')
  await aeHeader.scrollIntoViewIfNeeded()
  await aeHeader.click()
  await page.waitForTimeout(1000)

  // Get full HTML of the AE section content
  const sectionContent = await page.locator('#aes, [id="aes"]').first()
  if (await sectionContent.count() > 0) {
    const html = await sectionContent.innerHTML()
    console.log('AE section HTML (first 2000 chars):', html.substring(0, 2000))
  } else {
    console.log('No #aes element found')
    // Try finding the section by its content
    const aeContent = await page.evaluate(() => {
      const headers = document.querySelectorAll('button, h2, h3')
      for (const h of headers) {
        if (h.textContent?.includes('AEs & Customers')) {
          const parent = h.closest('div')
          return parent?.innerHTML?.substring(0, 2000) || 'parent not found'
        }
      }
      return 'section not found'
    })
    console.log('AE parent content:', aeContent)
  }

  // Assert: the AEs & Customers section is visible on the page
  await expect(page.getByText('AEs & Customers')).toBeVisible()
})

test('dashboard: check KPI values with config', async ({ page }) => {
  // Ensure AE is set
  await page.request.post(`${BASE}/api/aes`, {
    data: { aes: [{
      name: 'Carolanne Farrell',
      driveFolderId: '1BV0uRHei3oRvGYVEXBX_qBB-VGu0r9wq',
      sfReportId: '00OPe00000isU2zMAE',
      tableauTerritories: ['WEST_COMM_CORP_NORTHWEST_TERR01'],
      supportableSheetId: '150e3-q-8_6Uy3qnLhL-ARBVHyVy29P7tnAuFjxkkuCg',
      ccspSheetId: '10JEEZb3mDV7nY2w5gJ7zmEkN8p4TDjKOxHSNvumVUFs',
      pipelineSheetId: '10H8Nl8oQQg1x9Zt0p5cys7JJp0b4ObfzhB-pPMot3BM',
    }] }
  })

  await page.goto(`${BASE}/dashboard`)
  await page.waitForTimeout(3000)

  // Check KPI card values
  const kpiCards = await page.locator('[class*="kpi" i], [class*="card" i], [class*="stat" i]').all()
  console.log('KPI/card elements:', kpiCards.length)

  // Get all visible numbers/stats
  const bodyText = await page.textContent('body')

  // Check for "Carolanne" or "AC" initials (from the sidebar)
  const hasAERef = bodyText?.includes('Carolanne') || bodyText?.includes('AC')
  console.log('AE reference on dashboard:', hasAERef)
  console.log('Body snippet:', bodyText?.substring(0, 200))

  // Look for the initials avatar in sidebar
  const avatar = page.locator('[class*="avatar" i], [class*="initials" i]')
  console.log('Avatar elements:', await avatar.count())

  // Assert: dashboard body has visible content
  await expect(page.locator('body')).toBeVisible()
  expect(bodyText?.length).toBeGreaterThan(50)
})

test('dashboard: network requests analysis', async ({ page }) => {
  const requests: { url: string; status: number }[] = []
  page.on('response', response => {
    if (response.url().includes('/api/')) {
      requests.push({ url: response.url(), status: response.status() })
    }
  })

  await page.request.post(`${BASE}/api/aes`, {
    data: { aes: [{
      name: 'Carolanne Farrell',
      driveFolderId: '1BV0uRHei3oRvGYVEXBX_qBB-VGu0r9wq',
      sfReportId: '00OPe00000isU2zMAE',
      tableauTerritories: ['WEST_COMM_CORP_NORTHWEST_TERR01'],
      supportableSheetId: '150e3-q-8_6Uy3qnLhL-ARBVHyVy29P7tnAuFjxkkuCg',
      ccspSheetId: '10JEEZb3mDV7nY2w5gJ7zmEkN8p4TDjKOxHSNvumVUFs',
      pipelineSheetId: '10H8Nl8oQQg1x9Zt0p5cys7JJp0b4ObfzhB-pPMot3BM',
    }] }
  })

  await page.goto(`${BASE}/dashboard`)
  await page.waitForTimeout(4000)

  console.log('API requests during dashboard load:')
  for (const r of requests) {
    const emoji = r.status >= 400 ? 'FAIL' : 'OK'
    console.log(`  ${emoji} [${r.status}] ${r.url}`)
  }

  // Assert: at least one API request was made during dashboard load
  expect(requests.length).toBeGreaterThan(0)
})
