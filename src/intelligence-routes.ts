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
   * GitHub Issue #201
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

    // Try to read customer expansion data for filtering
    const expansionPath = resolve(INTEL_CACHE_DIR, `${slug}-expansion.json`)
    let expansionProducts: Set<string> | null = null

    if (existsSync(expansionPath)) {
      try {
        const expansionData = JSON.parse(readFileSync(expansionPath, 'utf-8'))
        if (expansionData.opportunities && Array.isArray(expansionData.opportunities)) {
          expansionProducts = new Set(
            expansionData.opportunities.map((opp: any) => opp.productSlug)
          )
        }
      } catch (e: any) {
        console.warn('[intelligence-routes] Failed to read expansion data for', slug, ':', e?.message ?? e)
      }
    }

    // Try to read customer subscriptions from sheets data
    const sheetsPath = resolve(MAIN_CACHE_DIR, `${slug}-sheets.json`)
    let subscriptionProducts: Set<string> | null = null

    if (existsSync(sheetsPath)) {
      try {
        const sheetsData = JSON.parse(readFileSync(sheetsPath, 'utf-8'))
        if (sheetsData.subscriptions && Array.isArray(sheetsData.subscriptions)) {
          subscriptionProducts = new Set(
            sheetsData.subscriptions
              .map((sub: any) => {
                // Map product names to slugs
                const name = sub.product?.toLowerCase() || ''
                if (name.includes('openshift') || name.includes('ocp')) return 'ocp'
                if (name.includes('ansible') || name.includes('aap')) return 'aap'
                if (name.includes('rhel') || name.includes('enterprise linux')) return 'rhel'
                return null
              })
              .filter(Boolean)
          )
        }
      } catch (e: any) {
        console.warn('[intelligence-routes] Failed to read sheets data for', slug, ':', e?.message ?? e)
      }
    }

    // Filter products: if we have customer-specific data, use it; otherwise return all
    let products = lifecycleData.products

    if (expansionProducts || subscriptionProducts) {
      const relevantSlugs = new Set([
        ...(expansionProducts || []),
        ...(subscriptionProducts || []),
      ])

      if (relevantSlugs.size > 0) {
        products = lifecycleData.products.filter(p => relevantSlugs.has(p.slug))
      }
    }

    return c.json({
      products,
      cachedAt: lifecycleData.fetchedAt,
    })
  })

  /**
   * GET /api/intelligence/global
   * Aggregate Red Hat intelligence across all customers (for Red Hat Pulse card)
   * GitHub Issue #203
   */
  app.get('/api/intelligence/global', (c) => {
    const { readdirSync } = require('fs')

    // Scan all customer news caches
    const allNews: NewsItem[] = []
    const latestTimestamps: string[] = []

    try {
      if (!existsSync(CACHE_DIR)) {
        return c.json({
          news: [],
          releases: [],
          events: [],
          cachedAt: new Date().toISOString(),
        })
      }

      const files = readdirSync(CACHE_DIR)
      for (const file of files) {
        if (!file.endsWith('.json')) continue

        const cachePath = resolve(CACHE_DIR, file)
        try {
          const data = JSON.parse(readFileSync(cachePath, 'utf-8')) as NewsCacheEntry
          if (data.articles && Array.isArray(data.articles)) {
            allNews.push(...data.articles)
          }
          if (data.lastUpdated) {
            latestTimestamps.push(data.lastUpdated)
          }
        } catch (e: any) {
          console.warn(`[intelligence-routes] Failed to read ${file}:`, e.message)
        }
      }
    } catch (e: any) {
      console.warn('[intelligence-routes] Failed to scan news cache:', e.message)
    }

    // Deduplicate by headline + sourceUrl
    const seen = new Map<string, NewsItem>()
    for (const item of allNews) {
      const key = `${item.headline}|${item.sourceUrl}`
      if (!seen.has(key)) {
        seen.set(key, item)
      }
    }

    // Sort by publishedDate desc, take top 3
    const deduped = [...seen.values()]
    deduped.sort((a, b) => {
      const aDate = new Date(a.publishedDate).getTime()
      const bDate = new Date(b.publishedDate).getTime()
      return bDate - aDate
    })
    const topNews = deduped.slice(0, 3)

    // Determine cachedAt: most recent timestamp from all caches
    const cachedAt = latestTimestamps.length > 0
      ? latestTimestamps.reduce((latest, ts) => (ts > latest ? ts : latest))
      : new Date().toISOString()

    // Releases: stub for now (requires #197 product-lifecycle cache)
    const releases: any[] = []

    // Events: stub for now (no events data source yet)
    const events: any[] = []

    return c.json({
      news: topNews,
      releases,
      events,
      cachedAt,
    })
  })

  return app
}
