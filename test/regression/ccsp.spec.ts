/**
 * Regression Tests — ccsp domain (split from test/regression.spec.ts).
 * Surgical refactor: test text preserved verbatim; readFileSync/resolve paths
 * adjusted for the new test/regression/ directory depth.
 */
import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { resolve, join } from 'path'
import { postJSONDestructive, DESTRUCTIVE_URL, requireTestContainer } from './helpers'

// ── Snapshot / restore full config (aes + customers) ─────────────────────────
// Used by @destructive tests that wipe AE/customer config — see parent file
// regression.spec.ts for history. Gracefully handles missing test container.

let snapshot: unknown = null

test.beforeAll(async () => {
  if (process.env.TEST_URL) requireTestContainer(DESTRUCTIVE_URL)
  try {
    const { body } = await postJSONDestructive('/api/__test/snapshot', {})
    snapshot = body
  } catch {
    snapshot = null
  }
})

test.afterAll(async () => {
  if (snapshot) {
    try {
      await postJSONDestructive('/api/__test/restore', snapshot)
    } catch { /* ignore — test container may have been stopped */ }
  }
})



// ─── REG-044: Tableau session-expired signal invalidates status cache (BKL-UX79) ──────────
test.describe('REG-044: CCSP scraper signals expired Tableau session to bootstrap status cache (BKL-UX79)', () => {
  const CCSP = resolve(import.meta.dirname!, '..', '..', 'src', 'ccsp-scraper.ts')
  const BOOTSTRAP = resolve(import.meta.dirname!, '..', '..', 'src', 'bootstrap-orchestrator.ts')

  test('consumeTableauSessionExpired exported from ccsp-scraper.ts', () => {
    const src = readFileSync(CCSP, 'utf8')
    expect(src, 'consumeTableauSessionExpired must be exported').toContain('export function consumeTableauSessionExpired')
  })

  test('scrapeOneAe sets _tableauSessionExpired on login-page detection', () => {
    const src = readFileSync(CCSP, 'utf8')
    const fnStart = src.indexOf('async function scrapeOneAe')
    expect(fnStart, 'scrapeOneAe must exist in ccsp-scraper.ts').toBeGreaterThan(-1)
    // Find the end of scrapeOneAe by locating the next top-level function or export
    const nextFn = src.indexOf('\nasync function ', fnStart + 1)
    const nextExport = src.indexOf('\nexport ', fnStart + 1)
    const candidates = [nextFn, nextExport].filter(n => n > -1)
    const fnEnd = candidates.length ? Math.min(...candidates) : src.length
    const body = src.slice(fnStart, fnEnd)
    expect(body, '_tableauSessionExpired flag must be set inside scrapeOneAe').toContain('_tableauSessionExpired = true')
  })

  test('bootstrap-orchestrator imports consumeTableauSessionExpired', () => {
    const src = readFileSync(BOOTSTRAP, 'utf8')
    expect(src, 'consumeTableauSessionExpired must be imported from ccsp-scraper.ts').toMatch(
      /import\s*\{[^}]*consumeTableauSessionExpired[^}]*\}\s*from\s*['"]\.\/ccsp-scraper\.ts['"]/,
    )
  })

  test('session-status handler invalidates _tableauStatusCache when flag is set', () => {
    const src = readFileSync(BOOTSTRAP, 'utf8')
    const handlerStart = src.indexOf("app.get('/api/bootstrap/tableau/session-status'")
    expect(handlerStart, 'session-status handler must exist').toBeGreaterThan(-1)
    const handlerEnd = src.indexOf('})', handlerStart)
    const handlerBody = src.slice(handlerStart, handlerEnd)
    expect(handlerBody, 'must call consumeTableauSessionExpired()').toContain('consumeTableauSessionExpired()')
    expect(handlerBody, 'must null out _tableauStatusCache on expired signal').toContain('_tableauStatusCache = null')
  })
})

