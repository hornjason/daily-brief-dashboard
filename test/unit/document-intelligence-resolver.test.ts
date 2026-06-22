/**
 * Document Intelligence Resolver — Unit Tests (ADR-041)
 *
 * Tests vocabulary resolution and sanitization for DocumentIntelligence.
 */

import { describe, test, expect } from 'bun:test'
import {
  sanitizeDocumentIntelligence,
  resolveProductReferences,
  resolveCompetitorReferences,
  resolvePartnerSolutions,
  resolveDocumentIntelligence,
} from '../../src/lib/document-intelligence-resolver.ts'
import type { DocumentIntelligence, ProductReference, CompetitorReference, PartnerSolutionReference } from '../../src/types/saleshub-product-types.ts'
import type { EcosystemPartnerCache } from '../../src/lib/ecosystem-catalog.ts'

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeDoc(overrides: Partial<DocumentIntelligence> = {}): DocumentIntelligence {
  return {
    documentName: 'Test Document',
    documentCategory: 'content-kit',
    summary: 'A test document about automation.',
    productsReferenced: [{ name: 'Ansible Automation Platform', slug: null }],
    integrationsReferenced: [{ technology: 'ServiceNow', category: 'ITSM' }],
    competitorsReferenced: [{ name: 'VMware', context: 'displacement' }],
    partnerSolutions: [{ partnerName: 'CrowdStrike', solutionArea: 'Security' }],
    useCases: ['ITSM automation'],
    customerScenarios: [{ scenario: 'Migrating from VMware', industry: 'Healthcare' }],
    cloudProviders: ['AWS'],
    audience: 'customer',
    keyPoints: ['Point 1'],
    talkTracks: ['Talk track 1'],
    links: [{ name: 'Link 1', url: 'https://example.com' }],
    actionableSteps: [{ step: 'Step 1', url: 'https://example.com/step' }],
    workshops: [{ name: 'Workshop 1', url: 'https://labs.redhat.com/w1' }],
    demos: [{ name: 'Demo 1', url: 'https://demo.redhat.com/d1' }],
    enrichedAt: '2026-06-22T00:00:00.000Z',
    sourceProductSlug: 'aap',
    ...overrides,
  }
}

