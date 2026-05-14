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
})
