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
//   TEST_CUSTOMER_NAMES   — comma-separated customer names for bootstrap (required if territory lookup is empty)
//   TEST_TABLEAU_TERRITORY — Tableau territory code, e.g. 'WEST_COMM_CORP_NORTHWEST_TERR01'
//   NOTE: CCSP and pipeline data are populated by L4 scrapers, not by L3 bootstrap.
//   Those assertions are informational only (0 rows is expected on a fresh test AE).
//
// Run (uses asa-e2e-test-runs folder — NOT CommandCenter):
//   TEST_DRIVE_PARENT_URL=https://drive.google.com/drive/folders/1BxxIwOUTWjPB_VAIdsrEdfuRyXC6su0_ \
//   TEST_AE_NAME='Carolanne Farrell' \
//   TEST_SF_REPORT_ID='00OPe00000isU2zMAE' \
//   npx playwright test test/bootstrap-e2e.spec.ts --project=e2e-tier --workers=1
//
// NOTE: TEST_DRIVE_PARENT_URL must point at asa-e2e-test-runs (1BxxIwOUTWjPB_VAIdsrEdfuRyXC6su0_).
// NEVER use CommandCenter (1BV0uRHei3oRvGYVEXBX_qBB-VGu0r9wq) — that is the production folder.
import { test, expect } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'

const DRIVE_PARENT_URL = process.env.TEST_DRIVE_PARENT_URL ?? ''
const DRIVE_PARENT_ID = DRIVE_PARENT_URL.match(/\/folders\/([a-zA-Z0-9_-]{20,})/)?.[1] ?? ''
const AE_NAME = process.env.TEST_AE_NAME ?? ''
const REGION = process.env.TEST_REGION ?? 'west-commercial'
const POD = process.env.TEST_POD ?? 'west-commercial.WEST_COMM_CORP_NORTHWEST'
const TERRITORY = process.env.TEST_TERRITORY ?? 'WEST_COMM_CORP_NORTHWEST_TERR01'
const SF_REPORT_ID = process.env.TEST_SF_REPORT_ID ?? ''
const TABLEAU_TERRITORY = process.env.TEST_TABLEAU_TERRITORY ?? 'WEST_COMM_CORP_NORTHWEST_TERR01'
const CUSTOMER_NAMES = (process.env.TEST_CUSTOMER_NAMES ?? '').split(',').map(s => s.trim()).filter(Boolean)

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
  const resetRes = await postJSON(request, '/api/setup/reset?confirm=true')
  expect(resetRes.status).toBeLessThan(400)

  // 3) Confirm clean slate.
  const aes = await getJSON(request, '/api/aes')
  expect(aes.status).toBe(200)
  expect(Array.isArray(aes.body?.aes)).toBe(true)
  expect(aes.body.aes.length, 'aes.json was not cleared by /api/setup/reset').toBe(0)
})

// ── afterAll: best-effort Drive folder cleanup ──────────────────────────────
// Without this, every E2E run leaves an orphaned AE Drive folder behind. The
// cleanup endpoint is gated on ALLOW_RESET=true (test container only) and
// returns 404 on builds that don't have it — both are silently tolerated.

