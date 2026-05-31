/**
 * Product Intelligence Service — Domain Logic
 *
 * Pure business logic extracted from product-intel-routes.ts.
 * All product intelligence operations, batch generation orchestration,
 * Drive folder setup, slide ingestion, and territory summary logic live here.
 *
 * Routes file (product-intel-routes.ts) is now a thin HTTP adapter.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import {
  getAllProductSummaries,
  getCachedSummary,
  fetchProductSummary,
  refreshAllProducts,
  getProductAlerts,
  acknowledgeAlert,
  loadProductConfig,
  loadProductIntelConfig,
  saveProductConfig,
  getProductIntelParentFolderId,
} from './product-release-radar.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { sanitizeErr, isValidDriveFolderId } from './utils.ts'
import { callGemini } from './gemini-call.ts'
import { readProductLifecycleCache } from './product-lifecycle.ts'
import { refreshDriveCorpus, getCachedDriveCorpus } from './product-drive-ingest.ts'
import { getFeatureCache, extractProductFeatures, enrichFeatures, refreshAllFeatures, isAllowedUrl } from './product-feature-radar.ts'
import {
  getCachedCustomerProductIntel,
  generateCustomerProductIntel,
  buildCustomerIntelContext,
} from './customer-product-intel.ts'
import { toSlug } from './cache-layer.ts'
import { customers } from './server-state.ts'
import { getValueMap } from './value-map-loader.ts'

// ── Config ────────────────────────────────────────────────────────────────────

import { CACHE_DIR as BASE_CACHE_DIR } from './lib/paths.ts'

const CACHE_DIR = resolve(BASE_CACHE_DIR, 'product-intel')

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DriveSetupResult {
  slug: string
  driveFolder: string
  created: boolean
}

export interface IngestSlidesResult {
  slug: string
  filesProcessed: number
  textChars: number
  corpusHash: string
  sources: string[]
}

export interface SlidesStatusResult {
  slug: string
  files: Array<{ name: string; fileId: string; modifiedTime: string }>
  corpusHash: string
  extractedAt: string
}

export interface BatchGenerationState {
  running: boolean
  current: string | null
  completed: number
  total: number
  errors: string[]
  startedAt: string | null
  completedAt: string | null
}

export interface GenerateAllResult {
  queued: string[]
  skipped: string[]
}

export interface WhatsNewResult {
  summary: string[]
  version: string
  generatedAt: string
  cached: boolean
}

export interface TerritorySummaryResult {
  slug: string
  coverageCount: number
  totalCustomers: number
  coverageBreakdown: Record<string, number>
  topPriorityActions: Array<{ action: string; customer: string; confidence: string }>
  lastUpdated: string | null
  slidesStatus: { filesIngested: number; lastRefreshed: string | null }
  featureStatus: { featureCount: number; extractedAt: string; enrichedAt: string | null } | null
}

export interface RefreshAllFeaturesResult {
  ok: true
  products: Array<{
    slug: string
    featureCount: number
    extractedAt: string
    enrichedAt: string | null
  }>
}

export interface RefreshFeaturesResult {
  slug: string
  displayName: string
  features: any[]
  extractedAt: string
  enrichedAt: string | null
}

export interface UpdateSourcesRequest {
  customSources?: string[]
  followLinks?: boolean
}

export interface UpdateSourcesResult {
  ok: true
  product: any
}

// ── Batch state (exported for route access) ──────────────────────────────────

export let _allCustomersBatchState: BatchGenerationState = {
  running: false,
  current: null,
  completed: 0,
  total: 0,
  errors: [],
  startedAt: null,
  completedAt: null,
}

// ── Drive folder setup ────────────────────────────────────────────────────────

/**
 * Bootstrap Drive subfolders for each product under Products/ subfolder.
 */
