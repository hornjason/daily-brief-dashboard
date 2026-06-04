/**
 * test/unit/recommended-actions-module.test.ts
 * Tests for recommended-actions-module after ADR-032 migration to signal-query pipeline.
 *
 * Verifies that the module:
 * - Reads all signals via collectAllSignalsUnbudgeted
 * - Calls getRecommendations to cross-reference signals with portfolio
 * - Maps RecommendedAction[] to Signal[] format
 * - Produces signals with correct source, type, and metadata
 */

import { describe, it, expect, beforeAll, beforeEach, mock } from 'bun:test'
import type { Signal } from '../../src/feature-module-registry.ts'
import type { RecommendedAction } from '../../src/lib/signal-query.ts'

// ── Mock signal-loader and signal-query before importing the module ──

const mockCollectAllSignals = mock(async () => [] as Signal[])
const mockGetRecommendations = mock(() => [] as RecommendedAction[])

mock.module('../../src/lib/signal-loader.ts', () => ({
  collectAllSignalsUnbudgeted: (...args: any[]) => mockCollectAllSignals(...args),
}))

mock.module('../../src/lib/signal-query.ts', () => ({
  getRecommendations: (...args: any[]) => mockGetRecommendations(...args),
}))

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeTestAction(): RecommendedAction {
  return {
    action: 'Expand Ansible Automation Platform: Renewal alignment',
    confidence: 'high',
    triggerSignals: [
      {
        source: 'subscriptions',
        type: 'subscription',
        headline: 'AAP subscription expiring in 60 days',
        detail: 'Expired subscription',
        rawRelevance: 0.9,
        timestamp: new Date().toISOString(),
        metadata: { redHatProducts: ['Automation'] },
      },
      {
        source: 'cases',
        type: 'case',
        headline: '3 open cases on Ansible Tower migration',
        detail: 'Open cases',
        rawRelevance: 0.7,
        timestamp: new Date().toISOString(),
        metadata: {},
      },
    ],
    solution: {
      name: 'Automation Everywhere',
      type: 'play',
      url: 'https://example.com/play',
      assets: [{ name: 'AAP Cheatsheet', url: 'https://example.com/aap', type: 'cheatsheet' }],
    },
    actions: ['Schedule renewal call', 'Share migration guide'],
    narrative: 'Customer has expiring AAP subscription with active migration cases.',
  }
}

function makeSecondAction(): RecommendedAction {
  return {
    action: 'Explore OpenShift Container Platform adoption',
    confidence: 'medium',
    triggerSignals: [
      {
        source: 'tech-stack',
        type: 'technology',
        headline: 'Uses Kubernetes on AWS EKS',
        detail: 'Container orchestration',
        rawRelevance: 0.6,
        timestamp: new Date().toISOString(),
        metadata: {},
      },
    ],
    solution: {
      name: 'Container Management',
      type: 'product',
    },
    actions: ['Demo OpenShift'],
  }
}

// ── Lazy imports ──────────────────────────────────────────────────────────

let FeatureModuleRegistry: typeof import('../../src/feature-module-registry.ts').FeatureModuleRegistry

beforeAll(async () => {
  const regMod = await import('../../src/feature-module-registry.ts')
  FeatureModuleRegistry = regMod.FeatureModuleRegistry
  await import('../../src/modules/recommended-actions-module.ts')
})

beforeEach(() => {
  mockCollectAllSignals.mockReset()
  mockGetRecommendations.mockReset()
  mockCollectAllSignals.mockImplementation(async () => [])
  mockGetRecommendations.mockImplementation(() => [])
})

// ── Tests ─────────────────────────────────────────────────────────────────

