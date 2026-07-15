/**
 * News Radar API Routes
 *
 * Five endpoints:
 * - GET /api/customer/:name/news — read from cache
 * - POST /api/customer/:name/news/refresh — search + cache + return
 * - GET /api/news/highlights — high-score articles across all customers
 * - GET /api/admin/news-config — return current configuration
 * - POST /api/admin/news-config — update configuration
 */

import { Hono } from 'hono'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { newsProvider } from './news-provider.ts'
import { toSlug } from './cache-layer.ts'
import type { NewsItem } from './news-provider.ts'
import { loadNewsConfig, updateNewsConfig } from './news-config.ts'
import { customers } from './server-state.ts'

// ── Cache directory ──────────────────────────────────────────────────────────

const CACHE_DIR = resolve(process.env.CACHE_DIR ?? 'data/cache', 'news')

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true })
}

// ── Cache helpers ────────────────────────────────────────────────────────────

interface NewsCacheEntry {
  articles: NewsItem[]
  lastUpdated: string
}

function getCachePath(customerName: string): string {
  const slug = toSlug(customerName)
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
    console.warn(`[news-routes] Failed to read cache for ${customerName}:`, e.message)
    return null
  }
}

function writeCache(customerName: string, articles: NewsItem[]): void {
  const cachePath = getCachePath(customerName)
  const entry: NewsCacheEntry = {
    articles,
    lastUpdated: new Date().toISOString(),
  }

  try {
    writeFileSync(cachePath, JSON.stringify(entry, null, 2), { mode: 0o600 })
  } catch (e: any) {
    console.error(`[news-routes] Failed to write cache for ${customerName}:`, e.message)
    throw e
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

export function createNewsRouter(): Hono {
  const app = new Hono()

  /**
   * GET /api/customer/:name/news
   * Read news from cache
   */
  app.get('/api/customer/:name/news', (c) => {
    const customerName = c.req.param('name')
    const cached = readCache(customerName)

    if (!cached) {
      return c.json({ articles: [], lastUpdated: null })
    }

    return c.json(cached)
  })

  /**
   * POST /api/customer/:name/news/refresh
   * Search for news, write to cache, return results
   */
  app.post('/api/customer/:name/news/refresh', async (c) => {
    const customerName = c.req.param('name')

    try {
      console.log(`[news-routes] Refreshing news for ${customerName}`)
      const customer = customers.find(c => c.name.toLowerCase() === customerName.toLowerCase())
      const articles = await newsProvider.searchNews(customerName, customer?.domain)

      writeCache(customerName, articles)

      return c.json({
        articles,
        lastUpdated: new Date().toISOString(),
      })
    } catch (e: any) {
      console.error(`[news-routes] News refresh failed for ${customerName}:`, e.message)
      return c.json({ error: e.message }, 500)
    }
  })

  /**
   * GET /api/news/highlights
   * Return high-significance articles (score >= 7) across all customers
   */
  app.get('/api/news/highlights', (c) => {
    try {
      if (!existsSync(CACHE_DIR)) {
        return c.json({ highlights: [] })
      }

      const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'))

      // Collect all critical articles with canonical customer names (#984 AC-2)
      const articlesByCustomer = new Map<string, Array<NewsItem & { customerName: string }>>()

      for (const file of files) {
        const cachePath = resolve(CACHE_DIR, file)
        try {
          const data: NewsCacheEntry = JSON.parse(readFileSync(cachePath, 'utf-8'))
          const slug = file.replace(/\.json$/, '')

          // Canonical customer name lookup — includes match for abbreviated slugs
          const matchedCustomer = customers.find(cu => {
            const cs = toSlug(cu.name)
            return cs === slug || cs.includes(slug) || slug.includes(cs)
          })
          const canonicalName = matchedCustomer?.name ?? slug.replace(/-/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
          const canonicalKey = canonicalName.toLowerCase()

          const criticalArticles = data.articles.filter(a => a.significanceScore >= 7)

          const existing = articlesByCustomer.get(canonicalKey) ?? []
          for (const article of criticalArticles) {
            existing.push({ ...article, customerName: canonicalName })
          }
          articlesByCustomer.set(canonicalKey, existing)
        } catch (e: any) {
          console.warn(`[news-routes] Failed to read cache file ${file}:`, e.message)
        }
      }

      // Top 2 per canonical customer, then global sort
      const highlights: Array<NewsItem & { customerName: string }> = []
      for (const articles of articlesByCustomer.values()) {
        articles.sort((a, b) => b.significanceScore - a.significanceScore)
        highlights.push(...articles.slice(0, 2))
      }

      highlights.sort((a, b) => b.significanceScore - a.significanceScore)

      return c.json({ highlights })
    } catch (e: any) {
      console.error('[news-routes] Failed to read highlights:', e.message)
      return c.json({ error: e.message }, 500)
    }
  })

  /**
   * GET /api/admin/news-config
   * Return current news search and scoring configuration
   */
  app.get('/api/admin/news-config', (c) => {
    try {
      const config = loadNewsConfig()
      return c.json(config)
    } catch (e: any) {
      console.error('[news-routes] Failed to load config:', e.message)
      return c.json({ error: e.message }, 500)
    }
  })

  /**
   * POST /api/admin/news-config
   * Update news search and scoring configuration
   *
   * Accepts partial config updates. Validates before writing.
   */
  app.post('/api/admin/news-config', async (c) => {
    try {
      const body = await c.req.json()

      // Update config
      const result = updateNewsConfig(body)

      if (!result.success) {
        return c.json({ error: result.error }, 400)
      }

      // Return updated config
      const config = loadNewsConfig()
      return c.json(config)
    } catch (e: any) {
      console.error('[news-routes] Failed to update config:', e.message)
      return c.json({ error: e.message }, 500)
    }
  })

  return app
}
