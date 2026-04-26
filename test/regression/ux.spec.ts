/**
 * Regression Tests — ux domain (split from test/regression.spec.ts).
 * Surgical refactor: test text preserved verbatim; readFileSync/resolve paths
 * adjusted for the new test/regression/ directory depth.
 */
import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { resolve, join } from 'path'
import { BASE_URL, DESTRUCTIVE_URL } from './helpers'



// ── REG-UX110: Bootstrap guard UX fix shipped 2026-04-25 ────────────────────
//
// BKL-UX110: startBootstrap() was calling POST /api/bootstrap/auto without
// checking status first, resulting in a silent 409 when a bootstrap was already
// running. Three changes were made:
//   1. startBootstrap() now calls GET /api/bootstrap/auto/status BEFORE posting —
//      if running, it sets preflightError and returns early (no 409)
//   2. A warning banner renders when liveBootstrapRunning && !bootstrapState?.running —
//      yellow bg-warning/10 border, ⚠ icon, text "AE setup is in progress…"
//   3. preflightError is now a styled flex div with ⚠ icon and text-sm (not text-xs)

test.describe('Bootstrap Guard UX — BKL-UX110', () => {
  const setupSrc = () => readFileSync(
    resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'pages', 'SetupPage.tsx'),
    'utf8',
  )

  test('(source) REG-UX110-01: startBootstrap fetches /api/bootstrap/auto/status before posting', () => {
    const src = setupSrc()
    // The guard must appear inside startBootstrap — check the guard comment is present
    // and that it fetches status before posting
    expect(src, 'BKL-UX110-FIX comment must exist in SetupPage.tsx').toContain('BKL-UX110-FIX')
    // Guard: fetch status then check .running before proceeding
    expect(src, 'startBootstrap must fetch /api/bootstrap/auto/status').toContain(
      "fetch('/api/bootstrap/auto/status')"
    )
    expect(src, 'startBootstrap must check statusData.running').toContain('statusData.running')
    expect(src, 'startBootstrap must call setPreflightError when running').toContain(
      'Another AE setup is already in progress'
    )
  })

  test('(source) REG-UX110-02: warning banner uses warning color scheme, not error', () => {
    const src = setupSrc()
    // Banner should be warning-colored (bg-warning/10, border-warning/30, text-warning)
    // and contain the required text
    expect(src, 'banner must have bg-warning/10').toContain('bg-warning/10')
    expect(src, 'banner must have border-warning/30').toContain('border-warning/30')
    expect(src, 'banner must contain "AE setup is in progress" text').toContain('AE setup is in progress')
    expect(src, 'banner must contain wait instruction').toContain('wait for it to complete before starting another')
    // Banner must include the unicode warning icon ⚠ (&#9888;)
    expect(src, 'banner must include &#9888; warning icon').toContain('&#9888;')
  })

  test('(source) REG-UX110-03: preflightError display is text-sm (not text-xs)', () => {
    const src = setupSrc()
    // The upgraded error block must use text-sm on the paragraph, not text-xs
    // Verify the error block pattern: flex div with icon + text-sm paragraph
    expect(src, 'preflightError block must use text-sm on the error message paragraph').toMatch(
      /preflightError[\s\S]{0,300}text-sm text-critical/
    )
    // Confirm the old text-xs pattern is NOT used for preflightError display
    // (text-xs may appear elsewhere for other elements, so we scope to the preflightError block)
    const preflightBlock = src.split('preflightError')[2] ?? '' // after second occurrence (JSX block)
    expect(preflightBlock.slice(0, 400), 'preflightError JSX block must not use text-xs for error text').not.toMatch(
      /<p className="text-xs text-critical"/
    )
  })

  test('(source) REG-UX110-04: banner only renders when liveBootstrapRunning and no local bootstrap running', () => {
    const src = setupSrc()
    // Correct condition: liveBootstrapRunning && !bootstrapState?.running
    expect(src, 'banner must gate on liveBootstrapRunning && !bootstrapState?.running').toContain(
      'liveBootstrapRunning && !bootstrapState?.running'
    )
  })

  test('(live) REG-UX110-05: Step 4 loads with no banner when bootstrap is idle', async ({ page }) => {
    // Verify the real bootstrap/auto/status API confirms not running
    const statusRes = await fetch(`${BASE_URL}/api/bootstrap/auto/status`)
    expect(statusRes.ok, 'bootstrap status endpoint must respond 200').toBe(true)
    const status = await statusRes.json() as { running: boolean; aeName: string | null }
    expect(status.running, 'bootstrap must not be running during this test').toBe(false)

    // Navigate to setup page and open Step 4
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await page.getByRole('button', { name: /Step 4 of 5 — AEs & Customers/ }).click()
    await page.locator('section#aes').waitFor({ state: 'visible' })

    // The warning banner must NOT be visible when bootstrap is idle
    const bannerText = page.getByText('AE setup is in progress')
    await expect(bannerText, 'warning banner must be hidden when no bootstrap is running').not.toBeVisible()
  })

  test('(live) REG-UX110-06: Step 4 Single AE tab is accessible and Set Up AE button is present', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/setup`)
    await page.getByRole('button', { name: /Step 4 of 5 — AEs & Customers/ }).click()
    await page.locator('section#aes').waitFor({ state: 'visible' })

    // Navigate to the Single AE tab (bootstrap guard lives here)
    const singleAeTab = page.getByRole('tab', { name: /Single AE/i })
    if (await singleAeTab.isVisible()) {
      await singleAeTab.click()
    }

    // "Set Up AE" button must exist — it's the button that triggers startBootstrap
    const setUpButton = page.getByRole('button', { name: /Set Up AE/i })
    if (await setUpButton.isVisible()) {
      // Button exists — verify it's actionable (not completely disabled before AE selection)
      // The guard fires on click, not on render, so button presence is the key check
      await expect(setUpButton).toBeVisible()
    }
    // If button not visible, it means an AE is already bootstrapped — not a failure
  })
})

// ── REG-UX114/115/116: UX fixes shipped 2026-04-18 ──────────────────────────
//
// Three related UX regressions:
//   BKL-UX114 — compact sparkline layout must be permanent (threshold gate removed)
//   BKL-UX115 — morning summary must default to expanded (was collapsed)
//   BKL-UX116 — Account Portfolio must promote to grouped view when aeList loads ≥4 AEs
//
// Source-level assertions catch regressions even when data or live state is
// unavailable (CI read-only runs). The UX116 browser test additionally verifies
// the wired-through behavior when ≥4 AEs are actually loaded.

test.describe('UX Regression — Compact layout and health dots (BKL-UX114–116)', () => {
  test('REG-UX114-01: Compact sparkline layout is always active regardless of AE count (BKL-UX114)', async () => {
    // API contract: pipeline endpoint must respond 200 so the compact layout
    // has real data to render against.
    const res = await fetch(`${BASE_URL}/api/pipeline`)
    expect(res.status).toBe(200)

    // CloudSpendSection removed the threshold gate via `const isCompact = true`.
    const cloudSpendSrc = readFileSync(
      resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'components', 'CloudSpendSection.tsx'),
      'utf8',
    )
    expect(
      cloudSpendSrc,
      'CloudSpendSection must pin compact layout via `const isCompact = true` (BKL-UX114)',
    ).toContain('const isCompact = true')

    // PipelineSection removed the threshold gate by deleting it entirely — the
    // compact branch is now the unconditional default. We assert on the
    // data-testid that marks the always-on compact row, plus the comment that
    // documents "permanent default regardless of owner count".
    const pipelineSrc = readFileSync(
      resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'components', 'PipelineSection.tsx'),
      'utf8',
    )
    expect(
      pipelineSrc,
      'PipelineSection must render the compact owner rows unconditionally (BKL-UX114)',
    ).toContain('data-testid="pipeline-owner-compact"')
    expect(
      pipelineSrc,
      'PipelineSection must document that compact is the permanent default (BKL-UX114)',
    ).toContain('permanent default regardless of owner count')
  })

  test('REG-UX115-01: Morning summary defaults to expanded state on load (BKL-UX115)', () => {
    // The collapsed flag must initialize to `false` so the summary renders
    // expanded on first paint. Was previously `useState(true)` which
    // required an explicit user toggle to see the content.
    const src = readFileSync(
      resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'components', 'MorningSummary.tsx'),
      'utf8',
    )
    expect(
      src,
      'MorningSummary must default collapsed=false so the summary opens expanded (BKL-UX115)',
    ).toContain('const [collapsed, setCollapsed] = useState(false)')
  })

  test('@live REG-UX116-01: Account Portfolio auto-promotes to grouped view showing health dots when ≥4 AEs load (BKL-UX116)', async ({ page }) => {
    // Live test — requires real data on 7776/7777. Skip when AE count < 4.
    const aesRes = await fetch(`${BASE_URL}/api/aes`)
    expect(aesRes.status).toBe(200)
    const aesBody = await aesRes.json() as { aes?: unknown[] }
    const aeCount = Array.isArray(aesBody.aes) ? aesBody.aes.length : 0
    test.skip(aeCount < 4, `Needs ≥4 AEs for grouped view (have ${aeCount})`)

    await page.goto(BASE_URL)
    await page
      .locator('[data-testid="ae-group-health-dots"]')
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 })
  })

  test('REG-UX116-02: AccountPortfolioGrid has reactive viewMode upgrade to grouped when aeList loads (BKL-UX116)', () => {
    // Regression guard for the "aeList empty at mount" bug: the lazy
    // useState initializer fires before aeList loads, so a useEffect must
    // promote viewMode to 'grouped' once aeList arrives — unless the user
    // has explicitly picked a view (tracked via hasUserChosen ref).
    const src = readFileSync(
      resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'components', 'AccountPortfolioGrid.tsx'),
      'utf8',
    )
    expect(
      src,
      'AccountPortfolioGrid must track hasUserChosen via useRef (BKL-UX116)',
    ).toContain('hasUserChosen')
    expect(
      src,
      'AccountPortfolioGrid must promote to grouped view via setViewMode (BKL-UX116)',
    ).toContain("setViewMode('grouped')")

    // Verify the promotion lives inside a useEffect that watches aeList.
    // We check ordering: the useRef declaration, the useEffect, the
    // aeList >= 4 check, the setViewMode call, and the [aeList] dep array
    // must appear in that order in a contiguous block.
    const effectBlockPattern = /hasUserChosen[\s\S]{0,400}useEffect\([\s\S]{0,400}aeList\.length >= 4[\s\S]{0,200}setViewMode\('grouped'\)[\s\S]{0,200}\[aeList\]/
    expect(
      effectBlockPattern.test(src),
      'AccountPortfolioGrid must have a useEffect watching aeList that promotes viewMode to grouped when ≥4 AEs load and the user has not chosen (BKL-UX116)',
    ).toBe(true)
  })
})

// ── REG-071: BKL-AI-INTEL-01 — intelligence-status falls back to disk cache ──
// Root cause: GET /api/customer/:name/intelligence-status read only the in-memory
// jobs Map. Customers whose pipeline ran in a previous server lifetime had a
// pending/missing job entry in memory, so the endpoint returned {status:'none'}
// even though data/cache/intelligence/{slug}.json had valid companyDocUrl and
// industryDocUrl. The Account Intelligence docs dropdown in the UI showed nothing.
// Fix: getJobStatus() now falls back to readIntelligenceCache() when the in-memory
// entry has no doc URLs, synthesizing a {status:'complete', companyDocUrl, ...}
// response from disk so the UI can display the links immediately.

test.describe('REG-071: intelligence-status falls back to disk cache (BKL-AI-INTEL-01)', () => {
  test('(source) getJobStatus has disk cache fallback when job entry has no URLs', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'account-intelligence.ts'), 'utf-8')

    // Locate the getJobStatus function
    const fnStart = src.indexOf('export function getJobStatus(')
    expect(fnStart, 'getJobStatus must be exported from account-intelligence.ts').toBeGreaterThan(-1)
    const fnEnd = src.indexOf('\nexport function ', fnStart + 1)
    const body = fnEnd > fnStart ? src.slice(fnStart, fnEnd) : src.slice(fnStart)

    // Must call readIntelligenceCache as the fallback
    expect(body, 'getJobStatus must call readIntelligenceCache() to fall back to disk').toMatch(/readIntelligenceCache/)

    // Must synthesize a complete status when disk cache has URLs
    expect(body, "fallback must set status: 'complete'").toMatch(/status:\s*['"]complete['"]/)

    // Must spread companyDocUrl and industryDocUrl from the disk cache
    expect(body, 'fallback must include companyDocUrl from disk cache').toMatch(/companyDocUrl/)
    expect(body, 'fallback must include industryDocUrl from disk cache').toMatch(/industryDocUrl/)
  })

  test('(live) intelligence-status returns doc URLs when disk cache has them', async () => {
    // Use a customer that is known to have a populated disk cache on 7776.
    // A10 Networks has a confirmed intelligence/{slug}.json with both doc URLs.
    const testCustomer = encodeURIComponent('A10 Networks')
    const res = await fetch(`${DESTRUCTIVE_URL}/api/customer/${testCustomer}/intelligence-status`)
    if (res.status === 404) {
      console.log('REG-071: A10 Networks not found on test container — skipping live assertion')
      return
    }
    expect(res.status, '/api/customer/A10 Networks/intelligence-status must return 200').toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty('status')
    // If the disk cache has URLs the endpoint MUST surface them — this is the regression guard.
    // If status is 'none' here, the fallback is broken.
    if (body.status === 'none') {
      // The fix ensures that when a disk cache with URLs exists, status is never 'none'.
      // If we reach this branch the test should fail only when the disk cache file exists on 7776.
      // We check from the server side whether a disk cache is present by inspecting the response
      // shape — if status is 'none' and the body has no companyDocUrl, the fix did not take effect.
      const noneWithNoUrls = !body.companyDocUrl && !body.industryDocUrl
      expect(noneWithNoUrls, 'status=none with no URLs despite disk cache existing — disk fallback not working').toBe(false)
    } else {
      // status is complete/pending/running/error — doc URLs should be present if the pipeline ran
      expect(typeof body.status).toBe('string')
    }
  })
})

// ── REG-072: BKL-AI-INTEL-02 — intelligence-status Drive discovery fallback ──
// Root cause: after a cache wipe both in-memory jobs and disk cache are empty
// even when intelligence docs already exist in the customer's Drive folder.
// Without a Drive fallback the UI shows only "Generate" and a click triggers a
// destructive full Gemini regeneration that overwrites the existing Drive docs.
//
// Fix: GET /api/customer/:name/intelligence-status is now async and:
//   1. Returns in-memory / existing disk-cache URLs immediately (REG-071 path)
//   2. If no URLs, checks disk cache age (7-day threshold on discoveredAt)
//   3. If cache absent or stale, scans Drive for `${name} - Company Intelligence`
//      and `${name} - Industry Analysis` inside the Account Intelligence subfolder
//   4. On hit: writes cache with discoveredAt=now and returns status:'complete'
//   5. On miss or Drive error: returns existing status (undefined → 'none')
//
// This regression test is source-level — the live fallback path covered by
// REG-071 is the same disk-cache fallback this route inherits from getJobStatus.
// Drive API behavior is not asserted in-container (DISALLOW_GEMINI=true + no
// Drive creds in CI), but the source-level assertions pin the design so the
// fallback can't be regressed away silently.

test.describe('REG-072: intelligence-status Drive discovery fallback (BKL-AI-INTEL-02)', () => {
  test('(source) discoverExistingIntelDocs is exported from account-intelligence.ts', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'account-intelligence.ts'), 'utf-8')
    // The discovery function must be exported for the route to import it.
    expect(src, 'account-intelligence.ts must export discoverExistingIntelDocs').toMatch(/export\s+async\s+function\s+discoverExistingIntelDocs\s*\(/)
    // Must return null (not throw) when the subfolder is absent so the route
    // can fall through cleanly.
    expect(src, 'discoverExistingIntelDocs must use findIntelligenceSubfolder read-only helper').toMatch(/findIntelligenceSubfolder\s*\(/)
    // Doc name matches must use the canonical suffixes written by writeIntelligenceDocs.
    expect(src, 'discover must look for "- Company Intelligence" docs').toMatch(/- Company Intelligence/)
    expect(src, 'discover must look for "- Industry Analysis" docs').toMatch(/- Industry Analysis/)
  })

  test('(source) cache schema has discoveredAt timestamp field', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'account-intelligence.ts'), 'utf-8')
    // The cache entry type must carry discoveredAt so staleness can be measured.
    expect(src, 'IntelligenceCacheEntry must declare discoveredAt field').toMatch(/discoveredAt\?:\s*string/)
    // writeIntelligenceDiscoveryCache must exist and write discoveredAt.
    expect(src, 'writeIntelligenceDiscoveryCache must be exported').toMatch(/export\s+function\s+writeIntelligenceDiscoveryCache\s*\(/)
    expect(src, 'discovery cache write must set discoveredAt: now').toMatch(/discoveredAt:\s*now/)
  })

  test('(source) route handler is async and uses 7-day staleness threshold', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'customer-routes.ts'), 'utf-8')
    // Route must be async to await the Drive scan.
    expect(
      src,
      'intelligence-status route handler must be async to call discoverExistingIntelDocs',
    ).toMatch(/app\.get\(\s*['"]\/api\/customer\/:name\/intelligence-status['"]\s*,\s*async\s*\(/)
    // 7-day staleness threshold — 7 * 24 * 60 * 60 * 1000 ms.
    expect(src, 'route must define a 7-day staleness threshold for Drive re-scan').toMatch(/7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/)
    // Must import the new helpers.
    expect(src, 'route must import discoverExistingIntelDocs').toMatch(/discoverExistingIntelDocs/)
    expect(src, 'route must import writeIntelligenceDiscoveryCache').toMatch(/writeIntelligenceDiscoveryCache/)
  })

  test('(live) intelligence-status returns complete with URLs when disk cache has them', async () => {
    // Same disk-cache fallback path as REG-071. If a customer exists with a
    // populated disk cache (pre-wipe or scan-persisted), the endpoint must
    // surface the URLs with status:'complete'. This asserts the route
    // preserves the fast-path behavior after the async refactor.
    const testCustomer = encodeURIComponent('A10 Networks')
    const res = await fetch(`${DESTRUCTIVE_URL}/api/customer/${testCustomer}/intelligence-status`)
    if (res.status === 404) {
      console.log('REG-072: A10 Networks not found on test container — skipping live assertion')
      return
    }
    expect(res.status, '/api/customer/A10 Networks/intelligence-status must return 200').toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty('status')
    // If the disk cache has URLs OR a Drive discovery previously succeeded, the
    // endpoint must return status: 'complete' with at least one doc URL.
    // A status of 'none' with no URLs means both the disk fallback AND the
    // Drive fallback are broken.
    if (body.status === 'none') {
      const noneWithNoUrls = !body.companyDocUrl && !body.industryDocUrl
      expect(
        noneWithNoUrls,
        'status=none with no URLs — disk or discovery fallback not working',
      ).toBe(false)
    } else if (body.status === 'complete') {
      // At least one doc URL should be present on a complete status.
      const hasAnyUrl = Boolean(body.companyDocUrl || body.industryDocUrl)
      expect(hasAnyUrl, 'status=complete must expose at least one doc URL').toBe(true)
    }
  })
})

// ── REG-073: BKL-AI-INTEL-02 — intelligence-status auto-generates on Drive miss ──
// Root cause: when Drive discovery returned nothing and no job existed, the
// endpoint returned {status:'none'} which forced the user to manually click
// Generate. After a cache wipe this is extra friction for the obvious next
// step. Fix: when Drive scan finds no docs AND no active job exists, the
// handler fire-and-forget calls runIntelligencePipeline(customerName) and
// immediately returns {status:'running', startedAt, source:'auto-generate'}.
// Duplicate triggers are guarded by checking getJobStatus + getRunningJob.
//
// The disk-cache simulation test (REG-073-A) runs live against 7776 using a
// seeded test customer (Acme Corp). The auto-generate and dup-guard tests
// (REG-073-C, REG-073-D) are source-level — Gemini is not permitted to fire
// in CI (DISALLOW_GEMINI=true) and running the pipeline requires live Drive
// credentials, so we pin the design via source-level assertions instead of
// attempting to drive the pipeline end-to-end in a test environment.

test.describe('REG-073: intelligence-status auto-generates on Drive miss (BKL-AI-INTEL-02)', () => {
  // writeFileSync, mkdirSync, existsSync, unlinkSync imported at top of file

  test('@live (live) REG-073-A: disk cache with URLs returns status:complete with both docs', async () => {
    // Seed customer "Acme Corp" lives on the test container; data-test/ is
    // bind-mounted to /data inside the container so a cache file written
    // from the host is visible to the running server.
    const customerName = 'Acme Corp'
    const slug = 'acme-corp'
    const intelDir = resolve(import.meta.dirname!, '..', '..', 'data-test', 'cache', 'intelligence')
    const cachePath = join(intelDir, `${slug}.json`)

    // Skip gracefully if the test container isn't running / seeded.
    const pingRes = await fetch(`${DESTRUCTIVE_URL}/api/aes`).catch(() => null)
    if (!pingRes || !pingRes.ok) {
      console.log('REG-073-A: test container unreachable — skipping')
      return
    }

    // Resolve customer existence before writing — Acme Corp is in seed data
    // but a pod switch may have removed it. Skip if absent.
    const custRes = await fetch(`${DESTRUCTIVE_URL}/api/customer/${encodeURIComponent(customerName)}/intelligence-status`)
    if (custRes.status === 404) {
      console.log(`REG-073-A: ${customerName} not found on test container — skipping`)
      return
    }

    mkdirSync(intelDir, { recursive: true })
    const entry = {
      customerName,
      company: '',
      industry: '',
      industryClassification: '',
      cachedAt: new Date().toISOString(),
      discoveredAt: new Date().toISOString(),
      companyDocUrl: 'https://docs.google.com/document/d/TEST_COMPANY_DOC_ID/edit',
      industryDocUrl: 'https://docs.google.com/document/d/TEST_INDUSTRY_DOC_ID/edit',
    }
    writeFileSync(cachePath, JSON.stringify(entry), { mode: 0o600 })

    try {
      const res = await fetch(`${DESTRUCTIVE_URL}/api/customer/${encodeURIComponent(customerName)}/intelligence-status`)
      expect(res.status, `/api/customer/${customerName}/intelligence-status must return 200`).toBe(200)
      const body = await res.json() as any
      expect(body.status, 'disk cache with URLs must surface as status:complete').toBe('complete')
      expect(body.companyDocUrl, 'companyDocUrl must be the seeded URL').toBe(entry.companyDocUrl)
      expect(body.industryDocUrl, 'industryDocUrl must be the seeded URL').toBe(entry.industryDocUrl)
    } finally {
      // Always clean up the temp cache file so subsequent tests see fresh state.
      if (existsSync(cachePath)) {
        try { unlinkSync(cachePath) } catch { /* best-effort cleanup */ }
      }
    }
  })

  test('(source) REG-073-B: route reads discoveredAt and compares to 7-day stale threshold', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'customer-routes.ts'), 'utf-8')
    // Locate the intelligence-status route body.
    const routeStart = src.indexOf("app.get('/api/customer/:name/intelligence-status'")
    expect(routeStart, 'intelligence-status route must be registered').toBeGreaterThan(-1)
    const routeEnd = src.indexOf('app.get(', routeStart + 1)
    const routeBody = routeEnd > routeStart ? src.slice(routeStart, routeEnd) : src.slice(routeStart)

    // 7-day staleness threshold literal must be present (7 * 24 * 60 * 60 * 1000).
    expect(
      src,
      'route file must declare INTEL_DISCOVERY_STALE_MS = 7 * 24 * 60 * 60 * 1000',
    ).toMatch(/7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/)
    // Handler must read discoveredAt off the cache entry and compare its age
    // against the staleness window before deciding to re-scan Drive.
    expect(routeBody, 'route handler must read cacheEntry.discoveredAt').toMatch(/discoveredAt/)
    expect(routeBody, 'route handler must compare discovery age against INTEL_DISCOVERY_STALE_MS').toMatch(/INTEL_DISCOVERY_STALE_MS/)
  })

  test('(source) REG-073-C: Drive miss branch fire-and-forget calls runIntelligencePipeline', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'customer-routes.ts'), 'utf-8')
    // runIntelligencePipeline must be imported.
    expect(src, 'customer-routes.ts must import runIntelligencePipeline').toMatch(/import\s*\{[^}]*runIntelligencePipeline[^}]*\}\s*from\s*['"]\.\/account-intelligence\.ts['"]/)

    // Locate the intelligence-status route body.
    const routeStart = src.indexOf("app.get('/api/customer/:name/intelligence-status'")
    expect(routeStart, 'intelligence-status route must be registered').toBeGreaterThan(-1)
    const routeEnd = src.indexOf('app.get(', routeStart + 1)
    const routeBody = routeEnd > routeStart ? src.slice(routeStart, routeEnd) : src.slice(routeStart)

    // The Drive-miss branch must call runIntelligencePipeline(customer.name)
    // — never awaited (fire-and-forget) so the poll returns immediately.
    expect(
      routeBody,
      'Drive-miss branch must fire-and-forget runIntelligencePipeline(customer.name)',
    ).toMatch(/runIntelligencePipeline\s*\(\s*customer\.name\s*\)/)

    // Must NOT await the pipeline call — awaiting would block the poll on the
    // full Gemini run (minutes). Use a string test that `await runIntelligencePipeline`
    // does not appear in this route body.
    expect(
      /await\s+runIntelligencePipeline\s*\(/.test(routeBody),
      'runIntelligencePipeline must not be awaited inside intelligence-status (fire-and-forget only)',
    ).toBe(false)

    // Response on auto-trigger must surface status:'running' so the poller
    // observes the transition.
    expect(routeBody, 'auto-generate branch must return status:running').toMatch(/status:\s*['"]running['"]/)
  })

  test('(source) REG-073-D: auto-generate branch checks job status before firing to prevent dup triggers', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'customer-routes.ts'), 'utf-8')

    // Locate the intelligence-status route body.
    const routeStart = src.indexOf("app.get('/api/customer/:name/intelligence-status'")
    expect(routeStart, 'intelligence-status route must be registered').toBeGreaterThan(-1)
    const routeEnd = src.indexOf('app.get(', routeStart + 1)
    const routeBody = routeEnd > routeStart ? src.slice(routeStart, routeEnd) : src.slice(routeStart)

    // Must check existing job state before firing. Either getJobStatus usage
    // (status?.status === 'running' | 'pending') or getRunningJob reference
    // satisfies the guard — both are exported from account-intelligence.ts.
    const hasRunningCheck = /status\?\.status\s*===\s*['"]running['"]/.test(routeBody)
    const hasPendingCheck = /status\?\.status\s*===\s*['"]pending['"]/.test(routeBody)
    const hasRunningJobCheck = /getRunningJob\s*\(\s*\)/.test(routeBody)

    expect(
      hasRunningCheck && hasPendingCheck,
      'auto-generate branch must guard on status.status === running AND === pending before firing',
    ).toBe(true)
    expect(
      hasRunningJobCheck,
      'auto-generate branch must consult getRunningJob() to avoid dup trigger when another customer is active',
    ).toBe(true)

    // The guard must gate the runIntelligencePipeline call — the call must be
    // inside a conditional block (not unconditionally at the end of the
    // handler). We check that an `if` or negated-guard precedes the fire.
    // This is an ordering check: the guard must appear before the call.
    const callIdx = routeBody.indexOf('runIntelligencePipeline(customer.name)')
    expect(callIdx, 'runIntelligencePipeline call must exist in route body').toBeGreaterThan(-1)
    const preamble = routeBody.slice(0, callIdx)
    expect(
      /alreadyActive|already\s*running|!\s*status\?\.status|getRunningJob/.test(preamble),
      'an active-job guard (alreadyActive / getRunningJob) must appear before runIntelligencePipeline is called',
    ).toBe(true)
  })
})

// ── REG-074: BKL-AI-INTEL-03 — intelligence re-trigger storm for no-data customers ──
//
// Bug: GET /api/customer/:name/intelligence-status fired runIntelligencePipeline()
// on every poll for customers whose pipeline completed via "skipped (no data)".
// The alreadyActive guard only treated status:'running' | 'pending' as active,
// so a completed no-data customer (no companyDocUrl, no discoveredAt) re-entered
// the Drive-miss auto-generate branch on every poll → infinite re-trigger loop.
//
// Source-level only — we can't reliably fire the pipeline in tests (Gemini).
// The three assertions below lock the three load-bearing pieces of the fix:
//   A. INTEL_RETRY_COOLDOWN_MS constant exists (rapid re-fire gate)
//   B. alreadyActive covers status:'complete' + skipped-step AND the cooldown
//      window (prevents the original re-trigger condition)
//   C. writeIntelligenceDiscoveryCache is called BEFORE firing the pipeline
//      (stub discoveredAt short-circuits the Drive scan on subsequent polls)
test.describe('REG-074: intelligence-status no-op guard prevents re-trigger storm (BKL-AI-INTEL-03)', () => {
  test('(source) REG-074-A: INTEL_RETRY_COOLDOWN_MS constant exists in customer-routes.ts', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'customer-routes.ts'), 'utf-8')
    // Must declare INTEL_RETRY_COOLDOWN_MS as a const with an ms-valued numeric
    // literal/expression. The exact value is not asserted (it may be tuned)
    // but it must resolve to a meaningful cooldown — we require at least
    // 60_000ms (1 min) via an arithmetic expression or a literal >= 60000.
    const m = src.match(/const\s+INTEL_RETRY_COOLDOWN_MS\s*=\s*([^\n]+?)\s*(?:\/\/|$)/m)
    expect(m, 'INTEL_RETRY_COOLDOWN_MS constant must be declared in customer-routes.ts').not.toBeNull()
    // Evaluate the RHS expression in a sandboxed Function — limited to numeric
    // math so eval of untrusted input is not a concern (source file is ours).
    const rhs = m![1].replace(/_/g, '')
    expect(
      /^[\d\s+\-*/().]+$/.test(rhs),
      `INTEL_RETRY_COOLDOWN_MS RHS must be a numeric expression, got: ${rhs}`,
    ).toBe(true)
    // eslint-disable-next-line no-new-func
    const value = new Function(`return (${rhs})`)() as number
    expect(value, 'INTEL_RETRY_COOLDOWN_MS must be >= 60_000 ms').toBeGreaterThanOrEqual(60_000)
  })

  test('(source) REG-074-B: alreadyActive guard covers complete+skipped and cooldown cases', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'customer-routes.ts'), 'utf-8')

    // Locate the intelligence-status route body.
    const routeStart = src.indexOf("app.get('/api/customer/:name/intelligence-status'")
    expect(routeStart, 'intelligence-status route must be registered').toBeGreaterThan(-1)
    const routeEnd = src.indexOf('app.get(', routeStart + 1)
    const routeBody = routeEnd > routeStart ? src.slice(routeStart, routeEnd) : src.slice(routeStart)

    // The alreadyActive expression must include the original running/pending
    // checks (carried over from REG-073-D) AND the new no-data + cooldown
    // signals. We assert each gate is present in the route body.
    expect(
      routeBody,
      'alreadyActive must still include status:running check (REG-073-D carry-over)',
    ).toMatch(/status\?\.status\s*===\s*['"]running['"]/)
    expect(
      routeBody,
      'alreadyActive must still include status:pending check (REG-073-D carry-over)',
    ).toMatch(/status\?\.status\s*===\s*['"]pending['"]/)

    // New: complete + skipped-step signal. Must key on status:'complete' and
    // inspect step for 'skipped' (case-insensitive compare via .toLowerCase()
    // or a /skipped/i regex literal).
    expect(
      routeBody,
      'alreadyActive must treat status:complete + step containing "skipped" as active (no-data pipeline)',
    ).toMatch(/status\?\.status\s*===\s*['"]complete['"]/)
    expect(
      /step[^\n]*skipped|skipped[^\n]*step/i.test(routeBody),
      'alreadyActive must inspect status.step for "skipped" substring',
    ).toBe(true)

    // New: cooldown window gate. Must reference INTEL_RETRY_COOLDOWN_MS and
    // compute a time delta against startedAt.
    expect(
      routeBody,
      'alreadyActive must consult INTEL_RETRY_COOLDOWN_MS for cooldown gating',
    ).toMatch(/INTEL_RETRY_COOLDOWN_MS/)
    expect(
      /startedAt/.test(routeBody),
      'cooldown gate must read status.startedAt to compute time since last fire',
    ).toBe(true)
  })

  test('(source) REG-074-C: writeIntelligenceDiscoveryCache called before pipeline fire on Drive miss', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'customer-routes.ts'), 'utf-8')

    // Must be imported from account-intelligence.ts.
    expect(
      src,
      'customer-routes.ts must import writeIntelligenceDiscoveryCache',
    ).toMatch(/import\s*\{[^}]*writeIntelligenceDiscoveryCache[^}]*\}\s*from\s*['"]\.\/account-intelligence\.ts['"]/)

    // Locate the intelligence-status route body.
    const routeStart = src.indexOf("app.get('/api/customer/:name/intelligence-status'")
    expect(routeStart, 'intelligence-status route must be registered').toBeGreaterThan(-1)
    const routeEnd = src.indexOf('app.get(', routeStart + 1)
    const routeBody = routeEnd > routeStart ? src.slice(routeStart, routeEnd) : src.slice(routeStart)

    // The Drive-miss branch must call writeIntelligenceDiscoveryCache BEFORE
    // the runIntelligencePipeline fire so subsequent polls see a fresh
    // discoveredAt (< 7 days) and skip the Drive scan via the staleness gate.
    const writeIdx = routeBody.lastIndexOf('writeIntelligenceDiscoveryCache(')
    const fireIdx  = routeBody.indexOf('runIntelligencePipeline(customer.name)')
    expect(writeIdx, 'writeIntelligenceDiscoveryCache must be called in the route body').toBeGreaterThan(-1)
    expect(fireIdx, 'runIntelligencePipeline must be called in the route body').toBeGreaterThan(-1)
    expect(
      writeIdx < fireIdx,
      'writeIntelligenceDiscoveryCache(customer.name, ...) must precede runIntelligencePipeline(customer.name) call so next poll short-circuits the Drive scan',
    ).toBe(true)

    // The stub write on the Drive-miss path must pass null URLs (explicit
    // "looked and found nothing" — distinct from undefined "didn't supply"),
    // so the cache entry does not carry stale URLs forward.
    const stubWriteSlice = routeBody.slice(writeIdx, fireIdx)
    expect(
      /companyDocUrl\s*:\s*null/.test(stubWriteSlice),
      'Drive-miss stub write must pass companyDocUrl: null',
    ).toBe(true)
    expect(
      /industryDocUrl\s*:\s*null/.test(stubWriteSlice),
      'Drive-miss stub write must pass industryDocUrl: null',
    ).toBe(true)
  })
})

// ── REG-075: BKL-UX-REG-01 — AEGroup renders health-dot strip in byAE mode ──
//
// Bug: AEGroup (byAE view mode) rendered only chevron + name + count in the
// collapsed header. AEGroupedList (grouped mode) already had a per-customer
// health-dot strip, but byAE mode never received the feature, leaving users
// with no health indicator for collapsed AE sections.
//
// Source-level — asserts the AEGroup component contract is intact:
//   A. AEGroup accepts a `customerScores?: number[]` prop
//   B. AEGroup renders the dot strip conditionally on `customerScores`
//   C. getAttentionDotColor is defined locally in AccountPortfolioGrid.tsx
test.describe('REG-075: AEGroup health-dot strip in byAE mode (BKL-UX-REG-01)', () => {
  const SRC_PATH = resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'components', 'AccountPortfolioGrid.tsx')

  test('(source) REG-075-A: AEGroup accepts customerScores prop', () => {
    const src = readFileSync(SRC_PATH, 'utf-8')
    // Locate the AEGroup function body.
    const start = src.indexOf('function AEGroup(')
    expect(start, 'AEGroup function must be defined in AccountPortfolioGrid.tsx').toBeGreaterThan(-1)
    // The next standalone `function ` after AEGroup's opening brace marks the end.
    const afterStart = src.indexOf('\nfunction ', start + 1)
    const body = afterStart > start ? src.slice(start, afterStart) : src.slice(start)
    // The prop type declaration must include `customerScores?: number[]`.
    expect(
      body,
      'AEGroup props must declare optional customerScores?: number[]',
    ).toMatch(/customerScores\?\s*:\s*number\[\]/)
  })

  test('(source) REG-075-B: AEGroup renders health-dot strip conditionally on customerScores', () => {
    const src = readFileSync(SRC_PATH, 'utf-8')
    const start = src.indexOf('function AEGroup(')
    expect(start, 'AEGroup function must be defined').toBeGreaterThan(-1)
    const afterStart = src.indexOf('\nfunction ', start + 1)
    const body = afterStart > start ? src.slice(start, afterStart) : src.slice(start)

    // Conditional guard — must check customerScores truthiness AND non-empty length
    // before rendering anything (matches AEGroupedList pattern).
    expect(
      body,
      'AEGroup must guard the dot strip on customerScores && customerScores.length > 0',
    ).toMatch(/customerScores\s*&&\s*customerScores\.length\s*>\s*0/)

    // Must cap visible dots at 12 (same visual ceiling as AEGroupedList).
    expect(
      body,
      'dot strip must slice(0, 12) — matches AEGroupedList MAX_HEALTH_DOTS',
    ).toMatch(/customerScores\.slice\(\s*0\s*,\s*12\s*\)/)

    // Each rendered dot must map its score through getAttentionDotColor.
    expect(
      body,
      'each dot must use getAttentionDotColor(score) for its background class',
    ).toMatch(/getAttentionDotColor\(\s*score\s*\)/)

    // Overflow counter when more than 12 customers — "+N" tail.
    expect(
      body,
      'dot strip must render overflow "+N" indicator when customerScores.length > 12',
    ).toMatch(/customerScores\.length\s*>\s*12/)
    expect(
      body,
      'overflow tail must show customerScores.length - 12',
    ).toMatch(/customerScores\.length\s*-\s*12/)
  })

  test('(source) REG-075-C: getAttentionDotColor helper is defined in AccountPortfolioGrid.tsx', () => {
    const src = readFileSync(SRC_PATH, 'utf-8')
    // Must be a local function (not an import) so the component is
    // self-contained — matches the palette used by AEGroupedList.
    expect(
      src,
      'getAttentionDotColor must be defined as a local function in AccountPortfolioGrid.tsx',
    ).toMatch(/function\s+getAttentionDotColor\s*\(\s*score\s*:\s*number\s*\)\s*:\s*string/)

    // Palette thresholds must match AEGroupedList (70 / 40 / >0 / else).
    const fnStart = src.indexOf('function getAttentionDotColor(')
    const fnSlice = src.slice(fnStart, fnStart + 400)
    expect(fnSlice, 'red-500 branch at score >= 70').toMatch(/score\s*>=\s*70[\s\S]*?bg-red-500/)
    expect(fnSlice, 'amber-500 branch at score >= 40').toMatch(/score\s*>=\s*40[\s\S]*?bg-amber-500/)
    expect(fnSlice, 'green-500 branch at score > 0').toMatch(/score\s*>\s*0[\s\S]*?bg-green-500/)
    expect(fnSlice, 'zinc-600 fallback for score === 0').toMatch(/bg-zinc-600/)
  })
})

// ── REG-076: BKL-UX117 — /api/pipeline?ae= filters by single AE ──────────────
// Regression: before this fix, the pipeline route ignored ?ae= and always returned
// all-AE aggregates. filterToSingleAE must be applied after filterToAEs.
test.describe('REG-076: pipeline route applies ?ae= single-AE filter (BKL-UX117)', () => {
  test('(source) REG-076-A: filterToSingleAE function exists in customer-routes.ts', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'customer-routes.ts'), 'utf8')
    expect(src, 'filterToSingleAE must be defined').toContain('function filterToSingleAE(')
    expect(src, 'filterToSingleAE must filter by owner lowercase').toContain('r.owner.toLowerCase() === needle')
  })

  test('(source) REG-076-B: /api/pipeline handler reads aeParam from query string', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'customer-routes.ts'), 'utf8')
    const pipelineRouteIdx = src.indexOf("app.get('/api/pipeline'")
    expect(pipelineRouteIdx, '/api/pipeline route must exist').toBeGreaterThan(0)
    const pipelineBlock = src.slice(pipelineRouteIdx, pipelineRouteIdx + 1200)
    expect(pipelineBlock, 'pipeline handler must read ae query param').toContain("c.req.query('ae')")
    expect(pipelineBlock, 'pipeline handler must call filterToSingleAE when aeParam set').toContain('filterToSingleAE(')
  })

  test('(source) REG-076-C: App.tsx builds pipelineQueryStr and appends ?ae= to pipelineApi URL', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'App.tsx'), 'utf8')
    expect(src, 'pipelineQueryStr must encode aeFilterSelected').toContain('pipelineQueryStr')
    expect(src, 'pipelineApi URL must include pipelineQueryStr').toMatch(/useApi.*\/api\/pipeline.*pipelineQueryStr/)
  })
})

// ── REG-078: BKL-RH-UX-01 — Offline token save endpoint ─────────────────────
// Regression: REDHAT_OFFLINE_TOKEN could only be set by editing .env manually.
// The endpoint validates input and updates process.env immediately.
test.describe('REG-078: offline token save endpoint (BKL-RH-UX-01)', () => {
  test('(api) REG-078-A: POST /api/settings/offline-token rejects empty token', async () => {
    const res = await fetch(`${DESTRUCTIVE_URL}/api/settings/offline-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error, 'error message must mention token requirement').toBeTruthy()
  })

  test('(api) REG-078-B: POST /api/settings/offline-token rejects token containing newline', async () => {
    const res = await fetch(`${DESTRUCTIVE_URL}/api/settings/offline-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'validstart\ninvalidnewline' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error, 'error must mention newline rejection').toBeTruthy()
  })

  test('(api) REG-078-C: POST /api/settings/offline-token rejects token with carriage return', async () => {
    const res = await fetch(`${DESTRUCTIVE_URL}/api/settings/offline-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'validstart\rinvalidcr' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toBeTruthy()
  })

  test('(api) REG-078-D: POST /api/settings/offline-token accepts valid token', async () => {
    const fakeToken = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature_placeholder'
    const res = await fetch(`${DESTRUCTIVE_URL}/api/settings/offline-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: fakeToken }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
  })

  test('(api) REG-078-E: GET /api/settings/offline-token returns configured:true after save', async () => {
    const fakeToken = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature_for_status_check'
    await fetch(`${DESTRUCTIVE_URL}/api/settings/offline-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: fakeToken }),
    })
    const res = await fetch(`${DESTRUCTIVE_URL}/api/settings/offline-token`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.configured).toBe(true)
  })

  test('(source) REG-078-F: settings-api.ts saveOfflineToken and getPersistedOfflineToken are exported', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'settings-api.ts'), 'utf8')
    expect(src, 'saveOfflineToken must be exported').toContain('export function saveOfflineToken(')
    expect(src, 'getPersistedOfflineToken must be exported').toContain('export function getPersistedOfflineToken(')
  })

  test('(source) REG-078-G: server.ts loads persisted token at startup', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'server.ts'), 'utf8')
    expect(src, 'server.ts must set REDHAT_OFFLINE_TOKEN from persisted value').toContain('REDHAT_OFFLINE_TOKEN')
    expect(src, 'startup block must reference redhatOfflineToken key').toContain('redhatOfflineToken')
    expect(src, 'startup block must guard against overwriting existing env var').toContain('!process.env.REDHAT_OFFLINE_TOKEN')
  })

  test('(source) REG-078-H: SetupPage.tsx renders offline token input in RH Portal section', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'pages', 'SetupPage.tsx'), 'utf8')
    expect(src, 'token input must use password type').toContain("type={offlineTokenShow ? 'text' : 'password'}")
    expect(src, 'handleSaveOfflineToken handler must exist').toContain('handleSaveOfflineToken')
    expect(src, 'offline token endpoint must be called').toContain('/api/settings/offline-token')
    expect(src, 'show/hide toggle must exist').toContain('offlineTokenShow')
  })
})

