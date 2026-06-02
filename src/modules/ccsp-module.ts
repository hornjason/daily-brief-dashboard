/**
 * CCSP Cloud Spend Module
 * GitHub Issue #268 — CCSP as a universal signal
 *
 * Registers CCSP cloud consumption data with FeatureModuleRegistry.
 * Provides Signal generation for all intelligence features — meeting prep,
 * briefs, campaigns, customer intelligence.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { readCCSPCache, toSlug } from '../cache-layer.ts'
import { customers, aes } from '../server-state.ts'
import { statSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const CCSP_CACHE_PATH = resolve(CACHE_DIR, 'ccsp-data.json')

/** Look up the CCSP sheet Drive URL for a customer slug. */
function getCcspSheetUrl(customerSlug: string): string | undefined {
  const customer = customers.find(c => toSlug(c.name) === customerSlug)
  if (!customer?.ae) return undefined
  const ae = aes.find(a => a.name === customer.ae)
  const sheetId = (ae as any)?.ccspSheetId
  if (!sheetId) return undefined
  return `https://docs.google.com/spreadsheets/d/${sheetId}/edit`
}

FeatureModuleRegistry.register({
  name: 'ccsp',
  displayName: 'CCSP Cloud Spend',
  refreshEndpoint: '/api/refresh/ccsp',
  signalRole: 'trigger',
  signalAudience: 'customer-specific',
  scope: 'customer',
  cacheTtlMs: 24 * 60 * 60 * 1000, // 24 hours — data from L3 Drive CSV refresh

  cachePaths: () => ['data/cache/ccsp-data.json'],

  async ensureFresh(_customerSlug: string): Promise<void> {
    try {
      const stat = statSync(CCSP_CACHE_PATH)
      if (Date.now() - stat.mtimeMs < this.cacheTtlMs!) return // fresh
    } catch { /* file doesn't exist — needs refresh */ }
    await this.syncNow('')
  },

  async fetch(): Promise<void> {
    // CCSP data comes from L3 Drive sync via refresh-engine — not fetched per-customer
  },

  async cleanup(): Promise<void> {},

  async syncNow(): Promise<void> {},

  async signals(customerSlug: string): Promise<Signal[]> {
    const cache = readCCSPCache()
    if (!cache?.records?.length) return []

    // Match customer by slug (normalize account name to slug for comparison)
    const customerRecords = cache.records.filter(r =>
      toSlug(r.accountName ?? '') === customerSlug
    )
    if (customerRecords.length === 0) return []

    const signals: Signal[] = []
    const sheetUrl = getCcspSheetUrl(customerSlug)

    // Cloud platform signals
    const clouds = [...new Set(customerRecords.map(r => r.cloudPartner).filter(Boolean))]
    for (const cloud of clouds) {
      const cloudRecords = customerRecords.filter(r => r.cloudPartner === cloud)
      const acv = cloudRecords.reduce((s, r) => s + (r.acvPlus || 0), 0)
      const products = [...new Set(cloudRecords.map(r => r.productOfferingGroup).filter(Boolean))]

      // Map cloud partner to Red Hat managed service
      const cloudToProduct: Record<string, string> = {
        'AWS': 'ROSA (Red Hat OpenShift Service on AWS)',
        'Microsoft': 'ARO (Azure Red Hat OpenShift)',
        'Google': 'OSD on GCP (OpenShift Dedicated)',
      }

      // ADR-027: rawRelevance based on ACV
      let rawRelevance = 0.3
      if (acv > 100000) rawRelevance = 0.9
      else if (acv > 50000) rawRelevance = 0.7
      else if (acv > 10000) rawRelevance = 0.5

      signals.push({
        source: 'ccsp',
        type: 'cloud-spend',
        headline: `${cloud} cloud spend: $${Math.round(acv).toLocaleString()} ACV`,
        detail: `Products: ${products.join(', ') || 'unspecified'}. ${cloudToProduct[cloud] ? `Managed service opportunity: ${cloudToProduct[cloud]}` : ''}`,
        rawRelevance,
        timestamp: cache.cachedAt,
        url: sheetUrl,  // #523: link to CCSP data sheet in Drive
        metadata: {
          customerSlug,  // ADR-027: Mark as customer-specific
          cloudPartner: cloud,
          acvPlus: acv,
          products,
          managedService: cloudToProduct[cloud] ?? null,
        },
      })
    }

    // Total cloud spend signal
    const totalACV = customerRecords.reduce((s, r) => s + (r.acvPlus || 0), 0)
    if (totalACV > 0) {
      signals.push({
        source: 'ccsp',
        type: 'cloud-spend',
        headline: `Total cloud spend: $${Math.round(totalACV).toLocaleString()} ACV across ${clouds.join(', ')}`,
        detail: `Customer is active on ${clouds.length} cloud platform${clouds.length > 1 ? 's' : ''}. Consider cross-cloud consistency positioning with OpenShift.`,
        rawRelevance: 0.8,
        timestamp: cache.cachedAt,
        url: sheetUrl,  // #523: link to CCSP data sheet in Drive
        metadata: {
          customerSlug,  // ADR-027: Mark as customer-specific
          acvPlus: totalACV,
          cloudPartners: clouds,
        },
      })
    }

    return signals
  },
})