export async function setupDriveFolders(): Promise<DriveSetupResult[]> {
  const config = loadProductIntelConfig()
  const parentFolderId = getProductIntelParentFolderId()

  if (!parentFolderId) {
    throw new Error('No parent folder configured — bootstrap an AE first to set the shared Drive parent folder')
  }
  if (!isValidDriveFolderId(parentFolderId)) {
    throw new Error('Invalid parent folder id resolved from AE records')
  }

  const drive = google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) })
  const products = [...config.products]
  const results: DriveSetupResult[] = []

  // BKL-DRIVE-PRODUCTS-ROOT-01: slug folders go under Products/ subfolder
  let productsFolderId = parentFolderId
  const productsSearch = await drive.files.list({
    q: `name='Products' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  }).catch(() => ({ data: { files: [] } }))

  if (productsSearch.data.files?.length) {
    productsFolderId = productsSearch.data.files[0].id!
  } else {
    const created = await drive.files.create({
      requestBody: { name: 'Products', mimeType: 'application/vnd.google-apps.folder', parents: [parentFolderId] },
      supportsAllDrives: true,
      fields: 'id',
    }).catch(() => null)
    if (created?.data.id) {
      productsFolderId = created.data.id
    } else {
      console.warn('[product-intel-service] setupDriveFolders: failed to create Products/ folder — falling back to CommandCenter root')
    }
  }

  for (let i = 0; i < products.length; i++) {
    const product = products[i]

    // BKL-UX-PRODUCT-FOLDER-REPARENT-01: verify existing folders are children of productsFolderId
    if (product.driveFolder) {
      const meta = await drive.files.get({
        fileId: product.driveFolder,
        fields: 'id,parents',
        supportsAllDrives: true,
      }).catch(() => null)
      if (meta?.data.parents && !meta.data.parents.includes(productsFolderId)) {
        await drive.files.update({
          fileId: product.driveFolder,
          addParents: productsFolderId,
          supportsAllDrives: true,
          fields: 'id',
        }).catch((e: any) => console.warn(`[product-intel-service] setupDriveFolders: failed to re-parent ${product.slug}:`, e?.message))
        console.log(`[product-intel-service] setupDriveFolders: re-parented ${product.slug} under Products/ (${productsFolderId})`)
      }
      results.push({ slug: product.slug, driveFolder: product.driveFolder, created: false })
      continue
    }

    // Check if folder already exists under Products/
    const safeName = product.slug.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const existing = await drive.files.list({
      q: `name='${safeName}' and '${productsFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    }).catch(() => ({ data: { files: [] } }))

    if (existing.data.files?.length) {
      const folderId = existing.data.files[0].id!
      products[i] = { ...product, driveFolder: folderId }
      results.push({ slug: product.slug, driveFolder: folderId, created: false })
      console.log(`[product-intel-service] setupDriveFolders: reusing existing folder for ${product.slug} under Products/ (${folderId})`)
    } else {
      const folder = await drive.files.create({
        requestBody: {
          name: product.slug,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [productsFolderId],
        },
        supportsAllDrives: true,
        fields: 'id',
      })
      const folderId = folder.data.id!
      products[i] = { ...product, driveFolder: folderId }
      results.push({ slug: product.slug, driveFolder: folderId, created: true })
      console.log(`[product-intel-service] setupDriveFolders: created folder for ${product.slug} under Products/ (${folderId})`)
    }
  }

  saveProductConfig(products)
  return results
}

// ── Slide ingestion ───────────────────────────────────────────────────────────

/**
 * Ingest Drive corpus for a product, auto-extract features after.
 */
export async function ingestSlides(slug: string): Promise<IngestSlidesResult> {
  const products = loadProductConfig()
  const product = products.find(p => p.slug === slug)
  if (!product) throw new Error(`Unknown product: ${slug}`)
  if (!product.driveFolder) throw new Error(`driveFolder is null for ${slug}`)

  const corpus = await refreshDriveCorpus(slug)
  if (!corpus) throw new Error(`No exportable files found for ${slug}`)

  const totalChars = corpus.files.reduce((sum, f) => sum + f.textContent.length, 0)

  // Auto-extract features after slide ingest (fire-and-forget)
  extractProductFeatures(slug).then(cache => {
    if (cache) enrichFeatures(slug).catch(e => console.warn('[feature-radar] enrichment failed:', e?.message))
  }).catch(e => console.warn('[feature-radar] extraction failed after ingest:', e?.message))

  return {
    slug,
    filesProcessed: corpus.files.length,
    textChars: totalChars,
    corpusHash: corpus.corpusHash,
    sources: corpus.files.map(f => f.name),
  }
}

