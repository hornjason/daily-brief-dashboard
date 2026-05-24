/**
 * Cloud Marketplace Detail Routes
 * GitHub Issue #352 — Cloud marketplace drill-down
 *
 * Serves raw cloud marketplace cache data for expandable detail UI.
 * - GET /api/cloud-marketplace/details — all cloud sections with offerings, programs, incentives
 */

import { Hono } from 'hono'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const CACHE_PATH = resolve(CACHE_DIR, 'cloud-marketplace', 'latest.json')

export function createCloudMarketplaceRouter(): Hono {
  const app = new Hono()

  app.get('/api/cloud-marketplace/details', (c) => {
    if (!existsSync(CACHE_PATH)) {
      return c.json({ clouds: [], newsletterDate: null, cachedAt: null })
    }

    try {
      const raw = readFileSync(CACHE_PATH, 'utf-8')
      const cache = JSON.parse(raw)
      return c.json({
        clouds: cache.clouds ?? [],
        newsletterDate: cache.newsletterDate ?? null,
        cachedAt: cache.cachedAt ?? null,
      })
    } catch (e: any) {
      return c.json({ error: e.message }, 500)
    }
  })

  return app
}
