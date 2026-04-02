/**
 * QA E2E Test: Brand-new user full journey
 * Tests the complete flow from factory state through setup to dashboard
 * Quinn Torres - QA Validation
 */
import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:7777'

const CAROLANNE_AE = {
  name: 'Carolanne Farrell',
  driveFolderId: '1BV0uRHei3oRvGYVEXBX_qBB-VGu0r9wq',
  sfReportId: '00OPe00000isU2zMAE',
  tableauTerritories: ['WEST_COMM_CORP_NORTHWEST_TERR01'],
  supportableSheetId: '150e3-q-8_6Uy3qnLhL-ARBVHyVy29P7tnAuFjxkkuCg',
  ccspSheetId: '10JEEZb3mDV7nY2w5gJ7zmEkN8p4TDjKOxHSNvumVUFs',
  pipelineSheetId: '10H8Nl8oQQg1x9Zt0p5cys7JJp0b4ObfzhB-pPMot3BM',
}

// Snapshot and restore AE config around all tests
let originalAes: unknown[] = []

test.beforeAll(async ({ request }) => {
  // Snapshot current AE list before clearing
  const snapshot = await (await request.get(`${BASE}/api/aes`)).json()
  originalAes = snapshot.aes ?? []

  // Clear AEs to simulate factory state
  await request.post(`${BASE}/api/aes`, { data: { aes: [] } })
  const health = await (await request.get(`${BASE}/health`)).json()
  if (health.aes !== 0) throw new Error('Failed to reset to factory state')
})

test.afterAll(async ({ request }) => {
  // Restore original AE config so tests are non-destructive
  await request.post(`${BASE}/api/aes`, { data: { aes: originalAes } })
})

// ── TEST 1: Health check — factory state ────────────────────────────────────
test.describe('1. Factory state verification', () => {
  test('health endpoint confirms aes:0, customers:0', async ({ request }) => {
    const res = await request.get(`${BASE}/health`)
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.aes).toBe(0)
    expect(body.customers).toBe(0)
    expect(body.status).toBe('ok')
  })
})

// ── TEST 2: Dashboard — new user experience ────────────────────────────────
test.describe('2. Dashboard as new user (no config)', () => {
  test('dashboard page loads without HTTP error', async ({ page }) => {
    const response = await page.goto(`${BASE}/dashboard`)
    expect(response?.ok()).toBeTruthy()
  })

  test('capture console errors on empty dashboard', async ({ page }) => {
    const errors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    await page.goto(`${BASE}/dashboard`)
    await page.waitForTimeout(3000)
    // Log all errors for the report
    if (errors.length > 0) {
      console.log('CONSOLE ERRORS on empty dashboard:', JSON.stringify(errors))
    }
    // Filter out network errors (500s from missing data sources are expected on empty state)
    const uiErrors = errors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('Failed to load resource') &&
      !e.includes('net::')
    )
    expect(uiErrors).toEqual([])
  })

  test('screenshot: what a new user sees on empty dashboard', async ({ page }) => {
    await page.goto(`${BASE}/dashboard`)
    await page.waitForTimeout(2000)
    await page.screenshot({ path: '/tmp/qa-01-dashboard-empty.png', fullPage: true })
    // Basic: page should render something (not blank white)
    const bodyText = await page.textContent('body')
    expect(bodyText?.length).toBeGreaterThan(50)
    console.log('Empty dashboard text snippet:', bodyText?.substring(0, 300))
  })
})

