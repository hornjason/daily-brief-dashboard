import { test, expect } from '@playwright/test'
import fs from 'fs'

const SHOTS = 'test/screenshots/quinn-issue7'
fs.mkdirSync(SHOTS, { recursive: true })

const consoleErrors: string[] = []
const pageErrors: string[] = []

test.beforeEach(async ({ page }) => {
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => pageErrors.push(e.message))
})

test('Issue #7 — wizard step inventory + Tableau/VNC scrub', async ({ page }) => {
  await page.goto('/dashboard/setup', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${SHOTS}/00-wizard-landing.png`, fullPage: true })

  // Capture full body text for forbidden-string scan
  const bodyText = await page.locator('body').innerText()
  console.log('--- BODY TEXT (first 4000) ---')
  console.log(bodyText.slice(0, 4000))

  // Capture wizard step indicators / nav buttons
  const headings = await page.locator('h1,h2,h3,h4').allTextContents()
  console.log('HEADINGS:', JSON.stringify(headings))

  // Look for sidebar / step nav buttons
  const stepButtons = await page.locator('button, [role="tab"], nav a').allTextContents()
  console.log('STEP-LIKE LABELS:', JSON.stringify(stepButtons.filter(s => s && s.length < 60)))

  // Forbidden strings in wizard
  const forbidden = [
    'Connections',
    'Data Sources',
    'Refresh Timer',
    'Automation & Limits',
    'Automation',
    'Tableau URL',
    'Tableau dashboard',
    'Open VNC',
    'VNC',
    'Tableau not connected',
  ]
  const found: Record<string, boolean> = {}
  for (const s of forbidden) {
    found[s] = bodyText.includes(s)
  }
  console.log('FORBIDDEN-MATCHES:', JSON.stringify(found, null, 2))
})

test('Issue #7 — walk wizard steps and capture screenshots', async ({ page }) => {
  await page.goto('/dashboard/setup', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)

  // Click Next repeatedly to walk through steps; capture screenshot each
  for (let i = 0; i < 10; i++) {
    await page.screenshot({ path: `${SHOTS}/step-${String(i).padStart(2, '0')}.png`, fullPage: true })
    const headings = await page.locator('h1,h2,h3').allTextContents()
    const body = (await page.locator('body').innerText()).slice(0, 500)
    console.log(`STEP ${i} HEADINGS:`, JSON.stringify(headings))
    console.log(`STEP ${i} BODY-START:`, body.replace(/\s+/g, ' ').slice(0, 300))

    const nextBtn = page.locator('button', { hasText: /^(Next|Continue|Skip)/ }).first()
    if (await nextBtn.count() === 0) {
      console.log(`STEP ${i}: no Next button, stopping walk`)
      break
    }
    const enabled = await nextBtn.isEnabled().catch(() => false)
    if (!enabled) {
      console.log(`STEP ${i}: Next button disabled, stopping walk`)
      break
    }
    await nextBtn.click().catch(() => {})
    await page.waitForTimeout(800)
  }
})

test('Issue #7 — Step 4 AEs & Customers field/label scan', async ({ page }) => {
  await page.goto('/dashboard/setup', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)

  // Try to navigate directly via step buttons that include "AE" or "Customer"
  const aeStepBtn = page.locator('button, [role="tab"]', { hasText: /AEs?\s*&|AE & Cust|Customers/i }).first()
  if (await aeStepBtn.count() > 0) {
    await aeStepBtn.click().catch(() => {})
    await page.waitForTimeout(1200)
  } else {
    // Walk forward 5 times
    for (let i = 0; i < 5; i++) {
      const nextBtn = page.locator('button', { hasText: /^(Next|Continue|Skip)/ }).first()
      if (await nextBtn.count() === 0) break
      if (!(await nextBtn.isEnabled().catch(() => false))) break
      await nextBtn.click().catch(() => {})
      await page.waitForTimeout(600)
    }
  }

  await page.screenshot({ path: `${SHOTS}/step4-ae-customers.png`, fullPage: true })

  // Try Manage tab
  const manageTab = page.locator('button, [role="tab"]', { hasText: /^Manage$/i }).first()
  if (await manageTab.count() > 0) {
    await manageTab.click().catch(() => {})
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${SHOTS}/step4-manage-tab.png`, fullPage: true })
  }

  const fullBody = await page.locator('body').innerText()
  console.log('--- STEP4 BODY ---')
  console.log(fullBody)

  // Field-level checks
  const tableauUrlInputs = await page.locator('input[placeholder*="ableau" i], input[name*="ableau" i], label:has-text("Tableau URL")').count()
  const territoryLabel = await page.locator('label', { hasText: /Territory/i }).allTextContents()
  const territoryCodeMatch = territoryLabel.some(t => /Territory Code/i.test(t))
  const territoryOptionalMatch = territoryLabel.some(t => /Territory \(optional\)/i.test(t))
  const tableauDashboardText = fullBody.includes('Tableau dashboard')
  const tableauWarning = fullBody.match(/Tableau.*not connected|Tableau not connected/i)

  console.log('CHECK tableauUrlInputs:', tableauUrlInputs)
  console.log('CHECK territoryLabels:', JSON.stringify(territoryLabel))
  console.log('CHECK territoryCodeMatch:', territoryCodeMatch)
  console.log('CHECK territoryOptionalMatch:', territoryOptionalMatch)
  console.log('CHECK tableauDashboardText:', tableauDashboardText)
  console.log('CHECK tableauWarning:', tableauWarning ? tableauWarning[0] : 'none')
})

test('Issue #7 — Step 4 Full POD tab Tableau-warning scan', async ({ page }) => {
  await page.goto('/dashboard/setup', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  // Expand the AEs & Customers step first
  const aeStep = page.locator('text=/AEs & Customers/i').first()
  if (await aeStep.count() > 0) {
    await aeStep.click().catch(() => {})
    await page.waitForTimeout(800)
  }
  const fullPodTab = page.locator('button, [role="tab"]', { hasText: /^Full POD$/i }).first()
  if (await fullPodTab.count() > 0) {
    await fullPodTab.click().catch(() => {})
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${SHOTS}/step4-full-pod-tab.png`, fullPage: true })
    const body = await page.locator('body').innerText()
    console.log('--- FULL POD BODY ---')
    console.log(body)
    console.log('FULL-POD Tableau warning?:', /Tableau.*not connected/i.test(body))
    console.log('FULL-POD Tableau URL?:', /Tableau URL/i.test(body))
  } else {
    console.log('Full POD tab not found')
  }
})

test('Issue #7 — Region/Step0 presence check', async ({ page }) => {
  // Brief expected Step 0 (Region) as part of the 6-step wizard. Verify presence/absence.
  await page.goto('/dashboard/setup', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const body = await page.locator('body').innerText()
  const hasRegion = /Region/i.test(body)
  const hasStep0 = /Step 0/i.test(body)
  console.log('REGION mention:', hasRegion)
  console.log('STEP 0 mention:', hasStep0)
  // Capture full body for the record
  console.log('--- FULL WIZARD BODY ---')
  console.log(body)
})

test('Issue #7 — Dashboard loads with data', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${SHOTS}/dashboard.png`, fullPage: true })
  const headings = await page.locator('h1,h2,h3').allTextContents()
  console.log('DASHBOARD HEADINGS:', JSON.stringify(headings))
  const bodyLen = (await page.locator('body').innerText()).length
  console.log('DASHBOARD BODY LENGTH:', bodyLen)
  console.log('CONSOLE ERRORS:', JSON.stringify(consoleErrors))
  console.log('PAGE ERRORS:', JSON.stringify(pageErrors))
})
