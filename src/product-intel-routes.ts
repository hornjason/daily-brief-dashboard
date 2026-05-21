/**
 * Product Intelligence Routes — HTTP Adapter
 *
 * Thin HTTP layer over product-intel-service.ts domain logic.
 * All business logic lives in the service module.
 */

import { Hono } from 'hono'
import { sanitizeErr } from './utils.ts'
import {
  getAllProductSummaries,
  getCachedSummary,
  fetchProductSummary,
  refreshAllProducts,
  getProductAlerts,
  acknowledgeAlert,
  loadProductConfig,
  setupDriveFolders,
  ingestSlides,
  getSlidesStatus,
  _allCustomersBatchState,
  startAllCustomersBatch,
  generateAllProductsForCustomer,
  generateSingleProductIntel,
  getCachedCustomerProductIntel,
  generateWhatsNew,
  getAllFeatureCaches,
  refreshAllProductFeatures,
  getTerritorySummary,
  getFeatureCache,
  refreshProductFeatures,
  updateProductSources,
} from './product-intel-service.ts'

// ── BKL-S16: In-memory mutex for Gemini generation endpoints ──────────────────
// Bun is single-threaded — a Set of active keys prevents concurrent duplicate calls.
// Keys: "intel:{slug}:{customerSlug}" | "refresh:{slug}" | "features:{slug}"
const _generatingKeys = new Set<string>()

