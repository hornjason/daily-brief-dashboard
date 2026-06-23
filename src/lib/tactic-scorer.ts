/**
 * src/lib/tactic-scorer.ts
 * Deep module for scoring candidate tactics against the full intelligence graph.
 *
 * GitHub Issue #591 — TacticScorer: rank tactics using all 9+ node types
 *
 * Replaces inline tactic relevance scoring in motion-builder.ts.
 * Traverses engagement, intel, lifecycle, event, evidence, and partner nodes
 * (in addition to existing subscription/case/program/play base scoring)
 * to compute a composite score with an evidence trail.
 *
 * Dependencies:
 *   - intelligence-graph-types.ts — CustomerGraph, IntelligenceNode
 *   - graph-utils.ts — findNodesByType, recencyWeight
 */

import type {
  CustomerGraph,
  IntelligenceNode,
} from './intelligence-graph-types.ts'
import { findActiveNodesByType, recencyWeight } from './graph-utils.ts'
import type { MaterialLink } from './material-index.ts'
import type { TacticOutcome } from './deal-outcome-history.ts'
import { getTdpKeywords } from './tdp-domains.ts'

/** Node types that TacticScorer traverses for scoring (#594 ADR-033 gate) */
/** Node types that TacticScorer traverses for scoring (#594 ADR-033 gate) */
export const TACTIC_SCORER_HANDLED_TYPES = [
  'customer', 'subscription', 'case', 'deal', 'play', 'program', 'product',
  'engagement', 'intel', 'lifecycle', 'event', 'evidence', 'partner',
] as const

// ── Types ────────────────────────────────────────────────────────────────────

export interface EvidenceItem {
  fact: string
  module: string
  recency: string  // "2h ago", "3d ago", "30d+ ago"
  weight: number
}

export interface SignalDensity {
  populated: number
  total: number
}

/** Total distinct signal source types in the intelligence graph */
export const TOTAL_SIGNAL_TYPES = 12

/** Weight applied to portfolio frequency for diversity penalty (#618).
 *  diversityFactor = 1 - (frequency * DIVERSITY_WEIGHT)
 *  At 0.5: a tactic in 90% of portfolios gets a 45% penalty. */
export const DIVERSITY_WEIGHT = 0.5

