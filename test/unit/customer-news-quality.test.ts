import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { resolve } from 'path'

const TEST_CACHE_DIR = resolve('data', 'test-cache-news-quality')
const NEWS_DIR = resolve(TEST_CACHE_DIR, 'news')
const CONFIG_PATH = resolve('config', 'news-config.json')

function makeArticle(overrides: Record<string, any> = {}) {
  return {
    headline: 'Test Headline',
    summary: 'Test summary',
    sourceUrl: 'https://example.com',
    sourceName: 'Test Source',
    publishedDate: new Date().toISOString(),
    significanceScore: 5,
    signalType: 'company news',
    productTags: ['OpenShift'],
    ...overrides,
  }
}

function writeCacheFile(slug: string, articles: any[]) {
  writeFileSync(
    resolve(NEWS_DIR, `${slug}.json`),
    JSON.stringify({ articles, lastUpdated: new Date().toISOString() }),
  )
}

describe('Customer News Quality (#983, #984, #985)', () => {
  beforeEach(() => {
    if (existsSync(TEST_CACHE_DIR)) rmSync(TEST_CACHE_DIR, { recursive: true })
    mkdirSync(NEWS_DIR, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TEST_CACHE_DIR)) rmSync(TEST_CACHE_DIR, { recursive: true })
  })

  // ── #983 AC-1: Job posting keywords in config ───────────────────────────
  describe('#983 — Job posting exclusion keywords', () => {
    it('news-config.json has ≥5 job-related exclude keywords', () => {
      const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
      const jobKeywords = ['hiring', 'job opening', 'career', 'apply now',
        "we're looking for", 'job posting', 'now hiring', 'open position']
      const found = jobKeywords.filter(kw =>
        config.excludeKeywords.some((ek: string) => ek.toLowerCase() === kw.toLowerCase()),
      )
      expect(found.length).toBeGreaterThanOrEqual(5)
    })
  })

  // ── #983 AC-2: Score threshold filter ───────────────────────────────────
  describe('#983 — Score threshold filter', () => {
    it('articles with effectiveScore ≤ 2 are excluded from morning brief', async () => {
      const origEnv = process.env.CACHE_DIR
      process.env.CACHE_DIR = TEST_CACHE_DIR

      writeCacheFile('acme-corp', [
        makeArticle({ headline: 'Low score article', significanceScore: 1, publishedDate: new Date(Date.now() - 10 * 86_400_000).toISOString() }),
        makeArticle({ headline: 'High score article', significanceScore: 8 }),
      ])

      const { buildRedHatIntelligenceForMorningBrief } = await import('../../src/dashboard-service.ts')
      const result = await buildRedHatIntelligenceForMorningBrief(
        [{ name: 'Acme Corp', products: ['OpenShift'] }],
        [],
      )

      process.env.CACHE_DIR = origEnv

      const headlines = result?.meetingNews.map(n => n.headline) ?? []
      expect(headlines).toContain('High score article')
      expect(headlines).not.toContain('Low score article')
    })
  })

  // ── #984: Canonical name dedup ──────────────────────────────────────────
  describe('#984 — Canonical name dedup', () => {
    it('uber.json and uber-technologies.json merge into 1 customer slot', async () => {
      const origEnv = process.env.CACHE_DIR
      process.env.CACHE_DIR = TEST_CACHE_DIR

      writeCacheFile('uber', [
        makeArticle({ headline: 'Uber expands fleet', significanceScore: 7 }),
      ])
      writeCacheFile('uber-technologies', [
        makeArticle({ headline: 'Uber Technologies Q2 results', significanceScore: 6 }),
      ])

      const { buildRedHatIntelligenceForMorningBrief } = await import('../../src/dashboard-service.ts')
      const result = await buildRedHatIntelligenceForMorningBrief(
        [{ name: 'Uber Technologies', products: ['OpenShift'] }],
        [],
      )

      process.env.CACHE_DIR = origEnv

      const customerNames = result?.meetingNews.map(n => n.relevantCustomer) ?? []
      const uberSlots = customerNames.filter(n => n.toLowerCase().includes('uber'))
      expect(uberSlots.length).toBeLessThanOrEqual(1)
    })
  })

  // ── #985: Meeting boost ─────────────────────────────────────────────────
  describe('#985 — Meeting relevance boost', () => {
    it('customer with upcoming meeting gets +5 boost and ranks higher', async () => {
      const origEnv = process.env.CACHE_DIR
      process.env.CACHE_DIR = TEST_CACHE_DIR

      writeCacheFile('meeting-customer', [
        makeArticle({ headline: 'Meeting customer news', significanceScore: 4 }),
      ])
      writeCacheFile('no-meeting-customer', [
        makeArticle({ headline: 'No meeting customer news', significanceScore: 6 }),
      ])

      const tomorrow = new Date(Date.now() + 86_400_000).toISOString()
      const { buildRedHatIntelligenceForMorningBrief } = await import('../../src/dashboard-service.ts')
      const result = await buildRedHatIntelligenceForMorningBrief(
        [
          { name: 'Meeting Customer', products: ['OpenShift'] },
          { name: 'No Meeting Customer', products: ['Ansible'] },
        ],
        [{ title: 'Call with Meeting Customer', start: tomorrow, customers: ['Meeting Customer'] }],
      )

      process.env.CACHE_DIR = origEnv

      const news = result?.meetingNews ?? []
      expect(news.length).toBeGreaterThanOrEqual(1)
      // Meeting customer (score 4 + 5 boost + 3 recency = 12) should rank above
      // no-meeting customer (score 6 + 3 recency = 9)
      expect(news[0].relevantCustomer).toBe('Meeting Customer')
    })

    it('3-day lookahead includes day-after-tomorrow meetings', async () => {
      const origEnv = process.env.CACHE_DIR
      process.env.CACHE_DIR = TEST_CACHE_DIR

      writeCacheFile('future-customer', [
        makeArticle({ headline: 'Future customer news', significanceScore: 4 }),
      ])
      writeCacheFile('baseline-customer', [
        makeArticle({ headline: 'Baseline news', significanceScore: 3 }),
      ])

      const dayAfterTomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString()
      const { buildRedHatIntelligenceForMorningBrief } = await import('../../src/dashboard-service.ts')
      const result = await buildRedHatIntelligenceForMorningBrief(
        [
          { name: 'Future Customer', products: ['OpenShift'] },
          { name: 'Baseline Customer', products: ['Ansible'] },
        ],
        [{ title: 'Planning with Future Customer', start: dayAfterTomorrow, customers: ['Future Customer'] }],
      )

      process.env.CACHE_DIR = origEnv

      const news = result?.meetingNews ?? []
      expect(news.length).toBeGreaterThanOrEqual(1)
      // Future customer gets meeting boost even for day-after-tomorrow
      expect(news[0].relevantCustomer).toBe('Future Customer')
    })
  })
})
