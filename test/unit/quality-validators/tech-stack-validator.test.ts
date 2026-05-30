/**
 * Unit tests for tech-stack-validator.ts
 */

import { describe, it, expect } from 'bun:test'
import { techStackValidator } from '../../../src/quality-validators/tech-stack-validator.ts'

// ── Good extraction fixture ────────────────────────────────────────────────

const GOOD_EXTRACTION = JSON.stringify([
  {
    name: 'Kubernetes',
    category: 'industry-tool',
    context: 'using',
    description: 'Container orchestration platform used in production.',
    infrastructure: ['AWS', 'On-prem'],
    redHatProducts: ['ocp', 'acs'],
    confidence: 'HIGH',
  },
  {
    name: 'Terraform',
    category: 'industry-tool',
    context: 'using',
    description: 'Infrastructure as code for cloud provisioning.',
    infrastructure: ['AWS'],
    redHatProducts: ['aap'],
    confidence: 'MEDIUM',
  },
  {
    name: 'InternalPlatform',
    category: 'proprietary',
    context: 'developing',
    description: 'Custom internal developer platform built on Kubernetes.',
    infrastructure: ['Kubernetes', 'AWS'],
    redHatProducts: ['rhdh', 'ocp'],
    confidence: 'HIGH',
  },
])

const BAD_EXTRACTION = JSON.stringify([
  {
    name: '',
    category: 'invalid-category',
    context: 'unknown-context',
    description: '',
    infrastructure: [],
    redHatProducts: [],
    confidence: 'SUPER_HIGH',
  },
])

// ── Tests ──────────────────────────────────────────────────────────────────

describe('techStackValidator', () => {
  it('has correct contentType and threshold', () => {
    expect(techStackValidator.contentType).toBe('tech-stack')
    expect(techStackValidator.passThreshold).toBe(70)
  })

  it('passes good extraction', () => {
    const scorecard = techStackValidator.validate(GOOD_EXTRACTION)
    expect(scorecard.passed).toBe(true)
    expect(scorecard.score).toBeGreaterThanOrEqual(70)
    expect(scorecard.failures.length).toBe(0)
  })

  it('fails bad extraction with multiple check failures', () => {
    const scorecard = techStackValidator.validate(BAD_EXTRACTION)
    expect(scorecard.passed).toBe(false)
    const failNames = scorecard.failures.map(f => f.name)
    expect(failNames).toContain('required-fields')
    expect(failNames).toContain('valid-categories')
    expect(failNames).toContain('valid-contexts')
    expect(failNames).toContain('valid-confidence')
  })

  it('fails invalid JSON', () => {
    const scorecard = techStackValidator.validate('not json at all')
    expect(scorecard.passed).toBe(false)
    expect(scorecard.failures[0].name).toBe('valid-json')
  })

  it('detects empty array via min-technologies check', () => {
    const scorecard = techStackValidator.validate('[]')
    const minCheck = scorecard.checks.find(c => c.name === 'min-technologies')
    expect(minCheck).toBeDefined()
    expect(minCheck!.passed).toBe(false)
    // Note: overall score may still pass since most other checks pass vacuously on empty array
  })

  it('validates category enum', () => {
    const badCategory = JSON.stringify([
      {
        name: 'Tool',
        category: 'saas',
        context: 'using',
        description: 'A tool.',
        redHatProducts: ['ocp'],
        confidence: 'HIGH',
      },
    ])
    const scorecard = techStackValidator.validate(badCategory)
    const catCheck = scorecard.checks.find(c => c.name === 'valid-categories')
    expect(catCheck).toBeDefined()
    expect(catCheck!.passed).toBe(false)
  })

  it('validates context enum', () => {
    const badContext = JSON.stringify([
      {
        name: 'Tool',
        category: 'industry-tool',
        context: 'deployed',
        description: 'A tool.',
        redHatProducts: ['ocp'],
        confidence: 'HIGH',
      },
    ])
    const scorecard = techStackValidator.validate(badContext)
    const ctxCheck = scorecard.checks.find(c => c.name === 'valid-contexts')
    expect(ctxCheck).toBeDefined()
    expect(ctxCheck!.passed).toBe(false)
  })

  it('validates confidence enum', () => {
    const badConfidence = JSON.stringify([
      {
        name: 'Tool',
        category: 'industry-tool',
        context: 'using',
        description: 'A tool.',
        redHatProducts: ['ocp'],
        confidence: 'VERY_HIGH',
      },
    ])
    const scorecard = techStackValidator.validate(badConfidence)
    const confCheck = scorecard.checks.find(c => c.name === 'valid-confidence')
    expect(confCheck).toBeDefined()
    expect(confCheck!.passed).toBe(false)
  })

  it('flags low Red Hat product coverage as recommended', () => {
    const noProducts = JSON.stringify([
      {
        name: 'Tool1',
        category: 'industry-tool',
        context: 'using',
        description: 'A tool.',
        redHatProducts: [],
        confidence: 'HIGH',
      },
      {
        name: 'Tool2',
        category: 'proprietary',
        context: 'developing',
        description: 'Another tool.',
        redHatProducts: [],
        confidence: 'MEDIUM',
      },
    ])
    const scorecard = techStackValidator.validate(noProducts)
    const rhCheck = scorecard.checks.find(c => c.name === 'has-red-hat-products')
    expect(rhCheck).toBeDefined()
    expect(rhCheck!.passed).toBe(false)
    expect(rhCheck!.severity).toBe('recommended')
  })
})
