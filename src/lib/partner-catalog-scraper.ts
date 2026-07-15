// src/lib/partner-catalog-scraper.ts
// GitHub Issue #997 — catalog.redhat.com partner scraper
// Pure HTTP scraper — no Playwright. Extracts partner tier from og:description
// meta tag and specializations from page text.

import { readTerritoryPartners, type TerritoryPartner } from './territory-partner-generator.ts'
import { writeJsonAtomic } from './atomic-write.ts'
import { CACHE_DIR } from './paths.ts'
import { resolve } from 'path'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CatalogEnrichment {
  partnershipLevel: string | null
  overview: string | null
  specializations: string[]
  catalogUrl: string
}

export type EnrichmentResult =
  | (CatalogEnrichment & { enrichmentStatus: 'enriched' })
  | { enrichmentStatus: 'not-found' }

// ── Constants ──────────────────────────────────────────────────────────────────

const CATALOG_BASE = 'https://catalog.redhat.com/en/partners/detail'
const TERRITORY_PARTNERS_PATH = resolve(CACHE_DIR, 'territory-partners.json')
const ENRICHMENT_DELAY_MS = 2000

/** Known Red Hat partner tier keywords (order matters — first match wins) */
const TIER_PATTERNS: Array<{ pattern: RegExp; tier: string }> = [
  { pattern: /Red\s+Hat\s+Specialized\s+Partner\s*\(RHSP\)/i, tier: 'RHSP' },
  { pattern: /Premier\s+Partner/i, tier: 'Premier' },
  { pattern: /Advanced\s+Partner/i, tier: 'Advanced' },
  { pattern: /Ready\s+Partner/i, tier: 'Ready' },
]

/** Known specialization names to extract from page text */
const SPECIALIZATION_NAMES = [
  'Mission Critical Automation',
  'Container Management',
  'Virtualization',
  'Cloud-Native Development',
  'Infrastructure Migration',
  'Application Modernization',
  'Data Analytics',
  'Edge Computing',
  'Hybrid Cloud Infrastructure',
]

// ── Slug Resolution ────────────────────────────────────────────────────────────

/**
 * Convert a partner name to a URL slug for catalog.redhat.com.
 * Strategy: lowercase, strip non-alphanumeric (except spaces/hyphens),
 * collapse whitespace to single hyphens.
 */
export function resolvePartnerSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')  // strip punctuation
    .replace(/\s+/g, '-')           // spaces → hyphens
    .replace(/-+/g, '-')            // collapse consecutive hyphens
    .replace(/^-|-$/g, '')          // trim leading/trailing hyphens
}

// ── HTTP Fetch ─────────────────────────────────────────────────────────────────

/**
 * Fetch the partner detail page HTML from catalog.redhat.com.
 * Returns HTML string on success, null on 404 or network error.
 */
export async function fetchPartnerPage(slug: string): Promise<string | null> {
  const url = `${CATALOG_BASE}/${slug}`
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PAI-Dashboard/1.0)',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

// ── HTML Parsing ───────────────────────────────────────────────────────────────

/**
 * Parse partner page HTML to extract tier, overview, and specializations.
 * Sources:
 *   - og:description meta tag → partnershipLevel + overview
 *   - Page text / RSC stream → specializations
 */
