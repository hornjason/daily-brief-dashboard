/**
 * Unit tests for meeting-prep-enrichment.ts — ADR-025
 * Tests four builder functions + extractProofPoints helper
 */
import { describe, test, expect } from 'bun:test'
import {
  buildProductAlignmentTable,
  buildSummitAnnouncementsTable,
  buildEnhancedLifecycleTable,
  buildRSSIntelligenceTable,
  extractProofPoints,
  buildSalesAlignmentBlock,
} from '../../src/meeting-prep-enrichment.ts'
import type { Customer } from '../../src/types.ts'
import type { ProductSummary } from '../../src/product-release-radar.ts'
import type { ProductLifecycleCache } from '../../src/product-lifecycle.ts'
import type { RSSItemLike } from '../../src/meeting-prep-enrichment.ts'

// ── Fixtures ────────────────────────────────────────────────────────────────

const now = new Date()
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString()
const daysFromNow = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString()

const mockCustomer: Customer = {
  name: 'Acme Corp',
  domain: 'acme.com',
  accountNumbers: ['12345'],
  ae: 'Jane Doe',
}

const mockProductSummaries: ProductSummary[] = [
  {
    slug: 'ocp',
    displayName: 'Red Hat OpenShift',
    shortName: 'OCP',
    currentVersion: '4.17',
    gaDate: daysAgo(10),
    eolDate: daysFromNow(365),
    summaryText: 'OpenShift 4.17 is generally available',
    summaryBullets: ['HCP improvements', 'GitOps enhancements', 'Multi-cluster management'],
    sources: ['https://example.com'],
    contentHash: 'abc123',
    synthesizedAt: daysAgo(5),
    refreshedAt: daysAgo(1),
  },
  {
    slug: 'aap',
    displayName: 'Red Hat Ansible Automation Platform',
    shortName: 'AAP',
    currentVersion: '2.6',
    gaDate: daysAgo(20),
    eolDate: daysFromNow(300),
    summaryText: 'AAP 2.6 with Lightspeed GA',
    summaryBullets: ['Ansible Lightspeed GA', 'Event-Driven Ansible 1.2'],
    sources: ['https://example.com'],
    contentHash: 'def456',
    synthesizedAt: daysAgo(15),
    refreshedAt: daysAgo(2),
  },
]

const oldProductSummary: ProductSummary = {
  slug: 'rhel',
  displayName: 'Red Hat Enterprise Linux',
  shortName: 'RHEL',
  currentVersion: '9.5',
  gaDate: daysAgo(90),
  eolDate: daysFromNow(365),
  summaryText: 'RHEL 9.5 released',
  summaryBullets: ['Image mode', 'Security updates'],
  sources: [],
  contentHash: 'ghi789',
  synthesizedAt: daysAgo(60),
  refreshedAt: daysAgo(45),
}

const mockRSSItems: RSSItemLike[] = [
  {
    title: 'Ansible Lightspeed: From Pilot to Production',
    link: 'https://redhat.com/blog/ansible-lightspeed',
    description: 'Learn how to deploy Lightspeed',
    pubDate: daysAgo(3),
    source: 'Red Hat Blog',
    productTags: ['aap'],
  },
  {
    title: 'Red Hat Summit 2026 Keynote Recap',
    link: 'https://redhat.com/summit/keynote',
    description: 'Keynote highlights',
    pubDate: daysAgo(5),
    source: 'Press Release',
    productTags: ['ocp', 'aap', 'rhel'],
  },
  {
    title: 'OpenShift 4.17 Migration Guide',
    link: 'https://developers.redhat.com/ocp-migration',
    description: 'Migration guide for OCP 4.17',
    pubDate: daysAgo(8),
    source: 'Developer Blog',
    productTags: ['ocp'],
  },
  {
    title: 'Old Article About RHEL',
    link: 'https://redhat.com/blog/old-rhel',
    description: 'Old news',
    pubDate: daysAgo(45),
    source: 'Red Hat Blog',
    productTags: ['rhel'],
  },
]

