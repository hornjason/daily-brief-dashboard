/**
 * Test: RH context auto-recovery in keepalive loop
 * BKL reference: #223
 *
 * Tests that the sync daemon detects dead RH browser contexts during keepalive
 * and auto-recovers using saved cookies.
 */

import { test, expect } from '@playwright/test'
import type { BrowserContext } from '@playwright/test'

test.describe('Sync Daemon RH Context Recovery', () => {

  test('should detect dead context during health probe', async () => {
    // This test verifies that a dead context (one where .pages() throws or times out)
    // is detected by the keepalive health probe.
    //
    // RED phase: This test should FAIL initially because the health probe doesn't exist yet.

    // Mock a dead context — one that throws when accessing .pages()
    const deadContext = {
      pages: async () => {
        throw new Error('Context is dead')
      },
    } as unknown as BrowserContext

    // The health probe should detect this and return false
    // (We'll implement isContextHealthy() as part of the fix)
    const { isContextHealthy } = await import('../scripts/sync-l3-daemon-utils.ts')
    const healthy = await isContextHealthy(deadContext, 5000)

    expect(healthy).toBe(false)
  })

  test('should detect timed-out context during health probe', async () => {
    // This test verifies that a context whose .pages() call hangs beyond timeout
    // is detected as unhealthy.
    //
    // RED phase: Should FAIL because isContextHealthy doesn't exist yet.

    // Mock a hanging context
    const hangingContext = {
      pages: async () => {
        await new Promise(resolve => setTimeout(resolve, 10000)) // hangs for 10s
        return []
      },
    } as unknown as BrowserContext

    const { isContextHealthy } = await import('../scripts/sync-l3-daemon-utils.ts')
    const healthy = await isContextHealthy(hangingContext, 2000) // 2s timeout

    expect(healthy).toBe(false)
  })

  test('should return true for healthy context', async () => {
    // This test verifies that a healthy context (one that responds correctly to .pages())
    // passes the health check.
    //
    // RED phase: Should FAIL because isContextHealthy doesn't exist yet.

    // Mock a healthy context
    const healthyContext = {
      pages: async () => {
        return [] // returns quickly
      },
    } as unknown as BrowserContext

    const { isContextHealthy } = await import('../scripts/sync-l3-daemon-utils.ts')
    const healthy = await isContextHealthy(healthyContext, 5000)

    expect(healthy).toBe(true)
  })
})

test.describe('RH Scraper Context Recovery', () => {

  test('should export recoverScrapeContext function', async () => {
    // This test verifies that rh-scraper.ts exports a recovery function
    // that can be called by the daemon.
    //
    // RED phase: Should FAIL because recoverScrapeContext doesn't exist yet.

    const rhScraper = await import('../src/rh-scraper.ts')

    expect(rhScraper.recoverScrapeContext).toBeDefined()
    expect(typeof rhScraper.recoverScrapeContext).toBe('function')
  })

  test('should throw error when recovery fails with no profile directory', async () => {
    // This test verifies that recoverScrapeContext throws a meaningful error
    // when called before browser initialization.
    //
    // GREEN phase validation: Confirms error handling works correctly.

    const { recoverScrapeContext, closeScrapeContext } = await import('../src/rh-scraper.ts')

    // Ensure context is closed first
    await closeScrapeContext().catch(() => {})

    // Attempting recovery without initialization should throw
    await expect(recoverScrapeContext()).rejects.toThrow(/Cannot recover.*no profile directory/)
  })
})
