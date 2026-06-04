/**
 * test/unit/graph-summary.test.ts — Unit tests for graph summary generation
 * GitHub Issue #605
 *
 * Tests the core summarizeGraph() function with various CustomerGraph configurations.
 * Verifies token budget, section coverage, and edge case handling.
 */

import { describe, it, expect } from 'bun:test'
import { summarizeGraph } from '../../src/lib/graph-summary.ts'
import type { CustomerGraph, IntelligenceNode, IntelligenceEdge } from '../../src/lib/intelligence-graph-types.ts'

// ── Test fixtures ─────────────────────────────────────────────────────────────

/**
 * Factory function for creating test CustomerGraph instances.
 * Provides minimal valid graph with only customer node by default.
 */
function makeGraph(overrides: Partial<CustomerGraph> = {}): CustomerGraph {
  const customerNode: IntelligenceNode = {
    id: 'customer:acme-corp',
    type: 'customer',
    name: 'Acme Corporation',
    properties: {},
    sourceModule: 'test',
    contentHash: 'test1234',
    updatedAt: new Date().toISOString(),
    history: {
      appeared: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      status: 'active',
    },
  }

  return {
    customerId: 'acme-corp',
    customerName: 'Acme Corporation',
    version: '1.0',
    builtAt: new Date().toISOString(),
    nodeCount: 1,
    edgeCount: 0,
    nodes: { 'customer:acme-corp': customerNode },
    edges: [],
    ...overrides,
  }
}

/**
 * Helper to create a test IntelligenceNode
 */
