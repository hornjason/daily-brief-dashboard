/**
 * Emails Module — GitHub Issue #274
 * Migrates legacy email cache to registry signal contract.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'

FeatureModuleRegistry.register({
  name: 'emails',
  scope: 'customer',
  cachePaths: () => [],
  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  async syncNow(): Promise<void> {},

  async signals(customerSlug: string): Promise<Signal[]> {
    const path = resolve(CACHE_DIR, `${customerSlug}-emails.json`)
    if (!existsSync(path)) return []

    let emails: any[]
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'))
      emails = Array.isArray(raw) ? raw : raw.emails ?? []
    } catch { return [] }

    if (emails.length === 0) return []

    return emails.slice(0, 50).map(e => ({
      source: 'emails',
      type: 'email' as const,
      headline: e.subject ?? e.snippet?.substring(0, 80) ?? 'Email',
      detail: `From: ${e.from ?? 'Unknown'} | ${e.date ?? ''}${e.classification ? ` | ${e.classification}` : ''}`,
      rawRelevance: e.classification === 'action_required' ? 0.8 : e.classification === 'important' ? 0.6 : 0.4,
      timestamp: e.date ?? new Date().toISOString(),
      metadata: {
        customerSlug,
        from: e.from,
        to: e.to,
        classification: e.classification,
        threadId: e.threadId,
      },
    }))
  },
})
