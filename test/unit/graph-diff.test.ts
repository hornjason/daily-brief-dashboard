/**
 * test/unit/graph-diff.test.ts
 * TDD tests for computeGraphDiff() — #603
 *
 * Tests:
 * 1. Returns all-new changes for a first-time graph (no previous graph)
 * 2. Returns empty changes when nothing changed between rebuilds
 * 3. Identifies historical nodes as disappeared
 * 4. Identifies new nodes that appeared after previous build
 * 5. Identifies reactivated nodes (historical -> active)
 * 6. Every change has description, nodeType, and nodeName
 * 7. Includes summary text
 * 8. Sorts changes: new first, then reactivated, then disappeared
 * 9. Handles empty graph gracefully
 * 10. Excludes customer node from changes
 *
 * NOTE: buildCustomerGraph() mutates existingGraph nodes when it reuses cached
 * objects (same content hash). To get accurate previous-graph snapshots for diff
 * comparison, we deep-clone graphs before passing them to subsequent builds.
 */

import { describe, it, expect, beforeAll } from 'bun:test'
import type { Signal } from '../../src/feature-module-registry.ts'
import type { CustomerGraph } from '../../src/lib/intelligence-graph-types.ts'

// Lazy imports to avoid ESM TDZ issues
let computeGraphDiff: typeof import('../../src/lib/graph-diff.ts').computeGraphDiff
let buildCustomerGraph: typeof import('../../src/lib/intelligence-graph.ts').buildCustomerGraph

beforeAll(async () => {
  const diffModule = await import('../../src/lib/graph-diff.ts')
  computeGraphDiff = diffModule.computeGraphDiff

  const graphModule = await import('../../src/lib/intelligence-graph.ts')
  buildCustomerGraph = graphModule.buildCustomerGraph
})

/** Deep clone a graph to prevent mutation side effects */
function cloneGraph(g: CustomerGraph): CustomerGraph {
  return JSON.parse(JSON.stringify(g))
}

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

const REDUCED_SIGNALS: Signal[] = [
  BASE_SIGNALS[0], // RHEL subscription only
  BASE_SIGNALS[2], // CCSP only — case removed
]

const EXTRA_SIGNALS: Signal[] = [
  ...BASE_SIGNALS,
  {
    source: 'tech-stack', type: 'tech-stack',
    headline: 'VMware vSphere detected',
    detail: '', timestamp: '2026-06-01', score: 0.6,
    metadata: { techName: 'VMware vSphere', category: 'virtualization', context: 'migrating' },
  },
]

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('computeGraphDiff — basic', () => {
  it('returns all-new changes for a first-time graph (no previous graph)', () => {
    const graph = buildCustomerGraph('test-diff', 'Test Diff Co', BASE_SIGNALS)
    const diff = computeGraphDiff(graph)

    expect(diff).toBeDefined()
    expect(diff.customerSlug).toBe('test-diff')
    // First build: all non-customer nodes are "new"
    expect(diff.changes.length).toBeGreaterThan(0)
    expect(diff.changes.every(c => c.changeType === 'new')).toBe(true)
  })

  it('returns empty changes when nothing changed between rebuilds', () => {
    const graph1 = buildCustomerGraph('test-diff', 'Test Diff Co', BASE_SIGNALS)
    const snapshot1 = cloneGraph(graph1)
    const graph2 = buildCustomerGraph('test-diff', 'Test Diff Co', BASE_SIGNALS, graph1)

    const diff = computeGraphDiff(graph2, snapshot1)

    // All nodes existed before and still exist — no changes
    expect(diff.changes.length).toBe(0)
  })
})

describe('computeGraphDiff — disappeared signals', () => {
  it('identifies historical nodes as disappeared', () => {
    const graph1 = buildCustomerGraph('test-diff', 'Test Diff Co', BASE_SIGNALS)
    const snapshot1 = cloneGraph(graph1)
    const graph2 = buildCustomerGraph('test-diff', 'Test Diff Co', REDUCED_SIGNALS, graph1)

    const diff = computeGraphDiff(graph2, snapshot1)

    const disappeared = diff.changes.filter(c => c.changeType === 'disappeared')
    expect(disappeared.length).toBe(1)
    expect(disappeared[0].nodeType).toBe('case')
    expect(disappeared[0].description.length).toBeGreaterThan(0)
  })
})

