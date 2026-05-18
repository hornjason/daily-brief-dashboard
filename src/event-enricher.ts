/**
 * Event Enricher — GitHub Issue #250
 *
 * Enriches Red Hat marketing events with:
 * 1. Descriptions synthesized from registration page content (via Gemini)
 * 2. Customer relevance cross-referencing (product tags → subscriptions)
 *
 * Enrichment is lazy — triggered on first API request, cached aggressively.
 * Registration page scraping is rate-limited to 5 pages per run.
 */

import { existsSync, readFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { callGemini } from './gemini-call.ts'
import { readSheetCache } from './cache-layer.ts'
import type { RHEvent } from './rh-events-fetcher.ts'

// ── Constants ───────────────────────────────────────────────────────────────

const CACHE_DIR = resolve(process.env.CACHE_DIR ?? 'data/cache', 'events')
const ENRICHMENT_CACHE_PATH = resolve(CACHE_DIR, 'rh-events-enriched.json')
const EVENTS_CACHE_PATH = resolve(CACHE_DIR, 'rh-events.json')
const CONFIG_DIR = process.env.CONFIG_DIR ?? 'data/config'

export const MAX_SCRAPES_PER_RUN = 5

// ── Types ───────────────────────────────────────────────────────────────────

export interface EnrichedEvent extends RHEvent {
  enrichedDescription: string | null
  enrichedAt: string | null
  customerRelevance?: {
    matchingCustomers: string[]
    productMatches: Record<string, string[]>
  }
}

interface EnrichmentEntry {
  enrichedDescription: string | null
  enrichedAt: string | null
}

export interface EnrichmentCache {
  enrichments: Record<string, EnrichmentEntry>
}

// ── Product tag → subscription keyword mapping ──────────────────────────────

const PRODUCT_TAG_KEYWORDS: Record<string, string[]> = {
  OCP: ['openshift', 'ocp'],
  AAP: ['ansible', 'aap', 'automation platform'],
  RHEL: ['enterprise linux', 'rhel'],
  RHOAI: ['openshift ai', 'rhoai', 'instructlab'],
}

// ── HTML Stripping ──────────────────────────────────────────────────────────

/**
 * Strip HTML to meaningful text content.
 * Removes nav, footer, script, style elements and returns plain text.
 */
export function stripHtmlToText(html: string, maxChars = 2000): string {
  // Remove script, style, nav, footer, header elements
  let cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')

  // Strip remaining HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ')

  // Decode common HTML entities
  cleaned = cleaned
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))

  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim()

  return cleaned.slice(0, maxChars)
}

// ── Cache Helpers ───────────────────────────────────────────────────────────

/**
 * Build cache key from event name + date
 */
export function buildEnrichmentCacheKey(eventName: string, eventDate: string): string {
  return `event-enrich:${eventName}:${eventDate}`
}

/**
 * Read enrichment cache from disk
 */
export function readEnrichmentCache(path: string): EnrichmentCache | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Write enrichment cache to disk
 */
function writeEnrichmentCache(path: string, cache: EnrichmentCache): void {
  const dir = resolve(path, '..')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeJsonAtomic(path, cache)
}

// ── Customer Relevance ──────────────────────────────────────────────────────

/**
 * Cross-reference event product tags against customer subscriptions.
 * Returns which customers have subscriptions matching the event's products.
 */