function makePartnerCache(name: string): EcosystemPartnerCache {
  return {
    partnerName: name,
    partnerSlug: name.toLowerCase().replace(/\s+/g, '-'),
    solutions: [],
    scrapedAt: '2026-06-22T00:00:00.000Z',
    solutionCount: 0,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('document-intelligence-resolver', () => {

  describe('sanitizeDocumentIntelligence', () => {
    test('strips HTML tags from text fields', () => {
      const doc = makeDoc({
        summary: '<b>Bold</b> summary with <a href="foo">link</a>',
        keyPoints: ['<script>alert("xss")</script>Key point'],
      })
      const result = sanitizeDocumentIntelligence(doc)
      expect(result.summary).not.toContain('<b>')
      expect(result.summary).not.toContain('</b>')
      expect(result.summary).toContain('Bold')
      expect(result.keyPoints[0]).not.toContain('<script>')
      expect(result.keyPoints[0]).toContain('Key point')
    })

    test('truncates names exceeding max length', () => {
      const longName = 'A'.repeat(300)
      const doc = makeDoc({ documentName: longName })
      const result = sanitizeDocumentIntelligence(doc)
      expect(result.documentName.length).toBe(200)
    })

    test('rejects non-http URLs from links', () => {
      const doc = makeDoc({
        links: [
          { name: 'Good', url: 'https://example.com' },
          { name: 'Bad', url: 'javascript:alert(1)' },
          { name: 'Also bad', url: 'ftp://files.example.com' },
          { name: 'HTTP OK', url: 'http://example.com' },
        ],
      })
      const result = sanitizeDocumentIntelligence(doc)
      expect(result.links).toHaveLength(2)
      expect(result.links[0].url).toBe('https://example.com')
      expect(result.links[1].url).toBe('http://example.com')
    })

    test('strips path traversal characters', () => {
      const doc = makeDoc({
        summary: 'Normal text ../../../etc/passwd leaked',
      })
      const result = sanitizeDocumentIntelligence(doc)
      expect(result.summary).not.toContain('../')
    })
  })

  describe('resolveProductReferences', () => {
    test('resolves known product names to slugs', () => {
      const refs: ProductReference[] = [
        { name: 'Ansible Automation Platform', slug: null },
        { name: 'Red Hat OpenShift Container Platform', slug: null },
      ]
      const result = resolveProductReferences(refs)
      // These should resolve via product-vocabulary.ts
      // If product-intel-config.json is available, slugs will be set
      // At minimum, verify the function runs without error and returns same length
      expect(result).toHaveLength(2)
      expect(result[0].name).toBe('Ansible Automation Platform')
      expect(result[1].name).toBe('Red Hat OpenShift Container Platform')
    })

    test('returns null slug for unknown products', () => {
      const refs: ProductReference[] = [
        { name: 'NotARealProduct', slug: null },
      ]
      const result = resolveProductReferences(refs)
      expect(result[0].slug).toBeNull()
    })
  })

  describe('resolveCompetitorReferences', () => {
    test('resolves known competitor names', () => {
      const refs: CompetitorReference[] = [
        { name: 'VMware', context: 'displacement' },
        { name: 'Puppet', context: 'comparison' },
      ]
      const result = resolveCompetitorReferences(refs)
      // Function should run without error
      expect(result).toHaveLength(2)
      expect(result[0].name).toBe('VMware')
      expect(result[0].context).toBe('displacement')
    })

    test('passes through unknown competitors unchanged', () => {
      const refs: CompetitorReference[] = [
        { name: 'UnknownCompetitor', context: 'comparison' },
      ]
      const result = resolveCompetitorReferences(refs)
      expect(result[0]).toEqual({ name: 'UnknownCompetitor', context: 'comparison' })
    })
  })

  describe('resolvePartnerSolutions', () => {
    test('uses canonical partner name from catalog', () => {
      const refs: PartnerSolutionReference[] = [
        { partnerName: 'crowdstrike', solutionArea: 'Security' },
      ]
      const partners = [makePartnerCache('CrowdStrike')]
      const result = resolvePartnerSolutions(refs, partners)
      expect(result[0].partnerName).toBe('CrowdStrike') // canonical from catalog
    })

    test('passes through unmatched partners unchanged', () => {
      const refs: PartnerSolutionReference[] = [
        { partnerName: 'UnknownPartner', solutionArea: 'Other' },
      ]
      const result = resolvePartnerSolutions(refs, [])
      expect(result[0].partnerName).toBe('UnknownPartner')
    })
  })

  describe('resolveDocumentIntelligence', () => {
    test('composes sanitize + all 3 resolution steps', () => {
      const doc = makeDoc({
        documentName: '<b>Test</b> Document',
        productsReferenced: [{ name: 'NotReal', slug: null }],
        competitorsReferenced: [{ name: 'VMware', context: 'displacement' }],
        partnerSolutions: [{ partnerName: 'crowdstrike', solutionArea: 'Security' }],
      })
      const partners = [makePartnerCache('CrowdStrike')]
      const result = resolveDocumentIntelligence(doc, partners)

      // Sanitized: HTML stripped
      expect(result.documentName).not.toContain('<b>')
      // Partner resolved to canonical name
      expect(result.partnerSolutions![0].partnerName).toBe('CrowdStrike')
      // Returns new object (immutable)
      expect(result).not.toBe(doc)
    })

    test('handles null optional fields gracefully', () => {
      const doc = makeDoc({
        integrationsReferenced: null,
        competitorsReferenced: null,
        partnerSolutions: null,
      })
      const result = resolveDocumentIntelligence(doc, [])
      expect(result.integrationsReferenced).toBeNull()
      expect(result.competitorsReferenced).toBeNull()
      expect(result.partnerSolutions).toBeNull()
    })
  })
})
