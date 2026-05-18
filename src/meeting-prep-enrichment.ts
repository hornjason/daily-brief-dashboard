/**
 * Meeting Prep Enrichment — ADR-025
 *
 * Four pure sync builder functions that produce deterministic markdown tables
 * for injection after Gemini-generated sections 4-7 of meeting prep docs.
 * No Gemini calls. No async. No side effects.
 *
 * Pattern: same insertAfterNumberedSection() used for section 2 partners table.
 */

import { readFileSync, existsSync } from 'fs'
import type { Customer, ProductSubscription } from './types.ts'
import type { ProductSummary } from './product-release-radar.ts'
import type { ProductLifecycleCache } from './product-lifecycle.ts'
import type { CustomerProductIntel } from './customer-product-intel.ts'

/** Compatible with both RSSItem from rh-rss-fetcher.ts and the narrower type in meeting-prep-routes.ts */
export interface RSSItemLike {
  title: string
  link: string
  pubDate: string
  source: string
  productTags: string[]
  description?: string
}

// ── Types ────────────────────────────────────────────────────────────────────

/** Compatible with the local ProductRoadmapEntry in meeting-prep-routes.ts */
export interface RoadmapEntry {
  product: string
  displayName: string
  nextVersion: string
  expectedDate: string
  highlights: string[]
  source: string
}

interface AlignmentOpts {
  productSummaries: ProductSummary[]
  rssItems: RSSItemLike[]
  customerSlug: string
  /** Injectable for testing — defaults to real getValueMap */
  getValueMapFn?: (slug: string) => string | null
  /** Injectable for testing — defaults to real getCachedCustomerProductIntel */
  getIntelFn?: (productSlug: string, customerSlug: string) => CustomerProductIntel | null
  /** Injectable for testing — defaults to real readSheetCache */
  getSheetCacheFn?: (customerName: string) => { rows: ProductSubscription[]; cachedAt: string } | null
}

interface LifecycleOpts {
  getSheetCacheFn?: (customerName: string) => { rows: ProductSubscription[]; cachedAt: string } | null
}

// ── Constants ────────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000
const THIRTY_DAYS_MS = 30 * MS_PER_DAY
const SEVEN_DAYS_MS = 7 * MS_PER_DAY
const MAX_TABLE_ROWS = 8
const MAX_PROOF_POINTS = 4
const MAX_KEY_CHANGES = 3

// ── Proof Point Extractor ────────────────────────────────────────────────────

/**
 * Parse value map text for quantified metrics: percentages, dollar amounts,
 * and analyst citations (Forrester, IDC, Gartner, ESG).
 */
export function extractProofPoints(valueMapText: string): string[] {
  const metrics: string[] = []
  const patterns: RegExp[] = [
    /\d+%\s+\w[\w\s]{2,30}?(?=\s+\d|\s*$|\s*[,;.|])/gm,  // percentage metrics: "58% Unplanned Downtime"
    /\$[\d,.]+[BMK]?\s+\w+/g,                // dollar metrics: "$2B ARR"
    /(?:Forrester|IDC|Gartner|ESG)\s*[-–—]?\s*[\w\s,]+/g,  // analyst citations: "IDC - The Business Value of..."
  ]
  for (const p of patterns) {
    const matches = valueMapText.match(p) ?? []
    metrics.push(...matches.map(m => m.trim().slice(0, 60)).slice(0, 4))
  }
  return [...new Set(metrics)].slice(0, MAX_PROOF_POINTS)
}

const VALUE_MAP_PATH_ENV = process.env.CACHE_DIR
  ? `${process.env.CACHE_DIR}/value-maps/business-value-maps.txt`
  : null

/**
 * Extract proof points for a specific product by scanning the FULL value map
 * file for all sections mentioning the product (not just the header section).
 * Falls back to extractProofPoints(sectionText) if full file unavailable.
 */
