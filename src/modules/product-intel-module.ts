// GitHub Issue #255 — Product Intelligence feature module
// Registers Product Intelligence (release radar + feature radar) with the Feature Module Registry.
// Wraps existing functions from product-release-radar.ts and product-feature-radar.ts.

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { refreshAllProducts, getAllProductSummaries } from '../product-release-radar.ts'
import { refreshAllFeatures, getFeatureCache } from '../product-feature-radar.ts'
import { toSlug } from '../cache-layer.ts'
import { existsSync, unlinkSync, readdirSync, statSync } from 'fs'
import { resolve } from 'path'
import { getCustomerProductContext } from '../lib/customer-product-context.ts'

const DATA_DIR  = process.env.DATA_DIR  ?? resolve(import.meta.dir, '../../data')
const CACHE_DIR = resolve(process.env.CACHE_DIR ?? resolve(DATA_DIR, 'cache'), 'product-intel')
const PRODUCT_INTEL_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

FeatureModuleRegistry.register({
  name: 'product-intel',
  displayName: 'Product Features',
  refreshEndpoint: '/api/products/features/refresh-all',

  scope: 'portfolio',

  nav: {
    label: 'Product Intelligence',
    icon: 'Brain',
    group: 'intelligence',
    path: '/dashboard/products',
    order: 5,
  },

  cachePaths: (slug: string) => [
    `data/cache/product-intel/${slug}-summary.json`,
    `data/cache/product-intel/${slug}-features.json`,
  ],

  cacheTtlMs: PRODUCT_INTEL_TTL_MS,

  refreshInterval: 7 * 24 * 60 * 60 * 1000,  // 7 days (weekly)

  async ensureFresh(_customerSlug: string): Promise<void> {
    // Portfolio-wide cache — check any summary file as staleness indicator
    // All product summaries refresh together, so checking one is sufficient
    if (!existsSync(CACHE_DIR)) {
      await refreshAllProducts()
      await refreshAllFeatures()
      return
    }

    try {
      const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('-summary.json'))
      if (files.length === 0) {
        // No summaries exist — needs refresh
        await refreshAllProducts()
        await refreshAllFeatures()
        return
      }

      // Check mtime of first summary file
      const stat = statSync(resolve(CACHE_DIR, files[0]))
      if (Date.now() - stat.mtimeMs < PRODUCT_INTEL_TTL_MS) return // fresh
    } catch { /* file doesn't exist — needs refresh */ }

    // Stale or missing — refresh
    await refreshAllProducts()
    await refreshAllFeatures()
  },

  async fetch(_customerName: string): Promise<void> {
    // Product intelligence is global (portfolio-level), not customer-specific
    await refreshAllProducts()
    await refreshAllFeatures()
  },

  async cleanup(_customerName: string): Promise<void> {
    // Product intel is portfolio-level, not customer-specific
    // Cleanup removes all cached product data when cleanup is triggered
    if (!existsSync(CACHE_DIR)) return

    const files = readdirSync(CACHE_DIR)
    for (const file of files) {
      try {
        unlinkSync(resolve(CACHE_DIR, file))
      } catch (e: any) {
        console.warn(`[product-intel-module] failed to delete ${file}:`, e?.message)
      }
    }
  },

  async syncNow(_customerName: string): Promise<void> {
    // Same as fetch for this module
    await refreshAllProducts()
    await refreshAllFeatures()
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const summaries = getAllProductSummaries()
    if (!summaries || summaries.length === 0) return []

    const context = getCustomerProductContext(customerSlug)
    const signals: Signal[] = []

    for (const summary of summaries) {
      if (!summary.slug || !summary.summaryText) continue

      const isOwned = context.ownedProducts.includes(summary.slug)
      const isInterest = !isOwned && context.interestProducts.includes(summary.slug)
      const rawRelevance = (isOwned || isInterest) ? 0.7 : 0.5

      const headline = summary.displayName
        ? `${summary.displayName} — ${summary.summaryText.substring(0, 80)}${summary.summaryText.length > 80 ? '...' : ''}`
        : summary.summaryText.substring(0, 100)

      const metadata: Record<string, any> = { productSlug: summary.slug }

      if (isOwned) {
        metadata.customerSlug = customerSlug
        metadata.matchType = 'subscription'
        metadata.redHatProducts = [summary.slug]
      } else if (isInterest) {
        metadata.customerSlug = customerSlug
        metadata.matchType = 'interest'
        metadata.context = 'evaluating'
        metadata.redHatProducts = [summary.slug]
      }

      signals.push({
        source: 'product-intel',
        type: 'product-intel',
        headline,
        detail: summary.summaryText,
        rawRelevance,
        timestamp: new Date().toISOString(),
        metadata,
      })
    }

    return signals
  },
})