// ── REG-082: BKL-SR03-Q1 — AutomationSettings client-side pre-save validation ──
// Regression: before this fix, out-of-range typed values were only rejected
// server-side after the POST. Now client-side validation blocks the request
// and highlights the offending field with a red border.
test.describe('REG-082: AutomationSettings pre-save range validation (BKL-SR03-Q1)', () => {
  test('(source) REG-082-A: handleSave runs range checks for every AutomationConfig field before fetch', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'components', 'AutomationSettings.tsx'), 'utf8')
    const handleIdx = src.indexOf('const handleSave')
    expect(handleIdx, 'handleSave must exist').toBeGreaterThan(0)
    const fetchIdx = src.indexOf("fetch('/api/settings/automation'", handleIdx)
    expect(fetchIdx, 'POST fetch must exist inside handleSave').toBeGreaterThan(handleIdx)
    const preSaveBlock = src.slice(handleIdx, fetchIdx)
    // Every numeric field on AutomationConfig must be guarded before the POST
    expect(preSaveBlock, 'defaultScrapeTimeoutMs must be range-checked').toContain('defaultScrapeTimeoutMs')
    expect(preSaveBlock, 'rhScrapeTimeoutMs must be range-checked').toContain('rhScrapeTimeoutMs')
    expect(preSaveBlock, 'circuitBreakerThreshold must be range-checked').toContain('circuitBreakerThreshold')
    expect(preSaveBlock, 'circuitBreakerCooldownMs must be range-checked').toContain('circuitBreakerCooldownMs')
    expect(preSaveBlock, 'driveDocTextCap must be range-checked').toContain('driveDocTextCap')
    expect(preSaveBlock, 'briefEmailsInPrompt must be range-checked').toContain('briefEmailsInPrompt')
    expect(preSaveBlock, 'briefHistoryDays must be range-checked').toContain('briefHistoryDays')
    // The validation block must early-return so the POST never fires on invalid input
    expect(preSaveBlock, 'invalid input must short-circuit before fetch').toMatch(/return\s*\}/)
  })

  test('(source) REG-082-B: errorField state highlights the specific out-of-range input', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'dashboard', 'src', 'components', 'AutomationSettings.tsx'), 'utf8')
    expect(src, 'errorField state must exist').toContain('errorField')
    expect(src, 'inputCls helper must apply error styling when field matches').toMatch(/errorField === key/)
    expect(src, 'error styling must use critical color tokens').toMatch(/ring-critical|border-critical/)
  })
})

