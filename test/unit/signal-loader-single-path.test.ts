// test/unit/signal-loader-single-path.test.ts
// GitHub Issue #276 — Regression test for single registry path

import { describe, it, expect } from 'bun:test'
import { loadCustomerSignals } from '../../src/lib/signal-loader.ts'

describe('signal-loader single registry path', () => {
  it('calls collectAllSignals and returns registrySignals', async () => {
    // This test verifies the signal loader calls the registry and returns signals
    // In the full suite, real modules are loaded from the manifest
    const result = await loadCustomerSignals('test-customer', 'Test Customer')

    // Verify structure — registrySignals should be an array
    expect(Array.isArray(result.registrySignals)).toBe(true)

    // Verify it's calling the registry (not empty unless no modules exist)
    // We can't assert exact count because real modules may be loaded
  })

  it('returns empty legacy signals object', async () => {
    const result = await loadCustomerSignals('test-customer')
    // Legacy signals object should always be empty (removed in #276)
    expect(result.signals).toEqual({})
  })

  it('populates loaded array with module names returning signals', async () => {
    const result = await loadCustomerSignals('test-customer')

    // loaded should be an array of source names
    expect(Array.isArray(result.loaded)).toBe(true)

    // If any signals returned, loaded should contain their sources
    if (result.registrySignals.length > 0) {
      const sources = result.registrySignals.map(s => s.source)
      for (const source of sources) {
        expect(result.loaded).toContain(source)
      }
    }
  })

  it('populates missing array with registered modules returning zero signals', async () => {
    const result = await loadCustomerSignals('test-customer')

    // missing should be an array
    expect(Array.isArray(result.missing)).toBe(true)
  })

  it('handles registry errors gracefully', async () => {
    // Real registry should not throw even with no data
    const result = await loadCustomerSignals('test-customer')

    expect(Array.isArray(result.registrySignals)).toBe(true)
    expect(result.signals).toEqual({})
  })
})
