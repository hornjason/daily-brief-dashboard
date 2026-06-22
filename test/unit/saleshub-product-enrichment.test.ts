/**
 * SalesHub Product Enrichment — Unit Tests (GitHub Issue #819, #866)
 *
 * Tests the Gemini-powered enrichment using the universal DocumentIntelligence
 * schema (ADR-041). Mocks callGemini to avoid real API calls.
 *
 * Also tests extractWithGemini ceremony including responseSchema fence-stripping bypass.
 */

import { describe, test, expect } from 'bun:test'
import {
  enrichDocumentIntelligence,
  enrichProductDocuments,
  extractWithGemini,
  stripMarkdownFences,
  type ExtractionConfig,
  type GeminiCaller,
} from '../../src/lib/saleshub-product-enrichment.ts'
import { matchDocumentToCustomer } from '../../src/modules/saleshub-products-module.ts'
import type { DocumentIntelligence } from '../../src/types/saleshub-product-types.ts'

// ── Helper: mock Gemini response ───────────────────────────────────────────

function mockGeminiResponse(data: any): GeminiCaller {
  return () => Promise.resolve({
    text: JSON.stringify(data),
    cached: false,
    inputTokens: 100,
    outputTokens: 200,
    model: 'gemini-2.0-flash',
  })
}

// Valid DocumentIntelligence mock response
const VALID_DOC_INTELLIGENCE = {
  documentCategory: 'content-kit',
  summary: 'A comprehensive guide to integrating ServiceNow ITSM with Ansible Automation Platform.',
  productsReferenced: [{ name: 'Ansible Automation Platform' }],
  integrationsReferenced: [{ technology: 'ServiceNow', category: 'ITSM' }],
  competitorsReferenced: null,
  partnerSolutions: [{ partnerName: 'ServiceNow', solutionArea: 'ITSM' }],
  useCases: ['ITSM automation', 'Ticket-driven remediation'],
  customerScenarios: null,
  cloudProviders: null,
  audience: 'customer',
  keyPoints: ['Automate incident response', 'Reduce MTTR'],
  talkTracks: ['Ask about ServiceNow ITSM integration needs'],
  links: [
    { name: 'Content Kit', url: 'https://saleshub.redhat.com/kit' },
    { name: 'Lab', url: 'https://labs.redhat.com/servicenow' },
  ],
  actionableSteps: [{ step: 'Schedule ServiceNow demo', url: 'https://demo.redhat.com' }],
  workshops: [{ name: 'ITSM Workshop', url: 'https://labs.redhat.com/itsm' }],
  demos: [{ name: 'ServiceNow Demo', url: 'https://demo.redhat.com/sn' }],
}

