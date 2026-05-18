/**
 * CCSP Cloud Spend Module
 * GitHub Issue #268 — CCSP as a universal signal
 *
 * Registers CCSP cloud consumption data with FeatureModuleRegistry.
 * Provides Signal generation for all intelligence features — meeting prep,
 * briefs, campaigns, customer intelligence.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { readCCSPCache } from '../cache-layer.ts'
import { toSlug } from '../cache-layer.ts'

FeatureModuleRegistry.register({
  name: 'ccsp',

  scope: 'customer',

  cachePaths: () => ['data/cache/ccsp-data.json'],

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

      signals.push({
        source: 'ccsp',
        type: 'cloud-spend',
        headline: `${cloud} cloud spend: $${Math.round(acv).toLocaleString()} ACV`,
        detail: `Products: ${products.join(', ') || 'unspecified'}. ${cloudToProduct[cloud] ? `Managed service opportunity: ${cloudToProduct[cloud]}` : ''}`,
        score: acv > 100000 ? 0.9 : acv > 50000 ? 0.7 : acv > 10000 ? 0.5 : 0.3,
        timestamp: cache.cachedAt,
        metadata: {
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
        score: 0.8,
        timestamp: cache.cachedAt,
        metadata: {
          totalACV,
          cloudPartners: clouds,
        },
      })
    }

    return signals
  },
})
