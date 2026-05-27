/**
 * Meeting Prep Enrichment — ADR-025
 *
 * Pure sync builder functions that produce deterministic data from product
 * alignment, lifecycle, RSS, and proof point sources.
 *
 * #426 update: Table builders are preserved for backward compat (enrichment
 * tests, other consumers). New entry point: `buildEnrichmentPromptContext()`
 * produces structured text for injection INTO the Gemini prompt (not post-hoc
 * table injection).
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
function humanizeProofPoint(pct: string, rawLabel: string, source: string): string {
  const label = rawLabel.toLowerCase()
  if (label.includes('downtime')) return `${pct} reduction in unplanned downtime${source}`
  if (label.includes('meantime') || label.includes('mttr') || label.includes('resolution')) return `${pct} faster mean time to resolution${source}`
  if (label.includes('productivity') || label.includes('fte')) return `${pct} improvement in ${label.replace(/fte/i, 'staff').trim()}${source}`
  if (label.includes('provisioning') || label.includes('deploy')) return `${pct} faster ${label.trim()}${source}`
  if (label.includes('security') || label.includes('compliance')) return `${pct} improvement in ${label.trim()}${source}`
  if (label.includes('saving') || label.includes('cost') || label.includes('reduction')) return `${pct} ${label.trim()}${source}`
  if (label.includes('faster') || label.includes('new')) return `${pct} ${label.trim()}${source}`
  return `${pct} improvement in ${label.trim()}${source}`
}

export function extractProofPoints(valueMapText: string): string[] {
  const metrics: string[] = []
  const lines = valueMapText.split('\n')

  // Find nearby source citation for context
  const findNearbySource = (lineIdx: number): string => {
    for (let j = lineIdx + 1; j < Math.min(lineIdx + 8, lines.length); j++) {
      const sourceLine = lines[j].trim()
      if (/^Source:\s*(IDC|Forrester|Gartner|ESG)/i.test(sourceLine)) {
        const match = sourceLine.match(/Source:\s*(.{10,60}?)(?:\s*\(|$)/i)
        return match ? ` (${match[1].trim()})` : ''
      }
    }
    return ''
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // Match percentage metrics: "58% Unplanned Downtime" → human-readable sentence
    const pctMatch = line.match(/^(\d+%)\s+([\w\s]{3,40}?)$/m)
    if (pctMatch) {
      const source = findNearbySource(i)
      const pct = pctMatch[1]
      const rawLabel = pctMatch[2].trim()
      const metric = humanizeProofPoint(pct, rawLabel, source)
      if (!metrics.includes(metric)) metrics.push(metric)
      if (metrics.length >= MAX_PROOF_POINTS) break
    }

    // Match dollar metrics: "$2B ARR"
    const dollarMatch = line.match(/(\$[\d,.]+[BMK]?\s+\w[\w\s]{2,20})/g)
    if (dollarMatch) {
      for (const m of dollarMatch) {
        const source = findNearbySource(i)
        const metric = `${m.trim()}${source}`
        if (!metrics.includes(metric)) metrics.push(metric)
        if (metrics.length >= MAX_PROOF_POINTS) break
      }
    }
  }

  return metrics.slice(0, MAX_PROOF_POINTS)
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
      'aap': ['ansible', 'ansible automation platform', 'automate the enterprise'],
      'rhel': ['rhel', 'enterprise linux', 'rhel in the cloud', 'aap for rhel', 'standardization and automation', 'downtime', 'infrastructure', 'security fte', 'compliance fte'],
      'ocp': ['openshift', 'openshift container platform', 'container platform'],
      'rhoai': ['openshift ai', 'red hat ai', 'enterprise linux ai'],
      'acs': ['advanced cluster security'],
      'acm': ['advanced cluster management'],
    }
    const names = productNames[slug] ?? [slug]

    // Find sections that mention this product and extract metrics from them
    const lines = fullText.split('\n')
    const relevantChunks: string[] = []

    // Strategy: find Value Map headers containing product name, then grab full section
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase()
      const isHeader = lower.includes('value map') || lower.includes('business value') || lower.includes('source: idc') || lower.includes('source: forrester')
      if (isHeader && names.some(n => lower.includes(n))) {
        // Grab a wide window (50 lines) after product-related headers
        relevantChunks.push(lines.slice(i, Math.min(lines.length, i + 50)).join('\n'))
      }
    }

    // Also scan for percentage lines near product mentions (wider window: 15 lines)
    for (let i = 0; i < lines.length; i++) {
      if (/\d+%/.test(lines[i])) {
        const context = lines.slice(Math.max(0, i - 15), Math.min(lines.length, i + 5)).join('\n')
        if (names.some(n => context.toLowerCase().includes(n))) {
          relevantChunks.push(lines[i])
        }
      }
    }

    if (relevantChunks.length > 0) {
      const combined = relevantChunks.join('\n')
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

/** Truncate at sentence boundary, fallback to word boundary */
function truncateAtSentence(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text || '—'
  const truncated = text.slice(0, maxLen)
  const lastPeriod = truncated.lastIndexOf('.')
  if (lastPeriod > maxLen * 0.5) return truncated.slice(0, lastPeriod + 1)
  const lastSpace = truncated.lastIndexOf(' ')
  return lastSpace > 0 ? truncated.slice(0, lastSpace) + '...' : truncated + '...'
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

    // --- Proof points (scan full file for IDC/Forrester metrics) ---
    const proofPoints = extractProductProofPoints(slug, valueMapText)
    const hasRealMetrics = proofPoints.length >= 2

    // --- Confidence scoring (deterministic per ADR-025) ---
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW'
    const relevanceHigh = intel && intel.relevanceScore === 'HIGH'
    const relevanceMedium = intel && intel.relevanceScore === 'MEDIUM'

    if (hasSubscription && (relevanceHigh || hasRealMetrics)) {
      confidence = 'HIGH'
    } else if (hasSubscription || relevanceMedium) {
      confidence = 'MEDIUM'
    } else {
      confidence = 'LOW'
    }

    const proofCell = proofPoints.length >= 2
      ? proofPoints.join(', ')
      : 'See value map documentation'

    // --- Use case (from intelligence or subscription) ---
    const sub = sheetCache ? findSubscription(sheetCache.rows, slug) : undefined
    const intelAction = intel?.priorityAction && intel.priorityAction !== 'Analysis unavailable' ? intel.priorityAction : ''
    const subQty = sub?.quantity ? `${sub.quantity} ${sub.quantity === 1 ? 'unit' : 'units'}` : ''
    const useCase = intelAction
      ? escapeCell(intelAction.slice(0, 80))
      : sub?.productDescription
        ? escapeCell(`${sub.productDescription}${subQty ? ` (${subQty})` : ''}`)
        : `${slug.toUpperCase()} deployment`

    // --- Summit/recent news ---
    const summary = productSummaries.find(p => p.slug === slug)
    const recentDate = summary?.gaDate ?? summary?.refreshedAt ?? summary?.synthesizedAt
    let newsCell = '—'
    if (summary && summary.summaryBullets?.length) {
      const bullet = summary.summaryBullets[0].slice(0, 80)
      const version = summary.currentVersion ?? ''
      const name = summary.shortName ?? summary.displayName
      const isRecent = recentDate && isWithinDays(recentDate, 30, now)
      if (isRecent) {
        newsCell = `**${name} ${version}** — ${escapeCell(bullet)}`
      } else {
        newsCell = `${name} ${version} — ${escapeCell(bullet)}`
      }
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
    const dateStr = ps.gaDate ?? ps.refreshedAt ?? ps.synthesizedAt
    if (!dateStr || !isWithinDays(dateStr, 30, now)) continue

    const age = daysBetween(dateStr, now)
    const recency = age <= 7 ? ` (${age} days old)` : ''
    const bullets = (ps.summaryBullets ?? []).slice(0, 2).map(b => b.slice(0, 60)).join('; ')
    const label = ps.gaDate ? 'GA' : 'Latest'
    items.push({
      announcement: `${ps.displayName} ${ps.currentVersion} ${label}`,
      whatsNew: bullets || ps.summaryText?.slice(0, 80) || '—',
      released: `${new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}${recency}`,
      whyMatters: ps.summaryBullets?.[0]?.slice(0, 60) ?? '—',
      sortDate: new Date(dateStr).getTime(),
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
      whatsNew: truncateAtSentence(item.description ?? '', 80),
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
    // Truncate each key change to keep table readable
    const keyChangesStr = keyChanges.slice(0, MAX_KEY_CHANGES).map(c => c.slice(0, 60).replace(/,\s*$/, '')).join('; ') || '—'

    // Customer Angle: template from subscription data
    const shortChange = (keyChanges[0] ?? 'latest updates').slice(0, 50).replace(/,\s*$/, '')
    let customerAngle = `Benefits from ${shortChange}`
    if (sheetCache) {
      const sub = findSubscription(sheetCache.rows, lc.slug)
      if (sub && sub.quantity > 0) {
        const unit = sub.productDescription?.toLowerCase().includes('node')
          ? (sub.quantity === 1 ? 'node' : 'nodes')
          : sub.productDescription?.toLowerCase().includes('host')
          ? (sub.quantity === 1 ? 'host' : 'hosts')
          : sub.productDescription?.toLowerCase().includes('core')
          ? (sub.quantity === 1 ? 'core' : 'cores')
          : (sub.quantity === 1 ? 'unit' : 'units')
        customerAngle = `Your ${sub.quantity} ${unit} — ${shortChange}`
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

// ── Enrichment Prompt Context (#426) ───────────────────────────────────────

interface EnrichmentPromptOpts extends AlignmentOpts {
  lifecycleCache?: ProductLifecycleCache | null
  roadmapData?: RoadmapEntry[]
}

/**
 * Build structured text context from enrichment data for injection INTO
 * the Gemini prompt. Replaces the old post-Gemini table injection pattern.
 *
 * Returns a string that Gemini can use to craft Value Play and Discussion
 * Questions with real product data, proof points, and lifecycle info.
 */
export function buildEnrichmentPromptContext(
  customer: Customer,
  productSlugs: string[],
  opts: EnrichmentPromptOpts,
): string {
  if (productSlugs.length === 0) return ''

  const {
    productSummaries,
    rssItems,
    customerSlug,
    getValueMapFn,
    getIntelFn,
    getSheetCacheFn,
    lifecycleCache,
    roadmapData,
  } = opts

  const now = new Date()
  const sheetCache = getSheetCacheFn ? getSheetCacheFn(customer.name) : null
  const parts: string[] = []

  // ── Product alignment context ──────────────────────────────────────
  for (const slug of productSlugs) {
    const valueMapText = getValueMapFn ? getValueMapFn(slug) : null
    const intel = getIntelFn ? getIntelFn(slug, customerSlug) : null
    const sub = sheetCache ? findSubscription(sheetCache.rows, slug) : undefined
    const proofPoints = extractProductProofPoints(slug, valueMapText)

    const lines: string[] = [`**${slug.toUpperCase()}**`]

    if (sub) {
      const qty = sub.quantity ? `${sub.quantity} units` : ''
      const endDate = sub.endDate ? `, expires ${sub.endDate}` : ''
      lines.push(`  Subscription: ${sub.productDescription ?? slug}${qty ? ` (${qty}${endDate})` : ''}`)
    }

    if (intel && intel.relevanceScore !== 'NONE') {
      lines.push(`  Priority action: ${intel.priorityAction}`)
      if (intel.featureTalkingPoints?.length) {
        for (const f of intel.featureTalkingPoints.slice(0, 3)) {
          lines.push(`  - ${f.feature} (${f.status}): ${f.reason}`)
        }
      }
    }

    if (proofPoints.length > 0) {
      lines.push(`  Proof points: ${proofPoints.join('; ')}`)
    }

    // Product summary / recent announcements
    const summary = productSummaries.find(p => p.slug === slug)
    if (summary?.summaryBullets?.length) {
      const recentDate = summary.gaDate ?? summary.refreshedAt
      const isRecent = recentDate && isWithinDays(recentDate, 30, now)
      if (isRecent) {
        lines.push(`  Recent release: ${summary.displayName} ${summary.currentVersion ?? ''} — ${summary.summaryBullets[0]}`)
      }
    }

    // Lifecycle
    if (lifecycleCache?.products?.length) {
      const lc = lifecycleCache.products.find(p => p.slug === slug)
      if (lc) {
        const rd = roadmapData?.find(r => r.product === slug)
        const nextVer = rd?.nextVersion ?? lc.nextVersion ?? ''
        const nextDate = rd?.expectedDate ?? (lc.nextExpected ? new Date(lc.nextExpected).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '')
        const eolDate = lc.eolDate ? new Date(lc.eolDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : ''
        lines.push(`  Lifecycle: current ${lc.currentVersion}${nextVer ? `, next ${nextVer} (${nextDate})` : ''}${eolDate ? `, EOL ${eolDate}` : ''}`)
      }
    }

    parts.push(lines.join('\n'))
  }

  // ── Recent news (last 30 days, product-filtered) ───────────────────
  const recentNews = rssItems
    .filter(item => {
      if (!item.pubDate || !isWithinDays(item.pubDate, 30, now)) return false
      const tags = (item.productTags ?? []).map(t => t.toLowerCase())
      return tags.some(t => productSlugs.includes(t))
    })
    .slice(0, 5)

  if (recentNews.length > 0) {
    const newsLines = recentNews.map(item => {
      const date = new Date(item.pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      return `  - [${date}] [${item.title}](${item.link}) (${item.source})`
    })
    parts.push(`**Recent Red Hat News**\n${newsLines.join('\n')}`)
  }

  return parts.join('\n\n')
}
