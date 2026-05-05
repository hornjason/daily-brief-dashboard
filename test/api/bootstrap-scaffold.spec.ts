/**
 * BKL-SCAFFOLD-STATUS-01 — GET /api/bootstrap/scaffold-status contract test.
 *
 * Validates the empty-state shape: when no AE / parentFolderId is configured
 * and no scaffold cache entry exists, the endpoint returns 200 with all
 * null/empty fields. The populated state requires a real Drive auth and a
 * completed bootstrap, so it is exercised by test/bootstrap-e2e.spec.ts
 * (manual/nightly), not here.
 */
import { test, expect, getJSON } from '../fixtures'

test.describe('GET /api/bootstrap/scaffold-status', () => {
  test('returns 200 with the expected top-level keys', async () => {
    const { status, body } = await getJSON('/api/bootstrap/scaffold-status')
    expect(status).toBe(200)
    expect(body).toHaveProperty('configFolderId')
    expect(body).toHaveProperty('productsFolderId')
    expect(body).toHaveProperty('productSubfolders')
  })

  test('productSubfolders is an object', async () => {
    const { body } = await getJSON('/api/bootstrap/scaffold-status')
    expect(typeof body.productSubfolders).toBe('object')
    expect(body.productSubfolders).not.toBeNull()
    expect(Array.isArray(body.productSubfolders)).toBe(false)
  })

  test('configFolderId and productsFolderId are string-or-null', async () => {
    const { body } = await getJSON('/api/bootstrap/scaffold-status')
    for (const key of ['configFolderId', 'productsFolderId'] as const) {
      const v = body[key]
      expect(v === null || typeof v === 'string').toBe(true)
    }
  })
})
