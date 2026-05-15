/**
 * Intelligence API Routes
 * GitHub Issue #200 — Intelligence tab shell + Red Hat News section
 * GitHub Issue #201 — Product Roadmap section
 *
 * Provides Red Hat intelligence surfaces:
 * - GET /api/customer/:name/intelligence/news — Red Hat news matched to customer products
 * - GET /api/customer/:name/intelligence/roadmap — Product lifecycle data (Issue #201)
 *
 * Future endpoints:
 * - GET /api/customer/:name/intelligence/events — Events near customer HQ
 */

import { Hono } from 'hono'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { toSlug } from './cache-layer.ts'
import type { NewsItem } from './news-provider.ts'
import type { ProductLifecycle } from './product-lifecycle.ts'

// ── Cache directory ──────────────────────────────────────────────────────────

const CACHE_DIR = resolve(process.env.DATA_DIR ?? 'data', 'cache', 'news')
const MAIN_CACHE_DIR = resolve(process.env.DATA_DIR ?? 'data', 'cache')
const INTEL_CACHE_DIR = resolve(MAIN_CACHE_DIR, 'intelligence')

// ── Cache helpers ────────────────────────────────────────────────────────────

interface NewsCacheEntry {
  articles: NewsItem[]
  lastUpdated: string
}

function getCachePath(customerName: string): string {
  const slug = toSlug(customerName)
  if (!slug || /[^a-zA-Z0-9_-]/.test(slug)) {
    throw new Error(`[intelligence-routes] unsafe slug: "${slug}"`)
  }
  return resolve(CACHE_DIR, `${slug}.json`)
}

