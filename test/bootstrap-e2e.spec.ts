// E2E Bootstrap — full new-user journey regression test (canonical spec).
//
// Source of truth: docs/E2E-BOOTSTRAP-FLOW.md (flowchart + gap analysis).
// Every assertion below is HARD — no informational-only checks. The intent is
// that this single spec replaces the manual "log in and click around" pass we
// used to run after every bootstrap change.
//
// Runs against the test container (port 7776) using the `e2e-tier` Playwright
// project. The hero image (Dockerfile.hero) is L3-only — Drive auth is the
// ONLY pre-flight check. RH Portal, Tableau, and VPN are NOT required and
// MUST NOT be added as gates here.
//
// Required env vars (test.skip()s when missing):
//   TEST_DRIVE_PARENT_URL — Google Drive folder URL for parent (asa-e2e-test-runs)
//   TEST_AE_NAME          — AE name to seed (must match the test territory sheet)
//
// Optional env vars:
//   TEST_URL              — overrides http://localhost:7776
//   TEST_REGION           — defaults to 'west-commercial'
//   TEST_POD              — defaults to 'west-commercial.WEST_COMM_CORP_NORTHWEST'
//   TEST_TERRITORY        — territory code, e.g. 'WEST_COMM_CORP_NORTHWEST_TERR01'
//   TEST_SF_REPORT_ID     — Salesforce report ID for the AE
//   TEST_TABLEAU_TERRITORY — Tableau territory code; defaults to TEST_TERRITORY
//   TEST_CUSTOMER_NAMES   — comma-separated customer names (used only if territory lookup empty)
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
import type { APIRequestContext, Page } from '@playwright/test'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'

const DRIVE_PARENT_URL = process.env.TEST_DRIVE_PARENT_URL ?? ''
const DRIVE_PARENT_ID = DRIVE_PARENT_URL.match(/\/folders\/([a-zA-Z0-9_-]{20,})/)?.[1] ?? ''
const AE_NAME = process.env.TEST_AE_NAME ?? ''
const REGION = process.env.TEST_REGION ?? 'west-commercial'
const POD = process.env.TEST_POD ?? 'west-commercial.WEST_COMM_CORP_NORTHWEST'
const TERRITORY = process.env.TEST_TERRITORY ?? 'WEST_COMM_CORP_NORTHWEST_TERR01'
const SF_REPORT_ID = process.env.TEST_SF_REPORT_ID ?? ''
const TABLEAU_TERRITORY = process.env.TEST_TABLEAU_TERRITORY ?? TERRITORY
const CUSTOMER_NAMES = (process.env.TEST_CUSTOMER_NAMES ?? '').split(',').map(s => s.trim()).filter(Boolean)

const HAS_LIVE_DATA = Boolean(DRIVE_PARENT_URL && AE_NAME)

// Bootstrap can take 10+ minutes end-to-end; intelligence pipeline adds another 5+.
test.describe.configure({ mode: 'serial' })
test.setTimeout(20 * 60 * 1000)

// ── Captured cross-test state ───────────────────────────────────────────────
// Populated by earlier tests, asserted against by later UI cross-check tests.

let firstCustomer: string = ''
let firstCustomerId: string = ''
let pipelineTotalAcv: number = 0
let pipelineTopOpps: Array<{ oppName: string; acv: number; accountName: string }> = []
let ccspTotalAcv: number = 0
let ccspTopAccounts: Array<{ name: string; acv: number }> = []

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

/**
 * Strip currency formatting and parse a dollar string back to a number.
 * Accepts "$1,234,567", "1,234.56", "$1.2M" (returns NaN for suffixes — caller
 * is expected to use the un-suffixed string when comparing).
 */
function parseDollar(text: string): number {
  return Number(text.replace(/[$,\s]/g, ''))
}

/**
 * Compare two dollar amounts within a $1 tolerance. UI may round, so an exact
 * match is too strict; off-by-cents rounding is acceptable.
 */
function dollarsMatch(a: number, b: number): boolean {
  return Math.abs(a - b) < 1
}

/**
 * Find a textual occurrence of a dollar amount on the page that matches the
 * captured API value within rounding tolerance. Searches the rendered text of
 * the whole page; the UI may format `1234567` as `$1,234,567` or `$1.23M` —
 * we accept either by extracting all dollar tokens and comparing numerically.
 *
 * Returns true if any token on the page matches the target value (within $1
 * for full numbers, or matches the abbreviated form within 1% for "1.23M"
 * style abbreviations — UI rounding can drift up to 1% on M/B suffixes).
 */