export function extractProductProofPoints(slug: string, sectionText: string | null): string[] {
  if (sectionText) {
    const fromSection = extractProofPoints(sectionText)
    if (fromSection.length >= 2) return fromSection
  }

  if (!VALUE_MAP_PATH_ENV) return sectionText ? extractProofPoints(sectionText) : []

  try {
    if (!existsSync(VALUE_MAP_PATH_ENV)) return []
    const fullText = readFileSync(VALUE_MAP_PATH_ENV, 'utf-8')

    const productNames: Record<string, string[]> = {
      'aap': ['ansible', 'ansible automation platform'],
      'rhel': ['rhel', 'enterprise linux'],
      'ocp': ['openshift', 'openshift container platform'],
      'rhoai': ['openshift ai', 'red hat ai'],
      'acs': ['advanced cluster security'],
      'acm': ['advanced cluster management'],
    }
    const names = productNames[slug] ?? [slug]

    const lines = fullText.split('\n')
    const relevantLines: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase()
      if (names.some(n => lower.includes(n)) || /\d+%/.test(lines[i])) {
        const context = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join('\n')
        if (names.some(n => context.toLowerCase().includes(n))) {
          relevantLines.push(lines[i])
        }
      }
    }

    if (relevantLines.length > 0) {
      const combined = relevantLines.join('\n')
      const metrics = extractProofPoints(combined)
      if (metrics.length >= 2) return metrics
    }
  } catch {}

  return sectionText ? extractProofPoints(sectionText) : []
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function daysBetween(dateStr: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(dateStr).getTime()) / MS_PER_DAY)
}

function isWithinDays(dateStr: string, days: number, now: Date): boolean {
  const diff = now.getTime() - new Date(dateStr).getTime()
  return diff >= 0 && diff <= days * MS_PER_DAY
}

/** Slug → subscription name fragments for matching */
const SLUG_TO_SUB_NAMES: Record<string, string[]> = {
  'aap': ['ansible', 'automation platform'],
  'rhel': ['enterprise linux', 'rhel'],
  'ocp': ['openshift', 'container platform'],
  'rhoai': ['openshift ai', 'red hat ai'],
  'acs': ['advanced cluster security'],
  'acm': ['advanced cluster management'],
  'satellite': ['satellite'],
  'quay': ['quay'],
}

/** Check if subscription rows contain a product matching the slug */
function findSubscription(rows: ProductSubscription[], slug: string): ProductSubscription | undefined {
  const names = SLUG_TO_SUB_NAMES[slug] ?? [slug]
  return rows.find(r =>
    r.status === 'Active' && (
      names.some(n => r.productDescription?.toLowerCase().includes(n)) ||
      names.some(n => r.sku?.toLowerCase().includes(n))
    )
  )
}

/** Escape pipe characters in table cell content */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

// ── Builder 1: Product Alignment Table (Section 4) ──────────────────────────

