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
  customerLens: { pain: string[]; outcomes: string[]; impact: string[] }
  realWorldExamples: Array<{ customer: string; outcome: string }>
  emailTemplateUrl: string
  discoveryQuestionsUrl: string
  introPitchDeckUrl: string
  personaSection: {
    roles: string[]
    painPoints: string[]
    discoveryQuestions: string[]
    valueProps: string[]
    whatWinsThemOver: string[]
  }
  tdpAlignment: string[]
  regionalCampaigns: Array<{ name: string; url: string }>
}

export interface TdpNode {
  name: string
  description: string
  tactics: string[]
  products: string[]
  customerWins: Array<{ name: string; description: string }>
  whatToSay: Array<{ name: string; url: string; type: string }>
  whatToShare: Array<{ name: string; url: string }>
  whatToShow: Array<{ name: string; url: string; type: string }>
  services: Array<{ name: string; description: string }>
  cheatsheetUrl: string
  customerDeckUrl: string
  extractedContent: string
  metrics: Array<{ value: string; context: string; source: string }>
}

export interface TacticNode {
  name: string
  talkTrack: string
  customerWins: string[]
  whatToSay: string[]
  whatToShare: Array<{ name: string; url: string; type: string }>
  parentTdp: string
  extractedContent: string
  metrics: Array<{ value: string; context: string; source: string }>
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
  customerLens?: { pain: string[]; outcomes: string[]; impact: string[] }
  realWorldExamples?: Array<{ customer: string; outcome: string }>
  emailTemplateUrl?: string
  discoveryQuestionsUrl?: string
  introPitchDeckUrl?: string
  personaSection?: {
    roles: string[]
    painPoints: string[]
    discoveryQuestions: string[]
    valueProps: string[]
    whatWinsThemOver: string[]
  }
  tdpAlignment?: string[]
  regionalCampaigns?: Array<{ name: string; url: string }>
}

export interface ScrapedTdpPage {
  name: string
  customerWins: Array<{ name: string; description: string }>
  whatToSay: Array<{ name: string; url: string; type: string }>
  whatToShare: Array<{ name: string; url: string }>
  whatToShow: Array<{ name: string; url: string; type: string }>
  services: Array<{ name: string; description: string }>
  cheatsheetUrl: string
  customerDeckUrl: string
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

// ── TDP Page Section Parsing (#366) ─────────────────────────────────────────

/**
 * Parse structured sections from a TDP page's innerText and links.
 * Extracts: Customer Wins, What to Say, What to Share, What to Show,
 * Services and Partner Solutions, 5-Minute Briefs, Develop Your Skills.
 */
export function parseTdpPageSections(
  text: string,
  links: Array<{ text: string; href: string }>,
): ScrapedTdpPage {
  const result: ScrapedTdpPage = {
    name: '',
    customerWins: [],
    whatToSay: [],
    whatToShare: [],
    whatToShow: [],
    services: [],
    cheatsheetUrl: '',
    customerDeckUrl: '',
  }

  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)

  type Section = 'none' | 'customer-wins' | 'what-to-say' | 'what-to-share' | 'what-to-show' | 'services' | 'briefs' | 'skills'
  let currentSection: Section = 'none'