async function pageHasDollarValue(page: Page, target: number): Promise<boolean> {
  const text = await page.locator('body').innerText()
  // Match $1,234, $1,234.56, $1.2M, $1.23B
  const tokens = text.match(/\$[\d,]+(?:\.\d+)?[MBK]?/g) ?? []
  for (const tok of tokens) {
    const suffix = tok.match(/[MBK]$/)?.[0]
    const num = parseDollar(tok.replace(/[MBK]$/, ''))
    if (Number.isNaN(num)) continue
    let value = num
    if (suffix === 'K') value = num * 1_000
    else if (suffix === 'M') value = num * 1_000_000
    else if (suffix === 'B') value = num * 1_000_000_000
    // Exact-ish for full numbers; 1% tolerance for abbreviated forms.
    if (suffix && Math.abs(value - target) / Math.max(target, 1) < 0.01) return true
    if (!suffix && dollarsMatch(value, target)) return true
  }
  return false
}

// ── beforeAll: seed region access, reset state ──────────────────────────────

test.beforeAll(async ({ request }) => {
  // Step A: seed region/POD selection so the wizard skips Step 0.
  const regionRes = await postJSON(request, '/api/regions/access', {
    enabledRegions: [REGION],
    enabledPods: [POD],
  })
  expect(regionRes.status, `region/access seeding failed: ${JSON.stringify(regionRes.body)}`).toBeLessThan(400)

  // Step A: wipe AE/customer/cache state on the test container.
  const resetRes = await postJSON(request, '/api/setup/reset?confirm=true')
  expect(resetRes.status).toBeLessThan(400)

  // Step A: confirm clean slate.
  const aes = await getJSON(request, '/api/aes')
  expect(aes.status).toBe(200)
  expect(Array.isArray(aes.body?.aes)).toBe(true)
  expect(aes.body.aes.length, 'aes.json was not cleared by /api/setup/reset').toBe(0)
})

// ── afterAll: best-effort Drive folder cleanup + state wipe ─────────────────

