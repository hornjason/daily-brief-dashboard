/**
 * Product Intelligence Routes — Wave 4 Phase 1
 *
 * REST API for product release radar data.
 * Separate from product-intelligence.ts (BKL-AI16 Q&A routes in customer-routes.ts).
 */

import type { Hono } from 'hono'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import {
  getAllProductSummaries,
  getCachedSummary,
  fetchProductSummary,
  getProductAlerts,
  acknowledgeAlert,
  loadProductConfig,
  loadProductIntelConfig,
  saveProductConfig,
} from './product-release-radar.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { sanitizeErr, sanitizePromptInput, isValidDriveFolderId } from './utils.ts'
import { refreshDriveCorpus, getCachedDriveCorpus } from './product-drive-ingest.ts'
import { getFeatureCache, extractProductFeatures, enrichFeatures, refreshAllFeatures, isAllowedUrl } from './product-feature-radar.ts'
import {
  getCachedCustomerProductIntel,
  generateCustomerProductIntel,
  toCustomerSlug,
} from './customer-product-intel.ts'
import { readSheetCache, readPipelineCache } from './cache-layer.ts'
import { fetchCases } from './redhat.ts'
import { customers } from './server-state.ts'
import { getCachedCustomerDocsCorpus } from './customer-docs-corpus.ts'
import { normalizeForQuery } from './utils.ts'

// ── BKL-S16: In-memory mutex for Gemini generation endpoints ──────────────────
// Bun is single-threaded — a Set of active keys prevents concurrent duplicate calls.
// Keys: "intel:{slug}:{customerSlug}" | "refresh:{slug}" | "features:{slug}"
const _generatingKeys = new Set<string>()

