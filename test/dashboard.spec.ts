/**
 * Dashboard E2E Tests — RH Session Banner & noVNC reconnect flow
 *
 * Requires the server to be running:
 *   bun run server.ts &
 * Or against the container:
 *   podman run --rm -p 7777:7777 -p 127.0.0.1:6080:6080 localhost/daily-brief-dashboard
 *
 * Run:
 *   bun run test:e2e
 */
import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'

const NO_SESSION: Record<string, unknown> = {
  hasSession: false, sessionExpired: false, lastScraped: null,
  caseCount: 0, loginInProgress: false, loginTimedOut: false,
}

const EXPIRED_SESSION: Record<string, unknown> = {
  hasSession: true, sessionExpired: true, lastScraped: '2026-03-27T10:00:00Z',
  caseCount: 5, loginInProgress: false, loginTimedOut: false,
}

const ACTIVE_SESSION: Record<string, unknown> = {
  hasSession: true, sessionExpired: false, lastScraped: '2026-03-27T10:00:00Z',
  caseCount: 5, loginInProgress: false, loginTimedOut: false,
}

// ── RH Session Banner visibility ──────────────────────────────────────────────

test.describe('RH Session Banner', () => {
  test('banner shows "not connected" when hasSession is false', async ({ page }) => {
    await page.route('**/api/auth/redhat/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(NO_SESSION) })
    )
    await page.goto(`${BASE_URL}/`)
    await expect(page.getByText(/Red Hat Portal not connected/i)).toBeVisible()
  })

  test('banner shows "session expired" when sessionExpired is true', async ({ page }) => {
    await page.route('**/api/auth/redhat/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(EXPIRED_SESSION) })
    )
    await page.goto(`${BASE_URL}/`)
    await expect(page.getByText(/Red Hat session expired/i)).toBeVisible()
  })

  test('no banner when session is active and not expired', async ({ page }) => {
    await page.route('**/api/auth/redhat/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(ACTIVE_SESSION) })
    )
    await page.goto(`${BASE_URL}/`)
    // Give the status fetch time to resolve
    await page.waitForTimeout(500)
    await expect(page.getByText(/Red Hat Portal not connected/i)).toHaveCount(0)
    await expect(page.getByText(/Red Hat session expired/i)).toHaveCount(0)
  })

  test('Connect button is visible when not connected', async ({ page }) => {
    await page.route('**/api/auth/redhat/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(NO_SESSION) })
    )
    await page.goto(`${BASE_URL}/`)
    await expect(page.getByRole('button', { name: /^Connect$/i })).toBeVisible()
  })

  test('Reconnect button is visible when session is expired', async ({ page }) => {
    await page.route('**/api/auth/redhat/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(EXPIRED_SESSION) })
    )
    await page.goto(`${BASE_URL}/`)
    await expect(page.getByRole('button', { name: /^Reconnect$/i })).toBeVisible()
  })
})

// ── noVNC reconnect flow ──────────────────────────────────────────────────────

test.describe('noVNC reconnect flow', () => {
  test('clicking Connect opens noVNC tab at correct URL', async ({ page, context }) => {
    await page.route('**/api/auth/redhat/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(NO_SESSION) })
    )
    await page.route('**/api/auth/redhat/start', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) })
    )
    await page.goto(`${BASE_URL}/`)

    // Wait for new page (tab) opened by window.open
    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: /^Connect$/i }).click(),
    ])

    expect(newPage.url()).toContain('localhost:6080/vnc.html')
    expect(newPage.url()).toContain('autoconnect=true')
  })

  test('status text changes to "Login browser opened" after clicking Connect', async ({ page }) => {
    await page.route('**/api/auth/redhat/status', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(NO_SESSION) })
    )
    await page.route('**/api/auth/redhat/start', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) })
    )
    await page.goto(`${BASE_URL}/`)
    // window.open to :6080 will fail to connect in test env — harmless, doesn't block the original page
    await page.getByRole('button', { name: /^Connect$/i }).click()
    await expect(page.getByText(/Login browser opened/i)).toBeVisible()
  })

  test('loginInProgress: after connecting, banner shows waiting state not Connect button', async ({ page }) => {
    // First call returns loginInProgress: true (login was just started)
    let callCount = 0
    await page.route('**/api/auth/redhat/status', route => {
      callCount++
      const body = callCount === 1
        ? { ...NO_SESSION }
        : { ...NO_SESSION, loginInProgress: true }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.route('**/api/auth/redhat/start', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) })
    )
    await page.goto(`${BASE_URL}/`)
    await page.getByRole('button', { name: /^Connect$/i }).click()

    // After clicking, the button should be replaced by a status message
    await expect(page.getByRole('button', { name: /^Connect$/i })).toHaveCount(0)
    await expect(page.getByText(/Login browser opened/i)).toBeVisible()
  })
})
