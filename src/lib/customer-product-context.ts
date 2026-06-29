/**
 * Customer Product Context Utility (ADR-029)
 * Extracts product context for a customer from subscriptions and intelligence themes.
 * Used by portfolio-level modules (lifecycle, product-intel, RSS, events, value-maps)
 * to conditionally set customerSlug in signal metadata.
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { toSlug } from '../cache-layer.ts'
import { resolveToSlug } from './product-vocabulary.ts'

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

    const slug = resolveToSlug(name)
    if (slug) products.push(slug)
  }
  return [...new Set(products)]
}

function extractInterestProducts(customerSlug: string): string[] {
  try {
    const intelligencePath = resolve(getCacheDir(), 'intelligence', `${customerSlug}.json`)
    if (!existsSync(intelligencePath)) return []

    const data = JSON.parse(readFileSync(intelligencePath, 'utf-8'))
    const company: string = data.company ?? ''
    if (!company) return []

    // Parse "### {Product} Fit" headings from "Whitespace & Opportunity Mapping" section
    const whitespaceStart = company.indexOf('Whitespace')
    if (whitespaceStart === -1) return []

    const whitespaceText = company.substring(whitespaceStart)
    const fitHeadings = whitespaceText.match(/^### (.+?)\s*Fit/gm) ?? []

    const products: string[] = []
    for (const heading of fitHeadings) {
      const productName = heading.replace('### ', '').replace(/\s*Fit$/, '').trim()
      const slug = resolveToSlug(productName)
      if (slug) products.push(slug)
    }

    return [...new Set(products)]
  } catch (e: any) {
    console.warn(`[customer-product-context] Failed to extract interest products for ${customerSlug}:`, e?.message)
    return []
  }
}
