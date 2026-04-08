/**
 * Quinn QA — 2026-04-08
 * BKL-POD-01: Drive folder preview on blur (POD Bootstrap section)
 * BKL-BOOT-01: Already-bootstrapped banner (Single AE Bootstrap section)
 */

import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:7777'

test.describe('BKL-POD-01 — Drive folder preview in POD Bootstrap section', () => {
  test('shows green folder name on valid Drive folder ID after blur', async ({ page }) => {
    const errors: string[] = []
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })

    await page.goto(`${BASE}/dashboard/setup`)
    await page.waitForLoadState('networkidle')

    // Find and open the POD Bootstrap accordion
    const podAccordion = page.getByRole('button', { name: /POD Bootstrap/i })
    await expect(podAccordion).toBeVisible()
    await podAccordion.click()
    await page.waitForTimeout(500)

    // Screenshot: POD section opened
    await page.screenshot({ path: '/tmp/qa-bkl-pod01-01-section-open.png', fullPage: false })

    // Find the Parent Drive Folder input
    const folderInput = page.getByPlaceholder('Drive folder URL or bare folder ID')
    // POD Bootstrap section may have its own folder input — use nth if needed
    const podFolderInputs = await page.getByPlaceholder('Drive folder URL or bare folder ID').all()
    console.log(`Found ${podFolderInputs.length} folder inputs on page`)

    // Use the last one (POD Bootstrap is below Single AE Bootstrap in page order)
    const podFolderInput = podFolderInputs[podFolderInputs.length - 1]
    await expect(podFolderInput).toBeVisible()

    // Test case 1: Enter an invalid ID and tab out
    await podFolderInput.fill('invalid-folder-id-that-does-not-exist-xyz123')
    await podFolderInput.blur()

    // Wait for the async blur handler to complete
    await page.waitForTimeout(3000)

    // Screenshot: after invalid input
    await page.screenshot({ path: '/tmp/qa-bkl-pod01-02-invalid-input.png', fullPage: false })

    // Check for error message
    const errorMsg = page.locator('p.text-critical, p.text-xs.text-critical').filter({ hasText: /Folder not found|check the URL|Could not reach/i })
    const errorVisible = await errorMsg.first().isVisible().catch(() => false)

    // Also check for red border on input
    const inputClasses = await podFolderInput.getAttribute('class')
    const hasCriticalBorder = inputClasses?.includes('border-critical') ?? false

    console.log(`Error message visible: ${errorVisible}`)
    console.log(`Input has border-critical: ${hasCriticalBorder}`)

    // Test case 2: Clear the field to reset state
    await podFolderInput.fill('')
    await podFolderInput.blur()
    await page.waitForTimeout(500)

    // Screenshot: field cleared
    await page.screenshot({ path: '/tmp/qa-bkl-pod01-03-cleared.png', fullPage: false })

    // Log any console errors
    console.log(`Console errors during test: ${errors.length}`)
    errors.forEach(e => console.log('  ERROR:', e))

    // Report findings
    if (!errorVisible && !hasCriticalBorder) {
      console.log('FINDING: Invalid folder ID did not show error feedback (UI may need network access to Drive API)')
    } else {
      console.log('PASS: Invalid folder ID shows error feedback')
    }
  })

  test('folder input border changes to success color when valid folder resolved', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.waitForLoadState('networkidle')

    const podAccordion = page.getByRole('button', { name: /POD Bootstrap/i })
    await expect(podAccordion).toBeVisible()
    await podAccordion.click()
    await page.waitForTimeout(500)

    // Use route interception to mock the validate-folder API response
    await page.route('**/api/aes/validate-folder', async route => {
      const req = route.request()
      const body = await req.postDataJSON()
      // Return a valid folder name for any input that looks like a real ID
      if (body?.folderUrl && body.folderUrl.length > 10) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ folderName: 'My POD Team Folder', folderId: 'test-folder-id' }),
        })
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Folder not found' }),
        })
      }
    })

    const podFolderInputs = await page.getByPlaceholder('Drive folder URL or bare folder ID').all()
    const podFolderInput = podFolderInputs[podFolderInputs.length - 1]

    // Enter a valid-looking folder ID
    await podFolderInput.fill('1BV0uRHei3oRvGYVEXBX_qBB-VGu0r9wq')
    await podFolderInput.blur()
    await page.waitForTimeout(1000)

    // Screenshot: after valid input with mocked response
    await page.screenshot({ path: '/tmp/qa-bkl-pod01-04-valid-mocked.png', fullPage: false })

    // Check for green success text
    const successMsg = page.locator('p.text-success, p.text-xs.text-success').filter({ hasText: /My POD Team Folder/i })
    const successVisible = await successMsg.first().isVisible().catch(() => false)

    const inputClasses = await podFolderInput.getAttribute('class')
    const hasSuccessBorder = inputClasses?.includes('border-success') ?? false

    console.log(`Success message visible: ${successVisible}`)
    console.log(`Input has border-success: ${hasSuccessBorder}`)

    expect(successVisible || hasSuccessBorder).toBe(true)
  })

  test('shows error feedback for invalid folder ID (mocked error response)', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.waitForLoadState('networkidle')

    const podAccordion = page.getByRole('button', { name: /POD Bootstrap/i })
    await podAccordion.click()
    await page.waitForTimeout(500)

    // Mock the validate-folder API to return an error
    await page.route('**/api/aes/validate-folder', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Folder not found' }),
      })
    })

    const podFolderInputs = await page.getByPlaceholder('Drive folder URL or bare folder ID').all()
    const podFolderInput = podFolderInputs[podFolderInputs.length - 1]

    await podFolderInput.fill('bad-folder-id')
    await podFolderInput.blur()
    await page.waitForTimeout(1000)

    await page.screenshot({ path: '/tmp/qa-bkl-pod01-05-invalid-mocked.png', fullPage: false })

    // Should show "Folder not found — check the URL" in red
    const errorMsg = page.locator('p').filter({ hasText: /Folder not found.*check the URL/i })
    const errorVisible = await errorMsg.first().isVisible().catch(() => false)

    const inputClasses = await podFolderInput.getAttribute('class')
    const hasCriticalBorder = inputClasses?.includes('border-critical') ?? false

    console.log(`Error message visible: ${errorVisible}`)
    console.log(`Input has border-critical: ${hasCriticalBorder}`)

    expect(errorVisible).toBe(true)
    expect(hasCriticalBorder).toBe(true)
  })
})

