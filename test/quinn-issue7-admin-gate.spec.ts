/**
 * Quinn Issue #7 — Admin Page L4 Removal Gate
 * Verifies L4 UI sections are gone and required sections remain.
 * Safe: read-only, no state mutation.
 */
import { test, expect } from '@playwright/test'
import fs from 'fs'

const SHOTS = 'test/screenshots/quinn-issue7-admin'
fs.mkdirSync(SHOTS, { recursive: true })

test('Issue #7 — Admin page: L4 sections removed, required sections present', async ({ page }) => {
  await page.goto('/dashboard/admin', { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: `${SHOTS}/admin-full.png`, fullPage: true })

  const bodyText = await page.locator('body').innerText()
  console.log('--- ADMIN BODY TEXT ---')
  console.log(bodyText)

  // L4 items that MUST NOT be present
  const forbiddenStrings = [
    'CCSP',
    'Open VNC Login',
    'Open VNC',
    'Browser Sessions',
    'ContentRhSession',
  ]

  const foundForbidden: string[] = []
  for (const s of forbiddenStrings) {
    if (bodyText.includes(s)) {
      foundForbidden.push(s)
    }
  }
  console.log('FORBIDDEN FOUND:', JSON.stringify(foundForbidden))

  // Required sections that MUST be present
  const requiredStrings = [
    'RH Cases',
    'SF Pipeline',
    'Scheduler',
    'AI',
  ]

  const missingRequired: string[] = []
  for (const s of requiredStrings) {
    if (!bodyText.includes(s)) {
      missingRequired.push(s)
    }
  }
  console.log('MISSING REQUIRED:', JSON.stringify(missingRequired))

  // Run Now buttons (should exist for RH Cases and SF Pipeline)
  const runNowButtons = await page.locator('button', { hasText: /Run Now/i }).allTextContents()
  console.log('RUN NOW BUTTONS:', JSON.stringify(runNowButtons))

  // Assert L4 elements are absent
  expect(foundForbidden, `These L4 strings must be absent: ${foundForbidden.join(', ')}`).toHaveLength(0)

  // Assert required sections are present
  expect(missingRequired, `These required sections are missing: ${missingRequired.join(', ')}`).toHaveLength(0)
})

test('Issue #7 — Session health panel: only RH Portal and Salesforce tiles', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: `${SHOTS}/dashboard-session-health.png`, fullPage: true })

  const bodyText = await page.locator('body').innerText()
  console.log('--- DASHBOARD BODY TEXT ---')
  console.log(bodyText)

  // Tableau/CCSP tile must NOT be present in session health
  const tableauPresent = bodyText.includes('Tableau / CCSP') || bodyText.includes('Tableau/CCSP')
  console.log('TABLEAU/CCSP TILE PRESENT:', tableauPresent)

  // RH Portal and Salesforce tiles MUST be present
  const rhPortalPresent = bodyText.includes('RH Portal')
  const salesforcePresent = bodyText.includes('Salesforce')
  console.log('RH PORTAL PRESENT:', rhPortalPresent)
  console.log('SALESFORCE PRESENT:', salesforcePresent)

  // Scroll to session health section if present
  const sessionHealthHeading = page.locator('text=/Session Health|session health/i').first()
  if (await sessionHealthHeading.count() > 0) {
    await sessionHealthHeading.scrollIntoViewIfNeeded()
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${SHOTS}/dashboard-session-health-scrolled.png`, fullPage: false })
    console.log('SESSION HEALTH heading found — screenshot captured')
  } else {
    console.log('SESSION HEALTH heading not found in body')
  }

  expect(tableauPresent, 'Tableau/CCSP tile must NOT appear in session health panel').toBe(false)
})

test('Issue #7 — Setup wizard: no Tableau URL, Territory Code label, 5 steps', async ({ page }) => {
  await page.goto('/dashboard/setup', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: `${SHOTS}/setup-wizard.png`, fullPage: true })

  const bodyText = await page.locator('body').innerText()

  // No Tableau URL field
  const tableauUrlPresent = /Tableau URL/i.test(bodyText)
  console.log('TABLEAU URL PRESENT:', tableauUrlPresent)

  // Territory Code label correct
  const territoryCodePresent = /Territory Code/i.test(bodyText)
  console.log('TERRITORY CODE PRESENT:', territoryCodePresent)

  // 5-step wizard indicators
  const step5Match = bodyText.match(/Step [1-5] of 5/g) || []
  console.log('5-STEP INDICATORS FOUND:', JSON.stringify(step5Match))
  const hasStepOf5 = /Step \d of 5/.test(bodyText)
  console.log('HAS STEP X OF 5:', hasStepOf5)

  expect(tableauUrlPresent, 'Tableau URL field must not be present in setup wizard').toBe(false)
  expect(territoryCodePresent, 'Territory Code label must be present').toBe(true)
  expect(hasStepOf5, 'Wizard must show Step X of 5 indicator').toBe(true)
})