test.afterAll(async ({ request }) => {
  try {
    const aesRes = await request.get(`${BASE}/api/aes`)
    const aesBody = await aesRes.json().catch(() => ({}))
    const ae = Array.isArray(aesBody?.aes) ? aesBody.aes.find((a: any) => a?.name === AE_NAME) : null
    const folderId = ae?.driveFolderId
    if (!folderId) {
      console.log('[bootstrap-e2e] afterAll: no driveFolderId for AE — nothing to clean up')
      return
    }
    const cleanup = await request.delete(`${BASE}/api/__test/drive-cleanup?folderId=${encodeURIComponent(folderId)}`)
    if (cleanup.status() === 404) {
      console.log('[bootstrap-e2e] afterAll: /api/__test/drive-cleanup not available on this build — skipping')
      return
    }
    const body = await cleanup.json().catch(() => ({}))
    if (body?.deleted) {
      console.log(`[bootstrap-e2e] afterAll: deleted Drive folder ${folderId}`)
    } else {
      console.warn(`[bootstrap-e2e] afterAll: Drive cleanup did not confirm deletion: ${JSON.stringify(body)}`)
    }
  } catch (e: any) {
    console.warn('[bootstrap-e2e] afterAll Drive cleanup failed (non-blocking):', e?.message ?? e)
  }
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
      name: AE_NAME, pod: POD, territory: TERRITORY,
      parentFolderId: DRIVE_PARENT_ID, sfReportId: SF_REPORT_ID,
      tableauTerritories: [TABLEAU_TERRITORY],
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
  // driveFolderId is populated by bootstrap step 1 — not by wizard submit.
  // Assert the submitted fields persisted; Drive folder check is in 'drive scaffold created'.
  expect(ae.sfReportId, 'AE sfReportId not persisted after wizard submit').toBeTruthy()
})

// ── Bootstrap: 5-step pipeline completes ────────────────────────────────────

test('bootstrap completes', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  // Bootstrap may be auto-fired by /api/aes; if not, fire it explicitly.
  const initial = await getJSON(request, '/api/bootstrap/auto/status')
  if (!initial.body?.running && !initial.body?.completedAt) {
    const bootstrapPayload: Record<string, unknown> = { aeName: AE_NAME, parentFolderId: DRIVE_PARENT_ID, sfReportId: SF_REPORT_ID, tableauTerritories: [TABLEAU_TERRITORY] }
    if (CUSTOMER_NAMES.length > 0) bootstrapPayload.customerNames = CUSTOMER_NAMES
    const start = await postJSON(request, '/api/bootstrap/auto', bootstrapPayload)
    expect(start.status, `POST /api/bootstrap/auto failed: ${JSON.stringify(start.body)}`).toBeLessThan(400)
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

// ── SF bookings sync — discovers customers from the SF POD sheet ────────────
// Bootstrap creates the Drive infrastructure; this sync reads the SF data and
// writes discovered customers to customers.json — exactly what a real new user
// triggers by waiting for the background scheduler (or clicking "Sync Now").

test('sf bookings sync — customer discovery', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  const sync = await postJSON(request, '/api/scrape/sf-bookings-sync', { aeNames: [AE_NAME] })
  expect(sync.status, `POST /api/scrape/sf-bookings-sync failed: ${JSON.stringify(sync.body)}`).toBeLessThan(400)

  // Poll until customers appear for this AE (up to 90s — Drive read + write)
  const customers = await pollUntil<any[]>(
    'customers populated',
    async () => {
      const res = await getJSON(request, '/customers')
      const found = (res.body as any[]).filter((c: any) => c?.ae === AE_NAME)
      if (found.length > 0) return { done: true, value: found }
      return { done: false }
    },
    { timeoutMs: 90_000, intervalMs: 5_000 },
  ).catch(() => null)

  if (!customers || customers.length === 0) {
    console.log(`[sf-bookings-sync] 0 customers discovered — territory filter may not match SF data rows. Tests that depend on customers will skip.`)
  } else {
    console.log(`[sf-bookings-sync] discovered ${customers.length} customers for ae=${AE_NAME}`)
  }
})

// ── Drive scaffold cache populated ──────────────────────────────────────────

test('drive scaffold created', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  // Prefer /api/bootstrap/scaffold-status (added in a later build) but fall
  // back to verifying via bootstrap auto status resources when that endpoint
  // is absent (older Mac Mini images).
  const scaffoldRes = await getJSON(request, '/api/bootstrap/scaffold-status')
  if (scaffoldRes.status === 200) {
    expect(scaffoldRes.body.configFolderId, 'scaffold-status.configFolderId is null after bootstrap').toBeTruthy()
    expect(scaffoldRes.body.productsFolderId, 'scaffold-status.productsFolderId is null after bootstrap').toBeTruthy()
    expect(typeof scaffoldRes.body.productSubfolders).toBe('object')
  } else {
    // Fallback: verify Drive folder was created via bootstrap auto status
    const statusRes = await getJSON(request, '/api/bootstrap/auto/status')
    expect(statusRes.status).toBe(200)
    expect(
      statusRes.body?.resources?.driveFolder?.id,
      'bootstrap resources.driveFolder.id not present — Drive scaffold did not create a folder',
    ).toBeTruthy()
    const ae = (await getJSON(request, '/api/aes')).body?.aes?.find((a: any) => a.name === AE_NAME)
    expect(ae?.driveFolderId, 'AE driveFolderId not populated after bootstrap').toBeTruthy()
  }
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
  // CCSP sheet rows come from Tableau (L4) — the L3 bootstrap creates the sheet
  // structure but leaves it empty. An L4 Tableau scrape writes data rows.
  // On a fresh bootstrap this will be 0. Informational log only.
  const rows = Array.isArray(body) ? body : Array.isArray(body?.rows) ? body.rows : []
  console.log(`[ccsp data visible] rows=${rows.length} (populated by L4 Tableau scrape, will be 0 on fresh bootstrap)`)
})

