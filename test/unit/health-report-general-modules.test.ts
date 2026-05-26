/**
 * Regression test for GitHub Issue #391/#396 — Signal Quality health check false errors
 *
 * General-scope modules (rss, events, value-maps, product-intel, partner-catalog, lifecycle)
 * should NOT be flagged as errors when their signals lack customerSlug.
 * These modules produce portfolio-level data that is correctly general.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { FeatureModuleRegistry, type Signal, type FeatureModule } from '../../src/feature-module-registry.ts'

// ── Test Helpers ─────────────────────────────────────────────────────────────

function makeGeneralSignal(source: string): Signal {
  return {
    source,
    type: 'product-intel',
    headline: 'General product signal',
    detail: 'This is a general signal with no customer specificity',
    timestamp: new Date().toISOString(),
    rawRelevance: 0.5,
    metadata: {
      // No customerSlug — this is intentionally general
    },
  }
}

function makeCustomerSignal(source: string, customerSlug: string): Signal {
  return {
    source,
    type: 'expansion',
    headline: 'Customer-specific signal',
    detail: 'Signal with customer context',
    timestamp: new Date().toISOString(),
    rawRelevance: 0.7,
    metadata: {
      customerSlug,
    },
  }
}

function registerTestModule(name: string, scope: 'portfolio' | 'customer' | 'both', signalsFn: (slug: string) => Promise<Signal[]>): void {
  const mod: FeatureModule = {
    name,
    scope,
    cachePaths: () => [],
    async fetch() {},
    async cleanup() {},
    async syncNow() {},
    signals: signalsFn,
  }
  FeatureModuleRegistry.register(mod)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('getHealthReport — general-scope modules (#391/#396)', () => {
  beforeAll(() => {
    FeatureModuleRegistry._resetForTesting()

    // Register a portfolio-scope module with general signals (no customerSlug)
    registerTestModule('rss-general', 'portfolio', async () => [
      makeGeneralSignal('rss-general'),
      makeGeneralSignal('rss-general'),
      makeGeneralSignal('rss-general'),
    ])

    // Register a customer-scope module with customer signals (varying rawRelevance to avoid same-rawRelevance warning)
    registerTestModule('pipeline-test', 'customer', async (slug) => [
      { ...makeCustomerSignal('pipeline-test', slug), rawRelevance: 0.9 },
      { ...makeCustomerSignal('pipeline-test', slug), rawRelevance: 0.5 },
    ])

    // Register a customer-scope module with NO signals (real missing data)
    registerTestModule('cases-empty', 'customer', async () => [])

    // Register a portfolio-scope module with NO signals
    registerTestModule('events-empty', 'portfolio', async () => [])
  })

  afterAll(() => {
    FeatureModuleRegistry._resetForTesting()
  })

  test('portfolio module with general signals shows as healthy (not error/warning for missing customerSlug)', async () => {
    const report = await FeatureModuleRegistry.getHealthReport('test-customer')
    const rssResult = report.modules.find(m => m.name === 'rss-general')

    expect(rssResult).toBeDefined()
    expect(rssResult!.status).toBe('healthy')
    expect(rssResult!.warnings).not.toContainEqual(expect.stringContaining('customerSlug'))
    expect(rssResult!.signalCount).toBe(3)
  })

  test('customer module with customer signals shows as healthy', async () => {
    const report = await FeatureModuleRegistry.getHealthReport('test-customer')
    const pipelineResult = report.modules.find(m => m.name === 'pipeline-test')

    expect(pipelineResult).toBeDefined()
    expect(pipelineResult!.status).toBe('healthy')
    expect(pipelineResult!.signalCount).toBe(2)
  })

  test('customer module with no signals shows warning', async () => {
    const report = await FeatureModuleRegistry.getHealthReport('test-customer')
    const casesResult = report.modules.find(m => m.name === 'cases-empty')

    expect(casesResult).toBeDefined()
    expect(casesResult!.status).toBe('warning')
    expect(casesResult!.warnings).toContainEqual('No signals returned')
  })

  test('portfolio module with no signals shows as healthy (not a problem for general modules)', async () => {
    const report = await FeatureModuleRegistry.getHealthReport('test-customer')
    const eventsResult = report.modules.find(m => m.name === 'events-empty')

    expect(eventsResult).toBeDefined()
    // Empty portfolio module should be healthy — it just has no general data yet
    expect(eventsResult!.status).toBe('healthy')
  })
})
