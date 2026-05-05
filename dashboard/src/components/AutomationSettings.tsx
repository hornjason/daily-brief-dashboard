import { useState } from 'react'
import { Loader2, Settings2 } from 'lucide-react'
import { useSettingsForm } from '../hooks/useSettingsForm'
import { SettingsCard } from './SettingsCard'

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
  const { draft, setDraft, saving, saved, error, setError, dirty, handleSave } =
    useSettingsForm<AutomationConfig>({
      fetchUrl: '/api/settings/automation',
      saveUrl: '/api/settings/automation',
      transform: (raw: { config: AutomationConfig }) => raw.config,
    })

  // Field-level validation state stays local — the hook intentionally does
  // not generalize this.
  const [errorField, setErrorField] = useState<string | null>(null)

  const inputCls = (key: string, base: string) =>
    errorField === key ? `${base} ring-critical border-critical` : base

  if (!draft) return (
    <div className="flex items-center gap-2 text-text-secondary text-sm py-6">
      <Loader2 className="w-4 h-4 animate-spin" />
      Loading settings...
    </div>
  )

  const onSave = async () => {
    // Pre-save validation (matches server-side bounds)
    const defaultMin = msToMinutes(draft.defaultScrapeTimeoutMs)
    const rhMin = msToMinutes(draft.rhScrapeTimeoutMs)
    const cooldownMin = msToMinutes(draft.circuitBreakerCooldownMs)
    if (defaultMin < 1 || defaultMin > 60) { setError('Default timeout must be between 1 and 60 minutes'); return }
    if (rhMin < 1 || rhMin > 60) { setError('RH Portal timeout must be between 1 and 60 minutes'); return }
    if (cooldownMin < 1 || cooldownMin > 60) { setError('Cooldown period must be between 1 and 60 minutes'); return }
    if (draft.circuitBreakerThreshold < 1 || draft.circuitBreakerThreshold > 20) { setError('Failure threshold must be between 1 and 20'); return }
    if (draft.driveDocTextCap < 1000 || draft.driveDocTextCap > 100000) { setError('Drive doc text cap must be between 1,000 and 100,000 characters'); setErrorField('driveDocTextCap'); return }
    if (draft.briefEmailsInPrompt < 1 || draft.briefEmailsInPrompt > 50) { setError('Emails in prompt must be between 1 and 50'); setErrorField('briefEmailsInPrompt'); return }
    if (draft.briefHistoryDays < 1 || draft.briefHistoryDays > 30) { setError('Brief history window must be between 1 and 30 days'); setErrorField('briefHistoryDays'); return }
    setErrorField(null)
    await handleSave()
  }

  const setMs = (key: keyof AutomationConfig, minutes: number) => {
    setDraft(prev => prev ? { ...prev, [key]: minutesToMs(minutes) } : prev)
  }

  const setNum = (key: keyof AutomationConfig, value: number) => {
    setDraft(prev => prev ? { ...prev, [key]: value } : prev)
  }

  return (
    <SettingsCard
      title="Automation & Limits"
      error={error}
      dirty={dirty}
      saving={saving}
      saved={saved}
      onSave={onSave}
      saveLabel="Save Settings"
      saveIcon={<Settings2 className="w-3.5 h-3.5" />}
      className="bg-surface rounded-xl p-5 border border-border space-y-5"
    >
      {/* Scrape timeouts */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Scrape Timeouts</p>

        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="text-sm text-text-primary">Default Scrape Timeout</p>
            <p className="text-xs text-text-secondary">Wall-clock limit for CCSP and SF scrapes</p>
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
              className={inputCls('driveDocTextCap', "w-24 bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-accent")}
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
              className={inputCls('briefEmailsInPrompt', "w-20 bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-accent")}
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
              className={inputCls('briefHistoryDays', "w-20 bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-accent")}
            />
            <span className="text-xs text-text-secondary w-8">days</span>
          </div>
        </div>
      </div>
    </SettingsCard>
  )
}
