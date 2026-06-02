/**
 * src/lib/motion-consumers.ts
 * Consumer integration helpers for StrategicMotion — GitHub Issue #521
 *
 * Transforms a StrategicMotion into consumer-specific output formats.
 * These are pure data transformers — no IO, no Gemini, no side effects.
 *
 * Consumers:
 *   - Brief: top 3 urgent action alerts
 *   - Portfolio: summary row per motion for dashboard table
 *   - Meeting Prep: pre-loaded context with agenda items
 *   - Playbook: full document sections
 *
 * Dependencies (read-only):
 *   - motion-builder.ts — StrategicMotion, MotionPhase types
 */

import type { StrategicMotion, MotionPhase } from './motion-builder.ts'

// ── Types ────────────────────────────────────────────────────────────────────

/** For daily brief — extract most urgent action item */
export interface BriefMotionAlert {
  customerName: string
  customerSlug: string
  motionTitle: string
  urgentPhase: string
  urgency: string
  actionText: string
}

/** For portfolio dashboard — summary row per motion */
export interface PortfolioMotionRow {
  customerName: string
  customerSlug: string
  motionTitle: string
  salesPlay?: string
  phaseCount: number
  currentPhase: string
  urgency: string
  confidence: string
  estimatedTcv?: number
}

/** For meeting prep — pre-load context */
export interface MeetingMotionContext {
  motionTitle: string
  currentPhase: string
  suggestedAgendaItems: string[]
  relevantTactics: string[]
  relevantAssets: Array<{ name: string; url: string }>
}

/** For playbook — full document sections */
export interface PlaybookMotionSection {
  executiveSummary: string
  currentState: string
  phases: Array<{
    name: string
    brief: string
    tactics: Array<{ name: string; parentTdp: string }>
    assets: Array<{ name: string; url: string }>
    personas: string[]
  }>
}

/** Input format for multi-motion functions */
export interface MotionInput {
  customerSlug: string
  customerName: string
  motion: StrategicMotion
}

// ── Urgency Helpers ─────────────────────────────────────────────────────────

const URGENCY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

function urgencyRank(urgency: string): number {
  return URGENCY_RANK[urgency] ?? 4
}

/**
 * Find the most urgent phase in a motion.
 * Returns the phase with the lowest urgency rank (critical=0 is most urgent).
 */
function findMostUrgentPhase(phases: MotionPhase[]): MotionPhase | null {
  if (phases.length === 0) return null
  return phases.reduce((best, phase) =>
    urgencyRank(phase.urgency) < urgencyRank(best.urgency) ? phase : best
  )
}

/**
 * Build action text from a phase's evidence.
 * Summarizes the most relevant evidence into a short sentence.
 */
function buildActionText(phase: MotionPhase): string {
  if (phase.evidence.length === 0) {
    return `${phase.name} requires attention`
  }
  // Use the first evidence fact as the primary action text
  return phase.evidence[0].fact
}

// ── Consumer Functions ──────────────────────────────────────────────────────

/**
 * For daily brief — extract most urgent action alerts across all motions.
 * Returns max 3 alerts, sorted by urgency (critical first).
 */
export function getMotionBriefAlerts(motions: MotionInput[]): BriefMotionAlert[] {
  if (motions.length === 0) return []

  const alerts: BriefMotionAlert[] = []

  for (const { customerSlug, customerName, motion } of motions) {
    const urgentPhase = findMostUrgentPhase(motion.phases)
    if (!urgentPhase) continue

    alerts.push({
      customerName,
      customerSlug,
      motionTitle: motion.title,
      urgentPhase: urgentPhase.name,
      urgency: urgentPhase.urgency,
      actionText: buildActionText(urgentPhase),
    })
  }

  // Sort by urgency rank (critical first), then by customer name for stability
  alerts.sort((a, b) => {
    const rankDiff = urgencyRank(a.urgency) - urgencyRank(b.urgency)
    if (rankDiff !== 0) return rankDiff
    return a.customerName.localeCompare(b.customerName)
  })

  // Cap at 3
  return alerts.slice(0, 3)
}

/**
 * For portfolio dashboard — one row per motion, sorted by urgency then TCV.
 */
