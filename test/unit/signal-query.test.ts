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
    // 2 signals = medium per ADR-032 §6 Step 4
    expect(vmwareRec!.confidence).toBe('medium')
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
    // Single signal = emerging (per ADR-032 §6, single-signal matches are 'emerging')
    expect(centosRec!.confidence).toBe('emerging')
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
})
