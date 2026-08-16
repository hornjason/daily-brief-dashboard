import { describe, it, expect } from 'bun:test'
import { classifyPersona, preMatchObjectives, type ContactContext } from '../../src/lib/persona-classifier.ts'
import type { CustomerObjectiveProfile, ObjectiveEntry } from '../../src/modules/intelligence-module.ts'

const makeEntry = (objective: string, overrides: Partial<ObjectiveEntry> = {}): ObjectiveEntry => ({
  objective,
  metric: null,
  priority: 'HIGH',
  source: 'test',
  confidence: 'HIGH',
  ...overrides,
})

const emptyProfile: CustomerObjectiveProfile = {
  financial: [],
  security: [],
  operational: [],
  innovation: [],
  growth: [],
}

const makeProfile = (overrides: Partial<CustomerObjectiveProfile> = {}): CustomerObjectiveProfile => ({
  ...emptyProfile,
  ...overrides,
})

// ── classifyPersona ──────────────────────────────────────────────────────

describe('classifyPersona', () => {
  it('CFO title → financial top category', () => {
    const result = classifyPersona({ name: 'Ryan Henderson', title: 'CFO' })
    expect(result.categories[0].category).toBe('financial')
  })

  it('CISO title + security context → security high confidence', () => {
    const result = classifyPersona({
      name: 'Sean Pike',
      title: 'Head of Information Security',
      leadershipContext: 'Former CISO at Business Wire. 25 years cybersecurity. Zero-trust architecture.',
    })
    expect(result.categories[0].category).toBe('security')
    expect(result.categories[0].confidence).toBeGreaterThan(0.5)
  })

  it('ambiguous title + rich context → context determines category', () => {
    const result = classifyPersona({
      name: 'Arvind Bhuvaraghan',
      title: 'Sr. Director, Enterprise Info Mgmt',
      leadershipContext: 'Manages Salesforce, Workday, Oracle stack. PMP, CISA certified. Infrastructure consolidation.',
    })
    expect(result.categories[0].category).toBe('operational')
  })

  it('empty context → fallback to financial', () => {
    const result = classifyPersona({ name: 'Jane Doe', title: 'Board Member' })
    expect(result.categories[0].category).toBe('financial')
    expect(result.categories[0].confidence).toBe(0.5)
  })

  it('CEO with AI security context → multiple categories ranked', () => {
    const result = classifyPersona({
      name: 'Dhrupad Trivedi',
      title: 'President and CEO',
      leadershipContext: 'strategic alignment with AI security trends, commitment to enhancing security solutions, AI infrastructure market',
    })
    expect(result.categories.length).toBeGreaterThan(1)
    const cats = result.categories.map(c => c.category)
    expect(cats).toContain('security')
    expect(cats).toContain('innovation')
  })

  it('Director of Finance with cost/margin context → financial', () => {
    const result = classifyPersona({
      name: 'Ryan Henderson',
      title: 'Director of Finance',
      leadershipContext: 'Built IR at Informatica; deep cost management expertise. Margin improvement focus.',
    })
    expect(result.categories[0].category).toBe('financial')
  })
})

// ── preMatchObjectives ───────────────────────────────────────────────────

describe('preMatchObjectives', () => {
  it('matches A10-like contacts to correct profile entries', () => {
    const profile = makeProfile({
      financial: [makeEntry('25-30% EBITDA margins target', { metric: '25-30%' })],
      security: [makeEntry('zero-trust architecture initiative')],
      innovation: [makeEntry('AI platform modernization')],
    })

    const contacts = [
      { name: 'Sean Pike', title: 'Head of Information Security', leadershipContext: 'Former CISO. Cybersecurity veteran.' },
      { name: 'Ryan Henderson', title: 'Director of Finance' },
    ]

    const results = preMatchObjectives(contacts, profile)
    expect(results.length).toBe(2)

    const seanMatch = results.find(r => r.recipientName === 'Sean Pike')!
    expect(seanMatch.category).toBe('security')
    expect(seanMatch.entry.objective).toContain('zero-trust')

    const ryanMatch = results.find(r => r.recipientName === 'Ryan Henderson')!
    expect(ryanMatch.category).toBe('financial')
    expect(ryanMatch.entry.objective).toContain('EBITDA')
  })

  it('filters LOW urgency entries', () => {
    const profile = makeProfile({
      financial: [
        makeEntry('low priority cost thing', { priority: 'LOW' }),
        makeEntry('high priority margin target', { priority: 'HIGH', metric: '25%' }),
      ],
    })

    const results = preMatchObjectives(
      [{ name: 'Jane', title: 'CFO' }],
      profile,
    )
    expect(results.length).toBe(1)
    expect(results[0].entry.objective).toContain('high priority margin target')
  })

  it('filters internal signals (termination, resignation)', () => {
    const profile = makeProfile({
      operational: [
        makeEntry('CEO termination creates leadership vacuum'),
        makeEntry('infrastructure modernization initiative'),
      ],
    })

    const results = preMatchObjectives(
      [{ name: 'Jane', title: 'VP Operations and Infrastructure' }],
      profile,
    )
    expect(results.length).toBe(1)
    expect(results[0].entry.objective).toContain('infrastructure modernization')
  })

  it('returns empty for contacts with no matching profile entries', () => {
    const results = preMatchObjectives(
      [{ name: 'Jane', title: 'CFO' }],
      emptyProfile,
    )
    expect(results.length).toBe(0)
  })

  it('falls through categories to find usable entry', () => {
    const profile = makeProfile({
      security: [],
      operational: [makeEntry('streamline infrastructure')],
    })

    const results = preMatchObjectives(
      [{ name: 'Sean', title: 'Head of Information Security', leadershipContext: 'Cybersecurity expert. Infrastructure management.' }],
      profile,
    )
    expect(results.length).toBe(1)
    expect(results[0].category).toBe('operational')
  })
})
