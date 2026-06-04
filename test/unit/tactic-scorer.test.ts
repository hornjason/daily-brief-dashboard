/**
 * test/unit/tactic-scorer.test.ts
 * TDD tests for TacticScorer — #591
 *
 * Validates that scoreTactics() traverses engagement, intel, lifecycle,
 * event, evidence, and partner node types to boost tactic scoring beyond
 * the base keyword match.
 */

import { describe, it, expect, beforeAll } from 'bun:test'
import type { CustomerGraph, IntelligenceNode, IntelligenceEdge } from '../../src/lib/intelligence-graph-types.ts'

let scoreTactics: typeof import('../../src/lib/tactic-scorer.ts').scoreTactics
let formatRecency: typeof import('../../src/lib/tactic-scorer.ts').formatRecency
let TOTAL_SIGNAL_TYPES: typeof import('../../src/lib/tactic-scorer.ts').TOTAL_SIGNAL_TYPES
let DIVERSITY_WEIGHT: typeof import('../../src/lib/tactic-scorer.ts').DIVERSITY_WEIGHT
let computePortfolioFrequency: typeof import('../../src/lib/tactic-scorer.ts').computePortfolioFrequency
type ScoredTactic = import('../../src/lib/tactic-scorer.ts').ScoredTactic
type EvidenceItem = import('../../src/lib/tactic-scorer.ts').EvidenceItem
type SignalDensity = import('../../src/lib/tactic-scorer.ts').SignalDensity

beforeAll(async () => {
  const mod = await import('../../src/lib/tactic-scorer.ts')
  scoreTactics = mod.scoreTactics
  formatRecency = mod.formatRecency
  TOTAL_SIGNAL_TYPES = mod.TOTAL_SIGNAL_TYPES
  DIVERSITY_WEIGHT = mod.DIVERSITY_WEIGHT
  computePortfolioFrequency = mod.computePortfolioFrequency
})

// ── Test Helpers ────────────────────────────────────────────────────────────

function makeNode(id: string, type: string, name: string, props: Record<string, unknown> = {}): IntelligenceNode {
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

function makeEdge(from: string, to: string, relation: string, opts: Partial<IntelligenceEdge> = {}): IntelligenceEdge {
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

function makeGraph(nodes: IntelligenceNode[], edges: IntelligenceEdge[]): CustomerGraph {
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

const CANDIDATE_TACTICS = [
  { name: 'Automate at Scale', parentTdp: 'Automation', assets: [{ name: 'ROI Calc', url: 'https://example.com/roi', type: 'share' }] },
  { name: 'K8s for AI Workloads', parentTdp: 'Container Mgmt', assets: [] },
  { name: 'Production AI', parentTdp: 'AI', assets: [] },
  { name: 'VM Migration', parentTdp: 'Virtualization', assets: [] },
]

// ── formatRecency ───────────────────────────────────────────────────────────

describe('formatRecency', () => {
  it('returns hours for < 24h', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    expect(formatRecency(twoHoursAgo)).toBe('2h ago')
  })

  it('returns days for 1-30d', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatRecency(fiveDaysAgo)).toBe('5d ago')
  })

  it('returns 30d+ for > 30 days', () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatRecency(sixtyDaysAgo)).toBe('30d+ ago')
  })
})

// ── scoreTactics base behavior ──────────────────────────────────────────────

describe('scoreTactics — base scoring', () => {
  it('returns ScoredTactic[] with compositeScore and evidenceTrail', () => {
    const graph = makeGraph(
      [makeNode('customer:test', 'customer', 'Test Customer')],
      [],
    )
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(CANDIDATE_TACTICS.length)
    for (const t of result) {
      expect(typeof t.compositeScore).toBe('number')
      expect(Array.isArray(t.evidenceTrail)).toBe(true)
      expect(typeof t.name).toBe('string')
      expect(typeof t.parentTdp).toBe('string')
    }
  })

  it('preserves tactic assets and parentTdp', () => {
    const graph = makeGraph([makeNode('customer:test', 'customer', 'Test')], [])
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    const automate = result.find(t => t.name === 'Automate at Scale')!
    expect(automate.parentTdp).toBe('Automation')
    expect(automate.assets.length).toBe(1)
    expect(automate.assets[0].name).toBe('ROI Calc')
  })

  it('subscription nodes contribute to base score', () => {
    const graph = makeGraph(
      [
        makeNode('customer:test', 'customer', 'Test'),
        makeNode('subscription:ansible', 'subscription', 'Ansible Automation Platform', {
          productDescription: 'Red Hat Ansible Automation Platform',
          status: 'Active',
        }),
      ],
      [makeEdge('customer:test', 'subscription:ansible', 'HAS_SUBSCRIPTION')],
    )
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    const automate = result.find(t => t.name === 'Automate at Scale')!
    const vmMigrate = result.find(t => t.name === 'VM Migration')!
    // Automation tactic should score higher with Ansible subscription present
    expect(automate.compositeScore).toBeGreaterThan(vmMigrate.compositeScore)
  })
})

