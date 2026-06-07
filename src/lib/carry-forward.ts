/**
 * src/lib/carry-forward.ts
 * Carry-forward escalation for recurring meeting prep (#646)
 *
 * When meeting prep regenerates for a recurring meeting series, tracks which
 * recommended plays appeared in previous preps. If a play repeats across
 * consecutive preps, escalates its presentation with urgency evidence.
 *
 * Pure domain logic — no I/O, no Gemini calls.
 */

import type { PrepHistoryEntry } from '../meeting-prep-service.ts'

// ── Types ────────────────────────────────────────────────────────────────────

/** Minimal evidence block interface for carry-forward (avoids circular deps) */
export interface EvidenceBlock {
  playName: string
  compositeScore: number
  evidenceTrail: Array<{ fact: string; source: string; recency: string }>
  availableLevers: Array<{ name: string; description: string; url: string; validThrough?: string; source: string }>
  teamContext: string
  proposedAsk: string
}

export interface RecommendedPlay {
  playName: string
  compositeScore: number
  firstRecommendedAt?: string  // ISO date when this play first appeared
}

export interface EscalationContext {
  /** How many consecutive preps this play appeared in (including current) */
  consecutiveCount: number
  /** ISO date when this play was first recommended in this series */
  firstRecommendedAt: string
  /** New evidence facts from current blocks not present at first recommendation */
  evidenceDelta: string[]
  /** Human-readable urgency progression description */
  urgencyChange: string
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Compute escalation context for plays that recur across consecutive preps
 * in the same recurring meeting series.
 *
 * @param currentBlocks - Evidence blocks from the current generation
 * @param history - Full prep history for this customer (newest first)
 * @param recurringEventId - The series ID to filter history entries
 * @returns Map of play name -> escalation context (only for plays that repeat)
 */
export function computeEscalation(
  currentBlocks: EvidenceBlock[],
  history: PrepHistoryEntry[],
  recurringEventId?: string,
): Map<string, EscalationContext> {
  const result = new Map<string, EscalationContext>()

  if (!recurringEventId || history.length === 0) return result

  // Filter history to this series only, sorted newest first (assumed from readHistory)
  const seriesHistory = history.filter(h => h.recurringEventId === recurringEventId)
  if (seriesHistory.length === 0) return result

  for (const block of currentBlocks) {
    const escalation = computePlayEscalation(block, seriesHistory)
    if (escalation) {
      result.set(block.playName, escalation)
    }
  }

  return result
}

/**
 * Format escalation context into a prompt-injectable string for Gemini.
 * Returns empty string if no escalations exist.
 */
export function formatEscalationForPrompt(
  escalations: Map<string, EscalationContext>,
): string {
  if (escalations.size === 0) return ''

  const lines: string[] = ['## Carry-Forward Escalation (plays repeated from previous preps)']

  for (const [playName, ctx] of escalations) {
    lines.push(`### ${playName} — REPEATED ${ctx.consecutiveCount}x consecutive`)
    lines.push(`- First recommended: ${ctx.firstRecommendedAt}`)
    lines.push(`- ${ctx.urgencyChange}`)
    if (ctx.evidenceDelta.length > 0) {
      lines.push('- New evidence since first flagged:')
      for (const delta of ctx.evidenceDelta) {
        lines.push(`  - ${delta}`)
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ── Internal ────────────────────────────────────────────────────────────────

function computePlayEscalation(
  block: EvidenceBlock,
  seriesHistory: PrepHistoryEntry[],
): EscalationContext | null {
  // Count consecutive appearances starting from the most recent history entry
  let consecutiveCount = 0
  let firstRecommendedAt: string | undefined

  for (const entry of seriesHistory) {
    const plays = entry.recommendedPlays ?? []
    const match = plays.find(p => p.playName === block.playName)

    if (!match) {
      // Streak broken — stop counting
      break
    }

    consecutiveCount++
    // Track the earliest firstRecommendedAt from any entry in the streak
    firstRecommendedAt = match.firstRecommendedAt ?? entry.generatedAt
  }

  if (consecutiveCount === 0) return null

  // +1 for the current generation
  const totalCount = consecutiveCount + 1

  // Use the oldest firstRecommendedAt we found
  const resolvedFirst = firstRecommendedAt ?? seriesHistory[seriesHistory.length - 1]?.generatedAt ?? new Date().toISOString()

  // Build evidence delta: all current evidence facts
  const evidenceDelta = block.evidenceTrail.map(e => e.fact)

  // Build urgency change description
  const daysSinceFirst = Math.round(
    (Date.now() - new Date(resolvedFirst).getTime()) / (1000 * 60 * 60 * 24),
  )
  const urgencyChange = daysSinceFirst > 0
    ? `This play has been flagged for ${daysSinceFirst} days across ${totalCount} consecutive preps — action is overdue.`
    : `This play has been recommended ${totalCount} times consecutively.`

  return {
    consecutiveCount: totalCount,
    firstRecommendedAt: resolvedFirst,
    evidenceDelta,
    urgencyChange,
  }
}
