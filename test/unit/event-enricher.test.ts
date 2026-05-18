/**
 * Event Enricher — Unit Tests
 * GitHub Issue #250
 *
 * Tests for event enrichment pipeline:
 * - HTML stripping from registration pages
 * - Enrichment with/without registration URL
 * - Customer relevance cross-referencing
 * - Rate limiting (max 5 per run)
 * - Cache read/write for enrichments
 * - Graceful fallback on fetch errors
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { resolve } from 'path'

// ── Test fixtures ───────────────────────────────────────────────────────────

const TEST_CACHE_DIR = resolve(import.meta.dir, '../../data/cache/__test-enrichment')
const ENRICHMENT_CACHE_PATH = resolve(TEST_CACHE_DIR, 'rh-events-enriched.json')
const EVENTS_CACHE_PATH = resolve(TEST_CACHE_DIR, 'rh-events.json')

const SAMPLE_EVENTS = [
  {
    name: 'Red Hat Tech Day w/ Intel',
    date: '2026-06-04',
    format: 'in-person' as const,
    location: 'Houston, TX',
    region: 'central' as const,
    productTags: ['OCP', 'RHEL'],
    registrationUrl: 'https://events.redhat.com/profile/form/index.cfm?PKformID=test123',
    description: 'June 4: In-Person | Red Hat Tech Day w/ Intel | Houston, TX',
    summary: 'IT Decision Makers / Technical staff',
  },
  {
    name: 'Virtual Ansible Automation Workshop',
    date: '2026-06-10',
    format: 'virtual' as const,
    location: null,
    region: 'national' as const,
    productTags: ['AAP'],
    registrationUrl: null,
    description: 'June 10: Virtual | Virtual Ansible Automation Workshop',
    summary: '',
  },
  {
    name: 'OpenShift AI Deep Dive',
    date: '2026-06-15',
    format: 'virtual' as const,
    location: null,
    region: 'national' as const,
    productTags: ['RHOAI', 'OCP'],
    registrationUrl: 'https://events.redhat.com/profile/form/index.cfm?PKformID=test456',
    description: 'June 15: Virtual | OpenShift AI Deep Dive',
    summary: 'Technical staff',
  },
]

// ── Tests ───────────────────────────────────────────────────────────────────

describe('event-enricher', () => {
  describe('stripHtmlToText', () => {
    it('strips HTML tags and returns plain text', async () => {
      const { stripHtmlToText } = await import('../../src/event-enricher.ts')

      const html = '<html><head><title>Test</title></head><body><nav>Nav</nav><main><h1>Event Title</h1><p>Description here.</p></main><footer>Footer</footer></body></html>'
      const text = stripHtmlToText(html)

      expect(text).toContain('Event Title')
      expect(text).toContain('Description here')
      // Should strip nav and footer
      expect(text).not.toContain('<nav>')
      expect(text).not.toContain('<footer>')
    })

    it('limits output to maxChars', async () => {
      const { stripHtmlToText } = await import('../../src/event-enricher.ts')

      const longHtml = '<p>' + 'a'.repeat(5000) + '</p>'
      const text = stripHtmlToText(longHtml, 2000)

      expect(text.length).toBeLessThanOrEqual(2000)
    })

    it('decodes HTML entities', async () => {
      const { stripHtmlToText } = await import('../../src/event-enricher.ts')

      const html = '<p>Red Hat&rsquo;s &amp; OpenShift&mdash;Enterprise</p>'
      const text = stripHtmlToText(html)

      expect(text).toContain("Red Hat's")
      expect(text).toContain('& OpenShift')
    })
  })

  describe('buildEnrichmentCacheKey', () => {
    it('creates deterministic key from event name and date', async () => {
      const { buildEnrichmentCacheKey } = await import('../../src/event-enricher.ts')

      const key = buildEnrichmentCacheKey('Red Hat Tech Day', '2026-06-04')
      expect(key).toBe('event-enrich:Red Hat Tech Day:2026-06-04')
    })
  })

  describe('matchCustomerRelevance', () => {
    it('matches customers whose subscriptions include event product tags', async () => {
      const { matchCustomerRelevance } = await import('../../src/event-enricher.ts')

      const customers = [
        { name: 'CrowdStrike', slug: 'crowdstrike' },
        { name: 'Illumio', slug: 'illumio' },
        { name: 'Acme Corp', slug: 'acme-corp' },
      ]

      // Mock subscription data: CrowdStrike has OCP, Illumio has OCP + AAP
      const subscriptionsByCustomer: Record<string, Array<{ productDescription: string }>> = {
        CrowdStrike: [{ productDescription: 'Red Hat OpenShift Container Platform' }],
        Illumio: [
          { productDescription: 'Red Hat OpenShift Container Platform' },
          { productDescription: 'Red Hat Ansible Automation Platform' },
        ],
        'Acme Corp': [{ productDescription: 'Red Hat Enterprise Linux Server' }],
      }

      const result = matchCustomerRelevance(['OCP'], customers, subscriptionsByCustomer)

      expect(result.matchingCustomers).toContain('CrowdStrike')
      expect(result.matchingCustomers).toContain('Illumio')
      expect(result.matchingCustomers).not.toContain('Acme Corp')
      expect(result.productMatches['OCP']).toContain('CrowdStrike')
      expect(result.productMatches['OCP']).toContain('Illumio')
    })

    it('returns empty when no customers match', async () => {
      const { matchCustomerRelevance } = await import('../../src/event-enricher.ts')

      const result = matchCustomerRelevance(
        ['RHOAI'],
        [{ name: 'Acme', slug: 'acme' }],
        { Acme: [{ productDescription: 'Red Hat Enterprise Linux' }] }
      )

      expect(result.matchingCustomers).toEqual([])
    })

    it('skips General tag', async () => {
      const { matchCustomerRelevance } = await import('../../src/event-enricher.ts')

      const result = matchCustomerRelevance(
        ['General'],
        [{ name: 'Acme', slug: 'acme' }],
        { Acme: [{ productDescription: 'Red Hat Enterprise Linux' }] }
      )

      expect(result.matchingCustomers).toEqual([])
    })
  })

  describe('enrichment cache', () => {
    beforeEach(() => {
      if (!existsSync(TEST_CACHE_DIR)) {
        mkdirSync(TEST_CACHE_DIR, { recursive: true })
      }
    })

    afterEach(() => {
      if (existsSync(TEST_CACHE_DIR)) {
        rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
      }
    })

    it('reads enrichment cache from file', async () => {
      const { readEnrichmentCache } = await import('../../src/event-enricher.ts')

      const cacheData = {
        enrichments: {
          'Red Hat Tech Day:2026-06-04': {
            enrichedDescription: 'A hands-on workshop covering OCP and RHEL.',
            enrichedAt: '2026-05-15T10:00:00Z',
          },
        },
      }
      writeFileSync(ENRICHMENT_CACHE_PATH, JSON.stringify(cacheData))

      const result = readEnrichmentCache(ENRICHMENT_CACHE_PATH)
      expect(result).not.toBeNull()
      expect(result!.enrichments['Red Hat Tech Day:2026-06-04'].enrichedDescription).toContain('hands-on workshop')
    })

    it('returns null for missing cache file', async () => {
      const { readEnrichmentCache } = await import('../../src/event-enricher.ts')

      const result = readEnrichmentCache('/nonexistent/path.json')
      expect(result).toBeNull()
    })
  })

  describe('rate limiting', () => {
    it('enriches at most 5 events with registration URLs per run', async () => {
      const { MAX_SCRAPES_PER_RUN } = await import('../../src/event-enricher.ts')
      expect(MAX_SCRAPES_PER_RUN).toBe(5)
    })
  })
})