export function buildProductAlignmentTable(
  customer: Customer,
  productSlugs: string[],
  opts: AlignmentOpts = { productSummaries: [], rssItems: [], customerSlug: '' },
): string {
  if (productSlugs.length === 0) return ''

  const {
    productSummaries,
    rssItems: _rssItems,
    customerSlug,
    getValueMapFn,
    getIntelFn,
    getSheetCacheFn,
  } = opts

  const now = new Date()
  const sheetCache = getSheetCacheFn ? getSheetCacheFn(customer.name) : null
  const rows: string[] = []

  for (const slug of productSlugs) {
    // --- Data lookups (injectable for testing) ---
    const valueMapText = getValueMapFn ? getValueMapFn(slug) : null
    const intel = getIntelFn ? getIntelFn(slug, customerSlug) : null
    const hasSubscription = sheetCache ? !!findSubscription(sheetCache.rows, slug) : false

    // --- Confidence scoring (deterministic per ADR-025) ---
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW'
    const relevanceHigh = intel && intel.relevanceScore === 'HIGH'
    const relevanceMedium = intel && intel.relevanceScore === 'MEDIUM'

    if (hasSubscription && relevanceHigh && valueMapText) {
      confidence = 'HIGH'
    } else if (hasSubscription || relevanceMedium) {
      confidence = 'MEDIUM'
    } else {
      confidence = 'LOW'
    }

    // --- Proof points (scan full file for IDC/Forrester metrics) ---
    const proofPoints = extractProductProofPoints(slug, valueMapText)
    const proofCell = proofPoints.length >= 2
      ? proofPoints.join(', ')
      : 'See value map documentation'

    // --- Use case (from intelligence or subscription) ---
    const sub = sheetCache ? findSubscription(sheetCache.rows, slug) : undefined
    const intelAction = intel?.priorityAction && intel.priorityAction !== 'Analysis unavailable' ? intel.priorityAction : ''
    const subQty = sub?.quantity ? `${sub.quantity} units` : ''
    const useCase = intelAction
      ? escapeCell(intelAction.slice(0, 80))
      : sub?.productDescription
        ? escapeCell(`${sub.productDescription}${subQty ? ` (${subQty})` : ''}`)
        : `${slug.toUpperCase()} deployment`

    // --- Summit/recent news ---
    const recentSummary = productSummaries.find(
      p => p.slug === slug && p.gaDate && isWithinDays(p.gaDate, 30, now)
    )
    let newsCell = '—'
    if (recentSummary) {
      const bullet = recentSummary.summaryBullets?.[0] ?? recentSummary.summaryText?.slice(0, 60)
      newsCell = `**${recentSummary.shortName ?? recentSummary.displayName} ${recentSummary.currentVersion} GA** — ${escapeCell(bullet)}`
    }

    rows.push(`| ${escapeCell(slug.toUpperCase())} | ${useCase} | ${confidence} | ${escapeCell(proofCell)} | ${newsCell} |`)
  }

  if (rows.length === 0) return ''

  return [
    '',
    '**Product Alignment — Confidence & Proof Points**',
    '| Red Hat Product | Customer Use Case | Confidence | Key Proof Points | Summit/Recent News |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}

// ── Builder 2: Summit Announcements Table (Section 5) ───────────────────────

export function buildSummitAnnouncementsTable(
  productSlugs: string[],
  rssItems: RSSItemLike[],
  productSummaries: ProductSummary[],
  roadmapData: RoadmapEntry[],
): string {
  const now = new Date()
  const items: Array<{ announcement: string; whatsNew: string; released: string; whyMatters: string; sortDate: number }> = []

  // Product summaries within 30 days
  for (const ps of productSummaries) {
    if (!productSlugs.includes(ps.slug)) continue
    if (!ps.gaDate || !isWithinDays(ps.gaDate, 30, now)) continue

    const age = daysBetween(ps.gaDate, now)
    const recency = age <= 7 ? ` (${age} days old)` : ''
    const bullets = (ps.summaryBullets ?? []).slice(0, 2).join(', ')
    items.push({
      announcement: `${ps.displayName} ${ps.currentVersion} GA`,
      whatsNew: bullets || ps.summaryText?.slice(0, 80) || '—',
      released: `${new Date(ps.gaDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}${recency}`,
      whyMatters: ps.summaryBullets?.[0] ?? '—',
      sortDate: new Date(ps.gaDate).getTime(),
    })
  }

  // RSS items within 30 days, filtered to product slugs
  for (const item of rssItems) {
    const tags = (item.productTags ?? []).map(t => t.toLowerCase())
    if (!tags.some(t => productSlugs.includes(t))) continue
    if (!item.pubDate || !isWithinDays(item.pubDate, 30, now)) continue

    const age = daysBetween(item.pubDate, now)
    const recency = age <= 7 ? ` (${age} days old)` : ''
    items.push({
      announcement: item.title,
      whatsNew: item.description?.slice(0, 80) || '—',
      released: `${new Date(item.pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}${recency}`,
      whyMatters: `Source: ${item.source}`,
      sortDate: new Date(item.pubDate).getTime(),
    })
  }

  // Roadmap items (upcoming releases) — filter to relevant products
  for (const rd of roadmapData) {
    if (!productSlugs.includes(rd.product)) continue
    const highlights = (rd.highlights ?? []).slice(0, 2).join(', ')
    items.push({
      announcement: `${rd.displayName} ${rd.nextVersion}`,
      whatsNew: highlights || '—',
      released: `Coming ${rd.expectedDate}`,
      whyMatters: 'Upcoming release',
      sortDate: Date.now() + 1, // sort after current items
    })
  }

  if (items.length === 0) return ''

  // Sort by date descending, cap at 8
  items.sort((a, b) => b.sortDate - a.sortDate)
  const capped = items.slice(0, MAX_TABLE_ROWS)

  return [
    '',
    '**Recent Announcements (last 30 days)**',
    '| Announcement | What\'s New | Released | Why It Matters |',
    '|---|---|---|---|',
    ...capped.map(i =>
      `| ${escapeCell(i.announcement)} | ${escapeCell(i.whatsNew)} | ${escapeCell(i.released)} | ${escapeCell(i.whyMatters)} |`
    ),
    '',
  ].join('\n')
}

// ── Builder 3: Enhanced Lifecycle Table (Section 6) ─────────────────────────

export function buildEnhancedLifecycleTable(
  customer: Customer,
  productSlugs: string[],
  lifecycleCache: ProductLifecycleCache | null,
  roadmapData: RoadmapEntry[],
  productSummaries: ProductSummary[],
  opts?: LifecycleOpts,
): string {
  if (!lifecycleCache?.products?.length) return ''

  const filtered = lifecycleCache.products.filter(p => productSlugs.includes(p.slug))
  if (filtered.length === 0) return ''

  const sheetCache = opts?.getSheetCacheFn ? opts.getSheetCacheFn(customer.name) : null
  const rows: string[] = []

  for (const lc of filtered) {
    const roadmap = roadmapData.find(r => r.product === lc.slug)
    const summary = productSummaries.find(p => p.slug === lc.slug)

    // Key Changes: roadmap highlights + summary bullets, capped at 3
    const keyChanges: string[] = []
    if (roadmap?.highlights) keyChanges.push(...roadmap.highlights)
    if (summary?.summaryBullets) {
      for (const b of summary.summaryBullets) {
        if (!keyChanges.includes(b)) keyChanges.push(b)
      }
    }
    const keyChangesStr = keyChanges.slice(0, MAX_KEY_CHANGES).join(', ') || '—'

    // Customer Angle: template from subscription data
    let customerAngle = `Benefits from ${keyChanges[0] ?? 'latest updates'}`
    if (sheetCache) {
      const sub = findSubscription(sheetCache.rows, lc.slug)
      if (sub && sub.quantity > 0) {
        const unit = sub.productDescription?.toLowerCase().includes('node')
          ? 'nodes'
          : sub.productDescription?.toLowerCase().includes('host')
          ? 'hosts'
          : sub.productDescription?.toLowerCase().includes('core')
          ? 'cores'
          : 'units'
        customerAngle = `Your ${sub.quantity} ${unit} benefits from ${keyChanges[0] ?? 'latest updates'}`
      }
    }

    const nextVer = roadmap?.nextVersion ?? lc.nextVersion ?? '—'
    const nextDate = roadmap?.expectedDate ?? (lc.nextExpected ? new Date(lc.nextExpected).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—')

    rows.push(
      `| ${escapeCell(lc.displayName)} | ${lc.currentVersion} | ${nextVer} | ${nextDate} | ${escapeCell(keyChangesStr)} | ${escapeCell(customerAngle)} |`
    )
  }

  if (rows.length === 0) return ''

  return [
    '',
    '**Enhanced Lifecycle — Key Changes & Customer Angle**',
    '| Product | Current | Next Release | Expected | Key Changes | Customer Angle |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}

// ── Builder 4: RSS Intelligence Table (Section 7) ───────────────────────────

export function buildRSSIntelligenceTable(
  productSlugs: string[],
  rssItems: RSSItemLike[],
  customerName: string,
): string {
  const now = new Date()

  // Filter: last 30 days, product-filtered
  const filtered = rssItems
    .filter(item => {
      if (!item.pubDate || !isWithinDays(item.pubDate, 30, now)) return false
      const tags = (item.productTags ?? []).map(t => t.toLowerCase())
      return tags.some(t => productSlugs.includes(t))
    })
    .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
    .slice(0, MAX_TABLE_ROWS)

  if (filtered.length === 0) return ''

  const rows: string[] = []
  for (const item of filtered) {
    const date = new Date(item.pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    const titleLink = `[${escapeCell(item.title)}](${item.link})`
    const relevance = getCustomerRelevance(item, productSlugs)

    rows.push(`| ${date} | ${escapeCell(item.source)} | ${titleLink} | ${escapeCell(relevance)} |`)
  }

  return [
    '',
    '**Latest Red Hat Blog & News Intelligence**',
    '| Date | Source | Title | Customer Relevance |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}

// ── Customer Relevance (rule-based per ADR-025) ─────────────────────────────

function getCustomerRelevance(item: RSSItemLike, productSlugs: string[]): string {
  const titleLower = item.title.toLowerCase()
  const descLower = (item.description ?? '').toLowerCase()

  // Summit/keynote items
  if (titleLower.includes('summit') || titleLower.includes('keynote')) {
    return 'Share with attendees as context for this meeting'
  }

  // Migration/upgrade items
  if (titleLower.includes('migration') || titleLower.includes('upgrade') || descLower.includes('migration')) {
    return 'Relevant if discussing upgrade path'
  }

  // Product match — find the matching product slug
  const matchedTags = (item.productTags ?? [])
    .map(t => t.toLowerCase())
    .filter(t => productSlugs.includes(t))

  if (matchedTags.length > 0) {
    return `Reference in ${matchedTags[0].toUpperCase()} discussion`
  }

  return 'General Red Hat news — share if relevant'
}
