/**
 * Shared test fixtures, API helpers, and factory functions.
 *
 * Every e2e spec should import { test, expect } from './fixtures'
 * instead of from '@playwright/test' directly.
 */
import { test as base } from '@playwright/test'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'
const TEST_BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'
// SNAPSHOT_BASE: snapshot/restore calls must target the same container as the tests being run.
// Default to TEST_BASE (7776) so destructive tests never accidentally snapshot/restore production.
// Override by setting BASE_URL=http://localhost:7777 for ci runs against production.
const SNAPSHOT_BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'

// ── BKL-TEST-12: Quinn endpoint allowlist ───────────────────────────
// When QUINN_SAFE_MODE=true, POST calls to destructive endpoints throw
// instead of executing. Prevents AI agent from wiping production data.
// Set in playwright.config.ts or agent environment.
const QUINN_SAFE_MODE = process.env.QUINN_SAFE_MODE === 'true'

// When QUINN_MODE=true, the quinnPage fixture installs a page.route()
// interceptor that blocks destructive POST endpoints at the browser level,
// responding 403 instead of executing. This is the network-layer guard;
// safePostJSON below is the API-helper-layer guard.
const QUINN_MODE = process.env.QUINN_MODE === 'true'

/** Endpoints that are NEVER safe to call from an AI agent test session */
export const QUINN_BLOCKED_POSTS = [
  '/api/setup/reset',
  '/api/__test/restore',
  '/api/bootstrap/auto',
  '/api/bootstrap/pod',
] as const

/** Wraps postJSON to enforce Quinn's endpoint allowlist */
export async function safePostJSON(path: string, data: unknown = {}) {
  if (QUINN_SAFE_MODE) {
    const blocked = QUINN_BLOCKED_POSTS.some(p => path.startsWith(p))
    if (blocked) {
      throw new Error(`QUINN GUARDRAIL: POST ${path} is in the blocked list. Set QUINN_SAFE_MODE=false to override (requires explicit approval).`)
    }
  }
  return postJSON(path, data)
}

// ── serverState fixture ──────────────────────────────────────────────
// Auto-snapshots config state before each test, restores after.
// Requires the /api/__test/snapshot + /api/__test/restore endpoints
// (added separately to server.ts). Falls back gracefully if those
// endpoints don't exist yet.

type ServerStateFixtures = { serverState: void }

export const test = base.extend<ServerStateFixtures>({
  serverState: [async ({ request }, use) => {
    // Snapshot current state
    let snapshot: unknown = null
    try {
      const res = await request.post(`${SNAPSHOT_BASE}/api/__test/snapshot`)
      if (res.ok()) snapshot = await res.json()
    } catch { /* endpoints not yet available — skip */ }

    await use()

    // Restore state after test
    if (snapshot) {
      try {
        await request.post(`${SNAPSHOT_BASE}/api/__test/restore`, { data: snapshot })
      } catch { /* ignore restore failures */ }
    }
  }, { auto: true, timeout: 5000 }],
})

// ── BKL-TEST-12: quinnPage fixture — browser-level POST block ────────
// Extends test with a `quinnPage` fixture that, when QUINN_MODE=true,
// installs a page.route() interceptor blocking destructive POST endpoints
// at the Playwright network layer (responds 403 before the request reaches
// the server). When QUINN_MODE is not set, quinnPage is the plain page
// with no additional routing — zero overhead for non-Quinn runs.
//
// Usage in tests tagged @quinn:
//   test('...', async ({ quinnPage }) => { ... })
//
// Activate: QUINN_MODE=true npx playwright test --grep @quinn

type QuinnFixtures = { quinnPage: import('@playwright/test').Page }

