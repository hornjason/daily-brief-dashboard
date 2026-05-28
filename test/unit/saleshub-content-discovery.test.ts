/**
 * Unit tests for SalesHub DocCenter content discovery via faceted API (#448)
 *
 * Tests the pure logic functions (no browser required):
 * - DocCenterDocument type structure
 * - API response parsing
 * - PPTX text extraction from XML
 * - Knowledge base merge logic
 * - Size gate enforcement
 * - Facet discovery response parsing
 */

import { describe, it, expect } from 'bun:test'
import {
  parseDocumentsFromApiResponse,
  parseFacetsFromApiResponse,
  extractTextFromPptxSlideXml,
  mergeDocumentsIntoKnowledge,
  shouldSkipDocument,
  type DocCenterDocument,
  type FacetDiscoveryResult,
} from '../../scripts/saleshub-content-discovery.ts'

// ── Mock API response matching real Seismic DocCenter search API shape ──

const MOCK_API_RESPONSE = {
  ServiceResult: {
    Documents: [
      {
        Name: 'Ansible Automation Platform Cheatsheet',
        VersionId: 'v-abc-123',
        ContentId: 'c-abc-123',
        Format: 'PDF',
        Size: 2_500_000,
        VersionCreated: '2026-03-15T10:00:00Z',
        DistributionTerms: 'General Distribution',
        CustomProperties: [
          { name: 'Content Type', values: [{ value: 'Cheatsheet' }] },
          { name: 'Product', values: [{ value: 'Red Hat Ansible Automation Platform' }] },
          { name: 'Sales Stage', values: [{ value: '1. Discover' }] },
          { name: 'TDP', values: [{ value: 'Automation' }] },
        ],
      },
      {
        Name: 'OpenShift Customer Deck',
        VersionId: 'v-def-456',
        ContentId: 'c-def-456',
        Format: 'PPTX',
        Size: 15_000_000,
        VersionCreated: '2026-04-01T14:30:00Z',
        DistributionTerms: 'Confidential - Channel NDA Required',
        CustomProperties: [
          { name: 'Content Type', values: [{ value: 'Business presentation' }] },
          { name: 'Product', values: [{ value: 'Red Hat OpenShift' }] },
          { name: 'Sales Stage', values: [{ value: '2. Validate' }] },
          { name: 'Sales Play', values: [{ value: 'Build and Run Applications' }] },
        ],
      },
      {
        Name: 'RHEL vs VMware Competitive Review',
        VersionId: 'v-ghi-789',
        ContentId: 'c-ghi-789',
        Format: 'PDF',
        Size: 5_000_000,
        VersionCreated: '2026-02-20T09:00:00Z',
        DistributionTerms: 'General Distribution',
        CustomProperties: [
          { name: 'Content Type', values: [{ value: 'Competitive review' }] },
          { name: 'Product', values: [{ value: 'Red Hat Enterprise Linux' }] },
          { name: 'Sales Stage', values: [{ value: '1. Discover' }] },
          { name: 'Sales Tactic', values: [{ value: 'VM migration' }] },
        ],
      },
    ],
    TotalDocuments: 3,
  },
}

const MOCK_FACET_RESPONSE = {
  ServiceResult: {
    Documents: [],
    TotalDocuments: 150,
    Aggregations: [
      {
        name: 'TDP',
        values: [
          { value: 'Automation', count: 30 },
          { value: 'AI Platform', count: 25 },
          { value: 'App Platform', count: 40 },
          { value: 'Virtualization', count: 20 },
          { value: 'Server/Cloud OS', count: 15 },
          { value: 'Container Mgmt', count: 20 },
        ],
      },
      {
        name: 'Sales Play',
        values: [
          { value: 'Build and Run Applications', count: 50 },
          { value: 'Modernize Infrastructure', count: 35 },
          { value: 'IT Operations Efficiency', count: 30 },
          { value: 'The AI-Ready Enterprise', count: 25 },
          { value: 'Sovereignty', count: 10 },
        ],
      },
      {
        name: 'Sales Tactic',
        values: [
          { value: 'VM migration', count: 15 },
          { value: 'Agentic AI', count: 12 },
          { value: 'Network Automation', count: 10 },
          { value: 'Container Adoption', count: 18 },
        ],
      },
      {
        name: 'Content Type',
        values: [
          { value: 'Business presentation', count: 60 },
          { value: 'Cheatsheet', count: 25 },
          { value: 'Competitive review', count: 15 },
          { value: 'Page RHSH', count: 50 },
        ],
      },
    ],
  },
}

