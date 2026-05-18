// src/modules/campaigns-module.ts
// GitHub Issue #146 — Campaign feature module registration
// Phase 1: No-op implementation to prove registry pattern end-to-end

import { FeatureModuleRegistry, type NavDeclaration, type AccountTabDeclaration, type ModuleScope } from '../feature-module-registry'

FeatureModuleRegistry.register({
  name: 'campaigns',

  scope: 'both',

  nav: {
    label: 'Campaigns',
    icon: 'Mail',
    group: 'actions',
    path: '/dashboard/campaigns',
    order: 10,
  },

  accountTab: {
    label: 'Campaigns',
    icon: 'Mail',
    order: 10,
  },

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
    // Delete all campaign cache files for this customer
    const { toSlug } = await import('../cache-layer')
    const { readdirSync, unlinkSync, existsSync } = await import('fs')
    const { resolve } = await import('path')

    const slug = toSlug(customerName)
    const campaignsDir = resolve(process.env.CACHE_DIR ?? 'data/cache', 'campaigns')

    if (!existsSync(campaignsDir)) return

    const files = readdirSync(campaignsDir).filter(f => f.startsWith(`${slug}-`) && f.endsWith('.json'))
    for (const file of files) {
      try {
        unlinkSync(resolve(campaignsDir, file))
        console.log(`[campaigns-module] Deleted ${file}`)
      } catch (e: any) {
        console.warn(`[campaigns-module] Failed to delete ${file}:`, e.message)
      }
    }
  },

  async syncNow(customerName: string): Promise<void> {
    // No-op: Phase 1 shell only
    return Promise.resolve()
  },
})
