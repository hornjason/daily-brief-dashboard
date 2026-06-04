/**
 * test/unit/graph-accumulation.test.ts
 * TDD tests for Graph Accumulation + History + Edge Staleness — #522
 *
 * Tests:
 * 1. history preserved across graph rebuilds
 * 2. dismissed status carried forward on rebuild
 * 3. pinned status carried forward on rebuild
 * 4. filterStaleEdges removes edges with outdated scoredAt
 * 5. filterStaleEdges keeps fresh edges
 * 6. history pruned after 90 days
 * 7. graph stays under 50KB with history
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import type { Signal } from '../../src/feature-module-registry.ts'
import type {
  CustomerGraph,
  IntelligenceNode,
  IntelligenceEdge,
  MotionHistoryEntry,
} from '../../src/lib/intelligence-graph-types.ts'

// Lazy imports to avoid ESM TDZ issues
let buildCustomerGraph: typeof import('../../src/lib/intelligence-graph.ts').buildCustomerGraph
let persistGraph: typeof import('../../src/lib/intelligence-graph.ts').persistGraph
let loadGraph: typeof import('../../src/lib/intelligence-graph.ts').loadGraph
let mergeHistory: typeof import('../../src/lib/intelligence-graph.ts').mergeHistory
let pruneHistory: typeof import('../../src/lib/intelligence-graph.ts').pruneHistory
let filterStaleEdges: typeof import('../../src/lib/intelligence-graph.ts').filterStaleEdges
let findNodesByType: typeof import('../../src/lib/graph-utils.ts').findNodesByType
let findActiveNodesByType: typeof import('../../src/lib/graph-utils.ts').findActiveNodesByType
let scoreTactics: typeof import('../../src/lib/tactic-scorer.ts').scoreTactics

beforeAll(async () => {
  const graphModule = await import('../../src/lib/intelligence-graph.ts')
  buildCustomerGraph = graphModule.buildCustomerGraph
  persistGraph = graphModule.persistGraph
  loadGraph = graphModule.loadGraph
  mergeHistory = graphModule.mergeHistory
  pruneHistory = graphModule.pruneHistory
  filterStaleEdges = graphModule.filterStaleEdges

  const utilsModule = await import('../../src/lib/graph-utils.ts')
  findNodesByType = utilsModule.findNodesByType
  findActiveNodesByType = utilsModule.findActiveNodesByType

  const tacticModule = await import('../../src/lib/tactic-scorer.ts')
  scoreTactics = tacticModule.scoreTactics
})

// ── Test Data Dir ─────────────────────────────────────────────────────────────

const TEST_DATA_DIR = resolve(import.meta.dir, '../../.test-data-graph-accum')

beforeAll(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true })
  mkdirSync(TEST_DATA_DIR, { recursive: true })
})

afterAll(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true })
})

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_SIGNALS: Signal[] = [
  {
    source: 'subscriptions', type: 'subscription',
    headline: 'RHEL Server - 8 subs',
    detail: '', timestamp: '2026-05-31', score: 0.7,
    metadata: { productDescription: 'Red Hat Enterprise Linux Server', quantity: 8, status: 'Active', endDate: '2027-05-08' },
  },
  {
    source: 'cases', type: 'case',
    headline: 'Case 04459393: Add New Users',
    detail: '', timestamp: '2026-05-31', score: 0.5,
    metadata: { caseNumber: '04459393', severity: '4', status: 'Waiting on Customer', product: 'RHEL' },
  },
  {
    source: 'ccsp', type: 'cloud-spend',
    headline: 'AWS cloud spend: $239,663 ACV',
    detail: '', timestamp: '2026-05-31', score: 0.8,
    metadata: { cloudPartner: 'AWS', acvPlus: 239663 },
  },
]

// ── Tests: History ────────────────────────────────────────────────────────────

describe('Graph Accumulation — history preservation', () => {
  it('history preserved across graph rebuilds', () => {
    // Build initial graph with history
    const initialHistory: MotionHistoryEntry[] = [
      {
        motionId: 'motion-001',
        title: 'Expand into OpenShift',
        phaseCount: 3,
        status: 'active',
        firstSeenAt: '2026-05-01T00:00:00.000Z',
        lastSeenAt: '2026-05-15T00:00:00.000Z',
      },
    ]

    const graph1 = buildCustomerGraph('test-cust', 'Test Customer', BASE_SIGNALS)
    graph1.history = initialHistory

    // Persist and reload
    persistGraph(graph1, TEST_DATA_DIR)
    const loaded = loadGraph('test-cust', TEST_DATA_DIR)

    expect(loaded).not.toBeNull()
    expect(loaded!.history).toBeDefined()
    expect(loaded!.history!.length).toBe(1)
    expect(loaded!.history![0].motionId).toBe('motion-001')
    expect(loaded!.history![0].title).toBe('Expand into OpenShift')

    // Rebuild from signals with existing graph
    const graph2 = buildCustomerGraph('test-cust', 'Test Customer', BASE_SIGNALS, loaded)

    // mergeHistory carries the previous history forward
    const merged = mergeHistory(graph2, loaded!.history!)
    expect(merged.history).toBeDefined()
    expect(merged.history!.length).toBeGreaterThanOrEqual(1)
    expect(merged.history!.some(h => h.motionId === 'motion-001')).toBe(true)
  })

  it('dismissed status carried forward on rebuild', () => {
    const previousHistory: MotionHistoryEntry[] = [
      {
        motionId: 'motion-dismissed',
        title: 'Migrate to RHEL 9',
        phaseCount: 2,
        status: 'dismissed',
        firstSeenAt: '2026-05-01T00:00:00.000Z',
        lastSeenAt: '2026-05-15T00:00:00.000Z',
      },
    ]

    const graph = buildCustomerGraph('test-cust-d', 'Test Customer D', BASE_SIGNALS)
    const merged = mergeHistory(graph, previousHistory)

    // Dismissed status must be preserved
    const entry = merged.history!.find(h => h.motionId === 'motion-dismissed')
    expect(entry).toBeDefined()
    expect(entry!.status).toBe('dismissed')
  })

  it('pinned status carried forward on rebuild', () => {
    const previousHistory: MotionHistoryEntry[] = [
      {
        motionId: 'motion-pinned',
        title: 'Expand Ansible footprint',
        phaseCount: 4,
        status: 'pinned',
        firstSeenAt: '2026-05-01T00:00:00.000Z',
        lastSeenAt: '2026-05-15T00:00:00.000Z',
      },
    ]

    const graph = buildCustomerGraph('test-cust-p', 'Test Customer P', BASE_SIGNALS)
    const merged = mergeHistory(graph, previousHistory)

    const entry = merged.history!.find(h => h.motionId === 'motion-pinned')
    expect(entry).toBeDefined()
    expect(entry!.status).toBe('pinned')
  })
})

// ── Tests: Edge Staleness ─────────────────────────────────────────────────────

describe('Graph Accumulation — edge staleness', () => {
  it('filterStaleEdges removes edges with outdated scoredAt', () => {
    const oldTimestamp = '2026-05-01T00:00:00.000Z'
    const newTimestamp = '2026-05-20T00:00:00.000Z'

    const graph: CustomerGraph = {
      customerId: 'stale-test',
      customerName: 'Stale Test',
      version: '1.0',
      builtAt: newTimestamp,
      nodeCount: 2,
      edgeCount: 1,
      nodes: {
        'customer:stale-test': {
          id: 'customer:stale-test',
          type: 'customer',
          name: 'Stale Test',
          properties: {},
          sourceModule: 'intelligence-graph',
          contentHash: 'aaaa1111',
          updatedAt: newTimestamp,
        },
        'subscription:rhel': {
          id: 'subscription:rhel',
          type: 'subscription',
          name: 'RHEL',
          properties: {},
          sourceModule: 'subscriptions',
          contentHash: 'bbbb2222',
          updatedAt: newTimestamp, // Node was updated AFTER edge was scored
        },
      },
      edges: [
        {
          from: 'customer:stale-test',
          to: 'subscription:rhel',
          relation: 'HAS_SUBSCRIPTION',
          tier: 'derived',
          strength: 0.7,
          evidence: ['RHEL Server - 8 subs'],
          scoredAt: oldTimestamp, // Edge scored BEFORE node update = stale
          createdAt: oldTimestamp,
          sourceType: 'subscriptions',
        },
      ],
    }

    const freshEdges = filterStaleEdges(graph)
    expect(freshEdges.length).toBe(0) // The stale edge should be filtered out
  })

  it('filterStaleEdges keeps fresh edges', () => {
    const edgeTimestamp = '2026-05-25T00:00:00.000Z'
    const nodeTimestamp = '2026-05-20T00:00:00.000Z'

    const graph: CustomerGraph = {
      customerId: 'fresh-test',
      customerName: 'Fresh Test',
      version: '1.0',
      builtAt: edgeTimestamp,
      nodeCount: 2,
      edgeCount: 1,
      nodes: {
        'customer:fresh-test': {
          id: 'customer:fresh-test',
          type: 'customer',
          name: 'Fresh Test',
          properties: {},
          sourceModule: 'intelligence-graph',
          contentHash: 'cccc3333',
          updatedAt: nodeTimestamp,
        },
        'subscription:ocp': {
          id: 'subscription:ocp',
          type: 'subscription',
          name: 'OCP',
          properties: {},
          sourceModule: 'subscriptions',
          contentHash: 'dddd4444',
          updatedAt: nodeTimestamp, // Node updated BEFORE edge scored
        },
      },
      edges: [
        {
          from: 'customer:fresh-test',
          to: 'subscription:ocp',
          relation: 'HAS_SUBSCRIPTION',
          tier: 'derived',
          strength: 0.8,
          evidence: ['OCP - 2 subs'],
          scoredAt: edgeTimestamp, // Edge scored AFTER node update = fresh
          createdAt: nodeTimestamp,
          sourceType: 'subscriptions',
        },
      ],
    }

    const freshEdges = filterStaleEdges(graph)
    expect(freshEdges.length).toBe(1)
    expect(freshEdges[0].to).toBe('subscription:ocp')
  })
})

// ── Tests: History Pruning ────────────────────────────────────────────────────

describe('Graph Accumulation — history pruning', () => {
  it('history pruned after 90 days', () => {
    const now = new Date()
    const oldDate = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000).toISOString() // 91 days ago
    const recentDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days ago

    const history: MotionHistoryEntry[] = [
      {
        motionId: 'old-motion',
        title: 'Old Motion',
        phaseCount: 2,
        status: 'active',
        firstSeenAt: oldDate,
        lastSeenAt: oldDate,
      },
      {
        motionId: 'recent-motion',
        title: 'Recent Motion',
        phaseCount: 3,
        status: 'active',
        firstSeenAt: recentDate,
        lastSeenAt: recentDate,
      },
    ]

    const pruned = pruneHistory(history)

    expect(pruned.length).toBe(1)
    expect(pruned[0].motionId).toBe('recent-motion')
  })

  it('graph stays under 50KB with history', () => {
    // Build a graph and add a realistic amount of history entries
    const graph = buildCustomerGraph('size-test', 'Size Test Customer', BASE_SIGNALS)

    // Add 50 history entries (realistic accumulation over time)
    const history: MotionHistoryEntry[] = []
    for (let i = 0; i < 50; i++) {
      history.push({
        motionId: `motion-${i}`,
        title: `Strategic Motion ${i} for expansion opportunity analysis`,
        phaseCount: Math.floor(Math.random() * 5) + 1,
        status: i % 3 === 0 ? 'dismissed' : i % 5 === 0 ? 'pinned' : 'active',
        firstSeenAt: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
        lastSeenAt: new Date().toISOString(),
      })
    }

    graph.history = history
    persistGraph(graph, TEST_DATA_DIR)

    const filePath = resolve(TEST_DATA_DIR, 'size-test', 'intelligence-graph.json')
    const raw = readFileSync(filePath, 'utf-8')
    const sizeBytes = Buffer.byteLength(raw, 'utf-8')

    expect(sizeBytes).toBeLessThan(50 * 1024) // Must stay under 50KB
  })
})

// ── Reduced fixture (without case signal) ────────────────────────────────────

const REDUCED_SIGNALS: Signal[] = [
  BASE_SIGNALS[0], // RHEL subscription
  BASE_SIGNALS[2], // CCSP
]

// ── Tests: Temporal Signal Persistence (#601) ─────────────────────────────────

describe('Temporal Signal Persistence — new nodes get history (#601)', () => {
  it('new nodes get appeared + lastSeen + status:active', () => {
    const graph = buildCustomerGraph('temporal-test', 'Temporal Test', BASE_SIGNALS)

    for (const node of Object.values(graph.nodes)) {
      expect(node.history).toBeDefined()
      expect(node.history!.status).toBe('active')
      expect(node.history!.appeared.length).toBeGreaterThan(0)
      expect(node.history!.lastSeen.length).toBeGreaterThan(0)
    }
  })

  it('appeared and lastSeen are same on first build', () => {
    const graph = buildCustomerGraph('temporal-test', 'Temporal Test', BASE_SIGNALS)

    for (const node of Object.values(graph.nodes)) {
      expect(node.history!.appeared).toBe(node.history!.lastSeen)
    }
  })
})

describe('Temporal Signal Persistence — rebuild preserves appeared (#601)', () => {
  it('rebuilding with same signals keeps appeared unchanged', () => {
    const graph1 = buildCustomerGraph('temporal-test', 'Temporal Test', BASE_SIGNALS)

    const originalAppeared: Record<string, string> = {}
    for (const [id, node] of Object.entries(graph1.nodes)) {
      originalAppeared[id] = node.history!.appeared
    }

    const graph2 = buildCustomerGraph('temporal-test', 'Temporal Test', BASE_SIGNALS, graph1)

    for (const [id, node] of Object.entries(graph2.nodes)) {
      if (originalAppeared[id]) {
        expect(node.history!.appeared).toBe(originalAppeared[id])
      }
    }

    for (const node of Object.values(graph2.nodes)) {
      expect(node.history!.status).toBe('active')
    }
  })
})

describe('Temporal Signal Persistence — disappeared signals (#601)', () => {
  it('rebuilding WITHOUT a signal marks it historical', () => {
    const graph1 = buildCustomerGraph('temporal-test', 'Temporal Test', BASE_SIGNALS)

    const caseNodeId = Object.entries(graph1.nodes).find(([, n]) => n.type === 'case')?.[0]
    expect(caseNodeId).toBeDefined()
    expect(graph1.nodes[caseNodeId!].history!.status).toBe('active')

    const graph2 = buildCustomerGraph('temporal-test', 'Temporal Test', REDUCED_SIGNALS, graph1)

    expect(graph2.nodes[caseNodeId!]).toBeDefined()
    expect(graph2.nodes[caseNodeId!].history!.status).toBe('historical')

    // Other nodes still active
    const subNode = Object.values(graph2.nodes).find(n => n.type === 'subscription')
    expect(subNode!.history!.status).toBe('active')
  })

  it('historical nodes persist across multiple rebuilds', () => {
    const graph1 = buildCustomerGraph('temporal-test', 'Temporal Test', BASE_SIGNALS)
    const caseNodeId = Object.entries(graph1.nodes).find(([, n]) => n.type === 'case')?.[0]!

    const graph2 = buildCustomerGraph('temporal-test', 'Temporal Test', REDUCED_SIGNALS, graph1)
    expect(graph2.nodes[caseNodeId].history!.status).toBe('historical')

    const graph3 = buildCustomerGraph('temporal-test', 'Temporal Test', REDUCED_SIGNALS, graph2)
    expect(graph3.nodes[caseNodeId]).toBeDefined()
    expect(graph3.nodes[caseNodeId].history!.status).toBe('historical')

    const graph4 = buildCustomerGraph('temporal-test', 'Temporal Test', REDUCED_SIGNALS, graph3)
    expect(graph4.nodes[caseNodeId]).toBeDefined()
    expect(graph4.nodes[caseNodeId].history!.status).toBe('historical')
  })

  it('historical node becomes active again if signal reappears', () => {
    const graph1 = buildCustomerGraph('temporal-test', 'Temporal Test', BASE_SIGNALS)
    const caseNodeId = Object.entries(graph1.nodes).find(([, n]) => n.type === 'case')?.[0]!

    const graph2 = buildCustomerGraph('temporal-test', 'Temporal Test', REDUCED_SIGNALS, graph1)
    expect(graph2.nodes[caseNodeId].history!.status).toBe('historical')

    const graph3 = buildCustomerGraph('temporal-test', 'Temporal Test', BASE_SIGNALS, graph2)
    expect(graph3.nodes[caseNodeId].history!.status).toBe('active')
  })
})

describe('Temporal Signal Persistence — node counts (#601)', () => {
  it('nodeCount excludes historical nodes', () => {
    const graph1 = buildCustomerGraph('temporal-test', 'Temporal Test', BASE_SIGNALS)
    const originalCount = graph1.nodeCount

    const graph2 = buildCustomerGraph('temporal-test', 'Temporal Test', REDUCED_SIGNALS, graph1)

    const totalNodes = Object.keys(graph2.nodes).length
    expect(totalNodes).toBeGreaterThan(graph2.nodeCount)
    expect(graph2.nodeCount).toBeLessThan(originalCount)
  })

  it('edgeCount excludes edges connected to historical nodes', () => {
    const graph1 = buildCustomerGraph('temporal-test', 'Temporal Test', BASE_SIGNALS)

    const graph2 = buildCustomerGraph('temporal-test', 'Temporal Test', REDUCED_SIGNALS, graph1)

    expect(graph2.edgeCount).toBeLessThan(graph2.edges.length)
  })
})

describe('Temporal Signal Persistence — findActiveNodesByType (#601)', () => {
  it('findNodesByType includes historical nodes', () => {
    const graph1 = buildCustomerGraph('temporal-test', 'Temporal Test', BASE_SIGNALS)
    const graph2 = buildCustomerGraph('temporal-test', 'Temporal Test', REDUCED_SIGNALS, graph1)

    const allCases = findNodesByType(graph2, 'case')
    expect(allCases.length).toBe(1)
    expect(allCases[0].history!.status).toBe('historical')
  })

  it('findActiveNodesByType excludes historical nodes', () => {
    const graph1 = buildCustomerGraph('temporal-test', 'Temporal Test', BASE_SIGNALS)
    const graph2 = buildCustomerGraph('temporal-test', 'Temporal Test', REDUCED_SIGNALS, graph1)

    const activeCases = findActiveNodesByType(graph2, 'case')
    expect(activeCases.length).toBe(0)
  })
})

describe('Temporal Signal Persistence — TacticScorer ignores historical (#601)', () => {
  it('TacticScorer does not score historical nodes', () => {
    const signalsWithEngagement: Signal[] = [
      ...BASE_SIGNALS,
      {
        source: 'emails', type: 'email',
        headline: 'RE: Ansible Automation discussion',
        detail: '', timestamp: '2026-05-31', score: 0.5,
        metadata: { threadId: 'ansible-thread', techMentions: ['ansible'], from: 'test@co.com' },
      },
    ]

    const graph1 = buildCustomerGraph('temporal-test', 'Temporal Test', signalsWithEngagement)
    const scored1 = scoreTactics(graph1, [{
      name: 'AAP Upsell', parentTdp: 'Automation', assets: [],
    }])

    const graph2 = buildCustomerGraph('temporal-test', 'Temporal Test', BASE_SIGNALS, graph1)

    const historicalEngagements = Object.values(graph2.nodes).filter(
      n => n.type === 'engagement' && n.history?.status === 'historical'
    )
    expect(historicalEngagements.length).toBe(1)

    const scored2 = scoreTactics(graph2, [{
      name: 'AAP Upsell', parentTdp: 'Automation', assets: [],
    }])

    expect(scored2[0].compositeScore).toBeLessThanOrEqual(scored1[0].compositeScore)
  })
})

describe('Temporal Signal Persistence — backward compatibility (#601)', () => {
  it('graphs without history fields treat all nodes as active', () => {
    const legacyGraph: CustomerGraph = {
      customerId: 'legacy',
      customerName: 'Legacy Co',
      version: '1.0',
      builtAt: new Date().toISOString(),
      nodeCount: 2,
      edgeCount: 1,
      nodes: {
        'customer:legacy': {
          id: 'customer:legacy', type: 'customer', name: 'Legacy Co',
          properties: {}, sourceModule: 'test', contentHash: 'abc', updatedAt: new Date().toISOString(),
        },
        'subscription:rhel': {
          id: 'subscription:rhel', type: 'subscription', name: 'RHEL',
          properties: {}, sourceModule: 'test', contentHash: 'def', updatedAt: new Date().toISOString(),
        },
      },
      edges: [{
        from: 'customer:legacy', to: 'subscription:rhel',
        relation: 'HAS_SUBSCRIPTION', tier: 'factual', strength: 0.7,
        evidence: ['RHEL'], scoredAt: new Date().toISOString(),
        createdAt: new Date().toISOString(), sourceType: 'subscriptions',
      }],
    }

    const subs = findActiveNodesByType(legacyGraph, 'subscription')
    expect(subs.length).toBe(1)

    const rebuilt = buildCustomerGraph('legacy', 'Legacy Co', [
      {
        source: 'subscriptions', type: 'subscription', headline: 'RHEL',
        detail: '', timestamp: '2026-05-31', score: 0.7,
        metadata: { productDescription: 'RHEL' },
      },
    ], legacyGraph)

    for (const node of Object.values(rebuilt.nodes)) {
      expect(node.history).toBeDefined()
      expect(node.history!.status).toBe('active')
    }
  })
})
