/**
 * Customer Product Intel Module — GitHub Issue #274
 * Migrates legacy per-product customer intel cache to registry signal contract.
 * GitHub Issue #353 — Connect features to business objectives via initiativeAlignment
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'

FeatureModuleRegistry.register({
  name: 'customer-product-intel',
  displayName: 'Customer Product Intel',
  refreshEndpoint: '/api/products/refresh-all',
  scope: 'customer',
  signalRole: 'trigger',
  signalAudience: 'customer-specific',
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days — data from Gemini generation
  cachePaths: () => [],

  async ensureFresh(customerSlug: string): Promise<void> {
    const productIntelDir = resolve(CACHE_DIR, 'product-intel')
    if (!existsSync(productIntelDir)) return
    try {
      const dirs = readdirSync(productIntelDir).filter(d => d.endsWith('-customer-intel'))
      for (const dir of dirs) {
        const filePath = resolve(productIntelDir, dir, `${customerSlug}.json`)
        if (!existsSync(filePath)) continue
        try {
          const stat = statSync(filePath)
          if (Date.now() - stat.mtimeMs < this.cacheTtlMs!) continue // fresh
        } catch { continue }
        // At least one file is stale — trigger refresh
        await this.syncNow(customerSlug)
        return
      }
    } catch { /* silent */ }
  },

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

        // #353: Surface business objective alignment in detail
        const initiatives: string[] = Array.isArray(intel.initiativeAlignment) ? intel.initiativeAlignment : []
        if (initiatives.length > 0) {
          parts.push(`Objective alignment: ${initiatives[0].substring(0, 120)}`)
        }

        const featureTPs: any[] = Array.isArray(intel.featureTalkingPoints) ? intel.featureTalkingPoints : []

        // #353: Boost rawRelevance when business objectives are connected
        let rawRelevance = (typeof intel.relevanceScore === 'number' ? intel.relevanceScore : 5) / 10
        if (initiatives.length > 0) {
          rawRelevance = Math.min(1.0, rawRelevance + 0.1)
        }

        signals.push({
          source: 'customer-product-intel',
          type: 'product-intel',
          headline: `${product} intelligence — relevance ${intel.relevanceScore ?? '?'}/10`,
          detail: parts.join(' | ') || 'Product intel generated',
          rawRelevance,
          timestamp: intel.generatedAt ?? data.cachedAt ?? new Date().toISOString(),
          url: `/dashboard/products/${product}`,  // #479: link to product detail page
          metadata: {
            customerSlug,
            product,
            relevanceScore: intel.relevanceScore,
            expansionOpps: intel.expansionOpportunities?.length ?? 0,
            hasRoadmap: !!intel.roadmapRelevance,
            hasCaseAlignment: !!intel.caseAlignment,
            initiativeAlignment: initiatives,
            featureTalkingPoints: featureTPs,
          },
        })
      }
    } catch { /* silent */ }

    return signals
  },
})
