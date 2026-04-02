interface Contact {
  name: string
  email?: string
  lastContact?: string
  frequency?: string  // 'weekly' | 'monthly' | 'silent'
  daysSilent?: number
}

export default function StakeholderEngagementPanel({ contacts }: { contacts: Contact[] }) {
  if (!contacts.length) return null

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wider">Stakeholder Engagement</h4>
      <div className="space-y-1.5">
        {contacts.map((c, i) => {
          const isSilent = c.frequency === 'silent' || (c.daysSilent != null && c.daysSilent > 14)
          return (
            <div key={i} className="flex items-center justify-between py-1">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${isSilent ? 'bg-signal-silent' : c.frequency === 'weekly' ? 'bg-health-green' : 'bg-health-amber'}`} />
                <span className="text-sm text-text-primary">{c.name}</span>
              </div>
              <div className="flex items-center gap-2">
                {isSilent && <span className="text-xs text-signal-silent font-medium">Silent {c.daysSilent ? `${c.daysSilent}d` : ''}</span>}
                {c.lastContact && <span className="text-xs text-text-secondary">{c.lastContact}</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export type { Contact }
