/**
 * test/unit/motion-builder.test.ts
 * TDD tests for Motion Builder — #515
 *
 * Uses CrowdStrike fixture data (same signals as intelligence-graph.test.ts)
 * to validate strategic motion generation from customer intelligence graphs.
 */

import { describe, it, expect, beforeAll } from 'bun:test'
import type { Signal } from '../../src/feature-module-registry.ts'
import type { CustomerGraph } from '../../src/lib/intelligence-graph-types.ts'

// Lazy imports
let buildCustomerGraph: typeof import('../../src/lib/intelligence-graph.ts').buildCustomerGraph
let buildMotion: typeof import('../../src/lib/motion-builder.ts').buildMotion
type StrategicMotion = import('../../src/lib/motion-builder.ts').StrategicMotion
type MotionPhase = import('../../src/lib/motion-builder.ts').MotionPhase

beforeAll(async () => {
  const graphModule = await import('../../src/lib/intelligence-graph.ts')
  buildCustomerGraph = graphModule.buildCustomerGraph

  const motionModule = await import('../../src/lib/motion-builder.ts')
  buildMotion = motionModule.buildMotion
})

// ── CrowdStrike Fixture Signals ──────────────────────────────────────────────
// Matches intelligence-graph.test.ts fixtures + SalesHub play/tactic signals

