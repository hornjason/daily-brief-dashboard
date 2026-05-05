// Manual/nightly E2E gate — not for CI. Requires real Drive auth in data-test/
// and live Vertex AI access (Gemini via the project's Google Cloud scope).
//
// Runs against the test container (port 7776) using the `test` Playwright project.
// The hero image (Dockerfile.hero) provides a pure HTTP server — no Playwright/VNC,
// no L4 scrapers. Drive auth is the ONLY pre-flight check; RH Portal, Tableau,
// and VPN are gone. settings.json ships baked-in with the regions catalog so
// region selection is pre-seeded in beforeAll and skipped during the wizard.
//
// Required env vars (test.skip()s when missing):
//   TEST_DRIVE_PARENT_URL — Google Drive folder URL to use as the parent folder
//   TEST_AE_NAME          — AE name to seed (must match the test territory sheet)
//
// Optional env vars:
//   TEST_URL              — overrides http://localhost:7776
//   TEST_REGION           — defaults to 'west-commercial'
//   TEST_POD              — defaults to 'west-commercial.WEST_COMM_CORP_NORTHWEST'
//   TEST_TERRITORY        — territory code, e.g. '01'
//   TEST_SF_REPORT_ID     — Salesforce report ID for the AE
//
// Run:
//   TEST_DRIVE_PARENT_URL=https://drive.google.com/drive/folders/... \
//   TEST_AE_NAME='Carolanne Farrell' \
//   npx playwright test test/bootstrap-e2e.spec.ts --project=test
import { test, expect } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'

const DRIVE_PARENT_URL = process.env.TEST_DRIVE_PARENT_URL ?? ''
const AE_NAME = process.env.TEST_AE_NAME ?? ''
const REGION = process.env.TEST_REGION ?? 'west-commercial'
const POD = process.env.TEST_POD ?? 'west-commercial.WEST_COMM_CORP_NORTHWEST'
const TERRITORY = process.env.TEST_TERRITORY ?? '01'
const SF_REPORT_ID = process.env.TEST_SF_REPORT_ID ?? ''

const HAS_LIVE_DATA = Boolean(DRIVE_PARENT_URL && AE_NAME)

// Bootstrap can take 10+ minutes end-to-end; intelligence pipeline adds another 5+.
test.describe.configure({ mode: 'serial' })
test.setTimeout(20 * 60 * 1000)

// ── Helpers ─────────────────────────────────────────────────────────────────

async function pollUntil<T>(
  label: string,
  fn: () => Promise<{ done: boolean; value?: T }>,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<T | null> {
  const deadline = Date.now() + opts.timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fn()
      if (res.done) return res.value ?? null
    } catch {
      // swallow — keep polling until timeout
    }
    await new Promise(r => setTimeout(r, opts.intervalMs))
  }
  throw new Error(`pollUntil timed out: ${label}`)
}

async function getJSON(request: APIRequestContext, path: string): Promise<{ status: number; body: any }> {
  const res = await request.get(`${BASE}${path}`)
  let body: any = null
  try { body = await res.json() } catch { /* tolerate non-JSON */ }
  return { status: res.status(), body }
}

async function postJSON(request: APIRequestContext, path: string, data: unknown = {}): Promise<{ status: number; body: any }> {
  const res = await request.post(`${BASE}${path}`, { data })
  let body: any = null
  try { body = await res.json() } catch { /* tolerate non-JSON */ }
  return { status: res.status(), body }
}

// ── beforeAll: seed region access, reset state ──────────────────────────────

test.beforeAll(async ({ request }) => {
  // 1) Pre-seed region/POD selection so the wizard skips Step 0.
  const regionRes = await postJSON(request, '/api/regions/access', {
    enabledRegions: [REGION],
    enabledPods: [POD],
  })
  expect(regionRes.status, `region/access seeding failed: ${JSON.stringify(regionRes.body)}`).toBeLessThan(400)

  // 2) Wipe AE/customer/cache state on the test container.
  const resetRes = await postJSON(request, '/api/setup/reset')
  expect(resetRes.status).toBeLessThan(400)

  // 3) Confirm clean slate.
  const aes = await getJSON(request, '/api/aes')
  expect(aes.status).toBe(200)
  expect(Array.isArray(aes.body?.aes)).toBe(true)
  expect(aes.body.aes.length, 'aes.json was not cleared by /api/setup/reset').toBe(0)
})

// ── Pre-flight: Drive auth (only required external dep on the hero image) ───

