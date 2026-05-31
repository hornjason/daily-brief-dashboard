/**
 * Customer Context Loader — shared helper for portfolio-scope modules
 * GitHub Issues #475, #486
 *
 * Loads customer tech-stack and subscription data from cache files,
 * providing normalized string arrays for matching against portfolio items.
 * Used by ecosystem-catalog, saleshub-content, and partner-catalog modules
 * to conditionally set customerSlug in signal metadata.
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

function getCacheDir(): string {
  return process.env.CACHE_DIR ?? 'data/cache'
}

export interface CustomerContext {
  /** Lowercased tech-stack technology names (e.g., ['vmware', 'kubernetes', 'docker']) */
  techs: string[]
  /** Lowercased subscription product descriptions (e.g., ['red hat enterprise linux', 'openshift container platform']) */
  products: string[]
}

/**
 * Load customer context from cache files.
 * Returns empty arrays when cache files are missing — graceful fallback.
 */
export function loadCustomerContext(customerSlug: string): CustomerContext {
  const techs = loadTechStack(customerSlug)
  const products = loadSubscriptionProducts(customerSlug)
  return { techs, products }
}

/**
 * Check if any of the target strings match against customer tech names.
 * Case-insensitive substring match: returns true if any tech name
 * contains any word from any target, or vice versa.
 */
export function matchesTechStack(targets: string[], customerTechs: string[]): boolean {
  if (customerTechs.length === 0 || targets.length === 0) return false

  for (const target of targets) {
    const targetLower = target.toLowerCase()
    for (const tech of customerTechs) {
      // Bidirectional substring match
      if (tech.includes(targetLower) || targetLower.includes(tech)) {
        return true
      }
    }
  }
  return false
}

/**
 * Check if any of the target product/tdp strings match against customer subscription products.
 * Case-insensitive substring match.
 */
export function matchesSubscriptionProducts(targets: string[], customerProducts: string[]): boolean {
  if (customerProducts.length === 0 || targets.length === 0) return false

  for (const target of targets) {
    const targetLower = target.toLowerCase()
    for (const product of customerProducts) {
      if (product.includes(targetLower) || targetLower.includes(product)) {
        return true
      }
    }
  }
  return false
}

function loadTechStack(customerSlug: string): string[] {
  try {
    const techCachePath = resolve(getCacheDir(), 'tech-stack', `${customerSlug}.json`)
    if (!existsSync(techCachePath)) return []
    const techData = JSON.parse(readFileSync(techCachePath, 'utf-8'))
    return (techData.technologies ?? [])
      .map((t: any) => (t.name ?? '').toLowerCase())
      .filter((n: string) => n.length > 0)
  } catch {
    return []
  }
}

function loadSubscriptionProducts(customerSlug: string): string[] {
  try {
    const sheetCachePath = resolve(getCacheDir(), `${customerSlug}-sheets.json`)
    if (!existsSync(sheetCachePath)) return []
    const sheetData = JSON.parse(readFileSync(sheetCachePath, 'utf-8'))
    const rows = sheetData.rows ?? sheetData.subscriptions ?? (Array.isArray(sheetData) ? sheetData : [])
    return rows
      .map((r: any) => (r.productDescription ?? '').toLowerCase())
      .filter((n: string) => n.length > 0)
  } catch {
    return []
  }
}
