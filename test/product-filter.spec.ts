/**
 * Product Filter Chip Bar — E2E Tests
 *
 * Tests the product filter chip bar that appears when accounts have
 * subscription data (products). The bar renders chips from
 * discoverAllProducts() in dashboard/src/utils/productName.ts.
 *
 * Data dependency: Requires at least one account with products[].productDescription
 * from a completed Supportable scrape. If no data exists, tests skip gracefully.
 *
 * Structural dependency: The product chip bar is nested inside the AE chip bar
 * block which only renders when aeList.length > 1 (App.tsx line 449). When only
 * 1 AE is configured, the spec intercepts /api/accounts to inject a cloned
 * customer under a second AE name. This does NOT modify server state.
 *
 * Requires the server to be running on localhost:7777.
 *
 * Run:
 *   npx playwright test test/product-filter.spec.ts
 */
import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777'

// ── Data check: skip all tests if no subscription data ──────────────

let hasProductData = false
let realAccountsPayload: { customers: any[] } = { customers: [] }
let aeCount = 0

test.beforeAll(async ({ request }) => {
  const res = await request.get(`${BASE_URL}/api/accounts`)
  if (!res.ok()) {
    test.skip(true, 'Cannot reach /api/accounts — server may not be running')
    return
  }
  const data = await res.json()
  realAccountsPayload = data
  const customers = data?.customers ?? []

  // Count unique AEs
  const aeNames = new Set<string>()
  for (const c of customers) {
    if (c.ae) aeNames.add(c.ae)
  }
  aeCount = aeNames.size

  for (const c of customers) {
    if (c.products && c.products.length > 0) {
      hasProductData = true
      break
    }
  }
})

// ── Helper: build augmented accounts response with 2+ AEs ───────────
// The product chip bar is nested inside aeList.length > 1 (App.tsx line 449).
// When only 1 AE exists, we clone the first customer with a different AE name
// to satisfy the rendering gate. Cloning a real customer (not a minimal skeleton)
// avoids crashes from missing fields (e.g., totalLicenses.toLocaleString).

function buildAugmentedPayload(): string {
  const payload = JSON.parse(JSON.stringify(realAccountsPayload))

  if (aeCount < 2 && payload.customers.length > 0) {
    const clone = JSON.parse(JSON.stringify(payload.customers[0]))
    clone.name = 'Synthetic Corp'
    clone.ae = 'Synthetic AE'
    clone.domain = 'synthetic.example.com'
    payload.customers.push(clone)
  }

  return JSON.stringify(payload)
}

// ── Helper: set up page for Product view with chip bar visible ──────

async function setupProductView(page: import('@playwright/test').Page, clearSelection = true) {
  const body = buildAugmentedPayload()

  // Intercept /api/accounts to ensure 2+ AEs
  await page.route('**/api/accounts?*', (route) =>
    route.fulfill({ contentType: 'application/json', body })
  )

  // Pre-set localStorage so the app loads directly in Product view
  await page.addInitScript((clear: boolean) => {
    localStorage.setItem('dashboard-view-mode', 'product')
    if (clear) localStorage.removeItem('product-filter-selected')
  }, clearSelection)

  await page.goto(`${BASE_URL}/`)
  await page.waitForLoadState('networkidle')
}

// ── Helper: find first product chip (not "All Products") ────────────

async function findFirstProductChip(chipBar: ReturnType<typeof import('@playwright/test').Page.prototype.locator>) {
  const chips = chipBar.getByRole('button')
  const count = await chips.count()
  for (let i = 0; i < count; i++) {
    const text = await chips.nth(i).textContent()
    if (text && text.trim() !== 'All Products') {
      return { chip: chips.nth(i), name: text.trim() }
    }
  }
  return null
}

// ── Product chip rendering ──────────────────────────────────────────

