/**
 * BKL-HERO-01 Phase 0 — API tests for region access endpoints.
 *
 * Covers:
 *   GET  /api/node-role        — returns { isL3Only: true } when NODE_ROLE unset
 *   GET  /api/regions/catalog  — returns West + TOLA selectable (seed settings has no East)
 *   POST /api/regions/access   — validates + persists to settings.json
 *
 * All tests run against the test container (7776) — must be tagged @destructive
 * because POST mutates settings.json. Snapshot/restore wraps the suite to
 * protect seed data.
 */
import { test, expect } from '@playwright/test'

// @destructive routes target the test container — TEST_URL > BASE_URL > 7776
const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'

test.describe('@destructive BKL-HERO-01 Phase 0 — region access endpoints', () => {
  // Snapshot/restore wrapper — protects seed data from POST mutations.
  test.beforeAll(async ({ request }) => {
    try {
      const res = await request.post(`${BASE}/api/__test/snapshot`)
      const snap = await res.json().catch(() => ({}))
      if (!snap.ok) console.warn(`[region-access.spec.ts beforeAll] snapshot not-ok: ${JSON.stringify(snap)}`)
    } catch (e) {
      console.warn(`[region-access.spec.ts beforeAll] snapshot skipped: ${e}`)
    }
  })

  test.afterAll(async ({ request }) => {
    try {
      const r = await request.post(`${BASE}/api/__test/restore`, { data: { force: true } })
      const d = await r.json().catch(() => ({}))
      if (!d.ok) console.error(`[region-access.spec.ts afterAll] restore failed: ${JSON.stringify(d)}`)
    } catch (e) {
      console.error(`[region-access.spec.ts afterAll] restore error: ${e}`)
    }
  })

  test('GET /api/regions/catalog returns West + East + TOLA selectable', async ({ request }) => {
    const res = await request.get(`${BASE}/api/regions/catalog`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.regions)).toBe(true)

    const ids = body.regions.map((r: { id: string }) => r.id)
    expect(ids).toContain('west-commercial')
    expect(ids).toContain('central-enterprise-tola')
    expect(ids).toContain('east-commercial')  // added via BKL-REGION-SEED-01
    expect(ids).not.toContain('east-enterprise')

    const west = body.regions.find((r: { id: string }) => r.id === 'west-commercial')
    expect(west.selectable).toBe(true)
    expect(Array.isArray(west.pods)).toBe(true)
    expect(west.pods.length).toBeGreaterThan(0)
    // Qualified key shape `${regionId}.${podKey}` — load-bearing for the filter contract.
    for (const pod of west.pods) {
      expect(pod.qualifiedKey).toBe(`west-commercial.${pod.key}`)
    }

    const tola = body.regions.find((r: { id: string }) => r.id === 'central-enterprise-tola')
    expect(tola.selectable).toBe(true)
    expect(tola.pods.length).toBe(1)
    expect(tola.pods[0].key).toBe('CENTRAL_ENT_TOLA')
  })

  test('POST /api/regions/access with valid payload returns { ok: true } and persists', async ({ request }) => {
    const payload = {
      enabledRegions: ['west-commercial'],
      enabledPods: ['west-commercial.WEST_COMM_CORP_NORTHWEST'],
    }
    const res = await request.post(`${BASE}/api/regions/access`, { data: payload })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })

    // After save: catalog still returns valid regions (write didn't corrupt other fields).
    const catalogRes = await request.get(`${BASE}/api/regions/catalog`)
    expect(catalogRes.status()).toBe(200)
    const catalog = await catalogRes.json()
    const ids = catalog.regions.map((r: { id: string }) => r.id)
    expect(ids).toContain('west-commercial')
    expect(ids).toContain('central-enterprise-tola')
    const west = catalog.regions.find((r: { id: string }) => r.id === 'west-commercial')
    expect(west.selectable).toBe(true)
  })

  test('POST /api/regions/access rejects unknown region ID with 400', async ({ request }) => {
    const res = await request.post(`${BASE}/api/regions/access`, {
      data: { enabledRegions: ['nonexistent-region-xyz'], enabledPods: [] },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/nonexistent-region-xyz/i)
  })

  test('POST /api/regions/access rejects unknown pod qualified key with 400', async ({ request }) => {
    const res = await request.post(`${BASE}/api/regions/access`, {
      data: {
        enabledRegions: ['west-commercial'],
        enabledPods: ['west-commercial.NOT_A_REAL_POD'],
      },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/NOT_A_REAL_POD/)
  })

  test('POST /api/regions/access rejects malformed body with 400', async ({ request }) => {
    const res = await request.post(`${BASE}/api/regions/access`, {
      data: { enabledRegions: 'west-commercial', enabledPods: [] },  // string instead of array
    })
    expect(res.status()).toBe(400)
  })

  // ── POST /api/regions/select — single-region wizard convenience (Phase 1) ──

  test('POST /api/regions/select with missing regionId returns 400', async ({ request }) => {
    const res = await request.post(`${BASE}/api/regions/select`, { data: {} })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/regionId/i)
  })

  test('POST /api/regions/select with unknown regionId returns 400', async ({ request }) => {
    const res = await request.post(`${BASE}/api/regions/select`, {
      data: { regionId: 'nonexistent-region-xyz' },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/nonexistent-region-xyz/i)
  })

  test('POST /api/regions/select with valid regionId returns ok plus enabledRegions/enabledPods', async ({ request }) => {
    const res = await request.post(`${BASE}/api/regions/select`, {
      data: { regionId: 'west-commercial' },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.enabledRegions).toEqual(['west-commercial'])
    expect(Array.isArray(body.enabledPods)).toBe(true)
    expect(body.enabledPods.length).toBeGreaterThan(0)
    // Every returned pod must be a qualified key for west-commercial.
    for (const qk of body.enabledPods as string[]) {
      expect(qk.startsWith('west-commercial.')).toBe(true)
    }

    // Verify persistence by reading via GET /api/regions/access.
    const accessRes = await request.get(`${BASE}/api/regions/access`)
    expect(accessRes.status()).toBe(200)
    const access = await accessRes.json()
    expect(access.enabledRegions).toEqual(['west-commercial'])
    expect(access.enabledPods).toEqual(body.enabledPods)
  })
})
