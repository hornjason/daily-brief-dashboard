/**
 * SalesHub Knowledge Base Module — GitHub Issue #424
 *
 * Registers SalesHub as a FeatureModule so the admin panel's
 * "Refresh SalesHub" button can track status and trigger reloads.
 *
 * On hero/L3 installs, syncNow() re-reads the JSON files from the
 * config directory (no scraping needed — data comes from pre-built files).
 * On primary/Mac Mini nodes, the existing scrape trigger path is preserved.
 */

import { FeatureModuleRegistry } from '../feature-module-registry.ts'
import { resetKnowledgeCache, getKnowledgeStats } from '../lib/saleshub-knowledge-loader.ts'
import { resolve } from 'path'

function getConfigDir(): string {
  return process.env.CONFIG_DIR ?? 'config'
}

FeatureModuleRegistry.register({
  name: 'saleshub',
  displayName: 'SalesHub Knowledge',
  refreshEndpoint: '/api/saleshub/refresh',

  scope: 'portfolio',

  refreshInterval: null, // on-demand only

  cachePaths: () => [
    resolve(getConfigDir(), 'saleshub-knowledge.json'),
    resolve(getConfigDir(), 'saleshub-content-index.json'),
  ],

  async fetch(_customerName: string): Promise<void> {
    // SalesHub is portfolio-wide, not customer-specific
    resetKnowledgeCache()
    const stats = getKnowledgeStats()
    FeatureModuleRegistry.recordOutcome('saleshub', {
      success: true,
      recordCount: stats.tdpCount + stats.salesPlayCount + stats.tacticCount,
    })
  },

  async cleanup(_customerName: string): Promise<void> {
    // No-op: SalesHub data is shared config, not per-customer cache
  },

  async syncNow(_customerName: string): Promise<void> {
    // Force re-read of JSON files from disk by resetting the mtime cache
    resetKnowledgeCache()
    const stats = getKnowledgeStats()
    const totalRecords = stats.tdpCount + stats.salesPlayCount + stats.tacticCount
    console.log(
      `[saleshub-module] reloaded: ${stats.tdpCount} TDPs, ${stats.salesPlayCount} plays, ${stats.tacticCount} tactics`
    )
    FeatureModuleRegistry.recordOutcome('saleshub', {
      success: true,
      recordCount: totalRecords,
    })
  },
})