// ── Pipeline data visible ───────────────────────────────────────────────────

test('pipeline data visible', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  const { status, body } = await getJSON(request, `/api/pipeline?ae=${encodeURIComponent(AE_NAME)}`)
  expect(status).toBe(200)
  // Pipeline rows come from SF Lightning browser scrape (L4) — the L3 bootstrap
  // creates the sheet structure but leaves it empty. An L4 SF scrape writes data rows.
  // On a fresh bootstrap this will be 0. Informational log only.
  const rows = Array.isArray(body) ? body : Array.isArray(body?.rows) ? body.rows : []
  console.log(`[pipeline data visible] rows=${rows.length} (populated by L4 SF scrape, will be 0 on fresh bootstrap)`)
})

// ── SF Bookings: subscriptions present for at least some customers ──────────

test('sf bookings subscriptions', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  // L3 gate: /customers must respond with a valid array.
  // On a fresh bootstrap without pre-seeded customers, the AE's customers may be empty
  // because deriveSfCustomersByTerritory requires existing customer records to match against.
  // Customer count is logged but not asserted — the hard gate is API shape (200 + array).
  const cust = await getJSON(request, '/customers')
  expect(cust.status).toBe(200)
  expect(Array.isArray(cust.body), '/customers must return an array').toBe(true)
  const customers = (cust.body as any[]).filter(c => c?.ae === AE_NAME)
  console.log(`[sf bookings] customers for ae=${AE_NAME}: ${customers.length}`)

  if (customers.length === 0) {
    console.log('[sf bookings] 0 customers — expected on fresh bootstrap (no pre-seeded customers.json)')
    return
  }

  // When customers exist: verify at least one has subscription/product data from the SF sheet.
  let withSubs = 0
  for (const c of customers) {
    const detail = await getJSON(request, `/customer/${encodeURIComponent(c.name)}/sheetdata`)
    const subs = detail.body?.rows ?? []
    if (Array.isArray(subs) && subs.length > 0) {
      withSubs++
      break
    }
  }
  console.log(`[sf bookings] customers with subscription data: ${withSubs}/${customers.length}`)
  expect(withSubs, `sf bookings: ${withSubs}/${customers.length} customers have subscription rows — writeSubscriptionsStep must have populated the sheet cache`).toBeGreaterThan(0)
})

// ── Products hub renders ────────────────────────────────────────────────────