export function matchCustomerRelevance(
  productTags: string[],
  customers: Array<{ name: string; slug: string }>,
  subscriptionsByCustomer: Record<string, Array<{ productDescription: string }>>
): { matchingCustomers: string[]; productMatches: Record<string, string[]> } {
  const matchingCustomers: string[] = []
  const productMatches: Record<string, string[]> = {}

  // Skip if only 'General' tag
  const realTags = productTags.filter(t => t !== 'General')
  if (realTags.length === 0) {
    return { matchingCustomers: [], productMatches: {} }
  }

  for (const customer of customers) {
    const subs = subscriptionsByCustomer[customer.name] ?? []
    if (subs.length === 0) continue

    let matched = false

    for (const tag of realTags) {
      const keywords = PRODUCT_TAG_KEYWORDS[tag]
      if (!keywords) continue

      const hasMatch = subs.some(sub => {
        const desc = sub.productDescription.toLowerCase()
        return keywords.some(kw => desc.includes(kw))
      })

      if (hasMatch) {
        matched = true
        if (!productMatches[tag]) productMatches[tag] = []
        if (!productMatches[tag].includes(customer.name)) {
          productMatches[tag].push(customer.name)
        }
      }
    }

    if (matched && !matchingCustomers.includes(customer.name)) {
      matchingCustomers.push(customer.name)
    }
  }

  return { matchingCustomers, productMatches }
}

// ── Load Customer Subscription Data ─────────────────────────────────────────

function loadCustomersAndSubscriptions(): {
  customers: Array<{ name: string; slug: string }>
  subscriptionsByCustomer: Record<string, Array<{ productDescription: string }>>
} {
  const customersPath = resolve(CONFIG_DIR, 'customers.json')
  if (!existsSync(customersPath)) {
    return { customers: [], subscriptionsByCustomer: {} }
  }

  let customersRaw: any[]
  try {
    const parsed = JSON.parse(readFileSync(customersPath, 'utf-8'))
    customersRaw = Array.isArray(parsed) ? parsed : (parsed.customers ?? [])
  } catch {
    return { customers: [], subscriptionsByCustomer: {} }
  }

  const customers = customersRaw.map((c: any) => ({
    name: c.name as string,
    slug: (c.slug ?? c.name.toLowerCase().replace(/\s+/g, '-')) as string,
  }))

  const subscriptionsByCustomer: Record<string, Array<{ productDescription: string }>> = {}

  for (const customer of customers) {
    const sheetCache = readSheetCache(customer.name)
    if (sheetCache?.rows) {
      subscriptionsByCustomer[customer.name] = sheetCache.rows.map(r => ({
        productDescription: r.productDescription ?? '',
      }))
    }
  }

  return { customers, subscriptionsByCustomer }
}

// ── Enrichment Pipeline ─────────────────────────────────────────────────────

/**
 * Enrich a single event by scraping its registration page and synthesizing
 * a description via Gemini.
 */
async function enrichSingleEvent(event: RHEvent): Promise<EnrichmentEntry> {
  const deltaKey = event.registrationUrl
    ? `event-enrich:${event.name}:${event.date}`
    : `event-enrich-generic:${event.name}:${event.date}`

  const systemPrompt = 'You are a Red Hat sales enablement expert. Given this event registration page content, write a 2-3 sentence description of what the event covers, who should attend, and what attendees will learn. Be concise and focus on business value for enterprise customers.'

  let userPrompt: string

  if (event.registrationUrl) {
    // Attempt to fetch registration page
    try {
      const res = await fetch(event.registrationUrl, {
        signal: AbortSignal.timeout(10_000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PAI-Dashboard/1.0)' },
      })

      if (!res.ok || !res.headers.get('content-type')?.includes('text/html')) {
        // Fall back to generic enrichment
        userPrompt = `Event: ${event.name}\nDate: ${event.date}\nFormat: ${event.format}\nProduct Tags: ${event.productTags.join(', ')}\n\nNo registration page content available. Write a brief 1-sentence description based on the event name and tags.`
      } else {
        const html = await res.text()
        const pageText = stripHtmlToText(html, 2000)
        userPrompt = `Event: ${event.name}\nDate: ${event.date}\nFormat: ${event.format}\nProduct Tags: ${event.productTags.join(', ')}\n\nRegistration page content:\n${pageText}`
      }
    } catch (e: any) {
      console.warn(`[event-enricher] Failed to fetch ${event.registrationUrl}: ${e.message}`)
      userPrompt = `Event: ${event.name}\nDate: ${event.date}\nFormat: ${event.format}\nProduct Tags: ${event.productTags.join(', ')}\n\nNo registration page content available. Write a brief 1-sentence description based on the event name and tags.`
    }
  } else {
    // No registration URL — generic enrichment
    userPrompt = `Event: ${event.name}\nDate: ${event.date}\nFormat: ${event.format}\nProduct Tags: ${event.productTags.join(', ')}\n\nNo registration page available. Write a brief 1-sentence description based on the event name and product tags.`
  }

  try {
    const result = await callGemini(systemPrompt, userPrompt, {
      callType: 'event-enrichment',
      model: 'lite',
      deltaKey,
    })

    return {
      enrichedDescription: result.text.trim(),
      enrichedAt: new Date().toISOString(),
    }
  } catch (e: any) {
    console.warn(`[event-enricher] Gemini call failed for ${event.name}: ${e.message}`)
    return {
      enrichedDescription: null,
      enrichedAt: null,
    }
  }
}

