/**
 * Account Intelligence Module — GitHub Issue #274
 * Migrates legacy intelligence cache to registry signal contract.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'

FeatureModuleRegistry.register({
  name: 'intelligence',
  displayName: 'Intelligence',
  refreshEndpoint: '/api/intelligence/generate-all',
  scope: 'customer',
  cachePaths: () => [],
  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  async syncNow(): Promise<void> {},

  async signals(customerSlug: string): Promise<Signal[]> {
    const path = resolve(CACHE_DIR, 'intelligence', `${customerSlug}.json`)
    if (!existsSync(path)) return []

    let data: any
    try {
      data = JSON.parse(readFileSync(path, 'utf-8'))
    } catch { return [] }

    if (data.noData) return []

    const signals: Signal[] = []

    if (data.company) {
      signals.push({
        source: 'intelligence',
        type: 'intelligence',
        headline: `Company intelligence for ${data.customerName ?? customerSlug}`,
        detail: data.company.substring(0, 300),
        rawRelevance: 0.7,  // ADR-027
        timestamp: data.cachedAt ?? new Date().toISOString(),
        metadata: {
          customerSlug,  // ADR-027: Mark as customer-specific
          docType: 'company',
          length: data.company.length,
          docUrl: data.companyDocUrl,
        },
      })
    }

    if (data.industry) {
      signals.push({
        source: 'intelligence',
        type: 'intelligence',
        headline: `Industry analysis: ${data.industryClassification ?? 'unclassified'}`,
        detail: data.industry.substring(0, 300),
        rawRelevance: 0.6,  // ADR-027
        timestamp: data.cachedAt ?? new Date().toISOString(),
        metadata: {
          customerSlug,  // ADR-027: Mark as customer-specific
          docType: 'industry',
          length: data.industry.length,
          docUrl: data.industryDocUrl,
        },
      })
    }

    return signals
  },
})
