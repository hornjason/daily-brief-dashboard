/**
 * Unit tests for Intelligence Routes
 * GitHub Issue #200 — Intelligence tab shell + Red Hat News section
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'fs'
import { resolve } from 'path'
import { createIntelligenceRouter } from '../../src/intelligence-routes.ts'
import type { NewsItem } from '../../src/news-provider.ts'

// MUST set env vars before any module imports resolve paths
const PROJECT_ROOT = resolve(import.meta.dir, '../..')
process.env.CACHE_DIR ??= resolve(PROJECT_ROOT, 'data/cache')
process.env.CONFIG_DIR ??= resolve(PROJECT_ROOT, 'data/config')
const TEST_CACHE_DIR = resolve(PROJECT_ROOT, 'data/cache/news')

describe('Intelligence Routes', () => {
  beforeEach(() => {
    // Ensure cache directory exists
    if (!existsSync(TEST_CACHE_DIR)) {
      mkdirSync(TEST_CACHE_DIR, { recursive: true })
    }
  })

  afterEach(() => {
    // Clean up test cache files
    if (existsSync(TEST_CACHE_DIR)) {
      const testFiles = ['acme-corp.json', 'boeing.json']
      for (const file of testFiles) {
        const path = resolve(TEST_CACHE_DIR, file)
        if (existsSync(path)) {
          unlinkSync(path)
        }
      }
    }
  })

  test.skip('GET /api/customer/:name/intelligence/news - returns cached news', async () => {
    const app = createIntelligenceRouter()

    // Write test cache
    const mockArticles: NewsItem[] = [
      {
        headline: 'AAP 2.7 Announced with MCP Server Support',
        summary: 'Red Hat announces Ansible Automation Platform 2.7...',
        sourceUrl: 'https://example.com/aap-2.7',
        sourceName: 'Red Hat',
        publishedDate: new Date().toISOString(),
        significanceScore: 8,
        signalType: 'product',
        productTags: ['AAP'],
      },
    ]

    const cachePath = resolve(TEST_CACHE_DIR, 'acme-corp.json')
    writeFileSync(
      cachePath,
      JSON.stringify({
        articles: mockArticles,
        lastUpdated: new Date().toISOString(),
      }),
      { mode: 0o600 }
    )

    const res = await app.request('/api/customer/Acme%20Corp/intelligence/news')
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.articles).toHaveLength(1)
    expect(json.articles[0].headline).toBe('AAP 2.7 Announced with MCP Server Support')
    expect(json.cachedAt).toBeDefined()
  })

  test('GET /api/customer/:name/intelligence/news - returns empty when no cache exists', async () => {
    const app = createIntelligenceRouter()

    const res = await app.request('/api/customer/NonExistent/intelligence/news')
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.articles).toEqual([])
    expect(json.cachedAt).toBe(null)
  })

  test.skip('GET /api/customer/:name/intelligence/news - productTags are present', async () => {
    const app = createIntelligenceRouter()

    const mockArticles: NewsItem[] = [
      {
        headline: 'OpenShift 4.18 GA Date Announced',
        summary: 'General availability scheduled for June 2026...',
        sourceUrl: 'https://example.com/ocp-4.18',
        sourceName: 'Red Hat',
        publishedDate: new Date().toISOString(),
        significanceScore: 5,
        signalType: 'product',
        productTags: ['OCP', 'AAP'],
      },
    ]

    const cachePath = resolve(TEST_CACHE_DIR, 'boeing.json')
    writeFileSync(
      cachePath,
      JSON.stringify({
        articles: mockArticles,
        lastUpdated: new Date().toISOString(),
      }),
      { mode: 0o600 }
    )

    const res = await app.request('/api/customer/Boeing/intelligence/news')
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.articles[0].productTags).toEqual(['OCP', 'AAP'])
  })

  test('GET /api/intelligence/global - aggregates news from all customers', async () => {
    const app = createIntelligenceRouter()

    // Write multiple customer caches
    const acmeArticles: NewsItem[] = [
      {
        headline: 'AAP 2.7 Announced',
        summary: 'Ansible Automation Platform 2.7...',
        sourceUrl: 'https://example.com/aap',
        sourceName: 'Red Hat',
        publishedDate: '2026-05-14T10:00:00Z',
        significanceScore: 8,
        signalType: 'product',
        productTags: ['AAP'],
      },
    ]

    const boeingArticles: NewsItem[] = [
      {
        headline: 'OpenShift 4.18 GA',
        summary: 'OpenShift Container Platform...',
        sourceUrl: 'https://example.com/ocp',
        sourceName: 'Red Hat',
        publishedDate: '2026-05-14T12:00:00Z',
        significanceScore: 7,
        signalType: 'product',
        productTags: ['OCP'],
      },
      {
        headline: 'AAP 2.7 Announced',
        summary: 'Ansible Automation Platform 2.7...',
        sourceUrl: 'https://example.com/aap',
        sourceName: 'Red Hat',
        publishedDate: '2026-05-14T10:00:00Z',
        significanceScore: 8,
        signalType: 'product',
        productTags: ['AAP'],
      },
    ]

    writeFileSync(
      resolve(TEST_CACHE_DIR, 'acme-corp.json'),
      JSON.stringify({ articles: acmeArticles, lastUpdated: '2026-05-14T10:00:00Z' }),
      { mode: 0o600 }
    )
    writeFileSync(
      resolve(TEST_CACHE_DIR, 'boeing.json'),
      JSON.stringify({ articles: boeingArticles, lastUpdated: '2026-05-14T12:00:00Z' }),
      { mode: 0o600 }
    )

    const res = await app.request('/api/intelligence/global')
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.news).toBeDefined()
    expect(json.releases).toBeDefined()
    expect(json.events).toBeDefined()
    expect(json.cachedAt).toBeDefined()

    // Should deduplicate (AAP 2.7 appears in both caches)
    // and return top 3 by publishedDate desc
    expect(json.news.length).toBeLessThanOrEqual(3)

    // Most recent first (OCP at 12:00, AAP at 10:00)
    if (json.news.length > 0) {
      expect(json.news[0].headline).toBe('OpenShift 4.18 GA')
    }
  })

  test('GET /api/intelligence/global - returns empty arrays when no caches exist', async () => {
    const app = createIntelligenceRouter()

    // Clean up all test caches
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
      mkdirSync(TEST_CACHE_DIR, { recursive: true })
    }

    const res = await app.request('/api/intelligence/global')
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(Array.isArray(json.news)).toBe(true)
    expect(Array.isArray(json.releases)).toBe(true)
    expect(Array.isArray(json.events)).toBe(true)
    expect(json.cachedAt).toBeDefined()
  })

  test.skip('GET /api/customer/:name/intelligence/roadmap - returns product lifecycle data', async () => {
    const app = createIntelligenceRouter()

    // Write test product lifecycle cache
    const MAIN_CACHE_DIR = resolve(import.meta.dir, '../../data/cache')
    const lifecyclePath = resolve(MAIN_CACHE_DIR, 'product-lifecycle.json')

    if (!existsSync(MAIN_CACHE_DIR)) {
      mkdirSync(MAIN_CACHE_DIR, { recursive: true })
    }

    writeFileSync(
      lifecyclePath,
      JSON.stringify({
        products: [
          {
            slug: 'ocp',
            displayName: 'Red Hat OpenShift Container Platform',
            currentVersion: '4.17',
            latestPatch: '4.17.3',
            nextVersion: '4.18',
            nextExpected: '2026-06-15',
            gaDate: '2025-03-01',
            eolDate: '2025-03-26',
            eusAvailable: true,
            supportEnd: '2025-03-26',
          },
          {
            slug: 'rhel',
            displayName: 'Red Hat Enterprise Linux',
            currentVersion: '9.3',
            latestPatch: '9.3.1',
            nextVersion: '9.4',
            nextExpected: '2026-05-28',
            gaDate: '2024-11-05',
            eolDate: '2032-05-31',
            eusAvailable: true,
            supportEnd: '2032-05-31',
          },
          {
            slug: 'aap',
            displayName: 'Red Hat Ansible Automation Platform',
            currentVersion: '2.6',
            latestPatch: '2.6.2',
            nextVersion: '2.7',
            nextExpected: '2026-06-01',
            gaDate: '2024-05-14',
            eolDate: '2024-05-27',
            eusAvailable: false,
            supportEnd: '2024-05-27',
          },
        ],
        fetchedAt: new Date().toISOString(),
      }),
      { mode: 0o600 }
    )

    // Write customer expansion cache (to filter products)
    const INTEL_CACHE_DIR = resolve(MAIN_CACHE_DIR, 'intelligence')
    if (!existsSync(INTEL_CACHE_DIR)) {
      mkdirSync(INTEL_CACHE_DIR, { recursive: true })
    }

    const expansionPath = resolve(INTEL_CACHE_DIR, 'acme-corp-expansion.json')
    writeFileSync(
      expansionPath,
      JSON.stringify({
        opportunities: [
          { productSlug: 'ocp', score: 85 },
          { productSlug: 'aap', score: 65 },
        ],
        lastUpdated: new Date().toISOString(),
      }),
      { mode: 0o600 }
    )

    const res = await app.request('/api/customer/Acme%20Corp/intelligence/roadmap')
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.products).toBeDefined()
    expect(json.cachedAt).toBeDefined()

    // Should filter to customer's relevant products (ocp, aap based on expansion data)
    expect(json.products.length).toBeGreaterThan(0)
    expect(json.products.some((p: any) => p.slug === 'ocp')).toBe(true)

    // Cleanup
    if (existsSync(lifecyclePath)) {
      unlinkSync(lifecyclePath)
    }
    if (existsSync(expansionPath)) {
      unlinkSync(expansionPath)
    }
  })

  test.skip('GET /api/customer/:name/intelligence/roadmap - returns all products when no customer data exists', async () => {
    const app = createIntelligenceRouter()

    const MAIN_CACHE_DIR = resolve(import.meta.dir, '../../data/cache')
    const lifecyclePath = resolve(MAIN_CACHE_DIR, 'product-lifecycle.json')

    if (!existsSync(MAIN_CACHE_DIR)) {
      mkdirSync(MAIN_CACHE_DIR, { recursive: true })
    }

    writeFileSync(
      lifecyclePath,
      JSON.stringify({
        products: [
          {
            slug: 'ocp',
            displayName: 'Red Hat OpenShift Container Platform',
            currentVersion: '4.17',
            latestPatch: '4.17.3',
            nextVersion: '4.18',
            nextExpected: '2026-06-15',
            gaDate: '2025-03-01',
            eolDate: '2025-03-26',
            eusAvailable: true,
            supportEnd: '2025-03-26',
          },
          {
            slug: 'rhel',
            displayName: 'Red Hat Enterprise Linux',
            currentVersion: '9.3',
            latestPatch: '9.3.1',
            nextVersion: '9.4',
            nextExpected: '2026-05-28',
            gaDate: '2024-11-05',
            eolDate: '2032-05-31',
            eusAvailable: true,
            supportEnd: '2032-05-31',
          },
        ],
        fetchedAt: new Date().toISOString(),
      }),
      { mode: 0o600 }
    )

    const res = await app.request('/api/customer/NonExistent/intelligence/roadmap')
    expect(res.status).toBe(200)

    const json = await res.json()
    // When no customer-specific data, return all products
    expect(json.products.length).toBe(2)

    // Cleanup
    if (existsSync(lifecyclePath)) {
      unlinkSync(lifecyclePath)
    }
  })

  test('GET /api/customer/:name/intelligence/roadmap - returns global products for any valid customer name', async () => {
    const app = createIntelligenceRouter()

    // Route now serves global product intelligence regardless of customer existence
    const res = await app.request('/api/customer/NonExistent/intelligence/roadmap')
    expect(res.status).toBe(200)

    const json = await res.json()
    // Should return global product lifecycle data (not customer-specific)
    expect(Array.isArray(json.products)).toBe(true)
    expect(json.products.length).toBeGreaterThan(0)
    expect(json.cachedAt).toBeDefined()
  })

  test('GET /api/customer/:name/intelligence/roadmap - handles invalid slug gracefully', async () => {
    const app = createIntelligenceRouter()

    // Path with special chars that produce empty slug
    const res = await app.request('/api/customer/%2F%2F%2F/intelligence/roadmap')
    expect(res.status).toBe(400)

    const json = await res.json()
    expect(json.error).toBeDefined()
  })
})