// ── AC-2 / AC-3: Engagement nodes → recency boost ─────────────────────────

describe('scoreTactics — engagement boost (AC-2, AC-3)', () => {
  it('recent engagement boosts tactic score', () => {
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() // 2 days ago
    const graph = makeGraph(
      [
        makeNode('customer:test', 'customer', 'Test'),
        makeNode('engagement:email1', 'engagement', 'Email discussing Ansible automation', {
          engagementType: 'email',
          summary: 'Customer interested in expanding Ansible automation',
        }),
      ],
      [makeEdge('customer:test', 'engagement:email1', 'HAS_ENGAGEMENT', {
        createdAt: recentDate,
        sourceType: 'engagement',
      })],
    )
    const withEngagement = scoreTactics(graph, CANDIDATE_TACTICS)
    const graphWithout = makeGraph([makeNode('customer:test', 'customer', 'Test')], [])
    const withoutEngagement = scoreTactics(graphWithout, CANDIDATE_TACTICS)

    const automateWith = withEngagement.find(t => t.name === 'Automate at Scale')!
    const automateWithout = withoutEngagement.find(t => t.name === 'Automate at Scale')!
    expect(automateWith.compositeScore).toBeGreaterThan(automateWithout.compositeScore)
  })

  it('engagement creates evidence trail entry', () => {
    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
    const graph = makeGraph(
      [
        makeNode('customer:test', 'customer', 'Test'),
        makeNode('engagement:email1', 'engagement', 'Email discussing Ansible automation', {
          engagementType: 'email',
        }),
      ],
      [makeEdge('customer:test', 'engagement:email1', 'HAS_ENGAGEMENT', {
        createdAt: recentDate,
        sourceType: 'engagement',
      })],
    )
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    const automate = result.find(t => t.name === 'Automate at Scale')!
    const engagementEvidence = automate.evidenceTrail.find(e => e.module === 'engagement')
    expect(engagementEvidence).toBeDefined()
    expect(engagementEvidence!.fact).toContain('Ansible')
  })
})

// ── AC-4: Intel nodes → competitive boost ──────────────────────────────────

describe('scoreTactics — competitive boost (AC-4)', () => {
  it('competitive intel boosts displacement-relevant tactics', () => {
    const graph = makeGraph(
      [
        makeNode('customer:test', 'customer', 'Test'),
        makeNode('intel:vmware-pressure', 'intel', 'VMware license cost increase', {
          intelType: 'competitive',
          competitor: 'VMware',
          domain: 'Virtualization',
        }),
      ],
      [makeEdge('customer:test', 'intel:vmware-pressure', 'HAS_INTEL', {
        sourceType: 'intel',
      })],
    )
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    const vmMigrate = result.find(t => t.name === 'VM Migration')!
    // VM Migration (Virtualization TDP) should get competitive boost from VMware intel
    expect(vmMigrate.evidenceTrail.some(e => e.module === 'intel')).toBe(true)

    // Compare against graph without intel
    const graphWithout = makeGraph([makeNode('customer:test', 'customer', 'Test')], [])
    const withoutIntel = scoreTactics(graphWithout, CANDIDATE_TACTICS)
    const vmMigrateWithout = withoutIntel.find(t => t.name === 'VM Migration')!
    expect(vmMigrate.compositeScore).toBeGreaterThan(vmMigrateWithout.compositeScore)
  })
})

// ── AC-2: Lifecycle nodes → urgency boost ──────────────────────────────────

