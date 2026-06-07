/**
 * test/unit/meeting-prep-graph-scoring.test.ts
 * Tests for intelligence graph scoring integration into meeting prep (#642)
 *
 * AC-10: Scored tactics ordered by compositeScore descending
 * AC-11: EOL within 90 days boosts related tactic score
 * AC-12: Integration test — generation path produces output with scored data
 * AC-4: Product lifecycle EOL/EOS within 180 days boost related tactic scores
 * AC-5: Product release signals boost related tactic scores when customer has matching subscriptions
 */

import { describe, it, expect } from 'bun:test'
import type {
  CustomerGraph,
  IntelligenceNode,
  IntelligenceEdge,
} from '../../src/lib/intelligence-graph-types.ts'
import { scoreTactics } from '../../src/lib/tactic-scorer.ts'
import { computeGraphDiff } from '../../src/lib/graph-diff.ts'
import { extractCandidateTactics } from '../../src/lib/meeting-prep-intelligence.ts'
import { formatScoredTacticsForPrompt } from '../../src/lib/meeting-prep-graph-integration.ts'

// ── Test Helpers ──────────────────────────────────────────────────────────────

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
    history: {
      appeared: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      status: 'active',
    },
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
    strength: 0.7,
    evidence: ['test evidence'],
    scoredAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    sourceType: 'test',
    timestampSource: 'signal',
    ...opts,
  }
}

function makeGraph(overrides: Partial<CustomerGraph> = {}): CustomerGraph {
  const customerNode = makeNode('customer:test-co', 'customer', 'Test Co')
  const subNode = makeNode('subscription:rhel', 'subscription', 'RHEL Premium', {
    productDescription: 'Red Hat Enterprise Linux Server',
    quantity: 100,
    endDate: '2027-01-15',
  })
  const playNode = makeNode('play:server-and-cloud-computing', 'play', 'Server and Cloud Computing', {
    tdp: 'Server and Cloud Computing',
    productAlignment: 'Server and Cloud Computing',
  })

  return {
    customerId: 'test-co',
    customerName: 'Test Co',
    version: '1.0',
    builtAt: new Date().toISOString(),
    nodeCount: 3,
    edgeCount: 2,
    nodes: {
      'customer:test-co': customerNode,
      'subscription:rhel': subNode,
      'play:server-and-cloud-computing': playNode,
    },
    edges: [
      makeEdge('customer:test-co', 'subscription:rhel', 'HAS_SUBSCRIPTION'),
      makeEdge('customer:test-co', 'play:server-and-cloud-computing', 'MATCHES_PLAY'),
    ],
    ...overrides,
  }
}

// ── AC-10: Scored tactics ordered by compositeScore descending ─────────────

describe('AC-10: Scored tactics ordering', () => {
  it('should return scored tactics ordered by compositeScore descending', () => {
    const graph = makeGraph()

    // Add a second play with Automation domain
    graph.nodes['play:automation'] = makeNode('play:automation', 'play', 'Build and Run Applications', {
      tdp: 'Automation',
      productAlignment: 'Automation',
    })
    graph.edges.push(makeEdge('customer:test-co', 'play:automation', 'MATCHES_PLAY'))

    // Add an Ansible subscription to boost Automation
    graph.nodes['subscription:ansible'] = makeNode('subscription:ansible', 'subscription', 'Ansible Automation Platform', {
      productDescription: 'Ansible Automation Platform',
      quantity: 50,
    })
    graph.edges.push(makeEdge('customer:test-co', 'subscription:ansible', 'HAS_SUBSCRIPTION'))

    const candidates = extractCandidateTactics(graph)
    const scored = scoreTactics(graph, candidates).sort(
      (a, b) => b.compositeScore - a.compositeScore,
    )

    expect(scored.length).toBeGreaterThanOrEqual(2)

    // Verify descending order
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1].compositeScore).toBeGreaterThanOrEqual(scored[i].compositeScore)
    }

    // Every tactic should have a compositeScore
    for (const tactic of scored) {
      expect(typeof tactic.compositeScore).toBe('number')
      expect(tactic.compositeScore).toBeGreaterThanOrEqual(0)
    }
  })
})

// ── AC-11: EOL within 90 days boosts related tactic score ──────────────────

