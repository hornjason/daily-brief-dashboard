/**
 * SalesHub Products Module — GitHub Issue #819
 *
 * Product-first FeatureModule that reads per-product JSON files from
 * config-templates/saleshub-products/{product-slug}/ and emits
 * product-level signals with customer cross-referencing (ADR-029).
 *
 * Each product directory contains:
 *   _product.json   — scraped page structure (sections, items, contacts)
 *   _enriched.json  — Gemini-extracted content kits, messaging guides, battlecards
 *
 * Signals cross-reference against customer subscriptions so that
 * customers who own the matching product get signals scored as customer-tier.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { loadCustomerContext, matchesSubscriptionProducts } from '../lib/customer-context-loader.ts'
import { readCCSPCache, readPipelineCache } from '../cache-layer.ts'
import { downloadProductsFromDrive } from '../lib/saleshub-product-drive-sync.ts'
import type { ProductPage, ProductSection, ProductEnrichment, DocumentIntelligence } from '../types/saleshub-product-types.ts'
import { resolve } from 'path'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'

// ── In-memory cache ──────────────────────────────────────────────────────────

interface ProductData {
  product: ProductPage
  enrichment: ProductEnrichment | null
}

let productCache: Map<string, ProductData> | null = null
let lastLoadedAt = 0

function getProductsDir(): string {
  // Check mounted data path first, then app-baked path
  if (process.env.CONFIG_DIR) {
    const mounted = resolve(process.env.CONFIG_DIR, '..', 'config-templates', 'saleshub-products')
    if (existsSync(mounted)) return mounted
  }
  return resolve('config-templates', 'saleshub-products')
}

/**
 * Load all product data from disk into the in-memory cache.
 * Uses mtime-based reload — only rereads when files have changed.
 */
