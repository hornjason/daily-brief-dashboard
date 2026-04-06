import { useState, useEffect } from 'react'
import { Loader2, Check, Settings2 } from 'lucide-react'

interface AutomationConfig {
  defaultScrapeTimeoutMs: number
  rhScrapeTimeoutMs: number
  circuitBreakerThreshold: number
  circuitBreakerCooldownMs: number
  driveDocTextCap: number
  briefEmailsInPrompt: number
  briefHistoryDays: number
}

function msToMinutes(ms: number): number {
  return Math.round(ms / 60_000)
}

function minutesToMs(min: number): number {
  return min * 60_000
}

export function AutomationSettings() {
  const [config, setConfig] = useState<AutomationConfig | null>(null)
  const [draft, setDraft] = useState<AutomationConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/settings/automation')
      .then(r => r.json())
      .then((d: { config: AutomationConfig }) => {
        setConfig(d.config)
        setDraft(d.config)
      })
      .catch(() => {})
  }, [])

  if (!draft) return null

  const handleSave = async () => {
    setSaving(true); setError(null)

    // Pre-save validation (matches server-side bounds)
    const defaultMin = msToMinutes(draft.defaultScrapeTimeoutMs)
    const rhMin = msToMinutes(draft.rhScrapeTimeoutMs)
    const cooldownMin = msToMinutes(draft.circuitBreakerCooldownMs)
    if (defaultMin < 1 || defaultMin > 60) { setError('Default timeout must be between 1 and 60 minutes'); setSaving(false); return }
    if (rhMin < 1 || rhMin > 60) { setError('RH Portal timeout must be between 1 and 60 minutes'); setSaving(false); return }
    if (cooldownMin < 1 || cooldownMin > 60) { setError('Cooldown period must be between 1 and 60 minutes'); setSaving(false); return }
    if (draft.circuitBreakerThreshold < 1 || draft.circuitBreakerThreshold > 20) { setError('Failure threshold must be between 1 and 20'); setSaving(false); return }
    if (draft.driveDocTextCap < 1000 || draft.driveDocTextCap > 100000) { setError('Drive doc text cap must be between 1,000 and 100,000 characters'); setSaving(false); return }
    if (draft.briefEmailsInPrompt < 1 || draft.briefEmailsInPrompt > 50) { setError('Emails in prompt must be between 1 and 50'); setSaving(false); return }
    if (draft.briefHistoryDays < 1 || draft.briefHistoryDays > 30) { setError('Brief history window must be between 1 and 30 days'); setSaving(false); return }

    try {
      const res = await fetch('/api/settings/automation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Save failed'); return }
      setConfig(data.config)
      setDraft(data.config)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(config)

  const setMs = (key: keyof AutomationConfig, minutes: number) => {
    setDraft(prev => prev ? { ...prev, [key]: minutesToMs(minutes) } : prev)
  }

  const setNum = (key: keyof AutomationConfig, value: number) => {
    setDraft(prev => prev ? { ...prev, [key]: value } : prev)
  }

  return (
    <div className="bg-surface rounded-xl p-5 border border-border space-y-5">
      <p className="text-sm font-medium text-text-primary">Automation &amp; Limits</p>

      {/* Scrape timeouts */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Scrape Timeouts</p>

        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="text-sm text-text-primary">Default Scrape Timeout</p>
            <p className="text-xs text-text-secondary">Wall-clock limit for CCSP, Supportable, and SF scrapes</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <input
              type="number"
              min={1}
              max={60}
              value={msToMinutes(draft.defaultScrapeTimeoutMs)}
              onChange={e => setMs('defaultScrapeTimeoutMs', Number(e.target.value))}
              className="w-20 bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <span className="text-xs text-text-secondary w-8">min</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="text-sm text-text-primary">RH Portal Scrape Timeout</p>
            <p className="text-xs text-text-secondary">Wall-clock limit for Red Hat case scrapes (iterates 50+ accounts)</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <input
              type="number"
              min={1}
              max={60}
              value={msToMinutes(draft.rhScrapeTimeoutMs)}
              onChange={e => setMs('rhScrapeTimeoutMs', Number(e.target.value))}
              className="w-20 bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <span className="text-xs text-text-secondary w-8">min</span>
          </div>
        </div>
      </div>

      {/* Circuit breaker */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Circuit Breaker</p>

        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="text-sm text-text-primary">Failure Threshold</p>
            <p className="text-xs text-text-secondary">Consecutive failures before a scraper is suspended</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <input
              type="number"
              min={1}
              max={20}
              value={draft.circuitBreakerThreshold}
              onChange={e => setNum('circuitBreakerThreshold', Number(e.target.value))}
              className="w-20 bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <span className="text-xs text-text-secondary w-8">fails</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="text-sm text-text-primary">Cooldown Period</p>
            <p className="text-xs text-text-secondary">How long a suspended scraper waits before retrying</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <input
              type="number"
              min={1}
              max={60}
              value={msToMinutes(draft.circuitBreakerCooldownMs)}
              onChange={e => setMs('circuitBreakerCooldownMs', Number(e.target.value))}
              className="w-20 bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <span className="text-xs text-text-secondary w-8">min</span>
          </div>
        </div>
      </div>

      {/* Brief generation limits */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Brief Generation Limits</p>

        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="text-sm text-text-primary">Drive Doc Text Cap</p>
            <p className="text-xs text-text-secondary">Max characters extracted per Google Drive document</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <input
              type="number"
              min={1000}
              max={100000}
              step={1000}
              value={draft.driveDocTextCap}
              onChange={e => setNum('driveDocTextCap', Number(e.target.value))}
              className="w-24 bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <span className="text-xs text-text-secondary w-8">chars</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="text-sm text-text-primary">Emails in Brief Prompt</p>
            <p className="text-xs text-text-secondary">Number of recent emails included in brief generation</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <input
              type="number"
              min={1}
              max={50}
              value={draft.briefEmailsInPrompt}
              onChange={e => setNum('briefEmailsInPrompt', Number(e.target.value))}
              className="w-20 bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <span className="text-xs text-text-secondary w-8">emails</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="text-sm text-text-primary">Brief History Window</p>
            <p className="text-xs text-text-secondary">Days of past briefs included in product intel prompt</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <input
              type="number"
              min={1}
              max={30}
              value={draft.briefHistoryDays}
              onChange={e => setNum('briefHistoryDays', Number(e.target.value))}
              className="w-20 bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <span className="text-xs text-text-secondary w-8">days</span>
          </div>
        </div>
      </div>

      {error && <p className="text-xs text-critical">{error}</p>}
      <button
        onClick={handleSave}
        disabled={!dirty || saving}
        className="w-full flex items-center justify-center gap-2 bg-accent hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
      >
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <Check className="w-3.5 h-3.5" /> : <Settings2 className="w-3.5 h-3.5" />}
        {saved ? 'Saved' : 'Save Settings'}
      </button>
    </div>
  )
}
