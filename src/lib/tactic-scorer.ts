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
import { findNodesByType, recencyWeight } from './graph-utils.ts'
import type { MaterialLink } from './material-index.ts'

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
 * Used to determine which boosts apply to which tactics.
 */
const TDP_KEYWORDS: Record<string, string[]> = {
  'Automation': ['ansible', 'automation', 'automate', 'playbook', 'ops', 'aap', 'puppet', 'chef', 'terraform'],
  'Container Mgmt': ['openshift', 'container', 'kubernetes', 'k8s', 'docker', 'ocp', 'pod', 'helm'],
  'Container Management': ['openshift', 'container', 'kubernetes', 'k8s', 'docker', 'ocp', 'pod', 'helm'],
  'Server and Cloud Computing': ['rhel', 'linux', 'server', 'cloud', 'migrate', 'os', 'standardize'],
  'AI': ['ai', 'ml', 'inference', 'model', 'rhoai', 'openshift ai', 'data science', 'gpu'],
  'AI Platform': ['ai', 'ml', 'inference', 'model', 'rhoai', 'openshift ai', 'data science', 'gpu'],
  'Virtualization': ['virtualization', 'virt', 'vmware', 'vsphere', 'vm', 'migrate', 'hypervisor'],
  'Management': ['satellite', 'management', 'insights', 'patch', 'compliance'],
  'Security': ['security', 'compliance', 'acs', 'stackrox', 'ciso'],
  'App Platform': ['app', 'application', 'developer', 'devops', 'cicd', 'pipeline'],
  'Application Development': ['app', 'application', 'developer', 'devops', 'cicd', 'pipeline'],
}

/**
 * Check if a node's content (name + properties) matches a given TDP domain.
 */
function nodeMatchesTdp(node: IntelligenceNode, tdp: string): boolean {
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
 * Extract base-score keywords from subscription, case, program, and play nodes.
 * Reuses the same keyword extraction logic as motion-builder.ts scoreTacticRelevance.
 */
function extractBaseKeywords(graph: CustomerGraph): Map<string, string[]> {
  const tdpKeywords = new Map<string, string[]>()

  // Subscriptions → TDP keywords
  const subs = findNodesByType(graph, 'subscription')
  for (const sub of subs) {
    const desc = String(sub.properties.productDescription ?? sub.name ?? '').toLowerCase()
    if (desc.includes('ansible') || desc.includes('automation')) {
      const existing = tdpKeywords.get('Automation') ?? []
      existing.push('ansible', 'automation', 'automate')
      tdpKeywords.set('Automation', existing)
    }
    if (desc.includes('openshift') || desc.includes('container')) {
      const existing = tdpKeywords.get('Container Mgmt') ?? []
      existing.push('openshift', 'container', 'kubernetes')
      tdpKeywords.set('Container Mgmt', existing)
      const existing2 = tdpKeywords.get('Container Management') ?? []
      existing2.push('openshift', 'container', 'kubernetes')
      tdpKeywords.set('Container Management', existing2)
    }
    if (desc.includes('rhel') || desc.includes('enterprise linux') || desc.includes('server')) {
      const existing = tdpKeywords.get('Server and Cloud Computing') ?? []
      existing.push('rhel', 'linux', 'server')
      tdpKeywords.set('Server and Cloud Computing', existing)
    }
    if (desc.includes('virtualization') || desc.includes('virt')) {
      const existing = tdpKeywords.get('Virtualization') ?? []
      existing.push('virtualization', 'virt')
      tdpKeywords.set('Virtualization', existing)
    }
    if (desc.includes('satellite')) {
      const existing = tdpKeywords.get('Management') ?? []
      existing.push('satellite', 'management')
      tdpKeywords.set('Management', existing)
    }
    if (desc.includes('ai') || desc.includes('rhoai')) {
      const existing = tdpKeywords.get('AI') ?? []
      existing.push('ai', 'ml')
      tdpKeywords.set('AI', existing)
      const existing2 = tdpKeywords.get('AI Platform') ?? []
      existing2.push('ai', 'ml')
      tdpKeywords.set('AI Platform', existing2)
    }
  }

  // Cases → keywords for their product domain
  const cases = findNodesByType(graph, 'case')
  for (const c of cases) {
    const product = String(c.properties.product ?? '').toLowerCase()
    if (product.includes('ansible')) {
      const existing = tdpKeywords.get('Automation') ?? []
      existing.push('ansible')
      tdpKeywords.set('Automation', existing)
    }
    if (product.includes('openshift')) {
      const existing = tdpKeywords.get('Container Mgmt') ?? []
      existing.push('openshift')
      tdpKeywords.set('Container Mgmt', existing)
      const existing2 = tdpKeywords.get('Container Management') ?? []
      existing2.push('openshift')
      tdpKeywords.set('Container Management', existing2)
    }
  }

  // Play nodes → keyword from productAlignment
  const plays = findNodesByType(graph, 'play')
  for (const play of plays) {
    const alignment = String(play.properties.productAlignment ?? '').toLowerCase()
    if (alignment.includes('ansible') || alignment.includes('automation')) {
      const existing = tdpKeywords.get('Automation') ?? []
      existing.push('automation')
      tdpKeywords.set('Automation', existing)
    }
    if (alignment.includes('openshift') || alignment.includes('container')) {
      const existing = tdpKeywords.get('Container Mgmt') ?? []
      existing.push('openshift', 'container')
      tdpKeywords.set('Container Mgmt', existing)
    }
    if (alignment.includes('ai')) {
      const existing = tdpKeywords.get('AI') ?? []
      existing.push('ai')
      tdpKeywords.set('AI', existing)
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
  const engagements = findNodesByType(graph, 'engagement')
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
  const lifecycles = findNodesByType(graph, 'lifecycle')
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
  const intels = findNodesByType(graph, 'intel')
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
  const evidenceNodes = findNodesByType(graph, 'evidence')
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
  const intels = findNodesByType(graph, 'intel')
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
  const events = findNodesByType(graph, 'event')
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
  const deals = findNodesByType(graph, 'deal')
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
  const partners = findNodesByType(graph, 'partner')
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
): ScoredTactic[] {
  const baseKeywords = extractBaseKeywords(graph)

  // Compute signal density once per call — same for all tactics in this customer's graph
  const nodeTypes = new Set(
    Object.values(graph.nodes).map(n => n.type).filter(t => t !== 'customer')
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

    const compositeScore = baseScore + recencyBoost + urgencyBoost + competitiveBoost + evidenceBoost + partnerBoost

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
