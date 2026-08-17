import { describe, it, expect } from 'bun:test'
import { deriveFootprint } from '../../src/campaign-service.ts'
import type { PersonaBrief } from '../../src/lib/persona-selector.ts'

function makeBrief(overrides: Partial<PersonaBrief> = {}): PersonaBrief {
  return {
    role: 'ECONOMIC_BUYER',
    suggestedTitle: 'VP of IT',
    why: 'Budget holder',
    objectiveMatch: 'Cost reduction',
    peerProofCandidates: [],
    timingTrigger: 'Q3 renewal',
    valueProposition: 'Reduce operational costs by 40%',
    featureKeys: [],
    competitiveContext: null,
    relationshipPath: 'Through AE',
    installedBase: 'RHEL 9, Ansible Automation Platform',
    suppressTriggers: [],
    confidence: { overall: 'HIGH' },
    ...overrides,
  }
}

describe('deriveFootprint', () => {
  it('uses Pass 0 installedBase when briefs are available', () => {
    const briefs = [makeBrief({ installedBase: 'RHEL 9, OpenShift Container Platform' })]
    const result = deriveFootprint(briefs, [], [])
    expect(result).toBeDefined()
    expect(result!.current).toBe('RHEL 9, OpenShift Container Platform')
  })

  it('falls back to raw subProducts when no briefs', () => {
    const subSignals = [
      { headline: 'Enterprise Linux', metadata: { product: 'RHEL 9' } },
      { headline: 'Ansible', metadata: { product: 'Ansible Automation Platform' } },
    ]
    const result = deriveFootprint([], subSignals as any, [])
    expect(result).toBeDefined()
    expect(result!.current).toBe('RHEL 9, Ansible Automation Platform')
  })

  it('deduplicates installed bases across multiple briefs', () => {
    const briefs = [
      makeBrief({ installedBase: 'RHEL 9, OpenShift' }),
      makeBrief({ installedBase: 'RHEL 9, Ansible Automation Platform' }),
      makeBrief({ installedBase: 'OpenShift' }),
    ]
    const result = deriveFootprint(briefs, [], [])
    expect(result).toBeDefined()
    const items = result!.current.split(' · ')
    expect(items).toContain('RHEL 9, OpenShift')
    expect(items).toContain('RHEL 9, Ansible Automation Platform')
    expect(items).toContain('OpenShift')
    expect(new Set(items).size).toBe(items.length)
  })

  it('includes competitive context in expansion when available', () => {
    const briefs = [makeBrief({
      installedBase: 'RHEL 9',
      valueProposition: 'Reduce costs by 40%',
      competitiveContext: 'VMware migration opportunity',
    })]
    const result = deriveFootprint(briefs, [], [])
    expect(result).toBeDefined()
    expect(result!.expansion).toContain('Reduce costs by 40%')
    expect(result!.expansion).toContain('VMware migration opportunity')
  })

  it('does not produce empty footprint when briefs have empty installedBase', () => {
    const briefs = [makeBrief({ installedBase: '' })]
    const result = deriveFootprint(briefs, [], [])
    expect(result).toBeUndefined()
  })

  it('uses value proposition without competitive context when competitive is null', () => {
    const briefs = [makeBrief({
      installedBase: 'RHEL 9',
      valueProposition: 'Standardize on enterprise Linux',
      competitiveContext: null,
    })]
    const result = deriveFootprint(briefs, [], [])
    expect(result).toBeDefined()
    expect(result!.expansion).toBe('Standardize on enterprise Linux')
    expect(result!.expansion).not.toContain('Competitive')
  })

  it('returns undefined when no briefs and no subProducts', () => {
    const result = deriveFootprint([], [], [])
    expect(result).toBeUndefined()
  })

  it('falls back to intelligence signals for expansion when no briefs', () => {
    const subSignals = [
      { headline: 'RHEL', metadata: { product: 'RHEL 9' } },
    ]
    const registrySignals = [
      { headline: 'Cloud migration initiative', source: 'intelligence' },
      { headline: 'Kubernetes adoption', source: 'pipeline' },
    ]
    const result = deriveFootprint([], subSignals as any, registrySignals as any)
    expect(result).toBeDefined()
    expect(result!.expansion).toContain('Cloud migration initiative')
    expect(result!.expansion).toContain('Kubernetes adoption')
  })
})
