/**
 * src/lib/motion-builder.ts
 * Strategic Motion Builder — GitHub Issue #515
 *
 * Given a customer's intelligence graph (from #511), generates a Strategic Motion:
 * a multi-phase account plan that groups related SalesHub tactics into a coherent
 * solution-selling strategy.
 *
 * Phase categories:
 *   - Anchor: protect existing subscriptions (expired/expiring-soon)
 *   - Expand: products the customer doesn't own but signals point toward
 *   - Transform: long-term strategic plays driven by Initiatives
 *
 * Dependencies:
 *   - intelligence-graph-types.ts — CustomerGraph, IntelligenceNode, IntelligenceEdge
 *   - graph-utils.ts — findNodesByType, getEdgesFrom
 *   - gemini-call.ts — callGemini (optional, for phase briefs)
 */

import type { Signal } from '../feature-module-registry.ts'
import { callGemini } from '../gemini-call.ts'
import type {
  CustomerGraph,
  IntelligenceNode,
} from './intelligence-graph-types.ts'
import { findNodesByType } from './graph-utils.ts'
import { getTdpByName } from './saleshub-knowledge-loader.ts'
import { resolve as resolveMaterials } from './material-index.ts'
import type { MaterialLink } from './material-index.ts'
import { scoreTactics, type SignalDensity } from './tactic-scorer.ts'
import type { GeminiRecommendation, EnhancedGeminiRecommendation, MergedRecommendation } from './gemini-tactic-recommender.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface MotionPhase {
  id: string
  name: string
  category: 'anchor' | 'expand' | 'transform'
  urgency: 'critical' | 'high' | 'medium' | 'low'
  tactics: Array<{
    name: string
    parentTdp: string
    tdpUrl?: string
    assets: Array<{ name: string; url: string; type: string }>
    materials?: MaterialLink[]
    brief?: string
  }>
  targetPersonas: string[]
  evidence: Array<{
    module: string
    fact: string
    url?: string
  }>
  estimatedTcv?: number
  brief?: string
}

export interface EnrichedContact {
  persona: string
  name?: string
  email?: string
  title?: string
  linkedinUrl?: string
  source?: string
}

export interface StrategicMotion {
  id: string
  customerSlug: string
  customerName: string
  title: string
  salesPlay?: string
  phases: MotionPhase[]
  confidence: 'high' | 'medium' | 'low'
  totalEstimatedTcv?: number
  generatedAt: string
  status: 'active' | 'dismissed' | 'pinned'
  enrichedContacts?: EnrichedContact[]
  geminiInsights?: GeminiRecommendation[]
  /** Enhanced Gemini recommendations with novel discoveries (#613) */
  enhancedRecommendations?: MergedRecommendation[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** TDP-to-persona mapping: each TDP domain has its own natural buyer personas (#540) */
const TDP_PERSONAS: Record<string, string[]> = {
  'Automation': ['VP IT Operations', 'Director of Platform Engineering', 'IT Operations Lead'],
  'Container Management': ['CTO / Platform Engineering', 'VP Infrastructure', 'Director of Cloud Architecture'],
  'Container Mgmt': ['CTO / Platform Engineering', 'VP Infrastructure', 'Director of Cloud Architecture'],
  'Server and Cloud Computing': ['VP Infrastructure', 'Cloud Architect', 'Director of IT Operations'],
  'AI Platform': ['Head of Data Science', 'CTO', 'VP AI/ML Engineering'],
  'AI': ['Head of Data Science', 'CTO', 'VP AI/ML Engineering'],
  'App Platform': ['VP Application Development', 'Director of Platform Engineering', 'CTO'],
  'Application Development': ['VP Application Development', 'Director of Platform Engineering', 'CTO'],
  'Virtualization': ['VP Infrastructure', 'Director of IT Operations', 'CIO'],
  'Management': ['VP IT Operations', 'Director of IT Operations', 'IT Operations Lead'],
  'Security': ['CISO', 'VP Security', 'Director of IT Security'],
}

/**
 * Derive target personas from the TDP domains covered by a phase's tactics.
 * Falls back to play-level personas if no TDP-specific personas are found.
 */
function derivePhasePersonas(
  tactics: MotionPhase['tactics'],
  fallbackPersonas: string[],
): string[] {
  const phaseTdps = [...new Set(tactics.map(t => t.parentTdp).filter(Boolean))]
  const phasePersonas = [...new Set(phaseTdps.flatMap(tdp => TDP_PERSONAS[tdp] ?? []))]
  return phasePersonas.length > 0 ? phasePersonas : fallbackPersonas
}

/** Maximum tactics per TDP domain in any phase */
const MAX_TACTICS_PER_TDP = 3

/** Maximum evidence items per phase (#532) */
const MAX_EVIDENCE_PER_PHASE = 7

/** Evidence module priority for sorting (lower = higher priority) */
const EVIDENCE_PRIORITY: Record<string, number> = {
  cases_open: 0,
  subscriptions: 1,
  ccsp: 2,
  'solution-intelligence': 3,
  'tech-stack': 4,
  cases_closed: 5,
}

/**
 * Sort evidence by priority and cap at MAX_EVIDENCE_PER_PHASE.
 * Open cases first, then expired subs, cloud spend, others, closed cases last.
 */
function capEvidence(evidence: MotionPhase['evidence']): MotionPhase['evidence'] {
  const sorted = [...evidence].sort((a, b) => {
    const aKey = a.module === 'cases'
      ? (a.fact.startsWith('Open case') ? 'cases_open' : 'cases_closed')
      : a.module
    const bKey = b.module === 'cases'
      ? (b.fact.startsWith('Open case') ? 'cases_open' : 'cases_closed')
      : b.module
    return (EVIDENCE_PRIORITY[aKey] ?? 99) - (EVIDENCE_PRIORITY[bKey] ?? 99)
  })
  return sorted.slice(0, MAX_EVIDENCE_PER_PHASE)
}

/**
 * Extract meaningful keywords from a product/case/tech name.
 * Strips common noise words and splits on whitespace and punctuation.
 * Returns lowercase keywords of 3+ characters.
 */
function extractKeywords(text: string): string[] {
  const NOISE = new Set([
    'red', 'hat', 'the', 'for', 'and', 'with', 'from', 'into',
    'premium', 'standard', 'basic', 'advanced', 'enterprise',
    'subscription', 'subscriptions', 'case',
  ])
  return text
    .toLowerCase()
    .split(/[\s\-_,.:;()/]+/)
    .filter(w => w.length >= 3 && !NOISE.has(w))
}

/** Minimum shared prefix length for stem matching */
const MIN_STEM_LENGTH = 5

/**
 * Check if two words share a common stem (prefix of MIN_STEM_LENGTH+ chars).
 * Handles morphological variants like automate/automation, container/containers.
 */
function stemMatch(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.min(a.length, b.length) < MIN_STEM_LENGTH) return false
  let shared = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) shared++
    else break
  }
  return shared >= MIN_STEM_LENGTH
}

