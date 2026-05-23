/**
 * Unit tests for signal-templates.ts — GitHub Issue #326
 *
 * Tests each template function with mock signals covering all metadata routing patterns.
 */

import { describe, test, expect } from 'bun:test'
import {
  templateProductAlignment,
  templateCloudMarketplace,
  templateRenewals,
  templateCases,
  templateTechStack,
  templateKeyRelationships,
  templateStrategicOpportunities,
  templateAll,
  type TemplateOptions,
} from '../../src/lib/signal-templates.ts'
import type { Signal } from '../../src/feature-module-registry.ts'

import type { AccountTeamMember } from '../../src/types.ts'

// ── Mock Data ────────────────────────────────────────────────────────────────

const mockProductSignal: Signal = {
  source: 'subscriptions',
  type: 'subscription',
  headline: 'OpenShift Container Platform',
  detail: 'Customer uses OpenShift for container orchestration',
  score: 0.85,
  timestamp: new Date().toISOString(),
  metadata: {
    product: 'OpenShift',
    confidence: 'HIGH',
    context: 'Production workloads',
  },
}

const mockCloudSignal: Signal = {
  source: 'cloud-marketplace',
  type: 'cloud-spend',
  headline: 'AWS Marketplace Activity',
  detail: 'Customer purchasing OpenShift via AWS Marketplace',
  score: 0.90,
  timestamp: new Date().toISOString(),
  metadata: {
    provider: 'AWS',
    hasCloudSpend: true,
    acvPlus: 125000,
    programs: ['Commit', 'EDP'],
    productOfferingGroup: ['OpenShift', 'RHEL'],
  },
}

const mockRenewalSignal: Signal = {
  source: 'pipeline',
  type: 'subscription',
  headline: 'Ansible Renewal Q2',
  detail: 'Ansible Automation Platform subscription renewal',
  score: 0.95,
  timestamp: new Date().toISOString(),
  metadata: {
    product: 'Ansible Automation Platform',
    renewal: true,
    amount: 250000,
    closeDate: '2026-06-30',
    stage: 'Commit',
  },
}

const mockCaseSignal: Signal = {
  source: 'cases',
  type: 'case',
  headline: 'Performance degradation on RHEL 9',
  detail: 'Customer experiencing slow disk I/O on RHEL 9 production systems',
  score: 0.92,
  timestamp: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days ago
  metadata: {
    caseNumber: '01234567',
    severity: 2,
    product: 'RHEL',
  },
}

const mockTechSignal: Signal = {
  source: 'tech-stack',
  type: 'technology',
  headline: 'Evaluating Kubernetes migration',
  detail: 'Customer currently using Docker Swarm, evaluating Kubernetes',
  score: 0.78,
  timestamp: new Date().toISOString(),
  metadata: {
    confidence: 'MEDIUM',
    context: 'Migration from Docker Swarm',
    infrastructure: ['containers', 'orchestration'],
  },
}

const mockAccountTeam: AccountTeamMember[] = [
  { name: 'Jane Smith', title: 'Account Executive', role: 'ae' },
  { name: 'John Doe', title: 'Solution Architect', role: 'asa' },
  { name: 'Alice Johnson', title: 'Sales Specialist', role: 'ssp' },
  { name: 'Bob Wilson', title: 'Specialist SA', role: 'ssa' },
]

// ── Template Function Tests ─────────────────────────────────────────────────

describe('templateProductAlignment', () => {
  test('returns null when no product signals', () => {
    const result = templateProductAlignment([mockCloudSignal, mockCaseSignal])
    expect(result).toBeNull()
  })

  test('renders product alignment table with metadata', () => {
    const result = templateProductAlignment([mockProductSignal])
    expect(result).toContain('| Product | Confidence | Use Case Context |')
    expect(result).toContain('| OpenShift | HIGH | Production workloads |')
  })

  test('handles signals without confidence metadata', () => {
    const signalNoConf: Signal = {
      ...mockProductSignal,
      metadata: { product: 'RHEL' },
    }
    const result = templateProductAlignment([signalNoConf])
    expect(result).toContain('| RHEL | MEDIUM |')
  })

  test('caps at 8 rows', () => {
    const signals = Array(12).fill(null).map((_, i) => ({
      ...mockProductSignal,
      metadata: { product: `Product-${i}` },
    }))
    const result = templateProductAlignment(signals)
    const rowCount = (result?.match(/\n/g) || []).length
    expect(rowCount).toBe(9) // header + separator + 8 data rows = 10 lines - 1 for no trailing newline = 9
  })
})

