// test/unit/ecosystem-catalog-sync.test.ts
// GitHub Issue #1000 — Ecosystem Catalog sync pipeline tests
// Tests mapResourceType, mapSolrDoc, toPartnerSlug, and syncEcosystemCatalog

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import {
  mapResourceType,
  mapSolrDoc,
  toPartnerSlug,
  syncEcosystemCatalog,
  fetchSolutionResources,
  type EcosystemPartnerCache,
} from '../../src/lib/ecosystem-catalog.ts'

const TEST_DIR = '/tmp/ecosystem-catalog-sync-test-' + Date.now()

beforeEach(() => {
  mkdirSync(resolve(TEST_DIR, 'ecosystem-catalog'), { recursive: true })
  process.env.CACHE_DIR = TEST_DIR
})

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true })
  }
  delete process.env.CACHE_DIR
})

// ── mapResourceType (§29 mapping) ────────────────────────────────────────────

describe('mapResourceType', () => {
  test('maps solution_brief → solution-brief', () => {
    expect(mapResourceType('solution_brief')).toBe('solution-brief')
  })

  test('maps customer_case_study → case-study', () => {
    expect(mapResourceType('customer_case_study')).toBe('case-study')
  })

  test('maps reference_architecture → design-guide', () => {
    expect(mapResourceType('reference_architecture')).toBe('design-guide')
  })

  test('maps demo → lab', () => {
    expect(mapResourceType('demo')).toBe('lab')
  })

  test('maps learning_course → lab', () => {
    expect(mapResourceType('learning_course')).toBe('lab')
  })

  test('maps video → video', () => {
    expect(mapResourceType('video')).toBe('video')
  })

  test('maps overview → documentation', () => {
    expect(mapResourceType('overview')).toBe('documentation')
  })

  test('maps unknown type → other', () => {
    expect(mapResourceType('whitepaper')).toBe('other')
    expect(mapResourceType('random_thing')).toBe('other')
  })

  test('maps undefined → other', () => {
    expect(mapResourceType(undefined)).toBe('other')
  })
})

// ── toPartnerSlug ────────────────────────────────────────────────────────────

describe('toPartnerSlug', () => {
  test('lowercases and replaces spaces with hyphens', () => {
    expect(toPartnerSlug('Cisco Systems')).toBe('cisco-systems')
  })

  test('removes special characters', () => {
    expect(toPartnerSlug('F5 Networks, Inc.')).toBe('f5-networks-inc')
  })

  test('collapses multiple hyphens', () => {
    expect(toPartnerSlug('Palo Alto   Networks')).toBe('palo-alto-networks')
  })

  test('strips leading/trailing hyphens', () => {
    expect(toPartnerSlug('--Cisco--')).toBe('cisco')
  })
})

// ── mapSolrDoc ───────────────────────────────────────────────────────────────

