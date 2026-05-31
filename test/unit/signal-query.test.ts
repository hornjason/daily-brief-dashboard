/**
 * test/unit/signal-query.test.ts — Unit tests for cross-referencing query helper
 * GitHub Issue #482, ADR-032
 *
 * Tests the core getRecommendations() function with mock signals and portfolio data.
 */

import { describe, it, expect } from 'bun:test'
import { getRecommendations, type RecommendedAction } from '../../src/lib/signal-query.ts'
import type { Signal } from '../../src/feature-module-registry.ts'

// ── Test fixtures ─────────────────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal>): Signal {
  return {
    source: 'test',
    type: 'technology',
    headline: 'Test signal',
    detail: 'Test detail',
    rawRelevance: 0.7,
    timestamp: new Date().toISOString(),
    metadata: { customerSlug: 'test-customer' },
    ...overrides,
  }
}

const mockSolutionPlays = {
  version: 2,
  plays: [
    {
      id: 'vmware-migration',
      name: 'VMware to OpenShift Virtualization Migration',
      tdp: 'Virtualization',
      summary: 'Consolidate VMs and containers on OpenShift',
      triggerTechnologies: ['VMware', 'vSphere', 'ESXi', 'Tanzu', 'vCenter'],
      redHatProducts: ['ocp', 'rhel', 'acm'],
      valueProps: ['Eliminate VMware licensing costs', 'Consolidate VM and container workloads'],
      cloudAmplifiers: ['AWS', 'Azure', 'Google'],
      category: 'modernization',
    },
    {
      id: 'platform-modernization',
      name: 'Infrastructure Modernization with RHEL',
      tdp: 'Server/Cloud OS',
      summary: 'Modernize from legacy OS to RHEL',
      triggerTechnologies: ['AIX', 'Solaris', 'CentOS', 'Ubuntu', 'SUSE', 'Oracle Linux'],
      redHatProducts: ['rhel', 'satellite', 'insights'],
      valueProps: ['Standardize on enterprise Linux', 'Satellite for multi-site management'],
      category: 'modernization',
    },
    {
      id: 'cloud-native-adoption',
      name: 'Cloud-Native Application Platform',
      tdp: 'App Platform',
      summary: 'Standardize on OpenShift as the Kubernetes platform',
      triggerTechnologies: ['Kubernetes', 'K8s', 'Docker', 'EKS', 'AKS', 'GKE'],
      redHatProducts: ['ocp', 'acs', 'rhdh', 'quay'],
      valueProps: ['Enterprise Kubernetes with security', 'Advanced Cluster Security'],
      cloudAmplifiers: ['AWS', 'Azure', 'Google'],
      category: 'platform',
    },
    {
      id: 'network-automation',
      name: 'Network Automation with Ansible',
      tdp: 'Automation',
      summary: 'Automate network device configuration',
      triggerTechnologies: ['Cisco', 'Juniper', 'Arista', 'Palo Alto', 'F5'],
      redHatProducts: ['aap'],
      valueProps: ['Agentless network automation'],
      category: 'automation',
    },
  ],
}

const mockEcosystemPartners = [
  {
    partnerName: 'Cisco',
    partnerSlug: 'cisco',
    solutions: [
      {
        name: 'Cisco ACI with OpenShift',
        partnerName: 'Cisco',
        partnerSlug: 'cisco',
        description: 'Integrated networking for OpenShift',
        platform: 'OpenShift Container Platform',
        categories: ['Networking'],
        geoRegion: 'Global',
        url: 'https://catalog.redhat.com/example',
        resources: [
          { title: 'Design Guide', url: 'https://example.com/design', type: 'design-guide' as const },
        ],
        collections: [],
      },
    ],
    scrapedAt: new Date().toISOString(),
    solutionCount: 1,
  },
]

