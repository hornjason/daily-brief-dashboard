// src/modules/partner-catalog-module.ts
// GitHub Issue #265 — Partner Catalog Pipeline feature module
// Registers partner catalog data as a signal source.
// Partners are loaded from data/config/partners.json (static config, L3-readable).
// Provides partner intelligence signals for content generation.

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { loadPartnersFromConfig, type Partner } from '../lib/partner-catalog.ts'
import { loadCustomerContext, matchesSubscriptionProducts, matchesTechStack } from '../lib/customer-context-loader.ts'

/**
 * Maps Red Hat product keywords to partner specialization keywords.
 * Used to bridge customer subscription product descriptions to partner specializations.
 * Example: customer has "OpenShift Container Platform" → matches "Container Management" specialization.
 */
const PRODUCT_TO_SPECIALIZATION: Record<string, string[]> = {
  'openshift': ['Container Mgmt', 'Container Management'],
  'enterprise linux': ['Server Cloud OS', 'Server Cloud'],
  'rhel': ['Server Cloud OS', 'Server Cloud'],
  'ansible': ['Mission Critical Automation', 'Automation'],
  'virtualization': ['Virtualization'],
  'application platform': ['Application Platform'],
}

/**
 * Check if any of the partner's specializations match the customer's product subscriptions.
 * Uses the PRODUCT_TO_SPECIALIZATION bridge to map between product descriptions and specializations.
 */
function partnerMatchesCustomerProducts(
  partnerSpecializations: string[],
  customerProducts: string[],
): boolean {
  if (partnerSpecializations.length === 0 || customerProducts.length === 0) return false

  // Build a set of specialization keywords that match the customer's products
  const matchedSpecializations = new Set<string>()
  for (const product of customerProducts) {
    for (const [keyword, specializations] of Object.entries(PRODUCT_TO_SPECIALIZATION)) {
      if (product.includes(keyword)) {
        for (const spec of specializations) {
          matchedSpecializations.add(spec.toLowerCase())
        }
      }
    }
  }

  // Check if any partner specialization matches
  for (const spec of partnerSpecializations) {
    if (matchedSpecializations.has(spec.toLowerCase())) return true
  }

  return false
}

FeatureModuleRegistry.register({
  name: 'partner-catalog',
  displayName: 'Partner Catalog',
  refreshEndpoint: '/api/customer/_global/modules/partner-catalog/sync',
  signalRole: 'enrichment',
  signalAudience: 'all',
  scope: 'portfolio',
  cacheTtlMs: undefined, // no TTL — config-driven

  async ensureFresh(_customerSlug: string): Promise<void> {
    // No-op — partner data is config-driven, no independent cache
  },

  cachePaths: (_slug: string) => [
    'data/config/partners.json',
  ],

  refreshInterval: null, // Config-driven, no scheduled refresh

  async fetch(_customerName: string): Promise<void> {
    // Partners are loaded from static config — no fetch needed
    return Promise.resolve()
  },

  async cleanup(_customerName: string): Promise<void> {
    // Config file is shared across all customers — no per-customer cleanup
    return Promise.resolve()
  },

  async syncNow(_customerName: string): Promise<void> {
    // Config-driven — no sync operation
    return Promise.resolve()
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const partners = loadPartnersFromConfig()
    if (partners.length === 0) return []

    // Load customer context for filtering (#486)
    const customerCtx = loadCustomerContext(customerSlug)

    return partners.map((p: Partner): Signal => {
      const credentialSummary = p.credentials
        ? p.credentials.map(c => `${c.name} (${c.count})`).join(', ')
        : 'No credential data'

      // Check if partner specializations match customer products or tech stack (#486)
      const isCustomerMatch =
        partnerMatchesCustomerProducts(p.specializations, customerCtx.products) ||
        matchesTechStack(p.specializations, customerCtx.techs)

      const metadata: Record<string, unknown> = {
        partnerName: p.name,
        partnershipLevel: p.partnershipLevel,
        specializations: p.specializations,
        credentialCount: p.credentials?.reduce((sum, c) => sum + c.count, 0) ?? 0,
      }

      if (isCustomerMatch) {
        metadata.customerSlug = customerSlug
      }

      return {
        source: 'partner-catalog',
        type: 'intelligence',
        headline: `${p.name} — ${p.partnershipLevel}`,
        detail: [
          `Specializations: ${p.specializations.join(', ')}`,
          `Geo: ${p.geo} (${p.country})`,
          `Credentials: ${credentialSummary}`,
          p.catalogUrl ? `Catalog: ${p.catalogUrl}` : '',
        ].filter(Boolean).join('\n'),
        timestamp: new Date().toISOString(),
        url: p.catalogUrl,
        rawRelevance: 0.4, // General portfolio intelligence; customer match raises via scoring
        metadata,
      }
    })
  },
})
