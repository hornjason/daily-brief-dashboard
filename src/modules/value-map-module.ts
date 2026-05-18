/**
 * Business Value Map Module
 * Registers Red Hat Business Value Maps as a universal signal.
 *
 * Value maps provide per-product business objectives, impact areas,
 * and solution enablers. When available, they feed into ALL intelligence
 * features — briefs, meeting prep, campaigns, customer intelligence —
 * via the universal signal contract (ADR-021).
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { getValueMap, getAvailableValueMapSlugs, clearValueMapCache } from '../value-map-loader.ts'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { toSlug } from '../cache-layer.ts'

function getCustomersPath(): string {
  const configDir = process.env.CONFIG_DIR ?? 'config'
  return resolve(configDir, 'customers.json')
}

function getCustomerProducts(customerSlug: string): string[] {
  try {
    const path = getCustomersPath()
    if (!existsSync(path)) return []
    const customers = JSON.parse(readFileSync(path, 'utf-8'))
    const custs = Array.isArray(customers) ? customers : customers.customers ?? []
    const customer = custs.find((c: any) => toSlug(c.name) === customerSlug)
    if (!customer) return []

    const products: string[] = []
    if (customer.subscriptions) {
      for (const sub of customer.subscriptions) {
        const name = (sub.productName || sub.product || '').toLowerCase()
        if (name.includes('openshift')) products.push('ocp')
        else if (name.includes('enterprise linux') || name.includes('rhel')) products.push('rhel')
        else if (name.includes('ansible')) products.push('aap')
        else if (name.includes('cluster security') || name.includes('acs')) products.push('acs')
        else if (name.includes('cluster management') || name.includes('acm')) products.push('acm')
        else if (name.includes('quay')) products.push('quay')
        else if (name.includes('openshift ai') || name.includes('rhoai')) products.push('rhoai')
        else if (name.includes('developer hub') || name.includes('rhdh')) products.push('rhdh')
        else if (name.includes('satellite')) products.push('satellite')
        else if (name.includes('insights')) products.push('insights')
      }
    }
    return [...new Set(products)]
  } catch {
    return []
  }
}

FeatureModuleRegistry.register({
  name: 'value-maps',

  scope: 'portfolio',

  cachePaths: () => ['data/cache/value-maps/business-value-maps.txt'],

  async fetch(): Promise<void> {
    clearValueMapCache()
  },

  async cleanup(): Promise<void> {},

  async syncNow(): Promise<void> {
    clearValueMapCache()
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const availableSlugs = getAvailableValueMapSlugs()
    if (availableSlugs.length === 0) return []

    const customerProducts = getCustomerProducts(customerSlug)
    const slugsToUse = customerProducts.length > 0
      ? customerProducts.filter(s => availableSlugs.includes(s))
      : availableSlugs

    if (slugsToUse.length === 0) return []

    const signals: Signal[] = []

    for (const slug of slugsToUse) {
      const content = getValueMap(slug)
      if (!content) continue

      const lines = content.split('\n').filter(l => l.trim())
      const summary = lines.slice(0, 5).join(' ').substring(0, 500)

      signals.push({
        source: 'value-maps',
        type: 'intelligence',
        headline: `Business value context for ${slug.toUpperCase()}`,
        detail: summary,
        score: 0.6,
        timestamp: new Date().toISOString(),
        metadata: {
          productSlug: slug,
          contentLength: content.length,
          isCustomerSpecific: customerProducts.length > 0,
        },
      })
    }

    return signals
  },
})
