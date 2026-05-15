/**
 * Red Hat Events Module
 * GitHub Issue #202 — Events module registration
 *
 * Registers events fetcher with FeatureModuleRegistry.
 * Provides Signal generation for content generation features.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { fetchRHEvents, type RHEvent } from '../rh-events-fetcher.ts'
import { existsSync, unlinkSync, readFileSync } from 'fs'
import { resolve } from 'path'

const CACHE_PATH = resolve(process.env.DATA_DIR ?? 'data', 'cache', 'events', 'rh-events.json')

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
  const customersPath = resolve(process.env.DATA_DIR ?? 'data', 'config', 'customers.json')
  if (!existsSync(customersPath)) {
    return null
  }

  let customers: any[]
  try {
    customers = JSON.parse(readFileSync(customersPath, 'utf8'))
  } catch (e: any) {
    console.warn('[events-module] Failed to parse customers.json:', e.message)
    return null
  }

  const customer = customers.find((c: any) => c.slug === customerSlug)
  if (!customer || !customer.ae) {
    return null
  }

  // Read aes.json to get territory
  const aesPath = resolve(process.env.DATA_DIR ?? 'data', 'config', 'aes.json')
  if (!existsSync(aesPath)) {
    return null
  }

  let aes: any[]
  try {
    aes = JSON.parse(readFileSync(aesPath, 'utf8'))
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

  cachePaths: () => ['data/cache/events/rh-events.json'],

  refreshInterval: 7 * 24 * 60 * 60 * 1000,  // weekly

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
    // Same as fetch for this module
    await fetchRHEvents()
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

    // Get customer's region
    const customerRegion = getCustomerRegion(customerSlug)

    // Filter events
    const now = Date.now()
    const signals: Signal[] = []

    for (const event of cache.events) {
      // Parse event date
      let eventDate: number
      try {
        eventDate = new Date(event.date).getTime()
      } catch {
        continue
      }

      // Only include upcoming events (within 90 days)
      const daysUntil = (eventDate - now) / (1000 * 60 * 60 * 24)
      if (daysUntil < 0 || daysUntil > 90) {
        continue
      }

      // Include if:
      // - Virtual/national events (available to everyone)
      // - In-person events matching customer's region
      const include = event.region === 'national' ||
                     (customerRegion && event.region === customerRegion)

      if (!include) {
        continue
      }

      // Score by proximity
      let score = 0.4  // base score for within 90 days
      if (daysUntil <= 14) {
        score = 0.8  // within 2 weeks
      } else if (daysUntil <= 30) {
        score = 0.6  // within 1 month
      }

      signals.push({
        source: 'rh-events',
        type: 'event',
        headline: event.name,
        detail: `${event.format === 'virtual' ? 'Virtual' : event.location || 'Location TBD'} • ${event.date}`,
        score,
        timestamp: event.date,
        url: event.registrationUrl || undefined,
        metadata: {
          format: event.format,
          location: event.location,
          region: event.region,
          productTags: event.productTags,
          registrationUrl: event.registrationUrl,
        },
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
