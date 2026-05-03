import { useState, useEffect, useCallback, useRef, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, X } from 'lucide-react'
import { formatRelTime } from '../lib/format'
import { ProductSourcesAdmin } from '../components/ProductSourcesAdmin'
import { Step0RegionAccess } from '../components/Step0RegionAccess'
import { useApi } from '../hooks/useApi'

// ── Types ──────────────────────────────────────────────────────────────────────

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
  ccsp: ScrapeStatus
  circuitBreakers?: Record<string, CircuitBreakerState>
  queue?: { running: string | null; pending: string[]; isAnyRunning: boolean }
  browserRestartNeeded?: boolean
  rhDiscoveryProgress?: { done: number; total: number; current: string | null } | null
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
  rhEnabled: boolean
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
  extraActions,
}: {
  label: string
  subtitle?: string
  status: ScrapeStatus | null
  onRunNow: () => void
  running: boolean
  circuitBreaker?: CircuitBreakerState
  /** true = pending (generic), string = pending with detail (e.g. "waiting on ccsp") */
  queuePending?: boolean | string
  /** Optional extra action buttons rendered at the card bottom */
  extraActions?: ReactNode
}) {
  const busy = running || status?.isRunning

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div>
            <span className="text-sm font-medium text-gray-200">{label}</span>
            {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          {circuitBreaker && circuitBreaker.state !== 'closed' && (
            <span
              className={`px-1.5 py-0.5 text-signal font-medium rounded ${
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
          className="px-3 py-1.5 text-xs font-medium rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors whitespace-nowrap shrink-0"
        >
          {busy ? 'Running…' : queuePending ? 'Queued…' : circuitBreaker?.state === 'open' ? 'Force Run' : 'Run Now'}
        </button>
      </div>
      <div className="mt-auto space-y-1 text-xs text-gray-400">
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
      {extraActions && <div className="mt-3 pt-3 border-t border-gray-700">{extraActions}</div>}
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
      <label className="flex items-center gap-2 w-40 shrink-0 self-center">
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => { setEnabled(e.target.checked); setSaved(false); setError(null) }}
          className="rounded border-gray-600 bg-gray-700 text-red-600 focus:ring-0 focus:ring-offset-0"
        />
        <span className="text-xs text-gray-300">{label}</span>
      </label>
      <div className="flex-1 flex flex-col justify-center">
        {!isInterval && (
          <>
            <input
              type="text"
              placeholder="HH:MM"
              value={timeVal}
              onChange={e => { setTimeVal(e.target.value); setSaved(false); setError(null) }}
              className="w-20 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-gray-400"
            />
            <span className="text-xs text-gray-500 mt-0.5">{floorHint}</span>
          </>
        )}
        {isInterval && <span className="text-xs text-gray-500">{floorHint}</span>}
      </div>
      <button
        onClick={handleSave}
        disabled={saving}
        className="px-2.5 py-1 text-xs font-medium rounded bg-gray-600 hover:bg-gray-500 disabled:opacity-40 text-white transition-colors shrink-0 self-center ml-auto"
      >
        {saving ? '...' : saved ? 'Saved' : 'Save'}
      </button>
      {error && <span className="text-xs text-red-400 pt-1">{error}</span>}
    </div>
  )
}

// ── Scheduler config section ───────────────────────────────────────────────────

function SchedulerConfig({
  intervals,
  schedulerCfg,
  onSave,
  isL3Only = false,
}: {
  intervals: RefreshIntervals | null
  schedulerCfg: SchedulerCfg | null
  onSave: (fields: Record<string, unknown>) => Promise<string | null>
  isL3Only?: boolean
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
    rhEnabled: true,
    rhLastRun: null,
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="space-y-1 divide-y divide-gray-700/50">
        {/* BKL-HERO-13: RH Cases scheduler rows are L4-only */}
        {!isL3Only && <div className="flex items-center gap-3 py-2">
          <label className="text-xs text-gray-400 w-40 shrink-0">
            RH Cases interval
            <span className="block text-gray-500">30 min floor</span>
          </label>
          <div className="flex-1 flex items-center gap-1.5">
            <input
              type="number"
              min={30}
              value={rhMinutes}
              onChange={e => { setRhMinutes(e.target.value); setSaveError(null); setSaved(false) }}
              className="w-20 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-gray-400"
            />
            <span className="text-xs text-gray-500">min</span>
          </div>
          <button
            onClick={handleRhSave}
            disabled={saving}
            className="px-2.5 py-1 text-xs font-medium rounded bg-gray-600 hover:bg-gray-500 disabled:opacity-40 text-white transition-colors shrink-0 ml-auto"
          >
            {saving ? '...' : saved ? 'Saved' : 'Save'}
          </button>
          {saveError && <span className="text-xs text-red-400">{saveError}</span>}
        </div>}
        {!isL3Only && schedulerCfg && (
          <SourceScheduleRow label="RH Cases" timeKey="rhScrape" enabledKey="rhEnabled" floorHint="Interval-based (see above)" schedCfg={cfg} onSave={onSave} isInterval />
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
                <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-signal font-bold border ${
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
  // BKL-TEST-07: surface server failure (non-2xx, network) on the Generate All button
  // instead of the previous silent failure (button just stops spinning).
  const [startError, setStartError] = useState<string | null>(null)
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
    setStartError(null)
    try {
      const res = await fetch('/api/intelligence/generate-all', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }))
        setStartError((body as { error?: string }).error ?? `Failed to start (${res.status})`)
      }
      await fetchBatchStatus()
    } catch {
      setStartError('Failed to start — check server logs.')
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
        {startError && (
          <div data-testid="batch-intel-start-error" className="text-red-400" role="alert">
            {startError}
          </div>
        )}
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
              <div className="text-gray-300 truncate" title={batchState.current}>Current: {batchState.current}</div>
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

// ── BKL-INTEL-03: Validate & Repair intelligence docs ────────────────────────

function ValidateRepairSection() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ validated: number; flagged: number; requeued: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleValidate = async () => {
    setRunning(true)
    setResult(null)
    setError(null)
    try {
      const r = await fetch('/api/intelligence/validate-all', { method: 'POST' })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        throw new Error((err as { error?: string }).error ?? `Server error: ${r.status}`)
      }
      const d = await r.json()
      setResult(d)
    } catch (e: any) {
      setError(e?.message ?? 'Unknown error')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="text-sm font-medium text-gray-200">Validate & Repair Intelligence Docs</span>
          <p className="text-xs text-gray-500 mt-0.5">Scan all complete docs for thin content and re-queue any with fewer than 5 lines</p>
        </div>
        <button
          onClick={handleValidate}
          disabled={running}
          className="px-3 py-1.5 text-xs font-medium rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors shrink-0"
        >
          {running ? 'Validating...' : 'Validate & Repair'}
        </button>
      </div>
      <div className="text-xs text-gray-500">
        {!running && !result && !error && 'Ready — click to scan all completed intelligence docs'}
        {running && <span className="text-yellow-400">Validating intelligence docs...</span>}
        {error && <span data-testid="validate-error" className="text-red-400">Error: {error}</span>}
        {result && (
          <span>
            Validated <span className="text-gray-300">{result.validated} docs</span>
            {result.flagged > 0
              ? <span className="text-yellow-400 ml-1">— flagged {result.flagged} for re-generation</span>
              : <span className="text-green-400 ml-1">— all docs look healthy</span>
            }
          </span>
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

// ── BKL-BACKUP-01: Config Backup Section ────────────────────────────────────

interface BackupStatus {
  sheetId: string | null
  lastBackup: string | null
  hasSheet: boolean
}

function ConfigBackupSection() {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [backing, setBacking] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [result, setResult] = useState<{ type: 'backup' | 'restore'; ok: boolean; detail: string } | null>(null)

  const fetchStatus = useCallback(() => {
    fetch('/api/admin/backup/status')
      .then(r => r.json())
      .then(d => setStatus(d))
      .catch(() => {})
  }, [])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  const handleBackup = async () => {
    setBacking(true)
    setResult(null)
    try {
      const res = await fetch('/api/admin/backup', { method: 'POST' })
      const d = await res.json()
      setResult({ type: 'backup', ok: d.ok, detail: d.ok ? `Backed up at ${d.timestamp}` : (d.error ?? 'No backup sheet configured') })
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
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 space-y-3">
      {/* Sheet ID */}
      <div className="text-xs text-gray-400">
        Sheet ID:{' '}
        {status?.hasSheet ? (
          <a
            href={`https://docs.google.com/spreadsheets/d/${status.sheetId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline font-mono"
          >
            {status.sheetId}
          </a>
        ) : (
          <span className="text-gray-500">Not configured (will be created on next bootstrap)</span>
        )}
      </div>

      {/* Last backup */}
      {status?.lastBackup && (
        <div className="text-xs text-gray-400">
          Last backup: <span className="text-gray-300">{formatRelTime(status.lastBackup)}</span>
        </div>
      )}

      {/* Actions */}
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

      {/* Result */}
      {result && (
        <div className={`text-xs ${result.ok ? 'text-green-400' : 'text-red-400'}`}>
          {result.detail}
        </div>
      )}
    </div>
  )
}

// ── BKL-REG-03: Domain Inference section ─────────────────────────────────────

function DomainInferenceSection() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ autoSaved: number; needReview: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleRun = async () => {
    setRunning(true)
    setResult(null)
    setError(null)
    try {
      const res = await fetch('/api/setup/infer-domains', { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error ?? `Failed (${res.status})`)
        return
      }
      const d = await res.json()
      const results: { customerName: string; candidates: { domain: string; sources: string[]; tier?: number; verified?: boolean }[] }[] = d.results ?? []
      const total = results.length

      // High-confidence: top candidate has 'web' source OR tier 1/2
      const highConf: { name: string; domain: string }[] = []
      let needReview = 0
      for (const r of results) {
        if (!r.candidates?.length) continue
        const top = r.candidates[0]
        const isHighConf = top.sources?.includes('web') || top.tier === 1 || top.tier === 2
        if (isHighConf) {
          highConf.push({ name: r.customerName, domain: top.domain })
        } else {
          needReview++
        }
      }

      // Save high-confidence domains
      if (highConf.length > 0) {
        const saveRes = await fetch('/api/setup/save-domains', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domains: highConf.map(r => ({ name: r.name, domain: r.domain })) }),
        })
        if (!saveRes.ok) {
          const sd = await saveRes.json().catch(() => ({}))
          setError(`Inferred ${highConf.length} domains but save failed: ${sd.error ?? saveRes.status}`)
          return
        }
      }

      setResult({ autoSaved: highConf.length, needReview, total })
    } catch {
      setError('Network error — check server logs.')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Domain Inference</h2>
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-200">Run Domain Inference</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Infer customer email domains via Clearbit + LLM waterfall. Auto-saves high-confidence matches.
            </p>
          </div>
          <button
            onClick={handleRun}
            disabled={running}
            className="px-3 py-1.5 text-xs font-medium rounded bg-accent/20 text-accent hover:bg-accent/30 border border-accent/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running ? 'Running...' : 'Run Now'}
          </button>
        </div>

        {result && (
          <div className="text-xs text-gray-400 bg-gray-900/50 rounded px-3 py-2 space-y-0.5">
            <p><span className="text-green-400 font-medium">{result.autoSaved}</span> domains auto-saved</p>
            <p><span className="text-yellow-400 font-medium">{result.needReview}</span> need manual review</p>
            <p className="text-gray-500">{result.total} customers processed</p>
          </div>
        )}

        {error && (
          <div className="text-xs text-red-400 bg-red-900/20 border border-red-700/30 rounded px-3 py-2">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

function ScrapeHistorySection() {
  const [history, setHistory] = useState<ScrapeLogEntry[]>([])

  useEffect(() => {
    const load = () =>
      fetch('/api/status/telemetry/history')
        .then(r => r.json())
        .then((d: Record<string, ScrapeLogEntry[]>) => {
          // Take last 10 per service before merging so infrequent scrapers (CCSP) always appear
          const all = Object.values(d).flatMap((entries) =>
            [...entries].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 10)
          )
          all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          setHistory(all)
        })
        .catch(() => {})
    load()
    const interval = setInterval(load, 10_000)
    return () => clearInterval(interval)
  }, [])

  if (history.length === 0) return null

  const SERVICE_LABELS: Record<string, string> = {
    rh: 'RH Cases', ccsp: 'CCSP', salesforce: 'Salesforce',
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
                <td className="px-4 py-2 text-text-secondary truncate max-w-[200px]" title={row.error ?? undefined}>{row.error ?? '—'}</td>
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
  // BKL-HERO-09: gate break-glass banner behind !isL3Only
  const nodeRoleApi = useApi<{ isL3Only: boolean }>('/api/node-role')
  const isL3Only = nodeRoleApi.data?.isL3Only ?? true
  // BKL-HERO-02: Region Access section state — load saved selections
  const regionAccessApi = useApi<{ enabledRegions?: string[]; enabledPods?: string[] }>('/api/regions/access')
  const [adminEnabledRegions, setAdminEnabledRegions] = useState<string[] | undefined>(undefined)
  const [adminEnabledPods, setAdminEnabledPods] = useState<string[] | undefined>(undefined)
  useEffect(() => {
    const d = regionAccessApi.data
    if (!d) return
    if (Array.isArray(d.enabledRegions)) setAdminEnabledRegions(d.enabledRegions)
    if (Array.isArray(d.enabledPods)) setAdminEnabledPods(d.enabledPods)
  }, [regionAccessApi.data])
  const [status, setStatus] = useState<AllScrapeStatus | null>(null)
  const [intervals, setIntervals] = useState<RefreshIntervals | null>(null)
  const [schedulerCfg, setSchedulerCfg] = useState<SchedulerCfg | null>(null)
  const [triggerBusy, setTriggerBusy] = useState<Record<string, boolean>>({})
  // BKL-TEST-07: per-scraper trigger error surfacing. Previously a non-2xx response
  // from a scrape trigger left the user with no visible feedback; now we render
  // a per-key error message under the corresponding ScrapeSection card.
  const [triggerErrors, setTriggerErrors] = useState<Record<string, string>>({})
  // BKL-G21: immediate queued state set from POST response before polling catches up
  const [localQueued, setLocalQueued] = useState<Record<string, string | true>>({})
  // BKL-W2-13: browser crash banner dismissal
  const [browserCrashDismissed, setBrowserCrashDismissed] = useState(false)
  // BKL-M52: Gemini cost tracking
  const [geminiUsage, setGeminiUsage] = useState<GeminiUsageSummary | null>(null)
  // Intelligence job status
  const [intelJobStatus, setIntelJobStatus] = useState<IntelligenceJobStatus | null>(null)
  // Intelligence enabled toggle
  const [intelligenceEnabled, setIntelligenceEnabled] = useState<boolean | null>(null)
  const [intelligenceToggling, setIntelligenceToggling] = useState(false)
  // BKL-AI-COST-04: doc classify age limit
  const [docClassifyMaxAgeDays, setDocClassifyMaxAgeDays] = useState<number | null>(null)
  const [docAgeSaving, setDocAgeSaving] = useState(false)
  const [docAgeError, setDocAgeError] = useState<string | null>(null)
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
        ccsp: {
          isRunning: scrapers['ccsp']?.state === 'running',
          lastSync:  scrapers['ccsp']?.lastSuccess ?? null,
          lastError: scrapers['ccsp']?.lastError ?? null,
        },
        circuitBreakers: d.circuitBreakers,
        queue: d.queue,
        browserRestartNeeded: d.browserRestartNeeded,
      }
      mapped.rhDiscoveryProgress = d.rhDiscoveryProgress ?? null
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

  // Fetch AI config for intelligence toggle
  useEffect(() => {
    fetch('/api/settings/ai')
      .then(r => r.json())
      .then((d: { config: { intelligenceEnabled: boolean; docClassifyMaxAgeDays?: number } }) => {
        setIntelligenceEnabled(d.config.intelligenceEnabled ?? false)
        setDocClassifyMaxAgeDays(d.config.docClassifyMaxAgeDays ?? 0)
      })
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
      ccsp: 'ccsp',
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
    // BKL-TEST-07: clear any prior error for this key when retried
    setTriggerErrors(e => {
      if (e[key] === undefined) return e
      const next = { ...e }
      delete next[key]
      return next
    })
    try {
      const res = await fetch(endpoint, { method: 'POST' })
      const data = await res.json().catch(() => ({} as { queued?: boolean; error?: string }))
      if (!res.ok) {
        // BKL-TEST-07: surface non-2xx scrape trigger failures per-scraper
        const msg = (data as { error?: string })?.error ?? `Trigger failed (${res.status})`
        setTriggerErrors(e => ({ ...e, [key]: msg }))
        return
      }
      // BKL-G21: if the API queued the task, show "Queued" state immediately without
      // waiting for the next poll cycle. Clear localQueued when polling detects actual running.
      if ((data as { queued?: boolean })?.queued === true) {
        const runningName = status?.queue?.running ?? null
        setLocalQueued(q => ({ ...q, [key]: runningName ? `waiting on ${runningName}` : true }))
      }
      await fetchStatus()
    } catch {
      setTriggerErrors(e => ({ ...e, [key]: 'Trigger failed — network error.' }))
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
          {!isL3Only && (
            <div className="mt-2 bg-red-900/50 border border-red-700/60 rounded-md px-4 py-2.5 text-xs text-red-300">
              <span className="font-semibold">Break-glass page.</span> Manual scrape triggers may take several minutes and require an active Red Hat Portal session. Not for normal use.
            </div>
          )}
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

        {/* Manual scrape triggers — BKL-HERO-L3-EMPTY-SECTIONS: gate entire section on L4 */}
        {!isL3Only && <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Manual Scrape Triggers</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {/* BKL-HERO-11: RH Cases trigger only runs on L4 */}
            <div className="flex flex-col gap-1" data-testid="rh-cases-section">
              <ScrapeSection
                label="RH Cases"
                status={status?.rh ?? null}
                running={!!triggerBusy['rh']}
                onRunNow={() => runScrape('rh', '/api/scrape/rh')}
                circuitBreaker={status?.circuitBreakers?.rh}
                queuePending={localQueued['rh'] ?? status?.queue?.pending?.includes('rh-cases')}
                subtitle={
                  status?.rhDiscoveryProgress
                    ? `Discovering ${status.rhDiscoveryProgress.done}/${status.rhDiscoveryProgress.total}${status.rhDiscoveryProgress.current ? ` — ${status.rhDiscoveryProgress.current}` : ''}`
                    : undefined
                }
              />
              {triggerErrors['rh'] && (
                <div
                  data-testid="scrape-trigger-error-rh"
                  className="text-xs text-red-400 px-1"
                  role="alert"
                >
                  {triggerErrors['rh']}
                </div>
              )}
            </div>
          </div>
        </div>}

        {/* Scheduler config — BKL-HERO-L3-EMPTY-SECTIONS: gate entire section on L4 */}
        {!isL3Only && <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Scheduler Config</h2>
          <SchedulerConfig intervals={intervals} schedulerCfg={schedulerCfg} onSave={saveSettings} />
        </div>}

        {/* AI Settings — intelligence toggle */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">AI Settings</h2>
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-200">Intelligence Generation</p>
                <p className="text-xs text-gray-500 mt-0.5">Enable/disable Gemini account intelligence and briefs globally</p>
              </div>
              {intelligenceEnabled === null ? (
                <div className="text-xs text-gray-500">Loading...</div>
              ) : (
                <button
                  onClick={async () => {
                    setIntelligenceToggling(true)
                    try {
                      const newVal = !intelligenceEnabled
                      const r = await fetch('/api/settings/ai', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ intelligenceEnabled: newVal }),
                      })
                      if (r.ok) {
                        setIntelligenceEnabled(newVal)
                      }
                    } catch { /* ignore */ }
                    finally { setIntelligenceToggling(false) }
                  }}
                  disabled={intelligenceToggling}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                    intelligenceEnabled ? 'bg-green-600' : 'bg-gray-600'
                  } ${intelligenceToggling ? 'opacity-50' : ''}`}
                  role="switch"
                  aria-checked={intelligenceEnabled}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      intelligenceEnabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              )}
            </div>
            {/* BKL-AI-COST-04: Doc classify age limit */}
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-700">
              <div>
                <p className="text-sm font-medium text-gray-200">Doc Age Limit (days)</p>
                <p className="text-xs text-gray-500 mt-0.5">0 = classify all docs regardless of age. Set to e.g. 30 to skip docs older than 30 days.</p>
              </div>
              {docClassifyMaxAgeDays === null ? (
                <div className="text-xs text-gray-500">Loading...</div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={docClassifyMaxAgeDays}
                    onChange={e => setDocClassifyMaxAgeDays(Math.max(0, parseInt(e.target.value) || 0))}
                    className="w-20 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-white text-right tabular-nums focus:outline-none focus:border-accent"
                  />
                  <button
                    onClick={async () => {
                      setDocAgeSaving(true)
                      setDocAgeError(null)
                      try {
                        const r = await fetch('/api/settings/ai', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ docClassifyMaxAgeDays }),
                        })
                        if (!r.ok) {
                          const err = await r.json().catch(() => ({}))
                          setDocAgeError((err as { error?: string }).error ?? 'Save failed')
                        }
                      } catch { setDocAgeError('Save failed') }
                      finally { setDocAgeSaving(false) }
                    }}
                    disabled={docAgeSaving}
                    data-testid="doc-age-save-btn"
                    className="px-2 py-1 text-xs bg-accent/20 text-accent rounded hover:bg-accent/30 transition-colors disabled:opacity-50"
                  >
                    {docAgeSaving ? 'Saving...' : 'Save'}
                  </button>
                  {docAgeError && (
                    <div data-testid="doc-age-save-error" role="alert" className="text-xs text-red-400 mt-1">
                      {docAgeError}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Gemini API cost tracking (BKL-M52) */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Gemini API Usage (this node)</h2>
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
            {geminiUsage === null ? (
              <div className="text-xs text-gray-500">Loading...</div>
            ) : geminiUsage.totalCalls === 0 ? (
              <div className="text-xs text-gray-500">No Gemini calls recorded yet this session</div>
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs text-gray-400">
                <dt className="whitespace-nowrap">Today</dt>
                <dd className="text-gray-200 tabular-nums truncate min-w-0">
                  {(geminiUsage.todayInputTokens + geminiUsage.todayOutputTokens).toLocaleString()} tokens
                  &nbsp;·&nbsp;
                  <span className="text-yellow-400">${(geminiUsage.todayCostUsd ?? 0).toFixed(4)}</span>
                </dd>
                <dt className="whitespace-nowrap">This month</dt>
                <dd className="text-gray-200 tabular-nums truncate min-w-0">
                  {(geminiUsage.monthInputTokens + geminiUsage.monthOutputTokens).toLocaleString()} tokens
                  &nbsp;·&nbsp;
                  <span className="text-yellow-400">${(geminiUsage.monthCostUsd ?? 0).toFixed(4)}</span>
                </dd>
                <dt className="whitespace-nowrap">Total calls this session</dt>
                <dd className="text-gray-200 tabular-nums truncate min-w-0">{geminiUsage.totalCalls}</dd>
                {Object.keys(geminiUsage.byCallType).length > 0 && (
                  <>
                    <dt className="col-span-2 pt-1 border-t border-gray-700" />
                    {Object.entries(geminiUsage.byCallType)
                      .sort((a, b) => b[1].costUsd - a[1].costUsd)
                      .map(([type, stats]) => (
                        <>
                          <dt key={`${type}-label`} className="text-gray-500 whitespace-nowrap">{type}</dt>
                          <dd key={`${type}-value`} className="tabular-nums truncate min-w-0">
                            {stats.calls} calls · ${(stats.costUsd ?? 0).toFixed(4)}
                          </dd>
                        </>
                      ))}
                  </>
                )}
              </dl>
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
          <div className="space-y-3">
            <BatchIntelligenceSection />
            <ValidateRepairSection />
          </div>
        </div>

        {/* BKL-AI13: NotebookLM batch create */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">NotebookLM</h2>
          <NotebookLMSection />
        </div>

        {/* Product Intelligence Sources */}
        <ProductSourcesAdmin />

        {/* BKL-BACKUP-01: Config Backup */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Config Backup</h2>
          <ConfigBackupSection />
        </div>

        {/* BKL-REG-03: Domain Inference */}
        <DomainInferenceSection />

        {/* BKL-M50e: Scrape History */}
        <ScrapeHistorySection />

        {/* BKL-HERO-02: Region Access — edit which regions/pods this install can access */}
        <div data-testid="admin-region-access">
          <h2 className="text-lg font-semibold text-white mb-4">Region Access</h2>
          <Step0RegionAccess
            initialEnabledRegions={adminEnabledRegions}
            initialEnabledPods={adminEnabledPods}
            onSave={(regions, pods) => {
              setAdminEnabledRegions(regions)
              setAdminEnabledPods(pods)
            }}
          />
        </div>

      </div>
    </div>
  )
}
