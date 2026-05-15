/**
 * Intelligence API Routes
 * GitHub Issue #200 — Intelligence tab shell + Red Hat News section
 * GitHub Issue #201 — Product Roadmap section
 * GitHub Issue #202 — Events module
 *
 * Provides Red Hat intelligence surfaces:
 * - GET /api/customer/:name/intelligence/news — Red Hat news matched to customer products
 * - GET /api/customer/:name/intelligence/roadmap — Product lifecycle data (Issue #201)
 * - GET /api/customer/:name/intelligence/events — Red Hat events filtered by region (Issue #202)
 */

import { Hono } from 'hono'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { toSlug } from './cache-layer.ts'
import type { NewsItem } from './news-provider.ts'
import type { ProductLifecycle } from './product-lifecycle.ts'
import type { RHEvent } from './rh-events-fetcher.ts'

// ── Cache directory ──────────────────────────────────────────────────────────

const CACHE_DIR = resolve(process.env.CACHE_DIR ?? 'data/cache', 'news')
const MAIN_CACHE_DIR = resolve(process.env.CACHE_DIR ?? 'data/cache')
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
    const configPath = resolve(process.env.CONFIG_DIR ?? 'data/config', 'product-intel-config.json')
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

      // Product-release-radar is authoritative for versions (scrapes Red Hat docs directly)
      const summaryPath = resolve(PRODUCT_INTEL_CACHE, `${product.slug}-summary.json`)
      if (existsSync(summaryPath)) {
        try {
          const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'))
          if (summary.currentVersion) {
            enriched.currentVersion = summary.currentVersion
          }
          if (summary.latestPatch || summary.latest) {
            enriched.latestPatch = summary.latestPatch || summary.latest
          }
          if (summary.gaDate) {
            enriched.gaDate = summary.gaDate
          }
        } catch (e: any) {
          // Silently skip — not critical
        }
      }

      // Add docsUrl from product-intel config (already read above)
      if (registeredSlugs) {
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
   * GET /api/customer/:name/intelligence/events
   * Red Hat marketing events filtered by customer region
   * GitHub Issue #202
   */
  app.get('/api/customer/:name/intelligence/events', (c) => {
    const customerName = c.req.param('name')
    const slug = toSlug(customerName)
    if (!slug || /[^a-zA-Z0-9_-]/.test(slug)) {
      return c.json({ error: 'Invalid customer name' }, 400)
    }

    // Read events cache
    const eventsPath = resolve(MAIN_CACHE_DIR, 'events', 'rh-events.json')
    if (!existsSync(eventsPath)) {
      return c.json({ events: [], cachedAt: null })
    }

    let eventsData: { events: RHEvent[]; fetchedAt: string }
    try {
      eventsData = JSON.parse(readFileSync(eventsPath, 'utf-8'))
    } catch (e: any) {
      console.warn('[intelligence-routes] Failed to read events cache:', e?.message ?? e)
      return c.json({ events: [], cachedAt: null })
    }

    // Get customer's region from their AE's territory
    const customersPath = resolve(process.env.DATA_DIR ?? 'data', 'config', 'customers.json')
    const aesPath = resolve(process.env.DATA_DIR ?? 'data', 'config', 'aes.json')

    let customerRegion: string | null = null

    if (existsSync(customersPath) && existsSync(aesPath)) {
      try {
        const customers = JSON.parse(readFileSync(customersPath, 'utf-8'))
        const customer = customers.find((c: any) => c.slug === slug)

        if (customer && customer.ae) {
          const aes = JSON.parse(readFileSync(aesPath, 'utf-8'))
          const ae = aes.find((a: any) => a.name === customer.ae)

          if (ae && ae.tableauTerritories && ae.tableauTerritories.length > 0) {
            const territory = ae.tableauTerritories[0]
            const normalized = territory.toUpperCase()

            if (normalized.startsWith('WEST')) customerRegion = 'west'
            else if (normalized.startsWith('NORTHEAST') || normalized.startsWith('NE_')) customerRegion = 'northeast'
            else if (normalized.startsWith('SOUTHEAST') || normalized.startsWith('SE_')) customerRegion = 'southeast'
            else if (normalized.startsWith('CENTRAL')) customerRegion = 'central'
            else if (normalized.startsWith('CANADA') || normalized.startsWith('CAN_')) customerRegion = 'canada'
            else customerRegion = 'west'  // fallback
          }
        }
      } catch (e: any) {
        console.warn('[intelligence-routes] Failed to determine customer region:', e?.message ?? e)
      }
    }

    // Filter events: virtual (national) + events matching customer's region
    const now = Date.now()
    const upcomingEvents = eventsData.events.filter(event => {
      // Parse event date
      let eventDate: number
      try {
        eventDate = new Date(event.date).getTime()
      } catch {
        return false
      }

      // Only include upcoming events (within 90 days)
      const daysUntil = (eventDate - now) / (1000 * 60 * 60 * 24)
      if (daysUntil < 0 || daysUntil > 90) {
        return false
      }

      // Include if virtual or matches customer region
      return event.region === 'national' || (customerRegion && event.region === customerRegion)
    })

    // Sort by date ascending (soonest first)
    upcomingEvents.sort((a, b) => {
      const aDate = new Date(a.date).getTime()
      const bDate = new Date(b.date).getTime()
      return aDate - bDate
    })

    return c.json({
      events: upcomingEvents,
      cachedAt: eventsData.fetchedAt,
    })
  })

  /**
   * GET /api/intelligence/global
   * Aggregate Red Hat intelligence across all customers (for Red Hat Pulse card)
   * GitHub Issue #203, #174 (RSS integration), #202 (events)
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

    // Read events data (next 90 days, sorted by date)
    const eventsPath = resolve(MAIN_CACHE_DIR, 'events', 'rh-events.json')
    let events: any[] = []

    if (existsSync(eventsPath)) {
      try {
        const eventsData = JSON.parse(readFileSync(eventsPath, 'utf-8'))
        if (eventsData.events && Array.isArray(eventsData.events)) {
          const now = Date.now()
          const upcoming = eventsData.events
            .filter((e: any) => {
              try {
                const eventDate = new Date(e.date).getTime()
                const daysUntil = (eventDate - now) / (1000 * 60 * 60 * 24)
                return daysUntil >= 0 && daysUntil <= 90
              } catch {
                return false
              }
            })
            .sort((a: any, b: any) => {
              const aDate = new Date(a.date).getTime()
              const bDate = new Date(b.date).getTime()
              return aDate - bDate
            })
            .slice(0, 5)

          events = upcoming.map((e: any) => ({
            name: e.name,
            date: e.date,
            format: e.format,
            location: e.location,
            region: e.region,
            productTags: e.productTags,
            registrationUrl: e.registrationUrl,
          }))
        }
      } catch (e: any) {
        console.warn('[intelligence-routes] Failed to read events cache:', e.message)
      }
    }

    return c.json({
      news,
      releases,
      events,
      cachedAt,
    })
  })

  return app
}
