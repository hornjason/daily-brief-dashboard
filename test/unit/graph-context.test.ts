/**
 * test/unit/graph-context.test.ts
 * Unit tests for buildFullGraphContext() — GitHub Issue #613
 *
 * Tests that the graph context builder produces structured, token-efficient
 * text representations of CustomerGraph for Gemini enhanced inference.
 */

import { describe, expect, test } from 'bun:test'
import { buildFullGraphContext } from '../../src/lib/graph-context.ts'
import type { CustomerGraph, IntelligenceNode, IntelligenceEdge } from '../../src/lib/intelligence-graph-types.ts'

// ── Test Helpers ────────────────────────────────────────────────────────────

function makeNode(
  id: string,
  type: IntelligenceNode['type'],
  name: string,
  properties: Record<string, unknown> = {},
): IntelligenceNode {
  return {
    id,
    type,
    name,
    properties,
    sourceModule: 'test',
    contentHash: 'abcd1234',
    updatedAt: new Date().toISOString(),
    history: { appeared: new Date().toISOString(), lastSeen: new Date().toISOString(), status: 'active' },
  }
}

function makeEdge(
  from: string,
  to: string,
  relation: string,
  opts: Partial<IntelligenceEdge> = {},
): IntelligenceEdge {
  return {
    from,
    to,
    relation,
    tier: 'factual',
    strength: 0.8,
    evidence: ['test evidence'],
    scoredAt: new Date().toISOString(),
    createdAt: opts.createdAt ?? new Date().toISOString(),
    sourceType: 'test',
    ...opts,
  }
}

function makeGraph(
  nodes: IntelligenceNode[],
  edges: IntelligenceEdge[] = [],
): CustomerGraph {
  const nodeMap: Record<string, IntelligenceNode> = {}
  for (const n of nodes) nodeMap[n.id] = n
  return {
    customerId: 'test-customer',
    customerName: 'Test Customer',
    version: '1.0',
    builtAt: new Date().toISOString(),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes: nodeMap,
    edges,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('buildFullGraphContext', () => {
  test('returns a string', () => {
    const graph = makeGraph([makeNode('customer:test', 'customer', 'Test Customer')])
    const result = buildFullGraphContext(graph)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  test('groups nodes by type', () => {
    const graph = makeGraph([
      makeNode('customer:test', 'customer', 'Test Customer'),
      makeNode('subscription:1', 'subscription', 'RHEL Premium', { product: 'RHEL' }),
      makeNode('subscription:2', 'subscription', 'OpenShift', { product: 'OCP' }),
      makeNode('case:1', 'case', 'Case about RHEL', { product: 'RHEL', severity: '2' }),
    ])
    const result = buildFullGraphContext(graph)
    expect(result).toContain('subscription')
    expect(result).toContain('case')
    expect(result).toContain('RHEL Premium')
    expect(result).toContain('OpenShift')
  })

  test('includes edge information with relation types', () => {
    const nodes = [
      makeNode('customer:test', 'customer', 'Test Customer'),
      makeNode('subscription:1', 'subscription', 'RHEL Premium'),
    ]
    const edges = [
      makeEdge('customer:test', 'subscription:1', 'HAS_SUBSCRIPTION'),
    ]
    const graph = makeGraph(nodes, edges)
    const result = buildFullGraphContext(graph)
    expect(result).toContain('HAS_SUBSCRIPTION')
  })

  test('excludes historical nodes', () => {
    const historicalNode = makeNode('subscription:old', 'subscription', 'Old Sub')
    historicalNode.history = {
      appeared: '2024-01-01T00:00:00Z',
      lastSeen: '2024-06-01T00:00:00Z',
      status: 'historical',
    }
    const graph = makeGraph([
      makeNode('customer:test', 'customer', 'Test Customer'),
      makeNode('subscription:1', 'subscription', 'Active Sub'),
      historicalNode,
    ])
    const result = buildFullGraphContext(graph)
    expect(result).toContain('Active Sub')
    expect(result).not.toContain('Old Sub')
  })

  test('caps output at reasonable size', () => {
    const nodes: IntelligenceNode[] = [
      makeNode('customer:test', 'customer', 'Test Customer'),
    ]
    for (let i = 0; i < 200; i++) {
      nodes.push(makeNode(`subscription:${i}`, 'subscription', `Subscription ${i} with very long name`, {
        product: `Product ${i}`,
        productDescription: `Long description for subscription ${i} to test token limits`,
      }))
    }
    const graph = makeGraph(nodes)
    const result = buildFullGraphContext(graph)
    // Should be under 32K chars (~8000 tokens)
    expect(result.length).toBeLessThanOrEqual(32000)
  })

  test('includes key node properties', () => {
    const graph = makeGraph([
      makeNode('customer:test', 'customer', 'Test Customer'),
      makeNode('case:1', 'case', 'Ansible playbook failure', {
        product: 'Ansible Automation Platform',
        severity: '1',
        status: 'open',
      }),
      makeNode('deal:1', 'deal', 'OpenShift Expansion', {
        amount: 150000,
        stage: 'Proposal',
      }),
    ])
    const result = buildFullGraphContext(graph)
    expect(result).toContain('Ansible')
    expect(result).toContain('OpenShift Expansion')
  })

  test('handles empty graph gracefully', () => {
    const graph = makeGraph([makeNode('customer:test', 'customer', 'Test Customer')])
    const result = buildFullGraphContext(graph)
    expect(typeof result).toBe('string')
    expect(result).toContain('Test Customer')
  })
})
