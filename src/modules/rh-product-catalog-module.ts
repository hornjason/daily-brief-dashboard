// src/modules/rh-product-catalog-module.ts
// GitHub Issue #677 — RH Product Catalog feature module (Phase 1: scraper + seed data)
// Maintains a canonical product catalog by scraping redhat.com/en/products.
// This module is a data source for the vocabulary resolver — it does not produce signals.
// Products are loaded from CONFIG_DIR first (live cache), falling back to config-templates (seed).

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { resolve, dirname } from 'path'

const CONFIG_DIR = process.env.CONFIG_DIR ?? 'data/config'
const CATALOG_PATH = resolve(CONFIG_DIR, 'rh-product-catalog.json')
const SEED_PATH = resolve('config-templates', 'rh-product-catalog.json')
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // Weekly
const SOURCE_URL = 'https://www.redhat.com/en/products'

interface CatalogProduct {
  name: string
  category: string
  url?: string
}

interface ProductCatalog {
  version: number
  refreshedAt: string
  source: string
  products: CatalogProduct[]
}

/**
 * Load product catalog from CONFIG_DIR (live cache) or config-templates (seed).
 * Returns null if neither file exists.
 */
export function loadProductCatalog(): ProductCatalog | null {
  for (const path of [CATALOG_PATH, SEED_PATH]) {
    try {
      if (existsSync(path)) {
        return JSON.parse(readFileSync(path, 'utf-8'))
      }
    } catch (e: any) {
      console.warn(`[rh-product-catalog] Failed to read ${path}: ${e.message}`)
    }
  }
  return null
}

/**
 * Parse product entries from the redhat.com/en/products HTML page.
 * Uses regex/string matching (no DOM parser required).
 * The page has category sections with product links.
 */
function parseProductsFromHtml(html: string): CatalogProduct[] {
  const products: CatalogProduct[] = []
  const seen = new Set<string>()

  // The page uses category headings (h2/h3) followed by product links.
  // Products appear as links with text containing "Red Hat" or product names.
  // Pattern: look for links within category sections.

  // Strategy: find all <a> tags that link to /en/technologies/ or /en/products/
  // and extract the text + href. Category is inferred from the URL path.
  const linkRegex = /<a[^>]+href="(\/en\/(?:technologies|products|lightspeed|services)[^"]*)"[^>]*>([^<]+)<\/a>/gi
  let match

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1]
    const rawName = match[2].trim()

    // Skip navigation/generic links
    if (!rawName || rawName.length < 3) continue
    if (rawName.toLowerCase().includes('learn more')) continue
    if (rawName.toLowerCase().includes('see all')) continue
    if (rawName.toLowerCase().includes('view all')) continue
    if (rawName.toLowerCase() === 'products') continue

    // Normalize name: ensure "Red Hat" prefix for known products
    let name = rawName
    if (!name.startsWith('Red Hat') && !name.startsWith('Microsoft') && !name.startsWith('3scale')) {
      // Check if this is a known Red Hat product short name
      if (href.includes('/technologies/') || href.includes('/products/')) {
        name = `Red Hat ${name}`
      }
    }

    // Deduplicate by name
    if (seen.has(name)) continue
    seen.add(name)

    // Infer category from URL path
    const category = inferCategoryFromUrl(href)

    products.push({
      name,
      category,
      url: `https://www.redhat.com${href}`,
    })
  }

  return products
}

/**
 * Infer product category from the URL path on redhat.com.
 */
function inferCategoryFromUrl(href: string): string {
  if (href.includes('/linux-platforms/')) return 'Linux Platforms'
  if (href.includes('/products/ai')) return 'Artificial Intelligence'
  if (href.includes('/cloud-computing/openshift')) return 'Cloud Computing'
  if (href.includes('/cloud-computing/')) return 'Cloud Computing'
  if (href.includes('/management/')) return 'Management'
  if (href.includes('/jboss-middleware/')) return 'Application Services'
  if (href.includes('/device-edge')) return 'Cloud Computing'
  if (href.includes('/lightspeed')) return 'Management'
  if (href.includes('/services/')) return 'Professional Services'
  if (href.includes('/products/runtimes')) return 'Application Services'
  if (href.includes('/products/application-foundations')) return 'Application Services'
  if (href.includes('/products/desktop')) return 'Cloud Computing'
  if (href.includes('/products/advanced-developer-suite')) return 'Cloud Computing'
  return 'Other'
}

FeatureModuleRegistry.register({
  name: 'rh-product-catalog',
  displayName: 'Product Catalog',
  refreshEndpoint: '/api/refresh/rh-product-catalog',
  signalRole: 'enrichment',
  signalAudience: 'all',
  scope: 'portfolio',

  cacheTtlMs: CACHE_TTL_MS,
  refreshInterval: CACHE_TTL_MS, // Weekly auto-refresh

  cachePaths: (_slug: string) => [CATALOG_PATH],

  async ensureFresh(_customerSlug: string): Promise<void> {
    try {
      if (existsSync(CATALOG_PATH)) {
        const stat = statSync(CATALOG_PATH)
        if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) return // fresh
      }
    } catch {
      // File missing — will use seed data
    }
    // Stale or missing — try a live refresh
    console.log('[rh-product-catalog] cache is stale or missing — attempting live refresh')
    try {
      await this.syncNow('')
    } catch (e: any) {
      console.warn(`[rh-product-catalog] ensureFresh refresh failed: ${e.message}`)
    }
  },

  async fetch(_customerName: string): Promise<void> {
    // Portfolio-wide data, not per-customer
  },

  async cleanup(_customerName: string): Promise<void> {
    // Portfolio-level cache — no per-customer cleanup
  },

  async syncNow(_customerName: string): Promise<void> {
    console.log(`[rh-product-catalog] fetching product catalog from ${SOURCE_URL}`)
    try {
      const response = await fetch(SOURCE_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PAI-Dashboard/1.0)',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(15_000),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const html = await response.text()
      const products = parseProductsFromHtml(html)

      if (products.length < 10) {
        console.warn(`[rh-product-catalog] parsed only ${products.length} products — page structure may have changed, keeping existing cache`)
        FeatureModuleRegistry.recordOutcome('rh-product-catalog', {
          success: false,
          error: `Only ${products.length} products parsed — likely page structure change`,
        })
        return
      }

      const catalog: ProductCatalog = {
        version: 1,
        refreshedAt: new Date().toISOString(),
        source: SOURCE_URL,
        products,
      }

      // Ensure config directory exists
      const dir = dirname(CATALOG_PATH)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2))
      console.log(`[rh-product-catalog] wrote ${products.length} products to ${CATALOG_PATH}`)
      FeatureModuleRegistry.recordOutcome('rh-product-catalog', {
        success: true,
        recordCount: products.length,
      })
    } catch (e: any) {
      console.warn(`[rh-product-catalog] fetch failed: ${e.message} — existing cache preserved`)
      FeatureModuleRegistry.recordOutcome('rh-product-catalog', {
        success: false,
        error: e.message,
      })
      // Don't overwrite existing cache on failure — graceful degradation
    }
  },

  async signals(_customerSlug: string): Promise<Signal[]> {
    // This module is a data source for the vocabulary resolver, not a signal producer.
    return []
  },
})
