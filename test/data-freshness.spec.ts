import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

// ── Test #271: Admin Data Freshness Dashboard ────────────────────────────────

test.describe('Data Freshness Dashboard', () => {
  test('GET /api/status/freshness returns comprehensive data source status', async ({ request }) => {
    const res = await request.get('http://localhost:7776/api/status/freshness')
    expect(res.ok()).toBeTruthy()

    const data = await res.json()

    // Should have status for all major data sources
    expect(data).toHaveProperty('sources')
    expect(Array.isArray(data.sources)).toBeTruthy()

    const sources = data.sources as Array<{
      name: string
      displayName: string
      lastChecked: string | null
      lastChanged: string | null
      recordCount: number | null
      intervalMinutes: number | null
      refreshEndpoint: string | null
      status: 'fresh' | 'stale' | 'critical' | 'unknown'
      state: 'idle' | 'refreshing' | 'queued' | 'error'
      error: string | null
    }>

    // Verify all expected sources are present
    const sourceNames = sources.map(s => s.name)
    expect(sourceNames).toContain('subscriptions')
    expect(sourceNames).toContain('pipeline')
    expect(sourceNames).toContain('ccsp')
    expect(sourceNames).toContain('rh-cases')
    expect(sourceNames).toContain('intelligence')
    expect(sourceNames).toContain('product-lifecycle')
    expect(sourceNames).toContain('product-features')

    // Each source should have required fields (GitHub Issue #309 contract)
    for (const source of sources) {
      expect(source).toHaveProperty('name')
      expect(source).toHaveProperty('displayName')
      expect(source).toHaveProperty('status')
      expect(source).toHaveProperty('state')
      expect(source).toHaveProperty('lastChecked')
      expect(source).toHaveProperty('lastChanged')
      expect(['fresh', 'stale', 'critical', 'unknown']).toContain(source.status)
      expect(['idle', 'refreshing', 'queued', 'error']).toContain(source.state)

      // If intervalMinutes is set, should have logic to determine staleness
      if (source.intervalMinutes !== null && source.lastChecked !== null) {
        const age = Date.now() - new Date(source.lastChecked).getTime()
        const ageMinutes = age / (60 * 1000)

        // Allow for state=error override to critical
        if (source.state === 'error') {
          expect(source.status).toBe('critical')
        } else if (ageMinutes < source.intervalMinutes) {
          expect(source.status).toBe('fresh')
        } else if (ageMinutes < source.intervalMinutes * 2) {
          expect(source.status).toBe('stale')
        } else {
          expect(source.status).toBe('critical')
        }
      }
    }
  })

  test('DataFreshnessDashboard renders all data sources', async ({ page }) => {
    await page.goto('http://localhost:7776/dashboard/setup')

    // Wait for the page to load
    await page.waitForLoadState('networkidle')

    // Find and click the "Data Freshness" section (accordion)
    const dataFreshnessSection = page.locator('text=Data Freshness')
    await expect(dataFreshnessSection).toBeVisible()
    await dataFreshnessSection.click()

    // Wait for content to expand
    await page.waitForTimeout(500)

    // Should show source cards
    const subscriptionsCard = page.locator('text=Subscriptions').first()
    await expect(subscriptionsCard).toBeVisible()

    const pipelineCard = page.locator('text=Pipeline').first()
    await expect(pipelineCard).toBeVisible()

    const ccspCard = page.locator('text=CCSP').first()
    await expect(ccspCard).toBeVisible()

    // Should have a "Refresh All" button
    const refreshAllBtn = page.locator('button:has-text("Refresh All")')
    await expect(refreshAllBtn).toBeVisible()
  })

  test('Individual refresh button triggers refresh', async ({ page }) => {
    await page.goto('http://localhost:7776/dashboard/setup')
    await page.waitForLoadState('networkidle')

    // Expand Data Freshness section
    const dataFreshnessSection = page.locator('text=Data Freshness')
    await dataFreshnessSection.click()
    await page.waitForTimeout(500)

    // Find a source with a refresh button (e.g., Pipeline)
    const pipelineSection = page.locator('[data-source="pipeline"]')
    const refreshButton = pipelineSection.locator('button:has-text("Refresh")')

    // Click refresh button
    await refreshButton.click()

    // Should show loading state
    await expect(refreshButton).toBeDisabled()

    // Wait for refresh to complete (should re-enable)
    await expect(refreshButton).toBeEnabled({ timeout: 10000 })
  })

  test('Refresh All button triggers all refreshes', async ({ page }) => {
    await page.goto('http://localhost:7776/dashboard/setup')
    await page.waitForLoadState('networkidle')

    // Expand Data Freshness section
    const dataFreshnessSection = page.locator('text=Data Freshness')
    await dataFreshnessSection.click()
    await page.waitForTimeout(500)

    // Click "Refresh All"
    const refreshAllBtn = page.locator('button:has-text("Refresh All")')
    await refreshAllBtn.click()

    // Should show loading state
    await expect(refreshAllBtn).toBeDisabled()

    // Wait for completion
    await expect(refreshAllBtn).toBeEnabled({ timeout: 30000 })
  })

  test('Freshness indicators show correct colors', async ({ page }) => {
    await page.goto('http://localhost:7776/dashboard/setup')
    await page.waitForLoadState('networkidle')

    // Expand Data Freshness section
    const dataFreshnessSection = page.locator('text=Data Freshness')
    await dataFreshnessSection.click()
    await page.waitForTimeout(500)

    // Check for status indicators (green/yellow/red/gray dots)
    const statusDots = page.locator('[data-testid="status-indicator"]')
    const count = await statusDots.count()

    // Should have at least one status indicator
    expect(count).toBeGreaterThan(0)

    // Each should have a color class
    for (let i = 0; i < count; i++) {
      const dot = statusDots.nth(i)
      const classes = await dot.getAttribute('class')

      // Should have one of: green/yellow/red/gray text color
      const hasColorClass =
        classes?.includes('text-green') ||
        classes?.includes('text-yellow') ||
        classes?.includes('text-red') ||
        classes?.includes('text-gray')

      expect(hasColorClass).toBeTruthy()
    }
  })
})