export function getPortfolioMotions(motions: MotionInput[]): PortfolioMotionRow[] {
  if (motions.length === 0) return []

  const rows: PortfolioMotionRow[] = motions.map(({ customerSlug, customerName, motion }) => {
    const urgentPhase = findMostUrgentPhase(motion.phases)

    return {
      customerName,
      customerSlug,
      motionTitle: motion.title,
      salesPlay: motion.salesPlay,
      phaseCount: motion.phases.length,
      currentPhase: urgentPhase?.name ?? '',
      urgency: urgentPhase?.urgency ?? 'low',
      confidence: motion.confidence,
      estimatedTcv: motion.totalEstimatedTcv,
    }
  })

  // Sort by urgency (critical first), then by TCV descending
  rows.sort((a, b) => {
    const rankDiff = urgencyRank(a.urgency) - urgencyRank(b.urgency)
    if (rankDiff !== 0) return rankDiff
    return (b.estimatedTcv ?? 0) - (a.estimatedTcv ?? 0)
  })

  return rows
}

/**
 * For meeting prep — extract context from a single motion.
 * Suggests 3 agenda items derived from the most urgent phase's evidence and tactics.
 */
export function getMeetingMotionContext(motion: StrategicMotion): MeetingMotionContext {
  const urgentPhase = findMostUrgentPhase(motion.phases)

  if (!urgentPhase) {
    return {
      motionTitle: motion.title,
      currentPhase: '',
      suggestedAgendaItems: [],
      relevantTactics: [],
      relevantAssets: [],
    }
  }

  // Build agenda items from evidence + tactics
  const agendaItems: string[] = []

  // From evidence: each evidence fact can seed an agenda topic
  for (const ev of urgentPhase.evidence) {
    if (agendaItems.length >= 3) break
    agendaItems.push(`Discuss: ${ev.fact}`)
  }

  // From tactics: if we still need more items
  for (const tactic of urgentPhase.tactics) {
    if (agendaItems.length >= 3) break
    agendaItems.push(`Review ${tactic.name} approach`)
  }

  // If we still need more, pull from other phases
  for (const phase of motion.phases) {
    if (agendaItems.length >= 3) break
    if (phase.id === urgentPhase.id) continue
    for (const tactic of phase.tactics) {
      if (agendaItems.length >= 3) break
      agendaItems.push(`Explore ${tactic.name} opportunity`)
    }
  }

  // Collect all tactics from the most urgent phase
  const relevantTactics = urgentPhase.tactics.map((t: { name: string }) => t.name)

  // Collect all assets from the most urgent phase's tactics
  const relevantAssets: Array<{ name: string; url: string }> = []
  for (const tactic of urgentPhase.tactics) {
    for (const asset of tactic.assets) {
      relevantAssets.push({ name: asset.name, url: asset.url })
    }
  }

  return {
    motionTitle: motion.title,
    currentPhase: urgentPhase.name,
    suggestedAgendaItems: agendaItems.slice(0, 3),
    relevantTactics,
    relevantAssets,
  }
}

/**
 * For playbook — flatten motion into document-ready sections.
 */
export function getPlaybookMotionSection(motion: StrategicMotion): PlaybookMotionSection {
  // Executive summary: title + confidence + TCV
  const tcvStr = motion.totalEstimatedTcv
    ? ` | Estimated TCV: $${motion.totalEstimatedTcv.toLocaleString()}`
    : ''
  const executiveSummary = `${motion.title} | Confidence: ${motion.confidence}${tcvStr}`

  // Current state: aggregate all evidence across phases
  const allEvidence: string[] = []
  for (const phase of motion.phases) {
    for (const ev of phase.evidence) {
      allEvidence.push(ev.fact)
    }
  }
  const currentState = allEvidence.length > 0
    ? allEvidence.join('. ') + '.'
    : 'No signal evidence available.'

  // Flatten phases
  const phases = motion.phases.map((phase: MotionPhase) => {
    // Collect all assets from all tactics in this phase
    const assets: Array<{ name: string; url: string }> = []
    for (const tactic of phase.tactics) {
      for (const asset of tactic.assets) {
        assets.push({ name: asset.name, url: asset.url })
      }
    }

    // Build brief from evidence
    const brief = phase.evidence.length > 0
      ? phase.evidence.map((e: { module: string; fact: string; url?: string }) => e.fact).join('; ')
      : `${phase.name} — pending signal evidence`

    return {
      name: phase.name,
      brief,
      tactics: phase.tactics.map((t: { name: string; parentTdp: string }) => ({ name: t.name, parentTdp: t.parentTdp })),
      assets,
      personas: [...phase.targetPersonas],
    }
  })

  return {
    executiveSummary,
    currentState,
    phases,
  }
}
