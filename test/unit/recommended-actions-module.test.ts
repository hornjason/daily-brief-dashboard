/**
 * test/unit/recommended-actions-module.test.ts
 * Tests for recommended-actions-module after #556 migration to graph pipeline.
 *
 * Verifies that the module:
 * - Reads persisted graph via loadGraph (not getExpansionMotion to avoid recursion)
 * - Calls buildMotion with the graph + SalesHub signals
 * - Maps StrategicMotion phases to Signal[] format
 * - Produces signals with correct source, type, and metadata
 */

import { describe, it, expect, beforeAll, beforeEach, mock } from 'bun:test'
import type { Signal } from '../../src/feature-module-registry.ts'
import type { StrategicMotion, MotionPhase } from '../../src/lib/motion-builder.ts'
import type { CustomerGraph } from '../../src/lib/intelligence-graph-types.ts'

// ── Mock intelligence-graph and motion-builder before importing the module ──

const mockLoadGraph = mock(() => null as CustomerGraph | null)
const mockFilterStaleEdges = mock((graph: CustomerGraph) => graph.edges)
const mockBuildMotion = mock(async () => null as StrategicMotion | null)

mock.module('../../src/lib/intelligence-graph.ts', () => ({
  loadGraph: (...args: any[]) => mockLoadGraph(...args),
  filterStaleEdges: (...args: any[]) => mockFilterStaleEdges(...args),
  buildCustomerGraph: mock(),
  persistGraph: mock(),
}))

mock.module('../../src/lib/motion-builder.ts', () => ({
  buildMotion: (...args: any[]) => mockBuildMotion(...args),
}))

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeTestGraph(): CustomerGraph {
  return {
    customerSlug: 'acme-corp',
    customerName: 'Acme Corp',
    nodeCount: 3,
    edgeCount: 2,
    nodes: {},
    edges: [],
    builtAt: new Date().toISOString(),
  }
}

function makeTestMotion(): StrategicMotion {
  return {
    id: 'motion-test-001',
    customerSlug: 'acme-corp',
    customerName: 'Acme Corp',
    title: 'Acme Expansion: Ansible + OpenShift',
    salesPlay: 'Platform Modernization',
    phases: [
      {
        id: 'phase-anchor-001',
        name: 'Ansible Automation Platform',
        category: 'anchor',
        urgency: 'high',
        tactics: [
          {
            name: 'Renewal alignment',
            parentTdp: 'Automation',
            assets: [{ name: 'AAP Cheatsheet', url: 'https://example.com/aap', type: 'cheatsheet' }],
          },
        ],
        targetPersonas: ['VP IT Operations', 'Director of Platform Engineering'],
        evidence: [
          { module: 'subscriptions', fact: 'AAP subscription expiring in 60 days', url: 'https://example.com/sub' },
          { module: 'cases', fact: '3 open cases on Ansible Tower migration' },
        ],
      },
      {
        id: 'phase-expand-001',
        name: 'OpenShift Container Platform',
        category: 'expand',
        urgency: 'medium',
        tactics: [
          {
            name: 'Container adoption',
            parentTdp: 'Container Management',
            assets: [{ name: 'OCP ROI Calculator', url: 'https://example.com/ocp', type: 'tool' }],
          },
        ],
        targetPersonas: ['CTO / Platform Engineering', 'VP Infrastructure'],
        evidence: [
          { module: 'tech-stack', fact: 'Running Kubernetes 1.28 on AWS EKS' },
        ],
      },
    ],
    confidence: 'high',
    generatedAt: '2026-06-01T12:00:00.000Z',
    status: 'active',
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
  mockLoadGraph.mockReset()
  mockFilterStaleEdges.mockReset()
  mockBuildMotion.mockReset()
  mockFilterStaleEdges.mockImplementation((graph: CustomerGraph) => graph.edges)
})

// ── Tests ─────────────────────────────────────────────────────────────────

