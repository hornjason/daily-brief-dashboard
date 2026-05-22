/**
 * scripts/saleshub-knowledge-extraction.ts — Pure extraction logic for SalesHub knowledge
 *
 * Contains parsing and assembly functions that transform raw scraped page text
 * into structured SalesHub knowledge objects. No browser/Playwright dependency.
 *
 * Used by scrape-saleshub.ts for extraction and by unit tests for validation.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface SalesHubKnowledge {
  version: number
  scrapedAt: string
  salesPlays: SalesPlayNode[]
  tdps: TdpNode[]
  tactics: TacticNode[]
  products: ProductNode[]
}

export interface SalesPlayNode {
  name: string
  description: string
  linkedTdps: string[]
}

export interface TdpNode {
  name: string
  description: string
  tactics: string[]
  products: string[]
}

export interface TacticNode {
  name: string
  talkTrack: string
  customerWins: string[]
  whatToSay: string[]
  whatToShare: Array<{ name: string; url: string; type: string }>
  parentTdp: string
}

export interface ProductNode {
  name: string
  slug: string
  description: string
  tdpContent: Array<{ type: 'tdp' | 'tactic'; name: string; description: string }>
  decks: Array<{ name: string; url: string; type: string }>
  resources: Array<{ name: string; url: string; type: string }>
  googleDocsUrls: string[]
}

// ── Input types from scraper ─────────────────────────────────────────────────

export interface ScrapedProduct {
  slug: string
  name: string
  description: string
  url: string
  tdpSections: Array<{ name: string; description: string }>
  salesTactics: Array<{ name: string; description: string }>
  googleDocsUrls: string[]
  keyResources: Array<{ text: string; url: string; type: string }>
  decks: Array<{ text: string; url: string; type: string }>
  scrapedAt: string
}

export interface ScrapedSalesPlay {
  name: string
  description: string
  linkedTdps: string[]
  url: string
}

export interface ScrapedSalesTactic {
  name: string
  talkTrack: string
  customerWins: string[]
  whatToSay: string[]
  whatToShare: Array<{ name: string; url: string; type: string }>
  parentTdp: string
  url: string
}

// ── Extraction Functions ─────────────────────────────────────────────────────

/**
 * Parse TDP sections from raw page text (accordion-expanded content).
 * Pattern: lines that are short titles followed by lines starting with "This" or "The"
 * that contain descriptive content. Stops at "Product Features" or "Deployment options" boundary.
 */
export function parseTdpSectionsFromText(
  text: string,
): Array<{ name: string; description: string }> {
  const results: Array<{ name: string; description: string }> = []
  const seen = new Set<string>()

  // Find TDP area in text — match from any TDP/tactics header to a boundary marker
  const tdpAreaMatch = text.match(
    /(?:TDP|Technology Decision Point|Sales tactics)[\s\S]*?(?=Product Features|Deployment options|$)/i,
  )
  if (!tdpAreaMatch) return results

  const tdpArea = tdpAreaMatch[0]
  const lines = tdpArea.split('\n').filter(l => l.trim().length > 0)

  let currentName = ''
  for (const line of lines) {
    const trimmed = line.trim()

    // Skip very short lines
    if (trimmed.length < 5) continue

    // Boundary markers — stop extraction
    if (trimmed.toLowerCase().startsWith('product features')) break
    if (trimmed.toLowerCase().startsWith('deployment options')) break

    // Description detection: longer text starting with descriptive words
    const isDescription =
      trimmed.length > 40 &&
      (trimmed.startsWith('This') || trimmed.startsWith('The'))

    // Title detection: shorter text that isn't a description
    const isTitle =
      !isDescription &&
      trimmed.length < 120 &&
      trimmed.length >= 5 &&
      !trimmed.includes('item(s)') &&
      !trimmed.startsWith('How to') &&
      !trimmed.toLowerCase().includes('product features')

    if (isTitle) {
      currentName = trimmed
    } else if (currentName && isDescription) {
      if (!seen.has(currentName)) {
        results.push({ name: currentName, description: trimmed })
        seen.add(currentName)
      }
      currentName = ''
    }
  }

  return results
}

/**
 * Parse Sales Tactic structured sections from page text.
 * Extracts: talk track, customer wins, what to say, what to share.
 */
