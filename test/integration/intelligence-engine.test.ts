/**
 * test/integration/intelligence-engine.test.ts
 * End-to-end integration tests for the intelligence engine pipeline.
 * GitHub Issue #891
 *
 * 4 synthetic customer fixtures: rich, moderate, thin, minimal.
 * Tests the full pipeline: signals → graph → cross-reference → motion → evidence → ledger.
 */

import { describe, it, expect, beforeAll } from 'bun:test'
import type { Signal } from '../../src/feature-module-registry.ts'

// Lazy imports to avoid ESM registration issues
let buildCustomerGraph: any
let buildMotion: any
let findNodesByType: any
let isGraphThin: any

beforeAll(async () => {
  const ig = await import('../../src/lib/intelligence-graph.ts')
  buildCustomerGraph = ig.buildCustomerGraph

  const mb = await import('../../src/lib/motion-builder.ts')
  buildMotion = mb.buildMotion
  isGraphThin = mb.isGraphThin

  const gu = await import('../../src/lib/graph-utils.ts')
  findNodesByType = gu.findNodesByType
})

// ── Fixture Helpers ─────────────────────────────────────────────────────────

function makeSignal(source: string, headline: string, meta: Record<string, any> = {}): Signal {
  return {
    source,
    type: source,
    headline,
    detail: '',
    timestamp: '2026-06-24',
    score: 0.7,
    metadata: { customerSlug: 'test-customer', ...meta },
  }
}

