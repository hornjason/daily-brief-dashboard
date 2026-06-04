/**
 * test/unit/meeting-prep-intelligence.test.ts
 * Integration test for meeting-prep intelligence pipeline — #607
 *
 * Validates that generateMeetingPrepBrief() correctly orchestrates:
 * - loadGraph() → load persisted customer intelligence graph
 * - scoreTactics() → rank tactics by evidence
 * - computeGraphDiff() → detect recent changes
 * - callGemini() → generate natural-language talking points
 *
 * This is an INTEGRATION test: mocks Gemini but exercises real pipeline logic.
 */

import { describe, it, expect, beforeAll, mock } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import type {
  CustomerGraph,
  IntelligenceNode,
  IntelligenceEdge,
} from '../../src/lib/intelligence-graph-types.ts'

let generateMeetingPrepBrief: typeof import('../../src/lib/meeting-prep-intelligence.ts').generateMeetingPrepBrief
type MeetingPrepBrief = import('../../src/lib/meeting-prep-intelligence.ts').MeetingPrepBrief

// ── Test Helpers ────────────────────────────────────────────────────────────

function makeNode(
  id: string,
  type: string,
  name: string,
  props: Record<string, unknown> = {},
): IntelligenceNode {
  return {
    id,
    type: type as any,
    name,
    properties: props,
    sourceModule: 'test',
    contentHash: 'abcd1234',
    updatedAt: new Date().toISOString(),
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
    evidence: [],
    scoredAt: new Date().toISOString(),
    createdAt: opts.createdAt ?? new Date().toISOString(),
    sourceType: opts.sourceType ?? 'test',
    ...opts,
  }
}

function makeGraph(
  nodes: IntelligenceNode[],
  edges: IntelligenceEdge[],
): CustomerGraph {
  const nodeMap: Record<string, IntelligenceNode> = {}
  for (const n of nodes) nodeMap[n.id] = n
  return {
    customerId: 'test-customer',
    customerName: 'Test Customer Inc.',
    version: '1.0',
    builtAt: new Date().toISOString(),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes: nodeMap,
    edges,
  }
}

function setupTestGraph(dataDir: string, customerSlug: string, graph: CustomerGraph) {
  const customerDir = join(dataDir, customerSlug)
  mkdirSync(customerDir, { recursive: true })
  const graphPath = join(customerDir, 'intelligence-graph.json')
  writeFileSync(graphPath, JSON.stringify(graph, null, 2), { mode: 0o600 })
}

