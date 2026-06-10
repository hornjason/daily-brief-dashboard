// src/modules/territory-module.ts
// GitHub Issue #733 — Territory FeatureModuleRegistry registration
// Registers territory sync with the Feature Module Registry for admin UI
// visibility, freshness tracking, and syncNow capability.

import { FeatureModuleRegistry } from '../feature-module-registry.ts'
import { existsSync, statSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const TERRITORY_CACHE_PATH = resolve(CACHE_DIR, 'territory-teams.json')
const TERRITORY_TTL_MS = 24 * 60 * 60 * 1000  // 24 hours

FeatureModuleRegistry.register({
  name: 'territory',
  displayName: 'Territory & Team',
  refreshEndpoint: '/api/admin/territory-sync',
  scope: 'portfolio',

  cachePaths: (_slug: string) => [
    'territory-teams.json',
  ],

  cacheTtlMs: TERRITORY_TTL_MS,

  async ensureFresh(_customerSlug: string): Promise<void> {
    try {
      const stat = statSync(TERRITORY_CACHE_PATH)
      if (Date.now() - stat.mtimeMs < TERRITORY_TTL_MS) return // fresh
    } catch { /* file doesn't exist — needs refresh */ }

    await this.syncNow!('')
  },

  async fetch(_customerName: string): Promise<void> {
    await this.syncNow!('')
  },

  async syncNow(_customerName: string): Promise<void> {
    const { runTerritorySyncOrchestration } = await import('../territory-sync.ts')
    const result = await runTerritorySyncOrchestration()
    FeatureModuleRegistry.recordOutcome('territory', {
      success: true,
      recordCount: result.added + result.unchanged,
    })
  },

  async cleanup(_customerName: string): Promise<void> {
    // no-op — territory data is portfolio-wide
  },
})
