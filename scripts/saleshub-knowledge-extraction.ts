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

  // Find TDP area in text — the TDP header appears twice: once in sidebar nav (short),
  // once in expanded content area (followed by actual descriptions). Find ALL matches
  // and use the one with the longest content before the next boundary.
  const tdpHeaderPattern = /\d{4}\s+\w+\s+TDP\s*&\s*Sales\s+tactics/gi
  let bestArea = ''
  let match: RegExpExecArray | null
  while ((match = tdpHeaderPattern.exec(text)) !== null) {
    const afterMatch = text.slice(match.index)
    const endMatch = afterMatch.match(/\n(?:Product Features|Deployment options|Content Details|Content Properties)\n/i)
    const candidate = endMatch ? afterMatch.slice(0, endMatch.index) : afterMatch.slice(0, 5000)
    if (candidate.length > bestArea.length) bestArea = candidate
  }

  // Fallback: search for individual TDP/tactic descriptions anywhere in the text
  if (bestArea.length < 100) {
    const fallbackMatch = text.match(/(?:Automation TDP|Virtualization TDP|App Platform TDP|AI TDP|Server.*TDP)[\s\S]{0,5000}/i)
    if (fallbackMatch) bestArea = fallbackMatch[0].slice(0, 5000)
  }

  if (!bestArea) return results
  const tdpArea = bestArea
  const lines = tdpArea.split('\n').filter(l => l.trim().length > 0)

  let currentName = ''
  for (const line of lines) {
    const trimmed = line.trim()

    // Skip very short lines
    if (trimmed.length < 5) continue

    // Boundary markers — stop extraction
    if (trimmed.toLowerCase().startsWith('product features')) break
    if (trimmed.toLowerCase().startsWith('deployment options')) break

    // Description detection: longer text that reads like a positioning statement
    const isDescription =
      trimmed.length > 40 &&
      /^(This|The|A |An |It |In |By |For |With |Enables|Positions|Helps|Provides|Supports|Delivers|Combines|Offers|Discover)/i.test(trimmed)

    // Title detection: shorter text that isn't a description
    const isTitle =
      !isDescription &&
      trimmed.length < 120 &&
      trimmed.length >= 5 &&
      !trimmed.includes('item(s)') &&
      !trimmed.startsWith('How to') &&
      !trimmed.startsWith('arrow') &&
      !trimmed.toLowerCase().includes('product features') &&
      !trimmed.toLowerCase().includes('content details') &&
      !trimmed.toLowerCase().includes('content properties')

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
// Garbage filter: entries that aren't real TDP/tactic content
function isGarbageEntry(name: string, description: string): boolean {
  const lower = name.toLowerCase()
  if (lower.startsWith('visit') || lower.startsWith('arrow') || lower.includes('item(s)')) return true
  if (lower.startsWith('content detail') || lower.startsWith('content propert')) return true
  if (lower.startsWith('rating') || lower.startsWith('review')) return true
  if (description.includes('redhat.com/') && description.length < 100 && !isTdpEntry(name)) return true
  return false
}

// Classify: entries with "TDP" in name are actual TDPs, others are tactics
function isTdpEntry(name: string): boolean {
  return /\bTDP\b/i.test(name)
}

export function buildSalesHubKnowledge(
  products: ScrapedProduct[],
  salesPlays: ScrapedSalesPlay[],
  tactics: ScrapedSalesTactic[],
): SalesHubKnowledge {
  const tdpMap = new Map<string, TdpNode>()
  const tacticNodes: TacticNode[] = []

  for (const product of products) {
    // Find the parent TDP name for this product's sections
    let currentTdpName = ''

    for (const section of product.tdpSections) {
      if (isGarbageEntry(section.name, section.description)) continue

      if (isTdpEntry(section.name)) {
        // This is an actual TDP
        currentTdpName = section.name
        const existing = tdpMap.get(section.name)
        if (existing) {
          if (!existing.products.includes(product.name)) existing.products.push(product.name)
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
      } else {
        // This is a tactic under the current TDP
        const parentTdp = currentTdpName || 'Unknown'
        tacticNodes.push({
          name: section.name,
          talkTrack: section.description,
          customerWins: [],
          whatToSay: [],
          whatToShare: [],
          parentTdp,
        })
        // Link tactic to its parent TDP
        const tdp = tdpMap.get(parentTdp)
        if (tdp && !tdp.tactics.includes(section.name)) {
          tdp.tactics.push(section.name)
        }
      }
    }
  }

  // Add standalone scraped tactics
  for (const tactic of tactics) {
    const existing = tacticNodes.find(t => t.name === tactic.name)
    if (existing) {
      if (tactic.talkTrack && tactic.talkTrack.length > existing.talkTrack.length) {
        existing.talkTrack = tactic.talkTrack
      }
      if (tactic.customerWins.length > 0) existing.customerWins = tactic.customerWins
      if (tactic.whatToSay.length > 0) existing.whatToSay = tactic.whatToSay
      if (tactic.whatToShare.length > 0) existing.whatToShare = tactic.whatToShare
    } else {
      tacticNodes.push({
        name: tactic.name,
        talkTrack: tactic.talkTrack,
        customerWins: tactic.customerWins,
        whatToSay: tactic.whatToSay,
        whatToShare: tactic.whatToShare,
        parentTdp: tactic.parentTdp,
      })
    }
    // Link to TDP
    if (tactic.parentTdp) {
      for (const [, tdp] of tdpMap) {
        if (tdp.name.toLowerCase().includes(tactic.parentTdp.toLowerCase())) {
          if (!tdp.tactics.includes(tactic.name)) tdp.tactics.push(tactic.name)
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

  return {
    version: 1,
    scrapedAt: new Date().toISOString(),
    salesPlays: salesPlayNodes,
    tdps: Array.from(tdpMap.values()),
    tactics: tacticNodes,
    products: productNodes,
  }
}