/** A weighted keyword: weight > 1 for signal-derived terms, 1 for generic */
export interface WeightedKeyword {
  word: string
  weight: number
}

/**
 * Score a tactic's relevance to weighted context keywords.
 *
 * Uses word-level stem matching to handle morphological variants
 * (automate/automation, container/containers) without false positives
 * from short substring overlap.
 *
 * Accepts both string[] (all weight 1.0) and WeightedKeyword[] for
 * backward compatibility. Signal-derived keywords (from cases, tech stack)
 * should have higher weight than generic product-name keywords.
 */
function scoreTacticRelevance(
  tacticName: string,
  contextKeywords: (string | WeightedKeyword)[],
): number {
  const tacticWords = extractKeywords(tacticName)
  let score = 0

  // Deduplicate by stem: keep highest weight per stem group
  const stemWeights = new Map<string, number>()
  for (const kw of contextKeywords) {
    const word = typeof kw === 'string' ? kw.toLowerCase() : kw.word.toLowerCase()
    const weight = typeof kw === 'string' ? 1.0 : kw.weight
    const existing = stemWeights.get(word)
    if (existing === undefined || weight > existing) {
      stemWeights.set(word, weight)
    }
  }

  const matched = new Set<string>()
  for (const [kw, weight] of stemWeights) {
    for (const tw of tacticWords) {
      if (!matched.has(tw) && stemMatch(tw, kw)) {
        score += weight
        matched.add(tw)
        break
      }
    }
  }
  return score
}

/**
 * Filter tactics to the top N per TDP domain, ranked by relevance to context keywords.
 * Tactics with assets get a small bonus (they're more actionable).
 */
function filterTopTacticsPerTdp(
  tactics: MotionPhase['tactics'],
  contextKeywords: (string | WeightedKeyword)[],
  maxPerTdp: number = MAX_TACTICS_PER_TDP,
): MotionPhase['tactics'] {
  // Filter out tactics with empty parentTdp, then group
  const validTactics = tactics.filter(t => t.parentTdp && t.parentTdp.trim())
  const byTdp = new Map<string, MotionPhase['tactics']>()
  for (const t of validTactics) {
    const list = byTdp.get(t.parentTdp) ?? []
    list.push(t)
    byTdp.set(t.parentTdp, list)
  }

  const result: MotionPhase['tactics'] = []
  for (const [_tdp, tdpTactics] of byTdp) {
    if (tdpTactics.length <= maxPerTdp) {
      result.push(...tdpTactics)
      continue
    }
    // Score and sort by relevance, with asset bonus
    const scored = tdpTactics.map(t => ({
      tactic: t,
      score: scoreTacticRelevance(t.name, contextKeywords) + (t.assets.length > 0 ? 0.5 : 0),
    }))
    scored.sort((a, b) => b.score - a.score)
    result.push(...scored.slice(0, maxPerTdp).map(s => s.tactic))
  }

  return result
}

/**
 * Generate a clean phase name from unique TDP domains covered by tactics.
 */
function buildPhaseName(prefix: string, tactics: MotionPhase['tactics']): string {
  const uniqueTdps = [...new Set(tactics.map(t => t.parentTdp).filter(t => t && t.trim()))]
  return uniqueTdps.length > 0 ? `${prefix}: ${uniqueTdps.join(' + ')}` : prefix
}

/**
 * Map TDP names from signals/nodes to normalized TDP domains for matching.
 * SalesHub plays use specific TDP names; subscriptions use product names.
 */
function inferTdpFromProduct(productName: string): string | null {
  const lower = productName.toLowerCase()
  if (lower.includes('ansible') || lower.includes('automation')) return 'Automation'
  if (lower.includes('openshift') || lower.includes('container') || lower.includes('kubernetes')) return 'Container Mgmt'
  if (lower.includes('rhel') || lower.includes('enterprise linux') || lower.includes('server')) return 'Server/Cloud OS'
  if (lower.includes('virtualization') || lower.includes('virt')) return 'Virtualization'
  if (lower.includes('satellite')) return 'Management'
  if (lower.includes('ai') || lower.includes('rhoai')) return 'AI Platform'
  return null
}

