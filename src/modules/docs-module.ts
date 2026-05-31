/**
 * Customer Docs Module — GitHub Issue #274
 * Migrates legacy customer docs corpus cache to registry signal contract.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'

FeatureModuleRegistry.register({
  name: 'customer-docs',
  refreshEndpoint: '/api/customer/_global/modules/customer-docs/sync',
  scope: 'customer',
  signalRole: 'trigger',
  signalAudience: 'customer-specific',
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days — read-only, no independent refresh

  async ensureFresh(_customerSlug: string): Promise<void> {
    // Data managed by product-intel pipeline — no independent refresh
  },

  cachePaths: () => [],
  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  async syncNow(): Promise<void> {},

  async signals(customerSlug: string): Promise<Signal[]> {
    const path = resolve(CACHE_DIR, 'product-intel', 'customer-docs', `${customerSlug}.json`)
    if (!existsSync(path)) return []

    let data: any
    try {
      data = JSON.parse(readFileSync(path, 'utf-8'))
    } catch { return [] }

    const files = data.files ?? []
    if (files.length === 0) return []

    return files.map((f: any) => ({
      source: 'customer-docs',
      type: 'intelligence' as const,
      headline: f.name ?? 'Document',
      detail: `${f.mimeType?.replace('application/vnd.google-apps.', '') ?? 'file'} | Modified: ${f.modifiedTime?.substring(0, 10) ?? 'unknown'}`,
      rawRelevance: 0.4,
      timestamp: f.modifiedTime ?? data.extractedAt ?? new Date().toISOString(),
      metadata: {
        customerSlug,
        fileName: f.name,
        mimeType: f.mimeType,
        hasContent: !!(f.textContent),
        contentLength: f.textContent?.length ?? 0,
      },
    }))
  },
})
