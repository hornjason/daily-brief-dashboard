// test/unit/partner-catalog-scraper.test.ts
// GitHub Issue #997 — catalog.redhat.com partner scraper tests

import { describe, it, expect, beforeAll, afterAll, mock, spyOn } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { resolve } from 'path'

// ── Test fixtures ──────────────────────────────────────────────────────────────

const CDW_OG_DESCRIPTION =
  'Red Hat Specialized Partner (RHSP)  CDW is a provider of IT solutions and services for business, government, education, and healthcare customers in the United States, the United Kingdom, and Canada.'

const CDW_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:description" content="${CDW_OG_DESCRIPTION}" />
  <meta property="og:title" content="CDW - Red Hat Partner" />
</head>
<body>
  <div>CDW is also a Red Hat Specialized Partner with the Mission Critical Automation, Container Management and Virtualization Specialization.</div>
</body>
</html>`

const PREMIER_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:description" content="Red Hat Premier Partner  Acme Corp is a leading technology company." />
</head>
<body><div>No specializations listed.</div></body>
</html>`

const ADVANCED_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:description" content="Red Hat Advanced Partner  Beta Inc provides cloud services." />
</head>
<body><div>Beta Inc has Cloud-Native Development specialization.</div></body>
</html>`

const NO_TIER_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:description" content="Some partner without a tier listed." />
</head>
<body><div>Generic page content.</div></body>
</html>`

// ── Test temp directory ────────────────────────────────────────────────────────

const TEST_DIR = resolve(import.meta.dir, '../../.test-tmp-997')