/**
 * Extract TDP domains the customer's signals cover.
 * Returns a Set of normalized TDP names.
 */
function extractCustomerTdpDomains(graph: CustomerGraph): Set<string> {
  const domains = new Set<string>()

  // From subscription nodes
  const subs = findNodesByType(graph, 'subscription')
  for (const sub of subs) {
    const desc = String(sub.properties.productDescription ?? sub.name ?? '')
    const tdp = inferTdpFromProduct(desc)
    if (tdp) domains.add(tdp)
  }

  // From case nodes (product field)
  const cases = findNodesByType(graph, 'case')
  for (const c of cases) {
    const product = String(c.properties.product ?? '')
    const tdp = inferTdpFromProduct(product)
    if (tdp) domains.add(tdp)
  }

  // From play nodes (productAlignment)
  const plays = findNodesByType(graph, 'play')
  for (const play of plays) {
    const alignment = String(play.properties.productAlignment ?? '')
    const tdp = inferTdpFromProduct(alignment)
    if (tdp) domains.add(tdp)
  }

  // From cloud spend → implies Server and Cloud Computing
  const programs = findNodesByType(graph, 'program')
  for (const prog of programs) {
    const progType = String(prog.properties.programType ?? '')
    if (progType === 'cloud-spend' || progType === 'marketplace') {
      domains.add('Server and Cloud Computing')
    }
  }

  // From tech-stack nodes (AI-related tech)
  const products = findNodesByType(graph, 'product')
  for (const p of products) {
    const name = String(p.properties.techName ?? p.name ?? '')
    const tdp = inferTdpFromProduct(name)
    if (tdp) domains.add(tdp)
  }

  return domains
}

/**
 * Match SalesHub plays to customer by TDP overlap.
 * Returns the play with the most TDP coverage, or null.
 */
function matchSalesPlay(
  customerTdps: Set<string>,
  playSignals: Signal[],
): { playName: string; tdpOverlap: number; personaRoles: string[] } | null {
  let best: { playName: string; tdpOverlap: number; personaRoles: string[] } | null = null

  for (const sig of playSignals) {
    const m = sig.metadata ?? {}
    const tdpAlignment = (m.tdpAlignment as string[]) ?? []
    const overlap = tdpAlignment.filter(tdp => customerTdps.has(tdp)).length
    if (overlap >= 2 && (!best || overlap > best.tdpOverlap)) {
      best = {
        playName: sig.headline,
        tdpOverlap: overlap,
        personaRoles: (m.personaRoles as string[]) ?? [],
      }
    }
  }

  return best
}

/**
 * Build anchor phase from expired/expiring subscriptions.
 */
function buildAnchorPhase(
  graph: CustomerGraph,
  tacticSignals: Signal[],
  portfolioFrequency?: Map<string, number>,
): MotionPhase | null {
  const subs = findNodesByType(graph, 'subscription')
  const expiredSubs = subs.filter(s => {
    const urgency = String(s.properties.urgency ?? s.properties.status ?? '').toLowerCase()
    return urgency === 'expired' || urgency === 'expired-critical'
  })

  if (expiredSubs.length === 0) return null

  // Find matching tactics for expired product TDPs
  const expiredTdps = new Set<string>()
  for (const sub of expiredSubs) {
    const desc = String(sub.properties.productDescription ?? sub.name ?? '')
    const tdp = inferTdpFromProduct(desc)
    if (tdp) expiredTdps.add(tdp)
  }

  const allMatchingTactics: MotionPhase['tactics'] = []
  for (const sig of tacticSignals) {
    const m = sig.metadata ?? {}
    const parentTdp = String(m.parentTdp ?? '')
    if (expiredTdps.has(parentTdp)) {
      const tdpInfo = getTdpByName(parentTdp)
      allMatchingTactics.push({
        name: sig.headline,
        parentTdp,
        tdpUrl: tdpInfo?.cheatsheetUrl || undefined,
        assets: (m.assets as Array<{ name: string; url: string; type: string }>)?.filter(a => a.url && a.url.trim() && !a.url.startsWith('/')) ?? [],
      })
    }
  }

  if (allMatchingTactics.length === 0) return null

  // Extract weighted context keywords from expired product names AND related cases (#543)
  // Signal-derived keywords (from cases) get weight 2.0; product-name keywords get 1.0
  const contextKeywords: (string | WeightedKeyword)[] = []
  for (const sub of expiredSubs) {
    const desc = String(sub.properties.productDescription ?? sub.name ?? '')
    contextKeywords.push(...extractKeywords(desc))
    // Domain-specific expansion for major product families
    if (desc.toLowerCase().includes('ansible')) contextKeywords.push('ansible', 'automate', 'automation', 'ops', 'modernize', 'playbook')
    if (desc.toLowerCase().includes('openshift')) contextKeywords.push('openshift', 'kubernetes', 'k8s', 'container', 'workload')
  }

  // Pull keywords from related cases — case product and headline give signal context
  // Case-derived keywords are weighted higher (2.0) because they reflect actual customer activity
  const cases = findNodesByType(graph, 'case')
  const relatedCases = cases.filter(c => {
    const caseProduct = String(c.properties.product ?? '').toLowerCase()
    return expiredSubs.some(sub => {
      const subName = String(sub.properties.productDescription ?? sub.name ?? '').toLowerCase()
      return (caseProduct.includes('ansible') && subName.includes('ansible')) ||
             (caseProduct.includes('openshift') && subName.includes('openshift'))
    })
  })
  for (const c of relatedCases) {
    // Case headlines describe actual customer problems — weight 2.0
    // (product name keywords already covered by subscription extraction above)
    for (const w of extractKeywords(c.name)) {
      contextKeywords.push({ word: w, weight: 2.0 })
    }
  }

  // Filter to top 3 per TDP domain by relevance to expired products
  let tactics = filterTopTacticsPerTdp(allMatchingTactics, contextKeywords)

  // #591: Rank tactics using full graph intelligence (engagement, intel, lifecycle, etc.)
  const scored = scoreTactics(graph, tactics, portfolioFrequency)
  scored.sort((a, b) => b.compositeScore - a.compositeScore)

  // #577: Cap total tactics per phase
  const MAX_TACTICS_PER_PHASE = 3
  tactics = scored.slice(0, MAX_TACTICS_PER_PHASE)

  // Attach materials to tactics (#576)
  attachMaterials(tactics)

  // Build evidence from expired subs and related cases
  const evidence: MotionPhase['evidence'] = []
  for (const sub of expiredSubs) {
    evidence.push({
      module: 'subscriptions',
      fact: `${sub.name} expired ${sub.properties.endDate ?? 'recently'}`,
      url: sub.properties.url as string | undefined,
    })
  }

  // Add case evidence for products related to expired subs (reuse cases from above)
  for (const c of cases) {
    const caseProduct = String(c.properties.product ?? '')
    const statusLabel = String(c.properties.status ?? '').toLowerCase().includes('closed')
      ? 'Recent case' : 'Open case'
    for (const sub of expiredSubs) {
      const subName = String(sub.properties.productDescription ?? sub.name ?? '')
      if (caseProduct.toLowerCase().includes('ansible') && subName.toLowerCase().includes('ansible')) {
        evidence.push({
          module: 'cases',
          fact: `${statusLabel}: ${c.name}`,
          url: c.properties.url as string | undefined,
        })
        break
      }
      if (caseProduct.toLowerCase().includes('openshift') && subName.toLowerCase().includes('openshift')) {
        evidence.push({
          module: 'cases',
          fact: `${statusLabel}: ${c.name}`,
          url: c.properties.url as string | undefined,
        })
        break
      }
    }
  }

  // Determine urgency: if any expired sub has matching cases → critical
  const hasCritical = expiredSubs.some(sub => {
    const desc = String(sub.properties.productDescription ?? sub.name ?? '').toLowerCase()
    return cases.some(c => {
      const cp = String(c.properties.product ?? '').toLowerCase()
      return (desc.includes('ansible') && cp.includes('ansible')) ||
             (desc.includes('openshift') && cp.includes('openshift'))
    })
  })

  return {
    id: 'phase-1-anchor',
    name: buildPhaseName('Anchor: Protect', tactics),
    category: 'anchor',
    urgency: hasCritical ? 'critical' : 'high',
    tactics,
    targetPersonas: [],
    evidence: capEvidence(evidence),
  }
}

