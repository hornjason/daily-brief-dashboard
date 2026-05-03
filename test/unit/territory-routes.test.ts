// BKL-ARCH-13: Smoke test — verifies territory-routes.ts loads without import errors
// and createTerritoryRouter() returns a Hono app (duck-type: has `fetch` method).

import { describe, it, expect } from 'bun:test'
import { createTerritoryRouter } from '../../src/territory-routes.ts'

describe('createTerritoryRouter', () => {
  it('returns a Hono app with a fetch method', () => {
    const router = createTerritoryRouter()
    expect(router).toBeDefined()
    expect(typeof router.fetch).toBe('function')
  })
})
