// src/modules/partner-catalog-module.ts
// GitHub Issue #265 — Partner Catalog Pipeline feature module
// Registers partner catalog data as a signal source.
// Partners are loaded from data/config/partners.json (static config, L3-readable).
// Provides partner intelligence signals for content generation.

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { loadPartnersFromConfig, type Partner } from '../lib/partner-catalog.ts'

FeatureModuleRegistry.register({
  name: 'partner-catalog',
  displayName: 'Partner Catalog',

  scope: 'portfolio',

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

  async signals(_customerSlug: string): Promise<Signal[]> {
    const partners = loadPartnersFromConfig()
    if (partners.length === 0) return []

    return partners.map((p: Partner): Signal => {
      const credentialSummary = p.credentials
        ? p.credentials.map(c => `${c.name} (${c.count})`).join(', ')
        : 'No credential data'

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
        rawRelevance: 0.4, // General portfolio intelligence
        metadata: {
          partnerName: p.name,
          partnershipLevel: p.partnershipLevel,
          specializations: p.specializations,
          credentialCount: p.credentials?.reduce((sum, c) => sum + c.count, 0) ?? 0,
        },
      }
    })
  },
})