/**
 * Enrich all events from the cache. Rate-limited to MAX_SCRAPES_PER_RUN
 * registration page fetches per invocation. Enrichments are cached separately
 * from the raw events cache.
 *
 * Returns enriched events with descriptions + customer relevance.
 */
export async function enrichEvents(): Promise<EnrichedEvent[]> {
  // Read raw events cache
  if (!existsSync(EVENTS_CACHE_PATH)) {
    return []
  }

  let eventsData: { events: RHEvent[]; fetchedAt: string }
  try {
    eventsData = JSON.parse(readFileSync(EVENTS_CACHE_PATH, 'utf-8'))
  } catch {
    return []
  }

  if (!eventsData.events?.length) return []

  // Filter to upcoming events (next 90 days)
  const now = Date.now()
  const upcoming = eventsData.events.filter(e => {
    try {
      const eventDate = new Date(e.date).getTime()
      const daysUntil = (eventDate - now) / (1000 * 60 * 60 * 24)
      return daysUntil >= -1 && daysUntil <= 90
    } catch {
      return false
    }
  })

  // Load enrichment cache
  const enrichmentCache = readEnrichmentCache(ENRICHMENT_CACHE_PATH) ?? { enrichments: {} }

  // Identify events needing enrichment
  let scrapeCount = 0
  const enrichedEvents: EnrichedEvent[] = []

  // Load customer data for relevance matching
  const { customers, subscriptionsByCustomer } = loadCustomersAndSubscriptions()

  for (const event of upcoming) {
    const cacheKey = `${event.name}:${event.date}`

    // Check if already enriched
    const cached = enrichmentCache.enrichments[cacheKey]
    if (cached) {
      const relevance = matchCustomerRelevance(event.productTags, customers, subscriptionsByCustomer)
      enrichedEvents.push({
        ...event,
        enrichedDescription: cached.enrichedDescription,
        enrichedAt: cached.enrichedAt,
        customerRelevance: relevance.matchingCustomers.length > 0 ? relevance : undefined,
      })
      continue
    }

    // Rate limit scraping
    if (event.registrationUrl && scrapeCount >= MAX_SCRAPES_PER_RUN) {
      // Skip enrichment for now — will be picked up on next request
      enrichedEvents.push({
        ...event,
        enrichedDescription: null,
        enrichedAt: null,
      })
      continue
    }

    // Enrich the event
    const entry = await enrichSingleEvent(event)
    if (event.registrationUrl) scrapeCount++

    // Store in cache
    enrichmentCache.enrichments[cacheKey] = entry

    const relevance = matchCustomerRelevance(event.productTags, customers, subscriptionsByCustomer)
    enrichedEvents.push({
      ...event,
      enrichedDescription: entry.enrichedDescription,
      enrichedAt: entry.enrichedAt,
      customerRelevance: relevance.matchingCustomers.length > 0 ? relevance : undefined,
    })
  }

  // Write updated cache
  writeEnrichmentCache(ENRICHMENT_CACHE_PATH, enrichmentCache)

  // Sort by date ascending
  enrichedEvents.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  // Deduplicate by name + date
  const seen = new Set<string>()
  return enrichedEvents.filter(e => {
    const key = `${e.name}|${e.date}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