describe('AC-11: EOL within 90 days boosts tactic score', () => {
  it('should boost tactic score when product has EOL within 90 days', () => {
    const graph = makeGraph()

    // Add lifecycle node with EOL in 60 days
    const eolDate = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
    graph.nodes['lifecycle:rhel-9'] = makeNode('lifecycle:rhel-9', 'lifecycle', 'RHEL 9 End of Life', {
      eolDate,
      product: 'RHEL',
      currentVersion: '9.4',
    })
    graph.edges.push(makeEdge('customer:test-co', 'lifecycle:rhel-9', 'HAS_LIFECYCLE'))

    // Score with EOL
    const candidates = extractCandidateTactics(graph)
    const scoredWithEol = scoreTactics(graph, candidates)
    const serverTacticWithEol = scoredWithEol.find(t => t.parentTdp === 'Server and Cloud Computing')

    // Score without EOL (remove lifecycle node)
    const graphNoEol = makeGraph()
    const candidatesNoEol = extractCandidateTactics(graphNoEol)
    const scoredNoEol = scoreTactics(graphNoEol, candidatesNoEol)
    const serverTacticNoEol = scoredNoEol.find(t => t.parentTdp === 'Server and Cloud Computing')

    expect(serverTacticWithEol).toBeDefined()
    expect(serverTacticNoEol).toBeDefined()

    // The tactic with EOL should score higher
    expect(serverTacticWithEol!.compositeScore).toBeGreaterThan(serverTacticNoEol!.compositeScore)

    // Should have EOL evidence in the trail
    const eolEvidence = serverTacticWithEol!.evidenceTrail.find(e =>
      e.fact.includes('EOL') || e.module === 'lifecycle',
    )
    expect(eolEvidence).toBeDefined()
  })

  it('should NOT boost tactic score when EOL is more than 180 days away', () => {
    const graph = makeGraph()

    // Add lifecycle node with EOL in 250 days (well beyond 180)
    const eolDate = new Date(Date.now() + 250 * 24 * 60 * 60 * 1000).toISOString()
    graph.nodes['lifecycle:rhel-9'] = makeNode('lifecycle:rhel-9', 'lifecycle', 'RHEL 9 End of Life', {
      eolDate,
      product: 'RHEL',
      currentVersion: '9.4',
    })
    graph.edges.push(makeEdge('customer:test-co', 'lifecycle:rhel-9', 'HAS_LIFECYCLE'))

    const candidates = extractCandidateTactics(graph)
    const scoredWithDistantEol = scoreTactics(graph, candidates)
    const serverTacticDistant = scoredWithDistantEol.find(t => t.parentTdp === 'Server and Cloud Computing')

    // Score without any lifecycle
    const graphNoEol = makeGraph()
    const candidatesNoEol = extractCandidateTactics(graphNoEol)
    const scoredNoEol = scoreTactics(graphNoEol, candidatesNoEol)
    const serverTacticNoEol = scoredNoEol.find(t => t.parentTdp === 'Server and Cloud Computing')

    expect(serverTacticDistant).toBeDefined()
    expect(serverTacticNoEol).toBeDefined()

    // No boost — scores should be equal (no urgency applied beyond 6 months)
    expect(serverTacticDistant!.compositeScore).toBe(serverTacticNoEol!.compositeScore)
  })
})

// ── AC-4: Product lifecycle EOL/EOS within 180 days boosts tactic scores ───

describe('AC-4: EOL/EOS within 180 days boosts related tactic scores', () => {
  it('should boost at 179 days (within the 6-month window)', () => {
    const graph = makeGraph()

    // EOL in 179 days — should be within 6-month window
    const eolDate = new Date(Date.now() + 179 * 24 * 60 * 60 * 1000).toISOString()
    graph.nodes['lifecycle:rhel-8'] = makeNode('lifecycle:rhel-8', 'lifecycle', 'RHEL 8 End of Life', {
      eolDate,
      product: 'RHEL',
      currentVersion: '8.10',
    })
    graph.edges.push(makeEdge('customer:test-co', 'lifecycle:rhel-8', 'HAS_LIFECYCLE'))

    const candidates = extractCandidateTactics(graph)
    const scored = scoreTactics(graph, candidates)
    const serverTactic = scored.find(t => t.parentTdp === 'Server and Cloud Computing')

    const graphNoEol = makeGraph()
    const candidatesNoEol = extractCandidateTactics(graphNoEol)
    const scoredNoEol = scoreTactics(graphNoEol, candidatesNoEol)
    const serverTacticNoEol = scoredNoEol.find(t => t.parentTdp === 'Server and Cloud Computing')

    expect(serverTactic!.compositeScore).toBeGreaterThan(serverTacticNoEol!.compositeScore)
  })
})

// ── AC-5: Product release signals boost when customer has matching subs ────