function loadProducts(): Map<string, ProductData> {
  // Cache staleness check — invalidate if older than cacheTtlMs (7 days)
  const cacheTtlMs = 7 * 24 * 60 * 60 * 1000
  if (productCache && lastLoadedAt > 0 && (Date.now() - lastLoadedAt > cacheTtlMs)) {
    productCache = null
  }
  if (productCache) return productCache



  const products = new Map<string, ProductData>()
  const productsDir = getProductsDir()

  if (!existsSync(productsDir)) return products

  let dirs: string[]
  try {
    dirs = readdirSync(productsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
  } catch {
    return products
  }

  for (const slug of dirs) {
    const productPath = resolve(productsDir, slug, '_product.json')
    if (!existsSync(productPath)) continue

    try {
      const product: ProductPage = JSON.parse(readFileSync(productPath, 'utf-8'))

      let enrichment: ProductEnrichment | null = null
      const enrichedPath = resolve(productsDir, slug, '_enriched.json')
      if (existsSync(enrichedPath)) {
        try {
          enrichment = JSON.parse(readFileSync(enrichedPath, 'utf-8'))
        } catch { /* enrichment is optional */ }
      }

      products.set(slug, { product, enrichment })
    } catch {
      // Skip malformed product files
      console.warn(`[saleshub-products] Failed to parse _product.json for ${slug}`)
    }
  }

  productCache = products
  lastLoadedAt = Date.now()
  return products
}

function resetProductCache(): void {
  productCache = null
  lastLoadedAt = 0
}

// ── Section discovery helpers ────────────────────────────────────────────────

/**
 * Find a section by matching its title case-insensitively against a list of patterns.
 * Returns the first matching section, or undefined.
 */
function findSection(sections: Record<string, ProductSection>, ...patterns: string[]): ProductSection | undefined {
  for (const [_key, section] of Object.entries(sections)) {
    const titleLower = section.title.toLowerCase()
    for (const pattern of patterns) {
      if (titleLower.includes(pattern.toLowerCase())) {
        return section
      }
    }
  }
  return undefined
}

/**
 * Collect all sections (including nested subsections) that match any pattern.
 */
function findAllSections(sections: Record<string, ProductSection>, ...patterns: string[]): ProductSection[] {
  const results: ProductSection[] = []
  for (const [_key, section] of Object.entries(sections)) {
    const titleLower = section.title.toLowerCase()
    for (const pattern of patterns) {
      if (titleLower.includes(pattern.toLowerCase())) {
        results.push(section)
        break
      }
    }
    // Also check subsections
    if (section.subsections) {
      for (const sub of section.subsections) {
        const subLower = sub.title.toLowerCase()
        for (const pattern of patterns) {
          if (subLower.includes(pattern.toLowerCase())) {
            results.push(sub)
            break
          }
        }
      }
    }
  }
  return results
}

// ── CCSP cloud spend helper ──────────────────────────────────────────────────

/**
 * Check if a customer has cloud spend with a given cloud provider.
 * Maps cloud provider names to CCSP partner names.
 */
function customerHasCloudSpend(customerSlug: string, cloudProvider: string): boolean {
  const providerMap: Record<string, string> = {
    'aws': 'Amazon Web Services',
    'azure': 'Microsoft',
    'gcp': 'Google',
    'google': 'Google',
    'google cloud': 'Google',
    'ibm': 'IBM',
  }

  const ccspPartner = providerMap[cloudProvider.toLowerCase()]
  if (!ccspPartner) return false

  const ccspCache = readCCSPCache()
  if (!ccspCache) return false

  // Check if customer has any records with this cloud partner
  return ccspCache.records.some(r =>
    r.cloudPartner === ccspPartner &&
    (r as any).customerSlug === customerSlug
  )
}

// ── ADR-041: Document Intelligence Customer Matching ────────────────────────

interface TechStackEntry {
  name: string
  [key: string]: unknown
}

interface TechStackCache {
  technologies: TechStackEntry[]
  [key: string]: unknown
}

function loadTechStackCache(customerSlug: string): TechStackCache | null {
  const cacheDir = process.env.CACHE_DIR ?? 'data/cache'
  const cachePath = resolve(cacheDir, 'tech-stack', `${customerSlug}.json`)
  if (!existsSync(cachePath)) return null
  try {
    return JSON.parse(readFileSync(cachePath, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Match a DocumentIntelligence against a customer's tech stack (ADR-041).
 *
 * Council corrections:
 * - 4-character minimum on all substring matches
 * - Single-direction only: tech stack name must CONTAIN extracted name
 * - Returns ALL match types as array (not early-return)
 */
export function matchDocumentToCustomer(
  doc: DocumentIntelligence,
  customerSlug: string,
): { matched: boolean; matchTypes: string[]; matchedItems: string[] } {
  const techStack = loadTechStackCache(customerSlug)
  if (!techStack?.technologies?.length) return { matched: false, matchTypes: [], matchedItems: [] }

  const techNames = techStack.technologies.map(t => t.name.toLowerCase())
  const matchTypes: string[] = []
  const matchedItems: string[] = []

  // Helper: 4-char minimum, single-direction (techName includes extracted)
  const matches = (extracted: string, techName: string): boolean => {
    const e = extracted.toLowerCase()
    if (e.length < 4) return false
    return techName.includes(e)
  }

  // Check integration matches
  const integrationMatches = (doc.integrationsReferenced ?? [])
    .filter(i => techNames.some(t => matches(i.technology, t)))
  if (integrationMatches.length > 0) {
    matchTypes.push('integration')
    matchedItems.push(...integrationMatches.map(i => i.technology))
  }

  // Check competitor matches
  const competitorMatches = (doc.competitorsReferenced ?? [])
    .filter(c => techNames.some(t => matches(c.name, t)))
  if (competitorMatches.length > 0) {
    // Determine match type based on context
    const hasDisplacement = competitorMatches.some(c => c.context === 'migration-from' || c.context === 'displacement')
    matchTypes.push(hasDisplacement ? 'competitor-displacement' : 'competitor-context')
    matchedItems.push(...competitorMatches.map(c => c.name))
  }

  // Check partner solution matches
  const partnerMatches = (doc.partnerSolutions ?? [])
    .filter(p => techNames.some(t => matches(p.partnerName, t)))
  if (partnerMatches.length > 0) {
    matchTypes.push('partner')
    matchedItems.push(...partnerMatches.map(p => p.partnerName))
  }

  return {
    matched: matchTypes.length > 0,
    matchTypes,
    matchedItems,
  }
}

// ── Gate 3 Advisory: Signal matching check (#874 PR 3) ──────────────────────

export interface Gate3Result {
  customersChecked: number
  totalMatches: number
  results: Array<{ customer: string; tech: string[]; matchCount: number }>
}

/**
 * Advisory-only check: validates that enriched documents match against
 * real customer tech stacks. Does NOT modify the manifest — purely
 * informational to confirm the enrichment pipeline produces actionable data.
 *
 * Picks 2-3 customers with known tech stack data, runs matchDocumentToCustomer()
 * on each enriched document, and logs results.
 */
export function runGate3Advisory(productSlug: string): Gate3Result {
  const cacheDir = process.env.CACHE_DIR ?? 'data/cache'
  const techStackDir = resolve(cacheDir, 'tech-stack')

  // Find 2-3 customers with tech stack data
  const customerSlugs: string[] = []
  if (existsSync(techStackDir)) {
    try {
      const files = readdirSync(techStackDir)
        .filter(f => f.endsWith('.json'))
        .slice(0, 3)
      for (const f of files) {
        try {
          const data = JSON.parse(readFileSync(resolve(techStackDir, f), 'utf-8'))
          if (data.technologies?.length > 0) {
            customerSlugs.push(f.replace('.json', ''))
          }
        } catch { /* skip unreadable files */ }
      }
    } catch { /* tech-stack dir unreadable */ }
  }

  if (customerSlugs.length === 0) {
    console.log(`[gate3-advisory] No customers with tech stack data — skipping advisory check`)
    return { customersChecked: 0, totalMatches: 0, results: [] }
  }

  // Read enrichment data for the product
  const productsDir = getProductsDir()
  const productDir = resolve(productsDir, productSlug)

  // Read enrichment data
  const enrichedPath = resolve(productDir, '_enriched.json')
  let enrichedDocs: DocumentIntelligence[] = []
  if (existsSync(enrichedPath)) {
    try {
      const enrichment: ProductEnrichment = JSON.parse(readFileSync(enrichedPath, 'utf-8'))
      enrichedDocs = enrichment.documents ?? []
    } catch { /* skip */ }
  }

  if (enrichedDocs.length === 0) {
    console.log(`[gate3-advisory] No enriched documents for "${productSlug}" — skipping advisory check`)
    return { customersChecked: 0, totalMatches: 0, results: [] }
  }

  // Run matching for each customer
  const results: Gate3Result['results'] = []
  let totalMatches = 0

  for (const customerSlug of customerSlugs) {
    const techStack = loadTechStackCache(customerSlug)
    const techNames = techStack?.technologies?.map(t => t.name) ?? []

    let matchCount = 0
    for (const doc of enrichedDocs) {
      const match = matchDocumentToCustomer(doc, customerSlug)
      if (match.matched) matchCount++
    }

    results.push({ customer: customerSlug, tech: techNames.slice(0, 5), matchCount })
    totalMatches += matchCount

    console.log(
      `[gate3-advisory] Customer ${customerSlug} (has ${techNames.slice(0, 3).join(', ')}) -> ${matchCount} docs matched`,
    )
  }

  console.log(
    `[gate3-advisory] Gate 3 Advisory: ${customerSlugs.length} customers checked, ${totalMatches} total matches across ${enrichedDocs.length} enriched docs`,
  )

  return {
    customersChecked: customerSlugs.length,
    totalMatches,
    results,
  }
}

// ── Signal emission ──────────────────────────────────────────────────────────

function emitProductSignals(
  productData: ProductData,
  customerSlug: string,
  isCustomerMatch: boolean,
): Signal[] {
  const { product, enrichment } = productData
  const signals: Signal[] = []
  const timestamp = product.scrapedAt ?? new Date().toISOString()

  // 1. Product news signals
  const newsSection = findSection(product.sections, 'product news')
  if (newsSection) {
    const headline = newsSection.textContent
      ? `${product.name} -- ${newsSection.textContent.slice(0, 100)}`
      : `${product.name} -- Product news available`

    const metadata: Record<string, unknown> = {
      productSlug: product.slug,
      links: newsSection.items.filter(i => i.url).map(i => ({ name: i.name, url: i.url })),
    }
    if (isCustomerMatch) metadata.customerSlug = customerSlug

    signals.push({
      source: 'saleshub-products',
      type: 'product-release',
      headline,
      detail: newsSection.textContent ?? '',
      rawRelevance: 0.3,
      timestamp,
      metadata,
    })
  }

  // 2. Document intelligence signals (ADR-041)
  if (enrichment?.documents) {
    for (const doc of enrichment.documents.slice(0, 10)) {
      const match = matchDocumentToCustomer(doc, customerSlug)

      const metadata: Record<string, unknown> = {
        productSlug: product.slug,
        documentCategory: doc.documentCategory,
        documentName: doc.documentName,
        redHatProducts: doc.productsReferenced.map(p => p.slug).filter(Boolean),
        sourceProductSlug: doc.sourceProductSlug,
      }

      if (match.matched) {
        metadata.customerSlug = customerSlug
        metadata.matchType = match.matchTypes
        metadata.matchedTechnologies = match.matchedItems
        metadata.integrationsReferenced = doc.integrationsReferenced
        metadata.links = (doc.links ?? []).slice(0, 3)
        metadata.useCases = doc.useCases
        metadata.talkTracks = doc.talkTracks
        metadata.actionableSteps = doc.actionableSteps

        // Check CCSP cloud spend for cloud-specific documents
        const clouds = doc.cloudProviders ?? []
        for (const cloud of clouds) {
          if (customerHasCloudSpend(customerSlug, cloud)) {
            metadata.hasCloudSpend = true
            break
          }
        }
      } else if (isCustomerMatch) {
        // Product subscription match — include customerSlug
        metadata.customerSlug = customerSlug
      }

      const cleanName = doc.documentName.replace(/\.(html|pdf|docx|pptx)$/i, '')
      signals.push({
        source: 'saleshub-products',
        type: 'recommendation',
        headline: `${product.name} — ${cleanName}`,
        detail: doc.summary || doc.keyPoints.join('; '),
        rawRelevance: match.matched ? 0.40 : 0.35,
        timestamp,
        metadata,
      })
    }
  }

  // 3. Training/enablement signals
  const trainingSection = findSection(product.sections, 'training')
  if (trainingSection && trainingSection.items.length > 0) {
    const metadata: Record<string, unknown> = {
      productSlug: product.slug,
      resourceType: 'training',
      items: trainingSection.items.map(i => ({ name: i.name, url: i.url ?? '' })),
    }
    if (isCustomerMatch) metadata.customerSlug = customerSlug

    signals.push({
      source: 'saleshub-products',
      type: 'recommendation',
      headline: `Training resources available for ${product.name}`,
      detail: trainingSection.items.map(i => `- ${i.name}`).join('\n'),
      rawRelevance: 0.25,
      timestamp,
      metadata,
    })
  }

  // 4. Services signals
  const servicesSection = findSection(product.sections, 'services')
  if (servicesSection && servicesSection.items.length > 0) {
    const metadata: Record<string, unknown> = {
      productSlug: product.slug,
      resourceType: 'services',
      items: servicesSection.items.map(i => ({ name: i.name, url: i.url ?? '' })),
    }
    if (isCustomerMatch) metadata.customerSlug = customerSlug

    signals.push({
      source: 'saleshub-products',
      type: 'recommendation',
      headline: `Migration and consulting resources for ${product.name}`,
      detail: servicesSection.items.map(i => `- ${i.name}`).join('\n'),
      rawRelevance: 0.25,
      timestamp,
      metadata,
    })
  }

  return signals
}

// ── Module registration ──────────────────────────────────────────────────────

FeatureModuleRegistry.register({
  name: 'saleshub-products',
  displayName: 'SalesHub Products',
  refreshEndpoint: '/api/saleshub-products/refresh',
  signalRole: 'enrichment',
  signalAudience: 'customer-specific',
  scope: 'portfolio',
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days

  refreshInterval: null, // on-demand only

  cachePaths: (_slug: string) => {
    const productsDir = getProductsDir()
    if (!existsSync(productsDir)) return []
    try {
      return readdirSync(productsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .flatMap(d => {
          const paths = [resolve(productsDir, d.name, '_product.json')]
          const enrichedPath = resolve(productsDir, d.name, '_enriched.json')
          if (existsSync(enrichedPath)) paths.push(enrichedPath)
          return paths
        })
    } catch { return [] }
  },

  async ensureFresh(_customerSlug: string): Promise<void> {
    const productsDir = getProductsDir()
    if (!existsSync(productsDir)) {
      // No local data — try downloading from Drive
      try {
        await downloadProductsFromDrive()
      } catch (e: any) {
        console.warn(`[saleshub-products] Drive download failed in ensureFresh: ${e.message}`)
      }
      resetProductCache()
      return
    }

    // Check mtime of the products directory itself
    try {
      const stat = statSync(productsDir)
      if (Date.now() - stat.mtimeMs < this.cacheTtlMs!) return // fresh
    } catch { /* needs refresh */ }

    // Stale — download from Drive, then reset cache
    try {
      await downloadProductsFromDrive()
    } catch (e: any) {
      console.warn(`[saleshub-products] Drive download failed in ensureFresh — using disk: ${e.message}`)
    }
    resetProductCache()
  },

  async fetch(_customerName: string): Promise<void> {
    // Portfolio-wide, not per-customer
    resetProductCache()
    const products = loadProducts()
    FeatureModuleRegistry.recordOutcome('saleshub-products', {
      success: true,
      recordCount: products.size,
    })
  },

  async cleanup(_customerName: string): Promise<void> {
    // No-op: product data is shared config, not per-customer cache
  },

  async syncNow(_customerName: string): Promise<void> {
    // Download fresh product data from Drive before re-reading
    try {
      const result = await downloadProductsFromDrive()
      if (result) {
        console.log(`[saleshub-products] Downloaded ${result.downloaded} products from Drive: ${result.products.join(', ')}`)
      }
    } catch (e: any) {
      console.warn(`[saleshub-products] Drive download failed in syncNow — using disk: ${e.message}`)
    }
    resetProductCache()
    const products = loadProducts()

    if (products.size === 0) {
      console.warn('[saleshub-products] zero-record guard: 0 product directories found')
      FeatureModuleRegistry.recordOutcome('saleshub-products', {
        success: false,
        error: 'No product directories found',
      })
      return
    }

    const enrichedCount = [...products.values()].filter(p => p.enrichment !== null).length
    console.log(
      `[saleshub-products] loaded ${products.size} products (${enrichedCount} with enrichment)`
    )
    FeatureModuleRegistry.recordOutcome('saleshub-products', {
      success: true,
      recordCount: products.size,
    })
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const products = loadProducts()
    if (products.size === 0) return []

    // Load customer context for cross-referencing (ADR-029)
    const customerCtx = loadCustomerContext(customerSlug)

    const allSignals: Signal[] = []

    for (const [_slug, productData] of products) {
      // Check if this product matches customer subscriptions
      const matchTargets = [
        productData.product.name,
        productData.product.slug,
        ...(productData.product.tdpLinks ?? []).map(l => l.name),
      ].filter(t => t && t.length > 0)
      const isCustomerMatch = matchesSubscriptionProducts(matchTargets, customerCtx.products)

      const signals = emitProductSignals(productData, customerSlug, isCustomerMatch)
      allSignals.push(...signals)
    }

    return allSignals
  },
})

// ── Enrichment endpoint (Gap 2 — GitHub Issue #819) ─────────────────────────

import { Hono } from 'hono'
import { enrichProductDocuments } from '../lib/saleshub-product-enrichment.ts'
import { writeFileSync } from 'fs'

/**
 * Creates a Hono router with the POST /api/saleshub-products/enrich endpoint.
 * Wire into server.ts: app.route('/', createSaleshubProductsRouter())
 */
export function createSaleshubProductsRouter() {
  const router = new Hono()

  router.post('/api/saleshub-products/enrich', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const slug = (body as any).slug as string | undefined

    if (!slug) {
      return c.json({ error: 'Missing required field: slug' }, 400)
    }

    const productsDir = getProductsDir()
    const productDir = resolve(productsDir, slug)
    const productPath = resolve(productDir, '_product.json')

    // Also check the app-baked path for downloads (mounted path may only have _product.json)
    const appProductDir = resolve('config-templates', 'saleshub-products', slug)

    if (!existsSync(productPath) && !existsSync(resolve(appProductDir, '_product.json'))) {
      return c.json({ error: `Product not found: ${slug}` }, 404)
    }

    // Read _product.json
    let product: ProductPage
    try {
      product = JSON.parse(readFileSync(productPath, 'utf-8'))
    } catch (e: any) {
      return c.json({ error: `Failed to read product data: ${e.message}` }, 500)
    }

    // Collect documents to enrich from the product directory (check both mounted and app-baked paths)
    const documents: Array<{ name: string; content: string; type: string; cloudProvider?: string }> = []
    const dirsToScan = [productDir]
    if (appProductDir !== productDir && existsSync(appProductDir)) dirsToScan.push(appProductDir)

    // Scan for downloadable files in subdirectories
    try {
      const allSubdirs: Array<{ name: string; parentDir: string }> = []
      for (const scanDir of dirsToScan) {
        const subs = readdirSync(scanDir, { withFileTypes: true }).filter(d => d.isDirectory())
        for (const s of subs) allSubdirs.push({ name: s.name, parentDir: scanDir })
      }
      const subdirs = allSubdirs.map(s => ({ ...s, isDirectory: () => true }))

      for (const subdir of subdirs) {
        if (subdir.name === 'downloads') {
          // Scan download subdirectories for PDFs and text files
          const downloadsPath = resolve(subdir.parentDir, 'downloads')
          const dlSubdirs = readdirSync(downloadsPath, { withFileTypes: true }).filter(d => d.isDirectory())
          for (const dlSub of dlSubdirs) {
            const dlSubPath = resolve(downloadsPath, dlSub.name)
            const allFiles = readdirSync(dlSubPath)
            // Prefer HTML files over PDF — HTML preserves hyperlinks from Google Docs
            const htmlFiles = new Set(allFiles.filter(f => f.toLowerCase().endsWith('.html')).map(f => f.replace(/\.html$/i, '')))
            const dlFiles = allFiles.filter(f => {
              const lower = f.toLowerCase()
              if (!(lower.endsWith('.html') || lower.endsWith('.pdf') || lower.endsWith('.docx') || lower.endsWith('.pptx') ||
                lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.extracted.json'))) return false
              // Skip PDF if HTML version exists (HTML has hyperlinks)
              if (lower.endsWith('.pdf') && htmlFiles.has(f.replace(/\.pdf$/i, ''))) return false
              return true
            })
            for (const file of dlFiles) {
              const filePath = resolve(dlSubPath, file)
              let content: string
              const lower = file.toLowerCase()
              if (lower.endsWith('.html')) {
                // HTML files preserve hyperlinks from Google Docs — send as text
                content = readFileSync(filePath, 'utf-8')
              } else if (lower.endsWith('.pdf') || lower.endsWith('.docx') || lower.endsWith('.pptx')) {
                content = `[PDF:base64:${readFileSync(filePath).toString('base64')}]`
              } else {
                content = readFileSync(filePath, 'utf-8')
              }
              const subdirLower = dlSub.name.toLowerCase()
              const fileLower = file.toLowerCase()
              const combined = `${subdirLower} ${fileLower}`

              // Classify document type from directory AND filename
              let docType = 'content-kit'
              if (subdirLower.includes('messaging') || fileLower.includes('messaging guide')) docType = 'messaging-guide'
              else if (subdirLower.includes('battlecard') || fileLower.includes('battlecard')) docType = 'battlecard'
              else if (subdirLower.includes('competitive') || fileLower.includes('competitive') || fileLower.includes(' or openshift') || fileLower.includes(' vs ')) docType = 'competitive-review'
              else if (subdirLower.includes('case-study') || subdirLower.includes('case_study') || fileLower.includes('case study') || fileLower.includes('win wire') || fileLower.includes('go-live')) docType = 'case-study'
              else if (subdirLower.includes('customer-go-live') || subdirLower.includes('customer-success')) docType = 'case-study'
              else if (fileLower.includes('content kit')) docType = 'content-kit'
              else if (subdirLower.includes('e-book') || subdirLower.includes('ebook') || subdirLower.includes('overview')) docType = 'content-kit'

              // Detect cloud provider from directory name OR filename
              let cloudProvider: string | undefined
              if (combined.includes('aws') || combined.includes('rosa')) cloudProvider = 'AWS'
              else if (combined.includes('azure') || combined.includes(' aro ') || combined.includes('aro ')) cloudProvider = 'Azure'
              else if (combined.includes('google cloud') || combined.includes('gcp')) cloudProvider = 'Google Cloud'

              documents.push({ name: file.replace(/\.(pdf|docx|pptx|txt|md|extracted\.json)$/i, ''), content, type: docType, cloudProvider })
            }
          }
          continue
        }

        const subdirPath = resolve(subdir.parentDir, subdir.name)
        const files = readdirSync(subdirPath).filter(f =>
          f.endsWith('.txt') || f.endsWith('.md') || f.endsWith('.extracted.json')
        )

        for (const file of files) {
          const filePath = resolve(subdirPath, file)
          const content = readFileSync(filePath, 'utf-8')
          const subdirLower = subdir.name.toLowerCase()
          const fileLower = file.toLowerCase()
          const combined = `${subdirLower} ${fileLower}`

          let docType = 'content-kit'
          let cloudProvider: string | undefined
          if (subdirLower.includes('messaging') || fileLower.includes('messaging guide')) docType = 'messaging-guide'
          else if (subdirLower.includes('battlecard') || subdirLower.includes('compete') || fileLower.includes('battlecard')) docType = 'battlecard'

          if (combined.includes('aws') || combined.includes('rosa')) cloudProvider = 'AWS'
          else if (combined.includes('azure') || combined.includes(' aro ') || combined.includes('aro ')) cloudProvider = 'Azure'
          else if (combined.includes('google cloud') || combined.includes('gcp')) cloudProvider = 'Google Cloud'

          documents.push({
            name: file.replace(/\.(txt|md|extracted\.json)$/, ''),
            content,
            type: docType,
            cloudProvider,
          })
        }
      }
    } catch (e: any) {
      console.warn(`[saleshub-products] Error scanning product directory for enrichment: ${e.message}`)
    }

    if (documents.length === 0) {
      return c.json({
        slug,
        enriched: false,
        message: 'No enrichable documents found. Download documents first.',
        documentsFound: 0,
      })
    }

    // Run enrichment
    try {
      const enrichment = await enrichProductDocuments(slug, documents)

      // Write _enriched.json
      const enrichedPath = resolve(productDir, '_enriched.json')
      writeFileSync(enrichedPath, JSON.stringify(enrichment, null, 2))

      // Reset cache so next signals() call picks up enrichment
      resetProductCache()

      // Gate 3 Advisory: check signal matching against real customers (#874 PR 3)
      let advisory: Gate3Result | null = null
      try {
        advisory = runGate3Advisory(slug)
      } catch (e: any) {
        console.warn(`[saleshub-products] Gate 3 advisory failed (non-blocking): ${e.message}`)
      }

      return c.json({
        slug,
        enriched: true,
        documentsProcessed: documents.length,
        documentsEnriched: enrichment.documents.length,
        enrichedAt: enrichment.enrichedAt,
        gate3Advisory: advisory,
      })
    } catch (e: any) {
      return c.json({ error: `Enrichment failed: ${e.message}` }, 500)
    }
  })

  router.post('/api/saleshub-products/upload-to-drive', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const slug = (body as any).slug as string | undefined
    if (!slug) return c.json({ error: 'Missing required field: slug' }, 400)

    const productsDir = getProductsDir()
    const productPath = resolve(productsDir, slug, '_product.json')
    if (!existsSync(productPath)) return c.json({ error: `Product not found: ${slug}` }, 404)

    const product = JSON.parse(readFileSync(productPath, 'utf-8'))
    const enrichedPath = resolve(productsDir, slug, '_enriched.json')
    const enrichment = existsSync(enrichedPath) ? JSON.parse(readFileSync(enrichedPath, 'utf-8')) : undefined

    const { uploadProductToDrive, uploadProductFilesToDrive } = await import('../lib/saleshub-product-drive-sync.ts')
    const folderId = await uploadProductToDrive(slug, product, enrichment)

    // Also upload downloaded files if they exist
    const appProductDir = resolve('config-templates', 'saleshub-products', slug)
    const downloadsDir = resolve(appProductDir, 'downloads')
    let fileResult = { uploaded: 0, errors: 0 }
    if (existsSync(downloadsDir)) {
      fileResult = await uploadProductFilesToDrive(product.name ?? slug, downloadsDir)
    }

    return c.json({ slug, uploaded: !!folderId, driveFolderId: folderId, files: fileResult })
  })

  return router
}