describe('recommended-actions-module (#556 graph migration)', () => {
  it('is registered in FeatureModuleRegistry', () => {
    const mod = FeatureModuleRegistry.get('recommended-actions')
    expect(mod).toBeDefined()
    expect(mod!.name).toBe('recommended-actions')
    expect(mod!.displayName).toBe('Recommended Actions')
  })

  it('returns empty array when no signals exist', async () => {
    mockCollectAllSignals.mockResolvedValue([])
    mockGetRecommendations.mockReturnValue([])

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    const signals = await mod.signals!('acme-corp')

    expect(signals).toEqual([])
    expect(mockCollectAllSignals).toHaveBeenCalled()
  })

  it('maps RecommendedAction[] to Signal[] with correct source and type', async () => {
    mockCollectAllSignals.mockResolvedValue([])
    mockGetRecommendations.mockReturnValue([makeTestAction(), makeSecondAction()])

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    const signals = await mod.signals!('acme-corp')

    expect(signals.length).toBe(2)

    for (const s of signals) {
      expect(s.source).toBe('recommended-actions')
      expect(s.type).toBe('recommendation')
    }
  })

  it('includes solutionName, triggerSignalCount, confidence in metadata', async () => {
    mockCollectAllSignals.mockResolvedValue([])
    mockGetRecommendations.mockReturnValue([makeTestAction()])

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    const signals = await mod.signals!('acme-corp')

    const signal = signals[0]
    expect(signal.metadata?.solutionName).toBe('Automation Everywhere')
    expect(signal.metadata?.solutionType).toBe('play')
    expect(signal.metadata?.triggerSignalCount).toBe(2)
    expect(signal.metadata?.confidence).toBe('HIGH')
    expect(signal.metadata?.customerSlug).toBe('acme-corp')
  })

  it('includes actions and assets in metadata', async () => {
    mockCollectAllSignals.mockResolvedValue([])
    mockGetRecommendations.mockReturnValue([makeTestAction()])

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    const signals = await mod.signals!('acme-corp')

    const signal = signals[0]
    expect(signal.metadata?.actions).toEqual(['Schedule renewal call', 'Share migration guide'])
    expect(signal.metadata?.assets).toHaveLength(1)
  })

  it('maps confidence to rawRelevance correctly', async () => {
    mockCollectAllSignals.mockResolvedValue([])
    mockGetRecommendations.mockReturnValue([makeTestAction(), makeSecondAction()])

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    const signals = await mod.signals!('acme-corp')

    // high confidence → 0.95, medium → 0.75
    expect(signals[0].rawRelevance).toBe(0.95)
    expect(signals[1].rawRelevance).toBe(0.75)
  })

  it('builds headline from action text', async () => {
    mockCollectAllSignals.mockResolvedValue([])
    mockGetRecommendations.mockReturnValue([makeTestAction()])

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    const signals = await mod.signals!('acme-corp')

    expect(signals[0].headline).toBe('Expand Ansible Automation Platform: Renewal alignment')
  })

  it('extracts redHatProducts from trigger signals', async () => {
    mockCollectAllSignals.mockResolvedValue([])
    mockGetRecommendations.mockReturnValue([makeTestAction()])

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    const signals = await mod.signals!('acme-corp')

    // redHatProducts extracted from trigger signal metadata
    expect(signals[0].metadata?.redHatProducts).toBeDefined()
  })

  it('caches results for 5 minutes', async () => {
    mockCollectAllSignals.mockResolvedValue([])
    mockGetRecommendations.mockReturnValue([makeTestAction()])

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    await mod.signals!('acme-corp')
    await mod.signals!('acme-corp')

    // Second call should use cache, so getRecommendations called only once
    expect(mockGetRecommendations).toHaveBeenCalledTimes(1)
  })

  it('syncNow clears cache', async () => {
    mockCollectAllSignals.mockResolvedValue([])
    mockGetRecommendations.mockReturnValue([makeTestAction()])

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    await mod.signals!('acme-corp')
    await mod.syncNow!()
    await mod.signals!('acme-corp')

    expect(mockGetRecommendations).toHaveBeenCalledTimes(2)
  })
})
