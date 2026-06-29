/**
 * Red Hat Events Module
 * GitHub Issue #202 — Events module registration
 *
 * Registers events fetcher with FeatureModuleRegistry.
 * Provides Signal generation for content generation features.
 */

import { FeatureModuleRegistry, type Signal, type NavDeclaration, type ModuleScope } from '../feature-module-registry.ts'
import { fetchRHEvents, type RHEvent } from '../rh-events-fetcher.ts'
import { existsSync, unlinkSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'
import { getCustomerProductContext } from '../lib/customer-product-context.ts'
import { resolveToSlug } from '../lib/product-vocabulary.ts'

const CACHE_PATH = resolve(process.env.CACHE_DIR ?? 'data/cache', 'events', 'rh-events.json')
const CONFIG_DIR = resolve(process.env.CONFIG_DIR ?? 'data/config')
const EVENTS_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

// ── Territory to Region Mapping ──────────────────────────────────────────────

/**
 * Map Tableau territory code to event region
 * Examples:
 * - "WEST_COMM_CORP_NORTHWEST_TERR01" → "west"
 * - "NORTHEAST_ENT_BFSI_TERR01" → "northeast"
 * - "CENTRAL_COMM_CORP_NORTH_CENTRAL_TERR01" → "central"
 */
function territoryToRegion(territory: string): string {
  const normalized = territory.toUpperCase()

  if (normalized.startsWith('WEST')) return 'west'
  if (normalized.startsWith('NORTHEAST') || normalized.startsWith('NE_')) return 'northeast'
  if (normalized.startsWith('SOUTHEAST') || normalized.startsWith('SE_')) return 'southeast'
  if (normalized.startsWith('CENTRAL')) return 'central'
  if (normalized.startsWith('CANADA') || normalized.startsWith('CAN_')) return 'canada'

  // Fallback to west
  return 'west'
}

/**
 * Get customer's region from their AE's territory
 */
function getCustomerRegion(customerSlug: string): string | null {
  // Read customers.json to find which AE owns this customer
  const customersPath = resolve(CONFIG_DIR, 'customers.json')
  if (!existsSync(customersPath)) {
    return null
  }

  let customers: any[]
  try {
    const parsed = JSON.parse(readFileSync(customersPath, 'utf8'))
    customers = Array.isArray(parsed) ? parsed : parsed.customers ?? []
  } catch (e: any) {
    console.warn('[events-module] Failed to parse customers.json:', e.message)
    return null
  }

  const customer = customers.find((c: any) => c.slug === customerSlug)
  if (!customer || !customer.ae) {
    return null
  }

  // Read aes.json to get territory
  const aesPath = resolve(CONFIG_DIR, 'aes.json')
  if (!existsSync(aesPath)) {
    return null
  }

  let aes: any[]
  try {
    const parsed = JSON.parse(readFileSync(aesPath, 'utf8'))
    aes = Array.isArray(parsed) ? parsed : parsed.aes ?? []
  } catch (e: any) {
    console.warn('[events-module] Failed to parse aes.json:', e.message)
    return null
  }

  const ae = aes.find((a: any) => a.name === customer.ae)
  if (!ae || !ae.tableauTerritories || ae.tableauTerritories.length === 0) {
    return null
  }

  // Use first territory to determine region
  const territory = ae.tableauTerritories[0]
  return territoryToRegion(territory)
}

// ── Module Registration ──────────────────────────────────────────────────────

FeatureModuleRegistry.register({
  name: 'rh-events',
  displayName: 'Events',
  refreshEndpoint: '/api/customer/_global/modules/rh-events/sync',
  signalRole: 'enrichment',
  signalAudience: 'all',
  scope: 'portfolio',

  nav: {
    label: 'Events',
    icon: 'CalendarDays',
    group: 'intelligence',
    path: '/dashboard/events',
    order: 30,
  },

  cachePaths: () => ['data/cache/events/rh-events.json'],

  cacheTtlMs: EVENTS_TTL_MS,

  refreshInterval: 7 * 24 * 60 * 60 * 1000,  // weekly

  async ensureFresh(_customerSlug: string): Promise<void> {
    // Portfolio-wide cache — check single file
    try {
      const stat = statSync(CACHE_PATH)
      if (Date.now() - stat.mtimeMs < EVENTS_TTL_MS) return // fresh
    } catch { /* file doesn't exist — needs refresh */ }

    // Stale or missing — refresh
    await fetchRHEvents()
  },

  async fetch(_customerName: string): Promise<void> {
    // Events are global, not customer-specific
    await fetchRHEvents()
  },

  async cleanup(_customerName: string): Promise<void> {
    // Remove cache file when cleaning up (global, not per-customer)
    if (existsSync(CACHE_PATH)) {
      unlinkSync(CACHE_PATH)
    }
  },

  async syncNow(_customerName: string): Promise<void> {
    await fetchRHEvents()
    try {
      const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'))
      FeatureModuleRegistry.recordOutcome('rh-events', { success: true, recordCount: raw.events?.length ?? 0 })
    } catch { FeatureModuleRegistry.recordOutcome('rh-events', { success: false, error: 'Failed to read events cache' }) }
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    // Read events cache
    if (!existsSync(CACHE_PATH)) {
      return []
    }

    let cache: { events: RHEvent[]; fetchedAt: string }
    try {
      const raw = readFileSync(CACHE_PATH, 'utf8')
      cache = JSON.parse(raw)
    } catch (e: any) {
      console.warn('[events-module] Failed to parse cache:', e.message)
      return []
    }

    if (!cache.events || cache.events.length === 0) {
      return []
    }

    const customerRegion = getCustomerRegion(customerSlug)
    const context = getCustomerProductContext(customerSlug)

    const now = Date.now()
    const signals: Signal[] = []

    for (const event of cache.events) {
      let eventDate: number
      try {
        eventDate = new Date(event.date).getTime()
      } catch {
        continue
      }

      const daysUntil = (eventDate - now) / (1000 * 60 * 60 * 24)
      if (daysUntil < 0 || daysUntil > 90) {
        continue
      }

      const regionMatch = customerRegion ? event.region === customerRegion : false
      const include = event.region === 'national' || regionMatch

      if (!include) {
        continue
      }

      // ADR-029: rawRelevance based on proximity
      let rawRelevance = 0.5
      if (daysUntil <= 14) {
        rawRelevance = 0.9
      } else if (daysUntil <= 30) {
        rawRelevance = 0.7
      }

      // #354: Boost relevance for geographic proximity (region match > national)
      if (regionMatch && event.format !== 'virtual') {
        rawRelevance = Math.min(1.0, rawRelevance + 0.1)
      }

      // ADR-029: cross-reference productTags against customer products
      let productMatch = false
      const matchedProducts: string[] = []

      if (event.productTags && event.productTags.length > 0) {
        for (const tag of event.productTags) {
          const slug = resolveToSlug(tag)
          if (slug && context.allRelevantProducts.includes(slug)) {
            productMatch = true
            if (!matchedProducts.includes(slug)) matchedProducts.push(slug)
          }
        }
      }

      const metadata: Record<string, any> = {
        format: event.format,
        location: event.location,
        region: event.region,
        regionMatch,
        customerRegion: customerRegion ?? undefined,
        productTags: event.productTags,
        registrationUrl: event.registrationUrl,
        description: event.summary || event.description || '',
      }

      if (productMatch) {
        metadata.customerSlug = customerSlug
        if (context.ownedProducts.some(p => matchedProducts.includes(p))) {
          metadata.matchType = 'subscription'
        } else {
          metadata.matchType = 'interest'
          metadata.context = 'evaluating'
        }
        metadata.redHatProducts = matchedProducts
      }

      signals.push({
        source: 'rh-events',
        type: 'event',
        headline: event.name,
        detail: `${event.format === 'virtual' ? 'Virtual' : event.location || 'Location TBD'} • ${event.date}`,
        rawRelevance,
        timestamp: event.date,
        url: event.registrationUrl || undefined,
        expiresAt: event.date,
        metadata,
      })
    }

    // Sort by date ascending (soonest first)
    signals.sort((a, b) => {
      const aDate = new Date(a.timestamp).getTime()
      const bDate = new Date(b.timestamp).getTime()
      return aDate - bDate
    })

    return signals
  },
})