export interface ScoredTactic {
  name: string
  parentTdp: string
  tdpUrl?: string
  assets: Array<{ name: string; url: string; type: string }>
  materials?: MaterialLink[]
  compositeScore: number
  evidenceTrail: EvidenceItem[]
  signalDensity: SignalDensity
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format an ISO timestamp into a human-readable recency string.
 */
export function formatRecency(isoTimestamp: string): string {
  const ageMs = Date.now() - new Date(isoTimestamp).getTime()
  const hours = ageMs / (1000 * 60 * 60)
  if (hours < 24) return `${Math.round(hours)}h ago`
  const days = Math.round(hours / 24)
  if (days <= 30) return `${days}d ago`
  return '30d+ ago'
}

/**
 * TDP-domain keyword sets for matching node content to tactic domains.
 * Sourced from tdp-domains.ts (single source of truth — #882).
 */
const TDP_KEYWORDS = getTdpKeywords()

/**
 * Check if a node's content (name + properties) matches a given TDP domain.
 */
export function nodeMatchesTdp(node: IntelligenceNode, tdp: string): boolean {
  const keywords = TDP_KEYWORDS[tdp]
  if (!keywords) return false

  // Build searchable text from node name + key properties
  const searchText = [
    node.name,
    String(node.properties.product ?? ''),
    String(node.properties.domain ?? ''),
    String(node.properties.productDescription ?? ''),
    String(node.properties.productAlignment ?? ''),
    String(node.properties.summary ?? ''),
    String(node.properties.competitor ?? ''),
    String(node.properties.techName ?? ''),
    ...(Array.isArray(node.properties.topics) ? node.properties.topics.map(String) : []),
  ].join(' ').toLowerCase()

  return keywords.some(kw => searchText.includes(kw))
}

/**
 * Extract base-score keywords from subscription, case, and play nodes.
 * Uses TDP_KEYWORDS as single source of truth — adding a new TDP domain
 * requires only one dict entry, not duplicate if/else chains (#604).
 */
function extractBaseKeywords(graph: CustomerGraph): Map<string, string[]> {
  const tdpKeywords = new Map<string, string[]>()

  const candidateNodes = [
    ...findActiveNodesByType(graph, 'subscription'),
    ...findActiveNodesByType(graph, 'case'),
    ...findActiveNodesByType(graph, 'play'),
  ]

  for (const node of candidateNodes) {
    for (const [tdp, keywords] of Object.entries(TDP_KEYWORDS)) {
      if (nodeMatchesTdp(node, tdp)) {
        const existing = tdpKeywords.get(tdp) ?? []
        existing.push(...keywords.slice(0, 3))
        tdpKeywords.set(tdp, existing)
      }
    }
  }

  return tdpKeywords
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Compute base score (0-1) from how many keyword signals match the tactic's TDP.
 */
function computeBaseScore(tdp: string, baseKeywords: Map<string, string[]>): number {
  const keywords = baseKeywords.get(tdp) ?? []
  if (keywords.length === 0) return 0
  // Normalize: more keyword matches = higher score, capped at 1.0
  return Math.min(keywords.length * 0.15, 1.0)
}

/**
 * Compute recency boost (0-0.5) from engagement nodes mentioning the tactic's TDP products.
 */
function computeRecencyBoost(
  graph: CustomerGraph,
  tdp: string,
  allEvidence: EvidenceItem[],
): number {
  const engagements = findActiveNodesByType(graph, 'engagement')
  let maxBoost = 0

  for (const eng of engagements) {
    if (!nodeMatchesTdp(eng, tdp)) continue

    // Find edges connected to this engagement for createdAt
    const engEdges = graph.edges.filter(e => e.from === eng.id || e.to === eng.id)
    for (const edge of engEdges) {
      const weight = recencyWeight(edge.createdAt, 30)
      const boost = weight * 0.5 // Scale to max 0.5
      if (boost > maxBoost) maxBoost = boost

      allEvidence.push({
        fact: `Recent engagement: ${eng.name}`,
        module: 'engagement',
        recency: formatRecency(edge.createdAt),
        weight: boost,
      })
    }
  }

  return maxBoost
}

/**
 * Compute urgency boost (0-0.5) from lifecycle nodes with upcoming EOL.
 */
function computeUrgencyBoost(
  graph: CustomerGraph,
  tdp: string,
  allEvidence: EvidenceItem[],
): number {
  const lifecycles = findActiveNodesByType(graph, 'lifecycle')
  let maxBoost = 0

  for (const lc of lifecycles) {
    if (!nodeMatchesTdp(lc, tdp)) continue

    const eolDate = lc.properties.eolDate as string | undefined
    if (!eolDate) continue

    const eolMs = new Date(eolDate).getTime() - Date.now()
    const eolMonths = eolMs / (1000 * 60 * 60 * 24 * 30)

    if (eolMonths <= 6 && eolMonths > 0) {
      // Closer to EOL = higher boost. 0 months = 0.5, 6 months = ~0.1
      const boost = 0.5 * (1 - eolMonths / 6)
      if (boost > maxBoost) maxBoost = boost

      const edgesForNode = graph.edges.filter(e => e.from === lc.id || e.to === lc.id)
      const edgeDate = edgesForNode[0]?.createdAt ?? new Date().toISOString()

      allEvidence.push({
        fact: `${lc.name} — EOL in ${Math.round(eolMonths)} months`,
        module: 'lifecycle',
        recency: formatRecency(edgeDate),
        weight: boost,
      })
    }
  }

  return maxBoost
}

/**
 * Compute competitive boost (0-0.5) from intel nodes with intelType: 'competitive'.
 */
function computeCompetitiveBoost(
  graph: CustomerGraph,
  tdp: string,
  allEvidence: EvidenceItem[],
): number {
  const intels = findActiveNodesByType(graph, 'intel')
  let totalBoost = 0

  for (const intel of intels) {
    const intelType = String(intel.properties.intelType ?? '')
    if (intelType !== 'competitive') continue
    if (!nodeMatchesTdp(intel, tdp)) continue

    const boost = 0.25 // Each competitive intel signal adds 0.25
    totalBoost += boost

    const edgesForNode = graph.edges.filter(e => e.from === intel.id || e.to === intel.id)
    const edgeDate = edgesForNode[0]?.createdAt ?? new Date().toISOString()

    allEvidence.push({
      fact: `Competitive intel: ${intel.name}`,
      module: 'intel',
      recency: formatRecency(edgeDate),
      weight: boost,
    })
  }

  return Math.min(totalBoost, 0.5)
}

/**
 * Compute evidence boost (0-0.3) from evidence, intel (non-competitive), and event nodes.
 */
function computeEvidenceBoost(
  graph: CustomerGraph,
  tdp: string,
  allEvidence: EvidenceItem[],
): number {
  let count = 0

  // Evidence nodes
  const evidenceNodes = findActiveNodesByType(graph, 'evidence')
  for (const ev of evidenceNodes) {
    if (!nodeMatchesTdp(ev, tdp)) continue
    count++

    const edgesForNode = graph.edges.filter(e => e.from === ev.id || e.to === ev.id)
    const edgeDate = edgesForNode[0]?.createdAt ?? new Date().toISOString()

    allEvidence.push({
      fact: `Evidence: ${ev.name}`,
      module: 'evidence',
      recency: formatRecency(edgeDate),
      weight: 0.1,
    })
  }

  // Intel nodes (non-competitive — general intel corroborates domain)
  const intels = findActiveNodesByType(graph, 'intel')
  for (const intel of intels) {
    if (String(intel.properties.intelType ?? '') === 'competitive') continue
    if (!nodeMatchesTdp(intel, tdp)) continue
    count++

    const edgesForNode = graph.edges.filter(e => e.from === intel.id || e.to === intel.id)
    const edgeDate = edgesForNode[0]?.createdAt ?? new Date().toISOString()

    allEvidence.push({
      fact: `Intel: ${intel.name}`,
      module: 'intel',
      recency: formatRecency(edgeDate),
      weight: 0.1,
    })
  }

  // Event nodes
  const events = findActiveNodesByType(graph, 'event')
  for (const ev of events) {
    if (!nodeMatchesTdp(ev, tdp)) continue
    count++

    const edgesForNode = graph.edges.filter(e => e.from === ev.id || e.to === ev.id)
    const edgeDate = edgesForNode[0]?.createdAt ?? new Date().toISOString()

    allEvidence.push({
      fact: `Event: ${ev.name}`,
      module: 'event',
      recency: formatRecency(edgeDate),
      weight: 0.1,
    })
  }

  // Deal nodes — active pipeline corroborates domain urgency
  const deals = findActiveNodesByType(graph, 'deal')
  for (const deal of deals) {
    if (!nodeMatchesTdp(deal, tdp)) continue
    count++

    const edgesForNode = graph.edges.filter(e => e.from === deal.id || e.to === deal.id)
    const edgeDate = edgesForNode[0]?.createdAt ?? new Date().toISOString()

    allEvidence.push({
      fact: `Pipeline: ${deal.name}`,
      module: 'pipeline',
      recency: formatRecency(edgeDate),
      weight: 0.15,
    })
  }

  // Each corroborating signal adds 0.1, capped at 0.3
  return Math.min(count * 0.1, 0.3)
}

/**
 * Compute partner boost (0-0.2) from partner nodes aligned with tactic domain.
 */
function computePartnerBoost(
  graph: CustomerGraph,
  tdp: string,
  allEvidence: EvidenceItem[],
): number {
  const partners = findActiveNodesByType(graph, 'partner')
  let totalBoost = 0

  for (const partner of partners) {
    if (!nodeMatchesTdp(partner, tdp)) continue

    const boost = 0.1
    totalBoost += boost

    const edgesForNode = graph.edges.filter(e => e.from === partner.id || e.to === partner.id)
    const edgeDate = edgesForNode[0]?.createdAt ?? new Date().toISOString()

    allEvidence.push({
      fact: `Partner: ${partner.name}`,
      module: 'partner',
      recency: formatRecency(edgeDate),
      weight: boost,
    })
  }

  return Math.min(totalBoost, 0.2)
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Score candidate tactics against the full intelligence graph.
 *
 * Traverses all 9+ node types to compute a composite score:
 *   - Base (0-1): keyword matching from subscriptions, cases, plays, programs
 *   - Recency (0-0.5): engagement signals with exponential decay
 *   - Urgency (0-0.5): lifecycle EOL proximity
 *   - Competitive (0-0.5): competitive intel pressure
 *   - Evidence (0-0.3): corroborating evidence, events, general intel
 *   - Partner (0-0.2): partner alignment
 *
 * Each scored tactic includes an evidenceTrail of top 5 items sorted by weight.
 *
 * Optional portfolioFrequency (#618): Map of tactic name → frequency (0.0-1.0)
 * across the portfolio. When provided, applies a diversity penalty:
 *   diversityFactor = 1 - (frequency * DIVERSITY_WEIGHT)
 *   finalScore = compositeScore * diversityFactor
 * A tactic in 90% of customers' top-5 gets a 45% penalty; one in 20% gets 10%.
 *
 * Optional teamContext (#621): Account team specialists — boosts tactics
 * matching a specialist's product domain by +0.1.
 *
 * Optional outcomeHistory (#622): Past deal outcomes attributed to tactics.
 * Boosts tactics that correlated with won deals:
 *   - Any customer in last 12 months: +0.15
 *   - Similar customer (via similarCustomerSlugs): +0.25 instead
 * Capped at one outcome boost per tactic (uses highest match).
 */
export function scoreTactics(
  graph: CustomerGraph,
  candidateTactics: Array<{
    name: string
    parentTdp: string
    tdpUrl?: string
    assets: Array<{ name: string; url: string; type: string }>
    materials?: MaterialLink[]
  }>,
  portfolioFrequency?: Map<string, number>,
  teamContext?: Array<{ name: string; role: string; products: string[] }>,
  outcomeHistory?: TacticOutcome[],
  similarCustomerSlugs?: Set<string>,
): ScoredTactic[] {
  const baseKeywords = extractBaseKeywords(graph)

  // Compute signal density once per call — only count active nodes (#601)
  const nodeTypes = new Set(
    Object.values(graph.nodes)
      .filter(n => n.history?.status !== 'historical')
      .map(n => n.type)
      .filter(t => t !== 'customer')
  )
  const density: SignalDensity = { populated: nodeTypes.size, total: TOTAL_SIGNAL_TYPES }

  return candidateTactics.map(tactic => {
    const allEvidence: EvidenceItem[] = []

    // 1. Base score from existing signal types
    const baseScore = computeBaseScore(tactic.parentTdp, baseKeywords)

    // 2. Recency boost from engagement nodes
    const recencyBoost = computeRecencyBoost(graph, tactic.parentTdp, allEvidence)

    // 3. Urgency boost from lifecycle nodes
    const urgencyBoost = computeUrgencyBoost(graph, tactic.parentTdp, allEvidence)

    // 4. Competitive boost from intel nodes
    const competitiveBoost = computeCompetitiveBoost(graph, tactic.parentTdp, allEvidence)

    // 5. Evidence boost from evidence, intel (non-competitive), event nodes
    const evidenceBoost = computeEvidenceBoost(graph, tactic.parentTdp, allEvidence)

    // 6. Partner boost from partner nodes
    const partnerBoost = computePartnerBoost(graph, tactic.parentTdp, allEvidence)

    let compositeScore = baseScore + recencyBoost + urgencyBoost + competitiveBoost + evidenceBoost + partnerBoost

    // 7. Diversity penalty (#618) — penalize tactics that appear universally across portfolios
    if (portfolioFrequency) {
      const frequency = portfolioFrequency.get(tactic.name) ?? 0
      if (frequency > 0) {
        const diversityFactor = 1 - (frequency * DIVERSITY_WEIGHT)
        const penaltyPct = Math.round(frequency * DIVERSITY_WEIGHT * 100)
        const freqPct = Math.round(frequency * 100)

        allEvidence.push({
          fact: `Diversity penalty: -${penaltyPct}% (appears in ${freqPct}% of portfolios)`,
          module: 'diversity',
          recency: '',
          weight: -(compositeScore * (1 - diversityFactor)), // negative to show it's a penalty
        })

        compositeScore = compositeScore * diversityFactor
      }
    }

    // 8. Team alignment boost (#621) — specialist covering this tactic's domain
    if (teamContext && teamContext.length > 0) {
      let teamBoosted = false
      for (const member of teamContext) {
        if (teamBoosted) break
        for (const product of member.products) {
          const productLower = product.toLowerCase()
          const tdpLower = tactic.parentTdp.toLowerCase()
          const nameLower = tactic.name.toLowerCase()
          if (tdpLower.includes(productLower) || nameLower.includes(productLower) ||
              productLower.includes(tdpLower) || productLower.includes(nameLower)) {
            compositeScore += 0.1
            allEvidence.push({
              fact: `Team alignment: ${member.name} (${member.role}) covers ${product}`,
              module: 'team',
              recency: '',
              weight: 0.1,
            })
            teamBoosted = true
            break
          }
          // Also check via TDP_KEYWORDS
          const keywords = TDP_KEYWORDS[tactic.parentTdp]
          if (keywords && keywords.some(kw => productLower.includes(kw))) {
            compositeScore += 0.1
            allEvidence.push({
              fact: `Team alignment: ${member.name} (${member.role}) covers ${product}`,
              module: 'team',
              recency: '',
              weight: 0.1,
            })
            teamBoosted = true
            break
          }
        }
      }
    }

    // 9. Deal outcome boost (#622) — tactics that correlated with won deals
    if (outcomeHistory && outcomeHistory.length > 0) {
      const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000
      const now = Date.now()
      let bestBoost = 0
      let bestOutcome: TacticOutcome | null = null
      let isSimilarMatch = false

      for (const outcome of outcomeHistory) {
        if (outcome.tacticName !== tactic.name) continue

        const closedMs = new Date(outcome.closedAt).getTime()
        if (now - closedMs > TWELVE_MONTHS_MS) continue

        const isSimilar = similarCustomerSlugs?.has(outcome.customerSlug) ?? false
        const boost = isSimilar ? 0.25 : 0.15

        if (boost > bestBoost) {
          bestBoost = boost
          bestOutcome = outcome
          isSimilarMatch = isSimilar
        }
      }

      if (bestBoost > 0 && bestOutcome) {
        compositeScore += bestBoost
        const prefix = isSimilarMatch ? 'Similar customer outcome' : 'Proven outcome'
        allEvidence.push({
          fact: `${prefix}: ${bestOutcome.customerName} closed $${bestOutcome.dealAmount.toLocaleString()} deal using this tactic`,
          module: 'outcome',
          recency: '',
          weight: bestBoost,
        })
      }
    }

    // Cap evidence trail at top 5 sorted by weight descending
    const evidenceTrail = allEvidence
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5)

    // When signal sources are sparse, prefix evidence trail with a note
    if (density.populated < 4) {
      evidenceTrail.unshift({
        fact: `Limited data: only ${density.populated} of ${density.total} signal sources available`,
        module: 'density',
        recency: '',
        weight: 0,
      })
    }

    return {
      name: tactic.name,
      parentTdp: tactic.parentTdp,
      tdpUrl: tactic.tdpUrl,
      assets: tactic.assets,
      materials: tactic.materials,
      compositeScore,
      evidenceTrail,
      signalDensity: density,
    }
  })
}

// ── Portfolio Frequency (#618) ──────────────────────────────────────────────

/**
 * Compute how frequently each tactic appears in the top-N across all customers.
 *
 * Pre-scores all customers WITHOUT diversity penalty, counts how often each
 * tactic lands in a customer's top-N, and returns a frequency map (0.0-1.0).
 *
 * The caller (expansion-motion-service or graph-routes) is responsible for
 * loading all customer graphs and passing them here. This function is pure
 * computation — no I/O.
 */
export function computePortfolioFrequency(
  allCustomerGraphs: Map<string, CustomerGraph>,
  allTactics: Array<{
    name: string
    parentTdp: string
    tdpUrl?: string
    assets: Array<{ name: string; url: string; type: string }>
    materials?: MaterialLink[]
  }>,
  topN: number = 5,
): Map<string, number> {
  const totalCustomers = allCustomerGraphs.size
  if (totalCustomers === 0) return new Map()

  // Count how many customers have each tactic in their top-N
  const tacticCounts = new Map<string, number>()

  for (const [, graph] of allCustomerGraphs) {
    // Score without diversity penalty
    const scored = scoreTactics(graph, allTactics)
    const sorted = [...scored].sort((a, b) => b.compositeScore - a.compositeScore)
    const topTactics = sorted.slice(0, topN)

    for (const tactic of topTactics) {
      if (tactic.compositeScore > 0) {
        tacticCounts.set(tactic.name, (tacticCounts.get(tactic.name) ?? 0) + 1)
      }
    }
  }

  // Convert counts to frequencies (0.0-1.0)
  const frequencies = new Map<string, number>()
  for (const [name, count] of tacticCounts) {
    frequencies.set(name, count / totalCustomers)
  }

  return frequencies
}