describe('recommended-actions-module (#556 graph migration)', () => {
  it('is registered in FeatureModuleRegistry', () => {
    const mod = FeatureModuleRegistry.get('recommended-actions')
    expect(mod).toBeDefined()
    expect(mod!.name).toBe('recommended-actions')
    expect(mod!.displayName).toBe('Recommended Actions')
  })

  it('returns empty array when no persisted graph exists', async () => {
    mockLoadGraph.mockReturnValue(null)

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    const signals = await mod.signals!('acme-corp')

    expect(signals).toEqual([])
    expect(mockLoadGraph).toHaveBeenCalled()
    expect(mockBuildMotion).not.toHaveBeenCalled()
  })

  it('maps MotionPhase[] to Signal[] with correct source and type', async () => {
    mockLoadGraph.mockReturnValue(makeTestGraph())
    mockBuildMotion.mockResolvedValue(makeTestMotion())

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    const signals = await mod.signals!('acme-corp')

    expect(signals.length).toBe(2)

    for (const s of signals) {
      expect(s.source).toBe('recommended-actions')
      expect(s.type).toBe('recommendation')
    }
  })

  it('includes motionTitle, phaseCategory, urgency in metadata', async () => {
    mockLoadGraph.mockReturnValue(makeTestGraph())
    mockBuildMotion.mockResolvedValue(makeTestMotion())

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    const signals = await mod.signals!('acme-corp')

    const anchorSignal = signals[0]
    expect(anchorSignal.metadata?.motionTitle).toBe('Acme Expansion: Ansible + OpenShift')
    expect(anchorSignal.metadata?.motionId).toBe('motion-test-001')
    expect(anchorSignal.metadata?.phaseCategory).toBe('anchor')
    expect(anchorSignal.metadata?.urgency).toBe('high')
    expect(anchorSignal.metadata?.confidence).toBe('HIGH')
    expect(anchorSignal.metadata?.solutionName).toBe('Ansible Automation Platform')
    expect(anchorSignal.metadata?.salesPlay).toBe('Platform Modernization')
  })

  it('includes targetPersonas, tactics, evidence, assets in metadata', async () => {
    mockLoadGraph.mockReturnValue(makeTestGraph())
    mockBuildMotion.mockResolvedValue(makeTestMotion())

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    const signals = await mod.signals!('acme-corp')

    const anchorSignal = signals[0]
    expect(anchorSignal.metadata?.targetPersonas).toEqual(['VP IT Operations', 'Director of Platform Engineering'])
    expect(anchorSignal.metadata?.tactics).toHaveLength(1)
    expect(anchorSignal.metadata?.evidence).toHaveLength(2)
    expect(anchorSignal.metadata?.assets).toHaveLength(1)
    expect(anchorSignal.metadata?.triggerSignalCount).toBe(2)
    expect(anchorSignal.metadata?.redHatProducts).toContain('Automation')
  })

  it('maps urgency to rawRelevance correctly', async () => {
    mockLoadGraph.mockReturnValue(makeTestGraph())
    mockBuildMotion.mockResolvedValue(makeTestMotion())

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    const signals = await mod.signals!('acme-corp')

    expect(signals[0].rawRelevance).toBe(0.85)
    expect(signals[1].rawRelevance).toBe(0.70)
  })

  it('sets solutionType based on phase category', async () => {
    mockLoadGraph.mockReturnValue(makeTestGraph())
    mockBuildMotion.mockResolvedValue(makeTestMotion())

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    const signals = await mod.signals!('acme-corp')

    expect(signals[0].metadata?.solutionType).toBe('product')
    expect(signals[1].metadata?.solutionType).toBe('play')
  })

  it('builds headline from phase name + tactic names', async () => {
    mockLoadGraph.mockReturnValue(makeTestGraph())
    mockBuildMotion.mockResolvedValue(makeTestMotion())

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    const signals = await mod.signals!('acme-corp')

    expect(signals[0].headline).toBe('Ansible Automation Platform: Renewal alignment')
    expect(signals[1].headline).toBe('OpenShift Container Platform: Container adoption')
  })

  it('uses timestamp from motion.generatedAt', async () => {
    mockLoadGraph.mockReturnValue(makeTestGraph())
    mockBuildMotion.mockResolvedValue(makeTestMotion())

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    const signals = await mod.signals!('acme-corp')

    expect(signals[0].timestamp).toBe('2026-06-01T12:00:00.000Z')
  })

  it('uses first evidence URL as signal url', async () => {
    mockLoadGraph.mockReturnValue(makeTestGraph())
    mockBuildMotion.mockResolvedValue(makeTestMotion())

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    const signals = await mod.signals!('acme-corp')

    expect(signals[0].url).toBe('https://example.com/sub')
    expect(signals[1].url).toBeUndefined()
  })

  it('caches results for 5 minutes', async () => {
    mockLoadGraph.mockReturnValue(makeTestGraph())
    mockBuildMotion.mockResolvedValue(makeTestMotion())

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    await mod.signals!('acme-corp')
    await mod.signals!('acme-corp')

    expect(mockBuildMotion).toHaveBeenCalledTimes(1)
  })

  it('syncNow clears cache', async () => {
    mockLoadGraph.mockReturnValue(makeTestGraph())
    mockBuildMotion.mockResolvedValue(makeTestMotion())

    const mod = FeatureModuleRegistry.get('recommended-actions')!
    await mod.syncNow!()
    await mod.signals!('acme-corp')
    await mod.syncNow!()
    await mod.signals!('acme-corp')

    expect(mockBuildMotion).toHaveBeenCalledTimes(2)
  })
})
