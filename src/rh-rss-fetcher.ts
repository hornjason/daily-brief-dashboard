/**
 * Red Hat RSS Feed Fetcher
 * GitHub Issue #174 — RSS feed module for Red Hat Pulse card
 *
 * Fetches and parses Red Hat blog and press release RSS feeds.
 * Tags items with product keywords for filtering.
 */

import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = resolve(process.env.CACHE_DIR ?? 'data/cache', 'rss')
const CACHE_PATH = resolve(CACHE_DIR, 'rh-feeds.json')

// ── Types ────────────────────────────────────────────────────────────────────

export interface RSSItem {
  title: string
  link: string
  description: string
  pubDate: string
  source: 'blog' | 'press-release' | 'developer-blog'
  productTags: string[]
}

export interface RSSCache {
  items: RSSItem[]
  fetchedAt: string
}

// ── RSS Feed URLs ────────────────────────────────────────────────────────────

const RSS_FEEDS = [
  { url: 'https://www.redhat.com/en/rss/blog', source: 'blog' as const },
  { url: 'https://www.redhat.com/en/rss/press-releases', source: 'press-release' as const },
  { url: 'https://developers.redhat.com/blog/feed', source: 'developer-blog' as const },
]

// ── Product Keyword Mapping ──────────────────────────────────────────────────

const PRODUCT_KEYWORDS: Record<string, string[]> = {
  AAP: ['ansible', 'aap', 'automation platform'],
  OCP: ['openshift', 'ocp', 'kubernetes'],
  RHEL: ['rhel', 'enterprise linux'],
  RHOAI: ['openshift ai', 'rhoai', 'instructlab'],
}

/**
 * Tag item with product keywords by scanning title + description
 */
function tagWithProducts(title: string, description: string): string[] {
  const text = `${title} ${description}`.toLowerCase()
  const tags: string[] = []

  for (const [tag, keywords] of Object.entries(PRODUCT_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) {
      tags.push(tag)
    }
  }

  return tags.length > 0 ? tags : ['General']
}

// ── XML Parsing ──────────────────────────────────────────────────────────────

/**
 * Parse RSS 2.0 XML into structured items.
 * Uses simple regex extraction — RSS 2.0 is predictable enough for this.
 */
function parseRSSXML(xml: string, source: 'blog' | 'press-release' | 'developer-blog'): RSSItem[] {
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

    const productTags = tagWithProducts(title, description)

    items.push({
      title: title.trim(),
      link: link.trim(),
      description: description.trim(),
      pubDate: pubDate.trim(),
      source,
      productTags,
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

  for (const feed of RSS_FEEDS) {
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
      const items = parseRSSXML(xml, feed.source)
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

  // Write cache
  const cache: RSSCache = {
    items: merged,
    fetchedAt: new Date().toISOString(),
  }

  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), { mode: 0o600 })
  console.log(`[rh-rss] wrote cache: ${merged.length} total items (${allItems.length} new, ${existingItems.length} existing)`)
}
