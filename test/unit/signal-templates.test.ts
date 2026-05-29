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
  templateUpcomingEvents,
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
  type: 'product-intel',
  headline: 'AWS Marketplace: 2 offerings, 2 programs',
  detail: 'ROSA\nRHEL\nPROGRAM: Commit\nPROGRAM: EDP',
  score: 0.90,
  timestamp: new Date().toISOString(),
  metadata: {
    provider: 'AWS',
    offeringType: 'summary',
    hasCloudSpend: true,
    hasCloudIntel: true,
    acvPlus: 125000,
    offerings: [
      { name: 'OpenShift', availability: 'Available today' },
      { name: 'RHEL', availability: 'Available today' },
    ],
    programs: [
      { name: 'Commit', description: 'Committed spend program' },
      { name: 'EDP', description: 'Enterprise Discount Program' },
    ],
    incentives: [],
    newCountries: [],
    partnerships: [],
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

  test('renders condensed cloud marketplace with spend and programs', () => {
    const result = templateCloudMarketplace([mockCloudSignal])
    expect(result).toContain('**AWS**')
    expect(result).toContain('$125,000 Red Hat marketplace spend')
    expect(result).toContain('Program: Commit')
    expect(result).toContain('Program: EDP')
    expect(result).toContain('Red Hat offerings on AWS Marketplace')
  })

  test('filters out providers without spend or intel', () => {
    const generalSignal: Signal = {
      ...mockCloudSignal,
      metadata: { ...mockCloudSignal.metadata, provider: 'Oracle', hasCloudSpend: false, hasCloudIntel: false, acvPlus: 0 },
    }
    const result = templateCloudMarketplace([generalSignal])
    expect(result).toBeNull()
  })

  test('shows intel-based providers with positioning message', () => {
    const intelSignal: Signal = {
      ...mockCloudSignal,
      metadata: { ...mockCloudSignal.metadata, provider: 'Azure', hasCloudSpend: false, hasCloudIntel: true, acvPlus: 0 },
    }
    const result = templateCloudMarketplace([intelSignal])
    expect(result).toContain('**Azure**')
    expect(result).toContain('customer uses Azure, no Red Hat marketplace spend yet')
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

// ── Upcoming Events (#377) ─────────────────────────────────────────────────

describe('templateUpcomingEvents', () => {
  const mockEventSignal: Signal = {
    source: 'rh-events',
    type: 'event',
    headline: 'Red Hat Summit 2026',
    detail: 'Boston, MA • Jun 15-17, 2026',
    score: 0.7,
    timestamp: '2026-06-15',
    metadata: {
      format: 'in-person',
      location: 'Boston, MA',
      region: 'northeast',
    },
  }

  test('returns null when no event signals', () => {
    const result = templateUpcomingEvents([mockProductSignal, mockCloudSignal])
    expect(result).toBeNull()
  })

  test('renders events table with format and location', () => {
    const result = templateUpcomingEvents([mockEventSignal])
    expect(result).not.toBeNull()
    expect(result).toContain('| Event | Date | Format | Location |')
    expect(result).toContain('Red Hat Summit 2026')
    expect(result).toContain('in-person')
    expect(result).toContain('Boston, MA')
  })

  test('handles virtual events without location', () => {
    const virtualEvent: Signal = {
      ...mockEventSignal,
      headline: 'OpenShift Webinar',
      metadata: { format: 'virtual', location: '', region: 'national' },
    }
    const result = templateUpcomingEvents([virtualEvent])
    expect(result).not.toBeNull()
    expect(result).toContain('virtual')
    expect(result).toContain('Virtual')
  })

  test('caps at 8 rows', () => {
    const signals = Array(12).fill(null).map((_, i) => ({
      ...mockEventSignal,
      headline: `Event ${i}`,
    }))
    const result = templateUpcomingEvents(signals)
    const dataRows = result!.split('\n').filter(l => l.startsWith('|')).length - 2 // minus header + separator
    expect(dataRows).toBeLessThanOrEqual(8)
  })

  test('templateAll includes events section', async () => {
    const result = await templateAll([mockEventSignal])
    expect(result.deterministic).toContain('## Upcoming Events')
    expect(result.sections.upcomingEvents).not.toBeNull()
  })
})

// ── Account Plan (#380) ───────────────────────────────────────────────────

describe('templateAccountPlan', () => {
  const mockAccountPlanSignal: Signal = {
    source: 'account-plan',
    type: 'account-plan',
    headline: 'Acme Corp Account Plan',
    detail: 'Key objectives: cloud migration to OpenShift, automation with Ansible, security modernization with ACS.',
    score: 0.9,
    timestamp: new Date().toISOString(),
    metadata: {
      customerSlug: 'acme-corp',
      contentLength: 2500,
    },
  }

  test('templateAll includes account plan in deterministic output for playbook', async () => {
    const result = await templateAll([mockAccountPlanSignal], undefined, { format: 'playbook' })
    expect(result.deterministic).toContain('## Account Plan')
    expect(result.deterministic).toContain('cloud migration')
    expect(result.sections.accountPlan).not.toBeNull()
  })

  test('templateAll includes account plan in deterministic output for brief', async () => {
    const result = await templateAll([mockAccountPlanSignal], undefined, { format: 'brief' })
    expect(result.deterministic).toContain('## Account Plan')
  })

  test('account plan does not appear in campaign format', async () => {
    const result = await templateAll([mockAccountPlanSignal], undefined, { format: 'campaign' })
    expect(result.deterministic).not.toContain('## Account Plan')
  })
})

describe('templateAll', () => {
  test('assembles all sections with signals', async () => {
    const signals = [
      mockProductSignal,
      mockCloudSignal,
      mockRenewalSignal,
      mockCaseSignal,
      mockTechSignal,
    ]

    const result = await templateAll(signals, mockAccountTeam)

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

  test('omits sections with no matching signals', async () => {
    const result = await templateAll([mockProductSignal])

    expect(result.deterministic).toContain('## Product Alignment')
    expect(result.deterministic).not.toContain('## Cloud Marketplace')
    expect(result.deterministic).not.toContain('## Renewals & Pipeline')

    expect(result.sections.productAlignment).not.toBeNull()
    expect(result.sections.cloudMarketplace).toBeNull()
    expect(result.sections.renewals).toBeNull()
  })

  test('narrativeContext format varies by consumer', async () => {
    const signals = [mockProductSignal, mockCloudSignal]

    // Playbook format
    const playbook = await templateAll(signals, undefined, { format: 'playbook' })
    expect(playbook.narrativeContext).toContain('[subscriptions] OpenShift Container Platform: Customer uses OpenShift')

    // Brief format
    const brief = await templateAll(signals, undefined, { format: 'brief' })
    expect(brief.narrativeContext).toContain('[subscription] OpenShift Container Platform —')

    // Campaign format
    const campaign = await templateAll(signals, undefined, { format: 'campaign' })
    expect(campaign.narrativeContext).toContain('[subscription] OpenShift Container Platform —')
  })

  test('respects maxNarrative cap', async () => {
    const signals = Array(30).fill(null).map((_, i) => ({
      ...mockProductSignal,
      headline: `Signal ${i}`,
    }))

    const result = await templateAll(signals, undefined, { format: 'playbook', maxNarrative: 5 })
    const lines = result.narrativeContext.split('\n')
    expect(lines.length).toBe(5)
  })

  test('productFilter excludes non-matching products', async () => {
    const signals = [
      mockProductSignal, // OpenShift
      { ...mockProductSignal, metadata: { product: 'RHEL' } },
      { ...mockProductSignal, metadata: { product: 'Ansible' } },
    ]

    const result = await templateAll(signals, undefined, { format: 'playbook', productFilter: ['openshift'] })

    // Only OpenShift signal should appear
    expect(result.narrativeContext).toContain('OpenShift')
    expect(result.narrativeContext).not.toContain('RHEL')
    expect(result.narrativeContext).not.toContain('Ansible')
  })

  test('intelligenceContext passthrough for campaigns', async () => {
    const result = await templateAll(
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
  test('routes by hasCloudSpend metadata to cloud section', async () => {
    const cloudSig: Signal = {
      source: 'unknown-source',
      type: 'subscription',
      headline: 'Test',
      detail: 'Test',
      timestamp: new Date().toISOString(),
      metadata: { hasCloudSpend: true, provider: 'GCP' },
    }

    const result = await templateAll([cloudSig])
    expect(result.sections.cloudMarketplace).not.toBeNull()
    expect(result.sections.cloudMarketplace).toContain('GCP')
  })

  test('routes by severity metadata to cases section', async () => {
    const caseSig: Signal = {
      source: 'unknown-source',
      type: 'support',
      headline: 'Test Case',
      detail: 'Test',
      timestamp: new Date().toISOString(),
      metadata: { severity: 1, caseNumber: '99999999' },
    }

    const result = await templateAll([caseSig])
    expect(result.sections.cases).not.toBeNull()
    expect(result.sections.cases).toContain('99999999')
  })

  test('routes by renewal metadata to renewals section', async () => {
    const renewalSig: Signal = {
      source: 'unknown-source',
      type: 'pipeline',
      headline: 'Test Renewal',
      detail: 'Test',
      timestamp: new Date().toISOString(),
      metadata: { renewal: true, stage: 'Negotiation', closeDate: '2026-12-31' },
    }

    const result = await templateAll([renewalSig])
    expect(result.sections.renewals).not.toBeNull()
    expect(result.sections.renewals).toContain('Negotiation')
  })

  test('routes by confidence + context metadata to tech stack', async () => {
    const techSig: Signal = {
      source: 'unknown-source',
      type: 'intelligence',
      headline: 'Test Tech',
      detail: 'Test',
      timestamp: new Date().toISOString(),
      metadata: { confidence: 'HIGH', context: 'evaluating' },
    }

    const result = await templateAll([techSig])
    expect(result.sections.techStack).not.toBeNull()
    expect(result.sections.techStack).toContain('evaluating')
  })

  test('routes by redHatProducts metadata to product alignment', async () => {
    const productSig: Signal = {
      source: 'unknown-source',
      type: 'subscription',
      headline: 'Test Product',
      detail: 'Test',
      timestamp: new Date().toISOString(),
      metadata: { redHatProducts: ['OpenShift', 'RHEL'] },
    }

    const result = await templateAll([productSig])
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

  test('templateAll includes strategicOpportunities in sections', async () => {
    const result = await templateAll([mockSolutionPlaySignal])
    expect(result.sections.strategicOpportunities).not.toBeNull()
    expect(result.deterministic).toContain('## Sales Alignment')
  })

  test('Sales Alignment renders before Product Alignment', async () => {
    const productSignal: Signal = {
      source: 'subscriptions',
      type: 'subscription',
      headline: 'OpenShift',
      detail: 'Active subscription',
      timestamp: new Date().toISOString(),
      metadata: { product: 'OpenShift' },
    }
    const result = await templateAll([mockSolutionPlaySignal, productSignal])
    const stratIdx = result.deterministic.indexOf('## Sales Alignment')
    const prodIdx = result.deterministic.indexOf('## Product Alignment')
    expect(stratIdx).toBeLessThan(prodIdx)
  })
})