describe('scoreTactics — lifecycle urgency boost (AC-2)', () => {
  it('upcoming EOL boosts tactic score significantly', () => {
    const threeMonthsFromNow = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
    const graph = makeGraph(
      [
        makeNode('customer:test', 'customer', 'Test'),
        makeNode('lifecycle:ansible-eol', 'lifecycle', 'Ansible Automation Platform EOL', {
          product: 'Ansible Automation Platform',
          eolDate: threeMonthsFromNow,
          milestone: 'end-of-life',
        }),
      ],
      [makeEdge('customer:test', 'lifecycle:ansible-eol', 'HAS_LIFECYCLE', {
        sourceType: 'lifecycle',
      })],
    )
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    const automate = result.find(t => t.name === 'Automate at Scale')!
    expect(automate.evidenceTrail.some(e => e.module === 'lifecycle')).toBe(true)

    // Compare
    const graphWithout = makeGraph([makeNode('customer:test', 'customer', 'Test')], [])
    const withoutLifecycle = scoreTactics(graphWithout, CANDIDATE_TACTICS)
    const automateWithout = withoutLifecycle.find(t => t.name === 'Automate at Scale')!
    expect(automate.compositeScore).toBeGreaterThan(automateWithout.compositeScore)
  })
})

// ── AC-2: Event nodes → evidence boost ─────────────────────────────────────

describe('scoreTactics — event evidence boost (AC-2)', () => {
  it('event nodes matching tactic domain add evidence', () => {
    const graph = makeGraph(
      [
        makeNode('customer:test', 'customer', 'Test'),
        makeNode('event:summit', 'event', 'Red Hat Summit AI Track', {
          eventType: 'conference',
          topics: ['AI', 'OpenShift'],
        }),
      ],
      [makeEdge('customer:test', 'event:summit', 'ATTENDED_EVENT', {
        sourceType: 'event',
      })],
    )
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    const aiTactic = result.find(t => t.name === 'Production AI')!
    expect(aiTactic.evidenceTrail.some(e => e.module === 'event')).toBe(true)
  })
})

// ── AC-2: Evidence nodes → evidence boost ──────────────────────────────────

describe('scoreTactics — evidence node boost (AC-2)', () => {
  it('evidence nodes corroborating domain increase score', () => {
    const graph = makeGraph(
      [
        makeNode('customer:test', 'customer', 'Test'),
        makeNode('evidence:automation-roi', 'evidence', 'Ansible ROI study validates automation investment', {
          domain: 'Automation',
          evidenceType: 'study',
        }),
      ],
      [makeEdge('customer:test', 'evidence:automation-roi', 'HAS_EVIDENCE', {
        sourceType: 'evidence',
      })],
    )
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    const automate = result.find(t => t.name === 'Automate at Scale')!
    expect(automate.evidenceTrail.some(e => e.module === 'evidence')).toBe(true)

    const graphWithout = makeGraph([makeNode('customer:test', 'customer', 'Test')], [])
    const withoutEvidence = scoreTactics(graphWithout, CANDIDATE_TACTICS)
    const automateWithout = withoutEvidence.find(t => t.name === 'Automate at Scale')!
    expect(automate.compositeScore).toBeGreaterThan(automateWithout.compositeScore)
  })
})

// ── AC-2: Partner nodes → partner boost ────────────────────────────────────

describe('scoreTactics — partner boost (AC-2)', () => {
  it('partner nodes aligned with tactic domain boost score', () => {
    const graph = makeGraph(
      [
        makeNode('customer:test', 'customer', 'Test'),
        makeNode('partner:aws', 'partner', 'AWS Partnership', {
          partnerType: 'cloud',
          domain: 'Container Mgmt',
        }),
      ],
      [makeEdge('customer:test', 'partner:aws', 'HAS_PARTNER', {
        sourceType: 'partner',
      })],
    )
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    const k8s = result.find(t => t.name === 'K8s for AI Workloads')!
    expect(k8s.evidenceTrail.some(e => e.module === 'partner')).toBe(true)

    const graphWithout = makeGraph([makeNode('customer:test', 'customer', 'Test')], [])
    const withoutPartner = scoreTactics(graphWithout, CANDIDATE_TACTICS)
    const k8sWithout = withoutPartner.find(t => t.name === 'K8s for AI Workloads')!
    expect(k8s.compositeScore).toBeGreaterThan(k8sWithout.compositeScore)
  })
})

// ── AC-5: Evidence trail capped at top 5 ───────────────────────────────────

