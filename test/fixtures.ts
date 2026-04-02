/**
 * Shared test fixtures, API helpers, and factory functions.
 *
 * Every e2e spec should import { test, expect } from './fixtures'
 * instead of from '@playwright/test' directly.
 */
import { test as base } from '@playwright/test'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'

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
      const res = await request.post(`${BASE}/api/__test/snapshot`)
      if (res.ok()) snapshot = await res.json()
    } catch { /* endpoints not yet available — skip */ }

    await use()

    // Restore state after test
    if (snapshot) {
      try {
        await request.post(`${BASE}/api/__test/restore`, { data: snapshot })
      } catch { /* ignore restore failures */ }
    }
  }, { auto: true, timeout: 5000 }],
})

export { expect } from '@playwright/test'

// ── API helpers ──────────────────────────────────────────────────────

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

// ── Carolanne's real config (used by e2e-carolanne.spec.ts) ──────────
// These are the authoritative IDs pulled from the live test suite.

export const CAROLANNE = {
  name: 'Carolanne Farrell',
  driveFolderId: '1BV0uRHei3oRvGYVEXBX_qBB-VGu0r9wq',
  sfReportId: '00OPe00000isU2zMAE',
  tableauTerritories: ['WEST_COMM_CORP_NORTHWEST_TERR01'],
  supportableSheetId: '1wXrSZIp6ip4cSE1w31Q76_ia9BoGdrpO5CN6kVga63o',
  pipelineSheetId: '10H8Nl8oQQg1x9Zt0p5cys7JJp0b4ObfzhB-pPMot3BM',
  ccspSheetId: '11JxHACopxfffQqJDu30WrHtXg49SqipGTje9IIsZA6U',
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
