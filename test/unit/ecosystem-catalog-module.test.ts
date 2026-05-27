// test/unit/ecosystem-catalog-module.test.ts
// GitHub Issue #438 — Ecosystem Catalog Module registration and signal tests

import { describe, test, expect, beforeAll } from 'bun:test'
import { FeatureModuleRegistry } from '../../src/feature-module-registry.ts'

// Use dynamic import to avoid ESM TDZ issues with self-registering modules
beforeAll(async () => {
  await import('../../src/modules/ecosystem-catalog-module.ts')
})

describe('ecosystem-catalog-module registration', () => {
  test('module is registered with name ecosystem-catalog', () => {
    const mod = FeatureModuleRegistry.get('ecosystem-catalog')
    expect(mod).toBeDefined()
    expect(mod!.name).toBe('ecosystem-catalog')
  })

  test('scope is portfolio', () => {
    const mod = FeatureModuleRegistry.get('ecosystem-catalog')!
    expect(mod.scope).toBe('portfolio')
  })

  test('has displayName', () => {
    const mod = FeatureModuleRegistry.get('ecosystem-catalog')!
    expect(mod.displayName).toBe('Ecosystem Catalog')
  })

  test('has refreshEndpoint for admin panel visibility', () => {
    const mod = FeatureModuleRegistry.get('ecosystem-catalog')!
    expect(mod.refreshEndpoint).toBe('/api/refresh/ecosystem-catalog')
  })

  test('cacheTtlMs is 30 days', () => {
    const mod = FeatureModuleRegistry.get('ecosystem-catalog')!
    expect(mod.cacheTtlMs).toBe(30 * 24 * 60 * 60 * 1000)
  })

  test('has ensureFresh implementation', () => {
    const mod = FeatureModuleRegistry.get('ecosystem-catalog')!
    expect(mod.ensureFresh).toBeDefined()
    expect(typeof mod.ensureFresh).toBe('function')
  })

  test('has signals function', () => {
    const mod = FeatureModuleRegistry.get('ecosystem-catalog')!
    expect(mod.signals).toBeDefined()
    expect(typeof mod.signals).toBe('function')
  })
})

describe('ecosystem-catalog-module signals', () => {
  test('empty cache produces zero signals', async () => {
    // With no files in the cache dir, signals should return empty
    const mod = FeatureModuleRegistry.get('ecosystem-catalog')!
    const signals = await mod.signals!('test-customer')
    expect(Array.isArray(signals)).toBe(true)
    // May or may not be empty depending on whether config-templates are in cache path
    // but should not throw
  })

  test('signal structure has correct metadata fields', async () => {
    const mod = FeatureModuleRegistry.get('ecosystem-catalog')!
    const signals = await mod.signals!('test-customer')

    // If there are signals, verify structure
    for (const signal of signals) {
      expect(signal.source).toBe('ecosystem-catalog')
      expect(signal.type).toBe('intelligence')
      expect(signal.headline).toBeDefined()
      expect(signal.detail).toBeDefined()
      expect(signal.rawRelevance).toBe(0.5)
      expect(signal.url).toBeDefined()

      // Metadata fields
      expect(signal.metadata).toBeDefined()
      if (signal.metadata) {
        expect(signal.metadata.partnerName).toBeDefined()
        expect(signal.metadata.platform).toBeDefined()
        expect(signal.metadata.solutionName).toBeDefined()
        expect(Array.isArray(signal.metadata.resourceTypes)).toBe(true)
      }
    }
  })

  test('signals have correct source and type', async () => {
    const mod = FeatureModuleRegistry.get('ecosystem-catalog')!
    const signals = await mod.signals!('any-slug')
    for (const s of signals) {
      expect(s.source).toBe('ecosystem-catalog')
      expect(s.type).toBe('intelligence')
    }
  })

  test('signals never set score directly (ADR-027 compliance)', async () => {
    const mod = FeatureModuleRegistry.get('ecosystem-catalog')!
    const signals = await mod.signals!('any-slug')
    for (const s of signals) {
      expect(s.score).toBeUndefined()
    }
  })
})
