import { describe, test, expect } from 'bun:test'
import { assessSignalQuality, CampaignQualityGateError, type SignalQualityAssessment } from '../../src/campaign-service.ts'
import { SIGNAL_TIERS } from '../../src/lib/signal-loader.ts'

describe('assessSignalQuality', () => {
  const allCritical = [...SIGNAL_TIERS.CRITICAL]
  const allContext = [...SIGNAL_TIERS.CONTEXT]
  const allEnrichment = [...SIGNAL_TIERS.ENRICHMENT]
  const allSources = [...allCritical, ...allContext, ...allEnrichment]

  test('PROCEED when both critical signals loaded', () => {
    const result = assessSignalQuality(allSources, [])
    expect(result.disposition).toBe('PROCEED')
    expect(result.missing).toEqual([])
  })

  test('BLOCKED when intelligence missing', () => {
    const loaded = allSources.filter(s => s !== 'intelligence')
    const result = assessSignalQuality(loaded, ['intelligence'])
    expect(result.disposition).toBe('BLOCKED')
    expect(result.missing).toContain('intelligence')
  })

  test('BLOCKED when subscriptions missing', () => {
    const loaded = allSources.filter(s => s !== 'subscriptions')
    const result = assessSignalQuality(loaded, ['subscriptions'])
    expect(result.disposition).toBe('BLOCKED')
    expect(result.missing).toContain('subscriptions')
  })

  test('BLOCKED when both critical missing', () => {
    const loaded = allSources.filter(s => !allCritical.includes(s))
    const result = assessSignalQuality(loaded, [...allCritical])
    expect(result.disposition).toBe('BLOCKED')
    expect(result.missing).toContain('intelligence')
    expect(result.missing).toContain('subscriptions')
  })

  test('DEGRADED when critical loaded but context missing', () => {
    const loaded = [...allCritical, ...allEnrichment]
    const result = assessSignalQuality(loaded, [...allContext])
    expect(result.disposition).toBe('DEGRADED')
    expect(result.missing.length).toBe(allContext.length)
    for (const ctx of allContext) {
      expect(result.missing).toContain(ctx)
    }
  })

  test('signalCompleteness = 100 when all loaded', () => {
    const result = assessSignalQuality(allSources, [])
    expect(result.signalCompleteness).toBe(100)
  })

  test('signalCompleteness = 0 when all critical missing and nothing else loaded', () => {
    const result = assessSignalQuality([], [...allSources])
    expect(result.signalCompleteness).toBe(0)
  })

  test('signalCompleteness correct with partial data — one critical loaded', () => {
    // intelligence loaded (30%), subscriptions missing (0%)
    // All context missing (0%), all enrichment missing (0%)
    const result = assessSignalQuality(['intelligence'], ['subscriptions', ...allContext, ...allEnrichment])
    // Critical: 1/2 * 60 = 30, Context: 0/4 * 30 = 0, Enrichment: 0/N * 10 = 0
    expect(result.signalCompleteness).toBe(30)
  })

  test('reasons populated for missing signals', () => {
    const result = assessSignalQuality([], [...allSources])
    expect(result.reasons['intelligence']).toBeDefined()
    expect(result.reasons['subscriptions']).toBeDefined()
  })

  test('stale array exists in result', () => {
    const result = assessSignalQuality(allSources, [])
    expect(Array.isArray(result.stale)).toBe(true)
  })
})

describe('CampaignQualityGateError', () => {
  test('has actionable message with customer name and missing signals', () => {
    const assessment: SignalQualityAssessment = {
      disposition: 'BLOCKED',
      signalCompleteness: 30,
      missing: ['subscriptions'],
      stale: [],
      reasons: { subscriptions: 'not loaded — no data available for this customer' },
    }
    const error = new CampaignQualityGateError(assessment, 'Acme Corp')
    expect(error.message).toContain('Acme Corp')
    expect(error.message).toContain('subscriptions')
    expect(error.message).toContain('forceGenerate')
    expect(error.name).toBe('CampaignQualityGateError')
    expect(error.assessment).toBe(assessment)
    expect(error.customerName).toBe('Acme Corp')
  })

  test('lists multiple missing signals', () => {
    const assessment: SignalQualityAssessment = {
      disposition: 'BLOCKED',
      signalCompleteness: 0,
      missing: ['intelligence', 'subscriptions'],
      stale: [],
      reasons: {
        intelligence: 'not loaded — no data available for this customer',
        subscriptions: 'not loaded — no data available for this customer',
      },
    }
    const error = new CampaignQualityGateError(assessment, 'Big Ten')
    expect(error.message).toContain('intelligence')
    expect(error.message).toContain('subscriptions')
    expect(error.message).toContain('Big Ten')
  })
})
