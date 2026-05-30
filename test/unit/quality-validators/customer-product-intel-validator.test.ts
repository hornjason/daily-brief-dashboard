/**
 * Unit tests for customer-product-intel-validator.ts
 */

import { describe, it, expect } from 'bun:test'
import { customerProductIntelValidator } from '../../../src/quality-validators/customer-product-intel-validator.ts'

// ── Good output fixture ────────────────────────────────────────────────

const GOOD_OUTPUT = JSON.stringify({
  relevanceScore: 'HIGH',
  priorityAction: 'Schedule technical deep-dive on OpenShift 4.16 features addressing case #12345 quota management issues.',
  roadmapRelevance: [
    {
      feature: 'Node auto-repair',
      customerConnection: 'Addresses case #12345 about node stability issues',
      talkingPoint: 'Automatic detection and repair of failed nodes reduces ops burden.',
    },
  ],
  expansionOpportunities: [
    {
      gap: 'No container security scanning',
      product: 'Red Hat Advanced Cluster Security',
      rationale: 'Case #67890 shows runtime container issues — ACS would provide proactive scanning.',
    },
  ],
  caseAlignment: [
    {
      caseNumber: '12345',
      roadmapFix: 'Node auto-repair in 4.16',
      timeline: 'GA Q3 2026',
    },
  ],
  competitiveAngle: 'Customer evaluating EKS — OpenShift hybrid story is stronger.',
})

const BAD_OUTPUT = JSON.stringify({
  relevanceScore: 'INVALID',
  priorityAction: '',
  roadmapRelevance: 'not-an-array',
  expansionOpportunities: 'not-an-array',
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe('customerProductIntelValidator', () => {
  it('has correct contentType and threshold', () => {
    expect(customerProductIntelValidator.contentType).toBe('customer-product-intel')
    expect(customerProductIntelValidator.passThreshold).toBe(70)
  })

  it('passes good output', () => {
    const scorecard = customerProductIntelValidator.validate(GOOD_OUTPUT)
    expect(scorecard.passed).toBe(true)
    expect(scorecard.score).toBeGreaterThanOrEqual(70)
    expect(scorecard.failures.length).toBe(0)
  })

  it('fails bad output with specific checks', () => {
    const scorecard = customerProductIntelValidator.validate(BAD_OUTPUT)
    expect(scorecard.passed).toBe(false)
    const failNames = scorecard.failures.map(f => f.name)
    expect(failNames).toContain('relevance-score')
    expect(failNames).toContain('priority-action')
    expect(failNames).toContain('expansion-opportunities')
  })

  it('fails invalid JSON', () => {
    const scorecard = customerProductIntelValidator.validate('not json at all')
    expect(scorecard.passed).toBe(false)
    expect(scorecard.failures[0].name).toBe('valid-json')
  })

  it('fails array instead of object', () => {
    const scorecard = customerProductIntelValidator.validate('[1, 2, 3]')
    expect(scorecard.passed).toBe(false)
    expect(scorecard.failures[0].name).toBe('valid-json')
    expect(scorecard.failures[0].actual).toContain('array')
  })

  it('validates relevance score enum', () => {
    const badRelevance = JSON.stringify({
      relevanceScore: 'CRITICAL',
      priorityAction: 'Do something.',
      roadmapRelevance: [{ feature: 'f', customerConnection: 'c', talkingPoint: 't' }],
      expansionOpportunities: [],
    })
    const scorecard = customerProductIntelValidator.validate(badRelevance)
    const relCheck = scorecard.checks.find(c => c.name === 'relevance-score')
    expect(relCheck).toBeDefined()
    expect(relCheck!.passed).toBe(false)
  })

  it('accepts all valid relevance scores', () => {
    for (const score of ['HIGH', 'MEDIUM', 'LOW', 'NONE', 'EXPANSION']) {
      const output = JSON.stringify({
        relevanceScore: score,
        priorityAction: 'Action.',
        roadmapRelevance: [{ feature: 'f', customerConnection: 'c', talkingPoint: 't' }],
        expansionOpportunities: [],
      })
      const scorecard = customerProductIntelValidator.validate(output)
      const relCheck = scorecard.checks.find(c => c.name === 'relevance-score')
      expect(relCheck!.passed).toBe(true)
    }
  })

  it('validates roadmap relevance entry fields when present', () => {
    const badRoadmap = JSON.stringify({
      relevanceScore: 'HIGH',
      priorityAction: 'Action.',
      roadmapRelevance: [
        { feature: 'f', customerConnection: '', talkingPoint: '' },
      ],
      expansionOpportunities: [],
    })
    const scorecard = customerProductIntelValidator.validate(badRoadmap)
    const rmCheck = scorecard.checks.find(c => c.name === 'roadmap-fields')
    expect(rmCheck).toBeDefined()
    expect(rmCheck!.passed).toBe(false)
  })

  it('validates expansion opportunity fields when present', () => {
    const badExpansion = JSON.stringify({
      relevanceScore: 'HIGH',
      priorityAction: 'Action.',
      roadmapRelevance: [{ feature: 'f', customerConnection: 'c', talkingPoint: 't' }],
      expansionOpportunities: [
        { gap: '', product: '', rationale: '' },
      ],
    })
    const scorecard = customerProductIntelValidator.validate(badExpansion)
    const expCheck = scorecard.checks.find(c => c.name === 'expansion-fields')
    expect(expCheck).toBeDefined()
    expect(expCheck!.passed).toBe(false)
  })

  it('treats roadmap-relevance as recommended (empty array still passes)', () => {
    const noRoadmap = JSON.stringify({
      relevanceScore: 'NONE',
      priorityAction: 'No action needed.',
      roadmapRelevance: [],
      expansionOpportunities: [],
    })
    const scorecard = customerProductIntelValidator.validate(noRoadmap)
    const rmCheck = scorecard.checks.find(c => c.name === 'roadmap-relevance')
    expect(rmCheck).toBeDefined()
    expect(rmCheck!.severity).toBe('recommended')
    // Overall should still pass because required checks pass
    expect(scorecard.passed).toBe(true)
  })
})
