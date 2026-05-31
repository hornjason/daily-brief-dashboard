// src/modules/ecosystem-catalog-module.ts
// GitHub Issue #438 — Ecosystem Catalog feature module (Phase 1: consumption layer)
// Registers ecosystem catalog data as a signal source.
// Solutions are loaded from cached JSON files in data/cache/ecosystem-catalog/*.json.
// Separate from partner-catalog-module.ts which handles specialized channel partners.

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { loadAllEcosystemPartners, getEcosystemCacheDir, type EcosystemSolution, type EcosystemResource } from '../lib/ecosystem-catalog.ts'
import { loadCustomerContext, matchesTechStack } from '../lib/customer-context-loader.ts'
import { downloadEcosystemCatalogFromDrive } from '../lib/ecosystem-catalog-drive-sync.ts'
import { statSync } from 'fs'
import { resolve } from 'path'

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days — monthly refresh cycle

/**
 * Format resources grouped by type into a markdown detail block.
 */
function formatResources(resources: EcosystemResource[]): string {
  if (resources.length === 0) return ''
  const byType = new Map<string, EcosystemResource[]>()
  for (const r of resources) {
    const group = byType.get(r.type) ?? []
    group.push(r)
    byType.set(r.type, group)
  }
  const lines: string[] = ['**Resources:**']
  for (const [type, items] of byType) {
    for (const item of items) {
      lines.push(`- [${item.title}](${item.url}) (${type})`)
    }
  }
  return lines.join('\n')
}

/**
 * Format Ansible collections into a markdown list.
 */
function formatCollections(collections: { name: string; namespace: string; category?: string; url?: string }[]): string {
  if (collections.length === 0) return ''
  const lines = ['**Ansible Collections:**']
  for (const c of collections) {
    const label = c.category ? `${c.name} (${c.category})` : c.name
    lines.push(c.url ? `- [${label}](${c.url})` : `- ${label}`)
  }
  return lines.join('\n')
}

FeatureModuleRegistry.register({
  name: 'ecosystem-catalog',
  displayName: 'Ecosystem Catalog',
  refreshEndpoint: '/api/refresh/ecosystem-catalog',

  scope: 'portfolio',

  cacheTtlMs: CACHE_TTL_MS,

  refreshInterval: null, // On-demand only (Phase 1 — no scraper)

  cachePaths: (_slug: string) => {
    const dir = getEcosystemCacheDir()
    return [dir]
  },

  async ensureFresh(_customerSlug: string): Promise<void> {
    // Check cache file ages vs TTL
    const dir = getEcosystemCacheDir()
    try {
      const stat = statSync(dir)
      if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) return // fresh
    } catch {
      // Directory missing — try Drive download
      await downloadEcosystemCatalogFromDrive()
      return
    }
    // Stale — pull fresh data from Drive
    console.log('[ecosystem-catalog] cache directory is older than 30 days — refreshing from Drive')
    await downloadEcosystemCatalogFromDrive()
  },

  async fetch(_customerName: string): Promise<void> {
    // Portfolio-wide data, not per-customer. Phase 1 reads from cache files.
  },

  async cleanup(_customerName: string): Promise<void> {
    // Portfolio-level cache — no per-customer cleanup
  },

  async syncNow(_customerName: string): Promise<void> {
    // L3 Drive refresh: download latest partner files before reloading
    await downloadEcosystemCatalogFromDrive()
    const partners = loadAllEcosystemPartners()
    const totalSolutions = partners.reduce((sum, p) => sum + p.solutions.length, 0)
    if (totalSolutions === 0) {
      console.warn(`[ecosystem-catalog] zero-record guard: 0 solutions loaded from ${partners.length} partners`)
      FeatureModuleRegistry.recordOutcome('ecosystem-catalog', { success: false, error: 'No solutions loaded' })
      return
    }
    console.log(`[ecosystem-catalog] loaded ${partners.length} partners with ${totalSolutions} solutions`)
    FeatureModuleRegistry.recordOutcome('ecosystem-catalog', {
      success: true,
      recordCount: totalSolutions,
    })
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const partners = loadAllEcosystemPartners()
    if (partners.length === 0) return []

    // Load customer context for filtering (#475)
    const customerCtx = loadCustomerContext(customerSlug)

    const signals: Signal[] = []

    for (const partnerCache of partners) {
      for (const solution of partnerCache.solutions) {
        const resourceTypes = [...new Set(solution.resources.map(r => r.type))]

        const detailParts: string[] = [
          solution.description,
          `**Platform:** ${solution.platform}`,
          `**Categories:** ${solution.categories.join(', ')}`,
          `**Region:** ${solution.geoRegion}`,
        ]

        if (solution.coSell) {
          detailParts.push('**Co-Sell:** Available for purchase through partner')
        }

        const resourceBlock = formatResources(solution.resources)
        if (resourceBlock) detailParts.push(resourceBlock)

        const collectionBlock = formatCollections(solution.collections)
        if (collectionBlock) detailParts.push(collectionBlock)

        // Check if solution matches customer tech stack (#475)
        const matchTargets = [solution.platform, ...solution.categories]
        const isCustomerMatch = matchesTechStack(matchTargets, customerCtx.techs)

        const metadata: Record<string, unknown> = {
          partnerName: solution.partnerName,
          platform: solution.platform, // backward compat
          product: solution.platform, // signal routing to Product Alignment section
          categories: solution.categories,
          coSell: solution.coSell ?? false,
          resourceTypes,
          solutionName: solution.name,
        }

        if (isCustomerMatch) {
          metadata.customerSlug = customerSlug
        }

        signals.push({
          source: 'ecosystem-catalog',
          type: 'intelligence',
          headline: `${solution.name} — ${solution.partnerName} + Red Hat`,
          detail: detailParts.join('\n'),
          timestamp: solution.publishedAt ?? partnerCache.scrapedAt,
          url: solution.url,
          rawRelevance: 0.5, // Medium — customer-level boosting when partner matches tech stack
          metadata,
        })
      }
    }

    return signals
  },
})
