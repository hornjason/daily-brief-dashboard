import { useState, useRef } from 'react'

interface SignalBreakdown {
  score: number
  signal: string
}

interface HealthBreakdown {
  cases: SignalBreakdown
  subscriptions: SignalBreakdown
  meetings: SignalBreakdown
  emails: SignalBreakdown
  pipeline: SignalBreakdown
  cloudSpend: SignalBreakdown
}

interface HealthDotProps {
  score: number
  size?: 'sm' | 'md'
  showScore?: boolean
  breakdown?: HealthBreakdown
  /** BKL-UX52: Attention mode reverses color scale (high score = red = needs attention) */
  mode?: 'health' | 'attention'
  /** BKL-UX52: Human-readable reasons for attention score tooltip */
  reasons?: string[]
}

const SIGNAL_LABELS: Record<string, string> = {
  cases: 'Cases',
  subscriptions: 'Subscriptions',
  meetings: 'Meetings',
  emails: 'Emails',
  pipeline: 'Pipeline',
  cloudSpend: 'Cloud Spend',
}

function scoreColor(score: number): string {
  if (score >= 70) return '#3FB950'
  if (score >= 40) return '#D29922'
  return '#F85149'
}

export default function HealthDot({ score, size = 'sm', showScore = false, breakdown, mode = 'health', reasons }: HealthDotProps) {
  // BKL-UX52: Attention mode — high score = bad (red >= 70, amber >= 40, green < 40)
  // Health mode (default) — high score = good (green >= 70, amber >= 40, red < 40)
  const isAttention = mode === 'attention'

  let color: string
  let textColor: string
  let label: string

  if (isAttention) {
    // Attention: high = needs attention (red), low = healthy (green), 0 = grey (no data)
    if (score === 0 && (!reasons || reasons.length === 0)) {
      color = 'bg-zinc-600'
      textColor = 'text-zinc-400'
      label = 'No data'
    } else if (score >= 70) {
      color = 'bg-red-500'
      textColor = 'text-red-400'
      label = 'Needs Attention'
    } else if (score >= 40) {
      color = 'bg-amber-500'
      textColor = 'text-amber-400'
      label = 'Monitor'
    } else {
      color = 'bg-green-500'
      textColor = 'text-green-400'
      label = 'Healthy'
    }
  } else {
    color = score >= 70 ? 'bg-health-green' : score >= 40 ? 'bg-health-amber' : 'bg-health-red'
    textColor = score >= 70 ? 'text-health-green' : score >= 40 ? 'text-health-amber' : 'text-health-red'
    label = score >= 70 ? 'Healthy' : score >= 40 ? 'Attention' : 'Critical'
  }

  const sizeClass = size === 'sm' ? 'w-2.5 h-2.5' : 'w-3 h-3'
  const hasTooltip = breakdown || (reasons && reasons.length > 0)

  const [showTooltip, setShowTooltip] = useState(false)
  const containerRef = useRef<HTMLSpanElement>(null)

  return (
    <span
      ref={containerRef}
      className="inline-flex items-center gap-1.5 relative"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <span className={`inline-block ${sizeClass} rounded-full ${color}`} title={hasTooltip ? undefined : `${isAttention ? 'Attention' : 'Health'}: ${score}/100 — ${label}`} />
      {showScore && <span className={`text-xs tabular-nums ${textColor}`}>{score}</span>}

      {/* BKL-UX52: Attention reasons tooltip */}
      {showTooltip && isAttention && reasons && reasons.length > 0 && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 pointer-events-none">
          <div className="w-2 h-2 bg-surface border-t border-l border-border rotate-45 absolute left-1/2 -translate-x-1/2 -top-1" />
          <div role="tooltip" className="bg-surface border border-border rounded-lg shadow-lg px-3 py-2.5 min-w-[220px] max-w-[320px]">
            <div className="flex items-center justify-between mb-2">
              <span className={`text-xs font-semibold ${textColor}`}>{label}</span>
              <span className={`text-sm font-bold tabular-nums ${textColor}`}>{score}</span>
            </div>
            <div className="space-y-1.5">
              {reasons.map((reason, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] text-text-secondary">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${score >= 70 ? 'bg-red-500' : score >= 40 ? 'bg-amber-500' : 'bg-green-500'}`} />
                  <span>{reason}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tooltip with score breakdown (BKL-G12) — health mode only */}
      {showTooltip && !isAttention && breakdown && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 pointer-events-none">
          {/* Arrow */}
          <div className="w-2 h-2 bg-surface border-t border-l border-border rotate-45 absolute left-1/2 -translate-x-1/2 -top-1" />
          <div role="tooltip" className="bg-surface border border-border rounded-lg shadow-lg px-3 py-2.5 min-w-[180px]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-text-primary">Health Score</span>
              <span className={`text-sm font-bold tabular-nums ${textColor}`}>{score}/100</span>
            </div>
            <div className="text-[9px] text-text-secondary/70 mt-0.5">Composite across 6 dimensions</div>
            <div className="text-[10px] text-text-secondary mb-1.5">{label}</div>
            <div className="space-y-1.5">
              {(Object.keys(breakdown) as (keyof HealthBreakdown)[]).map((key) => {
                const sig = breakdown[key]
                return (
                  <div key={key} className="flex items-center gap-2">
                    <div className="w-16 flex-shrink-0">
                      <div className="text-[10px] text-text-secondary leading-tight">{SIGNAL_LABELS[key]}</div>
                    </div>
                    <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${sig.score}%`, backgroundColor: scoreColor(sig.score) }}
                      />
                    </div>
                    <span className="text-[10px] tabular-nums text-text-secondary w-5 text-right">{sig.score}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Fallback title when no tooltip is available */}
      {!hasTooltip && (
        <span className="sr-only">{`${isAttention ? 'Attention' : 'Health'}: ${score}/100 — ${label}`}</span>
      )}
    </span>
  )
}
