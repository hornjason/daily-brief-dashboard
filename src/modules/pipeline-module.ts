/**
 * Pipeline Module — GitHub Issue #274
 * Migrates legacy SF pipeline cache to registry signal contract.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { readPipelineCache } from '../cache-layer.ts'
import { normalizeForQuery } from '../utils.ts'
import { customers } from '../server-state.ts'
import { toSlug } from '../cache-layer.ts'
import { statSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const PIPELINE_CACHE_PATH = resolve(CACHE_DIR, 'pipeline-data.json')

FeatureModuleRegistry.register({
  name: 'pipeline',
  displayName: 'Pipeline',
  refreshEndpoint: '/api/refresh/pipeline',
  scope: 'portfolio',
  cacheTtlMs: 24 * 60 * 60 * 1000, // 24 hours — data from L3 Drive CSV refresh
  cachePaths: () => ['data/cache/pipeline-data.json'],

  async ensureFresh(_customerSlug: string): Promise<void> {
    try {
      const stat = statSync(PIPELINE_CACHE_PATH)
      if (Date.now() - stat.mtimeMs < this.cacheTtlMs!) return // fresh
    } catch { /* file doesn't exist — needs refresh */ }
    await this.syncNow('')
  },

  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  async syncNow(): Promise<void> {},

  async signals(customerSlug: string): Promise<Signal[]> {
    const cache = readPipelineCache()
    if (!cache?.records?.length) return []

    const customer = customers.find(c => toSlug(c.name) === customerSlug)
    const needle = normalizeForQuery(customer?.name ?? customerSlug)

    const filterStartTime = performance.now()
    const totalRecords = cache.records.length
    const customerRecords = cache.records.filter(r =>
      normalizeForQuery(r.accountName).includes(needle) || needle.includes(normalizeForQuery(r.accountName))
    )
    const filterElapsed = performance.now() - filterStartTime

    // Only log when filter > 10ms
    if (filterElapsed > 10) {
      console.log(`[signal-perf] pipeline filter: ${filterElapsed.toFixed(2)}ms (${totalRecords} records → ${customerRecords.length} matches)`)
    }

    if (customerRecords.length === 0) return []

    const signals: Signal[] = []

    for (const opp of customerRecords) {
      const acv = opp.acv ?? 0
      const stage = opp.forecastCategory ?? 'Unknown'
      const name = opp.oppName ?? 'Opportunity'
      const closeDate = opp.closeDate ?? ''

      // ADR-027: rawRelevance based on stage
      let rawRelevance = 0.5
      const stageLower = stage.toLowerCase()
      if (stageLower.includes('commit') || stageLower.includes('closed')) rawRelevance = 0.9
      else if (stageLower.includes('best case') || stageLower.includes('upside')) rawRelevance = 0.7
      else if (stageLower.includes('pipeline')) rawRelevance = 0.5
      else rawRelevance = 0.3

      signals.push({
        source: 'pipeline',
        type: 'expansion',
        headline: `${name} — ${stage}`,
        detail: `$${Math.round(acv).toLocaleString()} ACV${closeDate ? ` | Close: ${closeDate}` : ''} | ${opp.products?.join(', ') ?? ''}`,
        rawRelevance,
        timestamp: cache.cachedAt ?? new Date().toISOString(),
        expiresAt: closeDate || undefined,  // Opportunities expire after close date (GitHub Issue #278)
        url: opp.oppId ? `https://redhatcrm.lightning.force.com/lightning/r/Opportunity/${opp.oppId}/view` : undefined,  // #479
        metadata: {
          customerSlug,  // ADR-027: Mark as customer-specific
          opportunityName: name,
          stage,
          amount: acv,  // ADR-027: amount for scoring booster
          closeDate,
          products: opp.products,
          renewal: opp.renewal,
        },
      })
    }

    return signals
  },
})