describe('templateCloudMarketplace', () => {
  test('returns null when no cloud signals', () => {
    const result = templateCloudMarketplace([mockProductSignal, mockCaseSignal])
    expect(result).toBeNull()
  })

  test('renders cloud marketplace table', () => {
    const result = templateCloudMarketplace([mockCloudSignal])
    expect(result).toContain('| Provider | ACV | Programs | Offerings |')
    expect(result).toContain('| AWS | $125,000 | Commit, EDP | OpenShift, RHEL |')
  })

  test('handles missing ACV', () => {
    const signalNoACV: Signal = {
      ...mockCloudSignal,
      metadata: { provider: 'Azure', hasCloudSpend: true },
    }
    const result = templateCloudMarketplace([signalNoACV])
    expect(result).toContain('| Azure | N/A |')
  })
})

describe('templateRenewals', () => {
  test('returns null when no renewal signals', () => {
    const result = templateRenewals([mockProductSignal, mockCaseSignal])
    expect(result).toBeNull()
  })

  test('renders renewals table sorted by closeDate', () => {
    const earlyRenewal: Signal = {
      ...mockRenewalSignal,
      metadata: { ...mockRenewalSignal.metadata, closeDate: '2026-05-15', product: 'Early Product' },
    }
    const lateRenewal: Signal = {
      ...mockRenewalSignal,
      metadata: { ...mockRenewalSignal.metadata, closeDate: '2026-08-30', product: 'Late Product' },
    }

    const result = templateRenewals([lateRenewal, earlyRenewal])
    expect(result).toContain('| Product | Amount | Close Date | Stage |')

    // Verify early renewal comes first
    const lines = result!.split('\n')
    const earlyIdx = lines.findIndex(l => l.includes('Early Product'))
    const lateIdx = lines.findIndex(l => l.includes('Late Product'))
    expect(earlyIdx).toBeLessThan(lateIdx)
  })

  test('formats closeDate as human-readable', () => {
    const result = templateRenewals([mockRenewalSignal])
    expect(result).toContain('Jun 30, 2026')
  })
})

describe('templateCases', () => {
  test('returns null when no case signals', () => {
    const result = templateCases([mockProductSignal, mockCloudSignal])
    expect(result).toBeNull()
  })

  test('renders cases table sorted by severity', () => {
    const sev1Case: Signal = {
      ...mockCaseSignal,
      metadata: { caseNumber: '11111111', severity: 1, product: 'Critical Issue' },
    }
    const sev3Case: Signal = {
      ...mockCaseSignal,
      metadata: { caseNumber: '33333333', severity: 3, product: 'Low Priority' },
    }

    const result = templateCases([sev3Case, sev1Case, mockCaseSignal])
    expect(result).toContain('| Case Number | Severity | Product | Age |')

    // Verify sev1 comes first
    const lines = result!.split('\n')
    const sev1Idx = lines.findIndex(l => l.includes('11111111'))
    const sev3Idx = lines.findIndex(l => l.includes('33333333'))
    expect(sev1Idx).toBeLessThan(sev3Idx)
  })

  test('calculates age from timestamp', () => {
    const result = templateCases([mockCaseSignal])
    expect(result).toContain('5d') // 5 days ago
  })
})

describe('templateTechStack', () => {
  test('returns null when no tech signals', () => {
    const result = templateTechStack([mockProductSignal, mockCloudSignal])
    expect(result).toBeNull()
  })

  test('renders tech stack table', () => {
    const result = templateTechStack([mockTechSignal])
    expect(result).toContain('| Technology | Red Hat Positioning | Confidence |')
    expect(result).toContain('| Evaluating Kubernetes migration | Migration from Docker Swarm | MEDIUM |')
  })
})

