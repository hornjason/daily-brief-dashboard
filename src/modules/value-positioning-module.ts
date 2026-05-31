/**
 * Value Positioning Module — GitHub Issue #264
 * Registers the proactive value positioning tool with FeatureModuleRegistry.
 * On-demand only (no scheduled refresh). Customer-scoped.
 */

import { FeatureModuleRegistry } from '../feature-module-registry.ts'

FeatureModuleRegistry.register({
  name: 'value-positioning',
  displayName: 'Value Positioning',
  refreshEndpoint: '/api/customer/_global/modules/value-positioning/sync',
  signalRole: 'trigger',
  signalAudience: 'customer-specific',
  scope: 'customer',
  cacheTtlMs: undefined, // no TTL — config-driven

  async ensureFresh(_customerSlug: string): Promise<void> {
    // No-op — value positioning is config-driven, no independent cache
  },

  refreshInterval: null, // on-demand only

  cachePaths: (slug: string) => [
    `data/cache/intelligence/${slug}-value-positioning.json`,
  ],

  driveArtifacts: (slug: string) => [
    `${slug}/Value Positioning/`,
  ],

  async fetch(_customerName: string): Promise<void> {
    return Promise.resolve()
  },

  async cleanup(customerName: string): Promise<void> {
    const { toSlug } = await import('../cache-layer.ts')
    const { existsSync, unlinkSync } = await import('fs')
    const { resolve } = await import('path')

    const slug = toSlug(customerName)
    const cacheDir = process.env.CACHE_DIR ?? 'data/cache'
    const path = resolve(cacheDir, 'intelligence', `${slug}-value-positioning.json`)

    if (existsSync(path)) {
      try {
        unlinkSync(path)
        console.log(`[value-positioning-module] Deleted ${path}`)
      } catch (e: any) {
        console.warn(`[value-positioning-module] Failed to delete ${path}:`, e.message)
      }
    }
  },

  async syncNow(_customerName: string): Promise<void> {
    return Promise.resolve()
  },
})