/**
 * Build expand phase from cloud spend and cross-sell opportunities.
 */
function buildExpandPhase(
  graph: CustomerGraph,
  tacticSignals: Signal[],
  anchorTdps: Set<string>,
  portfolioFrequency?: Map<string, number>,
): MotionPhase | null {
  const programs = findNodesByType(graph, 'program')
  const cloudPrograms = programs.filter(p =>
    String(p.properties.programType ?? '') === 'cloud-spend' ||
    String(p.properties.programType ?? '') === 'marketplace'
  )

  if (cloudPrograms.length === 0) return null

  // Find cloud/server related tactics NOT already in anchor
  const allMatchingTactics: MotionPhase['tactics'] = []
  for (const sig of tacticSignals) {
    const m = sig.metadata ?? {}
    const parentTdp = String(m.parentTdp ?? '')
    if (parentTdp.toLowerCase().includes('server') || parentTdp.toLowerCase().includes('cloud')) {
      if (!anchorTdps.has(parentTdp)) {
        const tdpInfo = getTdpByName(parentTdp)
        allMatchingTactics.push({
          name: sig.headline,
          parentTdp,
          tdpUrl: tdpInfo?.cheatsheetUrl || undefined,
          assets: (m.assets as Array<{ name: string; url: string; type: string }>)?.filter(a => a.url && a.url.trim() && !a.url.startsWith('/')) ?? [],
        })
      }
    }
  }

  if (allMatchingTactics.length === 0) return null

  // Context keywords from cloud spend partners + graph nodes (#543)
  const contextKeywords = ['cloud', 'migrate', 'standardize', 'os']
  for (const prog of cloudPrograms) {
    const partner = String(prog.properties.cloudPartner ?? prog.properties.provider ?? '')
    if (partner) contextKeywords.push(partner.toLowerCase())
    contextKeywords.push(...extractKeywords(prog.name))
  }

  // Pull keywords from active subscriptions in this domain
  const subs = findNodesByType(graph, 'subscription')
  const activeSubs = subs.filter(s => String(s.properties.status ?? '').toLowerCase() !== 'expired')
  for (const sub of activeSubs) {
    contextKeywords.push(...extractKeywords(String(sub.properties.productDescription ?? sub.name ?? '')))
  }

  // Filter to top 3 per TDP domain
  let tactics = filterTopTacticsPerTdp(allMatchingTactics, contextKeywords)

  // #591: Rank tactics using full graph intelligence
  const scored = scoreTactics(graph, tactics, portfolioFrequency)
  scored.sort((a, b) => b.compositeScore - a.compositeScore)

  // #577: Cap total tactics per phase
  const MAX_TACTICS_PER_PHASE = 3
  tactics = scored.slice(0, MAX_TACTICS_PER_PHASE)

  // Attach materials to tactics (#576)
  attachMaterials(tactics)

  // Evidence from cloud spend
  const evidence: MotionPhase['evidence'] = []
  for (const prog of cloudPrograms) {
    const partner = String(prog.properties.cloudPartner ?? prog.properties.provider ?? '')
    const acv = prog.properties.acvPlus
    if (acv) {
      evidence.push({
        module: 'ccsp',
        fact: `${partner} cloud spend: $${Number(acv).toLocaleString()} ACV`,
        url: prog.properties.url as string | undefined,
      })
    } else {
      evidence.push({
        module: prog.sourceModule,
        fact: `${prog.name}`,
        url: prog.properties.url as string | undefined,
      })
    }
  }

  // Add active sub evidence (reuse subs/activeSubs from keyword extraction above)
  for (const sub of activeSubs) {
    evidence.push({
      module: 'subscriptions',
      fact: `Active: ${sub.name}`,
      url: sub.properties.url as string | undefined,
    })
  }

  return {
    id: 'phase-2-expand',
    name: buildPhaseName('Expand', tactics),
    category: 'expand',
    urgency: 'high',
    tactics,
    targetPersonas: [],
    evidence: capEvidence(evidence),
  }
}

