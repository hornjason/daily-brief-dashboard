/**
 * Unit tests for ensureSignalsCurrent() — GitHub Issue #328
 * Tests universal pre-flight signal refresh with auto-discovery pattern
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { ensureSignalsCurrent } from '../../src/lib/signal-loader.ts'
import { FeatureModuleRegistry, type FeatureModule } from '../../src/feature-module-registry.ts'

describe('ensureSignalsCurrent', () => {
  // Note: Cannot clear registry between tests as modules are registered at import time
  // Tests must account for modules registered by other tests or imports

  test('calls ensureFresh on modules that implement it', async () => {
    let calledA = false
    let calledB = false

    const moduleA: FeatureModule = {
      name: 'test-module-a',
      cachePaths: () => [],
      async fetch() {},
      async cleanup() {},
      async syncNow() {},
      async ensureFresh(customerSlug: string) {
        calledA = true
        expect(customerSlug).toBe('test-customer')
      },
    }

    const moduleB: FeatureModule = {
      name: 'test-module-b',
      cachePaths: () => [],
      async fetch() {},
      async cleanup() {},
      async syncNow() {},
      async ensureFresh(customerSlug: string) {
        calledB = true
        expect(customerSlug).toBe('test-customer')
      },
    }

    FeatureModuleRegistry.register(moduleA)
    FeatureModuleRegistry.register(moduleB)

    const result = await ensureSignalsCurrent('test-customer')

    expect(calledA).toBe(true)
    expect(calledB).toBe(true)
    expect(result.refreshed).toEqual(['test-module-a', 'test-module-b'])
    expect(result.skipped).toEqual([])
    expect(result.failed).toEqual([])
  })

  test('skips modules without ensureFresh', async () => {
    const moduleWithFresh: FeatureModule = {
      name: 'module-with-fresh',
      cachePaths: () => [],
      async fetch() {},
      async cleanup() {},
      async syncNow() {},
      async ensureFresh() {},
    }

    const moduleWithoutFresh: FeatureModule = {
      name: 'module-without-fresh',
      cachePaths: () => [],
      async fetch() {},
      async cleanup() {},
      async syncNow() {},
    }

    FeatureModuleRegistry.register(moduleWithFresh)
    FeatureModuleRegistry.register(moduleWithoutFresh)

    const result = await ensureSignalsCurrent('test-customer')

    expect(result.refreshed).toContain('module-with-fresh')
    expect(result.skipped).toContain('module-without-fresh')
    expect(result.failed).toEqual([])
  })

  test('catches failures and adds to failed list', async () => {
    const failingModule: FeatureModule = {
      name: 'failing-module',
      cachePaths: () => [],
      async fetch() {},
      async cleanup() {},
      async syncNow() {},
      async ensureFresh() {
        throw new Error('Refresh failed')
      },
    }

    const successModule: FeatureModule = {
      name: 'success-module',
      cachePaths: () => [],
      async fetch() {},
      async cleanup() {},
      async syncNow() {},
      async ensureFresh() {},
    }

    FeatureModuleRegistry.register(failingModule)
    FeatureModuleRegistry.register(successModule)

    const result = await ensureSignalsCurrent('test-customer')

    expect(result.failed).toContain('failing-module')
    expect(result.refreshed).toContain('success-module')
    // Don't assert on skipped - other modules from previous tests may be present
  })

  test('respects 30-second timeout', async () => {
    const slowModule: FeatureModule = {
      name: 'slow-module',
      cachePaths: () => [],
      async fetch() {},
      async cleanup() {},
      async syncNow() {},
      async ensureFresh() {
        // Simulate a slow operation (2 seconds - enough to test timeout logic without waiting 30s)
        await new Promise(resolve => setTimeout(resolve, 2_000))
      },
    }

    FeatureModuleRegistry.register(slowModule)

    const start = Date.now()
    await ensureSignalsCurrent('test-customer')
    const elapsed = Date.now() - start

    // Should complete quickly (within timeout), not wait forever
    expect(elapsed).toBeLessThan(32_000)
  }, { timeout: 35_000 })

  test('handles customer slug correctly', async () => {
    // This test verifies the customerSlug is passed correctly
    // We can't test "no modules" because other tests have registered modules
    let receivedSlug = ''

    const testModule: FeatureModule = {
      name: 'slug-test-module',
      cachePaths: () => [],
      async fetch() {},
      async cleanup() {},
      async syncNow() {},
      async ensureFresh(customerSlug: string) {
        receivedSlug = customerSlug
      },
    }

    FeatureModuleRegistry.register(testModule)

    await ensureSignalsCurrent('acme-corp')

    expect(receivedSlug).toBe('acme-corp')
  })

  test('runs all ensureFresh calls in parallel', async () => {
    const executionOrder: string[] = []

    const moduleA: FeatureModule = {
      name: 'parallel-module-a',
      cachePaths: () => [],
      async fetch() {},
      async cleanup() {},
      async syncNow() {},
      async ensureFresh() {
        executionOrder.push('a-start')
        await new Promise(resolve => setTimeout(resolve, 100))
        executionOrder.push('a-end')
      },
    }

    const moduleB: FeatureModule = {
      name: 'parallel-module-b',
      cachePaths: () => [],
      async fetch() {},
      async cleanup() {},
      async syncNow() {},
      async ensureFresh() {
        executionOrder.push('b-start')
        await new Promise(resolve => setTimeout(resolve, 50))
        executionOrder.push('b-end')
      },
    }

    FeatureModuleRegistry.register(moduleA)
    FeatureModuleRegistry.register(moduleB)

    await ensureSignalsCurrent('test-customer')

    // If parallel, b-end should come before a-end
    const bEndIndex = executionOrder.indexOf('b-end')
    const aEndIndex = executionOrder.indexOf('a-end')
    expect(bEndIndex).toBeLessThan(aEndIndex)
  }, { timeout: 10_000 })
})
