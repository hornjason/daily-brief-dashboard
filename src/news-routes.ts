/**
 * News Radar API Routes
 *
 * Three endpoints:
 * - GET /api/customer/:name/news — read from cache
 * - POST /api/customer/:name/news/refresh — search + cache + return
 * - GET /api/news/highlights — high-score articles across all customers
 */

import { Hono } from 'hono'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { newsProvider } from './news-provider.ts'
import { toSlug } from './cache-layer.ts'
import type { NewsItem } from './news-provider.ts'
import { FeatureModuleRegistry } from './feature-module-registry.ts'

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
      const articles = await newsProvider.searchNews(customerName)

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
    const highlights: Array<NewsItem & { customerName: string }> = []

    try {
      // Read all cache files
      if (!existsSync(CACHE_DIR)) {
        return c.json({ highlights: [] })
      }

      const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'))

      for (const file of files) {
        const cachePath = resolve(CACHE_DIR, file)
        try {
          const data: NewsCacheEntry = JSON.parse(readFileSync(cachePath, 'utf-8'))

          // Extract customer name from filename (remove .json extension)
          const slug = file.replace(/\.json$/, '')

          // Filter for Critical significance only (score >= 7)
          const criticalArticles = data.articles.filter(a => a.significanceScore >= 7)

          // Sort by significance score descending
          criticalArticles.sort((a, b) => b.significanceScore - a.significanceScore)

          // Take top 2 highest-scored articles per customer (GitHub Issue #217)
          const top2 = criticalArticles.slice(0, 2)

          for (const article of top2) {
            highlights.push({
              ...article,
              customerName: slug,  // Use slug for now; could map back to display name if needed
            })
          }
        } catch (e: any) {
          console.warn(`[news-routes] Failed to read cache file ${file}:`, e.message)
          // Continue processing other files
        }
      }

      // Sort by significance score descending (global sort across all customers)
      highlights.sort((a, b) => b.significanceScore - a.significanceScore)

      return c.json({ highlights })
    } catch (e: any) {
      console.error('[news-routes] Failed to read highlights:', e.message)
      return c.json({ error: e.message }, 500)
    }
  })

  /**
   * POST /api/refresh/news
   * Refresh news for all customers (GitHub Issue #309)
   */
  app.post('/api/refresh/news', async (c) => {
    const { customers } = await import('./server-state.ts')
    let success = 0, failed = 0
    for (const customer of customers) {
      try {
        await newsProvider.searchNews(customer.name)
        success++
      } catch { failed++ }
    }
    FeatureModuleRegistry.recordOutcome('news', {
      success: failed === 0,
      recordCount: success,
      error: failed > 0 ? `${failed} customers failed` : undefined,
    })
    return c.json({ ok: true, refreshed: success, failed })
  })

  return app
}