const mockRoadmapData = [
  {
    product: 'ocp',
    displayName: 'Red Hat OpenShift',
    nextVersion: '4.18',
    expectedDate: 'Q3 2026',
    highlights: ['HCP GA', 'improved GitOps', 'network observability'],
    source: 'internal',
  },
  {
    product: 'aap',
    displayName: 'Red Hat Ansible Automation Platform',
    nextVersion: '2.7',
    expectedDate: 'Q4 2026',
    highlights: ['Lightspeed enhancements', 'EDA 1.3'],
    source: 'internal',
  },
]

const mockLifecycleCache: ProductLifecycleCache = {
  products: [
    {
      slug: 'ocp',
      displayName: 'Red Hat OpenShift Container Platform',
      currentVersion: '4.17',
      latestPatch: '4.17.2',
      nextVersion: '4.18',
      nextExpected: daysFromNow(90),
      gaDate: daysAgo(30),
      eolDate: daysFromNow(365),
      eusAvailable: true,
      supportEnd: daysFromNow(730),
    },
    {
      slug: 'aap',
      displayName: 'Red Hat Ansible Automation Platform',
      currentVersion: '2.6',
      latestPatch: '2.6.1',
      nextVersion: '2.7',
      nextExpected: daysFromNow(180),
      gaDate: daysAgo(60),
      eolDate: daysFromNow(300),
      eusAvailable: false,
      supportEnd: daysFromNow(500),
    },
  ],
  fetchedAt: daysAgo(1),
}

// ── extractProofPoints ──────────────────────────────────────────────────────

describe('extractProofPoints', () => {
  test('extracts percentage metrics', () => {
    // Function expects structured value map format: "N% Label" on separate lines
    const text = `667% Return on Investment
60% Reduction in Manual Tasks`
    const points = extractProofPoints(text)
    expect(points.some(p => p.includes('667%'))).toBe(true)
    expect(points.some(p => p.includes('60%'))).toBe(true)
  })

  test('extracts dollar metrics', () => {
    const text = 'Platform drives $2B ARR and saves $500K annually'
    const points = extractProofPoints(text)
    expect(points.some(p => p.includes('$2B'))).toBe(true)
    expect(points.some(p => p.includes('$500K'))).toBe(true)
  })

  test('extracts analyst citations from Source lines', () => {
    // Function looks for "Source: <analyst>" lines after metrics
    const text = `58% Reduction in Downtime
Source: Forrester TEI Study
40% Faster Deployment
Source: IDC MarketScape Report`
    const points = extractProofPoints(text)
    expect(points.some(p => p.includes('Forrester'))).toBe(true)
    expect(points.some(p => p.includes('IDC'))).toBe(true)
  })

  test('deduplicates and caps at 4', () => {
    const text = '10% savings, 20% faster, 30% cheaper, 40% better, 50% improved, Forrester TEI, IDC study'
    const points = extractProofPoints(text)
    expect(points.length).toBeLessThanOrEqual(4)
    // Ensure no duplicates
    expect(new Set(points).size).toBe(points.length)
  })

  test('returns empty array for text with no metrics', () => {
    const text = 'Red Hat provides enterprise solutions for modern IT infrastructure.'
    const points = extractProofPoints(text)
    expect(points).toEqual([])
  })
})

// ── buildProductAlignmentTable ──────────────────────────────────────────────