describe('parseDocumentsFromApiResponse', () => {
  it('parses documents with correct field mappings', () => {
    const docs = parseDocumentsFromApiResponse(MOCK_API_RESPONSE)
    expect(docs).toHaveLength(3)

    const cheatsheet = docs[0]
    expect(cheatsheet.name).toBe('Ansible Automation Platform Cheatsheet')
    expect(cheatsheet.contentType).toBe('Cheatsheet')
    expect(cheatsheet.versionId).toBe('v-abc-123')
    expect(cheatsheet.size).toBe(2_500_000)
    expect(cheatsheet.product).toBe('Red Hat Ansible Automation Platform')
    expect(cheatsheet.salesStage).toBe('1. Discover')
    expect(cheatsheet.tdp).toBe('Automation')
    expect(cheatsheet.distributionTerms).toBe('General Distribution')
  })

  it('extracts Sales Play association from CustomProperties', () => {
    const docs = parseDocumentsFromApiResponse(MOCK_API_RESPONSE)
    const deck = docs[1]
    expect(deck.salesPlay).toBe('Build and Run Applications')
    expect(deck.contentType).toBe('Business presentation')
  })

  it('extracts Sales Tactic association from CustomProperties', () => {
    const docs = parseDocumentsFromApiResponse(MOCK_API_RESPONSE)
    const review = docs[2]
    expect(review.salesTactic).toBe('VM migration')
    expect(review.contentType).toBe('Competitive review')
  })

  it('returns empty array for response with no documents', () => {
    const docs = parseDocumentsFromApiResponse({ ServiceResult: { Documents: [], TotalDocuments: 0 } })
    expect(docs).toHaveLength(0)
  })

  it('handles response with missing ServiceResult gracefully', () => {
    const docs = parseDocumentsFromApiResponse({})
    expect(docs).toHaveLength(0)
  })

  it('handles documents with missing CustomProperties', () => {
    const response = {
      ServiceResult: {
        Documents: [{
          Name: 'Orphan Doc',
          VersionId: 'v-xxx',
          ContentId: 'c-xxx',
          Format: 'PDF',
          Size: 1000,
          VersionCreated: '2026-01-01',
          DistributionTerms: '',
        }],
        TotalDocuments: 1,
      },
    }
    const docs = parseDocumentsFromApiResponse(response)
    expect(docs).toHaveLength(1)
    expect(docs[0].contentType).toBe('')
    expect(docs[0].product).toBe('')
    expect(docs[0].tdp).toBeUndefined()
  })
})

describe('parseFacetsFromApiResponse', () => {
  it('extracts TDP facets', () => {
    const facets = parseFacetsFromApiResponse(MOCK_FACET_RESPONSE)
    expect(facets.tdps).toContain('Automation')
    expect(facets.tdps).toContain('AI Platform')
    expect(facets.tdps).toContain('App Platform')
    expect(facets.tdps.length).toBe(6)
  })

  it('extracts Sales Play facets', () => {
    const facets = parseFacetsFromApiResponse(MOCK_FACET_RESPONSE)
    expect(facets.salesPlays).toContain('Build and Run Applications')
    expect(facets.salesPlays).toContain('Sovereignty')
    expect(facets.salesPlays.length).toBe(5)
  })

  it('extracts Sales Tactic facets', () => {
    const facets = parseFacetsFromApiResponse(MOCK_FACET_RESPONSE)
    expect(facets.salesTactics).toContain('VM migration')
    expect(facets.salesTactics).toContain('Agentic AI')
    expect(facets.salesTactics.length).toBe(4)
  })

  it('extracts Content Type facets', () => {
    const facets = parseFacetsFromApiResponse(MOCK_FACET_RESPONSE)
    expect(facets.contentTypes).toContain('Business presentation')
    expect(facets.contentTypes).toContain('Cheatsheet')
    expect(facets.contentTypes.length).toBe(4)
  })

  it('returns empty arrays when aggregations are missing', () => {
    const facets = parseFacetsFromApiResponse({ ServiceResult: { Documents: [], TotalDocuments: 0 } })
    expect(facets.tdps).toHaveLength(0)
    expect(facets.salesPlays).toHaveLength(0)
    expect(facets.salesTactics).toHaveLength(0)
    expect(facets.contentTypes).toHaveLength(0)
  })
})

