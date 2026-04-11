import { useState, useEffect } from 'react'
import { Loader2, Check, RefreshCw } from 'lucide-react'

interface RefreshIntervals {
  subscriptions: number
  ccsp: number
  rhScrape: number
}

export function RefreshTimerSettings() {
  const [intervals, setIntervals] = useState<RefreshIntervals | null>(null)
  const [draft, setDraft] = useState<RefreshIntervals | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/settings/refresh')
      .then(r => r.json())
      .then((d: { intervals: RefreshIntervals }) => {
        setIntervals(d.intervals)
        setDraft(d.intervals)
      })
      .catch(() => {})
  }, [])

  if (!draft) return (
    <div className="flex items-center gap-2 text-text-secondary text-sm py-6">
      <Loader2 className="w-4 h-4 animate-spin" />
      Loading settings...
    </div>
  )

  const handleSave = async () => {
    setSaving(true); setError(null)
    try {
      const res = await fetch('/api/settings/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Save failed'); return }
      setIntervals(data.intervals)
      setDraft(data.intervals)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(intervals)

  const fields: Array<{ key: keyof RefreshIntervals; label: string; hint: string }> = [
    { key: 'rhScrape',      label: 'RH Support Cases', hint: 'How often to scrape open cases from Red Hat portal' },
    { key: 'subscriptions', label: 'Subscriptions',    hint: 'How often to sync product data from Supportable sheets' },
    { key: 'ccsp',          label: 'CCSP Spend',       hint: 'How often to refresh cloud spend data' },
  ]

  return (
    <div className="bg-surface rounded-xl p-5 border border-border space-y-4">
      <p className="text-sm font-medium text-text-primary">Auto-Refresh Intervals</p>
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
      {error && <p className="text-xs text-critical">{error}</p>}
      <button
        onClick={handleSave}
        disabled={!dirty || saving}
        className="w-full flex items-center justify-center gap-2 bg-accent hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
      >
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <Check className="w-3.5 h-3.5" /> : <RefreshCw className="w-3.5 h-3.5" />}
        {saved ? 'Saved' : 'Save Intervals'}
      </button>
    </div>
  )
}