/**
 * Read cached Drive corpus status without calling Drive API.
 */
export function getSlidesStatus(slug: string): SlidesStatusResult | null {
  const corpus = getCachedDriveCorpus(slug)
  if (!corpus) return null

  return {
    slug: corpus.slug,
    files: corpus.files.map(f => ({
      name: f.name,
      fileId: f.fileId,
      modifiedTime: f.modifiedTime,
    })),
    corpusHash: corpus.corpusHash,
    extractedAt: corpus.extractedAt,
  }
}

// ── Batch customer intel generation ───────────────────────────────────────────

/**
 * Start batch generation of customer intel for all customers × all products.
 * Runs in background, updates _allCustomersBatchState.
 */
export function startAllCustomersBatch(mutexKeys: Set<string>): { message: string; customerCount: number } {
  const batchKey = 'intel:batch:all-customers'
  if (mutexKeys.has(batchKey)) {
    throw new Error('Batch generation already running')
  }
  mutexKeys.add(batchKey)

  const productConfigs = loadProductConfig()
  const customerList = [...customers]
  const total = customerList.length

  _allCustomersBatchState = {
    running: true,
    current: null,
    completed: 0,
    total,
    errors: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  }

  // Run in background
  ;(async () => {
    try {
      for (const customer of customerList) {
        const customerSlug = toSlug(customer.name)
        _allCustomersBatchState.current = customer.name
        try {
          const ctx = await buildCustomerIntelContext(customerSlug)
          for (const product of productConfigs) {
            const summary = getCachedSummary(product.slug)
            if (!summary) continue
            const mutexKey = `intel:${product.slug}:${customerSlug}`
            if (mutexKeys.has(mutexKey)) continue
            mutexKeys.add(mutexKey)
            try {
              const corpus = getCachedDriveCorpus(product.slug)
              const slidesText = corpus ? corpus.files.map(f => f.textContent).join('\n\n') : ''
              const { features: productFeatures, hash: productFeaturesHash } = ctx.productFeaturesFn(product.slug)
              await generateCustomerProductIntel({
                slug: product.slug,
                productSummary: summary,
                slidesText,
                customerName: ctx.customerName,
                subscriptions: ctx.subscriptions,
                supportCases: ctx.supportCases,
                customerDocsText: ctx.customerDocsText,
                customerDocsHash: ctx.customerDocsHash,
                opportunityNote: ctx.opportunityNote,
                productFeatures,
                productFeaturesHash,
              })
            } finally {
              mutexKeys.delete(mutexKey)
            }
            await new Promise(r => setTimeout(r, 3000)) // 3s between Gemini calls
          }
        } catch (e: any) {
          const msg = `${customer.name}: ${sanitizeErr(e)}`
          console.error(`[product-intel-service] generateAllCustomers: ${msg}`)
          _allCustomersBatchState.errors.push(msg)
        }
        _allCustomersBatchState.completed++
      }
      console.log(`[product-intel-service] generateAllCustomers: completed ${total} customers`)
    } finally {
      _allCustomersBatchState.running = false
      _allCustomersBatchState.current = null
      _allCustomersBatchState.completedAt = new Date().toISOString()
      mutexKeys.delete(batchKey)
    }
  })()

  return { message: 'Batch generation started', customerCount: total }
}

// ── Single customer, all products generation ──────────────────────────────────

/**
 * Generate intel for all products sequentially for a single customer.
 */