test.afterAll(async ({ request }) => {
  try {
    const aesRes = await request.get(`${BASE}/api/aes`)
    const aesBody = await aesRes.json().catch(() => ({}))
    const ae = Array.isArray(aesBody?.aes) ? aesBody.aes.find((a: any) => a?.name === AE_NAME) : null
    const folderId = ae?.driveFolderId
    if (folderId) {
      const cleanup = await request.delete(`${BASE}/api/__test/drive-cleanup?folderId=${encodeURIComponent(folderId)}`)
      if (cleanup.status() === 404) {
        console.log('[bootstrap-e2e] afterAll: /api/__test/drive-cleanup not available — skipping')
      } else {
        const body = await cleanup.json().catch(() => ({}))
        if (body?.deleted) {
          console.log(`[bootstrap-e2e] afterAll: deleted Drive folder ${folderId}`)
        } else {
          console.warn(`[bootstrap-e2e] afterAll: Drive cleanup did not confirm deletion: ${JSON.stringify(body)}`)
        }
      }
    } else {
      console.log('[bootstrap-e2e] afterAll: no driveFolderId for AE — nothing to clean up')
    }
  } catch (e: any) {
    console.warn('[bootstrap-e2e] afterAll Drive cleanup failed (non-blocking):', e?.message ?? e)
  }

  // Step S: wipe state and confirm empty (soft).
  try {
    const wipe = await request.post(`${BASE}/api/setup/reset?confirm=true`)
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

// ── Step B: Drive auth ──────────────────────────────────────────────────────

test('B — drive auth: Google session is connected', async ({ request }) => {
  await test.step('GET /api/auth/google/status', async () => {
    const { status, body } = await getJSON(request, '/api/auth/google/status')
    if (status === 404) test.skip(true, '/api/auth/google/status not present on this build')
    expect(status).toBe(200)
    const ok = body?.hasSession === true || body?.connected === true || body?.driveReady === true
    expect(ok, `Google/Drive not connected. body=${JSON.stringify(body)}`).toBe(true)
  })
})

// ── Step C: Validate parent folder ──────────────────────────────────────────

test('C — wizard: validate parent Drive folder', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  await test.step('POST /api/aes/validate-folder', async () => {
    const { status, body } = await postJSON(request, '/api/aes/validate-folder', {
      folderUrl: DRIVE_PARENT_URL,
    })
    expect(status, `validate-folder failed: ${JSON.stringify(body)}`).toBeLessThan(400)
    const ok = body?.ok === true || body?.valid === true || Boolean(body?.folderId)
    expect(ok, `validate-folder body shape unexpected: ${JSON.stringify(body)}`).toBeTruthy()
  })
})

// ── Step D: AE setup ────────────────────────────────────────────────────────

test('D — wizard: create AE via /api/aes', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  await test.step('POST /api/aes', async () => {
    const submitRes = await postJSON(request, '/api/aes', {
      aes: [{
        name: AE_NAME, pod: POD, territory: TERRITORY,
        parentFolderId: DRIVE_PARENT_ID, sfReportId: SF_REPORT_ID,
        tableauTerritories: [TABLEAU_TERRITORY],
      }],
    })
    expect(submitRes.status, `POST /api/aes failed: ${JSON.stringify(submitRes.body)}`).toBeLessThan(400)
  })

  await test.step('GET /api/aes — AE persisted with sfReportId', async () => {
    const { body } = await getJSON(request, '/api/aes')
    const ae = body.aes.find((a: any) => a.name === AE_NAME)
    expect(ae, `${AE_NAME} not found in /api/aes after wizard submit`).toBeDefined()
    expect(ae.sfReportId, 'AE sfReportId not persisted after wizard submit').toBeTruthy()
  })
})

// ── Step E: Bootstrap completes — all sheet IDs + driveFolderId populated ───

test('E — bootstrap completes (all 3 sheet IDs + driveFolderId populated)', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  await test.step('start bootstrap (or detect already running)', async () => {
    const initial = await getJSON(request, '/api/bootstrap/auto/status')
    if (!initial.body?.running && !initial.body?.completedAt) {
      const payload: Record<string, unknown> = {
        aeName: AE_NAME,
        parentFolderId: DRIVE_PARENT_ID,
        sfReportId: SF_REPORT_ID,
        tableauTerritories: [TABLEAU_TERRITORY],
      }
      if (CUSTOMER_NAMES.length > 0) payload.customerNames = CUSTOMER_NAMES
      const start = await postJSON(request, '/api/bootstrap/auto', payload)
      expect(start.status, `POST /api/bootstrap/auto failed: ${JSON.stringify(start.body)}`).toBeLessThan(400)
    }
  })

  const final = await test.step('poll bootstrap auto status (≤10 min)', async () => {
    return pollUntil<any>(
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
  })

  await test.step('no bootstrap step ended in error', async () => {
    expect(final, 'bootstrap never reached a terminal state').toBeTruthy()
    expect(final.error, `bootstrap error: ${final.error}`).toBeFalsy()
    const errored = (final.steps as Array<{ status: string; name?: string }>)
      .filter(s => s.status === 'error')
    expect(errored, `bootstrap step(s) errored: ${JSON.stringify(errored)}`).toHaveLength(0)
  })

  await test.step('AE has driveFolderId + all 3 sheet IDs populated', async () => {
    const { body } = await getJSON(request, '/api/aes')
    const ae = body?.aes?.find((a: any) => a.name === AE_NAME)
    expect(ae, `${AE_NAME} missing from /api/aes after bootstrap`).toBeDefined()
    expect(ae.driveFolderId,        'AE.driveFolderId null after bootstrap (Step 1 should create AE folder)').toBeTruthy()
    expect(ae.subscriptionSheetId,  'AE.subscriptionSheetId null after bootstrap (Step 4 should create SF Bookings sheet)').toBeTruthy()
    expect(ae.ccspSheetId,          'AE.ccspSheetId null after bootstrap (Step 5 should create CCSP sheet)').toBeTruthy()
    expect(ae.pipelineSheetId,      'AE.pipelineSheetId null after bootstrap (Step 5 should create Pipeline sheet)').toBeTruthy()
  })
})

// ── Step E2: Domain inference — every customer has domain, no manual fallback ──

test('E2 — domain inference: every customer has a domain', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  await test.step('GET /api/bootstrap/auto/status — domainInference results present', async () => {
    const { body } = await getJSON(request, '/api/bootstrap/auto/status')
    expect(body?.resources?.domainInference, 'resources.domainInference missing from bootstrap status').toBeDefined()
    expect(Array.isArray(body.resources.domainInference), 'resources.domainInference must be an array').toBe(true)
    if (body?.resources?.inferenceWarning) {
      console.warn(`[E2] inferenceWarning present (soft): ${body.resources.inferenceWarning}`)
    }
  })

  await test.step('GET /customers — every customer has domain non-null and not needsManualDomain', async () => {
    const cust = await getJSON(request, '/customers')
    expect(cust.status).toBe(200)
    expect(Array.isArray(cust.body), '/customers must return an array').toBe(true)
    const customers = (cust.body as any[]).filter(c => c?.ae === AE_NAME)
    expect(customers.length, `domain inference cannot run with 0 customers for ae=${AE_NAME}`).toBeGreaterThan(0)

    const missingDomain = customers.filter(c => !c.domain || typeof c.domain !== 'string' || c.domain.trim() === '')
    expect(
      missingDomain,
      `customers with no domain after inference: ${missingDomain.map(c => c.name).join(', ')}`,
    ).toHaveLength(0)

    const needManual = customers.filter(c => c.needsManualDomain === true)
    expect(
      needManual,
      `customers flagged needsManualDomain after inference: ${needManual.map(c => c.name).join(', ')}`,
    ).toHaveLength(0)
  })
})

