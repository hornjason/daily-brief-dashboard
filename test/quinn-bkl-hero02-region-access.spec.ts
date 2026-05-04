/**
 * BKL-HERO-02: Region Access section — Admin page validation
 * Quinn QA — 2026-04-30
 *
 * Validates that the Region Access section shipped in BKL-HERO-02 is
 * present, rendered, and free of console errors on the Admin page.
 *
 * Non-destructive: read-only navigation only. No form submissions.
 */

import { test, expect } from './fixtures'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots')

function screenshotPath(name: string): string {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
  }
  return path.join(SCREENSHOT_DIR, name)
}

test.describe('BKL-HERO-02 — Region Access section (Admin page)', () => {
  test.describe.configure({ mode: 'serial' })

  test('admin page loads without JS errors', async ({ page }) => {
    const consoleErrors: string[] = []

    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      const text = msg.text()
      // Suppress known background noise
      if (text.includes('/api/briefs/pregen')) return
      consoleErrors.push(text)
    })

    page.on('pageerror', (err) => {
      const message = err.message ?? String(err)
      if (message.includes('/api/briefs/pregen')) return
      consoleErrors.push(`pageerror: ${message}`)
    })

    await page.goto(`${BASE}/dashboard/admin`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })

    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
      // Background pollers may keep network busy — acceptable for this check
    })

    await page.screenshot({
      path: screenshotPath('quinn-bkl-hero02-admin-fullpage.png'),
      fullPage: true,
    })

    expect(
      consoleErrors,
      `Unexpected console errors: ${consoleErrors.join(' | ')}`,
    ).toHaveLength(0)
  })

  test('Region Access section heading is visible', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/admin`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })

    // Wait for SPA to render
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})

    // Look for "Region Access" heading text — case-insensitive via regex
    const heading = page.getByText(/region access/i)
    await expect(heading.first()).toBeVisible({ timeout: 10_000 })
  })

  test('data-testid="admin-region-access" exists in DOM', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/admin`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })

    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})

    const regionSection = page.locator('[data-testid="admin-region-access"]')
    await expect(regionSection).toBeAttached({ timeout: 10_000 })
  })

  test('Step0RegionAccess renders inside admin-region-access — summary or form mode', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/admin`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })

    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})

    const regionSection = page.locator('[data-testid="admin-region-access"]')
    await expect(regionSection).toBeAttached({ timeout: 10_000 })

    // In summary mode: Edit button is present
    // In form mode: region checkboxes are present
    const editButton = regionSection.getByRole('button', { name: /edit/i })
    const checkboxes = regionSection.locator('input[type="checkbox"]')

    const editCount = await editButton.count()
    const checkboxCount = await checkboxes.count()

    const hasSummaryMode = editCount > 0
    const hasFormMode = checkboxCount > 0

    expect(
      hasSummaryMode || hasFormMode,
      `Step0RegionAccess must render in summary mode (Edit button) or form mode (checkboxes). ` +
      `Found: editButtons=${editCount}, checkboxes=${checkboxCount}`,
    ).toBe(true)

    // Screenshot of just the region section
    await regionSection.screenshot({
      path: screenshotPath('quinn-bkl-hero02-region-access-section.png'),
    })

    // Log which mode we found
    if (hasSummaryMode) {
      console.log('Region Access: SUMMARY mode (Edit button visible)')
    } else {
      console.log(`Region Access: FORM mode (${checkboxCount} checkboxes visible)`)
    }
  })
})
