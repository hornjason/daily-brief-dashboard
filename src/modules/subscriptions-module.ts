/**
 * Subscriptions Module — GitHub Issue #274
 * Migrates legacy subscription/sheets cache to registry signal contract.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'
import { customers, aes } from '../server-state.ts'
import { toSlug } from '../cache-layer.ts'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const EXPIRING_SOON_DAYS = 90

function normalizeProductName(raw: string): string {
  return raw.replace(/^Red Hat\s+/i, '').replace(/,\s.*$/, '').trim() || raw
}

function baseProductName(desc: string): string {
  return desc.replace(/,\s.*$/, '').replace(/\s*\(.*\)/, '').trim()
}

function hasMatchingCase(productDesc: string, customerSlug: string): boolean {
  const casesPath = resolve(CACHE_DIR, 'cases.json')
  if (!existsSync(casesPath)) return false
  try {
    const data = JSON.parse(readFileSync(casesPath, 'utf-8'))
    const cases = data.cases ?? (Array.isArray(data) ? data : [])
    const baseName = baseProductName(productDesc).toLowerCase()
    return cases.some((c: any) => {
      const caseProduct = (c.product ?? '').toLowerCase()
      return caseProduct && baseName.startsWith(caseProduct) || caseProduct.startsWith(baseName)
    })
  } catch { return false }
}

function computeUrgency(endDate: string | undefined, productDesc: string, customerSlug: string): 'active' | 'expiring-soon' | 'expired' | 'expired-critical' {
  if (!endDate) return 'active'
  const end = new Date(endDate)
  const now = new Date()
  const daysUntilEnd = Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

  if (daysUntilEnd > EXPIRING_SOON_DAYS) return 'active'
  if (daysUntilEnd > 0) return 'expiring-soon'
  if (daysUntilEnd === 0) return 'expiring-soon'
  // Expired — check for active cases on this product
  if (hasMatchingCase(productDesc, customerSlug)) return 'expired-critical'
  return 'expired'
}

/** Look up the subscription sheet Drive URL for a customer slug. */
function getSubscriptionSheetUrl(customerSlug: string): string | undefined {
  const customer = customers.find(c => toSlug(c.name) === customerSlug)
  if (!customer?.ae) return undefined
  const ae = aes.find(a => a.name === customer.ae)
  const sheetId = (ae as any)?.subscriptionSheetId
  if (!sheetId) return undefined
  return `https://docs.google.com/spreadsheets/d/${sheetId}/edit`
}

FeatureModuleRegistry.register({
  name: 'subscriptions',
  displayName: 'Subscriptions',
  refreshEndpoint: '/api/refresh/subscriptions',
  scope: 'customer',
  signalRole: 'trigger',
  signalAudience: 'customer-specific',
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
    const sheetUrl = getSubscriptionSheetUrl(customerSlug)
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

      const rawProduct = subs[0]?.productDescription ?? subs[0]?.productName ?? product
      const urgency = computeUrgency(nearestEnd, rawProduct, customerSlug)

      signals.push({
        source: 'subscriptions',
        type: 'subscription',
        headline: `${product} — ${qty} subscription${qty !== 1 ? 's' : ''}`,
        detail: nearestEnd ? `Earliest renewal: ${nearestEnd}` : 'Active subscription',
        rawRelevance: urgency === 'expired-critical' ? 0.95 : urgency === 'expired' ? 0.85 : urgency === 'expiring-soon' ? 0.7 : 0.5,
        timestamp: data.cachedAt ?? new Date().toISOString(),
        url: sheetUrl,  // #523: link to SF bookings sheet in Drive
        metadata: {
          customerSlug,
          product,
          quantity: qty,
          endDate: nearestEnd,
          urgency,
        },
      })
    }

    return signals
  },
})