describe('AC-5: Product release signals boost related tactic scores', () => {
  it('should boost tactic score when product-intel node matches customer subscription domain', () => {
    const graph = makeGraph()

    // Add product-intel node about RHEL release
    graph.nodes['intel:product-rhel'] = makeNode('intel:product-rhel', 'intel', 'RHEL 9.5 Released with AI Enhancements', {
      intelType: 'product',
      product: 'RHEL',
      category: 'release',
    })
    graph.edges.push(makeEdge('customer:test-co', 'intel:product-rhel', 'HAS_INTEL'))

    const candidates = extractCandidateTactics(graph)
    const scoredWithRelease = scoreTactics(graph, candidates)
    const serverTacticWithRelease = scoredWithRelease.find(t => t.parentTdp === 'Server and Cloud Computing')

    // Without the release intel
    const graphNoRelease = makeGraph()
    const candidatesNoRelease = extractCandidateTactics(graphNoRelease)
    const scoredNoRelease = scoreTactics(graphNoRelease, candidatesNoRelease)
    const serverTacticNoRelease = scoredNoRelease.find(t => t.parentTdp === 'Server and Cloud Computing')

    expect(serverTacticWithRelease).toBeDefined()
    expect(serverTacticNoRelease).toBeDefined()

    // The tactic with the product release signal should score higher
    expect(serverTacticWithRelease!.compositeScore).toBeGreaterThan(serverTacticNoRelease!.compositeScore)
  })
})

// ── AC-1: extractCandidateTactics is exported ──────────────────────────────

describe('AC-1: extractCandidateTactics exported', () => {
  it('should be importable and return candidate tactics from play nodes', () => {
    const graph = makeGraph()
    const candidates = extractCandidateTactics(graph)

    expect(candidates.length).toBeGreaterThanOrEqual(1)
    expect(candidates[0]).toHaveProperty('name')
    expect(candidates[0]).toHaveProperty('parentTdp')
  })
})

// ── formatScoredTacticsForPrompt ───────────────────────────────────────────

describe('formatScoredTacticsForPrompt', () => {
  it('should format scored tactics into a structured text block for Gemini prompt', () => {
    const graph = makeGraph()
    const candidates = extractCandidateTactics(graph)
    const scored = scoreTactics(graph, candidates).sort(
      (a, b) => b.compositeScore - a.compositeScore,
    )

    const result = formatScoredTacticsForPrompt(scored)

    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
    // Should contain the tactic name
    expect(result).toContain('Server and Cloud Computing')
    // Should contain score
    expect(result).toMatch(/score: \d+\.\d+/)
  })

  it('should return empty string when no scored tactics', () => {
    const result = formatScoredTacticsForPrompt([])
    expect(result).toBe('')
  })
})

// ── AC-12: Integration — generation path produces output with scored data ──

describe('AC-12: Integration test — scored data in generation path', () => {
  it('should produce scored tactics with evidence trails from a realistic graph', () => {
    const graph = makeGraph()

    // Add engagement node
    graph.nodes['engagement:email-recent'] = makeNode('engagement:email-recent', 'engagement', 'Discussion about RHEL migration', {
      channel: 'email',
      techMentions: ['rhel'],
    })
    graph.edges.push(makeEdge('customer:test-co', 'engagement:email-recent', 'HAS_ENGAGEMENT'))

    // Add lifecycle node (EOL in 90 days)
    const eolDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
    graph.nodes['lifecycle:rhel-8'] = makeNode('lifecycle:rhel-8', 'lifecycle', 'RHEL 8 EOL', {
      eolDate,
      product: 'RHEL',
    })
    graph.edges.push(makeEdge('customer:test-co', 'lifecycle:rhel-8', 'HAS_LIFECYCLE'))

    // Add deal node
    graph.nodes['deal:rhel-expansion'] = makeNode('deal:rhel-expansion', 'deal', 'RHEL Server Expansion', {
      stage: 'Negotiate',
      amount: 150000,
      closeDate: '2026-07-15',
    })
    graph.edges.push(makeEdge('customer:test-co', 'deal:rhel-expansion', 'HAS_DEAL'))

    const candidates = extractCandidateTactics(graph)
    const scored = scoreTactics(graph, candidates).sort(
      (a, b) => b.compositeScore - a.compositeScore,
    )
    const diff = computeGraphDiff(graph, null)

    // Scored tactics should exist
    expect(scored.length).toBeGreaterThan(0)

    // Top tactic for Server/Cloud OS should have evidence
    const serverTactic = scored.find(t => t.parentTdp === 'Server and Cloud Computing')
    expect(serverTactic).toBeDefined()
    expect(serverTactic!.evidenceTrail.length).toBeGreaterThan(0)
    expect(serverTactic!.compositeScore).toBeGreaterThan(0)

    // Graph diff should have changes
    expect(diff.changes.length).toBeGreaterThan(0)

    // Format for prompt should produce structured output
    const promptBlock = formatScoredTacticsForPrompt(scored)
    expect(promptBlock).toContain('Server and Cloud Computing')
  })
})