describe('mapSolrDoc', () => {
  test('maps all §29 fields correctly', () => {
    const doc = {
      allTitle: 'Network Automation with Cisco and Red Hat',
      partnerName: 'Cisco',
      partner_catalog_url_id: 'cisco',
      short_description: 'Joint network automation solution',
      target_platforms: ['Ansible Automation Platform'],
      subcategories: ['Networking', 'Automation'],
      supported_regions: ['Global'],
      view_uri: '/en/solutions/detail/abc-123',
      lastModifiedDate: '2026-01-15T00:00:00Z',
    }

    const result = mapSolrDoc(doc)
    expect(result).not.toBeNull()
    expect(result!.name).toBe('Network Automation with Cisco and Red Hat')
    expect(result!.partnerName).toBe('Cisco')
    expect(result!.partnerSlug).toBe('cisco')
    expect(result!.description).toBe('Joint network automation solution')
    expect(result!.platform).toBe('Ansible Automation Platform')
    expect(result!.categories).toEqual(['Networking', 'Automation'])
    expect(result!.geoRegion).toBe('Global')
    expect(result!.url).toBe('https://catalog.redhat.com/en/solutions/detail/abc-123')
    expect(result!.publishedAt).toBe('2026-01-15T00:00:00Z')
    expect(result!.resources).toEqual([])
    expect(result!.collections).toEqual([]) // Deferred per §29
  })

  test('returns null when allTitle is missing', () => {
    expect(mapSolrDoc({})).toBeNull()
    expect(mapSolrDoc({ allTitle: '' })).toBeNull()
    expect(mapSolrDoc({ allTitle: '  ' })).toBeNull()
  })

  test('extracts partner from title when partnerName field is missing', () => {
    const doc = {
      allTitle: 'Network Automation with Cisco and Red Hat',
      short_description: 'desc',
    }
    const result = mapSolrDoc(doc)
    expect(result).not.toBeNull()
    expect(result!.partnerName).toBe('Cisco')
  })

  test('extracts partner from "PartnerName + Red Hat" title pattern', () => {
    const doc = {
      allTitle: 'VMware + Red Hat Enterprise Linux',
      short_description: 'desc',
    }
    const result = mapSolrDoc(doc)
    expect(result).not.toBeNull()
    expect(result!.partnerName).toBe('VMware')
  })

  test('returns null when no partner can be determined', () => {
    const doc = {
      allTitle: 'Some Generic Solution',
      short_description: 'desc',
    }
    const result = mapSolrDoc(doc)
    expect(result).toBeNull()
  })

  test('prepends base URL to relative view_uri', () => {
    const doc = {
      allTitle: 'Test',
      partnerName: 'TestCo',
      view_uri: '/en/solutions/detail/abc',
    }
    const result = mapSolrDoc(doc)
    expect(result!.url).toBe('https://catalog.redhat.com/en/solutions/detail/abc')
  })

  test('preserves absolute URLs', () => {
    const doc = {
      allTitle: 'Test',
      partnerName: 'TestCo',
      view_uri: 'https://catalog.redhat.com/en/solutions/detail/abc',
    }
    const result = mapSolrDoc(doc)
    expect(result!.url).toBe('https://catalog.redhat.com/en/solutions/detail/abc')
  })

  test('infers platform from solution_type when target_platforms missing', () => {
    expect(mapSolrDoc({
      allTitle: 'Test', partnerName: 'X',
      solution_type: 'Ansible Certified Content',
    })!.platform).toBe('Ansible Automation Platform')

    expect(mapSolrDoc({
      allTitle: 'Test', partnerName: 'X',
      solution_type: 'OpenShift Partner',
    })!.platform).toBe('OpenShift Container Platform')

    expect(mapSolrDoc({
      allTitle: 'Test', partnerName: 'X',
      solution_type: 'RHEL Ecosystem',
    })!.platform).toBe('Red Hat Enterprise Linux')
  })

  test('defaults geoRegion to Global when supported_regions empty', () => {
    const doc = { allTitle: 'Test', partnerName: 'X' }
    expect(mapSolrDoc(doc)!.geoRegion).toBe('Global')
  })

  test('includes resources when provided', () => {
    const doc = { allTitle: 'Test', partnerName: 'X' }
    const resources = [
      { title: 'Lab 1', url: 'https://example.com/lab', type: 'lab' as const },
    ]
    const result = mapSolrDoc(doc, resources)
    expect(result!.resources).toHaveLength(1)
    expect(result!.resources[0].title).toBe('Lab 1')
  })
})

// ── syncEcosystemCatalog (integration with mocked fetch) ─────────────────────