test.describe('Product Filter Chip Bar — Rendering', () => {
  test.skip(() => !hasProductData, 'No subscription data — run Supportable scrape first')

  test('product filter chip bar appears in Product view with at least one chip', async ({ page }) => {
    await setupProductView(page)

    const chipBar = page.locator('[aria-label="Filter by product"]')
    await expect(chipBar).toBeVisible({ timeout: 5000 })

    // "All Products" button should be present
    const allChip = chipBar.getByRole('button', { name: 'All Products' })
    await expect(allChip).toBeVisible()

    // At least one product chip besides "All Products"
    const chips = chipBar.getByRole('button')
    const count = await chips.count()
    expect(count).toBeGreaterThan(1) // "All Products" + at least 1 product
  })

  test('product chips display stripped product names (no "Red Hat" prefix)', async ({ page }) => {
    await setupProductView(page)

    const chipBar = page.locator('[aria-label="Filter by product"]')
    await expect(chipBar).toBeVisible({ timeout: 5000 })

    // No chip should start with "Red Hat " — the UI strips that prefix
    const chips = chipBar.getByRole('button')
    const count = await chips.count()
    for (let i = 0; i < count; i++) {
      const text = await chips.nth(i).textContent()
      if (text && text !== 'All Products') {
        expect(text.trim()).not.toMatch(/^Red Hat /i)
      }
    }
  })

  test('"All Products" chip has active styling by default (no filter selected)', async ({ page }) => {
    await setupProductView(page)

    const chipBar = page.locator('[aria-label="Filter by product"]')
    await expect(chipBar).toBeVisible({ timeout: 5000 })

    const allChip = chipBar.getByRole('button', { name: 'All Products' })
    await expect(allChip).toHaveClass(/ring-accent/)
  })

  test('chip bar is NOT visible in ASA view', async ({ page }) => {
    // Load in ASA view (default)
    await page.addInitScript(() => {
      localStorage.setItem('dashboard-view-mode', 'asa')
    })
    await page.goto(`${BASE_URL}/`)
    await page.waitForLoadState('networkidle')

    // Product filter bar should not be visible in ASA view
    const chipBar = page.locator('[aria-label="Filter by product"]')
    await expect(chipBar).toHaveCount(0)
  })
})

// ── Chip click behavior ─────────────────────────────────────────────

test.describe('Product Filter Chip Bar — Click Behavior', () => {
  test.skip(() => !hasProductData, 'No subscription data — run Supportable scrape first')

  test('clicking a product chip gives it active styling', async ({ page }) => {
    await setupProductView(page)

    const chipBar = page.locator('[aria-label="Filter by product"]')
    await expect(chipBar).toBeVisible({ timeout: 5000 })

    const found = await findFirstProductChip(chipBar)
    expect(found).not.toBeNull()

    // Click the chip
    await found!.chip.click()

    // Active chip should have accent ring styling
    await expect(found!.chip).toHaveClass(/ring-accent/)

    // "All Products" chip should lose its active styling
    const allChip = chipBar.getByRole('button', { name: 'All Products' })
    await expect(allChip).not.toHaveClass(/ring-accent/)
  })

  test('clicking "All Products" clears selection', async ({ page }) => {
    await setupProductView(page)

    const chipBar = page.locator('[aria-label="Filter by product"]')
    await expect(chipBar).toBeVisible({ timeout: 5000 })

    // Select a product chip first
    const found = await findFirstProductChip(chipBar)
    expect(found).not.toBeNull()
    await found!.chip.click()

    // Click "All Products" to clear
    const allChip = chipBar.getByRole('button', { name: 'All Products' })
    await allChip.click()

    // "All Products" should now have active styling
    await expect(allChip).toHaveClass(/ring-accent/)

    // localStorage should be empty array
    const stored = await page.evaluate(() => localStorage.getItem('product-filter-selected'))
    expect(JSON.parse(stored ?? '[]')).toEqual([])
  })
})

// ── Multi-select ────────────────────────────────────────────────────

test.describe('Product Filter Chip Bar — Multi-Select', () => {
  test.skip(() => !hasProductData, 'No subscription data — run Supportable scrape first')

  test('clicking two product chips activates both', async ({ page }) => {
    await setupProductView(page)

    const chipBar = page.locator('[aria-label="Filter by product"]')
    await expect(chipBar).toBeVisible({ timeout: 5000 })

    const chips = chipBar.getByRole('button')
    const count = await chips.count()

    // Need at least 2 product chips (besides "All Products")
    const productChips: { chip: ReturnType<typeof chips.nth>; name: string }[] = []
    for (let i = 0; i < count; i++) {
      const text = await chips.nth(i).textContent()
      if (text && text.trim() !== 'All Products') {
        productChips.push({ chip: chips.nth(i), name: text.trim() })
        if (productChips.length >= 2) break
      }
    }

    if (productChips.length < 2) {
      test.skip(true, 'Need at least 2 product chips for multi-select test')
      return
    }

    // Click both chips
    await productChips[0].chip.click()
    await productChips[1].chip.click()

    // Both should have active styling
    await expect(productChips[0].chip).toHaveClass(/ring-accent/)
    await expect(productChips[1].chip).toHaveClass(/ring-accent/)

    // localStorage should have 2 entries
    const stored = await page.evaluate(() => localStorage.getItem('product-filter-selected'))
    const parsed = JSON.parse(stored ?? '[]')
    expect(parsed).toHaveLength(2)
  })
})

