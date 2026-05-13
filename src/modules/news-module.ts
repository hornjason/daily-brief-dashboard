// src/modules/news-module.ts
// GitHub Issue #153 — News radar feature module registration
// Implements news search, caching, and cleanup

import { FeatureModuleRegistry } from '../feature-module-registry'
import { newsProvider } from '../news-provider.ts'
import { toSlug } from '../cache-layer.ts'
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = resolve(process.env.DATA_DIR ?? 'data', 'cache', 'news')

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true })
}

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
    const articles = await newsProvider.searchNews(customerName)
    const slug = toSlug(customerName)
    const cachePath = resolve(CACHE_DIR, `${slug}.json`)

    const entry = {
      articles,
      lastUpdated: new Date().toISOString(),
    }

    writeFileSync(cachePath, JSON.stringify(entry, null, 2), { mode: 0o600 })
  },

  async cleanup(customerName: string): Promise<void> {
    const slug = toSlug(customerName)
    const cachePath = resolve(CACHE_DIR, `${slug}.json`)

    if (existsSync(cachePath)) {
      unlinkSync(cachePath)
    }
  },

  async syncNow(customerName: string): Promise<void> {
    // Same as fetch for this module
    await this.fetch(customerName)
  },
})
