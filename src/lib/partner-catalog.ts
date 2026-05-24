// src/lib/partner-catalog.ts
// GitHub Issue #265 — Partner Catalog Pipeline
// Partner data lookup, matching, and product-partner alignment.
// Reads structured partner data from data/config/partners.json.

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PartnerCredential {
  /** e.g. "Red Hat Ansible Automation Platform: Technical Seller" */
  name: string
  /** credential vs certification */
  type: 'credential' | 'certification'
  /** e.g. "Ansible Automation Platform" */
  product: string
  /** Number of certified individuals */
  count: number
}

export interface Partner {
  name: string
  aliases: string[]
  domain: string
  partnershipLevel: string
  specializations: string[]
  geo: string
  country: string
  catalogUrl?: string
  sourceUrl?: string
  /** URL slug on catalog.redhat.com */
  slug?: string
  /** Overview description from catalog page */
  overview?: string
  /** Credential and certification details from Areas of Expertise tab */
  credentials?: PartnerCredential[]
}

export interface PartnerMatch {
  partner: Partner
  /** Which products matched */
  matchedProducts: string[]
  /** How the match was found: specialization, credential, or both */
  matchType: ('specialization' | 'credential')[]
  /** Total certified individuals across matched credentials */
  credentialCount: number
}

// ── Product-to-specialization mapping ─────────────────────────────────────────
// Maps Red Hat product names to partner specialization keywords for matching.

const PRODUCT_SPECIALIZATION_MAP: Record<string, string[]> = {
  'Ansible Automation Platform': ['Mission Critical Automation', 'Automation'],
  'OpenShift Container Platform': ['Container Mgmt', 'Container Management'],
  'Red Hat Enterprise Linux': ['Server Cloud OS', 'Server Cloud'],
  'Red Hat Virtualization': ['Virtualization'],
  'Application Platform': ['Application Platform'],
}

// ── Loading ───────────────────────────────────────────────────────────────────

/**
 * Load partners from a JSON file path.
 * Returns empty array on missing file or parse error (fail-open).
 */
export function loadPartners(filePath: string): Partner[] {
  if (!existsSync(filePath)) return []
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return []
  }
}

/**
 * Load partners from the default config path.
 */
export function loadPartnersFromConfig(): Partner[] {
  const configDir = process.env.CONFIG_DIR ?? 'data/config'
  return loadPartners(resolve(configDir, 'partners.json'))
}

// ── Lookup ────────────────────────────────────────────────────────────────────

/**
 * Find a partner by email/web domain.
 * Matches on exact domain or subdomain (e.g. "mail.cdw.com" matches "cdw.com").
 */
export function findPartnerByDomain(domain: string, partners: Partner[]): Partner | undefined {
  const d = domain.toLowerCase()
  return partners.find(p => d === p.domain || d.endsWith('.' + p.domain))
}

/**
 * Find a partner by name or alias (case-insensitive).
 * Matches exact name, any alias, or if the query is contained in name/aliases.
 */
export function findPartnerByName(query: string, partners: Partner[]): Partner | undefined {
  const q = query.toLowerCase()
  return partners.find(p => {
    if (p.name.toLowerCase() === q) return true
    if (p.aliases.some(a => a.toLowerCase() === q)) return true
    // Check if query matches an alias substring
    if (p.aliases.some(a => a.toLowerCase().includes(q) || q.includes(a.toLowerCase()))) return true
    // Check if query is contained in the full name
    if (p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase())) return true
    return false
  })
}

// ── Product-Partner Matching ────────────────────────────────────────────────

/**
 * Given a list of Red Hat product names, find partners with matching
 * specializations or credentials. Returns matches sorted by credential
 * depth (descending).
 */
export function matchPartnersToProducts(
  products: string[],
  partners: Partner[]
): PartnerMatch[] {
  const matches: PartnerMatch[] = []

  for (const partner of partners) {
    const matchedProducts: string[] = []
    const matchType = new Set<'specialization' | 'credential'>()
    let credentialCount = 0

    for (const product of products) {
      const productLower = product.toLowerCase()

      // Check specializations via mapping
      const specKeywords = PRODUCT_SPECIALIZATION_MAP[product] ?? []
      const specMatch = partner.specializations.some(s =>
        specKeywords.some(k => s.toLowerCase().includes(k.toLowerCase()))
      )
      if (specMatch) {
        matchedProducts.push(product)
        matchType.add('specialization')
      }

      // Check credentials
      if (partner.credentials) {
        for (const cred of partner.credentials) {
          if (cred.product.toLowerCase().includes(productLower) ||
              productLower.includes(cred.product.toLowerCase())) {
            if (!matchedProducts.includes(product)) matchedProducts.push(product)
            matchType.add('credential')
            credentialCount += cred.count
          }
        }
      }
    }

    if (matchedProducts.length > 0) {
      matches.push({
        partner,
        matchedProducts,
        matchType: Array.from(matchType),
        credentialCount,
      })
    }
  }

  // Sort by credential count descending, then by number of matched products
  matches.sort((a, b) => {
    if (b.credentialCount !== a.credentialCount) return b.credentialCount - a.credentialCount
    return b.matchedProducts.length - a.matchedProducts.length
  })

  return matches
}