  for (const line of lines) {
    const lower = line.toLowerCase()

    // Section header detection
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
    if (lower === 'what to show' || lower.startsWith('what to show')) {
      currentSection = 'what-to-show'
      continue
    }
    if (lower.startsWith('services and partner') || lower.startsWith('partner solutions')) {
      currentSection = 'services'
      continue
    }
    if (lower.startsWith('5-minute brief') || lower.startsWith('5 minute brief')) {
      currentSection = 'briefs'
      continue
    }
    if (lower.startsWith('develop your skill') || lower.startsWith('training and certification')) {
      currentSection = 'skills'
      continue
    }

    // Boundary detection — stop accumulating into current section on next major header
    if (lower === 'sales tactic' || lower === 'sales tactics' ||
        lower.startsWith('product features') || lower.startsWith('deployment options') ||
        lower.startsWith('content details') || lower.startsWith('content properties')) {
      currentSection = 'none'
      continue
    }

    // Content accumulation
    if (line.length < 5) continue

    switch (currentSection) {
      case 'customer-wins':
        // Customer wins are named case studies: "Company — outcome" or multi-line
        if (line.length > 10) {
          // Split on dash/em-dash for name/description pattern
          const dashIdx = line.indexOf(' — ')
          const hyphenIdx = dashIdx === -1 ? line.indexOf(' - ') : -1
          const splitIdx = dashIdx !== -1 ? dashIdx : hyphenIdx
          if (splitIdx > 3) {
            result.customerWins.push({
              name: line.slice(0, splitIdx).trim(),
              description: line.slice(splitIdx + 3).trim(),
            })
          } else {
            result.customerWins.push({ name: line, description: '' })
          }
        }
        break
      case 'what-to-say':
        if (line.length > 5) {
          const matchingLink = links.find(l =>
            l.text.toLowerCase().includes(line.toLowerCase().slice(0, 20)) ||
            line.toLowerCase().includes(l.text.toLowerCase().slice(0, 20)),
          )
          result.whatToSay.push({
            name: line,
            url: matchingLink?.href ?? '',
            type: matchingLink?.href ? classifyLinkType(matchingLink.href) : 'seismic',
          })
        }
        break
      case 'what-to-share':
        if (line.length > 5) {
          const matchingLink = links.find(l =>
            l.text.toLowerCase().includes(line.toLowerCase().slice(0, 20)) ||
            line.toLowerCase().includes(l.text.toLowerCase().slice(0, 20)),
          )
          result.whatToShare.push({
            name: line,
            url: matchingLink?.href ?? '',
          })
        }
        break
      case 'what-to-show':
        if (line.length > 5) {
          const matchingLink = links.find(l =>
            l.text.toLowerCase().includes(line.toLowerCase().slice(0, 20)) ||
            line.toLowerCase().includes(l.text.toLowerCase().slice(0, 20)),
          )
          result.whatToShow.push({
            name: line,
            url: matchingLink?.href ?? '',
            type: lower.includes('demo') ? 'demo' : lower.includes('workshop') ? 'workshop' : 'resource',
          })
        }
        break
      case 'services':
        if (line.length > 10) {
          result.services.push({ name: line, description: '' })
        }
        break
      // briefs and skills sections — informational, not structured for now
    }
  }

  // Extract cheatsheet and customer deck URLs from links
  for (const link of links) {
    const lower = link.text.toLowerCase()
    if (lower.includes('cheatsheet') || lower.includes('cheat sheet')) {
      if (!result.cheatsheetUrl) result.cheatsheetUrl = link.href
    }
    if (lower.includes('customer deck') || lower.includes('customer-facing deck')) {
      if (!result.customerDeckUrl) result.customerDeckUrl = link.href
    }
  }

  return result
}

// ── Sales Play Page Section Parsing (#367) ──────────────────────────────────

/**
 * Parse structured sections from a Sales Play page's innerText and links.
 * Extracts: Customer Lens, Real-World Examples, What to Say, What to Share,
 * Personas & Challenges, TDP Alignment, Regional Campaigns.
 */
