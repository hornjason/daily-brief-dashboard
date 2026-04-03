import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatRelTime } from '../lib/format'

// ── Types ──────────────────────────────────────────────────────────────────────

interface InitialLoadStatus {
  running: boolean
  currentCustomer: string | null
  completedCount: number
  totalCount: number
  errors: { customer: string; message: string }[]
  startedAt: string | null
  completedAt: string | null
}

interface ScrapeStatus {
  isRunning: boolean
  lastSync: string | null
  lastError: string | null
}

interface CircuitBreakerState {
  name: string
  state: 'closed' | 'open' | 'half-open'
  failures: number
  lastFailure: string | null
}

interface AllScrapeStatus {
  rh: ScrapeStatus
  supportable: ScrapeStatus
  ccsp: ScrapeStatus
  salesforce: ScrapeStatus
  circuitBreakers?: Record<string, CircuitBreakerState>
  queue?: { running: string | null; pending: string[]; isAnyRunning: boolean }
}

interface RefreshIntervals {
  subscriptions: number
  ccsp: number
  rhScrape: number
}

interface SchedulerCfg {
  ccspTime: string
  supportableTime: string
  territoryTime: string
  sfPipelineTime: string
  ccspEnabled: boolean
  supportableEnabled: boolean
  territoryEnabled: boolean
  sfPipelineEnabled: boolean
  rhEnabled: boolean
  ccspLastRun: string | null
  supportableLastRun: string | null
  territoryLastRun: string | null
  sfPipelineLastRun: string | null
  rhLastRun: string | null
}

// ── Scrape source section ──────────────────────────────────────────────────────

