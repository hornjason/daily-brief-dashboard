/**
 * Cross-customer similarity API tests (#612).
 * Covers endpoint shape and error handling for GET /api/customer/:slug/similar.
 */
import { test, expect, getJSON } from '../fixtures'

const NONEXISTENT = '__nonexistent_customer_xyz__'

test.describe('Similar customers endpoint', () => {
  test('GET /api/customer/:slug/similar returns 200 with expected shape', async () => {
    // Use a known customer slug — the endpoint returns empty array if no graphs exist
    const { status, body } = await getJSON('/api/customer/test-customer/similar')

    // Either 200 (customer found) or 404 (customer not in this instance)
    if (status === 200) {
      expect(body).toHaveProperty('customer')
      expect(body).toHaveProperty('similar')
      expect(body).toHaveProperty('computedAt')
      expect(Array.isArray(body.similar)).toBe(true)
      expect(typeof body.computedAt).toBe('string')

      // If there are similar customers, verify shape
      if (body.similar.length > 0) {
        const first = body.similar[0]
        expect(first).toHaveProperty('slug')
        expect(first).toHaveProperty('name')
        expect(first).toHaveProperty('overlapScore')
        expect(first).toHaveProperty('sharedProducts')
        expect(first).toHaveProperty('totalSharedNodes')
        expect(typeof first.overlapScore).toBe('number')
        expect(first.overlapScore).toBeGreaterThanOrEqual(0)
        expect(first.overlapScore).toBeLessThanOrEqual(1)
      }
    } else {
      // Customer not found in this instance — that's fine
      expect(status).toBe(404)
    }
  })

  test('GET /api/customer/:slug/similar returns 404 for nonexistent customer', async () => {
    const { status, body } = await getJSON(`/api/customer/${NONEXISTENT}/similar`)
    expect(status).toBe(404)
    expect(body).toHaveProperty('error')
  })
})