/**
 * Build transform phase from play nodes and AI/strategic opportunities.
 */
function buildTransformPhase(
  graph: CustomerGraph,
  tacticSignals: Signal[],
  usedTdps: Set<string>,
  portfolioFrequency?: Map<string, number>,
): MotionPhase | null {
  const plays = findNodesByType(graph, 'play')

  // Find tactics not already used in anchor/expand
  const allMatchingTactics: MotionPhase['tactics'] = []
  for (const sig of tacticSignals) {
    const m = sig.metadata ?? {}
    const parentTdp = String(m.parentTdp ?? '')
    if (!usedTdps.has(parentTdp)) {
      const tdpInfo = getTdpByName(parentTdp)
      allMatchingTactics.push({
        name: sig.headline,
        parentTdp,
        tdpUrl: tdpInfo?.cheatsheetUrl || undefined,
        assets: (m.assets as Array<{ name: string; url: string; type: string }>)?.filter(a => a.url && a.url.trim() && !a.url.startsWith('/')) ?? [],
      })
    }
  }

  if (allMatchingTactics.length === 0) return null

  // Context keywords from plays, AI-related tech stack, and graph nodes (#543)
  const contextKeywords: string[] = ['ai', 'ml', 'production', 'inference', 'model']
  for (const play of plays) {
    const alignment = String(play.properties.productAlignment ?? '')
    if (alignment) contextKeywords.push(...extractKeywords(alignment))
  }

  // Pull keywords from tech-stack products (AI tools, frameworks)
  const products = findNodesByType(graph, 'product')
  for (const p of products) {
    const name = String(p.properties.techName ?? p.name ?? '')
    contextKeywords.push(...extractKeywords(name))
  }

  // Filter to top 3 per TDP domain
  let tactics = filterTopTacticsPerTdp(allMatchingTactics, contextKeywords)

  // #591: Rank tactics using full graph intelligence
  const scored = scoreTactics(graph, tactics, portfolioFrequency)
  scored.sort((a, b) => b.compositeScore - a.compositeScore)

  // #577: Cap total tactics per phase
  const MAX_TACTICS_PER_PHASE = 3
  tactics = scored.slice(0, MAX_TACTICS_PER_PHASE)

  // Attach materials to tactics (#576)
  attachMaterials(tactics)

  // Evidence from plays and tech stack
  const evidence: MotionPhase['evidence'] = []
  for (const play of plays) {
    evidence.push({
      module: 'solution-intelligence',
      fact: `Matched play: ${play.name}`,
      url: play.properties.url as string | undefined,
    })
  }

  // Tech stack evidence for AI-related products (reuse products from keyword extraction above)
  for (const p of products) {
    const name = String(p.properties.techName ?? p.name ?? '')
    if (name.toLowerCase().includes('ai') || name.toLowerCase().includes('ml')) {
      evidence.push({
        module: 'tech-stack',
        fact: `Uses ${name}`,
        url: p.properties.url as string | undefined,
      })
    }
  }

  if (evidence.length === 0) return null

  return {
    id: 'phase-3-transform',
    name: buildPhaseName('Transform', tactics),
    category: 'transform',
    urgency: 'medium',
    tactics,
    targetPersonas: [],
    evidence: capEvidence(evidence),
  }
}

/**
 * Attach material links to each tactic based on its parentTdp.
 * Resolves up to 3 materials per tactic from the MaterialIndex (#576).
 */
function attachMaterials(tactics: MotionPhase['tactics']): void {
  for (const tactic of tactics) {
    tactic.materials = resolveMaterials(tactic.parentTdp).slice(0, 3)
  }
}


// ── Displacement Detection (#589) ──────────────────────────────────────────

/**
 * Normalize a tech-stack product name for displacement matching.
 * Lowercases, strips version numbers (e.g. "8.0", "v2.1.3"), and removes
 * common suffixes like "enterprise", "platform", "server", "cloud".
 */
export function normalizeForDisplacement(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bv?\d+(\.\d+)*\b/g, '')       // strip version numbers
    .replace(/\b(enterprise|platform|server|cloud|standard|premium|professional|community|edition)\b/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')            // non-alpha to space
    .replace(/\s+/g, ' ')                      // collapse whitespace
    .trim()
}