describe('shouldSkipDocument', () => {
  it('skips documents over 200MB', () => {
    const doc: DocCenterDocument = {
      name: 'Huge File',
      contentType: 'Business presentation',
      size: 201 * 1024 * 1024, // 201MB
      version: '',
      versionCreated: '',
      versionId: 'v1',
      downloadUrl: '',
      distributionTerms: '',
      product: '',
      salesStage: '',
    }
    expect(shouldSkipDocument(doc)).toBe(true)
  })

  it('allows documents under 200MB', () => {
    const doc: DocCenterDocument = {
      name: 'Normal File',
      contentType: 'Cheatsheet',
      size: 5_000_000, // 5MB
      version: '',
      versionCreated: '',
      versionId: 'v1',
      downloadUrl: '',
      distributionTerms: '',
      product: '',
      salesStage: '',
    }
    expect(shouldSkipDocument(doc)).toBe(false)
  })

  it('allows documents exactly at 200MB', () => {
    const doc: DocCenterDocument = {
      name: 'Edge Case',
      contentType: 'Business presentation',
      size: 200 * 1024 * 1024, // exactly 200MB
      version: '',
      versionCreated: '',
      versionId: 'v1',
      downloadUrl: '',
      distributionTerms: '',
      product: '',
      salesStage: '',
    }
    expect(shouldSkipDocument(doc)).toBe(false)
  })

  it('skips video formats', () => {
    const doc: DocCenterDocument = {
      name: 'Training Video',
      contentType: 'Video',
      size: 1000,
      version: '',
      versionCreated: '',
      versionId: 'v1',
      downloadUrl: '',
      distributionTerms: '',
      product: '',
      salesStage: '',
    }
    expect(shouldSkipDocument(doc)).toBe(true)
  })
})

describe('extractTextFromPptxSlideXml', () => {
  it('extracts text from slide XML with a:t elements', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
           xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
      <p:cSld>
        <p:spTree>
          <p:sp>
            <p:txBody>
              <a:p><a:r><a:t>Enterprise Automation Strategy</a:t></a:r></a:p>
              <a:p><a:r><a:t>Key Benefits for IT Teams</a:t></a:r></a:p>
            </p:txBody>
          </p:sp>
        </p:spTree>
      </p:cSld>
    </p:sld>`

    const text = extractTextFromPptxSlideXml(xml)
    expect(text).toContain('Enterprise Automation Strategy')
    expect(text).toContain('Key Benefits for IT Teams')
  })

  it('returns empty string for empty XML', () => {
    expect(extractTextFromPptxSlideXml('')).toBe('')
  })

  it('handles XML with no text elements', () => {
    const xml = `<?xml version="1.0"?><p:sld><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>`
    const text = extractTextFromPptxSlideXml(xml)
    expect(text).toBe('')
  })

  it('handles notes slide XML', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
      <p:cSld>
        <p:spTree>
          <p:sp>
            <p:txBody>
              <a:p><a:r><a:t>Speaker notes content here</a:t></a:r></a:p>
            </p:txBody>
          </p:sp>
        </p:spTree>
      </p:cSld>
    </p:notes>`

    const text = extractTextFromPptxSlideXml(xml)
    expect(text).toContain('Speaker notes content here')
  })
})