describe('scoreTactics — evidence trail cap (AC-5)', () => {
  it('evidenceTrail capped at 5 items sorted by weight', () => {
    // Create a graph with many signals for Automation domain
    const nodes = [
      makeNode('customer:test', 'customer', 'Test'),
      makeNode('engagement:e1', 'engagement', 'Ansible email 1', { engagementType: 'email' }),
      makeNode('engagement:e2', 'engagement', 'Ansible email 2', { engagementType: 'email' }),
      makeNode('engagement:e3', 'engagement', 'Ansible meeting', { engagementType: 'meeting' }),
      makeNode('intel:i1', 'intel', 'Puppet competitor intel', { intelType: 'competitive', competitor: 'Puppet', domain: 'Automation' }),
      makeNode('evidence:ev1', 'evidence', 'Automation study 1', { domain: 'Automation' }),
      makeNode('evidence:ev2', 'evidence', 'Automation study 2', { domain: 'Automation' }),
      makeNode('lifecycle:lc1', 'lifecycle', 'Ansible EOL', { product: 'Ansible', eolDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString() }),
      makeNode('partner:p1', 'partner', 'Automation partner', { domain: 'Automation' }),
    ]
    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
    const edges = nodes.slice(1).map(n =>
      makeEdge('customer:test', n.id, 'RELATED', { createdAt: recentDate, sourceType: n.type })
    )

    const graph = makeGraph(nodes, edges)
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    const automate = result.find(t => t.name === 'Automate at Scale')!
    expect(automate.evidenceTrail.length).toBeLessThanOrEqual(5)
    // Should be sorted by weight descending
    for (let i = 1; i < automate.evidenceTrail.length; i++) {
      expect(automate.evidenceTrail[i - 1].weight).toBeGreaterThanOrEqual(automate.evidenceTrail[i].weight)
    }
  })
})

// ── AC-7: Composite score ordering ─────────────────────────────────────────

describe('scoreTactics — composite ordering (AC-7)', () => {
  it('tactics with more signal support score higher', () => {
    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
    const graph = makeGraph(
      [
        makeNode('customer:test', 'customer', 'Test'),
        makeNode('subscription:ansible', 'subscription', 'Ansible Platform', {
          productDescription: 'Red Hat Ansible Automation Platform',
          status: 'Active',
        }),
        makeNode('engagement:ansible-email', 'engagement', 'Email about Ansible upgrade', {
          engagementType: 'email',
        }),
        makeNode('evidence:ansible-study', 'evidence', 'Ansible ROI study', {
          domain: 'Automation',
        }),
      ],
      [
        makeEdge('customer:test', 'subscription:ansible', 'HAS_SUBSCRIPTION'),
        makeEdge('customer:test', 'engagement:ansible-email', 'HAS_ENGAGEMENT', {
          createdAt: recentDate,
          sourceType: 'engagement',
        }),
        makeEdge('customer:test', 'evidence:ansible-study', 'HAS_EVIDENCE', {
          sourceType: 'evidence',
        }),
      ],
    )
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    // Sort by compositeScore descending — Automation should be near top
    const sorted = [...result].sort((a, b) => b.compositeScore - a.compositeScore)
    expect(sorted[0].parentTdp).toBe('Automation')
  })
})

// ── AC-1 / AC-5 (#595): Signal density computation ───────────────────────

