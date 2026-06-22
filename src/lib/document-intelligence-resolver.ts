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
  const sanitizeStr = (s: string): string => {
    if (!s) return s
    let cleaned = s.replace(HTML_TAG_RE, '').replace(PATH_TRAVERSAL_RE, '')
    if (cleaned.length > MAX_NAME_LENGTH) cleaned = cleaned.slice(0, MAX_NAME_LENGTH)
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
    summary: sanitizeStr(raw.summary),
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
  }
}
