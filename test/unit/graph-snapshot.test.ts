/**
 * test/unit/graph-snapshot.test.ts
 * Regression test for #671 — persistGraph must save a previous snapshot,
 * and computeGraphDiff with a real previous graph must NOT mark all nodes as "new".
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { resolve } from 'path'
import { tmpdir } from 'os'
import { persistGraph, loadGraph } from '../../src/lib/intelligence-graph.ts'
import { computeGraphDiff } from '../../src/lib/graph-diff.ts'
import type { CustomerGraph, IntelligenceNode } from '../../src/lib/intelligence-graph-types.ts'

function makeGraph(
  customerId: string,
  nodeOverrides: Record<string, Partial<IntelligenceNode>> = {},
  builtAt?: string,
): CustomerGraph {
  const ts = builtAt ?? new Date().toISOString()
  const baseNodes: Record<string, IntelligenceNode> = {
    [`customer:${customerId}`]: {
      id: `customer:${customerId}`,
      type: 'customer',
      name: customerId,
      properties: {},
      sourceModule: 'intelligence-graph',
      contentHash: 'abc123',
      updatedAt: ts,
      history: { appeared: ts, lastSeen: ts, status: 'active' },
    },
    'subscription:rhel-server': {
      id: 'subscription:rhel-server',
      type: 'subscription',
      name: 'RHEL Server',
      properties: { sku: 'RH00001' },
      sourceModule: 'subscriptions',
      contentHash: 'sub-hash-1',
      updatedAt: ts,
      history: { appeared: ts, lastSeen: ts, status: 'active' },
    },
    'case:00123456': {
      id: 'case:00123456',
      type: 'case',
      name: 'Kernel panic on boot',
      properties: { caseNumber: '00123456', severity: '2' },
      sourceModule: 'cases',
      contentHash: 'case-hash-1',
      updatedAt: ts,
      history: { appeared: ts, lastSeen: ts, status: 'active' },
    },
  }

  // Apply overrides
  for (const [id, overrides] of Object.entries(nodeOverrides)) {
    if (baseNodes[id]) {
      baseNodes[id] = { ...baseNodes[id], ...overrides }
    } else {
      baseNodes[id] = {
        id,
        type: 'product',
        name: id,
        properties: {},
        sourceModule: 'test',
        contentHash: `hash-${id}`,
        updatedAt: ts,
        history: { appeared: ts, lastSeen: ts, status: 'active' },
        ...overrides,
      } as IntelligenceNode
    }
  }

  return {
    customerId,
    customerName: customerId,
    version: '1.0',
    builtAt: ts,
    nodeCount: Object.keys(baseNodes).length,
    edgeCount: 0,
    nodes: baseNodes,
    edges: [],
  }
}

describe('graph-snapshot (#671)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `graph-snapshot-test-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('persistGraph creates .previous.json', () => {
    it('should NOT create .previous.json on first persist (no existing graph)', () => {
      const graph = makeGraph('acme-corp')
      persistGraph(graph, tempDir)

      const prevPath = resolve(tempDir, 'acme-corp', 'intelligence-graph.previous.json')
      expect(existsSync(prevPath)).toBe(false)

      // But the main file should exist
      const mainPath = resolve(tempDir, 'acme-corp', 'intelligence-graph.json')
      expect(existsSync(mainPath)).toBe(true)
    })

    it('should create .previous.json when an existing graph is present', () => {
      const graph1 = makeGraph('acme-corp', {}, '2026-06-01T00:00:00.000Z')
      persistGraph(graph1, tempDir)

      // Second persist — should copy graph1 to .previous.json
      const graph2 = makeGraph('acme-corp', {
        'product:ansible': {
          id: 'product:ansible',
          type: 'product',
          name: 'Ansible',
          properties: {},
          sourceModule: 'tech-stack',
          contentHash: 'ansible-hash',
          updatedAt: '2026-06-07T00:00:00.000Z',
          history: { appeared: '2026-06-07T00:00:00.000Z', lastSeen: '2026-06-07T00:00:00.000Z', status: 'active' },
        },
      }, '2026-06-07T00:00:00.000Z')
      persistGraph(graph2, tempDir)

      const prevPath = resolve(tempDir, 'acme-corp', 'intelligence-graph.previous.json')
      expect(existsSync(prevPath)).toBe(true)

      // The previous file should contain graph1's data
      const prevData = JSON.parse(readFileSync(prevPath, 'utf-8')) as CustomerGraph
      expect(prevData.builtAt).toBe('2026-06-01T00:00:00.000Z')
      expect(prevData.nodes['product:ansible']).toBeUndefined()
    })

    it('should overwrite .previous.json on subsequent persists', () => {
      const graph1 = makeGraph('acme-corp', {}, '2026-06-01T00:00:00.000Z')
      persistGraph(graph1, tempDir)

      const graph2 = makeGraph('acme-corp', {}, '2026-06-03T00:00:00.000Z')
      persistGraph(graph2, tempDir)

      const graph3 = makeGraph('acme-corp', {}, '2026-06-07T00:00:00.000Z')
      persistGraph(graph3, tempDir)

      const prevPath = resolve(tempDir, 'acme-corp', 'intelligence-graph.previous.json')
      const prevData = JSON.parse(readFileSync(prevPath, 'utf-8')) as CustomerGraph
      // Previous should be graph2 (the one before graph3)
      expect(prevData.builtAt).toBe('2026-06-03T00:00:00.000Z')
    })
  })

  describe('computeGraphDiff with previous graph filters correctly', () => {
    it('should mark all nodes as "new" when no previous graph is provided', () => {
      const current = makeGraph('acme-corp')
      const diff = computeGraphDiff(current)

      // Without previous, all non-customer nodes should be "new"
      const newChanges = diff.changes.filter(c => c.changeType === 'new')
      expect(newChanges.length).toBe(2) // subscription + case (customer is excluded)
    })

    it('should NOT mark existing nodes as "new" when previous graph is provided', () => {
      const ts = '2026-06-01T00:00:00.000Z'
      const previous = makeGraph('acme-corp', {}, ts)
      const current = makeGraph('acme-corp', {}, '2026-06-07T00:00:00.000Z')

      const diff = computeGraphDiff(current, previous)

      // Same nodes in both — no changes
      const newChanges = diff.changes.filter(c => c.changeType === 'new')
      expect(newChanges.length).toBe(0)
      expect(diff.summary).toBe('No changes since last rebuild')
    })

    it('should only mark genuinely new nodes as "new"', () => {
      const ts = '2026-06-01T00:00:00.000Z'
      const previous = makeGraph('acme-corp', {}, ts)

      // Add a new product node in the current graph
      const current = makeGraph('acme-corp', {
        'product:openshift': {
          id: 'product:openshift',
          type: 'product',
          name: 'OpenShift',
          properties: {},
          sourceModule: 'tech-stack',
          contentHash: 'osh-hash',
          updatedAt: '2026-06-07T00:00:00.000Z',
          history: { appeared: '2026-06-07T00:00:00.000Z', lastSeen: '2026-06-07T00:00:00.000Z', status: 'active' },
        },
      }, '2026-06-07T00:00:00.000Z')

      const diff = computeGraphDiff(current, previous)

      const newChanges = diff.changes.filter(c => c.changeType === 'new')
      expect(newChanges.length).toBe(1)
      expect(newChanges[0].nodeName).toBe('OpenShift')

      // Existing nodes should NOT appear as new
      const allNodeNames = diff.changes.map(c => c.nodeName)
      expect(allNodeNames).not.toContain('RHEL Server')
      expect(allNodeNames).not.toContain('Kernel panic on boot')
    })

    it('should detect disappeared nodes when previous graph is provided', () => {
      const ts = '2026-06-01T00:00:00.000Z'
      const previous = makeGraph('acme-corp', {}, ts)

      // Current graph has the case node marked as historical (it disappeared)
      const current = makeGraph('acme-corp', {
        'case:00123456': {
          id: 'case:00123456',
          type: 'case',
          name: 'Kernel panic on boot',
          properties: { caseNumber: '00123456', severity: '2' },
          sourceModule: 'cases',
          contentHash: 'case-hash-1',
          updatedAt: ts,
          history: { appeared: ts, lastSeen: ts, status: 'historical' },
        },
      }, '2026-06-07T00:00:00.000Z')

      const diff = computeGraphDiff(current, previous)

      const disappeared = diff.changes.filter(c => c.changeType === 'disappeared')
      expect(disappeared.length).toBe(1)
      expect(disappeared[0].nodeName).toBe('Kernel panic on boot')
    })
  })

  describe('end-to-end: persist -> load previous -> diff', () => {
    it('should produce correct diff using loadGraph for previous snapshot', () => {
      // First build — 2 nodes (sub + case)
      const graph1 = makeGraph('acme-corp', {}, '2026-06-01T00:00:00.000Z')
      persistGraph(graph1, tempDir)

      // Second build — adds a product node
      const graph2 = makeGraph('acme-corp', {
        'product:ansible': {
          id: 'product:ansible',
          type: 'product',
          name: 'Ansible',
          properties: {},
          sourceModule: 'tech-stack',
          contentHash: 'ansible-hash',
          updatedAt: '2026-06-07T00:00:00.000Z',
          history: { appeared: '2026-06-07T00:00:00.000Z', lastSeen: '2026-06-07T00:00:00.000Z', status: 'active' },
        },
      }, '2026-06-07T00:00:00.000Z')
      persistGraph(graph2, tempDir)

      // Load the previous snapshot (should be graph1)
      const prevPath = resolve(tempDir, 'acme-corp', 'intelligence-graph.previous.json')
      expect(existsSync(prevPath)).toBe(true)
      const previousGraph = JSON.parse(readFileSync(prevPath, 'utf-8')) as CustomerGraph

      // Load current graph
      const currentGraph = loadGraph('acme-corp', tempDir)
      expect(currentGraph).not.toBeNull()

      // Compute diff with real previous
      const diff = computeGraphDiff(currentGraph!, previousGraph)

      // Only Ansible should be new — not sub or case
      const newChanges = diff.changes.filter(c => c.changeType === 'new')
      expect(newChanges.length).toBe(1)
      expect(newChanges[0].nodeName).toBe('Ansible')
      expect(diff.previousBuiltAt).toBe('2026-06-01T00:00:00.000Z')
    })
  })
})
