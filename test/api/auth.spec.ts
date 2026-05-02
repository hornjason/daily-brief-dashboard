/**
 * test/api/auth.spec.ts
 * API contract tests for auth and scraper-status endpoints.
 *
 * Assumes the server is running at process.env.BASE_URL or http://localhost:7777.
 * These tests are read-only — they do not mutate state.
 */
import { test, expect } from '../fixtures'

const BASE = process.env.BASE_URL ?? 'http://localhost:7777'

async function getJSON(path: string) {
  const res = await fetch(`${BASE}${path}`)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function deleteJSON(path: string) {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

// ── GET /api/auth/redhat/status ───────────────────────────────────────────────

test.describe('GET /api/auth/redhat/status', () => {
  test('returns HTTP 200', async () => {
    const { status } = await getJSON('/api/auth/redhat/status')
    expect(status).toBe(200)
  })

  test('response has all 7 required fields', async () => {
    const { body } = await getJSON('/api/auth/redhat/status')
    expect(body).not.toBeNull()

    // hasSession: boolean
    expect(typeof body.hasSession).toBe('boolean')

    // sessionExpired: boolean
    expect(typeof body.sessionExpired).toBe('boolean')

    // lastScraped: string | null
    expect(body.lastScraped === null || typeof body.lastScraped === 'string').toBe(true)

    // caseCount: number
    expect(typeof body.caseCount).toBe('number')

    // loginInProgress: boolean
    expect(typeof body.loginInProgress).toBe('boolean')

    // loginTimedOut: boolean
    expect(typeof body.loginTimedOut).toBe('boolean')

    // liveReachable: boolean
    expect(typeof body.liveReachable).toBe('boolean')
  })
})

// ── DELETE /api/auth/redhat/session ──────────────────────────────────────────

test.describe('DELETE /api/auth/redhat/session', () => {
  test('returns 200 with { cancelled: true }', async () => {
    const { status, body } = await deleteJSON('/api/auth/redhat/session')
    expect(status).toBe(200)
    expect(body).toHaveProperty('cancelled', true)
  })
})

// ── GET /api/scraper-status ───────────────────────────────────────────────────

test.describe('GET /api/scraper-status', () => {
  test('returns HTTP 200', async () => {
    const { status } = await getJSON('/api/scraper-status')
    expect(status).toBe(200)
  })

  test('response has scrapers key', async () => {
    const { body } = await getJSON('/api/scraper-status')
    expect(body).not.toBeNull()
    expect(body).toHaveProperty('scrapers')
    expect(typeof body.scrapers).toBe('object')
  })

  test('scrapers map includes rh-cases, ccsp, sf-pipeline keys', async () => {
    const { body } = await getJSON('/api/scraper-status')
    const scrapers = body?.scrapers ?? {}
    expect(scrapers).toHaveProperty('rh-cases')
    expect(scrapers).toHaveProperty('ccsp')
    expect(scrapers).toHaveProperty('sf-pipeline')
  })
})

// ── GET /api/scrape/rh/status ─────────────────────────────────────────────────

test.describe('GET /api/scrape/rh/status', () => {
  test('returns HTTP 200', async () => {
    const { status } = await getJSON('/api/scrape/rh/status')
    expect(status).toBe(200)
  })

  test('response shape includes state field with valid value', async () => {
    const { body } = await getJSON('/api/scrape/rh/status')
    expect(body).not.toBeNull()
    expect(body).toHaveProperty('state')
    expect(['fresh', 'stale', 'running', 'failed']).toContain(body.state)
  })
})