// ── REG-077: BKL-UX118 — CCSP AE filter propagates to Total Portfolio ACV ──
// Regression: before BKL-UX118, the quarterly breakdown row for a globally-selected AE
// never auto-expanded and the LEFT panel "Total Portfolio ACV" stat did not change
// because internal activeAE state was not driven by the aeFilterSelected prop.
//
// Behavioral rewrite (TEST-P0-03 / TEST-AUDIT.md): the prior tests source-grepped
// CloudSpendSection.tsx with readFileSync + toContain, so they passed even when
// the prop wiring was broken. The AE filter bug shipped under that "green" suite.
//
// These tests drive the dashboard, click an AE chip in the global "Filter by Account
// Executive" radiogroup, and assert the CCSP "Total Portfolio ACV" actually changes.
//
// Test container only — needs the seeded multi-AE CCSP data on 7776.
test.describe('REG-077: CCSP AE filter propagates to Total Portfolio ACV (BKL-UX118) @destructive', () => {
  test.use({ baseURL: process.env.TEST_URL ?? 'http://localhost:7776' })

  // Precondition guard: this test depends on the test container having the
  // multi-AE seed (10 AEs + matching CCSP byAE rows). Other destructive tests
  // in the same project (qa-e2e-newuser, bootstrap-onboarding) wipe data via
  // /api/setup/reset?confirm=true. If our run lands after one of those, the
  // CCSP section won't render at all and we'd time out on a misleading error.
  // Skip with a clear message instead — see TEST-AUDIT.md note on parallel
  // destructive isolation as a known structural gap.
  test.beforeEach(async ({ request }, testInfo) => {
    const baseUrl = process.env.TEST_URL ?? 'http://localhost:7776'
    const ccspRes = await request.get(`${baseUrl}/api/ccsp`)
    if (!ccspRes.ok()) {
      testInfo.skip(true, `REG-077 precondition: GET /api/ccsp returned ${ccspRes.status()} — cannot validate CCSP UI without data`)
      return
    }
    const ccsp = await ccspRes.json()
    const byAEcount = Array.isArray(ccsp?.byAE) ? ccsp.byAE.length : 0
    if (byAEcount < 2) {
      testInfo.skip(true, `REG-077 precondition: CCSP byAE has ${byAEcount} entries (need ≥2). Test container wiped by a parallel destructive test — restore via 'make test-restore' + 'make test-up-live'.`)
    }
  })

  // Pull a real ACV figure ($X,XXX or $X.XM) out of the Total Portfolio ACV tile.
  // The tile renders the value in the div immediately after `text=Total Portfolio ACV`.
  // While `loading` is true, that div is replaced with an empty skeleton placeholder
  // (CloudSpendSection.tsx line 436), so we must poll until a non-empty currency
  // string appears. Otherwise we race the loading flip and read "" back.
  async function readTotalPortfolioAcv(page: import('@playwright/test').Page): Promise<string> {
    const section = page.locator('h2:has-text("Cloud Spend")').locator('xpath=ancestor::div[contains(@class,"bg-surface")][1]')
    const valueLocator = section.locator('text=Total Portfolio ACV').locator('xpath=following-sibling::div[1]').first()
    await expect(valueLocator).toBeVisible({ timeout: 10_000 })

    // Poll for the rendered value to settle on a real currency string. The skeleton
    // div has empty innerText, so any non-empty text past the loading flip is real.
    let txt = ''
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      txt = (await valueLocator.innerText()).trim()
      if (txt.length > 0 && /\$/.test(txt)) break
      await page.waitForTimeout(150)
    }
    expect(txt.length, 'Total Portfolio ACV value must not be empty after settle').toBeGreaterThan(0)
    expect(txt, 'Total Portfolio ACV must be a currency string').toMatch(/\$/)
    return txt
  }

  async function gotoDashboardAndWaitForCcsp(page: import('@playwright/test').Page) {
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    // Wait for CCSP section + the global AE filter radiogroup to render.
    await page.waitForSelector('h2:has-text("Cloud Spend")', { timeout: 15_000 })
    await page.waitForSelector('[role="radiogroup"][aria-label="Filter by Account Executive"]', { timeout: 15_000 })
  }

  test('REG-077-A: clicking an AE chip changes Total Portfolio ACV to a different value', async ({ page }) => {
    await gotoDashboardAndWaitForCcsp(page)

    const before = await readTotalPortfolioAcv(page)

    // Click the first non-"All" AE chip in the global filter.
    const aeBar = page.locator('[role="radiogroup"][aria-label="Filter by Account Executive"]')
    const aeChips = aeBar.locator('button[role="radio"]')
    const total = await aeChips.count()
    expect(total, 'must have at least 2 AE chips ("All" + ≥1 AE)').toBeGreaterThanOrEqual(2)

    // The first chip is "All"; pick the second one (a real AE).
    const firstAeChip = aeChips.nth(1)
    await firstAeChip.click()

    // Wait for the React state + useEffect to settle and the LEFT panel to repaint.
    await page.waitForTimeout(500)

    const afterFiltered = await readTotalPortfolioAcv(page)
    expect(afterFiltered, 'Total Portfolio ACV must change after selecting an AE').not.toBe(before)
  })

  test('REG-077-B: filtered AE Total Portfolio ACV is strictly less than the unfiltered total', async ({ page }) => {
    await gotoDashboardAndWaitForCcsp(page)

    const unfiltered = await readTotalPortfolioAcv(page)

    const aeBar = page.locator('[role="radiogroup"][aria-label="Filter by Account Executive"]')
    const aeChips = aeBar.locator('button[role="radio"]')
    await aeChips.nth(1).click()
    await page.waitForTimeout(500)

    const filtered = await readTotalPortfolioAcv(page)

    // Parse the formatted dollar amounts ("$1.2M", "$745K", "$53,810,490") into raw numbers.
    function parseDollar(s: string): number {
      const cleaned = s.replace(/[$,\s]/g, '')
      const m = cleaned.match(/^([\d.]+)([KMB])?$/i)
      if (!m) return NaN
      const n = parseFloat(m[1])
      const suffix = (m[2] ?? '').toUpperCase()
      if (suffix === 'K') return n * 1_000
      if (suffix === 'M') return n * 1_000_000
      if (suffix === 'B') return n * 1_000_000_000
      return n
    }

    const unfilteredNum = parseDollar(unfiltered)
    const filteredNum = parseDollar(filtered)
    expect(Number.isFinite(unfilteredNum), `must parse unfiltered ACV "${unfiltered}"`).toBe(true)
    expect(Number.isFinite(filteredNum), `must parse filtered ACV "${filtered}"`).toBe(true)
    expect(filteredNum, 'a single-AE total must be less than the all-AE total').toBeLessThan(unfilteredNum)
  })

  test('REG-077-C: clicking "All" after an AE filter restores the original Total Portfolio ACV', async ({ page }) => {
    await gotoDashboardAndWaitForCcsp(page)

    const initial = await readTotalPortfolioAcv(page)

    const aeBar = page.locator('[role="radiogroup"][aria-label="Filter by Account Executive"]')
    const aeChips = aeBar.locator('button[role="radio"]')
    await aeChips.nth(1).click()
    await page.waitForTimeout(500)

    const filtered = await readTotalPortfolioAcv(page)
    expect(filtered, 'sanity: filter must take effect first').not.toBe(initial)

    // Click "All" (first chip in the radiogroup).
    await aeChips.nth(0).click()
    await page.waitForTimeout(500)

    const restored = await readTotalPortfolioAcv(page)
    expect(restored, 'clicking "All" must restore the unfiltered Total Portfolio ACV').toBe(initial)
  })
})

