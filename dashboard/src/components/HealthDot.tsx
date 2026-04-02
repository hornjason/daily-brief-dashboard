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

export default function HealthDot({ score, size = 'sm', showScore = false, breakdown }: HealthDotProps) {
  const color = score >= 70 ? 'bg-health-green' : score >= 40 ? 'bg-health-amber' : 'bg-health-red'
  const textColor = score >= 70 ? 'text-health-green' : score >= 40 ? 'text-health-amber' : 'text-health-red'
  const sizeClass = size === 'sm' ? 'w-2.5 h-2.5' : 'w-3 h-3'
  const label = score >= 70 ? 'Healthy' : score >= 40 ? 'Attention' : 'Critical'

  const [showTooltip, setShowTooltip] = useState(false)
  const containerRef = useRef<HTMLSpanElement>(null)

  return (
    <span
      ref={containerRef}
      className="inline-flex items-center gap-1.5 relative"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <span className={`inline-block ${sizeClass} rounded-full ${color}`} />
      {showScore && <span className={`text-xs tabular-nums ${textColor}`}>{score}</span>}

      {/* Tooltip with score breakdown (BKL-G12) */}
      {showTooltip && breakdown && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none">
          <div role="tooltip" className="bg-surface border border-border rounded-lg shadow-lg px-3 py-2.5 min-w-[180px]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-text-primary">Health Score</span>
              <span className={`text-sm font-bold tabular-nums ${textColor}`}>{score}/100</span>
            </div>
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
          {/* Arrow */}
          <div className="w-2 h-2 bg-surface border-b border-r border-border rotate-45 absolute left-1/2 -translate-x-1/2 -bottom-1" />
        </div>
      )}

      {/* Fallback title when no breakdown is available */}
      {!breakdown && (
        <span className="sr-only">{`Health: ${score}/100 — ${label}`}</span>
      )}
    </span>
  )
}