/** Map of competitor keywords → Red Hat displacement target + TDP domain */
export const DISPLACEMENT_KEYWORDS: Record<string, { redHat: string; tdp: string }> = {
  // ── VMware family ────────────────────────────────────────────────────────
  'vmware':      { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'vsphere':     { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'esxi':        { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'vcenter':     { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'nsx':         { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'vsan':        { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'tanzu':       { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'broadcom':    { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'workstation': { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'fusion':      { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },

  // ── Splunk family ────────────────────────────────────────────────────────
  'splunk':      { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },

  // ── Datadog family ───────────────────────────────────────────────────────
  'datadog':     { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },
  'dd-agent':    { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },

  // ── Puppet family ────────────────────────────────────────────────────────
  'puppet':       { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'puppetserver': { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'facter':       { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'hiera':        { redHat: 'Ansible Automation Platform', tdp: 'Automation' },

  // ── Chef family ──────────────────────────────────────────────────────────
  'chef':          { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'chef infra':    { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'chef automate': { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'inspec':        { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'habitat':       { redHat: 'Ansible Automation Platform', tdp: 'Automation' },

  // ── Terraform / HashiCorp family ─────────────────────────────────────────
  'terraform':  { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'hashicorp':  { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'vault':      { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'consul':     { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'nomad':      { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'packer':     { redHat: 'Ansible Automation Platform', tdp: 'Automation' },

  // ── Citrix family ────────────────────────────────────────────────────────
  'citrix':     { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'xenserver':  { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'xenapp':     { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'netscaler':  { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },

  // ── Docker family (NOT kubernetes) ───────────────────────────────────────
  'docker':          { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },
  'docker desktop':  { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },
  'docker swarm':    { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },

  // ── Rancher / SUSE ───────────────────────────────────────────────────────
  'rancher':       { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },
  'suse rancher':  { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },
  'harvester':     { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },

  // ── CloudFoundry / Pivotal ───────────────────────────────────────────────
  'cloud foundry':  { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },
  'pivotal':        { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },
  'pcf':            { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },
  'tas':            { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },

  // ── ServiceNow ───────────────────────────────────────────────────────────
  'servicenow':  { redHat: 'Ansible Automation Platform', tdp: 'Automation' },

  // ── IBM family ───────────────────────────────────────────────────────────
  'ibm cloud pak':  { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },
  'websphere':      { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },
  'liberty':        { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },

  // ── Monitoring ───────────────────────────────────────────────────────────
  'nagios':       { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },
  'zabbix':       { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },
  'new relic':    { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },
  'dynatrace':    { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },
  'appdynamics':  { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },

  // ── Legacy virtualization ────────────────────────────────────────────────
  'hyper-v':   { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'hyperv':    { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'proxmox':   { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'nutanix':   { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },

  // ── Config management ────────────────────────────────────────────────────
  'saltstack':  { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'salt':       { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'cfengine':   { redHat: 'Ansible Automation Platform', tdp: 'Automation' },

  // ── Additional VMware variants ───────────────────────────────────────────
  'vrealize':     { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'aria':         { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'horizon':      { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'vsphere ha':   { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },
  'vmotion':      { redHat: 'OpenShift Virtualization', tdp: 'Virtualization' },

  // ── Additional container / PaaS ──────────────────────────────────────────
  'mesos':       { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },
  'marathon':    { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },
  'mesosphere':  { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },
  'docker compose': { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },
  'podman':      { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },
  'containerd':  { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },
  'cri-o':       { redHat: 'OpenShift Container Platform', tdp: 'Container Mgmt' },

  // ── Additional monitoring / observability ────────────────────────────────
  'prometheus':    { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },
  'grafana':       { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },
  'elastic':       { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },
  'elasticsearch': { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },
  'kibana':        { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },
  'logstash':      { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },
  'sumo logic':    { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },
  'icinga':        { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },
  'pagerduty':     { redHat: 'OpenShift Observability', tdp: 'Container Mgmt' },

  // ── Additional automation / IaC ──────────────────────────────────────────
  'ansible tower': { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'awx':           { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'pulumi':        { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
  'crossplane':    { redHat: 'Ansible Automation Platform', tdp: 'Automation' },
}

/**
 * Build displacement phase from non-Red-Hat product nodes in the graph.
 * Matches competitor product names against DISPLACEMENT_KEYWORDS using
 * fuzzy/normalized matching (word boundaries, stripped versions).
 */
function buildDisplacementPhase(
  graph: CustomerGraph,
  tacticSignals: Signal[],
  usedTdps: Set<string>,
  portfolioFrequency?: Map<string, number>,
): MotionPhase | null {
  const products = findNodesByType(graph, 'product')
  const nonRedHatProducts = products.filter(p => {
    const isRedHat = p.properties.isRedHat === true || p.properties.isRedHat === 'true'
    return !isRedHat
  })

  if (nonRedHatProducts.length === 0) return null

  // Find displacement matches using normalized fuzzy matching
  const matches: Array<{ competitor: string; redHat: string; tdp: string; nodeName: string }> = []
  const matchedTdps = new Set<string>()

  // Sort keywords longest-first so multi-word keywords match before single-word
  const sortedKeywords = Object.entries(DISPLACEMENT_KEYWORDS)
    .sort((a, b) => b[0].length - a[0].length)

  for (const product of nonRedHatProducts) {
    const rawName = String(product.properties.techName ?? product.name ?? '')
    const normalized = normalizeForDisplacement(rawName)

    for (const [keyword, mapping] of sortedKeywords) {
      if (usedTdps.has(mapping.tdp) || matchedTdps.has(mapping.tdp)) continue

      const escapedKw = keyword.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
      const wordBoundaryRe = new RegExp(`(^|\\s)${escapedKw}(\\s|$)`)
      if (wordBoundaryRe.test(normalized)) {
        matches.push({
          competitor: rawName,
          redHat: mapping.redHat,
          tdp: mapping.tdp,
          nodeName: product.name,
        })
        matchedTdps.add(mapping.tdp)
      }
    }
  }

  if (matches.length === 0) return null

  // Find tactics for displacement TDPs
  const displacementTdps = new Set(matches.map(m => m.tdp))
  const allMatchingTactics: MotionPhase['tactics'] = []
  for (const sig of tacticSignals) {
    const m = sig.metadata ?? {}
    const parentTdp = String(m.parentTdp ?? '')
    if (displacementTdps.has(parentTdp)) {
      const tdpInfo = getTdpByName(parentTdp)
      allMatchingTactics.push({
        name: sig.headline,
        parentTdp,
        tdpUrl: tdpInfo?.cheatsheetUrl || undefined,
        assets: (m.assets as Array<{ name: string; url: string; type: string }>)?.filter(a => a.url && a.url.trim() && !a.url.startsWith('/')) ?? [],
      })
    }
  }

  // Context keywords from competitor names
  const contextKeywords = matches.flatMap(m => [
    ...extractKeywords(m.competitor),
    ...extractKeywords(m.redHat),
    'migrate', 'displace', 'replace',
  ])

  let tactics = filterTopTacticsPerTdp(allMatchingTactics, contextKeywords)

  // #591: Rank tactics using full graph intelligence
  const scored = scoreTactics(graph, tactics, portfolioFrequency)
  scored.sort((a, b) => b.compositeScore - a.compositeScore)

  const MAX_TACTICS_PER_PHASE = 3
  tactics = scored.slice(0, MAX_TACTICS_PER_PHASE)

  if (tactics.length === 0) return null

  // Attach materials
  attachMaterials(tactics)


  // Build evidence from displacement matches
  const evidence: MotionPhase['evidence'] = matches.map(m => ({
    module: 'tech-stack',
    fact: `Customer uses ${m.competitor} — opportunity to displace with ${m.redHat}`,
  }))

  return {
    id: 'phase-displacement',
    name: buildPhaseName('Displace', tactics),
    category: 'expand',
    urgency: 'high',
    tactics,
    targetPersonas: [],
    evidence: capEvidence(evidence),
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a strategic motion from a customer's intelligence graph.
 *
 * Returns null if the graph has fewer than 2 Play nodes or no meaningful
 * phase groupings can be constructed.
 *
 * @param graph - Customer intelligence graph from buildCustomerGraph()
 * @param customerSlug - Customer slug identifier
 * @param customerName - Human-readable customer name
 * @param playSignals - SalesHub play signals (portfolio-wide)
 * @param tacticSignals - SalesHub tactic signals (portfolio-wide)
 */
export async function buildMotion(
  graph: CustomerGraph,
  customerSlug: string,
  customerName: string,
  playSignals: Signal[],
  tacticSignals: Signal[],
  portfolioFrequency?: Map<string, number>,
): Promise<StrategicMotion | null> {
  // Guard: need at least 1 play node for a meaningful motion (#573)
  const playNodes = findNodesByType(graph, 'play')
  if (playNodes.length < 1) return null

  // Step 1: Extract customer TDP domains from graph
  const customerTdps = extractCustomerTdpDomains(graph)

  // Step 2: Match best-fit SalesHub sales play
  const matchedPlay = matchSalesPlay(customerTdps, playSignals)

  // Step 3: Build phases
  const phases: MotionPhase[] = []

  // Anchor phase — expired subscriptions
  const anchorPhase = buildAnchorPhase(graph, tacticSignals, portfolioFrequency)
  const anchorTdps = new Set<string>()
  if (anchorPhase) {
    phases.push(anchorPhase)
    for (const t of anchorPhase.tactics) {
      anchorTdps.add(t.parentTdp)
    }
  }

  // Expand phase — cloud/cross-sell opportunities
  const expandPhase = buildExpandPhase(graph, tacticSignals, anchorTdps, portfolioFrequency)
  const usedTdps = new Set([...anchorTdps])
  if (expandPhase) {
    phases.push(expandPhase)
    for (const t of expandPhase.tactics) {
      usedTdps.add(t.parentTdp)
    }
  }

  // Transform phase — strategic/AI plays
  const transformPhase = buildTransformPhase(graph, tacticSignals, usedTdps, portfolioFrequency)
  if (transformPhase) {
    phases.push(transformPhase)
    for (const t of transformPhase.tactics) {
      usedTdps.add(t.parentTdp)
    }
  }

  // Displacement phase — competitor displacement opportunities (#579, #589)
  const displacementPhase = buildDisplacementPhase(graph, tacticSignals, usedTdps, portfolioFrequency)
  if (displacementPhase) {
    phases.push(displacementPhase)
  }

  // #595: Phase suppression — if ALL tactics in a phase come from a graph with
  // fewer than 3 distinct signal source types, suppress that phase entirely.
  // Density is per-customer (same for all tactics), so compute once from graph.
  const graphNodeTypes = new Set(
    Object.values(graph.nodes).map(n => n.type).filter(t => t !== 'customer')
  )
  if (graphNodeTypes.size < 3) {
    // Suppress all phases — graph too sparse for meaningful recommendations
    phases.length = 0
  }

  // Guard: need at least 1 phase
  if (phases.length === 0) return null

  // Step 4: Assign personas per phase from TDP domains (#540)
  // Each phase derives personas from the TDP domains its tactics cover,
  // falling back to the play-level personas only if no TDP match is found.
  const fallbackPersonas = matchedPlay?.personaRoles ?? []
  for (const phase of phases) {
    phase.targetPersonas = derivePhasePersonas(phase.tactics, fallbackPersonas)
  }

  // Step 5: Generate title
  const title = matchedPlay
    ? `${matchedPlay.playName} for ${customerName}`
    : `${[...customerTdps].slice(0, 3).join(' + ')} for ${customerName}`

  // Step 6: Compute confidence from signal convergence
  const totalSignals = Object.keys(graph.nodes).length - 1 // exclude customer node
  const confidence: StrategicMotion['confidence'] =
    totalSignals >= 8 ? 'high' : totalSignals >= 4 ? 'medium' : 'low'

  // Step 7: Compute total estimated TCV from pipeline deals
  const deals = findNodesByType(graph, 'deal')
  const totalTcv = deals.reduce((sum, d) => sum + (Number(d.properties.amount) || 0), 0)

  // Step 8: Generate Gemini briefs for each phase (parallel, non-blocking)
  await generatePhaseBriefs(phases, customerName)

  // Step 9: Gemini tactic inference (#599) — augmentation, not replacement
  let geminiInsights: GeminiRecommendation[] | undefined
  if (process.env.GEMINI_TACTIC_INFERENCE === 'true') {
    try {
      const { summarizeGraph } = await import('./graph-summary.ts')
      const { recommendTactics } = await import('./gemini-tactic-recommender.ts')
      const graphText = summarizeGraph(graph)
      const availableTactics = tacticSignals.map(s => ({
        name: s.headline,
        parentTdp: String(s.metadata?.parentTdp ?? ''),
      }))
      const insights = await recommendTactics(graphText, availableTactics, customerName)
      // Filter out tactics already in deterministic phases
      const existingTacticNames = new Set(phases.flatMap(p => p.tactics.map(t => t.name)))
      geminiInsights = insights.filter(i => !existingTacticNames.has(i.tacticName))
      if (geminiInsights.length === 0) geminiInsights = undefined
    } catch (e: any) {
      console.warn('[motion-builder] Gemini tactic inference failed:', e?.message)
    }
  }

  // Step 10: Enhanced Gemini inference (#613, #617) — deeper graph-aware recommendations
  let enhancedRecommendations: MergedRecommendation[] | undefined
  {
    try {
      const { summarizeGraph } = await import('./graph-summary.ts')
      const { buildFullGraphContext } = await import('./graph-context.ts')
      const { enhancedRecommendTactics, mergeRecommendations } = await import('./gemini-tactic-recommender.ts')

      const graphText = summarizeGraph(graph)
      const fullGraphContext = buildFullGraphContext(graph)
      const availableTactics = tacticSignals.map(s => ({
        name: s.headline,
        parentTdp: String(s.metadata?.parentTdp ?? ''),
      }))

      // Get deterministic top 5 tactic names from phases
      const deterministicTop = phases
        .flatMap(p => p.tactics.map(t => t.name))
        .slice(0, 5)

      const enhanced = await enhancedRecommendTactics(
        graphText,
        fullGraphContext,
        availableTactics,
        deterministicTop,
        customerName,
      )

      // Merge deterministic + novel
      const deterministicScored = phases
        .flatMap(p => p.tactics)
        .map((t, i) => ({
          name: t.name,
          parentTdp: t.parentTdp,
          compositeScore: 1.0 - (i * 0.1), // Preserve phase ordering
        }))
        .slice(0, 5)

      const merged = mergeRecommendations(deterministicScored, enhanced)
      if (merged.some(m => m.isNovel)) {
        enhancedRecommendations = merged
      }
    } catch (e: any) {
      console.warn('[motion-builder] Enhanced Gemini inference failed:', e?.message)
    }
  }

  return {
    id: `motion:${customerSlug}`,
    customerSlug,
    customerName,
    title,
    salesPlay: matchedPlay?.playName,
    phases,
    confidence,
    totalEstimatedTcv: totalTcv || undefined,
    generatedAt: new Date().toISOString(),
    status: 'active',
    geminiInsights,
    enhancedRecommendations,
  }
}

// ── Gemini Phase Briefs (#527) ──────────────────────────────────────────────

async function generatePhaseBrief(
  phase: MotionPhase,
  customerName: string,
): Promise<string | undefined> {
  try {
    const evidenceLines = phase.evidence.map(e => `- ${e.fact}`).join('\n')
    const tacticNames = phase.tactics.map(t => t.name).join(', ')
    const tdpDomains = [...new Set(phase.tactics.map(t => t.parentTdp))].join(', ')

    const systemPrompt = 'You write concise strategic account briefs for enterprise sales. Focus on business impact. Be specific to the customer situation. No generic product descriptions.'
    const userPrompt = `Write a 3-5 sentence brief explaining why this phase matters for ${customerName}.

Phase: ${phase.name}
Tactics: ${tacticNames}
TDP Domains: ${tdpDomains}
Evidence:
${evidenceLines}

Focus on business impact. Be specific to this customer's situation. No generic product descriptions.`

    const result = await callGemini(systemPrompt, userPrompt, {
      callType: 'motion-phase-brief',
      customerName,
    })
    return result.text || undefined
  } catch {
    return undefined
  }
}

async function generatePhaseBriefs(phases: MotionPhase[], customerName: string): Promise<void> {
  await Promise.all(phases.map(async (phase) => {
    phase.brief = await generatePhaseBrief(phase, customerName)
  }))
}