// ── REG-084: BKL-UX119 — Section-internal AE row click propagates to global filter ──
// Regression: clicking an AE row inside CloudSpendSection's "By AE" tile (or
// an owner row in PipelineSection's "By Owner" tile) only set local component
// state — it did NOT update the global aeFilterSelected, so the left-panel
// Total Portfolio ACV and partner bars did not repaint. The only thing that
// worked was the global AE chip bar at the top of the page.
//
// Fix lifts the selection via new onSelectAE / onSelectOwner callbacks so
// internal row clicks drive the global AE filter just like the chip bar.
//
// Test container only — needs the seeded multi-AE CCSP data on 7776.
test.describe('REG-084: AE row click in CCSP tile propagates to Total Portfolio ACV (BKL-UX119) @destructive', () => {
  test.use({ baseURL: process.env.TEST_URL ?? 'http://localhost:7776' })

  // Same precondition as REG-077: the CCSP byAE seed must be present.
  test.beforeEach(async ({ request }, testInfo) => {
    const baseUrl = process.env.TEST_URL ?? 'http://localhost:7776'
    const ccspRes = await request.get(`${baseUrl}/api/ccsp`)
    if (!ccspRes.ok()) {
      testInfo.skip(true, `REG-084 precondition: GET /api/ccsp returned ${ccspRes.status()} — cannot validate CCSP UI without data`)
      return
    }
    const ccsp = await ccspRes.json()
    const byAEcount = Array.isArray(ccsp?.byAE) ? ccsp.byAE.length : 0
    if (byAEcount < 2) {
      testInfo.skip(true, `REG-084 precondition: CCSP byAE has ${byAEcount} entries (need ≥2). Test container wiped by a parallel destructive test — restore via 'make test-restore' + 'make test-up-live'.`)
    }
  })

  // Reuse the same settle-safe reader pattern as REG-077. The skeleton div has
  // empty innerText during loading, so we must poll past the loading flip.
  async function readTotalPortfolioAcv(page: import('@playwright/test').Page): Promise<string> {
    const section = page.locator('h2:has-text("Cloud Spend")').locator('xpath=ancestor::div[contains(@class,"bg-surface")][1]')
    const valueLocator = section.locator('text=Total Portfolio ACV').locator('xpath=following-sibling::div[1]').first()
    await expect(valueLocator).toBeVisible({ timeout: 10_000 })

    let txt = ''
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      txt = (await valueLocator.innerText()).trim()
      if (txt.length > 0 && /\$/.test(txt)) break
      await page.waitForTimeout(150)
    }
    expect(txt.length, 'Total Portfolio ACV value must not be empty after settle').toBeGreaterThan(0)
    expect(txt, 'Total Portfolio ACV must be a currency string').toMatch(/\$/)
    return txt
  }

  function parseDollar(s: string): number {
    const cleaned = s.replace(/[$,\s]/g, '')
    const m = cleaned.match(/^([\d.]+)([KMB])?$/i)
    if (!m) return NaN
    const n = parseFloat(m[1])
    const suffix = (m[2] ?? '').toUpperCase()
    if (suffix === 'K') return n * 1_000
    if (suffix === 'M') return n * 1_000_000
    if (suffix === 'B') return n * 1_000_000_000
    return n
  }

  async function gotoDashboardAndWaitForCcsp(page: import('@playwright/test').Page) {
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    await page.waitForSelector('h2:has-text("Cloud Spend")', { timeout: 15_000 })
    // Also wait for the By-AE compact rows to render.
    await page.waitForSelector('[data-testid="ccsp-ae-compact-row"]', { timeout: 15_000 })
  }

  test('REG-084-A: clicking an AE row in the "By AE" tile changes Total Portfolio ACV to a smaller value', async ({ page }) => {
    await gotoDashboardAndWaitForCcsp(page)

    const before = await readTotalPortfolioAcv(page)
    const beforeNum = parseDollar(before)
    expect(Number.isFinite(beforeNum), `must parse unfiltered ACV "${before}"`).toBe(true)

    // Click the first AE row inside the "By AE" compact tile (NOT the global chip).
    const aeRows = page.locator('[data-testid="ccsp-ae-compact-row"]')
    const rowCount = await aeRows.count()
    expect(rowCount, 'must have at least one AE row in the By AE tile').toBeGreaterThanOrEqual(1)
    await aeRows.first().click()

    // Wait for the state lift → global filter → API refetch → left-panel repaint.
    await page.waitForTimeout(800)

    const afterFiltered = await readTotalPortfolioAcv(page)
    const afterNum = parseDollar(afterFiltered)
    expect(Number.isFinite(afterNum), `must parse filtered ACV "${afterFiltered}"`).toBe(true)
    expect(afterFiltered, 'Total Portfolio ACV must change after clicking an AE row in the tile').not.toBe(before)
    expect(afterNum, 'a single-AE total must be strictly less than the all-AE total').toBeLessThan(beforeNum)
  })
})
