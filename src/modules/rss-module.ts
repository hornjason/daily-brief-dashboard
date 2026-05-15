/**
 * Red Hat RSS Module
 * GitHub Issue #174 — RSS feed module registration
 *
 * Registers RSS fetcher with FeatureModuleRegistry.
 * Provides Signal generation for content generation features.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { fetchRedHatRSS, type RSSItem } from '../rh-rss-fetcher.ts'
import { existsSync, unlinkSync, readFileSync } from 'fs'
import { resolve } from 'path'

const CACHE_PATH = resolve(process.env.DATA_DIR ?? 'data', 'cache', 'rss', 'rh-feeds.json')

FeatureModuleRegistry.register({
  name: 'rh-rss',

  cachePaths: () => ['data/cache/rss/rh-feeds.json'],

  refreshInterval: 4 * 60 * 60 * 1000,  // 4 hours

  async fetch(_customerName: string): Promise<void> {
    // RSS is global, not customer-specific
    await fetchRedHatRSS()
  },

  async cleanup(_customerName: string): Promise<void> {
    // Remove cache file when cleaning up (global, not per-customer)
    if (existsSync(CACHE_PATH)) {
      unlinkSync(CACHE_PATH)
    }
  },

  async syncNow(_customerName: string): Promise<void> {
    // Same as fetch for this module
    await fetchRedHatRSS()
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    // Read RSS cache
    if (!existsSync(CACHE_PATH)) {
      return []
    }

    let cache: { items: RSSItem[]; fetchedAt: string }
    try {
      const raw = readFileSync(CACHE_PATH, 'utf8')
      cache = JSON.parse(raw)
    } catch (e: any) {
      console.warn('[rss-module] Failed to parse cache:', e.message)
      return []
    }

    if (!cache.items || cache.items.length === 0) {
      return []
    }

    // Score items by age
    const now = Date.now()
    const signals: Signal[] = []

    for (const item of cache.items) {
      const pubDate = new Date(item.pubDate)
      const ageMs = now - pubDate.getTime()
      const ageHours = ageMs / (1000 * 60 * 60)

      // Score: 0.6 for < 24h, 0.4 for < 48h, 0.3 for older
      let score = 0.3
      if (ageHours < 24) {
        score = 0.6
      } else if (ageHours < 48) {
        score = 0.4
      }

      signals.push({
        source: 'rh-rss',
        type: 'news',
        headline: item.title,
        detail: item.description,
        score,
        timestamp: item.pubDate,
        url: item.link,
        metadata: {
          productTags: item.productTags,
          feedSource: item.source,
        },
      })
    }

    // Sort by score descending
    signals.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

    return signals
  },
})
