// GitHub Issue #255 — Product Intelligence feature module
// Registers Product Intelligence (release radar + feature radar) with the Feature Module Registry.
// Wraps existing functions from product-release-radar.ts and product-feature-radar.ts.

import { FeatureModuleRegistry } from '../feature-module-registry.ts'
import { refreshAllProducts, getAllProductSummaries } from '../product-release-radar.ts'
import { refreshAllFeatures, getFeatureCache } from '../product-feature-radar.ts'
import { toSlug } from '../cache-layer.ts'
import { existsSync, unlinkSync, readdirSync } from 'fs'
import { resolve } from 'path'

const DATA_DIR  = process.env.DATA_DIR  ?? resolve(import.meta.dir, '../../data')
const CACHE_DIR = resolve(process.env.CACHE_DIR ?? resolve(DATA_DIR, 'cache'), 'product-intel')

FeatureModuleRegistry.register({
  name: 'product-intel',

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

  refreshInterval: 7 * 24 * 60 * 60 * 1000,  // 7 days (weekly)

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

  async signals(customerSlug: string): Promise<any[]> {
    // Product intelligence signals are generated from cached summaries
    // This would return product-related signals for a customer (if we had customer-product mapping)
    // For now, return empty array — will be enhanced when customer-product mapping exists
    return []
  },
})
