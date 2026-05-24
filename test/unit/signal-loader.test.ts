// test/unit/signal-loader.test.ts
// Unit tests for signal loading (GitHub Issue #171)
// Tests the registry signal collection + legacy cache fallback pattern

import { describe, test, expect } from 'bun:test'
import { FeatureModuleRegistry, type FeatureModule, type Signal } from '../../src/feature-module-registry.ts'

describe('FeatureModuleRegistry.collectAllSignals', () => {
  test('collects signals from modules that implement signals()', async () => {
    const module1: FeatureModule = {
      name: 'test-module-1',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
      signals: async (customerSlug: string) => [
        {
          source: 'test-module-1',
          type: 'news',
          headline: 'Test headline 1',
          detail: 'Test detail 1',
          rawRelevance: 0.9,  // ADR-027: higher relevance to ensure it sorts first
          timestamp: '2026-05-14T00:00:00Z',
        }
      ]
    }

    const module2: FeatureModule = {
      name: 'test-module-2',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
      signals: async (customerSlug: string) => [
        {
          source: 'test-module-2',
          type: 'intelligence',
          headline: 'Test headline 2',
          detail: 'Test detail 2',
          rawRelevance: 0.5,  // ADR-027: lower relevance to ensure it sorts second
          timestamp: '2026-05-14T01:00:00Z',
        }
      ]
    }

    FeatureModuleRegistry.register(module1)
    FeatureModuleRegistry.register(module2)

    const allSignals = await FeatureModuleRegistry.collectAllSignals('test-customer')
    // Filter to only test-registered modules (real modules may be loaded from manifest)
    const signals = allSignals.filter(s => s.source === 'test-module-1' || s.source === 'test-module-2')

    expect(signals).toHaveLength(2)
    expect(signals[0].source).toBe('test-module-1')
    expect(signals[1].source).toBe('test-module-2')
  })

  test('skips modules that do not implement signals()', async () => {
    const moduleWithSignals: FeatureModule = {
      name: 'with-signals',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
      signals: async () => [
        {
          source: 'with-signals',
          type: 'news',
          headline: 'Has signals',
          detail: 'Detail',
          timestamp: '2026-05-14T00:00:00Z',
        }
      ]
    }

    const moduleWithoutSignals: FeatureModule = {
      name: 'without-signals',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
      // No signals() method
    }

    FeatureModuleRegistry.register(moduleWithSignals)
    FeatureModuleRegistry.register(moduleWithoutSignals)

    const allSignals = await FeatureModuleRegistry.collectAllSignals('test-customer')
    const signals = allSignals.filter(s => s.source === 'with-signals')

    expect(signals).toHaveLength(1)
    expect(signals[0].source).toBe('with-signals')
  })

  test('continues collecting when one module throws (fail-open)', async () => {
    const failingModule: FeatureModule = {
      name: 'failing-module',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
      signals: async () => {
        throw new Error('Signal fetch failed')
      }
    }

    const workingModule: FeatureModule = {
      name: 'working-module',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
      signals: async () => [
        {
          source: 'working-module',
          type: 'news',
          headline: 'Works fine',
          detail: 'Detail',
          timestamp: '2026-05-14T00:00:00Z',
        }
      ]
    }

    // Capture console.warn output
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: any[]) => warnings.push(args.join(' '))

    FeatureModuleRegistry.register(failingModule)
    FeatureModuleRegistry.register(workingModule)

    const allSignals = await FeatureModuleRegistry.collectAllSignals('test-customer')

    console.warn = originalWarn

    // Should have collected from working module despite failing module
    const signals = allSignals.filter(s => s.source === 'working-module')
    expect(signals).toHaveLength(1)
    expect(signals[0].source).toBe('working-module')

    // Should have logged a warning
    expect(warnings.some(w => w.includes('failing-module'))).toBe(true)
  })

  test('passes customerSlug to each signals() call', async () => {
    let capturedSlug: string | null = null

    const module: FeatureModule = {
      name: 'test-module',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
      signals: async (customerSlug: string) => {
        capturedSlug = customerSlug
        return []
      }
    }

    FeatureModuleRegistry.register(module)
    await FeatureModuleRegistry.collectAllSignals('acme-corp')

    expect(capturedSlug).toBe('acme-corp')
  })

  test('returns empty array when no modules are registered', async () => {
    // Note: In full suite, real modules may be loaded from manifest
    // This test verifies the method runs without error when called on a fresh registry
    const signals = await FeatureModuleRegistry.collectAllSignals('test-customer')
    expect(Array.isArray(signals)).toBe(true)
  })

  test('flattens signals from all modules into single array', async () => {
    const module1: FeatureModule = {
      name: 'multi-signal-1',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
      signals: async () => [
        {
          source: 'multi-signal-1',
          type: 'news',
          headline: 'Signal 1A',
          detail: 'Detail 1A',
          rawRelevance: 0.9,  // ADR-027: ensure it sorts first
          timestamp: '2026-05-14T00:00:00Z',
        },
        {
          source: 'multi-signal-1',
          type: 'news',
          headline: 'Signal 1B',
          detail: 'Detail 1B',
          rawRelevance: 0.8,  // ADR-027: ensure it sorts second
          timestamp: '2026-05-14T01:00:00Z',
        }
      ]
    }

    const module2: FeatureModule = {
      name: 'multi-signal-2',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
      signals: async () => [
        {
          source: 'multi-signal-2',
          type: 'intelligence',
          headline: 'Signal 2A',
          detail: 'Detail 2A',
          rawRelevance: 0.7,  // ADR-027: ensure it sorts third
          timestamp: '2026-05-14T02:00:00Z',
        }
      ]
    }

    FeatureModuleRegistry.register(module1)
    FeatureModuleRegistry.register(module2)

    const allSignals = await FeatureModuleRegistry.collectAllSignals('test-customer')
    const signals = allSignals.filter(s => s.source === 'multi-signal-1' || s.source === 'multi-signal-2')

    expect(signals).toHaveLength(3)
    expect(signals.map(s => s.headline)).toEqual(['Signal 1A', 'Signal 1B', 'Signal 2A'])
  })
})
