/**
 * Subscriptions Module — GitHub Issue #274
 * Migrates legacy subscription/sheets cache to registry signal contract.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'

FeatureModuleRegistry.register({
  name: 'subscriptions',
  scope: 'customer',
  cachePaths: () => [],
  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  async syncNow(): Promise<void> {},

  async signals(customerSlug: string): Promise<Signal[]> {
    const path = resolve(CACHE_DIR, `${customerSlug}-sheets.json`)
    if (!existsSync(path)) return []

    let data: any
    try {
      data = JSON.parse(readFileSync(path, 'utf-8'))
    } catch { return [] }

    const rows = data.rows ?? data.subscriptions ?? (Array.isArray(data) ? data : [])
    if (rows.length === 0) return []

    const signals: Signal[] = []
    const products = new Map<string, any[]>()

    for (const row of rows) {
      const product = row.productName ?? row.product ?? row.SKU ?? 'Unknown'
      if (!products.has(product)) products.set(product, [])
      products.get(product)!.push(row)
    }

    for (const [product, subs] of products) {
      const qty = subs.reduce((s: number, r: any) => s + (r.quantity ?? r.qty ?? 1), 0)
      const endDates = subs.map((r: any) => r.endDate ?? r.expirationDate).filter(Boolean).sort()
      const nearestEnd = endDates[0]

      signals.push({
        source: 'subscriptions',
        type: 'subscription',
        headline: `${product} — ${qty} subscription${qty !== 1 ? 's' : ''}`,
        detail: nearestEnd ? `Earliest renewal: ${nearestEnd}` : 'Active subscription',
        score: 0.5,
        timestamp: data.cachedAt ?? new Date().toISOString(),
        metadata: { product, quantity: qty, nearestEnd },
      })
    }

    return signals
  },
})