describe('mergeDocumentsIntoKnowledge', () => {
  it('merges documents into TDP nodes by TDP tag', () => {
    const docs: DocCenterDocument[] = [
      {
        name: 'Automation Cheatsheet',
        contentType: 'Cheatsheet',
        size: 1000,
        version: '1',
        versionCreated: '2026-01-01',
        versionId: 'v1',
        downloadUrl: '',
        distributionTerms: 'General',
        product: 'Ansible',
        salesStage: '1. Discover',
        tdp: 'Automation',
        extractedContent: 'Some extracted content',
      },
    ]

    const tdps = [
      { name: 'Automation', description: '', tactics: [], products: [], customerWins: [], whatToSay: [], whatToShare: [], whatToShow: [], services: [], cheatsheetUrl: '', customerDeckUrl: '', extractedContent: '', metrics: [] },
      { name: 'AI Platform', description: '', tactics: [], products: [], customerWins: [], whatToSay: [], whatToShare: [], whatToShow: [], services: [], cheatsheetUrl: '', customerDeckUrl: '', extractedContent: '', metrics: [] },
    ]

    const result = mergeDocumentsIntoKnowledge(docs, tdps, [])
    const automationTdp = result.tdps.find(t => t.name === 'Automation')
    expect(automationTdp?.documents).toBeDefined()
    expect(automationTdp?.documents).toHaveLength(1)
    expect(automationTdp?.documents?.[0].name).toBe('Automation Cheatsheet')

    // AI Platform should have no documents
    const aiTdp = result.tdps.find(t => t.name === 'AI Platform')
    expect(aiTdp?.documents ?? []).toHaveLength(0)
  })

  it('merges documents into sales play nodes by play tag', () => {
    const docs: DocCenterDocument[] = [
      {
        name: 'Build and Run Deck',
        contentType: 'Business presentation',
        size: 5000,
        version: '1',
        versionCreated: '2026-01-01',
        versionId: 'v2',
        downloadUrl: '',
        distributionTerms: 'General',
        product: 'OpenShift',
        salesStage: '2. Validate',
        salesPlay: 'Build and Run Applications',
      },
    ]

    const salesPlays = [
      { name: 'Build and Run Applications', description: '', linkedTdps: [], customerLens: { pain: [], outcomes: [], impact: [] }, realWorldExamples: [], emailTemplateUrl: '', discoveryQuestionsUrl: '', introPitchDeckUrl: '', personaSection: { roles: [], painPoints: [], discoveryQuestions: [], valueProps: [], whatWinsThemOver: [] }, tdpAlignment: [], regionalCampaigns: [] },
    ]

    const result = mergeDocumentsIntoKnowledge(docs, [], salesPlays)
    const play = result.salesPlays.find(p => p.name === 'Build and Run Applications')
    expect(play?.documents).toBeDefined()
    expect(play?.documents).toHaveLength(1)
    expect(play?.documents?.[0].name).toBe('Build and Run Deck')
  })

  it('handles documents with no TDP or play association', () => {
    const docs: DocCenterDocument[] = [
      {
        name: 'Orphan Doc',
        contentType: 'Cheatsheet',
        size: 1000,
        version: '1',
        versionCreated: '2026-01-01',
        versionId: 'v3',
        downloadUrl: '',
        distributionTerms: 'General',
        product: 'RHEL',
        salesStage: '1. Discover',
        // no tdp, no salesPlay, no salesTactic
      },
    ]

    const tdps = [
      { name: 'Automation', description: '', tactics: [], products: [], customerWins: [], whatToSay: [], whatToShare: [], whatToShow: [], services: [], cheatsheetUrl: '', customerDeckUrl: '', extractedContent: '', metrics: [] },
    ]

    const result = mergeDocumentsIntoKnowledge(docs, tdps, [])
    // Orphan doc should not appear in any TDP
    for (const tdp of result.tdps) {
      expect(tdp.documents ?? []).toHaveLength(0)
    }
    // But the unmatched documents should be returned
    expect(result.unmatched).toHaveLength(1)
  })

  it('handles empty document array', () => {
    const result = mergeDocumentsIntoKnowledge([], [{ name: 'Test', description: '', tactics: [], products: [], customerWins: [], whatToSay: [], whatToShare: [], whatToShow: [], services: [], cheatsheetUrl: '', customerDeckUrl: '', extractedContent: '', metrics: [] }], [])
    expect(result.tdps[0].documents ?? []).toHaveLength(0)
    expect(result.unmatched).toHaveLength(0)
  })

  it('matches documents to TDPs case-insensitively', () => {
    const docs: DocCenterDocument[] = [
      {
        name: 'automation deck',
        contentType: 'Business presentation',
        size: 1000,
        version: '1',
        versionCreated: '2026-01-01',
        versionId: 'v4',
        downloadUrl: '',
        distributionTerms: 'General',
        product: '',
        salesStage: '',
        tdp: 'automation', // lowercase
      },
    ]

    const tdps = [
      { name: 'Automation', description: '', tactics: [], products: [], customerWins: [], whatToSay: [], whatToShare: [], whatToShow: [], services: [], cheatsheetUrl: '', customerDeckUrl: '', extractedContent: '', metrics: [] },
    ]

    const result = mergeDocumentsIntoKnowledge(docs, tdps, [])
    expect(result.tdps[0].documents).toHaveLength(1)
  })
})