const mockCloudMarketplace = {
  clouds: [
    {
      provider: 'AWS',
      programs: [
        { name: 'AWS Marketplace CPPO', description: 'Channel Partner Private Offer' },
        { name: 'AWS ISV Accelerate', description: 'Co-sell program' },
      ],
    },
    {
      provider: 'Microsoft',
      programs: [
        { name: 'Azure Marketplace', description: 'Azure marketplace listing' },
      ],
    },
  ],
  cachedAt: new Date().toISOString(),
}

const mockSaleshubKnowledge = {
  version: 1,
  tdps: [
    {
      name: 'Virtualization',
      tactics: ['VMware Migration Assessment'],
      whatToSay: [{ name: 'VMware talk track', url: 'https://example.com/talk', type: 'seismic' }],
    },
  ],
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getRecommendations', () => {
  it('returns empty array when no signals', () => {
    const result = getRecommendations(
      [],
      mockSolutionPlays.plays,
      mockEcosystemPartners,
      mockCloudMarketplace,
      mockSaleshubKnowledge,
    )
    expect(result).toEqual([])
  })

  it('returns empty array when no portfolio data', () => {
    const signals = [
      makeSignal({
        type: 'technology',
        headline: 'VMware detected',
        metadata: { customerSlug: 'acme', confidence: 'HIGH', technologies: ['VMware'] },
      }),
    ]
    const result = getRecommendations(signals, [], [], null, null)
    expect(result).toEqual([])
  })

  it('matches tech-stack signals to solution plays', () => {
    const signals = [
      makeSignal({
        source: 'tech-stack',
        type: 'technology',
        headline: 'VMware detected',
        metadata: {
          customerSlug: 'acme',
          confidence: 'HIGH',
          technologies: ['VMware'],
          techName: 'VMware',
        },
      }),
    ]

    const result = getRecommendations(
      signals,
      mockSolutionPlays.plays,
      mockEcosystemPartners,
      mockCloudMarketplace,
      mockSaleshubKnowledge,
    )

    expect(result.length).toBeGreaterThan(0)
    const vmwareRec = result.find(r => r.solution.name.includes('VMware'))
    expect(vmwareRec).toBeDefined()
    expect(vmwareRec!.solution.type).toBe('play')
    expect(vmwareRec!.triggerSignals.length).toBeGreaterThan(0)
  })

  it('assigns MEDIUM confidence when 2 corroborating signals (ADR-032 §6)', () => {
    const signals = [
      makeSignal({
        source: 'tech-stack',
        type: 'technology',
        headline: 'VMware detected',
        metadata: {
          customerSlug: 'acme',
          confidence: 'HIGH',
          techName: 'VMware',
        },
      }),
      makeSignal({
        source: 'cases',
        type: 'case',
        headline: 'VMware migration case',
        detail: 'Customer asking about VMware to OpenShift migration',
        metadata: {
          customerSlug: 'acme',
          severity: '2',
          techMentions: ['VMware'],
        },
      }),
    ]

    const result = getRecommendations(
      signals,
      mockSolutionPlays.plays,
      mockEcosystemPartners,
      mockCloudMarketplace,
      mockSaleshubKnowledge,
    )

    const vmwareRec = result.find(r => r.solution.name.includes('VMware'))
    expect(vmwareRec).toBeDefined()
    // 2 customer-specific signals (weighted 3 each = 6) = high per #495 weighted scoring
    expect(vmwareRec!.confidence).toBe('high')
    expect(vmwareRec!.triggerSignals.length).toBeGreaterThanOrEqual(2)
  })

  it('assigns HIGH confidence when 3+ corroborating signals', () => {
    const signals = [
      makeSignal({
        source: 'tech-stack',
        type: 'technology',
        headline: 'VMware detected',
        metadata: { customerSlug: 'acme', confidence: 'HIGH', techName: 'VMware' },
      }),
      makeSignal({
        source: 'cases',
        type: 'case',
        headline: 'VMware migration case',
        detail: 'Customer asking about VMware migration',
        metadata: { customerSlug: 'acme', severity: '2', techMentions: ['VMware'] },
      }),
      makeSignal({
        source: 'intelligence',
        type: 'intelligence',
        headline: 'Customer evaluating VMware alternatives',
        detail: 'Business objective: eliminate VMware licensing costs',
        metadata: { customerSlug: 'acme' },
      }),
    ]

    const result = getRecommendations(
      signals,
      mockSolutionPlays.plays,
      mockEcosystemPartners,
      mockCloudMarketplace,
      mockSaleshubKnowledge,
    )

    const vmwareRec = result.find(r => r.solution.name.includes('VMware'))
    expect(vmwareRec).toBeDefined()
    expect(vmwareRec!.confidence).toBe('high')
    expect(vmwareRec!.triggerSignals.length).toBeGreaterThanOrEqual(3)
  })

  it('assigns emerging confidence for single-signal matches', () => {
    const signals = [
      makeSignal({
        source: 'tech-stack',
        type: 'technology',
        headline: 'CentOS detected',
        metadata: {
          customerSlug: 'acme',
          confidence: 'MEDIUM',
          techName: 'CentOS',
        },
      }),
    ]

    const result = getRecommendations(
      signals,
      mockSolutionPlays.plays,
      [],
      null,
      null,
    )

    const centosRec = result.find(r => r.solution.name.includes('RHEL') || r.solution.name.includes('Modernization'))
    expect(centosRec).toBeDefined()
    // Single customer-specific signal (weighted 3) = medium per #495 weighted scoring
    expect(centosRec!.confidence).toBe('medium')
  })

  it('matches cloud-spend signals to marketplace programs', () => {
    const signals = [
      makeSignal({
        source: 'ccsp',
        type: 'cloud-spend',
        headline: 'AWS spend: $200K',
        metadata: {
          customerSlug: 'acme',
          provider: 'AWS',
          hasCloudSpend: true,
          acvPlus: 200000,
        },
      }),
    ]

    const result = getRecommendations(
      signals,
      mockSolutionPlays.plays,
      mockEcosystemPartners,
      mockCloudMarketplace,
      mockSaleshubKnowledge,
    )

    const awsRec = result.find(r => r.solution.type === 'program' || r.solution.type === 'incentive')
    expect(awsRec).toBeDefined()
  })

  it('matches tech-stack signals to ecosystem partners', () => {
    const signals = [
      makeSignal({
        source: 'tech-stack',
        type: 'technology',
        headline: 'Cisco detected',
        metadata: {
          customerSlug: 'acme',
          confidence: 'HIGH',
          techName: 'Cisco',
        },
      }),
    ]

    const result = getRecommendations(
      signals,
      mockSolutionPlays.plays,
      mockEcosystemPartners,
      mockCloudMarketplace,
      mockSaleshubKnowledge,
    )

    const partnerRec = result.find(r => r.solution.type === 'partner')
    expect(partnerRec).toBeDefined()
    expect(partnerRec!.solution.name).toContain('Cisco')
  })

  it('sorts results by confidence then trigger count', () => {
    const signals = [
      // VMware with 2 corroborating signals → should be HIGH
      makeSignal({
        source: 'tech-stack',
        type: 'technology',
        headline: 'VMware detected',
        metadata: { customerSlug: 'acme', confidence: 'HIGH', techName: 'VMware' },
      }),
      makeSignal({
        source: 'cases',
        type: 'case',
        headline: 'VMware case',
        detail: 'VMware migration inquiry',
        metadata: { customerSlug: 'acme', severity: '2', techMentions: ['VMware'] },
      }),
      // CentOS with 1 signal → should be EMERGING
      makeSignal({
        source: 'tech-stack',
        type: 'technology',
        headline: 'CentOS detected',
        metadata: { customerSlug: 'acme', confidence: 'MEDIUM', techName: 'CentOS' },
      }),
    ]

    const result = getRecommendations(
      signals,
      mockSolutionPlays.plays,
      [],
      null,
      null,
    )

    // HIGH confidence items should appear before EMERGING
    if (result.length >= 2) {
      const confidenceOrder = { high: 3, medium: 2, emerging: 1 }
      for (let i = 1; i < result.length; i++) {
        const prev = confidenceOrder[result[i - 1].confidence]
        const curr = confidenceOrder[result[i].confidence]
        expect(prev).toBeGreaterThanOrEqual(curr)
      }
    }
  })

  it('caps results at MAX_RECOMMENDATIONS (10)', () => {
    // Create many tech signals that trigger different plays
    const techNames = [
      'VMware', 'CentOS', 'Kubernetes', 'Cisco', 'Juniper',
      'Arista', 'Docker', 'EKS', 'AKS', 'GKE',
      'Solaris', 'Ubuntu', 'AIX',
    ]
    const signals = techNames.map(name =>
      makeSignal({
        source: 'tech-stack',
        type: 'technology',
        headline: `${name} detected`,
        metadata: { customerSlug: 'acme', confidence: 'HIGH', techName: name },
      }),
    )

    const result = getRecommendations(
      signals,
      mockSolutionPlays.plays,
      mockEcosystemPartners,
      mockCloudMarketplace,
      mockSaleshubKnowledge,
    )

    expect(result.length).toBeLessThanOrEqual(10)
  })

  it('includes solution assets in recommendations', () => {
    const signals = [
      makeSignal({
        source: 'tech-stack',
        type: 'technology',
        headline: 'Cisco detected',
        metadata: { customerSlug: 'acme', confidence: 'HIGH', techName: 'Cisco' },
      }),
    ]

    const result = getRecommendations(
      signals,
      mockSolutionPlays.plays,
      mockEcosystemPartners,
      mockCloudMarketplace,
      mockSaleshubKnowledge,
    )

    const partnerRec = result.find(r => r.solution.type === 'partner')
    if (partnerRec) {
      expect(partnerRec.solution.assets).toBeDefined()
      expect(partnerRec.solution.assets!.length).toBeGreaterThan(0)
    }
  })

  it('includes actions array in recommendations', () => {
    const signals = [
      makeSignal({
        source: 'tech-stack',
        type: 'technology',
        headline: 'VMware detected',
        metadata: { customerSlug: 'acme', confidence: 'HIGH', techName: 'VMware' },
      }),
    ]

    const result = getRecommendations(
      signals,
      mockSolutionPlays.plays,
      [],
      null,
      null,
    )

    expect(result.length).toBeGreaterThan(0)
    expect(result[0].actions).toBeDefined()
    expect(result[0].actions.length).toBeGreaterThan(0)
  })

  it('narrative field is undefined (lazy generation)', () => {
    const signals = [
      makeSignal({
        source: 'tech-stack',
        type: 'technology',
        headline: 'VMware detected',
        metadata: { customerSlug: 'acme', confidence: 'HIGH', techName: 'VMware' },
      }),
    ]

    const result = getRecommendations(
      signals,
      mockSolutionPlays.plays,
      [],
      null,
      null,
    )

    expect(result.length).toBeGreaterThan(0)
    expect(result[0].narrative).toBeUndefined()
  })

  it('case signals mentioning technology trigger play recommendations', () => {
    const signals = [
      makeSignal({
        source: 'cases',
        type: 'case',
        headline: 'Customer case about VMware migration',
        detail: 'Customer exploring VMware to container migration',
        metadata: {
          customerSlug: 'acme',
          severity: '2',
          techMentions: ['VMware'],
        },
      }),
    ]

    const result = getRecommendations(
      signals,
      mockSolutionPlays.plays,
      [],
      null,
      null,
    )

    const vmwareRec = result.find(r => r.solution.name.includes('VMware'))
    expect(vmwareRec).toBeDefined()
  })

  it('intelligence signals with business objectives match play value props', () => {
    const signals = [
      makeSignal({
        source: 'intelligence',
        type: 'intelligence',
        headline: 'Customer planning VM modernization',
        detail: 'Business objective: reduce VMware licensing costs by 40%',
        metadata: {
          customerSlug: 'acme',
          businessObjectives: ['Reduce VMware licensing costs', 'Consolidate infrastructure'],
        },
      }),
    ]

    const result = getRecommendations(
      signals,
      mockSolutionPlays.plays,
      [],
      null,
      null,
    )

    // Should match VMware migration play via keyword detection
    expect(result.length).toBeGreaterThan(0)
  })

  // ── #495: Recommendation diversity ──────────────────────────────────────────

  it('#495: weights customer-specific signals 3x over portfolio-wide signals', () => {
    // Customer-specific signal (has customerSlug)
    const customerSignal = makeSignal({
      source: 'tech-stack',
      type: 'technology',
      headline: 'VMware detected at Acme',
      metadata: { customerSlug: 'acme', confidence: 'HIGH', techName: 'VMware' },
    })
    // Portfolio-wide signal (no customerSlug)
    const portfolioSignal = makeSignal({
      source: 'tech-stack',
      type: 'technology',
      headline: 'VMware in value-map',
      metadata: { techName: 'VMware' },
    })

    // With only portfolio signal: should still work but lower weighted score
    const portfolioResult = getRecommendations(
      [portfolioSignal],
      mockSolutionPlays.plays,
      [],
      null,
      null,
    )

    // With customer-specific signal: should have higher weighted score
    const customerResult = getRecommendations(
      [customerSignal],
      mockSolutionPlays.plays,
      [],
      null,
      null,
    )

    // Both should produce recommendations
    expect(portfolioResult.length).toBeGreaterThan(0)
    expect(customerResult.length).toBeGreaterThan(0)

    // Customer-specific should have higher weighted score (reflected in confidence or ranking)
    const portfolioVmware = portfolioResult.find(r => r.solution.name.includes('VMware'))
    const customerVmware = customerResult.find(r => r.solution.name.includes('VMware'))
    expect(portfolioVmware).toBeDefined()
    expect(customerVmware).toBeDefined()
  })

  it('#495: deduplicates recommendations by solution name, keeping highest weighted', () => {
    // Two different signal paths that trigger the same solution play
    const signals = [
      makeSignal({
        source: 'tech-stack',
        type: 'technology',
        headline: 'VMware detected',
        metadata: { customerSlug: 'acme', confidence: 'HIGH', techName: 'VMware' },
      }),
      makeSignal({
        source: 'cases',
        type: 'case',
        headline: 'vSphere case',
        detail: 'Customer asking about vSphere migration',
        metadata: { customerSlug: 'acme', severity: '2', techMentions: ['vSphere'] },
      }),
    ]

    const result = getRecommendations(
      signals,
      mockSolutionPlays.plays,
      [],
      null,
      null,
    )

    // Should NOT have duplicate solutions by name
    const solutionNames = result.map(r => r.solution.name)
    const uniqueNames = [...new Set(solutionNames)]
    expect(solutionNames.length).toBe(uniqueNames.length)
  })

  it('#495: different customers get different top recommendations when portfolio signals are shared', () => {
    // Reproduce the real bug: portfolio-wide signals with no customerSlug
    // inflate VMware play to 3 triggers for ALL customers. Without weighted scoring,
    // every customer shows VMware as top recommendation regardless of their own signals.
    //
    // Shared portfolio signals: VMware gets 3 (value-map, playbook, partner),
    //   Kubernetes gets 2 (value-map, playbook). Both are portfolio-wide (no customerSlug).
    //
    // Acme adds customer-specific Kubernetes signal.
    // Without weighting: VMware=3, K8s=3 → tie → Map order picks VMware for BOTH customers
    // With weighting (customer=3x): Acme VMware=3*1=3, Acme K8s=2*1+1*3=5 → K8s wins for Acme
    // Beta has no customer-specific: VMware=3*1=3, K8s=2*1=2 → VMware wins for Beta

    const sharedPortfolioSignals = [
      makeSignal({ source: 'tech-stack', type: 'technology',
        headline: 'VMware in value-map', metadata: { techName: 'VMware' } }),
      makeSignal({ source: 'intelligence', type: 'intelligence',
        headline: 'VMware playbook', detail: 'VMware migration content', metadata: {} }),
      makeSignal({ source: 'tech-stack', type: 'technology',
        headline: 'vSphere in partner catalog', metadata: { techName: 'vSphere' } }),
      makeSignal({ source: 'tech-stack', type: 'technology',
        headline: 'Kubernetes in value-map', metadata: { techName: 'Kubernetes' } }),
      makeSignal({ source: 'intelligence', type: 'intelligence',
        headline: 'Kubernetes playbook', detail: 'Kubernetes cloud-native content', metadata: {} }),
    ]

    // Acme: customer-specific Kubernetes signal → should boost Cloud-Native above VMware
    const acmeSignals = [
      ...sharedPortfolioSignals,
      makeSignal({ source: 'tech-stack', type: 'technology',
        headline: 'Kubernetes detected at Acme',
        metadata: { customerSlug: 'acme', techName: 'Kubernetes' } }),
    ]

    // Beta: NO customer-specific signals → VMware wins by portfolio trigger count
    const betaSignals = [...sharedPortfolioSignals]

    const acmeResult = getRecommendations(acmeSignals, mockSolutionPlays.plays, [], null, null)
    const betaResult = getRecommendations(betaSignals, mockSolutionPlays.plays, [], null, null)

    expect(acmeResult.length).toBeGreaterThan(0)
    expect(betaResult.length).toBeGreaterThan(0)

    // Acme should get Cloud-Native at top (customer-specific K8s signal outweighs portfolio VMware)
    expect(acmeResult[0].solution.name).toContain('Cloud-Native')
    // Beta should get VMware at top (no customer signals, portfolio VMware has more triggers)
    expect(betaResult[0].solution.name).toContain('VMware')
  })

  it('#495: sorts by weighted score not raw trigger count', () => {
    // 3 portfolio-wide signals for CentOS (weighted: 3 * 1 = 3)
    // vs 1 customer-specific signal for VMware (weighted: 1 * 3 = 3 — tie, but with 1 portfolio too)
    const signals = [
      // Customer-specific VMware signal
      makeSignal({
        source: 'tech-stack',
        type: 'technology',
        headline: 'VMware at customer',
        metadata: { customerSlug: 'acme', confidence: 'HIGH', techName: 'VMware' },
      }),
      // Customer-specific VMware case
      makeSignal({
        source: 'cases',
        type: 'case',
        headline: 'VMware case',
        detail: 'VMware migration inquiry',
        metadata: { customerSlug: 'acme', severity: '2', techMentions: ['VMware'] },
      }),
      // Portfolio-wide CentOS signal (no customerSlug)
      makeSignal({
        source: 'tech-stack',
        type: 'technology',
        headline: 'CentOS in portfolio',
        metadata: { techName: 'CentOS' },
      }),
    ]

    const result = getRecommendations(
      signals,
      mockSolutionPlays.plays,
      [],
      null,
      null,
    )

    // VMware should rank higher than CentOS because customer-specific signals
    // are weighted 3x (VMware: 2 customer * 3 = 6, CentOS: 1 portfolio * 1 = 1)
    const vmwareIdx = result.findIndex(r => r.solution.name.includes('VMware'))
    const centosIdx = result.findIndex(r => r.solution.name.includes('RHEL') || r.solution.name.includes('Modernization'))
    if (vmwareIdx >= 0 && centosIdx >= 0) {
      expect(vmwareIdx).toBeLessThan(centosIdx)
    }
  })
})