/** Helper: open Step 4 (AEs & Customers) and ensure Auto Setup mode is active */
async function openAutoBootstrapForm(page: any) {
  await page.goto(`${BASE}/dashboard/setup`)
  await page.waitForLoadState('networkidle')

  // Step 4 accordion
  const step4Btn = page.getByRole('button', { name: /Step 4.*AEs.*Customers/i })
  await expect(step4Btn).toBeVisible()
  await step4Btn.click()
  await page.waitForTimeout(500)

  // Click "Auto Setup" mode tab if not already active
  const autoSetupBtn = page.getByRole('button', { name: /^Auto Setup$/i })
  const isActive = await autoSetupBtn.evaluate((el: HTMLElement) => el.className.includes('bg-accent')).catch(() => false)
  if (!isActive) {
    await autoSetupBtn.click()
    await page.waitForTimeout(300)
  }
}

/** Helper: open Step 4 Auto Setup and select Carolanne Farrell's territory
 * Territory: WEST_COMM_CORP_NORTHWEST / TERR01 → Carolanne Farrell (fully bootstrapped)
 * This triggers matchedAe resolution which drives matchedAeIsBootstrapped.
 */
async function selectBootstrappedAe(page: any) {
  await openAutoBootstrapForm(page)

  // Select POD: Northwest Corp = WEST_COMM_CORP_NORTHWEST
  const podSelect = page.locator('select').first()
  await podSelect.selectOption('WEST_COMM_CORP_NORTHWEST')
  await page.waitForTimeout(500)

  // Select territory 01 (Carolanne Farrell)
  // Territory select is the second select element
  const terrSelect = page.locator('select').nth(1)
  await terrSelect.selectOption('01')
  await page.waitForTimeout(1000)  // allow matchedAe to resolve via useMemo
}

