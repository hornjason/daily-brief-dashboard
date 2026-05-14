/**
 * Intelligence API Routes
 * GitHub Issue #200 — Intelligence tab shell + Red Hat News section
 *
 * Provides Red Hat intelligence surfaces:
 * - GET /api/customer/:name/intelligence/news — Red Hat news matched to customer products
 *
 * Future endpoints (out of scope for #200):
 * - GET /api/customer/:name/intelligence/roadmap — Product lifecycle data
 * - GET /api/customer/:name/intelligence/events — Events near customer HQ
 */

import { Hono } from 'hono'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { toSlug } from './cache-layer.ts'
import type { NewsItem } from './news-provider.ts'

// ── Cache directory ──────────────────────────────────────────────────────────

const CACHE_DIR = resolve(process.env.DATA_DIR ?? 'data', 'cache', 'news')

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
