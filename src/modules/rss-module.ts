/**
 * Red Hat RSS Module
 * GitHub Issue #174 — RSS feed module registration
 *
 * Registers RSS fetcher with FeatureModuleRegistry.
 * Provides Signal generation for content generation features.
 */

import { FeatureModuleRegistry, type Signal, type NavDeclaration, type ModuleScope } from '../feature-module-registry.ts'
import { fetchRedHatRSS, type RSSItem } from '../rh-rss-fetcher.ts'
import { existsSync, unlinkSync, readFileSync } from 'fs'
import { resolve } from 'path'

const CACHE_PATH = resolve(process.env.CACHE_DIR ?? 'data/cache', 'rss', 'rh-feeds.json')

FeatureModuleRegistry.register({
  name: 'rh-rss',
  displayName: 'RSS Feeds',
  refreshEndpoint: '/api/admin/rss-feeds/refresh',

  scope: 'portfolio',

  nav: {
    label: 'Red Hat News',
    icon: 'Rss',
    group: 'intelligence',
    path: '/dashboard/rh-news',
    order: 40,
  },

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

    // ADR-027: Convert scoring to rawRelevance, detect customer/industry specificity
    const now = Date.now()
    const signals: Signal[] = []

    // Import customers to check for name matches
    const { customers } = await import('../server-state.ts')
    const customer = customers.find(c => {
      const { toSlug } = require('../cache-layer.ts')
      return toSlug(c.name) === customerSlug
    })
    const customerNameLower = customer?.name.toLowerCase() ?? ''

    for (const item of cache.items) {
      const pubDate = new Date(item.pubDate)
      const ageMs = now - pubDate.getTime()
      const ageHours = ageMs / (1000 * 60 * 60)

      // rawRelevance: 0.9 for < 24h, 0.6 for < 48h, 0.3 for older
      let rawRelevance = 0.3
      if (ageHours < 24) {
        rawRelevance = 0.9
      } else if (ageHours < 48) {
        rawRelevance = 0.6
      }

      // Check if customer name appears in headline or description
      const titleLower = item.title.toLowerCase()
      const descLower = item.description.toLowerCase()
      const hasCustomerName = customerNameLower && (
        titleLower.includes(customerNameLower) ||
        descLower.includes(customerNameLower)
      )

      // Build metadata
      const metadata: Record<string, any> = {
        productTags: item.productTags,
        feedSource: item.source,
      }

      // Mark customer-specific signals
      if (hasCustomerName) {
        metadata.customerSlug = customerSlug
      }

      signals.push({
        source: 'rh-rss',
        type: 'news',
        headline: item.title,
        detail: item.description,
        rawRelevance,
        timestamp: item.pubDate,
        url: item.link,
        metadata,
      })
    }

    // Sort by rawRelevance descending
    signals.sort((a, b) => (b.rawRelevance ?? 0) - (a.rawRelevance ?? 0))

    return signals
  },
})
