import { Cloud } from 'lucide-react'
import { useSettingsForm } from '../hooks/useSettingsForm'
import { SettingsCard } from './SettingsCard'

interface WeatherConfig {
  enabled: boolean
  zipCode: string
}

export function WeatherSettings() {
  const { draft, setDraft, saving, saved, error, dirty, handleSave } =
    useSettingsForm<WeatherConfig>({
      fetchUrl: '/api/settings/weather',
      saveUrl: '/api/settings/weather',
    })

  if (!draft) return null

  return (
    <SettingsCard
      title="Weather"
      error={error}
      dirty={dirty}
      saving={saving}
      saved={saved}
      onSave={handleSave}
      saveLabel="Save Weather Settings"
      saveIcon={<Cloud className="w-3.5 h-3.5" />}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-text-primary">Show weather in top bar</p>
          <p className="text-xs text-text-secondary">Displays current temperature and conditions next to the date</p>
        </div>
        <button
          onClick={() => setDraft(d => d ? { ...d, enabled: !d.enabled } : d)}
          className={`relative w-10 h-5 rounded-full transition-colors ${draft.enabled ? 'bg-accent' : 'bg-border'}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${draft.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
      </div>
      {draft.enabled && (
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="text-sm text-text-primary">Zip / Postal Code</p>
            <p className="text-xs text-text-secondary">Used to fetch local weather conditions</p>
          </div>
          <input
            type="text"
            placeholder="e.g. 10001"
            value={draft.zipCode}
            onChange={e => setDraft(d => d ? { ...d, zipCode: e.target.value } : d)}
            className="w-28 bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      )}
    </SettingsCard>
  )
}