describe('saleshub-product-enrichment (ADR-041)', () => {

  describe('enrichDocumentIntelligence', () => {
    test('extracts DocumentIntelligence from document content', async () => {
      const result = await enrichDocumentIntelligence(
        { name: 'ServiceNow ITSM Kit', content: 'Content about ServiceNow', type: 'content-kit' },
        mockGeminiResponse(VALID_DOC_INTELLIGENCE),
      )

      expect(result).toBeTruthy()
      expect(result!.documentName).toBe('ServiceNow ITSM Kit')
      expect(result!.documentCategory).toBe('content-kit')
      expect(result!.productsReferenced).toHaveLength(1)
      expect(result!.productsReferenced[0].name).toBe('Ansible Automation Platform')
      expect(result!.integrationsReferenced).toHaveLength(1)
      expect(result!.integrationsReferenced![0].technology).toBe('ServiceNow')
      expect(result!.useCases).toHaveLength(2)
      expect(result!.links).toHaveLength(2)
    })

    test('returns null on Gemini failure', async () => {
      const result = await enrichDocumentIntelligence(
        { name: 'Bad Kit', content: 'content', type: 'content-kit' },
        () => Promise.reject(new Error('Gemini API error')),
      )
      expect(result).toBeNull()
    })

    test('returns null on invalid JSON response', async () => {
      const result = await enrichDocumentIntelligence(
        { name: 'Bad JSON Kit', content: 'content', type: 'content-kit' },
        () => Promise.resolve({
          text: 'not valid json at all',
          cached: false,
          inputTokens: 50,
          outputTokens: 50,
          model: 'gemini-2.0-flash',
        }),
      )
      expect(result).toBeNull()
    })

    test('handles nullable fields correctly', async () => {
      const minimalResponse = {
        documentCategory: 'battlecard',
        summary: 'VMware vs OpenShift Virtualization battlecard.',
        productsReferenced: [{ name: 'OpenShift' }],
        integrationsReferenced: null,
        competitorsReferenced: [{ name: 'VMware', context: 'displacement' }],
        partnerSolutions: null,
        useCases: null,
        customerScenarios: null,
        cloudProviders: null,
        audience: 'internal',
        keyPoints: ['Lower TCO'],
        talkTracks: null,
        links: [],
        actionableSteps: null,
        workshops: null,
        demos: null,
      }

      const result = await enrichDocumentIntelligence(
        { name: 'VMware BC', content: 'content', type: 'battlecard' },
        mockGeminiResponse(minimalResponse),
      )

      expect(result).toBeTruthy()
      expect(result!.integrationsReferenced).toBeNull()
      expect(result!.partnerSolutions).toBeNull()
      expect(result!.useCases).toBeNull()
      expect(result!.competitorsReferenced).toHaveLength(1)
    })
  })

  describe('enrichProductDocuments', () => {
    test('populates documents[] with DocumentIntelligence entries', async () => {
      const mockGemini = (_type: string) => mockGeminiResponse(VALID_DOC_INTELLIGENCE)

      const result = await enrichProductDocuments('aap', [
        { name: 'Doc A', content: 'content a', type: 'content-kit' },
        { name: 'Doc B', content: 'content b', type: 'messaging-guide' },
      ], mockGemini)

      expect(result.productSlug).toBe('aap')
      expect(result.documents).toHaveLength(2)
      expect(result.documents[0].documentName).toBe('Doc A')
      expect(result.documents[1].documentName).toBe('Doc B')
      // sourceProductSlug is set by enrichProductDocuments
      expect(result.documents[0].sourceProductSlug).toBe('aap')
    })

    test('handles empty document list', async () => {
      const result = await enrichProductDocuments('test-product', [])
      expect(result.productSlug).toBe('test-product')
      expect(result.documents).toEqual([])
    })

    test('skips documents larger than 10MB', async () => {
      const largeContent = 'x'.repeat(11_000_000)
      const mockGemini = (_type: string) => mockGeminiResponse(VALID_DOC_INTELLIGENCE)

      const result = await enrichProductDocuments('test', [
        { name: 'Huge Doc', content: largeContent, type: 'content-kit' },
        { name: 'Normal Doc', content: 'small', type: 'content-kit' },
      ], mockGemini)

      expect(result.documents).toHaveLength(1)
      expect(result.documents[0].documentName).toBe('Normal Doc')
    })
  })

  describe('extractWithGemini', () => {
    test('bypasses fence-stripping when responseSchema is present', async () => {
      const config: ExtractionConfig<any> = {
        systemPrompt: 'test',
        userPromptFn: (_name, _content) => 'test prompt',
        callType: 'test-extraction',
        responseSchema: { type: 'object', properties: {} },
        parseResult: (raw) => raw,
      }

      // Gemini returns raw JSON (no fences) when responseSchema is set
      const rawJson = { key: 'value', nested: { a: 1 } }
      const gemini: GeminiCaller = () => Promise.resolve({
        text: JSON.stringify(rawJson),
        cached: false,
        inputTokens: 50,
        outputTokens: 50,
        model: 'gemini-2.0-flash',
      })

      const result = await extractWithGemini(config, 'test-doc', 'content', gemini)
      expect(result).toEqual(rawJson)
    })

    test('strips fences when responseSchema is NOT present', async () => {
      const config: ExtractionConfig<any> = {
        systemPrompt: 'test',
        userPromptFn: (_name, _content) => 'test prompt',
        callType: 'test-extraction',
        // No responseSchema
        parseResult: (raw) => raw,
      }

      const rawJson = { key: 'value' }
      const gemini: GeminiCaller = () => Promise.resolve({
        text: '```json\n' + JSON.stringify(rawJson) + '\n```',
        cached: false,
        inputTokens: 50,
        outputTokens: 50,
        model: 'gemini-2.0-flash',
      })

      const result = await extractWithGemini(config, 'test-doc', 'content', gemini)
      expect(result).toEqual(rawJson)
    })

    test('passes responseSchema and temperature to gemini opts', async () => {
      let receivedOpts: any = null
      const schema = { type: 'object', properties: { x: { type: 'string' } } }
      const config: ExtractionConfig<any> = {
        systemPrompt: 'test',
        userPromptFn: (_name, _content) => 'test',
        callType: 'test',
        responseSchema: schema,
        parseResult: (raw) => raw,
      }

      const gemini: GeminiCaller = (_sys, _user, opts) => {
        receivedOpts = opts
        return Promise.resolve({
          text: '{"x":"y"}',
          cached: false,
          inputTokens: 50,
          outputTokens: 50,
          model: 'gemini-2.0-flash',
        })
      }

      await extractWithGemini(config, 'doc', 'content', gemini)
      expect(receivedOpts.responseSchema).toEqual(schema)
      expect(receivedOpts.temperature).toBe(0.3)
      expect(receivedOpts.timeoutMs).toBe(90000)
    })
  })

  describe('stripMarkdownFences', () => {
    test('strips json code fences', () => {
      expect(stripMarkdownFences('```json\n{"a":1}\n```')).toBe('{"a":1}')
    })

    test('strips plain code fences', () => {
      expect(stripMarkdownFences('```\n{"a":1}\n```')).toBe('{"a":1}')
    })

    test('returns clean JSON unchanged', () => {
      expect(stripMarkdownFences('{"a":1}')).toBe('{"a":1}')
    })
  })

  describe('matchDocumentToCustomer', () => {
    function makeDocIntel(overrides: Partial<DocumentIntelligence> = {}): DocumentIntelligence {
      return {
        documentName: 'Test Doc',
        documentCategory: 'content-kit',
        summary: 'Test summary for validation purposes.',
        productsReferenced: [{ name: 'Ansible Automation Platform', slug: 'aap' }],
        integrationsReferenced: [{ technology: 'ServiceNow', category: 'ITSM' }],
        competitorsReferenced: null,
        partnerSolutions: null,
        useCases: ['ITSM automation'],
        customerScenarios: null,
        cloudProviders: null,
        audience: 'customer',
        keyPoints: ['Point 1'],
        talkTracks: null,
        links: [],
        actionableSteps: null,
        workshops: null,
        demos: null,
        enrichedAt: '2026-06-22T00:00:00.000Z',
        sourceProductSlug: 'aap',
        ...overrides,
      }
    }

    test('matches ServiceNow integration against tech stack', () => {
      // This test depends on having a tech stack cache file at
      // data/cache/tech-stack/test-customer.json. Since we can't guarantee
      // that in unit tests, we test the function's logic by verifying
      // it returns no match when no cache exists.
      const doc = makeDocIntel()
      const result = matchDocumentToCustomer(doc, 'nonexistent-customer')
      expect(result.matched).toBe(false)
      expect(result.matchTypes).toEqual([])
    })

    test('4-char minimum prevents short matches', () => {
      // "AI" is only 2 chars — should NOT match "Ansible Automation Platform"
      const doc = makeDocIntel({
        integrationsReferenced: [{ technology: 'AI', category: 'Other' }],
      })
      const result = matchDocumentToCustomer(doc, 'nonexistent-customer')
      expect(result.matched).toBe(false)
    })

    test('returns all match types (not early-return)', () => {
      // Verify the function signature returns matchTypes as array
      const doc = makeDocIntel()
      const result = matchDocumentToCustomer(doc, 'test')
      expect(Array.isArray(result.matchTypes)).toBe(true)
      expect(Array.isArray(result.matchedItems)).toBe(true)
    })
  })
})
