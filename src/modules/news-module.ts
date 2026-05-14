// src/modules/news-module.ts
// GitHub Issue #153 — News radar feature module registration
// Implements news search, caching, and cleanup

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry'
import { newsProvider, type NewsItem } from '../news-provider.ts'
import { toSlug } from '../cache-layer.ts'
import { existsSync, unlinkSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = resolve(process.env.DATA_DIR ?? 'data', 'cache', 'news')

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true })
}

FeatureModuleRegistry.register({
  name: 'news-radar',

  cachePaths: (slug: string) => [
    `data/cache/news/${slug}.json`,
  ],

  driveArtifacts: (slug: string) => [
    `${slug}/news/`,
  ],

  notebookSources: true,

  refreshInterval: 86_400_000,  // 24 hours

  async fetch(customerName: string): Promise<void> {
    const articles = await newsProvider.searchNews(customerName)
    const slug = toSlug(customerName)
    const cachePath = resolve(CACHE_DIR, `${slug}.json`)

    const entry = {
      articles,
      lastUpdated: new Date().toISOString(),
    }

    writeFileSync(cachePath, JSON.stringify(entry, null, 2), { mode: 0o600 })
  },

  async cleanup(customerName: string): Promise<void> {
    const slug = toSlug(customerName)
    const cachePath = resolve(CACHE_DIR, `${slug}.json`)

    if (existsSync(cachePath)) {
      unlinkSync(cachePath)
    }
  },

  async syncNow(customerName: string): Promise<void> {
    // Same as fetch for this module
    await this.fetch(customerName)
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const cachePath = resolve(CACHE_DIR, `${customerSlug}.json`)

    // No cache file → return empty array
    if (!existsSync(cachePath)) {
      return []
    }

    // Read and parse cache
    let cacheData: { articles: NewsItem[]; lastUpdated: string }
    try {
      const raw = readFileSync(cachePath, 'utf8')
      cacheData = JSON.parse(raw)
    } catch (e: any) {
      console.warn(`[news-module] Failed to parse cache for ${customerSlug}:`, e.message)
      return []
    }

    // Empty articles → return empty array
    if (!cacheData.articles || cacheData.articles.length === 0) {
      return []
    }

    // Get threshold from customer config (default 7)
    const threshold = getCustomerNewsThreshold(customerSlug)

    // Filter by threshold, map to Signal shape, sort by score descending
    const signals = cacheData.articles
      .filter((article) => article.significanceScore >= threshold)
      .map((article): Signal => ({
        source: 'news-radar',
        type: 'news',
        headline: article.headline,
        detail: article.summary,
        score: article.significanceScore / 10,  // Normalize 0-10 to 0-1
        timestamp: article.publishedDate,
        url: article.sourceUrl,
        metadata: {
          productTags: (article as any).productTags,  // Optional field, may not exist
          sourceName: article.sourceName,
          signalType: article.signalType,
        },
      }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))  // Sort by score descending

    return signals
  },
})

// ── Helper functions ─────────────────────────────────────────────────────────

/**
 * Get news threshold for a customer from config, defaulting to 7
 */
function getCustomerNewsThreshold(customerSlug: string): number {
  const configPath = resolve(process.env.DATA_DIR ?? 'data', 'config', 'customers.json')

  if (!existsSync(configPath)) {
    return 7  // Default threshold
  }

  try {
    const raw = readFileSync(configPath, 'utf8')
    const config = JSON.parse(raw)

    // Find customer by slug match
    const customer = config.customers?.find((c: any) => {
      const slug = toSlug(c.name)
      return slug === customerSlug
    })

    if (customer && typeof customer.newsThreshold === 'number') {
      return customer.newsThreshold
    }

    return 7  // Default threshold
  } catch (e: any) {
    console.warn('[news-module] Failed to read customer config, using default threshold 7:', e.message)
    return 7
  }
}