describe('templateKeyRelationships', () => {
  test('returns null when no team provided', () => {
    const result = templateKeyRelationships(undefined)
    expect(result).toBeNull()
  })

  test('renders account team table', () => {
    const result = templateKeyRelationships(mockAccountTeam)
    expect(result).toContain('| Name | Role | Focus Area |')
    expect(result).toContain('| Jane Smith | Account Executive | Primary relationship, commercial |')
    expect(result).toContain('| John Doe | Solution Architect | Technical strategy, architecture |')
    expect(result).toContain('| Alice Johnson | Sales Specialist | Product specialization, sales |')
    expect(result).toContain('| Bob Wilson | Specialist SA | Technical deep-dive, specialization |')
  })

  test('returns null when team array is empty', () => {
    const emptyTeam: AccountTeamMember[] = []
    const result = templateKeyRelationships(emptyTeam)
    expect(result).toBeNull()
  })
})

describe('templateAll', () => {
  test('assembles all sections with signals', () => {
    const signals = [
      mockProductSignal,
      mockCloudSignal,
      mockRenewalSignal,
      mockCaseSignal,
      mockTechSignal,
    ]

    const result = templateAll(signals, mockAccountTeam)

    expect(result.deterministic).toContain('## Product Alignment')
    expect(result.deterministic).toContain('## Cloud Marketplace')
    expect(result.deterministic).toContain('## Renewals & Pipeline')
    expect(result.deterministic).toContain('## Support Cases')
    expect(result.deterministic).toContain('## Technology Stack')
    expect(result.deterministic).toContain('## Key Relationships')

    expect(result.sections.productAlignment).not.toBeNull()
    expect(result.sections.cloudMarketplace).not.toBeNull()
    expect(result.sections.renewals).not.toBeNull()
    expect(result.sections.cases).not.toBeNull()
    expect(result.sections.techStack).not.toBeNull()
    expect(result.sections.keyRelationships).not.toBeNull()
  })

  test('omits sections with no matching signals', () => {
    const result = templateAll([mockProductSignal])

    expect(result.deterministic).toContain('## Product Alignment')
    expect(result.deterministic).not.toContain('## Cloud Marketplace')
    expect(result.deterministic).not.toContain('## Renewals & Pipeline')

    expect(result.sections.productAlignment).not.toBeNull()
    expect(result.sections.cloudMarketplace).toBeNull()
    expect(result.sections.renewals).toBeNull()
  })

  test('narrativeContext format varies by consumer', () => {
    const signals = [mockProductSignal, mockCloudSignal]

    // Playbook format
    const playbook = templateAll(signals, undefined, { format: 'playbook' })
    expect(playbook.narrativeContext).toContain('[subscriptions] OpenShift Container Platform: Customer uses OpenShift')

    // Brief format
    const brief = templateAll(signals, undefined, { format: 'brief' })
    expect(brief.narrativeContext).toContain('[subscription] OpenShift Container Platform —')

    // Campaign format
    const campaign = templateAll(signals, undefined, { format: 'campaign' })
    expect(campaign.narrativeContext).toContain('[subscription] OpenShift Container Platform —')
  })

  test('respects maxNarrative cap', () => {
    const signals = Array(30).fill(null).map((_, i) => ({
      ...mockProductSignal,
      headline: `Signal ${i}`,
    }))

    const result = templateAll(signals, undefined, { format: 'playbook', maxNarrative: 5 })
    const lines = result.narrativeContext.split('\n')
    expect(lines.length).toBe(5)
  })

  test('productFilter excludes non-matching products', () => {
    const signals = [
      mockProductSignal, // OpenShift
      { ...mockProductSignal, metadata: { product: 'RHEL' } },
      { ...mockProductSignal, metadata: { product: 'Ansible' } },
    ]

    const result = templateAll(signals, undefined, { format: 'playbook', productFilter: ['openshift'] })

    // Only OpenShift signal should appear
    expect(result.narrativeContext).toContain('OpenShift')
    expect(result.narrativeContext).not.toContain('RHEL')
    expect(result.narrativeContext).not.toContain('Ansible')
  })

  test('intelligenceContext passthrough for campaigns', () => {
    const result = templateAll(
      [mockProductSignal],
      undefined,
      { format: 'campaign', intelligenceContext: 'Fortune 500 financial services company' }
    )

    expect(result.narrativeContext).toContain('Company Intelligence:')
    expect(result.narrativeContext).toContain('Fortune 500 financial services company')
  })
})