export async function generateAllProductsForCustomer(
  customerSlug: string,
  mutexKeys: Set<string>
): Promise<GenerateAllResult> {
  if (!/^[a-z0-9-]+$/.test(customerSlug)) {
    throw new Error('Invalid customerSlug')
  }

  const products = loadProductConfig()
  const queued: string[] = []
  const skipped: string[] = []

  const ctx = await buildCustomerIntelContext(customerSlug)

  for (const product of products) {
    const slug = product.slug
    const mutexKey = `intel:${slug}:${customerSlug}`

    if (mutexKeys.has(mutexKey)) {
      skipped.push(slug)
      continue
    }

    const productSummary = getCachedSummary(slug)
    if (!productSummary) {
      console.warn(`[product-intel-service] generateAllProducts: no cached summary for ${slug} — skipping`)
      skipped.push(slug)
      continue
    }

    mutexKeys.add(mutexKey)
    try {
      const corpus = getCachedDriveCorpus(slug)
      const slidesText = corpus ? corpus.files.map(f => f.textContent).join('\n\n') : ''
      const { features: productFeatures, hash: productFeaturesHash } = ctx.productFeaturesFn(slug)

      await generateCustomerProductIntel({
        slug,
        productSummary,
        slidesText,
        customerName: ctx.customerName,
        subscriptions: ctx.subscriptions,
        supportCases: ctx.supportCases,
        customerDocsText: ctx.customerDocsText,
        customerDocsHash: ctx.customerDocsHash,
        opportunityNote: ctx.opportunityNote,
        productFeatures,
        productFeaturesHash,
      })
      queued.push(slug)
    } catch (e: any) {
      console.error(`[product-intel-service] generateAllProducts: error generating ${slug}/${customerSlug}:`, sanitizeErr(e))
      skipped.push(slug)
    } finally {
      mutexKeys.delete(mutexKey)
    }
  }

  return { queued, skipped }
}

// ── Single product intel generation ───────────────────────────────────────────

/**
 * Generate (or regenerate) customer intel for a single product + customer.
 */
export async function generateSingleProductIntel(
  slug: string,
  customerSlug: string
): Promise<any> {
  if (!/^[a-z0-9-]+$/.test(slug) || !/^[a-z0-9-]+$/.test(customerSlug)) {
    throw new Error('Invalid slug')
  }

  const products = loadProductConfig()
  const product = products.find(p => p.slug === slug)
  if (!product) throw new Error(`Unknown product: ${slug}`)

  const productSummary = getCachedSummary(slug)
  if (!productSummary) {
    throw new Error(`No cached summary for ${slug} — run POST /api/products/${slug}/refresh first`)
  }

  const corpus = getCachedDriveCorpus(slug)
  const slidesText = corpus ? corpus.files.map(f => f.textContent).join('\n\n') : ''

  const ctx = await buildCustomerIntelContext(customerSlug)
  const { features: productFeatures, hash: productFeaturesHash } = ctx.productFeaturesFn(slug)

  const intel = await generateCustomerProductIntel({
    slug,
    productSummary,
    slidesText,
    customerName: ctx.customerName,
    subscriptions: ctx.subscriptions,
    supportCases: ctx.supportCases,
    customerDocsText: ctx.customerDocsText,
    customerDocsHash: ctx.customerDocsHash,
    opportunityNote: ctx.opportunityNote,
    productFeatures,
    productFeaturesHash,
  })

  return intel
}

// ── What's New synthesis ──────────────────────────────────────────────────────

/**
 * Generate sales talking points for current release.
 */