// ── TEST 3: Setup Page — structure ──────────────────────────────────────────
test.describe('3. Setup page structure', () => {
  test('setup page loads successfully', async ({ page }) => {
    const response = await page.goto(`${BASE}/dashboard/setup`)
    expect(response?.ok()).toBeTruthy()
    await page.screenshot({ path: '/tmp/qa-02-setup-landing.png', fullPage: true })
  })

  test('all accordion sections visible', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.waitForTimeout(1000)

    // The setup uses accordion sections, not wizard steps
    const sections = ['OAuth Keys', 'Google Auth', 'Red Hat Portal', 'AEs & Customers', 'Data Sources']
    for (const section of sections) {
      const el = page.getByText(section)
      const count = await el.count()
      console.log(`Section "${section}" found: ${count > 0}`)
      expect(count).toBeGreaterThan(0)
    }
  })

  test('no console errors on setup page', async ({ page }) => {
    const errors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    await page.goto(`${BASE}/dashboard/setup`)
    await page.waitForTimeout(2000)
    const uiErrors = errors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('Failed to load resource') &&
      !e.includes('net::')
    )
    if (errors.length > 0) console.log('Setup page console errors:', JSON.stringify(errors))
    expect(uiErrors).toEqual([])
  })
})

// ── TEST 4: Setup — OAuth Keys section ──────────────────────────────────────
test.describe('4. Setup - OAuth Keys section', () => {
  test('OAuth Keys section shows status', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.waitForTimeout(1000)
    // Click to expand OAuth Keys section
    const oauthSection = page.getByText('OAuth Keys').first()
    await oauthSection.click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: '/tmp/qa-03-setup-oauth.png', fullPage: true })
  })
})

// ── TEST 5: Setup — Google Auth section ──────────────────────────────────────
test.describe('5. Setup - Google Auth section', () => {
  test('Google Auth section shows status', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.waitForTimeout(1000)
    const googleSection = page.getByText('Google Auth').first()
    await googleSection.click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: '/tmp/qa-04-setup-google-auth.png', fullPage: true })
  })
})

