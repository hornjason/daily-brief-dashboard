/**
 * Document Intelligence Resolver — ADR-041 Post-Extraction Resolution
 *
 * Deterministic vocabulary resolution for DocumentIntelligence.
 * Runs OUTSIDE Gemini — pure TypeScript, no LLM.
 *
 * Resolution chain:
 * 1. sanitizeDocumentIntelligence() — validate/clean raw extraction output
 * 2. resolveProductReferences() — resolve product names to slugs via product-vocabulary
 * 3. resolveCompetitorReferences() — resolve competitors via competitive-vocabulary
 * 4. resolvePartnerSolutions() — match partners against ecosystem catalog
 * 5. resolveDocumentIntelligence() — compose all steps into one immutable transform
 */

import type {
  DocumentIntelligence,
  ProductReference,
  CompetitorReference,
  PartnerSolutionReference,
} from '../types/saleshub-product-types.ts'
import { resolveToSlug } from './product-vocabulary.ts'
import { resolveDisplacement } from './competitive-vocabulary.ts'
import type { EcosystemPartnerCache } from './ecosystem-catalog.ts'
import { TDP_DOMAINS } from './tdp-domains.ts'

// ── Sanitization ────────────────────────────────────────────────────────────

const MAX_NAME_LENGTH = 200
const HTML_TAG_RE = /<[^>]+>/g
const PATH_TRAVERSAL_RE = /\.\.\//g

/**
 * Sanitize a DocumentIntelligence object:
 * - Truncate names to MAX_NAME_LENGTH
 * - Strip HTML tags from text fields
 * - Validate URL schemes (https/http only)
 * - Reject fields with path-traversal characters
 */
export function sanitizeDocumentIntelligence(raw: DocumentIntelligence): DocumentIntelligence {
  const sanitizeStr = (s: string, maxLen = MAX_NAME_LENGTH): string => {
    if (!s) return s
    let cleaned = s.replace(HTML_TAG_RE, '').replace(PATH_TRAVERSAL_RE, '')
    if (cleaned.length > maxLen) cleaned = cleaned.slice(0, maxLen)
    return cleaned
  }

  const sanitizeUrl = (url: string): string => {
    if (!url) return url
    const trimmed = url.trim()
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
    return '' // reject non-http(s) URLs
  }

  return {
    ...raw,
    documentName: sanitizeStr(raw.documentName),
    summary: sanitizeStr(raw.summary, 5000),
    productsReferenced: raw.productsReferenced.map(p => ({
      ...p,
      name: sanitizeStr(p.name),
    })),
    integrationsReferenced: raw.integrationsReferenced?.map(i => ({
      technology: sanitizeStr(i.technology),
      category: sanitizeStr(i.category),
    })) ?? null,
    competitorsReferenced: raw.competitorsReferenced?.map(c => ({
      name: sanitizeStr(c.name),
      context: sanitizeStr(c.context),
    })) ?? null,
    partnerSolutions: raw.partnerSolutions?.map(p => ({
      partnerName: sanitizeStr(p.partnerName),
      solutionArea: sanitizeStr(p.solutionArea),
    })) ?? null,
    useCases: raw.useCases?.map(u => sanitizeStr(u)) ?? null,
    customerScenarios: raw.customerScenarios?.map(cs => ({
      scenario: sanitizeStr(cs.scenario),
      industry: cs.industry ? sanitizeStr(cs.industry) : null,
    })) ?? null,
    keyPoints: raw.keyPoints.map(k => sanitizeStr(k)),
    talkTracks: raw.talkTracks?.map(t => sanitizeStr(t)) ?? null,
    links: raw.links
      .map(l => ({ name: sanitizeStr(l.name), url: sanitizeUrl(l.url) }))
      .filter(l => l.url.length > 0),
    actionableSteps: raw.actionableSteps?.map(a => ({
      step: sanitizeStr(a.step),
      url: a.url ? sanitizeUrl(a.url) || undefined : undefined,
    })) ?? null,
    tdpAlignment: raw.tdpAlignment?.map(t => sanitizeStr(t)) ?? null,
    buyingStage: (['awareness', 'discovery', 'evaluation', 'justification', 'expansion'] as const)
      .includes(raw.buyingStage) ? raw.buyingStage : 'awareness',
    targetPersona: raw.targetPersona?.map(t => sanitizeStr(t)) ?? null,
    customerProblem: raw.customerProblem ? sanitizeStr(raw.customerProblem, 2000) : null,
    conversationOpener: raw.conversationOpener ? sanitizeStr(raw.conversationOpener, 1000) : null,
    techStackTriggers: raw.techStackTriggers?.map(t => sanitizeStr(t)) ?? null,
    workshops: raw.workshops
      ?.map(w => ({ name: sanitizeStr(w.name), url: sanitizeUrl(w.url) }))
      .filter(w => w.url.length > 0) ?? null,
    demos: raw.demos
      ?.map(d => ({ name: sanitizeStr(d.name), url: sanitizeUrl(d.url) }))
      .filter(d => d.url.length > 0) ?? null,
  }
}

