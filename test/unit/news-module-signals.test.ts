// test/unit/news-module-signals.test.ts
// GitHub Issue #175 — news-radar signals() implementation tests
// Tests the signals() method that maps NewsItem to Signal interface

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'fs'
import { resolve } from 'path'
import type { Signal } from '../../src/feature-module-registry'

// Import the registry to access the registered module
import { FeatureModuleRegistry } from '../../src/feature-module-registry'
import '../../src/modules/news-module'  // Side-effect: registers the module

const TEST_CACHE_DIR = resolve(process.env.DATA_DIR ?? 'data', 'cache', 'news')
const TEST_CONFIG_DIR = resolve(process.env.DATA_DIR ?? 'data', 'config')

describe('news-module signals()', () => {
  const testSlug = 'test-customer'
  const testCachePath = resolve(TEST_CACHE_DIR, `${testSlug}.json`)
  const customersConfigPath = resolve(TEST_CONFIG_DIR, 'customers.json')

  beforeEach(() => {
    // Ensure cache directory exists
    if (!existsSync(TEST_CACHE_DIR)) {
      mkdirSync(TEST_CACHE_DIR, { recursive: true })
    }

    // Ensure config directory exists
    if (!existsSync(TEST_CONFIG_DIR)) {
      mkdirSync(TEST_CONFIG_DIR, { recursive: true })
    }
  })

  afterEach(() => {
    // Clean up test cache file
    if (existsSync(testCachePath)) {
      unlinkSync(testCachePath)
    }

    // Clean up test config file
    if (existsSync(customersConfigPath)) {
      unlinkSync(customersConfigPath)
    }
  })

  it('maps NewsItem fields to Signal fields correctly', async () => {
    // Setup: Write test cache file with one article
    const testCache = {
      articles: [
        {
          headline: 'Company announces major acquisition',
          summary: 'Company XYZ acquires competitor for $5B',
          sourceUrl: 'https://example.com/article',
          sourceName: 'TechCrunch',
          publishedDate: '2026-05-14T10:00:00Z',
          significanceScore: 8,
          signalType: 'acquisition',
        },
      ],
      lastUpdated: '2026-05-14T12:00:00Z',
    }

    writeFileSync(testCachePath, JSON.stringify(testCache, null, 2), { mode: 0o600 })

    // Execute: Call signals()
    const newsModule = FeatureModuleRegistry.get('news-radar')
    expect(newsModule).toBeDefined()
    expect(newsModule?.signals).toBeDefined()

    const signals = await newsModule!.signals!(testSlug)

    // Verify: Check Signal shape
    expect(signals).toHaveLength(1)

    const signal = signals[0]
    expect(signal.source).toBe('news-radar')
    expect(signal.type).toBe('news')
    expect(signal.headline).toBe('Company announces major acquisition')
    expect(signal.detail).toBe('Company XYZ acquires competitor for $5B')
    expect(signal.score).toBe(0.8)  // 8/10 = 0.8
    expect(signal.timestamp).toBe('2026-05-14T10:00:00Z')
    expect(signal.url).toBe('https://example.com/article')
    expect(signal.metadata).toEqual({
      productTags: undefined,  // Not set in test data
      sourceName: 'TechCrunch',
      signalType: 'acquisition',
    })
  })

  it('normalizes significanceScore from 0-10 to score 0-1', async () => {
    // Setup: Write test cache with various scores (all above threshold 7 to test normalization)
    const testCache = {
      articles: [
        { headline: 'Low score', summary: 'Detail', sourceUrl: 'http://a.com', sourceName: 'A', publishedDate: '2026-05-14T10:00:00Z', significanceScore: 7, signalType: 'other' },
        { headline: 'Mid score', summary: 'Detail', sourceUrl: 'http://b.com', sourceName: 'B', publishedDate: '2026-05-14T10:00:00Z', significanceScore: 8, signalType: 'other' },
        { headline: 'High score', summary: 'Detail', sourceUrl: 'http://c.com', sourceName: 'C', publishedDate: '2026-05-14T10:00:00Z', significanceScore: 10, signalType: 'other' },
      ],
      lastUpdated: '2026-05-14T12:00:00Z',
    }

    writeFileSync(testCachePath, JSON.stringify(testCache, null, 2), { mode: 0o600 })

    // Execute
    const newsModule = FeatureModuleRegistry.get('news-radar')
    const signals = await newsModule!.signals!(testSlug)

    // Verify: All 3 pass threshold, sorted by score descending
    expect(signals).toHaveLength(3)
    expect(signals[0].score).toBe(1.0)  // 10/10
    expect(signals[1].score).toBe(0.8)  // 8/10
    expect(signals[2].score).toBe(0.7)  // 7/10
  })

  it('filters by threshold (default 7)', async () => {
    // Setup: Write test cache with articles above and below threshold
    const testCache = {
      articles: [
        { headline: 'Low significance', summary: 'Detail', sourceUrl: 'http://a.com', sourceName: 'A', publishedDate: '2026-05-14T10:00:00Z', significanceScore: 3, signalType: 'other' },
        { headline: 'Below threshold', summary: 'Detail', sourceUrl: 'http://b.com', sourceName: 'B', publishedDate: '2026-05-14T10:00:00Z', significanceScore: 6, signalType: 'other' },
        { headline: 'At threshold', summary: 'Detail', sourceUrl: 'http://c.com', sourceName: 'C', publishedDate: '2026-05-14T10:00:00Z', significanceScore: 7, signalType: 'other' },
        { headline: 'Above threshold', summary: 'Detail', sourceUrl: 'http://d.com', sourceName: 'D', publishedDate: '2026-05-14T10:00:00Z', significanceScore: 9, signalType: 'other' },
      ],
      lastUpdated: '2026-05-14T12:00:00Z',
    }

    writeFileSync(testCachePath, JSON.stringify(testCache, null, 2), { mode: 0o600 })

    // Execute (no custom threshold in config, should default to 7)
    const newsModule = FeatureModuleRegistry.get('news-radar')
    const signals = await newsModule!.signals!(testSlug)

    // Verify: Only articles with score >= 7 included, sorted by score descending
    expect(signals).toHaveLength(2)
    expect(signals[0].headline).toBe('Above threshold')  // Score 9, sorted first
    expect(signals[1].headline).toBe('At threshold')     // Score 7, sorted second
  })

  it('filters by custom threshold from customer config', async () => {
    // Setup: Write customer config with custom newsThreshold
    const customersConfig = {
      customers: [
        {
          name: 'Test Customer',
          newsThreshold: 5,  // Custom threshold
        },
      ],
    }

    writeFileSync(customersConfigPath, JSON.stringify(customersConfig, null, 2), { mode: 0o600 })

    // Setup: Write test cache with articles
    const testCache = {
      articles: [
        { headline: 'Below custom threshold', summary: 'Detail', sourceUrl: 'http://a.com', sourceName: 'A', publishedDate: '2026-05-14T10:00:00Z', significanceScore: 4, signalType: 'other' },
        { headline: 'At custom threshold', summary: 'Detail', sourceUrl: 'http://b.com', sourceName: 'B', publishedDate: '2026-05-14T10:00:00Z', significanceScore: 5, signalType: 'other' },
        { headline: 'Above custom threshold', summary: 'Detail', sourceUrl: 'http://c.com', sourceName: 'C', publishedDate: '2026-05-14T10:00:00Z', significanceScore: 8, signalType: 'other' },
      ],
      lastUpdated: '2026-05-14T12:00:00Z',
    }

    writeFileSync(testCachePath, JSON.stringify(testCache, null, 2), { mode: 0o600 })

    // Execute
    const newsModule = FeatureModuleRegistry.get('news-radar')
    const signals = await newsModule!.signals!(testSlug)

    // Verify: Only articles with score >= 5 included, sorted by score descending
    expect(signals).toHaveLength(2)
    expect(signals[0].headline).toBe('Above custom threshold')  // Score 8, sorted first
    expect(signals[1].headline).toBe('At custom threshold')     // Score 5, sorted second
  })

  it('returns empty array when no cache exists', async () => {
    // Setup: Ensure no cache file exists
    if (existsSync(testCachePath)) {
      unlinkSync(testCachePath)
    }

    // Execute
    const newsModule = FeatureModuleRegistry.get('news-radar')
    const signals = await newsModule!.signals!(testSlug)

    // Verify
    expect(signals).toEqual([])
  })

  it('returns empty array when cache has empty articles array', async () => {
    // Setup: Write cache with no articles
    const testCache = {
      articles: [],
      lastUpdated: '2026-05-14T12:00:00Z',
    }

    writeFileSync(testCachePath, JSON.stringify(testCache, null, 2), { mode: 0o600 })

    // Execute
    const newsModule = FeatureModuleRegistry.get('news-radar')
    const signals = await newsModule!.signals!(testSlug)

    // Verify
    expect(signals).toEqual([])
  })

  it('catches and warns on invalid cache JSON, returns empty array', async () => {
    // Setup: Write invalid JSON
    writeFileSync(testCachePath, 'INVALID JSON{{{', { mode: 0o600 })

    // Execute
    const newsModule = FeatureModuleRegistry.get('news-radar')

    // Should not throw, should return empty array
    const signals = await newsModule!.signals!(testSlug)

    // Verify
    expect(signals).toEqual([])
  })

  it('sorts results by score descending', async () => {
    // Setup: Write test cache with unsorted articles
    const testCache = {
      articles: [
        { headline: 'Mid score', summary: 'Detail', sourceUrl: 'http://b.com', sourceName: 'B', publishedDate: '2026-05-14T10:00:00Z', significanceScore: 8, signalType: 'other' },
        { headline: 'High score', summary: 'Detail', sourceUrl: 'http://c.com', sourceName: 'C', publishedDate: '2026-05-14T10:00:00Z', significanceScore: 10, signalType: 'other' },
        { headline: 'Low score', summary: 'Detail', sourceUrl: 'http://a.com', sourceName: 'A', publishedDate: '2026-05-14T10:00:00Z', significanceScore: 7, signalType: 'other' },
      ],
      lastUpdated: '2026-05-14T12:00:00Z',
    }

    writeFileSync(testCachePath, JSON.stringify(testCache, null, 2), { mode: 0o600 })

    // Execute
    const newsModule = FeatureModuleRegistry.get('news-radar')
    const signals = await newsModule!.signals!(testSlug)

    // Verify: Results sorted by score descending (10, 8, 7)
    expect(signals).toHaveLength(3)
    expect(signals[0].score).toBe(1.0)  // 10/10
    expect(signals[1].score).toBe(0.8)  // 8/10
    expect(signals[2].score).toBe(0.7)  // 7/10
  })
})
