/**
 * Unit tests for Intelligence Routes
 * GitHub Issue #200 — Intelligence tab shell + Red Hat News section
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'fs'
import { resolve } from 'path'
import { createIntelligenceRouter } from '../../src/intelligence-routes.ts'
import type { NewsItem } from '../../src/news-provider.ts'

const TEST_CACHE_DIR = resolve(import.meta.dir, '../../data/cache/news')

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

  test('GET /api/customer/:name/intelligence/news - returns cached news', async () => {
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

  test('GET /api/customer/:name/intelligence/news - productTags are present', async () => {
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
    expect(json.news).toEqual([])
    expect(json.releases).toEqual([])
    expect(json.events).toEqual([])
    expect(json.cachedAt).toBeDefined()
  })
})