describe('syncEcosystemCatalog', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('fetches, maps, groups, and writes per-partner cache files', async () => {
    const solrResponse = {
      response: {
        docs: [
          {
            allTitle: 'Network Automation with Cisco and Red Hat',
            partnerName: 'Cisco',
            partner_catalog_url_id: 'cisco',
            short_description: 'Cisco network automation',
            target_platforms: ['Ansible Automation Platform'],
            subcategories: ['Networking'],
            supported_regions: ['Global'],
            view_uri: '/en/solutions/detail/sol-001',
            lastModifiedDate: '2026-01-01T00:00:00Z',
            id: 'sol-001',
          },
          {
            allTitle: 'Security Platform with Cisco and Red Hat',
            partnerName: 'Cisco',
            partner_catalog_url_id: 'cisco',
            short_description: 'Cisco security platform',
            target_platforms: ['OpenShift Container Platform'],
            subcategories: ['Security'],
            supported_regions: ['NA'],
            view_uri: '/en/solutions/detail/sol-002',
            lastModifiedDate: '2026-02-01T00:00:00Z',
            id: 'sol-002',
          },
          {
            allTitle: 'Virtualization with VMware and Red Hat',
            partnerName: 'VMware',
            partner_catalog_url_id: 'vmware',
            short_description: 'VMware virtualization',
            target_platforms: ['Red Hat Enterprise Linux'],
            subcategories: ['Virtualization'],
            supported_regions: ['Global'],
            view_uri: '/en/solutions/detail/sol-003',
            lastModifiedDate: '2026-03-01T00:00:00Z',
            id: 'sol-003',
          },
        ],
      },
    }

    const prmResponses: Record<string, any[]> = {
      'sol-001': [
        { title: 'Cisco Lab', url: 'https://example.com/lab', type: 'demo' },
        { title: 'Cisco Brief', url: 'https://example.com/brief', type: 'solution_brief' },
      ],
      'sol-002': [
        { title: 'Security Video', url: 'https://example.com/video', type: 'video' },
      ],
      'sol-003': [],
    }

    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()

      if (url.includes('hydra/rest/search/kcs')) {
        return new Response(JSON.stringify(solrResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (url.includes('hydra/prm/v1/solutions/')) {
        const match = url.match(/solutions\/([^/]+)\/resources/)
        const id = match?.[1] || ''
        const resources = prmResponses[id] || []
        return new Response(JSON.stringify(resources), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response('Not found', { status: 404 })
    }) as typeof fetch

    const result = await syncEcosystemCatalog()

    // Verify counts
    expect(result.solutionCount).toBe(3)
    expect(result.partnerCount).toBe(2)

    // Verify cache files written
    const cacheDir = resolve(TEST_DIR, 'ecosystem-catalog')
    const files = readdirSync(cacheDir).filter(f => f.endsWith('.json')).sort()
    expect(files).toEqual(['cisco.json', 'vmware.json'])

    // Verify cisco.json content
    const ciscoCache = JSON.parse(readFileSync(resolve(cacheDir, 'cisco.json'), 'utf-8')) as EcosystemPartnerCache
    expect(ciscoCache.partnerName).toBe('Cisco')
    expect(ciscoCache.partnerSlug).toBe('cisco')
    expect(ciscoCache.solutionCount).toBe(2)
    expect(ciscoCache.solutions).toHaveLength(2)
    expect(ciscoCache.scrapedAt).toBeTruthy()

    // Verify solution field mapping
    const sol1 = ciscoCache.solutions.find(s => s.name.includes('Network'))!
    expect(sol1.partnerName).toBe('Cisco')
    expect(sol1.description).toBe('Cisco network automation')
    expect(sol1.platform).toBe('Ansible Automation Platform')
    expect(sol1.categories).toEqual(['Networking'])
    expect(sol1.url).toBe('https://catalog.redhat.com/en/solutions/detail/sol-001')

    // Verify resources mapped
    expect(sol1.resources).toHaveLength(2)
    expect(sol1.resources[0].type).toBe('lab')      // demo → lab
    expect(sol1.resources[1].type).toBe('solution-brief')  // solution_brief → solution-brief

    // Verify vmware.json content
    const vmwareCache = JSON.parse(readFileSync(resolve(cacheDir, 'vmware.json'), 'utf-8')) as EcosystemPartnerCache
    expect(vmwareCache.partnerName).toBe('VMware')
    expect(vmwareCache.solutionCount).toBe(1)
    expect(vmwareCache.solutions[0].resources).toEqual([])
  })

  test('throws on SOLR API failure', async () => {
    globalThis.fetch = (async () => {
      return new Response('Server Error', { status: 500, statusText: 'Internal Server Error' })
    }) as typeof fetch

    await expect(syncEcosystemCatalog()).rejects.toThrow('SOLR API returned 500')
  })

  test('throws on empty SOLR response (refuses to overwrite with empty)', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ response: { docs: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    await expect(syncEcosystemCatalog()).rejects.toThrow('0 solutions')
  })

  test('handles PRM API failures gracefully (fail-open per solution)', async () => {
    const solrResponse = {
      response: {
        docs: [
          {
            allTitle: 'Test with Partner1 and Red Hat',
            partnerName: 'Partner1',
            partner_catalog_url_id: 'partner1',
            short_description: 'desc',
            view_uri: '/en/solutions/detail/sol-fail',
            id: 'sol-fail',
          },
        ],
      },
    }

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('hydra/rest/search/kcs')) {
        return new Response(JSON.stringify(solrResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      // PRM API fails
      return new Response('Timeout', { status: 504 })
    }) as typeof fetch

    const result = await syncEcosystemCatalog()
    expect(result.solutionCount).toBe(1)

    // Solution should exist but with empty resources
    const cacheDir = resolve(TEST_DIR, 'ecosystem-catalog')
    const cache = JSON.parse(readFileSync(resolve(cacheDir, 'partner1.json'), 'utf-8'))
    expect(cache.solutions[0].resources).toEqual([])
  })

  test('all required EcosystemSolution fields present (AC-2)', async () => {
    const solrResponse = {
      response: {
        docs: [
          {
            allTitle: 'Full Solution with FullPartner and Red Hat',
            partnerName: 'FullPartner',
            partner_catalog_url_id: 'fullpartner',
            short_description: 'A complete description',
            target_platforms: ['Ansible Automation Platform'],
            subcategories: ['AI', 'Automation'],
            supported_regions: ['EMEA'],
            view_uri: '/en/solutions/detail/full-001',
            lastModifiedDate: '2026-06-01T00:00:00Z',
            id: 'full-001',
          },
        ],
      },
    }

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('hydra/rest/search/kcs')) {
        return new Response(JSON.stringify(solrResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify([
        { title: 'Lab', url: 'https://example.com/lab', type: 'demo' },
        { title: 'Brief', url: 'https://example.com/brief', type: 'solution_brief' },
        { title: 'Video', url: 'https://example.com/vid', type: 'video' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    const result = await syncEcosystemCatalog()
    expect(result.solutionCount).toBe(1)

    const cacheDir = resolve(TEST_DIR, 'ecosystem-catalog')
    const cache = JSON.parse(readFileSync(resolve(cacheDir, 'fullpartner.json'), 'utf-8')) as EcosystemPartnerCache
    const sol = cache.solutions[0]

    // AC-2: All 7 required fields present
    expect(sol.name).toBe('Full Solution with FullPartner and Red Hat')
    expect(sol.partnerName).toBe('FullPartner')
    expect(sol.description).toBe('A complete description')
    expect(sol.platform).toBe('Ansible Automation Platform')
    expect(sol.categories).toEqual(['AI', 'Automation'])
    expect(sol.url).toContain('catalog.redhat.com')
    expect(sol.resources).toHaveLength(3)

    // AC-3: Resource types include lab, solution-brief, video
    const types = sol.resources.map(r => r.type).sort()
    expect(types).toContain('lab')
    expect(types).toContain('solution-brief')
    expect(types).toContain('video')
  })
})

// ── fetchSolutionResources ───────────────────────────────────────────────────

describe('fetchSolutionResources', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('maps PRM resources to EcosystemResource type', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([
        { title: 'A Lab', url: 'https://example.com/lab', type: 'demo' },
        { title: 'A Brief', url: 'https://example.com/brief', type: 'solution_brief' },
        { title: 'A Case Study', url: 'https://example.com/case', type: 'customer_case_study' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    const resources = await fetchSolutionResources('test-id')
    expect(resources).toHaveLength(3)
    expect(resources[0]).toEqual({ title: 'A Lab', url: 'https://example.com/lab', type: 'lab' })
    expect(resources[1]).toEqual({ title: 'A Brief', url: 'https://example.com/brief', type: 'solution-brief' })
    expect(resources[2]).toEqual({ title: 'A Case Study', url: 'https://example.com/case', type: 'case-study' })
  })

  test('returns empty array on API failure', async () => {
    globalThis.fetch = (async () => {
      return new Response('Error', { status: 500 })
    }) as typeof fetch

    const resources = await fetchSolutionResources('bad-id')
    expect(resources).toEqual([])
  })

  test('filters out resources missing title or url', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([
        { title: 'Valid', url: 'https://example.com', type: 'demo' },
        { title: '', url: 'https://example.com', type: 'demo' },
        { title: 'No URL', url: '', type: 'demo' },
        { type: 'demo' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    const resources = await fetchSolutionResources('test-id')
    expect(resources).toHaveLength(1)
    expect(resources[0].title).toBe('Valid')
  })

  test('handles nested resources property in response', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        resources: [
          { title: 'Nested', url: 'https://example.com/nested', type: 'video' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    const resources = await fetchSolutionResources('test-id')
    expect(resources).toHaveLength(1)
    expect(resources[0].title).toBe('Nested')
    expect(resources[0].type).toBe('video')
  })
})