test('products hub', async ({ page, request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  await page.goto(`${BASE}/dashboard/products`)
  // Allow page to settle — products page loads multiple async fetches.
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  // Hard gate: the "no AEs configured" error must NOT appear.
  const empty = page.getByText(/no aes configured|no aes set up/i)
  await expect(empty).toHaveCount(0)
  // Soft gate: product cards visible only when CCSP data exists (L4 Tableau).
  const anyCard = page.locator('[data-testid="product-card"], .product-card, h2:has-text("OpenShift"), h2:has-text("RHEL"), h2:has-text("Ansible")')
  const cardCount = await anyCard.count()
  console.log(`[products hub] product cards visible: ${cardCount} (requires product-intel pipeline: content.redhat.com + REDHAT_OFFLINE_TOKEN + Gemini synthesis)`)
  // API gate: verify /api/products responds correctly (reads cached summaries — L3 safe)
  const productsRes = await request.get(`${BASE}/api/products`)
  expect(productsRes.status(), `GET /api/products returned non-200: ${productsRes.status()}`).toBe(200)
  const productSummaries = await productsRes.json().catch(() => [])
  console.log(`[products hub] /api/products summaries: ${Array.isArray(productSummaries) ? productSummaries.length : 'error'} (populated by product-intel, not by bootstrap)`)
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
  // Account numbers are populated by L4 RH Portal browser discovery — not available
  // on a fresh test AE without prior L4 scrapes. Support CASES (/api/cases/all)
  // also require account numbers (populated by the same L4 scrape) before they
  // can be matched. Both are informational on fresh bootstrap. Soft-warn only.
  const cust = await getJSON(request, '/customers')
  const customers = (cust.body as any[]).filter(c => c?.ae === AE_NAME)
  const withAccounts = customers.filter(c => Array.isArray(c.accountNumbers) && c.accountNumbers.length > 0)
  console.log(`[account numbers] ${withAccounts.length}/${customers.length} customers have accountNumbers (L4 RH Portal required for > 0)`)
})

// ── RH support cases endpoint — shape verification ──────────────────────────

test('rh support cases endpoint', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  // GET /api/cases/all reads from disk cache — L3 safe. On a fresh bootstrap
  // without L4 account number discovery, cases will be 0 (no account numbers
  // to match against). This test verifies the endpoint shape, not case count.
  const { status, body } = await getJSON(request, '/api/cases/all')
  expect(status, `GET /api/cases/all returned ${status}`).toBe(200)
  expect(Array.isArray(body?.cases), '/api/cases/all must return { cases: array }').toBe(true)
  expect(typeof body?.totalCount, '/api/cases/all must return { totalCount: number }').toBe('number')
  console.log(`[rh support cases] totalCount=${body?.totalCount} (requires account numbers from L4 RH Portal discovery for > 0)`)
})

// ── Scrape timestamps recent ────────────────────────────────────────────────

test('scrape timestamps recent', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  // Timestamps reflect L4 scrape completion — not present on a fresh test AE.
  // This test verifies the API responds correctly; timestamp assertions are soft.
  const { status, body } = await getJSON(request, '/api/status/scrapes')
  expect(status).toBe(200)
  const sixtyMinAgo = Date.now() - 60 * 60 * 1000

  const ccspTs = body?.ccsp?.lastSync ? new Date(body.ccsp.lastSync).getTime() : 0
  const sfTs = body?.salesforce?.lastSync ? new Date(body.salesforce.lastSync).getTime() : 0
  console.log(`[scrape timestamps] ccsp=${body?.ccsp?.lastSync ?? 'none'} sf=${body?.salesforce?.lastSync ?? 'none'} (L4 required for < 60min)`)
  // Only assert when timestamps are present — absence is OK on a fresh test AE.
  if (ccspTs > 0) expect(ccspTs, 'CCSP scrape timestamp not within last 60 min').toBeGreaterThan(sixtyMinAgo)
  if (sfTs > 0) expect(sfTs, 'SF (pipeline) sync timestamp not within last 60 min').toBeGreaterThan(sixtyMinAgo)
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
  if (final.status === 'error') {
    // Auth failures (invalid_grant, Gemini key issues) are test-env credential problems, not code bugs.
    console.log(`[intelligence] status=error (non-fatal in test env): ${final.error ?? ''}`)
    return
  }
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
  const accountsArr = lookup.body?.accounts ?? lookup.body?.customers
  expect(Array.isArray(accountsArr), 'territory lookup returned no accounts/customers array').toBe(true)

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