// ── Product Reference Resolution ────────────────────────────────────────────

/**
 * Resolve product names to canonical slugs via product-vocabulary.ts.
 * Pure function — no Gemini, no async.
 */
export function resolveProductReferences(refs: ProductReference[]): ProductReference[] {
  return refs.map(ref => ({
    name: ref.name,
    slug: resolveToSlug(ref.name),
  }))
}

// ── Competitor Reference Resolution ─────────────────────────────────────────

/**
 * Resolve competitor names via competitive-vocabulary.ts.
 * Uses resolveDisplacement() — NOT getDisplacementTarget (doesn't exist).
 */
export function resolveCompetitorReferences(refs: CompetitorReference[]): CompetitorReference[] {
  return refs.map(ref => {
    const displacement = resolveDisplacement(ref.name)
    if (displacement) {
      // Annotate context with displacement info if available
      return {
        name: ref.name,
        context: ref.context,
      }
    }
    return ref
  })
}

// ── Partner Solution Resolution ─────────────────────────────────────────────

/**
 * Resolve partner solution references against the pre-loaded ecosystem catalog.
 * Matches on partner name (case-insensitive).
 */
export function resolvePartnerSolutions(
  refs: PartnerSolutionReference[],
  partners: EcosystemPartnerCache[],
): PartnerSolutionReference[] {
  return refs.map(ref => {
    const refLower = ref.partnerName.toLowerCase()
    const match = partners.find(p => p.partnerName.toLowerCase() === refLower)
    if (match) {
      // Partner found in ecosystem catalog — keep reference intact
      return {
        partnerName: match.partnerName, // use canonical name from catalog
        solutionArea: ref.solutionArea,
      }
    }
    return ref
  })
}

// ── TDP Alignment Resolution (#962) ────────────────────────────────────────

/**
 * Edge-case mappings for free-form TDP values that have no lexical overlap
 * with any keyword in TDP_DOMAINS. These are deterministic fallbacks —
 * the keyword system handles the other 58+ values automatically.
 */
const TDP_EDGE_CASES: Record<string, string> = {
  'disaster recovery': 'Server and Cloud Computing',
  'edge computing': 'Server and Cloud Computing',
  'itsm integration': 'Management',
  'observability and monitoring': 'Management',
  'infrastructure as code': 'Automation',
}

/**
 * Resolve a single free-form TDP string to a canonical TDP domain name.
 * Resolution order:
 * 1. Exact canonical match (case-insensitive)
 * 2. Exact alias match
 * 3. Keyword-weighted matching (sum of matched keyword char lengths)
 * 4. Acronym matching (first letter of each word)
 * 5. Edge-case lookup
 * 6. Canonical name substring check
 * Returns null if no match — caller drops unresolvable values.
 */