function writeTestPartners(partners: any[], filename = 'territory-partners.json') {
  const path = resolve(TEST_DIR, filename)
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(path, JSON.stringify(partners, null, 2))
  return path
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('partner-catalog-scraper', () => {
  let resolvePartnerSlug: typeof import('../../src/lib/partner-catalog-scraper.ts').resolvePartnerSlug
  let parsePartnerPage: typeof import('../../src/lib/partner-catalog-scraper.ts').parsePartnerPage
  let fetchPartnerPage: typeof import('../../src/lib/partner-catalog-scraper.ts').fetchPartnerPage
  let enrichPartnerFromCatalog: typeof import('../../src/lib/partner-catalog-scraper.ts').enrichPartnerFromCatalog
  let enrichTerritoryPartners: typeof import('../../src/lib/partner-catalog-scraper.ts').enrichTerritoryPartners
  let delay: typeof import('../../src/lib/partner-catalog-scraper.ts').delay
  let _setDelay: typeof import('../../src/lib/partner-catalog-scraper.ts')._setDelay

  beforeAll(async () => {
    const mod = await import('../../src/lib/partner-catalog-scraper.ts')
    resolvePartnerSlug = mod.resolvePartnerSlug
    parsePartnerPage = mod.parsePartnerPage
    fetchPartnerPage = mod.fetchPartnerPage
    enrichPartnerFromCatalog = mod.enrichPartnerFromCatalog
    enrichTerritoryPartners = mod.enrichTerritoryPartners
    delay = mod.delay
    _setDelay = mod._setDelay
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  // ── AC-2: Slug resolution ──────────────────────────────────────────────────

  describe('resolvePartnerSlug', () => {
    it('resolves simple names to lowercase hyphenated slug', () => {
      expect(resolvePartnerSlug('CDW')).toBe('cdw')
    })

    it('resolves compound names with spaces to hyphenated slug', () => {
      expect(resolvePartnerSlug('SHI International')).toBe('shi-international')
    })

    it('resolves names with special characters', () => {
      expect(resolvePartnerSlug("Level Up Technology")).toBe('level-up-technology')
    })

    it('strips punctuation and normalizes', () => {
      // Punctuation stripped, consecutive hyphens collapsed
      expect(resolvePartnerSlug("O'Brien & Associates, LLC")).toBe('obrien-associates-llc')
      const slug = resolvePartnerSlug("Test & Co")
      expect(slug).toBe('test-co')
    })

    it('handles names with extra whitespace', () => {
      expect(resolvePartnerSlug('  Foo  Bar  ')).toBe('foo-bar')
    })
  })

  // ── AC-1 + AC-2: parsePartnerPage ─────────────────────────────────────────

  describe('parsePartnerPage', () => {
    it('extracts RHSP tier from og:description', () => {
      const result = parsePartnerPage(CDW_HTML, 'cdw')
      expect(result.partnershipLevel).toBe('RHSP')
    })

    it('extracts overview text after tier declaration', () => {
      const result = parsePartnerPage(CDW_HTML, 'cdw')
      expect(result.overview).toContain('CDW is a provider')
    })

    it('extracts specializations from page body', () => {
      const result = parsePartnerPage(CDW_HTML, 'cdw')
      expect(result.specializations).toContain('Mission Critical Automation')
      expect(result.specializations).toContain('Container Management')
      expect(result.specializations).toContain('Virtualization')
    })

    it('builds catalog URL from slug', () => {
      const result = parsePartnerPage(CDW_HTML, 'cdw')
      expect(result.catalogUrl).toBe(
        'https://catalog.redhat.com/en/partners/detail/cdw',
      )
    })

    it('returns 3+ enriched fields from CDW page data (AC-1 threshold)', () => {
      const result = parsePartnerPage(CDW_HTML, 'cdw')
      let fieldCount = 0
      if (result.partnershipLevel) fieldCount++
      if (result.catalogUrl) fieldCount++
      if (result.overview) fieldCount++
      if (result.specializations.length > 0) fieldCount++
      expect(fieldCount).toBeGreaterThanOrEqual(3)
    })

    it('extracts Premier tier', () => {
      const result = parsePartnerPage(PREMIER_HTML, 'acme-corp')
      expect(result.partnershipLevel).toBe('Premier')
    })

    it('extracts Advanced tier', () => {
      const result = parsePartnerPage(ADVANCED_HTML, 'beta-inc')
      expect(result.partnershipLevel).toBe('Advanced')
      expect(result.specializations).toContain('Cloud-Native Development')
    })

    it('returns null partnershipLevel when no tier found', () => {
      const result = parsePartnerPage(NO_TIER_HTML, 'unknown')
      expect(result.partnershipLevel).toBeNull()
    })

    it('handles reversed meta tag attribute order', () => {
      const reversedHtml = `<html><head>
        <meta content="Red Hat Premier Partner  Reversed Corp is great." property="og:description" />
      </head><body></body></html>`
      const result = parsePartnerPage(reversedHtml, 'reversed-corp')
      expect(result.partnershipLevel).toBe('Premier')
      expect(result.overview).toContain('Reversed Corp')
    })
  })

  // ── AC-1: enrichPartnerFromCatalog (with mocked fetch) ────────────────────

  describe('enrichPartnerFromCatalog', () => {
    it('returns enriched result with partnershipLevel, catalogUrl, overview', async () => {
      // Mock global fetch to return CDW HTML for the CDW slug
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url: any) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('/cdw')) {
          return new Response(CDW_HTML, { status: 200 })
        }
        return new Response('', { status: 404 })
      }

      try {
        const result = await enrichPartnerFromCatalog('CDW')
        expect(result.enrichmentStatus).toBe('enriched')
        if (result.enrichmentStatus === 'enriched') {
          expect(result.partnershipLevel).toBe('RHSP')
          expect(result.catalogUrl).toContain('catalog.redhat.com')
          expect(result.overview).toContain('CDW is a provider')
        }
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('returns not-found when page returns 404', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => new Response('', { status: 404 })

      try {
        const result = await enrichPartnerFromCatalog('Nonexistent Partner Corp')
        expect(result.enrichmentStatus).toBe('not-found')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('tries slug variations for compound names (AC-2)', async () => {
      const fetchedUrls: string[] = []
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url: any) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        fetchedUrls.push(urlStr)
        if (urlStr.includes('/shi-international')) {
          return new Response(PREMIER_HTML, { status: 200 })
        }
        return new Response('', { status: 404 })
      }

      try {
        const result = await enrichPartnerFromCatalog('SHI International')
        expect(result.enrichmentStatus).toBe('enriched')
        // First attempt should be the full hyphenated slug
        expect(fetchedUrls[0]).toContain('/shi-international')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('tries simplified slug when primary fails', async () => {
      const fetchedUrls: string[] = []
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url: any) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        fetchedUrls.push(urlStr)
        // Only the simplified "level-up" slug works
        if (urlStr.endsWith('/level-up')) {
          return new Response(ADVANCED_HTML, { status: 200 })
        }
        return new Response('', { status: 404 })
      }

      try {
        const result = await enrichPartnerFromCatalog('Level Up Technology Solutions')
        expect(result.enrichmentStatus).toBe('enriched')
        // Should have tried primary first, then simplified
        expect(fetchedUrls.length).toBeGreaterThanOrEqual(2)
        expect(fetchedUrls[0]).toContain('/level-up-technology-solutions')
        expect(fetchedUrls.some(u => u.endsWith('/level-up'))).toBe(true)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  // ── AC-3: enrichTerritoryPartners ─────────────────────────────────────────

  describe('enrichTerritoryPartners', () => {
    it('enriches pending entries and writes back', async () => {
      const testPartners = [
        {
          name: 'CDW',
          aliases: [],
          domain: null,
          enrichmentStatus: 'pending',
          partnershipLevel: null,
          specializations: [],
          catalogUrl: null,
          customerAssociations: [],
          extractedAt: '2026-07-01T00:00:00Z',
        },
        {
          name: 'Already Enriched Corp',
          aliases: [],
          domain: null,
          enrichmentStatus: 'enriched',
          partnershipLevel: 'Premier',
          specializations: [],
          catalogUrl: 'https://catalog.redhat.com/en/partners/detail/already-enriched-corp',
          customerAssociations: [],
          extractedAt: '2026-07-01T00:00:00Z',
        },
        {
          name: 'Unknown Partner',
          aliases: [],
          domain: null,
          enrichmentStatus: 'pending',
          partnershipLevel: null,
          specializations: [],
          catalogUrl: null,
          customerAssociations: [],
          extractedAt: '2026-07-01T00:00:00Z',
        },
      ]

      const path = writeTestPartners(testPartners)

      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url: any) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('/cdw')) {
          return new Response(CDW_HTML, { status: 200 })
        }
        return new Response('', { status: 404 })
      }

      // Replace delay with instant resolution for tests
      const restoreDelay = _setDelay(async () => {})

      try {
        const count = await enrichTerritoryPartners(path)

        // CDW should be enriched, Unknown should be not-found
        // Count reflects CDW enriched (1)
        expect(count).toBe(1)

        // Read back the file
        const { readFileSync } = await import('fs')
        const written = JSON.parse(readFileSync(path, 'utf-8'))

        // CDW should be enriched
        const cdw = written.find((p: any) => p.name === 'CDW')
        expect(cdw.enrichmentStatus).toBe('enriched')
        expect(cdw.partnershipLevel).toBe('RHSP')
        expect(cdw.catalogUrl).toContain('catalog.redhat.com')

        // Already enriched should be unchanged
        const alreadyEnriched = written.find((p: any) => p.name === 'Already Enriched Corp')
        expect(alreadyEnriched.enrichmentStatus).toBe('enriched')

        // Unknown should be not-found
        const unknown = written.find((p: any) => p.name === 'Unknown Partner')
        expect(unknown.enrichmentStatus).toBe('not-found')
      } finally {
        globalThis.fetch = originalFetch
        restoreDelay()
      }
    })

    it('returns 0 when no pending entries', async () => {
      const testPartners = [
        {
          name: 'Already Done',
          aliases: [],
          domain: null,
          enrichmentStatus: 'enriched',
          partnershipLevel: 'Premier',
          specializations: [],
          catalogUrl: 'https://catalog.redhat.com/en/partners/detail/already-done',
          customerAssociations: [],
          extractedAt: '2026-07-01T00:00:00Z',
        },
      ]

      const path = writeTestPartners(testPartners, 'no-pending.json')
      const count = await enrichTerritoryPartners(path)
      expect(count).toBe(0)
    })
  })

  // ── AC-4: Rate limiting ───────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('delay function exists and returns a promise', () => {
      expect(typeof delay).toBe('function')
      // Verify it returns a Promise
      const result = delay(0)
      expect(result).toBeInstanceOf(Promise)
    })

    it('enrichTerritoryPartners calls delay between requests', async () => {
      const testPartners = [
        {
          name: 'Partner A',
          aliases: [],
          domain: null,
          enrichmentStatus: 'pending',
          partnershipLevel: null,
          specializations: [],
          catalogUrl: null,
          customerAssociations: [],
          extractedAt: '2026-07-01T00:00:00Z',
        },
        {
          name: 'Partner B',
          aliases: [],
          domain: null,
          enrichmentStatus: 'pending',
          partnershipLevel: null,
          specializations: [],
          catalogUrl: null,
          customerAssociations: [],
          extractedAt: '2026-07-01T00:00:00Z',
        },
      ]

      const path = writeTestPartners(testPartners, 'rate-limit.json')

      const originalFetch = globalThis.fetch
      const fetchTimes: number[] = []
      globalThis.fetch = async () => {
        fetchTimes.push(Date.now())
        return new Response('', { status: 404 })
      }

      let delayCallCount = 0
      const restoreDelay = _setDelay(async (ms: number) => {
        delayCallCount++
        expect(ms).toBe(2000) // AC-4: minimum 2s delay
      })

      try {
        await enrichTerritoryPartners(path)

        // With 2 pending partners, delay should be called once (between them)
        expect(delayCallCount).toBe(1)
      } finally {
        globalThis.fetch = originalFetch
        restoreDelay()
      }
    })
  })
})
