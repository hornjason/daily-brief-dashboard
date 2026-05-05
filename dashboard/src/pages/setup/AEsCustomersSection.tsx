import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  XCircle,
  ChevronDown,
  ExternalLink,
  Loader2,
  Plus,
  Trash2,
  Users,
} from 'lucide-react'
import { BootstrapConfigBlock } from '../../components/BootstrapConfigBlock'
import { useBootstrapConfig } from '../../hooks/useBootstrapConfig'

// ── Types ──────────────────────────────────────────────────────────────────────

interface SfReport { id: string; name: string }

interface WizardAE {
  id: string
  name: string
  folderUrl: string
  folderId: string
  folderName: string
  sfReportId: string
  tableauUrl: string
  subscriptionSheetId: string
  pipelineSheetId: string
  ccspSheetId: string
  tableauTerritories: string
  customers: WizardCustomer[]
}

interface WizardCustomer {
  id: string
  name: string
  supportableName: string
  domain: string
  accountNumbers: string
  aliases: string
}

// ── Auto-Bootstrap types ──────────────────────────────────────────────────────

interface AutoBootstrapStep {
  name: string
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  detail?: string
}

interface AutoBootstrapState {
  running: boolean
  aeName: string | null
  steps: AutoBootstrapStep[]
  error: string | null
  completedAt: string | null
  resources?: {
    driveFolder?: { id: string; url: string }
    customerFolders?: Record<string, { id: string; url: string }>
    supportableSheet?: { id: string; url: string }
    ccspSheet?: { id: string; url: string }
    pipelineSheet?: { id: string; url: string }
    unmatchedCustomers?: string[]
    junkFiltered?: string[]
    domainInference?: { customerName: string; domain: string; confidence: 'high' | 'low'; sources: string[] }[]
    inferenceWarning?: string
  }
}

interface PodBootstrapStatus {
  podBootstrap: {
    running: boolean
    total: number
    completed: number
    currentAE: string | null
    results: Array<{ name: string; status: string; error?: string; customerCount?: number }>
    completedAt: string | null
    error: string | null
  }
}

// ── Small helpers ──────────────────────────────────────────────────────────────

function makeBlankCustomer(): WizardCustomer {
  return { id: crypto.randomUUID(), name: '', supportableName: '', domain: '', accountNumbers: '', aliases: '' }
}

function makeBlankAE(): WizardAE {
  return {
    id: crypto.randomUUID(),
    name: '',
    folderUrl: '',
    folderId: '',
    folderName: '',
    sfReportId: '',
    tableauUrl: '',
    subscriptionSheetId: '',
    pipelineSheetId: '',
    ccspSheetId: '',
    tableauTerritories: '',
    customers: [makeBlankCustomer()],
  }
}

// ── SaveAeButton ──────────────────────────────────────────────────────────────

function SaveAeButton() {
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (saved) return <span className="text-xs text-success font-medium">&#10003; AE Saved</span>

  return (
    <div className="flex items-center gap-2">
      <button
        disabled={saving}
        onClick={async () => {
          setSaving(true)
          setError(null)
          try {
            const res = await fetch('/api/aes')
            if (!res.ok) throw new Error('Failed to load AEs')
            const { aes: currentAes } = await res.json()
            const saveRes = await fetch('/api/aes', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ aes: currentAes }),
            })
            if (!saveRes.ok) throw new Error('Failed to save AEs')
            setSaved(true)
            window.dispatchEvent(new CustomEvent('ae-saved', { detail: { count: currentAes.length } }))
          } catch (e: any) {
            setError(e.message ?? 'Save failed')
          } finally {
            setSaving(false)
          }
        }}
        className="text-xs px-2.5 py-1 bg-success hover:bg-success/80 disabled:opacity-50 text-white rounded font-medium"
      >
        {saving ? 'Saving…' : 'Save AE'}
      </button>
      {error && <span className="text-xs text-critical">{error}</span>}
    </div>
  )
}

// ── RetryStepButton ───────────────────────────────────────────────────────────

