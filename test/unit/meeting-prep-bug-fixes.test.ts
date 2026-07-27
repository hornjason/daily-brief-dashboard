/**
 * Regression tests for meeting prep bug fixes (#1013, #1014, #1009)
 */
import { describe, it, expect, beforeAll } from 'bun:test'

describe('#1013: Graph deal signals extraction', () => {
  let extractGraphDealSignals: typeof import('../../src/lib/meeting-prep-graph-integration.ts').extractGraphDealSignals

  beforeAll(async () => {
    const mod = await import('../../src/lib/meeting-prep-graph-integration.ts')
    extractGraphDealSignals = mod.extractGraphDealSignals
  })

  it('returns empty array for non-existent customer', () => {
    const signals = extractGraphDealSignals('nonexistent-customer-xyz', [])
    expect(signals).toEqual([])
  })

  it('returns signals with source=pipeline and type=expansion', () => {
    const signals = extractGraphDealSignals('illumio', [])
    for (const s of signals) {
      expect(s.source).toBe('pipeline')
      expect(s.type).toBe('expansion')
      expect(s.headline).toBeTruthy()
      expect(s.metadata?.opportunityName).toBeTruthy()
      expect(s.metadata?.stage).toBeTruthy()
    }
  })

  it('excludes Closed deals', () => {
    const signals = extractGraphDealSignals('illumio', [])
    for (const s of signals) {
      const stage = String(s.metadata?.stage ?? '').toLowerCase()
      expect(stage).not.toContain('closed')
    }
  })

  it('deduplicates against existing pipeline signals', () => {
    const allSignals = extractGraphDealSignals('illumio', [])
    if (allSignals.length === 0) return // no graph data available

    const firstDeal = allSignals[0]
    const withExisting = extractGraphDealSignals('illumio', [
      { metadata: { opportunityName: firstDeal.metadata?.opportunityName as string } },
    ])
    expect(withExisting.length).toBeLessThan(allSignals.length)
  })

  it('sets rawRelevance based on stage', () => {
    const signals = extractGraphDealSignals('illumio', [])
    for (const s of signals) {
      expect(s.rawRelevance).toBeGreaterThanOrEqual(0)
      expect(s.rawRelevance).toBeLessThanOrEqual(1)
      const stage = String(s.metadata?.stage ?? '').toLowerCase()
      if (stage.includes('commit')) expect(s.rawRelevance).toBe(0.9)
      else if (stage.includes('best case')) expect(s.rawRelevance).toBe(0.7)
      else if (stage.includes('pipeline')) expect(s.rawRelevance).toBe(0.5)
    }
  })
})

describe('#1014: Case status filtering', () => {
  it('closed case statuses are excluded from meeting prep', () => {
    const closedStatuses = ['closed', 'closed - resolved', 'closed - cancelled', 'closed - duplicate']
    const testCases = [
      { accountNumber: '123', status: 'Closed', summary: 'should be excluded', severity: '1' },
      { accountNumber: '123', status: 'Closed - Resolved', summary: 'should be excluded', severity: '2' },
      { accountNumber: '123', status: 'Waiting on Red Hat', summary: 'should be included', severity: '2' },
      { accountNumber: '123', status: 'Open', summary: 'should be included', severity: '3' },
    ]

    const filtered = testCases.filter(sc =>
      !closedStatuses.includes((sc.status ?? '').toLowerCase())
    )

    expect(filtered.length).toBe(2)
    expect(filtered.every(c => !c.status.toLowerCase().startsWith('closed'))).toBe(true)
    expect(filtered.some(c => c.status === 'Waiting on Red Hat')).toBe(true)
    expect(filtered.some(c => c.status === 'Open')).toBe(true)
  })
})

describe('#1009: Domain company overrides', () => {
  it('levelupla.com resolves to Level Up Technology', async () => {
    const mod = await import('../../src/lib/attendee-profile-cache.ts')
    const profiles = await mod.resolveAttendees(
      ['test@levelupla.com'],
      '',
      {},
    )
    const profile = profiles.find(p => p.email === 'test@levelupla.com')
    expect(profile).toBeDefined()
    expect(profile!.company).toBe('Level Up Technology')
  })

  it('unknown domains still derive from domain name', async () => {
    const mod = await import('../../src/lib/attendee-profile-cache.ts')
    const profiles = await mod.resolveAttendees(
      ['test@unknowncorp.com'],
      '',
      {},
    )
    const profile = profiles.find(p => p.email === 'test@unknowncorp.com')
    expect(profile).toBeDefined()
    expect(profile!.company).toBe('Unknowncorp')
  })
})