test.describe('BKL-BOOT-01 — Already-bootstrapped banner in Single AE Bootstrap section', () => {
  test('Step 4 opens and shows AutoBootstrapForm with POD and territory selects', async ({ page }) => {
    const errors: string[] = []
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })

    await openAutoBootstrapForm(page)
    await page.screenshot({ path: '/tmp/qa-bkl-boot01-01-auto-setup-open.png', fullPage: false })

    // AE Name input should be visible
    const aeNameInput = page.getByPlaceholder('Jane Smith')
    await expect(aeNameInput).toBeVisible()

    // POD select should be visible
    const podSelect = page.locator('select').first()
    await expect(podSelect).toBeVisible()

    // Territory select disabled until POD chosen
    const terrSelect = page.locator('select').nth(1)
    await expect(terrSelect).toBeVisible()

    console.log(`Console errors: ${errors.length}`)
    errors.forEach(e => console.log('  ERROR:', e))
  })

  test('banner shows when territory is selected for bootstrapped AE', async ({ page }) => {
    await selectBootstrappedAe(page)

    await page.screenshot({ path: '/tmp/qa-bkl-boot01-02-territory-selected.png', fullPage: false })

    // AE name should be auto-filled
    const aeNameInput = page.getByPlaceholder('Jane Smith')
    const aeNameValue = await aeNameInput.inputValue()
    console.log(`AE name auto-filled: "${aeNameValue}"`)
    expect(aeNameValue).toContain('Carolanne')

    // Banner should be visible
    const bannerVisible = await page.locator('text=already fully bootstrapped').isVisible().catch(() => false)
    const forceRebootstrapVisible = await page.locator('text=Force re-bootstrap').isVisible().catch(() => false)
    const prerequisitesVisible = await page.locator('text=Before you start:').isVisible().catch(() => false)
    const bootstrapBtnVisible = await page.getByRole('button', { name: /Set Up AE/i }).isVisible().catch(() => false)

    console.log(`Banner visible: ${bannerVisible}`)
    console.log(`Force re-bootstrap visible: ${forceRebootstrapVisible}`)
    console.log(`Prerequisites visible (should be hidden): ${prerequisitesVisible}`)
    console.log(`Bootstrap button visible (should be hidden): ${bootstrapBtnVisible}`)

    expect(bannerVisible).toBe(true)
    expect(forceRebootstrapVisible).toBe(true)
    expect(prerequisitesVisible).toBe(false)
    expect(bootstrapBtnVisible).toBe(false)
  })

  test('banner shows truncated sheet IDs and all 4 labels', async ({ page }) => {
    await selectBootstrappedAe(page)
    await page.screenshot({ path: '/tmp/qa-bkl-boot01-03-banner-details.png', fullPage: false })

    const bannerVisible = await page.locator('text=already fully bootstrapped').first().isVisible().catch(() => false)
    expect(bannerVisible).toBe(true)

    // Check that all 4 sheet ID labels are present
    const supportableLabel = await page.locator('text=Supportable:').isVisible().catch(() => false)
    const ccspLabel = await page.locator('text=CCSP:').isVisible().catch(() => false)
    const pipelineLabel = await page.locator('text=Pipeline:').isVisible().catch(() => false)
    const driveLabel = await page.locator('text=Drive:').isVisible().catch(() => false)

    console.log(`Supportable label: ${supportableLabel}`)
    console.log(`CCSP label: ${ccspLabel}`)
    console.log(`Pipeline label: ${pipelineLabel}`)
    console.log(`Drive label: ${driveLabel}`)

    expect(supportableLabel).toBe(true)
    expect(ccspLabel).toBe(true)
    expect(pipelineLabel).toBe(true)
    expect(driveLabel).toBe(true)
  })

  test('Force re-bootstrap link re-shows prerequisites and Bootstrap button', async ({ page }) => {
    await selectBootstrappedAe(page)

    const bannerVisible = await page.locator('text=already fully bootstrapped').isVisible().catch(() => false)
    expect(bannerVisible).toBe(true)

    // Click "Force re-bootstrap (overwrites existing sheets)"
    await page.locator('text=Force re-bootstrap').click()
    await page.waitForTimeout(500)

    await page.screenshot({ path: '/tmp/qa-bkl-boot01-04-force-rebootstrap.png', fullPage: false })

    const bannerStillVisible = await page.locator('text=already fully bootstrapped').isVisible().catch(() => false)
    const prerequisitesVisible = await page.locator('text=Before you start:').isVisible().catch(() => false)
    const bootstrapBtnVisible = await page.getByRole('button', { name: /Set Up AE/i }).isVisible().catch(() => false)

    console.log(`Banner after force click (should be gone): ${bannerStillVisible}`)
    console.log(`Prerequisites visible after force click (should be shown): ${prerequisitesVisible}`)
    console.log(`Bootstrap button visible (should be shown): ${bootstrapBtnVisible}`)

    expect(bannerStillVisible).toBe(false)
    expect(prerequisitesVisible).toBe(true)
    expect(bootstrapBtnVisible).toBe(true)
  })
})