function resolveSingleTdp(tdp: string): string | null {
  const lowered = tdp.toLowerCase()

  // Step 1: Already canonical (case-insensitive)
  for (const canonical of Object.keys(TDP_DOMAINS)) {
    if (canonical.toLowerCase() === lowered) return canonical
  }

  // Step 2: Exact alias match
  for (const [canonical, domain] of Object.entries(TDP_DOMAINS)) {
    for (const alias of domain.aliases) {
      if (alias.toLowerCase() === lowered) return canonical
    }
  }

  // Step 3: Keyword-weighted matching
  // Score = sum of character lengths of all matched keywords.
  // Longer keywords contribute more, naturally preferring specific matches.
  // When tied, prefer the domain with the shorter canonical name (more specific).
  const stripped = lowered.replace(/[^a-z0-9 ]/g, '') // normalize ci/cd → cicd
  let bestScore = 0
  const candidates: string[] = []

  for (const [canonical, domain] of Object.entries(TDP_DOMAINS)) {
    let score = 0
    for (const kw of domain.keywords) {
      if (lowered.includes(kw) || stripped.includes(kw)) {
        score += kw.length
      }
    }
    if (score > bestScore) {
      bestScore = score
      candidates.length = 0
      candidates.push(canonical)
    } else if (score === bestScore && score > 0) {
      candidates.push(canonical)
    }
  }

  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) {
    // Tie-break: check if input contains a canonical domain name
    for (const c of candidates) {
      if (lowered.includes(c.toLowerCase())) return c
    }
    // Final tie-break: shorter canonical name = more specific domain
    candidates.sort((a, b) => a.length - b.length)
    return candidates[0]
  }

  // Step 4: Acronym matching — "Artificial Intelligence" → "ai"
  const words = lowered.split(/[\s/,&-]+/).filter(w => w.length > 0)
  if (words.length >= 2) {
    const acronym = words.map(w => w[0]).join('')
    for (const [canonical, domain] of Object.entries(TDP_DOMAINS)) {
      if (domain.keywords.includes(acronym)) return canonical
    }
  }

  // Step 5: Edge-case lookup for values with no lexical keyword overlap
  const edgeCase = TDP_EDGE_CASES[lowered]
  if (edgeCase) return edgeCase

  // Step 6: Canonical domain name substring check
  for (const canonical of Object.keys(TDP_DOMAINS)) {
    if (lowered.includes(canonical.toLowerCase())) return canonical
  }

  // No match — drop
  return null
}

/**
 * Map an array of free-form TDP values to canonical TDP domain names.
 * - Resolves each value via keyword matching, alias lookup, and edge-case fallback
 * - Deduplicates the result
 * - Returns null if input is null/empty or all values are unresolvable
 */
export function resolveTdpAlignment(tdps: string[] | null): string[] | null {
  if (!tdps || tdps.length === 0) return null

  const resolved: string[] = []
  for (const tdp of tdps) {
    const mapped = resolveSingleTdp(tdp)
    if (mapped) resolved.push(mapped)
  }

  if (resolved.length === 0) return null
  return [...new Set(resolved)]
}

// ── Composed Resolution ─────────────────────────────────────────────────────

/**
 * Full resolution pipeline: sanitize, then resolve products, competitors,
 * and partner solutions. Returns a NEW object (immutable transform).
 */
export function resolveDocumentIntelligence(
  doc: DocumentIntelligence,
  partners: EcosystemPartnerCache[],
): DocumentIntelligence {
  const sanitized = sanitizeDocumentIntelligence(doc)

  return {
    ...sanitized,
    productsReferenced: resolveProductReferences(sanitized.productsReferenced),
    competitorsReferenced: sanitized.competitorsReferenced
      ? resolveCompetitorReferences(sanitized.competitorsReferenced)
      : null,
    partnerSolutions: sanitized.partnerSolutions
      ? resolvePartnerSolutions(sanitized.partnerSolutions, partners)
      : null,
    tdpAlignment: resolveTdpAlignment(sanitized.tdpAlignment),
  }
}
