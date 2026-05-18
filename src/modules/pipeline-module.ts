/**
 * Pipeline Module — GitHub Issue #274
 * Migrates legacy SF pipeline cache to registry signal contract.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { readPipelineCache } from '../cache-layer.ts'
import { normalizeForQuery } from '../utils.ts'
import { customers } from '../server-state.ts'
import { toSlug } from '../cache-layer.ts'

FeatureModuleRegistry.register({
  name: 'pipeline',
  scope: 'portfolio',
  cachePaths: () => ['data/cache/pipeline-data.json'],
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

      let score = 0.5
      const stageLower = stage.toLowerCase()
      if (stageLower.includes('commit') || stageLower.includes('closed')) score = 0.9
      else if (stageLower.includes('best case') || stageLower.includes('upside')) score = 0.7
      else if (stageLower.includes('pipeline')) score = 0.4

      signals.push({
        source: 'pipeline',
        type: 'expansion',
        headline: `${name} — ${stage}`,
        detail: `$${Math.round(acv).toLocaleString()} ACV${closeDate ? ` | Close: ${closeDate}` : ''} | ${opp.products?.join(', ') ?? ''}`,
        score,
        timestamp: cache.cachedAt ?? new Date().toISOString(),
        metadata: {
          opportunityName: name,
          stage,
          acv,
          closeDate,
          products: opp.products,
          renewal: opp.renewal,
        },
      })
    }

    return signals
  },
})
