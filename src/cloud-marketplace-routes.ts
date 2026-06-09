/**
 * Cloud Marketplace Detail Routes
 * GitHub Issue #352, #453 — Cloud marketplace drill-down with customer-specific signals
 *
 * - GET /api/cloud-marketplace/details — raw global cache (legacy)
 * - GET /api/customer/:name/cloud-marketplace — customer-specific summary signals
 */

import { Hono } from 'hono'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { FeatureModuleRegistry } from './feature-module-registry.ts'
import { toSlug } from './cache-layer.ts'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const CACHE_PATH = resolve(CACHE_DIR, 'cloud-marketplace', 'latest.json')

export function createCloudMarketplaceRouter(): Hono {
  const app = new Hono()

  // Legacy global endpoint
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

  // #453 — Customer-specific cloud marketplace signals
  app.get('/api/customer/:name/cloud-marketplace', async (c) => {
    const customerName = c.req.param('name')
    const customerSlug = toSlug(customerName)

    try {
      // Get cloud-marketplace module signals for this customer
      const mod = FeatureModuleRegistry.get('cloud-marketplace')
      if (!mod || !mod.signals) {
        return c.json({ providers: [], newsletterDate: null, cachedAt: null })
      }

      const signals = await mod.signals(customerSlug)

      // Filter to summary signals only
      const summarySignals = signals.filter(s => s.metadata?.offeringType === 'summary')

      // Sort: hasCloudSpend first, then hasCloudIntel
      summarySignals.sort((a, b) => {
        const aSpend = a.metadata?.hasCloudSpend ?? false
        const bSpend = b.metadata?.hasCloudSpend ?? false
        if (aSpend !== bSpend) return bSpend ? 1 : -1
        const aIntel = a.metadata?.hasCloudIntel ?? false
        const bIntel = b.metadata?.hasCloudIntel ?? false
        if (aIntel !== bIntel) return bIntel ? 1 : -1
        return 0
      })

      // Map to provider response shape
      const providers = summarySignals.map(s => ({
        provider: s.metadata?.provider ?? 'Unknown',
        acv: s.metadata?.acvPlus ?? 0,
        hasCloudSpend: s.metadata?.hasCloudSpend ?? false,
        hasCloudIntel: s.metadata?.hasCloudIntel ?? false,
        offerings: s.metadata?.offerings ?? [],
        programs: s.metadata?.programs ?? [],
        incentives: s.metadata?.incentives ?? [],
        newCountries: s.metadata?.newCountries ?? [],
        partnerships: s.metadata?.partnerships ?? [],
      }))

      // Read cache file for newsletterDate, cachedAt, and cmFolderId
      let newsletterDate: string | null = null
      let cachedAt: string | null = null
      let driveFolderUrl: string | null = null
      if (existsSync(CACHE_PATH)) {
        try {
          const cache = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'))
          newsletterDate = cache.newsletterDate ?? null
          cachedAt = cache.cachedAt ?? null
          if (cache.cmFolderId) {
            driveFolderUrl = `https://drive.google.com/drive/folders/${cache.cmFolderId}`
          }
        } catch {
          // Ignore cache read failures
        }
      }

      const isStale = cachedAt ? (Date.now() - new Date(cachedAt).getTime()) > 7 * 24 * 60 * 60 * 1000 : true
      return c.json({ providers, newsletterDate, cachedAt, driveFolderUrl, isStale })
    } catch (e: any) {
      return c.json({ error: e.message }, 500)
    }
  })

  return app
}
