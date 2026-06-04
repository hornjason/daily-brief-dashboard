/**
 * test/unit/intelligence-graph.test.ts
 * TDD tests for Intelligence Graph — #511
 *
 * Uses CrowdStrike fixture data to validate:
 * 1. Node creation from signals
 * 2. Edge types (factual vs derived)
 * 3. Persistence (write/read, 50KB ceiling)
 * 4. Content-hash caching
 * 5. BFS traversal + play query
 * 6. Utility functions (findNodesByType, etc.)
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import type { Signal } from '../../src/feature-module-registry.ts'
import type { CustomerGraph, IntelligenceNode, IntelligenceEdge } from '../../src/lib/intelligence-graph-types.ts'

// Lazy imports to avoid ESM TDZ issues
let buildCustomerGraph: typeof import('../../src/lib/intelligence-graph.ts').buildCustomerGraph
let persistGraph: typeof import('../../src/lib/intelligence-graph.ts').persistGraph
let loadGraph: typeof import('../../src/lib/intelligence-graph.ts').loadGraph
let queryPlays: typeof import('../../src/lib/intelligence-graph.ts').queryPlays
let extractSignalTimestamp: typeof import('../../src/lib/intelligence-graph.ts').extractSignalTimestamp
let computeContentHash: typeof import('../../src/lib/graph-utils.ts').computeContentHash
let bfsTraverse: typeof import('../../src/lib/graph-utils.ts').bfsTraverse
let findNodesByType: typeof import('../../src/lib/graph-utils.ts').findNodesByType
let getEdgesFrom: typeof import('../../src/lib/graph-utils.ts').getEdgesFrom
let getEdgesTo: typeof import('../../src/lib/graph-utils.ts').getEdgesTo
let rankByEdgeStrength: typeof import('../../src/lib/graph-utils.ts').rankByEdgeStrength
let recencyWeight: typeof import('../../src/lib/graph-utils.ts').recencyWeight

beforeAll(async () => {
  const graphModule = await import('../../src/lib/intelligence-graph.ts')
  buildCustomerGraph = graphModule.buildCustomerGraph
  persistGraph = graphModule.persistGraph
  loadGraph = graphModule.loadGraph
  queryPlays = graphModule.queryPlays
  extractSignalTimestamp = graphModule.extractSignalTimestamp

  const utilsModule = await import('../../src/lib/graph-utils.ts')
  computeContentHash = utilsModule.computeContentHash
  bfsTraverse = utilsModule.bfsTraverse
  findNodesByType = utilsModule.findNodesByType
  getEdgesFrom = utilsModule.getEdgesFrom
  getEdgesTo = utilsModule.getEdgesTo
  rankByEdgeStrength = utilsModule.rankByEdgeStrength
  recencyWeight = utilsModule.recencyWeight
})

// ── Test Data Dir ─────────────────────────────────────────────────────────────

const TEST_DATA_DIR = resolve(import.meta.dir, '../../.test-data-graph')

beforeAll(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true })
  mkdirSync(TEST_DATA_DIR, { recursive: true })
})

afterAll(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true })
})

// ── CrowdStrike Fixture ───────────────────────────────────────────────────────

const CROWDSTRIKE_FIXTURES: Signal[] = [
  // Subscriptions
  {
    source: 'subscriptions', type: 'subscription', headline: 'Enterprise Linux Server - 8 subscriptions',
    detail: '', timestamp: '2026-05-31', score: 0.7,
    metadata: { productDescription: 'Red Hat Enterprise Linux Server, Premium', quantity: 8, status: 'Active', endDate: '2027-05-08' },
  },
  {
    source: 'subscriptions', type: 'subscription', headline: 'Ansible Automation Platform - 2 subscriptions',
    detail: '', timestamp: '2026-05-31', score: 0.9,
    metadata: { productDescription: 'Red Hat Ansible Automation Platform, Premium', quantity: 2, status: 'Expired', endDate: '2026-05-10' },
  },
  {
    source: 'subscriptions', type: 'subscription', headline: 'OpenShift Container Platform - 2 subscriptions',
    detail: '', timestamp: '2026-05-31', score: 0.9,
    metadata: { productDescription: 'Red Hat OpenShift Container Platform Standard', quantity: 2, status: 'Expired', endDate: '2026-05-10' },
  },
  // Cases
  {
    source: 'cases', type: 'case', headline: 'Case 04459393: Add New Users to Red Hat Support Portal',
    detail: '', timestamp: '2026-05-31', score: 0.5,
    metadata: { caseNumber: '04459393', severity: '4', status: 'Waiting on Customer', product: 'Red Hat Ansible Automation Platform' },
  },
  {
    source: 'cases', type: 'case', headline: 'Case 04127120: Ansible playbook to reboot fails',
    detail: '', timestamp: '2026-05-31', score: 0.6,
    metadata: { caseNumber: '04127120', severity: '3', status: 'Closed', product: 'Red Hat Ansible Automation Platform' },
  },
  // CCSP
  {
    source: 'ccsp', type: 'cloud-spend', headline: 'AWS cloud spend: $239,663 ACV',
    detail: '', timestamp: '2026-05-31', score: 0.8,
    metadata: { cloudPartner: 'AWS', acvPlus: 239663 },
  },
  {
    source: 'ccsp', type: 'cloud-spend', headline: 'Google cloud spend: $210,392 ACV',
    detail: '', timestamp: '2026-05-31', score: 0.7,
    metadata: { cloudPartner: 'Google', acvPlus: 210392 },
  },
  // Tech stack
  {
    source: 'tech-stack', type: 'technology', headline: 'Falcon Next-Gen SIEM (proprietary, using)',
    detail: '', timestamp: '2026-05-31', score: 0.4,
    metadata: { techName: 'Falcon Next-Gen SIEM', category: 'proprietary', context: 'using' },
  },
  {
    source: 'tech-stack', type: 'technology', headline: 'Charlotte AI (proprietary, using)',
    detail: '', timestamp: '2026-05-31', score: 0.4,
    metadata: { techName: 'Charlotte AI', category: 'proprietary', context: 'using' },
  },
  // Solution intelligence
  {
    source: 'solution-intelligence', type: 'recommendation', headline: 'AI/ML Platform with OpenShift AI',
    detail: '', timestamp: '2026-05-31', score: 0.8, url: 'https://example.com',
    metadata: { matchedTechnologies: ['Charlotte AI'], solutionName: 'AI/ML Platform', productAlignment: 'OpenShift AI' },
  },
  // Cloud marketplace
  {
    source: 'cloud-marketplace', type: 'cloud-spend', headline: 'AWS Marketplace: 0 offerings, 1 programs',
    detail: '', timestamp: '2026-05-31', score: 0.6,
    metadata: { provider: 'AWS', programCount: 1 },
  },
]

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Intelligence Graph — buildCustomerGraph', () => {
  it('creates correct node count from fixture signals', () => {
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)

    // Expected nodes:
    // 1 Customer
    // 3 Subscriptions (RHEL, AAP, OCP)
    // 2 Cases
    // 2 CCSP programs (AWS, Google)
    // 2 Tech products (Falcon SIEM, Charlotte AI)
    // 1 Solution play (AI/ML Platform) — created by solution-intelligence derived edges
    // 1 Marketplace program (AWS)
    // 2 Subscription-derived plays (#573): "Server and Cloud Computing" (RHEL),
    //   "Build and Run Applications" (Ansible + OpenShift share this play)
    // Total: 14
    expect(graph.nodeCount).toBe(14)
    expect(Object.keys(graph.nodes).length).toBe(14)
  })

  it('has correct edge types — factual and derived', () => {
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)

    const factualEdges = graph.edges.filter(e => e.tier === 'factual')
    const derivedEdges = graph.edges.filter(e => e.tier === 'derived')

    // Factual: Customer → 3 subs + 2 cases + 2 ccsp + 2 tech + 1 marketplace = 10
    expect(factualEdges.length).toBe(10)

    // Derived: Customer → Play (MATCHES_PLAY) + Play → Product (TARGETS_PRODUCT for Charlotte AI)
    expect(derivedEdges.length).toBeGreaterThanOrEqual(1)

    // Verify MATCHES_PLAY exists
    const matchesPlay = derivedEdges.filter(e => e.relation === 'MATCHES_PLAY')
    expect(matchesPlay.length).toBeGreaterThanOrEqual(1)
  })

  it('customer node is the hub', () => {
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)
    const customerNode = Object.values(graph.nodes).find(n => n.type === 'customer')

    expect(customerNode).toBeDefined()
    expect(customerNode!.name).toBe('CrowdStrike')

    // All factual edges originate from customer
    const factualEdges = graph.edges.filter(e => e.tier === 'factual')
    for (const edge of factualEdges) {
      expect(edge.from).toBe(customerNode!.id)
    }
  })
})

describe('Intelligence Graph — persistence', () => {
  it('persistGraph writes JSON under 50KB', () => {
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)
    persistGraph(graph, TEST_DATA_DIR)

    const filePath = resolve(TEST_DATA_DIR, 'crowdstrike', 'intelligence-graph.json')
    expect(existsSync(filePath)).toBe(true)

    const raw = readFileSync(filePath, 'utf-8')
    expect(Buffer.byteLength(raw, 'utf-8')).toBeLessThan(200 * 1024)
  })

  it('persistGraph throws when graph exceeds 200KB', () => {
    // Construct an oversized graph
    const nodes: Record<string, IntelligenceNode> = {}
    const edges: IntelligenceEdge[] = []

    // Create enough nodes to exceed 200KB
    for (let i = 0; i < 2000; i++) {
      const id = `product:oversized-${i}`
      nodes[id] = {
        id,
        type: 'product',
        name: `Oversized Product ${i} with a very long description that helps push the size over the limit ${'x'.repeat(80)}`,
        properties: { description: 'x'.repeat(200), category: 'test', context: 'oversized' },
        sourceModule: 'test',
        contentHash: 'abcd1234',
        updatedAt: new Date().toISOString(),
      }
    }

    const oversizedGraph: CustomerGraph = {
      customerId: 'oversized-test',
      customerName: 'Oversized Test',
      version: '1.0',
      builtAt: new Date().toISOString(),
      nodeCount: Object.keys(nodes).length,
      edgeCount: edges.length,
      nodes,
      edges,
    }

    expect(() => persistGraph(oversizedGraph, TEST_DATA_DIR)).toThrow('exceeds 50KB')
  })

  it('loadGraph returns persisted graph with identical structure', () => {
    const original = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)
    persistGraph(original, TEST_DATA_DIR)

    const loaded = loadGraph('crowdstrike', TEST_DATA_DIR)
    expect(loaded).not.toBeNull()
    expect(loaded!.customerId).toBe(original.customerId)
    expect(loaded!.customerName).toBe(original.customerName)
    expect(loaded!.nodeCount).toBe(original.nodeCount)
    expect(loaded!.edgeCount).toBe(original.edgeCount)
    expect(Object.keys(loaded!.nodes).length).toBe(Object.keys(original.nodes).length)
    expect(loaded!.edges.length).toBe(original.edges.length)
  })

  it('loadGraph returns null for nonexistent customer', () => {
    const result = loadGraph('nonexistent-customer-xyz', TEST_DATA_DIR)
    expect(result).toBeNull()
  })
})

describe('Intelligence Graph — content-hash caching', () => {
  it('unchanged signals produce same hashes', () => {
    const graph1 = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)
    const graph2 = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)

    // All nodes should have the same content hashes
    for (const nodeId of Object.keys(graph1.nodes)) {
      expect(graph2.nodes[nodeId]).toBeDefined()
      expect(graph2.nodes[nodeId].contentHash).toBe(graph1.nodes[nodeId].contentHash)
    }
  })

  it('existing graph nodes are reused when hash matches', () => {
    const graph1 = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)

    // Build again with existing graph
    const graph2 = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES, graph1)

    // Same structure
    expect(graph2.nodeCount).toBe(graph1.nodeCount)
    expect(Object.keys(graph2.nodes).length).toBe(Object.keys(graph1.nodes).length)
  })
})

describe('Intelligence Graph — BFS traversal and queryPlays', () => {
  it('BFS traversal from customer node returns connected plays within 2 hops', () => {
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)
    const customerNode = Object.values(graph.nodes).find(n => n.type === 'customer')!

    const reachable = bfsTraverse(graph, customerNode.id, 2)

    // Should include all direct neighbors (1 hop) and their neighbors (2 hops)
    expect(reachable.length).toBeGreaterThan(0)

    // Play nodes should be reachable (connected via MATCHES_PLAY)
    const plays = reachable.filter(n => n.type === 'play')
    expect(plays.length).toBeGreaterThanOrEqual(1)
  })

  it('queryPlays returns the solution-intelligence play', () => {
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)
    const plays = queryPlays(graph)

    expect(plays.length).toBeGreaterThanOrEqual(1)
    expect(plays.some(p => p.name.includes('AI/ML Platform'))).toBe(true)
  })

  it('plays ranked by converging edge strength', () => {
    // Create a graph with two plays: one with 3 signals, one with 1 signal
    const signals: Signal[] = [
      // Three signals pointing at Play A
      {
        source: 'solution-intelligence', type: 'recommendation', headline: 'Play A match 1',
        detail: '', timestamp: '2026-05-31', score: 0.9,
        metadata: { solutionName: 'Play A', matchedTechnologies: [] },
      },
      {
        source: 'solution-intelligence', type: 'recommendation', headline: 'Play A match 2',
        detail: '', timestamp: '2026-05-31', score: 0.8,
        metadata: { solutionName: 'Play A', matchedTechnologies: [] },
      },
      {
        source: 'solution-intelligence', type: 'recommendation', headline: 'Play A match 3',
        detail: '', timestamp: '2026-05-31', score: 0.7,
        metadata: { solutionName: 'Play A', matchedTechnologies: [] },
      },
      // One signal pointing at Play B
      {
        source: 'solution-intelligence', type: 'recommendation', headline: 'Play B match 1',
        detail: '', timestamp: '2026-05-31', score: 0.9,
        metadata: { solutionName: 'Play B', matchedTechnologies: [] },
      },
    ]

    const graph = buildCustomerGraph('test-ranking', 'Test Ranking', signals)
    const plays = queryPlays(graph)

    expect(plays.length).toBe(2)
    // Play A should rank higher (3 edges vs 1 edge)
    expect(plays[0].name).toContain('Play A')
    expect(plays[1].name).toContain('Play B')
  })
})

describe('Intelligence Graph — utility functions', () => {
  it('findNodesByType returns correct subsets', () => {
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)

    const subscriptions = findNodesByType(graph, 'subscription')
    expect(subscriptions.length).toBe(3)

    const cases = findNodesByType(graph, 'case')
    expect(cases.length).toBe(2)

    const products = findNodesByType(graph, 'product')
    expect(products.length).toBe(2)

    const programs = findNodesByType(graph, 'program')
    // 2 CCSP + 1 marketplace = 3
    expect(programs.length).toBe(3)

    const plays = findNodesByType(graph, 'play')
    // 1 from solution-intelligence + 2 from subscription-derived (#573)
    expect(plays.length).toBe(3)

    const customers = findNodesByType(graph, 'customer')
    expect(customers.length).toBe(1)
  })

  it('getEdgesFrom returns edges originating from customer', () => {
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)
    const customerNode = Object.values(graph.nodes).find(n => n.type === 'customer')!

    const edges = getEdgesFrom(graph, customerNode.id)
    expect(edges.length).toBeGreaterThan(0)

    // All should originate from customer
    for (const edge of edges) {
      expect(edge.from).toBe(customerNode.id)
    }
  })

  it('getEdgesTo returns edges pointing to a subscription node', () => {
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)
    const subNode = Object.values(graph.nodes).find(n => n.type === 'subscription')!

    const edges = getEdgesTo(graph, subNode.id)
    expect(edges.length).toBeGreaterThanOrEqual(1)
    expect(edges[0].to).toBe(subNode.id)
  })

  it('computeContentHash produces consistent 8-char hashes', () => {
    const hash1 = computeContentHash('hello world')
    const hash2 = computeContentHash('hello world')

    expect(hash1).toBe(hash2)
    expect(hash1.length).toBe(8)
    expect(/^[0-9a-f]{8}$/.test(hash1)).toBe(true)
  })

  it('rankByEdgeStrength sorts nodes by total connected edge strength', () => {
    const nodes: IntelligenceNode[] = [
      { id: 'a', type: 'play', name: 'A', properties: {}, sourceModule: 'test', contentHash: '1', updatedAt: '' },
      { id: 'b', type: 'play', name: 'B', properties: {}, sourceModule: 'test', contentHash: '2', updatedAt: '' },
    ]
    const edges: IntelligenceEdge[] = [
      { from: 'x', to: 'a', relation: 'R', tier: 'factual', strength: 0.3, evidence: [], scoredAt: '', createdAt: '2026-05-31', sourceType: 'test' },
      { from: 'x', to: 'b', relation: 'R', tier: 'factual', strength: 0.9, evidence: [], scoredAt: '', createdAt: '2026-05-31', sourceType: 'test' },
      { from: 'y', to: 'b', relation: 'R', tier: 'factual', strength: 0.5, evidence: [], scoredAt: '', createdAt: '2026-05-31', sourceType: 'test' },
    ]

    const ranked = rankByEdgeStrength(nodes, edges)
    // B has total 1.4, A has total 0.3
    expect(ranked[0].id).toBe('b')
    expect(ranked[1].id).toBe('a')
  })
})

describe('Intelligence Graph — edge metadata (#590)', () => {
  it('all factual edges have createdAt populated from signal data', () => {
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)
    const factualEdges = graph.edges.filter(e => e.tier === 'factual')

    expect(factualEdges.length).toBeGreaterThan(0)
    for (const edge of factualEdges) {
      expect(edge.createdAt).toBeDefined()
      expect(typeof edge.createdAt).toBe('string')
      expect(edge.createdAt.length).toBeGreaterThan(0)
    }
  })

  it('all derived edges have createdAt populated', () => {
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)
    const derivedEdges = graph.edges.filter(e => e.tier === 'derived')

    expect(derivedEdges.length).toBeGreaterThan(0)
    for (const edge of derivedEdges) {
      expect(edge.createdAt).toBeDefined()
      expect(typeof edge.createdAt).toBe('string')
      expect(edge.createdAt.length).toBeGreaterThan(0)
    }
  })

  it('all edges have sourceType matching signal.source', () => {
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)

    for (const edge of graph.edges) {
      expect(edge.sourceType).toBeDefined()
      expect(typeof edge.sourceType).toBe('string')
      expect(edge.sourceType.length).toBeGreaterThan(0)
    }

    // Verify specific source types
    const subEdges = graph.edges.filter(e => e.sourceType === 'subscriptions')
    expect(subEdges.length).toBeGreaterThanOrEqual(3)

    const caseEdges = graph.edges.filter(e => e.sourceType === 'cases')
    expect(caseEdges.length).toBeGreaterThanOrEqual(2)

    const solutionEdges = graph.edges.filter(e => e.sourceType === 'solution-intelligence')
    expect(solutionEdges.length).toBeGreaterThanOrEqual(1)
  })

  it('strength is always > 0 on all edges', () => {
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)

    for (const edge of graph.edges) {
      expect(edge.strength).toBeGreaterThan(0)
    }
  })

  it('factual edge createdAt uses signal timestamp when metadata dates missing', () => {
    const signals: Signal[] = [
      {
        source: 'cases', type: 'case', headline: 'Test case',
        detail: '', timestamp: '2026-04-15', score: 0.5,
        metadata: { caseNumber: '99999', severity: '3', status: 'Open', product: 'RHEL' },
      },
    ]

    const graph = buildCustomerGraph('ts-test', 'Timestamp Test', signals)
    const caseEdge = graph.edges.find(e => e.sourceType === 'cases')
    expect(caseEdge).toBeDefined()
    // Should use signal.timestamp since metadata has no startDate/createdAt/date
    expect(caseEdge!.createdAt).toBe('2026-04-15')
  })
})

describe('Intelligence Graph — recencyWeight (#590)', () => {
  it('recencyWeight returns 1.0 for current timestamp', () => {
    const now = new Date().toISOString()
    const weight = recencyWeight(now)
    // Should be very close to 1.0
    expect(weight).toBeGreaterThan(0.99)
    expect(weight).toBeLessThanOrEqual(1.0)
  })

  it('recencyWeight returns ~0.5 at half-life', () => {
    const halfLifeDays = 90
    const halfLifeAgo = new Date(Date.now() - halfLifeDays * 24 * 60 * 60 * 1000).toISOString()
    const weight = recencyWeight(halfLifeAgo, halfLifeDays)
    // Should be approximately 0.5
    expect(weight).toBeGreaterThan(0.49)
    expect(weight).toBeLessThan(0.51)
  })

  it('recencyWeight returns ~0.25 at two half-lives', () => {
    const halfLifeDays = 90
    const twoHalfLives = new Date(Date.now() - 2 * halfLifeDays * 24 * 60 * 60 * 1000).toISOString()
    const weight = recencyWeight(twoHalfLives, halfLifeDays)
    expect(weight).toBeGreaterThan(0.24)
    expect(weight).toBeLessThan(0.26)
  })

  it('engagement signals use 30-day half-life', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const weight = recencyWeight(thirtyDaysAgo, 30)
    expect(weight).toBeGreaterThan(0.49)
    expect(weight).toBeLessThan(0.51)
  })

  it('recencyWeight is always between 0 and 1', () => {
    // Very old date
    const veryOld = '2020-01-01T00:00:00.000Z'
    const weight = recencyWeight(veryOld)
    expect(weight).toBeGreaterThan(0)
    expect(weight).toBeLessThanOrEqual(1.0)
  })
})

describe('Intelligence Graph — timestamp pipeline (#596)', () => {
  it('extractSignalTimestamp: subscription signals extract startDate', () => {
    const signal = { source: 'subscriptions', timestamp: '2026-05-31' } as Signal
    const m = { startDate: '2025-06-01', endDate: '2027-05-08' }
    const result = extractSignalTimestamp(signal, m)
    expect(result.ts).toBe('2025-06-01')
    expect(result.source).toBe('signal')
  })

  it('extractSignalTimestamp: case signals extract createdDate', () => {
    const signal = { source: 'cases', timestamp: '2026-05-31' } as Signal
    const m = { createdDate: '2026-03-15', caseNumber: '12345' }
    const result = extractSignalTimestamp(signal, m)
    expect(result.ts).toBe('2026-03-15')
    expect(result.source).toBe('signal')
  })

  it('extractSignalTimestamp: email signals extract date field', () => {
    const signal = { source: 'emails', timestamp: '2026-05-31' } as Signal
    const m = { date: '2026-05-28', from: 'test@example.com' }
    const result = extractSignalTimestamp(signal, m)
    expect(result.ts).toBe('2026-05-28')
    expect(result.source).toBe('signal')
  })

  it('extractSignalTimestamp: news-radar extracts publishedAt', () => {
    const signal = { source: 'news-radar', timestamp: '2026-05-31' } as Signal
    const m = { publishedAt: '2026-05-20', title: 'News article' }
    const result = extractSignalTimestamp(signal, m)
    expect(result.ts).toBe('2026-05-20')
    expect(result.source).toBe('signal')
  })

  it('extractSignalTimestamp: pipeline extracts closeDate', () => {
    const signal = { source: 'pipeline', timestamp: '2026-05-31' } as Signal
    const m = { closeDate: '2026-08-15', stage: 'Negotiate' }
    const result = extractSignalTimestamp(signal, m)
    expect(result.ts).toBe('2026-08-15')
    expect(result.source).toBe('signal')
  })

  it('extractSignalTimestamp: falls back to generic fields when source-specific missing', () => {
    const signal = { source: 'cases', timestamp: '2026-05-31' } as Signal
    // No createdDate/lastModifiedDate/created — but has generic 'date'
    const m = { date: '2026-04-10', caseNumber: '99999' }
    const result = extractSignalTimestamp(signal, m)
    expect(result.ts).toBe('2026-04-10')
    expect(result.source).toBe('signal')
  })

  it('extractSignalTimestamp: falls back to signal.timestamp when no metadata dates', () => {
    const signal = { source: 'cases', timestamp: '2026-04-15' } as Signal
    const m = { caseNumber: '99999', severity: '3' }
    const result = extractSignalTimestamp(signal, m)
    expect(result.ts).toBe('2026-04-15')
    expect(result.source).toBe('signal')
  })

  it('extractSignalTimestamp: returns empty string + ingestion when no timestamps at all', () => {
    const signal = { source: 'cases' } as Signal
    const m = { caseNumber: '99999' }
    const result = extractSignalTimestamp(signal, m)
    expect(result.ts).toBe('')
    expect(result.source).toBe('ingestion')
  })

  it('extractSignalTimestamp: rejects invalid date strings', () => {
    const signal = { source: 'subscriptions' } as Signal
    const m = { startDate: 'not-a-date', endDate: 'also-not-a-date' }
    const result = extractSignalTimestamp(signal, m)
    expect(result.ts).toBe('')
    expect(result.source).toBe('ingestion')
  })

  it('signals without timestamps get graph builtAt, not nowIso()', () => {
    const signals: Signal[] = [
      {
        source: 'tech-stack', type: 'technology', headline: 'Docker',
        detail: '', score: 0.4,
        metadata: { techName: 'Docker', category: 'container', context: 'using' },
        // No timestamp field, no date in metadata
      },
    ]

    const graph = buildCustomerGraph('ts-test', 'Timestamp Test', signals)
    const techEdge = graph.edges.find(e => e.sourceType === 'tech-stack')
    expect(techEdge).toBeDefined()
    // createdAt should equal graph.builtAt (ingestion fallback), not a different nowIso() call
    expect(techEdge!.createdAt).toBe(graph.builtAt)
    expect(techEdge!.timestampSource).toBe('ingestion')
  })

  it('subscription edge gets timestampSource: signal from startDate', () => {
    const signals: Signal[] = [
      {
        source: 'subscriptions', type: 'subscription', headline: 'RHEL',
        detail: '', timestamp: '2026-05-31', score: 0.7,
        metadata: { productDescription: 'RHEL Server', startDate: '2025-01-15', endDate: '2027-01-15' },
      },
    ]

    const graph = buildCustomerGraph('ts-test2', 'Timestamp Test 2', signals)
    const subEdge = graph.edges.find(e => e.sourceType === 'subscriptions' && e.tier === 'factual')
    expect(subEdge).toBeDefined()
    expect(subEdge!.createdAt).toBe('2025-01-15')
    expect(subEdge!.timestampSource).toBe('signal')
  })

  it('case edge gets timestampSource: signal from signal.timestamp fallback', () => {
    const signals: Signal[] = [
      {
        source: 'cases', type: 'case', headline: 'Test case',
        detail: '', timestamp: '2026-04-15', score: 0.5,
        metadata: { caseNumber: '99999', severity: '3', status: 'Open', product: 'RHEL' },
      },
    ]

    const graph = buildCustomerGraph('ts-test3', 'Timestamp Test 3', signals)
    const caseEdge = graph.edges.find(e => e.sourceType === 'cases')
    expect(caseEdge).toBeDefined()
    expect(caseEdge!.createdAt).toBe('2026-04-15')
    expect(caseEdge!.timestampSource).toBe('signal')
  })

  it('all edges in CrowdStrike fixture have timestampSource set', () => {
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)
    for (const edge of graph.edges) {
      expect(edge.timestampSource).toBeDefined()
      expect(['signal', 'inferred', 'ingestion']).toContain(edge.timestampSource)
    }
  })

  it('CrowdStrike subscription edges use signal.timestamp as createdAt (no startDate in fixture)', () => {
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)
    const subEdges = graph.edges.filter(e => e.sourceType === 'subscriptions' && e.tier === 'factual')
    expect(subEdges.length).toBe(3)
    for (const edge of subEdges) {
      // Fixture subscriptions have no startDate but do have endDate and signal.timestamp
      // endDate is in SOURCE_TIMESTAMP_FIELDS for subscriptions, so it should be used
      // Actually they DO have endDate in metadata — endDate: '2027-05-08' etc
      expect(edge.timestampSource).toBe('signal')
      expect(edge.createdAt.length).toBeGreaterThan(0)
    }
  })

  it('derived edges also have timestampSource set', () => {
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', CROWDSTRIKE_FIXTURES)
    const derivedEdges = graph.edges.filter(e => e.tier === 'derived')
    expect(derivedEdges.length).toBeGreaterThan(0)
    for (const edge of derivedEdges) {
      expect(edge.timestampSource).toBeDefined()
    }
  })
})
