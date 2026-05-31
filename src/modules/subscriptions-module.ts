/**
 * Subscriptions Module — GitHub Issue #274
 * Migrates legacy subscription/sheets cache to registry signal contract.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'

function normalizeProductName(raw: string): string {
  return raw.replace(/^Red Hat\s+/i, '').replace(/,\s.*$/, '').trim() || raw
}

FeatureModuleRegistry.register({
  name: 'subscriptions',
  displayName: 'Subscriptions',
  refreshEndpoint: '/api/refresh/subscriptions',
  scope: 'customer',
  cacheTtlMs: 4 * 60 * 60 * 1000, // 4 hours — data from Sheets refresh
  cachePaths: () => [],

  async ensureFresh(customerSlug: string): Promise<void> {
    const cachePath = resolve(CACHE_DIR, `${customerSlug}-sheets.json`)
    try {
      const stat = statSync(cachePath)
      if (Date.now() - stat.mtimeMs < this.cacheTtlMs!) return // fresh
    } catch { /* file doesn't exist — needs refresh */ }
    await this.syncNow(customerSlug)
  },

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
      const rawProduct = row.productDescription ?? row.productName ?? row.product ?? row.SKU ?? row.sku ?? 'Unknown'
      const product = normalizeProductName(rawProduct)
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
        rawRelevance: 0.5,  // ADR-027: default relevance
        timestamp: data.cachedAt ?? new Date().toISOString(),
        metadata: {
          customerSlug,  // ADR-027: Mark as customer-specific
          product,
          quantity: qty,
          endDate: nearestEnd,  // ADR-027: endDate for renewal urgency booster
        },
      })
    }

    return signals
  },
})