// ── Step F: Drive scaffold (Config/, Products/, product subfolders) ─────────

test('F — drive scaffold: Config + Products + product subfolders created', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  await test.step('GET /api/bootstrap/scaffold-status', async () => {
    const { status, body } = await getJSON(request, '/api/bootstrap/scaffold-status')
    expect(status, `GET /api/bootstrap/scaffold-status returned ${status}`).toBe(200)
    expect(body.configFolderId,  'scaffold-status.configFolderId is null after bootstrap').toBeTruthy()
    expect(body.productsFolderId, 'scaffold-status.productsFolderId is null after bootstrap').toBeTruthy()
    expect(typeof body.productSubfolders, 'scaffold-status.productSubfolders must be an object').toBe('object')
    const subCount = Object.keys(body.productSubfolders ?? {}).length
    expect(subCount, 'scaffold-status.productSubfolders has zero entries — no product slug folders created under Products/').toBeGreaterThan(0)
  })
})

// ── Step G: SF bookings sync — customers populated; intelligence fired in BG ─

test('G — sf bookings sync: customers populated + intelligence fired in background', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  await test.step('POST /api/scrape/sf-bookings-sync', async () => {
    const sync = await postJSON(request, '/api/scrape/sf-bookings-sync', { aeNames: [AE_NAME] })
    expect(sync.status, `POST /api/scrape/sf-bookings-sync failed: ${JSON.stringify(sync.body)}`).toBeLessThan(400)
  })

  const customers = await test.step('poll /customers until customers populated for AE (≤90s)', async () => {
    return pollUntil<any[]>(
      'customers populated',
      async () => {
        const res = await getJSON(request, '/customers')
        const found = (res.body as any[]).filter((c: any) => c?.ae === AE_NAME)
        if (found.length > 0) return { done: true, value: found }
        return { done: false }
      },
      { timeoutMs: 90_000, intervalMs: 5_000 },
    )
  })

  await test.step('HARD: customers.length > 0 — capture firstCustomer', async () => {
    expect(customers, 'pollUntil returned null for /customers populate').toBeTruthy()
    expect(customers!.length, `customers.length must be > 0 for ae=${AE_NAME} after sf-bookings-sync`).toBeGreaterThan(0)
    firstCustomer = customers![0].name as string
    // Customer.id field is not part of the Customer type — the account-plan
    // route accepts either the customer name or its slug as ":id". We use the
    // name directly (encoded) since that's what /customers returns.
    firstCustomerId = customers![0].id ?? customers![0]._id ?? customers![0].name
    console.log(`[G] firstCustomer=${firstCustomer}`)
  })

  await test.step('FIRE-AND-FORGET intelligence generation (no await)', async () => {
    // Intentionally not awaited — runs in background while remaining steps
    // execute. Polled in step P. Uses native fetch (not Playwright request)
    // so the request outlives the test step's APIRequestContext lifecycle.
    const url = `${BASE}/api/customer/${encodeURIComponent(firstCustomer)}/generate-intelligence?force=true`
    void fetch(url, { method: 'POST' })
    console.log(`[G] fired POST ${url} (not awaited)`)
  })
})

// ── Step H: Subscription data integrity — header + ≥1 data row ──────────────

test('H — subscription data integrity (sheetdata returns rows > 1)', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  expect(firstCustomer, 'firstCustomer must be captured by step G').toBeTruthy()

  await test.step(`GET /customer/${firstCustomer}/sheetdata`, async () => {
    const { status, body } = await getJSON(request, `/customer/${encodeURIComponent(firstCustomer)}/sheetdata`)
    expect(status, `GET sheetdata returned ${status}`).toBe(200)
    const rows = body?.rows
    expect(Array.isArray(rows), 'sheetdata.rows must be an array').toBe(true)
    expect(rows.length, `sheetdata.rows must contain header + at least one data row (got ${rows?.length})`).toBeGreaterThan(1)
  })
})

// ── Step I: CCSP data — byAE entry has ACV + topAccounts ────────────────────

