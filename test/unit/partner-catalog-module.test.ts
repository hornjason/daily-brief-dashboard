// test/unit/partner-catalog-module.test.ts
// GitHub Issue #265 — Partner Catalog Module registration tests

import { describe, test, expect, beforeEach } from 'bun:test'
import { FeatureModuleRegistry } from '../../src/feature-module-registry.ts'

// Import the module to trigger self-registration
import '../../src/modules/partner-catalog-module.ts'

describe('partner-catalog-module registration', () => {
  test('module is registered', () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')
    expect(mod).toBeDefined()
    expect(mod!.name).toBe('partner-catalog')
  })

  test('scope is portfolio (not customer-specific)', () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    expect(mod.scope).toBe('portfolio')
  })

  test('has signals function', () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    expect(mod.signals).toBeDefined()
    expect(typeof mod.signals).toBe('function')
  })

  test('signals returns partner data as signals', async () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    const signals = await mod.signals!('test-customer')
    // Should load from config and return signals
    // Even with empty/default data, should not throw
    expect(Array.isArray(signals)).toBe(true)
  })

  test('cachePaths returns expected path', () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    const paths = mod.cachePaths('test-slug')
    expect(paths.length).toBeGreaterThan(0)
    expect(paths[0]).toContain('partners')
  })
})
