/**
 * test/unit/evidence-block-builder.test.ts
 * Unit tests for evidence-block-builder.ts (#643)
 *
 * TDD Red Phase: Tests written first, expected to FAIL until implementation.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import type { ScoredTactic, EvidenceItem as TacticEvidenceItem } from '../../src/lib/tactic-scorer.ts'
import type { Signal } from '../../src/feature-module-registry.ts'
import type { AccountTeamMember } from '../../src/types.ts'

// ── Import the module under test ────────────────────────────────────────────
import {
  buildEvidenceBlocks,
  extractKeyDataPoint,
  type EvidenceBlock,
  type EvidenceItem,
  type DataPoint,
  type Lever,
} from '../../src/lib/evidence-block-builder.ts'

// ── Test fixtures ───────────────────────────────────────────────────────────

function makeScoredTactic(overrides: Partial<ScoredTactic> = {}): ScoredTactic {
  return {
    name: 'RHEL Migration',
    parentTdp: 'Platform Migration',
    compositeScore: 0.85,
    evidenceTrail: [
      { fact: '47 RHEL 7 subscriptions, EOS 2027-06-30', module: 'subscriptions', recency: 'current', weight: 0.9 },
      { fact: 'Case 12345678: kernel panic on RHEL 7.9', module: 'cases', recency: '2d ago', weight: 0.7 },
    ],
    signalDensity: { populated: 8, total: 12 },
    assets: [{ name: 'Migration Guide', url: 'https://example.com/guide', type: 'guide' }],
    ...overrides,
  }
}

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    source: 'cloud-marketplace',
    type: 'product-intel',
    headline: 'AWS Marketplace: RHEL offerings',
    detail: 'INCENTIVE: AWS migration credit 25%',
    timestamp: new Date().toISOString(),
    rawRelevance: 0.8,
    metadata: {
      provider: 'AWS',
      hasCloudSpend: true,
      customerSlug: 'acme-corp',
      incentives: [
        { name: 'AWS migration credit 25%', value: '25% off first year', url: 'https://aws.example.com/credit', description: 'Migration credit for RHEL', validThrough: '2026-12-31' },
      ],
      programs: [
        { name: 'Cloud Access Program', url: 'https://redhat.example.com/cloud-access', description: 'Run existing RHEL subs on AWS', validThrough: '2027-01-15' },
      ],
    },
    ...overrides,
  }
}

function makeEcosystemSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    source: 'ecosystem-catalog',
    type: 'intelligence',
    headline: 'CrowdStrike + Red Hat — Falcon Operator',
    detail: 'Automated endpoint protection for OpenShift\n**Resources:**\n- [Interactive Lab](https://labs.example.com/crowdstrike) (lab)',
    timestamp: new Date().toISOString(),
    url: 'https://catalog.redhat.com/crowdstrike',
    rawRelevance: 0.6,
    metadata: {
      partnerName: 'CrowdStrike',
      platform: 'OpenShift Container Platform',
      categories: ['Security'],
      coSell: true,
      resourceTypes: ['lab', 'solution-brief'],
      solutionName: 'Falcon Operator',
      customerSlug: 'acme-corp',
    },
    ...overrides,
  }
}

function makePartnerSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    source: 'partner-catalog',
    type: 'intelligence',
    headline: 'Cisco — matches OpenShift Container Platform',
    detail: 'Specializations: OpenShift Container Platform\nGeo: NA (US)\nCatalog: https://partner.example.com/cisco',
    timestamp: new Date().toISOString(),
    url: 'https://partner.example.com/cisco',
    rawRelevance: 0.7,
    metadata: {
      partnerName: 'Cisco',
      specializations: ['OpenShift Container Platform'],
      certifications: ['OpenShift Certified'],
      catalogUrl: 'https://partner.example.com/cisco',
      matchedProducts: ['OpenShift Container Platform'],
      customerSlug: 'acme-corp',
    },
    ...overrides,
  }
}

const mockTeam: AccountTeamMember[] = [
  { name: 'Alice Johnson', title: 'Account Executive', role: 'ae' },
  { name: 'Bob Smith', title: 'Account Solution Architect', role: 'asa' },
  { name: 'Carol Davis', title: 'RHEL SSP', role: 'ssp' },
  { name: 'Dave Lee', title: 'OpenShift SSP', role: 'ssp' },
]

// ── Tests ───────────────────────────────────────────────────────────────────

describe('buildEvidenceBlocks()', () => {
  const scoredTactics: ScoredTactic[] = [
    makeScoredTactic({ name: 'RHEL Migration', compositeScore: 0.85 }),
    makeScoredTactic({ name: 'OpenShift Expansion', compositeScore: 0.72, parentTdp: 'Cloud Native', evidenceTrail: [
      { fact: '12 OpenShift subscriptions, renewal 2026-09-15', module: 'subscriptions', recency: 'current', weight: 0.8 },
    ] }),
    makeScoredTactic({ name: 'Ansible Automation', compositeScore: 0.65, parentTdp: 'IT Automation', evidenceTrail: [
      { fact: '5 Ansible subscriptions', module: 'subscriptions', recency: 'current', weight: 0.6 },
    ] }),
    makeScoredTactic({ name: 'Low Priority Play', compositeScore: 0.30 }),
  ]

  const signals: Signal[] = [
    makeSignal(),
    makeEcosystemSignal(),
    makePartnerSignal(),
  ]

  it('AC-1: returns EvidenceBlock[] with correct interface shape', () => {
    const blocks = buildEvidenceBlocks(scoredTactics, signals, mockTeam)
    expect(blocks.length).toBeGreaterThan(0)

    const block = blocks[0]
    expect(block).toHaveProperty('playName')
    expect(block).toHaveProperty('compositeScore')
    expect(block).toHaveProperty('evidenceTrail')
    expect(block).toHaveProperty('availableLevers')
    expect(block).toHaveProperty('teamContext')
    expect(block).toHaveProperty('proposedAsk')
    expect(typeof block.playName).toBe('string')
    expect(typeof block.compositeScore).toBe('number')
    expect(Array.isArray(block.evidenceTrail)).toBe(true)
    expect(Array.isArray(block.availableLevers)).toBe(true)
    expect(typeof block.teamContext).toBe('string')
    expect(typeof block.proposedAsk).toBe('string')
  })

  it('AC-2: evidenceTrail items contain specific data from real signals', () => {
    const blocks = buildEvidenceBlocks(scoredTactics, signals, mockTeam)
    const firstBlock = blocks[0]

    expect(firstBlock.evidenceTrail.length).toBeGreaterThan(0)
    const item = firstBlock.evidenceTrail[0]
    expect(item).toHaveProperty('fact')
    expect(item).toHaveProperty('source')
    expect(item).toHaveProperty('recency')
    expect(typeof item.fact).toBe('string')
    expect(item.fact.length).toBeGreaterThan(5) // Not empty/trivial
  })

  it('AC-3: availableLevers contain name, description, URL, validThrough, source from marketplace/ecosystem/partner signals', () => {
    const blocks = buildEvidenceBlocks(scoredTactics, signals, mockTeam)

    // Flatten all levers across all blocks
    const allLevers = blocks.flatMap(b => b.availableLevers)
    expect(allLevers.length).toBeGreaterThan(0)

    for (const lever of allLevers) {
      expect(lever).toHaveProperty('name')
      expect(lever).toHaveProperty('description')
      expect(lever).toHaveProperty('url')
      expect(lever).toHaveProperty('source')
      expect(typeof lever.name).toBe('string')
      expect(typeof lever.description).toBe('string')
      expect(typeof lever.url).toBe('string')
      expect(['cloud-marketplace', 'ecosystem-catalog', 'partner-catalog']).toContain(lever.source)
    }

    // Check that at least one lever has validThrough from cloud-marketplace incentive
    const leverWithExpiry = allLevers.find(l => l.validThrough)
    expect(leverWithExpiry).toBeDefined()
  })

  it('AC-4: teamContext names SSP/specialist from account team relevant to play products', () => {
    const blocks = buildEvidenceBlocks(scoredTactics, signals, mockTeam)

    // RHEL Migration play should reference the RHEL SSP
    const rhelBlock = blocks.find(b => b.playName === 'RHEL Migration')
    expect(rhelBlock).toBeDefined()
    expect(rhelBlock!.teamContext).toContain('Carol Davis')
  })

  it('AC-5: returns top 3 blocks ordered by compositeScore descending', () => {
    const blocks = buildEvidenceBlocks(scoredTactics, signals, mockTeam)

    expect(blocks.length).toBe(3)
    expect(blocks[0].compositeScore).toBeGreaterThanOrEqual(blocks[1].compositeScore)
    expect(blocks[1].compositeScore).toBeGreaterThanOrEqual(blocks[2].compositeScore)
    // The 4th tactic (compositeScore 0.30) should not appear
    expect(blocks.find(b => b.playName === 'Low Priority Play')).toBeUndefined()
  })

  it('returns empty array when no scored tactics provided', () => {
    const blocks = buildEvidenceBlocks([], signals, mockTeam)
    expect(blocks).toEqual([])
  })

  it('handles fewer than 3 tactics gracefully', () => {
    const twoTactics = scoredTactics.slice(0, 2)
    const blocks = buildEvidenceBlocks(twoTactics, signals, mockTeam)
    expect(blocks.length).toBe(2)
  })
})

describe('AC-16: lever extraction from specific signal sources', () => {
  it('extracts incentives from cloud-marketplace signals', () => {
    const tactics = [makeScoredTactic()]
    const signals = [makeSignal()]
    const blocks = buildEvidenceBlocks(tactics, signals, mockTeam)

    const levers = blocks.flatMap(b => b.availableLevers)
    const marketplaceLevers = levers.filter(l => l.source === 'cloud-marketplace')
    expect(marketplaceLevers.length).toBeGreaterThan(0)
    expect(marketplaceLevers[0].url).toContain('http')
  })

  it('extracts resources from ecosystem-catalog signals', () => {
    const tactics = [makeScoredTactic({ name: 'OpenShift Security', parentTdp: 'Security' })]
    const signals = [makeEcosystemSignal()]
    const blocks = buildEvidenceBlocks(tactics, signals, mockTeam)

    const levers = blocks.flatMap(b => b.availableLevers)
    const ecoLevers = levers.filter(l => l.source === 'ecosystem-catalog')
    expect(ecoLevers.length).toBeGreaterThan(0)
  })

  it('extracts partner info from partner-catalog signals', () => {
    const tactics = [makeScoredTactic({ name: 'OpenShift Partner Engagement', parentTdp: 'Cloud Native' })]
    const signals = [makePartnerSignal()]
    const blocks = buildEvidenceBlocks(tactics, signals, mockTeam)

    const levers = blocks.flatMap(b => b.availableLevers)
    const partnerLevers = levers.filter(l => l.source === 'partner-catalog')
    expect(partnerLevers.length).toBeGreaterThan(0)
    expect(partnerLevers[0].url).toContain('http')
  })
})

// ── #653: Data-driven proposed asks ─────────────────────────────────────────

describe('#653/#658: extractKeyDataPoint()', () => {
  it('returns DataPoint with primary from EOS date (highest priority)', () => {
    const evidence: EvidenceItem[] = [
      { fact: '47 RHEL 7 subscriptions, EOS 2027-06-30', source: 'subscriptions', recency: 'current' },
    ]
    const result = extractKeyDataPoint(evidence)
    expect(result.primary).toBe('EOS 2027-06-30')
    expect(result.secondary).toBe('47 RHEL 7 subscriptions')
  })

  it('extracts EOS dates as primary from evidence', () => {
    const evidence: EvidenceItem[] = [
      { fact: 'Product approaching EOS 2027-06-30', source: 'lifecycle', recency: 'current' },
    ]
    expect(extractKeyDataPoint(evidence).primary).toBe('EOS 2027-06-30')
  })

  it('extracts case numbers from evidence', () => {
    const evidence: EvidenceItem[] = [
      { fact: 'Case #12345678: kernel panic on RHEL 7.9', source: 'cases', recency: '2d ago' },
    ]
    expect(extractKeyDataPoint(evidence).primary).toBe('case #12345678')
  })

  it('extracts dollar amounts from evidence', () => {
    const evidence: EvidenceItem[] = [
      { fact: 'Pipeline opportunity worth $1,234,567', source: 'pipeline', recency: 'current' },
    ]
    expect(extractKeyDataPoint(evidence).primary).toBe('$1,234,567')
  })

  it('falls back to truncated first fact when no pattern matches', () => {
    const evidence: EvidenceItem[] = [
      { fact: 'Customer expressed interest in container security solutions', source: 'notes', recency: 'current' },
    ]
    const result = extractKeyDataPoint(evidence)
    expect(result.primary.length).toBeLessThanOrEqual(60)
    expect(result.primary).toContain('container security')
    expect(result.secondary).toBeUndefined()
  })

  it('returns empty primary for empty evidence array', () => {
    expect(extractKeyDataPoint([]).primary).toBe('')
  })

  it('#658: evidence with sub count AND EOS date returns EOS date as primary', () => {
    const evidence: EvidenceItem[] = [
      { fact: '47 RHEL 7 subscriptions approaching end of life', source: 'subscriptions', recency: 'current' },
      { fact: 'EOS 2027-06-30 for RHEL 7', source: 'lifecycle', recency: 'current' },
    ]
    const result = extractKeyDataPoint(evidence)
    expect(result.primary).toBe('EOS 2027-06-30')
    expect(result.secondary).toBe('47 RHEL 7 subscriptions')
  })

  it('#658: priority order dates > dollars > cases > subs', () => {
    const evidence: EvidenceItem[] = [
      { fact: '47 RHEL subscriptions total', source: 'subscriptions', recency: 'current' },
      { fact: 'Case #99887766 open since last week', source: 'cases', recency: '2d ago' },
      { fact: 'Pipeline opportunity worth $500K', source: 'pipeline', recency: 'current' },
      { fact: 'Renewal closing 2027-01-15', source: 'lifecycle', recency: 'current' },
    ]
    const result = extractKeyDataPoint(evidence)
    expect(result.primary).toBe('closing 2027-01-15')
    expect(result.secondary).toBe('$500K')
  })

  it('#658: scans ALL evidence items, not just first match', () => {
    const evidence: EvidenceItem[] = [
      { fact: 'General interest in containers', source: 'notes', recency: 'current' },
      { fact: 'No specific data here either', source: 'notes', recency: 'current' },
      { fact: 'But this one has $2M pipeline', source: 'pipeline', recency: 'current' },
    ]
    const result = extractKeyDataPoint(evidence)
    expect(result.primary).toBe('$2M')
  })
})

describe('#653: data-driven proposed asks in buildEvidenceBlocks', () => {
  const mockTeamLocal: AccountTeamMember[] = [
    { name: 'Alice Johnson', title: 'Account Executive', role: 'ae' },
    { name: 'Bob Smith', title: 'Account Solution Architect', role: 'asa' },
  ]

  it('AC-1: migration ask includes specific subscription count and EOS date', () => {
    const tactic = makeScoredTactic({
      name: 'RHEL Migration',
      evidenceTrail: [
        { fact: '47 RHEL 7 subscriptions, EOS 2027-06-30', module: 'subscriptions', recency: 'current', weight: 0.9 },
      ],
    })
    const blocks = buildEvidenceBlocks([tactic], [], mockTeamLocal)
    expect(blocks[0].proposedAsk).toContain('47 RHEL 7 subscriptions')
  })

  it('AC-2: falls back to generic template when evidence has no extractable data points', () => {
    const tactic = makeScoredTactic({
      name: 'Generic Play',
      compositeScore: 0.7,
      evidenceTrail: [],
    })
    const blocks = buildEvidenceBlocks([tactic], [], mockTeamLocal)
    // Should contain the tactic name in a generic ask
    expect(blocks[0].proposedAsk).toContain('Generic Play')
    expect(blocks[0].proposedAsk).toContain('deep-dive')
  })

  it('case ask includes specific case number', () => {
    const tactic = makeScoredTactic({
      name: 'Support Remediation',
      compositeScore: 0.75,
      evidenceTrail: [
        { fact: 'Case #98765432: critical outage on RHEL 8', module: 'cases', recency: 'current', weight: 0.9 },
      ],
    })
    const blocks = buildEvidenceBlocks([tactic], [], mockTeamLocal)
    expect(blocks[0].proposedAsk).toContain('case #98765432')
  })

  it('#658: compound ask includes both primary and secondary data points', () => {
    const tactic = makeScoredTactic({
      name: 'RHEL Migration',
      compositeScore: 0.85,
      evidenceTrail: [
        { fact: '47 RHEL 7 subscriptions, EOS 2027-06-30', module: 'subscriptions', recency: 'current', weight: 0.9 },
        { fact: 'Pipeline opportunity worth $500K for migration', module: 'pipeline', recency: 'current', weight: 0.7 },
      ],
    })
    const blocks = buildEvidenceBlocks([tactic], [], mockTeamLocal)
    // EOS date is primary (highest priority), dollar amount is secondary
    expect(blocks[0].proposedAsk).toContain('EOS 2027-06-30')
    expect(blocks[0].proposedAsk).toContain('$500K')
  })
})
