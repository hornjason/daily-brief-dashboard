import { test, expect } from '../fixtures'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'

const UPDATE_RESPONSE = {
  updateAvailable: true,
  currentVersion: '1.7.2',
  latestVersion: 'v1.7.3',
  releaseUrl: 'https://github.com/hornjason/daily-brief-dashboard/releases/tag/v1.7.3',
}

test.describe('UpdateBanner — inline upgrade instructions', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/updates/check', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(UPDATE_RESPONSE) })
    )
    // Clear any prior dismissal
    await page.goto(BASE)
    await page.evaluate(() => localStorage.removeItem('update-banner-dismissed'))
    await page.reload()
  })

  test('banner shows version text and Upgrade button', async ({ page }) => {
    const banner = page.locator('[data-testid="update-banner"]')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('1.7.2')
    await expect(banner).toContainText('v1.7.3')
    await expect(page.locator('[data-testid="upgrade-toggle"]')).toBeVisible()
  })

  test('clicking Upgrade expands to show command with version', async ({ page }) => {
    const toggle = page.locator('[data-testid="upgrade-toggle"]')
    await expect(toggle).toContainText('Upgrade')
    await toggle.click()

    const expanded = page.locator('[data-testid="upgrade-instructions"]')
    await expect(expanded).toBeVisible()
    await expect(expanded).toContainText('--version=v1.7.3')
    await expect(expanded).toContainText('upgrade.sh')
  })

  test('data safety message visible in expanded view', async ({ page }) => {
    await page.locator('[data-testid="upgrade-toggle"]').click()
    const expanded = page.locator('[data-testid="upgrade-instructions"]')
    await expect(expanded).toContainText('Your data and settings are preserved')
  })

  test('clicking Upgrade again collapses the section', async ({ page }) => {
    const toggle = page.locator('[data-testid="upgrade-toggle"]')
    await toggle.click()
    await expect(page.locator('[data-testid="upgrade-instructions"]')).toBeVisible()
    await toggle.click()
    await expect(page.locator('[data-testid="upgrade-instructions"]')).not.toBeVisible()
  })

  test('copy button copies command to clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.locator('[data-testid="upgrade-toggle"]').click()

    const copyBtn = page.locator('[data-testid="copy-upgrade-cmd"]')
    await expect(copyBtn).toBeVisible()
    await copyBtn.click()

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText())
    expect(clipboardText).toContain('--version=v1.7.3')
    expect(clipboardText).toContain('upgrade.sh')
  })
})
