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
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs'
import { resolve } from 'path'
import { getCustomerProductContext } from '../lib/customer-product-context.ts'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const VALUE_MAPS_PATH = resolve(CACHE_DIR, 'value-maps/business-value-maps.txt')
const SETTINGS_PATH = resolve(process.env.CONFIG_DIR ?? 'config', 'settings.json')
const VALUE_MAPS_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

function getValueMapsDeckId(): string | null {
  try {
    if (!existsSync(SETTINGS_PATH)) return null
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    return settings.valueMapsDeckId ?? null
  } catch {
    return null
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
  signalRole: 'enrichment',
  signalAudience: 'all',
  scope: 'portfolio',

  refreshInterval: 7 * 24 * 60 * 60 * 1000, // weekly

  cachePaths: () => ['data/cache/value-maps/business-value-maps.txt'],

  cacheTtlMs: VALUE_MAPS_TTL_MS,

  async ensureFresh(_customerSlug: string): Promise<void> {
    // Portfolio-wide cache — check single file
    try {
      const stat = statSync(VALUE_MAPS_PATH)
      if (Date.now() - stat.mtimeMs < VALUE_MAPS_TTL_MS) return // fresh
    } catch { /* file doesn't exist — needs refresh */ }

    // Stale or missing — refresh
    const deckId = getValueMapsDeckId()
    if (deckId) {
      await fetchFromDrive(deckId)
    } else {
      clearValueMapCache()
    }
  },

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
      FeatureModuleRegistry.recordOutcome('value-maps', { success: true })
    } else {
      clearValueMapCache()
      FeatureModuleRegistry.recordOutcome('value-maps', { success: true, recordCount: 0 })
    }
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const availableSlugs = getAvailableValueMapSlugs()
    if (availableSlugs.length === 0) return []

    // ADR-029: use shared utility instead of local getCustomerProducts
    const context = getCustomerProductContext(customerSlug)
    const hasRelevantProducts = context.allRelevantProducts.length > 0
    const slugsToUse = hasRelevantProducts
      ? context.allRelevantProducts.filter(s => availableSlugs.includes(s))
      : availableSlugs

    if (slugsToUse.length === 0) return []

    const signals: Signal[] = []

    for (const slug of slugsToUse) {
      const content = getValueMap(slug)
      if (!content) continue

      const lines = content.split('\n').filter(l => l.trim())
      const summary = lines.slice(0, 5).join(' ').substring(0, 500)

      const isOwned = context.ownedProducts.includes(slug)
      const isInterest = !isOwned && context.interestProducts.includes(slug)

      const metadata: Record<string, any> = {
        productSlug: slug,
        contentLength: content.length,
      }

      if (isOwned) {
        metadata.customerSlug = customerSlug
        metadata.matchType = 'subscription'
        metadata.redHatProducts = [slug]
      } else if (isInterest) {
        metadata.customerSlug = customerSlug
        metadata.matchType = 'interest'
        metadata.context = 'evaluating'
        metadata.redHatProducts = [slug]
      }

      signals.push({
        source: 'value-maps',
        type: 'intelligence',
        headline: `Business value context for ${slug.toUpperCase()}`,
        detail: summary,
        rawRelevance: (isOwned || isInterest) ? 0.75 : 0.6,
        timestamp: new Date().toISOString(),
        metadata,
      })
    }

    return signals
  },
})