describe('scoreTactics — signal density (#595)', () => {
  it('TOTAL_SIGNAL_TYPES is 12', () => {
    expect(TOTAL_SIGNAL_TYPES).toBe(12)
  })

  it('returns signalDensity on every ScoredTactic', () => {
    const graph = makeGraph(
      [makeNode('customer:test', 'customer', 'Test Customer')],
      [],
    )
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    for (const t of result) {
      expect(t.signalDensity).toBeDefined()
      expect(typeof t.signalDensity.populated).toBe('number')
      expect(t.signalDensity.total).toBe(12)
    }
  })

  it('counts 0 populated when graph has only customer node', () => {
    const graph = makeGraph(
      [makeNode('customer:test', 'customer', 'Test')],
      [],
    )
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    expect(result[0].signalDensity.populated).toBe(0)
  })

  it('counts distinct node types excluding customer', () => {
    const graph = makeGraph(
      [
        makeNode('customer:test', 'customer', 'Test'),
        makeNode('sub:1', 'subscription', 'Ansible', { productDescription: 'Ansible' }),
        makeNode('sub:2', 'subscription', 'RHEL', { productDescription: 'RHEL' }),
        makeNode('case:1', 'case', 'Case 1', { product: 'Ansible' }),
        makeNode('eng:1', 'engagement', 'Email', {}),
        makeNode('intel:1', 'intel', 'Intel', { intelType: 'general' }),
      ],
      [
        makeEdge('customer:test', 'sub:1', 'HAS_SUBSCRIPTION'),
        makeEdge('customer:test', 'sub:2', 'HAS_SUBSCRIPTION'),
        makeEdge('customer:test', 'case:1', 'HAS_CASE'),
        makeEdge('customer:test', 'eng:1', 'HAS_ENGAGEMENT'),
        makeEdge('customer:test', 'intel:1', 'HAS_INTEL'),
      ],
    )
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    // 4 distinct types: subscription, case, engagement, intel (2 subscriptions count as 1 type)
    expect(result[0].signalDensity.populated).toBe(4)
    expect(result[0].signalDensity.total).toBe(12)
  })

  it('density is same for all tactics (per-customer, not per-tactic)', () => {
    const graph = makeGraph(
      [
        makeNode('customer:test', 'customer', 'Test'),
        makeNode('sub:1', 'subscription', 'Ansible', { productDescription: 'Ansible' }),
        makeNode('partner:1', 'partner', 'AWS', { domain: 'Container Mgmt' }),
      ],
      [
        makeEdge('customer:test', 'sub:1', 'HAS_SUBSCRIPTION'),
        makeEdge('customer:test', 'partner:1', 'HAS_PARTNER'),
      ],
    )
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    const densities = result.map(t => t.signalDensity)
    // All should be identical
    for (const d of densities) {
      expect(d.populated).toBe(2)
      expect(d.total).toBe(12)
    }
  })

  it('prefixes evidenceTrail with limited data note when populated < 4', () => {
    const graph = makeGraph(
      [
        makeNode('customer:test', 'customer', 'Test'),
        makeNode('sub:1', 'subscription', 'Ansible', { productDescription: 'Ansible' }),
      ],
      [makeEdge('customer:test', 'sub:1', 'HAS_SUBSCRIPTION')],
    )
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    const automate = result.find(t => t.name === 'Automate at Scale')!
    // Should have a density warning in evidence trail
    const densityNote = automate.evidenceTrail.find(e => e.module === 'density')
    expect(densityNote).toBeDefined()
    expect(densityNote!.fact).toContain('1 of 12')
  })

  it('does NOT prefix evidenceTrail when populated >= 4', () => {
    const graph = makeGraph(
      [
        makeNode('customer:test', 'customer', 'Test'),
        makeNode('sub:1', 'subscription', 'Ansible', { productDescription: 'Ansible' }),
        makeNode('case:1', 'case', 'Case', { product: 'Ansible' }),
        makeNode('eng:1', 'engagement', 'Email', {}),
        makeNode('intel:1', 'intel', 'Intel', { intelType: 'general' }),
      ],
      [
        makeEdge('customer:test', 'sub:1', 'HAS_SUBSCRIPTION'),
        makeEdge('customer:test', 'case:1', 'HAS_CASE'),
        makeEdge('customer:test', 'eng:1', 'HAS_ENGAGEMENT'),
        makeEdge('customer:test', 'intel:1', 'HAS_INTEL'),
      ],
    )
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    for (const t of result) {
      const densityNote = t.evidenceTrail.find(e => e.module === 'density')
      expect(densityNote).toBeUndefined()
    }
  })

  it('counts all 12 types when fully populated graph', () => {
    const allTypes = [
      'subscription', 'case', 'deal', 'play', 'program', 'product',
      'engagement', 'intel', 'lifecycle', 'event', 'evidence', 'partner',
    ]
    const nodes = [makeNode('customer:test', 'customer', 'Test')]
    const edges: IntelligenceEdge[] = []
    for (const type of allTypes) {
      const id = `${type}:1`
      nodes.push(makeNode(id, type, `Test ${type}`, {}))
      edges.push(makeEdge('customer:test', id, 'RELATED'))
    }
    const graph = makeGraph(nodes, edges)
    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    expect(result[0].signalDensity.populated).toBe(12)
    expect(result[0].signalDensity.total).toBe(12)
  })
})

// ── #618: Diversity penalty ─────────────────────────────────────────────────