function RetryStepButton({ label, endpoint, body }: { label: string; endpoint: string; body: Record<string, unknown> }) {
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const handleRetry = async () => {
    setStatus('running')
    try {
      const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      setStatus(r.ok ? 'done' : 'error')
    } catch { setStatus('error') }
  }
  return (
    <button
      onClick={handleRetry}
      disabled={status === 'running'}
      className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border transition-colors ${
        status === 'done' ? 'border-success/40 text-success bg-success/10' :
        status === 'error' ? 'border-critical/40 text-critical bg-critical/10' :
        'border-accent/40 text-accent bg-accent/10 hover:bg-accent/20'
      }`}
    >
      {status === 'running' && <Loader2 className="w-3 h-3 animate-spin" />}
      {status === 'done' ? '✓ Started' : status === 'error' ? 'Failed — try again' : label}
    </button>
  )
}

// ── AutoBootstrapProgress ─────────────────────────────────────────────────────

function AutoBootstrapProgress({ state, onReset, tableauSessionNeeded }: { state: AutoBootstrapState; onReset?: () => void; tableauSessionNeeded?: boolean | null }) {
  const hasError = state.steps.some(s => s.status === 'error')
  const [cancelling, setCancelling] = useState(false)

  // BKL-G15: Elapsed time counter (mm:ss) during bootstrap execution
  const [elapsed, setElapsed] = useState('')
  useEffect(() => {
    if (!state.running) {
      setElapsed('')
      return
    }
    const startTime = Date.now()
    const tick = () => {
      const totalSec = Math.floor((Date.now() - startTime) / 1000)
      const mm = String(Math.floor(totalSec / 60)).padStart(2, '0')
      const ss = String(totalSec % 60).padStart(2, '0')
      setElapsed(`${mm}:${ss}`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [state.running])

  const statusIcon = (s: AutoBootstrapStep['status'], stepIndex: number, stepName: string) => {
    const label = `Step ${stepIndex + 1}: ${s === 'done' ? 'Complete' : s === 'running' ? 'Running' : s === 'error' ? 'Failed' : s === 'cancelled' ? 'Cancelled' : 'Pending'} — ${stepName}`
    switch (s) {
      case 'pending':   return <span aria-label={label} className="relative z-10 inline-flex w-6 h-6 rounded-full border-2 border-border bg-bg items-center justify-center" />
      case 'running':   return <span aria-label={label} className="relative z-10 inline-flex w-6 h-6 rounded-full border-2 border-accent bg-bg items-center justify-center"><Loader2 className="w-3.5 h-3.5 animate-spin text-accent" /></span>
      case 'done':      return <span aria-label={label} className="relative z-10 inline-flex w-6 h-6 rounded-full border-2 border-success bg-bg items-center justify-center"><CheckCircle className="w-3.5 h-3.5 text-success" /></span>
      case 'error':     return <span aria-label={label} className="relative z-10 inline-flex w-6 h-6 rounded-full border-2 border-critical bg-bg items-center justify-center"><XCircle className="w-3.5 h-3.5 text-critical" /></span>
      case 'cancelled': return <span aria-label={label} className="relative z-10 inline-flex w-6 h-6 rounded-full border-2 border-warning bg-bg items-center justify-center"><XCircle className="w-3.5 h-3.5 text-warning" /></span>
    }
  }

  return (
    <div className="mt-4 space-y-4" aria-live="polite">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-text-primary">
          {state.completedAt ? `Setup ${state.error === 'Cancelled by user' ? 'cancelled' : hasError ? 'finished with errors' : 'complete'} — ${state.aeName}` : `Setting up ${state.aeName}…`}
        </p>
        <div className="flex items-center gap-3">
          {state.running && elapsed && (
            <p className="text-xs text-text-secondary">{elapsed}</p>
          )}
          {/* BKL-WIZ-02: Cancel button while bootstrap is running */}
          {state.running && (
            <button
              onClick={async () => {
                setCancelling(true)
                await fetch('/api/bootstrap/auto/cancel', { method: 'POST' }).catch(e => console.error('[bootstrap] cancel failed:', e))
                setCancelling(false)
              }}
              disabled={cancelling}
              className="text-xs text-warning hover:text-warning/80 underline disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
        </div>
      </div>

      {/* Step list with connector lines */}
      <div className="relative">
        {state.steps.map((step, i) => (
          <div key={i} className="relative flex gap-3">
            {/* Vertical connector line */}
            {i < state.steps.length - 1 && (
              <div className="absolute left-3 top-6 bottom-0 w-px bg-surface-hover" />
            )}
            {/* Icon */}
            <div className="flex-shrink-0 mt-0.5">{statusIcon(step.status, i, step.name)}</div>
            {/* Content row — highlight running step */}
            <div className={`flex-1 mb-2 rounded px-2 py-1 text-sm ${step.status === 'running' ? 'bg-surface/60' : ''}`}>
              <span className={
                step.status === 'error'     ? 'text-critical' :
                step.status === 'done'      ? 'text-success' :
                step.status === 'running'   ? 'text-white font-medium' :
                step.status === 'cancelled' ? 'text-warning' :
                'text-text-secondary'
              }>
                {step.name}
              </span>
              {step.detail && (
                <p className={`text-xs mt-0.5 truncate max-w-lg ${step.status === 'error' ? 'text-critical/80' : 'text-text-secondary'}`} {...(step.status === 'error' ? { role: 'alert' } : {})}>{step.detail}</p>
              )}
              {/* BKL-ARCH-L4-SPLIT: Tableau login prompt removed — CCSP step no longer part of hero bootstrap */}
            </div>
          </div>
        ))}
      </div>

      {/* Completion card */}
      {state.completedAt && !state.running && (
        <div className={`rounded-lg border p-3 text-sm ${hasError ? 'border-warning/30 bg-warning/10' : 'border-success/30 bg-success/10'}`}>
          <p className={`font-medium mb-2 ${hasError ? 'text-warning' : 'text-success'}`} {...(hasError ? { role: 'alert' } : {})}>
            {hasError ? 'Completed with errors — some steps may need retry' : 'All done! Resources are ready.'}
          </p>
          {/* Q4: Per-step retry guidance + one-click retry for failed steps */}
          {hasError && (() => {
            const failedSteps = state.steps.filter(s => s.status === 'error')
            if (failedSteps.length === 0) return null
            const hintFor = (stepName: string): string => {
              if (stepName.toLowerCase().includes('rh portal') || stepName.toLowerCase().includes('red hat') || stepName.toLowerCase().includes('account'))
                return 'RH Portal auth failed — scroll up to Step 3 and reconnect.'
              if (stepName.toLowerCase().includes('drive') || stepName.toLowerCase().includes('folder'))
                return 'Drive folder failed — verify Google Auth is connected in Step 2.'
              if (stepName.toLowerCase().includes('populate') || stepName.toLowerCase().includes('data sheets'))
                return 'Data sheet population failed — verify Google Auth is connected in Step 2.'
              if (stepName.toLowerCase().includes('pipeline') || stepName.toLowerCase().includes('salesforce'))
                return 'Pipeline sheet failed — check Salesforce connection in Step 3 (Connections).'
              if (stepName.toLowerCase().includes('territory'))
                return 'Territory lookup failed — verify Google Sheets access in Step 2.'
              return 'Step failed — check server logs and click "Clear stuck state" to retry.'
            }
            // BKL-ARCH-L4-SPLIT: hasCcspFailure removed — CCSP step is no longer part of hero bootstrap
            const hasCcspFailure = false
            return (
              <div className="mb-3 space-y-2">
                <div className="space-y-1">
                  {failedSteps.map((s, i) => (
                    <p key={i} className="text-xs text-warning bg-warning/10 border border-warning/20 rounded px-2 py-1.5">
                      <span className="font-medium">{s.name}</span> — {hintFor(s.name)}
                    </p>
                  ))}
                </div>
                {hasCcspFailure && state.aeName && (
                  <div className="flex gap-2 flex-wrap">
                    <RetryStepButton
                      label="Retry CCSP"
                      endpoint="/api/scrape/ccsp"
                      body={{}}
                    />
                  </div>
                )}
              </div>
            )
          })()}
          {/* BKL-G10: Clickable resource links from bootstrap result */}
          {(() => {
            const r = state.resources
            const links: { label: string; url: string }[] = []
            if (r?.driveFolder?.url) links.push({ label: 'Drive Folder', url: r.driveFolder.url })
            if (r?.supportableSheet?.url) links.push({ label: 'Supportable Sheet', url: r.supportableSheet.url })
            if (r?.ccspSheet?.url) links.push({ label: 'CCSP Sheet', url: r.ccspSheet.url })
            if (r?.pipelineSheet?.url) links.push({ label: 'Pipeline Sheet', url: r.pipelineSheet.url })
            if (links.length > 0) {
              return (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {links.map((link, i) => (
                    <a
                      key={i}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 bg-surface hover:bg-surface-hover border border-border rounded-lg px-3 py-2 text-xs text-text-secondary transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5 text-text-secondary shrink-0" />
                      {link.label}
                    </a>
                  ))}
                </div>
              )
            }
            // Fallback: generate clickable links from step details when resource URLs aren't available
            const doneSteps = state.steps.filter(s => s.status === 'done' && s.detail)
            if (doneSteps.length === 0) return null
            const fallbackLinks: { label: string; url: string }[] = []
            for (const s of doneSteps) {
              const idMatch = s.detail?.match(/(?:Folder|Sheet):\s*([a-zA-Z0-9_-]{10,})/)
              if (idMatch) {
                const id = idMatch[1]
                const isFolder = s.name.toLowerCase().includes('folder')
                const url = isFolder
                  ? `https://drive.google.com/drive/folders/${id}`
                  : `https://docs.google.com/spreadsheets/d/${id}/edit`
                fallbackLinks.push({ label: s.name, url })
              }
            }
            if (fallbackLinks.length > 0) {
              return (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {fallbackLinks.map((link, i) => (
                    <a
                      key={i}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 bg-surface hover:bg-surface-hover border border-border rounded-lg px-3 py-2 text-xs text-text-secondary transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5 text-text-secondary shrink-0" />
                      {link.label}
                    </a>
                  ))}
                </div>
              )
            }
            return (
              <div className="grid grid-cols-2 gap-1.5">
                {doneSteps.map((s, i) => (
                  <span key={i} className="text-xs text-text-secondary truncate">{s.name}: <span className="text-text-primary">{s.detail}</span></span>
                ))}
              </div>
            )
          })()}
          {/* Surface junk names filtered from territory sheet */}
          {(() => {
            const junk = state.resources?.junkFiltered ?? []
            if (junk.length > 0) {
              return (
                <div className="mt-2 bg-surface/60 border border-border/50 rounded-lg px-3 py-2">
                  <p className="text-xs text-text-primary font-medium">
                    {junk.length} junk name{junk.length !== 1 ? 's' : ''} filtered from territory sheet:
                  </p>
                  <ul className="mt-0.5 list-disc list-inside">
                    {junk.map(name => (
                      <li key={name} className="text-xs text-text-secondary">{name}</li>
                    ))}
                  </ul>
                  <p className="text-xs text-text-secondary mt-1">These matched known junk patterns (deal names, billing rows, CCSP charges) and were excluded automatically.</p>
                </div>
              )
            }
            return null
          })()}
          {/* Surface customers with 0 accounts discovered — show names */}
          {(() => {
            const unmatched = state.resources?.unmatchedCustomers ?? []
            if (unmatched.length > 0) {
              return (
                <div className="mt-2 bg-warning/10 border border-warning/30/50 rounded-lg px-3 py-2">
                  <p className="text-xs text-warning font-medium">
                    {unmatched.length} customer{unmatched.length !== 1 ? 's' : ''} were not matched to an AE:
                  </p>
                  <ul className="mt-0.5 list-disc list-inside">
                    {unmatched.map(name => (
                      <li key={name} className="text-xs text-warning">{name}</li>
                    ))}
                  </ul>
                  <p className="text-xs text-text-secondary mt-1">Check that the name exactly matches the AE configuration. Edit the customer list and re-run to correct.</p>
                </div>
              )
            }
            return null
          })()}
          {/* BKL-F05: Domain inference results */}
          {(() => {
            const inferred = state.resources?.domainInference ?? []
            if (inferred.length === 0) return null
            const highConf = inferred.filter(d => d.confidence === 'high')
            const lowConf = inferred.filter(d => d.confidence === 'low')
            return (
              <div className="mt-2 bg-surface/60 border border-border/50 rounded-lg px-3 py-2">
                <p className="text-xs text-text-primary font-medium">Domains inferred automatically:</p>
                {highConf.length > 0 && (
                  <div className="mt-1">
                    <p className="text-xs text-success">✓ Auto-saved ({highConf.length}):</p>
                    <ul className="mt-0.5 list-disc list-inside">
                      {highConf.map(d => (
                        <li key={d.customerName} className="text-xs text-text-primary">{d.customerName} → <span className="text-success">{d.domain}</span> <span className="text-text-secondary">({d.sources.join('+')})</span></li>
                      ))}
                    </ul>
                  </div>
                )}
                {lowConf.length > 0 && (
                  <div className="mt-1">
                    <p className="text-xs text-warning">⚠ Review needed ({lowConf.length}):</p>
                    <ul className="mt-0.5 list-disc list-inside">
                      {lowConf.map(d => (
                        <li key={d.customerName} className="text-xs text-text-primary">{d.customerName} → <span className="text-warning">{d.domain}</span> <span className="text-text-secondary">({d.sources.join('+')})</span></li>
                      ))}
                    </ul>
                    <p className="text-xs text-text-secondary mt-1">Confirm these in Setup → Domains before using email filters.</p>
                  </div>
                )}
              </div>
            )
          })()}
          {/* BKL-DOM-INF-05: Inference warning for unresolvable domains */}
          {state.resources?.inferenceWarning && (
            <div className="mt-2 bg-surface/60 border border-warning/40 rounded-lg px-3 py-2">
              <p className="text-xs text-warning font-medium">⚠ Domain inference incomplete</p>
              <p className="text-xs text-text-secondary mt-1">{state.resources.inferenceWarning}</p>
              <p className="text-xs text-text-secondary mt-1">Set domains manually in Setup → Domains for affected customers.</p>
            </div>
          )}
          <div className="mt-3 flex items-center gap-3">
            <SaveAeButton />
            <a
              href="#aes"
              onClick={() => document.getElementById('aes')?.scrollIntoView({ behavior: 'smooth' })}
              className="text-xs text-accent hover:text-accent/80 underline"
            >
              Edit AE / customers
            </a>
            {onReset && (
              <button onClick={onReset} className="text-xs text-text-secondary hover:text-text-primary underline">
                Add another AE
              </button>
            )}
            {hasError && (
              <button
                onClick={() => fetch('/api/bootstrap/auto/reset', { method: 'POST' })}
                className="text-xs text-text-secondary hover:text-text-primary underline"
              >
                Clear stuck state
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── AutoBootstrapForm ─────────────────────────────────────────────────────────

interface AutoBootstrapFormProps {
  /** Shared POD selection — owned by the parent AEsCustomersSection. */
  sharedPod: string
  setSharedPod: (pod: string) => void
  sharedSfReportId: string
  sharedPodSfReportMap: Record<string, string>
  sharedTerritorySheetUrl: string
  sharedPodOptions: ReadonlyArray<{ value: string; label: string }>
  /** BKL-UX85: Parent Drive Folder is now rendered in BootstrapConfigBlock
   *  (above this form, right after SF Report ID). The validated folder ID
   *  flows down as this prop so submit logic still picks it up. */
  sharedParentFolderId: string
  /** BKL-UX85: push the current aeName up so BootstrapConfigBlock can render
   *  a scaffolding preview for the single AE about to be bootstrapped. */
  onAeNameChange?: (name: string) => void
}

function AutoBootstrapForm({
  sharedPod: pod,
  setSharedPod: setPod,
  sharedSfReportId: sfReportId,
  sharedPodSfReportMap: podSfReportMap,
  sharedTerritorySheetUrl: territorySheetUrl,
  sharedPodOptions: podOptions,
  sharedParentFolderId,
  onAeNameChange,
}: AutoBootstrapFormProps) {
  const [aeName, setAeName] = useState('')
  const [customerText, setCustomerText] = useState('')
  // BKL-UX85: parent folder is now owned by BootstrapConfigBlock via the
  // shared config block above; this form receives the validated id as a prop.
  const parentFolderId = sharedParentFolderId
  const [knownAes, setKnownAes] = useState<Array<{ name: string; tableauTerritories?: string[]; accounts?: string[]; parentFolderId?: string; subscriptionSheetId?: string; ccspSheetId?: string; pipelineSheetId?: string; driveFolderId?: string }>>([])
  const [forceRebootstrap, setForceRebootstrap] = useState(false)
  const bootstrapStartingRef = useRef(false)

  // Territory picker state — `pod` is owned by the parent AEsCustomersSection;
  // terrNum is local. territoryInput is derived from both.
  // Reset terrNum when POD changes (POD selection now happens in shared config block above).
  const [terrNum, setTerrNum] = useState('')
  const prevPodRef = useRef(pod)
  useEffect(() => {
    if (prevPodRef.current !== pod) {
      setTerrNum('')
      setAeName('')
      setCustomerText('')
      prevPodRef.current = pod
    }
  }, [pod])
  const [territoryError, setTerritoryError] = useState<string | null>(null)
  const [territoryLoading, setTerritoryLoading] = useState(false)
  const [podTerritoryNames, setPodTerritoryNames] = useState<{ num: string; aeName: string }[]>([])
  const [podNamesError, setPodNamesError] = useState<string | null>(null)
  const [preflightError, setPreflightError] = useState<string | null>(null)

  // Bootstrap state — check on mount so progress survives page reloads
  const [bootstrapState, setBootstrapState] = useState<AutoBootstrapState | null>(null)
  const [starting, setStarting] = useState(false)
  const [tableauSessionNeeded, setTableauSessionNeeded] = useState<boolean | null>(null)
  // Pending auto-start after OAuth return — fires once territory auto-fill has populated all fields
  const [autoStartPending, setAutoStartPending] = useState(false)
  // BKL-UX110-FIX: live server bootstrap state — persists across React state resets
  const [liveBootstrapRunning, setLiveBootstrapRunning] = useState(false)
  const [liveBootstrapAeName, setLiveBootstrapAeName] = useState<string | null>(null)

  const PENDING_KEY = 'pai_pending_bootstrap'

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/bootstrap/auto/status', { signal: controller.signal })
      .then(r => r.json())
      .then((d: AutoBootstrapState) => {
        // Guard: API can return null entries in steps if a bootstrap was interrupted mid-run
        const sanitized = { ...d, steps: d.steps.filter(Boolean) }
        // BKL-UX110: only restore in-flight runs on mount. Completed runs are
        // stale on re-entry — the user navigated away and came back, they
        // expect the form in its default "ready to bootstrap" state, not
        // showing leftover results from a previous run.
        if (sanitized.running) setBootstrapState(sanitized)
        // BKL-UX110-FIX: always track live server state regardless of local bootstrapState
        setLiveBootstrapRunning(sanitized.running ?? false)
        setLiveBootstrapAeName(sanitized.aeName ?? null)
      })
      .catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })
    fetch('/api/aes', { signal: controller.signal })
      .then(r => r.json())
      .then((d: { aes: Array<{ name: string; tableauTerritories?: string[]; accounts?: string[]; parentFolderId?: string; subscriptionSheetId?: string; ccspSheetId?: string; pipelineSheetId?: string; driveFolderId?: string }> }) => setKnownAes(d.aes ?? []))
      .catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })
    // SF Report ID is now auto-filled from the selected POD via
    // useBootstrapConfig — /api/sf/reports is no longer fetched here.

    // Restore form state after OAuth redirect — check sessionStorage directly (no URL guard).
    // The key is set just before the OAuth redirect and consumed here on first mount.
    // No URL dependency needed; the key is ephemeral and removed immediately after reading.
    // Note: sfReportId is derived from `pod` via useBootstrapConfig, so we
    // only need to restore `pod` for the report ID to reappear.
    const saved = sessionStorage.getItem(PENDING_KEY)
    if (saved) {
      try {
        // BKL-UX85: parentFolderId is now owned by the parent via
        // BootstrapConfigBlock — the parent's useBootstrapConfig restores
        // podBookingsFolderId from settings.json on mount, so we no longer
        // need to restore it here. We still restore pod + terrNum to resume
        // the exact AE selection.
        const { pod: savedPod, terrNum: savedTn } = JSON.parse(saved)
        if (savedPod) setPod(savedPod)
        if (savedTn) setTerrNum(savedTn)
        setAutoStartPending(true)
        sessionStorage.removeItem(PENDING_KEY)
      } catch { /* ignore malformed restore */ }
    }
    return () => controller.abort()
  }, [])

  // BKL-UX85: parentFolderId is now owned by the shared BootstrapConfigBlock
  // (above this form). Auto-inherit from existing AEs is no longer needed —
  // settings.json persists the last-validated POD folder and the config
  // block pre-fills from there on mount.

  // Derive full territory string(s) from pod + terrNum — no reverse-parsing needed
  const territoryInput = useMemo(() => {
    if (!pod || !terrNum.trim()) return ''
    return terrNum.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
      .map(n => `${pod}_TERR${n.padStart(2, '0')}`).join(', ')
  }, [pod, terrNum])

  // Fetch territory names from sheet whenever POD changes
  useEffect(() => {
    if (!pod) { setPodTerritoryNames([]); setPodNamesError(null); return }
    const controller = new AbortController()
    setPodNamesError(null)
    fetch(`/api/territory-names?pod=${encodeURIComponent(pod)}`, { signal: controller.signal })
      .then(r => r.json().catch(() => ({ territories: [] })))
      .then((d: { territories?: { num: string; aeName: string }[] }) => {
        setPodTerritoryNames(d.territories ?? [])
        if (!d.territories?.length) setPodNamesError('Could not load territories — check your Google connection')
      })
      .catch((e) => { if (e.name !== 'AbortError') { setPodTerritoryNames([]); setPodNamesError('Could not load territories — check your Google connection') } })
    return () => controller.abort()
  }, [pod])

  // Territory options for the selected POD — AE name in label if known from sheet or aes, else generic 01–20
  const podTerritoryOptions = useMemo(() => {
    if (!pod) return []
    // Prefer live sheet data
    if (podTerritoryNames.length > 0) {
      return podTerritoryNames.map(({ num, aeName }) => ({ num, label: `${num} — ${aeName}` }))
    }
    // Fall back to knownAes (populated aes.json)
    const knownForPod = knownAes
      .filter(ae => ae.tableauTerritories?.some(t => t.startsWith(pod + '_TERR')))
      .map(ae => {
        const num = ae.tableauTerritories!.find(t => t.startsWith(pod + '_TERR'))!
          .replace(pod + '_TERR', '')
        return { num, label: `${num} — ${ae.name}` }
      })
      .sort((a, b) => a.num.localeCompare(b.num))
    if (knownForPod.length > 0) return knownForPod
    return Array.from({ length: 20 }, (_, i) => {
      const num = String(i + 1).padStart(2, '0')
      return { num, label: num }
    })
  }, [pod, knownAes, podTerritoryNames])

  // Reverse map: territory string → AE
  const territoryAeMap = useMemo(() => {
    const map = new Map<string, typeof knownAes[0]>()
    for (const ae of knownAes) {
      for (const t of ae.tableauTerritories ?? []) map.set(t, ae)
    }
    return map
  }, [knownAes])

  // AE matched by the current territory input (first match wins)
  const matchedAe = useMemo(() => {
    const terrs = territoryInput.split(',').map(s => s.trim()).filter(Boolean)
    for (const t of terrs) {
      const ae = territoryAeMap.get(t)
      if (ae) return ae
    }
    return null
  }, [territoryInput, territoryAeMap])

  // Auto-fill AE name + accounts whenever territory resolves to a known AE (always overwrite)
  useEffect(() => {
    if (!matchedAe) return
    setAeName(matchedAe.name)
    if (matchedAe.accounts?.length) setCustomerText(matchedAe.accounts.join('\n'))
    setForceRebootstrap(false)  // reset force flag when territory changes to a new AE
  }, [matchedAe])

  // Live territory lookup — fires when territoryInput changes and no match in knownAes
  useEffect(() => {
    if (!territoryInput || matchedAe) return
    // territoryInput may be comma-separated; look up the first one
    const firstTerritory = territoryInput.split(',')[0].trim()
    if (!firstTerritory) return
    const controller = new AbortController()
    setTerritoryLoading(true)
    setTerritoryError(null)
    fetch(`/api/territory-lookup?territory=${encodeURIComponent(firstTerritory)}`, { signal: controller.signal })
      .then(r => r.json().catch(() => ({ error: 'Could not load territory data — check your Google connection' })))
      .then((d: { aeName?: string; accounts?: string[]; error?: string }) => {
        if (d.error) {
          setTerritoryError(d.error.includes('not found') ? null : d.error)
          return
        }
        if (d.aeName) setAeName(d.aeName)
        if (d.accounts?.length) setCustomerText(d.accounts.join('\n'))
      })
      .catch((e) => { if (e.name !== 'AbortError') setTerritoryError('Could not load territory data — check your Google connection') })
      .finally(() => { if (!controller.signal.aborted) setTerritoryLoading(false) })
    return () => controller.abort()
  }, [territoryInput, matchedAe])

  // BKL-UX85: push the derived aeName up so the shared BootstrapConfigBlock
  // can render its scaffolding preview for the single AE.
  useEffect(() => {
    onAeNameChange?.(aeName)
  }, [aeName, onAeNameChange])

  // Auto-start bootstrap once all fields are populated after OAuth return redirect
  useEffect(() => {
    if (!autoStartPending) return
    if (!aeName.trim() || !sfReportId.trim() || !territoryInput || !customerText.trim()) return
    setAutoStartPending(false)
    startBootstrap()
  }, [autoStartPending, aeName, sfReportId, territoryInput, customerText])

  // BKL-UX85: handleAeNameBlur removed with the AE Name input — the matchedAe
  // effect above already auto-fills customerText when territory resolves.

  // Start auto-bootstrap
  const startBootstrap = async () => {
    // BKL-UX110-FIX: guard against starting a second bootstrap when one is already running server-side
    try {
      const statusRes = await fetch('/api/bootstrap/auto/status')
      if (statusRes.ok) {
        const statusData: AutoBootstrapState = await statusRes.json()
        if (statusData.running) {
          const runningFor = statusData.aeName ? ` (currently setting up ${statusData.aeName})` : ''
          setPreflightError(`Another AE setup is already in progress${runningFor} — wait for it to complete.`)
          return
        }
      }
    } catch { /* network failure — fall through and let the 409 handle it */ }

    // E2: prevent double-trigger from autoStartPending or rapid clicks
    if (bootstrapStartingRef.current) return
    bootstrapStartingRef.current = true

    const customerNames = customerText.split('\n').map(s => s.trim()).filter(Boolean)
    const territories = territoryInput.split(',').map(s => s.trim()).filter(Boolean)

    if (!aeName.trim() || !sfReportId.trim() || !territories.length || !customerNames.length) {
      bootstrapStartingRef.current = false
      return
    }

    // SF Report ID: when auto-filled from POD map it is always a bare ID, but
    // when entered manually the user may paste a full Salesforce report URL.
    // Extract the bare ID before validation in either case.
    const extractedReportId = (() => {
      const raw = sfReportId.trim()
      if (/^[A-Za-z0-9]{15,18}$/.test(raw)) return raw
      try {
        const url = new URL(raw)
        for (const seg of url.pathname.split('/').filter(Boolean).reverse()) {
          if (/^[A-Za-z0-9]{15,18}$/.test(seg)) return seg
        }
      } catch { /* not a URL */ }
      return raw
    })()
    if (!/^00O[a-zA-Z0-9]{12,15}$/.test(extractedReportId)) {
      const rhfp = pod ? !!podSfReportMap[pod] : false
      setPreflightError(
        rhfp
          ? `SF Report ID for POD "${pod}" is malformed — check settings.json`
          : `Invalid SF Report ID — paste a bare report ID (starts with 00O) or a full Salesforce report URL`
      )
      bootstrapStartingRef.current = false
      return
    }

    setPreflightError(null)

    // Pre-check: RH Portal must be connected (needed for account discovery)
    try {
      const rhStatus = await fetch('/api/auth/redhat/status').then(r => r.json())
      if (!rhStatus.hasSession || rhStatus.sessionExpired) {
        setPreflightError('Red Hat Portal must be connected before running bootstrap — scroll up to connect it.')
        bootstrapStartingRef.current = false
        return
      }
    } catch {
      // E1: network failure on status check — do not proceed silently
      setPreflightError('Could not verify Red Hat Portal connection — check server status and try again.')
      bootstrapStartingRef.current = false
      return
    }

    // Pre-check: validate parent folder exists if provided
    if (parentFolderId.trim()) {
      try {
        // BKL-UX85-FIX: parentFolderId may be a bare folder ID (no /folders/ prefix)
        // because BootstrapConfigBlock fires onParentFolderChange(resolvedId) with just
        // the ID. Normalize to a full URL so the server regex matches.
        const folderVal = parentFolderId.trim()
        const folderUrl = /\/folders\//.test(folderVal)
          ? folderVal
          : `https://drive.google.com/drive/folders/${folderVal}`
        const vr = await fetch('/api/aes/validate-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderUrl }),
        })
        const vd = await vr.json()
        if (vd.error) {
          setPreflightError(`Drive folder not found — check the URL and try again.`)
          bootstrapStartingRef.current = false
          return
        }
      } catch {
        // E9: network failure on folder validation — do not proceed silently
        setPreflightError('Could not validate Drive folder — check your connection and try again.')
        bootstrapStartingRef.current = false
        return
      }
    }

    setStarting(true)
    try {
      const r = await fetch('/api/bootstrap/auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aeName: aeName.trim(),
          sfReportId: extractedReportId,
          tableauTerritories: territories,
          customerNames,
          parentFolderId: parentFolderId.trim() || undefined,
        }),
      })
      const d = await r.json()
      if (d.error) {
        if (d.action === 'redirect' && d.url) {
          // Need elevated Google permissions — save form state, then redirect to bootstrap OAuth
          // sfReportId is derived from `pod` on restore — no need to persist it.
          sessionStorage.setItem(PENDING_KEY, JSON.stringify({
            parentFolderId: parentFolderId.trim(),
            pod,
            terrNum,
          }))
          setPreflightError('Bootstrap requires elevated Drive permissions. Re-authorizing…')
          if (!d.url?.startsWith('/oauth/')) return
          setTimeout(() => { window.location.href = d.url }, 1200)
          return
        }
        setPreflightError(d.error)
        return
      }
      // Start polling
      setBootstrapState({ running: true, aeName: aeName.trim(), steps: [], error: null, completedAt: null })
    } catch (e: any) {
      setPreflightError(e.message) // E3: was incorrectly setTerritoryError
    } finally {
      setStarting(false)
      bootstrapStartingRef.current = false // E2: release re-entry guard
    }
  }

  // Poll bootstrap status
  useEffect(() => {
    if (!bootstrapState?.running && !starting) return
    const controller = new AbortController()
    const interval = setInterval(async () => {
      try {
        const r = await fetch('/api/bootstrap/auto/status', { signal: controller.signal })
        const d: AutoBootstrapState = await r.json()
        setBootstrapState({ ...d, steps: d.steps.filter(Boolean) })
        // BKL-UX110-FIX: keep live banner state in sync during active poll
        setLiveBootstrapRunning(d.running ?? false)
        setLiveBootstrapAeName(d.aeName ?? null)
        // BKL-ARCH-L4-SPLIT: CCSP/Tableau session check removed — no Tableau step in hero bootstrap
        if (!d.running) clearInterval(interval)
      } catch (e: any) { if (e.name !== 'AbortError') { /* ignore */ } }
    }, 2_000)
    return () => { controller.abort(); clearInterval(interval) }
  }, [bootstrapState?.running, starting, tableauSessionNeeded])

  const resetForm = () => {
    // Q13: preserve sfReportId across AE resets — most AEs share the same SF
    // report. sfReportId is derived from `pod` via useBootstrapConfig, so
    // preserving pod automatically preserves the report ID. We only clear
    // the terr-number so the next AE picks a new territory.
    setBootstrapState(null); setAeName(''); setCustomerText(''); setTerrNum('')
    setTableauSessionNeeded(null)
    bootstrapStartingRef.current = false
  }
  const customerNames = customerText.split('\n').map(s => s.trim()).filter(Boolean)
  const territories = territoryInput.split(',').map(s => s.trim()).filter(Boolean)
  const canStart = aeName.trim() && sfReportId.trim() && territories.length > 0 && customerNames.length > 0
  const matchedAeIsBootstrapped = !!(matchedAe?.ccspSheetId && matchedAe?.pipelineSheetId && matchedAe?.driveFolderId)

  if (autoStartPending) {
    return (
      <div className="flex items-center gap-3 py-6 text-text-secondary text-sm">
        <Loader2 className="w-4 h-4 animate-spin shrink-0" />
        Resuming your setup — loading territory data…
      </div>
    )
  }

  if (bootstrapState && (bootstrapState.running || bootstrapState.completedAt)) {
    return (
      <div>
        <AutoBootstrapProgress state={bootstrapState} onReset={bootstrapState.completedAt && !bootstrapState.running ? resetForm : undefined} tableauSessionNeeded={tableauSessionNeeded} />
        {bootstrapState.completedAt && !bootstrapState.running && (
          <button
            onClick={resetForm}
            className="hidden" // handled by onReset inside AutoBootstrapProgress
          >
            Set up another AE
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3">
        {/* BKL-UX85: AE Name input removed — redundant with territory auto-fill.
            The `aeName` state is still derived from matchedAe / live territory
            lookup and used by the submit handler. */}
        <div>
          <label className="block text-xs text-text-secondary mb-0.5">Account Territory *</label>
          <p className="text-xs text-text-secondary mb-2">Selects your territory for CCSP scoping and auto-fills AE name + customer list from the territory sheet.</p>
          <div className="space-y-2">
            <div>
              <p className="text-xs text-text-secondary mb-1">Territory</p>
              <select
                data-testid="territory-num-select"
                value={terrNum}
                onChange={e => setTerrNum(e.target.value)}
                disabled={!pod}
                className={`w-full bg-surface border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent disabled:opacity-40 ${!terrNum && pod ? 'bg-blue-600/40 border-blue-500/60' : 'border-border'}`}
              >
                <option value="">Select…</option>
                {podTerritoryOptions.map(opt => (
                  <option key={opt.num} value={opt.num}>{opt.label}</option>
                ))}
              </select>
            </div>
            {territoryInput && (
              <p className="text-xs text-text-secondary font-mono">{territoryInput}</p>
            )}
            {matchedAe ? (
              <p data-testid="matched-ae-name" className="text-xs text-success">→ {matchedAe.name}{matchedAe.accounts?.length ? ` · ${matchedAe.accounts.length} accounts pre-loaded` : ''}</p>
            ) : territoryLoading ? (
              <p className="text-xs text-text-secondary flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading territory data from sheet…</p>
            ) : territoryInput && !aeName ? (
              <p className="text-xs text-warning">No AE data for this territory — enter AE name and accounts manually below</p>
            ) : territoryInput && aeName ? (
              <p data-testid="loaded-ae-name" className="text-xs text-success">→ {aeName} · loaded from territory sheet</p>
            ) : null}
            {podNamesError && (
              <p className="text-xs text-warning">{podNamesError}</p>
            )}
            {territoryError && (
              <p className="text-xs text-critical">{territoryError}</p>
            )}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-text-secondary">Customer Names * (one per line)</label>
            <a
              href="https://docs.google.com/spreadsheets/d/1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8/edit?gid=294606982#gid=294606982"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-accent hover:text-accent/80"
            >
              <ExternalLink className="w-3 h-3" />
              Account name reference
            </a>
          </div>
          <textarea
            data-testid="customer-names-textarea"
            value={customerText}
            onChange={e => setCustomerText(e.target.value)}
            placeholder={"Acme Corp\nGlobex Industries\nStark Enterprises"}
            rows={5}
            className={`w-full bg-surface border rounded-lg px-3 py-2 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent resize-y ${!customerText.trim() ? 'bg-blue-600/40 border-blue-500/60' : 'border-border'}`}
          />
          {customerNames.length > 0 && (
            <p className="text-xs text-text-secondary mt-1">{customerNames.length} customer(s) — names must match AE configuration exactly. Edit before starting if needed.</p>
          )}
        </div>
      </div>
      {/* BKL-UX85: Parent Drive Folder input + custom hierarchy preview
          removed here — they now live in the shared BootstrapConfigBlock
          above the form (right after SF Report ID). */}

      {/* Already-bootstrapped notice — BKL-BOOT-01 */}
      {matchedAeIsBootstrapped && !forceRebootstrap && (
        <div className="bg-success/10 border border-success/30 rounded-lg px-3 py-3 text-xs space-y-2">
          <p className="font-medium text-success flex items-center gap-1.5">
            <CheckCircle className="w-3.5 h-3.5" /> {matchedAe!.name} is already fully bootstrapped
          </p>
          <p className="text-text-secondary">CCSP, Pipeline, and Drive folder are in place. No re-bootstrap needed.</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-text-secondary pt-1">
            <span>CCSP: <span className="text-text-primary">{matchedAe!.ccspSheetId?.slice(0, 20)}…</span></span>
            <span>Pipeline: <span className="text-text-primary">{matchedAe!.pipelineSheetId?.slice(0, 20)}…</span></span>
            <span>Drive: <span className="text-text-primary">{matchedAe!.driveFolderId?.slice(0, 20)}…</span></span>
          </div>
          <button
            onClick={() => setForceRebootstrap(true)}
            className="mt-1 text-xs text-text-secondary hover:text-text-primary underline"
          >
            Force re-bootstrap (overwrites existing sheets)
          </button>
        </div>
      )}

      {/* BKL-UX85 / BKL-ARCH-L4-SPLIT: "Before you start" prerequisites callout removed.
          Bootstrap is now under 1 minute with no Tableau VNC step. */}

      {liveBootstrapRunning && !bootstrapState?.running && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning/10 border border-warning/30 text-sm text-warning">
          <span className="mt-0.5">&#9888;</span>
          <span>
            AE setup is in progress{liveBootstrapAeName ? <> for <strong>{liveBootstrapAeName}</strong></> : ''}
            {' '}&#8212; wait for it to complete before starting another.
          </span>
        </div>
      )}

      {preflightError && (
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-critical/10 border border-critical/30">
          <span className="text-critical mt-0.5 text-base leading-none">&#9888;</span>
          <p className="text-sm text-critical">{preflightError}</p>
        </div>
      )}

      {(!matchedAeIsBootstrapped || forceRebootstrap) && (
        <div className="flex justify-end pt-1">
          <button
            onClick={startBootstrap}
            disabled={!canStart || starting}
            className="flex items-center gap-2 disabled:opacity-50 text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors bg-accent hover:bg-accent/80"
          >
            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            {starting ? 'Starting...' : 'Set Up AE'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── AEsCustomersSection ───────────────────────────────────────────────────────

export function AEsCustomersSection({ onAeCountChange, step0EnabledPods }: { onAeCountChange?: (count: number) => void; step0EnabledPods?: string[] }) {
  const [activeTab, setActiveTab] = useState<'single-ae' | 'full-pod' | 'manage'>('single-ae')

  // Shared config state — lifted from AutoBootstrapForm so it persists across tab switches
  const {
    selectedPod,
    setSelectedPod,
    sfReportId,
    setSfReportIdOverride,
    podSfReportMap,
    podLabels,
    territorySheetUrl,
    territorySheetId,
    podBookingsFolderId,
    setPodBookingsFolderId,
    podOptions,
    regions,
    selectedRegion,
    setSelectedRegion,
  } = useBootstrapConfig()

  // BKL-UX-REGION-ACCESS-WIZARD-GATE-01 (2026-05-05): The region access gate is for
  // dashboard display filtering, not for gating AE bootstrap. Any AE in any pod must
  // be able to bootstrap regardless of which regions are enabled. Show all pods.
  const filteredPodOptions = podOptions

  // BKL-UX86: Known AEs (full server records) — used to derive a safe
  // default Parent Drive Folder from a prior successful bootstrap. The
  // WizardAE array below intentionally strips `parentFolderId`, so we keep
  // a parallel lightweight record here for the default-folder lookup.
  const [knownAes, setKnownAes] = useState<Array<{ name: string; parentFolderId?: string }>>([])
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/aes', { signal: controller.signal })
      .then(r => r.json())
      .then((d: { aes?: Array<{ name: string; parentFolderId?: string }> }) => {
        setKnownAes(Array.isArray(d.aes) ? d.aes : [])
      })
      .catch((e) => { if (e.name !== 'AbortError') setKnownAes([]) })
    return () => controller.abort()
  }, [])

  // BKL-UX86: derive a known-good default from any AE that has a
  // parentFolderId recorded. This value came from a prior successful
  // bootstrap and is safe to pre-fill (unlike settings.json, which may hold
  // a stale/wrong value — see BKL-UX84).
  const defaultParentFolderId = useMemo(
    () => knownAes.find(a => a.parentFolderId && a.parentFolderId.trim().length > 0)?.parentFolderId ?? '',
    [knownAes],
  )

  // Fetch AE names for the selected POD so the BootstrapConfigBlock can render
  // the Drive scaffolding preview with real AE names. Uses the same
  // /api/territory-names endpoint that the Single AE tab uses.
  const [fullPodAeNames, setFullPodAeNames] = useState<string[]>([])
  useEffect(() => {
    if (!selectedPod) { setFullPodAeNames([]); return }
    const controller = new AbortController()
    fetch(`/api/territory-names?pod=${encodeURIComponent(selectedPod)}`, { signal: controller.signal })
      .then(r => r.json().catch(() => ({ territories: [] })))
      .then((d: { territories?: { num: string; aeName: string }[] }) => {
        const names = (d.territories ?? [])
          .map(t => t.aeName)
          .filter((n): n is string => typeof n === 'string' && n.length > 0)
        // Dedupe in case the sheet has the same AE across multiple territories
        setFullPodAeNames(Array.from(new Set(names)))
      })
      .catch((e) => { if (e.name !== 'AbortError') { setFullPodAeNames([]) } })
    return () => controller.abort()
  }, [selectedPod])

  // Full POD bootstrap state (inline — was PodBootstrapSection)
  const [podBootstrapState, setPodBootstrapState] = useState<PodBootstrapStatus['podBootstrap'] | null>(null)
  const [podStarting, setPodStarting] = useState(false)
  const [podStartError, setPodStartError] = useState<string | null>(null)
  const [podCancelling, setPodCancelling] = useState(false)
  // BKL-UX84: the Parent Drive Folder must be validated in the CURRENT session
  // before Bootstrap Full POD unlocks. Settings.json may hold a wrong value
  // (e.g. a protected directory); treating it as pre-validated would let the
  // user kick off a bootstrap that creates AE subfolders in the wrong place.
  // This flag flips true only when BootstrapConfigBlock's onParentFolderChange
  // fires from a successful Validate click.
  const [podFolderValidated, setPodFolderValidated] = useState<boolean>(false)

  // BKL-UX85: Single AE preview name — pushed up from AutoBootstrapForm via
  // onAeNameChange so the shared BootstrapConfigBlock can render a scaffolding
  // preview that shows exactly the AE folder about to be created.
  const [singleAePreviewName, setSingleAePreviewName] = useState<string>('')

  // Check for existing POD bootstrap run on mount
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/bootstrap/auto/status', { signal: controller.signal })
      .then(r => r.json())
      .then((d: PodBootstrapStatus) => {
        // BKL-UX110: only restore in-flight POD runs on mount. Completed runs
        // are stale on re-entry — the user expects the form in its default
        // state, not showing leftover results from a previous run.
        if (d.podBootstrap && d.podBootstrap.running) {
          setPodBootstrapState(d.podBootstrap)
        }
      })
      .catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })
    return () => controller.abort()
  }, [])

  // Poll while POD bootstrap is running
  useEffect(() => {
    if (!podBootstrapState?.running) return
    const controller = new AbortController()
    const interval = setInterval(async () => {
      try {
        const r = await fetch('/api/bootstrap/auto/status', { signal: controller.signal })
        const d: PodBootstrapStatus = await r.json()
        setPodBootstrapState(d.podBootstrap)
        if (!d.podBootstrap.running) clearInterval(interval)
      } catch (e: any) { if (e.name !== 'AbortError') { /* ignore */ } }
    }, 3_000)
    return () => { controller.abort(); clearInterval(interval) }
  }, [podBootstrapState?.running])

  const startPodBootstrap = async () => {
    if (!territorySheetId.trim() || !sfReportId.trim() || !podBookingsFolderId.trim() || !selectedPod) return
    const podTabTitle = podOptions.find(o => o.value === selectedPod)?.label ?? selectedPod
    setPodStarting(true)
    setPodStartError(null)
    try {
      const r = await fetch('/api/bootstrap/pod', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          territorySheetId: territorySheetId.trim(),
          sfReportId: sfReportId.trim(),
          parentFolderId: podBookingsFolderId.trim(),
          podTabTitle,
        }),
      })
      const d = await r.json()
      if (!r.ok || d.error) {
        setPodStartError(d.error ?? 'Failed to start POD bootstrap')
        return
      }
      setPodBootstrapState({ running: true, total: 0, completed: 0, currentAE: null, results: [], completedAt: null, error: null })
    } catch (e: any) {
      setPodStartError(e.message ?? 'Network error')
    } finally {
      setPodStarting(false)
    }
  }

  const cancelPodBootstrap = async () => {
    setPodCancelling(true)
    try {
      await fetch('/api/bootstrap/cancel', { method: 'POST' })
    } catch { /* ignore */ }
  }

  const resetPodBootstrap = async () => {
    try {
      const res = await fetch('/api/bootstrap/auto/reset', { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setPodStartError(d.error ?? `Reset failed (${res.status})`)
        return
      }
    } catch (e: any) {
      console.error('[bootstrap] reset failed:', e)
    }
    setPodBootstrapState(null)
    setPodStartError(null)
    setPodCancelling(false)
  }

  const podSuccessCount = podBootstrapState?.results.filter(r => r.status === 'ok' || r.status === 'skipped').length ?? 0
  const podFailCount = podBootstrapState?.results.filter(r => r.status === 'error').length ?? 0
  // BKL-UX84: require a fresh session-level validate of the parent folder
  // before allowing the Bootstrap Full POD button to fire.
  const canStartPodBootstrap = !!territorySheetId.trim() && !!sfReportId.trim() && !!podBookingsFolderId.trim() && !!selectedPod && podFolderValidated

  const [aes, setAes] = useState<WizardAE[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [validatingFolder, setValidatingFolder] = useState<string | null>(null)
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null)
  const [sfReports, setSfReports] = useState<SfReport[]>([])
  const [folderValidateError, setFolderValidateError] = useState<string | null>(null)
  const [scrapeError, setScrapeError] = useState<string | null>(null)
  const [collapsedAEs, setCollapsedAEs] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (aes.length > 2 && collapsedAEs.size === 0) {
      setCollapsedAEs(new Set(aes.map(ae => ae.id)))
    }
  }, [aes.length])

  // Load AEs and customers from server
  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      fetch('/api/aes', { signal: controller.signal }).then(r => r.json()),
      fetch('/customers', { signal: controller.signal }).then(r => r.json()),
    ])
      .then(([aeData, customerList]) => {
        const serverAes: Array<{
          name: string
          driveFolderId: string
          sfReportId?: string
          tableauUrl?: string
          subscriptionSheetId?: string
          pipelineSheetId?: string
          ccspSheetId?: string
          tableauTerritories?: string[]
        }> = aeData.aes ?? []
        const serverCustomers: Array<{
          name: string
          supportableName?: string
          domain?: string
          accountNumbers?: string[]
          aliases?: string[]
          ae?: string
        }> = Array.isArray(customerList) ? customerList : []

        // Show all named AEs regardless of bootstrap state so pre-bootstrap AEs can be edited/removed
        const configuredAes = serverAes.filter(ae => ae.name)
        if (configuredAes.length > 0) setActiveTab('manage') // auto-switch to manage view when AEs exist
        if (configuredAes.length === 0) {
          setAes([makeBlankAE()])
        } else {
          setAes(configuredAes.map(ae => ({
            id: crypto.randomUUID(),
            name: ae.name,
            folderUrl: '',
            folderId: ae.driveFolderId,
            folderName: ae.driveFolderId,
            sfReportId: ae.sfReportId ?? '',
            tableauUrl: ae.tableauUrl ?? '',
            subscriptionSheetId: ae.subscriptionSheetId ?? '',
            pipelineSheetId: ae.pipelineSheetId ?? '',
            ccspSheetId: ae.ccspSheetId ?? '',
            tableauTerritories: (ae.tableauTerritories ?? []).join(', '),
            customers: serverCustomers
              .filter(c => c.ae === ae.name)
              .map(c => ({
                id: crypto.randomUUID(),
                name: c.name,
                supportableName: c.supportableName ?? '',
                domain: c.domain ?? '',
                accountNumbers: (c.accountNumbers ?? []).join(', '),
                aliases: (c.aliases ?? []).join(', '),
              })),
          })).map(ae => ({
            ...ae,
            customers: ae.customers.length > 0 ? ae.customers : [makeBlankCustomer()],
          })))
        }
      })
      .catch((e) => { if (e.name !== 'AbortError') setAes([makeBlankAE()]) })
      .finally(() => setLoading(false))
    fetch('/api/sf/reports', { signal: controller.signal })
      .then(r => r.json())
      .then((d: { reports: SfReport[] }) => { if (d.reports?.length) setSfReports(d.reports) })
      .catch(() => {})
    return () => controller.abort()
  }, [])

  const updateAE = useCallback((aeId: string, patch: Partial<WizardAE>) => {
    setAes(prev => prev.map(a => a.id === aeId ? { ...a, ...patch } : a))
    setSaveMsg(null)
  }, [])

  const updateCustomer = useCallback((aeId: string, custId: string, patch: Partial<WizardCustomer>) => {
    setAes(prev => prev.map(a =>
      a.id === aeId
        ? { ...a, customers: a.customers.map(c => c.id === custId ? { ...c, ...patch } : c) }
        : a
    ))
    setSaveMsg(null)
  }, [])

  const addCustomer = useCallback((aeId: string) => {
    setAes(prev => prev.map(a =>
      a.id === aeId ? { ...a, customers: [...a.customers, makeBlankCustomer()] } : a
    ))
  }, [])

  const removeCustomer = useCallback((aeId: string, custId: string) => {
    setAes(prev => prev.map(a =>
      a.id === aeId ? { ...a, customers: a.customers.filter(c => c.id !== custId) } : a
    ))
  }, [])

  const addAE = () => {
    setAes(prev => [...prev, makeBlankAE()])
  }

  const removeAE = (aeId: string) => {
    setRemoveConfirmId(aeId)
  }

  const confirmRemoveAE = (aeId: string) => {
    setAes(prev => prev.filter(a => a.id !== aeId))
    setRemoveConfirmId(null)
  }

  const validateFolder = async (aeId: string) => {
    const ae = aes.find(a => a.id === aeId)
    if (!ae?.folderUrl.trim()) return
    setValidatingFolder(aeId)
    try {
      const r = await fetch('/api/aes/validate-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderUrl: ae.folderUrl.trim() }),
      })
      const d = await r.json()
      if (d.error) {
        setFolderValidateError(d.error)
      } else {
        setFolderValidateError(null)
        updateAE(aeId, { folderId: d.folderId, folderName: d.folderName })
      }
    } catch {
      setFolderValidateError('Failed to validate folder — ensure Google Auth is complete')
    } finally {
      setValidatingFolder(null)
    }
  }

  const handleSave = async () => {
    // Client-side validation: every AE must have a non-empty name
    const blankIdx = aes.findIndex(a => !a.name.trim())
    if (blankIdx !== -1) {
      setSaveMsg(`Error: AE #${blankIdx + 1} has an empty name — please enter a name before saving`)
      return
    }

    setSaving(true)
    setSaveMsg(null)
    try {
      // Fetch current server AEs so we can preserve server-managed fields
      // (tableauTerritories, accounts, etc.) that the Edit/View form doesn't expose
      const serverState = await fetch('/api/aes').then(r => r.json()).catch(() => ({ aes: [] }))
      const serverAeMap = new Map<string, Record<string, unknown>>(
        (serverState.aes ?? []).map((a: Record<string, unknown>) => [a.name as string, a])
      )

      // Extract folder/report IDs from URLs if user pasted full URLs
      const extractFolderId = (input: string): string => {
        const match = input.match(/\/folders\/([a-zA-Z0-9_-]{20,})/)
        return match ? match[1] : input.trim()
      }
      const extractReportId = (input: string): string => {
        // Strip any Salesforce URL prefix, keep bare alphanumeric ID
        const match = input.match(/([a-zA-Z0-9]{15,18})(?:\s*$|\?)/)
        return match ? match[1] : input.trim()
      }

      // Build AE objects for the server — merge wizard fields over server state
      const serverAes = aes
        .map(a => ({
          ...(serverAeMap.get(a.name.trim()) ?? {}),  // preserve server-only fields
          name: a.name.trim(),
          driveFolderId: a.folderId || extractFolderId(a.folderUrl),
          ...(a.sfReportId.trim() ? { sfReportId: extractReportId(a.sfReportId) } : {}),
          ...(a.tableauUrl.trim() ? { tableauUrl: a.tableauUrl.trim() } : {}),
          ...(a.subscriptionSheetId ? { subscriptionSheetId: a.subscriptionSheetId } : {}),
          ...(a.pipelineSheetId ? { pipelineSheetId: a.pipelineSheetId } : {}),
          ...(a.ccspSheetId ? { ccspSheetId: a.ccspSheetId } : {}),
          ...(a.tableauTerritories.trim() ? { tableauTerritories: a.tableauTerritories.split(',').map(s => s.trim()).filter(Boolean) } : {}),
        }))

      const res = await fetch('/api/aes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aes: serverAes }),
      })
      const d = await res.json()
      if (d.error) { setSaveMsg(`Error: ${d.error}`); return }

      // Now save customers
      const allCustomers = aes.flatMap(a =>
        a.customers
          .filter(c => c.name.trim())
          .map(c => ({
            name: c.name.trim(),
            supportableName: c.supportableName.trim() || undefined,
            domain: c.domain.trim() || undefined,
            accountNumbers: c.accountNumbers
              .split(',')
              .map(s => s.trim())
              .filter(Boolean),
            aliases: c.aliases.trim()
              ? c.aliases.split(',').map(s => s.trim()).filter(Boolean)
              : undefined,
            ae: a.name.trim(),
          }))
      )

      await fetch('/api/setup/save-customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customers: allCustomers }),
      })

      setSaveMsg(`Saved ${serverAes.length} AE(s) and ${allCustomers.length} customer(s)`)
      onAeCountChange?.(serverAes.length)
    } catch (e: any) {
      setSaveMsg(`Error: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-text-secondary text-sm py-4">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading AE configuration...
      </div>
    )
  }

  // BKL-WIZ-FRESH-INSTALL-01: informational summary at top of Step 4 so the
  // user sees current AE/customer counts before choosing a tab. Read-only —
  // derived from the same `aes` state already loaded from /api/aes + /customers.
  const configuredAeCount = aes.filter(a => a.name.trim()).length
  const configuredCustomerCount = aes.reduce(
    (sum, a) => sum + a.customers.filter(c => c.name.trim()).length,
    0,
  )

  return (
    <div className="space-y-5">
      {/* BKL-WIZ-FRESH-INSTALL-01: non-blocking info note showing current
          configuration counts — only renders when ≥1 AE is configured. */}
      {configuredAeCount > 0 && (
        <div
          data-testid="wiz-step4-config-summary"
          className="text-xs text-text-secondary bg-surface/60 border border-border/40 rounded-lg px-3 py-2"
        >
          Currently configured: {configuredAeCount} AE{configuredAeCount !== 1 ? 's' : ''}, {configuredCustomerCount} customer{configuredCustomerCount !== 1 ? 's' : ''} — use the tabs below to add, modify, or remove.
        </div>
      )}

      {/* Tab row — at top so users pick mode before seeing config */}
      <div className="flex items-center gap-1 bg-surface rounded-lg p-1 w-fit">
        <button
          onClick={() => setActiveTab('single-ae')}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            activeTab === 'single-ae'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:text-white'
          }`}
        >
          Single AE
        </button>
        <button
          onClick={() => setActiveTab('full-pod')}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            activeTab === 'full-pod'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:text-white'
          }`}
        >
          Full POD
        </button>
        <button
          onClick={() => setActiveTab('manage')}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            activeTab === 'manage'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:text-white'
          }`}
        >
          Manage
        </button>
      </div>

      {/* Info box — below tabs, above config block.
          BKL-ARCH-L4-SPLIT: Updated to reflect hero-install bootstrap (no Tableau/CCSP):
          under 1 minute, Drive folder + L3 sheet population only. */}
      {activeTab === 'single-ae' && (
        <div className="bg-accent/10 border border-accent/30 rounded-xl px-4 py-3 space-y-2">
          <p className="text-sm font-medium text-accent">Automated AE setup — one click to fully configured</p>
          <p className="text-xs text-accent/80 leading-relaxed">
            Creates a Drive folder, discovers RH Portal account numbers, and generates all data sheets automatically.
          </p>
          <ul className="text-xs text-accent/80 leading-relaxed space-y-0.5 list-disc list-inside pt-1">
            <li>This takes <span className="text-accent font-medium">under 1 minute</span> — creates your Drive folder and populates sheets from shared data</li>
          </ul>
        </div>
      )}
      {activeTab === 'full-pod' && (
        <div className="bg-accent/10 border border-accent/30 rounded-xl px-4 py-3 space-y-2">
          <p className="text-sm font-medium text-accent">Bootstrap your entire POD at once</p>
          <p className="text-xs text-accent/80 leading-relaxed">
            The system will iterate through each AE in the territory sheet, running the full bootstrap pipeline for each one.
          </p>
          <ul className="text-xs text-accent/80 leading-relaxed space-y-0.5 list-disc list-inside pt-1">
            <li>Takes longer than a single AE — plan accordingly</li>
          </ul>
        </div>
      )}

      {/* Shared config block — below tabs, hidden in Manage.
          BKL-UX85: Parent Drive Folder now renders for BOTH single-ae and
          full-pod (previously full-pod only). For single-ae we pass the
          currently derived aeName (single entry) so the scaffolding preview
          reflects the one AE about to be bootstrapped. */}
      {activeTab !== 'manage' && (
        <BootstrapConfigBlock
          selectedPod={selectedPod}
          setSelectedPod={setSelectedPod}
          sfReportId={sfReportId}
          onSfReportIdChange={setSfReportIdOverride}
          podSfReportMap={podSfReportMap}
          podLabels={podLabels}
          territorySheetUrl={territorySheetUrl}
          podOptions={filteredPodOptions}
          regions={regions}
          selectedRegion={selectedRegion}
          setSelectedRegion={setSelectedRegion}
          parentFolderId={defaultParentFolderId}
          lockedFolderId={defaultParentFolderId}
          showRootFallback={!defaultParentFolderId}
          onParentFolderChange={(folderId: string) => {
            // BKL-UX84 / BKL-UX86: a successful Validate click (or silent
            // auto-validate from a known-good AE folder) is the ONLY way to
            // unlock Bootstrap Full POD. Update the shared folder id AND
            // mark the current session as validated. For single-ae the
            // validated id flows into AutoBootstrapForm as sharedParentFolderId.
            setPodBookingsFolderId(folderId)
            setPodFolderValidated(true)
          }}
          previewAeNames={
            activeTab === 'full-pod'
              ? fullPodAeNames
              : (singleAePreviewName ? [singleAePreviewName] : [])
          }
        />
      )}

      {/* Single AE tab */}
      {activeTab === 'single-ae' && (
        <AutoBootstrapForm
          sharedPod={selectedPod}
          setSharedPod={setSelectedPod}
          sharedSfReportId={sfReportId}
          sharedPodSfReportMap={podSfReportMap}
          sharedTerritorySheetUrl={territorySheetUrl}
          sharedPodOptions={filteredPodOptions}
          sharedParentFolderId={podBookingsFolderId}
          onAeNameChange={setSingleAePreviewName}
        />
      )}

      {/* Full POD tab */}
      {activeTab === 'full-pod' && (
        <div className="space-y-5">
          {!podBookingsFolderId.trim() && (
            <div className="flex items-start gap-2 bg-warning/10 border border-warning/30 rounded-lg px-3 py-2.5 text-xs text-warning">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>Parent Drive Folder not configured in settings.json — <code>podBookingsFolderId</code> is required for Full POD bootstrap.</span>
            </div>
          )}

          {/* Input + button — hide when running or completed */}
          {!podBootstrapState?.running && !podBootstrapState?.completedAt && (
            <div className="space-y-3">
              {podStartError && (
                <p className="text-xs text-critical bg-critical/10 border border-critical/30 rounded px-3 py-2 flex items-center gap-1.5">
                  <XCircle className="w-3.5 h-3.5 shrink-0" /> {podStartError}
                </p>
              )}
              <div className="flex justify-end">
                <button
                  onClick={startPodBootstrap}
                  disabled={!canStartPodBootstrap || podStarting}
                  className="flex items-center gap-2 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  {podStarting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-4 h-4" />}
                  {podStarting ? 'Starting...' : 'Bootstrap POD'}
                </button>
              </div>
            </div>
          )}

          {/* Live progress */}
          {podBootstrapState?.running && (
            <div className="space-y-3" aria-live="polite">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-text-primary">
                  {podBootstrapState.completed} / {podBootstrapState.total} AEs complete
                </p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={cancelPodBootstrap}
                    disabled={podCancelling}
                    className="flex items-center gap-1.5 text-xs text-critical hover:text-critical/80 disabled:opacity-50 transition-colors"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    {podCancelling ? 'Cancelling...' : 'Cancel'}
                  </button>
                  <Loader2 className="w-4 h-4 animate-spin text-accent" />
                </div>
              </div>

              {podBootstrapState.currentAE && (
                <div className="flex items-center gap-2 bg-accent/10 border border-accent/30 rounded-lg px-3 py-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-accent shrink-0" />
                  <span className="text-sm text-accent">Bootstrapping: {podBootstrapState.currentAE}...</span>
                </div>
              )}

              {podBootstrapState.results.length > 0 && (
                <div className="space-y-1">
                  {podBootstrapState.results.map((result, i) => {
                    const isOk = result.status === 'ok' || result.status === 'skipped'
                    return (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        {isOk
                          ? <CheckCircle className="w-4 h-4 text-success shrink-0" />
                          : result.status === 'pending' || result.status === 'retrying'
                            ? <Loader2 className="w-4 h-4 animate-spin text-accent shrink-0" />
                            : <XCircle className="w-4 h-4 text-critical shrink-0" />}
                        <span className={isOk ? 'text-success' : result.status === 'error' ? 'text-critical' : 'text-text-secondary'}>{result.name}</span>
                        {result.status === 'skipped' && <span className="text-xs text-text-secondary">(skipped)</span>}
                        {result.customerCount !== undefined && result.customerCount > 0 && <span className="text-xs text-text-secondary">({result.customerCount} customers)</span>}
                        {result.error && <span className="text-xs text-critical/70 truncate max-w-xs">- {result.error}</span>}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Completion state */}
          {podBootstrapState?.completedAt && !podBootstrapState.running && (
            <div className="space-y-3">
              <div className={`rounded-lg border p-4 text-sm ${podFailCount > 0 ? 'border-warning/30 bg-warning/10' : 'border-success/30 bg-success/10'}`}>
                <p className={`font-medium ${podFailCount > 0 ? 'text-warning' : 'text-success'}`}>
                  POD bootstrap complete — {podSuccessCount} succeeded{podFailCount > 0 ? `, ${podFailCount} failed` : ''}
                </p>
              </div>

              {podBootstrapState.results.length > 0 && (
                <div className="space-y-1">
                  {podBootstrapState.results.map((result, i) => {
                    const isOk = result.status === 'ok' || result.status === 'skipped'
                    return (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        {isOk
                          ? <CheckCircle className="w-4 h-4 text-success shrink-0" />
                          : <XCircle className="w-4 h-4 text-critical shrink-0" />}
                        <span className={isOk ? 'text-success' : 'text-critical'}>{result.name}</span>
                        {result.status === 'skipped' && <span className="text-xs text-text-secondary">(skipped)</span>}
                        {result.customerCount !== undefined && result.customerCount > 0 && <span className="text-xs text-text-secondary">({result.customerCount} customers)</span>}
                        {result.error && <span className="text-xs text-critical/70 truncate max-w-xs">- {result.error}</span>}
                      </div>
                    )
                  })}
                </div>
              )}

              {podBootstrapState.error && (
                <p className="text-xs text-critical bg-critical/10 border border-critical/30 rounded px-3 py-2 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {podBootstrapState.error}
                </p>
              )}

              <button
                onClick={resetPodBootstrap}
                className="text-xs text-text-secondary hover:text-text-primary underline"
              >
                Reset and run again
              </button>
            </div>
          )}

          {/* Top-level error (before any results) */}
          {podBootstrapState?.error && !podBootstrapState.completedAt && !podBootstrapState.running && (
            <div className="space-y-3">
              <p className="text-xs text-critical bg-critical/10 border border-critical/30 rounded px-3 py-2 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {podBootstrapState.error}
              </p>
              <button
                onClick={resetPodBootstrap}
                className="text-xs text-text-secondary hover:text-text-primary underline"
              >
                Reset and try again
              </button>
            </div>
          )}
        </div>
      )}

      {/* Manage tab */}
      {activeTab === 'manage' && (
      <>
      <p className="text-sm text-text-secondary">
        Configure your Account Executives and their customers. Each AE can have a Drive folder and Salesforce report.
      </p>

      {aes.map((ae, aeIdx) => {
        const isCollapsed = collapsedAEs.has(ae.id)
        return (
        <div key={ae.id} className="bg-bg rounded-xl border border-border overflow-hidden">
          {aes.length > 1 && (
            <button
              onClick={() => setCollapsedAEs(prev => {
                const next = new Set(prev)
                if (next.has(ae.id)) next.delete(ae.id)
                else next.add(ae.id)
                return next
              })}
              className="w-full flex items-center justify-between px-5 py-3 hover:bg-surface-hover transition-colors"
            >
              <div className="flex items-center gap-2">
                <ChevronDown className={`w-4 h-4 text-text-secondary transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                <span className="text-sm font-semibold text-text-primary">{ae.name.trim() || `AE #${aeIdx + 1}`}</span>
                <span className="text-xs text-text-secondary">{ae.customers.length} customer{ae.customers.length !== 1 ? 's' : ''}</span>
              </div>
              {removeConfirmId === ae.id ? (
                <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                  <span className="text-xs text-critical">Remove this AE and all customers?</span>
                  <button onClick={(e) => { e.stopPropagation(); confirmRemoveAE(ae.id) }} className="text-xs bg-critical hover:bg-critical/80 text-white px-2 py-0.5 rounded">Remove</button>
                  <button onClick={(e) => { e.stopPropagation(); setRemoveConfirmId(null) }} className="text-xs text-text-secondary hover:text-white">Cancel</button>
                </div>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); removeAE(ae.id) }}
                  className="flex items-center gap-1 text-xs text-text-secondary hover:text-critical transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Remove AE
                </button>
              )}
            </button>
          )}

          {(!isCollapsed || aes.length <= 1) && (
          <div className="p-5 space-y-4">
          {aes.length <= 1 && (
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-text-primary">{ae.name.trim() || `AE #${aeIdx + 1}`}</span>
            {removeConfirmId === ae.id ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-critical">Remove this AE and all customers?</span>
                <button onClick={() => confirmRemoveAE(ae.id)} className="text-xs bg-critical hover:bg-critical/80 text-white px-2 py-0.5 rounded">Remove</button>
                <button onClick={() => setRemoveConfirmId(null)} className="text-xs text-text-secondary hover:text-white">Cancel</button>
              </div>
            ) : (
              <button
                onClick={() => removeAE(ae.id)}
                className="flex items-center gap-1 text-xs text-text-secondary hover:text-critical transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Remove AE
              </button>
            )}
          </div>
          )}

          {/* AE fields */}
          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className="block text-xs text-text-secondary mb-1">AE Name</label>
              <input
                type="text"
                value={ae.name}
                onChange={e => updateAE(ae.id, { name: e.target.value })}
                placeholder="Jane Smith"
                className={`w-full bg-surface border rounded-lg px-3 py-2 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent ${
                  saveMsg?.includes(`AE #${aeIdx + 1}`) ? 'border-critical' : !ae.name.trim() ? 'bg-blue-600/40 border-blue-500/60' : 'border-border'
                }`}
              />
              {saveMsg?.includes(`AE #${aeIdx + 1}`) && (
                <p className="text-xs text-critical mt-1">AE name is required</p>
              )}
            </div>

            <div>
              <label className="block text-xs text-text-secondary mb-1">Drive Folder URL</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={ae.folderUrl}
                  onChange={e => { updateAE(ae.id, { folderUrl: e.target.value, folderName: '', folderId: '' }); setFolderValidateError(null) }}
                  onBlur={() => validateFolder(ae.id)}
                  placeholder="https://drive.google.com/drive/folders/..."
                  className={`flex-1 bg-surface border rounded-lg px-3 py-2 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent ${folderValidateError && validatingFolder === null ? 'border-critical' : ae.folderName && ae.folderId ? 'border-success' : !ae.folderUrl.trim() ? 'bg-blue-600/40 border-blue-500/60' : 'border-border'}`}
                />
                <button
                  onClick={() => validateFolder(ae.id)}
                  disabled={!ae.folderUrl.trim() || validatingFolder === ae.id}
                  className="flex items-center gap-1.5 bg-surface-hover hover:bg-surface-active disabled:opacity-40 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors shrink-0"
                >
                  {validatingFolder === ae.id
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <CheckCircle className="w-4 h-4" />}
                  Validate
                </button>
              </div>
              {ae.folderName && ae.folderId && (
                <p className="text-xs text-success mt-1 flex items-center gap-1">
                  <CheckCircle className="w-3 h-3" />
                  {ae.folderName}
                </p>
              )}
              {folderValidateError && !ae.folderName && (
                <p className="text-xs text-critical mt-1">{folderValidateError}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-text-secondary mb-1">SF Report ID (optional)</label>
                {sfReports.length > 0 ? (
                  <select
                    value={ae.sfReportId}
                    onChange={e => updateAE(ae.id, { sfReportId: e.target.value })}
                    className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent"
                  >
                    <option value="">— Select a report —</option>
                    {sfReports.map(r => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={ae.sfReportId}
                    onChange={e => updateAE(ae.id, { sfReportId: e.target.value })}
                    placeholder="Salesforce report ID or Lightning URL"
                    className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent"
                  />
                )}
                <p className="text-[10px] text-text-secondary mt-1">Pipeline opportunities report. <a href="/docs/SF-REPORT-SETUP.md" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Setup guide →</a></p>
              </div>
            </div>

            {/* Territory */}
            <div>
              <label className="block text-xs text-text-secondary mb-1">Territory (optional)</label>
              <input
                type="text"
                value={ae.tableauTerritories}
                onChange={e => updateAE(ae.id, { tableauTerritories: e.target.value })}
                placeholder="WEST_COMM_CORP_NORTHWEST_TERR01"
                className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent"
              />
              <p className="text-xs text-text-secondary mt-1">Territory code for CCSP scoping. Comma-separate for multiple.</p>
            </div>

            {/* Sheet IDs */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-text-secondary mb-1">Pipeline Sheet ID</label>
                <input
                  type="text"
                  value={ae.pipelineSheetId}
                  onChange={e => updateAE(ae.id, { pipelineSheetId: e.target.value })}
                  placeholder="Google Sheet ID"
                  className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="block text-xs text-text-secondary mb-1">CCSP Sheet ID</label>
                <input
                  type="text"
                  value={ae.ccspSheetId}
                  onChange={e => updateAE(ae.id, { ccspSheetId: e.target.value })}
                  placeholder="Google Sheet ID"
                  className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent"
                />
              </div>
            </div>
          </div>

          {/* Customer table */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Customers</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-text-secondary uppercase tracking-wide border-b border-border">
                    <th className="text-left py-2 pr-2 font-medium">Customer Name</th>
                    <th className="text-left py-2 pr-2 font-medium">Domain</th>
                    <th className="text-left py-2 pr-2 font-medium">Account Numbers</th>
                    <th className="text-left py-2 pr-2 font-medium">Aliases</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {ae.customers.map(c => (
                    <tr key={c.id} className="border-b border-border/50">
                      <td className="py-1.5 pr-2">
                        <input
                          type="text"
                          value={c.name}
                          onChange={e => updateCustomer(ae.id, c.id, { name: e.target.value })}
                          placeholder="Acme Corp"
                          className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent"
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          type="text"
                          value={c.domain}
                          onChange={e => updateCustomer(ae.id, c.id, { domain: e.target.value })}
                          placeholder="acme.com"
                          className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent"
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          type="text"
                          value={c.accountNumbers}
                          onChange={e => updateCustomer(ae.id, c.id, { accountNumbers: e.target.value })}
                          placeholder="1234567, 2345678"
                          className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent"
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          type="text"
                          value={c.aliases}
                          onChange={e => updateCustomer(ae.id, c.id, { aliases: e.target.value })}
                          placeholder="Dropbox Inc., Dropbox Holdings"
                          className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent"
                          title="Alternate names for Drive folder lookup (comma-separated)"
                        />
                      </td>
                      <td className="py-1.5">
                        <button
                          onClick={() => removeCustomer(ae.id, c.id)}
                          className="text-text-secondary hover:text-critical transition-colors p-1"
                          title="Remove customer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              onClick={() => addCustomer(ae.id)}
              className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 transition-colors mt-1"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Customer
            </button>
          </div>
          </div>
          )}
        </div>
        )
      })}

      {folderValidateError && (
        <p className="text-xs text-critical bg-critical/10 border border-critical/30 rounded px-3 py-2">{folderValidateError}</p>
      )}

      <div className="flex items-center justify-between pt-2">
        <button
          onClick={addAE}
          className="flex items-center gap-1.5 text-sm text-accent hover:text-accent/80 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add AE
        </button>

        <div className="flex items-center gap-3">
          {saveMsg && (
            <span className={`text-sm ${saveMsg.startsWith('Error') ? 'text-critical' : 'text-success'}`}>
              {saveMsg}
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
      </>
      )}
    </div>
  )
}
