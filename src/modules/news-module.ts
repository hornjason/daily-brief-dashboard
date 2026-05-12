// src/modules/news-module.ts
// GitHub Issue #146 — News radar feature module registration
// Phase 1: No-op implementation to prove registry pattern end-to-end

import { FeatureModuleRegistry } from '../feature-module-registry'

FeatureModuleRegistry.register({
  name: 'news-radar',

  cachePaths: (slug: string) => [
    `data/cache/news/${slug}.json`,
  ],

  driveArtifacts: (slug: string) => [
    `${slug}/news/`,
  ],

  notebookSources: true,

  refreshInterval: 86_400_000,  // 24 hours

  async fetch(customerName: string): Promise<void> {
    // No-op: Phase 1 shell only
    return Promise.resolve()
  },

  async cleanup(customerName: string): Promise<void> {
    // No-op: Phase 1 shell only
    return Promise.resolve()
  },

  async syncNow(customerName: string): Promise<void> {
    // No-op: Phase 1 shell only
    return Promise.resolve()
  },
})
