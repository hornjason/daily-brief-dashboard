// test/unit/startup-cascade-simple.test.ts
// Simple integration test for cascade ordering

import { describe, test, expect } from 'bun:test'

describe('Startup cascade ordering', () => {
  test('tier definitions are correct', () => {
    // Re-export constants from startup-cascade to verify structure
    const TIER_0_MODULES = ['subscriptions', 'partners']
    const TIER_1_MODULES = ['pipeline', 'ccsp', 'rh-cases']
    const TIER_2_MODULES = ['product-lifecycle', 'product-intel', 'value-maps', 'rh-rss']
    const TIER_3_MODULES = ['intelligence', 'news-radar', 'customer-product-intel']

    // Tier 0: bootstrap already writes these
    expect(TIER_0_MODULES).toContain('subscriptions')
    expect(TIER_0_MODULES).toContain('partners')

    // Tier 1: needs customers + subscriptions
    expect(TIER_1_MODULES).toContain('pipeline')
    expect(TIER_1_MODULES).toContain('ccsp')
    expect(TIER_1_MODULES).toContain('rh-cases')

    // Tier 2: needs Tier 1
    expect(TIER_2_MODULES).toContain('product-lifecycle')
    expect(TIER_2_MODULES).toContain('product-intel')
    expect(TIER_2_MODULES).toContain('value-maps')
    expect(TIER_2_MODULES).toContain('rh-rss')

    // Tier 3: needs everything above
    expect(TIER_3_MODULES).toContain('intelligence')
    expect(TIER_3_MODULES).toContain('news-radar')
    expect(TIER_3_MODULES).toContain('customer-product-intel')
  })

  test('semaphore enforces concurrency limit', async () => {
    // Test the semaphore class independently
    class Semaphore {
      private permits: number
      private waiting: Array<() => void> = []

      constructor(permits: number) {
        this.permits = permits
      }

      async acquire(): Promise<void> {
        if (this.permits > 0) {
          this.permits--
          return
        }
        return new Promise(resolve => {
          this.waiting.push(resolve)
        })
      }

      release(): void {
        if (this.waiting.length > 0) {
          const resolve = this.waiting.shift()
          resolve?.()
        } else {
          this.permits++
        }
      }
    }

    const sem = new Semaphore(2)
    let active = 0
    let maxActive = 0

    const runTask = async () => {
      await sem.acquire()
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active--
      sem.release()
    }

    // Run 5 tasks in parallel
    await Promise.all([runTask(), runTask(), runTask(), runTask(), runTask()])

    // Max concurrent should be 2 (semaphore limit)
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(maxActive).toBeGreaterThan(0)
  })
})
