import { describe, it, expect } from 'bun:test'
import { generateCampaignFromStructured, renderMetricsTable, renderObjectiveBlock, type UsedObjective } from '../../src/campaign-html-template.ts'
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
  }

  it('should generate HTML with core structure and branding', () => {
    const html = generateCampaignFromStructured(minimalSelection, {
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

  it('should escape HTML special characters', () => {
    const html = generateCampaignFromStructured(minimalSelection, {
      ...minimalData,
      materialTitle: 'Test <script>',
      customerName: 'Test & Co.',
    })

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
  })

  it('should include intelligence dashboard metrics', () => {
    const html = generateCampaignFromStructured(minimalSelection, minimalData)
    expect(html).toContain('Annual Revenue')
    expect(html).toContain('Employees')
  })

  it('should apply Red Hat brand color throughout template', () => {
    const html = generateCampaignFromStructured(minimalSelection, minimalData)
    const colorMatches = html.match(/#c41e3a/g)
    expect(colorMatches).not.toBeNull()
    expect(colorMatches!.length).toBeGreaterThan(5)
  })

  it('should handle missing sections without throwing errors', () => {
    const html = generateCampaignFromStructured(minimalSelection, minimalData)
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
        peerProof: '',
        challengerDataPoint: '',
        signalBridge: '',
        customOpener: '',
        featureApplications: [],
        referenceLine: '',
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
    sourceUrls: [],
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
  })

  it('includes voice profile email/phone in sign-off when no named AE exists', () => {
    const html = generateCampaignFromStructured(minimalSelection, {
      ...createMinimalData(),
      aeEmail: 'test@redhat.com',
      aePhone: '555-1234',
    })

    expect(html).toContain('Account Executive')
    expect(html).toContain('test@redhat.com')
    expect(html).toContain('M: 555-1234')
  })

  it('includes fallback contact when no named AE and no voice profile contact info', () => {
    const html = generateCampaignFromStructured(minimalSelection, createMinimalData())

    expect(html).toContain('Account Executive')
    // Should have SOME contact info - either a fallback email or message
    const hasContactInfo = html.includes('@redhat.com') || html.includes('Contact your Red Hat account team')
    expect(hasContactInfo).toBe(true)
  })

  it('derives email from name when named AE exists', () => {
    const html = generateCampaignFromStructured(minimalSelection, {
      ...createMinimalData(),
      accountTeam: [{ name: 'Jane Doe', role: 'ae', title: 'Account Executive' }],
    })

    expect(html).toContain('Jane Doe')
    expect(html).toContain('jdoe@redhat.com')
  })
})