function makeNode(type: IntelligenceNode['type'], name: string, properties: Record<string, unknown> = {}): IntelligenceNode {
  return {
    id: `${type}:${name.toLowerCase().replace(/\s+/g, '-')}`,
    type,
    name,
    properties,
    sourceModule: 'test',
    contentHash: 'test1234',
    updatedAt: new Date().toISOString(),
    history: {
      appeared: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      status: 'active',
    },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('summarizeGraph', () => {
  describe('empty graph handling', () => {
    it('should produce valid output for customer node only (no signals)', () => {
      const graph = makeGraph()
      const summary = summarizeGraph(graph)

      expect(summary).toContain('Customer: Acme Corporation')
      expect(summary).toContain('Signal density: 0/12 types (0% coverage)')
      expect(summary).not.toContain('undefined')
      expect(summary).not.toContain('null')
      expect(summary.split('\n').length).toBeGreaterThan(0)
    })

    it('should handle graph with no edges gracefully', () => {
      const nodes = {
        'customer:acme-corp': makeNode('customer', 'Acme Corporation'),
        'subscription:rhocp-01': makeNode('subscription', 'OpenShift Container Platform', {
          productDescription: 'OpenShift Container Platform',
          endDate: '2026-12-31',
          urgency: 'active',
        }),
      }

      const graph = makeGraph({
        nodes,
        nodeCount: 2,
        edges: [],
      })

      const summary = summarizeGraph(graph)
      expect(summary).toContain('Customer: Acme Corporation')
      expect(summary).toContain('Active subscriptions:')
      expect(summary).not.toContain('undefined')
    })
  })

  describe('full graph with all 12 node types', () => {
    it('should produce structured sections for each populated node type', () => {
      const now = new Date()
      const futureDate = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) // 6 months out

      const nodes = {
        'customer:acme-corp': makeNode('customer', 'Acme Corporation'),
        'subscription:rhocp-01': makeNode('subscription', 'OpenShift', { productDescription: 'OpenShift', endDate: futureDate }),
        'case:12345': makeNode('case', 'Case 12345', { product: 'RHEL', severity: '3' }),
        'deal:opp-001': makeNode('deal', 'Q2 Expansion', { amount: 150000 }),
        'product:vmware': makeNode('product', 'VMware', { techName: 'VMware vSphere' }),
        'engagement:email-001': makeNode('engagement', 'Email discussion', { channel: 'email' }),
        'intel:comp-001': makeNode('intel', 'Competitor Intel', { intelType: 'competitive', competitor: 'AWS' }),
        'lifecycle:rhel7': makeNode('lifecycle', 'RHEL 7 EOL', { product: 'RHEL 7', eolDate: '2026-09-30' }),
        'event:summit-2026': makeNode('event', 'Red Hat Summit 2026'),
        'partner:cisco': makeNode('partner', 'Cisco'),
        'program:cloud-001': makeNode('program', 'AWS Cloud Spend', { programType: 'cloud-spend', cloudPartner: 'AWS', acvPlus: 50000 }),
        'program:marketplace-001': makeNode('program', 'Azure Marketplace', { programType: 'marketplace', provider: 'Azure' }),
        'play:vmware-migration': makeNode('play', 'VMware to OpenShift Migration'),
      }

      const graph = makeGraph({
        nodes,
        nodeCount: Object.keys(nodes).length,
      })

      const summary = summarizeGraph(graph)

      // Verify key sections are present
      expect(summary).toContain('Customer: Acme Corporation')
      expect(summary).toContain('Active subscriptions:')
      expect(summary).toContain('Open cases:')
      expect(summary).toContain('Pipeline:')
      expect(summary).toContain('Tech stack:')
      expect(summary).toContain('Recent engagement:')
      expect(summary).toContain('Competitor tech:')
      expect(summary).toContain('Upcoming EOL:')
      expect(summary).toContain('Events:')
      expect(summary).toContain('Partner ecosystem:')
      expect(summary).toContain('Cloud spend:')
      expect(summary).toContain('Marketplace:')
      expect(summary).toContain('Active solution plays:')
      expect(summary).toContain('Signal density:')

      // Verify no broken placeholders
      expect(summary).not.toContain('undefined')
      expect(summary).not.toContain('null')
      expect(summary).not.toContain('NaN')
    })
  })

  describe('token budget constraint', () => {
    it('should stay under 500 tokens (approximately 2000 characters)', () => {
      // Create a graph with significant data
      const nodes: Record<string, IntelligenceNode> = {
        'customer:acme-corp': makeNode('customer', 'Acme Corporation'),
      }

      // Add 20 subscriptions
      for (let i = 1; i <= 20; i++) {
        nodes[`subscription:sub-${i}`] = makeNode('subscription', `Subscription ${i}`, {
          productDescription: `Product ${i}`,
          endDate: '2026-12-31',
        })
      }

      // Add 30 cases
      for (let i = 1; i <= 30; i++) {
        nodes[`case:case-${i}`] = makeNode('case', `Case ${i}`, {
          product: i % 2 === 0 ? 'RHEL' : 'OpenShift',
          severity: String((i % 4) + 1),
        })
      }

      // Add 15 products
      for (let i = 1; i <= 15; i++) {
        nodes[`product:tech-${i}`] = makeNode('product', `Technology ${i}`, {
          techName: `Tech Stack Item ${i}`,
        })
      }

      const graph = makeGraph({
        nodes,
        nodeCount: Object.keys(nodes).length,
      })

      const summary = summarizeGraph(graph)
      const charCount = summary.length

      // Approximate 500 tokens = ~2000 characters (conservative estimate)
      expect(charCount).toBeLessThan(2000)

      // Should still contain key sections despite truncation
      expect(summary).toContain('Customer: Acme Corporation')
      expect(summary).toContain('Signal density:')
    })
  })

  describe('tech stack cap', () => {
    it('should cap tech stack items at 10 and show +N more suffix', () => {
      const nodes: Record<string, IntelligenceNode> = {
        'customer:acme-corp': makeNode('customer', 'Acme Corporation'),
      }

      // Add 15 tech stack products
      for (let i = 1; i <= 15; i++) {
        nodes[`product:tech-${i}`] = makeNode('product', `Tech ${i}`, {
          techName: `Technology ${i}`,
        })
      }

      const graph = makeGraph({
        nodes,
        nodeCount: Object.keys(nodes).length,
      })

      const summary = summarizeGraph(graph)

      expect(summary).toContain('Tech stack:')
      expect(summary).toContain('(+5 more)')

      // Should show first 10 items
      expect(summary).toContain('Technology 1')
      expect(summary).toContain('Technology 10')
    })

    it('should not show +N more suffix when tech stack has 10 or fewer items', () => {
      const nodes: Record<string, IntelligenceNode> = {
        'customer:acme-corp': makeNode('customer', 'Acme Corporation'),
      }

      // Add exactly 10 tech stack products
      for (let i = 1; i <= 10; i++) {
        nodes[`product:tech-${i}`] = makeNode('product', `Tech ${i}`, {
          techName: `Technology ${i}`,
        })
      }

      const graph = makeGraph({
        nodes,
        nodeCount: Object.keys(nodes).length,
      })

      const summary = summarizeGraph(graph)

      expect(summary).toContain('Tech stack:')
      expect(summary).not.toContain('(+')
      expect(summary).not.toContain('more)')
    })
  })

  describe('missing node types', () => {
    it('should gracefully omit sections when node types are missing', () => {
      // Graph with only subscriptions, no other types
      const nodes = {
        'customer:acme-corp': makeNode('customer', 'Acme Corporation'),
        'subscription:rhocp-01': makeNode('subscription', 'OpenShift', {
          productDescription: 'OpenShift Container Platform',
          endDate: '2027-06-30',
        }),
      }

      const graph = makeGraph({
        nodes,
        nodeCount: 2,
      })

      const summary = summarizeGraph(graph)

      // Should include subscription section
      expect(summary).toContain('Active subscriptions:')

      // Should NOT include sections for missing types
      expect(summary).not.toContain('Open cases:')
      expect(summary).not.toContain('Pipeline:')
      expect(summary).not.toContain('Tech stack:')
      expect(summary).not.toContain('Recent engagement:')

      // Should still have customer name and signal density
      expect(summary).toContain('Customer: Acme Corporation')
      expect(summary).toContain('Signal density:')

      // No undefined/null leaks
      expect(summary).not.toContain('undefined')
      expect(summary).not.toContain('null')
    })

    it('should handle missing optional properties gracefully', () => {
      const nodes = {
        'customer:acme-corp': makeNode('customer', 'Acme Corporation'),
        'subscription:sub-001': makeNode('subscription', 'Subscription', {
          // No productDescription, no endDate, no urgency
        }),
        'case:case-001': makeNode('case', 'Case', {
          // No product, no severity
        }),
        'deal:deal-001': makeNode('deal', 'Deal', {
          // No amount
        }),
      }

      const graph = makeGraph({
        nodes,
        nodeCount: 4,
      })

      const summary = summarizeGraph(graph)

      // Should render sections without errors
      expect(summary).toContain('Active subscriptions:')
      expect(summary).toContain('Open cases:')
      expect(summary).toContain('Pipeline:')

      // Should use fallback values
      expect(summary).toContain('unknown')

      // No undefined/null leaks
      expect(summary).not.toContain('undefined')
      expect(summary).not.toContain('null')
    })
  })

  describe('subscription status handling', () => {
    it('should show expired status with past end dates', () => {
      const pastDate = '2024-01-15' // In the past

      const nodes = {
        'customer:acme-corp': makeNode('customer', 'Acme Corporation'),
        'subscription:expired-sub': makeNode('subscription', 'Expired Subscription', {
          productDescription: 'Old Product',
          endDate: pastDate,
        }),
      }

      const graph = makeGraph({
        nodes,
        nodeCount: 2,
      })

      const summary = summarizeGraph(graph)

      expect(summary).toContain('Active subscriptions:')
      expect(summary).toContain('expired')
      expect(summary).toContain('2024-01')
    })

    it('should show expires status with future end dates', () => {
      const futureDate = '2027-12-31' // In the future

      const nodes = {
        'customer:acme-corp': makeNode('customer', 'Acme Corporation'),
        'subscription:active-sub': makeNode('subscription', 'Active Subscription', {
          productDescription: 'Current Product',
          endDate: futureDate,
        }),
      }

      const graph = makeGraph({
        nodes,
        nodeCount: 2,
      })

      const summary = summarizeGraph(graph)

      expect(summary).toContain('Active subscriptions:')
      expect(summary).toContain('expires')
      expect(summary).toContain('2027-12')
    })

    it('should include urgency status when not active', () => {
      const nodes = {
        'customer:acme-corp': makeNode('customer', 'Acme Corporation'),
        'subscription:urgent-sub': makeNode('subscription', 'Urgent Subscription', {
          productDescription: 'Critical Product',
          endDate: '2026-12-31',
          urgency: 'expiring-soon',
        }),
      }

      const graph = makeGraph({
        nodes,
        nodeCount: 2,
      })

      const summary = summarizeGraph(graph)

      expect(summary).toContain('Active subscriptions:')
      expect(summary).toContain('[expiring-soon]')
    })
  })

  describe('signal density calculation', () => {
    it('should calculate correct coverage percentage', () => {
      const nodes = {
        'customer:acme-corp': makeNode('customer', 'Acme Corporation'),
        'subscription:sub-01': makeNode('subscription', 'Subscription'),
        'case:case-01': makeNode('case', 'Case'),
        'deal:deal-01': makeNode('deal', 'Deal'),
      }

      const graph = makeGraph({
        nodes,
        nodeCount: 4,
      })

      const summary = summarizeGraph(graph)

      // 3 types (subscription, case, deal) out of 12 = 25%
      expect(summary).toContain('Signal density: 3/12 types (25% coverage)')
    })

    it('should exclude customer node from type count', () => {
      const nodes = {
        'customer:acme-corp': makeNode('customer', 'Acme Corporation'),
      }

      const graph = makeGraph({
        nodes,
        nodeCount: 1,
      })

      const summary = summarizeGraph(graph)

      // Only customer node = 0 types
      expect(summary).toContain('Signal density: 0/12 types (0% coverage)')
    })

    it('should exclude historical nodes from type count', () => {
      const historicalNode = makeNode('subscription', 'Old Subscription')
      historicalNode.history = {
        appeared: '2024-01-01',
        lastSeen: '2024-06-01',
        status: 'historical',
      }

      const nodes = {
        'customer:acme-corp': makeNode('customer', 'Acme Corporation'),
        'subscription:old-sub': historicalNode,
        'case:current-case': makeNode('case', 'Current Case'),
      }

      const graph = makeGraph({
        nodes,
        nodeCount: 3,
      })

      const summary = summarizeGraph(graph)

      // Only 1 active type (case) — historical subscription excluded
      expect(summary).toContain('Signal density: 1/12 types (8% coverage)')
    })
  })

  describe('aggregations and breakdowns', () => {
    it('should aggregate cases by product and severity', () => {
      const nodes = {
        'customer:acme-corp': makeNode('customer', 'Acme Corporation'),
        'case:case-01': makeNode('case', 'Case 1', { product: 'RHEL', severity: '2' }),
        'case:case-02': makeNode('case', 'Case 2', { product: 'RHEL', severity: '3' }),
        'case:case-03': makeNode('case', 'Case 3', { product: 'OpenShift', severity: '2' }),
      }

      const graph = makeGraph({
        nodes,
        nodeCount: 4,
      })

      const summary = summarizeGraph(graph)

      expect(summary).toContain('Open cases: 3')
      expect(summary).toContain('2 on RHEL')
      expect(summary).toContain('1 on OpenShift')
      expect(summary).toContain('2 sev-2')
      expect(summary).toContain('1 sev-3')
    })

    it('should aggregate engagement by channel', () => {
      const nodes = {
        'customer:acme-corp': makeNode('customer', 'Acme Corporation'),
        'engagement:email-01': makeNode('engagement', 'Email 1', { channel: 'email' }),
        'engagement:email-02': makeNode('engagement', 'Email 2', { channel: 'email' }),
        'engagement:meeting-01': makeNode('engagement', 'Meeting 1', { channel: 'meeting' }),
      }

      const graph = makeGraph({
        nodes,
        nodeCount: 4,
      })

      const summary = summarizeGraph(graph)

      expect(summary).toContain('Recent engagement:')
      expect(summary).toContain('2 email')
      expect(summary).toContain('1 meeting')
    })
  })
})