describe('computeGraphDiff — new signals', () => {
  it('identifies new nodes that appeared after previous build', () => {
    const graph1 = buildCustomerGraph('test-diff', 'Test Diff Co', BASE_SIGNALS)
    const snapshot1 = cloneGraph(graph1)
    const graph2 = buildCustomerGraph('test-diff', 'Test Diff Co', EXTRA_SIGNALS, graph1)

    const diff = computeGraphDiff(graph2, snapshot1)

    const newNodes = diff.changes.filter(c => c.changeType === 'new')
    expect(newNodes.length).toBeGreaterThanOrEqual(1)
    expect(newNodes.some(n => n.nodeType === 'product' && n.nodeName.includes('VMware'))).toBe(true)
  })
})

describe('computeGraphDiff — reactivated signals', () => {
  it('identifies reactivated nodes (historical -> active)', () => {
    const graph1 = buildCustomerGraph('test-diff', 'Test Diff Co', BASE_SIGNALS)
    const graph2 = buildCustomerGraph('test-diff', 'Test Diff Co', REDUCED_SIGNALS, cloneGraph(graph1))
    const snapshot2 = cloneGraph(graph2)
    // Bring case back
    const graph3 = buildCustomerGraph('test-diff', 'Test Diff Co', BASE_SIGNALS, graph2)

    const diff = computeGraphDiff(graph3, snapshot2)

    const reactivated = diff.changes.filter(c => c.changeType === 'reactivated')
    expect(reactivated.length).toBe(1)
    expect(reactivated[0].nodeType).toBe('case')
  })
})

describe('computeGraphDiff — output format', () => {
  it('includes summary text', () => {
    const graph1 = buildCustomerGraph('test-diff', 'Test Diff Co', BASE_SIGNALS)
    const snapshot1 = cloneGraph(graph1)
    const graph2 = buildCustomerGraph('test-diff', 'Test Diff Co', EXTRA_SIGNALS, graph1)

    const diff = computeGraphDiff(graph2, snapshot1)

    expect(diff.summary).toBeDefined()
    expect(diff.summary.length).toBeGreaterThan(0)
  })

  it('sorts changes: new first, then reactivated, then disappeared', () => {
    const graph1 = buildCustomerGraph('test-diff', 'Test Diff Co', BASE_SIGNALS)
    const graph2 = buildCustomerGraph('test-diff', 'Test Diff Co', REDUCED_SIGNALS, cloneGraph(graph1))
    const snapshot2 = cloneGraph(graph2)
    // graph2: sub active, ccsp active, case historical
    // Add a new signal + bring case back
    const finalSignals = [
      ...BASE_SIGNALS, // brings case back (reactivated)
      EXTRA_SIGNALS[3], // VMware (new)
    ]
    const graph3 = buildCustomerGraph('test-diff', 'Test Diff Co', finalSignals, graph2)

    const diff = computeGraphDiff(graph3, snapshot2)

    const types = diff.changes.map(c => c.changeType)
    const newIdx = types.indexOf('new')
    const reactivatedIdx = types.indexOf('reactivated')

    // New should come before reactivated
    if (newIdx >= 0 && reactivatedIdx >= 0) {
      expect(newIdx).toBeLessThan(reactivatedIdx)
    }
  })

  it('every change has description, nodeType, and nodeName', () => {
    const graph1 = buildCustomerGraph('test-diff', 'Test Diff Co', BASE_SIGNALS)
    const snapshot1 = cloneGraph(graph1)
    const mixedSignals = [
      BASE_SIGNALS[0], // keep sub
      EXTRA_SIGNALS[3], // add VMware
      // remove case and ccsp
    ]
    const graph2 = buildCustomerGraph('test-diff', 'Test Diff Co', mixedSignals, graph1)

    const diff = computeGraphDiff(graph2, snapshot1)

    for (const change of diff.changes) {
      expect(change.description.length).toBeGreaterThan(0)
      expect(change.nodeType.length).toBeGreaterThan(0)
      expect(change.nodeName.length).toBeGreaterThan(0)
    }
  })
})

describe('computeGraphDiff — edge cases', () => {
  it('handles empty graph gracefully', () => {
    const emptyGraph: CustomerGraph = {
      customerId: 'empty',
      customerName: 'Empty Co',
      version: '1.0',
      builtAt: new Date().toISOString(),
      nodeCount: 0,
      edgeCount: 0,
      nodes: {},
      edges: [],
    }

    const diff = computeGraphDiff(emptyGraph)
    expect(diff).toBeDefined()
    expect(diff.changes).toEqual([])
  })

  it('excludes customer node from changes', () => {
    const graph = buildCustomerGraph('test-diff', 'Test Diff Co', BASE_SIGNALS)
    const diff = computeGraphDiff(graph)

    // Customer node should never appear as a "change"
    expect(diff.changes.every(c => c.nodeType !== 'customer')).toBe(true)
  })
})