describe('scoreTactics — diversity penalty (#618)', () => {
  // Helper: graph with Ansible subscription so Automation tactic has a base score
  function makeAutomationGraph(): CustomerGraph {
    return makeGraph(
      [
        makeNode('customer:test', 'customer', 'Test'),
        makeNode('subscription:ansible', 'subscription', 'Ansible Automation Platform', {
          productDescription: 'Red Hat Ansible Automation Platform',
          status: 'Active',
        }),
      ],
      [makeEdge('customer:test', 'subscription:ansible', 'HAS_SUBSCRIPTION')],
    )
  }

  it('DIVERSITY_WEIGHT defaults to 0.5', () => {
    expect(DIVERSITY_WEIGHT).toBe(0.5)
  })

  it('tactic with 90% frequency gets ~45% penalty', () => {
    const graph = makeAutomationGraph()
    const freq = new Map<string, number>([['Automate at Scale', 0.9]])

    const withPenalty = scoreTactics(graph, CANDIDATE_TACTICS, freq)
    const withoutPenalty = scoreTactics(graph, CANDIDATE_TACTICS)

    const automateWith = withPenalty.find(t => t.name === 'Automate at Scale')!
    const automateWithout = withoutPenalty.find(t => t.name === 'Automate at Scale')!

    // diversityFactor = 1 - (0.9 * 0.5) = 0.55, so score should be ~55% of original
    const expectedScore = automateWithout.compositeScore * 0.55
    expect(automateWith.compositeScore).toBeCloseTo(expectedScore, 2)
  })

  it('tactic with 0% frequency gets no penalty', () => {
    const graph = makeAutomationGraph()
    const freq = new Map<string, number>([['Automate at Scale', 0.0]])

    const withPenalty = scoreTactics(graph, CANDIDATE_TACTICS, freq)
    const withoutPenalty = scoreTactics(graph, CANDIDATE_TACTICS)

    const automateWith = withPenalty.find(t => t.name === 'Automate at Scale')!
    const automateWithout = withoutPenalty.find(t => t.name === 'Automate at Scale')!

    expect(automateWith.compositeScore).toBe(automateWithout.compositeScore)
  })

  it('portfolioFrequency=undefined → no penalty (backward compat)', () => {
    const graph = makeAutomationGraph()

    const result = scoreTactics(graph, CANDIDATE_TACTICS)
    const resultExplicitUndefined = scoreTactics(graph, CANDIDATE_TACTICS, undefined)

    const automate1 = result.find(t => t.name === 'Automate at Scale')!
    const automate2 = resultExplicitUndefined.find(t => t.name === 'Automate at Scale')!

    expect(automate1.compositeScore).toBe(automate2.compositeScore)
  })

  it('evidence trail includes diversity penalty item', () => {
    const graph = makeAutomationGraph()
    const freq = new Map<string, number>([['Automate at Scale', 0.8]])

    const result = scoreTactics(graph, CANDIDATE_TACTICS, freq)
    const automate = result.find(t => t.name === 'Automate at Scale')!

    const diversityEvidence = automate.evidenceTrail.find(e => e.module === 'diversity')
    expect(diversityEvidence).toBeDefined()
    expect(diversityEvidence!.fact).toContain('80%')
    expect(diversityEvidence!.weight).toBeLessThan(0)
  })

  it('tactic not in frequency map gets no penalty', () => {
    const graph = makeAutomationGraph()
    // Only penalize 'Production AI', not 'Automate at Scale'
    const freq = new Map<string, number>([['Production AI', 0.9]])

    const withFreq = scoreTactics(graph, CANDIDATE_TACTICS, freq)
    const withoutFreq = scoreTactics(graph, CANDIDATE_TACTICS)

    const automateWith = withFreq.find(t => t.name === 'Automate at Scale')!
    const automateWithout = withoutFreq.find(t => t.name === 'Automate at Scale')!

    expect(automateWith.compositeScore).toBe(automateWithout.compositeScore)
  })
})

// ── #621: Team alignment boost ─────────────────────────────────────────────

