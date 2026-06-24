/**
 * test/integration/intelligence-engine.test.ts
 * Integration test harness for the intelligence engine pipeline.
 *
 * GitHub Issue #891 — 4 synthetic customer fixtures testing end-to-end:
 *   buildCustomerGraph → cross-reference pass → buildMotion → flowLedger
 *
 * KEY REGRESSION: When the cross-reference pass lands (#884/#887), verifies
 * ALL portfolio-scope competitive-intel nodes have crossReferenced set
 * (true or false, never undefined). This catches the PR2 regression where
 * the cross-reference pass was accidentally replaced.
 */

import { describe, it, expect, beforeAll } from 'bun:test'
import type { Signal } from '../../src/feature-module-registry.ts'
import type { CustomerGraph, IntelligenceNode } from '../../src/lib/intelligence-graph-types.ts'

// Lazy imports to avoid ESM TDZ issues
let buildCustomerGraph: typeof import('../../src/lib/intelligence-graph.ts').buildCustomerGraph
let buildMotion: typeof import('../../src/lib/motion-builder.ts').buildMotion
let findNodesByType: typeof import('../../src/lib/graph-utils.ts').findNodesByType

beforeAll(async () => {
  const graphModule = await import('../../src/lib/intelligence-graph.ts')
  buildCustomerGraph = graphModule.buildCustomerGraph

  const motionModule = await import('../../src/lib/motion-builder.ts')
  buildMotion = motionModule.buildMotion

  const utilsModule = await import('../../src/lib/graph-utils.ts')
  findNodesByType = utilsModule.findNodesByType
})

// ── SalesHub Portfolio Signals (shared across all fixtures) ─────────────────

const PLAY_SIGNALS: Signal[] = [
  {
    source: 'saleshub-plays', type: 'recommendation', headline: 'The AI-Ready Enterprise',
    detail: 'Accelerate AI adoption', rawRelevance: 0.4, timestamp: '2026-06-01',
    metadata: {
      tdpAlignment: ['Automation', 'Container Management', 'Server and Cloud Computing', 'AI'],
      playType: 'strategic',
      personaRoles: ['CTO', 'VP Engineering'],
      documents: [],
    },
  },
  {
    source: 'saleshub-plays', type: 'recommendation', headline: 'Build and Run Applications',
    detail: 'Modernize app development', rawRelevance: 0.4, timestamp: '2026-06-01',
    metadata: {
      tdpAlignment: ['Container Management', 'Server and Cloud Computing', 'Application Development', 'Automation'],
      playType: 'strategic',
      personaRoles: ['VP Engineering', 'Director DevOps'],
      documents: [],
    },
  },
]

