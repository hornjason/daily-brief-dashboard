// src/modules/partner-catalog-module.ts
// GitHub Issue #265, #640 — Partner Catalog Pipeline feature module
// Registers partner catalog data as a signal source.
// Partners are loaded from data/config/partners.json (static config, L3-readable).
// Emits partner match signals by cross-referencing customer tech stack/subscriptions
// against partner specializations via matchPartnersToProducts().

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { loadPartnersFromConfig, matchPartnersToProducts, type Partner } from '../lib/partner-catalog.ts'
import { loadCustomerContext, matchesTechStack } from '../lib/customer-context-loader.ts'
import { statSync } from 'fs'
import { resolve } from 'path'

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days — config file refresh cycle

/**
 * Canonical Red Hat product names recognized by matchPartnersToProducts().
 * Maps lowercase subscription keywords → canonical product name.
 */
const SUBSCRIPTION_TO_PRODUCT: Record<string, string> = {
  'ansible': 'Ansible Automation Platform',
  'openshift': 'OpenShift Container Platform',
  'enterprise linux': 'Red Hat Enterprise Linux',
  'rhel': 'Red Hat Enterprise Linux',
  'virtualization': 'Red Hat Virtualization',
  'application platform': 'Application Platform',
}

/**
 * Extract canonical Red Hat product names from customer subscription descriptions.
 * Customer products are lowercased strings like "red hat openshift container platform".
 * Returns deduplicated array of canonical product names for matchPartnersToProducts().
 */
function extractCanonicalProducts(customerProducts: string[]): string[] {
  const canonical = new Set<string>()
  for (const product of customerProducts) {
    for (const [keyword, canonicalName] of Object.entries(SUBSCRIPTION_TO_PRODUCT)) {
      if (product.includes(keyword)) {
        canonical.add(canonicalName)
      }
    }
  }
  return Array.from(canonical)
}

/**
 * Resolve the partners.json config file path.
 */
function getPartnersConfigPath(): string {
  const configDir = process.env.CONFIG_DIR ?? 'data/config'
  return resolve(configDir, 'partners.json')
}

FeatureModuleRegistry.register({
  name: 'partner-catalog',
  displayName: 'Partner Catalog',
  refreshEndpoint: '/api/customer/_global/modules/partner-catalog/sync',
  signalRole: 'enrichment',
  signalAudience: 'all',
  scope: 'portfolio',
  cacheTtlMs: CACHE_TTL_MS,

  refreshInterval: null, // Config-driven, no scheduled refresh

  cachePaths: (_slug: string) => [
    getPartnersConfigPath(),
  ],

  async ensureFresh(_customerSlug: string): Promise<void> {
    // Check partners.json mtime against TTL (AC-5)
    const configPath = getPartnersConfigPath()
    try {
      const stat = statSync(configPath)
      if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) return // fresh
    } catch {
      // File missing — nothing to refresh for config-driven data
      return
    }
    // Stale — log advisory (config files are manually updated, no auto-refresh source)
    console.log('[partner-catalog] partners.json is older than 7 days — consider updating')
  },

  async fetch(_customerName: string): Promise<void> {
    // Partners are loaded from static config — no fetch needed
  },

  async cleanup(_customerName: string): Promise<void> {
    // Config file is shared across all customers — no per-customer cleanup
  },

  async syncNow(_customerName: string): Promise<void> {
    // Reload partners from config and record outcome (AC-7)
    const partners = loadPartnersFromConfig()
    if (partners.length === 0) {
      console.warn('[partner-catalog] zero-record guard: 0 partners loaded from config')
      FeatureModuleRegistry.recordOutcome('partner-catalog', { success: false, error: 'No partners loaded' })
      return
    }
    console.log(`[partner-catalog] loaded ${partners.length} partners from config`)
    FeatureModuleRegistry.recordOutcome('partner-catalog', {
      success: true,
      recordCount: partners.length,
    })
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const partners = loadPartnersFromConfig()
    if (partners.length === 0) return []

    // Load customer context for cross-referencing (#486, #640)
    const customerCtx = loadCustomerContext(customerSlug)

    // Map subscription descriptions to canonical Red Hat product names, then cross-reference (AC-2)
    const canonicalProducts = extractCanonicalProducts(customerCtx.products)
    const partnerMatches = matchPartnersToProducts(canonicalProducts, partners)
    const matchedPartnerNames = new Set(partnerMatches.map(m => m.partner.name))

    const signals: Signal[] = []

    for (const partner of partners) {
      const match = partnerMatches.find(m => m.partner.name === partner.name)
      const isCustomerMatch = !!match ||
        matchesTechStack(partner.specializations, customerCtx.techs)

      // Build certifications list from credentials
      const certifications = partner.credentials
        ?.filter(c => c.type === 'certification')
        .map(c => c.name) ?? []

      const credentialSummary = partner.credentials
        ? partner.credentials.map(c => `${c.name} (${c.count})`).join(', ')
        : 'No credential data'

      // AC-3: metadata includes partnerName, specializations, certifications, catalogUrl, matchedProducts
      const metadata: Record<string, unknown> = {
        partnerName: partner.name,
        partnershipLevel: partner.partnershipLevel,
        specializations: partner.specializations,
        certifications,
        catalogUrl: partner.catalogUrl ?? null,
        matchedProducts: match?.matchedProducts ?? [],
        credentialCount: partner.credentials?.reduce((sum, c) => sum + c.count, 0) ?? 0,
      }

      // AC-4: Set customerSlug for customer-tier scoring (floor 0.50)
      if (isCustomerMatch) {
        metadata.customerSlug = customerSlug
      }

      // Partner match signals get higher rawRelevance for differentiation
      const rawRelevance = match
        ? 0.6 + Math.min(0.3, match.credentialCount * 0.01) // 0.60-0.90 based on credential depth
        : 0.4 // General portfolio intelligence

      const headline = match
        ? `${partner.name} — matches ${match.matchedProducts.join(', ')}`
        : `${partner.name} — ${partner.partnershipLevel}`

      signals.push({
        source: 'partner-catalog',
        type: 'intelligence',
        headline,
        detail: [
          `Specializations: ${partner.specializations.join(', ')}`,
          `Geo: ${partner.geo} (${partner.country})`,
          `Credentials: ${credentialSummary}`,
          match ? `Matched Products: ${match.matchedProducts.join(', ')}` : '',
          match ? `Match Type: ${match.matchType.join(', ')}` : '',
          partner.catalogUrl ? `Catalog: ${partner.catalogUrl}` : '',
        ].filter(Boolean).join('\n'),
        timestamp: new Date().toISOString(),
        url: partner.catalogUrl,
        rawRelevance,
        metadata,
      })
    }

    return signals
  },
})
