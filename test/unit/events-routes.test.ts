// BKL-ARCH-14: Smoke test — verifies events-routes.ts loads without import errors
// and createEventsRouter() returns a Hono app (duck-type: has `fetch` method).

import { describe, it, expect } from 'bun:test'
import { createEventsRouter } from '../../src/events-routes.ts'

describe('createEventsRouter', () => {
  it('returns a Hono app with a fetch method', () => {
    const router = createEventsRouter()
    expect(router).toBeDefined()
    expect(typeof router.fetch).toBe('function')
  })
})