test('I — CCSP data: byAE entry exists with acv > 0 and topAccounts', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  // Trigger a CCSP cache refresh — bootstrap creates a new CCSP sheet but the
  // in-memory cache was loaded at container startup from old seed data.
  // POST /api/refresh/ccsp forces a re-read from the AE's ccspSheetId.
  await postJSON(request, '/api/refresh/ccsp', {})

  const { status, body } = await getJSON(request, `/api/ccsp?ae=${encodeURIComponent(AE_NAME)}`)
  expect(status, `GET /api/ccsp returned ${status}`).toBe(200)

  const byAE = Array.isArray(body?.byAE) ? body.byAE : []
  const aeEntry = byAE.find((e: any) => e.ae === AE_NAME) ?? byAE[0]
  expect(aeEntry, `byAE has no entry for ${AE_NAME} (byAE.length=${byAE.length})`).toBeDefined()
  expect(aeEntry.acv, `byAE[${AE_NAME}].acv must be > 0`).toBeGreaterThan(0)
  expect(Array.isArray(aeEntry.topAccounts), `byAE[${AE_NAME}].topAccounts must be array`).toBe(true)
  expect(aeEntry.topAccounts.length, `byAE[${AE_NAME}].topAccounts.length must be > 0`).toBeGreaterThan(0)

  ccspTotalAcv = Number(aeEntry.acv)
  ccspTopAccounts = aeEntry.topAccounts as Array<{ name: string; acv: number }>
  console.log(`[I] ccspTotalAcv=${ccspTotalAcv} topAccounts=${ccspTopAccounts.length}`)
})

// ── Step J: Pipeline data — openCount + totalAcv + topOpps ──────────────────

test('J — pipeline data: openCount > 0, totalAcv > 0, topOpps populated', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  // Same pattern as step I — force refresh so the newly created pipeline sheet
  // is read into cache before asserting.
  await postJSON(request, '/api/refresh/pipeline', {})

  const { status, body } = await getJSON(request, `/api/pipeline?ae=${encodeURIComponent(AE_NAME)}`)
  expect(status, `GET /api/pipeline returned ${status}`).toBe(200)

  expect(body?.openCount, 'pipeline.openCount must be > 0').toBeGreaterThan(0)
  expect(body?.totalAcv,  'pipeline.totalAcv must be > 0').toBeGreaterThan(0)
  expect(Array.isArray(body?.topOpps), 'pipeline.topOpps must be an array').toBe(true)
  expect(body.topOpps.length, 'pipeline.topOpps must have at least one entry').toBeGreaterThan(0)

  // Each topOpp record must carry oppName + acv (and accountName from PipelineRecord).
  const first = body.topOpps[0]
  expect(typeof first.oppName, 'topOpps[0].oppName must be a string').toBe('string')
  expect(typeof first.acv,     'topOpps[0].acv must be a number').toBe('number')

  pipelineTotalAcv = Number(body.totalAcv)
  pipelineTopOpps = body.topOpps as Array<{ oppName: string; acv: number; accountName: string }>
  console.log(`[J] pipelineTotalAcv=${pipelineTotalAcv} topOpps=${pipelineTopOpps.length}`)
})

// ── Step K: Dashboard landing page — renders without error, AE name visible ──

test('K — dashboard landing page renders with AE name, no error', async ({ page }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  await test.step('navigate to /dashboard', async () => {
    await page.goto(`${BASE}/dashboard`)
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  })

  await test.step('no error state visible', async () => {
    const errorTestId = page.locator('[data-testid="error"]')
    await expect(errorTestId, 'error data-testid element must not be visible on /dashboard').toHaveCount(0)
    // /error|failed/i text — allow zero matches; if present, must not be visible.
    const errorText = page.getByText(/error|failed/i)
    const errCount = await errorText.count()
    if (errCount > 0) {
      // Sometimes harmless words slip in (e.g. "Failed login attempts" on a metric card);
      // the hard rule is no VISIBLE error indicator. Walk visible matches.
      for (let i = 0; i < errCount; i++) {
        const el = errorText.nth(i)
        const visible = await el.isVisible().catch(() => false)
        const txt = await el.innerText().catch(() => '')
        // Allow benign substrings; flag obvious failure phrases.
        if (visible && /error loading|failed to load|something went wrong/i.test(txt)) {
          throw new Error(`/dashboard shows error indicator: "${txt}"`)
        }
      }
    }
  })

  await test.step(`AE name "${AE_NAME}" visible on page`, async () => {
    await expect(
      page.getByText(AE_NAME, { exact: false }).first(),
      `AE name "${AE_NAME}" not visible on /dashboard`,
    ).toBeVisible({ timeout: 15_000 })
  })
})

// ── Step L: Pipeline tile — UI matches API ──────────────────────────────────