// ── Signal Routing Tests ────────────────────────────────────────────────────

describe('signal routing by metadata', () => {
  test('routes by hasCloudSpend metadata to cloud section', () => {
    const cloudSig: Signal = {
      source: 'unknown-source',
      type: 'subscription',
      headline: 'Test',
      detail: 'Test',
      timestamp: new Date().toISOString(),
      metadata: { hasCloudSpend: true, provider: 'GCP' },
    }

    const result = templateAll([cloudSig])
    expect(result.sections.cloudMarketplace).not.toBeNull()
    expect(result.sections.cloudMarketplace).toContain('GCP')
  })

  test('routes by severity metadata to cases section', () => {
    const caseSig: Signal = {
      source: 'unknown-source',
      type: 'support',
      headline: 'Test Case',
      detail: 'Test',
      timestamp: new Date().toISOString(),
      metadata: { severity: 1, caseNumber: '99999999' },
    }

    const result = templateAll([caseSig])
    expect(result.sections.cases).not.toBeNull()
    expect(result.sections.cases).toContain('99999999')
  })

  test('routes by renewal metadata to renewals section', () => {
    const renewalSig: Signal = {
      source: 'unknown-source',
      type: 'pipeline',
      headline: 'Test Renewal',
      detail: 'Test',
      timestamp: new Date().toISOString(),
      metadata: { renewal: true, stage: 'Negotiation', closeDate: '2026-12-31' },
    }

    const result = templateAll([renewalSig])
    expect(result.sections.renewals).not.toBeNull()
    expect(result.sections.renewals).toContain('Negotiation')
  })

  test('routes by confidence + context metadata to tech stack', () => {
    const techSig: Signal = {
      source: 'unknown-source',
      type: 'intelligence',
      headline: 'Test Tech',
      detail: 'Test',
      timestamp: new Date().toISOString(),
      metadata: { confidence: 'HIGH', context: 'evaluating' },
    }

    const result = templateAll([techSig])
    expect(result.sections.techStack).not.toBeNull()
    expect(result.sections.techStack).toContain('evaluating')
  })

  test('routes by redHatProducts metadata to product alignment', () => {
    const productSig: Signal = {
      source: 'unknown-source',
      type: 'subscription',
      headline: 'Test Product',
      detail: 'Test',
      timestamp: new Date().toISOString(),
      metadata: { redHatProducts: ['OpenShift', 'RHEL'] },
    }

    const result = templateAll([productSig])
    expect(result.sections.productAlignment).not.toBeNull()
  })
})

// ── Strategic Opportunities (ADR-030) ─────────────────────────────────────

