/**
 * Customer Product Intel Module — GitHub Issue #274
 * Migrates legacy per-product customer intel cache to registry signal contract.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'

FeatureModuleRegistry.register({
  name: 'customer-product-intel',
  displayName: 'Customer Product Intel',
  refreshEndpoint: '/api/products/refresh-all',
  scope: 'customer',
  cachePaths: () => [],
  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  async syncNow(): Promise<void> {},

  async signals(customerSlug: string): Promise<Signal[]> {
    const productIntelDir = resolve(CACHE_DIR, 'product-intel')
    if (!existsSync(productIntelDir)) return []

    const signals: Signal[] = []

    try {
      const dirs = readdirSync(productIntelDir).filter(d => d.endsWith('-customer-intel'))
      for (const dir of dirs) {
        const filePath = resolve(productIntelDir, dir, `${customerSlug}.json`)
        if (!existsSync(filePath)) continue

        const data = JSON.parse(readFileSync(filePath, 'utf-8'))
        const intel = data.intel ?? data
        const product = intel.product ?? dir.replace('-customer-intel', '')

        const parts: string[] = []
        if (intel.priorityAction) parts.push(`Priority: ${intel.priorityAction}`)
        if (intel.expansionOpportunities?.length) parts.push(`${intel.expansionOpportunities.length} expansion opps`)
        if (intel.competitiveAngle) parts.push(intel.competitiveAngle.substring(0, 100))

        signals.push({
          source: 'customer-product-intel',
          type: 'product-intel',
          headline: `${product} intelligence — relevance ${intel.relevanceScore ?? '?'}/10`,
          detail: parts.join(' | ') || 'Product intel generated',
          rawRelevance: (intel.relevanceScore ?? 5) / 10,
          timestamp: intel.generatedAt ?? data.cachedAt ?? new Date().toISOString(),
          metadata: {
            customerSlug,
            product,
            relevanceScore: intel.relevanceScore,
            expansionOpps: intel.expansionOpportunities?.length ?? 0,
            hasRoadmap: !!intel.roadmapRelevance,
            hasCaseAlignment: !!intel.caseAlignment,
          },
        })
      }
    } catch { /* silent */ }

    return signals
  },
})