test('drive auth — Google session is connected', async ({ request }) => {
  const { status, body } = await getJSON(request, '/api/auth/google/status')
  if (status === 404) test.skip(true, '/api/auth/google/status not present on this build')
  expect(status).toBe(200)
  // Tolerate either { hasSession } or { connected } shape — the canonical
  // signal is "Drive is reachable", not the exact field name.
  const ok = body?.hasSession === true || body?.connected === true || body?.driveReady === true
  expect(ok, `Google/Drive not connected. body=${JSON.stringify(body)}`).toBe(true)
})

// ── Wizard: validate Drive folder ───────────────────────────────────────────

test('wizard — drive folder validate', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  // POST /api/aes/validate-folder — checks the parent Drive folder is reachable
  // and writable. If endpoint shape differs, accept either { ok } or 200.
  const { status, body } = await postJSON(request, '/api/aes/validate-folder', {
    folderUrl: DRIVE_PARENT_URL,
  })
  expect(status, `validate-folder failed: ${JSON.stringify(body)}`).toBeLessThan(400)
  const ok = body?.ok === true || body?.valid === true || body?.folderId
  expect(ok, `validate-folder body shape unexpected: ${JSON.stringify(body)}`).toBeTruthy()
})

// ── Wizard: create AE via /api/aes ──────────────────────────────────────────

test('wizard — ae setup', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  // Submit the AE config the same way the wizard does — POST /api/aes with
  // the territory/POD pre-selected so live lookup hydrates customer list +
  // sheet IDs inside the bootstrap flow.
  const submitRes = await postJSON(request, '/api/aes', {
    aes: [{
      name: AE_NAME,
      pod: POD,
      territory: TERRITORY,
      parentFolderUrl: DRIVE_PARENT_URL,
      sfReportId: SF_REPORT_ID,
    }],
  })
  expect(submitRes.status, `POST /api/aes failed: ${JSON.stringify(submitRes.body)}`).toBeLessThan(400)

  // Confirm AE persisted with Drive folder + the three required sheet IDs.
  // Sheet IDs are populated by bootstrap; if AE is created synchronously
  // they may be empty here — assert presence after bootstrap completes
  // ("bootstrap completes" test below).
  const { body } = await getJSON(request, '/api/aes')
  const ae = body.aes.find((a: any) => a.name === AE_NAME)
  expect(ae, `${AE_NAME} not found in /api/aes after wizard submit`).toBeDefined()
  expect(ae.driveFolderId || ae.parentFolderId, 'AE has no Drive folder id at all').toBeTruthy()
})

// ── Bootstrap: 5-step pipeline completes ────────────────────────────────────

test('bootstrap completes', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  // Bootstrap may be auto-fired by /api/aes; if not, fire it explicitly.
  const initial = await getJSON(request, '/api/bootstrap/auto/status')
  if (!initial.body?.running && !initial.body?.completedAt) {
    const start = await postJSON(request, '/api/bootstrap/auto', { aeName: AE_NAME })
    expect(start.status, `POST /api/bootstrap/auto failed: ${JSON.stringify(start.body)}`).toBeLessThan(500)
  }

  // Poll up to 10 minutes for completion.
  const final = await pollUntil<any>(
    'bootstrap auto status',
    async () => {
      const res = await getJSON(request, '/api/bootstrap/auto/status')
      const b = res.body
      if (!b) return { done: false }
      if (b.completedAt || (!b.running && Array.isArray(b.steps) && b.steps.length > 0)) {
        return { done: true, value: b }
      }
      return { done: false }
    },
    { timeoutMs: 10 * 60 * 1000, intervalMs: 5_000 },
  )

  expect(final, 'bootstrap never reached a terminal state').toBeTruthy()
  expect(final.error, `bootstrap error: ${final.error}`).toBeFalsy()
  // No step should be in 'error' status. We don't pin the exact step count —
  // the hero image runs 5 steps today but the count may evolve.
  const errored = (final.steps as Array<{ status: string; name?: string }>)
    .filter(s => s.status === 'error')
  expect(errored, `bootstrap step(s) errored: ${JSON.stringify(errored)}`).toHaveLength(0)
})

// ── Drive scaffold cache populated ──────────────────────────────────────────

test('drive scaffold created', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  const { status, body } = await getJSON(request, '/api/bootstrap/scaffold-status')
  expect(status).toBe(200)
  expect(body.configFolderId, 'scaffold-status.configFolderId is null after bootstrap').toBeTruthy()
  expect(body.productsFolderId, 'scaffold-status.productsFolderId is null after bootstrap').toBeTruthy()
  expect(typeof body.productSubfolders).toBe('object')
  expect(
    Object.keys(body.productSubfolders).length,
    'productSubfolders empty — Products/<slug> scaffolding did not capture any subfolders',
  ).toBeGreaterThan(0)
})

// ── Intelligence: fire EARLY so Gemini runs while later sync tests execute ──