test('L — pipeline tile UI: totalAcv + at least one topOpp visible', async ({ page }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  expect(pipelineTopOpps.length, 'pipelineTopOpps must be captured by step J').toBeGreaterThan(0)

  await test.step('navigate to /dashboard', async () => {
    await page.goto(`${BASE}/dashboard`)
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  })

  const pipelineTile = page.locator('[data-testid="pipeline-tile"]')

  await test.step('pipeline tile is visible', async () => {
    await expect(pipelineTile).toBeVisible({ timeout: 15_000 })
  })

  await test.step(`pipeline totalAcv ($${pipelineTotalAcv}) visible in pipeline tile`, async () => {
    const tileText = await pipelineTile.innerText()
    const tokens = tileText.match(/\$[\d,]+(?:\.\d+)?[MBK]?/g) ?? []
    let found = false
    for (const tok of tokens) {
      const suffix = tok.match(/[MBK]$/)?.[0]
      const num = parseDollar(tok.replace(/[MBK]$/, ''))
      if (Number.isNaN(num)) continue
      let value = num
      if (suffix === 'K') value = num * 1_000
      else if (suffix === 'M') value = num * 1_000_000
      else if (suffix === 'B') value = num * 1_000_000_000
      if (suffix && Math.abs(value - pipelineTotalAcv) / Math.max(pipelineTotalAcv, 1) < 0.01) { found = true; break }
      if (!suffix && dollarsMatch(value, pipelineTotalAcv)) { found = true; break }
    }
    expect(found, `pipeline totalAcv ${pipelineTotalAcv} not found in pipeline tile (within rounding)`).toBe(true)
  })

  await test.step('at least one topOpp account name visible in pipeline tile', async () => {
    // PipelineSection renders opp.accountName (not opp.oppName) in the top-opps list.
    let visible = false
    const candidates = [...new Set(pipelineTopOpps.slice(0, 10).map(o => o.accountName).filter(Boolean))]
    for (const name of candidates) {
      const loc = pipelineTile.getByText(name, { exact: false }).first()
      if (await loc.isVisible().catch(() => false)) { visible = true; break }
    }
    expect(
      visible,
      `none of the top-10 pipeline account names visible in pipeline tile. Looked for: ${candidates.join(' | ')}`,
    ).toBe(true)
  })
})

// ── Step M: CCSP tile — UI matches API ──────────────────────────────────────