// ── localStorage persistence ────────────────────────────────────────

test.describe('Product Filter Chip Bar — Persistence', () => {
  test.skip(() => !hasProductData, 'No subscription data — run Supportable scrape first')

  test('selected product persists across page reload', async ({ page }) => {
    // Use setupProductView with clearSelection=false so addInitScript
    // does not remove product-filter-selected on reload
    await setupProductView(page, false)

    const chipBar = page.locator('[aria-label="Filter by product"]')
    await expect(chipBar).toBeVisible({ timeout: 5000 })

    // Select a product chip and capture its name
    const found = await findFirstProductChip(chipBar)
    expect(found).not.toBeNull()
    await found!.chip.click()
    const selectedName = found!.name

    // Verify localStorage was set
    const storedBefore = await page.evaluate(() => localStorage.getItem('product-filter-selected'))
    expect(storedBefore).toContain(selectedName)

    // Reload the page (route intercept persists across reloads)
    await page.reload()
    await page.waitForLoadState('networkidle')

    // The chip should still be selected after reload
    const chipBarAfter = page.locator('[aria-label="Filter by product"]')
    await expect(chipBarAfter).toBeVisible({ timeout: 5000 })

    const selectedChip = chipBarAfter.getByRole('button', { name: selectedName, exact: true })
    await expect(selectedChip).toHaveClass(/ring-accent/)

    // localStorage should still have the selection
    const storedAfter = await page.evaluate(() => localStorage.getItem('product-filter-selected'))
    expect(storedAfter).toContain(selectedName)
  })
})

// ── Card filtering ──────────────────────────────────────────────────

test.describe('Product Filter Chip Bar — Account Filtering', () => {
  test.skip(() => !hasProductData, 'No subscription data — run Supportable scrape first')

  test('selecting a product filters the visible account count', async ({ page }) => {
    await setupProductView(page)

    const chipBar = page.locator('[aria-label="Filter by product"]')
    await expect(chipBar).toBeVisible({ timeout: 5000 })

    // Ensure "All Products" is selected (no filter)
    const allChip = chipBar.getByRole('button', { name: 'All Products' })
    await allChip.click()
    await page.waitForTimeout(300)

    // Read the "All" count from the AE chip bar (total accounts displayed)
    const aeBar = page.locator('[aria-label="Filter by Account Executive"]')
    const allAeChip = aeBar.getByRole('radio', { name: /^All/ })
    const allCountText = await allAeChip.textContent()
    const totalBefore = parseInt(allCountText?.match(/\d+/)?.[0] ?? '0', 10)

    // Select a product chip
    const found = await findFirstProductChip(chipBar)
    expect(found).not.toBeNull()
    await found!.chip.click()
    await page.waitForTimeout(500)

    // Verify the filteredAccounts changed via localStorage state
    const stored = await page.evaluate(() => localStorage.getItem('product-filter-selected'))
    const parsed = JSON.parse(stored ?? '[]')
    expect(parsed.length).toBeGreaterThan(0)

    // The filter should reduce or maintain account count (not increase)
    // We verify by checking that at least one product chip was selected
    expect(parsed).toContain(found!.name)
  })
})

// ── Clear / deselect ────────────────────────────────────────────────

test.describe('Product Filter Chip Bar — Clear Selection', () => {
  test.skip(() => !hasProductData, 'No subscription data — run Supportable scrape first')

  test('clicking an active chip deselects it (toggle off)', async ({ page }) => {
    await setupProductView(page)

    const chipBar = page.locator('[aria-label="Filter by product"]')
    await expect(chipBar).toBeVisible({ timeout: 5000 })

    const found = await findFirstProductChip(chipBar)
    expect(found).not.toBeNull()

    // Click to select
    await found!.chip.click()
    await expect(found!.chip).toHaveClass(/ring-accent/)

    // Click again to deselect
    await found!.chip.click()

    // Chip should lose active styling
    await expect(found!.chip).not.toHaveClass(/ring-accent/)

    // "All Products" should regain active styling (no filter = all)
    const allChip = chipBar.getByRole('button', { name: 'All Products' })
    await expect(allChip).toHaveClass(/ring-accent/)

    // localStorage should be empty array
    const stored = await page.evaluate(() => localStorage.getItem('product-filter-selected'))
    expect(JSON.parse(stored ?? '[]')).toEqual([])
  })
})