export function parseSalesPlayPageSections(
  text: string,
  links: Array<{ text: string; href: string }>,
): Omit<ScrapedSalesPlay, 'name' | 'description' | 'linkedTdps' | 'url'> {
  const result = {
    customerLens: { pain: [] as string[], outcomes: [] as string[], impact: [] as string[] },
    realWorldExamples: [] as Array<{ customer: string; outcome: string }>,
    emailTemplateUrl: '',
    discoveryQuestionsUrl: '',
    introPitchDeckUrl: '',
    personaSection: {
      roles: [] as string[],
      painPoints: [] as string[],
      discoveryQuestions: [] as string[],
      valueProps: [] as string[],
      whatWinsThemOver: [] as string[],
    },
    tdpAlignment: [] as string[],
    regionalCampaigns: [] as Array<{ name: string; url: string }>,
  }

  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)

  type Section = 'none' | 'customer-lens-pain' | 'customer-lens-outcomes' | 'customer-lens-impact' |
    'real-world' | 'what-to-say' | 'what-to-share' | 'personas' | 'tdp-alignment' | 'regional'
  let currentSection: Section = 'none'
  type PersonaSubSection = 'none' | 'roles' | 'painPoints' | 'discoveryQuestions' | 'valueProps' | 'whatWinsThemOver'
  let personaSubSection: PersonaSubSection = 'none'

  for (const line of lines) {
    const lower = line.toLowerCase()

    // Section header detection
    if (lower === 'customer lens' || lower.startsWith('customer lens')) {
      // Customer Lens has three columns; we detect sub-headers
      currentSection = 'customer-lens-pain'
      continue
    }
    if (lower === 'pain' || lower === 'pain points' || lower.startsWith('customer pain')) {
      currentSection = 'customer-lens-pain'
      continue
    }
    if (lower === 'outcomes' || lower === 'desired outcomes' || lower.startsWith('business outcomes')) {
      currentSection = 'customer-lens-outcomes'
      continue
    }
    if (lower === 'impact' || lower === 'business impact' || lower.startsWith('measurable impact')) {
      currentSection = 'customer-lens-impact'
      continue
    }
    if (lower === 'real-world examples' || lower.startsWith('real-world example') || lower.startsWith('real world example')) {
      currentSection = 'real-world'
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
    if (lower.startsWith('personas') || lower.startsWith('personas & challenges') || lower.startsWith('personas and challenges')) {
      currentSection = 'personas'
      personaSubSection = 'none'
      continue
    }
    if (lower.startsWith('tdps powering') || lower.startsWith('tdp alignment') || lower.startsWith('supporting tdps')) {
      currentSection = 'tdp-alignment'
      continue
    }
    if (lower.includes('regional campaign') || lower.includes('americas commercial') || lower.includes('americas enterprise')) {
      currentSection = 'regional'
      // If this line itself is a campaign name, capture it
      if (line.length > 5 && !lower.startsWith('regional')) {
        const matchingLink = links.find(l =>
          l.text.toLowerCase().includes(lower.slice(0, 20)),
        )
        result.regionalCampaigns.push({ name: line, url: matchingLink?.href ?? '' })
      }
      continue
    }

    // Boundary: stop on unrelated major sections
    if (lower === 'sales tactic' || lower === 'sales tactics' ||
        lower.startsWith('content details') || lower.startsWith('content properties')) {
      currentSection = 'none'
      continue
    }

    if (line.length < 5) continue

    switch (currentSection) {
      case 'customer-lens-pain':
        if (line.length > 8) result.customerLens.pain.push(line)
        break
      case 'customer-lens-outcomes':
        if (line.length > 8) result.customerLens.outcomes.push(line)
        break
      case 'customer-lens-impact':
        if (line.length > 8) result.customerLens.impact.push(line)
        break
      case 'real-world':
        if (line.length > 10) {
          const dashIdx = line.indexOf(' — ')
          const hyphenIdx = dashIdx === -1 ? line.indexOf(' - ') : -1
          const splitIdx = dashIdx !== -1 ? dashIdx : hyphenIdx
          if (splitIdx > 3) {
            result.realWorldExamples.push({
              customer: line.slice(0, splitIdx).trim(),
              outcome: line.slice(splitIdx + 3).trim(),
            })
          } else {
            result.realWorldExamples.push({ customer: line, outcome: '' })
          }
        }
        break
      case 'what-to-say':
        // Look for specific asset types
        if (line.length > 5) {
          const matchingLink = links.find(l =>
            l.text.toLowerCase().includes(line.toLowerCase().slice(0, 20)) ||
            line.toLowerCase().includes(l.text.toLowerCase().slice(0, 20)),
          )
          const url = matchingLink?.href ?? ''
          if (lower.includes('email template')) {
            result.emailTemplateUrl = url
          } else if (lower.includes('discovery question')) {
            result.discoveryQuestionsUrl = url
          } else if (lower.includes('intro') && (lower.includes('pitch') || lower.includes('deck'))) {
            result.introPitchDeckUrl = url
          }
        }
        break
      case 'what-to-share':
        // Informational — links captured via link matching above
        break
      case 'personas': {
        // Sub-section state machine: detect positional headers within personas section
        if (lower === 'top three that matter most' || lower === 'top 3 that matter most') {
          personaSubSection = 'roles'
          continue
        }
        if (lower === 'what they care about' || lower === 'current reality' || lower === 'impacts') {
          personaSubSection = 'painPoints'
          continue
        }
        if (lower === 'ask these questions') {
          personaSubSection = 'discoveryQuestions'
          continue
        }
        if (lower === 'what wins them over') {
          personaSubSection = 'whatWinsThemOver'
          continue
        }
        if (lower === 'red hat advantage' || lower === 'value drivers' || lower === 'how red hat helps') {
          personaSubSection = 'valueProps'
          continue
        }
        if (line.length > 5 && personaSubSection !== 'none') {
          result.personaSection[personaSubSection].push(line)
        }
        break
      }
      case 'tdp-alignment':
        // Only accept lines matching known TDP names (#381)
        const CANONICAL_TDPS = ['AI Platform', 'Server/Cloud Operating System', 'Container Management',
          'Automation', 'App Platform', 'Application Platform', 'Virtualization', 'Server/Cloud OS']
        if (line.length > 3 && CANONICAL_TDPS.some(t => t.toLowerCase() === lower || lower.includes(t.toLowerCase()))) {
          result.tdpAlignment.push(line)
        }
        break
      case 'regional':
        if (line.length > 5) {
          const matchingLink = links.find(l =>
            l.text.toLowerCase().includes(lower.slice(0, 20)),
          )
          result.regionalCampaigns.push({ name: line, url: matchingLink?.href ?? '' })
        }
        break
    }
  }

  // Also scan links for specific URLs
  for (const link of links) {
    const lower = link.text.toLowerCase()
    if (!result.emailTemplateUrl && lower.includes('email template')) {
      result.emailTemplateUrl = link.href
    }
    if (!result.discoveryQuestionsUrl && (lower.includes('discovery question') || lower.includes('discovery guide'))) {
      result.discoveryQuestionsUrl = link.href
    }
    if (!result.introPitchDeckUrl && lower.includes('intro') && (lower.includes('pitch') || lower.includes('deck'))) {
      result.introPitchDeckUrl = link.href
    }
  }

  return result
}