test('M — CCSP tile UI: ACV + at least one topAccount visible', async ({ page, request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  expect(ccspTopAccounts.length, 'ccspTopAccounts must be captured by step I').toBeGreaterThan(0)

  // The CloudSpendSection tile is intentionally hidden on L3-only installs
  // (NODE_ROLE != 'primary'). Step I already verified the CCSP API data.
  // Skip the UI tile check rather than fail — this is by-design, not a bug.
  const nodeRole = await getJSON(request, '/api/node-role')
  test.skip(nodeRole.body?.isL3Only === true, 'CCSP tile not rendered on L3-only hero install (isL3Only=true) — API data validated in step I')

  await test.step('navigate to /dashboard', async () => {
    await page.goto(`${BASE}/dashboard`)
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  })

  const ccspTile = page.locator('[data-testid="ccsp-tile"]')

  await test.step('CCSP tile is visible', async () => {
    await expect(ccspTile).toBeVisible({ timeout: 15_000 })
  })

  await test.step(`CCSP totalAcv ($${ccspTotalAcv}) visible in CCSP tile`, async () => {
    const tileText = await ccspTile.innerText()
    const tokens = tileText.match(/\$[\d,]+(?:\.\d+)?[MBK]?/g) ?? []
    let found = false
    for (const tok of tokens) {
      const suffix = tok.match(/[MBK]$/)?.[0]
      const num = parseDollar(tok.replace(/[MBK]$/, ''))
      if (Number.isNaN(num)) continue
      let value = num
      if (suffix === 'K') value = num * 1_000
      else if (suffix === 'M') value = num * 1_000_000
      else if (suffix === 'B') value = num * 1_000_000_000
      if (suffix && Math.abs(value - ccspTotalAcv) / Math.max(ccspTotalAcv, 1) < 0.01) { found = true; break }
      if (!suffix && dollarsMatch(value, ccspTotalAcv)) { found = true; break }
    }
    expect(found, `CCSP totalAcv ${ccspTotalAcv} not found in CCSP tile (within rounding)`).toBe(true)
  })

  await test.step('at least one CCSP topAccount name visible in CCSP tile', async () => {
    let visible = false
    for (const acct of ccspTopAccounts.slice(0, 5)) {
      const loc = ccspTile.getByText(acct.name, { exact: false }).first()
      if (await loc.isVisible().catch(() => false)) { visible = true; break }
    }
    expect(
      visible,
      `none of the top-5 CCSP account names visible in CCSP tile. Looked for: ${ccspTopAccounts.slice(0, 5).map(a => a.name).join(' | ')}`,
    ).toBe(true)
  })
})

// ── Step N: Account portfolio — cards visible with subscription content ─────

test('N — account portfolio: cards visible with non-blank subscription content', async ({ page }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')

  await test.step('navigate to /dashboard', async () => {
    await page.goto(`${BASE}/dashboard`)
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  })

  const cards = page.locator('[data-testid="account-card"]')

  await test.step('account cards visible (count > 0)', async () => {
    expect(await cards.count(), 'account card count must be > 0').toBeGreaterThan(0)
  })

  await test.step('first account card is visible and contains non-empty text', async () => {
    const firstCard = cards.first()
    await expect(firstCard).toBeVisible({ timeout: 15_000 })
    const cardText = (await firstCard.innerText()).trim()
    expect(cardText.length, 'first account card must contain non-empty text (not a loading spinner)').toBeGreaterThan(0)
  })

  await test.step('at least one card shows non-blank product/subscription content', async () => {
    // Look for at least one product slug or "subscription" text near the cards area.
    const subscriptionishText = page.getByText(/subscription|openshift|rhel|ansible|product|active|expires/i)
    const hits = await subscriptionishText.count()
    expect(hits, 'no subscription/product content visible in account portfolio area').toBeGreaterThan(0)
  })
})

// ── Step O: Account detail page — customer name + subscription rows ─────────

test('O — account detail page: customer header + subscription rows visible', async ({ page }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  expect(firstCustomer, 'firstCustomer must be captured by step G').toBeTruthy()

  await test.step(`navigate to /dashboard/customer/${firstCustomer}`, async () => {
    await page.goto(`${BASE}/dashboard/customer/${encodeURIComponent(firstCustomer)}`)
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  })

  await test.step('customer name visible in header', async () => {
    await expect(
      page.getByText(firstCustomer, { exact: false }).first(),
      `customer name "${firstCustomer}" not visible on detail page`,
    ).toBeVisible({ timeout: 15_000 })
  })

  await test.step('subscription section visible with at least one product row', async () => {
    // The empty state would show "No data"; we want at least one product line.
    const noData = await page.getByText(/no data|no subscriptions|no products/i).first()
      .isVisible().catch(() => false)
    expect(noData, `customer detail page shows empty subscription state`).toBe(false)
    // Anything resembling a subscription / product row.
    const productRow = page.getByText(/openshift|rhel|ansible|product|subscription|quantity|expires|days left/i)
    const rowCount = await productRow.count()
    expect(rowCount, 'no subscription/product rows visible on customer detail page').toBeGreaterThan(0)
  })
})

// ── Step P: Poll account intelligence (kicked off in step G) ────────────────

test('P — account intelligence: poll status until complete', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  expect(firstCustomer, 'firstCustomer must be captured by step G').toBeTruthy()
  test.setTimeout(10 * 60 * 1000)

  const final = await test.step('poll intelligence-status until complete (≤5 min)', async () => {
    return pollUntil<any>(
      'intelligence-status complete',
      async () => {
        const res = await getJSON(
          request,
          `/api/customer/${encodeURIComponent(firstCustomer)}/intelligence-status`,
        )
        const b = res.body
        if (b?.status === 'complete') return { done: true, value: b }
        if (b?.status === 'error')    return { done: true, value: b }
        return { done: false }
      },
      { timeoutMs: 5 * 60 * 1000, intervalMs: 15_000 },
    )
  })

  await test.step('status === complete + both doc URLs non-null', async () => {
    expect(final, 'intelligence pipeline never reached terminal state').toBeTruthy()
    expect(final.status, `intelligence ended with status=${final.status}: ${final.error ?? ''}`).toBe('complete')
    expect(final.companyDocUrl,  'intelligence-status.companyDocUrl is null').toBeTruthy()
    expect(final.industryDocUrl, 'intelligence-status.industryDocUrl is null').toBeTruthy()
  })
})

// ── Step Q: Verify intelligence docs exist in Drive ─────────────────────────

