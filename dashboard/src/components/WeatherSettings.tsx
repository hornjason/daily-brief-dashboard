import { useState, useEffect } from 'react'
import { Loader2, Check, Cloud } from 'lucide-react'

interface WeatherConfig {
  enabled: boolean
  zipCode: string
}

export function WeatherSettings() {
  const [config, setConfig] = useState<WeatherConfig | null>(null)
  const [draft, setDraft] = useState<WeatherConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/settings/weather')
      .then(r => r.json())
      .then((d: WeatherConfig) => { setConfig(d); setDraft(d) })
      .catch(() => {})
  }, [])

  if (!draft) return null

  const dirty = JSON.stringify(draft) !== JSON.stringify(config)

  const handleSave = async () => {
    setSaving(true); setError(null)
    try {
      const res = await fetch('/api/settings/weather', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Save failed'); return }
      setConfig(data); setDraft(data)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-slate-800 rounded-xl p-5 border border-slate-700 space-y-4">
      <p className="text-sm font-medium text-slate-300">Weather</p>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-200">Show weather in top bar</p>
          <p className="text-xs text-slate-500">Displays current temperature and conditions next to the date</p>
        </div>
        <button
          onClick={() => setDraft(d => d ? { ...d, enabled: !d.enabled } : d)}
          className={`relative w-10 h-5 rounded-full transition-colors ${draft.enabled ? 'bg-indigo-600' : 'bg-slate-600'}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${draft.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
      </div>
      {draft.enabled && (
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="text-sm text-slate-200">Zip / Postal Code</p>
            <p className="text-xs text-slate-500">Used to fetch local weather conditions</p>
          </div>
          <input
            type="text"
            placeholder="e.g. 10001"
            value={draft.zipCode}
            onChange={e => setDraft(d => d ? { ...d, zipCode: e.target.value } : d)}
            className="w-28 bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        onClick={handleSave}
        disabled={!dirty || saving}
        className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
      >
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <Check className="w-3.5 h-3.5" /> : <Cloud className="w-3.5 h-3.5" />}
        {saved ? 'Saved' : 'Save Weather Settings'}
      </button>
    </div>
  )
}
