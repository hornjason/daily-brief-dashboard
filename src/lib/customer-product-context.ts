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
    const path = resolve(getConfigDir(), 'customers.json')
    if (!existsSync(path)) return []

    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    const customers = Array.isArray(parsed) ? parsed : parsed.customers ?? []

    const customer = customers.find((c: any) => toSlug(c.name) === customerSlug || c.slug === customerSlug)
    if (!customer || !customer.subscriptions) return []

    const products: string[] = []
    for (const sub of customer.subscriptions) {
      const name = (sub.productName || sub.product || '').toLowerCase()
      if (!name) continue

      if (name.includes('openshift ai') || name.includes('rhoai')) products.push('rhoai')
      else if (name.includes('openshift')) products.push('ocp')
      else if (name.includes('enterprise linux') || name.includes('rhel')) products.push('rhel')
      else if (name.includes('ansible')) products.push('aap')
      else if (name.includes('cluster security') || name.includes('acs')) products.push('acs')
      else if (name.includes('cluster management') || name.includes('acm')) products.push('acm')
      else if (name.includes('quay')) products.push('quay')
      else if (name.includes('developer hub') || name.includes('rhdh')) products.push('rhdh')
      else if (name.includes('satellite')) products.push('satellite')
      else if (name.includes('insights')) products.push('insights')
    }

    return [...new Set(products)]
  } catch (e: any) {
    console.warn(`[customer-product-context] Failed to extract owned products for ${customerSlug}:`, e?.message)
    return []
  }
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