const TACTIC_SIGNALS: Signal[] = [
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Automate at Scale',
    detail: 'TDP: Automation', rawRelevance: 0.3, timestamp: '2026-06-01',
    metadata: { parentTdp: 'Automation', playType: 'tactic', assets: [] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Optimize and Modernize IT Ops',
    detail: 'TDP: Automation', rawRelevance: 0.3, timestamp: '2026-06-01',
    metadata: { parentTdp: 'Automation', playType: 'tactic', assets: [] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'K8s for AI Workloads',
    detail: 'TDP: Container Management', rawRelevance: 0.3, timestamp: '2026-06-01',
    metadata: { parentTdp: 'Container Management', playType: 'tactic', assets: [] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Migrate to Cloud',
    detail: 'TDP: Server and Cloud Computing', rawRelevance: 0.3, timestamp: '2026-06-01',
    metadata: { parentTdp: 'Server and Cloud Computing', playType: 'tactic', assets: [] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Standardize OS',
    detail: 'TDP: Server and Cloud Computing', rawRelevance: 0.3, timestamp: '2026-06-01',
    metadata: { parentTdp: 'Server and Cloud Computing', playType: 'tactic', assets: [] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Production AI',
    detail: 'TDP: AI', rawRelevance: 0.3, timestamp: '2026-06-01',
    metadata: { parentTdp: 'AI', playType: 'tactic', assets: [] },
  },
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'VM Migration',
    detail: 'TDP: Container Management', rawRelevance: 0.3, timestamp: '2026-06-01',
    metadata: { parentTdp: 'Container Management', playType: 'tactic', assets: [] },
  },
  // Virtualization tactics for displacement phase
  {
    source: 'saleshub-tactics', type: 'recommendation', headline: 'Virtualization Modernization',
    detail: 'TDP: Virtualization', rawRelevance: 0.3, timestamp: '2026-06-01',
    metadata: { parentTdp: 'Virtualization', playType: 'tactic', assets: [] },
  },
]

// ── Fixture Builders ────────────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> & { source: string; type: string; headline: string }): Signal {
  return {
    detail: '',
    timestamp: '2026-06-01',
    score: 0.5,
    ...overrides,
    metadata: overrides.metadata ?? {},
  }
}

function buildSubscription(desc: string, status: string, endDate: string): Signal {
  return makeSignal({
    source: 'subscriptions', type: 'subscription',
    headline: `${desc} subscription`,
    score: status === 'Expired' ? 0.9 : 0.7,
    metadata: { productDescription: desc, quantity: 5, status, endDate, urgency: status === 'Expired' ? 'expired' : 'active' },
  })
}

function buildCase(num: string, product: string, severity: string, status: string): Signal {
  return makeSignal({
    source: 'cases', type: 'case',
    headline: `Case ${num}: Test case for ${product}`,
    url: `https://access.redhat.com/support/cases/#/case/${num}`,
    metadata: { caseNumber: num, product, severity, status },
  })
}

function buildPipeline(name: string, stage: string, amount: number, closeDate: string): Signal {
  return makeSignal({
    source: 'pipeline', type: 'deal',
    headline: `${name} - ${stage}`,
    score: 0.8,
    metadata: { opportunityName: name, stage, amount, closeDate },
  })
}

function buildTech(name: string, category: string = 'proprietary', context: string = 'using'): Signal {
  return makeSignal({
    source: 'tech-stack', type: 'technology',
    headline: `${name} (${category}, ${context})`,
    score: 0.4,
    metadata: { techName: name, category, context },
  })
}

function buildCompetitiveIntel(competitor: string, product: string, threatLevel: string): Signal {
  return makeSignal({
    source: 'competitive-intel', type: 'intel',
    headline: `${competitor} competitive pressure on ${product}`,
    score: 0.7,
    metadata: { competitor, product, threatLevel },
  })
}

function buildEmail(subject: string, techMentions: string[]): Signal {
  return makeSignal({
    source: 'emails', type: 'engagement',
    headline: subject,
    metadata: { threadId: subject.slice(0, 20), from: 'contact@example.com', techMentions, classification: 'technical' },
  })
}

function buildPartner(name: string, tier: string): Signal {
  return makeSignal({
    source: 'partner-catalog', type: 'partner',
    headline: `Partner: ${name}`,
    metadata: { partnerName: name, tier, specializations: ['Cloud'] },
  })
}

function buildLifecycle(product: string, eolDate: string): Signal {
  return makeSignal({
    source: 'product-lifecycle', type: 'lifecycle',
    headline: `${product} lifecycle update`,
    metadata: { product, eolDate, currentVersion: '8.9', nextVersion: '9.0' },
  })
}

function buildCloudSpend(partner: string, acv: number): Signal {
  return makeSignal({
    source: 'ccsp', type: 'cloud-spend',
    headline: `${partner} cloud spend: $${acv.toLocaleString()} ACV`,
    score: 0.8,
    metadata: { cloudPartner: partner, acvPlus: acv },
  })
}

function buildNewsRadar(title: string): Signal {
  return makeSignal({
    source: 'news-radar', type: 'intel',
    headline: title,
    metadata: { title, source: 'reuters', publishedAt: '2026-05-28' },
  })
}

// ── Helper: detect cross-reference pass ─────────────────────────────────────

function hasCrossReferencePass(graph: CustomerGraph): boolean {
  return Object.values(graph.nodes).some(n => (n as any).crossReferenced !== undefined)
}

// ── Fixture 1: Rich Customer (8+ source types) ─────────────────────────────

function buildRichCustomerSignals(): Signal[] {
  return [
    // Subscriptions (3)
    buildSubscription('Red Hat Enterprise Linux Server, Premium', 'Active', '2027-08-15'),
    buildSubscription('Red Hat Ansible Automation Platform, Premium', 'Expired', '2026-05-10'),
    buildSubscription('Red Hat OpenShift Container Platform Standard', 'Expired', '2026-04-01'),
    // Cases (5)
    buildCase('05001001', 'Red Hat Ansible Automation Platform', '2', 'Waiting on Customer'),
    buildCase('05001002', 'Red Hat Ansible Automation Platform', '3', 'Closed'),
    buildCase('05001003', 'Red Hat Enterprise Linux', '4', 'Open'),
    buildCase('05001004', 'Red Hat OpenShift Container Platform', '3', 'Closed'),
    buildCase('05001005', 'Red Hat Enterprise Linux', '1', 'Open'),
    // Pipeline (3)
    buildPipeline('AAP Renewal - Acme Corp', 'Negotiate', 150000, '2026-08-01'),
    buildPipeline('OCP Expansion - Acme Corp', 'Propose', 250000, '2026-09-15'),
    buildPipeline('RHEL Server Growth', 'Identify', 80000, '2026-12-01'),
    // Tech stack (10) — evaluating context passes displacement filter
    buildTech('VMware vSphere 8.0', 'competitor', 'evaluating'),
    buildTech('Docker Enterprise 20.10', 'competitor', 'evaluating'),
    buildTech('Terraform v1.8.0', 'competitor', 'evaluating'),
    buildTech('Kubernetes', 'open-source', 'using'),
    buildTech('Jenkins', 'open-source', 'using'),
    buildTech('Splunk Enterprise 9.1', 'competitor', 'evaluating'),
    buildTech('Charlotte AI', 'proprietary', 'using'),
    buildTech('PostgreSQL', 'open-source', 'using'),
    buildTech('Apache Kafka', 'open-source', 'using'),
    buildTech('Grafana', 'open-source', 'using'),
    // Competitive intel (4)
    buildCompetitiveIntel('VMware', 'OpenShift Virtualization', 'high'),
    buildCompetitiveIntel('Puppet', 'Ansible Automation Platform', 'medium'),
    buildCompetitiveIntel('Docker', 'OpenShift Container Platform', 'medium'),
    buildCompetitiveIntel('Splunk', 'OpenShift Observability', 'low'),
    // Emails (3)
    buildEmail('Re: Ansible upgrade path discussion', ['Ansible']),
    buildEmail('OpenShift migration timeline', ['OpenShift', 'Kubernetes']),
    buildEmail('Infrastructure modernization Q3', ['VMware']),
    // Partner catalog (3)
    buildPartner('AWS Advanced Consulting', 'Premier'),
    buildPartner('Accenture Red Hat Practice', 'Premier'),
    buildPartner('HashiCorp Integration', 'Select'),
    // Product lifecycle (2)
    buildLifecycle('Red Hat Enterprise Linux 8', '2029-05-31'),
    buildLifecycle('Red Hat Ansible Automation Platform 2.3', '2026-11-30'),
    // Cloud spend (2)
    buildCloudSpend('AWS', 540000),
    buildCloudSpend('Azure', 180000),
    // News radar (3)
    buildNewsRadar('Acme Corp announces cloud-first strategy'),
    buildNewsRadar('Acme Corp CTO speaks at KubeCon 2026'),
    buildNewsRadar('Acme Corp acquires AI startup NeuralOps'),
    // Solution intelligence (2)
    makeSignal({
      source: 'solution-intelligence', type: 'recommendation',
      headline: 'AI/ML Platform with OpenShift AI', score: 0.8,
      metadata: { matchedTechnologies: ['Charlotte AI'], solutionName: 'AI/ML Platform', productAlignment: 'OpenShift AI' },
    }),
    makeSignal({
      source: 'solution-intelligence', type: 'recommendation',
      headline: 'Automation at Scale with Ansible', score: 0.85,
      metadata: { matchedTechnologies: [], solutionName: 'Automation at Scale', productAlignment: 'Ansible' },
    }),
  ]
}

// ── Fixture 2: Moderate Customer (5-7 source types) ─────────────────────────

function buildModerateCustomerSignals(): Signal[] {
  return [
    buildSubscription('Red Hat Enterprise Linux Server, Standard', 'Active', '2027-06-01'),
    buildSubscription('Red Hat OpenShift Container Platform', 'Expired', '2026-03-15'),
    buildCase('06002001', 'Red Hat Enterprise Linux', '3', 'Open'),
    buildCase('06002002', 'Red Hat OpenShift Container Platform', '4', 'Closed'),
    buildTech('Docker Desktop', 'competitor', 'evaluating'),
    buildTech('Kubernetes', 'open-source', 'using'),
    buildTech('Terraform v1.5', 'competitor', 'evaluating'),
    buildTech('GitHub Actions', 'proprietary', 'using'),
    buildTech('Prometheus', 'open-source', 'using'),
    buildPipeline('OCP Renewal - Moderate Inc', 'Propose', 120000, '2026-09-01'),
    buildNewsRadar('Moderate Inc expands cloud operations'),
    buildNewsRadar('Moderate Inc hires VP of Platform Engineering'),
    buildNewsRadar('Moderate Inc partners with AWS for infrastructure'),
    buildCloudSpend('AWS', 320000),
    makeSignal({
      source: 'solution-intelligence', type: 'recommendation',
      headline: 'Container Platform Modernization', score: 0.75,
      metadata: { matchedTechnologies: ['Kubernetes'], solutionName: 'Container Modernization', productAlignment: 'OpenShift' },
    }),
  ]
}

// ── Fixture 3: Thin Customer (3-4 source types) ─────────────────────────────
// Uses 'evaluating' context on competitor tech to pass displacement filter

function buildThinCustomerSignals(): Signal[] {
  return [
    buildSubscription('Red Hat Enterprise Linux Server', 'Active', '2027-12-01'),
    // evaluating context — passes displacement filter (proprietary+using gets skipped)
    buildTech('VMware vSphere 7.0', 'competitor', 'evaluating'),
    buildTech('Puppet Enterprise', 'competitor', 'evaluating'),
    buildTech('Nagios', 'open-source', 'using'),
    buildCompetitiveIntel('VMware', 'OpenShift Virtualization', 'high'),
    buildCompetitiveIntel('Puppet', 'Ansible Automation Platform', 'medium'),
    makeSignal({
      source: 'solution-intelligence', type: 'recommendation',
      headline: 'Infrastructure Modernization', score: 0.6,
      metadata: { matchedTechnologies: [], solutionName: 'Infra Modernization', productAlignment: 'RHEL' },
    }),
  ]
}

// ── Fixture 4: Minimal Customer (1-2 source types) ──────────────────────────

function buildMinimalCustomerSignals(): Signal[] {
  return [
    buildSubscription('Red Hat Enterprise Linux Server', 'Active', '2028-01-01'),
  ]
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIXTURE 1: Rich Customer — 8+ source types
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration: Rich Customer (8+ sources)', () => {
  let graph: CustomerGraph

  beforeAll(() => {
    graph = buildCustomerGraph('acme-corp', 'Acme Corp', buildRichCustomerSignals())
  })

  it('graph has 8+ distinct node types', () => {
    const nodeTypes = new Set(Object.values(graph.nodes).map(n => n.type))
    expect(nodeTypes.size).toBeGreaterThanOrEqual(8)
  })

  it('graph has correct customer hub node', () => {
    const customer = Object.values(graph.nodes).find(n => n.type === 'customer')
    expect(customer).toBeDefined()
    expect(customer!.name).toBe('Acme Corp')
  })

  it('subscription nodes match fixture count (3)', () => {
    expect(findNodesByType(graph, 'subscription').length).toBe(3)
  })

  it('case nodes match fixture count (5)', () => {
    expect(findNodesByType(graph, 'case').length).toBe(5)
  })

  it('deal nodes match fixture count (3)', () => {
    expect(findNodesByType(graph, 'deal').length).toBe(3)
  })

  it('product nodes exist for tech stack', () => {
    expect(findNodesByType(graph, 'product').length).toBeGreaterThanOrEqual(8)
  })

  it('intel nodes from competitive-intel and news-radar', () => {
    const intelNodes = Object.values(graph.nodes).filter(n => n.type === 'intel')
    expect(intelNodes.length).toBeGreaterThanOrEqual(4)
  })

  it('engagement nodes from email signals', () => {
    const engagements = Object.values(graph.nodes).filter(n => n.type === 'engagement')
    expect(engagements.length).toBe(3)
  })

  it('partner nodes from partner-catalog', () => {
    expect(findNodesByType(graph, 'partner').length).toBe(3)
  })

  it('all factual edges originate from customer node', () => {
    const customerNode = Object.values(graph.nodes).find(n => n.type === 'customer')!
    const factualEdges = graph.edges.filter(e => e.tier === 'factual')
    for (const edge of factualEdges) {
      expect(edge.from).toBe(customerNode.id)
    }
  })

  // ── Cross-reference regression guard (#884/#887) ─────────────────────

  it('when cross-reference pass exists: ALL portfolio-scope nodes have crossReferenced set', () => {
    if (!hasCrossReferencePass(graph)) return
    const portfolioSources = new Set([
      'competitive-intel', 'news-radar', 'rh-rss', 'rh-events',
      'product-intel', 'ecosystem-catalog', 'partner-catalog', 'saleshub-products',
    ])
    const portfolioNodes = Object.values(graph.nodes).filter(n => portfolioSources.has(n.sourceModule))
    expect(portfolioNodes.length).toBeGreaterThan(0)
    for (const node of portfolioNodes) {
      expect((node as any).crossReferenced).toBeDefined()
      expect(typeof (node as any).crossReferenced).toBe('boolean')
    }
  })

  it('when cross-reference pass exists: VMware intel matches VMware tech', () => {
    if (!hasCrossReferencePass(graph)) return
    const vmwareIntel = Object.values(graph.nodes).find(n =>
      n.sourceModule === 'competitive-intel' &&
      String(n.properties?.competitor ?? '').toLowerCase().includes('vmware')
    )
    expect(vmwareIntel).toBeDefined()
    expect((vmwareIntel as any).crossReferenced).toBe(true)
  })

  it('when cross-reference pass exists: all 4 competitive-intel match customer tech', () => {
    if (!hasCrossReferencePass(graph)) return
    const compIntel = Object.values(graph.nodes).filter(n => n.sourceModule === 'competitive-intel')
    expect(compIntel.length).toBe(4)
    for (const node of compIntel) {
      expect((node as any).crossReferenced).toBe(true)
    }
  })

  // ── Motion tests ──────────────────────────────────────────────────────

  it('buildMotion returns non-null with 2+ phases', async () => {
    const motion = await buildMotion(graph, 'acme-corp', 'Acme Corp', PLAY_SIGNALS, TACTIC_SIGNALS)
    expect(motion).not.toBeNull()
    expect(motion!.phases.length).toBeGreaterThanOrEqual(2)
  })

  it('evidence arrays span 3+ distinct source modules', async () => {
    const motion = await buildMotion(graph, 'acme-corp', 'Acme Corp', PLAY_SIGNALS, TACTIC_SIGNALS)
    expect(motion).not.toBeNull()
    const allModules = new Set<string>()
    for (const phase of motion!.phases) {
      for (const ev of phase.evidence) { allModules.add(ev.module) }
    }
    expect(allModules.size).toBeGreaterThanOrEqual(3)
  })

  it('flowLedger: signalsIngested > 0 and finalEvidenceCount > 0', async () => {
    const motion = await buildMotion(graph, 'acme-corp', 'Acme Corp', PLAY_SIGNALS, TACTIC_SIGNALS)
    expect(motion).not.toBeNull()
    expect(motion!.flowLedger).toBeDefined()
    expect(motion!.flowLedger!.signalsIngested).toBeGreaterThan(0)
    expect(motion!.flowLedger!.finalEvidenceCount).toBeGreaterThan(0)
  })

  it('motion confidence is high for rich customer', async () => {
    const motion = await buildMotion(graph, 'acme-corp', 'Acme Corp', PLAY_SIGNALS, TACTIC_SIGNALS)
    expect(motion).not.toBeNull()
    expect(motion!.confidence).toBe('high')
  })

  it('motion status defaults to active', async () => {
    const motion = await buildMotion(graph, 'acme-corp', 'Acme Corp', PLAY_SIGNALS, TACTIC_SIGNALS)
    expect(motion).not.toBeNull()
    expect(motion!.status).toBe('active')
  })

  it('every phase has non-empty evidence with module and fact', async () => {
    const motion = await buildMotion(graph, 'acme-corp', 'Acme Corp', PLAY_SIGNALS, TACTIC_SIGNALS)
    expect(motion).not.toBeNull()
    for (const phase of motion!.phases) {
      expect(phase.evidence.length).toBeGreaterThan(0)
      for (const ev of phase.evidence) {
        expect(typeof ev.module).toBe('string')
        expect(ev.module.length).toBeGreaterThan(0)
        expect(typeof ev.fact).toBe('string')
        expect(ev.fact.length).toBeGreaterThan(0)
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// FIXTURE 2: Moderate Customer — 5-7 source types
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration: Moderate Customer (5-7 sources)', () => {
  let graph: CustomerGraph

  beforeAll(() => {
    graph = buildCustomerGraph('moderate-inc', 'Moderate Inc', buildModerateCustomerSignals())
  })

  it('graph has 5+ distinct node types', () => {
    const nodeTypes = new Set(Object.values(graph.nodes).map(n => n.type))
    expect(nodeTypes.size).toBeGreaterThanOrEqual(5)
  })

  it('buildMotion returns non-null with 1+ phases', async () => {
    const motion = await buildMotion(graph, 'moderate-inc', 'Moderate Inc', PLAY_SIGNALS, TACTIC_SIGNALS)
    expect(motion).not.toBeNull()
    expect(motion!.phases.length).toBeGreaterThanOrEqual(1)
  })

  it('flowLedger present with signalsIngested > 0', async () => {
    const motion = await buildMotion(graph, 'moderate-inc', 'Moderate Inc', PLAY_SIGNALS, TACTIC_SIGNALS)
    expect(motion).not.toBeNull()
    expect(motion!.flowLedger).toBeDefined()
    expect(motion!.flowLedger!.signalsIngested).toBeGreaterThan(0)
  })

  it('motion id follows format motion:{slug}', async () => {
    const motion = await buildMotion(graph, 'moderate-inc', 'Moderate Inc', PLAY_SIGNALS, TACTIC_SIGNALS)
    expect(motion).not.toBeNull()
    expect(motion!.id).toBe('motion:moderate-inc')
  })

  it('when cross-reference pass exists: portfolio nodes have crossReferenced set', () => {
    if (!hasCrossReferencePass(graph)) return
    const portfolioNodes = Object.values(graph.nodes).filter(n =>
      ['competitive-intel', 'news-radar', 'partner-catalog'].includes(n.sourceModule)
    )
    for (const node of portfolioNodes) {
      expect((node as any).crossReferenced).toBeDefined()
      expect(typeof (node as any).crossReferenced).toBe('boolean')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// FIXTURE 3: Thin Customer — 3-4 source types
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration: Thin Customer (3-4 sources)', () => {
  let graph: CustomerGraph

  beforeAll(() => {
    graph = buildCustomerGraph('thin-ltd', 'Thin Ltd', buildThinCustomerSignals())
  })

  it('graph builds correctly with limited sources', () => {
    expect(graph.customerId).toBe('thin-ltd')
    expect(graph.customerName).toBe('Thin Ltd')
    expect(graph.nodeCount).toBeGreaterThan(0)
  })

  it('has subscription, product, intel, and play node types', () => {
    const nodeTypes = new Set(Object.values(graph.nodes).map(n => n.type))
    expect(nodeTypes.has('subscription')).toBe(true)
    expect(nodeTypes.has('product')).toBe(true)
    expect(nodeTypes.has('intel')).toBe(true)
    expect(nodeTypes.has('play')).toBe(true)
  })

  it('buildMotion returns non-null (displacement phase from VMware/Puppet evaluating)', async () => {
    const motion = await buildMotion(graph, 'thin-ltd', 'Thin Ltd', PLAY_SIGNALS, TACTIC_SIGNALS)
    // 4 non-customer types (subscription, product, intel, play) >= 3: suppression gate passes
    // VMware/Puppet with evaluating context qualify for displacement phase
    expect(motion).not.toBeNull()
  })

  it('competitive-intel nodes present in graph', () => {
    const compIntel = Object.values(graph.nodes).filter(n => n.sourceModule === 'competitive-intel')
    expect(compIntel.length).toBe(2)
  })

  it('when cross-reference pass exists: competitive-intel nodes have crossReferenced set', () => {
    if (!hasCrossReferencePass(graph)) return
    const compIntel = Object.values(graph.nodes).filter(n => n.sourceModule === 'competitive-intel')
    for (const node of compIntel) {
      expect((node as any).crossReferenced).toBeDefined()
      expect(typeof (node as any).crossReferenced).toBe('boolean')
    }
  })

  it('when cross-reference pass exists: VMware intel matches tech via displacement vocabulary', () => {
    if (!hasCrossReferencePass(graph)) return
    const vmwareIntel = Object.values(graph.nodes).find(n =>
      n.sourceModule === 'competitive-intel' &&
      String(n.properties?.competitor ?? '').toLowerCase().includes('vmware')
    )
    expect(vmwareIntel).toBeDefined()
    expect((vmwareIntel as any).crossReferenced).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// FIXTURE 4: Minimal Customer — 1-2 source types
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration: Minimal Customer (1-2 sources)', () => {
  let graph: CustomerGraph

  beforeAll(() => {
    graph = buildCustomerGraph('minimal-co', 'Minimal Co', buildMinimalCustomerSignals())
  })

  it('graph builds correctly with single source', () => {
    expect(graph.customerId).toBe('minimal-co')
    expect(graph.customerName).toBe('Minimal Co')
    expect(Object.keys(graph.nodes).length).toBeGreaterThan(0)
  })

  it('suppression gate fires: < 3 non-customer node types means null motion', async () => {
    const graphNodeTypes = new Set(
      Object.values(graph.nodes).map(n => n.type).filter(t => t !== 'customer')
    )
    expect(graphNodeTypes.size).toBeLessThan(3)
    const motion = await buildMotion(graph, 'minimal-co', 'Minimal Co', PLAY_SIGNALS, TACTIC_SIGNALS)
    expect(motion).toBeNull()
  })

  it('customer hub node present', () => {
    const customer = Object.values(graph.nodes).find(n => n.type === 'customer')
    expect(customer).toBeDefined()
    expect(customer!.name).toBe('Minimal Co')
  })

  it('subscription node created from single signal', () => {
    const subs = findNodesByType(graph, 'subscription')
    expect(subs.length).toBe(1)
    expect(subs[0].name).toContain('Red Hat Enterprise Linux')
  })

  it('derived play node created from subscription TDP mapping', () => {
    const plays = findNodesByType(graph, 'play')
    expect(plays.length).toBeGreaterThanOrEqual(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-fixture regression tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration: Cross-fixture regression', () => {
  it('all 4 fixtures build graphs without throwing', () => {
    expect(() => buildCustomerGraph('r', 'R', buildRichCustomerSignals())).not.toThrow()
    expect(() => buildCustomerGraph('m', 'M', buildModerateCustomerSignals())).not.toThrow()
    expect(() => buildCustomerGraph('t', 'T', buildThinCustomerSignals())).not.toThrow()
    expect(() => buildCustomerGraph('n', 'N', buildMinimalCustomerSignals())).not.toThrow()
  })

  it('every graph has builtAt timestamp', () => {
    for (const [slug, name, signals] of [
      ['rich', 'Rich', buildRichCustomerSignals()],
      ['mod', 'Moderate', buildModerateCustomerSignals()],
      ['thin', 'Thin', buildThinCustomerSignals()],
      ['min', 'Minimal', buildMinimalCustomerSignals()],
    ] as Array<[string, string, Signal[]]>) {
      const g = buildCustomerGraph(slug, name, signals)
      expect(g.builtAt).toBeDefined()
      expect(typeof g.builtAt).toBe('string')
      expect(g.builtAt.length).toBeGreaterThan(0)
    }
  })

  it('all edges have createdAt, sourceType, and strength > 0', () => {
    const graph = buildCustomerGraph('r', 'Rich', buildRichCustomerSignals())
    expect(graph.edges.length).toBeGreaterThan(0)
    for (const edge of graph.edges) {
      expect(edge.createdAt).toBeDefined()
      expect(edge.sourceType).toBeDefined()
      expect(edge.strength).toBeGreaterThan(0)
    }
  })

  it('richer customers produce higher or equal confidence', async () => {
    const richGraph = buildCustomerGraph('r', 'Rich', buildRichCustomerSignals())
    const modGraph = buildCustomerGraph('m', 'Moderate', buildModerateCustomerSignals())
    const richMotion = await buildMotion(richGraph, 'r', 'Rich', PLAY_SIGNALS, TACTIC_SIGNALS)
    const modMotion = await buildMotion(modGraph, 'm', 'Moderate', PLAY_SIGNALS, TACTIC_SIGNALS)
    expect(richMotion).not.toBeNull()
    expect(modMotion).not.toBeNull()
    const levels: Record<string, number> = { low: 0, medium: 1, high: 2 }
    expect(levels[richMotion!.confidence]).toBeGreaterThanOrEqual(levels[modMotion!.confidence])
  })

  it('nodeCount matches nodes object size for all fixtures', () => {
    for (const [slug, name, signals] of [
      ['r', 'R', buildRichCustomerSignals()],
      ['m', 'M', buildModerateCustomerSignals()],
      ['t', 'T', buildThinCustomerSignals()],
      ['n', 'N', buildMinimalCustomerSignals()],
    ] as Array<[string, string, Signal[]]>) {
      const g = buildCustomerGraph(slug, name, signals)
      expect(g.nodeCount).toBe(Object.keys(g.nodes).length)
    }
  })

  it('edgeCount matches edges array length for all fixtures', () => {
    for (const [slug, name, signals] of [
      ['r', 'R', buildRichCustomerSignals()],
      ['m', 'M', buildModerateCustomerSignals()],
      ['t', 'T', buildThinCustomerSignals()],
      ['n', 'N', buildMinimalCustomerSignals()],
    ] as Array<[string, string, Signal[]]>) {
      const g = buildCustomerGraph(slug, name, signals)
      expect(g.edgeCount).toBe(g.edges.length)
    }
  })
})
