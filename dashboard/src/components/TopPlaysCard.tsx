/**
 * TopPlaysCard.tsx
 * GitHub Issue #620 — Surface top 2-3 expansion plays on the customer overview tab
 *
 * Compact card showing the highest-confidence expansion plays from the existing
 * expansion motion data. Gives sellers actionable plays without navigating
 * to the Campaigns tab.
 */

import { useState, useEffect, useMemo } from 'react'
import { Target, ExternalLink, ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

// ── Types (mirrors ExpansionMotionSection types) ───────────────────────────

interface MotionPhase {
  id: string
  name: string
  category: 'anchor' | 'expand' | 'transform'
  urgency: 'critical' | 'high' | 'medium' | 'low'
  tactics: Array<{
    name: string
    parentTdp: string
    brief?: string
    evidenceTrail?: Array<{
      fact: string
      module: string
      recency: string
      weight: number
    }>
  }>
  evidence: Array<{
    module: string
    fact: string
    url?: string
  }>
}

interface GeminiRecommendation {
  tacticName: string
  parentTdp: string
  reasoning: string
  confidence: 'high' | 'medium' | 'low'
  signalsUsed: string[]
}

interface StrategicMotion {
  id: string
  title: string
  salesPlay?: string
  phases: MotionPhase[]
  confidence: 'high' | 'medium' | 'low'
  geminiInsights?: GeminiRecommendation[]
  generatedAt: string
}

// ── Confidence ordering + styles ───────────────────────────────────────────

const CONFIDENCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }

const CONFIDENCE_BADGE: Record<string, string> = {
  high: 'text-green-400 bg-green-400/10 border-green-400/20',
  medium: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  low: 'text-text-secondary bg-text-secondary/10 border-text-secondary/20',
}

// ── Derive top plays from motion data ──────────────────────────────────────

interface TopPlay {
  tacticName: string
  reasoning: string
  confidence: 'high' | 'medium' | 'low'
}

function deriveTopPlays(motion: StrategicMotion): TopPlay[] {
  const plays: TopPlay[] = []

  // Prefer Gemini insights — they have explicit reasoning and confidence per tactic
  if (motion.geminiInsights && motion.geminiInsights.length > 0) {
    for (const insight of motion.geminiInsights) {
      plays.push({
        tacticName: insight.tacticName,
        reasoning: insight.reasoning,
        confidence: insight.confidence,
      })
    }
  }

  // Fall back to phase tactics if no Gemini insights
  if (plays.length === 0) {
    for (const phase of motion.phases) {
      for (const tactic of phase.tactics) {
        // Build a one-line reasoning from evidence trail or phase evidence
        const reason =
          tactic.brief ??
          tactic.evidenceTrail?.[0]?.fact ??
          phase.evidence?.[0]?.fact ??
          `${phase.name} — ${tactic.parentTdp}`

        plays.push({
          tacticName: tactic.name,
          reasoning: reason,
          // Use phase urgency as a proxy for confidence
          confidence:
            phase.urgency === 'critical' || phase.urgency === 'high'
              ? 'high'
              : phase.urgency === 'medium'
                ? 'medium'
                : 'low',
        })
      }
    }
  }

  // Sort by confidence (high first) and take top 3
  plays.sort((a, b) => (CONFIDENCE_RANK[a.confidence] ?? 2) - (CONFIDENCE_RANK[b.confidence] ?? 2))
  return plays.slice(0, 3)
}

// ── Component ──────────────────────────────────────────────────────────────

interface TopPlaysCardProps {
  customerSlug: string
  customerName: string
}

export function TopPlaysCard({ customerSlug, customerName }: TopPlaysCardProps) {
  const navigate = useNavigate()
  const [motion, setMotion] = useState<StrategicMotion | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    setMotion(null)

    fetch(`/api/customer/${encodeURIComponent(customerSlug)}/expansion-motion`)
      .then(r => {
        if (!r.ok) return null
        return r.json()
      })
      .then(data => {
        const m = data?.motion
        if (m && m.phases && m.phases.length > 0) {
          setMotion(m)
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [customerSlug])

  const plays = useMemo(() => (motion ? deriveTopPlays(motion) : []), [motion])

  // Don't render anything while loading (avoid layout shift)
  if (loading) return null

  // Empty state — subtle text, no card chrome
  if (!motion || plays.length === 0) {
    return (
      <div className="text-xs text-text-secondary/60 italic py-1">
        No expansion plays available
      </div>
    )
  }

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-border/60 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">Top Expansion Plays</h2>
        </div>
        <button
          onClick={() => navigate(`/dashboard/campaigns`)}
          className="flex items-center gap-1 text-xs text-accent hover:underline transition-colors"
        >
          All Campaigns
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>

      {/* Play rows */}
      <div className="divide-y divide-border/30">
        {plays.map((play, i) => (
          <div key={i} className="px-5 py-3 flex items-start gap-3 group">
            {/* Left: tactic name + reasoning */}
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary block truncate" title={play.tacticName}>
                {play.tacticName}
              </span>
              <span className="text-xs text-text-secondary line-clamp-1 leading-relaxed" title={play.reasoning}>
                {play.reasoning}
              </span>
            </div>

            {/* Right: confidence badge + link */}
            <div className="flex items-center gap-2 shrink-0 pt-0.5">
              <span className={`text-xs px-1.5 py-0.5 rounded border font-medium capitalize ${CONFIDENCE_BADGE[play.confidence]}`}>
                {play.confidence}
              </span>
              <button
                onClick={() => navigate(`/dashboard/campaigns`)}
                className="text-xs text-text-secondary hover:text-accent transition-colors opacity-0 group-hover:opacity-100"
                title="View Campaign"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