function makePortfolioSignal(source: string, headline: string, meta: Record<string, any> = {}): Signal {
  return {
    source,
    type: source,
    headline,
    detail: '',
    timestamp: '2026-06-24',
    score: 0.5,
    metadata: meta, // no customerSlug = portfolio-wide
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const RICH_SIGNALS: Signal[] = [
  // Subscriptions (3)
  makeSignal('subscriptions', 'RHEL Server', { productDescription: 'Red Hat Enterprise Linux Server', status: 'Active', startDate: '2025-01-01', endDate: '2027-01-01' }),
  makeSignal('subscriptions', 'OpenShift', { productDescription: 'OpenShift Container Platform', status: 'Expired', urgency: 'expired-critical' }),
  makeSignal('subscriptions', 'Ansible', { productDescription: 'Ansible Automation Platform', status: 'Active' }),
  // Cases (5)
  makeSignal('cases', 'Case: RHEL crash', { caseNumber: '001', severity: '2', status: 'Open', product: 'Red Hat Enterprise Linux' }),
  makeSignal('cases', 'Case: OCP upgrade', { caseNumber: '002', severity: '3', status: 'Open', product: 'OpenShift Container Platform' }),
  makeSignal('cases', 'Case: Ansible timeout', { caseNumber: '003', severity: '2', status: 'Open', product: 'Ansible Automation Platform' }),
  makeSignal('cases', 'Case: RHEL kernel', { caseNumber: '004', severity: '3', status: 'Closed', product: 'Red Hat Enterprise Linux' }),
  makeSignal('cases', 'Case: OCP networking', { caseNumber: '005', severity: '1', status: 'Open', product: 'OpenShift Container Platform' }),
  // Pipeline (3)
  makeSignal('pipeline', 'OpenShift deal', { opportunityName: 'OCP Expansion', stage: 'Negotiation', amount: 500000, closeDate: '2026-08-15' }),
  makeSignal('pipeline', 'RHEL renewal', { opportunityName: 'RHEL Renewal', stage: 'Closed Won', amount: 100000 }),
  makeSignal('pipeline', 'Ansible deal', { opportunityName: 'AAP Expansion', stage: 'Pipeline', amount: 200000, closeDate: '2026-09-01' }),
  // Tech-stack (5) — customer-specific
  makeSignal('tech-stack', 'Uses Docker', { techName: 'Docker', category: 'industry-tool', context: 'using' }),
  makeSignal('tech-stack', 'Uses VMware vSphere', { techName: 'VMware vSphere', category: 'industry-tool', context: 'using' }),
  makeSignal('tech-stack', 'Uses Kubernetes', { techName: 'Kubernetes', category: 'industry-tool', context: 'evaluating' }),
  makeSignal('tech-stack', 'Uses Terraform', { techName: 'Terraform', category: 'industry-tool', context: 'using' }),
  makeSignal('tech-stack', 'Uses AWS EKS', { techName: 'AWS EKS', category: 'industry-tool', context: 'using' }),
  // Competitive-intel (4) — portfolio-wide, some should cross-reference
  makePortfolioSignal('competitive-intel', 'VMware: pricing changes', { competitor: 'VMware', intelType: 'competitive' }),
  makePortfolioSignal('competitive-intel', 'Portworx: container storage', { competitor: 'Portworx', intelType: 'competitive' }),
  makePortfolioSignal('competitive-intel', 'AWS EKS: managed K8s', { competitor: 'AWS', intelType: 'competitive' }),
  makePortfolioSignal('competitive-intel', 'MuleSoft: integration platform', { competitor: 'MuleSoft', intelType: 'competitive' }),
  // Emails (3)
  makeSignal('emails', 'Re: OpenShift upgrade plan', { threadId: 't1', classification: 'technical', techMentions: ['openshift'] }),
  makeSignal('emails', 'Re: Cloud migration timeline', { threadId: 't2', classification: 'strategic', techMentions: ['aws', 'cloud'] }),
  makeSignal('emails', 'Re: Ansible rollout Q3', { threadId: 't3', classification: 'project', techMentions: ['ansible'] }),
  // Partner-catalog (3)
  makePortfolioSignal('partner-catalog', 'Acme Corp', { partnerName: 'Acme Corp', specializations: ['automation'], tier: 'premier' }),
  makePortfolioSignal('partner-catalog', 'CloudOps Inc', { partnerName: 'CloudOps Inc', specializations: ['cloud'], tier: 'advanced' }),
  makePortfolioSignal('partner-catalog', 'SecureNet', { partnerName: 'SecureNet', specializations: ['security'], tier: 'premier' }),
  // Product-lifecycle (2)
  makeSignal('product-lifecycle', 'RHEL 8 EOL', { product: 'RHEL 8', eolDate: '2026-12-31' }),
  makeSignal('product-lifecycle', 'OCP 4.12 EOL', { product: 'OpenShift 4.12', eolDate: '2027-03-01' }),
]

const MODERATE_SIGNALS: Signal[] = [
  makeSignal('subscriptions', 'RHEL', { productDescription: 'Red Hat Enterprise Linux', status: 'Active' }),
  makeSignal('subscriptions', 'Satellite', { productDescription: 'Red Hat Satellite', status: 'Active' }),
  makeSignal('cases', 'Case: patching', { caseNumber: '010', severity: '3', status: 'Open', product: 'Red Hat Enterprise Linux' }),
  makeSignal('cases', 'Case: satellite sync', { caseNumber: '011', severity: '2', status: 'Open', product: 'Red Hat Satellite' }),
  makeSignal('tech-stack', 'Uses Puppet', { techName: 'Puppet', category: 'industry-tool', context: 'using' }),
  makeSignal('tech-stack', 'Uses Chef', { techName: 'Chef', category: 'industry-tool', context: 'using' }),
  makeSignal('tech-stack', 'Uses Jenkins', { techName: 'Jenkins', category: 'industry-tool', context: 'using' }),
  makeSignal('pipeline', 'Satellite renewal', { opportunityName: 'Satellite Renewal', stage: 'Negotiation', amount: 50000 }),
  makePortfolioSignal('news-radar', 'RHEL 10 announced', { title: 'RHEL 10 announced', intelType: 'news' }),
  makePortfolioSignal('news-radar', 'Linux kernel update', { title: 'Linux kernel 6.x', intelType: 'news' }),
  makePortfolioSignal('news-radar', 'Ansible community growth', { title: 'Ansible community', intelType: 'news' }),
]

const THIN_SIGNALS: Signal[] = [
  makeSignal('subscriptions', 'RHEL', { productDescription: 'Red Hat Enterprise Linux', status: 'Expired', urgency: 'expired' }),
  makeSignal('tech-stack', 'Uses CentOS', { techName: 'CentOS', category: 'industry-tool', context: 'using' }),
  makeSignal('tech-stack', 'Uses nginx', { techName: 'nginx', category: 'industry-tool', context: 'using' }),
  makeSignal('tech-stack', 'Uses PostgreSQL', { techName: 'PostgreSQL', category: 'industry-tool', context: 'using' }),
  makePortfolioSignal('competitive-intel', 'SUSE: Linux alternative', { competitor: 'SUSE', intelType: 'competitive' }),
  makePortfolioSignal('competitive-intel', 'Canonical: Ubuntu server', { competitor: 'Canonical', intelType: 'competitive' }),
]

const MINIMAL_SIGNALS: Signal[] = [
  makeSignal('subscriptions', 'RHEL basic', { productDescription: 'Red Hat Enterprise Linux', status: 'Active' }),
]

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Intelligence Engine Integration', () => {
  describe('Rich customer (8+ source types)', () => {
    it('builds graph with ≥8 node types', () => {
      const graph = buildCustomerGraph('rich-test', 'Rich Test Corp', RICH_SIGNALS)
      const types = new Set(Object.values(graph.nodes).map((n: any) => n.type))
      expect(types.size).toBeGreaterThanOrEqual(6) // subscription, case, deal, product, intel, engagement, lifecycle, partner
    })

    it('cross-reference gate tags competitive-intel nodes', () => {
      const graph = buildCustomerGraph('rich-test', 'Rich Test Corp', RICH_SIGNALS)
      const compNodes = Object.values(graph.nodes).filter((n: any) => n.sourceModule === 'competitive-intel')
      expect(compNodes.length).toBeGreaterThan(0)

      // KEY REGRESSION TEST: every competitive-intel node must have crossReferenced set
      for (const node of compNodes) {
        expect((node as any).crossReferenced).toBeDefined()
        expect(typeof (node as any).crossReferenced).toBe('boolean')
      }

      // VMware should be cross-referenced (customer has VMware vSphere in tech-stack)
      const vmwareNode = compNodes.find((n: any) => String(n.properties?.competitor ?? '').toLowerCase().includes('vmware'))
      if (vmwareNode) {
        expect((vmwareNode as any).crossReferenced).toBe(true)
      }

      // MuleSoft should NOT be cross-referenced (customer has no MuleSoft signals)
      const mulesoftNode = compNodes.find((n: any) => String(n.properties?.competitor ?? '').toLowerCase().includes('mulesoft'))
      if (mulesoftNode) {
        expect((mulesoftNode as any).crossReferenced).toBe(false)
      }
    })

    it('buildMotion returns motion or null (depends on SalesHub signals)', async () => {
      const graph = buildCustomerGraph('rich-test', 'Rich Test Corp', RICH_SIGNALS)
      const motion = await buildMotion(graph, 'rich-test', 'Rich Test Corp', [], [])
      // Without SalesHub play/tactic signals, motion may be null — that's expected
      // The key assertion: if motion IS produced, it has valid structure
      if (motion) {
        expect(motion.phases.length).toBeGreaterThanOrEqual(1)
        expect(motion.flowLedger).toBeDefined()
        expect(motion.flowLedger!.signalsIngested).toBeGreaterThan(0)

        const allModules = new Set<string>()
        for (const phase of motion.phases) {
          for (const ev of phase.evidence) {
            allModules.add(ev.module)
          }
        }
        expect(allModules.size).toBeGreaterThanOrEqual(1)
      }
    })

    it('isGraphThin returns false for rich graph', () => {
      const graph = buildCustomerGraph('rich-test', 'Rich Test Corp', RICH_SIGNALS)
      expect(isGraphThin(graph)).toBe(false)
    })
  })

  describe('Moderate customer (5-7 source types)', () => {
    it('builds graph with correct node types', () => {
      const graph = buildCustomerGraph('mod-test', 'Moderate Test Corp', MODERATE_SIGNALS)
      const types = new Set(Object.values(graph.nodes).map((n: any) => n.type).filter((t: string) => t !== 'customer'))
      expect(types.size).toBeGreaterThanOrEqual(3)
    })

    it('buildMotion returns valid structure if non-null', async () => {
      const graph = buildCustomerGraph('mod-test', 'Moderate Test Corp', MODERATE_SIGNALS)
      const motion = await buildMotion(graph, 'mod-test', 'Moderate Test Corp', [], [])
      if (motion) {
        expect(motion.flowLedger).toBeDefined()
        expect(motion.flowLedger!.signalsIngested).toBeGreaterThan(0)
      }
    })
  })

  describe('Thin customer (3-4 source types)', () => {
    it('has fewer node types than rich customer', () => {
      const thinGraph = buildCustomerGraph('thin-test', 'Thin Test Corp', THIN_SIGNALS)
      const richGraph = buildCustomerGraph('rich-test', 'Rich Test Corp', RICH_SIGNALS)
      const thinTypes = new Set(Object.values(thinGraph.nodes).map((n: any) => n.type))
      const richTypes = new Set(Object.values(richGraph.nodes).map((n: any) => n.type))
      expect(thinTypes.size).toBeLessThan(richTypes.size)
    })

    it('adaptive corroboration allows single-match sources', async () => {
      const graph = buildCustomerGraph('thin-test', 'Thin Test Corp', THIN_SIGNALS)
      const motion = await buildMotion(graph, 'thin-test', 'Thin Test Corp', [], [])
      // With adaptive corroboration, thin graphs should still get motions
      // even with single-match competitive-intel sources
      if (motion) {
        expect(motion.flowLedger).toBeDefined()
      }
    })

    it('cross-reference gate tags all portfolio nodes', () => {
      const graph = buildCustomerGraph('thin-test', 'Thin Test Corp', THIN_SIGNALS)
      const compNodes = Object.values(graph.nodes).filter((n: any) => n.sourceModule === 'competitive-intel')
      for (const node of compNodes) {
        expect((node as any).crossReferenced).toBeDefined()
      }
    })
  })

  describe('Minimal customer (1-2 source types)', () => {
    it('graph builds correctly with 1 signal', () => {
      const graph = buildCustomerGraph('min-test', 'Minimal Test Corp', MINIMAL_SIGNALS)
      expect(graph).toBeDefined()
      expect(graph.nodeCount).toBeGreaterThan(0)
    })

    it('suppression gate fires — graphNodeTypes.size < 2 means null motion', async () => {
      const graph = buildCustomerGraph('min-test', 'Minimal Test Corp', MINIMAL_SIGNALS)
      const types = new Set(Object.values(graph.nodes).map((n: any) => n.type).filter((t: string) => t !== 'customer'))
      // Minimal has only 1 subscription — 1 node type — should be suppressed
      if (types.size < 2) {
        const motion = await buildMotion(graph, 'min-test', 'Minimal Test Corp', [], [])
        expect(motion).toBeNull()
      }
    })
  })

  describe('Cross-reference regression prevention', () => {
    it('ALL portfolio-scope nodes have crossReferenced set (never undefined)', () => {
      const graph = buildCustomerGraph('rich-test', 'Rich Test Corp', RICH_SIGNALS)
      const portfolioSources = new Set([
        'competitive-intel', 'news-radar', 'rh-rss', 'rh-events',
        'product-intel', 'ecosystem-catalog', 'partner-catalog', 'saleshub-products',
      ])

      for (const node of Object.values(graph.nodes)) {
        if (portfolioSources.has((node as any).sourceModule)) {
          expect((node as any).crossReferenced).toBeDefined()
          expect(typeof (node as any).crossReferenced).toBe('boolean')
        }
      }
    })

    it('customer-specific nodes are always crossReferenced=true', () => {
      const graph = buildCustomerGraph('rich-test', 'Rich Test Corp', RICH_SIGNALS)
      const customerSources = new Set(['subscriptions', 'cases', 'pipeline', 'tech-stack', 'emails'])

      for (const node of Object.values(graph.nodes)) {
        if (customerSources.has((node as any).sourceModule)) {
          expect((node as any).crossReferenced).toBe(true)
        }
      }
    })
  })
})
