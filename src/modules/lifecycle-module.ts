// GitHub Issue #197 — Product lifecycle feature module
// Registers product lifecycle fetcher with the Feature Module Registry
// and provides Signal generation for content generation features.

import { FeatureModuleRegistry, type Signal, type NavDeclaration, type ModuleScope } from '../feature-module-registry.ts'
import { fetchProductLifecycle, readProductLifecycleCache } from '../product-lifecycle.ts'
import { existsSync, unlinkSync, statSync } from 'fs'
import { resolve } from 'path'
import { getCustomerProductContext } from '../lib/customer-product-context.ts'

const CACHE_PATH = resolve(process.env.CACHE_DIR ?? 'data/cache', 'product-lifecycle.json')
const LIFECYCLE_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

FeatureModuleRegistry.register({
  name: 'product-lifecycle',
  displayName: 'Product Lifecycle',
  refreshEndpoint: '/api/products/refresh-all',

  scope: 'portfolio',

  nav: {
    label: 'Products',
    icon: 'Package',
    group: 'intelligence',
    path: '/dashboard/products',
    order: 10,
  },

  cachePaths: () => ['data/cache/product-lifecycle.json'],

  cacheTtlMs: LIFECYCLE_TTL_MS,

  refreshInterval: 7 * 24 * 60 * 60 * 1000,  // weekly

  async ensureFresh(_customerSlug: string): Promise<void> {
    // Portfolio-wide cache — check single file
    try {
      const stat = statSync(CACHE_PATH)
      if (Date.now() - stat.mtimeMs < LIFECYCLE_TTL_MS) return // fresh
    } catch { /* file doesn't exist — needs refresh */ }

    // Stale or missing — refresh
    await fetchProductLifecycle()
  },

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

    const context = getCustomerProductContext(customerSlug)
    const signals: Signal[] = []
    const now = new Date()

    for (const product of cache.products) {
      // ADR-029: rawRelevance based on lifecycle urgency
      let rawRelevance = 0.5

      if (product.eolDate && product.eolDate !== 'N/A') {
        try {
          const eolDate = new Date(product.eolDate)
          const daysUntilEol = Math.floor((eolDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

          if (daysUntilEol < 90) {
            rawRelevance = 0.9
          } else if (product.nextVersion) {
            rawRelevance = 0.7
          }
        } catch {
          // Invalid date format — use default
        }
      } else if (product.nextVersion) {
        rawRelevance = 0.7
      }

      const versionPart = `${product.displayName.replace('Red Hat ', '')} ${product.currentVersion}`
      const eolPart = product.eolDate !== 'N/A'
        ? `EOL ${new Date(product.eolDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short' })}`
        : 'Active support'

      const headline = `${versionPart} — ${eolPart}`

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

      // ADR-029: cross-reference against customer subscriptions/interests
      const isOwned = context.ownedProducts.includes(product.slug)
      const isInterest = !isOwned && context.interestProducts.includes(product.slug)

      const metadata: Record<string, any> = {
        slug: product.slug,
        currentVersion: product.currentVersion,
        latestPatch: product.latestPatch,
        eolDate: product.eolDate,
        nextVersion: product.nextVersion,
        nextExpected: product.nextExpected,
        eusAvailable: product.eusAvailable,
      }

      if (isOwned) {
        metadata.customerSlug = customerSlug
        metadata.matchType = 'subscription'
        metadata.redHatProducts = [product.slug]
      } else if (isInterest) {
        metadata.customerSlug = customerSlug
        metadata.matchType = 'interest'
        metadata.context = 'evaluating'
        metadata.redHatProducts = [product.slug]
      }

      signals.push({
        source: 'product-lifecycle',
        type: 'product-release',
        headline,
        detail,
        rawRelevance,
        timestamp: cache.fetchedAt,
        metadata,
      })
    }

    return signals
  },
})
