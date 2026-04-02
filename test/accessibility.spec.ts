/**
 * Accessibility tests — WCAG 2.1 AA compliance on main pages using axe-core.
 */
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'

test.describe('Accessibility — WCAG 2.1 AA', () => {
  test('dashboard page (/dashboard) has no axe violations', async ({ page }) => {
    // App redirects / → /dashboard; SPA uses react-router with /dashboard/* paths
    await page.goto(`${BASE}/dashboard`)
    // Wait for React to hydrate — look for a real rendered element, not just body
    await page.waitForSelector('h1, [data-testid], nav, main', { state: 'visible', timeout: 10000 })

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      // WCAG 1.4.3 explicitly exempts inactive UI components (disabled elements)
      // from color-contrast requirements. Exclude them to avoid false positives.
      .exclude('[disabled]')
      .analyze()

    if (results.violations.length > 0) {
      const summary = results.violations.map(v =>
        `[${v.impact}] ${v.id}: ${v.description} (${v.nodes.length} nodes)`
      ).join('\n')
      expect.soft(results.violations.length, `Axe violations on /dashboard:\n${summary}`).toBe(0)
    }
    expect(results.violations.length).toBe(0)
  })

  test('/dashboard/setup page has no axe violations', async ({ page }) => {
    // Setup is served at /dashboard/setup (react-router route in App.tsx)
    await page.goto(`${BASE}/dashboard/setup`)
    // Wait for React to hydrate — look for a real rendered element, not just body
    await page.waitForSelector('h1, [data-testid], nav, main', { state: 'visible', timeout: 10000 })

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      // WCAG 1.4.3 explicitly exempts inactive UI components (disabled elements)
      // from color-contrast requirements. Exclude them to avoid false positives.
      .exclude('[disabled]')
      .analyze()

    if (results.violations.length > 0) {
      const summary = results.violations.map(v =>
        `[${v.impact}] ${v.id}: ${v.description} (${v.nodes.length} nodes)`
      ).join('\n')
      expect.soft(results.violations.length, `Axe violations on /dashboard/setup:\n${summary}`).toBe(0)
    }
    expect(results.violations.length).toBe(0)
  })
})
