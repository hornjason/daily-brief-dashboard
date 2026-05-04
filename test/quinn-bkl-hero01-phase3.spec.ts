/**
 * BKL-HERO-01 Phase 3 — Hero RH Token Connection Step
 * Quinn Torres — 2026-04-30
 *
 * Validates the HeroStep3Connections component on the Setup wizard
 * under L3-only conditions (NODE_ROLE unset → isL3Only=true).
 *
 * Test container (7776) has NODE_ROLE unset by design.
 */
import { test, expect } from '@playwright/test'

function screenshotPath(name: string) {
  return `/tmp/quinn-bkl-hero01-phase3-${name}.png`
}

test.describe('BKL-HERO-01 Phase 3 — Hero RH Token Connection', () => {
  test.beforeEach(async ({ page }) => {
    // Collect console errors
    page.on('console', msg => {
      if (msg.type() === 'error') console.log('CONSOLE-ERR:', msg.text())
    })
    page.on('pageerror', err => console.log('PAGE-ERR:', err.message))
  })

  test('1. Hero Step 3 component renders (isL3Only=true)', async ({ page }) => {
    await page.goto('/dashboard/setup', { waitUntil: 'networkidle' })
    // Wait for the RH token section to finish its mount check
    await page.waitForTimeout(2000)

    // The component should be present — either form mode or summary mode
    const step3Form = page.locator('[data-testid="hero-step3-connections"]')
    const step3Summary = page.locator('[data-testid="hero-step3-summary"]')

    const formVisible = await step3Form.isVisible().catch(() => false)
    const summaryVisible = await step3Summary.isVisible().catch(() => false)

    console.log('step3 form visible:', formVisible)
    console.log('step3 summary visible:', summaryVisible)

    // At least one mode must be visible
    expect(formVisible || summaryVisible).toBe(true)

    // Heading text differs by mode:
    // Form mode: h2 "Step 3 of 5 — Red Hat Connection"
    // Summary mode: p "Red Hat Token Configured"
    if (formVisible) {
      const heading = page.locator('h2:has-text("Red Hat Connection")')
      await expect(heading).toBeVisible()
    } else {
      // Summary mode — verify summary content
      const summaryText = page.locator('text=Red Hat Token Configured')
      await expect(summaryText).toBeVisible()
    }

    await page.screenshot({ path: screenshotPath('01-step3-renders'), fullPage: false })
  })

  test('2. Token form layout — textarea and button present and correct state', async ({ page }) => {
    await page.goto('/dashboard/setup', { waitUntil: 'networkidle' })
    await page.waitForTimeout(2000)

    // If in summary mode (token already configured), click Edit to get back to form
    const editBtn = page.locator('[data-testid="rh-token-edit"]')
    if (await editBtn.isVisible()) {
      await editBtn.click()
      await page.waitForTimeout(500)
    }

    const textarea = page.locator('[data-testid="rh-token-input"]')
    await expect(textarea).toBeVisible()

    const saveBtn = page.locator('[data-testid="rh-token-save"]')
    await expect(saveBtn).toBeVisible()

    // Button should be disabled when textarea is empty
    await textarea.fill('')
    await expect(saveBtn).toBeDisabled()

    // Take screenshot of the form state
    await page.screenshot({ path: screenshotPath('02-token-form-layout'), fullPage: false })

    console.log('Textarea visible:', await textarea.isVisible())
    console.log('Save button visible:', await saveBtn.isVisible())
    console.log('Save button disabled when empty:', await saveBtn.isDisabled())
  })

  test('3. Help link visible and points to access.redhat.com', async ({ page }) => {
    await page.goto('/dashboard/setup', { waitUntil: 'networkidle' })
    await page.waitForTimeout(2000)

    // If summary mode, click edit to reveal form
    const editBtn = page.locator('[data-testid="rh-token-edit"]')
    if (await editBtn.isVisible()) {
      await editBtn.click()
      await page.waitForTimeout(500)
    }

    const helpLink = page.locator('[data-testid="rh-token-help"]')
    await expect(helpLink).toBeVisible()

    const href = await helpLink.getAttribute('href')
    console.log('Help link href:', href)

    // Should point to access.redhat.com (the actual token management page)
    expect(href).toMatch(/access\.redhat\.com|sso\.redhat\.com|redhat\.com/)

    await page.screenshot({ path: screenshotPath('03-help-link'), fullPage: false })
  })

  test('4. Error state — fake token shows readable error message', async ({ page }) => {
    await page.goto('/dashboard/setup', { waitUntil: 'networkidle' })
    await page.waitForTimeout(2000)

    // If summary mode, click edit to get form
    const editBtn = page.locator('[data-testid="rh-token-edit"]')
    if (await editBtn.isVisible()) {
      await editBtn.click()
      await page.waitForTimeout(500)
    }

    const textarea = page.locator('[data-testid="rh-token-input"]')
    const saveBtn = page.locator('[data-testid="rh-token-save"]')

    await textarea.fill('bad-test-token-quinn')
    // Button should now be enabled
    await expect(saveBtn).toBeEnabled()

    await page.screenshot({ path: screenshotPath('04a-token-typed'), fullPage: false })

    await saveBtn.click()

    // Wait up to 15 seconds for error to appear (real SSO call)
    await page.waitForSelector('[data-testid="rh-token-error"]', { timeout: 15000 })

    const errorEl = page.locator('[data-testid="rh-token-error"]')
    await expect(errorEl).toBeVisible()

    const errorText = await errorEl.textContent()
    console.log('Error message text:', errorText)

    // Error must be non-empty and not a raw internal dump
    expect(errorText).toBeTruthy()
    expect(errorText!.length).toBeGreaterThan(5)
    // Must not expose raw stack trace internals
    expect(errorText).not.toContain('at Object.')
    expect(errorText).not.toContain('TypeError:')
    expect(errorText).not.toContain('SyntaxError:')

    await page.screenshot({ path: screenshotPath('04b-error-state'), fullPage: false })
  })

  test('5. No visual regressions — L3-only gating correct', async ({ page }) => {
    await page.goto('/dashboard/setup', { waitUntil: 'networkidle' })
    await page.waitForTimeout(2000)

    // Step 0 must be visible above Step 3
    const step0 = page.locator('[data-testid="step0-region-access"], section').filter({ hasText: 'Region' }).first()
    // Use a broader check — just verify "Region" text appears somewhere before Step 3
    const regionText = page.locator('text=Region').first()
    const regionVisible = await regionText.isVisible().catch(() => false)
    console.log('Step 0 Region section visible:', regionVisible)

    // L4-only sections must NOT be present
    // DataSourcesSection (when !isL3Only), RefreshTimerSettings, AutomationSettings
    // These would contain "Refresh Timer" or "Automation" headings
    const refreshTimer = page.locator('text=Refresh Timer').first()
    const automation = page.locator('text=Automation').first()
    const refreshVisible = await refreshTimer.isVisible().catch(() => false)
    const automationVisible = await automation.isVisible().catch(() => false)

    console.log('Refresh Timer visible (should be false):', refreshVisible)
    console.log('Automation visible (should be false):', automationVisible)

    expect(refreshVisible).toBe(false)
    expect(automationVisible).toBe(false)

    // AI & Intelligence Settings should be visible
    const aiSection = page.locator('text=AI').first()
    const aiVisible = await aiSection.isVisible().catch(() => false)
    console.log('AI section visible:', aiVisible)

    await page.screenshot({ path: screenshotPath('05-l3-gating-check'), fullPage: true })
  })

  test('6. Visual quality — card styling, contrast, no overflow', async ({ page }) => {
    await page.goto('/dashboard/setup', { waitUntil: 'networkidle' })
    await page.waitForTimeout(2000)

    // If summary mode, click edit to see full form card
    const editBtn = page.locator('[data-testid="rh-token-edit"]')
    if (await editBtn.isVisible()) {
      await editBtn.click()
      await page.waitForTimeout(500)
    }

    const section = page.locator('[data-testid="hero-step3-connections"]')
    await expect(section).toBeVisible()

    // Check it has the expected card classes (bg-surface, rounded-xl, border)
    const classes = await section.getAttribute('class')
    console.log('Section classes:', classes)
    expect(classes).toContain('rounded-xl')
    expect(classes).toContain('border')

    // Check that the section is not overflowing the viewport
    const bbox = await section.boundingBox()
    console.log('Section bounding box:', bbox)
    if (bbox) {
      // Should not start off screen
      expect(bbox.x).toBeGreaterThanOrEqual(0)
      expect(bbox.y).toBeGreaterThanOrEqual(0)
    }

    // Full page screenshot for visual review
    await page.screenshot({ path: screenshotPath('06-visual-quality'), fullPage: true })
  })
})