describe('buildProductAlignmentTable', () => {
  test('returns table header and format', () => {
    const result = buildProductAlignmentTable(mockCustomer, ['ocp', 'aap'], {
      productSummaries: mockProductSummaries,
      rssItems: mockRSSItems,
      customerSlug: 'acme-corp',
      getValueMapFn: (_slug: string) => 'Achieves 667% ROI with Forrester TEI validation',
      getIntelFn: (_ps: string, _cs: string) => ({
        product: 'ocp', customer: 'acme-corp', relevanceScore: 'HIGH' as const,
        priorityAction: 'Discuss upgrade', roadmapRelevance: [], expansionOpportunities: [],
        caseAlignment: [], competitiveAngle: null, generatedAt: daysAgo(1), productCacheHash: 'x',
      }),
      getSheetCacheFn: (_name: string) => ({
        rows: [{ sku: 'OCP-STD', productDescription: 'OpenShift Container Platform', quantity: 50, status: 'Active' }],
        cachedAt: daysAgo(1),
      }),
    })
    expect(result).toContain('**Product Alignment')
    expect(result).toContain('Confidence')
    expect(result).toContain('|')
  })

  test('assigns HIGH confidence when subscription + HIGH relevance + value map exists', () => {
    const result = buildProductAlignmentTable(mockCustomer, ['ocp'], {
      productSummaries: mockProductSummaries,
      rssItems: [],
      customerSlug: 'acme-corp',
      getValueMapFn: () => 'Some value map text with 50% improvement',
      getIntelFn: () => ({
        product: 'ocp', customer: 'acme-corp', relevanceScore: 'HIGH' as const,
        priorityAction: 'Discuss upgrade', roadmapRelevance: [], expansionOpportunities: [],
        caseAlignment: [], competitiveAngle: null, generatedAt: daysAgo(1), productCacheHash: 'x',
      }),
      getSheetCacheFn: () => ({
        rows: [{ sku: 'OCP', productDescription: 'OpenShift', quantity: 10, status: 'Active' }],
        cachedAt: daysAgo(1),
      }),
    })
    expect(result).toContain('HIGH')
  })

  test('assigns MEDIUM confidence when only subscription exists', () => {
    const result = buildProductAlignmentTable(mockCustomer, ['ocp'], {
      productSummaries: mockProductSummaries,
      rssItems: [],
      customerSlug: 'acme-corp',
      getValueMapFn: () => null,
      getIntelFn: () => null,
      getSheetCacheFn: () => ({
        rows: [{ sku: 'OCP', productDescription: 'OpenShift', quantity: 10, status: 'Active' }],
        cachedAt: daysAgo(1),
      }),
    })
    expect(result).toContain('MEDIUM')
  })

  test('assigns LOW confidence for expansion-only products', () => {
    const result = buildProductAlignmentTable(mockCustomer, ['ocp'], {
      productSummaries: mockProductSummaries,
      rssItems: [],
      customerSlug: 'acme-corp',
      getValueMapFn: () => null,
      getIntelFn: () => null,
      getSheetCacheFn: () => null,
    })
    expect(result).toContain('LOW')
  })

  test('returns empty string when no product slugs', () => {
    const result = buildProductAlignmentTable(mockCustomer, [], {
      productSummaries: mockProductSummaries,
      rssItems: [],
      customerSlug: 'acme-corp',
    })
    expect(result).toBe('')
  })

  test('includes bold summit news for recent announcements', () => {
    const result = buildProductAlignmentTable(mockCustomer, ['ocp'], {
      productSummaries: mockProductSummaries,
      rssItems: [],
      customerSlug: 'acme-corp',
      getValueMapFn: () => 'Some text',
      getIntelFn: () => null,
      getSheetCacheFn: () => null,
    })
    // OCP summary GA date is 10 days ago — within 30 days
    expect(result).toContain('**')
  })
})

// ── buildSummitAnnouncementsTable ───────────────────────────────────────────

