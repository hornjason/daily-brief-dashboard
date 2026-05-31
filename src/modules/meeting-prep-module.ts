// src/modules/meeting-prep-module.ts
// GitHub Issue #229 — Meeting Prep feature module registration

import { FeatureModuleRegistry } from '../feature-module-registry.ts'

FeatureModuleRegistry.register({
  name: 'meeting-prep',
  refreshEndpoint: '/api/customer/_global/modules/meeting-prep/sync',

  scope: 'both',
  cacheTtlMs: undefined, // no TTL — generation is on-demand

  async ensureFresh(_customerSlug: string): Promise<void> {
    // No-op — meeting prep generation is on-demand
  },

  nav: {
    label: 'Meeting Prep',
    icon: 'FileText',
    group: 'actions',
    path: '/dashboard/meeting-prep',
    order: 20,
  },

  accountTab: {
    label: 'Prep',
    icon: 'FileText',
    order: 15,
  },

  cachePaths: (slug: string) => [
    `data/cache/meeting-prep/${slug}.json`,
  ],

  driveArtifacts: (slug: string) => [
    `${slug}/Meeting Prep/`,
  ],

  refreshInterval: null, // on-demand only

  async fetch(_customerName: string): Promise<void> {
    // No-op — meeting prep is on-demand only
    return Promise.resolve()
  },

  async cleanup(customerName: string): Promise<void> {
    const { toSlug } = await import('../cache-layer')
    const { readdirSync, unlinkSync, existsSync } = await import('fs')
    const { resolve } = await import('path')

    const slug = toSlug(customerName)
    const prepDir = resolve(process.env.CACHE_DIR ?? 'data/cache', 'meeting-prep')

    if (!existsSync(prepDir)) return

    const files = readdirSync(prepDir).filter(f => f.startsWith(`${slug}`) && f.endsWith('.json'))
    for (const file of files) {
      try {
        unlinkSync(resolve(prepDir, file))
        console.log(`[meeting-prep-module] Deleted ${file}`)
      } catch (e: any) {
        console.warn(`[meeting-prep-module] Failed to delete ${file}:`, e.message)
      }
    }
  },

  async syncNow(customerName: string): Promise<void> {
    // Meeting prep is triggered per-meeting, not per-customer
    // This is a no-op; generation happens via the API endpoint
    return Promise.resolve()
  },
})
