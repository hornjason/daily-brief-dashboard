/**
 * test/unit/customer-similarity.test.ts
 * Unit tests for cross-customer pattern detection (#612)
 *
 * Tests the customer similarity engine that computes overlap
 * between intelligence graph nodes across customer portfolios.
 */

import { describe, test, expect } from 'bun:test'
import type { CustomerGraph, IntelligenceNode } from '../../src/lib/intelligence-graph-types.ts'
import {
  computeSimilarity,
  getSimilarCustomers,
} from '../../src/lib/customer-similarity.ts'

// ── Test Helpers ────────────────────────────────────────────────────────────

function makeNode(
  type: string,
  name: string,
  sourceModule: string = 'test',
  properties: Record<string, unknown> = {},
): IntelligenceNode {
  const id = `${type}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return {
    id,
    type: type as any,
    name,
    properties,
    sourceModule,
    contentHash: 'abcd1234',
    updatedAt: new Date().toISOString(),
    history: { appeared: new Date().toISOString(), lastSeen: new Date().toISOString(), status: 'active' },
  }
}

function makeGraph(
  slug: string,
  name: string,
  nodes: IntelligenceNode[],
): CustomerGraph {
  const customerNode = makeNode('customer', name)
  const allNodes: Record<string, IntelligenceNode> = {
    [customerNode.id]: customerNode,
  }
  for (const n of nodes) {
    allNodes[n.id] = n
  }
  return {
    customerId: slug,
    customerName: name,
    version: '1.0',
    builtAt: new Date().toISOString(),
    nodeCount: Object.keys(allNodes).length,
    edgeCount: 0,
    nodes: allNodes,
    edges: [],
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('computeSimilarity', () => {
  test('two customers with identical product nodes produce high similarity', () => {
    const sharedProducts = [
      makeNode('product', 'OpenShift', 'subscriptions'),
      makeNode('product', 'Ansible', 'subscriptions'),
      makeNode('product', 'RHEL', 'subscriptions'),
    ]

    const graphA = makeGraph('acme-corp', 'Acme Corp', [...sharedProducts])
    const graphB = makeGraph('beta-inc', 'Beta Inc', [...sharedProducts])

    const score = computeSimilarity(graphA, graphB)
    expect(score).toBeGreaterThan(0.8)
  })

  test('two customers with zero overlap produce 0.0 score', () => {
    const graphA = makeGraph('acme-corp', 'Acme Corp', [
      makeNode('product', 'OpenShift', 'subscriptions'),
      makeNode('product', 'Ansible', 'subscriptions'),
    ])
    const graphB = makeGraph('beta-inc', 'Beta Inc', [
      makeNode('case', 'Case-001', 'cases', { severity: '1' }),
      makeNode('deal', 'Big Deal', 'pipeline'),
    ])

    const score = computeSimilarity(graphA, graphB)
    expect(score).toBe(0)
  })

  test('identical graphs produce 1.0 score', () => {
    const nodes = [
      makeNode('product', 'OpenShift', 'subscriptions'),
      makeNode('case', 'Case-001', 'cases', { severity: '2', product: 'RHEL' }),
      makeNode('partner', 'AWS', 'partner-catalog'),
    ]

    const graphA = makeGraph('acme-corp', 'Acme Corp', [...nodes])
    const graphB = makeGraph('beta-inc', 'Beta Inc', [...nodes])

    const score = computeSimilarity(graphA, graphB)
    expect(score).toBe(1)
  })

  test('partial overlap produces intermediate score', () => {
    const graphA = makeGraph('acme-corp', 'Acme Corp', [
      makeNode('product', 'OpenShift', 'subscriptions'),
      makeNode('product', 'Ansible', 'subscriptions'),
      makeNode('case', 'Case-001', 'cases', { severity: '1' }),
    ])
    const graphB = makeGraph('beta-inc', 'Beta Inc', [
      makeNode('product', 'OpenShift', 'subscriptions'),
      makeNode('deal', 'Big Deal', 'pipeline'),
      makeNode('partner', 'AWS', 'partner-catalog'),
    ])

    const score = computeSimilarity(graphA, graphB)
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
  })

  test('graph with only customer node produces 0.0 score', () => {
    const graphA = makeGraph('acme-corp', 'Acme Corp', [])
    const graphB = makeGraph('beta-inc', 'Beta Inc', [
      makeNode('product', 'OpenShift', 'subscriptions'),
    ])

    const score = computeSimilarity(graphA, graphB)
    expect(score).toBe(0)
  })
})

describe('getSimilarCustomers', () => {
  test('returns empty array for single customer in portfolio', () => {
    const graphs = new Map<string, CustomerGraph>()
    graphs.set('acme-corp', makeGraph('acme-corp', 'Acme Corp', [
      makeNode('product', 'OpenShift', 'subscriptions'),
    ]))

    const result = getSimilarCustomers('acme-corp', graphs)
    expect(result).toEqual([])
  })

  test('results are sorted by overlap score descending', () => {
    const graphs = new Map<string, CustomerGraph>()

    // Target customer
    graphs.set('target', makeGraph('target', 'Target Corp', [
      makeNode('product', 'OpenShift', 'subscriptions'),
      makeNode('product', 'Ansible', 'subscriptions'),
      makeNode('product', 'RHEL', 'subscriptions'),
    ]))

    // High overlap — shares all 3 products
    graphs.set('high-match', makeGraph('high-match', 'High Match Inc', [
      makeNode('product', 'OpenShift', 'subscriptions'),
      makeNode('product', 'Ansible', 'subscriptions'),
      makeNode('product', 'RHEL', 'subscriptions'),
    ]))

    // Medium overlap — shares 1 product
    graphs.set('medium-match', makeGraph('medium-match', 'Medium Match LLC', [
      makeNode('product', 'OpenShift', 'subscriptions'),
      makeNode('deal', 'Some Deal', 'pipeline'),
    ]))

    // No overlap
    graphs.set('no-match', makeGraph('no-match', 'No Match Co', [
      makeNode('deal', 'Other Deal', 'pipeline'),
    ]))

    const result = getSimilarCustomers('target', graphs)

    // Should be sorted by overlapScore descending
    expect(result.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].overlapScore).toBeGreaterThanOrEqual(result[i].overlapScore)
    }

    // First result should be the high-match customer
    expect(result[0].slug).toBe('high-match')
    expect(result[0].overlapScore).toBeGreaterThan(result[1].overlapScore)
  })

  test('excludes the target customer from results', () => {
    const graphs = new Map<string, CustomerGraph>()
    graphs.set('target', makeGraph('target', 'Target Corp', [
      makeNode('product', 'OpenShift', 'subscriptions'),
    ]))
    graphs.set('other', makeGraph('other', 'Other Corp', [
      makeNode('product', 'OpenShift', 'subscriptions'),
    ]))

    const result = getSimilarCustomers('target', graphs)
    const slugs = result.map(r => r.slug)
    expect(slugs).not.toContain('target')
  })

  test('respects topN parameter', () => {
    const graphs = new Map<string, CustomerGraph>()
    graphs.set('target', makeGraph('target', 'Target Corp', [
      makeNode('product', 'OpenShift', 'subscriptions'),
    ]))
    for (let i = 0; i < 10; i++) {
      graphs.set(`customer-${i}`, makeGraph(`customer-${i}`, `Customer ${i}`, [
        makeNode('product', 'OpenShift', 'subscriptions'),
      ]))
    }

    const result = getSimilarCustomers('target', graphs, 3)
    expect(result.length).toBeLessThanOrEqual(3)
  })

  test('populates sharedProducts, sharedCasePatterns, and sharedNodeTypes', () => {
    const graphs = new Map<string, CustomerGraph>()
    graphs.set('target', makeGraph('target', 'Target Corp', [
      makeNode('product', 'OpenShift', 'subscriptions'),
      makeNode('case', 'Case-001', 'cases', { severity: '1', product: 'RHEL' }),
      makeNode('partner', 'AWS', 'partner-catalog'),
    ]))
    graphs.set('similar', makeGraph('similar', 'Similar Corp', [
      makeNode('product', 'OpenShift', 'subscriptions'),
      makeNode('case', 'Case-001', 'cases', { severity: '1', product: 'RHEL' }),
      makeNode('partner', 'AWS', 'partner-catalog'),
    ]))

    const result = getSimilarCustomers('target', graphs)
    expect(result.length).toBe(1)
    expect(result[0].sharedProducts).toContain('OpenShift')
    expect(result[0].sharedCasePatterns.length).toBeGreaterThan(0)
    expect(result[0].sharedNodeTypes).toContain('product')
    expect(result[0].sharedNodeTypes).toContain('case')
    expect(result[0].sharedNodeTypes).toContain('partner')
    expect(result[0].totalSharedNodes).toBe(3)
  })

  test('excludes customers with zero overlap from results', () => {
    const graphs = new Map<string, CustomerGraph>()
    graphs.set('target', makeGraph('target', 'Target Corp', [
      makeNode('product', 'OpenShift', 'subscriptions'),
    ]))
    graphs.set('no-match', makeGraph('no-match', 'No Match Co', [
      makeNode('deal', 'Some Deal', 'pipeline'),
    ]))

    const result = getSimilarCustomers('target', graphs)
    expect(result.length).toBe(0)
  })
})