function ScrapeSection({
  label,
  status,
  onRunNow,
  running,
  circuitBreaker,
  queuePending,
}: {
  label: string
  status: ScrapeStatus | null
  onRunNow: () => void
  running: boolean
  circuitBreaker?: CircuitBreakerState
  queuePending?: boolean
}) {
  const busy = running || status?.isRunning

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-200">{label}</span>
          {circuitBreaker && circuitBreaker.state !== 'closed' && (
            <span
              className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${
                circuitBreaker.state === 'open' ? 'bg-red-900/60 text-red-400' : 'bg-yellow-900/60 text-yellow-400'
              }`}
              title={circuitBreaker.lastFailure ?? undefined}
            >
              {circuitBreaker.state === 'open' ? `BREAKER OPEN (${circuitBreaker.failures})` : 'HALF-OPEN'}
            </span>
          )}
        </div>
        <button
          onClick={onRunNow}
          disabled={!!busy || !!queuePending}
          className="px-3 py-1.5 text-xs font-medium rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
        >
          {busy ? 'Running…' : queuePending ? 'Queued…' : circuitBreaker?.state === 'open' ? 'Force Run' : 'Run Now'}
        </button>
      </div>
      <div className="space-y-1 text-xs text-gray-400">
        {status?.lastSync && (
          <div>Last run: <span className="text-gray-300">{formatRelTime(status.lastSync)}</span></div>
        )}
        {!status?.lastSync && <div className="text-gray-500">Never run</div>}
        {status?.isRunning && (
          <div className="flex items-center gap-1.5 text-yellow-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
            In progress
          </div>
        )}
        {queuePending && !status?.isRunning && (
          <div className="flex items-center gap-1.5 text-blue-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            Queued — waiting for other scraper to finish
          </div>
        )}
        {status?.lastError && (
          <div className="text-red-400 truncate" title={status.lastError}>Error: {status.lastError}</div>
        )}
        {circuitBreaker?.state === 'open' && circuitBreaker.lastFailure && (
          <div className="text-red-400/80 truncate" title={circuitBreaker.lastFailure}>
            Last failure: {circuitBreaker.lastFailure}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Source schedule row ────────────────────────────────────────────────────────

interface SourceScheduleRowProps {
  label: string
  timeKey: string
  enabledKey: string
  floorHint: string
  schedCfg: SchedulerCfg
  onSave: (fields: Record<string, unknown>) => Promise<string | null>
  isInterval?: boolean
}

function SourceScheduleRow({ label, timeKey, enabledKey, floorHint, schedCfg, onSave, isInterval }: SourceScheduleRowProps) {
  const currentTime = (schedCfg as any)[timeKey] as string ?? ''
  const currentEnabled = (schedCfg as any)[enabledKey] as boolean ?? true
  const [timeVal, setTimeVal] = useState(currentTime)
  const [enabled, setEnabled] = useState(currentEnabled)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setTimeVal((schedCfg as any)[timeKey] ?? '')
    setEnabled((schedCfg as any)[enabledKey] ?? true)
  }, [schedCfg, timeKey, enabledKey])

  const handleSave = async () => {
    setError(null)
    setSaving(true)
    const fields: Record<string, unknown> = { [enabledKey]: enabled }
    if (!isInterval) fields[timeKey] = timeVal
    const err = await onSave(fields)
    setSaving(false)
    if (err) { setError(err) } else { setSaved(true); setTimeout(() => setSaved(false), 2000) }
  }

  return (
    <div className="flex items-start gap-3 py-2">
      <label className="flex items-center gap-2 w-40 shrink-0">
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => { setEnabled(e.target.checked); setSaved(false); setError(null) }}
          className="rounded border-gray-600 bg-gray-700 text-red-600 focus:ring-0 focus:ring-offset-0"
        />
        <span className="text-xs text-gray-300">{label}</span>
      </label>
      {!isInterval && (
        <div className="flex flex-col">
          <input
            type="text"
            placeholder="HH:MM"
            value={timeVal}
            onChange={e => { setTimeVal(e.target.value); setSaved(false); setError(null) }}
            className="w-20 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-gray-400"
          />
          <span className="text-[10px] text-gray-500 mt-0.5">{floorHint}</span>
        </div>
      )}
      {isInterval && <span className="text-xs text-gray-500 pt-1">{floorHint}</span>}
      <button
        onClick={handleSave}
        disabled={saving}
        className="px-2.5 py-1 text-xs font-medium rounded bg-gray-600 hover:bg-gray-500 disabled:opacity-40 text-white transition-colors shrink-0"
      >
        {saving ? '...' : saved ? 'Saved' : 'Save'}
      </button>
      {error && <span className="text-[10px] text-red-400 pt-1">{error}</span>}
    </div>
  )
}

// ── Scheduler config section ───────────────────────────────────────────────────

function SchedulerConfig({
  intervals,
  schedulerCfg,
  onSave,
}: {
  intervals: RefreshIntervals | null
  schedulerCfg: SchedulerCfg | null
  onSave: (fields: Record<string, unknown>) => Promise<string | null>
}) {
  const [rhMinutes, setRhMinutes] = useState<string>('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (intervals) setRhMinutes(String(intervals.rhScrape))
  }, [intervals])

  const handleRhSave = async () => {
    setSaveError(null)
    const val = parseInt(rhMinutes, 10)
    if (!Number.isFinite(val) || val < 30) {
      setSaveError('rhScrape minimum is 30 minutes')
      return
    }
    setSaving(true)
    const err = await onSave({ rhScrape: val })
    setSaving(false)
    if (err) { setSaveError(err) } else { setSaved(true); setTimeout(() => setSaved(false), 2000) }
  }

  const cfg = schedulerCfg ?? {
    ccspTime: '06:30', supportableTime: '07:00', territoryTime: '01:45', sfPipelineTime: '02:00',
    ccspEnabled: true, supportableEnabled: true, territoryEnabled: true, sfPipelineEnabled: true, rhEnabled: true,
    ccspLastRun: null, supportableLastRun: null, territoryLastRun: null, sfPipelineLastRun: null, rhLastRun: null,
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <h3 className="text-sm font-medium text-gray-200 mb-4">Scheduler Config</h3>
      <div className="space-y-1 divide-y divide-gray-700/50">
        <SourceScheduleRow label="CCSP" timeKey="ccspTime" enabledKey="ccspEnabled" floorHint="Min 6h between runs" schedCfg={cfg} onSave={onSave} />
        <SourceScheduleRow label="Supportable" timeKey="supportableTime" enabledKey="supportableEnabled" floorHint="Min 12h between runs" schedCfg={cfg} onSave={onSave} />
        <SourceScheduleRow label="Territory" timeKey="territoryTime" enabledKey="territoryEnabled" floorHint="Min 6h between runs" schedCfg={cfg} onSave={onSave} />
        <SourceScheduleRow label="SF Pipeline" timeKey="sfPipelineTime" enabledKey="sfPipelineEnabled" floorHint="Min 12h between runs" schedCfg={cfg} onSave={onSave} />
        <div className="flex items-center gap-3 py-2">
          <label className="text-xs text-gray-400 w-40 shrink-0">
            RH Cases interval
            <span className="block text-gray-500">30 min floor</span>
          </label>
          <input
            type="number"
            min={30}
            value={rhMinutes}
            onChange={e => { setRhMinutes(e.target.value); setSaveError(null); setSaved(false) }}
            className="w-20 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-gray-400"
          />
          <span className="text-xs text-gray-500">min</span>
          <button
            onClick={handleRhSave}
            disabled={saving}
            className="px-2.5 py-1 text-xs font-medium rounded bg-gray-600 hover:bg-gray-500 disabled:opacity-40 text-white transition-colors"
          >
            {saving ? '...' : saved ? 'Saved' : 'Save'}
          </button>
          {saveError && <span className="text-[10px] text-red-400">{saveError}</span>}
        </div>
        {schedulerCfg && (
          <SourceScheduleRow label="RH Cases" timeKey="rhScrape" enabledKey="rhEnabled" floorHint="Interval-based (see above)" schedCfg={cfg} onSave={onSave} isInterval />
        )}
      </div>
    </div>
  )
}

// ── Initial load section ───────────────────────────────────────────────────────

function InitialLoadSection({ scrapeRunning }: { scrapeRunning: boolean }) {
  const [loadStatus, setLoadStatus] = useState<InitialLoadStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchLoadStatus = useCallback(async () => {
    try {
      const d = await fetch('/api/bootstrap/initial-load/status').then(r => r.json())
      setLoadStatus(d)
    } catch {}
  }, [])

  useEffect(() => {
    fetchLoadStatus()
  }, [fetchLoadStatus])

  useEffect(() => {
    if (loadStatus?.running) {
      if (!pollRef.current) {
        pollRef.current = setInterval(fetchLoadStatus, 5_000)
      }
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [loadStatus?.running, fetchLoadStatus])

  const handleRun = async () => {
    setStarting(true)
    try {
      await fetch('/api/bootstrap/initial-load', { method: 'POST' })
      await fetchLoadStatus()
      pollRef.current = setInterval(fetchLoadStatus, 5_000)
    } finally {
      setStarting(false)
    }
  }

  const busy = starting || loadStatus?.running
  const disabled = !!busy || scrapeRunning

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="text-sm font-medium text-gray-200">Scrape Subscriptions (Full Reload)</span>
          <p className="text-xs text-gray-500 mt-0.5">Crash-safe full load — resumes from last completed customer</p>
        </div>
        <button
          onClick={handleRun}
          disabled={disabled}
          className="px-3 py-1.5 text-xs font-medium rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors shrink-0"
        >
          {busy ? 'Running…' : 'Run'}
        </button>
      </div>
      <div className="space-y-1 text-xs text-gray-400">
        {loadStatus?.running && loadStatus.totalCount > 0 && (
          <div className="flex items-center gap-1.5 text-yellow-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
            {loadStatus.completedCount} / {loadStatus.totalCount} customers complete
          </div>
        )}
        {loadStatus?.running && loadStatus.currentCustomer && (
          <div className="text-gray-300 truncate">Current: {loadStatus.currentCustomer}</div>
        )}
        {!loadStatus?.running && loadStatus?.completedAt && (
          <div>Last run: <span className="text-gray-300">{formatRelTime(loadStatus.completedAt)}</span>
            {loadStatus.errors.length > 0 && (
              <span className="text-red-400 ml-2">({loadStatus.errors.length} error{loadStatus.errors.length !== 1 ? 's' : ''})</span>
            )}
          </div>
        )}
        {!loadStatus?.running && !loadStatus?.completedAt && (
          <div className="text-gray-500">Never run</div>
        )}
        {scrapeRunning && !loadStatus?.running && (
          <div className="text-yellow-600">Supportable scrape in progress — wait to finish before running initial load</div>
        )}
      </div>
    </div>
  )
}

// ── Admin page ─────────────────────────────────────────────────────────────────

export function AdminPage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<AllScrapeStatus | null>(null)
  const [intervals, setIntervals] = useState<RefreshIntervals | null>(null)
  const [schedulerCfg, setSchedulerCfg] = useState<SchedulerCfg | null>(null)
  const [triggerBusy, setTriggerBusy] = useState<Record<string, boolean>>({})

  const fetchStatus = useCallback(async () => {
    try {
      const d = await fetch('/api/status/scrapes').then(r => r.json())
      setStatus(d)
    } catch {}
  }, [])

  const fetchIntervals = useCallback(async () => {
    try {
      const d = await fetch('/api/settings/refresh').then(r => r.json())
      setIntervals(d.intervals)
      if (d.schedulerConfig) setSchedulerCfg(d.schedulerConfig)
    } catch {}
  }, [])

  useEffect(() => {
    fetchStatus()
    fetchIntervals()
    const poll = setInterval(fetchStatus, 5_000)
    return () => clearInterval(poll)
  }, [fetchStatus, fetchIntervals])

  const runScrape = useCallback(async (key: string, endpoint: string) => {
    setTriggerBusy(b => ({ ...b, [key]: true }))
    try {
      await fetch(endpoint, { method: 'POST' })
      await fetchStatus()
    } finally {
      setTriggerBusy(b => ({ ...b, [key]: false }))
    }
  }, [fetchStatus])

  const saveSettings = useCallback(async (fields: Record<string, unknown>): Promise<string | null> => {
    try {
      const res = await fetch('/api/settings/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      const d = await res.json()
      if (d.error) return d.error
      if (d.intervals) setIntervals(d.intervals)
      if (d.schedulerConfig) setSchedulerCfg(d.schedulerConfig)
      return null
    } catch {
      return 'Save failed — check server logs.'
    }
  }, [])

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-6">
      <div className="max-w-2xl mx-auto space-y-6">

        {/* Header */}
        <div>
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold text-gray-100">Admin</h1>
            <button
              onClick={() => navigate('/dashboard/setup')}
              className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
            >
              ← Back to Setup
            </button>
          </div>
          <div className="mt-2 bg-red-900/50 border border-red-700/60 rounded-md px-4 py-2.5 text-xs text-red-300">
            <span className="font-semibold">Break-glass page.</span> Manual scrape triggers may take several minutes and require an active Red Hat Portal session. Not for normal use.
          </div>
        </div>

        {/* Manual scrape triggers */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Manual Scrape Triggers</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <ScrapeSection
              label="RH Cases"
              status={status?.rh ?? null}
              running={!!triggerBusy['rh']}
              onRunNow={() => runScrape('rh', '/api/scrape/rh')}
              circuitBreaker={status?.circuitBreakers?.rh}
              queuePending={status?.queue?.pending?.includes('rh-cases')}
            />
            <ScrapeSection
              label="Discover & Scrape Subscriptions"
              status={status?.supportable ?? null}
              running={!!triggerBusy['supportable']}
              onRunNow={() => runScrape('supportable', '/api/scrape/supportable/discover')}
              circuitBreaker={status?.circuitBreakers?.supportable}
              queuePending={status?.queue?.pending?.includes('supportable')}
            />
            <ScrapeSection
              label="CCSP"
              status={status?.ccsp ?? null}
              running={!!triggerBusy['ccsp']}
              onRunNow={() => runScrape('ccsp', '/api/scrape/ccsp')}
              circuitBreaker={status?.circuitBreakers?.ccsp}
              queuePending={status?.queue?.pending?.includes('ccsp')}
            />
            <ScrapeSection
              label="SF Pipeline"
              status={status?.salesforce ?? null}
              running={!!triggerBusy['salesforce']}
              onRunNow={() => runScrape('salesforce', '/api/scrape/salesforce')}
              circuitBreaker={status?.circuitBreakers?.salesforce}
              queuePending={status?.queue?.pending?.includes('sf-pipeline')}
            />
          </div>
        </div>

        {/* Initial load */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Initial Load</h2>
          <InitialLoadSection scrapeRunning={!!status?.supportable?.isRunning} />
        </div>

        {/* Scheduler config */}
        <SchedulerConfig intervals={intervals} schedulerCfg={schedulerCfg} onSave={saveSettings} />

      </div>
    </div>
  )
}
