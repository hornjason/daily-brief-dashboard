// src/modules/campaigns-module.ts
// GitHub Issue #146 — Campaign feature module registration
// Phase 1: No-op implementation to prove registry pattern end-to-end

import { FeatureModuleRegistry } from '../feature-module-registry'

FeatureModuleRegistry.register({
  name: 'campaigns',

  cachePaths: (slug: string) => [
    `data/cache/campaigns/${slug}.json`,
  ],

  driveArtifacts: (slug: string) => [
    `${slug}/campaigns/`,
  ],

  notebookSources: true,

  refreshInterval: null,  // on-demand only

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
