/**
 * Red Hat RSS Module
 * GitHub Issue #174 — RSS feed module registration
 *
 * Registers RSS fetcher with FeatureModuleRegistry.
 * Provides Signal generation for content generation features.
 */

import { FeatureModuleRegistry, type Signal, type NavDeclaration, type ModuleScope } from '../feature-module-registry.ts'
import { fetchRedHatRSS, type RSSItem } from '../rh-rss-fetcher.ts'
import { existsSync, unlinkSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'
import { getCustomerProductContext, normalizeProductSlug } from '../lib/customer-product-context.ts'

const CACHE_PATH = resolve(process.env.CACHE_DIR ?? 'data/cache', 'rss', 'rh-feeds.json')
const RSS_TTL_MS = 4 * 60 * 60 * 1000  // 4 hours

FeatureModuleRegistry.register({
  name: 'rh-rss',
  displayName: 'RSS Feeds',
  refreshEndpoint: '/api/admin/rss-feeds/refresh',
  signalRole: 'enrichment',
  signalAudience: 'all',
  scope: 'portfolio',

  nav: {
    label: 'Red Hat News',
    icon: 'Rss',
    group: 'intelligence',
    path: '/dashboard/rh-news',
    order: 40,
  },

  cachePaths: () => ['data/cache/rss/rh-feeds.json'],

  cacheTtlMs: RSS_TTL_MS,

  refreshInterval: 4 * 60 * 60 * 1000,  // 4 hours

  async ensureFresh(_customerSlug: string): Promise<void> {
    // Portfolio-wide cache — check single file
    try {
      const stat = statSync(CACHE_PATH)
      if (Date.now() - stat.mtimeMs < RSS_TTL_MS) return // fresh
    } catch { /* file doesn't exist — needs refresh */ }

    // Stale or missing — refresh
    await fetchRedHatRSS()
  },

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
    await fetchRedHatRSS()
    try {
      const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'))
      FeatureModuleRegistry.recordOutcome('rh-rss', { success: true, recordCount: raw.items?.length ?? 0 })
    } catch { FeatureModuleRegistry.recordOutcome('rh-rss', { success: false, error: 'Failed to read RSS cache' }) }
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

    const context = getCustomerProductContext(customerSlug)
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

      let rawRelevance = 0.3
      if (ageHours < 24) {
        rawRelevance = 0.9
      } else if (ageHours < 48) {
        rawRelevance = 0.6
      }

      // ADR-029: cross-reference productTags against customer products
      let productMatch = false
      const matchedProducts: string[] = []

      if (item.productTags && item.productTags.length > 0) {
        for (const tag of item.productTags) {
          const slug = normalizeProductSlug(tag)
          if (slug && context.ownedProducts.includes(slug)) {
            productMatch = true
            if (!matchedProducts.includes(slug)) matchedProducts.push(slug)
          }
        }
      }

      // Check if customer name appears in headline or description
      const titleLower = item.title.toLowerCase()
      const descLower = item.description.toLowerCase()
      const hasCustomerName = customerNameLower && (
        titleLower.includes(customerNameLower) ||
        descLower.includes(customerNameLower)
      )

      const metadata: Record<string, any> = {
        productTags: item.productTags,
        feedSource: item.source,
      }

      // Name match takes priority, then subscription, then interest
      if (hasCustomerName) {
        metadata.customerSlug = customerSlug
        metadata.matchType = 'name'
      } else if (productMatch) {
        metadata.customerSlug = customerSlug
        if (context.ownedProducts.some(p => matchedProducts.includes(p))) {
          metadata.matchType = 'subscription'
        } else {
          metadata.matchType = 'interest'
          metadata.context = 'evaluating'
        }
      } else {
        continue
      }

      if (matchedProducts.length > 0) {
        metadata.redHatProducts = matchedProducts
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