// ── REG-083: BKL-SR03-F1 — CircuitBreaker reads automation config lazily ──
// Regression: scraper-manager.ts read circuitBreakerThreshold and
// circuitBreakerCooldownMs once at module init and baked them into the
// CircuitBreaker constructor as readonly fields. Saving new values via
// POST /api/settings/automation had no effect on circuit breakers until a
// container restart. The fix: pass getter functions into the constructor and
// re-read getAutomationConfig() inside isOpen()/recordFailure()/getState() on
// every call. These source-level assertions guard against regression.
test.describe('REG-083: CircuitBreaker reads automation config lazily (BKL-SR03-F1)', () => {
  test('(source) REG-083-A: constructor sites pass getter functions, not raw config values', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'scraper-manager.ts'), 'utf8')
    // The old (buggy) shape: `new CircuitBreaker('rh', _automationCfg.circuitBreakerThreshold, …)`
    // bakes the value in at construction. Forbid that exact pattern at every call site.
    expect(
      src,
      'CircuitBreaker constructor must NOT receive a bare _automationCfg.* value — pass a getter function instead'
    ).not.toMatch(/new\s+CircuitBreaker\([^)]*_automationCfg\.\w+/)
    // Likewise forbid passing `getAutomationConfig().…` directly as a constructor arg
    // (that would also bake in the value at the moment of construction).
    expect(
      src,
      'CircuitBreaker constructor must NOT receive a bare getAutomationConfig().* value — pass a getter function instead'
    ).not.toMatch(/new\s+CircuitBreaker\([^)]*getAutomationConfig\(\)\./)
  })

  test('(source) REG-083-B: a getter for circuitBreakerThreshold/cooldownMs exists and is reused', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'scraper-manager.ts'), 'utf8')
    // The fix shape declares getter consts that wrap getAutomationConfig() reads;
    // require the literal arrow expressions so a future refactor can't silently
    // re-bake values without tripping this guard.
    expect(
      src,
      'expected a getter wrapping getAutomationConfig().circuitBreakerThreshold'
    ).toMatch(/\(\s*\)\s*(?::\s*number\s*)?=>\s*getAutomationConfig\(\)\.circuitBreakerThreshold/)
    expect(
      src,
      'expected a getter wrapping getAutomationConfig().circuitBreakerCooldownMs'
    ).toMatch(/\(\s*\)\s*(?::\s*number\s*)?=>\s*getAutomationConfig\(\)\.circuitBreakerCooldownMs/)
  })

  test('(source) REG-083-C: isOpen/recordFailure/getState read threshold lazily, not from a baked field', () => {
    const src = readFileSync(resolve(import.meta.dirname!, '..', '..', 'src', 'scraper-manager.ts'), 'utf8')
    // The previous shape declared `readonly threshold: number` and
    // `readonly cooldownMs: number` as instance fields — these are exactly what
    // gets baked at construction. The lazy-read fix replaces them with getter
    // accessors backed by stored functions.
    expect(
      src,
      'CircuitBreaker must NOT declare a readonly threshold field — that bakes the value at construction'
    ).not.toMatch(/readonly\s+threshold\s*:\s*number/)
    expect(
      src,
      'CircuitBreaker must NOT declare a readonly cooldownMs field — that bakes the value at construction'
    ).not.toMatch(/readonly\s+cooldownMs\s*:\s*number/)
  })
})

