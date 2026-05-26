interface SignalGauge {
  label: string
  score: number
  signal: string
}

interface HealthScoreHeroProps {
  score: number
  status: 'red' | 'yellow' | 'green'
  breakdown: {
    cases: { score: number; signal: string }
    subscriptions: { score: number; signal: string }
    meetings: { score: number; signal: string }
    emails: { score: number; signal: string }
    pipeline: { score: number; signal: string }
    cloudSpend: { score: number; signal: string }
  }
}

export default function HealthScoreHero({ score, status, breakdown }: HealthScoreHeroProps) {
  const statusColor = status === 'green' ? 'text-health-green' : status === 'yellow' ? 'text-health-amber' : 'text-health-red'
  const statusBg = status === 'green'
    ? 'bg-health-green-bg border-health-green-border'
    : status === 'yellow'
      ? 'bg-health-amber-bg border-health-amber-border'
      : 'bg-health-red-bg border-health-red-border'

  const fallback = { score: 0, signal: 'No data' }

  // Friendly signal labels for "no cached data" states — these are informational,
  // not penalties (health-score.ts already excludes them from weighted average)
  const friendlySignal = (raw: string): string => {
    if (raw === 'No cached email data') return 'Gmail not connected'
    if (raw === 'No cached meeting data') return 'No meeting data yet'
    return raw
  }

  const gauges: SignalGauge[] = [
    { label: 'Cases', ...(breakdown?.cases ?? fallback) },
    { label: 'Subscriptions', ...(breakdown?.subscriptions ?? fallback) },
    { label: 'Meetings', ...(breakdown?.meetings ?? fallback) },
    { label: 'Emails', ...(breakdown?.emails ?? fallback) },
    { label: 'Pipeline', ...(breakdown?.pipeline ?? fallback) },
    { label: 'Cloud Spend', ...(breakdown?.cloudSpend ?? fallback) },
  ].map(g => ({ ...g, signal: friendlySignal(g.signal) }))

  // Signals indicating no data source is connected — show muted, not alarming
  const isNotConnected = (signal: string) =>
    signal === 'Gmail not connected' || signal === 'No meeting data yet' || signal.includes('No cached')

  return (
    <div className={`p-4 rounded-card border ${statusBg}`}>
      <div className="flex items-center gap-3 mb-3">
        <span className={`text-hero ${statusColor}`}>{((score ?? 0) / 10).toFixed(1)}</span>
        <span className="text-xs text-text-secondary">/ 10</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {gauges.map(g => {
          const notConnected = isNotConnected(g.signal)
          return (
            <div key={g.label} className="flex flex-col gap-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="text-signal text-text-secondary">{g.label}</span>
                {notConnected ? (
                  <span className="text-signal text-text-secondary/40">--</span>
                ) : (
                  <span className="text-signal tabular-nums text-text-primary">{g.score}</span>
                )}
              </div>
              <div className="h-1 bg-border rounded-full overflow-hidden">
                {notConnected ? (
                  <div className="h-full rounded-full bg-border/60" style={{ width: '100%' }} />
                ) : (
                  <div
                    className={`h-full rounded-full transition-all ${g.score >= 70 ? 'bg-health-green' : g.score >= 40 ? 'bg-health-amber' : 'bg-health-red'}`}
                    style={{ width: `${g.score}%` }}
                  />
                )}
              </div>
              <span className={`text-signal truncate ${notConnected ? 'text-text-secondary/40 italic' : 'text-text-secondary/60'}`} title={g.signal}>{g.signal}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
