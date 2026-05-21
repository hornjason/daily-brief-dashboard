import { useState, useEffect, useCallback } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Step0RegionAccess } from '../Step0RegionAccess'
import { formatRelTime } from '../../lib/format'

// ── Types ──────────────────────────────────────────────────────────────────────

interface AiSettings {
  intelligenceEnabled: boolean
  docClassifyMaxAgeDays: number
}

interface RefreshIntervals {
  subscriptions: number
  ccsp: number
  rhScrape: number
}

interface BackupStatus {
  sheetId: string | null
  lastBackup: string | null
  hasSheet: boolean
}

// ── Collapsible Section ────────────────────────────────────────────────────────

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-label={isOpen ? `Collapse ${title} section` : `Expand ${title} section`}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-700/50 transition-colors"
      >
        <span className="text-sm font-medium text-gray-200">{title}</span>
        {isOpen ? (
          <ChevronDown className="w-4 h-4 text-gray-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-gray-400" />
        )}
      </button>
      {isOpen && <div className="px-4 pb-4 border-t border-gray-700">{children}</div>}
    </div>
  )
}

// ── AI Settings Section ────────────────────────────────────────────────────────

function AiSettingsSection() {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/settings/ai')
      .then((r) => r.json())
      .then((d) => setSettings(d.config))
      .catch(() => {})
  }, [])

  const handleSave = async (updates: Partial<AiSettings>) => {
    setSaving(true)
    setSaved(false)
    try {
      const res = await fetch('/api/settings/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (res.ok) {
        setSettings((prev) => ({ ...prev!, ...updates }))
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } catch {
      // Silent fail
    } finally {
      setSaving(false)
    }
  }

  if (!settings) return <div className="mt-4 text-xs text-gray-500">Loading...</div>

  return (
    <div className="mt-4 space-y-4">
      {/* Intelligence Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-200">Intelligence Generation</p>
          <p className="text-xs text-gray-500 mt-0.5">Enable/disable Gemini account intelligence and briefs globally</p>
        </div>
        <button
          onClick={() => handleSave({ intelligenceEnabled: !settings.intelligenceEnabled })}
          disabled={saving}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            settings.intelligenceEnabled ? 'bg-green-600' : 'bg-gray-600'
          } ${saving ? 'opacity-50' : ''}`}
          role="switch"
          aria-checked={settings.intelligenceEnabled}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              settings.intelligenceEnabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* Doc Age Limit */}
      <div className="flex items-center justify-between pt-4 border-t border-gray-700">
        <div>
          <p className="text-sm font-medium text-gray-200">Doc Age Limit (days)</p>
          <p className="text-xs text-gray-500 mt-0.5">
            0 = classify all docs regardless of age. Set to e.g. 30 to skip docs older than 30 days.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            step={1}
            value={settings.docClassifyMaxAgeDays}
            onChange={(e) => setSettings({ ...settings, docClassifyMaxAgeDays: Math.max(0, parseInt(e.target.value) || 0) })}
            className="w-20 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-white text-right tabular-nums focus:outline-none focus:border-accent"
          />
          <button
            onClick={() => handleSave({ docClassifyMaxAgeDays: settings.docClassifyMaxAgeDays })}
            disabled={saving}
            className="px-2 py-1 text-xs bg-accent/20 text-accent rounded hover:bg-accent/30 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Scheduler Config Section ───────────────────────────────────────────────────

function SchedulerConfigSection() {
  const [intervals, setIntervals] = useState<RefreshIntervals | null>(null)
  const [rhMinutes, setRhMinutes] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/settings/refresh')
      .then((r) => r.json())
      .then((d) => {
        setIntervals(d.intervals)
        setRhMinutes(String(d.intervals.rhScrape))
      })
      .catch(() => {})
  }, [])

  const handleSave = async () => {
    const val = parseInt(rhMinutes, 10)
    if (!Number.isFinite(val) || val < 30) return

    setSaving(true)
    setSaved(false)
    try {
      const res = await fetch('/api/settings/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rhScrape: val }),
      })
      if (res.ok) {
        const d = await res.json()
        setIntervals(d.intervals)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } catch {
      // Silent fail
    } finally {
      setSaving(false)
    }
  }

  if (!intervals) return <div className="mt-4 text-xs text-gray-500">Loading...</div>

  return (
    <div className="mt-4 flex items-center gap-3">
      <label className="text-xs text-gray-400 w-40 shrink-0">
        RH Cases interval
        <span className="block text-gray-500">30 min floor</span>
      </label>
      <div className="flex-1 flex items-center gap-1.5">
        <input
          type="number"
          min={30}
          value={rhMinutes}
          onChange={(e) => setRhMinutes(e.target.value)}
          className="w-20 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-gray-400"
        />
        <span className="text-xs text-gray-500">min</span>
      </div>
      <button
        onClick={handleSave}
        disabled={saving}
        className="px-2.5 py-1 text-xs font-medium rounded bg-gray-600 hover:bg-gray-500 disabled:opacity-40 text-white transition-colors shrink-0 ml-auto"
      >
        {saving ? '...' : saved ? 'Saved' : 'Save'}
      </button>
    </div>
  )
}