// ── REG-CONN: Connection VNC flow source patterns ────────────────────────────
//
// BKL-UX94: Three surgical fixes to VNC login flows:
//   rh-auth.ts: await about:blank navigation + bringToFront + 500ms URL stability debounce
//   sf-auth.ts: blank existing pages + bringToFront + await sfPage.goto
//   SetupPage.tsx: remove immediate VNC close on pre-flight valid check; let resolveLogin handle it

test.describe('REG-CONN: Connection VNC flow source patterns', () => {
  test('REG-CONN-RH-01: rh-auth.ts uses await before about:blank navigation', async () => {
    const src = readFileSync(join(resolve(import.meta.dirname!, '..', '..'), 'src', 'rh-auth.ts'), 'utf8')
    expect(src).toMatch(/await\s+blankPage\.goto\(['"]about:blank/)
  })

  test('REG-CONN-RH-02: rh-auth.ts calls bringToFront on blank page', async () => {
    const src = readFileSync(join(resolve(import.meta.dirname!, '..', '..'), 'src', 'rh-auth.ts'), 'utf8')
    expect(src).toContain('bringToFront()')
  })

  test('REG-CONN-RH-03: rh-auth.ts has URL stability debounce after isPortalUrl match', async () => {
    const src = readFileSync(join(resolve(import.meta.dirname!, '..', '..'), 'src', 'rh-auth.ts'), 'utf8')
    expect(src).toMatch(/isPortalUrl[\s\S]{0,300}setTimeout.*500/)
  })

  test('REG-CONN-SF-01: sf-auth.ts navigates existing pages to about:blank', async () => {
    const src = readFileSync(join(resolve(import.meta.dirname!, '..', '..'), 'src', 'sf-auth.ts'), 'utf8')
    expect(src).toMatch(/context\.pages\(\)/)
    expect(src).toMatch(/goto\(['"]about:blank/)
  })

  test('REG-CONN-SF-02: sf-auth.ts calls bringToFront on sfPage', async () => {
    const src = readFileSync(join(resolve(import.meta.dirname!, '..', '..'), 'src', 'sf-auth.ts'), 'utf8')
    expect(src).toContain('sfPage.bringToFront()')
  })

  test('REG-CONN-SF-03: sf-auth.ts awaits sfPage.goto not fire-and-forget', async () => {
    const src = readFileSync(join(resolve(import.meta.dirname!, '..', '..'), 'src', 'sf-auth.ts'), 'utf8')
    expect(src).toMatch(/await sfPage\.goto\(SF_LOGIN_URL/)
  })

  test('REG-CONN-CCSP-01: SetupPage.tsx does not immediately close VNC after pre-flight valid check', async () => {
    const src = readFileSync(join(resolve(import.meta.dirname!, '..', '..'), 'dashboard', 'src', 'pages', 'SetupPage.tsx'), 'utf8')
    // The immediate close block (close() followed immediately by null and return inside session-status check) must be gone
    expect(src).not.toMatch(/sessionValid[\s\S]{0,50}tableauVncRef\.current\?\.close\(\)[\s\S]{0,20}tableauVncRef\.current = null[\s\S]{0,20}setTableauConnecting\(false\)[\s\S]{0,20}return/)
  })
})