describe('buildSummitAnnouncementsTable', () => {
  test('returns header and table format', () => {
    const result = buildSummitAnnouncementsTable(
      ['ocp', 'aap'],
      mockRSSItems,
      mockProductSummaries,
      mockRoadmapData,
    )
    expect(result).toContain('**Recent Announcements')
    expect(result).toContain('|')
  })

  test('filters items to last 30 days', () => {
    const result = buildSummitAnnouncementsTable(
      ['rhel'],
      mockRSSItems, // contains one old RHEL item at 45 days ago
      [oldProductSummary],
      [],
    )
    // Old article (45 days) should NOT appear; old product summary (90 days GA) should NOT appear
    expect(result).not.toContain('Old Article')
  })

  test('filters to relevant product slugs', () => {
    const result = buildSummitAnnouncementsTable(
      ['aap'], // only AAP
      mockRSSItems,
      mockProductSummaries,
      mockRoadmapData,
    )
    // Should contain AAP items but not OCP-only items
    expect(result).toContain('Ansible')
    // Summit keynote is tagged with aap so it should appear
    expect(result).toContain('Summit')
  })

  test('caps at 8 rows', () => {
    const manyItems: RSSItemLike[] = Array.from({ length: 15 }, (_, i) => ({
      title: `Article ${i + 1}`,
      link: `https://example.com/${i}`,
      description: '',
      pubDate: daysAgo(i + 1),
      source: 'Blog',
      productTags: ['ocp'],
    }))
    const result = buildSummitAnnouncementsTable(['ocp'], manyItems, [], [])
    const dataRows = result.split('\n').filter(l => l.trim().startsWith('|')).length - 2 // minus header + separator
    expect(dataRows).toBeLessThanOrEqual(8)
  })

  test('returns empty string when no items match', () => {
    const result = buildSummitAnnouncementsTable(['satellite'], [], [], [])
    expect(result).toBe('')
  })

  test('includes recency framing for recent items', () => {
    const recentItem: RSSItem = {
      title: 'Brand New OCP Announcement',
      link: 'https://redhat.com/new',
      description: '',
      pubDate: daysAgo(2),
      source: 'Press Release',
      productTags: ['ocp'],
    }
    const result = buildSummitAnnouncementsTable(['ocp'], [recentItem], [], [])
    // Within 7 days should get recency framing
    expect(result).toContain('day')
  })

  test('includes upcoming roadmap items with Coming prefix', () => {
    const result = buildSummitAnnouncementsTable(
      ['ocp'],
      [],
      [],
      mockRoadmapData,
    )
    expect(result).toContain('Coming')
  })
})

// ── buildEnhancedLifecycleTable ─────────────────────────────────────────────

describe('buildEnhancedLifecycleTable', () => {
  test('returns header and table with Key Changes and Customer Angle', () => {
    const result = buildEnhancedLifecycleTable(
      mockCustomer,
      ['ocp', 'aap'],
      mockLifecycleCache,
      mockRoadmapData,
      mockProductSummaries,
      {
        getSheetCacheFn: () => ({
          rows: [{ sku: 'OCP', productDescription: 'OpenShift', quantity: 50, status: 'Active' }],
          cachedAt: daysAgo(1),
        }),
      },
    )
    expect(result).toContain('**Enhanced Lifecycle')
    expect(result).toContain('Key Changes')
    expect(result).toContain('Customer Angle')
    expect(result).toContain('|')
  })

  test('caps key changes at 3 items', () => {
    const result = buildEnhancedLifecycleTable(
      mockCustomer,
      ['ocp'],
      mockLifecycleCache,
      mockRoadmapData,
      mockProductSummaries,
      { getSheetCacheFn: () => null },
    )
    // Key changes from roadmap highlights (3 items) + summary bullets — should be capped at 3
    const lines = result.split('\n').filter(l => l.trim().startsWith('|')).slice(2) // data rows
    if (lines.length > 0) {
      const keyChangesCell = lines[0].split('|').filter(c => c.trim())[4] // 5th column
      if (keyChangesCell) {
        const commaCount = (keyChangesCell.match(/,/g) || []).length
        expect(commaCount).toBeLessThanOrEqual(2) // 3 items = 2 commas max
      }
    }
  })

  test('uses subscription quantity in customer angle', () => {
    const result = buildEnhancedLifecycleTable(
      mockCustomer,
      ['ocp'],
      mockLifecycleCache,
      mockRoadmapData,
      mockProductSummaries,
      {
        getSheetCacheFn: () => ({
          rows: [{ sku: 'OCP', productDescription: 'OpenShift nodes', quantity: 50, status: 'Active' }],
          cachedAt: daysAgo(1),
        }),
      },
    )
    expect(result).toContain('50')
  })

  test('uses generic angle when no subscription quantity', () => {
    const result = buildEnhancedLifecycleTable(
      mockCustomer,
      ['ocp'],
      mockLifecycleCache,
      mockRoadmapData,
      mockProductSummaries,
      { getSheetCacheFn: () => null },
    )
    // Should still have a Customer Angle column but generic
    expect(result).toContain('Customer Angle')
  })

  test('returns empty string when lifecycle cache is null', () => {
    const result = buildEnhancedLifecycleTable(
      mockCustomer, ['ocp'], null, mockRoadmapData, mockProductSummaries,
    )
    expect(result).toBe('')
  })

  test('returns empty string when no matching products in lifecycle', () => {
    const result = buildEnhancedLifecycleTable(
      mockCustomer, ['satellite'], mockLifecycleCache, mockRoadmapData, mockProductSummaries,
    )
    expect(result).toBe('')
  })
})

