// src/modules/tools-module.ts
// GitHub Issue #146 — Business value tools feature module registration
// GitHub Issue #148 — Upload artifact API (tools-routes.ts)
// Phase 1: No-op fetch/syncNow; cleanup deletes local cache

import { FeatureModuleRegistry } from '../feature-module-registry'
import { existsSync, unlinkSync } from 'fs'
import { resolve } from 'path'

FeatureModuleRegistry.register({
  name: 'tools',

  cachePaths: (slug: string) => [
    `data/cache/tools/${slug}.json`,
  ],

  driveArtifacts: (slug: string) => [
    `${slug}/tools/`,
  ],

  notebookSources: true,

  refreshInterval: null,  // on-demand only

  async fetch(customerName: string): Promise<void> {
    // No-op: Phase 1 shell only
    return Promise.resolve()
  },

  async cleanup(customerName: string): Promise<void> {
    // Delete local cache file if it exists
    const slug = customerName.toLowerCase().replace(/\s+/g, '-')
    const CACHE_DIR = process.env.CACHE_DIR ?? resolve(import.meta.dir, '../../cache')
    const cachePath = resolve(CACHE_DIR, 'tools', `${slug}.json`)

    if (existsSync(cachePath)) {
      unlinkSync(cachePath)
      console.log(`[tools-module] Deleted cache file: ${cachePath}`)
    }
  },

  async syncNow(customerName: string): Promise<void> {
    // No-op: NotebookLM sync is issue #150
    return Promise.resolve()
  },
})
