// src/modules/ma-module.ts
// GitHub Issue #218 — M&A activity signal module
// Reads cached M&A data (mergers, acquisitions, partnerships, expansions)
// and produces signals per customer for intelligence, campaigns, meeting prep.

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { toSlug } from '../cache-layer.ts'
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const MA_CACHE_PATH = resolve(CACHE_DIR, 'ma-activity.json')

interface MARecord {
  account: string
  date: string
  acquiredEntity: string
  description: string
  dealType: 'acquisition' | 'merger' | 'partnership' | 'expansion'
}

interface MACache {
  records: MARecord[]
  lastUpdated: string
}

function readMACache(): MACache | null {
  if (!existsSync(MA_CACHE_PATH)) return null
  try {
    return JSON.parse(readFileSync(MA_CACHE_PATH, 'utf-8'))
  } catch {
    return null
  }
}

function recencyScore(dateStr: string): number {
  const ageMs = Date.now() - new Date(dateStr).getTime()
  const months = ageMs / (30 * 24 * 60 * 60 * 1000)
  if (months <= 6) return 0.9
  if (months <= 12) return 0.7
  if (months <= 24) return 0.5
  return 0.3
}

FeatureModuleRegistry.register({
  name: 'mergers-acquisitions',
  displayName: 'M&A Activity',
  refreshEndpoint: '/api/refresh/ma',
  scope: 'customer',
  refreshInterval: 7 * 24 * 60 * 60 * 1000, // weekly

  cachePaths: () => ['data/cache/ma-activity.json'],

  async fetch(): Promise<void> {
    // M&A data is populated by external sheet sync — no per-customer fetch
  },

  async cleanup(): Promise<void> {},

  async syncNow(): Promise<void> {},

  async signals(customerSlug: string): Promise<Signal[]> {
    const cache = readMACache()
    if (!cache?.records?.length) return []

    const customerRecords = cache.records.filter(r =>
      toSlug(r.account) === customerSlug
    )
    if (customerRecords.length === 0) return []

    return customerRecords.map((r): Signal => ({
      source: 'mergers-acquisitions',
      type: 'acquisition',
      headline: `Acquired ${r.acquiredEntity} — ${r.description.slice(0, 80)}`,
      detail: r.description,
      rawRelevance: recencyScore(r.date),
      timestamp: r.date,
      metadata: {
        customerSlug,
        acquiredEntity: r.acquiredEntity,
        dealType: r.dealType,
      },
    }))
  },
})
