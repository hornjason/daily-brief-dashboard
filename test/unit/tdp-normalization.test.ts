/**
 * TDP Normalization Tests — GitHub Issue #962
 *
 * Verifies resolveTdpAlignment() maps all 63 free-form Gemini TDP values
 * to the 8 canonical TDP domain names using keyword-based matching.
 */

import { describe, test, expect } from 'bun:test'
import { resolveTdpAlignment } from '../../src/lib/document-intelligence-resolver.ts'
import { TDP_DOMAINS } from '../../src/lib/tdp-domains.ts'

// ── The 8 canonical TDP domain names ───────────────────────────────────────

const CANONICAL_NAMES = Object.keys(TDP_DOMAINS)

// ── All 63 free-form values from Gemini ────────────────────────────────────

const ALL_FREEFORM_VALUES = [
  'AI/ML Operations',
  'AIOps',
  'Application Development',
  'Application Modernization',
  'Application Performance Management',
  'Artificial Intelligence',
  'Automation',
  'Automation Management',
  'Automation Security',
  'Automation and Management',
  'Automation and Orchestration',
  'CI/CD Automation',
  'Cloud Automation',
  'Cloud Computing',
  'Cloud Governance',
  'Cloud Management',
  'Cloud Migration',
  'Cloud Security',
  'Cloud-Native Application Development',
  'Cloud-Native Development',
  'Compliance Automation',
  'Configuration Management',
  'Container Platform Automation',
  'Container Platform Security',
  'Container Platform Virtualization',
  'Continuous Compliance',
  'Data Management',
  'Datacenter Automation',
  'DevOps',
  'DevOps Automation',
  'DevOps Transformation',
  'DevOps and CI/CD',
  'DevSecOps',
  'Disaster Recovery',
  'Edge Computing',
  'Event-Driven Automation',
  'Hybrid Cloud Automation',
  'Hybrid Cloud Infrastructure',
  'Hybrid Cloud Management',
  'Hybrid Cloud Management and Automation',
  'Hybrid Cloud Operations',
  'Hybrid Cloud Security',
  'IT Automation',
  'IT Operations Automation',
  'IT Operations Management',
  'ITSM Integration',
  'Infrastructure Automation',
  'Infrastructure as Code',
  'Linux Platform Management',
  'Network Automation',
  'Observability and Monitoring',
  'Operating System Management',
  'Private Cloud Automation',
  'Private Cloud Management',
  'Public Cloud Management',
  'Secrets Management',
  'Security Automation',
  'Security and Compliance',
  'Service Management Automation',
  'Storage Automation',
  'Virtualization',
  'Virtualization Management',
  'Virtualization Modernization',
]

// ── Tests ──────────────────────────────────────────────────────────────────

describe('resolveTdpAlignment (#962)', () => {

  describe('null/empty/undefined input', () => {
    test('null input returns null', () => {
      expect(resolveTdpAlignment(null)).toBeNull()
    })

    test('empty array returns null', () => {
      expect(resolveTdpAlignment([])).toBeNull()
    })

    test('undefined input returns null', () => {
      // @ts-expect-error — testing defensive behavior
      expect(resolveTdpAlignment(undefined)).toBeNull()
    })
  })

  describe('canonical values pass through unchanged', () => {
    for (const name of CANONICAL_NAMES) {
      test(`"${name}" passes through`, () => {
        const result = resolveTdpAlignment([name])
        expect(result).toEqual([name])
      })
    }
  })

  describe('all 63 free-form values map to a canonical name', () => {
    for (const value of ALL_FREEFORM_VALUES) {
      test(`"${value}" maps to a canonical TDP`, () => {
        const result = resolveTdpAlignment([value])
        expect(result).not.toBeNull()
        expect(result!.length).toBeGreaterThanOrEqual(1)
        for (const mapped of result!) {
          expect(CANONICAL_NAMES).toContain(mapped)
        }
      })
    }
  })

  describe('expected specific mappings', () => {
    const expectedMappings: [string, string][] = [
      ['Cloud Computing', 'Server and Cloud Computing'],
      ['AI/ML Operations', 'AI Platform'],
      ['Virtualization Management', 'Virtualization'],
      ['Security and Compliance', 'Security'],
      ['DevOps Transformation', 'Application Development'],
      ['Artificial Intelligence', 'AI Platform'],
      ['Infrastructure as Code', 'Automation'],
      ['IT Automation', 'Automation'],
      ['Network Automation', 'Automation'],
      ['Datacenter Automation', 'Automation'],
      ['Event-Driven Automation', 'Automation'],
      ['Container Platform Automation', 'Automation'],
      ['Continuous Compliance', 'Security'],
      ['Configuration Management', 'Management'],
      ['Data Management', 'Management'],
      ['Linux Platform Management', 'Management'],
      ['Observability and Monitoring', 'Management'],
      ['ITSM Integration', 'Management'],
      ['Disaster Recovery', 'Server and Cloud Computing'],
      ['Edge Computing', 'Server and Cloud Computing'],
      ['Application Modernization', 'Application Development'],
      ['Virtualization Modernization', 'Virtualization'],
    ]

    for (const [input, expected] of expectedMappings) {
      test(`"${input}" → "${expected}"`, () => {
        const result = resolveTdpAlignment([input])
        expect(result).not.toBeNull()
        expect(result).toContain(expected)
      })
    }
  })

  describe('deduplication', () => {
    test('duplicate canonical results are deduplicated', () => {
      const result = resolveTdpAlignment(['Cloud Automation', 'IT Automation'])
      expect(result).not.toBeNull()
      // Both should map to Automation — result should have Automation only once
      const automationCount = result!.filter(v => v === 'Automation').length
      expect(automationCount).toBeLessThanOrEqual(1)
    })

    test('multiple distinct mappings are preserved', () => {
      const result = resolveTdpAlignment(['Cloud Computing', 'Security Automation'])
      expect(result).not.toBeNull()
      expect(result!.length).toBe(2)
    })
  })

  describe('alias matching', () => {
    test('"Container Mgmt" alias resolves to "Container Management"', () => {
      const result = resolveTdpAlignment(['Container Mgmt'])
      expect(result).toEqual(['Container Management'])
    })

    test('"AI" alias resolves to "AI Platform"', () => {
      const result = resolveTdpAlignment(['AI'])
      expect(result).toEqual(['AI Platform'])
    })

    test('"App Platform" alias resolves to "Application Development"', () => {
      const result = resolveTdpAlignment(['App Platform'])
      expect(result).toEqual(['Application Development'])
    })
  })

  describe('no unmatched free-form values pass through', () => {
    test('unrecognized values are dropped, not passed through', () => {
      const result = resolveTdpAlignment(['Completely Unknown TDP Value'])
      expect(result).toBeNull()
    })

    test('mix of valid and invalid — only valid survives', () => {
      const result = resolveTdpAlignment(['Cloud Computing', 'Totally Fake', 'IT Automation'])
      expect(result).not.toBeNull()
      expect(result!.every(v => CANONICAL_NAMES.includes(v))).toBe(true)
      expect(result).not.toContain('Totally Fake')
    })
  })

  describe('result array returns null when all values drop', () => {
    test('all-invalid input returns null', () => {
      const result = resolveTdpAlignment(['FakeTDP1', 'FakeTDP2'])
      expect(result).toBeNull()
    })
  })
})