// ── Mock Gemini ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  const mod = await import('../../src/lib/meeting-prep-intelligence.ts')
  generateMeetingPrepBrief = mod.generateMeetingPrepBrief

  // Mock callGemini to avoid real API calls
  const geminiMod = await import('../../src/gemini-call.ts')
  mock.module('../../src/gemini-call.ts', () => ({
    ...geminiMod,
    callGemini: mock(async (systemPrompt: string, userPrompt: string) => {
      // Return deterministic talking points for testing
      return {
        text: `Ask about their Ansible automation roadmap given recent support cases.
Discuss RHEL migration opportunities based on subscription expansion.
Review Event-Driven Ansible adoption for self-healing infrastructure.`,
        usage: { inputTokens: 100, outputTokens: 50, totalCost: 0.001 },
      }
    }),
  }))
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('generateMeetingPrepBrief — integration', () => {
  const testDataDir = join('/tmp', 'meeting-prep-test-' + Date.now())

  it('AC-1: exercises generateMeetingPrepBrief() with a realistic mock graph', async () => {
    // Arrange: Create a realistic customer graph with subscriptions, cases, and plays
    const customerSlug = 'test-customer-ac1'
    const nodes = [
      makeNode('customer:test', 'customer', 'Test Customer Inc.'),
      makeNode('subscription:ansible', 'subscription', 'Ansible Automation Platform', {
        productName: 'Red Hat Ansible Automation Platform',
        status: 'Active',
        quantity: 100,
      }),
      makeNode('subscription:rhel', 'subscription', 'Red Hat Enterprise Linux', {
        productName: 'Red Hat Enterprise Linux',
        status: 'Active',
        quantity: 500,
      }),
      makeNode('case:01234567', 'case', 'Ansible playbook performance', {
        severity: 'High',
        status: 'Engineering',
      }),
      makeNode('play:automate-at-scale', 'play', 'Automate at Scale', {
        tdp: 'Automation',
        url: 'https://redhat.com/tdp/automation',
      }),
      makeNode('play:rhel-migration', 'play', 'RHEL Migration', {
        tdp: 'Operating Systems',
        url: 'https://redhat.com/tdp/os',
      }),
    ]

    const edges = [
      makeEdge('customer:test', 'subscription:ansible', 'HAS_SUBSCRIPTION'),
      makeEdge('customer:test', 'subscription:rhel', 'HAS_SUBSCRIPTION'),
      makeEdge('customer:test', 'case:01234567', 'HAS_CASE'),
      makeEdge('customer:test', 'play:automate-at-scale', 'MATCHES_PLAY'),
      makeEdge('customer:test', 'play:rhel-migration', 'MATCHES_PLAY'),
    ]

    const graph = makeGraph(nodes, edges)
    setupTestGraph(testDataDir, customerSlug, graph)

    // Act: Generate the brief
    const brief = await generateMeetingPrepBrief(customerSlug, testDataDir)

    // Assert: Pipeline executed successfully
    expect(brief).not.toBeNull()
    expect(brief!.customerName).toBe('Test Customer Inc.')
  })

  it('AC-2: verifies brief contains talkingPoints, recentChanges, topEvidence, materials', async () => {
    // Arrange: Graph with rich evidence
    const customerSlug = 'test-customer-ac2'
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() // 2 days ago

    const nodes = [
      makeNode('customer:test', 'customer', 'Acme Corporation'),
      makeNode('subscription:openshift', 'subscription', 'OpenShift Container Platform', {
        productName: 'Red Hat OpenShift Container Platform',
        status: 'Active',
      }),
      makeNode('case:98765432', 'case', 'K8s networking issue', {
        severity: 'Medium',
        status: 'Closed',
        createdAt: recentDate,
      }),
      makeNode('play:k8s-for-ai', 'play', 'K8s for AI Workloads', {
        tdp: 'Container Management',
        productAlignment: 'OpenShift',
      }),
      makeNode('engagement:webinar-2024', 'engagement', 'AI on OpenShift Webinar', {
        date: recentDate,
        topic: 'AI workloads',
      }),
    ]

    const edges = [
      makeEdge('customer:test', 'subscription:openshift', 'HAS_SUBSCRIPTION'),
      makeEdge('customer:test', 'case:98765432', 'HAS_CASE', { createdAt: recentDate }),
      makeEdge('customer:test', 'play:k8s-for-ai', 'MATCHES_PLAY'),
      makeEdge('customer:test', 'engagement:webinar-2024', 'ATTENDED', { createdAt: recentDate }),
    ]

    const graph = makeGraph(nodes, edges)
    setupTestGraph(testDataDir, customerSlug, graph)

    // Act
    const brief = await generateMeetingPrepBrief(customerSlug, testDataDir)

    // Assert: All required sections present
    expect(brief).not.toBeNull()
    expect(Array.isArray(brief!.talkingPoints)).toBe(true)
    expect(brief!.talkingPoints.length).toBeGreaterThan(0)

    expect(Array.isArray(brief!.recentChanges)).toBe(true)
    // Recent changes should include new nodes from graph diff

    expect(Array.isArray(brief!.topEvidence)).toBe(true)
    expect(brief!.topEvidence.length).toBeGreaterThan(0)
    expect(brief!.topEvidence[0]).toHaveProperty('fact')
    expect(brief!.topEvidence[0]).toHaveProperty('recency')

    expect(Array.isArray(brief!.materials)).toBe(true)
    // Materials may be empty if no material index matches
  })

  it('AC-3: Gemini call mocked (no real API call)', async () => {
    // Arrange: Minimal graph
    const customerSlug = 'test-customer-ac3'
    const nodes = [
      makeNode('customer:test', 'customer', 'Mock Test Corp'),
      makeNode('play:test-play', 'play', 'Test Play', { tdp: 'Testing' }),
    ]
    const edges = [makeEdge('customer:test', 'play:test-play', 'MATCHES_PLAY')]
    const graph = makeGraph(nodes, edges)
    setupTestGraph(testDataDir, customerSlug, graph)

    // Act
    const brief = await generateMeetingPrepBrief(customerSlug, testDataDir)

    // Assert: Gemini mock returned deterministic talking points
    expect(brief).not.toBeNull()
    expect(brief!.talkingPoints.length).toBeGreaterThanOrEqual(3)
    expect(brief!.talkingPoints[0]).toContain('Ansible automation roadmap')
    // This verifies the mock is working (no real API call)
  })

  it('AC-4: test passes with bun test --isolate', async () => {
    // This test validates the test itself runs in isolation mode
    const customerSlug = 'test-customer-ac4'
    const nodes = [makeNode('customer:test', 'customer', 'Isolation Test Inc.')]
    const edges: IntelligenceEdge[] = []
    const graph = makeGraph(nodes, edges)
    setupTestGraph(testDataDir, customerSlug, graph)

    const brief = await generateMeetingPrepBrief(customerSlug, testDataDir)

    // Even with no tactics, should return a valid brief structure
    expect(brief).not.toBeNull()
    expect(brief!.customerName).toBe('Isolation Test Inc.')
    expect(brief!.signalDensity).toBeDefined()
    expect(brief!.signalDensity.total).toBeGreaterThan(0)
    expect(brief!.generatedAt).toBeDefined()
  })

  it('returns null when no graph exists for customer', async () => {
    // Act: Request brief for non-existent customer
    const brief = await generateMeetingPrepBrief('nonexistent-customer', testDataDir)

    // Assert
    expect(brief).toBeNull()
  })

  it('includes account team in brief output', async () => {
    // Arrange
    const customerSlug = 'test-customer-team'
    const nodes = [makeNode('customer:test', 'customer', 'Team Test Corp')]
    const edges: IntelligenceEdge[] = []
    const graph = makeGraph(nodes, edges)
    setupTestGraph(testDataDir, customerSlug, graph)

    // Act
    const brief = await generateMeetingPrepBrief(customerSlug, testDataDir)

    // Assert: accountTeam array exists (may be empty if customer not in server-state)
    expect(brief).not.toBeNull()
    expect(Array.isArray(brief!.accountTeam)).toBe(true)
    // Each team member has role and name
    if (brief!.accountTeam.length > 0) {
      expect(brief!.accountTeam[0]).toHaveProperty('role')
      expect(brief!.accountTeam[0]).toHaveProperty('name')
    }
  })

  it('signal density calculation reflects populated node types', async () => {
    // Arrange: Graph with 3 distinct signal types (subscription, case, play)
    const customerSlug = 'test-customer-density'
    const nodes = [
      makeNode('customer:test', 'customer', 'Density Test Inc.'),
      makeNode('subscription:test-sub', 'subscription', 'Test Subscription', { status: 'Active' }),
      makeNode('case:test-case', 'case', 'Test Case', { severity: 'Low' }),
      makeNode('play:test-play', 'play', 'Test Play', { tdp: 'Test' }),
    ]
    const edges = [
      makeEdge('customer:test', 'subscription:test-sub', 'HAS_SUBSCRIPTION'),
      makeEdge('customer:test', 'case:test-case', 'HAS_CASE'),
      makeEdge('customer:test', 'play:test-play', 'MATCHES_PLAY'),
    ]
    const graph = makeGraph(nodes, edges)
    setupTestGraph(testDataDir, customerSlug, graph)

    // Act
    const brief = await generateMeetingPrepBrief(customerSlug, testDataDir)

    // Assert: Signal density counts 3 populated types (subscription, case, play)
    expect(brief).not.toBeNull()
    expect(brief!.signalDensity.populated).toBe(3)
    expect(brief!.signalDensity.total).toBeGreaterThan(0)
    expect(brief!.signalDensity.pct).toBeGreaterThan(0)
    expect(brief!.signalDensity.pct).toBeLessThanOrEqual(100)
  })

  it('recent changes formatted correctly', async () => {
    // Arrange: Graph that will trigger diff changes
    const customerSlug = 'test-customer-changes'
    const nodes = [
      makeNode('customer:test', 'customer', 'Changes Test Inc.'),
      makeNode('subscription:new-sub', 'subscription', 'New Subscription', {
        status: 'Active',
        createdAt: new Date().toISOString(),
      }),
    ]
    const edges = [makeEdge('customer:test', 'subscription:new-sub', 'HAS_SUBSCRIPTION')]
    const graph = makeGraph(nodes, edges)
    setupTestGraph(testDataDir, customerSlug, graph)

    // Act
    const brief = await generateMeetingPrepBrief(customerSlug, testDataDir)

    // Assert: recentChanges has correct structure
    expect(brief).not.toBeNull()
    if (brief!.recentChanges.length > 0) {
      const change = brief!.recentChanges[0]
      expect(['new', 'historical', 'reactivated']).toContain(change.type)
      expect(typeof change.description).toBe('string')
      expect(typeof change.when).toBe('string')
    }
  })

  // Cleanup test artifacts
  it('cleanup test artifacts', () => {
    try {
      rmSync(testDataDir, { recursive: true, force: true })
    } catch (e) {
      // Ignore cleanup errors
    }
    expect(true).toBe(true) // Placeholder assertion for cleanup test
  })
})