const CROWDSTRIKE_SIGNALS: Signal[] = [
  // Subscriptions (with urgency metadata)
  {
    source: 'subscriptions', type: 'subscription', headline: 'Enterprise Linux Server - 8 subscriptions',
    detail: '', timestamp: '2026-05-31', score: 0.7,
    metadata: { productDescription: 'Red Hat Enterprise Linux Server, Premium', quantity: 8, status: 'Active', endDate: '2027-05-08', urgency: 'active' },
  },
  {
    source: 'subscriptions', type: 'subscription', headline: 'Ansible Automation Platform - 2 subscriptions',
    detail: '', timestamp: '2026-05-31', score: 0.9, url: 'https://access.redhat.com/management/subscriptions/ansible-1',
    metadata: { productDescription: 'Red Hat Ansible Automation Platform, Premium', quantity: 2, status: 'Expired', endDate: '2026-05-10', urgency: 'expired-critical' },
  },
  {
    source: 'subscriptions', type: 'subscription', headline: 'OpenShift Container Platform - 2 subscriptions',
    detail: '', timestamp: '2026-05-31', score: 0.9, url: 'https://access.redhat.com/management/subscriptions/ocp-1',
    metadata: { productDescription: 'Red Hat OpenShift Container Platform Standard', quantity: 2, status: 'Expired', endDate: '2026-05-10', urgency: 'expired' },
  },
  // Cases
  {
    source: 'cases', type: 'case', headline: 'Case 04459393: Add New Users to Red Hat Support Portal',
    detail: '', timestamp: '2026-05-31', score: 0.5, url: 'https://access.redhat.com/support/cases/#/case/04459393',
    metadata: { caseNumber: '04459393', severity: '4', status: 'Waiting on Customer', product: 'Red Hat Ansible Automation Platform' },
  },
  {
    source: 'cases', type: 'case', headline: 'Case 04127120: Ansible playbook to reboot fails',
    detail: '', timestamp: '2026-05-31', score: 0.6, url: 'https://access.redhat.com/support/cases/#/case/04127120',
    metadata: { caseNumber: '04127120', severity: '3', status: 'Closed', product: 'Red Hat Ansible Automation Platform' },
  },
  // CCSP cloud spend
  {
    source: 'ccsp', type: 'cloud-spend', headline: 'AWS cloud spend: $643,000 ACV',
    detail: '', timestamp: '2026-05-31', score: 0.8, url: 'https://ccsp.redhat.com/reports/aws',
    metadata: { cloudPartner: 'AWS', acvPlus: 643000 },
  },
  {
    source: 'ccsp', type: 'cloud-spend', headline: 'Google cloud spend: $323,000 ACV',
    detail: '', timestamp: '2026-05-31', score: 0.7,
    metadata: { cloudPartner: 'Google', acvPlus: 323000 },
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
  // Solution intelligence — derived play edges
  {
    source: 'solution-intelligence', type: 'recommendation', headline: 'AI/ML Platform with OpenShift AI',
    detail: '', timestamp: '2026-05-31', score: 0.8, url: 'https://example.com',
    metadata: { matchedTechnologies: ['Charlotte AI'], solutionName: 'AI/ML Platform', productAlignment: 'OpenShift AI' },
  },
  {
    source: 'solution-intelligence', type: 'recommendation', headline: 'Automation at Scale with Ansible',
    detail: '', timestamp: '2026-05-31', score: 0.85, url: 'https://example.com/ansible',
    metadata: { matchedTechnologies: [], solutionName: 'Automation at Scale', productAlignment: 'Ansible' },
  },
  // Cloud marketplace
  {
    source: 'cloud-marketplace', type: 'cloud-spend', headline: 'AWS Marketplace: 0 offerings, 1 programs',
    detail: '', timestamp: '2026-05-31', score: 0.6,
    metadata: { provider: 'AWS', programCount: 1 },
  },
]

// SalesHub play signals (portfolio-wide, not in customer signals but used for matching)
const SALESHUB_PLAY_SIGNALS: Signal[] = [
  {
    source: 'saleshub-plays', type: 'recommendation', headline: 'The AI-Ready Enterprise',
    detail: 'Accelerate AI adoption across the enterprise', rawRelevance: 0.4, timestamp: '2026-05-31',
    metadata: {
      tdpAlignment: ['Automation', 'Container Management', 'Server and Cloud Computing', 'AI'],
      playType: 'strategic',
      personaRoles: ['CTO', 'VP Engineering', 'VP Infrastructure'],
      documents: [{ name: 'AI-Ready Deck.pptx', driveUrl: 'https://drive.example.com/ai-deck' }],
    },
  },
  {
    source: 'saleshub-plays', type: 'recommendation', headline: 'Build and Run Applications',
    detail: 'Modernize app development and delivery', rawRelevance: 0.4, timestamp: '2026-05-31',
    metadata: {
      tdpAlignment: ['Container Management', 'Server and Cloud Computing', 'Application Development', 'Automation'],
      playType: 'strategic',
      personaRoles: ['VP Engineering', 'Director DevOps'],
      documents: [],
    },
  },
  {
    source: 'saleshub-plays', type: 'recommendation', headline: 'Secure and Compliant Infrastructure',
    detail: 'Security-focused infrastructure modernization', rawRelevance: 0.4, timestamp: '2026-05-31',
    metadata: {
      tdpAlignment: ['Server and Cloud Computing', 'Security'],
      playType: 'strategic',
      personaRoles: ['CISO', 'VP Security'],
      documents: [],
    },
  },
]

// SalesHub tactic signals — includes many tactics per TDP to test filtering
const SALESHUB_TACTIC_SIGNALS: Signal[] = [
  // Automation TDP — 5 tactics (only 2-3 should be relevant to expired Ansible)
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Automate at Scale',
    detail: 'TDP: Automation', rawRelevance: 0.3, timestamp: '2026-05-31',
    metadata: { parentTdp: 'Automation', playType: 'tactic', assets: [{ name: 'Ansible ROI Calculator', url: 'https://example.com/roi', type: 'share' }] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Optimize and Modernize IT Ops',
    detail: 'TDP: Automation', rawRelevance: 0.3, timestamp: '2026-05-31',
    metadata: { parentTdp: 'Automation', playType: 'tactic', assets: [] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Network Automation',
    detail: 'TDP: Automation', rawRelevance: 0.3, timestamp: '2026-05-31',
    metadata: { parentTdp: 'Automation', playType: 'tactic', assets: [] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Security Automation',
    detail: 'TDP: Automation', rawRelevance: 0.3, timestamp: '2026-05-31',
    metadata: { parentTdp: 'Automation', playType: 'tactic', assets: [] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Edge Automation',
    detail: 'TDP: Automation', rawRelevance: 0.3, timestamp: '2026-05-31',
    metadata: { parentTdp: 'Automation', playType: 'tactic', assets: [] },
  },
  // Container Management TDP — 5 tactics (only 2-3 should be relevant to expired OpenShift)
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'K8s for AI Workloads',
    detail: 'TDP: Container Management', rawRelevance: 0.3, timestamp: '2026-05-31',
    metadata: { parentTdp: 'Container Management', playType: 'tactic', assets: [{ name: 'OpenShift AI Demo', url: 'https://example.com/ocp-ai', type: 'share' }] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'K8s for 3rd Party Workloads',
    detail: 'TDP: Container Management', rawRelevance: 0.3, timestamp: '2026-05-31',
    metadata: { parentTdp: 'Container Management', playType: 'tactic', assets: [] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'VM Migration',
    detail: 'TDP: Container Management', rawRelevance: 0.3, timestamp: '2026-05-31',
    metadata: { parentTdp: 'Container Management', playType: 'tactic', assets: [] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Sovereign Infrastructure',
    detail: 'TDP: Container Management', rawRelevance: 0.3, timestamp: '2026-05-31',
    metadata: { parentTdp: 'Container Management', playType: 'tactic', assets: [] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Container Mgmt Base',
    detail: 'TDP: Container Management', rawRelevance: 0.3, timestamp: '2026-05-31',
    metadata: { parentTdp: 'Container Management', playType: 'tactic', assets: [] },
  },
  // Server and Cloud Computing TDP — 3 tactics
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Migrate to Cloud',
    detail: 'TDP: Server and Cloud Computing', rawRelevance: 0.3, timestamp: '2026-05-31',
    metadata: { parentTdp: 'Server and Cloud Computing', playType: 'tactic', assets: [{ name: 'Cloud Migration Guide', url: 'https://example.com/cloud', type: 'share' }] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Standardize OS',
    detail: 'TDP: Server and Cloud Computing', rawRelevance: 0.3, timestamp: '2026-05-31',
    metadata: { parentTdp: 'Server and Cloud Computing', playType: 'tactic', assets: [] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Edge Computing',
    detail: 'TDP: Server and Cloud Computing', rawRelevance: 0.3, timestamp: '2026-05-31',
    metadata: { parentTdp: 'Server and Cloud Computing', playType: 'tactic', assets: [] },
  },
  // AI TDP — 3 tactics
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Production AI',
    detail: 'TDP: AI', rawRelevance: 0.3, timestamp: '2026-05-31',
    metadata: { parentTdp: 'AI', playType: 'tactic', assets: [{ name: 'RHOAI Overview', url: 'https://example.com/ai', type: 'share' }] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Inference at Scale',
    detail: 'TDP: AI', rawRelevance: 0.3, timestamp: '2026-05-31',
    metadata: { parentTdp: 'AI', playType: 'tactic', assets: [] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'AI Model Serving',
    detail: 'TDP: AI', rawRelevance: 0.3, timestamp: '2026-05-31',
    metadata: { parentTdp: 'AI', playType: 'tactic', assets: [] },
  },
]

// ── Helper: build CrowdStrike graph with all signals ─────────────────────────

function buildCrowdStrikeGraph(): CustomerGraph {
  const allSignals = [...CROWDSTRIKE_SIGNALS, ...SALESHUB_PLAY_SIGNALS, ...SALESHUB_TACTIC_SIGNALS]
  return buildCustomerGraph('crowdstrike', 'CrowdStrike', allSignals)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Motion Builder — buildMotion', () => {
  it('returns null for graph with fewer than 2 play nodes', async () => {
    // Single play signal → only 1 play node in graph
    const minimalSignals: Signal[] = [
      {
        source: 'solution-intelligence', type: 'recommendation', headline: 'Single play',
        detail: '', timestamp: '2026-05-31', score: 0.7,
        metadata: { solutionName: 'Single Play', matchedTechnologies: [] },
      },
    ]
    const graph = buildCustomerGraph('tiny', 'Tiny Corp', minimalSignals)
    const motion = await buildMotion(graph, 'tiny', 'Tiny Corp', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)
    expect(motion).toBeNull()
  })

  it('produces motion with correct title from matched sales play', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    expect(motion!.title).toContain('CrowdStrike')
    // Should contain a sales play name
    expect(motion!.salesPlay).toBeDefined()
    expect(typeof motion!.salesPlay).toBe('string')
  })

  it('anchor phase contains tactics for expired subscriptions', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    const anchorPhase = motion!.phases.find(p => p.category === 'anchor')
    expect(anchorPhase).toBeDefined()
    // Anchor should have tactics related to expired Ansible/OpenShift
    expect(anchorPhase!.urgency).toBe('critical')
    expect(anchorPhase!.tactics.length).toBeGreaterThan(0)
  })

  it('phases are ordered by urgency (anchor first)', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    expect(motion!.phases.length).toBeGreaterThanOrEqual(2)
    // First phase should be anchor when expired subs exist
    expect(motion!.phases[0].category).toBe('anchor')
  })

  it('each phase has evidence array with module and fact', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    for (const phase of motion!.phases) {
      expect(Array.isArray(phase.evidence)).toBe(true)
      expect(phase.evidence.length).toBeGreaterThan(0)
      for (const ev of phase.evidence) {
        expect(typeof ev.module).toBe('string')
        expect(typeof ev.fact).toBe('string')
        expect(ev.module.length).toBeGreaterThan(0)
        expect(ev.fact.length).toBeGreaterThan(0)
      }
    }
  })

  it('each tactic has parentTdp and assets', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    for (const phase of motion!.phases) {
      for (const tactic of phase.tactics) {
        expect(typeof tactic.parentTdp).toBe('string')
        expect(tactic.parentTdp.length).toBeGreaterThan(0)
        expect(Array.isArray(tactic.assets)).toBe(true)
      }
    }
  })

  it('motion matches best-fit sales play by TDP alignment coverage', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    // CrowdStrike has signals in Automation + Container Mgmt + Server/Cloud + AI
    // "The AI-Ready Enterprise" aligns with 4 TDPs (Automation, Container Management, Server and Cloud Computing, AI)
    // "Build and Run Applications" also aligns with 4 TDPs
    // Either is valid — both have max coverage
    expect(['The AI-Ready Enterprise', 'Build and Run Applications']).toContain(motion!.salesPlay)
  })

  it('confidence reflects signal convergence count', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    // CrowdStrike has many signals (subs, cases, ccsp, tech, plays) → high confidence
    expect(motion!.confidence).toBe('high')
  })

  it('motion has status: active by default', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    expect(motion!.status).toBe('active')
  })

  it('motion id follows format motion:{customerSlug}', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    expect(motion!.id).toBe('motion:crowdstrike')
    expect(motion!.customerSlug).toBe('crowdstrike')
    expect(motion!.customerName).toBe('CrowdStrike')
  })

  // ── #529: Tactic filtering — limit to top 3 per TDP domain ─────────────
  it('anchor phase limits tactics to at most 3 per TDP domain', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    const anchorPhase = motion!.phases.find(p => p.category === 'anchor')
    expect(anchorPhase).toBeDefined()

    // Group tactics by parentTdp and verify max 3 per TDP
    const tacticsByTdp = new Map<string, string[]>()
    for (const t of anchorPhase!.tactics) {
      const list = tacticsByTdp.get(t.parentTdp) ?? []
      list.push(t.name)
      tacticsByTdp.set(t.parentTdp, list)
    }
    for (const [tdp, names] of tacticsByTdp) {
      expect(names.length).toBeLessThanOrEqual(3)
    }

    // With 5 Automation + 5 Container Mgmt tactics available,
    // anchor should NOT have all 10 — should have at most 6 (3 per TDP)
    expect(anchorPhase!.tactics.length).toBeLessThanOrEqual(6)
  })

  it('expand phase limits tactics to at most 3 per TDP domain', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    const expandPhase = motion!.phases.find(p => p.category === 'expand')
    if (expandPhase) {
      const tacticsByTdp = new Map<string, string[]>()
      for (const t of expandPhase.tactics) {
        const list = tacticsByTdp.get(t.parentTdp) ?? []
        list.push(t.name)
        tacticsByTdp.set(t.parentTdp, list)
      }
      for (const [tdp, names] of tacticsByTdp) {
        expect(names.length).toBeLessThanOrEqual(3)
      }
    }
  })

  it('transform phase limits tactics to at most 3 per TDP domain', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    const transformPhase = motion!.phases.find(p => p.category === 'transform')
    if (transformPhase) {
      const tacticsByTdp = new Map<string, string[]>()
      for (const t of transformPhase.tactics) {
        const list = tacticsByTdp.get(t.parentTdp) ?? []
        list.push(t.name)
        tacticsByTdp.set(t.parentTdp, list)
      }
      for (const [tdp, names] of tacticsByTdp) {
        expect(names.length).toBeLessThanOrEqual(3)
      }
    }
  })

  // ── #530: Phase names use unique TDP domains, not tactic names ────────
  it('phase names use unique TDP domains, not tactic names', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    const anchorPhase = motion!.phases.find(p => p.category === 'anchor')
    expect(anchorPhase).toBeDefined()

    // Name should contain TDP domain names (e.g., "Automation", "Container Mgmt")
    // NOT individual tactic names repeated
    // E.g., "Anchor: Protect Automation + Container Mgmt Base" not
    // "Anchor: Protect Automation + Container Mgmt + Automation + Automation + Container Mgmt + Container Mgmt"
    const nameParts = anchorPhase!.name.replace(/^Anchor: Protect /, '').split(' + ')
    const uniqueParts = [...new Set(nameParts)]
    // Each TDP should appear exactly once
    expect(nameParts.length).toBe(uniqueParts.length)
    // And the count should match the number of unique TDP domains in the tactics
    const uniqueTdps = [...new Set(anchorPhase!.tactics.map(t => t.parentTdp))]
    expect(nameParts.length).toBe(uniqueTdps.length)
  })

  it('expand phase name uses unique TDP domains', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    const expandPhase = motion!.phases.find(p => p.category === 'expand')
    if (expandPhase) {
      // Expand name format: "Expand: TDP1 + TDP2"
      const nameParts = expandPhase.name.replace(/^Expand: /, '').split(' + ')
      const uniqueParts = [...new Set(nameParts)]
      expect(nameParts.length).toBe(uniqueParts.length)
    }
  })

  it('transform phase name uses unique TDP domains', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    const transformPhase = motion!.phases.find(p => p.category === 'transform')
    if (transformPhase) {
      const nameParts = transformPhase.name.replace(/^Transform: /, '').split(' + ')
      const uniqueParts = [...new Set(nameParts)]
      expect(nameParts.length).toBe(uniqueParts.length)
    }
  })

  // ── #534: Evidence items include URLs from node properties ───────────
  it('evidence items include URLs from node properties', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    const anchorPhase = motion!.phases.find(p => p.category === 'anchor')
    expect(anchorPhase).toBeDefined()

    // Subscription evidence should have URLs from signal.url preserved through node properties
    const subEvidence = anchorPhase!.evidence.filter(e => e.module === 'subscriptions')
    expect(subEvidence.length).toBeGreaterThan(0)
    const withUrl = subEvidence.filter(e => e.url !== undefined)
    expect(withUrl.length).toBeGreaterThan(0)
    expect(withUrl[0].url).toContain('access.redhat.com')

    // Case evidence should also have URLs
    const caseEvidence = anchorPhase!.evidence.filter(e => e.module === 'cases')
    if (caseEvidence.length > 0) {
      const caseWithUrl = caseEvidence.filter(e => e.url !== undefined)
      expect(caseWithUrl.length).toBeGreaterThan(0)
    }

    // Expand phase — cloud spend evidence should have URLs
    const expandPhase = motion!.phases.find(p => p.category === 'expand')
    if (expandPhase) {
      const ccspEvidence = expandPhase.evidence.filter(e => e.module === 'ccsp')
      const ccspWithUrl = ccspEvidence.filter(e => e.url !== undefined)
      expect(ccspWithUrl.length).toBeGreaterThan(0)
    }
  })

  // ── #536: Closed cases labeled as "Recent case" not "Active case" ───
  it('closed cases labeled as Recent case not Active case', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    // Find all case evidence across all phases
    const allCaseEvidence = motion!.phases.flatMap(p => p.evidence.filter(e => e.module === 'cases'))

    // Case 04459393 is "Waiting on Customer" (open) → should be "Open case"
    const openCase = allCaseEvidence.find(e => e.fact.includes('04459393'))
    if (openCase) {
      expect(openCase.fact).toMatch(/^Open case:/)
    }

    // Case 04127120 is "Closed" → should be "Recent case"
    const closedCase = allCaseEvidence.find(e => e.fact.includes('04127120'))
    if (closedCase) {
      expect(closedCase.fact).toMatch(/^Recent case:/)
    }

    // No evidence should say "Active case"
    for (const ev of allCaseEvidence) {
      expect(ev.fact).not.toMatch(/^Active case:/)
    }
  })

  // ── #532: Evidence limited to 7 items per phase ─────────────────────
  it('evidence limited to 7 items per phase', async () => {
    // Build a graph with many signals that would produce >7 evidence items
    const manySignals: Signal[] = [
      ...CROWDSTRIKE_SIGNALS,
      // Add extra case signals to inflate evidence count
      ...Array.from({ length: 10 }, (_, i) => ({
        source: 'cases' as const, type: 'case' as const,
        headline: `Case ${1000 + i}: Extra test case ${i}`,
        detail: '', timestamp: '2026-05-31', score: 0.5,
        url: `https://access.redhat.com/support/cases/#/case/${1000 + i}`,
        metadata: { caseNumber: String(1000 + i), severity: '4', status: i < 2 ? 'Open' : 'Closed', product: 'Red Hat Ansible Automation Platform' },
      })),
    ]
    const graph = buildCustomerGraph('crowdstrike', 'CrowdStrike', manySignals)
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    for (const phase of motion!.phases) {
      expect(phase.evidence.length).toBeLessThanOrEqual(7)
    }
  })

  // ── #535: Tactic assets exclude items with empty URLs ──────────────────
  it('tactic assets exclude items with empty URLs', async () => {
    // Add tactic signals that have assets with empty/whitespace URLs (section headers)
    const tacticsWithDeadAssets: Signal[] = [
      {
        source: 'saleshub-tactics', type: 'recommendation', headline: 'Automate Everything',
        detail: 'TDP: Automation', rawRelevance: 0.3, timestamp: '2026-05-31',
        metadata: {
          parentTdp: 'Automation', playType: 'tactic',
          assets: [
            { name: 'Ansible ROI Calculator', url: 'https://example.com/roi', type: 'share' },
            { name: 'What to show - differentiate with product demos', url: '', type: 'share' },
            { name: 'Customer pitch', url: '  ', type: 'share' },
            { name: 'Valid Asset', url: 'https://example.com/valid', type: 'share' },
          ],
        },
      },
    ]

    // Replace the Automation tactics with our test ones that have dead assets
    const customTactics = [
      ...SALESHUB_TACTIC_SIGNALS.filter(s => String(s.metadata?.parentTdp ?? '') !== 'Automation'),
      ...tacticsWithDeadAssets,
    ]

    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, customTactics)

    expect(motion).not.toBeNull()
    // Find the anchor phase — it covers expired Ansible (Automation TDP)
    const anchorPhase = motion!.phases.find(p => p.category === 'anchor')
    expect(anchorPhase).toBeDefined()

    // All assets across all tactics should have non-empty URLs
    for (const tactic of anchorPhase!.tactics) {
      for (const asset of tactic.assets) {
        expect(asset.url.trim().length).toBeGreaterThan(0)
      }
    }

    // The tactic with dead assets should only have the 2 valid ones
    const automationTactic = anchorPhase!.tactics.find(t => t.name === 'Automate Everything')
    if (automationTactic) {
      expect(automationTactic.assets.length).toBe(2)
      expect(automationTactic.assets.map(a => a.name)).toEqual([
        'Ansible ROI Calculator',
        'Valid Asset',
      ])
    }
  })

  // ── #540: Different phases have different target personas based on TDP domains ─
  it('different phases have different target personas based on TDP domains', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    // Must have at least 2 phases to compare
    expect(motion!.phases.length).toBeGreaterThanOrEqual(2)

    // Each phase should have targetPersonas populated
    for (const phase of motion!.phases) {
      expect(phase.targetPersonas.length).toBeGreaterThan(0)
    }

    // Phases covering different TDP domains should NOT all have identical personas
    const anchorPhase = motion!.phases.find(p => p.category === 'anchor')
    const transformPhase = motion!.phases.find(p => p.category === 'transform')
    if (anchorPhase && transformPhase) {
      // Anchor covers Automation + Container Mgmt; Transform covers AI
      // These should have different persona sets (not identical)
      const anchorSet = new Set(anchorPhase.targetPersonas)
      const transformSet = new Set(transformPhase.targetPersonas)
      const identical = anchorSet.size === transformSet.size &&
        [...anchorSet].every(p => transformSet.has(p))
      expect(identical).toBe(false)
    }
  })

  it('phases with Automation TDP target IT ops personas, not data science', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    const anchorPhase = motion!.phases.find(p => p.category === 'anchor')
    expect(anchorPhase).toBeDefined()

    // Anchor phase covers Automation TDP (expired Ansible) — should target IT ops personas
    const anchorTdps = [...new Set(anchorPhase!.tactics.map(t => t.parentTdp))]
    if (anchorTdps.includes('Automation')) {
      // Should include IT ops-related personas
      const hasOpsPersona = anchorPhase!.targetPersonas.some(p =>
        p.toLowerCase().includes('ops') ||
        p.toLowerCase().includes('platform') ||
        p.toLowerCase().includes('infrastructure')
      )
      expect(hasOpsPersona).toBe(true)

      // Should NOT include data science personas (those belong to AI phase)
      const hasDataScience = anchorPhase!.targetPersonas.some(p =>
        p.toLowerCase().includes('data science')
      )
      expect(hasDataScience).toBe(false)
    }
  })

  it('expand phase contains cloud-related tactics when cloud spend exists', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    const expandPhase = motion!.phases.find(p => p.category === 'expand')
    expect(expandPhase).toBeDefined()
    // Should have cloud-related tactic
    const cloudTactics = expandPhase!.tactics.filter(t =>
      t.parentTdp.toLowerCase().includes('server') || t.parentTdp.toLowerCase().includes('cloud')
    )
    expect(cloudTactics.length).toBeGreaterThan(0)
  })

  // ── #543: Tactic scoring uses customer signal context ─────────────────
  it('tactic scoring uses customer signal context, not just product name keywords', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    const anchorPhase = motion!.phases.find(p => p.category === 'anchor')
    expect(anchorPhase).toBeDefined()

    // CrowdStrike has expired Ansible subs AND Ansible cases → anchor should
    // prefer tactics mentioning "automate", "ops", "ansible", "playbook" over
    // generic tactics like "Network Automation" or "Edge Automation"
    const anchorAutomationTactics = anchorPhase!.tactics.filter(
      t => t.parentTdp === 'Automation'
    )
    const tacticNames = anchorAutomationTactics.map(t => t.name)

    // "Automate at Scale" should rank higher than "Network Automation" or "Edge Automation"
    // because customer has ansible cases (product: "Red Hat Ansible Automation Platform")
    // which adds keywords like "ansible", "playbook", "ops"
    expect(tacticNames).toContain('Automate at Scale')
  })

  it('irrelevant tactics score lower than relevant ones', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    const anchorPhase = motion!.phases.find(p => p.category === 'anchor')
    expect(anchorPhase).toBeDefined()

    // With 5 Automation tactics and max 3 per TDP, "Edge Automation" and
    // "Security Automation" should be filtered out in favor of more relevant ones
    // because CrowdStrike has no network or edge signals
    const anchorAutomationTactics = anchorPhase!.tactics.filter(
      t => t.parentTdp === 'Automation'
    )
    const tacticNames = anchorAutomationTactics.map(t => t.name)

    // "Edge Automation" has no signal support — no edge-related signals exist
    // It should NOT be in the top 3 for a customer with Ansible + ops signals
    expect(tacticNames).not.toContain('Edge Automation')
  })

  it('anchor phase context keywords include case product terms', async () => {
    // Customer with expired Ansible AND cases mentioning "playbook" — the
    // anchor phase should derive keywords from case product names, not just
    // hardcoded product-to-keyword mappings.
    // Add a tactic that specifically matches "playbook" — it should rank high
    // because the customer has a case: "Ansible playbook to reboot fails"
    const extraTactics: Signal[] = [
      ...SALESHUB_TACTIC_SIGNALS,
      {
        source: 'saleshub-tactics', type: 'recommendation', headline: 'Playbook Best Practices',
        detail: 'TDP: Automation', rawRelevance: 0.3, timestamp: '2026-05-31',
        metadata: { parentTdp: 'Automation', playType: 'tactic', assets: [] },
      },
      {
        source: 'saleshub-tactics', type: 'recommendation', headline: 'Manage Firewalls',
        detail: 'TDP: Automation', rawRelevance: 0.3, timestamp: '2026-05-31',
        metadata: { parentTdp: 'Automation', playType: 'tactic', assets: [] },
      },
    ]

    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, extraTactics)

    expect(motion).not.toBeNull()
    const anchorPhase = motion!.phases.find(p => p.category === 'anchor')
    expect(anchorPhase).toBeDefined()

    const anchorAutomationTactics = anchorPhase!.tactics.filter(
      t => t.parentTdp === 'Automation'
    )
    const tacticNames = anchorAutomationTactics.map(t => t.name)

    // "Playbook Best Practices" should be selected because the customer has
    // case 04127120: "Ansible playbook to reboot fails" — "playbook" keyword
    // comes from case context, not just product name
    expect(tacticNames).toContain('Playbook Best Practices')

    // "Manage Firewalls" has zero signal support — should be filtered out
    expect(tacticNames).not.toContain('Manage Firewalls')
  })

  it('expand phase context keywords include cloud partner names from graph', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    const expandPhase = motion!.phases.find(p => p.category === 'expand')
    if (expandPhase) {
      // CrowdStrike has AWS ($643K) and Google ($323K) cloud spend
      // "Migrate to Cloud" tactic should score well because it contains "cloud"
      // and aligns with the customer's cloud spend signals
      const tacticNames = expandPhase.tactics.map(t => t.name)
      expect(tacticNames).toContain('Migrate to Cloud')
    }
  })

  it('transform phase context keywords include tech stack AI terms from graph', async () => {
    const graph = buildCrowdStrikeGraph()
    const motion = await buildMotion(graph, 'crowdstrike', 'CrowdStrike', SALESHUB_PLAY_SIGNALS, SALESHUB_TACTIC_SIGNALS)

    expect(motion).not.toBeNull()
    const transformPhase = motion!.phases.find(p => p.category === 'transform')
    if (transformPhase) {
      // CrowdStrike uses "Charlotte AI" — transform phase should pick up AI-related
      // keywords from graph nodes, boosting tactics like "Production AI"
      const tacticNames = transformPhase.tactics.map(t => t.name)
      expect(tacticNames).toContain('Production AI')
    }
  })
})