export async function generateWhatsNew(slug: string, forceRefresh: boolean): Promise<WhatsNewResult> {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('Invalid slug')

  const featureCache = getFeatureCache(slug)
  const hasFeatures = featureCache && featureCache.features.length > 0

  const radarSummary = getCachedSummary(slug)
  const lifecycleCache = readProductLifecycleCache()
  const lifecycle = lifecycleCache?.products.find(p => p.slug === slug)
  const version = radarSummary?.currentVersion ?? lifecycle?.currentVersion ?? featureCache?.features[0]?.versionCurrent ?? 'latest'

  let featuresForSynthesis: any[] = []
  if (hasFeatures) {
    const gaFeatures = featureCache!.features.filter(f =>
      f.status === 'GA' && (f.versionCurrent === version || f.versionIntroduced === version)
    )
    featuresForSynthesis = gaFeatures.length > 0
      ? gaFeatures
      : featureCache!.features.filter(f => f.status === 'GA').length > 0
        ? featureCache!.features.filter(f => f.status === 'GA').slice(0, 20)
        : featureCache!.features.slice(0, 20)
  }

  const featureContext = featuresForSynthesis.map(f =>
    `- [${f.status}] ${f.name}: ${f.description}${f.enrichedDescription ? ' ' + f.enrichedDescription : ''}`
  ).join('\n')

  const productName = featureCache?.displayName ?? radarSummary?.displayName ?? slug.toUpperCase()
  const deltaKey = forceRefresh ? undefined : `product-whats-new:${slug}:${version}`
  const valueMapContent = getValueMap(slug)

  if (featuresForSynthesis.length === 0 && !valueMapContent) {
    return { summary: [], version, generatedAt: new Date().toISOString(), cached: false }
  }

  const systemPrompt = 'You are a Red Hat product expert. Given the features in this release and the business value context, write a concise summary (5-7 bullet points) covering both GA and Tech Preview features. For each bullet, use this exact format: "**Feature Name**: explanation of what it does and business value." Start with the most impactful GA features, then include 1-2 notable Tech Preview features that customers should know about. Connect each feature to a business outcome (cost reduction, risk mitigation, productivity, revenue growth). Write as if briefing an Account Executive before a customer meeting. Return ONLY a JSON array of strings, each being one bullet point with the **bold** feature name. No numbering, no extra text.'

  let userPrompt = `Product: ${productName}\nVersion: ${version}`
  if (featureContext) {
    userPrompt += `\n\nFeatures in this release:\n${featureContext}`
  }
  if (valueMapContent) {
    userPrompt += `\n\nBusiness Value Context (use this to frame features in terms of customer outcomes):\n${valueMapContent}`
  }

  const result = await callGemini(systemPrompt, userPrompt, {
    callType: 'product-whats-new',
    deltaKey,
    responseSchema: {
      type: 'ARRAY',
      items: { type: 'STRING' },
    },
  })

  let summary: string[]
  try {
    summary = JSON.parse(result.text)
    if (!Array.isArray(summary)) summary = [result.text]
  } catch {
    summary = result.text.split('\n').filter(line => line.trim().length > 0).slice(0, 5)
  }

  return {
    summary,
    version,
    generatedAt: new Date().toISOString(),
    cached: result.cached,
  }
}

// ── Territory summary ─────────────────────────────────────────────────────────

/**
 * Aggregate customer intel for a product across territory.
 */
export function getTerritorySummary(slug: string): TerritorySummaryResult {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('Invalid slug')

  // Defense-in-depth: ensure CACHE_DIR is within expected /data volume (Rook finding BKL-W5-RK-F1)
  if (!CACHE_DIR.startsWith('/data')) {
    throw new Error('Server configuration error')
  }

  const intelDir = resolve(CACHE_DIR, `${slug}-customer-intel`)
  const totalCustomers = customers.length

  // BKL-UI-01: filter on-disk cache by active customer slugs
  const activeCustomerSlugs = new Set(customers.map(c => toSlug(c.name)))

  const coverageBreakdown: Record<string, number> = { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 }
  const priorityActions: { action: string; confidence: string; customer: string }[] = []
  let lastUpdated: string | null = null

  if (existsSync(intelDir)) {
    const files = readdirSync(intelDir).filter(f => f.endsWith('.json'))
    for (const file of files) {
      const fileCustomerSlug = file.replace(/\.json$/, '')
      if (!activeCustomerSlugs.has(fileCustomerSlug)) continue
      try {
        const raw = JSON.parse(readFileSync(resolve(intelDir, file), 'utf-8'))
        const intel = raw.intel ?? raw
        const score = intel.relevanceScore ?? 'NONE'
        if (score in coverageBreakdown) coverageBreakdown[score]++
        if (
          intel.priorityAction &&
          intel.priorityAction !== 'Analysis unavailable' &&
          !intel.priorityAction.startsWith('Analysis skipped')
        ) {
          priorityActions.push({
            action: intel.priorityAction,
            confidence: score,
            customer: intel.customer ?? fileCustomerSlug.replace(/[^\w\s-]/g, ''),
          })
        }
        const ts = raw.cachedAt ?? intel.generatedAt
        if (ts && (!lastUpdated || ts > lastUpdated)) lastUpdated = ts
      } catch { /* skip corrupt cache files */ }
    }
  }

  const coverageCount = coverageBreakdown.HIGH + coverageBreakdown.MEDIUM + coverageBreakdown.LOW + coverageBreakdown.NONE

  const confidenceOrder: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0 }
  const topPriorityActions = priorityActions
    .sort((a, b) => (confidenceOrder[b.confidence] ?? 0) - (confidenceOrder[a.confidence] ?? 0))
    .slice(0, 3)
    .map(p => ({ action: p.action, customer: p.customer, confidence: p.confidence }))

  const corpus = getCachedDriveCorpus(slug)
  const slidesStatus = corpus
    ? { filesIngested: corpus.files.length, lastRefreshed: corpus.extractedAt }
    : { filesIngested: 0, lastRefreshed: null }

  const featureCache = getFeatureCache(slug)
  const featureStatus = featureCache
    ? { featureCount: featureCache.features.length, extractedAt: featureCache.extractedAt, enrichedAt: featureCache.enrichedAt }
    : null

  return {
    slug,
    coverageCount,
    totalCustomers,
    coverageBreakdown,
    topPriorityActions,
    lastUpdated,
    slidesStatus,
    featureStatus,
  }
}