export const quinnTest = base.extend<QuinnFixtures>({
  quinnPage: async ({ page }, use) => {
    if (QUINN_MODE) {
      // Intercept POST requests to any blocked destructive endpoint.
      // Playwright glob: ** matches any origin prefix.
      for (const blocked of QUINN_BLOCKED_POSTS) {
        await page.route(`**${blocked}`, async (route) => {
          if (route.request().method() === 'POST') {
            console.warn(`[QUINN GUARDRAIL] Blocked POST ${route.request().url()}`)
            await route.fulfill({
              status: 403,
              contentType: 'application/json',
              body: JSON.stringify({
                error: `QUINN GUARDRAIL: POST ${blocked} is blocked in QUINN_MODE. This endpoint is destructive and must not be called from automated agent tests.`,
              }),
            })
          } else {
            await route.continue()
          }
        })
      }
    }
    await use(page)
  },
})

export { expect } from '@playwright/test'

// ── API helpers ──────────────────────────────────────────────────────

/** Use this for any test that calls a destructive endpoint — routes to test container */
export async function postJSONDestructive(path: string, data: unknown = {}) {
  const res = await fetch(`${TEST_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/** Use this for GET calls inside @destructive tests — routes to test container (TEST_URL/BASE_URL/7776) */
export async function getJSONDestructive(path: string) {
  const res = await fetch(`${TEST_BASE}${path}`)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

export async function getJSON(path: string) {
  const res = await fetch(`${BASE}${path}`)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

export async function postJSON(path: string, data: unknown = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

export async function deleteJSON(path: string) {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

// ── Test data factories ──────────────────────────────────────────────
// Minimal valid objects for each domain type.
// Override any field with the second argument.

export function buildAE(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'Test AE',
    driveFolderId: '1BV0uRHei3oRvGYVEXBX_qBB-VGu0r9wq',
    sfReportId: 'abc123',
    tableauTerritories: ['WEST_COMM_CORP_NORTHWEST_TERR01'],
    supportableSheetId: '',
    pipelineSheetId: '',
    ccspSheetId: '',
    ...overrides,
  }
}

export function buildCustomer(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'Test Customer',
    accountNumbers: ['1234'],
    domain: 'testcustomer.com',
    ...overrides,
  }
}

export function buildCase(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    caseNumber: 'RHC-0000001',
    summary: 'Test case summary',
    severity: '3',
    status: 'Waiting on Red Hat',
    product: 'OpenShift Container Platform',
    createdAt: new Date().toISOString(),
    daysOpen: 0,
    ...overrides,
  }
}

// ── Reference AE config (used by e2e-carolanne.spec.ts) ──────────────
// BKL-HERO-04: Updated 2026-05-02 — "TBH" AE no longer in live prod roster.
// Re-pointed to "Carolanne Farrell" — the current live AE (data/config/aes.json).
// The export name CAROLANNE is retained because multiple specs import it.

export const CAROLANNE = {
  name: 'Carolanne Farrell',
  driveFolderId: '1BV0uRHei3oRvGYVEXBX_qBB-VGu0r9wq',
  sfReportId: '00OPe00000isU2zMAE',
  tableauTerritories: ['WEST_COMM_CORP_NORTHWEST_TERR01'],
  supportableSheetId: '150e3-q-8_6Uy3qnLhL-ARBVHyVy29P7tnAuFjxkkuCg',
  pipelineSheetId: '10H8Nl8oQQg1x9Zt0p5cys7JJp0b4ObfzhB-pPMot3BM',
  ccspSheetId: '1K37mK8BQa8RqHL8ljp_wv7dmF7g9Y_Q1YhhYFmsFaPQ',
}

// ── RH session mock payloads ─────────────────────────────────────────

export const RH_NO_SESSION = {
  hasSession: false,
  sessionExpired: false,
  lastScraped: null,
  isRunning: false,
}

export const RH_EXPIRED = {
  hasSession: true,
  sessionExpired: true,
  lastScraped: null,
  isRunning: false,
}

export const RH_ACTIVE = {
  hasSession: true,
  sessionExpired: false,
  lastScraped: new Date().toISOString(),
  isRunning: false,
}
