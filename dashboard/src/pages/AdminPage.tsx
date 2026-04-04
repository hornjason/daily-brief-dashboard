import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, X } from 'lucide-react'
import { formatRelTime } from '../lib/format'
import { SessionHealthPanel } from '../components/SessionHealthPanel'

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
  browserRestartNeeded?: boolean
}

interface RefreshIntervals {
  subscriptions: number
  ccsp: number
  rhScrape: number
}

// BKL-M52: Gemini cost summary from /api/admin/gemini-usage
interface GeminiUsageSummary {
  todayInputTokens: number
  todayOutputTokens: number
  todayCostUsd: number
  monthInputTokens: number
  monthOutputTokens: number
  monthCostUsd: number
  totalCalls: number
  byCallType: Record<string, { inputTokens: number; outputTokens: number; calls: number; costUsd: number }>
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
  subtitle,
  status,
  onRunNow,
  running,
  circuitBreaker,
  queuePending,
}: {
  label: string
  subtitle?: string
  status: ScrapeStatus | null
  onRunNow: () => void
  running: boolean
  circuitBreaker?: CircuitBreakerState
  /** true = pending (generic), string = pending with detail (e.g. "waiting on supportable") */
  queuePending?: boolean | string
}) {
  const busy = running || status?.isRunning

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div>
            <span className="text-sm font-medium text-gray-200">{label}</span>
            {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
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
            {typeof queuePending === 'string'
              ? `Queued — ${queuePending}`
              : 'Queued — waiting for other scraper to finish'}
          </div>
        )}
        {status?.lastError && !status?.isRunning && (
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
          <span className="text-sm font-medium text-gray-200">Supportable Full Bootstrap</span>
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

// ── Intelligence job status types ─────────────────────────────────────────────

interface IntelligenceJobStatus {
  status: 'idle' | 'running' | 'complete' | 'error'
  step?: string
  customerName?: string
  completedAt?: string
  error?: string
}

const INTEL_STEPS = [
  { label: 'Identifying Industry', matchKey: 'identifying industry' },
  { label: 'Generating Intelligence', matchKey: 'generating' },
  { label: 'Writing to Drive', matchKey: 'writing docs to Drive' },
]

function IntelligenceStepperSection({ jobStatus }: { jobStatus: IntelligenceJobStatus | null }) {
  if (!jobStatus || jobStatus.status !== 'running') return null

  const currentStepIndex = INTEL_STEPS.findIndex(s => jobStatus.step?.toLowerCase().includes(s.matchKey.toLowerCase()))
  const activeStep = currentStepIndex >= 0 ? currentStepIndex : 0

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
        <span className="text-sm font-medium text-gray-200">Intelligence Generation Running</span>
        {jobStatus.customerName && (
          <span className="text-xs text-gray-400">— {jobStatus.customerName}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {INTEL_STEPS.map((step, i) => {
          const isComplete = i < activeStep
          const isActive = i === activeStep
          const isFuture = i > activeStep
          return (
            <div key={step.label} className="flex items-center gap-2 flex-1 min-w-0">
              <div className={`flex items-center gap-1.5 flex-1 min-w-0 ${isFuture ? 'opacity-40' : ''}`}>
                <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold border ${
                  isComplete
                    ? 'bg-green-700 border-green-600 text-white'
                    : isActive
                    ? 'bg-yellow-500/20 border-yellow-500 text-yellow-400'
                    : 'bg-gray-700 border-gray-600 text-gray-500'
                }`}>
                  {isComplete ? '✓' : i + 1}
                </div>
                <span className={`text-xs truncate ${
                  isComplete ? 'text-green-400' : isActive ? 'text-yellow-400 font-medium' : 'text-gray-500'
                }`}>
                  {step.label}
                </span>
              </div>
              {i < INTEL_STEPS.length - 1 && (
                <div className={`w-4 h-px shrink-0 ${i < activeStep ? 'bg-green-600' : 'bg-gray-600'}`} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── BKL-M50e: Scrape history section ─────────────────────────────���─────────────

// ── BKL-AI06: Batch intelligence generation section ──────────────────────────

interface BatchIntelState {
  running: boolean
  total: number
  completed: number
  failed: number
  current: string | null
  startedAt: string | null
  completedAt: string | null
  errors: { customer: string; error: string }[]
  // BKL-M53: server-computed ETA fields
  elapsedSeconds?: number | null
  estimatedSecondsRemaining?: number | null
  percentComplete?: number
}

// ── BKL-AI13: NotebookLM Admin Section ────────────────────────────────────────

function NotebookLMSection() {
  const [status, setStatus] = useState<{ enabled: boolean } | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ created: number; failed: number } | null>(null)

  useEffect(() => {
    fetch('/api/notebooklm/status').then(r => r.json()).then(setStatus).catch(() => {})
  }, [])

  const handleCreateAll = async () => {
    setRunning(true)
    setResult(null)
    try {
      const r = await fetch('/api/admin/notebooks/create-all', { method: 'POST' })
      const d = await r.json()
      setResult(d)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="text-sm font-medium text-gray-200">NotebookLM Notebooks</span>
          <p className="text-xs text-gray-500 mt-0.5">Create or update per-customer NotebookLM notebooks from Drive sources</p>
        </div>
        <button
          onClick={handleCreateAll}
          disabled={running || !status?.enabled}
          title={!status?.enabled ? 'Set NOTEBOOKLM_ENABLED=true in .env to enable' : undefined}
          className="px-3 py-1.5 text-xs font-medium rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors shrink-0"
        >
          {running ? 'Running...' : 'Create All Notebooks'}
        </button>
      </div>
      <div className="text-xs text-gray-500">
        {status === null && 'Loading...'}
        {status && !status.enabled && 'NotebookLM disabled — set NOTEBOOKLM_ENABLED=true in .env to enable'}
        {status?.enabled && !result && !running && 'Ready — click to create or sync all customer notebooks'}
        {running && <span className="text-yellow-400">Creating notebooks...</span>}
        {result && (
          <span>
            Done — <span className="text-gray-300">{result.created} created/updated</span>
            {result.failed > 0 && <span className="text-red-400 ml-1">({result.failed} failed)</span>}
          </span>
        )}
      </div>
    </div>
  )
}

function BatchIntelligenceSection() {
  const [batchState, setBatchState] = useState<BatchIntelState | null>(null)
  const [starting, setStarting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchBatchStatus = useCallback(async () => {
    try {
      const d = await fetch('/api/intelligence/generate-all/status').then(r => r.json())
      setBatchState(d)
    } catch {}
  }, [])

  useEffect(() => {
    fetchBatchStatus()
  }, [fetchBatchStatus])

  useEffect(() => {
    if (batchState?.running) {
      if (!pollRef.current) {
        pollRef.current = setInterval(fetchBatchStatus, 3_000)
      }
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [batchState?.running, fetchBatchStatus])

  const handleGenerate = async () => {
    setStarting(true)
    try {
      await fetch('/api/intelligence/generate-all', { method: 'POST' })
      await fetchBatchStatus()
    } finally {
      setStarting(false)
    }
  }

  const busy = starting || batchState?.running
  const pct = batchState && batchState.total > 0
    ? Math.round((batchState.completed / batchState.total) * 100)
    : 0

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="text-sm font-medium text-gray-200">Generate All Account Intelligence</span>
          <p className="text-xs text-gray-500 mt-0.5">Sequential Gemini pipeline for every customer (industry + company + Drive docs)</p>
        </div>
        <button
          onClick={handleGenerate}
          disabled={!!busy}
          className="px-3 py-1.5 text-xs font-medium rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors shrink-0"
        >
          {busy ? 'Running...' : 'Generate All'}
        </button>
      </div>
      <div className="space-y-2 text-xs text-gray-400">
        {batchState?.running && batchState.total > 0 && (
          <>
            <div className="flex items-center gap-1.5 text-yellow-400">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
              {batchState.completed} / {batchState.total} customers ({batchState.percentComplete ?? pct}%)
              {batchState.estimatedSecondsRemaining != null && batchState.estimatedSecondsRemaining > 0 && (
                <span className="ml-1 text-gray-400">
                  ~{batchState.estimatedSecondsRemaining >= 60
                    ? `${Math.ceil(batchState.estimatedSecondsRemaining / 60)} min`
                    : `${batchState.estimatedSecondsRemaining}s`} remaining
                </span>
              )}
            </div>
            <div className="w-full bg-gray-700 rounded-full h-1.5">
              <div
                className="bg-yellow-500 h-1.5 rounded-full transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            {batchState.current && (
              <div className="text-gray-300 truncate">Current: {batchState.current}</div>
            )}
          </>
        )}
        {!batchState?.running && batchState?.completedAt && (
          <div>
            Last run: <span className="text-gray-300">{formatRelTime(batchState.completedAt)}</span>
            {' '}&mdash; {batchState.completed - batchState.failed}/{batchState.total} succeeded
            {batchState.failed > 0 && (
              <span className="text-red-400 ml-1">({batchState.failed} failed)</span>
            )}
          </div>
        )}
        {!batchState?.running && !batchState?.completedAt && !batchState?.startedAt && (
          <div className="text-gray-500">Never run</div>
        )}
        {!batchState?.running && batchState?.errors && batchState.errors.length > 0 && (
          <div className="mt-1 space-y-1">
            {batchState.errors.map((err, i) => (
              <div key={i} className="text-red-400 truncate" title={err.error}>
                {err.customer}: {err.error}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── BKL-M50e: Scrape history section ─────────────────────────────────────────

interface ScrapeLogEntry {
  timestamp: string
  service: string
  durationMs: number
  recordCount: number
  status: 'success' | 'failure' | 'skipped' | 'timeout'
  error?: string
}

function ScrapeHistorySection() {
  const [history, setHistory] = useState<ScrapeLogEntry[]>([])

  useEffect(() => {
    fetch('/api/status/telemetry/history')
      .then(r => r.json())
      .then((d: Record<string, ScrapeLogEntry[]>) => {
        const all = Object.values(d).flat()
        all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        setHistory(all.slice(0, 50))
      })
      .catch(() => {})
  }, [])

  if (history.length === 0) return null

  const SERVICE_LABELS: Record<string, string> = {
    rh: 'RH Cases', ccsp: 'CCSP', supportable: 'Supportable', salesforce: 'Salesforce',
  }
  const STATUS_COLORS: Record<string, string> = {
    success: 'text-green-400', failure: 'text-red-400', skipped: 'text-yellow-400', timeout: 'text-orange-400',
  }

  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Scrape History</h2>
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-text-secondary">
              <th className="px-4 py-2 text-left font-medium">Time</th>
              <th className="px-4 py-2 text-left font-medium">Scraper</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium">Records</th>
              <th className="px-4 py-2 text-right font-medium">Duration</th>
              <th className="px-4 py-2 text-left font-medium">Error</th>
            </tr>
          </thead>
          <tbody>
            {history.map((row, i) => (
              <tr key={i} className="border-b border-border/40 last:border-0 hover:bg-white/5">
                <td className="px-4 py-2 text-text-secondary whitespace-nowrap">{formatRelTime(row.timestamp)}</td>
                <td className="px-4 py-2 text-text-primary">{SERVICE_LABELS[row.service] ?? row.service}</td>
                <td className={`px-4 py-2 font-medium ${STATUS_COLORS[row.status] ?? 'text-text-secondary'}`}>{row.status}</td>
                <td className="px-4 py-2 text-right text-text-secondary">{row.recordCount}</td>
                <td className="px-4 py-2 text-right text-text-secondary whitespace-nowrap">
                  {row.durationMs >= 60000
                    ? `${Math.round(row.durationMs / 60000)}m`
                    : `${Math.round(row.durationMs / 1000)}s`}
                </td>
                <td className="px-4 py-2 text-text-secondary truncate max-w-[200px]">{row.error ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Admin page ────────────────────────────────��────────────────────────────────

export function AdminPage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<AllScrapeStatus | null>(null)
  const [intervals, setIntervals] = useState<RefreshIntervals | null>(null)
  const [schedulerCfg, setSchedulerCfg] = useState<SchedulerCfg | null>(null)
  const [triggerBusy, setTriggerBusy] = useState<Record<string, boolean>>({})
  // BKL-G21: immediate queued state set from POST response before polling catches up
  const [localQueued, setLocalQueued] = useState<Record<string, string | true>>({})
  // BKL-W2-13: browser crash banner dismissal
  const [browserCrashDismissed, setBrowserCrashDismissed] = useState(false)
  // BKL-M52: Gemini cost tracking
  const [geminiUsage, setGeminiUsage] = useState<GeminiUsageSummary | null>(null)
  // Intelligence job status
  const [intelJobStatus, setIntelJobStatus] = useState<IntelligenceJobStatus | null>(null)
  // localQueued value: true = queued (no detail), or string = "waiting on <scraper>"

  const fetchStatus = useCallback(async () => {
    try {
      const d = await fetch('/api/scraper-status').then(r => r.json())
      // Map unified /api/scraper-status response shape to AllScrapeStatus
      const scrapers = d.scrapers ?? {}
      const mapped: AllScrapeStatus = {
        rh: {
          isRunning: scrapers['rh-cases']?.state === 'running',
          lastSync:  scrapers['rh-cases']?.lastSuccess ?? null,
          lastError: scrapers['rh-cases']?.lastError ?? null,
        },
        supportable: {
          isRunning: scrapers['supportable']?.state === 'running',
          lastSync:  scrapers['supportable']?.lastSuccess ?? null,
          lastError: scrapers['supportable']?.lastError ?? null,
        },
        ccsp: {
          isRunning: scrapers['ccsp']?.state === 'running',
          lastSync:  scrapers['ccsp']?.lastSuccess ?? null,
          lastError: scrapers['ccsp']?.lastError ?? null,
        },
        salesforce: {
          isRunning: scrapers['sf-pipeline']?.state === 'running',
          lastSync:  scrapers['sf-pipeline']?.lastSuccess ?? null,
          lastError: scrapers['sf-pipeline']?.lastError ?? null,
        },
        circuitBreakers: d.circuitBreakers,
        queue: d.queue,
        browserRestartNeeded: d.browserRestartNeeded,
      }
      setStatus(mapped)
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

  // BKL-M52: fetch Gemini usage on mount
  useEffect(() => {
    fetch('/api/admin/gemini-usage')
      .then(r => r.json())
      .then((d: GeminiUsageSummary) => setGeminiUsage(d))
      .catch(() => {})
  }, [])

  // Intelligence job status polling (every 3s when running)
  useEffect(() => {
    let pollInterval: ReturnType<typeof setInterval> | null = null

    const fetchIntelStatus = () => {
      fetch('/api/intelligence/status')
        .then(r => r.json())
        .then((d: IntelligenceJobStatus) => {
          setIntelJobStatus(d)
          if (d.status !== 'running' && pollInterval) {
            clearInterval(pollInterval)
            pollInterval = null
          }
        })
        .catch(() => {})
    }

    fetchIntelStatus()
    pollInterval = setInterval(fetchIntelStatus, 3_000)
    return () => { if (pollInterval) clearInterval(pollInterval) }
  }, [])

  // BKL-G21: clear localQueued entries once polling confirms the scraper is running
  // or it's no longer in the queue's pending list (completed / dropped)
  useEffect(() => {
    if (!status) return
    const pendingInQueue = status.queue?.pending ?? []
    // Map UI key → scraper queue name
    const keyToQueueName: Record<string, string> = {
      rh: 'rh-cases',
      supportable: 'supportable',
      ccsp: 'ccsp',
      salesforce: 'sf-pipeline',
    }
    setLocalQueued(prev => {
      const next = { ...prev }
      let changed = false
      for (const [key, queueName] of Object.entries(keyToQueueName)) {
        if (next[key] !== undefined) {
          const isActuallyRunning = status[key as keyof AllScrapeStatus] !== undefined
            && (status[key as keyof AllScrapeStatus] as ScrapeStatus)?.isRunning
          const stillPending = pendingInQueue.includes(queueName)
          if (isActuallyRunning || !stillPending) {
            delete next[key]
            changed = true
          }
        }
      }
      return changed ? next : prev
    })
  }, [status])

  const runScrape = useCallback(async (key: string, endpoint: string) => {
    setTriggerBusy(b => ({ ...b, [key]: true }))
    try {
      const res = await fetch(endpoint, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      // BKL-G21: if the API queued the task, show "Queued" state immediately without
      // waiting for the next poll cycle. Clear localQueued when polling detects actual running.
      if (data?.queued === true) {
        const runningName = status?.queue?.running ?? null
        setLocalQueued(q => ({ ...q, [key]: runningName ? `waiting on ${runningName}` : true }))
      }
      await fetchStatus()
    } finally {
      setTriggerBusy(b => ({ ...b, [key]: false }))
    }
  }, [fetchStatus, status?.queue?.running])

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

        {/* BKL-W2-13: Browser crash banner */}
        {status?.browserRestartNeeded && !browserCrashDismissed && (
          <div className="flex items-start gap-3 bg-red-900/30 border border-red-700/40 rounded-lg px-4 py-3">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-red-400">Browser context crashed</p>
              <p className="text-xs text-gray-400 mt-0.5">Scrapers cannot run. Restart the container to recover: <code className="bg-gray-700/60 px-1 py-0.5 rounded text-xs font-mono">make rebuild</code></p>
            </div>
            <button
              onClick={() => setBrowserCrashDismissed(true)}
              className="shrink-0 text-gray-500 hover:text-gray-300 transition-colors"
              aria-label="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* BKL-M50d: Data Source Health panel */}
        <SessionHealthPanel />

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
              queuePending={localQueued['rh'] ?? status?.queue?.pending?.includes('rh-cases')}
            />
            <ScrapeSection
              label="Supportable Discovery + Sync"
              subtitle="Full discovery + scrape from source for all AEs"
              status={status?.supportable ?? null}
              running={!!triggerBusy['supportable']}
              onRunNow={() => runScrape('supportable', '/api/scrape/supportable/discover')}
              circuitBreaker={status?.circuitBreakers?.supportable}
              queuePending={localQueued['supportable'] ?? status?.queue?.pending?.includes('supportable')}
            />
            <ScrapeSection
              label="CCSP"
              status={status?.ccsp ?? null}
              running={!!triggerBusy['ccsp']}
              onRunNow={() => runScrape('ccsp', '/api/scrape/ccsp')}
              circuitBreaker={status?.circuitBreakers?.ccsp}
              queuePending={localQueued['ccsp'] ?? status?.queue?.pending?.includes('ccsp')}
            />
            <ScrapeSection
              label="SF Pipeline"
              status={status?.salesforce ?? null}
              running={!!triggerBusy['salesforce']}
              onRunNow={() => runScrape('salesforce', '/api/scrape/salesforce')}
              circuitBreaker={status?.circuitBreakers?.salesforce}
              queuePending={localQueued['salesforce'] ?? status?.queue?.pending?.includes('sf-pipeline')}
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

        {/* Gemini API cost tracking (BKL-M52) */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Gemini API Usage</h2>
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
            {geminiUsage === null ? (
              <div className="text-xs text-gray-500">Loading...</div>
            ) : geminiUsage.totalCalls === 0 ? (
              <div className="text-xs text-gray-500">No Gemini calls recorded yet this session</div>
            ) : (
              <div className="space-y-2 text-xs text-gray-400">
                <div className="flex justify-between">
                  <span>Today</span>
                  <span className="text-gray-200 tabular-nums">
                    {(geminiUsage.todayInputTokens + geminiUsage.todayOutputTokens).toLocaleString()} tokens
                    &nbsp;·&nbsp;
                    <span className="text-yellow-400">${geminiUsage.todayCostUsd.toFixed(4)}</span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>This month</span>
                  <span className="text-gray-200 tabular-nums">
                    {(geminiUsage.monthInputTokens + geminiUsage.monthOutputTokens).toLocaleString()} tokens
                    &nbsp;·&nbsp;
                    <span className="text-yellow-400">${geminiUsage.monthCostUsd.toFixed(4)}</span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Total calls this session</span>
                  <span className="text-gray-200 tabular-nums">{geminiUsage.totalCalls}</span>
                </div>
                {Object.keys(geminiUsage.byCallType).length > 0 && (
                  <div className="pt-1 border-t border-gray-700 space-y-1">
                    {Object.entries(geminiUsage.byCallType)
                      .sort((a, b) => b[1].costUsd - a[1].costUsd)
                      .map(([type, stats]) => (
                        <div key={type} className="flex justify-between">
                          <span className="text-gray-500">{type}</span>
                          <span className="tabular-nums text-gray-400">
                            {stats.calls} calls · ${stats.costUsd.toFixed(4)}
                          </span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Intelligence job progress stepper */}
        {intelJobStatus?.status === 'running' && (
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Intelligence Generation</h2>
            <IntelligenceStepperSection jobStatus={intelJobStatus} />
          </div>
        )}

        {/* BKL-AI06: Batch intelligence generation */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Account Intelligence</h2>
          <BatchIntelligenceSection />
        </div>

        {/* BKL-AI13: NotebookLM batch create */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">NotebookLM</h2>
          <NotebookLMSection />
        </div>

        {/* BKL-M50e: Scrape History */}
        <ScrapeHistorySection />

      </div>
    </div>
  )
}