export function createProductIntelRouter(): Hono {
  const router = new Hono()

  // GET /api/products — all cached summaries (no fetch, reads cache only)
  router.get('/api/products', (c) => {
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
  router.get('/api/products/config', (c) => {
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
  router.get('/api/products/alerts', (c) => {
    try {
      const alerts = getProductAlerts()
      return c.json(alerts)
    } catch (e: any) {
      console.error('[product-intel] GET /api/products/alerts error:', sanitizeErr(e))
      return c.json({ error: 'Failed to load product alerts' }, 500)
    }
  })

  // POST /api/products/alerts/:id/acknowledge
  router.post('/api/products/alerts/:id/acknowledge', async (c) => {
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
  router.post('/api/products/setup-drive-folders', async (c) => {
    try {
      const results = await setupDriveFolders()
      return c.json({ products: results })
    } catch (e: any) {
      console.error('[product-intel] POST /api/products/setup-drive-folders error:', sanitizeErr(e))
      const status = e.message.includes('No parent folder') ? 400 : 500
      return c.json({ error: sanitizeErr(e) }, status)
    }
  })

  // POST /api/products/ingest-slides — ingest Drive corpus for a product
  router.post('/api/products/ingest-slides', async (c) => {
    let body: { slug?: string }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
    const slug = body?.slug
    if (!slug) return c.json({ error: 'slug is required' }, 400)

    try {
      const result = await ingestSlides(slug)
      return c.json(result)
    } catch (e: any) {
      console.error(`[product-intel] ingest-slides error for ${slug}:`, sanitizeErr(e))
      const status = e.message.includes('Unknown product') || e.message.includes('driveFolder is null') || e.message.includes('No exportable files') ? 400 : 500
      return c.json({ error: sanitizeErr(e) }, status)
    }
  })

  // GET /api/products/slides-status — read cached Drive corpus without calling Drive
  router.get('/api/products/slides-status', (c) => {
    const slug = c.req.query('slug')
    if (!slug) return c.json({ error: 'slug query param is required' }, 400)
    try {
      const result = getSlidesStatus(slug)
      if (!result) return c.json(null)
      return c.json(result)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/products/intel/generate-all-customers/status — batch generation status
  // NOTE: registered BEFORE /api/products/:slug and BEFORE /:customerSlug to avoid slug collision
  router.get('/api/products/intel/generate-all-customers/status', (c) => {
    return c.json({
      running: _allCustomersBatchState.running,
      current: _allCustomersBatchState.current,
      completed: _allCustomersBatchState.completed,
      total: _allCustomersBatchState.total,
      errors: _allCustomersBatchState.errors,
      startedAt: _allCustomersBatchState.startedAt,
      completedAt: _allCustomersBatchState.completedAt,
    })
  })

  // POST /api/products/intel/generate-all-customers — regenerate intel for all customers x all products
  router.post('/api/products/intel/generate-all-customers', async (c) => {
    try {
      const result = startAllCustomersBatch(_generatingKeys)
      return c.json(result)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e), state: _allCustomersBatchState }, 409)
    }
  })

  // POST /api/products/intel/:customerSlug/generate-all — generate intel for ALL products sequentially
  router.post('/api/products/intel/:customerSlug/generate-all', async (c) => {
    const customerSlug = c.req.param('customerSlug')
    try {
      const result = await generateAllProductsForCustomer(customerSlug, _generatingKeys)
      return c.json(result)
    } catch (e: any) {
      const status = e.message.includes('Invalid customerSlug') ? 400 : 500
      return c.json({ error: sanitizeErr(e) }, status)
    }
  })

  // GET /api/products/:slug/intel/:customerSlug — cached customer intel (no generation)
  // NOTE: registered BEFORE /api/products/:slug to avoid ":slug" matching "intel"
  router.get('/api/products/:slug/intel/:customerSlug', (c) => {
    const slug         = c.req.param('slug')
    const customerSlug = c.req.param('customerSlug')
    if (!/^[a-z0-9-]+$/.test(slug) || !/^[a-z0-9-]+$/.test(customerSlug)) return c.json({ error: 'Invalid slug' }, 400)
    try {
      const intel = getCachedCustomerProductIntel(slug, customerSlug)
      // BKL-Q09: return 200+null when no intel exists — "not yet generated" is expected state, not an error
      if (!intel) return c.json(null)
      return c.json(intel)
    } catch (e: any) {
      console.error(`[product-intel] GET /api/products/${slug}/intel/${customerSlug} error:`, sanitizeErr(e))
      return c.json({ error: 'Failed to read customer intel cache' }, 500)
    }
  })

  // POST /api/products/:slug/intel/:customerSlug/generate — generate (or regenerate) customer intel
  router.post('/api/products/:slug/intel/:customerSlug/generate', async (c) => {
    const slug = c.req.param('slug')
    const customerSlug = c.req.param('customerSlug')
    const mutexKey = `intel:${slug}:${customerSlug}`

    if (_generatingKeys.has(mutexKey)) {
      return c.json({ error: `Generation already in progress for ${slug}/${customerSlug}` }, 409)
    }
    _generatingKeys.add(mutexKey)
    try {
      const intel = await generateSingleProductIntel(slug, customerSlug)
      return c.json(intel)
    } catch (e: any) {
      console.error(`[product-intel] POST /api/products/${slug}/intel/${customerSlug}/generate error:`, sanitizeErr(e))
      const status = e.message.includes('Invalid slug') || e.message.includes('Unknown product') || e.message.includes('No cached summary') ? 400 : 500
      return c.json({ error: sanitizeErr(e) }, status)
    } finally {
      _generatingKeys.delete(mutexKey)
    }
  })

  // ── What's New Route (Issue #249) ─────────────────────────────────────────
  // NOTE: registered BEFORE /api/products/:slug to avoid ":slug" matching "whats-new"

  // GET /api/products/:slug/whats-new — Gemini-synthesized sales talking points for current release
  router.get('/api/products/:slug/whats-new', async (c) => {
    const slug = c.req.param('slug')
    const forceRefresh = c.req.query('refresh') === 'true'
    try {
      const result = await generateWhatsNew(slug, forceRefresh)
      return c.json(result)
    } catch (e: any) {
      console.error(`[product-intel] GET /api/products/${slug}/whats-new error:`, sanitizeErr(e))
      const status = e.message.includes('Invalid slug') ? 400 : 500
      return c.json({ error: sanitizeErr(e) }, status)
    }
  })

  // ── Feature Radar Routes ──────────────────────────────────────────────────

  // GET /api/products/features — all products' feature caches
  router.get('/api/products/features', (c) => {
    try {
      const caches = getAllFeatureCaches()
      return c.json(caches)
    } catch (e: any) {
      console.error('[product-intel] GET /api/products/features error:', sanitizeErr(e))
      return c.json({ error: 'Failed to load feature caches' }, 500)
    }
  })

  // POST /api/products/features/refresh-all — extract + enrich features for all products
  router.post('/api/products/features/refresh-all', async (c) => {
    try {
      const result = await refreshAllProductFeatures(_generatingKeys)
      return c.json(result)
    } catch (e: any) {
      console.error('[product-intel] POST /api/products/features/refresh-all error:', sanitizeErr(e))
      const status = e.message.includes('already in progress') ? 409 : 500
      return c.json({ error: sanitizeErr(e) }, status)
    }
  })

  // GET /api/products/:slug/territory-summary — aggregate customer intel for a product across territory
  router.get('/api/products/:slug/territory-summary', (c) => {
    const slug = c.req.param('slug')
    try {
      const result = getTerritorySummary(slug)
      return c.json(result)
    } catch (e: any) {
      console.error(`[product-intel] GET /api/products/${slug}/territory-summary error:`, sanitizeErr(e))
      const status = e.message.includes('Invalid slug') || e.message.includes('Server configuration error') ? 400 : 500
      return c.json({ error: sanitizeErr(e) }, status)
    }
  })

  // GET /api/products/:slug/features — feature cache for a single product
  router.get('/api/products/:slug/features', (c) => {
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
  router.post('/api/products/:slug/features/refresh', async (c) => {
    const slug = c.req.param('slug')
    try {
      const result = await refreshProductFeatures(slug, _generatingKeys)
      return c.json(result)
    } catch (e: any) {
      console.error(`[product-intel] POST /api/products/${slug}/features/refresh error:`, sanitizeErr(e))
      const status = e.message.includes('already in progress') ? 409 : e.message.includes('Extraction failed') ? 400 : 500
      return c.json({ error: sanitizeErr(e) }, status)
    }
  })

  // GET /api/products/:slug — single cached summary or 404
  router.get('/api/products/:slug', (c) => {
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

  // POST /api/products/refresh-all — refresh all product summaries (BKL-HERO-PRODUCT-PREREQ-01)
  router.post('/api/products/refresh-all', async (c) => {
    const mutexKey = 'refresh:all'
    if (_generatingKeys.has(mutexKey)) {
      return c.json({ error: 'Refresh already in progress for all products' }, 409)
    }
    _generatingKeys.add(mutexKey)
    try {
      await refreshAllProducts()
      const summaries = getAllProductSummaries()
      return c.json({ success: true, count: summaries.length, products: summaries })
    } catch (e: any) {
      console.error('[product-intel] POST /api/products/refresh-all error:', sanitizeErr(e))
      return c.json({ error: sanitizeErr(e) }, 500)
    } finally {
      _generatingKeys.delete(mutexKey)
    }
  })

  // POST /api/products/:slug/refresh — fetch + synthesize, return updated summary
  router.post('/api/products/:slug/refresh', async (c) => {
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
  router.patch('/api/products/:slug/sources', async (c) => {
    const slug = c.req.param('slug')
    try {
      const body = await c.req.json()
      const result = await updateProductSources(slug, body)
      return c.json(result)
    } catch (e: any) {
      console.error(`[product-intel] PATCH /api/products/${slug}/sources error:`, sanitizeErr(e))
      const status = e.message.includes('Unknown product') ? 404 : e.message.includes('not in allowed domains') ? 400 : 500
      return c.json({ error: sanitizeErr(e) }, status)
    }
  })

  return router
}
