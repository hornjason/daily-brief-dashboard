/**
 * Product Vocabulary Resolver — GitHub Issue #676
 *
 * Shared module that resolves between Red Hat product slugs, display names,
 * short names, and aliases. Fixes vocabulary mismatch preventing ecosystem
 * catalog data from passing through filterByProduct().
 *
 * Builds an in-memory index on first call (lazy singleton) from
 * product-intel-config.json. All lookups are case-insensitive exact matches.
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { CONFIG_DIR } from './paths.ts'

// ── Types ────────────────────────────────────────────────────────────────────

interface ProductEntry {
  slug: string
  displayName: string
  shortName: string
  subscriptionPatterns: string[]
  caseProductPatterns: string[]
}

interface ProductIndex {
  /** lowercase key → slug */
  lookup: Map<string, string>
  /** slug → ProductEntry */
  bySlug: Map<string, ProductEntry>
  /** all slugs in config order */
  slugs: string[]
}

// ── Lazy Singleton ───────────────────────────────────────────────────────────

let _index: ProductIndex | null = null

function loadConfig(): ProductEntry[] {
  const paths = [
    resolve(CONFIG_DIR, 'product-intel-config.json'),
    resolve('config-templates', 'product-intel-config.json'),
  ]

  for (const p of paths) {
    try {
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, 'utf-8'))
        return Array.isArray(raw.products) ? raw.products : []
      }
    } catch { /* try next */ }
  }

  return []
}

function buildIndex(): ProductIndex {
  if (_index) return _index

  const products = loadConfig()
  const lookup = new Map<string, string>()
  const bySlug = new Map<string, ProductEntry>()
  const slugs: string[] = []

  for (const product of products) {
    const slug = product.slug
    slugs.push(slug)
    bySlug.set(slug, product)

    // Register all name variants (lowercase) → slug
    // Order matters: later entries don't overwrite earlier ones
    const variants: string[] = [
      slug,
      product.displayName,
      product.shortName,
      ...(product.subscriptionPatterns ?? []),
      ...(product.caseProductPatterns ?? []),
    ]

    for (const v of variants) {
      if (!v) continue
      const key = v.toLowerCase()
      if (!lookup.has(key)) {
        lookup.set(key, slug)
      }
    }
  }

  _index = { lookup, bySlug, slugs }
  return _index
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve any product name/alias/pattern to its canonical slug.
 * Case-insensitive exact match. Returns null if no match.
 *
 * Match order:
 * 1. slug (identity)
 * 2. displayName
 * 3. shortName
 * 4. subscriptionPatterns
 * 5. caseProductPatterns
 */
export function resolveToSlug(input: string): string | null {
  if (!input) return null
  const index = buildIndex()
  return index.lookup.get(input.toLowerCase()) ?? null
}

/**
 * Get the full display name for a product slug.
 * Returns null if slug not found.
 */
export function resolveToDisplayName(slug: string): string | null {
  const index = buildIndex()
  return index.bySlug.get(slug)?.displayName ?? null
}

/**
 * Get the short name for a product slug.
 * Returns null if slug not found.
 */
export function resolveToShortName(slug: string): string | null {
  const index = buildIndex()
  return index.bySlug.get(slug)?.shortName ?? null
}

/**
 * Get all known aliases for a product slug (deduplicated).
 * Includes: slug, displayName, shortName, subscriptionPatterns, caseProductPatterns.
 * Returns empty array if slug not found.
 */
export function getAliases(slug: string): string[] {
  const index = buildIndex()
  const product = index.bySlug.get(slug)
  if (!product) return []

  const all = new Set<string>()
  all.add(product.slug)
  all.add(product.displayName)
  if (product.shortName) all.add(product.shortName)
  for (const p of product.subscriptionPatterns ?? []) if (p) all.add(p)
  for (const p of product.caseProductPatterns ?? []) if (p) all.add(p)

  return Array.from(all)
}

/**
 * Get all product slugs from the config.
 */
export function getAllSlugs(): string[] {
  return buildIndex().slugs.slice()
}

/**
 * Get all product display names from the config.
 */
export function getAllProductNames(): string[] {
  const index = buildIndex()
  return index.slugs.map(s => index.bySlug.get(s)!.displayName)
}

/**
 * Reset the cached index. For testing only.
 */
export function resetCache(): void {
  _index = null
}