// ── TEST 6: Setup — AE Configuration via UI ─────────────────────────────────
test.describe('6. Setup - AE & Customer configuration', () => {
  test('AEs & Customers section opens', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.waitForTimeout(1000)
    const aeSection = page.getByText('AEs & Customers').first()
    await aeSection.click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: '/tmp/qa-05-setup-aes-section.png', fullPage: true })
  })

  test('AE form fields are present', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.waitForTimeout(1000)
    const aeSection = page.getByText('AEs & Customers').first()
    await aeSection.click()
    await page.waitForTimeout(500)

    // Check for AE form fields
    const inputs = await page.locator('input[type="text"], input:not([type]), textarea').all()
    console.log('Input fields found in AE section:', inputs.length)

    // Look for name/folder/report fields
    const allPlaceholders = await page.locator('input').evaluateAll(els =>
      els.map(el => ({
        placeholder: el.getAttribute('placeholder') || '',
        name: el.getAttribute('name') || '',
        type: el.getAttribute('type') || '',
        value: el.getAttribute('value') || '',
      }))
    )
    console.log('All input fields:', JSON.stringify(allPlaceholders))
  })

  test('enter Carolanne config through the UI', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`)
    await page.waitForTimeout(1000)

    // Open AEs & Customers section
    const aeSection = page.getByText('AEs & Customers').first()
    await aeSection.click()
    await page.waitForTimeout(500)

    // Try to find and fill AE name field
    const nameInput = page.locator('input[placeholder*="AE" i], input[placeholder*="name" i], input[name*="name" i]').first()
    if (await nameInput.count() > 0) {
      await nameInput.fill('Carolanne Farrell')
      console.log('Filled AE name field')
    } else {
      console.log('WARNING: Could not find AE name input field')
    }

    // Try Drive folder
    const folderInput = page.locator('input[placeholder*="folder" i], input[placeholder*="drive" i], input[placeholder*="URL" i]').first()
    if (await folderInput.count() > 0) {
      await folderInput.fill('1BV0uRHei3oRvGYVEXBX_qBB-VGu0r9wq')
      console.log('Filled Drive folder field')
    } else {
      console.log('WARNING: Could not find Drive folder input field')
    }

    await page.screenshot({ path: '/tmp/qa-06-setup-ae-filled.png', fullPage: true })
  })
})

// ── TEST 7: AE Configuration via API ────────────────────────────────────────
test.describe('7. AE config via API (correct payload)', () => {
  test('POST /api/aes with correct array format', async ({ request }) => {
    const res = await request.post(`${BASE}/api/aes`, {
      data: { aes: [CAROLANNE_AE] }
    })
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    console.log('POST /api/aes response:', JSON.stringify(body))
    expect(body.ok).toBe(true)
    expect(body.count).toBe(1)
  })

  test('GET /api/aes confirms AE was saved', async ({ request }) => {
    // Ensure AE is set
    await request.post(`${BASE}/api/aes`, { data: { aes: [CAROLANNE_AE] } })
    const res = await request.get(`${BASE}/api/aes`)
    const body = await res.json()
    expect(body.aes).toHaveLength(1)
    expect(body.aes[0].name).toBe('Carolanne Farrell')
    expect(body.aes[0].driveFolderId).toBe('1BV0uRHei3oRvGYVEXBX_qBB-VGu0r9wq')
    expect(body.aes[0].sfReportId).toBe('00OPe00000isU2zMAE')
    console.log('AE saved:', JSON.stringify(body.aes[0]))
  })

  test('health now shows aes:1', async ({ request }) => {
    await request.post(`${BASE}/api/aes`, { data: { aes: [CAROLANNE_AE] } })
    const res = await request.get(`${BASE}/health`)
    const body = await res.json()
    expect(body.aes).toBe(1)
  })
})

// ── TEST 8-10: Dashboard after setup ────────────────────────────────────────
test.describe('8-10. Dashboard after AE config', () => {
  test.beforeEach(async ({ request }) => {
    // Ensure AE is configured before each dashboard test
    await request.post(`${BASE}/api/aes`, { data: { aes: [CAROLANNE_AE] } })
  })

  test('dashboard loads after AE config - full screenshot', async ({ page }) => {
    await page.goto(`${BASE}/dashboard`)
    await page.waitForTimeout(3000)
    await page.screenshot({ path: '/tmp/qa-07-dashboard-configured.png', fullPage: true })
    const bodyText = await page.textContent('body')
    console.log('Dashboard body (first 500 chars):', bodyText?.substring(0, 500))
  })

  test('console errors on configured dashboard', async ({ page }) => {
    const errors: string[] = []
    const warnings: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text())
      if (msg.type() === 'warning') warnings.push(msg.text())
    })
    await page.goto(`${BASE}/dashboard`)
    await page.waitForTimeout(3000)
    console.log('Console errors:', JSON.stringify(errors))
    console.log('Console warnings:', JSON.stringify(warnings))
    // We don't fail on 500s from external APIs but we log them
  })

  test('dashboard sections rendered', async ({ page }) => {
    await page.goto(`${BASE}/dashboard`)
    await page.waitForTimeout(3000)
    const bodyText = (await page.textContent('body')) ?? ''

    const sections: Record<string, boolean> = {
      'Command Center': bodyText.includes('Command Center'),
      'Pipeline': bodyText.includes('Pipeline') || bodyText.includes('pipeline'),
      'Cloud Spend / CCSP': bodyText.includes('Cloud') || bodyText.includes('CCSP'),
      'Calendar': bodyText.includes('Calendar') || bodyText.includes('calendar') || bodyText.includes('Meeting'),
      'Accounts / Portfolio': bodyText.includes('Account') || bodyText.includes('Portfolio') || bodyText.includes('Customer'),
    }
    console.log('Dashboard sections:', JSON.stringify(sections, null, 2))

    // At minimum, some sections should be present
    const found = Object.values(sections).filter(v => v).length
    expect(found).toBeGreaterThanOrEqual(2)
  })

  test('sidebar navigation exists and has links', async ({ page }) => {
    await page.goto(`${BASE}/dashboard`)
    await page.waitForTimeout(2000)

    // Look for sidebar/nav elements
    const sidebarLinks = await page.locator('nav a, aside a, [class*="sidebar"] a, [class*="Sidebar"] a').count()
    const navButtons = await page.locator('nav button, aside button').count()
    console.log('Sidebar links:', sidebarLinks, 'Nav buttons:', navButtons)

    await page.screenshot({ path: '/tmp/qa-08-dashboard-sidebar.png' })
  })

  test('RH Portal badge/status on dashboard', async ({ page }) => {
    await page.goto(`${BASE}/dashboard`)
    await page.waitForTimeout(2000)

    const bodyText = (await page.textContent('body')) ?? ''
    // Check for any RH Portal reference
    const hasRedHat = bodyText.includes('Red Hat') || bodyText.includes('RH Portal')
    const hasPortalBanner = bodyText.includes('not connected') || bodyText.includes('Connect')
    console.log('Red Hat reference:', hasRedHat, 'Portal banner:', hasPortalBanner)

    await page.screenshot({ path: '/tmp/qa-09-dashboard-rh-portal.png' })
  })

  test('Settings panel accessibility', async ({ page }) => {
    await page.goto(`${BASE}/dashboard`)
    await page.waitForTimeout(2000)

    // Try to find and click a settings button/gear icon
    const settingsBtns = page.locator('button').filter({ hasText: /settings|config|gear/i })
    const settingsCount = await settingsBtns.count()

    // Also look for SVG gear icons in buttons
    const gearButtons = page.locator('button:has(svg)')
    const gearCount = await gearButtons.count()

    console.log('Settings text buttons:', settingsCount, 'Buttons with SVG:', gearCount)

    // Try clicking any settings-like button
    if (settingsCount > 0) {
      await settingsBtns.first().click()
      await page.waitForTimeout(500)
      await page.screenshot({ path: '/tmp/qa-10-settings-panel.png', fullPage: true })
    } else {
      // Try the setup link
      const setupLink = page.locator('a[href*="setup"]')
      if (await setupLink.count() > 0) {
        console.log('Found setup link (no settings button) - this is a potential UX gap')
      }
      await page.screenshot({ path: '/tmp/qa-10-no-settings-button.png' })
    }
  })

  test('click through dashboard navigation', async ({ page }) => {
    await page.goto(`${BASE}/dashboard`)
    await page.waitForTimeout(2000)

    // Find all clickable navigation items
    const navItems = page.locator('nav a, aside a, [role="tab"], [class*="sidebar"] a')
    const count = await navItems.count()
    console.log('Navigation items found:', count)

    for (let i = 0; i < Math.min(count, 5); i++) {
      const text = await navItems.nth(i).textContent()
      console.log(`Nav item ${i}: "${text?.trim()}"`)
    }
  })
})

// ── TEST: Setup reset endpoint ──────────────────────────────────────────────
test.describe('BUG: Reset endpoint issues', () => {
  test('POST /api/setup/reset?confirm=true returns 500', async ({ request }) => {
    const res = await request.post(`${BASE}/api/setup/reset?confirm=true`)
    console.log('Reset endpoint status:', res.status())
    // Document the bug - reset endpoint is broken
    if (res.status() === 500) {
      console.log('BUG CONFIRMED: /api/setup/reset?confirm=true returns 500 Internal Server Error')
    }
  })

  test('reset does not clear AEs (missing from reset logic)', async ({ request }) => {
    // Set an AE
    await request.post(`${BASE}/api/aes`, { data: { aes: [CAROLANNE_AE] } })
    let health = await (await request.get(`${BASE}/health`)).json()
    expect(health.aes).toBe(1)

    // Try reset (may 500, but check if AEs survive)
    await request.post(`${BASE}/api/setup/reset?confirm=true`)
    health = await (await request.get(`${BASE}/health`)).json()
    console.log('After reset - aes:', health.aes, 'customers:', health.customers)
    // BUG: reset should clear AEs but doesn't
    if (health.aes > 0) {
      console.log('BUG CONFIRMED: /api/setup/reset does not clear aes array or aes.json')
    }
  })
})
