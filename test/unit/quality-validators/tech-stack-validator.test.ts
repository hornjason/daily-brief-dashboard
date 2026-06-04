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
    // All required checks pass; some recommended checks (has-why, has-sources) may fail
    const requiredFailures = scorecard.failures.filter(f => f.severity === 'required')
    expect(requiredFailures.length).toBe(0)
  })

  it('fails bad extraction with multiple check failures', () => {
    const scorecard = techStackValidator.validate(BAD_EXTRACTION)
    expect(scorecard.passed).toBe(false)
    const failNames = scorecard.failures.map(f => f.name)
    // Bad extraction has only 1 entry (< 3), invalid context, empty description
    expect(failNames).toContain('min-technologies')
    expect(failNames).toContain('has-context')
    expect(failNames).toContain('has-descriptions')
  })

  it('fails invalid JSON', () => {
    const scorecard = techStackValidator.validate('not json at all')
    expect(scorecard.passed).toBe(false)
    // Invalid JSON → entries = [] → min-technologies fails first
    expect(scorecard.failures[0].name).toBe('min-technologies')
  })

  it('detects empty array via min-technologies check', () => {
    const scorecard = techStackValidator.validate('[]')
    const minCheck = scorecard.checks.find(c => c.name === 'min-technologies')
    expect(minCheck).toBeDefined()
    expect(minCheck!.passed).toBe(false)
    // Note: overall score may still pass since most other checks pass vacuously on empty array
  })

  it('validates context enum via has-context check', () => {
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
    const ctxCheck = scorecard.checks.find(c => c.name === 'has-context')
    expect(ctxCheck).toBeDefined()
    expect(ctxCheck!.passed).toBe(false)
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