export function parsePartnerPage(
  html: string,
  slug: string,
): CatalogEnrichment {
  const catalogUrl = `${CATALOG_BASE}/${slug}`

  // Extract og:description content
  const ogMatch = html.match(
    /<meta\s+(?:property|name)="og:description"\s+content="([^"]*)"/i,
  ) ?? html.match(
    /content="([^"]*)"\s+(?:property|name)="og:description"/i,
  )
  const ogDescription = ogMatch?.[1] ?? ''

  // Parse partnership level from og:description
  let partnershipLevel: string | null = null
  for (const { pattern, tier } of TIER_PATTERNS) {
    if (pattern.test(ogDescription)) {
      partnershipLevel = tier
      break
    }
  }

  // Extract overview: text after the tier declaration in og:description
  let overview: string | null = null
  if (ogDescription) {
    // Remove the tier prefix to get the description portion
    // Pattern: "Red Hat <Tier> Partner (RHSP)  CompanyName is a..."
    // or "Red Hat <Tier> Partner  CompanyName is a..."
    const overviewMatch = ogDescription.match(
      /(?:Red\s+Hat\s+\w+\s+Partner(?:\s*\(RHSP\))?)\s{2,}(.+)/i,
    )
    overview = overviewMatch?.[1]?.trim() ?? ogDescription.trim()
    if (!overview) overview = null
  }

  // Extract specializations from full page text
  const specializations: string[] = []
  for (const specName of SPECIALIZATION_NAMES) {
    // Case-insensitive search in full HTML (covers RSC stream text too)
    if (html.toLowerCase().includes(specName.toLowerCase())) {
      specializations.push(specName)
    }
  }

  return { partnershipLevel, overview, specializations, catalogUrl }
}

// ── Enrichment ─────────────────────────────────────────────────────────────────

/**
 * Enrich a single partner by name from catalog.redhat.com.
 * Tries the primary slug, then falls back to slug variations.
 */
export async function enrichPartnerFromCatalog(
  name: string,
): Promise<EnrichmentResult> {
  const primarySlug = resolvePartnerSlug(name)
  const slugs = [primarySlug]

  // Add simplified slug (first two words) if different from primary
  const words = name.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
  if (words.length > 2) {
    const simplified = words.slice(0, 2).join('-')
    if (simplified !== primarySlug) slugs.push(simplified)
  }

  // Also try just the first word if different
  if (words.length > 1) {
    const firstWord = words[0]
    if (firstWord !== primarySlug && !slugs.includes(firstWord)) {
      slugs.push(firstWord)
    }
  }

  for (const slug of slugs) {
    const html = await fetchPartnerPage(slug)
    if (!html) continue

    const parsed = parsePartnerPage(html, slug)
    return {
      ...parsed,
      enrichmentStatus: 'enriched' as const,
    }
  }

  return { enrichmentStatus: 'not-found' }
}

// ── Batch Enrichment ───────────────────────────────────────────────────────────

/**
 * Delay helper for rate limiting between catalog requests.
 * Reassignable for test injection.
 */
export let delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Test-only: replace the delay function. Returns a restore callback. */
export function _setDelay(fn: (ms: number) => Promise<void>): () => void {
  const prev = delay
  delay = fn
  return () => { delay = prev }
}

/**
 * Batch-enrich all pending territory partners from catalog.redhat.com.
 * Reads territory-partners.json, filters to pending entries, enriches each
 * with a 2s delay between requests, and writes back.
 *
 * @param path - Override path for territory-partners.json
 * @returns Count of enriched entries
 */
export async function enrichTerritoryPartners(
  path: string = TERRITORY_PARTNERS_PATH,
): Promise<number> {
  const partners = readTerritoryPartners(path)
  const pending = partners.filter((p) => p.enrichmentStatus === 'pending')

  if (pending.length === 0) return 0

  let enrichedCount = 0
  for (let i = 0; i < pending.length; i++) {
    const partner = pending[i]
    const result = await enrichPartnerFromCatalog(partner.name)

    // Find the entry in the full array and update
    const idx = partners.findIndex(
      (p) => p.name.toLowerCase() === partner.name.toLowerCase(),
    )
    if (idx === -1) continue

    if (result.enrichmentStatus === 'enriched') {
      partners[idx] = {
        ...partners[idx],
        enrichmentStatus: 'enriched',
        partnershipLevel: result.partnershipLevel,
        specializations: result.specializations,
        catalogUrl: result.catalogUrl,
      }
      enrichedCount++
    } else {
      partners[idx] = {
        ...partners[idx],
        enrichmentStatus: 'not-found',
      }
    }

    // Rate limit: 2s delay between requests (skip after last)
    if (i < pending.length - 1) {
      await delay(ENRICHMENT_DELAY_MS)
    }
  }

  writeJsonAtomic(path, partners)
  return enrichedCount
}
