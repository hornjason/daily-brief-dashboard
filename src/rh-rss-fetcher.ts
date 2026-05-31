/**
 * Red Hat RSS Feed Fetcher
 * GitHub Issue #174 — RSS feed module for Red Hat Pulse card
 *
 * Fetches and parses Red Hat blog and press release RSS feeds.
 * Tags items with product keywords for filtering.
 */

import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { CACHE_DIR as BASE_CACHE_DIR, DATA_CONFIG_DIR } from './lib/paths.ts'

const CACHE_DIR = resolve(BASE_CACHE_DIR, 'rss')
const CACHE_PATH = resolve(CACHE_DIR, 'rh-feeds.json')

// ── Types ────────────────────────────────────────────────────────────────────

export interface RSSItem {
  title: string
  link: string
  description: string
  pubDate: string
  source: string
  productTags: string[]
  /** Feed category from config (Corporate, Developer, Research, Security, Product) — GitHub Issue #408 */
  category?: string
}

export interface RSSCache {
  items: RSSItem[]
  fetchedAt: string
}

export interface RSSFeedConfig {
  url: string
  source: string
  category: string
  label: string
  productTags: string[]
  enabled: boolean
}

// ── Config Loading ───────────────────────────────────────────────────────────

export function loadFeedConfig(): RSSFeedConfig[] {
  const configPath = resolve(DATA_CONFIG_DIR, 'rss-feeds.json')

  if (!existsSync(configPath)) {
    // Fallback to original hardcoded feeds
    return [
      {
        url: 'https://www.redhat.com/en/rss/blog',
        source: 'blog',
        category: 'Corporate',
        label: 'Global Red Hat Blog',
        productTags: [],
        enabled: true
      },
      {
        url: 'https://www.redhat.com/en/rss/press-releases',
        source: 'press-release',
        category: 'Corporate',
        label: 'Press Releases',
        productTags: [],
        enabled: true
      },
      {
        url: 'https://developers.redhat.com/blog/feed',
        source: 'developer-blog',
        category: 'Developer',
        label: 'Developer Blog',
        productTags: [],
        enabled: true
      },
    ]
  }

  try {
    const configs = JSON.parse(readFileSync(configPath, 'utf-8')) as RSSFeedConfig[]
    return configs.filter(f => f.enabled)
  } catch (e: any) {
    console.warn(`[rh-rss] Failed to load feed config:`, e?.message ?? e)
    return []
  }
}

// ── Product Keyword Mapping ──────────────────────────────────────────────────

const PRODUCT_KEYWORDS: Record<string, string[]> = {
  AAP: ['ansible', 'aap', 'automation platform'],
  OCP: ['openshift', 'ocp', 'kubernetes'],
  RHEL: ['rhel', 'enterprise linux'],
  RHOAI: ['openshift ai', 'rhoai', 'instructlab'],
}

/**
 * Tag item with product keywords by scanning title + description.
 * Auto-detected tags from keyword matching.
 */
function detectProductTags(text: string): string[] {
  const normalized = text.toLowerCase()
  const tags: string[] = []

  for (const [tag, keywords] of Object.entries(PRODUCT_KEYWORDS)) {
    if (keywords.some(kw => normalized.includes(kw))) {
      tags.push(tag)
    }
  }

  return tags.length > 0 ? tags : ['General']
}

// ── XML Parsing ──────────────────────────────────────────────────────────────

/**
 * Parse RSS 2.0 XML into structured items.
 * Uses simple regex extraction — RSS 2.0 is predictable enough for this.
 *
 * @param xml RSS feed XML content
 * @param source Feed source identifier (e.g., 'blog', 'security-advisory')
 * @param configTags Optional product tags from feed config to merge with auto-detected tags
 * @param category Feed category from config (GitHub Issue #408)
 */
function parseRSSXML(xml: string, source: string, configTags?: string[], category?: string): RSSItem[] {
  const items: RSSItem[] = []

  // Extract all <item>...</item> blocks
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g)

  for (const match of itemMatches) {
    const itemXml = match[1]

    // Extract fields with regex
    const title = itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/)?.[1] ?? itemXml.match(/<title>(.*?)<\/title>/)?.[1] ?? ''
    const link = itemXml.match(/<link>(.*?)<\/link>/)?.[1] ?? ''
    const description = itemXml.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/)?.[1] ?? itemXml.match(/<description>(.*?)<\/description>/)?.[1] ?? ''
    const pubDate = itemXml.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? ''

    if (!title || !link) continue  // Skip items without essential fields

    // Merge config tags with auto-detected tags
    const autoTags = detectProductTags(title + ' ' + description)
    const productTags = [...new Set([...(configTags ?? []), ...autoTags])]

    items.push({
      title: title.trim(),
      link: link.trim(),
      description: description.trim(),
      pubDate: pubDate.trim(),
      source,
      productTags,
      ...(category ? { category } : {}),
    })
  }

  return items
}

// ── Fetch RSS Feeds ──────────────────────────────────────────────────────────

/**
 * Fetch all RSS feeds and write to cache.
 * Each feed is try/caught individually so one failure doesn't block others.
 * #226: Accumulates history by merging with existing cache (deduplicated by link).
 */
export async function fetchRedHatRSS(): Promise<void> {
  // Ensure cache directory exists
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true })
  }

  const allItems: RSSItem[] = []
  const feeds = loadFeedConfig()

  console.log(`[rh-rss] loaded ${feeds.length} enabled feeds from config`)

  for (const feed of feeds) {
    try {
      console.log(`[rh-rss] fetching ${feed.source} from ${feed.url}`)
      const response = await fetch(feed.url, {
        signal: AbortSignal.timeout(15_000),
      })

      if (!response.ok) {
        console.warn(`[rh-rss] ${feed.source} fetch failed: HTTP ${response.status}`)
        continue
      }

      const xml = await response.text()
      const items = parseRSSXML(xml, feed.source, feed.productTags, feed.category)
      allItems.push(...items)

      console.log(`[rh-rss] ${feed.source}: parsed ${items.length} items`)
    } catch (e: any) {
      console.warn(`[rh-rss] ${feed.source} fetch error:`, e?.message ?? e)
      // Continue to next feed
    }
  }

  // #226: Read existing cache to accumulate history
  let existingItems: RSSItem[] = []
  if (existsSync(CACHE_PATH)) {
    try {
      const existing = JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as RSSCache
      existingItems = existing.items || []
    } catch (e: any) {
      console.warn(`[rh-rss] failed to read existing cache:`, e?.message ?? e)
    }
  }

  // Merge: new items + existing, deduplicate by link
  const seen = new Set<string>()
  const merged: RSSItem[] = []
  for (const item of [...allItems, ...existingItems]) {
    if (!seen.has(item.link)) {
      seen.add(item.link)
      merged.push(item)
    }
  }

  // Min-count guard (#464): if merged < 5 but existing cache had >= 5, skip write
  if (merged.length < 5 && existingItems.length >= 5) {
    console.warn(`[rh-rss] min-count guard: merged ${merged.length} items < 5 but cache has ${existingItems.length} — keeping existing`)
    return
  }

  // Write cache
  const cache: RSSCache = {
    items: merged,
    fetchedAt: new Date().toISOString(),
  }

  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), { mode: 0o600 })
  console.log(`[rh-rss] wrote cache: ${merged.length} total items (${allItems.length} new, ${existingItems.length} existing)`)
}