// ── Config Backup Section ──────────────────────────────────────────────────────

function ConfigBackupSection() {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [backing, setBacking] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [result, setResult] = useState<{ type: 'backup' | 'restore'; ok: boolean; detail: string } | null>(null)

  const fetchStatus = useCallback(() => {
    fetch('/api/admin/backup/status')
      .then((r) => r.json())
      .then((d) => setStatus(d))
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  const handleBackup = async () => {
    setBacking(true)
    setResult(null)
    try {
      const res = await fetch('/api/admin/backup', { method: 'POST' })
      const d = await res.json()
      setResult({
        type: 'backup',
        ok: d.ok,
        detail: d.ok ? `Backed up at ${d.timestamp}` : d.error ?? 'No backup sheet configured',
      })
      fetchStatus()
    } catch {
      setResult({ type: 'backup', ok: false, detail: 'Network error' })
    } finally {
      setBacking(false)
    }
  }

  const handleRestore = async () => {
    setRestoring(true)
    setResult(null)
    setConfirmRestore(false)
    try {
      const res = await fetch('/api/admin/backup/restore', { method: 'POST' })
      const d = await res.json()
      const detail = d.ok
        ? `Restored: ${d.sections.join(', ')}${d.errors?.length ? ` | Errors: ${d.errors.join(', ')}` : ''}`
        : `Failed: ${d.errors?.join(', ') ?? 'unknown error'}`
      setResult({ type: 'restore', ok: d.ok, detail })
    } catch {
      setResult({ type: 'restore', ok: false, detail: 'Network error' })
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="mt-4 space-y-3">
      {status?.hasSheet && (
        <div className="text-xs text-gray-400">
          Sheet ID:{' '}
          <a
            href={`https://docs.google.com/spreadsheets/d/${status.sheetId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline font-mono"
          >
            {status.sheetId}
          </a>
        </div>
      )}
      {status?.lastBackup && (
        <div className="text-xs text-gray-400">
          Last backup: <span className="text-gray-300">{formatRelTime(status.lastBackup)}</span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={handleBackup}
          disabled={backing || !status?.hasSheet}
          className="px-3 py-1.5 text-xs font-medium rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
        >
          {backing ? 'Backing up...' : 'Backup Now'}
        </button>
        {!confirmRestore ? (
          <button
            onClick={() => setConfirmRestore(true)}
            disabled={restoring || !status?.hasSheet}
            className="px-3 py-1.5 text-xs font-medium rounded bg-yellow-700 hover:bg-yellow-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
          >
            Restore from Backup
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-yellow-400">This will overwrite current config. Continue?</span>
            <button
              onClick={handleRestore}
              disabled={restoring}
              className="px-3 py-1.5 text-xs font-medium rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white transition-colors"
            >
              {restoring ? 'Restoring...' : 'Yes, Restore'}
            </button>
            <button
              onClick={() => setConfirmRestore(false)}
              className="px-3 py-1.5 text-xs font-medium rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
      {result && (
        <div className={`text-xs ${result.ok ? 'text-green-400' : 'text-red-400'}`}>{result.detail}</div>
      )}
    </div>
  )
}

// ── Main Panel ─────────────────────────────────────────────────────────────────

export function SettingsPanel() {
  const [adminEnabledRegions, setAdminEnabledRegions] = useState<string[] | undefined>(undefined)
  const [adminEnabledPods, setAdminEnabledPods] = useState<string[] | undefined>(undefined)

  // Load region access settings
  useEffect(() => {
    fetch('/api/regions/access')
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.enabledRegions)) setAdminEnabledRegions(d.enabledRegions)
        if (Array.isArray(d.enabledPods)) setAdminEnabledPods(d.enabledPods)
      })
      .catch(() => {})
  }, [])

  return (
    <div className="space-y-3">
      <CollapsibleSection title="AI Settings">
        <AiSettingsSection />
      </CollapsibleSection>

      <CollapsibleSection title="Scheduler Config">
        <SchedulerConfigSection />
      </CollapsibleSection>

      <CollapsibleSection title="Region Access">
        <div className="mt-4">
          <Step0RegionAccess
            initialEnabledRegions={adminEnabledRegions}
            initialEnabledPods={adminEnabledPods}
            onSave={(regions, pods) => {
              setAdminEnabledRegions(regions)
              setAdminEnabledPods(pods)
            }}
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Config Backup">
        <ConfigBackupSection />
      </CollapsibleSection>
    </div>
  )
}