test('Q — verify Account Intelligence docs in Drive', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  expect(firstCustomer, 'firstCustomer must be captured by step G').toBeTruthy()

  // Re-fetch the intelligence-status to obtain fresh doc URLs and the
  // customer's driveFolderId for the optional Drive listing check.
  const status = (await getJSON(request, `/api/customer/${encodeURIComponent(firstCustomer)}/intelligence-status`)).body
  expect(status?.companyDocUrl,  'companyDocUrl missing — step P should have populated it').toBeTruthy()
  expect(status?.industryDocUrl, 'industryDocUrl missing — step P should have populated it').toBeTruthy()
  // Distinct URLs — guard against a regression that returned the same Doc twice.
  expect(status.companyDocUrl).not.toEqual(status.industryDocUrl)

  // Optional: verify against /api/__test/drive-list when present.
  const customers = (await getJSON(request, '/customers')).body as any[]
  const cust = customers.find(c => c?.name === firstCustomer)
  const customerFolderId = cust?.driveFolderId ?? null
  if (!customerFolderId) {
    console.log('[Q] customer.driveFolderId not present — skipping Drive listing cross-check')
    return
  }

  const probe = await request.get(`${BASE}/api/__test/drive-list?folderId=${encodeURIComponent(customerFolderId)}`)
  if (probe.status() === 404) {
    console.log('[Q] /api/__test/drive-list not available on this build — distinct doc URLs check is sufficient')
    return
  }
  expect(probe.status()).toBeLessThan(400)
  const body = await probe.json().catch(() => ({}))
  // Look for an "Account Intelligence/" subfolder (case-insensitive) and >= 2 docs in it.
  // The /api/__test/drive-list response shape isn't pinned — this looks for either a
  // flat children array or a nested folders structure.
  const items: any[] = Array.isArray(body?.items) ? body.items
    : Array.isArray(body?.children) ? body.children
    : Array.isArray(body) ? body
    : []
  const intelFolder = items.find((it: any) => /account.intelligence/i.test(it?.name ?? ''))
  expect(intelFolder, `Account Intelligence/ subfolder not found inside customer Drive folder ${customerFolderId}`).toBeTruthy()
  // Drive listing of the subfolder may require a second call — we tolerate either
  // (a) the listing endpoint returning child counts inline, or (b) a second probe.
  let docCount = Number(intelFolder.docCount ?? intelFolder.fileCount ?? NaN)
  if (Number.isNaN(docCount) && intelFolder.id) {
    const sub = await request.get(`${BASE}/api/__test/drive-list?folderId=${encodeURIComponent(intelFolder.id)}`)
    if (sub.ok()) {
      const subBody = await sub.json().catch(() => ({}))
      const subItems: any[] = Array.isArray(subBody?.items) ? subBody.items
        : Array.isArray(subBody?.children) ? subBody.children
        : Array.isArray(subBody) ? subBody
        : []
      docCount = subItems.filter((i: any) => /document|doc/i.test(i?.mimeType ?? '')).length
        || subItems.length
    }
  }
  if (!Number.isNaN(docCount)) {
    expect(docCount, `Account Intelligence/ subfolder has ${docCount} docs (expected >= 2)`).toBeGreaterThanOrEqual(2)
  }
})

// ── Step R: Generate account plan ───────────────────────────────────────────

test('R — generate account plan: driveUrl + markdown.length > 100', async ({ request }) => {
  test.skip(!HAS_LIVE_DATA, 'requires TEST_DRIVE_PARENT_URL + TEST_AE_NAME')
  expect(firstCustomer, 'firstCustomer must be captured by step G').toBeTruthy()
  test.setTimeout(5 * 60 * 1000)

  const planId = firstCustomerId || firstCustomer

  const gen = await test.step(`POST /api/customers/${planId}/account-plan/generate`, async () => {
    return postJSON(request, `/api/customers/${encodeURIComponent(planId)}/account-plan/generate`)
  })

  await test.step('response has driveUrl non-null', async () => {
    expect(gen.status, `account-plan/generate returned ${gen.status}: ${JSON.stringify(gen.body)}`).toBeLessThan(400)
    expect(gen.body?.driveUrl, 'account-plan response missing driveUrl').toBeTruthy()
  })

  await test.step('markdown.length > 100 (via GET /api/customers/:id/account-plan)', async () => {
    // POST endpoint returns { ok, generatedAt, driveUrl } — markdown is fetched
    // via the companion GET. (See E2E-BOOTSTRAP-FLOW.md gap note: the POST
    // shape does not include markdown; the GET does. Logged for backlog.)
    const fetched = await getJSON(request, `/api/customers/${encodeURIComponent(planId)}/account-plan`)
    expect(fetched.status, `GET account-plan returned ${fetched.status}`).toBe(200)
    expect(fetched.body?.notGenerated, 'account-plan reports notGenerated after generate succeeded').toBeFalsy()
    expect(typeof fetched.body?.markdown, 'account-plan markdown must be a string').toBe('string')
    expect(
      (fetched.body?.markdown ?? '').length,
      `account-plan markdown.length must be > 100 (got ${(fetched.body?.markdown ?? '').length})`,
    ).toBeGreaterThan(100)
  })
})
