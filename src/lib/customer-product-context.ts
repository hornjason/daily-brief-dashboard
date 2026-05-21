/**
 * Customer Product Context Utility (ADR-029)
 * Extracts product context for a customer from subscriptions and intelligence themes.
 * Used by portfolio-level modules (lifecycle, product-intel, RSS, events, value-maps)
 * to conditionally set customerSlug in signal metadata.
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { toSlug } from '../cache-layer.ts'

function getConfigDir(): string {
  return process.env.CONFIG_DIR ?? 'config'
}

function getCacheDir(): string {
  return process.env.CACHE_DIR ?? 'data/cache'
}

export interface CustomerProductContext {
  ownedProducts: string[]
  interestProducts: string[]
  allRelevantProducts: string[]
}

const PRODUCT_SLUG_MAP: Record<string, string> = {
  'openshift': 'ocp',
  'openshift container platform': 'ocp',
  'openshift ai': 'rhoai',
  'enterprise linux': 'rhel',
  'rhel': 'rhel',
  'ansible': 'aap',
  'ansible automation platform': 'aap',
  'advanced cluster security': 'acs',
  'advanced cluster management': 'acm',
  'quay': 'quay',
  'developer hub': 'rhdh',
  'satellite': 'satellite',
  'insights': 'insights',
}

export function normalizeProductSlug(name: string): string | undefined {
  const normalized = name.toLowerCase().trim()

  if (PRODUCT_SLUG_MAP[normalized]) return PRODUCT_SLUG_MAP[normalized]

  // Substring match — check more specific patterns first
  if (normalized.includes('openshift ai') || normalized.includes('rhoai')) return 'rhoai'
  if (normalized.includes('openshift')) return 'ocp'
  if (normalized.includes('enterprise linux') || normalized.includes('rhel')) return 'rhel'
  if (normalized.includes('ansible')) return 'aap'
  if (normalized.includes('cluster security') || normalized.includes('acs')) return 'acs'
  if (normalized.includes('cluster management') || normalized.includes('acm')) return 'acm'
  if (normalized.includes('quay')) return 'quay'
  if (normalized.includes('developer hub') || normalized.includes('rhdh')) return 'rhdh'
  if (normalized.includes('satellite')) return 'satellite'
  if (normalized.includes('insights')) return 'insights'
  if (normalized.includes('runtimes')) return 'runtimes'
  if (normalized.includes('integration')) return 'integration'

  return undefined
}

export function getCustomerProductContext(customerSlug: string): CustomerProductContext {
  const ownedProducts = extractOwnedProducts(customerSlug)
  const interestProducts = extractInterestProducts(customerSlug)
  const allRelevantProducts = [...new Set([...ownedProducts, ...interestProducts])]

  return { ownedProducts, interestProducts, allRelevantProducts }
}

function extractOwnedProducts(customerSlug: string): string[] {
  try {
    // Primary source: sheets cache (same source as subscriptions-module)
    const sheetsPath = resolve(getCacheDir(), `${customerSlug}-sheets.json`)
    if (existsSync(sheetsPath)) {
      const data = JSON.parse(readFileSync(sheetsPath, 'utf-8'))
      const rows = data.rows ?? data.subscriptions ?? (Array.isArray(data) ? data : [])
      if (rows.length > 0) return extractProductSlugsFromRows(rows)
    }

    // Fallback: customers.json subscriptions field (if populated by SF bookings sync)
    const configPath = resolve(getConfigDir(), 'customers.json')
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
      const customers = Array.isArray(parsed) ? parsed : parsed.customers ?? []
      const customer = customers.find((c: any) => toSlug(c.name) === customerSlug || c.slug === customerSlug)
      if (customer?.subscriptions?.length > 0) {
        return extractProductSlugsFromRows(customer.subscriptions)
      }
    }

    return []
  } catch (e: any) {
    console.warn(`[customer-product-context] Failed to extract owned products for ${customerSlug}:`, e?.message)
    return []
  }
}

function extractProductSlugsFromRows(rows: any[]): string[] {
  const products: string[] = []
  for (const row of rows) {
    const name = (row.productDescription || row.productName || row.product || row.SKU || '').toLowerCase()
    if (!name) continue

    const slug = normalizeProductSlug(name)
    if (slug) products.push(slug)
  }
  return [...new Set(products)]
}

function extractInterestProducts(_customerSlug: string): string[] {
  try {
    const intelligencePath = resolve(getCacheDir(), 'intelligence', `${_customerSlug}.json`)
    if (!existsSync(intelligencePath)) return []

    // Subscription match alone solves the primary problem per ADR-029.
    // Interest match from intelligence themes is a future enhancement.
    return []
  } catch {
    return []
  }
}