test('intelligence — fire generation', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  // Pick the first customer for the seeded AE.
  const cust = await getJSON(request, '/customers')
  const customers = (cust.body as any[]).filter(c => c?.ae === AE_NAME)
  test.skip(customers.length === 0, `no customers found for ae=${AE_NAME} (bootstrap likely seeded zero)`)

  const target = customers[0].name as string
  const fire = await postJSON(
    request,
    `/api/customer/${encodeURIComponent(target)}/generate-intelligence?force=true`,
  )
  // 202 (queued), 200 (started), or 503 (intelligenceEnabled=false) all acceptable;
  // 503 is a soft skip because nothing in the hero image lifecycle disables it,
  // but the assertion makes the failure mode explicit.
  expect([200, 202, 503]).toContain(fire.status)
  if (fire.status === 503) test.skip(true, 'intelligence disabled in AI settings — re-enable to assert')
})

// ── CCSP rows visible ───────────────────────────────────────────────────────

test('ccsp data visible', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  const { status, body } = await getJSON(request, `/api/ccsp?ae=${encodeURIComponent(AE_NAME)}`)
  expect(status).toBe(200)
  // /api/ccsp returns a list (possibly empty) — at least one row required to
  // confirm the CCSP scrape during bootstrap actually wrote data.
  const rows = Array.isArray(body) ? body : Array.isArray(body?.rows) ? body.rows : []
  expect(rows.length, 'no CCSP rows returned for the seeded AE').toBeGreaterThan(0)
})

// ── Pipeline data visible ───────────────────────────────────────────────────

test('pipeline data visible', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  const { status, body } = await getJSON(request, `/api/pipeline?ae=${encodeURIComponent(AE_NAME)}`)
  expect(status).toBe(200)
  const rows = Array.isArray(body) ? body : Array.isArray(body?.rows) ? body.rows : []
  expect(rows.length, 'no pipeline rows returned for the seeded AE').toBeGreaterThan(0)
})

// ── SF Bookings: subscriptions present for at least some customers ──────────

test('sf bookings subscriptions', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  const cust = await getJSON(request, '/customers')
  const customers = (cust.body as any[]).filter(c => c?.ae === AE_NAME)
  expect(customers.length, `no customers for ae=${AE_NAME}`).toBeGreaterThan(0)

  // CCSP-only customers may legitimately have zero subscriptions — we only
  // assert that >0 customers in the territory have subscription/product data
  // surfaced by the SF Bookings sheet sync.
  let withSubs = 0
  for (const c of customers) {
    const detail = await getJSON(request, `/customer/${encodeURIComponent(c.name)}/sheetdata`)
    const subs = detail.body?.subscriptions ?? detail.body?.products ?? []
    if (Array.isArray(subs) && subs.length > 0) {
      withSubs++
      break // one is sufficient; avoid hammering N requests
    }
  }
  expect(withSubs, 'no customers in this AE have any SF subscription/product data').toBeGreaterThan(0)
})

// ── Products hub renders ────────────────────────────────────────────────────

test('products hub', async ({ page }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  await page.goto(`${BASE}/dashboard/products`)
  // Allow page to settle — products page loads multiple async fetches.
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  // Negative assertion first — empty-state banner must NOT be rendered.
  const empty = page.getByText(/no aes configured|no aes set up/i)
  await expect(empty).toHaveCount(0)
  // Positive assertion — at least one feature/product card visible.
  const anyCard = page.locator('[data-testid="product-card"], .product-card, h2:has-text("OpenShift"), h2:has-text("RHEL"), h2:has-text("Ansible")')
  await expect(anyCard.first()).toBeVisible({ timeout: 15_000 })
})

// ── Customer detail page renders ────────────────────────────────────────────

test('customer detail page', async ({ page, request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  const cust = await getJSON(request, '/customers')
  const target = (cust.body as any[]).find(c => c?.ae === AE_NAME)
  test.skip(!target, `no customer found for ae=${AE_NAME}`)

  await page.goto(`${BASE}/dashboard/customer/${encodeURIComponent(target.name)}`)
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  // The customer name appears somewhere on the page (header, breadcrumb, etc).
  await expect(page.getByText(target.name, { exact: false }).first()).toBeVisible({ timeout: 15_000 })
})

// ── Customers have account numbers from RH Portal sidebar discovery ─────────

test('account numbers present', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  const cust = await getJSON(request, '/customers')
  const customers = (cust.body as any[]).filter(c => c?.ae === AE_NAME)
  const withAccounts = customers.filter(c => Array.isArray(c.accountNumbers) && c.accountNumbers.length > 0)
  expect(
    withAccounts.length,
    'no customers have accountNumbers — RH Portal sidebar discovery did not run or returned empty',
  ).toBeGreaterThan(0)
})

