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
 * - GET /api/admin/rss-feeds — List RSS feed config
 * - POST /api/admin/rss-feeds — Add new RSS feed
 * - DELETE /api/admin/rss-feeds — Remove RSS feed
 * - PATCH /api/admin/rss-feeds — Toggle feed enabled/disabled
 * - POST /api/admin/rss-feeds/refresh — Trigger immediate RSS fetch
 */

import { Hono } from 'hono'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { toSlug } from './cache-layer.ts'
import type { NewsItem } from './news-provider.ts'
import type { ProductLifecycle } from './product-lifecycle.ts'
import type { RHEvent } from './rh-events-fetcher.ts'
import { enrichEvents } from './event-enricher.ts'
import { loadFeedConfig, fetchRedHatRSS, type RSSFeedConfig, type RSSItem } from './rh-rss-fetcher.ts'
import { CACHE_DIR as BASE_CACHE_DIR, DATA_CONFIG_DIR } from './lib/paths.ts'

// ── Cache directory ──────────────────────────────────────────────────────────

const CACHE_DIR = resolve(BASE_CACHE_DIR, 'news')
const MAIN_CACHE_DIR = BASE_CACHE_DIR
const INTEL_CACHE_DIR = resolve(MAIN_CACHE_DIR, 'intelligence')
const CONFIG_DIR = DATA_CONFIG_DIR

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
    const customersPath = resolve(process.env.CONFIG_DIR ?? 'data/config', 'customers.json')
    const aesPath = resolve(process.env.CONFIG_DIR ?? 'data/config', 'aes.json')

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
   * GET /api/rss/feeds
   * All RSS feed items (for Red Hat News page)
   * GitHub Issue #220 (Fix 5)
   */
  app.get('/api/rss/feeds', (c) => {
    const RSS_CACHE_PATH = resolve(MAIN_CACHE_DIR, 'rss', 'rh-feeds.json')

    if (!existsSync(RSS_CACHE_PATH)) {
      return c.json({ items: [], fetchedAt: new Date().toISOString() })
    }

    try {
      const rssData = JSON.parse(readFileSync(RSS_CACHE_PATH, 'utf-8'))
      return c.json(rssData)
    } catch (e: any) {
      console.warn('[intelligence-routes] Failed to read RSS cache:', e.message)
      return c.json({ items: [], fetchedAt: new Date().toISOString() })
    }
  })

  /**
   * GET /api/events/enriched
   * Enriched events with Gemini-synthesized descriptions + customer relevance
   * GitHub Issue #250
   *
   * Lazy enrichment: scrapes registration pages and calls Gemini on first request,
   * then caches results. Rate-limited to 5 page scrapes per request.
   */
  app.get('/api/events/enriched', async (c) => {
    try {
      const enriched = await enrichEvents()
      return c.json({ events: enriched, fetchedAt: new Date().toISOString() })
    } catch (e: any) {
      console.warn('[intelligence-routes] Event enrichment failed, falling back:', e.message)
      // Fall back to non-enriched events
      const eventsPath = resolve(MAIN_CACHE_DIR, 'events', 'rh-events.json')
      if (!existsSync(eventsPath)) {
        return c.json({ events: [], fetchedAt: null })
      }
      try {
        const eventsData = JSON.parse(readFileSync(eventsPath, 'utf-8'))
        return c.json({ events: eventsData.events ?? [], fetchedAt: eventsData.fetchedAt })
      } catch {
        return c.json({ events: [], fetchedAt: null })
      }
    }
  })

  /**
   * GET /api/events
   * All upcoming Red Hat events (next 90 days), not sliced — for the Events module page
   * GitHub Issue #247
   */
  app.get('/api/events', (c) => {
    const eventsPath = resolve(MAIN_CACHE_DIR, 'events', 'rh-events.json')

    if (!existsSync(eventsPath)) {
      return c.json({ events: [], fetchedAt: null })
    }

    try {
      const eventsData = JSON.parse(readFileSync(eventsPath, 'utf-8'))
      if (!eventsData.events || !Array.isArray(eventsData.events)) {
        return c.json({ events: [], fetchedAt: eventsData.fetchedAt ?? null })
      }

      const now = Date.now()
      const upcoming = eventsData.events
        .filter((e: any) => {
          try {
            const eventDate = new Date(e.date).getTime()
            const daysUntil = (eventDate - now) / (1000 * 60 * 60 * 24)
            return daysUntil >= -1 && daysUntil <= 90
          } catch {
            return false
          }
        })
        .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime())

      // Deduplicate by name + date
      const seen = new Set<string>()
      const events = upcoming
        .filter((e: any) => {
          const key = `${e.name}|${e.date}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .map((e: any) => ({
          name: e.name,
          date: e.date,
          format: e.format,
          location: e.location,
          region: e.region,
          productTags: e.productTags,
          registrationUrl: e.registrationUrl,
          description: e.description ?? '',
          summary: e.summary ?? '',
        }))

      return c.json({ events, fetchedAt: eventsData.fetchedAt })
    } catch (e: any) {
      console.warn('[intelligence-routes] Failed to read events cache:', e.message)
      return c.json({ events: [], fetchedAt: null })
    }
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
          // Sort by pubDate desc, take top 5
          const sorted = [...rssData.items].sort((a, b) => {
            const aDate = new Date(a.pubDate).getTime()
            const bDate = new Date(b.pubDate).getTime()
            return bDate - aDate
          })
          news = sorted.slice(0, 5).map((item: any) => ({
            headline: item.title,
            sourceUrl: item.link,
            publishedDate: item.pubDate,
            summary: item.description,
            sourceName: item.source === 'blog' ? 'Red Hat Blog' : item.source === 'developer-blog' ? 'Red Hat Developer Blog' : 'Red Hat Press Release',
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

    // Read product releases — prefer release radar (scrapes Red Hat docs) over lifecycle (endoflife.date)
    // Release radar is authoritative for current version; lifecycle provides GA/EOL dates
    const lifecyclePath = resolve(MAIN_CACHE_DIR, 'product-lifecycle.json')
    let releases: any[] = []

    // First, read release radar summaries for authoritative version info
    const PRODUCT_INTEL_CACHE = resolve(MAIN_CACHE_DIR, 'product-intel')
    const radarVersions = new Map<string, string>()
    for (const slug of ['ocp', 'rhel', 'aap', 'ocp-virt', 'rhoai', 'rhel-ai', 'rh-ai-inference']) {
      const summaryPath = resolve(PRODUCT_INTEL_CACHE, `${slug}-summary.json`)
      if (existsSync(summaryPath)) {
        try {
          const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'))
          if (summary.currentVersion) {
            radarVersions.set(slug, summary.currentVersion)
          }
        } catch { /* skip */ }
      }
    }

    if (existsSync(lifecyclePath)) {
      try {
        const lifecycleData = JSON.parse(readFileSync(lifecyclePath, 'utf-8'))
        if (lifecycleData.products && Array.isArray(lifecycleData.products)) {
          // Show current releases — radar is authoritative, lifecycle fills gaps
          // When radar has a major-only version (e.g., "10"), prefer lifecycle's more specific version (e.g., "10.1")
          releases = lifecycleData.products
            .filter((p: any) => p.currentVersion)
            .map((p: any) => {
              const radarVersion = radarVersions.get(p.slug)
              const radarIsMajorOnly = radarVersion && !radarVersion.includes('.')
              const bestVersion = radarIsMajorOnly ? p.currentVersion : (radarVersion ?? p.currentVersion)
              return {
                product: p.displayName,
                slug: p.slug,
                version: bestVersion,
                latestPatch: p.latestPatch,
                gaDate: p.gaDate,
                eolDate: p.eolDate,
                nextVersion: p.nextVersion ?? null,
                nextExpected: p.nextExpected ?? null,
              }
            })
        }
      } catch (e: any) {
        console.warn('[intelligence-routes] Failed to read product lifecycle cache:', e.message)
      }
    }

    // Read events data (next 90 days, sorted by date)
    const eventsPath = resolve(MAIN_CACHE_DIR, 'events', 'rh-events.json')
    let events: any[] = []

    // Load enrichment cache for descriptions (Issue #250)
    const enrichmentPath = resolve(MAIN_CACHE_DIR, 'events', 'rh-events-enriched.json')
    let enrichmentCache: Record<string, { enrichedDescription: string | null }> = {}
    if (existsSync(enrichmentPath)) {
      try {
        const enrichmentData = JSON.parse(readFileSync(enrichmentPath, 'utf-8'))
        enrichmentCache = enrichmentData.enrichments ?? {}
      } catch { /* ignore */ }
    }

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

          // Deduplicate events by name + date
          const seen = new Set<string>()
          const deduplicated = upcoming.filter((e: any) => {
            const key = `${e.name}|${e.date}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })

          events = deduplicated.map((e: any) => {
            const cacheKey = `${e.name}:${e.date}`
            const enrichment = enrichmentCache[cacheKey]
            return {
              name: e.name,
              date: e.date,
              format: e.format,
              location: e.location,
              region: e.region,
              productTags: e.productTags,
              registrationUrl: e.registrationUrl,
              description: e.description ?? '',
              summary: e.summary ?? '',
              enrichedDescription: enrichment?.enrichedDescription ?? null,
            }
          })
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

  /**
   * GET /api/admin/rss-feeds
   * List all configured RSS feeds
   */
  app.get('/api/admin/rss-feeds', (c) => {
    const configPath = resolve(CONFIG_DIR, 'rss-feeds.json')
    if (!existsSync(configPath)) {
      return c.json({ feeds: [] })
    }

    try {
      const feeds = JSON.parse(readFileSync(configPath, 'utf-8'))
      return c.json({ feeds })
    } catch (e: any) {
      console.warn('[intelligence-routes] Failed to read RSS feed config:', e?.message ?? e)
      return c.json({ feeds: [] })
    }
  })

  /**
   * POST /api/admin/rss-feeds
   * Add a new RSS feed to config
   */
  app.post('/api/admin/rss-feeds', async (c) => {
    const body = await c.req.json<{
      url: string
      label: string
      category?: string
      productTags?: string[]
    }>()

    if (!body.url || !body.label) {
      return c.json({ error: 'url and label are required' }, 400)
    }

    const configPath = resolve(CONFIG_DIR, 'rss-feeds.json')
    let feeds: RSSFeedConfig[] = []

    if (existsSync(configPath)) {
      try {
        feeds = JSON.parse(readFileSync(configPath, 'utf-8'))
      } catch (e: any) {
        console.warn('[intelligence-routes] Failed to read existing config:', e?.message ?? e)
      }
    }

    // Check for duplicate URL
    if (feeds.some(f => f.url === body.url)) {
      return c.json({ error: 'Feed URL already exists' }, 409)
    }

    // Derive source from URL pattern
    const source = body.url.includes('security') ? 'security-advisory'
      : body.url.includes('status') ? 'status'
      : body.url.includes('press') ? 'press-release'
      : body.url.includes('developer') ? 'developer-blog'
      : 'blog'

    const newFeed: RSSFeedConfig = {
      url: body.url,
      source,
      category: body.category ?? 'Custom',
      label: body.label,
      productTags: body.productTags ?? [],
      enabled: true,
    }

    feeds.push(newFeed)
    writeFileSync(configPath, JSON.stringify(feeds, null, 2))

    console.log(`[intelligence-routes] Added RSS feed: ${body.label} (${body.url})`)
    return c.json({ feed: newFeed, total: feeds.length })
  })

  /**
   * DELETE /api/admin/rss-feeds
   * Remove an RSS feed from config
   */
  app.delete('/api/admin/rss-feeds', async (c) => {
    const body = await c.req.json<{ url: string }>()

    if (!body.url) {
      return c.json({ error: 'url is required' }, 400)
    }

    const configPath = resolve(CONFIG_DIR, 'rss-feeds.json')
    if (!existsSync(configPath)) {
      return c.json({ error: 'No feeds configured' }, 404)
    }

    let feeds: RSSFeedConfig[] = []
    try {
      feeds = JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch (e: any) {
      return c.json({ error: 'Failed to read config' }, 500)
    }

    const before = feeds.length
    feeds = feeds.filter(f => f.url !== body.url)

    if (feeds.length === before) {
      return c.json({ error: 'Feed not found' }, 404)
    }

    writeFileSync(configPath, JSON.stringify(feeds, null, 2))
    console.log(`[intelligence-routes] Removed RSS feed: ${body.url}`)
    return c.json({ removed: body.url, remaining: feeds.length })
  })

  /**
   * PATCH /api/admin/rss-feeds
   * Update RSS feed configuration (enabled, label, category, productTags, url)
   */
  app.patch('/api/admin/rss-feeds', async (c) => {
    const body = await c.req.json<{
      url: string
      enabled?: boolean
      label?: string
      category?: string
      productTags?: string[]
      newUrl?: string
    }>()

    if (!body.url) {
      return c.json({ error: 'url is required' }, 400)
    }

    const configPath = resolve(CONFIG_DIR, 'rss-feeds.json')
    if (!existsSync(configPath)) {
      return c.json({ error: 'No feeds configured' }, 404)
    }

    let feeds: RSSFeedConfig[] = []
    try {
      feeds = JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch (e: any) {
      return c.json({ error: 'Failed to read config' }, 500)
    }

    const feed = feeds.find(f => f.url === body.url)
    if (!feed) {
      return c.json({ error: 'Feed not found' }, 404)
    }

    // Update fields if provided
    if (body.enabled !== undefined) feed.enabled = body.enabled
    if (body.label !== undefined) feed.label = body.label
    if (body.category !== undefined) feed.category = body.category
    if (body.productTags !== undefined) feed.productTags = body.productTags
    if (body.newUrl !== undefined) feed.url = body.newUrl

    writeFileSync(configPath, JSON.stringify(feeds, null, 2))

    console.log(`[intelligence-routes] Updated RSS feed: ${body.url}`)
    return c.json({ feed })
  })

  /**
   * POST /api/admin/rss-feeds/refresh
   * Trigger immediate RSS feed fetch
   */
  app.post('/api/admin/rss-feeds/refresh', async (c) => {
    try {
      console.log('[intelligence-routes] Triggering manual RSS refresh')
      await fetchRedHatRSS()
      return c.json({ status: 'complete' })
    } catch (e: any) {
      console.warn('[intelligence-routes] RSS refresh failed:', e?.message ?? e)
      return c.json({ error: e?.message ?? 'RSS refresh failed' }, 500)
    }
  })

  /**
   * GET /api/admin/rss-feeds/preview
   * Fetch and display raw RSS feed content for testing
   */
  app.get('/api/admin/rss-feeds/preview', async (c) => {
    const url = c.req.query('url')
    if (!url) {
      return c.json({ error: 'url query parameter required' }, 400)
    }

    try {
      const res = await fetch(decodeURIComponent(url), {
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        return c.html(`<html><head><title>RSS Feed Preview Error</title><style>body { background: #1a1a2e; color: #e0e0e0; font-family: monospace; padding: 20px; }</style></head><body><h1>Error fetching feed</h1><p>HTTP ${res.status}</p></body></html>`)
      }
      const text = await res.text()
      const escaped = text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
      return c.html(`<html><head><title>RSS Feed Preview</title><style>body { background: #1a1a2e; color: #e0e0e0; font-family: monospace; padding: 20px; white-space: pre-wrap; word-wrap: break-word; }</style></head><body>${escaped}</body></html>`)
    } catch (e: any) {
      return c.html(`<html><head><title>RSS Feed Preview Error</title><style>body { background: #1a1a2e; color: #e0e0e0; font-family: monospace; padding: 20px; }</style></head><body><h1>Error fetching feed</h1><p>${e?.message ?? 'Unknown error'}</p></body></html>`)
    }
  })

  /**
   * GET /api/admin/rss-feeds/stats
   * Return per-feed article counts and latest article dates from cache
   */
  app.get('/api/admin/rss-feeds/stats', (c) => {
    const cachePath = resolve(BASE_CACHE_DIR, 'rss', 'rh-feeds.json')

    if (!existsSync(cachePath)) {
      return c.json({ stats: {} })
    }

    try {
      const cache = JSON.parse(readFileSync(cachePath, 'utf-8')) as { items: RSSItem[] }
      const stats: Record<string, { articleCount: number; lastArticleDate: string | null }> = {}

      // Group items by source
      for (const item of cache.items) {
        if (!stats[item.source]) {
          stats[item.source] = { articleCount: 0, lastArticleDate: null }
        }
        stats[item.source].articleCount++

        // Track latest pubDate
        if (item.pubDate) {
          const currentLatest = stats[item.source].lastArticleDate
          if (!currentLatest || new Date(item.pubDate) > new Date(currentLatest)) {
            stats[item.source].lastArticleDate = item.pubDate
          }
        }
      }

      return c.json({ stats })
    } catch (e: any) {
      console.warn('[intelligence-routes] Failed to read RSS cache for stats:', e?.message ?? e)
      return c.json({ stats: {} })
    }
  })

  return app
}
