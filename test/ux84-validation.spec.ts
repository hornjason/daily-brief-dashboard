import { test } from './fixtures'
import { expect } from '@playwright/test'

// Quinn QA validation for BKL-UX84: Parent Drive Folder field safety fix.
// Runs against production (7777) read-only — no writes, no bootstrap triggers.
// Excluded from CI by the `quinn-*.spec.ts` ignore pattern in playwright.config.ts.

const SETUP_URL = '/dashboard/setup'
const VALID_DRIVE_URL = 'https://drive.google.com/drive/folders/14I0UH1CiSNNOqVHdZVS7tHOPibJMN5Oo'
const SCREENSHOT_DIR = 'test-results/quinn-ux84'

test('BKL-UX84 — Parent Drive Folder safety fix', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  // 1. Load the Setup page
  await page.goto(SETUP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-setup-initial-load.png`, fullPage: true })

  // 2a. Setup page is an accordion — expand Step 4 (AEs & Customers) first.
  const step4 = page.getByRole('button', { name: /step 4 of 5.*aes.*customers/i })
  await expect(step4).toBeVisible({ timeout: 10_000 })
  await step4.click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02a-step4-expanded.png`, fullPage: true })

  // 2b. Click into the Full POD tab inside Step 4.
  const fullPodTab = page.getByRole('button', { name: /full pod/i })
  if (await fullPodTab.count()) {
    await fullPodTab.first().click()
    await page.waitForTimeout(300)
  }

  // 2c. Select a POD so the other Bootstrap POD prereqs (sfReportId,
  //     territorySheetId, selectedPod) are satisfied — this lets us observe
  //     the full enable→disable cycle on podFolderValidated alone.
  const podSelect = page.getByTestId('pod-select')
  if (await podSelect.count()) {
    await podSelect.selectOption({ index: 1 }).catch(() => {})
    await page.waitForTimeout(400)
  }
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-full-pod-tab.png`, fullPage: true })

  // Locate the Parent Drive Folder input + Validate button + Bootstrap button.
  const parentFolderBlock = page.getByTestId('parent-drive-folder-block')
  const parentFolderInput = page.getByTestId('parent-folder-input')
  const validateButton = page.getByTestId('parent-folder-validate')
  const bootstrapButton = page.getByRole('button', { name: /^bootstrap pod|starting/i })

  await expect(parentFolderBlock).toBeVisible({ timeout: 10_000 })
  await expect(parentFolderInput).toBeVisible()

  // Scroll parent folder block into view for screenshots.
  await parentFolderBlock.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-parent-folder-block-on-load.png`, fullPage: true })

  // 3. VERIFY: Parent Drive Folder input is EMPTY on load.
  const initialValue = await parentFolderInput.inputValue()
  console.log(`[quinn-ux84] Initial Parent Drive Folder value: "${initialValue}"`)
  expect(initialValue, 'Parent Drive Folder should be empty on initial load (BKL-UX84)').toBe('')

  // 4. VERIFY: Bootstrap POD button is disabled when folder field is empty.
  //    We need selectedPod + sfReportId + territorySheetId + podFolderValidated
  //    all true for the button to enable. An empty folder field is sufficient
  //    to keep it disabled regardless of the other prereqs.
  await bootstrapButton.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-bootstrap-button-empty-state.png`, fullPage: true })
  await expect(bootstrapButton, 'Bootstrap POD should be disabled when folder empty').toBeDisabled()

  // 5. Type an invalid (non-URL) value into the folder field.
  await parentFolderInput.scrollIntoViewIfNeeded()
  await parentFolderInput.fill('hello')
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/05-invalid-input-hello.png`, fullPage: true })

  // 6. VERIFY: Bootstrap POD remains disabled with invalid/unvalidated input.
  await expect(
    bootstrapButton,
    'Bootstrap POD should remain disabled after typing invalid text (no validate)',
  ).toBeDisabled()

  // 7. Paste the valid Drive URL and click Validate. Note: we do NOT actually
  //    hit the server here — we intercept /api/aes/validate-folder with a
  //    stubbed success response so production state is never touched.
  await page.route('**/api/aes/validate-folder', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        folderId: '14I0UH1CiSNNOqVHdZVS7tHOPibJMN5Oo',
        folderName: 'QA Test Folder (stubbed)',
      }),
    })
  })

  await parentFolderInput.fill(VALID_DRIVE_URL)
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/06-valid-url-pasted.png`, fullPage: true })

  // Bootstrap still disabled BEFORE clicking Validate (folder not yet validated).
  await expect(
    bootstrapButton,
    'Bootstrap POD should still be disabled before Validate click (session-fresh validation required)',
  ).toBeDisabled()

  // 8. Click Validate.
  await validateButton.click()

  // Wait for either success pill or error pill to appear.
  const successPill = page.getByTestId('parent-folder-success')
  await expect(successPill).toBeVisible({ timeout: 10_000 })
  await page.screenshot({ path: `${SCREENSHOT_DIR}/07-validated-success.png`, fullPage: true })

  // 9. VERIFY: After successful validate, Bootstrap POD button is enabled.
  //    Wait up to 3s for the button to become enabled after the save POST resolves
  //    and the parent component's state updates (podFolderValidated=true).
  //    All other prereqs (pod, sf report, territory sheet) should already be
  //    satisfied from settings.json on this production server.
  await expect(
    bootstrapButton,
    'Bootstrap POD should become enabled after successful validate (all prereqs satisfied from settings.json)',
  ).toBeEnabled({ timeout: 3000 })
  const bootstrapDisabledAfterValidate = await bootstrapButton.isDisabled()
  console.log(`[quinn-ux84] Bootstrap POD disabled after validate: ${bootstrapDisabledAfterValidate}`)

  // 10. Clear / change the folder URL.
  await parentFolderInput.fill('')
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/08-folder-cleared.png`, fullPage: true })

  // 11. VERIFY: Bootstrap POD is disabled again after clearing the field.
  //     NOTE: captured as a soft observation rather than a blocking failure so
  //     the rest of the report still produces evidence. This is the BKL-UX84
  //     gap suspicion: child resets folderResolvedId but never notifies parent,
  //     so the parent's podFolderValidated flag persists.
  const bootstrapDisabledAfterClear = await bootstrapButton.isDisabled()
  const inputValueAfterClear = await parentFolderInput.inputValue()
  console.log(`[quinn-ux84] After clearing folder input: value="${inputValueAfterClear}" buttonDisabled=${bootstrapDisabledAfterClear}`)

  // Also try typing garbage after clear to confirm same behavior.
  await parentFolderInput.fill('not-a-url-xyz')
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/09-folder-garbage-after-validate.png`, fullPage: true })
  const bootstrapDisabledAfterGarbage = await bootstrapButton.isDisabled()
  console.log(`[quinn-ux84] After typing garbage post-validate: buttonDisabled=${bootstrapDisabledAfterGarbage}`)

  // Soft assertion — we EXPECT the button to re-disable when the field is
  // cleared/changed. If it stays enabled, that's a BKL-UX84 gap.
  expect.soft(
    bootstrapDisabledAfterClear,
    'BKL-UX84 GAP: Bootstrap POD should re-disable after clearing the folder field (parent podFolderValidated flag persists after child reset)',
  ).toBe(true)
  expect.soft(
    bootstrapDisabledAfterGarbage,
    'BKL-UX84 GAP: Bootstrap POD should re-disable after typing invalid text post-validate',
  ).toBe(true)

  // Final report
  console.log(`[quinn-ux84] Console errors captured: ${consoleErrors.length}`)
  for (const err of consoleErrors) console.log(`[quinn-ux84][console.error] ${err}`)
})