describe('scoreTactics — team alignment boost (#621)', () => {
  const teamContext = [
    { name: 'Jane Smith', role: 'SSP', products: ['OpenShift'] },
    { name: 'Bob Jones', role: 'SSA', products: ['Ansible'] },
  ]

  it('team member with matching product adds +0.1 boost', () => {
    const graph = makeGraph(
      [makeNode('customer:test', 'customer', 'Test')],
      [],
    )
    const withTeam = scoreTactics(graph, CANDIDATE_TACTICS, undefined, teamContext)
    const withoutTeam = scoreTactics(graph, CANDIDATE_TACTICS)

    // Automation tactic should get +0.1 from Bob Jones (Ansible matches Automation TDP keywords)
    const automateWith = withTeam.find(t => t.name === 'Automate at Scale')!
    const automateWithout = withoutTeam.find(t => t.name === 'Automate at Scale')!
    expect(automateWith.compositeScore).toBeCloseTo(automateWithout.compositeScore + 0.1, 5)
  })

  it('team member with non-matching product gives no boost', () => {
    const nonMatchingTeam = [
      { name: 'Alice Lee', role: 'SSP', products: ['Storage'] },
    ]
    const graph = makeGraph(
      [makeNode('customer:test', 'customer', 'Test')],
      [],
    )
    const withTeam = scoreTactics(graph, CANDIDATE_TACTICS, undefined, nonMatchingTeam)
    const withoutTeam = scoreTactics(graph, CANDIDATE_TACTICS)

    // No product matches any tactic — scores should be identical
    for (const tactic of CANDIDATE_TACTICS) {
      const scoreWith = withTeam.find(t => t.name === tactic.name)!.compositeScore
      const scoreWithout = withoutTeam.find(t => t.name === tactic.name)!.compositeScore
      expect(scoreWith).toBe(scoreWithout)
    }
  })

  it('no team context gives no boost (backward compatible)', () => {
    const graph = makeGraph(
      [makeNode('customer:test', 'customer', 'Test')],
      [],
    )
    const result1 = scoreTactics(graph, CANDIDATE_TACTICS)
    const result2 = scoreTactics(graph, CANDIDATE_TACTICS, undefined, undefined)
    const result3 = scoreTactics(graph, CANDIDATE_TACTICS, undefined, [])

    for (const tactic of CANDIDATE_TACTICS) {
      const s1 = result1.find(t => t.name === tactic.name)!.compositeScore
      const s2 = result2.find(t => t.name === tactic.name)!.compositeScore
      const s3 = result3.find(t => t.name === tactic.name)!.compositeScore
      expect(s1).toBe(s2)
      expect(s2).toBe(s3)
    }
  })

  it('evidence trail includes team alignment item', () => {
    const graph = makeGraph(
      [makeNode('customer:test', 'customer', 'Test')],
      [],
    )
    const result = scoreTactics(graph, CANDIDATE_TACTICS, undefined, teamContext)
    const k8s = result.find(t => t.name === 'K8s for AI Workloads')!
    // Jane Smith has OpenShift which matches Container Mgmt
    const teamEvidence = k8s.evidenceTrail.find(e => e.fact.includes('Team alignment'))
    expect(teamEvidence).toBeDefined()
    expect(teamEvidence!.fact).toContain('Jane Smith')
    expect(teamEvidence!.fact).toContain('SSP')
    expect(teamEvidence!.fact).toContain('OpenShift')
  })

  it('multiple team members matching same tactic only boost once (+0.1 not stacking)', () => {
    const multiMatchTeam = [
      { name: 'Jane Smith', role: 'SSP', products: ['OpenShift'] },
      { name: 'Tom Davis', role: 'SSA', products: ['Kubernetes', 'OpenShift Container Platform'] },
    ]
    const graph = makeGraph(
      [makeNode('customer:test', 'customer', 'Test')],
      [],
    )
    const withMulti = scoreTactics(graph, CANDIDATE_TACTICS, undefined, multiMatchTeam)
    const singleTeam = [{ name: 'Jane Smith', role: 'SSP', products: ['OpenShift'] }]
    const withSingle = scoreTactics(graph, CANDIDATE_TACTICS, undefined, singleTeam)

    const k8sMulti = withMulti.find(t => t.name === 'K8s for AI Workloads')!
    const k8sSingle = withSingle.find(t => t.name === 'K8s for AI Workloads')!
    // Both should have exactly +0.1 — no stacking
    expect(k8sMulti.compositeScore).toBe(k8sSingle.compositeScore)
  })
})

// ── #618: computePortfolioFrequency ─────────────────────────────────────────

