interface Contact {
  name: string
  email?: string
  lastContact?: string
  frequency?: string  // 'weekly' | 'monthly' | 'silent'
  daysSilent?: number
  emailCount30d?: number
  emailCount60d?: number
  emailCount90d?: number
}

function FrequencyBar({ count30d, count60d, count90d }: { count30d: number; count60d: number; count90d: number }) {
  // Max across all periods for relative scaling
  const max = Math.max(count30d, count60d, count90d, 1)

  // Color: green if active (30d > 0), amber if 60d only, gray/red if silent
  const barColor = (count: number, period: '30d' | '60d' | '90d') => {
    if (count === 0) return 'bg-signal-silent/30'
    if (period === '30d') return 'bg-health-green'
    if (period === '60d') return 'bg-health-amber'
    return 'bg-signal-silent'
  }

  const periods = [
    { label: '90d', count: count90d, key: '90d' as const },
    { label: '60d', count: count60d, key: '60d' as const },
    { label: '30d', count: count30d, key: '30d' as const },
  ]

  return (
    <div className="flex items-center gap-1 mt-1">
      {periods.map(p => (
        <div key={p.key} className="flex items-center gap-0.5" title={`${p.count} emails in ${p.label}`}>
          <span className="text-[9px] text-text-secondary w-5 text-right">{p.label}</span>
          <div className="w-14 h-1.5 bg-border/30 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${barColor(p.count, p.key)}`}
              style={{ width: `${max > 0 ? (p.count / max) * 100 : 0}%` }}
            />
          </div>
          <span className="text-[9px] text-text-secondary w-3">{p.count}</span>
        </div>
      ))}
    </div>
  )
}

export default function StakeholderEngagementPanel({ contacts }: { contacts: Contact[] }) {
  if (!contacts.length) return null

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wider">Stakeholder Engagement</h4>
      <div className="space-y-2.5">
        {contacts.map((c, i) => {
          const isSilent = c.frequency === 'silent' || (c.daysSilent != null && c.daysSilent > 14)
          const hasFreqData = c.emailCount30d != null || c.emailCount60d != null || c.emailCount90d != null
          return (
            <div key={i} className="py-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${isSilent ? 'bg-signal-silent' : c.frequency === 'weekly' ? 'bg-health-green' : 'bg-health-amber'}`} />
                  <span className="text-sm text-text-primary">{c.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  {isSilent && <span className="text-xs text-signal-silent font-medium">Silent {c.daysSilent ? `${c.daysSilent}d` : ''}</span>}
                  {c.lastContact && <span className="text-xs text-text-secondary">{c.lastContact}</span>}
                </div>
              </div>
              {hasFreqData && (
                <div className="pl-3.5">
                  <FrequencyBar
                    count30d={c.emailCount30d ?? 0}
                    count60d={c.emailCount60d ?? 0}
                    count90d={c.emailCount90d ?? 0}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export type { Contact }
