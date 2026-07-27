/**
 * src/lib/meeting-prep-graph-integration.ts
 * Integration layer: intelligence graph scoring → meeting prep generation (#642)
 *
 * The graph scores and ranks. Gemini narrates. This is Layer 3 compliance.
 *
 * Provides:
 * - loadAndScoreTactics() — loads graph, extracts candidates, scores, sorts
 * - formatScoredTacticsForPrompt() — formats scored tactics into structured
 *   text for Gemini prompt injection (replaces raw enrichment context)
 */

import { loadGraph } from './intelligence-graph.ts'
import { extractCandidateTactics } from './meeting-prep-intelligence.ts'
import { scoreTactics, type ScoredTactic } from './tactic-scorer.ts'
import { computeGraphDiff, type GraphDiff } from './graph-diff.ts'
import { CACHE_DIR } from './paths.ts'
import type { Signal, SignalType } from '../feature-module-registry.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface GraphScoringResult {
  /** Scored and sorted tactics (descending by compositeScore) */
  scoredTactics: ScoredTactic[]
  /** Graph temporal diff (what changed since last build) */
  graphDiff: GraphDiff
  /** Whether the graph was loaded successfully */
  graphLoaded: boolean
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load the intelligence graph for a customer, score tactics, and compute diff.
 * Returns empty results if no graph exists (graceful degradation).
 */
export function loadAndScoreTactics(customerSlug: string): GraphScoringResult {
  const graph = loadGraph(customerSlug, CACHE_DIR)

  if (!graph) {
    return {
      scoredTactics: [],
      graphDiff: {
        customerSlug,
        currentBuiltAt: new Date().toISOString(),
        changes: [],
        summary: 'No intelligence graph available',
      },
      graphLoaded: false,
    }
  }

  const candidates = extractCandidateTactics(graph)
  const scoredTactics = scoreTactics(graph, candidates).sort(
    (a, b) => b.compositeScore - a.compositeScore,
  )
  const graphDiff = computeGraphDiff(graph, null)

  return {
    scoredTactics,
    graphDiff,
    graphLoaded: true,
  }
}

/**
 * Extract non-Closed deal nodes from the intelligence graph as pipeline signals.
 * Supplements pipeline-module signals when pipeline-data.json is stale or incomplete.
 * Deduplicates against existing pipeline signals by opportunity name.
 */
export function extractGraphDealSignals(
  customerSlug: string,
  existingPipelineSignals: { metadata?: { opportunityName?: string } }[],
): Signal[] {
  const graph = loadGraph(customerSlug, CACHE_DIR)
  if (!graph) return []

  const existingNames = new Set(
    existingPipelineSignals
      .map(s => (s.metadata?.opportunityName ?? '').toLowerCase())
      .filter(Boolean),
  )

  const dealNodes = Object.values(graph.nodes).filter(n => n.type === 'deal')
  const signals: Signal[] = []

  for (const deal of dealNodes) {
    const props = deal.properties as Record<string, any>
    const stage = (props.forecastCategory ?? props.stage ?? '').toString()
    if (stage.toLowerCase().includes('closed')) continue
    if (existingNames.has(deal.name.toLowerCase())) continue

    const amount = Number(props.amount ?? 0)
    const closeDate = (props.closeDate ?? '').toString()
    let rawRelevance = 0.5
    const sl = stage.toLowerCase()
    if (sl.includes('commit')) rawRelevance = 0.9
    else if (sl.includes('best case') || sl.includes('upside')) rawRelevance = 0.7
    else if (sl.includes('pipeline')) rawRelevance = 0.5

    signals.push({
      source: 'pipeline',
      type: 'expansion' as SignalType,
      headline: `${deal.name} — ${stage}`,
      detail: `$${Math.round(amount).toLocaleString()} ACV${closeDate ? ` | Close: ${closeDate}` : ''}`,
      rawRelevance,
      timestamp: graph.builtAt,
      metadata: {
        customerSlug,
        opportunityName: deal.name,
        stage,
        amount,
        closeDate,
        sourceGraph: true,
      },
    })
  }

  return signals
}

/**
 * Format scored tactics into a structured text block for injection into
 * the Gemini prompt. Replaces buildEnrichmentPromptContext() for the
 * intelligence portion of the prompt.
 *
 * Output format:
 * ```
 * Top Scored Tactics (pre-ranked by intelligence graph):
 * 1. [Name] (TDP: [tdp], score: 0.87)
 *    Evidence:
 *    - [evidence fact] ([recency])
 *    ...
 * ```
 *
 * Only includes tactics with score > 0 and caps at top 5.
 */
export function formatScoredTacticsForPrompt(
  scoredTactics: ScoredTactic[],
  maxTactics: number = 5,
): string {
  const nonZero = scoredTactics.filter(t => t.compositeScore > 0)
  if (nonZero.length === 0) return ''

  const top = nonZero.slice(0, maxTactics)

  const lines: string[] = ['Top Scored Tactics (pre-ranked by intelligence graph):']

  for (let i = 0; i < top.length; i++) {
    const t = top[i]
    lines.push(`${i + 1}. ${t.name} (TDP: ${t.parentTdp}, score: ${t.compositeScore.toFixed(2)})`)

    const evidenceItems = t.evidenceTrail.filter(e => e.weight > 0)
    if (evidenceItems.length > 0) {
      lines.push('   Evidence:')
      for (const ev of evidenceItems) {
        lines.push(`   - ${ev.fact}${ev.recency ? ` (${ev.recency})` : ''}`)
      }
    }
  }

  // Add signal density note if available
  const firstTactic = top[0]
  if (firstTactic?.signalDensity) {
    const { populated, total } = firstTactic.signalDensity
    lines.push('')
    lines.push(`Signal density: ${populated}/${total} signal types populated (${Math.round((populated / total) * 100)}%)`)
  }

  return lines.join('\n')
}

/**
 * Format graph diff changes for the prompt context.
 * Provides "what's changed" narrative for Gemini.
 */
export function formatGraphDiffForPrompt(diff: GraphDiff): string {
  if (diff.changes.length === 0) return ''

  const lines: string[] = ['Recent Intelligence Changes:']
  for (const change of diff.changes.slice(0, 8)) {
    lines.push(`- ${change.description} (${change.timestamp})`)
  }

  return lines.join('\n')
}