// ── Scrape timestamps recent ────────────────────────────────────────────────

test('scrape timestamps recent', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  const { status, body } = await getJSON(request, '/api/status/scrapes')
  expect(status).toBe(200)
  const sixtyMinAgo = Date.now() - 60 * 60 * 1000

  const ccspTs = body?.ccsp?.lastSync ? new Date(body.ccsp.lastSync).getTime() : 0
  expect(ccspTs, 'CCSP scrape timestamp not within last 60 min').toBeGreaterThan(sixtyMinAgo)

  const sfTs = body?.salesforce?.lastSync ? new Date(body.salesforce.lastSync).getTime() : 0
  expect(sfTs, 'SF (pipeline) sync timestamp not within last 60 min').toBeGreaterThan(sixtyMinAgo)
})

// ── Intelligence results — assert AFTER all other tests gave Gemini time ────

test('intelligence — assert results', async ({ request, page }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  test.setTimeout(10 * 60 * 1000)

  const cust = await getJSON(request, '/customers')
  const target = (cust.body as any[]).find(c => c?.ae === AE_NAME)
  test.skip(!target, `no customer found for ae=${AE_NAME}`)

  // Poll intelligence status — generated upstream by 'intelligence — fire generation'.
  const final = await pollUntil<any>(
    'intelligence-status complete',
    async () => {
      const res = await getJSON(
        request,
        `/api/customer/${encodeURIComponent(target.name)}/intelligence-status`,
      )
      const b = res.body
      if (b?.status === 'complete' && (b.companyDocUrl || b.industryDocUrl)) {
        return { done: true, value: b }
      }
      if (b?.status === 'error') {
        return { done: true, value: b }
      }
      return { done: false }
    },
    { timeoutMs: 5 * 60 * 1000, intervalMs: 15_000 },
  )

  expect(final, 'intelligence pipeline never completed').toBeTruthy()
  expect(final.status, `intelligence ended with status=${final.status}: ${final.error ?? ''}`).toBe('complete')
  expect(
    final.companyDocUrl || final.industryDocUrl,
    'intelligence completed but no Drive doc URLs in response',
  ).toBeTruthy()

  // UI assertion — customer detail page surfaces the brief content.
  await page.goto(`${BASE}/dashboard/customer/${encodeURIComponent(target.name)}`)
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  // Anything resembling brief content — header text, doc link, or non-empty section.
  const hasBriefContent = await page
    .getByText(/intelligence|brief|summary|company.{0,20}brief/i)
    .first()
    .isVisible({ timeout: 15_000 })
    .catch(() => false)
  expect(hasBriefContent, 'customer detail page renders no intelligence/brief section').toBe(true)
})

// ── Territory dropdown auto-fills (UI smoke) ────────────────────────────────

test('territory dropdown', async ({ page, request }) => {
  test.skip(!HAS_LIVE_DATA || !TERRITORY, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME + TEST_TERRITORY')

  // Hit the lookup endpoint directly — the wizard form just renders this.
  const lookup = await getJSON(
    request,
    `/api/territory-lookup?pod=${encodeURIComponent(POD)}&territory=${encodeURIComponent(TERRITORY)}`,
  )
  if (lookup.status === 404) test.skip(true, '/api/territory-lookup not present on this build')
  expect(lookup.status).toBe(200)
  expect(lookup.body?.aeName, 'territory lookup returned no aeName').toBeTruthy()
  expect(Array.isArray(lookup.body?.customers), 'territory lookup returned no customers array').toBe(true)

  // UI smoke — Setup page loads and the AEs section is reachable.
  await page.goto(`${BASE}/dashboard/setup`)
  await expect(page.getByText(/AEs.*Customers|AE Setup|Add AE/i).first()).toBeVisible({ timeout: 15_000 })
})

// ── Cleanup ─────────────────────────────────────────────────────────────────

test.afterAll(async ({ request }) => {
  // Best-effort wipe — never fails the suite if the endpoint changes shape.
  try {
    const wipe = await request.post(`${BASE}/api/setup/reset`)
    if (wipe.ok()) {
      const aes = await request.get(`${BASE}/api/aes`)
      const body = await aes.json().catch(() => ({}))
      if (Array.isArray(body?.aes) && body.aes.length !== 0) {
        console.warn(`[bootstrap-e2e] afterAll: /api/aes still has ${body.aes.length} entries after reset`)
      }
    }
  } catch (e: any) {
    console.warn('[bootstrap-e2e] afterAll cleanup failed (non-blocking):', e?.message ?? e)
  }
})