describe('computePortfolioFrequency (#618)', () => {
  it('computes correct frequencies across 3 customers', () => {
    // Customer A: has Ansible subscription → Automation tactic scores high
    const graphA = makeGraph(
      [
        makeNode('customer:a', 'customer', 'Customer A'),
        makeNode('sub:ansible', 'subscription', 'Ansible Automation Platform', {
          productDescription: 'Red Hat Ansible Automation Platform',
        }),
      ],
      [makeEdge('customer:a', 'sub:ansible', 'HAS_SUBSCRIPTION')],
    )

    // Customer B: has Ansible subscription → same top tactics
    const graphB = makeGraph(
      [
        makeNode('customer:b', 'customer', 'Customer B'),
        makeNode('sub:ansible', 'subscription', 'Ansible Automation Platform', {
          productDescription: 'Red Hat Ansible Automation Platform',
        }),
      ],
      [makeEdge('customer:b', 'sub:ansible', 'HAS_SUBSCRIPTION')],
    )

    // Customer C: has OpenShift subscription → Container Mgmt scores high
    const graphC = makeGraph(
      [
        makeNode('customer:c', 'customer', 'Customer C'),
        makeNode('sub:ocp', 'subscription', 'OpenShift Container Platform', {
          productDescription: 'Red Hat OpenShift Container Platform',
        }),
      ],
      [makeEdge('customer:c', 'sub:ocp', 'HAS_SUBSCRIPTION')],
    )

    const allGraphs = new Map<string, CustomerGraph>([
      ['customer-a', graphA],
      ['customer-b', graphB],
      ['customer-c', graphC],
    ])

    const freq = computePortfolioFrequency(allGraphs, CANDIDATE_TACTICS, 5)

    // 'Automate at Scale' should appear in top-5 for customers A and B (2/3 = 0.667)
    expect(freq.has('Automate at Scale')).toBe(true)
    const automateFreq = freq.get('Automate at Scale')!
    expect(automateFreq).toBeCloseTo(2 / 3, 2)
  })

  it('end-to-end: diversity penalty differentiates top-3 across customers', () => {
    // All 3 customers have AI subscriptions → without penalty, all get same top tactic
    const makeAiGraph = (id: string): CustomerGraph => makeGraph(
      [
        makeNode(`customer:${id}`, 'customer', `Customer ${id}`),
        makeNode(`sub:ai-${id}`, 'subscription', 'OpenShift AI', {
          productDescription: 'Red Hat OpenShift AI data science gpu inference',
        }),
      ],
      [makeEdge(`customer:${id}`, `sub:ai-${id}`, 'HAS_SUBSCRIPTION')],
    )

    const graphA = makeAiGraph('a')
    const graphB = makeAiGraph('b')
    const graphC = makeAiGraph('c')

    // Without diversity penalty, all customers get same ranking
    const resultsNoPenalty = [
      scoreTactics(graphA, CANDIDATE_TACTICS),
      scoreTactics(graphB, CANDIDATE_TACTICS),
      scoreTactics(graphC, CANDIDATE_TACTICS),
    ]

    const topNoPenalty = resultsNoPenalty.map(r =>
      [...r].sort((a, b) => b.compositeScore - a.compositeScore)[0].name
    )
    // All should have the same top tactic (proving the problem)
    expect(topNoPenalty[0]).toBe(topNoPenalty[1])
    expect(topNoPenalty[1]).toBe(topNoPenalty[2])

    // Now compute portfolio frequency and apply it
    const allGraphs = new Map<string, CustomerGraph>([
      ['a', graphA], ['b', graphB], ['c', graphC],
    ])
    const freq = computePortfolioFrequency(allGraphs, CANDIDATE_TACTICS, 3)

    // The tactic that appears in all 3 top-3s gets frequency 1.0
    // With penalty, its score drops by 50%, allowing others to surface
    const resultsWithPenalty = [
      scoreTactics(graphA, CANDIDATE_TACTICS, freq),
      scoreTactics(graphB, CANDIDATE_TACTICS, freq),
      scoreTactics(graphC, CANDIDATE_TACTICS, freq),
    ]

    // The top tactic's score should be lower with penalty applied
    const topWithPenalty = resultsWithPenalty[0]
      .sort((a, b) => b.compositeScore - a.compositeScore)
    const topNoPenaltyResult = resultsNoPenalty[0]
      .sort((a, b) => b.compositeScore - a.compositeScore)

    // The universally-appearing tactic should have a lower score
    const universalTactic = topNoPenalty[0]
    const penalizedScore = topWithPenalty.find(t => t.name === universalTactic)!.compositeScore
    const originalScore = topNoPenaltyResult.find(t => t.name === universalTactic)!.compositeScore
    expect(penalizedScore).toBeLessThan(originalScore)
  })
})
