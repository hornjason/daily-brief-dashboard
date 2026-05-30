/**
 * Unit tests for competitive-intel-validator.ts
 */

import { describe, it, expect } from 'bun:test'
import { competitiveIntelValidator } from '../../../src/quality-validators/competitive-intel-validator.ts'

// ── Good extraction fixture ────────────────────────────────────────────────

const GOOD_EXTRACTION = JSON.stringify([
  {
    competitor: 'VMware',
    product: 'vSphere',
    announcement: 'VMware increases licensing costs for vSphere 8 by 30%.',
    redHatCounter: 'Red Hat OpenShift Virtualization offers predictable pricing with included support.',
    salesTriggers: ['reduce IT staff but do more with less', 'consolidate virtualization licensing'],
    compensation: '$500 SPIFF per deal',
    keyDates: ['2026-06-30'],
  },
  {
    competitor: 'AWS',
    product: 'EKS',
    announcement: 'AWS launches EKS Anywhere for on-premise Kubernetes.',
    redHatCounter: 'OpenShift provides consistent hybrid cloud experience across all environments.',
    salesTriggers: ['hybrid cloud strategy'],
    compensation: null,
    keyDates: [],
  },
])

const BAD_EXTRACTION = JSON.stringify([
  {
    competitor: '',
    product: '',
    announcement: '',
    redHatCounter: '',
    salesTriggers: [],
    compensation: null,
    keyDates: [],
  },
])

// ── Tests ──────────────────────────────────────────────────────────────────

describe('competitiveIntelValidator', () => {
  it('has correct contentType and threshold', () => {
    expect(competitiveIntelValidator.contentType).toBe('competitive-intel')
    expect(competitiveIntelValidator.passThreshold).toBe(70)
  })

  it('passes good extraction', () => {
    const scorecard = competitiveIntelValidator.validate(GOOD_EXTRACTION)
    expect(scorecard.passed).toBe(true)
    expect(scorecard.score).toBeGreaterThanOrEqual(70)
    expect(scorecard.failures.length).toBe(0)
  })

  it('fails bad extraction with missing required fields', () => {
    const scorecard = competitiveIntelValidator.validate(BAD_EXTRACTION)
    expect(scorecard.passed).toBe(false)
    const failNames = scorecard.failures.map(f => f.name)
    expect(failNames).toContain('required-fields')
  })

  it('fails invalid JSON', () => {
    const scorecard = competitiveIntelValidator.validate('not json at all')
    expect(scorecard.passed).toBe(false)
    expect(scorecard.failures[0].name).toBe('valid-json')
  })

  it('detects empty array via min-extractions check', () => {
    const scorecard = competitiveIntelValidator.validate('[]')
    const minCheck = scorecard.checks.find(c => c.name === 'min-extractions')
    expect(minCheck).toBeDefined()
    expect(minCheck!.passed).toBe(false)
    // Note: overall score may still pass (83%) since most other checks pass vacuously
  })

  it('detects duplicate competitor+product pairs', () => {
    const withDupes = JSON.stringify([
      {
        competitor: 'VMware',
        product: 'vSphere',
        announcement: 'First entry.',
        redHatCounter: 'Counter 1.',
        salesTriggers: ['trigger1'],
      },
      {
        competitor: 'VMware',
        product: 'vSphere',
        announcement: 'Duplicate entry.',
        redHatCounter: 'Counter 2.',
        salesTriggers: ['trigger2'],
      },
    ])
    const scorecard = competitiveIntelValidator.validate(withDupes)
    const dupCheck = scorecard.checks.find(c => c.name === 'no-duplicate-competitors')
    expect(dupCheck).toBeDefined()
    expect(dupCheck!.passed).toBe(false)
  })

  it('flags low sales trigger coverage as recommended', () => {
    const noTriggers = JSON.stringify([
      {
        competitor: 'VMware',
        product: 'vSphere',
        announcement: 'Announcement.',
        redHatCounter: 'Counter.',
        salesTriggers: [],
      },
      {
        competitor: 'AWS',
        product: 'EKS',
        announcement: 'Announcement.',
        redHatCounter: 'Counter.',
        salesTriggers: [],
      },
    ])
    const scorecard = competitiveIntelValidator.validate(noTriggers)
    const triggerCheck = scorecard.checks.find(c => c.name === 'sales-triggers-present')
    expect(triggerCheck).toBeDefined()
    expect(triggerCheck!.passed).toBe(false)
    expect(triggerCheck!.severity).toBe('recommended')
  })

  it('flags long description fields', () => {
    const longDescs = JSON.stringify([
      {
        competitor: 'VMware',
        product: 'vSphere',
        announcement: 'X'.repeat(500),
        redHatCounter: 'Short.',
        salesTriggers: ['trigger'],
      },
    ])
    const scorecard = competitiveIntelValidator.validate(longDescs)
    const lenCheck = scorecard.checks.find(c => c.name === 'description-length')
    expect(lenCheck).toBeDefined()
    expect(lenCheck!.passed).toBe(false)
    expect(lenCheck!.severity).toBe('recommended')
  })
})