function readCache(customerName: string): NewsCacheEntry | null {
  const cachePath = getCachePath(customerName)
  if (!existsSync(cachePath)) {
    return null
  }

  try {
    const data = JSON.parse(readFileSync(cachePath, 'utf-8'))
    return data
  } catch (e: any) {
    console.warn(`[intelligence-routes] Failed to read cache for ${customerName}:`, e.message)
    return null
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

export function createIntelligenceRouter(): Hono {
  const app = new Hono()

  /**
   * GET /api/customer/:name/intelligence/news
   * Read Red Hat news from cache (same source as News tab, different surface)
   */
  app.get('/api/customer/:name/intelligence/news', (c) => {
    const customerName = c.req.param('name')
    if (!customerName || customerName.length > 200) {
      return c.json({ error: 'Invalid customer name' }, 400)
    }
    const cached = readCache(customerName)

    if (!cached) {
      return c.json({ articles: [], cachedAt: null })
    }

    return c.json({
      articles: cached.articles,
      cachedAt: cached.lastUpdated,
    })
  })

  /**
   * GET /api/customer/:name/intelligence/roadmap
   * Product lifecycle data filtered to customer's relevant products
   * GitHub Issue #201, #212
   */
  app.get('/api/customer/:name/intelligence/roadmap', (c) => {
    const customerName = c.req.param('name')

    // Validate customer name and slug
    const slug = toSlug(customerName)
    if (!slug || /[^a-zA-Z0-9_-]/.test(slug)) {
      return c.json({ error: 'Invalid customer name' }, 400)
    }

    // Read product lifecycle cache
    const lifecyclePath = resolve(MAIN_CACHE_DIR, 'product-lifecycle.json')
    if (!existsSync(lifecyclePath)) {
      return c.json({ products: [], cachedAt: null })
    }

    let lifecycleData: { products: ProductLifecycle[]; fetchedAt: string }
    try {
      lifecycleData = JSON.parse(readFileSync(lifecyclePath, 'utf-8'))
    } catch (e: any) {
      console.warn('[intelligence-routes] Failed to read product lifecycle cache:', e?.message ?? e)
      return c.json({ products: [], cachedAt: null })
    }

    // GitHub Issue #212 (1/3): Read registered products from product-intel-config.json
    const configPath = resolve(process.env.DATA_DIR ?? 'data', 'config', 'product-intel-config.json')
    let registeredSlugs: Set<string> | null = null

    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
        if (config.products && Array.isArray(config.products)) {
          registeredSlugs = new Set(config.products.map((p: any) => p.slug))
        }
      } catch (e: any) {
        console.warn('[intelligence-routes] Failed to read product-intel config:', e?.message ?? e)
      }
    }

    // GitHub Issue #212 (2/3): Enrich products with product-release-radar cache data + docsUrl
    const PRODUCT_INTEL_CACHE = resolve(MAIN_CACHE_DIR, 'product-intel')
    let enrichedProducts = lifecycleData.products.map((product) => {
      let enriched: any = { ...product }

      // Try to read product-release-radar summary
      const summaryPath = resolve(PRODUCT_INTEL_CACHE, `${product.slug}-summary.json`)
      if (existsSync(summaryPath)) {
        try {
          const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'))
          // If radar has a newer current version, use it
          if (summary.currentVersion && summary.currentVersion !== product.currentVersion) {
            enriched.currentVersion = summary.currentVersion
          }
        } catch (e: any) {
          // Silently skip — not critical
        }
      }

      // Add docsUrl from product-intel config
      if (existsSync(configPath)) {
        try {
          const config = JSON.parse(readFileSync(configPath, 'utf-8'))
          const productConfig = config.products?.find((p: any) => p.slug === product.slug)
          if (productConfig?.seeds?.releaseNotesUrl) {
            enriched.docsUrl = productConfig.seeds.releaseNotesUrl
          }
        } catch (e: any) {
          // Silently skip
        }
      }

      return enriched
    })

    // GitHub Issue #212 (1/3): Filter to registered products only
    if (registeredSlugs && registeredSlugs.size > 0) {
      enrichedProducts = enrichedProducts.filter(p => registeredSlugs.has(p.slug))
    }

    return c.json({
      products: enrichedProducts,
      cachedAt: lifecycleData.fetchedAt,
    })
  })

  /**
   * GET /api/intelligence/global
   * Aggregate Red Hat intelligence across all customers (for Red Hat Pulse card)
   * GitHub Issue #203, #174 (RSS integration)
   */
  app.get('/api/intelligence/global', (c) => {
    // GitHub Issue #174: Read RSS feed data instead of customer news caches
    const RSS_CACHE_PATH = resolve(MAIN_CACHE_DIR, 'rss', 'rh-feeds.json')

    let news: any[] = []
    let cachedAt = new Date().toISOString()

    // Read Red Hat RSS feeds
    if (existsSync(RSS_CACHE_PATH)) {
      try {
        const rssData = JSON.parse(readFileSync(RSS_CACHE_PATH, 'utf-8'))
        if (rssData.items && Array.isArray(rssData.items)) {
          // Sort by pubDate desc, take top 3
          const sorted = [...rssData.items].sort((a, b) => {
            const aDate = new Date(a.pubDate).getTime()
            const bDate = new Date(b.pubDate).getTime()
            return bDate - aDate
          })
          news = sorted.slice(0, 3).map((item: any) => ({
            headline: item.title,
            sourceUrl: item.link,
            publishedDate: item.pubDate,
            summary: item.description,
            sourceName: item.source === 'blog' ? 'Red Hat Blog' : 'Red Hat Press Release',
            productTags: item.productTags,
          }))
        }
        if (rssData.fetchedAt) {
          cachedAt = rssData.fetchedAt
        }
      } catch (e: any) {
        console.warn('[intelligence-routes] Failed to read RSS cache:', e.message)
      }
    }

    // Read product lifecycle for releases
    const lifecyclePath = resolve(MAIN_CACHE_DIR, 'product-lifecycle.json')
    let releases: any[] = []

    if (existsSync(lifecyclePath)) {
      try {
        const lifecycleData = JSON.parse(readFileSync(lifecyclePath, 'utf-8'))
        if (lifecycleData.products && Array.isArray(lifecycleData.products)) {
          // Map to release format, take top 3 most recent
          releases = lifecycleData.products
            .filter((p: any) => p.nextVersion && p.nextExpected)
            .sort((a: any, b: any) => {
              const aDate = new Date(a.nextExpected).getTime()
              const bDate = new Date(b.nextExpected).getTime()
              return bDate - aDate
            })
            .slice(0, 3)
            .map((p: any) => ({
              product: p.displayName,
              version: p.nextVersion,
              expectedDate: p.nextExpected,
              currentVersion: p.currentVersion,
            }))
        }
      } catch (e: any) {
        console.warn('[intelligence-routes] Failed to read product lifecycle cache:', e.message)
      }
    }

    // Events: stub for now (no events data source yet)
    const events: any[] = []

    return c.json({
      news,
      releases,
      events,
      cachedAt,
    })
  })

  return app
}
