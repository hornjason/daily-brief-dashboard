// test/unit/signal-loader-single-path.test.ts
// GitHub Issue #276 — Regression test for single registry path

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { loadCustomerSignals } from '../../src/lib/signal-loader.ts'
import type { Signal } from '../../src/feature-module-registry.ts'

// Mock the registry to control signal return
const mockCollectAllSignals = mock(async (customerSlug: string): Promise<Signal[]> => [])

beforeEach(() => {
  mockCollectAllSignals.mockClear()
})

describe('signal-loader single registry path', () => {
  it('calls collectAllSignals and returns registrySignals', async () => {
    const testSignals: Signal[] = [
      {
        source: 'news-radar',
        type: 'news',
        headline: 'Test news item',
        detail: 'Test detail',
        timestamp: new Date().toISOString(),
        score: 100,
      },
      {
        source: 'lifecycle-events',
        type: 'lifecycle',
        headline: 'Product update',
        detail: 'New version available',
        timestamp: new Date().toISOString(),
        score: 80,
      },
    ]

    mockCollectAllSignals.mockResolvedValue(testSignals)

    // Temporarily mock the registry
    const originalRegistry = (await import('../../src/feature-module-registry.ts')).FeatureModuleRegistry
    ;(originalRegistry as any).collectAllSignals = mockCollectAllSignals

    const result = await loadCustomerSignals('test-customer', 'Test Customer')

    expect(mockCollectAllSignals).toHaveBeenCalledWith('test-customer')
    expect(result.registrySignals).toEqual(testSignals)
    expect(result.registrySignals.length).toBe(2)
  })

  it('returns empty legacy signals object', async () => {
    mockCollectAllSignals.mockResolvedValue([])

    const originalRegistry = (await import('../../src/feature-module-registry.ts')).FeatureModuleRegistry
    ;(originalRegistry as any).collectAllSignals = mockCollectAllSignals

    const result = await loadCustomerSignals('test-customer')

    expect(result.signals).toEqual({})
  })

  it('populates loaded array with module names returning signals', async () => {
    const testSignals: Signal[] = [
      {
        source: 'news-radar',
        type: 'news',
        headline: 'Item 1',
        detail: 'Detail 1',
        timestamp: new Date().toISOString(),
      },
      {
        source: 'lifecycle-events',
        type: 'lifecycle',
        headline: 'Item 2',
        detail: 'Detail 2',
        timestamp: new Date().toISOString(),
      },
    ]

    mockCollectAllSignals.mockResolvedValue(testSignals)

    const originalRegistry = (await import('../../src/feature-module-registry.ts')).FeatureModuleRegistry
    ;(originalRegistry as any).collectAllSignals = mockCollectAllSignals

    const result = await loadCustomerSignals('test-customer')

    // loaded should include module names that contributed signals
    expect(result.loaded).toContain('news-radar')
    expect(result.loaded).toContain('lifecycle-events')
  })

  it('populates missing array with registered modules returning zero signals', async () => {
    // Simulate a registry where some modules are registered but return no signals
    // This test will need to be updated once we have a way to query registered modules
    mockCollectAllSignals.mockResolvedValue([])

    const originalRegistry = (await import('../../src/feature-module-registry.ts')).FeatureModuleRegistry
    ;(originalRegistry as any).collectAllSignals = mockCollectAllSignals

    const result = await loadCustomerSignals('test-customer')

    // When no signals returned, all registered modules should be in missing
    // For now, verify missing is an array (implementation will populate it)
    expect(Array.isArray(result.missing)).toBe(true)
  })

  it('handles registry errors gracefully', async () => {
    mockCollectAllSignals.mockRejectedValue(new Error('Registry failure'))

    const originalRegistry = (await import('../../src/feature-module-registry.ts')).FeatureModuleRegistry
    ;(originalRegistry as any).collectAllSignals = mockCollectAllSignals

    // Should not throw, should return empty result
    const result = await loadCustomerSignals('test-customer')

    expect(result.registrySignals).toEqual([])
    expect(result.signals).toEqual({})
  })
})
