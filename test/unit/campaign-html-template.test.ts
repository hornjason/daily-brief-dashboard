import { describe, it, expect } from 'bun:test'
import { generateCampaignFromStructured, renderMetricsTable, renderObjectiveBlock, assembleEmail, isInternalUrl, type UsedObjective } from '../../src/campaign-html-template.ts'
import { toBlock } from '../../src/lib/block-output.ts'
import { LinkRegistry } from '../../src/lib/link-registry.ts'
import type { PersonaBrief } from '../../src/lib/persona-selector.ts'
import type { CustomerObjectiveProfile } from '../../src/modules/intelligence-module.ts'

describe('generateCampaignFromStructured — core behavior', () => {
  const minimalSelection = {
    campaignSummary: 'Test campaign',
    customerContext: 'Test context',
    positioning: 'Test positioning',
    emails: [] as any[],
  }

  const minimalData = {
    resolvedExecs: [],
    signals: [],
    voiceProfile: null,
    accountTeam: [],
    subscriptions: [],
    structuredPlays: [],
    customerName: 'Test Corp',
    materialTitle: 'Test Material',
    materialUrl: 'https://test.com',
    generatedDate: 'May 13, 2026',
    enablePolish: false,
  }

  it('should generate HTML with core structure and branding', async () => {
    const html = await generateCampaignFromStructured(minimalSelection, {
      ...minimalData,
      materialTitle: 'Cloud Migration Strategy Guide',
      materialUrl: 'https://docs.google.com/document/d/test123/edit',
      customerName: 'Test Corporation',
      accountTeam: [{ name: 'Carolanne Farrell', title: 'Account Executive', role: 'ae' }],
    })

    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('#c41e3a')
    expect(html).toContain('Content Campaign: Cloud Migration Strategy Guide')
    expect(html).toContain('Test Corporation')
    expect(html).toContain('Carolanne Farrell')
    expect(html).toContain('Email Templates by Role')
  })

  it('should escape HTML special characters', async () => {
    const html = await generateCampaignFromStructured(minimalSelection, {
      ...minimalData,
      materialTitle: 'Test <script>',
      customerName: 'Test & Co.',
    })

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
  })

  it('should include intelligence dashboard metrics', async () => {
    const html = await generateCampaignFromStructured(minimalSelection, minimalData)
    expect(html).toContain('Annual Revenue')
    expect(html).toContain('Employees')
  })

  it('should apply Red Hat brand color throughout template', async () => {
    const html = await generateCampaignFromStructured(minimalSelection, minimalData)
    const colorMatches = html.match(/#c41e3a/g)
    expect(colorMatches).not.toBeNull()
    expect(colorMatches!.length).toBeGreaterThan(5)
  })

  it('should handle missing sections without throwing errors', async () => {
    const html = await generateCampaignFromStructured(minimalSelection, minimalData)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('</html>')
  })
})

describe('renderMetricsTable with Pass 0 briefs', () => {
  const mockBriefs: PersonaBrief[] = [
    {
      role: 'CISO',
      suggestedTitle: 'Chief Information Security Officer',
      why: 'test',
      objectiveMatch: 'Reduce risk exposure by 40%',
      peerProofCandidates: [],
      timingTrigger: 'Q3 budget',
      valueProposition: 'test',
      featureKeys: [],
      competitiveContext: null,
      relationshipPath: 'test',
      installedBase: 'test',
      suppressTriggers: [],
      confidence: { overall: 'HIGH' },
    },
    {
      role: 'VP_INFRA',
      suggestedTitle: 'VP of Infrastructure',
      why: 'test',
      objectiveMatch: 'Migrate 80% of workloads to hybrid cloud',
      peerProofCandidates: [],
      timingTrigger: 'EOY deadline',
      valueProposition: 'test',
      featureKeys: [],
      competitiveContext: null,
      relationshipPath: 'test',
      installedBase: 'test',
      suppressTriggers: [],
      confidence: { overall: 'MEDIUM' },
    },
  ]

  const fallbackObjectives: UsedObjective[] = [
    { objective: 'Fallback objective', metric: 'metric1', category: 'Financial', usedIn: 'John (Executive)' },
  ]

  it('renders all Pass 0 briefs as table rows', () => {
    const html = renderMetricsTable(fallbackObjectives, mockBriefs)
    expect(html).toContain('Business Metrics Used in Outreach')
    expect(html).toContain('<tr')
    const rowCount = (html.match(/<tr/g) || []).length
    expect(rowCount).toBe(3) // header + 2 briefs
  })

  it('renders Pass 0 brief role in the Category column', () => {
    const html = renderMetricsTable([], mockBriefs)
    expect(html).toContain('CISO')
    expect(html).toContain('VP_INFRA')
  })

  it('renders Pass 0 brief objectiveMatch in the Metric column', () => {
    const html = renderMetricsTable([], mockBriefs)
    expect(html).toContain('Reduce risk exposure by 40%')
    expect(html).toContain('Migrate 80% of workloads to hybrid cloud')
  })

  it('renders Pass 0 brief suggestedTitle in the Used In column', () => {
    const html = renderMetricsTable([], mockBriefs)
    expect(html).toContain('Chief Information Security Officer')
    expect(html).toContain('VP of Infrastructure')
  })

  it('falls back to usedObjectives when Pass 0 briefs not provided', () => {
    const html = renderMetricsTable(fallbackObjectives)
    expect(html).toContain('Fallback objective')
    expect(html).toContain('Financial')
    expect(html).not.toContain('CISO')
  })

  it('falls back to usedObjectives when Pass 0 briefs is empty array', () => {
    const html = renderMetricsTable(fallbackObjectives, [])
    expect(html).toContain('Fallback objective')
    expect(html).not.toContain('CISO')
  })
})

describe('renderObjectiveBlock prefix stripping (#1095)', () => {
  const mockProfile: CustomerObjectiveProfile = {
    financial: [
      {
        objective: 'Revenue Trajectory: 14.5% growth year-over-year',
        metric: '14.5%',
        priority: 'HIGH',
        source: 'Financial Metrics',
        confidence: 'HIGH',
      },
      {
        objective: 'Raised Full-Year 2026 Guidance — Management increased revenue growth guidance to 16-18%',
        metric: '16-18%',
        priority: 'HIGH',
        source: 'Strategic Initiatives',
        confidence: 'HIGH',
      },
      {
        objective: 'Profitability: Operating margin improved to 22.3%',
        metric: '22.3%',
        priority: 'HIGH',
        source: 'Financial Metrics',
        confidence: 'HIGH',
      },
    ],
    security: [
      {
        objective: 'Cybersecurity Enhancement — Invested $50M in threat detection systems',
        metric: '$50M',
        priority: 'MED',
        source: 'Strategic Initiatives',
        confidence: 'HIGH',
      },
    ],
    operational: [],
    innovation: [],
    growth: [],
  }

  const campaignTheme = {
    threat: 'infrastructure sprawl',
    solution: 'consolidated platform approach',
  }

  it('strips "Revenue Trajectory:" prefix from financial objectives', () => {
    const result = renderObjectiveBlock(mockProfile, campaignTheme)
    expect(result).not.toContain('Revenue Trajectory:')
    expect(result).toContain('14.5% growth')
  })

  it('strips "Raised Full-Year XXXX Guidance —" prefix from financial objectives', () => {
    const mockWithGuidance: CustomerObjectiveProfile = {
      ...mockProfile,
      financial: [mockProfile.financial[1]], // Only the guidance entry
    }
    const result = renderObjectiveBlock(mockWithGuidance, campaignTheme)
    expect(result).not.toContain('Raised Full-Year 2026 Guidance —')
    expect(result).not.toContain('Raised Full-Year')
    expect(result).toContain('Management increased revenue growth guidance')
  })

  it('strips "Profitability:" prefix from financial objectives', () => {
    const mockWithProfitability: CustomerObjectiveProfile = {
      ...mockProfile,
      financial: [mockProfile.financial[2]], // Only the profitability entry
    }
    const result = renderObjectiveBlock(mockWithProfitability, campaignTheme)
    expect(result).not.toContain('Profitability:')
    expect(result).toContain('Operating margin')
  })

  it('strips category prefix from security objectives with em-dash', () => {
    const mockWithSecurity: CustomerObjectiveProfile = {
      ...mockProfile,
      security: [mockProfile.security[0]],
      financial: [],
    }
    const result = renderObjectiveBlock(mockWithSecurity, campaignTheme)
    expect(result).not.toContain('Cybersecurity Enhancement —')
    expect(result).toContain('Invested $50M')
  })

  it('produces natural-reading sentences without visible prefixes', () => {
    const result = renderObjectiveBlock(mockProfile, campaignTheme)
    // Verify sentence structure looks natural - no raw category labels
    expect(result).toMatch(/^(With|Given|As)\s+[^:]+[,.]/)
    // Should not have double colons or em-dashes mid-sentence indicating leaked prefixes
    expect(result).not.toMatch(/:\s*—/)
    expect(result).not.toMatch(/—\s*—/)
  })
})

describe('generateCampaignFromStructured — sign-off contact info (#1129)', () => {
  const minimalSelection = {
    customerContext: 'Test customer context',
    emails: [
      {
        recipientName: 'John Smith',
        tier: 'executive' as const,
        subject: 'Test Subject',
        signalIndex: 0,
        featureKeys: [],
        peerProof: null,
      },
    ],
  }

  // Helper to create fresh data object for each test (avoid mutation across tests)
  const createMinimalData = () => ({
    materialTitle: 'Test Material',
    materialUrl: 'https://example.com/material',
    customerName: 'Test Corp',
    generatedDate: '2026-08-17',
    accountTeam: [],
    resolvedExecs: [{ name: 'John Smith', title: 'CTO', email: 'john@example.com', linkedIn: '' }],
    signals: [{ headline: 'Test Signal', metadata: {} }],
    subscriptions: [],
    structuredPlays: [],
    voiceProfile: undefined,
    objectiveProfile: undefined,
    rawSignals: undefined,
    pass0Briefs: undefined,
    fitRationale: undefined,
    campaignThreat: undefined,
    campaignSolution: undefined,
    signalQuality: undefined,
    preMatchedMetrics: undefined,
    preMatchedPeerProofs: undefined,
    sourceAttributions: undefined,
    enablePolish: false,
  })

  it('includes voice profile email/phone in sign-off when no named AE exists', async () => {
    const html = await generateCampaignFromStructured(minimalSelection, {
      ...createMinimalData(),
      aeEmail: 'test@redhat.com',
      aePhone: '555-1234',
    })

    expect(html).toContain('Account Executive')
    expect(html).toContain('test@redhat.com')
    expect(html).toContain('M: 555-1234')
  })

  it('includes fallback contact when no named AE and no voice profile contact info', async () => {
    const html = await generateCampaignFromStructured(minimalSelection, createMinimalData())

    expect(html).toContain('Account Executive')
    // Should have SOME contact info - either a fallback email or message
    const hasContactInfo = html.includes('@redhat.com') || html.includes('Contact your Red Hat account team')
    expect(hasContactInfo).toBe(true)
  })

  it('derives email from name when named AE exists', async () => {
    const html = await generateCampaignFromStructured(minimalSelection, {
      ...createMinimalData(),
      accountTeam: [{ name: 'Jane Doe', role: 'ae', title: 'Account Executive' }],
    })

    expect(html).toContain('Jane Doe')
    expect(html).toContain('jdoe@redhat.com')
  })
})

describe('email body formatting — bullets and links (#1149)', () => {
  it('assembleEmail preserves newlines after word-limit hard trim', () => {
    const featureBullets = [
      '• [Ansible Automation Platform](https://www.redhat.com/en/technologies/management/ansible) — unifies automation across hybrid environments',
      '• [Event-Driven Ansible](https://www.redhat.com/en/technologies/management/ansible/event-driven) — triggers automated responses in real time',
      '• [Ansible Lightspeed](https://www.redhat.com/en/technologies/management/ansible/ansible-lightspeed) — accelerates playbook creation with AI',
    ].join('\n')

    const blocks = {
      opener: toBlock('Hi Sarah, I noticed your team is expanding automation initiatives across multiple business units.'),
      signalBridge: toBlock('Your recent investment in hybrid cloud infrastructure creates an opportunity to consolidate automation tooling.'),
      relationshipLine: toBlock('Your teams already rely on OpenShift and RHEL.'),
      featureBullets: toBlock(featureBullets),
      referenceLine: toBlock('For a deeper look, see [Automation Strategy Guide](https://www.redhat.com/en/resources/automation-guide).'),
      peerPattern: toBlock('Teams in financial services have reduced deployment time by 60% using a unified automation platform. The pattern is consistent across regulated industries.'),
      challengerFrame: toBlock('Without consolidation, automation sprawl typically increases operational costs by 30% within 18 months.'),
      cta: toBlock('Worth a 15-minute conversation to map this to your environment?'),
      signOff: toBlock('Best,\nCarolanne Farrell'),
    }

    const voiceTokens = {
      formality: 'professional' as const,
      assertionLevel: 'confident' as const,
      wordBudget: { exec: 80, manager: 200 },
    }

    const result = assembleEmail(blocks, 'executive', voiceTokens, 'Sarah')
    expect(result.body).toContain('\n')
  })

  it('assembleEmail body has no inline bullet characters after hard trim', () => {
    const featureBullets = [
      '• [AAP](https://www.redhat.com/aap) — unifies automation',
      '• [EDA](https://www.redhat.com/eda) — triggers responses',
    ].join('\n')

    const blocks = {
      opener: toBlock('Hi Sarah, expanding automation.'),
      signalBridge: toBlock('Investment in hybrid cloud creates opportunity.'),
      relationshipLine: toBlock('Your teams rely on OpenShift.'),
      featureBullets: toBlock(featureBullets),
      referenceLine: toBlock(''),
      peerPattern: toBlock('Financial services reduced deploy time by 60%.'),
      challengerFrame: toBlock('Sprawl increases costs by 30%.'),
      cta: toBlock('Worth a call?'),
      signOff: toBlock('Best,\nCarolanne'),
    }

    const voiceTokens = {
      formality: 'professional' as const,
      assertionLevel: 'confident' as const,
      wordBudget: { exec: 30, manager: 200 },
    }

    const result = assembleEmail(blocks, 'executive', voiceTokens, 'Sarah')
    const lines = result.body.split('\n').filter(l => l.trim().length > 0)
    for (const line of lines) {
      const inlineBullets = (line.match(/•/g) || []).length
      expect(inlineBullets).toBeLessThanOrEqual(1)
    }
  })

  it('feature bullets render as styled elements with anchor tags in full pipeline', async () => {
    const html = await generateCampaignFromStructured(
      {
        customerContext: 'Test',
        emails: [{
          recipientName: 'John Smith',
          tier: 'manager' as const,
          subject: 'Test',
          signalIndex: 0,
          featureKeys: ['ansible-automation-platform', 'event-driven-ansible'],
          peerProof: null,
        }],
      },
      {
        materialTitle: 'Test',
        materialUrl: 'https://example.com',
        customerName: 'Test Corp',
        generatedDate: '2026-08-18',
        accountTeam: [{ name: 'Test AE', role: 'ae', title: 'Account Executive' }],
        resolvedExecs: [{ name: 'John Smith', title: 'CTO', email: 'john@test.com', linkedIn: '' }],
        signals: [{ headline: 'Test Signal', metadata: {} }],
        subscriptions: [],
        linkRegistry: new LinkRegistry([{ url: 'https://www.redhat.com/en/resources/guide', title: 'Red Hat Guide' }]),
        structuredPlays: [],
        enablePolish: false,
      },
    )

    const styledBullets = (html.match(/position: absolute[^>]*>•<\/span>/g) || []).length
    expect(styledBullets).toBeGreaterThanOrEqual(2)

    const anchorMatches = html.match(/<a href="https:\/\/www\.redhat\.com[^"]*"[^>]*>/g) || []
    expect(anchorMatches.length).toBeGreaterThanOrEqual(2)
  })

  it('referenceLine from linkRegistry renders as clickable anchor tags', async () => {
    const html = await generateCampaignFromStructured(
      {
        customerContext: 'Test',
        emails: [{
          recipientName: 'John Smith',
          tier: 'manager' as const,
          subject: 'Test',
          signalIndex: 0,
          featureKeys: [],
          peerProof: null,
        }],
      },
      {
        materialTitle: 'Test',
        materialUrl: 'https://example.com',
        customerName: 'Test Corp',
        generatedDate: '2026-08-18',
        accountTeam: [{ name: 'Test AE', role: 'ae', title: 'Account Executive' }],
        resolvedExecs: [{ name: 'John Smith', title: 'CTO', email: 'john@test.com', linkedIn: '' }],
        signals: [{ headline: 'Test Signal', metadata: {} }],
        subscriptions: [],
        linkRegistry: new LinkRegistry([{ url: 'https://www.hklaw.com/en/insights/publications/2026/sb-122-analysis', title: 'SB 122 Analysis' }]),
        structuredPlays: [],
        enablePolish: false,
      },
    )

    expect(html).toContain('hklaw.com')
  })
})

describe('internal URLs in Reference Materials (#1150)', () => {
  const baseSelection = {
    campaignSummary: 'Test campaign',
    customerContext: 'Test context',
    positioning: 'Test positioning',
    emails: [] as any[],
  }

  const baseData = {
    resolvedExecs: [],
    signals: [],
    voiceProfile: null,
    accountTeam: [],
    subscriptions: [],
    structuredPlays: [],
    customerName: 'Test Corp',
    materialTitle: 'SSP Deck',
    materialUrl: 'https://docs.google.com/presentation/d/abc123',
    generatedDate: '2026-08-19',
    enablePolish: false,
  }

  it('renders Google Docs URL in reference materials section', async () => {
    const html = await generateCampaignFromStructured(baseSelection, {
      ...baseData,
      referenceMaterials: [
        { resource: 'SSP Deck - Cloud Strategy', url: 'https://docs.google.com/presentation/d/abc123', keyTakeaway: 'Strategic selling deck for cloud migration' },
        { resource: 'Portal Analysis', url: 'https://access.redhat.com/articles/12345', keyTakeaway: 'Customer support case trends' },
      ],
    })

    expect(html).toContain('docs.google.com/presentation/d/abc123')
    expect(html).toContain('access.redhat.com/articles/12345')
    expect(html).toContain('SSP Deck - Cloud Strategy')
    expect(html).toContain('Portal Analysis')
  })

  it('isInternalUrl still identifies internal domains', () => {
    expect(isInternalUrl('https://docs.google.com/document/d/xyz')).toBe(true)
    expect(isInternalUrl('https://drive.google.com/file/d/xyz')).toBe(true)
    expect(isInternalUrl('https://slides.google.com/presentation/d/xyz')).toBe(true)
    expect(isInternalUrl('https://access.redhat.com/articles/12345')).toBe(true)
    expect(isInternalUrl('https://salesforce.com/opp/123')).toBe(true)
    expect(isInternalUrl('https://www.gartner.com/report/123')).toBe(false)
  })
})