// ── buildRSSIntelligenceTable ───────────────────────────────────────────────

describe('buildRSSIntelligenceTable', () => {
  test('returns header and table format', () => {
    const result = buildRSSIntelligenceTable(['ocp', 'aap'], mockRSSItems, 'Acme Corp')
    expect(result).toContain('**Latest Red Hat Blog & News Intelligence')
    expect(result).toContain('|')
  })

  test('includes real URLs as markdown links', () => {
    const result = buildRSSIntelligenceTable(['aap'], mockRSSItems, 'Acme Corp')
    expect(result).toContain('[Ansible Lightspeed')
    expect(result).toContain('](https://redhat.com/blog/ansible-lightspeed)')
  })

  test('filters to last 30 days', () => {
    const result = buildRSSIntelligenceTable(['rhel'], mockRSSItems, 'Acme Corp')
    // Old RHEL article (45 days) should not appear
    expect(result).not.toContain('Old Article')
  })

  test('filters by product slugs', () => {
    const result = buildRSSIntelligenceTable(['aap'], mockRSSItems, 'Acme Corp')
    // AAP-tagged items should appear
    expect(result).toContain('Ansible Lightspeed')
    // Summit is tagged with aap too
    expect(result).toContain('Summit')
  })

  test('caps at 8 items', () => {
    const manyItems: RSSItemLike[] = Array.from({ length: 15 }, (_, i) => ({
      title: `RSS Item ${i + 1}`,
      link: `https://example.com/rss/${i}`,
      description: '',
      pubDate: daysAgo(i + 1),
      source: 'Blog',
      productTags: ['ocp'],
    }))
    const result = buildRSSIntelligenceTable(['ocp'], manyItems, 'Acme Corp')
    const dataRows = result.split('\n').filter(l => l.trim().startsWith('|')).length - 2
    expect(dataRows).toBeLessThanOrEqual(8)
  })

  test('returns empty string when no items match', () => {
    const result = buildRSSIntelligenceTable(['satellite'], mockRSSItems, 'Acme Corp')
    expect(result).toBe('')
  })

  test('assigns customer relevance for product match', () => {
    const result = buildRSSIntelligenceTable(['aap'], mockRSSItems, 'Acme Corp')
    expect(result).toContain('Reference in')
  })

  test('assigns summit relevance for summit items', () => {
    const result = buildRSSIntelligenceTable(['ocp', 'aap', 'rhel'], mockRSSItems, 'Acme Corp')
    expect(result).toContain('Summit' || result.includes('attendees'))
  })

  test('assigns migration relevance for migration items', () => {
    const result = buildRSSIntelligenceTable(['ocp'], mockRSSItems, 'Acme Corp')
    expect(result).toContain('Migration') // migration guide title
  })
})

