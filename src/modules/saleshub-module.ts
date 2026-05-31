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
import { downloadSaleshubFromDrive } from '../lib/saleshub-drive-sync.ts'
import { resolve } from 'path'
import { statSync } from 'fs'

function getConfigDir(): string {
  return process.env.CONFIG_DIR ?? 'config'
}

FeatureModuleRegistry.register({
  name: 'saleshub',
  displayName: 'SalesHub Knowledge',
  refreshEndpoint: '/api/saleshub/refresh',
  signalRole: 'enrichment',
  signalAudience: 'all',
  scope: 'portfolio',
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days — data from Drive sync

  refreshInterval: null, // on-demand only

  async ensureFresh(_customerSlug: string): Promise<void> {
    const configPath = resolve(getConfigDir(), 'saleshub-knowledge.json')
    try {
      const stat = statSync(configPath)
      if (Date.now() - stat.mtimeMs < this.cacheTtlMs!) return // fresh
    } catch { /* file doesn't exist — needs refresh */ }
    await this.syncNow('')
  },

  cachePaths: () => [
    resolve(getConfigDir(), 'saleshub-knowledge.json'),
    resolve(getConfigDir(), 'saleshub-content-index.json'),
  ],

  async fetch(_customerName: string): Promise<void> {
    // SalesHub is portfolio-wide, not customer-specific
    // Download fresh data from Drive before reading from disk
    try {
      await downloadSaleshubFromDrive()
    } catch (e: any) {
      console.warn(`[saleshub-module] Drive download failed during fetch — falling back to disk: ${e.message}`)
    }
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
    // Download fresh data from Drive before re-reading from disk
    try {
      await downloadSaleshubFromDrive()
    } catch (e: any) {
      console.warn(`[saleshub-module] Drive download failed during syncNow — falling back to disk: ${e.message}`)
    }
    // Force re-read of JSON files from disk by resetting the mtime cache
    resetKnowledgeCache()
    const stats = getKnowledgeStats()
    const totalRecords = stats.tdpCount + stats.salesPlayCount + stats.tacticCount
    if (totalRecords === 0) {
      console.warn(`[saleshub-module] zero-record guard: 0 TDPs + plays + tactics loaded`)
      FeatureModuleRegistry.recordOutcome('saleshub', { success: false, error: 'No records loaded' })
      return
    }
    console.log(
      `[saleshub-module] reloaded: ${stats.tdpCount} TDPs, ${stats.salesPlayCount} plays, ${stats.tacticCount} tactics`
    )
    FeatureModuleRegistry.recordOutcome('saleshub', {
      success: true,
      recordCount: totalRecords,
    })
  },
})
