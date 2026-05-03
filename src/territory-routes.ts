// ── BKL-ARCH-13: Territory route module ─────────────────────────────────────
// Extracted from server.ts — three territory/pod/accounts endpoints.
// No logic changes; only relocation.

import { Hono } from 'hono'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { aes, customers } from './server-state.ts'
import { readSheetCache, readPipelineCache } from './cache-layer.ts'
import { readPodConfig, getAeNamesForPod } from './pod-config.ts'
import { computeAllAttentionScores } from './attention-score.ts'
import { sanitizeErr } from './utils.ts'

function getDataSourcesPath(): string {
  return process.env.CONFIG_DIR
    ? resolve(process.env.CONFIG_DIR, 'data-sources.json')
    : resolve(import.meta.dir, '../config/data-sources.json')
}

function getRhCasesCachePath(): string {
  const cacheDir = process.env.CACHE_DIR ?? resolve(import.meta.dir, '../cache')
  return resolve(cacheDir, 'cases.json')
}

export function createTerritoryRouter(): Hono {
  const app = new Hono()

  // GET /api/territory/notifications
  app.get('/api/territory/notifications', async (c) => {
    const notifPath = resolve(process.env.DATA_DIR ?? 'data', 'cache', 'territory-notifications.json')
    try {
      if (!existsSync(notifPath)) return c.json({ updatedAt: null, pending: [] })
      const data = JSON.parse(readFileSync(notifPath, 'utf-8'))
      return c.json(data)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/pods — BKL-UX52: Pod configuration endpoint
  app.get('/api/pods', (c) => {
    const pods = readPodConfig(getDataSourcesPath(), aes)
    return c.json({ pods: pods.map(p => ({ id: p.id, name: p.name, aeNames: p.aeNames })) })
  })

  // GET /api/accounts — All customers with cached sheet data merged
  // BKL-UX52: Accepts ?pod=<id> to filter by pod; adds attentionScore + attentionReasons
  app.get('/api/accounts', (c) => {
    const podId = c.req.query('pod') ?? undefined

    // Determine which AE names to include based on pod filter
    let aeNamesToInclude: Set<string> | null = null
    if (podId) {
      const pods = readPodConfig(getDataSourcesPath(), aes)
      const names = getAeNamesForPod(pods, podId)
      aeNamesToInclude = new Set(names)
    }

    // Filter customers by pod (AE membership)
    let filteredCustomers = customers.filter(cu => !cu.inactive)
    if (aeNamesToInclude) {
      filteredCustomers = filteredCustomers.filter(cu => cu.ae && aeNamesToInclude!.has(cu.ae))
    }

    // Compute attention scores for filtered customers
    let allCases: any[] = []
    try {
      const raw = JSON.parse(readFileSync(getRhCasesCachePath(), 'utf-8'))
      allCases = raw.cases ?? []
    } catch { /* no cases cache */ }

    const pipelineData = readPipelineCache()
    const allPipeline = pipelineData?.records ?? []

    const attentionScores = computeAllAttentionScores(filteredCustomers, allCases, allPipeline)

    const result = filteredCustomers.map((customer) => {
      const cached = readSheetCache(customer.name)
      const products = cached?.rows ?? []
      const distinctProducts = new Set(products.map((p) => p.productDescription)).size
      const totalLicenses = products.reduce((sum, p) => sum + p.quantity, 0)
      const attention = attentionScores.get(customer.name)

      return {
        name: customer.name,
        domain: customer.domain ?? '',
        accountNumbers: customer.accountNumbers ?? [],
        ae: customer.ae ?? '',
        segment: customer.segment ?? '',
        products,
        productCount: distinctProducts,
        totalLicenses,
        cachedAt: cached?.cachedAt ?? null,
        ccspCustomer: customer.ccspCustomer ?? false,
        attentionScore: attention?.attentionScore ?? 0,
        attentionReasons: attention?.attentionReasons ?? [],
        needsManualDomain: customer.needsManualDomain ?? false,
      }
    })
    return c.json({ customers: result })
  })

  return app
}
