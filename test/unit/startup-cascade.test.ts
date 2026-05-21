// test/unit/startup-cascade.test.ts
// Unit tests for post-bootstrap refresh cascade (GitHub Issue #310)

import { describe, test, expect, beforeEach, mock } from 'bun:test'

// Mock the FeatureModuleRegistry
const mockStatus: Record<string, { lastChecked: string | null }> = {}
const mockRegistry = {
  getAllStatus: () => mockStatus,
  list: () => [
    { name: 'rh-cases' },
    { name: 'product-lifecycle' },
    { name: 'product-intel' },
    { name: 'value-maps' },
    { name: 'rh-rss' },
    { name: 'intelligence' },
    { name: 'news-radar' },
    { name: 'customer-product-intel' },
    { name: 'partners' },
  ],
  get: (name: string) => ({
    fetch: mock(async () => {}),
  }),
  recordOutcome: mock(() => {}),
}

// Mock refresh-engine functions
const mockRefreshSubscriptions = mock(async () => {})
const mockRefreshCCSP = mock(async () => {})
const mockRefreshPipeline = mock(async () => {})

// Setup mocks before importing the module under test
mock.module('../../src/feature-module-registry.ts', () => ({
  FeatureModuleRegistry: mockRegistry,
}))

mock.module('../../src/refresh-engine.ts', () => ({
  refreshSubscriptions: mockRefreshSubscriptions,
  refreshCCSP: mockRefreshCCSP,
  refreshPipeline: mockRefreshPipeline,
}))

// Now we can import the module under test
const { runStartupCascade } = await import('../../src/startup-cascade.ts')

describe('runStartupCascade', () => {
  beforeEach(() => {
    // Reset mocks
    mockRefreshSubscriptions.mockClear()
    mockRefreshCCSP.mockClear()
    mockRefreshPipeline.mockClear()
    mockRegistry.recordOutcome.mockClear()

    // Clear mock status
    for (const key of Object.keys(mockStatus)) {
      delete mockStatus[key]
    }
  })

  test('skips cascade when all modules have timestamps', async () => {
    // All modules have lastChecked timestamp
    const timestamp = '2026-05-20T10:00:00Z'
    mockStatus['subscriptions'] = { lastChecked: timestamp }
    mockStatus['partners'] = { lastChecked: timestamp }
    mockStatus['pipeline'] = { lastChecked: timestamp }
    mockStatus['ccsp'] = { lastChecked: timestamp }
    mockStatus['rh-cases'] = { lastChecked: timestamp }
    mockStatus['product-lifecycle'] = { lastChecked: timestamp }
    mockStatus['product-intel'] = { lastChecked: timestamp }
    mockStatus['value-maps'] = { lastChecked: timestamp }
    mockStatus['rh-rss'] = { lastChecked: timestamp }
    mockStatus['intelligence'] = { lastChecked: timestamp }
    mockStatus['news-radar'] = { lastChecked: timestamp }
    mockStatus['customer-product-intel'] = { lastChecked: timestamp }

    const result = await runStartupCascade()

    expect(result.completed.length).toBe(0)
    expect(result.failed.length).toBe(0)
    expect(result.skipped.length).toBeGreaterThan(0)
  })

  test('runs cascade when modules have no timestamp', async () => {
    // Fresh install — set all modules to null (or leave mockStatus empty so they're undefined)
    // Empty mockStatus means all modules return undefined status, triggering cascade
    // (beforeEach already clears mockStatus, so it's already empty)

    const result = await runStartupCascade()

    // Should have attempted to refresh the fresh modules
    expect(mockRefreshPipeline).toHaveBeenCalled()
    expect(mockRefreshCCSP).toHaveBeenCalled()

    // Should have completed successfully
    expect(result.completed.length).toBeGreaterThan(0)
    expect(result.failed.length).toBe(0)
  })

  test('runs tiers in dependency order', async () => {
    // Mock all modules as fresh (empty mockStatus means undefined status for all)
    // (beforeEach already clears mockStatus)

    const callOrder: string[] = []

    // Track call order
    mockRefreshPipeline.mockImplementation(async () => {
      callOrder.push('pipeline')
    })
    mockRefreshCCSP.mockImplementation(async () => {
      callOrder.push('ccsp')
    })

    const originalModuleGet = mockRegistry.get
    mockRegistry.get = (name: string) => {
      if (name === 'product-lifecycle') {
        return {
          fetch: mock(async () => {
            callOrder.push('product-lifecycle')
          }),
        }
      }
      return originalModuleGet(name)
    }

    await runStartupCascade()

    // Tier 1 modules (pipeline, ccsp) should be called before Tier 2 (product-lifecycle)
    const pipelineIdx = callOrder.indexOf('pipeline')
    const ccspIdx = callOrder.indexOf('ccsp')
    const lifecycleIdx = callOrder.indexOf('product-lifecycle')

    expect(pipelineIdx).toBeGreaterThanOrEqual(0)
    expect(ccspIdx).toBeGreaterThanOrEqual(0)
    expect(lifecycleIdx).toBeGreaterThan(Math.max(pipelineIdx, ccspIdx))
  })

  test('handles partial failure gracefully', async () => {
    // All modules fresh (empty mockStatus)
    // Make pipeline fail
    mockRefreshPipeline.mockRejectedValue(new Error('Pipeline refresh failed'))

    const result = await runStartupCascade()

    // Pipeline should be in failed list
    expect(result.failed).toContain('pipeline')

    // CCSP should still succeed
    expect(result.completed).toContain('ccsp')

    // Total should account for all attempted modules
    const total = result.completed.length + result.failed.length + result.skipped.length
    expect(total).toBeGreaterThan(0)
  })

  test('respects concurrency limit of 2', async () => {
    // Mock several modules as fresh
    mockStatus['pipeline'] = { lastChecked: null }
    mockStatus['ccsp'] = { lastChecked: null }
    mockStatus['rh-cases'] = { lastChecked: null }

    let concurrentCalls = 0
    let maxConcurrent = 0

    const trackConcurrency = async () => {
      concurrentCalls++
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls)
      await new Promise(resolve => setTimeout(resolve, 10))
      concurrentCalls--
    }

    mockRefreshPipeline.mockImplementation(trackConcurrency)
    mockRefreshCCSP.mockImplementation(trackConcurrency)

    await runStartupCascade()

    // Max concurrent should not exceed 2 (semaphore limit)
    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })
})