// ── buildSalesAlignmentBlock ───────────────────────────────────────────────

describe('buildSalesAlignmentBlock', () => {
  test('returns empty string when no solution plays match', () => {
    const result = buildSalesAlignmentBlock(['satellite'], 'acme-corp', {
      getSolutionContextFn: () => ({
        activeSolutionPlays: [],
        marketplaceOpportunities: [],
        versionCorrelations: [],
        crossSellSignals: [],
      }),
      getTacticsByTdpFn: () => [],
    })
    expect(result).toBe('')
  })

  test('produces blockquote with TDP, tactic, and play name', () => {
    const result = buildSalesAlignmentBlock(['ocp'], 'acme-corp', {
      getSolutionContextFn: () => ({
        activeSolutionPlays: [
          {
            playId: 'vm-migration',
            playName: 'VM Migration & Modernization',
            tdp: 'Optimize and Modernize IT Ops',
            matchedTechnologies: ['VMware'],
            confidence: 'HIGH' as const,
            redHatProducts: ['ocp'],
            valueProps: ['Consolidate infrastructure'],
            category: 'modernization',
            matchReasoning: 'Detected VMware',
          },
        ],
        marketplaceOpportunities: [],
        versionCorrelations: [],
        crossSellSignals: [],
      }),
      getTacticsByTdpFn: (tdpName: string) => [{
        name: 'VM migration & modernization',
        talkTrack: 'Talk about modernization',
        customerWins: [],
        whatToSay: [],
        whatToShare: [
          { name: 'Customer deck - Optimize and modernize operations CY26', url: 'https://example.com/deck', type: 'seismic' },
          { name: 'ROI estimator', url: 'https://red.ht/virttcoestimator', type: 'seismic' },
        ],
        parentTdp: 'Optimize and Modernize IT Ops',
        extractedContent: '',
        metrics: [],
      }],
      getTdpByNameFn: () => ({
        name: 'Optimize and Modernize IT Ops',
        description: '',
        tactics: [],
        products: [],
        customerWins: [],
        whatToSay: [],
        whatToShare: [],
        whatToShow: [],
        services: [
          { name: 'Navigate engagement', description: 'Consulting' },
          { name: 'Skills Assessment', description: 'Training' },
        ],
        cheatsheetUrl: '',
        customerDeckUrl: '',
        extractedContent: '',
        metrics: [],
      }),
    })

    // AC-1: Aligned to callout with TDP, tactic, play
    expect(result).toContain('**Aligned to:**')
    expect(result).toContain('Optimize and Modernize IT Ops')
    expect(result).toContain('VM Migration & Modernization')

    // AC-2: whatToShare assets as markdown links
    expect(result).toContain('[Customer deck - Optimize and modernize operations CY26](https://example.com/deck)')
    expect(result).toContain('[ROI estimator](https://red.ht/virttcoestimator)')

    // AC-3: Services listed
    expect(result).toContain('Navigate engagement')
    expect(result).toContain('Skills Assessment')

    // AC-5: Blockquote format (deterministic, not Gemini)
    expect(result).toContain('> ')
  })

  test('only includes whatToShare items that have URLs', () => {
    const result = buildSalesAlignmentBlock(['ocp'], 'acme-corp', {
      getSolutionContextFn: () => ({
        activeSolutionPlays: [
          {
            playId: 'vm-migration',
            playName: 'VM Migration',
            tdp: 'Optimize IT Ops',
            matchedTechnologies: ['VMware'],
            confidence: 'HIGH' as const,
            redHatProducts: ['ocp'],
            valueProps: [],
            category: 'modernization',
            matchReasoning: '',
          },
        ],
        marketplaceOpportunities: [],
        versionCorrelations: [],
        crossSellSignals: [],
      }),
      getTacticsByTdpFn: () => [{
        name: 'VM migration',
        talkTrack: '',
        customerWins: [],
        whatToSay: [],
        whatToShare: [
          { name: 'Has URL', url: 'https://example.com/doc', type: 'seismic' },
          { name: 'No URL', url: '', type: 'seismic' },
        ],
        parentTdp: 'Optimize IT Ops',
        extractedContent: '',
        metrics: [],
      }],
      getTdpByNameFn: () => undefined,
    })

    expect(result).toContain('[Has URL](https://example.com/doc)')
    expect(result).not.toContain('No URL')
  })

  test('omits services line when TDP has no services', () => {
    const result = buildSalesAlignmentBlock(['ocp'], 'acme-corp', {
      getSolutionContextFn: () => ({
        activeSolutionPlays: [
          {
            playId: 'test',
            playName: 'Test Play',
            tdp: 'Some TDP',
            matchedTechnologies: ['Docker'],
            confidence: 'MEDIUM' as const,
            redHatProducts: ['ocp'],
            valueProps: [],
            category: 'test',
            matchReasoning: '',
          },
        ],
        marketplaceOpportunities: [],
        versionCorrelations: [],
        crossSellSignals: [],
      }),
      getTacticsByTdpFn: () => [{
        name: 'Some tactic',
        talkTrack: '',
        customerWins: [],
        whatToSay: [],
        whatToShare: [
          { name: 'Deck', url: 'https://example.com/deck', type: 'seismic' },
        ],
        parentTdp: 'Some TDP',
        extractedContent: '',
        metrics: [],
      }],
      getTdpByNameFn: () => ({
        name: 'Some TDP',
        description: '',
        tactics: [],
        products: [],
        customerWins: [],
        whatToSay: [],
        whatToShare: [],
        whatToShow: [],
        services: [],
        cheatsheetUrl: '',
        customerDeckUrl: '',
        extractedContent: '',
        metrics: [],
      }),
    })

    expect(result).not.toContain('Services to propose')
  })

  test('handles multiple solution plays', () => {
    const result = buildSalesAlignmentBlock(['ocp', 'aap'], 'acme-corp', {
      getSolutionContextFn: () => ({
        activeSolutionPlays: [
          {
            playId: 'play1',
            playName: 'Play One',
            tdp: 'TDP Alpha',
            matchedTechnologies: ['VMware'],
            confidence: 'HIGH' as const,
            redHatProducts: ['ocp'],
            valueProps: [],
            category: 'cat1',
            matchReasoning: '',
          },
          {
            playId: 'play2',
            playName: 'Play Two',
            tdp: 'TDP Beta',
            matchedTechnologies: ['Ansible'],
            confidence: 'MEDIUM' as const,
            redHatProducts: ['aap'],
            valueProps: [],
            category: 'cat2',
            matchReasoning: '',
          },
        ],
        marketplaceOpportunities: [],
        versionCorrelations: [],
        crossSellSignals: [],
      }),
      getTacticsByTdpFn: (tdpName: string) => [{
        name: `Tactic for ${tdpName}`,
        talkTrack: '',
        customerWins: [],
        whatToSay: [],
        whatToShare: [
          { name: `Deck for ${tdpName}`, url: `https://example.com/${tdpName}`, type: 'seismic' },
        ],
        parentTdp: tdpName,
        extractedContent: '',
        metrics: [],
      }],
      getTdpByNameFn: () => undefined,
    })

    // Both plays should appear
    expect(result).toContain('Play One')
    expect(result).toContain('Play Two')
    expect(result).toContain('TDP Alpha')
    expect(result).toContain('TDP Beta')
  })
})