/** Classify a URL into a resource type */
function classifyLinkType(url: string): string {
  if (url.includes('docs.google.com/document')) return 'google-docs'
  if (url.includes('docs.google.com/presentation')) return 'google-slides'
  if (url.endsWith('.pdf') || url.includes('/pdf/')) return 'pdf'
  return 'seismic'
}

// ── Assembly Function ────────────────────────────────────────────────────────

/**
 * Build the complete SalesHubKnowledge structure from scraped data.
 * Aggregates TDPs across products, deduplicates, and cross-references.
 */
// Garbage filter: entries that aren't real TDP/tactic content
function isGarbageEntry(name: string, description?: string): boolean {
  const trimmed = name.trim()
  const lower = trimmed.toLowerCase()
  // Pure UI chrome / SalesHub platform noise (13 patterns — reduced from 70+ in #388)
  if (lower.startsWith('visit') || lower.startsWith('arrow') || lower.includes('item(s)')) return true
  if (lower.startsWith('content detail') || lower.startsWith('content propert')) return true
  if (lower.startsWith('rating') || lower.startsWith('review')) return true
  if (lower.startsWith('displaying slide')) return true
  if (lower === 'services' || lower === 'learning resources' || lower === 'business content') return true
  if (lower === 'social selling' || lower === 'hear from a peer') return true
  if (lower.startsWith('go to sprout social') || lower.startsWith('filter by topic')) return true
  if (lower === 'how to get started' || lower === 'how to get started:') return true
  if (lower.startsWith('once you\'ve shared')) return true
  if (/^\d+$/.test(trimmed)) return true
  if (lower === 'coming soon!') return true
  if (lower.includes('sales tatics') || lower.includes('sales tactics')) return true
  if (description !== undefined && description.includes('redhat.com/') && description.length < 100 && !isTdpEntry(name)) return true
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
  tdpPages?: ScrapedTdpPage[],
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
            customerWins: [],
            whatToSay: [],
            whatToShare: [],
            whatToShow: [],
            services: [],
            cheatsheetUrl: '',
            customerDeckUrl: '',
            extractedContent: '',
            metrics: [],
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
          extractedContent: '',
          metrics: [],
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
        extractedContent: '',
        metrics: [],
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

  // Merge TDP page structured sections into TDP nodes (#366)
  if (tdpPages) {
    for (const tdpPage of tdpPages) {
      // Match by name — TDP page name may be "AI Platform" while tdpMap has "AI Platform TDP"
      let matched = false
      for (const [, tdp] of tdpMap) {
        if (tdp.name.toLowerCase().includes(tdpPage.name.toLowerCase()) ||
            tdpPage.name.toLowerCase().includes(tdp.name.toLowerCase().replace(/ tdp$/i, ''))) {
          tdp.customerWins = tdpPage.customerWins
          tdp.whatToSay = tdpPage.whatToSay
          tdp.whatToShare = tdpPage.whatToShare
          tdp.whatToShow = tdpPage.whatToShow
          tdp.services = tdpPage.services
          tdp.cheatsheetUrl = tdpPage.cheatsheetUrl
          tdp.customerDeckUrl = tdpPage.customerDeckUrl
          matched = true
          break
        }
      }
      // If no match found, create a new TDP node from the page data
      if (!matched && tdpPage.name) {
        tdpMap.set(tdpPage.name, {
          name: tdpPage.name,
          description: '',
          tactics: [],
          products: [],
          customerWins: tdpPage.customerWins,
          whatToSay: tdpPage.whatToSay,
          whatToShare: tdpPage.whatToShare,
          whatToShow: tdpPage.whatToShow,
          services: tdpPage.services,
          cheatsheetUrl: tdpPage.cheatsheetUrl,
          customerDeckUrl: tdpPage.customerDeckUrl,
          extractedContent: '',
          metrics: [],
        })
      }
    }
  }

  // ── TDP name normalization (#381) ──
  const TDP_NAME_MAP: Record<string, string> = {
    'server/cloud operating system': 'Server/Cloud OS',
    'server/cloud operating system tdp': 'Server/Cloud OS',
    'application platform': 'App Platform',
    'application platform tdp': 'App Platform TDP',
    'container management': 'Container Mgmt',
    'container management tdp': 'Container Mgmt',
    'automation tdp': 'Automation',
    'edge': 'AI Platform',
  }

  // Normalize TDP names in tdpMap
  for (const [key, tdp] of tdpMap) {
    const normalized = TDP_NAME_MAP[tdp.name.toLowerCase()]
    if (normalized && normalized !== tdp.name) {
      tdpMap.delete(key)
      // Merge into existing entry if one exists
      const existing = tdpMap.get(normalized)
      if (existing) {
        for (const t of tdp.tactics) { if (!existing.tactics.includes(t)) existing.tactics.push(t) }
        for (const p of tdp.products) { if (!existing.products.includes(p)) existing.products.push(p) }
        if (tdp.customerWins.length > existing.customerWins.length) existing.customerWins = tdp.customerWins
        if (tdp.whatToSay.length > existing.whatToSay.length) existing.whatToSay = tdp.whatToSay
        if (tdp.whatToShare.length > existing.whatToShare.length) existing.whatToShare = tdp.whatToShare
        if (tdp.whatToShow.length > existing.whatToShow.length) existing.whatToShow = tdp.whatToShow
        if (tdp.services.length > existing.services.length) existing.services = tdp.services
        if (!existing.cheatsheetUrl && tdp.cheatsheetUrl) existing.cheatsheetUrl = tdp.cheatsheetUrl
        if (!existing.customerDeckUrl && tdp.customerDeckUrl) existing.customerDeckUrl = tdp.customerDeckUrl
      } else {
        tdp.name = normalized
        tdpMap.set(normalized, tdp)
      }
    }
  }

  // Also normalize tactic parentTdp references
  for (const tactic of tacticNodes) {
    const normalized = TDP_NAME_MAP[tactic.parentTdp.toLowerCase()]
    if (normalized) tactic.parentTdp = normalized
  }

  // ── Deduplicate tactics with near-identical names (#381) ──
  {
    const seen = new Map<string, number>()
    const toRemove = new Set<number>()
    for (let i = 0; i < tacticNodes.length; i++) {
      const key = tacticNodes[i].name.toLowerCase().replace(/:\s*/g, ': ').replace(/\s+/g, ' ').trim()
      if (seen.has(key)) {
        const keptIdx = seen.get(key)!
        if (tacticNodes[i].name.includes(': ') && !tacticNodes[keptIdx].name.includes(': ')) {
          toRemove.add(keptIdx)
          seen.set(key, i)
        } else {
          toRemove.add(i)
        }
      } else {
        seen.set(key, i)
      }
    }
    if (toRemove.size > 0) {
      const removed = Array.from(toRemove).map(i => tacticNodes[i].name)
      console.log(`[knowledge] Deduplicated ${toRemove.size} near-duplicate tactics: ${removed.join(', ')}`)
      for (let i = tacticNodes.length - 1; i >= 0; i--) {
        if (toRemove.has(i)) tacticNodes.splice(i, 1)
      }
    }
  }

  // ── Post-processing: Restructure TDPs to match SalesHub actual structure (#368) ──

  // Helper for case-insensitive substring matching
  const fuzzyMatch = (haystack: string, needle: string) =>
    haystack.toLowerCase().includes(needle.toLowerCase())

  // (a) Create Container Mgmt TDP and move tactics from App Platform
  const containerMgmtTacticPatterns = [
    'kubernetes', // matches both K8s tactics (filtered below)
    'multicluster',
    'supply chain',
  ]
  const containerMgmtTacticNames: string[] = []

  // Find tactics to move by scanning tacticNodes
  for (const tactic of tacticNodes) {
    const name = tactic.name.toLowerCase()
    const shouldMove =
      (name.includes('kubernetes') && (name.includes('non-ai') || name.includes('3rd party ai') || name.includes('3rd party workloads'))) ||
      name.includes('multicluster') ||
      name.includes('supply chain')
    if (shouldMove) {
      tactic.parentTdp = 'Container Mgmt'
      containerMgmtTacticNames.push(tactic.name)
    }
  }

  // Add "Sovereign Infrastructure" tactic if not already present
  if (!tacticNodes.find(t => fuzzyMatch(t.name, 'sovereign infrastructure'))) {
    tacticNodes.push({
      name: 'Sovereign Infrastructure',
      talkTrack: '',
      customerWins: [],
      whatToSay: [],
      whatToShare: [],
      parentTdp: 'Container Mgmt',
      extractedContent: '',
      metrics: [],
    })
  } else {
    // Update parentTdp if it exists
    const sovereign = tacticNodes.find(t => fuzzyMatch(t.name, 'sovereign infrastructure'))
    if (sovereign) sovereign.parentTdp = 'Container Mgmt'
  }
  containerMgmtTacticNames.push('Sovereign Infrastructure')

  // Create Container Mgmt TDP node if it doesn't exist
  if (!tdpMap.has('Container Mgmt')) {
    tdpMap.set('Container Mgmt', {
      name: 'Container Mgmt',
      description: 'The Container Management Technology Decision Point positions Red Hat OpenShift for enterprise Kubernetes container management, multi-cluster operations, supply chain security, and sovereign infrastructure.',
      tactics: [...containerMgmtTacticNames],
      products: [],
      customerWins: [],
      whatToSay: [],
      whatToShare: [],
      whatToShow: [],
      services: [],
      cheatsheetUrl: '',
      customerDeckUrl: '',
      extractedContent: '',
      metrics: [],
    })
  } else {
    const cm = tdpMap.get('Container Mgmt')!
    for (const name of containerMgmtTacticNames) {
      if (!cm.tactics.includes(name)) cm.tactics.push(name)
    }
  }

  // Remove moved tactics from App Platform TDP(s)
  for (const [, tdp] of tdpMap) {
    if (fuzzyMatch(tdp.name, 'app platform')) {
      tdp.tactics = tdp.tactics.filter(t => !containerMgmtTacticNames.includes(t))
    }
  }

  // Copy products from App Platform to Container Mgmt (they share OpenShift)
  for (const [, tdp] of tdpMap) {
    if (fuzzyMatch(tdp.name, 'app platform')) {
      const cm = tdpMap.get('Container Mgmt')!
      for (const prod of tdp.products) {
        if (!cm.products.includes(prod)) cm.products.push(prod)
      }
    }
  }

  // (b) Add "Red Hat AI Factory with NVIDIA" tactic if not present
  // Determine the AI Platform TDP name (may be "AI TDP", "AI", or "AI Platform")
  let aiTdpName = ''
  for (const [, tdp] of tdpMap) {
    if (/^ai(\s+tdp)?$/i.test(tdp.name.trim()) || fuzzyMatch(tdp.name, 'ai platform')) {
      aiTdpName = tdp.name
      break
    }
  }
  if (!tacticNodes.find(t => fuzzyMatch(t.name, 'ai factory') && fuzzyMatch(t.name, 'nvidia'))) {
    const parentForAiFactory = aiTdpName || 'AI Platform'
    tacticNodes.push({
      name: 'Red Hat AI Factory with NVIDIA',
      talkTrack: '',
      customerWins: [],
      whatToSay: [],
      whatToShare: [],
      parentTdp: parentForAiFactory,
      extractedContent: '',
      metrics: [],
    })
    // Add to AI TDP's tactics list
    if (aiTdpName) {
      const aiTdp = tdpMap.get(aiTdpName)!
      if (!aiTdp.tactics.includes('Red Hat AI Factory with NVIDIA')) {
        aiTdp.tactics.push('Red Hat AI Factory with NVIDIA')
      }
    }
  }

  // (c) Remove Edge TDP entirely
  for (const [key, tdp] of tdpMap) {
    if (fuzzyMatch(tdp.name, 'edge')) {
      tdpMap.delete(key)
    }
  }

  // (d) Rename AI → AI Platform
  for (const [key, tdp] of tdpMap) {
    if (/^ai(\s+tdp)?$/i.test(tdp.name.trim())) {
      tdpMap.delete(key)
      tdp.name = 'AI Platform'
      tdpMap.set('AI Platform', tdp)
      break // Only one AI TDP to rename
    }
  }
  // Update tacticNodes parentTdp references from AI/AI TDP to AI Platform
  for (const tactic of tacticNodes) {
    if (/^ai(\s+tdp)?$/i.test(tactic.parentTdp.trim())) {
      tactic.parentTdp = 'AI Platform'
    }
  }
  // Update AI Factory tactic parentTdp if it was set to old name
  const aiFactoryTactic = tacticNodes.find(t => fuzzyMatch(t.name, 'ai factory') && fuzzyMatch(t.name, 'nvidia'))
  if (aiFactoryTactic && aiFactoryTactic.parentTdp !== 'AI Platform') {
    aiFactoryTactic.parentTdp = 'AI Platform'
  }

  // (e) Ensure Container Mgmt tactics list is accurate (already done above)

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

  // Build sales play nodes (#367)
  const salesPlayNodes: SalesPlayNode[] = salesPlays.map(sp => ({
    name: sp.name,
    description: sp.description,
    linkedTdps: sp.linkedTdps,
    customerLens: sp.customerLens ?? { pain: [], outcomes: [], impact: [] },
    realWorldExamples: sp.realWorldExamples ?? [],
    emailTemplateUrl: sp.emailTemplateUrl ?? '',
    discoveryQuestionsUrl: sp.discoveryQuestionsUrl ?? '',
    introPitchDeckUrl: sp.introPitchDeckUrl ?? '',
    personaSection: sp.personaSection ?? { roles: [], painPoints: [], discoveryQuestions: [], valueProps: [], whatWinsThemOver: [] },
    tdpAlignment: sp.tdpAlignment ?? [],
    regionalCampaigns: sp.regionalCampaigns ?? [],
  }))

  // ── Clean noise from all text arrays ──
  for (const play of salesPlayNodes) {
    if (play.personaSection) {
      play.personaSection.roles = play.personaSection.roles.filter(p => !isGarbageEntry(p))
      play.personaSection.painPoints = play.personaSection.painPoints.filter(p => !isGarbageEntry(p))
      play.personaSection.discoveryQuestions = play.personaSection.discoveryQuestions.filter(p => !isGarbageEntry(p))
      play.personaSection.valueProps = play.personaSection.valueProps.filter(p => !isGarbageEntry(p))
      play.personaSection.whatWinsThemOver = play.personaSection.whatWinsThemOver.filter(p => !isGarbageEntry(p))
    }
  }
  for (const tactic of tacticNodes) {
    if (tactic.whatToSay) tactic.whatToSay = tactic.whatToSay.filter(s => typeof s === 'string' ? !isGarbageEntry(s) : true)
    if (tactic.whatToShare) tactic.whatToShare = tactic.whatToShare.filter(s => {
      if (typeof s === 'string') return !isGarbageEntry(s)
      if (typeof s === 'object' && s.name) return !isGarbageEntry(s.name) && s.url !== 'javascript:void(0)'
      return true
    })
    if (tactic.customerWins) tactic.customerWins = tactic.customerWins.filter(s => typeof s === 'string' ? !isGarbageEntry(s) : true)
  }
  for (const [, tdp] of tdpMap) {
    if (tdp.whatToSay) tdp.whatToSay = tdp.whatToSay.filter(s => typeof s === 'string' ? !isGarbageEntry(s) : true)
    if (tdp.whatToShare) tdp.whatToShare = tdp.whatToShare.filter(s => {
      if (typeof s === 'string') return !isGarbageEntry(s)
      if (typeof s === 'object' && s.name) return !isGarbageEntry(s.name) && s.url !== 'javascript:void(0)'
      return true
    })
    if (tdp.whatToShow) tdp.whatToShow = tdp.whatToShow.filter(s => typeof s === 'string' ? !isGarbageEntry(s) : true)
    if (tdp.services) tdp.services = tdp.services.filter(s => typeof s === 'string' ? !isGarbageEntry(s) : true)
    if (tdp.customerWins) tdp.customerWins = tdp.customerWins.filter(s => typeof s === 'string' ? !isGarbageEntry(s) : true)
  }

  // ── Deduplicate whatToShare links by URL (keep longest name) ──
  for (const tactic of tacticNodes) {
    if (tactic.whatToShare && Array.isArray(tactic.whatToShare)) {
      const seen = new Map<string, number>()
      const toRemove = new Set<number>()
      for (let i = 0; i < tactic.whatToShare.length; i++) {
        const item = tactic.whatToShare[i]
        if (typeof item === 'object' && item.url && item.url !== '') {
          if (seen.has(item.url)) {
            const keptIdx = seen.get(item.url)!
            const keptName = (tactic.whatToShare[keptIdx] as any)?.name?.length ?? 0
            const thisName = item.name?.length ?? 0
            if (thisName > keptName) {
              toRemove.add(keptIdx)
              seen.set(item.url, i)
            } else {
              toRemove.add(i)
            }
          } else {
            seen.set(item.url, i)
          }
        }
      }
      if (toRemove.size > 0) {
        tactic.whatToShare = tactic.whatToShare.filter((_, i) => !toRemove.has(i))
      }
    }
  }
  for (const [, tdp] of tdpMap) {
    if (tdp.whatToShare && Array.isArray(tdp.whatToShare)) {
      const seen = new Map<string, number>()
      const toRemove = new Set<number>()
      for (let i = 0; i < tdp.whatToShare.length; i++) {
        const item = tdp.whatToShare[i]
        if (typeof item === 'object' && item.url && item.url !== '') {
          if (seen.has(item.url)) {
            const keptIdx = seen.get(item.url)!
            const keptName = (tdp.whatToShare[keptIdx] as any)?.name?.length ?? 0
            const thisName = item.name?.length ?? 0
            if (thisName > keptName) {
              toRemove.add(keptIdx)
              seen.set(item.url, i)
            } else {
              toRemove.add(i)
            }
          } else {
            seen.set(item.url, i)
          }
        }
      }
      if (toRemove.size > 0) {
        tdp.whatToShare = tdp.whatToShare.filter((_, i) => !toRemove.has(i))
      }
    }
  }

  return {
    version: 1,
    scrapedAt: new Date().toISOString(),
    salesPlays: salesPlayNodes,
    tdps: Array.from(tdpMap.values()),
    tactics: tacticNodes,
    products: productNodes,
  }
}
