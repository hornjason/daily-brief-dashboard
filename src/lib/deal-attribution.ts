/**
 * src/lib/deal-attribution.ts
 * Deal outcome tracking — correlates intelligence activity with deal progression.
 *
 * GitHub Issue #614 — Did intelligence influence the opportunity?
 *
 * Pure domain logic: reads persisted intelligence graph + debriefs,
 * correlates deals with prior intelligence activity (meeting preps,
 * motions, graph density), and assigns an attribution score.
 *
 * No framework imports. No side effects. Independently testable.
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import type { CustomerGraph, MotionHistoryEntry } from './intelligence-graph-types.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface DealAttribution {
  /** Node ID from the intelligence graph (e.g. "deal:big-renewal") */
  dealId: string
  /** Human-readable deal name */
  dealName: string
  /** Pipeline stage (Commit, Best Case, Pipeline, etc.) */
  stage: string
  /** Deal value in USD */
  amount: number
  /** Customer slug this deal belongs to */
  customerSlug: string
  /** Intelligence activity that preceded this deal */
  priorIntelligence: {
    /** Number of meeting prep debriefs captured for this customer */
    meetingPrepsGenerated: number
    /** Motion titles recommended by the intelligence system */
    tacticsRecommended: string[]
    /** ISO timestamp of earliest motion generation (if any) */
    motionGeneratedAt?: string
    /** Graph density (nodes + edges) at time of computation */
    graphDensityAtTime: number
  }
  /** Attribution strength: strong/moderate/weak/none */
  attributionScore: 'strong' | 'moderate' | 'weak' | 'none'
}

// ── Core function ────────────────────────────────────────────────────────────

/**
 * Compute deal attribution for a customer by correlating intelligence
 * activity with deal nodes in the graph.
 *
 * @param customerSlug - Customer identifier
 * @param dataDir - Base data directory (contains {slug}/intelligence-graph.json and debriefs/{slug}/)
 * @returns Array of DealAttribution objects, one per deal node in the graph
 */
export function computeDealAttribution(
  customerSlug: string,
  dataDir: string,
): DealAttribution[] {
  // Step 1: Load the customer's intelligence graph
  const graph = loadGraphSafe(customerSlug, dataDir)
  if (!graph) return []

  // Step 2: Extract deal nodes from the graph
  const dealNodes = Object.values(graph.nodes).filter(n => n.type === 'deal')
  if (dealNodes.length === 0) return []

  // Step 3: Count meeting prep debriefs
  const debriefCount = countDebriefs(customerSlug, dataDir)

  // Step 4: Extract motion history
  const motionHistory = graph.history ?? []
  const tacticsRecommended = motionHistory.map(m => m.title)
  const motionGeneratedAt = getEarliestMotionDate(motionHistory)

  // Step 5: Compute graph density
  const graphDensity = graph.nodeCount + graph.edgeCount

  // Step 6: Build attribution for each deal
  return dealNodes.map(node => {
    const props = node.properties as Record<string, unknown>
    const hasDebriefs = debriefCount > 0
    const hasMotions = motionHistory.length > 0

    return {
      dealId: node.id,
      dealName: node.name,
      stage: String(props.stage ?? 'Unknown'),
      amount: Number(props.amount ?? 0),
      customerSlug,
      priorIntelligence: {
        meetingPrepsGenerated: debriefCount,
        tacticsRecommended,
        motionGeneratedAt,
        graphDensityAtTime: graphDensity,
      },
      attributionScore: computeScore(hasDebriefs, hasMotions),
    }
  })
}

// ── Attribution scoring ──────────────────────────────────────────────────────

/**
 * Determine attribution strength based on intelligence signals.
 *
 * - strong: Both meeting prep debriefs AND strategic motions exist
 * - moderate: Only motions exist (system recommended tactics, no meeting follow-up)
 * - weak: Only debriefs exist (meetings happened, but no strategic motion)
 * - none: No intelligence activity at all
 */
function computeScore(
  hasDebriefs: boolean,
  hasMotions: boolean,
): 'strong' | 'moderate' | 'weak' | 'none' {
  if (hasDebriefs && hasMotions) return 'strong'
  if (hasMotions) return 'moderate'
  if (hasDebriefs) return 'weak'
  return 'none'
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Load a customer's intelligence graph from disk. Returns null on any error.
 */
function loadGraphSafe(customerSlug: string, dataDir: string): CustomerGraph | null {
  // Validate slug to prevent path traversal
  if (/[^a-zA-Z0-9_-]/.test(customerSlug)) return null

  const filePath = resolve(dataDir, customerSlug, 'intelligence-graph.json')
  if (!existsSync(filePath)) return null

  try {
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as CustomerGraph
  } catch {
    return null
  }
}

/**
 * Count debrief files in the debriefs directory for a customer.
 */
function countDebriefs(customerSlug: string, dataDir: string): number {
  const debriefDir = resolve(dataDir, 'debriefs', customerSlug)
  if (!existsSync(debriefDir)) return 0

  try {
    const files = readdirSync(debriefDir).filter(f => f.endsWith('.json'))
    return files.length
  } catch {
    return 0
  }
}

/**
 * Get the earliest motion generation date from motion history.
 */
function getEarliestMotionDate(history: MotionHistoryEntry[]): string | undefined {
  if (history.length === 0) return undefined

  return history
    .map(h => h.firstSeenAt)
    .sort()[0]
}
