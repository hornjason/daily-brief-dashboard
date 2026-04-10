/**
 * AE Lifecycle Tests — BKL-TEST-02
 * Tests for AE add/remove operations with guaranteed snapshot/restore wrapping.
 * NEVER call POST /api/aes without snapshot/restore — atomic customer cleanup
 * wipes customers.json permanently if afterAll doesn't restore.
 *
 * Pattern: beforeAll snapshot → test → afterAll restore (with retry rollback).
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'

const TEST_AE = {
  name: '__test_lifecycle_ae__',
  driveFolderId: 'test-folder-id-placeholder',
  sfReportId: '00OPe000testREPORT',
  tableauTerritories: ['TEST_TERR99'],
}

test.beforeAll(async ({ request }) => {
  const snap = await (await request.post(`${BASE}/api/__test/snapshot`)).json()
  if (!snap.ok) throw new Error(`Snapshot failed: ${snap.error}`)
})

test.afterAll(async ({ request }) => {
  // Always restore — even if tests failed mid-way
  try {
    const r = await request.post(`${BASE}/api/__test/restore`)
    const d = await r.json()
    if (!d.ok) throw new Error(d.error ?? 'restore returned not-ok')
  } catch (e) {
    try {
      await request.post(`${BASE}/api/__test/restore`)
    } catch {
      console.error('[lifecycle afterAll] RESTORE FAILED — call POST /api/__test/restore manually to recover production data')
      throw e
    }
  }
})

// ── AE add lifecycle ─────────────────────────────────────────────────────────

test.describe('@destructive AE lifecycle — add and remove', () => {
  test('health endpoint returns current AE count', async ({ request }) => {
    const r = await request.get(`${BASE}/health`)
    expect(r.ok()).toBeTruthy()
    const body = await r.json()
    expect(typeof body.aes).toBe('number')
  })

  test('GET /api/aes returns array of AEs', async ({ request }) => {
    const r = await request.get(`${BASE}/api/aes`)
    expect(r.ok()).toBeTruthy()
    const body = await r.json()
    expect(Array.isArray(body.aes)).toBeTruthy()
  })

  test('POST /api/aes adds an AE without wiping existing data', async ({ request }) => {
    // GET current AE list, then POST the full list with test AE appended
    const before = await (await request.get(`${BASE}/api/aes`)).json()
    const beforeCount = before.aes?.length ?? 0
    const existing = before.aes ?? []

    // Skip if test AE already exists (previous run didn't clean up)
    const alreadyExists = existing.some((a: { name: string }) => a.name === TEST_AE.name)
    if (!alreadyExists) {
      const addResp = await request.post(`${BASE}/api/aes`, {
        data: { aes: [...existing, TEST_AE] },
      })
      expect([200, 201]).toContain(addResp.status())

      const after = await (await request.get(`${BASE}/api/aes`)).json()
      expect(after.aes?.length).toBeGreaterThanOrEqual(beforeCount)
    }
  })

  test('POST /api/aes remove does not wipe unrelated customers', async ({ request }) => {
    // Get current customer count
    const healthBefore = await (await request.get(`${BASE}/health`)).json()
    const custBefore = healthBefore.customers ?? 0

    // If test AE exists, remove it by posting the list without it
    const aeList = await (await request.get(`${BASE}/api/aes`)).json()
    const testAeExists = aeList.aes?.some((a: { name: string }) => a.name === TEST_AE.name)

    if (testAeExists) {
      const remaining = (aeList.aes ?? []).filter((a: { name: string }) => a.name !== TEST_AE.name)
      const removeResp = await request.post(`${BASE}/api/aes`, {
        data: { aes: remaining },
      })
      expect(removeResp.status()).toBe(200)

      // Customer count should not total-wipe (test AE has no real customers)
      const healthAfter = await (await request.get(`${BASE}/health`)).json()
      if (custBefore > 0) {
        expect(healthAfter.customers).toBeGreaterThan(0)
      }
    }
  })
})