export function registerProductIntelRoutes(app: Hono): void {

  // GET /api/products — all cached summaries (no fetch, reads cache only)
  app.get('/api/products', (c) => {
    try {
      const summaries = getAllProductSummaries()
      return c.json(summaries)
    } catch (e: any) {
      console.error('[product-intel] GET /api/products error:', sanitizeErr(e))
      return c.json({ error: 'Failed to load product summaries' }, 500)
    }
  })

  // GET /api/products/config — full product config array (for admin UI)
  // NOTE: registered BEFORE /api/products/:slug — Hono matches in registration order
  app.get('/api/products/config', (c) => {
    try {
      const config = loadProductConfig()
      return c.json(config)
    } catch (e: any) {
      console.error('[product-intel] GET /api/products/config error:', sanitizeErr(e))
      return c.json({ error: 'Failed to load product config' }, 500)
    }
  })

  // GET /api/products/alerts — unacknowledged + all product alerts
  // NOTE: must be registered BEFORE /api/products/:slug to avoid ":slug" matching "alerts"
  app.get('/api/products/alerts', (c) => {
    try {
      const alerts = getProductAlerts()
      return c.json(alerts)
    } catch (e: any) {
      console.error('[product-intel] GET /api/products/alerts error:', sanitizeErr(e))
      return c.json({ error: 'Failed to load product alerts' }, 500)
    }
  })

  // POST /api/products/alerts/:id/acknowledge
  app.post('/api/products/alerts/:id/acknowledge', async (c) => {
    const id = c.req.param('id')
    try {
      acknowledgeAlert(id)
      return c.json({ ok: true })
    } catch (e: any) {
      console.error(`[product-intel] POST /api/products/alerts/${id}/acknowledge error:`, sanitizeErr(e))
      return c.json({ error: 'Failed to acknowledge alert' }, 500)
    }
  })

  // POST /api/products/setup-drive-folders — bootstrap Drive subfolders for each product
  // NOTE: registered BEFORE /api/products/:slug to avoid ":slug" matching "setup-drive-folders"
  app.post('/api/products/setup-drive-folders', async (c) => {
    try {
      const config = loadProductIntelConfig()
      const parentFolderId = config.driveParentFolderId
      if (!parentFolderId) {
        return c.json({ error: 'driveParentFolderId not set in product-intel-config.json' }, 400)
      }
      if (!isValidDriveFolderId(parentFolderId)) {
        return c.json({ error: 'Invalid driveParentFolderId in config' }, 500)
      }

      const drive = google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) })
      const products = [...config.products]
      const results: { slug: string; driveFolder: string; created: boolean }[] = []

      for (let i = 0; i < products.length; i++) {
        const product = products[i]

        // Skip if already configured
        if (product.driveFolder) {
          results.push({ slug: product.slug, driveFolder: product.driveFolder, created: false })
          continue
        }

        // Check if folder already exists in parent (same pattern as bootstrap-orchestrator.ts lines 347-360)
        const safeName = product.slug.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
        const existing = await drive.files.list({
          q: `name='${safeName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'files(id, name)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }).catch(() => ({ data: { files: [] } }))

        if (existing.data.files?.length) {
          const folderId = existing.data.files[0].id!
          products[i] = { ...product, driveFolder: folderId }
          results.push({ slug: product.slug, driveFolder: folderId, created: false })
          console.log(`[product-intel] setup-drive-folders: reusing existing folder for ${product.slug} (${folderId})`)
        } else {
          const folder = await drive.files.create({
            requestBody: {
              name: product.slug,
              mimeType: 'application/vnd.google-apps.folder',
              parents: [parentFolderId],
            },
            supportsAllDrives: true,
            fields: 'id',
          })
          const folderId = folder.data.id!
          products[i] = { ...product, driveFolder: folderId }
          results.push({ slug: product.slug, driveFolder: folderId, created: true })
          console.log(`[product-intel] setup-drive-folders: created folder for ${product.slug} (${folderId})`)
        }
      }

      saveProductConfig(products)
      return c.json({ products: results })
    } catch (e: any) {
      console.error('[product-intel] POST /api/products/setup-drive-folders error:', sanitizeErr(e))
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // POST /api/products/ingest-slides — ingest Drive corpus for a product
  // NOTE: registered BEFORE /api/products/:slug to avoid ":slug" matching "ingest-slides"
  app.post('/api/products/ingest-slides', async (c) => {
    let body: { slug?: string }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
    const slug = body?.slug
    if (!slug) return c.json({ error: 'slug is required' }, 400)
    const products = loadProductConfig()
    const product = products.find(p => p.slug === slug)
    if (!product) return c.json({ error: `Unknown product: ${slug}` }, 400)
    if (!product.driveFolder) return c.json({ error: `driveFolder is null for ${slug}` }, 400)
    try {
      const corpus = await refreshDriveCorpus(slug)
      if (!corpus) return c.json({ error: `No exportable files found for ${slug}` }, 400)
      const totalChars = corpus.files.reduce((sum, f) => sum + f.textContent.length, 0)
      // Auto-extract features after slide ingest (fire-and-forget)
      extractProductFeatures(slug).then(cache => {
        if (cache) enrichFeatures(slug).catch(e => console.warn('[feature-radar] enrichment failed:', e?.message))
      }).catch(e => console.warn('[feature-radar] extraction failed after ingest:', e?.message))
      return c.json({ slug, filesProcessed: corpus.files.length, textChars: totalChars, corpusHash: corpus.corpusHash, sources: corpus.files.map(f => f.name) })
    } catch (e: any) {
      console.error(`[product-intel] ingest-slides error for ${slug}:`, sanitizeErr(e))
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/products/slides-status — read cached Drive corpus without calling Drive
  // NOTE: registered BEFORE /api/products/:slug to avoid ":slug" matching "slides-status"
  app.get('/api/products/slides-status', (c) => {
    const slug = c.req.query('slug')
    if (!slug) return c.json({ error: 'slug query param is required' }, 400)
    try {
      const corpus = getCachedDriveCorpus(slug)
      if (!corpus) return c.json(null)
      return c.json({ slug: corpus.slug, files: corpus.files.map(f => ({ name: f.name, fileId: f.fileId, modifiedTime: f.modifiedTime })), corpusHash: corpus.corpusHash, extractedAt: corpus.extractedAt })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/products/:slug/intel/:customerSlug — cached customer intel (no generation)
  // NOTE: registered BEFORE /api/products/:slug to avoid ":slug" matching "intel"
  app.get('/api/products/:slug/intel/:customerSlug', (c) => {
    const slug         = c.req.param('slug')
    const customerSlug = c.req.param('customerSlug')
    if (!/^[a-z0-9-]+$/.test(slug) || !/^[a-z0-9-]+$/.test(customerSlug)) return c.json({ error: 'Invalid slug' }, 400)
    try {
      const intel = getCachedCustomerProductIntel(slug, customerSlug)
      if (!intel) return c.json({ error: `No cached intel for ${slug}/${customerSlug}` }, 404)
      return c.json(intel)
    } catch (e: any) {
      console.error(`[product-intel] GET /api/products/${slug}/intel/${customerSlug} error:`, sanitizeErr(e))
      return c.json({ error: 'Failed to read customer intel cache' }, 500)
    }
  })

  // POST /api/products/:slug/intel/:customerSlug/generate — generate (or regenerate) customer intel
  app.post('/api/products/:slug/intel/:customerSlug/generate', async (c) => {
    const slug         = c.req.param('slug')
    const customerSlug = c.req.param('customerSlug')
    if (!/^[a-z0-9-]+$/.test(slug) || !/^[a-z0-9-]+$/.test(customerSlug)) {
      return c.json({ error: 'Invalid slug' }, 400)
    }
    const mutexKey = `intel:${slug}:${customerSlug}`
    if (_generatingKeys.has(mutexKey)) {
      return c.json({ error: `Generation already in progress for ${slug}/${customerSlug}` }, 409)
    }
    _generatingKeys.add(mutexKey)
    try {
      // Resolve product config
      const products = loadProductConfig()
      const product  = products.find(p => p.slug === slug)
      if (!product) return c.json({ error: `Unknown product: ${slug}` }, 400)
      // Drive corpus is optional (Phase 2) — products without driveFolder use release-notes-only

      // Resolve product summary
      const productSummary = getCachedSummary(slug)
      if (!productSummary) return c.json({ error: `No cached summary for ${slug} — run POST /api/products/${slug}/refresh first` }, 400)

      // Drive corpus — concat all file text; empty string if no corpus yet
      const corpus    = getCachedDriveCorpus(slug)
      const slidesText = corpus ? corpus.files.map(f => f.textContent).join('\n\n') : ''

      // Resolve customer by customerSlug — match against customers array
      const customer = customers.find(cu => toCustomerSlug(cu.name) === customerSlug)
      const customerName = customer?.name ?? customerSlug  // fallback: use slug as display name

      // Wave 5: pass ALL subscriptions unfiltered — let Gemini determine relevance
      const sheetCache    = readSheetCache(customerName)
      const subscriptions = sheetCache?.rows ?? []

      // Wave 5: pass ALL customer cases unfiltered — let Gemini determine relevance
      let supportCases: any[] = []
      try {
        const allCases    = await fetchCases().catch(() => [])
        const accountNums = (customer?.accountNumbers ?? []).map(String)
        supportCases = accountNums.length
          ? allCases.filter(c => accountNums.includes(String(c.accountNumber)))
          : []
      } catch (e: any) {
        console.warn(`[product-intel] could not load cases for ${customerName} — proceeding with empty array:`, e?.message)
      }

      // Wave 5: customer docs corpus (cached at brief-gen time, zero Drive API calls)
      const docsCorpus     = getCachedCustomerDocsCorpus(customerSlug)
      const customerDocsText = docsCorpus
        ? docsCorpus.files.map(f => `[${f.name}]\n${f.textContent}`).join('\n\n')
        : ''
      const customerDocsHash = docsCorpus?.corpusHash ?? ''

      // Pipeline context
      const needle = normalizeForQuery(customerName.toLowerCase())
      const pipelineCache = readPipelineCache()
      const pipelineRecords = pipelineCache
        ? pipelineCache.records.filter(r => {
            const hay = normalizeForQuery(r.accountName)
            return hay.includes(needle) || needle.includes(hay)
          }).filter(r => r.forecastCategory.toLowerCase() !== 'closed')
        : []
      const opportunityNote = pipelineRecords.length
        ? pipelineRecords.map(r => `${sanitizePromptInput(r.oppName ?? '', 200)}: $${r.acv?.toLocaleString() ?? '?'} ACV, close ${r.closeDate ?? '?'}, ${r.forecastCategory}`).join('\n')
        : undefined

      // Load feature radar cache for this product (Phase 3: feature talking points)
      const featureCache = getFeatureCache(slug)
      const productFeatures = featureCache?.features.map(f => ({
        name: f.name,
        status: f.status,
        description: f.description,
        tags: f.tags,
        versionIntroduced: f.versionIntroduced,
      }))
      const productFeaturesHash = featureCache?.corpusHash

      const intel = await generateCustomerProductIntel({
        slug,
        productSummary,
        slidesText,
        customerName,
        subscriptions,
        supportCases,
        customerDocsText,
        customerDocsHash,
        opportunityNote,
        productFeatures,
        productFeaturesHash,
      })

      return c.json(intel)
    } catch (e: any) {
      console.error(`[product-intel] POST /api/products/${slug}/intel/${customerSlug}/generate error:`, sanitizeErr(e))
      return c.json({ error: sanitizeErr(e) }, 500)
    } finally {
      _generatingKeys.delete(mutexKey)
    }
  })

  // ── Feature Radar Routes ──────────────────────────────────────────────────

  // GET /api/products/features — all products' feature caches
  // NOTE: registered BEFORE /api/products/:slug to avoid ":slug" matching "features"
  app.get('/api/products/features', (c) => {
    try {
      const products = loadProductConfig()
      const caches: any[] = []
      for (const p of products) {
        const cache = getFeatureCache(p.slug)
        if (cache) caches.push(cache)
      }
      return c.json(caches)
    } catch (e: any) {
      console.error('[product-intel] GET /api/products/features error:', sanitizeErr(e))
      return c.json({ error: 'Failed to load feature caches' }, 500)
    }
  })

  // POST /api/products/features/refresh-all — extract + enrich features for all products
  // NOTE: registered BEFORE /api/products/:slug to avoid ":slug" matching "features"
  app.post('/api/products/features/refresh-all', async (c) => {
    const mutexKey = 'refresh-all'
    if (_generatingKeys.has(mutexKey)) {
      return c.json({ error: 'Feature refresh-all already in progress' }, 409)
    }
    _generatingKeys.add(mutexKey)
    try {
      await refreshAllFeatures()
      const products = loadProductConfig()
      const caches: any[] = []
      for (const p of products) {
        const cache = getFeatureCache(p.slug)
        if (cache) caches.push({ slug: p.slug, featureCount: cache.features.length, extractedAt: cache.extractedAt, enrichedAt: cache.enrichedAt })
      }
      return c.json({ ok: true, products: caches })
    } catch (e: any) {
      console.error('[product-intel] POST /api/products/features/refresh-all error:', sanitizeErr(e))
      return c.json({ error: sanitizeErr(e) }, 500)
    } finally {
      _generatingKeys.delete(mutexKey)
    }
  })

  // GET /api/products/:slug/territory-summary — aggregate customer intel for a product across territory
  app.get('/api/products/:slug/territory-summary', (c) => {
    const slug = c.req.param('slug')
    if (!/^[a-z0-9-]+$/.test(slug)) return c.json({ error: 'Invalid slug' }, 400)
    try {
      const DATA_DIR = process.env.DATA_DIR ?? resolve(import.meta.dir, '../data')
      const CACHE_DIR = resolve(process.env.CACHE_DIR ?? resolve(DATA_DIR, 'cache'), 'product-intel')
      // Defense-in-depth: ensure CACHE_DIR is within expected /data volume (Rook finding BKL-W5-RK-F1)
      if (!CACHE_DIR.startsWith('/data')) {
        console.error('territory-summary: CACHE_DIR is not within expected /data volume:', CACHE_DIR)
        return c.json({ error: 'Server configuration error' }, 500)
      }
      const intelDir = resolve(CACHE_DIR, `${slug}-customer-intel`)
      const totalCustomers = customers.length

      const coverageBreakdown: Record<string, number> = { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 }
      const priorityActions: { action: string; confidence: string; customer: string }[] = []
      let lastUpdated: string | null = null

      if (existsSync(intelDir)) {
        const files = readdirSync(intelDir).filter(f => f.endsWith('.json'))
        for (const file of files) {
          try {
            const raw = JSON.parse(readFileSync(resolve(intelDir, file), 'utf-8'))
            const intel = raw.intel ?? raw
            const score = intel.relevanceScore ?? 'NONE'
            if (score in coverageBreakdown) coverageBreakdown[score]++
            if (intel.priorityAction && intel.priorityAction !== 'Analysis unavailable') {
              priorityActions.push({
                action: intel.priorityAction,
                confidence: score,
                customer: intel.customer ?? file.replace('.json', ''),
              })
            }
            const ts = raw.cachedAt ?? intel.generatedAt
            if (ts && (!lastUpdated || ts > lastUpdated)) lastUpdated = ts
          } catch { /* skip corrupt cache files */ }
        }
      }

      const coverageCount = coverageBreakdown.HIGH + coverageBreakdown.MEDIUM + coverageBreakdown.LOW + coverageBreakdown.NONE

      // Top 3 priority actions: prefer HIGH confidence, then MEDIUM, then LOW
      const confidenceOrder: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0 }
      const topPriorityActions = priorityActions
        .sort((a, b) => (confidenceOrder[b.confidence] ?? 0) - (confidenceOrder[a.confidence] ?? 0))
        .slice(0, 3)
        .map(p => ({ action: p.action, customer: p.customer, confidence: p.confidence }))

      // Slide corpus status
      const corpus = getCachedDriveCorpus(slug)
      const slidesStatus = corpus
        ? { filesIngested: corpus.files.length, lastRefreshed: corpus.extractedAt }
        : { filesIngested: 0, lastRefreshed: null }

      // Feature radar status
      const featureCache = getFeatureCache(slug)
      const featureStatus = featureCache
        ? { featureCount: featureCache.features.length, extractedAt: featureCache.extractedAt, enrichedAt: featureCache.enrichedAt }
        : null

      return c.json({
        slug,
        coverageCount,
        totalCustomers,
        coverageBreakdown,
        topPriorityActions,
        lastUpdated,
        slidesStatus,
        featureStatus,
      })
    } catch (e: any) {
      console.error(`[product-intel] GET /api/products/${slug}/territory-summary error:`, sanitizeErr(e))
      return c.json({ error: 'Failed to generate territory summary' }, 500)
    }
  })

  // GET /api/products/:slug/features — feature cache for a single product
  app.get('/api/products/:slug/features', (c) => {
    const slug = c.req.param('slug')
    if (!/^[a-z0-9-]+$/.test(slug)) return c.json({ error: 'Invalid slug' }, 400)
    try {
      const cache = getFeatureCache(slug)
      if (!cache) return c.json({ error: `No feature cache for ${slug}` }, 404)
      return c.json(cache)
    } catch (e: any) {
      console.error(`[product-intel] GET /api/products/${slug}/features error:`, sanitizeErr(e))
      return c.json({ error: 'Failed to load feature cache' }, 500)
    }
  })

  // POST /api/products/:slug/features/refresh — extract + enrich features for one product
  app.post('/api/products/:slug/features/refresh', async (c) => {
    const slug = c.req.param('slug')
    const mutexKey = `features:${slug}`
    if (_generatingKeys.has(mutexKey)) {
      return c.json({ error: `Feature refresh already in progress for ${slug}` }, 409)
    }
    _generatingKeys.add(mutexKey)
    try {
      const cache = await extractProductFeatures(slug)
      if (!cache) return c.json({ error: `Extraction failed for ${slug} — no Drive corpus?` }, 400)
      await enrichFeatures(slug)
      const updated = getFeatureCache(slug)
      return c.json(updated)
    } catch (e: any) {
      console.error(`[product-intel] POST /api/products/${slug}/features/refresh error:`, sanitizeErr(e))
      return c.json({ error: sanitizeErr(e) }, 500)
    } finally {
      _generatingKeys.delete(mutexKey)
    }
  })

  // GET /api/products/:slug — single cached summary or 404
  app.get('/api/products/:slug', (c) => {
    const slug = c.req.param('slug')
    try {
      // Validate slug against known config
      const config = loadProductConfig()
      const known  = config.find(p => p.slug === slug)
      if (!known) return c.json({ error: `Unknown product: ${slug}` }, 404)

      const summary = getCachedSummary(slug)
      if (!summary) return c.json({ error: `No cached data for ${slug} — call POST /api/products/${slug}/refresh` }, 404)

      return c.json(summary)
    } catch (e: any) {
      console.error(`[product-intel] GET /api/products/${slug} error:`, sanitizeErr(e))
      return c.json({ error: 'Failed to load product summary' }, 500)
    }
  })

  // POST /api/products/:slug/refresh — fetch + synthesize, return updated summary
  app.post('/api/products/:slug/refresh', async (c) => {
    const slug = c.req.param('slug')
    const mutexKey = `refresh:${slug}`
    if (_generatingKeys.has(mutexKey)) {
      return c.json({ error: `Refresh already in progress for ${slug}` }, 409)
    }
    _generatingKeys.add(mutexKey)
    try {
      const summary = await fetchProductSummary(slug)
      return c.json(summary)
    } catch (e: any) {
      console.error(`[product-intel] POST /api/products/${slug}/refresh error:`, sanitizeErr(e))
      return c.json({ error: sanitizeErr(e) }, 500)
    } finally {
      _generatingKeys.delete(mutexKey)
    }
  })

  // PATCH /api/products/:slug/sources — update customSources and/or followLinks for a product
  app.patch('/api/products/:slug/sources', async (c) => {
    const slug = c.req.param('slug')
    try {
      const products = loadProductConfig()
      const idx = products.findIndex(p => p.slug === slug)
      if (idx === -1) return c.json({ error: `Unknown product: ${slug}` }, 404)

      const body = await c.req.json() as { customSources?: string[]; followLinks?: boolean }

      // Validate each URL against allowed domains (reuses feature radar allowlist — BKL-S13)
      if (Array.isArray(body.customSources)) {
        for (const url of body.customSources) {
          if (!url.startsWith('http') || !isAllowedUrl(url)) {
            return c.json({ error: `URL not in allowed domains (redhat.com, openshift.com, github.com/openshift): ${url}` }, 400)
          }
        }
        products[idx] = { ...products[idx], customSources: body.customSources }
      }

      if (typeof body.followLinks === 'boolean') {
        products[idx] = { ...products[idx], followLinks: body.followLinks }
      }

      saveProductConfig(products)
      return c.json({ ok: true, product: products[idx] })
    } catch (e: any) {
      console.error(`[product-intel] PATCH /api/products/${slug}/sources error:`, sanitizeErr(e))
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })
}