export function parseSalesTacticSections(text: string): {
  talkTrack: string
  customerWins: string[]
  whatToSay: string[]
  whatToShare: Array<{ name: string; url: string; type: string }>
} {
  const result = {
    talkTrack: '',
    customerWins: [] as string[],
    whatToSay: [] as string[],
    whatToShare: [] as Array<{ name: string; url: string; type: string }>,
  }

  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)

  type Section = 'none' | 'intro' | 'how-to-use' | 'customer-wins' | 'what-to-say' | 'what-to-share' | 'services' | 'tdps'
  let currentSection: Section = 'none'
  const talkTrackParts: string[] = []

  for (const line of lines) {
    const lower = line.toLowerCase()

    // Section detection — order matters (most specific first)
    if (lower === 'customer wins' || lower.startsWith('customer wins')) {
      currentSection = 'customer-wins'
      continue
    }
    if (lower === 'what to say' || lower.startsWith('what to say')) {
      currentSection = 'what-to-say'
      continue
    }
    if (lower === 'what to share' || lower.startsWith('what to share')) {
      currentSection = 'what-to-share'
      continue
    }
    if (lower.startsWith('services and partner') || lower.startsWith('supporting tdps')) {
      currentSection = 'services'
      continue
    }
    if (lower.startsWith('how to use')) {
      currentSection = 'how-to-use'
      continue
    }
    if (lower === 'sales tactic') {
      // The intro text before "How to use" is the talk track
      currentSection = 'intro'
      continue
    }

    // Content accumulation
    switch (currentSection) {
      case 'none':
        // Before "Sales Tactic" header — skip the tactic name itself
        break
      case 'intro':
        // Text between "Sales Tactic" and "How to use" — this is the talk track
        if (line.length > 15) talkTrackParts.push(line)
        break
      case 'how-to-use':
        // "How to use this page" intro — also part of talk track
        if (line.length > 20) talkTrackParts.push(line)
        break
      case 'customer-wins':
        if (line.length > 15) result.customerWins.push(line)
        break
      case 'what-to-say':
        if (line.length > 15) result.whatToSay.push(line)
        break
      case 'what-to-share':
        if (line.length > 5) {
          result.whatToShare.push({ name: line, url: '', type: 'seismic' })
        }
        break
    }
  }

  result.talkTrack = talkTrackParts.join(' ').slice(0, 2000)

  return result
}

// ── Assembly Function ────────────────────────────────────────────────────────

/**
 * Build the complete SalesHubKnowledge structure from scraped data.
 * Aggregates TDPs across products, deduplicates, and cross-references.
 */
export function buildSalesHubKnowledge(
  products: ScrapedProduct[],
  salesPlays: ScrapedSalesPlay[],
  tactics: ScrapedSalesTactic[],
): SalesHubKnowledge {
  // Build TDP index from all product pages (deduplicate by name)
  const tdpMap = new Map<string, TdpNode>()

  for (const product of products) {
    for (const section of product.tdpSections) {
      const existing = tdpMap.get(section.name)
      if (existing) {
        // Add this product to the existing TDP
        if (!existing.products.includes(product.name)) {
          existing.products.push(product.name)
        }
        // Keep the longer description
        if (section.description.length > existing.description.length) {
          existing.description = section.description
        }
      } else {
        tdpMap.set(section.name, {
          name: section.name,
          description: section.description,
          tactics: [],
          products: [product.name],
        })
      }
    }

    // Also add tactic names to TDP records
    for (const tactic of product.salesTactics) {
      // Try to find a parent TDP for this tactic based on position
      for (const [, tdp] of tdpMap) {
        if (!tdp.tactics.includes(tactic.name)) {
          tdp.tactics.push(tactic.name)
        }
        break // Associate with first TDP as default
      }
    }
  }

  // Cross-reference standalone tactics with TDPs
  for (const tactic of tactics) {
    if (tactic.parentTdp) {
      for (const [, tdp] of tdpMap) {
        if (tdp.name.toLowerCase().includes(tactic.parentTdp.toLowerCase())) {
          if (!tdp.tactics.includes(tactic.name)) {
            tdp.tactics.push(tactic.name)
          }
        }
      }
    }
  }

  // Build product nodes
  const productNodes: ProductNode[] = products.map(p => ({
    name: p.name,
    slug: p.slug,
    description: p.description,
    tdpContent: [
      ...p.tdpSections.map(s => ({ type: 'tdp' as const, name: s.name, description: s.description })),
      ...p.salesTactics.map(s => ({ type: 'tactic' as const, name: s.name, description: s.description })),
    ],
    decks: p.decks.map(d => ({ name: d.text, url: d.url, type: d.type })),
    resources: p.keyResources.map(r => ({ name: r.text, url: r.url, type: r.type })),
    googleDocsUrls: p.googleDocsUrls,
  }))

  // Build sales play nodes
  const salesPlayNodes: SalesPlayNode[] = salesPlays.map(sp => ({
    name: sp.name,
    description: sp.description,
    linkedTdps: sp.linkedTdps,
  }))

  // Build tactic nodes
  const tacticNodes: TacticNode[] = tactics.map(t => ({
    name: t.name,
    talkTrack: t.talkTrack,
    customerWins: t.customerWins,
    whatToSay: t.whatToSay,
    whatToShare: t.whatToShare,
    parentTdp: t.parentTdp,
  }))

  return {
    version: 1,
    scrapedAt: new Date().toISOString(),
    salesPlays: salesPlayNodes,
    tdps: Array.from(tdpMap.values()),
    tactics: tacticNodes,
    products: productNodes,
  }
}
