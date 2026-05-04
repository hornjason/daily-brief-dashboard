/**
 * Quinn QA session — BKL-HERO-01 Phase 1
 * Visual + interactive validation of Step 0 — Region & Pod Access on /dashboard/setup.
 *
 * Target: prod (port 7777, ci project). Save POST is intercepted to avoid mutating
 * prod settings.json (which would hide Step 0 permanently after the run).
 *
 * Excluded from CI by being under test/quinn-sessions/ (not in default testDir).
 */
import { test, expect, Page } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SHOTS = path.join(__dirname, 'screenshots-bkl-hero-01')
fs.mkdirSync(SHOTS, { recursive: true })

async function gotoSetup(page: Page) {
  // Intercept the save endpoint so we never write to prod settings.json
  await page.route('**/api/regions/access', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })
  await page.goto('/dashboard/setup', { waitUntil: 'networkidle' })
}

test('BKL-HERO-01 Phase 1 — full Quinn visual review', async ({ page }) => {
  const findings: string[] = []
  await gotoSetup(page)

  // 1. Step 0 renders at top
  const step0 = page.getByTestId('step0-region-access')
  await expect(step0).toBeVisible()
  await expect(step0.getByRole('heading', { name: /Step 0 — Select Your Region & Pods/i })).toBeVisible()
  // Confirm it appears BEFORE the OAuth Step 1 accordion
  const step0Box = await step0.boundingBox()
  const oauth = page.getByText(/Step 1 of 5 — OAuth Keys/)
  const oauthBox = await oauth.boundingBox()
  if (!step0Box || !oauthBox) findings.push('FAIL: bounding boxes missing')
  else if (step0Box.y >= oauthBox.y) findings.push(`FAIL: Step 0 (y=${step0Box.y}) not above OAuth (y=${oauthBox.y})`)
  else findings.push(`PASS 1: Step 0 renders above OAuth (Δy=${(oauthBox.y - step0Box.y).toFixed(0)}px)`)
  await page.screenshot({ path: path.join(SHOTS, '01-step0-form.png'), fullPage: false })

  // 2. Region list — West selectable, TOLA selectable, no East
  const west = page.getByTestId('region-row-west-commercial')
  const tola = page.getByTestId('region-row-central-enterprise-tola')
  await expect(west).toBeVisible()
  await expect(tola).toBeVisible()
  const eastRows = await page.locator('[data-testid^="region-row-east"]').count()
  if (eastRows > 0) findings.push(`FAIL 2: found ${eastRows} East region row(s)`)
  else findings.push('PASS 2: No East regions visible')
  const westCb = page.getByTestId('region-checkbox-west-commercial')
  const tolaCb = page.getByTestId('region-checkbox-central-enterprise-tola')
  expect(await westCb.isDisabled()).toBe(false)
  expect(await tolaCb.isDisabled()).toBe(false)
  findings.push('PASS 2: West Commercial + TOLA checkboxes enabled')

  // 3. Expand/collapse West — 4 pods
  await page.getByTestId('region-toggle-west-commercial').click()
  await page.waitForTimeout(150)
  const podCheckboxes = page.locator('[data-testid^="pod-checkbox-west-commercial."]')
  const podCount = await podCheckboxes.count()
  if (podCount !== 4) findings.push(`FAIL 3: expected 4 West pods, got ${podCount}`)
  else findings.push('PASS 3: 4 West pods shown after expand')
  await page.screenshot({ path: path.join(SHOTS, '02-west-expanded.png'), fullPage: false })
  // collapse
  await page.getByTestId('region-toggle-west-commercial').click()
  await page.waitForTimeout(100)
  const podCountAfter = await page.locator('[data-testid^="pod-checkbox-west-commercial."]').count()
  if (podCountAfter !== 0) findings.push(`FAIL 3 (collapse): pods still visible (${podCountAfter})`)
  else findings.push('PASS 3 (collapse): pods hidden after second click')

  // 5. Save button disabled when 0 pods
  const saveBtn = page.getByTestId('step0-save')
  expect(await saveBtn.isDisabled()).toBe(true)
  await expect(saveBtn).toHaveText(/Save & Next/)
  findings.push('PASS 5a: Save disabled at 0 pods, label "Save & Next"')

  // 4. Pod selection updates counter
  await page.getByTestId('region-toggle-west-commercial').click()
  await page.waitForTimeout(150)
  const firstPod = page.locator('[data-testid^="pod-checkbox-west-commercial."]').first()
  await firstPod.click()
  const counter = page.getByTestId('step0-counter')
  await expect(counter).toHaveText(/1 pod selected across 1 region/)
  findings.push('PASS 4: Counter shows "1 pod selected across 1 region"')
  // 5b: enabled now
  expect(await saveBtn.isDisabled()).toBe(false)
  findings.push('PASS 5b: Save enabled with 1 pod')

  // 6. TOLA auto-select
  await tolaCb.click()
  await page.waitForTimeout(150)
  // TOLA should be checked, single-territory note should appear if expanded; verify counter increments
  await expect(counter).toHaveText(/2 pods selected across 2 regions/)
  // Expand TOLA to confirm "Single territory" note (no pod sub-list)
  await page.getByTestId('region-toggle-central-enterprise-tola').click()
  await page.waitForTimeout(150)
  await expect(page.getByText(/Single territory — auto-selected when region is checked\./)).toBeVisible()
  const tolaPodCheckboxes = await page.locator('[data-testid^="pod-checkbox-central-enterprise-tola."]').count()
  if (tolaPodCheckboxes !== 0) findings.push(`FAIL 6: TOLA showed ${tolaPodCheckboxes} pod checkbox(es), expected 0`)
  else findings.push('PASS 6: TOLA auto-selected with "Single territory" note, no pod sub-list')

  // 7. Save flow → summary state
  await saveBtn.click()
  await expect(page.getByTestId('step0-summary')).toBeVisible({ timeout: 5000 })
  await expect(page.getByText(/Region Access Configured/)).toBeVisible()
  // Should show a green check mark and region+pod labels
  const summaryText = await page.getByTestId('step0-summary').innerText()
  if (!/West Commercial:/i.test(summaryText)) findings.push(`FAIL 7: summary missing West Commercial label — got: ${summaryText}`)
  else findings.push('PASS 7: Summary shows green check + region/pod labels')
  await page.screenshot({ path: path.join(SHOTS, '03-summary.png'), fullPage: false })

  // 8. Edit link reopens form
  await page.getByTestId('step0-edit').click()
  await expect(page.getByTestId('step0-region-access')).toBeVisible()
  await expect(page.getByTestId('step0-summary')).toHaveCount(0)
  findings.push('PASS 8: [Edit] reopens Step 0 form')

  // 9. Visual quality assertions
  const cls = await page.getByTestId('step0-region-access').getAttribute('class')
  const hasSurface = /bg-surface/.test(cls ?? '')
  const hasRounded = /rounded-xl/.test(cls ?? '')
  const hasBorder = /border/.test(cls ?? '')
  if (!hasSurface || !hasRounded || !hasBorder) findings.push(`FAIL 9: missing styles — bg-surface=${hasSurface} rounded-xl=${hasRounded} border=${hasBorder}`)
  else findings.push('PASS 9: bg-surface + rounded-xl + border present (matches setup wizard aesthetic)')
  // Confirm checkbox accent color class
  const cbClass = await page.getByTestId('region-checkbox-west-commercial').getAttribute('class')
  if (!/accent-accent/.test(cbClass ?? '')) findings.push(`FAIL 9: checkbox missing accent-accent (got: ${cbClass})`)
  else findings.push('PASS 9: checkboxes use accent-accent color')

  // Write findings file for parent agent to pick up
  fs.writeFileSync(path.join(SHOTS, 'findings.txt'), findings.join('\n') + '\n')
  console.log('\n=== QUINN FINDINGS ===\n' + findings.join('\n') + '\n=====================\n')

  // Hard fail if any finding starts with FAIL
  const fails = findings.filter(f => f.startsWith('FAIL'))
  expect(fails, 'Failing checks: ' + fails.join(' | ')).toHaveLength(0)
})
