/**
 * Account Plan Module — GitHub Issue #274
 * Migrates legacy account plan cache to registry signal contract.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'

FeatureModuleRegistry.register({
  name: 'account-plan',
  scope: 'customer',
  cachePaths: () => [],
  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  async syncNow(): Promise<void> {},

  async signals(customerSlug: string): Promise<Signal[]> {
    const path = resolve(CACHE_DIR, 'intelligence', `${customerSlug}-account-plan.md`)
    if (!existsSync(path)) return []

    let content: string
    try {
      content = readFileSync(path, 'utf-8')
    } catch { return [] }

    if (!content.trim()) return []

    const mtime = statSync(path).mtime.toISOString()
    const firstLine = content.split('\n').find(l => l.trim()) ?? 'Account Plan'

    return [{
      source: 'account-plan',
      type: 'account-plan',
      headline: firstLine.replace(/^#+\s*/, '').substring(0, 80),
      detail: content.substring(0, 300),
      score: 0.7,
      timestamp: mtime,
      metadata: { contentLength: content.length },
    }]
  },
})
