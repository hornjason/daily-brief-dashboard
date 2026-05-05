import { Loader2, RefreshCw } from 'lucide-react'
import { useSettingsForm } from '../hooks/useSettingsForm'
import { SettingsCard } from './SettingsCard'

interface RefreshIntervals {
  subscriptions: number
  ccsp: number
  rhScrape: number
}

export function RefreshTimerSettings() {
  const { draft, setDraft, saving, saved, error, dirty, handleSave } =
    useSettingsForm<RefreshIntervals>({
      fetchUrl: '/api/settings/refresh',
      saveUrl: '/api/settings/refresh',
      transform: (raw: { intervals: RefreshIntervals }) => raw.intervals,
    })

  if (!draft) return (
    <div className="flex items-center gap-2 text-text-secondary text-sm py-6">
      <Loader2 className="w-4 h-4 animate-spin" />
      Loading settings...
    </div>
  )

  const fields: Array<{ key: keyof RefreshIntervals; label: string; hint: string }> = [
    { key: 'rhScrape',      label: 'RH Support Cases', hint: 'How often to scrape open cases from Red Hat portal' },
    { key: 'subscriptions', label: 'Subscriptions',    hint: 'How often to sync product data from SF Bookings sheets' },
    { key: 'ccsp',          label: 'CCSP Spend',       hint: 'How often to refresh cloud spend data' },
  ]

  return (
    <SettingsCard
      title="Auto-Refresh Intervals"
      error={error}
      dirty={dirty}
      saving={saving}
      saved={saved}
      onSave={handleSave}
      saveLabel="Save Intervals"
      saveIcon={<RefreshCw className="w-3.5 h-3.5" />}
    >
      <div className="space-y-3">
        {fields.map(({ key, label, hint }) => (
          <div key={key} className="flex items-center gap-3">
            <div className="flex-1">
              <p className="text-sm text-text-primary">{label}</p>
              <p className="text-xs text-text-secondary">{hint}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="number"
                min={1}
                value={draft[key]}
                onChange={e => setDraft(prev => prev ? { ...prev, [key]: Number(e.target.value) } : prev)}
                className="w-20 bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <span className="text-xs text-text-secondary w-8">min</span>
            </div>
          </div>
        ))}
      </div>
    </SettingsCard>
  )
}
