// GitHub Issue #197 — Product lifecycle feature module
// Registers product lifecycle fetcher with the Feature Module Registry
// and provides Signal generation for content generation features.

import { FeatureModuleRegistry, type Signal, type NavDeclaration, type ModuleScope } from '../feature-module-registry.ts'
import { fetchProductLifecycle, readProductLifecycleCache } from '../product-lifecycle.ts'
import { existsSync, unlinkSync } from 'fs'
import { resolve } from 'path'

const CACHE_PATH = resolve(process.env.CACHE_DIR ?? 'data/cache', 'product-lifecycle.json')

FeatureModuleRegistry.register({
  name: 'product-lifecycle',

  scope: 'portfolio',

  nav: {
    label: 'Products',
    icon: 'Package',
    group: 'intelligence',
    path: '/dashboard/products',
    order: 10,
  },

  cachePaths: () => ['data/cache/product-lifecycle.json'],

  refreshInterval: 7 * 24 * 60 * 60 * 1000,  // weekly

  async fetch(_customerName: string): Promise<void> {
    // Product lifecycle is global, not customer-specific
    await fetchProductLifecycle()
  },

  async cleanup(_customerName: string): Promise<void> {
    // Remove cache file when cleaning up (global, not per-customer)
    if (existsSync(CACHE_PATH)) {
      unlinkSync(CACHE_PATH)
    }
  },

  async syncNow(_customerName: string): Promise<void> {
    // Same as fetch for this module
    await fetchProductLifecycle()
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const cache = readProductLifecycleCache()

    if (!cache || !cache.products) {
      return []
    }

    const signals: Signal[] = []
    const now = new Date()

    for (const product of cache.products) {
      // Calculate days until EOL for scoring
      let score = 0.4  // default score

      if (product.eolDate && product.eolDate !== 'N/A') {
        try {
          const eolDate = new Date(product.eolDate)
          const daysUntilEol = Math.floor((eolDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

          if (daysUntilEol < 90) {
            score = 0.8  // EOL soon — high priority
          } else if (product.nextVersion) {
            score = 0.6  // New version available
          }
        } catch {
          // Invalid date format — use default score
        }
      } else if (product.nextVersion) {
        score = 0.6  // New version available
      }

      // Build headline
      const versionPart = `${product.displayName.replace('Red Hat ', '')} ${product.currentVersion}`
      const eolPart = product.eolDate !== 'N/A'
        ? `EOL ${new Date(product.eolDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short' })}`
        : 'Active support'

      const headline = `${versionPart} — ${eolPart}`

      // Build detail
      const parts: string[] = []
      parts.push(`Current version: ${product.latestPatch}`)
      parts.push(`GA: ${new Date(product.gaDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}`)
      parts.push(`Support ends: ${new Date(product.supportEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}`)

      if (product.eusAvailable) {
        parts.push('EUS available')
      }

      if (product.nextVersion && product.nextExpected) {
        parts.push(`Next version: ${product.nextVersion} (expected ${new Date(product.nextExpected).toLocaleDateString('en-US', { year: 'numeric', month: 'short' })})`)
      }

      const detail = parts.join(' | ')

      signals.push({
        source: 'product-lifecycle',
        type: 'product-release',
        headline,
        detail,
        score,
        timestamp: cache.fetchedAt,
        metadata: {
          slug: product.slug,
          currentVersion: product.currentVersion,
          latestPatch: product.latestPatch,
          eolDate: product.eolDate,
          nextVersion: product.nextVersion,
          nextExpected: product.nextExpected,
          eusAvailable: product.eusAvailable,
        },
      })
    }

    return signals
  },
})