// ── Feature radar operations ──────────────────────────────────────────────────

/**
 * Get all products' feature caches.
 */
export function getAllFeatureCaches(): any[] {
  const products = loadProductConfig()
  const caches: any[] = []
  for (const p of products) {
    const cache = getFeatureCache(p.slug)
    if (cache) caches.push(cache)
  }
  return caches
}

/**
 * Extract + enrich features for all products.
 */
export async function refreshAllProductFeatures(mutexKeys: Set<string>): Promise<RefreshAllFeaturesResult> {
  const mutexKey = 'refresh-all'
  if (mutexKeys.has(mutexKey)) {
    throw new Error('Feature refresh-all already in progress')
  }
  mutexKeys.add(mutexKey)
  try {
    await refreshAllFeatures()
    const products = loadProductConfig()
    const caches: any[] = []
    for (const p of products) {
      const cache = getFeatureCache(p.slug)
      if (cache) caches.push({ slug: p.slug, featureCount: cache.features.length, extractedAt: cache.extractedAt, enrichedAt: cache.enrichedAt })
    }
    return { ok: true, products: caches }
  } finally {
    mutexKeys.delete(mutexKey)
  }
}

/**
 * Extract + enrich features for one product.
 */
export async function refreshProductFeatures(slug: string, mutexKeys: Set<string>): Promise<RefreshFeaturesResult> {
  const mutexKey = `features:${slug}`
  if (mutexKeys.has(mutexKey)) {
    throw new Error(`Feature refresh already in progress for ${slug}`)
  }
  mutexKeys.add(mutexKey)
  try {
    const cache = await extractProductFeatures(slug)
    if (!cache) throw new Error(`Extraction failed for ${slug} — no Drive corpus?`)
    await enrichFeatures(slug)
    const updated = getFeatureCache(slug)
    if (!updated) throw new Error(`Failed to read updated cache for ${slug}`)
    return updated as RefreshFeaturesResult
  } finally {
    mutexKeys.delete(mutexKey)
  }
}

// ── Product config updates ────────────────────────────────────────────────────

/**
 * Update customSources and/or followLinks for a product.
 */
export async function updateProductSources(slug: string, body: UpdateSourcesRequest): Promise<UpdateSourcesResult> {
  const products = loadProductConfig()
  const idx = products.findIndex(p => p.slug === slug)
  if (idx === -1) throw new Error(`Unknown product: ${slug}`)

  if (Array.isArray(body.customSources)) {
    for (const url of body.customSources) {
      if (!url.startsWith('http') || !isAllowedUrl(url)) {
        throw new Error(`URL not in allowed domains (redhat.com, openshift.com, github.com/openshift): ${url}`)
      }
    }
    products[idx] = { ...products[idx], customSources: body.customSources }
  }

  if (typeof body.followLinks === 'boolean') {
    products[idx] = { ...products[idx], followLinks: body.followLinks }
  }

  saveProductConfig(products)
  return { ok: true, product: products[idx] }
}

// ── Re-exports for convenience ────────────────────────────────────────────────

export {
  getAllProductSummaries,
  getCachedSummary,
  fetchProductSummary,
  refreshAllProducts,
  getProductAlerts,
  acknowledgeAlert,
  loadProductConfig,
  getCachedCustomerProductIntel,
  getFeatureCache,
}
