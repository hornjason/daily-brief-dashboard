/**
 * Business Value Map Module
 * Registers Red Hat Business Value Maps as a universal signal.
 *
 * Sourcing strategy (ADR-023): Drive-first with static fallback.
 * - When valueMapsDeckId is configured in settings.json, fetch() exports
 *   the Google Slides deck as text/plain and writes to cache.
 * - When not configured, the static file shipped in config-templates/
 *   (seeded by entrypoint.sh on first boot) is used as-is.
 * - value-map-loader.ts reads from cache path regardless of source.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { getValueMap, getAvailableValueMapSlugs, clearValueMapCache } from '../value-map-loader.ts'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { toSlug } from '../cache-layer.ts'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const VALUE_MAPS_PATH = resolve(CACHE_DIR, 'value-maps/business-value-maps.txt')
const SETTINGS_PATH = resolve(process.env.CONFIG_DIR ?? 'config', 'settings.json')

function getValueMapsDeckId(): string | null {
  try {
    if (!existsSync(SETTINGS_PATH)) return null
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    return settings.valueMapsDeckId ?? null
  } catch {
    return null
  }
}

function getCustomersPath(): string {
  const configDir = process.env.CONFIG_DIR ?? 'config'
  return resolve(configDir, 'customers.json')
}

function getCustomerProducts(customerSlug: string): string[] {
  try {
    const path = getCustomersPath()
    if (!existsSync(path)) return []
    const customers = JSON.parse(readFileSync(path, 'utf-8'))
    const custs = Array.isArray(customers) ? customers : customers.customers ?? []
    const customer = custs.find((c: any) => toSlug(c.name) === customerSlug)
    if (!customer) return []

    const products: string[] = []
    if (customer.subscriptions) {
      for (const sub of customer.subscriptions) {
        const name = (sub.productName || sub.product || '').toLowerCase()
        if (name.includes('openshift')) products.push('ocp')
        else if (name.includes('enterprise linux') || name.includes('rhel')) products.push('rhel')
        else if (name.includes('ansible')) products.push('aap')
        else if (name.includes('cluster security') || name.includes('acs')) products.push('acs')
        else if (name.includes('cluster management') || name.includes('acm')) products.push('acm')
        else if (name.includes('quay')) products.push('quay')
        else if (name.includes('openshift ai') || name.includes('rhoai')) products.push('rhoai')
        else if (name.includes('developer hub') || name.includes('rhdh')) products.push('rhdh')
        else if (name.includes('satellite')) products.push('satellite')
        else if (name.includes('insights')) products.push('insights')
      }
    }
    return [...new Set(products)]
  } catch {
    return []
  }
}

async function fetchFromDrive(deckId: string): Promise<void> {
  try {
    const { google } = await import('googleapis')
    const { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } = await import('../google.ts')
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    const res = await drive.files.export(
      { fileId: deckId, mimeType: 'text/plain' },
      { responseType: 'text' }
    )

    const content = typeof res.data === 'string' ? res.data : String(res.data)
    if (content.length < 100) {
      console.warn(`[value-maps] Drive export returned only ${content.length} chars — keeping existing cache`)
      return
    }

    const dir = resolve(CACHE_DIR, 'value-maps')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(VALUE_MAPS_PATH, content)
    clearValueMapCache()
    console.log(`[value-maps] refreshed from Drive deck ${deckId} — ${content.length} chars`)
  } catch (e: any) {
    console.warn(`[value-maps] Drive export failed: ${e?.message ?? e} — using cached file`)
  }
}

FeatureModuleRegistry.register({
  name: 'value-maps',
  displayName: 'Value Maps',
  refreshEndpoint: '/api/products/refresh-all',

  scope: 'portfolio',

  refreshInterval: 7 * 24 * 60 * 60 * 1000, // weekly

  cachePaths: () => ['data/cache/value-maps/business-value-maps.txt'],

  async fetch(): Promise<void> {
    const deckId = getValueMapsDeckId()
    if (deckId) {
      await fetchFromDrive(deckId)
    } else {
      clearValueMapCache()
    }
  },

  async cleanup(): Promise<void> {},

  async syncNow(): Promise<void> {
    const deckId = getValueMapsDeckId()
    if (deckId) {
      await fetchFromDrive(deckId)
    } else {
      clearValueMapCache()
    }
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const availableSlugs = getAvailableValueMapSlugs()
    if (availableSlugs.length === 0) return []

    const customerProducts = getCustomerProducts(customerSlug)
    const isCustomerSpecific = customerProducts.length > 0
    const slugsToUse = isCustomerSpecific
      ? customerProducts.filter(s => availableSlugs.includes(s))
      : availableSlugs

    if (slugsToUse.length === 0) return []

    const signals: Signal[] = []

    for (const slug of slugsToUse) {
      const content = getValueMap(slug)
      if (!content) continue

      const lines = content.split('\n').filter(l => l.trim())
      const summary = lines.slice(0, 5).join(' ').substring(0, 500)

      signals.push({
        source: 'value-maps',
        type: 'intelligence',
        headline: `Business value context for ${slug.toUpperCase()}`,
        detail: summary,
        rawRelevance: isCustomerSpecific ? 0.75 : 0.6,  // ADR-027
        timestamp: new Date().toISOString(),
        metadata: {
          customerSlug: isCustomerSpecific ? customerSlug : undefined,  // ADR-027: Only customer-specific if they have products
          productSlug: slug,
          contentLength: content.length,
          redHatProducts: [slug],  // ADR-027: booster for RH products
        },
      })
    }

    return signals
  },
})