describe('templateStrategicOpportunities', () => {
  const mockSolutionPlaySignal: Signal = {
    source: 'tech-stack',
    type: 'technology',
    headline: 'VMware (industry-tool, migrating_from)',
    detail: 'VMware virtualization platform',
    score: 0.85,
    timestamp: new Date().toISOString(),
    metadata: {
      customerSlug: 'acme',
      solutionPlayId: 'vmware-migration',
      solutionPlayName: 'VMware to OpenShift Virtualization Migration',
      solutionTdp: 'Virtualization',
      valueProps: ['Eliminate VMware licensing costs (40-60% reduction)'],
      solutionCategory: 'modernization',
      redHatProducts: ['ocp', 'rhel'],
      confidence: 'HIGH',
    },
  }

  const mockSecondPlaySignal: Signal = {
    source: 'tech-stack',
    type: 'technology',
    headline: 'ServiceNow (industry-tool, using)',
    detail: 'ITSM platform',
    score: 0.7,
    timestamp: new Date().toISOString(),
    metadata: {
      customerSlug: 'acme',
      solutionPlayId: 'itsm-automation',
      solutionPlayName: 'ITSM Automation with EDA',
      solutionTdp: 'Automation',
      valueProps: ['Reduce MTTR by automating triage'],
      solutionCategory: 'automation',
      redHatProducts: ['aap', 'rhel'],
      confidence: 'MEDIUM',
    },
  }

  test('renders solution plays table with TDP column', () => {
    const result = templateStrategicOpportunities([mockSolutionPlaySignal])
    expect(result).not.toBeNull()
    expect(result).toContain('### Solution Plays')
    expect(result).toContain('| TDP |')
    expect(result).toContain('Virtualization')
    expect(result).toContain('VMware to OpenShift Virtualization Migration')
    expect(result).toContain('ocp, rhel')
  })

  test('dedupes signals by solutionPlayId', () => {
    const duplicate: Signal = { ...mockSolutionPlaySignal, headline: 'vSphere (industry-tool, using)' }
    const result = templateStrategicOpportunities([mockSolutionPlaySignal, duplicate])
    expect(result).not.toBeNull()
    const playNameCount = (result!.match(/VMware to OpenShift Virtualization Migration/g) ?? []).length
    expect(playNameCount).toBe(1)
  })

  test('renders multiple plays', () => {
    const result = templateStrategicOpportunities([mockSolutionPlaySignal, mockSecondPlaySignal])
    expect(result).not.toBeNull()
    expect(result).toContain('Virtualization')
    expect(result).toContain('Automation')
  })

  test('returns null when no signals have solutionPlayId', () => {
    const noPlaySignal: Signal = {
      source: 'tech-stack',
      type: 'technology',
      headline: 'Docker',
      detail: 'Container runtime',
      timestamp: new Date().toISOString(),
      metadata: { confidence: 'HIGH' },
    }
    const result = templateStrategicOpportunities([noPlaySignal])
    expect(result).toBeNull()
  })

  test('renders marketplace opportunities sub-section when cloud signals present', () => {
    const cloudSignal: Signal = {
      source: 'cloud-marketplace',
      type: 'product-release',
      headline: 'AWS: ROSA',
      detail: 'Managed OpenShift on AWS',
      score: 0.9,
      timestamp: new Date().toISOString(),
      metadata: {
        provider: 'AWS',
        hasCloudSpend: true,
        acvPlus: 250000,
        eligiblePrograms: ['CPPO', 'EDP'],
        privateOfferEligible: true,
      },
    }
    const result = templateStrategicOpportunities([mockSolutionPlaySignal, cloudSignal])
    expect(result).toContain('### Marketplace Opportunities')
    expect(result).toContain('AWS')
    expect(result).toContain('Eligible')
  })

  test('renders version correlations sub-section when amplified signals present', () => {
    const versionSignal: Signal = {
      source: 'solution-intelligence',
      type: 'product-intel',
      headline: 'RHEL 8: 3 active cases + EOL Jun 2026',
      detail: 'Version correlation',
      score: 0.9,
      timestamp: new Date().toISOString(),
      metadata: {
        product: 'RHEL',
        activeCases: 3,
        lifecycleEvent: 'EOL 2026-06-30',
        amplified: true,
      },
    }
    const result = templateStrategicOpportunities([mockSolutionPlaySignal, versionSignal])
    expect(result).toContain('### Urgent Correlations')
    expect(result).toContain('RHEL')
  })

  test('templateAll includes strategicOpportunities in sections', () => {
    const result = templateAll([mockSolutionPlaySignal])
    expect(result.sections.strategicOpportunities).not.toBeNull()
    expect(result.deterministic).toContain('## Sales Alignment')
  })

  test('Sales Alignment renders before Product Alignment', () => {
    const productSignal: Signal = {
      source: 'subscriptions',
      type: 'subscription',
      headline: 'OpenShift',
      detail: 'Active subscription',
      timestamp: new Date().toISOString(),
      metadata: { product: 'OpenShift' },
    }
    const result = templateAll([mockSolutionPlaySignal, productSignal])
    const stratIdx = result.deterministic.indexOf('## Sales Alignment')
    const prodIdx = result.deterministic.indexOf('## Product Alignment')
    expect(stratIdx).toBeLessThan(prodIdx)
  })
})
