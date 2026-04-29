import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatRelTime } from '../lib/format'
import { getVncUrl } from '../utils'
import { RefreshTimerSettings } from '../components/RefreshTimerSettings'
import { AiIntelligenceSettings } from '../components/AiIntelligenceSettings'
import { AutomationSettings } from '../components/AutomationSettings'
import { EmailSettingsSection } from '../components/EmailSettingsSection'
import CopyButton from '../components/CopyButton'
import { BootstrapConfigBlock } from '../components/BootstrapConfigBlock'
import { useBootstrapConfig } from '../hooks/useBootstrapConfig'
// BKL-CONN-ARCH-01: two-axis connection state derivation
import { deriveRhCard, deriveSfCard, deriveTableauCard } from '../lib/connection-state'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Plus,
  Play,
  RefreshCw,
  Shield,
  Trash2,
  Users,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

interface SfReport { id: string; name: string }

interface AuthTokens {
  gmail: boolean
  drive: boolean
  calendar: boolean
  allConfigured: boolean
  valid?: boolean
  expired?: boolean
  email?: string
}

interface WizardAE {
  id: string
  name: string
  folderUrl: string
  folderId: string
  folderName: string
  sfReportId: string
  tableauUrl: string
  supportableSheetId: string
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

// ── Small helpers ──────────────────────────────────────────────────────────────

function StatusBadge({ ok, label }: { ok: boolean | null; label: string }) {
  if (ok === null) return <span className="text-text-secondary text-sm">{label}: checking...</span>
  return (
    <span className={`flex items-center gap-1.5 text-sm ${ok ? 'text-success' : 'text-critical'}`}>
      {ok ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
      {label}
    </span>
  )
}

function CodeBlock({ code, copyable = true }: { code: string; copyable?: boolean }) {
  return (
    <div className="relative">
      <pre className="bg-bg rounded-lg p-3 font-mono text-sm text-text-primary border border-border overflow-x-auto whitespace-pre-wrap">
        {code}
      </pre>
      {copyable && (
        <div className="absolute top-2 right-2">
          <CopyButton text={code} variant="button" />
        </div>
      )}
    </div>
  )
}

// timeAgo is an alias for formatRelTime — use the shared implementation
const timeAgo = (iso: string) => formatRelTime(iso)

// Returns true if timestamp is within the last 5 minutes
const isRecent = (iso: string | null | undefined) =>
  !!iso && Date.now() - new Date(iso).getTime() < 5 * 60 * 1000

function VersionFooter() {
  const [version, setVersion] = useState<string | null>(null)
  const navigate = useNavigate()
  const clickCountRef = useRef(0)
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    fetch('/api/version')
      .then(r => r.json())
      .then(d => setVersion(d.version))
      .catch(() => {})
  }, [])

  const handleClick = () => {
    clickCountRef.current += 1
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    if (clickCountRef.current >= 3) {
      clickCountRef.current = 0
      navigate('/dashboard/admin')
      return
    }
    clickTimerRef.current = setTimeout(() => { clickCountRef.current = 0 }, 1500)
  }

  if (!version) return null
  return (
    <span
      data-testid="version-number"
      className="text-xs text-text-secondary select-none cursor-default"
      onClick={handleClick}
    >
      v{version}
    </span>
  )
}

// ── Accordion Section ──────────────────────────────────────────────────────────

function AccordionSection({
  id,
  title,
  badge,
  isOpen,
  onToggle,
  children,
}: {
  id: string
  title: string
  badge?: React.ReactNode
  isOpen: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <section id={id} className="bg-surface rounded-xl border border-border overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-surface-hover transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          {isOpen
            ? <ChevronDown className="w-4 h-4 text-text-secondary shrink-0" />
            : <ChevronRight className="w-4 h-4 text-text-secondary shrink-0" />}
          <span className="text-base font-semibold text-white">{title}</span>
        </div>
        {badge && <div className="shrink-0 ml-3">{badge}</div>}
      </button>
      {isOpen && (
        <div className="px-6 pb-6 pt-0 border-t border-border/50">
          <div className="pt-4">{children}</div>
        </div>
      )}
    </section>
  )
}

// ── Step 0: OAuth Keys upload ──────────────────────────────────────────────────

const GDRIVE_KEYS_URL = import.meta.env.VITE_OAUTH_KEYS_DRIVE_URL ?? 'https://drive.google.com/file/d/1W8JXPuk3a3I_L2q65H8d7fhe0xcuNGGC/view?usp=drive_link'

function Step0OAuthKeys({ onReady }: { onReady: () => void }) {
  const [exists, setExists] = useState<boolean | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'upload' | 'paste'>('paste')
  const [pasteText, setPasteText] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/setup/oauth-keys-status', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => { setExists(d.exists); if (d.exists) onReady() })
      .catch((e) => { if (e.name !== 'AbortError') setExists(false) })
    return () => controller.abort()
  }, [])

  const submit = async (jsonText: string) => {
    setError(null)
    setUploading(true)
    try {
      const json = JSON.parse(jsonText)
      const res = await fetch('/api/setup/upload-oauth-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Upload failed')
      setExists(true)
      onReady()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setUploading(false)
    }
  }

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    submit(await file.text())
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Google OAuth Credentials</h2>
        <p className="text-sm text-text-secondary">
          This app needs a GCP OAuth keys file to authenticate with Google. Your admin has shared this file internally.
        </p>
      </div>

      {exists === true ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-success text-sm">
            <CheckCircle className="w-4 h-4" />
            OAuth keys already configured — you're good to go.
          </div>
          <button
            onClick={() => setExists(false)}
            className="text-xs text-text-secondary hover:text-text-primary underline"
          >
            Replace keys file
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {GDRIVE_KEYS_URL && (
            <a
              href={GDRIVE_KEYS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 bg-surface-hover hover:bg-surface-active text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors w-fit"
            >
              <ExternalLink className="w-4 h-4" />
              Open OAuth Keys in Google Drive
            </a>
          )}

          {/* Mode toggle */}
          <div className="flex gap-1 bg-bg rounded-lg p-1 w-fit">
            {(['paste', 'upload'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  mode === m ? 'bg-surface-active text-white' : 'text-text-secondary hover:text-white'
                }`}
              >
                {m === 'paste' ? 'Paste JSON' : 'Upload file'}
              </button>
            ))}
          </div>

          {mode === 'paste' ? (
            <div className="space-y-2">
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder='Paste the contents of gcp-oauth.keys.json here...'
                rows={6}
                className={`w-full bg-bg border rounded-lg p-3 font-mono text-xs text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent resize-none ${!pasteText.trim() ? 'bg-blue-600/40 border-blue-500/60' : 'border-border'}`}
              />
              <button
                onClick={() => submit(pasteText)}
                disabled={!pasteText.trim() || uploading}
                className="flex items-center gap-2 bg-accent hover:bg-accent/80 disabled:opacity-40 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                {uploading ? 'Saving...' : 'Save Keys'}
              </button>
            </div>
          ) : (
            <label className="flex items-center gap-2 bg-accent hover:bg-accent/80 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer w-fit">
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {uploading ? 'Uploading...' : 'Upload gcp-oauth.keys.json'}
              <input type="file" accept=".json,application/json" className="hidden" onChange={handleFile} disabled={uploading} />
            </label>
          )}

          {error && (
            <p className="text-sm text-critical flex items-center gap-1.5">
              <XCircle className="w-4 h-4" /> {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Google Auth ────────────────────────────────────────────────────────────────

interface OAuthStatus {
  authorized: boolean
  expired?: boolean
  email?: string
  configuredAt: string | null
  hasCloudPlatformScope?: boolean
}

function GoogleAuthSection() {
  const [oauthStatus, setOauthStatus] = useState<OAuthStatus | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/oauth/status', { signal: controller.signal })
      .then(r => r.json())
      .then((d: OAuthStatus) => setOauthStatus(d))
      .catch((e) => { if (e.name !== 'AbortError') setOauthStatus({ authorized: false, configuredAt: null }) })
      .finally(() => setChecking(false))
    return () => controller.abort()
  }, [])

  if (checking) {
    return (
      <div className="flex items-center gap-2 text-text-secondary text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        Checking Google connection...
      </div>
    )
  }

  if (oauthStatus?.expired) {
    return (
      <div className="space-y-4">
        <div className="bg-warning/10 border border-warning/30 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <XCircle className="w-5 h-5 text-warning" />
            <span className="font-semibold text-white">Session Expired</span>
          </div>
          <p className="text-sm text-text-secondary">Your Google token is no longer valid. Click below to re-authenticate.</p>
          <button
            onClick={() => window.location.href = '/oauth/start'}
            className="flex items-center gap-2 bg-accent hover:bg-accent/80 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            Re-authenticate with Google
          </button>
        </div>
      </div>
    )
  }

  if (oauthStatus?.authorized) {
    return (
      <div className="space-y-4">
        <div className="bg-success/10 border border-success/30 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-success" />
            <span className="font-semibold text-white">Google Workspace Connected</span>
            {oauthStatus.email && (
              <span className="text-sm text-text-secondary ml-1">· {oauthStatus.email}</span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            {['Gmail (read)', 'Google Drive (read)', 'Google Calendar (read)', 'Google Sheets (read)'].map(s => (
              <div key={s} className="flex items-center gap-1.5 text-success">
                <Check className="w-3.5 h-3.5" />
                <span>{s}</span>
              </div>
            ))}
          </div>
          {oauthStatus.configuredAt && (
            <p className="text-xs text-text-secondary">Connected {timeAgo(oauthStatus.configuredAt)}</p>
          )}
          <button
            onClick={() => window.location.href = '/oauth/start'}
            className="text-sm text-text-secondary hover:text-white underline transition-colors"
          >
            Re-authorize
          </button>
        </div>
        {/* BKL-UX-OAUTH-SCOPE-01: warn when token lacks cloud-platform scope (Vertex AI / Gemini) */}
        {oauthStatus.hasCloudPlatformScope === false && (
          <div className="bg-warning/10 border border-warning/30 rounded-xl p-4 flex items-start gap-3">
            <span className="text-warning text-lg leading-none">⚠</span>
            <div className="space-y-1">
              <p className="text-sm font-medium text-white">AI briefs require an updated Google sign-in</p>
              <p className="text-sm text-text-secondary">Sign out and sign back in to enable Vertex AI access.</p>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <p className="text-text-secondary text-sm">Authorize read access to Calendar, Gmail, Drive, and Sheets. One click — no scripts needed.</p>

      <div className="bg-bg rounded-xl p-6 border border-border space-y-4">
        <a
          href="/oauth/start"
          className="flex items-center justify-center gap-2 bg-accent hover:bg-accent/80 text-white px-6 py-3 rounded-lg font-medium transition-colors w-full text-center"
        >
          <ExternalLink className="w-4 h-4" />
          Connect Google Workspace
        </a>
        <div className="grid grid-cols-2 gap-1.5 text-xs text-text-secondary">
          {['Gmail (read-only)', 'Google Drive (read-only)', 'Calendar (read-only)', 'Sheets (read-only)'].map(s => (
            <div key={s} className="flex items-center gap-1">
              <div className="w-1 h-1 rounded-full bg-surface-active" />
              {s}
            </div>
          ))}
        </div>
      </div>


      {/* Not a test user fallback */}
      <div className="bg-surface/50 border border-border rounded-xl p-4 space-y-2">
        <p className="text-sm font-medium text-text-primary">Not a test user yet?</p>
        <p className="text-sm text-text-secondary">
          If the connection fails with "Access Denied", your Google account needs to be added to the app first.
        </p>
        <a
          href="mailto:jhorn@redhat.com?subject=Dashboard%20Access%20Request&body=Hi%20Jason%2C%0A%0APlease%20add%20me%20as%20a%20test%20user%20for%20the%20PAI%20Dashboard%20OAuth%20app.%0A%0AMy%20Red%20Hat%20Google%20email%3A%20%5Benter%20your%20email%20here%5D%0A%0AThanks!"
          className="inline-flex items-center gap-2 bg-surface-hover hover:bg-surface-active text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          Request Access from Jason
        </a>
      </div>
    </div>
  )
}

// ── AEs & Customers ────────────────────────────────────────────────────────────

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
    supportableSheetId: '',
    pipelineSheetId: '',
    ccspSheetId: '',
    tableauTerritories: '',
    customers: [makeBlankCustomer()],
  }
}

// ── Auto-Bootstrap types & components ────────────────────────────────────────

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
  }
}

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
        {saving ? 'Saving\u2026' : 'Save AE'}
      </button>
      {error && <span className="text-xs text-critical">{error}</span>}
    </div>
  )
}

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
              {/* Tableau login prompt — only shown when reachable but session invalid AND no records were written.
                  If detail shows records (e.g. "192 records"), Tableau clearly worked — suppress the stale-cache false-positive. */}
              {step.name === 'Create CCSP Sheet' && step.status === 'done' && tableauSessionNeeded === true && !step.detail?.match(/\d+\s+records?/) && (
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="text-xs text-warning">Tableau session required to populate CCSP data</span>
                  <button
                    onClick={async () => {
                      await fetch('/api/bootstrap/tableau/open-login', { method: 'POST' })
                      window.open(getVncUrl(), 'tableau-login', 'width=1280,height=900')
                    }}
                    className="text-xs bg-warning hover:bg-warning/80 text-white px-2 py-0.5 rounded"
                  >
                    Open Tableau
                  </button>
                </div>
              )}
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
            const isCcspStep = (name: string) => name.toLowerCase().includes('ccsp') || name.toLowerCase().includes('tableau')
            const hintFor = (stepName: string): string => {
              if (stepName.toLowerCase().includes('rh portal') || stepName.toLowerCase().includes('red hat') || stepName.toLowerCase().includes('account'))
                return 'RH Portal auth failed — scroll up to Step 3 and reconnect.'
              if (stepName.toLowerCase().includes('drive') || stepName.toLowerCase().includes('folder'))
                return 'Drive folder failed — verify Google Auth is connected in Step 2.'
              if (isCcspStep(stepName))
                return 'Connect Tableau in Step 3 (Connections), then click Retry CCSP.'
              if (stepName.toLowerCase().includes('pipeline') || stepName.toLowerCase().includes('salesforce'))
                return 'Pipeline sheet failed — check Salesforce connection in Step 3 (Connections).'
              if (stepName.toLowerCase().includes('territory'))
                return 'Territory lookup failed — verify Google Sheets access in Step 2.'
              return 'Step failed — check server logs and click "Clear stuck state" to retry.'
            }
            const hasCcspFailure = failedSteps.some(s => isCcspStep(s.name))
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
  const [knownAes, setKnownAes] = useState<Array<{ name: string; tableauTerritories?: string[]; accounts?: string[]; parentFolderId?: string; supportableSheetId?: string; ccspSheetId?: string; pipelineSheetId?: string; driveFolderId?: string }>>([])
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
      .then((d: { aes: Array<{ name: string; tableauTerritories?: string[]; accounts?: string[]; parentFolderId?: string; supportableSheetId?: string; ccspSheetId?: string; pipelineSheetId?: string; driveFolderId?: string }> }) => setKnownAes(d.aes ?? []))
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

    // SF Report ID is now auto-filled from the POD → report ID map — no URL
    // extraction needed. We still validate the shape defensively in case a
    // malformed ID ever slips into settings.json.
    const extractedReportId = sfReportId.trim()
    if (!/^00O[a-zA-Z0-9]{12,15}$/.test(extractedReportId)) {
      setPreflightError(`Configured SF Report ID for POD "${pod}" is malformed — check settings.json`)
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
        // When CCSP step completes, check if Tableau login is actually needed
        const ccspStep = d.steps.find(s => s.name === 'Create CCSP Sheet')
        if (ccspStep?.status === 'done' && tableauSessionNeeded === null) {
          fetch('/api/bootstrap/tableau/session-status', { signal: controller.signal })
            .then(r => r.json())
            .then(({ reachable, sessionValid }: { reachable: boolean; sessionValid: boolean }) => {
              setTableauSessionNeeded(reachable && !sessionValid)
            })
            .catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })
        }
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

      {/* BKL-UX85: "Before you start" prerequisites callout removed — its
          bullets (7–15 min, Tableau VNC popup) are now folded into the
          blue info box at the top of the Single AE tab. */}

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

function AEsCustomersSection({ onAeCountChange }: { onAeCountChange?: (count: number) => void }) {
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
  const [tableauOk, setTableauOk] = useState<boolean | null>(null)
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

  // Check Tableau status on mount (for Full POD tab warning)
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/bootstrap/tableau/session-status', { signal: controller.signal })
      .then(r => r.json())
      .then((d: { reachable: boolean; sessionValid: boolean }) => setTableauOk(d.sessionValid))
      .catch(() => setTableauOk(false))
    return () => controller.abort()
  }, [])

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
          supportableSheetId?: string
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
            supportableSheetId: ae.supportableSheetId ?? '',
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
          ...(a.supportableSheetId ? { supportableSheetId: a.supportableSheetId } : {}),
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
          BKL-UX85: expanded to include the "Before you start" prerequisites
          (7–15 min, Tableau VNC popup) that previously lived in a separate
          callout below the form. */}
      {activeTab === 'single-ae' && (
        <div className="bg-accent/10 border border-accent/30 rounded-xl px-4 py-3 space-y-2">
          <p className="text-sm font-medium text-accent">Automated AE setup — one click to fully configured</p>
          <p className="text-xs text-accent/80 leading-relaxed">
            Creates a Drive folder, discovers RH Portal account numbers, and generates all data sheets automatically.
          </p>
          <ul className="text-xs text-accent/80 leading-relaxed space-y-0.5 list-disc list-inside pt-1">
            <li>This takes <span className="text-accent font-medium">7–15 minutes</span> to complete</li>
            <li>A <span className="text-accent font-medium">Tableau VNC popup</span> will appear mid-run — leave it open</li>
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
            <li>Takes significantly longer than a single AE — plan accordingly</li>
            <li>A <span className="text-accent font-medium">Tableau VNC popup</span> will appear mid-run — leave it open</li>
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
          podOptions={podOptions}
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
          sharedPodOptions={podOptions}
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

          {tableauOk === false && (
            <div className="flex items-start gap-2 bg-warning/10 border border-warning/30 rounded-lg px-3 py-2.5 text-xs text-warning">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>Tableau is not connected. CCSP scrape will fail for each AE. Connect Tableau in Step 3 (Connections) first or continue knowing CCSP will be skipped.</span>
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
        Configure your Account Executives and their customers. Each AE can have a Drive folder, Salesforce report, and Tableau dashboard.
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
              <div>
                <label className="block text-xs text-text-secondary mb-1">Tableau URL (optional)</label>
                <input
                  type="text"
                  value={ae.tableauUrl}
                  onChange={e => updateAE(ae.id, { tableauUrl: e.target.value })}
                  placeholder="Paste your Tableau dashboard URL"
                  className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent"
                />
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
              <p className="text-xs text-text-secondary mt-1">Tableau territory code for CCSP scoping. Comma-separate for multiple.</p>
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

// ── Red Hat Portal ─────────────────────────────────────────────────────────────


interface RhStatus {
  hasSession: boolean
  sessionExpired: boolean
  lastScraped: string | null
  caseCount: number
  loginInProgress: boolean
  loginTimedOut: boolean
}

function RedHatPortalSection({ onConnected }: { onConnected?: () => void }) {
  const [status, setStatus] = useState<RhStatus | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const popupRef = useRef<Window | null>(null)
  // Guard: only close the VNC window after the backend has confirmed loginInProgress:true
  // at least once. Without this, stale hasSession:true (dead browser, live session file)
  // causes the first poll to immediately close the window before login even starts.
  const loginStartedRef = useRef(false)

  const fetchStatus = async (signal?: AbortSignal): Promise<boolean> => {
    try {
      const d: RhStatus = await fetch('/api/auth/redhat/status', { signal }).then((r) => r.json())
      setStatus(d)
      // BKL-UX63: Align with Step 5 logic — require !sessionExpired for connected state
      if (d.hasSession && !d.sessionExpired) onConnected?.()
      if (d.loginInProgress) loginStartedRef.current = true
      if (d.hasSession && !d.loginInProgress && connecting && loginStartedRef.current) {
        setConnecting(false)
        popupRef.current?.close()
        popupRef.current = null
        fetch('/api/scrape/rh', { method: 'POST', signal }).catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })
      }
      return true
    } catch (e: any) {
      if (e.name !== 'AbortError') { /* ignore */ }
      return false
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    // BKL-UX73: Retry once if the mount fetch fails (e.g. container restart timing window)
    fetchStatus(controller.signal).then(ok => {
      if (!ok) setTimeout(() => fetchStatus(controller.signal), 600)
    })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!connecting) return
    const controller = new AbortController()
    const interval = setInterval(() => fetchStatus(controller.signal), 2_000)
    return () => { controller.abort(); clearInterval(interval) }
  }, [connecting])

  const handleConnect = async () => {
    // BKL-UX60: Connect button always wins — check status first, then either
    // start a new login or re-use the in-progress one. Never show errors.
    setError(null)
    loginStartedRef.current = false
    setConnecting(true)
    try {
      // Step 1: check current state
      const currentStatus: RhStatus = await fetch('/api/auth/redhat/status').then(r => r.json())
      setStatus(currentStatus)

      if (currentStatus.loginInProgress) {
        // Login already running — just open VNC tab, skip POST
        loginStartedRef.current = true
        // BKL-CONN-ARCH-01: open as named popup window, not '_blank' tab
        popupRef.current = window.open(getVncUrl(), 'rh-vnc', 'width=1280,height=900')
      } else {
        // Start a new login, then open VNC tab
        await fetch('/api/auth/redhat/start', { method: 'POST' }).catch(e => console.warn('[rh-auth] start failed:', e))
        // Always set after explicit login start — flag is reset to false at top of handleConnect
        // so mount-time stale-session guard (BKL-UX63) is not affected
        loginStartedRef.current = true
        // BKL-CONN-ARCH-01: open as named popup window, not '_blank' tab
        popupRef.current = window.open(getVncUrl(), 'rh-vnc', 'width=1280,height=900')
      }
      // Poll will detect completion and flip to Connected
    } catch {
      // Silently absorb errors — never show login errors to the user
      setConnecting(false)
    }
  }

  const handleCancel = async () => {
    await fetch('/api/auth/redhat/session', { method: 'DELETE' }).catch(e => console.error('[rh-auth] cancel failed:', e))
    popupRef.current?.close()
    popupRef.current = null
    setConnecting(false)
    fetchStatus()
  }

  // BKL-UX63: Show connected view only when hasSession is true AND session is not expired
  // (aligns with Step 5 DataSourcesSection logic)
  if (status?.hasSession && !status?.sessionExpired && !connecting) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <CheckCircle className="w-5 h-5 text-success" />
          <span className="font-semibold text-white">Red Hat Portal Connected</span>
        </div>
        <p className="text-text-secondary text-sm">
          Support cases will sync automatically every 4 hours.
          {status.lastScraped && (
            <> Last synced {timeAgo(status.lastScraped)} — {status.caseCount} cases.</>
          )}
        </p>
        <button
          onClick={handleConnect}
          className="text-sm text-text-secondary hover:text-white underline transition-colors"
        >
          Reconnect session
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-text-secondary text-sm">
        Connect your Red Hat Customer Portal session to surface open support cases in the
        dashboard. A browser window will open — log in, then return here.
      </p>

      {connecting ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 bg-accent/10 border border-accent/30 rounded-lg p-4">
            <Loader2 className="w-5 h-5 text-accent animate-spin shrink-0" />
            <div>
              <p className="text-white text-sm font-medium">Connecting...</p>
              <p className="text-text-secondary text-xs mt-0.5">
                Complete login in the opened browser tab. Session saves automatically.
              </p>
            </div>
          </div>
          {status?.loginTimedOut && (
            <p className="text-warning text-sm">Login timed out — try again.</p>
          )}
          <button
            onClick={handleCancel}
            className="text-sm text-text-secondary hover:text-text-primary underline transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <button
            onClick={handleConnect}
            className="flex items-center gap-2 bg-critical hover:bg-critical/80 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            Connect Red Hat Portal
          </button>
          {error && (
            <p className="text-critical text-sm flex items-center gap-1.5">
              <XCircle className="w-4 h-4" /> {error}
            </p>
          )}
          <p className="text-text-secondary text-xs">
            Optional — you can skip this and connect later from the dashboard.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Data Sources ───────────────────────────────────────────────────────────────

function DataSourcesSection({ onHealthChange, onlyConnections, hideConnections }: { onHealthChange?: (status: 'loading' | 'healthy' | 'issues', connectedCount?: number) => void; onlyConnections?: boolean; hideConnections?: boolean }) {
  const [sfStatus, setSfStatus] = useState<{
    hasSession: boolean
    lastSync: string | null
    rowCount: number
    syncError: string | null
    sessionExpired?: boolean
    reportConfigured: boolean
  } | null>(null)
  const [rhStatus, setRhStatus] = useState<{
    hasSession: boolean
    sessionExpired: boolean
    lastScraped: string | null
    caseCount: number
    loginInProgress?: boolean
    liveReachable?: boolean | null
  } | null>(null)

  const [ccspStatus, setCcspStatus] = useState<{
    running: boolean
    lastScrape: string | null
    lastSuccess?: string | null
    lastError: string | null
    recordCount?: number | null
    state?: string | null
  } | null>(null)
  const [ccspScraping, setCcspScraping] = useState(false)
  const [ccspScrapeError, setCcspScrapeError] = useState<string | null>(null)
  // ccspSyncedAt removed — derived from server ccspStatus.lastSuccess/lastScrape via isRecent()
  const [sfSyncing, setSfSyncing] = useState(false)
  // BKL-WIZ-SF-SYNC-01: transient success message after a manual Sync Now
  // completes successfully. Cleared on the next sync click and auto-hidden
  // after 8s so it doesn't linger forever.
  const [sfSyncSuccess, setSfSyncSuccess] = useState<string | null>(null)
  const [sfSyncError, setSfSyncError] = useState<string | null>(null)
  // sfSyncedAt removed — derived from server sfStatus.lastSync via isRecent()
  const [rhSyncing, setRhSyncing] = useState(false)
  const [rhSyncError, setRhSyncError] = useState<string | null>(null)
  const [rhSyncedAt, setRhSyncedAt] = useState<string | null>(null)

  // BKL-G22: Poll /api/scraper-status so Sync buttons reflect live running state
  // even when a scrape was triggered externally or on page load mid-run.
  const [scraperRunning, setScraperRunning] = useState<{
    rh: boolean; ccsp: boolean; salesforce: boolean
  }>({ rh: false, ccsp: false, salesforce: false })
  const scraperPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    const fetchScraperStatus = () => {
      fetch('/api/scraper-status')
        .then(r => r.json())
        .then(d => {
          const s = d.scrapers ?? {}
          setScraperRunning({
            rh:         s['rh-cases']?.state === 'running',
            ccsp:        s['ccsp']?.state === 'running',
            salesforce:  s['sf-pipeline']?.state === 'running',
          })
        })
        .catch(() => {})
    }
    fetchScraperStatus()
    scraperPollRef.current = setInterval(fetchScraperStatus, 3_000)
    return () => { if (scraperPollRef.current) clearInterval(scraperPollRef.current) }
  }, [])

  // BKL-UX62: When a scraper transitions from running→done, re-fetch its status
  // so the "Synced Xm ago" timestamp updates immediately (not waiting for the 15s poll).
  const prevScraperRunning = useRef(scraperRunning)
  useEffect(() => {
    const prev = prevScraperRunning.current
    if (prev.rh && !scraperRunning.rh) {
      fetch('/api/auth/redhat/status').then(r => r.json()).then(setRhStatus).catch(() => {})
    }
    if (prev.salesforce && !scraperRunning.salesforce) {
      fetch('/api/auth/salesforce/status').then(r => r.json()).then(setSfStatus).catch(() => {})
    }
    if (prev.ccsp && !scraperRunning.ccsp) {
      fetch('/api/scrape/ccsp/status').then(r => r.json()).then(setCcspStatus).catch(() => {})
    }
    prevScraperRunning.current = scraperRunning
  }, [scraperRunning])

  // Connection flow state
  const [tableauStatus, setTableauStatus] = useState<{ reachable: boolean; sessionValid: boolean } | null>(null)
  const [sfConnecting, setSfConnecting] = useState(false)
  const sfVncRef = useRef<Window | null>(null)
  const sfLoginStartedRef = useRef(false)
  const [tableauConnecting, setTableauConnecting] = useState(false)
  const tableauVncRef = useRef<Window | null>(null)
  const [rhConnecting, setRhConnecting] = useState(false)
  const rhLoginStartedRef = useRef(false)
  const rhConnectPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const rhVncRef = useRef<Window | null>(null)

  // Polling interval refs for cleanup
  const sfPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const tableauPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const tableauTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rhTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sfTimeoutFiredRef = useRef(false)
  const sfTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // BKL-CONN-SYNC-POLL-UNMOUNT-01: refs for inner sync poll intervals so unmount cleanup can clear them
  const rhSyncPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sfSyncPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const ccspSyncPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // BKL-CONN-SF-SUCCESS-TIMEOUT-01: ref for SF sync success hide timeout
  const sfSuccessTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // BKL-RH-UX-01: Offline token input state
  const [offlineTokenConfigured, setOfflineTokenConfigured] = useState<boolean | null>(null)
  const [offlineTokenValue, setOfflineTokenValue] = useState('')
  const [offlineTokenShow, setOfflineTokenShow] = useState(false)
  const [offlineTokenSaving, setOfflineTokenSaving] = useState(false)
  const [offlineTokenMsg, setOfflineTokenMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const handleSaveOfflineToken = async () => {
    setOfflineTokenSaving(true)
    setOfflineTokenMsg(null)
    try {
      const res = await fetch('/api/settings/offline-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: offlineTokenValue }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as any
        setOfflineTokenMsg({ type: 'error', text: d.error ?? `Save failed (${res.status})` })
      } else {
        setOfflineTokenMsg({ type: 'ok', text: 'Token saved' })
        setOfflineTokenConfigured(true)
      }
    } catch (e: any) {
      setOfflineTokenMsg({ type: 'error', text: e?.message ?? 'Save failed — server unreachable' })
    } finally {
      setOfflineTokenSaving(false)
      setOfflineTokenValue('')
    }
  }

  const refreshAll = (signal?: AbortSignal) => {
    fetch('/api/scrape/ccsp/status', { signal }).then(r => r.json()).then(setCcspStatus).catch((e) => { if (e.name !== 'AbortError') setCcspStatus({ running: false, lastScrape: null, lastError: 'Unreachable' }) })
    fetch('/api/auth/salesforce/status', { signal }).then(r => r.json()).then(setSfStatus).catch((e) => { if (e.name !== 'AbortError') setSfStatus({ hasSession: false, lastSync: null, rowCount: 0, syncError: 'Unreachable', reportConfigured: false }) })
    fetch('/api/auth/redhat/status', { signal }).then(r => r.json()).then(setRhStatus).catch((e) => { if (e.name !== 'AbortError') setRhStatus({ hasSession: false, sessionExpired: false, lastScraped: null, caseCount: 0 }) })
    fetch('/api/bootstrap/tableau/session-status', { signal }).then(r => r.json()).then(setTableauStatus).catch((e) => { if (e.name !== 'AbortError') setTableauStatus({ reachable: false, sessionValid: false }) })
    fetch('/api/settings/offline-token', { signal }).then(r => r.json()).then(d => setOfflineTokenConfigured(d.configured ?? false)).catch(() => {})
  }

  useEffect(() => {
    const controller = new AbortController()
    refreshAll(controller.signal)
    statusPollRef.current = setInterval(() => refreshAll(), 15000)
    return () => {
      controller.abort()
      if (statusPollRef.current) clearInterval(statusPollRef.current)
    }
  }, [])

  // Cleanup polling intervals on unmount
  useEffect(() => {
    return () => {
      if (sfPollRef.current) { clearInterval(sfPollRef.current); sfPollRef.current = null }
      if (tableauPollRef.current) clearInterval(tableauPollRef.current)
      if (tableauTimeoutRef.current) { clearTimeout(tableauTimeoutRef.current); tableauTimeoutRef.current = null }
      if (rhTimeoutRef.current) { clearTimeout(rhTimeoutRef.current); rhTimeoutRef.current = null }
      if (sfTimeoutRef.current) { clearTimeout(sfTimeoutRef.current); sfTimeoutRef.current = null }
      if (statusPollRef.current) clearInterval(statusPollRef.current)
      if (rhConnectPollRef.current) clearInterval(rhConnectPollRef.current)
      if (rhSyncPollRef.current) { clearInterval(rhSyncPollRef.current); rhSyncPollRef.current = null }
      if (sfSyncPollRef.current) { clearInterval(sfSyncPollRef.current); sfSyncPollRef.current = null }
      if (ccspSyncPollRef.current) { clearInterval(ccspSyncPollRef.current); ccspSyncPollRef.current = null }
      if (sfSuccessTimeoutRef.current) { clearTimeout(sfSuccessTimeoutRef.current); sfSuccessTimeoutRef.current = null }
      rhVncRef.current?.close()
      rhVncRef.current = null
      sfVncRef.current?.close()
      sfVncRef.current = null
      tableauVncRef.current?.close()
      tableauVncRef.current = null
      // BKL-CONN-UNMOUNT-VNC-01: cancel server-side SF login loop on navigation —
      // cancelSfLoginBrowser is idempotent so calling unconditionally is safe.
      fetch('/api/auth/salesforce/session', { method: 'DELETE' }).catch(() => {})
    }
  }, [])

  const VNC_URL = getVncUrl()

  const handleSfConnect = async () => {
    if (sfPollRef.current) return  // already polling — ignore re-entrant click
    setSfConnecting(true)
    sfLoginStartedRef.current = false
    sfTimeoutFiredRef.current = false

    // If session is already active in React state, skip VNC entirely — opening then immediately
    // closing it looks like a bug to the user. Just trigger a sync and return.
    if (sfSessionActive) {
      setSfConnecting(false)
      await fetch('/api/scrape/salesforce', { method: 'POST' }).catch(e => console.error('[sf-auth] sync trigger failed:', e))
      return
    }

    // Open VNC window synchronously FIRST — browser popup blockers fire when
    // window.open is called after any await. Open now while still in the user gesture.
    sfVncRef.current = window.open(VNC_URL, 'sf-vnc', 'width=1280,height=900')

    // Start login flow
    try {
      const res = await fetch('/api/auth/salesforce/start', { method: 'POST' })
      const d = await res.json()
      if (d.error) { sfVncRef.current?.close(); sfVncRef.current = null; setSfConnecting(false); return }
      sfLoginStartedRef.current = true
    } catch { sfVncRef.current?.close(); sfVncRef.current = null; setSfConnecting(false); return }

    sfPollRef.current = setInterval(async () => {
      // Guard against benign double-fire when 120s timeout and a poll tick race.
      if (sfTimeoutFiredRef.current) return
      // BKL-CONN-WINDOW-CLOSED-01: User closed VNC popup — do final status
      // check and stop polling so the Connect spinner doesn't hang forever.
      if (sfVncRef.current?.closed) {
        if (sfPollRef.current) clearInterval(sfPollRef.current)
        sfPollRef.current = null
        sfVncRef.current = null
        try {
          const res = await fetch('/api/auth/salesforce/status')
          const status = await res.json()
          setSfStatus(status)
          if (status.hasSession && !status.sessionExpired && !status.loginInProgress) {
            setSfConnecting(false)
            fetch('/api/scrape/salesforce', { method: 'POST' }).catch(e => console.error('[sf-auth] post-login sync failed:', e))
          } else {
            setSfConnecting(false)
          }
        } catch {
          setSfConnecting(false)
        }
        return
      }
      try {
        const res = await fetch('/api/auth/salesforce/status')
        const status = await res.json()
        setSfStatus(status)
        const expired = status.sessionExpired || status.syncError?.toLowerCase().includes('session expired')
        // Close VNC as soon as login flow ends (loginInProgress → false)
        // regardless of whether hasSession is true yet — server-side adoption can lag
        // up to 20s and the user has already visually completed login at this point.
        if (!status.loginInProgress && sfLoginStartedRef.current) {
          if (sfPollRef.current) clearInterval(sfPollRef.current)
          sfPollRef.current = null
          sfVncRef.current?.close()
          sfVncRef.current = null
          setSfConnecting(false)
          if (status.hasSession && !expired) {
            fetch('/api/scrape/salesforce', { method: 'POST' }).catch(e => console.error('[sf-auth] post-login sync failed:', e))
          }
          return
        }
        if (status.hasSession && !expired) {
          if (sfPollRef.current) clearInterval(sfPollRef.current)
          sfPollRef.current = null
          setSfConnecting(false)
          sfVncRef.current?.close()
          sfVncRef.current = null
          // Session confirmed — trigger sync so lastSync populates and status flips to Connected
          fetch('/api/scrape/salesforce', { method: 'POST' }).catch(e => console.error('[sf-auth] post-login sync failed:', e))
        }
      } catch { /* ignore */ }
    }, 3_000)

    sfTimeoutRef.current = setTimeout(() => {
      sfTimeoutFiredRef.current = true
      if (sfPollRef.current) { clearInterval(sfPollRef.current); sfPollRef.current = null }
      sfVncRef.current?.close()
      sfVncRef.current = null
      setSfConnecting(false)
      // Cancel server-side login loop so it doesn't keep running for ~5 more minutes.
      fetch('/api/auth/salesforce/session', { method: 'DELETE' }).catch(() => {})
    }, 120_000)
  }

  const handleSfCancel = async () => {
    if (sfPollRef.current) { clearInterval(sfPollRef.current); sfPollRef.current = null }
    if (sfTimeoutRef.current) { clearTimeout(sfTimeoutRef.current); sfTimeoutRef.current = null }
    sfTimeoutFiredRef.current = false
    setSfConnecting(false)
    sfVncRef.current?.close()
    sfVncRef.current = null
    await fetch('/api/auth/salesforce/session', { method: 'DELETE' }).catch(e => console.error('[sf-auth] cancel failed:', e))
  }

  const handleRhConnect = async () => {
    if (rhConnectPollRef.current) return  // already polling — ignore re-entrant click
    setRhConnecting(true)
    rhLoginStartedRef.current = false
    try {
      const currentStatus = await fetch('/api/auth/redhat/status').then(r => r.json())
      setRhStatus(currentStatus)
      // Session already valid — no VNC needed, just trigger a scrape and update UI
      if (currentStatus.hasSession && !currentStatus.sessionExpired && !currentStatus.loginInProgress) {
        setRhConnecting(false)
        fetch('/api/scrape/rh', { method: 'POST' }).catch(e => console.error('[rh-auth] post-session sync failed:', e))
        return
      }
      if (currentStatus.loginInProgress) {
        rhLoginStartedRef.current = true
        // BKL-CONN-ARCH-01: open as named popup window, not '_blank' tab — matches SF/Tableau handlers
        rhVncRef.current = window.open(getVncUrl(), 'rh-vnc', 'width=1280,height=900')
      } else {
        await fetch('/api/auth/redhat/start', { method: 'POST' }).catch(e => console.warn('[rh-auth] start failed:', e))
        rhLoginStartedRef.current = true
        // BKL-CONN-ARCH-01: open as named popup window, not '_blank' tab — matches SF/Tableau handlers
        rhVncRef.current = window.open(getVncUrl(), 'rh-vnc', 'width=1280,height=900')
      }
      // Poll until connected
      rhConnectPollRef.current = setInterval(async () => {
        // BKL-CONN-WINDOW-CLOSED-02: User closed VNC popup — do final status
        // check and stop polling so the Connect spinner doesn't hang forever.
        if (rhVncRef.current?.closed) {
          if (rhConnectPollRef.current) clearInterval(rhConnectPollRef.current)
          rhConnectPollRef.current = null
          rhVncRef.current = null
          try {
            const d = await fetch('/api/auth/redhat/status').then(r => r.json())
            setRhStatus(d)
            setRhConnecting(false)
          } catch {
            setRhConnecting(false)
          }
          return
        }
        try {
          const d = await fetch('/api/auth/redhat/status').then(r => r.json())
          setRhStatus(d)
          if (d.loginInProgress) rhLoginStartedRef.current = true
          // Close VNC as soon as login flow ends (loginInProgress → false)
          // regardless of whether hasSession is true yet — server-side adoption can lag
          // up to 20s and the user has already visually completed login at this point.
          if (!d.loginInProgress && rhLoginStartedRef.current) {
            if (rhConnectPollRef.current) clearInterval(rhConnectPollRef.current)
            rhConnectPollRef.current = null
            rhVncRef.current?.close()
            rhVncRef.current = null
            setRhConnecting(false)
            if (d.hasSession && !d.sessionExpired) {
              fetch('/api/scrape/rh', { method: 'POST' }).catch(e => console.error('[rh-auth] post-login sync failed:', e))
            }
            return
          }
        } catch { /* ignore */ }
      }, 2_000)
      // Hard timeout
      rhTimeoutRef.current = setTimeout(() => {
        if (rhConnectPollRef.current) { clearInterval(rhConnectPollRef.current); rhConnectPollRef.current = null }
        rhVncRef.current?.close()
        rhVncRef.current = null
        setRhConnecting(false)
      }, 120_000)
    } catch {
      rhVncRef.current?.close()
      rhVncRef.current = null
      setRhConnecting(false)
    }
  }

  const handleRhCancel = async () => {
    if (rhConnectPollRef.current) { clearInterval(rhConnectPollRef.current); rhConnectPollRef.current = null }
    if (rhTimeoutRef.current) { clearTimeout(rhTimeoutRef.current); rhTimeoutRef.current = null }
    rhVncRef.current?.close()
    rhVncRef.current = null
    setRhConnecting(false)
    await fetch('/api/auth/redhat/session', { method: 'DELETE' }).catch(e => console.error('[rh-auth] cancel failed:', e))
    fetch('/api/auth/redhat/status').then(r => r.json()).then(setRhStatus).catch(() => {})
  }

  const handleTableauCancel = () => {
    if (tableauPollRef.current) { clearInterval(tableauPollRef.current); tableauPollRef.current = null }
    if (tableauTimeoutRef.current) { clearTimeout(tableauTimeoutRef.current); tableauTimeoutRef.current = null }
    setTableauConnecting(false)
    tableauVncRef.current?.close()
    tableauVncRef.current = null
  }

  const handleTableauConnect = async () => {
    if (tableauPollRef.current) return  // already in progress — ignore re-entrant click
    setTableauConnecting(true)

    // Open VNC window synchronously FIRST — browser popup blockers fire when
    // window.open is called after any await. Open now while still in the user gesture.
    tableauVncRef.current = window.open(VNC_URL, 'tableau-vnc', 'width=1280,height=900')

    // IMPORTANT: await open-login before starting wait-for-login to avoid a race
    // condition where wait-for-login sees the pre-navigation page state (stale
    // Tableau URL or the initial domcontentloaded before SSO redirect) and returns
    // a false-positive sessionValid: true — which immediately closes the VNC window.
    // open-login also navigates the live page to Tableau and brings it to front,
    // so VNC shows Tableau content immediately (not the about:blank from BKL-UX94).
    try {
      await fetch('/api/bootstrap/tableau/open-login', { method: 'POST' })
    } catch { /* fall through — wait-for-login will handle the error state */ }

    // Shared resolved flag — first detection wins, prevents double-close
    let loginResolved = false
    const resolveLogin = (valid: boolean) => {
      if (loginResolved) return
      loginResolved = true
      if (tableauPollRef.current) { clearInterval(tableauPollRef.current); tableauPollRef.current = null }
      if (valid) {
        setTableauStatus({ reachable: true, sessionValid: true })
        setTimeout(() => { tableauVncRef.current?.close(); tableauVncRef.current = null }, 3000)
      } else {
        // Close VNC window even on failure — user has already logged in or abandoned the flow
        tableauVncRef.current?.close()
        tableauVncRef.current = null
      }
      setTableauConnecting(false)
    }

    // Primary: server-side Playwright URL detection — re-polls on 90s timeout
    // until loginResolved is true (success, hard cap, or VNC closed by user).
    const pollWaitForLogin = async () => {
      while (!loginResolved) {
        try {
          const r = await fetch('/api/bootstrap/tableau/wait-for-login')
          const status = await r.json()
          if (status.sessionValid) { resolveLogin(true); return }
          // 90s server timeout — re-poll if still waiting
        } catch {
          // network error — re-poll after brief delay
          await new Promise(res => setTimeout(res, 2_000))
        }
      }
    }
    pollWaitForLogin()

    // Fallback: poll session-status every 5s — catches cases where wait-for-login
    // detection misses the login (SSO URL variation, slow redirect chain)
    tableauPollRef.current = setInterval(async () => {
      // BKL-CONN: detect user-closed VNC window — abort flow cleanly
      if (tableauVncRef.current?.closed) {
        resolveLogin(false)
        return
      }
      try {
        const res = await fetch('/api/bootstrap/tableau/session-status?force=true')
        const status = await res.json()
        if (status.sessionValid) resolveLogin(true)
      } catch { /* retry next tick */ }
    }, 5_000)

    // Hard cap — stop polling after 120s regardless.
    // BKL-CONN-TABLEAU-TIMEOUT-REF-01: store timer ID so unmount cleanup can clear it.
    tableauTimeoutRef.current = setTimeout(() => resolveLogin(false), 300_000)
  }

  const handleRhSync = async () => {
    setRhSyncError(null)
    setRhSyncing(true)
    try {
      if (!rhStatus?.hasSession) {
        setRhSyncError('No active session — connect in the RH Portal section above first.')
        setRhSyncing(false)
        return
      }
      await fetch('/api/scrape/rh', { method: 'POST' })
      // Poll status endpoint until scraper finishes
      const poll = () => new Promise<void>((resolve) => {
        const iv = setInterval(async () => {
          try {
            const s = await fetch('/api/scrape/rh/status').then(r => r.json())
            if (!s.running) {
              clearInterval(iv)
              rhSyncPollRef.current = null
              // Refresh displayed data
              fetch('/api/auth/redhat/status').then(r => r.json()).then(setRhStatus).catch(() => {})
              resolve()
            }
          } catch { clearInterval(iv); rhSyncPollRef.current = null; resolve() }
        }, 2_000)
        rhSyncPollRef.current = iv
      })
      await poll()
    } catch (e: any) {
      setRhSyncError(`Sync failed: ${e.message}`)
    } finally {
      setRhSyncing(false)
    }
  }

  const handleSfSync = async () => {
    setSfSyncError(null)
    setSfSyncSuccess(null)
    setSfSyncing(true)
    try {
      const res = await fetch('/api/refresh/pipeline', { method: 'POST' })
      const d = await res.json()
      if (d.error) { setSfSyncError(d.error); setSfSyncing(false); return }
      // Poll status endpoint until scraper finishes, then refresh sfStatus before resolving.
      // BKL-WIZ-SF-SYNC-01: capture final status so we can show a transient
      // success message with row count once the run finishes cleanly.
      let finalStatus: { running?: boolean; lastError?: string | null; recordCount?: number } | null = null
      const poll = () => new Promise<void>((resolve) => {
        const iv = setInterval(async () => {
          try {
            const s = await fetch('/api/scrape/salesforce/status').then(r => r.json())
            if (!s.running) {
              clearInterval(iv)
              sfSyncPollRef.current = null
              finalStatus = s
              // Await status refresh so sfStatus is updated before setSfSyncing(false) fires
              fetch('/api/auth/salesforce/status')
                .then(r => r.json())
                .then(data => { setSfStatus(data); resolve() })
                .catch(() => resolve())
            }
          } catch { clearInterval(iv); sfSyncPollRef.current = null; resolve() }
        }, 2_000)
        sfSyncPollRef.current = iv
      })
      await poll()
      // BKL-WIZ-SF-SYNC-01: surface success feedback when the run finished
      // without an error. Use recordCount from the status endpoint when
      // available; otherwise fall back to a generic "Sync complete" message.
      const fs = finalStatus as { running?: boolean; lastError?: string | null; recordCount?: number } | null
      if (fs && !fs.lastError) {
        const count = typeof fs.recordCount === 'number' ? fs.recordCount : null
        setSfSyncSuccess(count !== null ? `Sync complete — ${count} rows` : 'Sync complete')
        sfSuccessTimeoutRef.current = setTimeout(() => { setSfSyncSuccess(null); sfSuccessTimeoutRef.current = null }, 8_000)
      }
    } catch (e: any) {
      setSfSyncError('Sync failed. Check server logs for details.')
    } finally {
      setSfSyncing(false)
    }
  }

  const handleRunCcspScrape = async () => {
    setCcspScrapeError(null)
    setCcspScraping(true)
    try {
      const res = await fetch('/api/refresh/ccsp', { method: 'POST' })
      const d = await res.json()
      if (d.error) { setCcspScrapeError(d.error); setCcspScraping(false); return }
      // Poll status endpoint until scraper finishes
      const poll = () => new Promise<void>((resolve) => {
        const iv = setInterval(async () => {
          try {
            const s = await fetch('/api/scrape/ccsp/status').then(r => r.json())
            if (!s.running) {
              clearInterval(iv)
              ccspSyncPollRef.current = null
              setCcspStatus(s)
              resolve()
            }
          } catch { clearInterval(iv); ccspSyncPollRef.current = null; resolve() }
        }, 2_000)
        ccspSyncPollRef.current = iv
      })
      await poll()
    } catch (e: any) {
      setCcspScrapeError('Sync failed. Check server logs for details.')
    } finally {
      setCcspScraping(false)
    }
  }

  const SyncButton = ({ onClick, loading, disabled, label, icon: Icon = RefreshCw }: { onClick: () => void; loading: boolean; disabled: boolean; label: string; icon?: React.ElementType }) => (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      className="flex items-center gap-1.5 bg-surface-hover hover:bg-surface-active disabled:opacity-40 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
      {loading ? 'Syncing\u2026' : label}
    </button>
  )

  // Derived statuses for card border accents
  // BKL-ADM03: session file persists through failed scrapes, so also require
  // that a successful scrape has completed (lastScraped timestamp exists) for RH,
  // and that last sync completed without error for SF.
  const rhScrapeOk = !!rhStatus?.lastScraped
  // BKL-UX60: sessionExpired can be true even while a successful scrape is running
  // (a failed queued run sets it, then a fresh run starts). Show as active when
  // hasSession is true OR the rh-cases scraper is actively running.
  const rhSessionActive = ((rhStatus?.hasSession && !rhStatus?.sessionExpired && rhStatus?.liveReachable !== false) || scraperRunning.rh) ?? false
  const rhExpired = !!(rhStatus?.sessionExpired)
  const rhConnected = rhSessionActive && (rhScrapeOk || scraperRunning.rh)
  const sfExpired = (sfStatus?.sessionExpired || !!sfStatus?.syncError) ?? false
  const sfScrapeOk = !!sfStatus?.lastSync
  const sfSessionActive = (sfStatus?.hasSession && !sfExpired) ?? false
  const sfConnected = sfSessionActive && sfScrapeOk

  // BKL-CCSP-01: Detect Tableau session expiry errors from backend
  const isTableauSessionError = (err: string | null | undefined): boolean => {
    if (!err) return false
    const lower = err.toLowerCase()
    return lower.includes('tableau session') || lower.includes('re-authenticate') || lower.includes('browser context')
  }

  const ccspConnected = ccspStatus?.lastScrape && !ccspStatus?.running && !ccspStatus?.lastError
  const ccspRunning = ccspStatus?.running ?? false
  // Tableau shows "Connected" only when sessionValid — old records don't mean the session works.
  // A stale session means new scrapes fail regardless of what recordCount is.
  const tableauConnected = (tableauStatus?.sessionValid && tableauStatus?.reachable !== false) ?? false

  const allStatusesLoaded = rhStatus !== null && sfStatus !== null && ccspStatus !== null && tableauStatus !== null
  const anyErrors = (rhStatus && !rhConnected) || (sfStatus && !sfConnected) || (ccspStatus && !!ccspStatus.lastError) || (tableauStatus && !tableauConnected)

  // BKL-CONN-ARCH-01: two-axis card states (session × data) — pure derivation
  // from raw status. Replaces ad-hoc ternaries that conflated session validity
  // with data freshness (caused Tableau "Stale" with valid SSO, SF "Expired"
  // from a single transient sync error).
  const rhCard = deriveRhCard(
    {
      hasSession: rhStatus?.hasSession ?? false,
      sessionExpired: rhStatus?.sessionExpired ?? false,
      lastScraped: rhStatus?.lastScraped ?? null,
      loginInProgress: rhStatus?.loginInProgress,
      liveReachable: rhStatus?.liveReachable,
      lastAuthenticatedAt: (rhStatus as any)?.lastAuthenticatedAt ?? null,
    },
    scraperRunning.rh ?? false
  )
  const sfCard = deriveSfCard(
    {
      hasSession: sfStatus?.hasSession ?? false,
      sessionExpired: sfStatus?.sessionExpired,
      syncError: sfStatus?.syncError,
      lastSync: sfStatus?.lastSync,
      loginInProgress: (sfStatus as any)?.loginInProgress,
      lastAuthenticatedAt: (sfStatus as any)?.lastAuthenticatedAt ?? null,
    },
    (scraperRunning as any).sf ?? false
  )
  const tableauCard = deriveTableauCard(
    tableauStatus,
    ccspStatus
      ? { state: ccspStatus.state ?? null, lastScrape: ccspStatus.lastScrape ?? null, lastError: ccspStatus.lastError, running: ccspStatus.running }
      : null,
    tableauConnecting,
    (tableauStatus as any)?.lastAuthenticatedAt ?? null
  )
  const connectedCount = [rhCard, sfCard, tableauCard].filter(c => c.countsAsConnected).length

  // Legacy counter — preserved for the existing onHealthChange callback contract
  const connectedDataSources = connectedCount

  useEffect(() => {
    if (!onHealthChange) return
    if (!allStatusesLoaded) { onHealthChange('loading'); return }
    onHealthChange(anyErrors ? 'issues' : 'healthy', connectedDataSources)
  }, [allStatusesLoaded, anyErrors, connectedDataSources, onHealthChange])

  // BKL-UX65: Fallback timeout — if statuses never fully load within 15s, force out of 'loading'
  useEffect(() => {
    if (!onHealthChange) return
    const fallback = setTimeout(() => {
      if (!allStatusesLoaded) onHealthChange('issues')
    }, 15_000)
    return () => clearTimeout(fallback)
  }, [allStatusesLoaded, onHealthChange])

  return (
    <div className="space-y-6">
      {/* ── CONNECTIONS ── */}
      {!hideConnections && <div>
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">Connections</h3>
        {/* BKL-CONN-ARCH-01: ordering hint until all three primary sources connected */}
        {connectedCount < 3 && (
          <p className="text-xs text-text-secondary mb-3">
            Connect your data sources in order — each one builds on the previous.
          </p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 min-[1440px]:grid-cols-3 gap-3">

          {/* Red Hat Portal */}
          {/* BKL-UX60: Show Connected when hasSession OR scraper running, Connecting when loginInProgress */}
          <div className={`flex flex-col bg-surface/50 border border-border rounded-xl p-4 border-l-[3px] min-h-[160px] ${rhSessionActive ? 'border-l-success' : rhStatus?.loginInProgress ? 'border-l-warning' : 'border-l-border'}`}>
            <div className="flex items-center justify-between mb-1">
              <div>
                <p className="text-sm font-medium text-white">Red Hat Portal</p>
                <p className="text-xs text-text-secondary">Support cases</p>
              </div>
              <div className="flex items-center gap-1.5">
                {rhStatus === null ? (
                  <>
                    <Loader2 className="w-2.5 h-2.5 animate-spin text-text-secondary" />
                    <span className="text-xs text-text-secondary">Checking...</span>
                  </>
                ) : (rhConnecting || (rhStatus?.loginInProgress && !rhSessionActive)) ? (
                  <>
                    <Loader2 className="w-2.5 h-2.5 animate-spin text-warning" />
                    <span className="text-xs text-warning">Connecting</span>
                  </>
                ) : (
                  <>
                    {/* BKL-CONN-ARCH-01: dot + label from rhCard derivation */}
                    <span className={`w-2 h-2 rounded-full ${rhCard.dotPulse ? 'animate-pulse' : ''} ${
                      rhCard.dotColor === 'green' ? 'bg-success' :
                      rhCard.dotColor === 'blue' ? 'bg-blue-400' :
                      rhCard.dotColor === 'amber' ? 'bg-warning' :
                      rhCard.dotColor === 'red' ? 'bg-critical' : 'bg-surface-active'
                    }`} />
                    <span className={`text-xs ${
                      rhCard.dotColor === 'green' ? 'text-success' :
                      rhCard.dotColor === 'blue' ? 'text-blue-400' :
                      rhCard.dotColor === 'amber' ? 'text-warning' :
                      rhCard.dotColor === 'red' ? 'text-critical' : 'text-text-secondary'
                    }`}>{rhCard.label}</span>
                    {rhCard.secondaryLabel && (
                      <span className="text-xs text-text-secondary ml-1">{rhCard.secondaryLabel}</span>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="mt-auto pt-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={handleRhConnect}
                  disabled={rhConnecting}
                  className={`disabled:opacity-40 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${rhSessionActive ? 'bg-surface-hover hover:bg-surface-active text-white' : 'bg-blue-600/40 hover:bg-blue-600/50 text-blue-300 border border-blue-500/60'}`}
                >
                  {rhConnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />}
                  {rhConnecting ? 'Connecting...' : rhSessionActive ? 'Reconnect' : 'Connect'}
                </button>
                {rhConnecting && (
                  <button
                    onClick={handleRhCancel}
                    className="bg-critical/15 hover:bg-critical/20 text-critical px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                  >
                    Cancel
                  </button>
                )}
              </div>
              {/* BKL-RH-UX-01: Offline token input */}
              <div className="mt-3 border-t border-border/40 pt-3">
                <p className="text-xs text-text-secondary mb-1.5">
                  Offline Token
                  {offlineTokenConfigured === true && (
                    <span className="ml-1.5 text-success font-medium">configured</span>
                  )}
                  {offlineTokenConfigured === false && (
                    <span className="ml-1.5 text-warning font-medium">not set</span>
                  )}
                </p>
                <div className="flex items-center gap-1.5">
                  <input
                    type={offlineTokenShow ? 'text' : 'password'}
                    value={offlineTokenValue}
                    onChange={e => { setOfflineTokenValue(e.target.value); setOfflineTokenMsg(null) }}
                    placeholder={offlineTokenConfigured ? 'Enter new token to replace' : 'Paste REDHAT_OFFLINE_TOKEN'}
                    className="flex-1 min-w-0 bg-surface border border-border rounded px-2 py-1 text-xs text-white placeholder:text-text-secondary/60 focus:outline-none focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={() => setOfflineTokenShow(v => !v)}
                    className="text-text-secondary hover:text-white px-1.5 py-1 rounded text-xs transition-colors"
                    title={offlineTokenShow ? 'Hide token' : 'Show token'}
                  >
                    {offlineTokenShow ? 'Hide' : 'Show'}
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveOfflineToken}
                    disabled={offlineTokenSaving || !offlineTokenValue.trim()}
                    className="disabled:opacity-40 bg-accent/20 hover:bg-accent/30 text-accent border border-accent/40 px-2.5 py-1 rounded text-xs font-medium transition-colors"
                  >
                    {offlineTokenSaving ? 'Saving…' : 'Save'}
                  </button>
                </div>
                {offlineTokenMsg && (
                  <p className={`text-xs mt-1 ${offlineTokenMsg.type === 'ok' ? 'text-success' : 'text-critical'}`}>
                    {offlineTokenMsg.text}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Salesforce */}
          <div className={`flex flex-col bg-surface/50 border border-border rounded-xl p-4 border-l-[3px] min-h-[160px] ${sfConnected ? 'border-l-success' : (sfExpired || sfSessionActive) ? 'border-l-warning' : 'border-l-border'}`}>
            <div className="flex items-center justify-between mb-1">
              <div>
                <p className="text-sm font-medium text-white">Salesforce</p>
                <p className="text-xs text-text-secondary">Pipeline</p>
              </div>
              <div className="flex items-center gap-1.5">
                {/* BKL-CONN-ARCH-01: dot + label from sfCard derivation */}
                <span className={`w-2 h-2 rounded-full ${sfCard.dotPulse ? 'animate-pulse' : ''} ${
                  sfCard.dotColor === 'green' ? 'bg-success' :
                  sfCard.dotColor === 'blue' ? 'bg-blue-400' :
                  sfCard.dotColor === 'amber' ? 'bg-warning' :
                  sfCard.dotColor === 'red' ? 'bg-critical' : 'bg-surface-active'
                }`} />
                <span className={`text-xs ${
                  sfCard.dotColor === 'green' ? 'text-success' :
                  sfCard.dotColor === 'blue' ? 'text-blue-400' :
                  sfCard.dotColor === 'amber' ? 'text-warning' :
                  sfCard.dotColor === 'red' ? 'text-critical' : 'text-text-secondary'
                }`}>{sfCard.label}</span>
                {sfCard.secondaryLabel && (
                  <span className="text-xs text-text-secondary ml-1">{sfCard.secondaryLabel}</span>
                )}
              </div>
            </div>
            <div className="mt-auto pt-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSfConnect}
                  /* BKL-CONN-ARCH-01: gate SF on RH being connected (ordering) */
                  disabled={sfConnecting || !rhCard.countsAsConnected}
                  title={!rhCard.countsAsConnected ? 'Connect Red Hat Portal first' : undefined}
                  className={`disabled:opacity-40 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${sfConnected ? 'bg-surface-hover hover:bg-surface-active text-white' : 'bg-blue-600/40 hover:bg-blue-600/50 text-blue-300 border border-blue-500/60'}`}
                >
                  {sfConnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />}
                  {sfConnecting ? 'Connecting...' : sfConnected ? 'Reconnect' : 'Connect'}
                </button>
                {sfConnecting && (
                  <button
                    onClick={handleSfCancel}
                    className="bg-critical/15 hover:bg-critical/20 text-critical px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                  >
                    Cancel
                  </button>
                )}
              </div>
              {sfStatus?.syncError && <p className="text-xs text-critical mt-2">{sfStatus.syncError}</p>}
              {!sfStatus?.reportConfigured && (
                <p className="text-xs text-text-secondary mt-2">SF Report ID required — configure in AEs & Customers above.</p>
              )}
            </div>
          </div>

          {/* Tableau */}
          <div className={`flex flex-col bg-surface/50 border border-border rounded-xl p-4 border-l-[3px] min-h-[160px] ${ccspStatus?.lastError ? 'border-l-critical' : tableauConnected ? 'border-l-success' : tableauConnecting ? 'border-l-warning' : 'border-l-border'}`}>
            <div className="flex items-center justify-between mb-1">
              <div>
                <p className="text-sm font-medium text-white">Tableau</p>
                <p className="text-xs text-text-secondary">CCSP cloud spend</p>
              </div>
              <div className="flex items-center gap-1.5">
                {/* BKL-CONN-ARCH-01: unified state via tableauCard derivation.
                    Replaces stacked ternaries that conflated CCSP data state
                    with Tableau session state (caused "Stale" with valid SSO). */}
                {tableauCard.sessionState === 'authenticating' ? (
                  <>
                    <Loader2 className="w-2.5 h-2.5 animate-spin text-blue-400" />
                    <span className="text-xs text-blue-400">{tableauCard.label}</span>
                  </>
                ) : tableauCard.label === 'Checking…' ? (
                  <>
                    <Loader2 className="w-2.5 h-2.5 animate-spin text-text-secondary" />
                    <span className="text-xs text-text-secondary">{tableauCard.label}</span>
                  </>
                ) : (
                  <>
                    <span className={`w-2 h-2 rounded-full ${tableauCard.dotPulse ? 'animate-pulse' : ''} ${
                      tableauCard.dotColor === 'green' ? 'bg-success' :
                      tableauCard.dotColor === 'blue' ? 'bg-blue-400' :
                      tableauCard.dotColor === 'amber' ? 'bg-warning' :
                      tableauCard.dotColor === 'red' ? 'bg-critical' : 'bg-surface-active'
                    }`} />
                    <span className={`text-xs ${
                      tableauCard.dotColor === 'green' ? 'text-success' :
                      tableauCard.dotColor === 'blue' ? 'text-blue-400' :
                      tableauCard.dotColor === 'amber' ? 'text-warning' :
                      tableauCard.dotColor === 'red' ? 'text-critical' : 'text-text-secondary'
                    }`}>{tableauCard.label}</span>
                    {tableauCard.secondaryLabel && (
                      <span className="text-xs text-text-secondary ml-1">{tableauCard.secondaryLabel}</span>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="mt-auto pt-3">
              {/* BKL-UX61: No standalone Tableau login — it uses RH Portal SSO.
                  Show Connect/Reconnect when RH Portal is connected (SSO available).
                  Show hint only when RH Portal is not yet connected. */}
              {!tableauConnecting && !rhSessionActive && (
                <div className="text-xs text-text-secondary flex items-center gap-1">
                  <Shield className="w-3 h-3" />
                  <span>Requires Red Hat Portal session</span>
                </div>
              )}
              {(rhSessionActive || tableauConnecting) && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleTableauConnect}
                  /* BKL-CONN-ARCH-01: gate Tableau on RH being connected (ordering) */
                  /* BKL-STAB-01: disable when session already valid — clicking Connect on a live session
                     opens a stale Tableau page in the shared context, poisoning newPage() for all scrapes */
                  disabled={!rhCard.countsAsConnected || tableauConnecting || tableauConnected}
                  title={!rhCard.countsAsConnected ? 'Connect Red Hat Portal first' : tableauConnected ? 'Tableau session is active — disconnect first to reconnect' : undefined}
                  className={`disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${tableauConnected ? 'bg-surface/40 text-text-secondary border border-border' : 'bg-blue-600/40 hover:bg-blue-600/50 text-blue-300 border border-blue-500/60'}`}
                >
                  {tableauConnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />}
                  {tableauConnecting ? 'Connecting...' : tableauConnected ? 'Reconnect' : 'Connect'}
                </button>
                {tableauConnecting && (
                  <button
                    onClick={handleTableauCancel}
                    className="bg-critical/15 hover:bg-critical/20 text-critical px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                  >
                    Cancel
                  </button>
                )}
              </div>
              )}
              {tableauConnecting && <p className="text-xs text-text-secondary mt-2"><strong className="text-warning">Two steps:</strong> (1) Enter your Tableau username → Sign In. (2) The page redirects to <strong className="text-white">Red Hat SSO</strong> — enter your Red Hat employee credentials there too. Do not close or refresh the VNC window. It closes automatically when done.</p>}
            </div>
          </div>

        </div>
      </div>}

      {/* ── SYNC ── (hidden in connections-only / pre-flight mode) */}
      {!onlyConnections && <div>
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">Sync</h3>
        <div className="divide-y divide-border/50">

          {/* Red Hat Cases */}
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-white">Red Hat Cases</p>
              {rhStatus?.lastScraped ? (
                <p className={`text-xs ${isRecent(rhStatus.lastScraped) ? 'text-success' : 'text-text-secondary'}`}>Synced {timeAgo(rhStatus.lastScraped)} — {rhStatus.caseCount}</p>
              ) : (
                <p className="text-xs text-text-secondary">Support cases</p>
              )}
            </div>
            <div className="flex items-center">
              {/* BKL-G22: loading reflects both local trigger and external isRunning from poll */}
              <SyncButton onClick={handleRhSync} loading={rhSyncing || scraperRunning.rh} disabled={!rhConnected} label="Sync Now" icon={RefreshCw} />
            </div>
          </div>
          {rhSyncError && <p role="alert" className="text-xs text-critical pb-2">{rhSyncError}</p>}
          {(rhSyncing || scraperRunning.rh) && (
            <div className="flex items-center gap-2 pb-2 text-xs text-warning">
              <svg className="w-3 h-3 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              <span>Syncing{rhStatus?.caseCount ? ` — last: ${rhStatus.caseCount} cases` : '…'}</span>
            </div>
          )}

          {/* CCSP (Tableau) */}
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-white">CCSP (Tableau)</p>
              {(ccspStatus?.lastSuccess ?? ccspStatus?.lastScrape) ? (
                <p className="text-xs text-text-secondary">Synced {timeAgo(([ccspStatus.lastSuccess, ccspStatus.lastScrape].filter((t): t is string => !!t).sort().slice(-1)[0]) ?? '')}{ccspStatus.recordCount ? ` — ${ccspStatus.recordCount}` : ''}</p>
              ) : (
                <p className="text-xs text-text-secondary">Cloud spend</p>
              )}
              {isRecent([ccspStatus?.lastSuccess, ccspStatus?.lastScrape].filter((t): t is string => !!t).sort().slice(-1)[0]) && (
                ccspStatus?.recordCount
                  ? <p className="text-xs text-success">✓ Synced — {ccspStatus.recordCount} records</p>
                  : <p className="text-xs text-warning">⚠ Synced but returned 0 records</p>
              )}
              {ccspStatus?.lastError && isTableauSessionError(ccspStatus.lastError) ? (
                <div className="flex items-center gap-1.5 mt-1">
                  <p className="text-xs text-warning">Tableau session expired — re-authenticate via VNC to continue</p>
                  <a
                    href={getVncUrl()}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent/80 underline whitespace-nowrap"
                    onClick={() => handleTableauConnect()}
                  >
                    <ExternalLink className="w-3 h-3" />
                    Open VNC
                  </a>
                </div>
              ) : ccspStatus?.lastError ? (
                <p className="text-xs text-critical">{ccspStatus.lastError}</p>
              ) : null}
            </div>
            <SyncButton onClick={handleRunCcspScrape} loading={ccspScraping || scraperRunning.ccsp} disabled={ccspRunning || scraperRunning.ccsp} label="Sync Now" />
          </div>
          <p className="text-xs text-text-secondary pb-1">Syncs to the service-account CCSP sheet. User-created sheets require manual sharing with the service account email first.</p>
          {ccspScrapeError && isTableauSessionError(ccspScrapeError) ? (
            <div className="flex items-center gap-1.5 pb-2">
              <p className="text-xs text-warning">Tableau session expired — re-authenticate via VNC to continue</p>
              <a
                href={getVncUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent/80 underline whitespace-nowrap"
                onClick={() => handleTableauConnect()}
              >
                <ExternalLink className="w-3 h-3" />
                Open VNC
              </a>
            </div>
          ) : ccspScrapeError ? (
            <p role="alert" className="text-xs text-critical pb-2">{ccspScrapeError}</p>
          ) : null}

          {/* Pipeline (Salesforce) */}
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-white">Pipeline (Salesforce)</p>
              {(sfSyncing || scraperRunning.salesforce) ? (
                <p className="text-xs text-warning">Syncing…</p>
              ) : sfStatus?.lastSync ? (
                <p className={`text-xs ${isRecent(sfStatus.lastSync) ? 'text-success' : 'text-text-secondary'}`}>
                  {isRecent(sfStatus.lastSync)
                    ? `✓ Synced ${timeAgo(sfStatus.lastSync)}${sfStatus.rowCount ? ` — ${sfStatus.rowCount} rows` : ' — 0 rows'}`
                    : `Synced ${timeAgo(sfStatus.lastSync)}${sfStatus.rowCount ? ` — ${sfStatus.rowCount}` : ''}`}
                </p>
              ) : (
                <p className="text-xs text-text-secondary">Pipeline data</p>
              )}
            </div>
            <div className="flex items-center">
              {!sfConnected && (
                <span className="text-xs text-text-secondary mr-3">
                  {sfSessionActive ? 'Session active — sync needed to complete setup' : 'Requires Salesforce session'}
                </span>
              )}
              <SyncButton onClick={handleSfSync} loading={sfSyncing || scraperRunning.salesforce} disabled={!sfSessionActive || !sfStatus?.reportConfigured} label="Sync Now" />
            </div>
          </div>
          {sfSyncError && <p role="alert" className="text-xs text-critical pb-2">{sfSyncError}</p>}
          {sfSyncSuccess && (
            <p
              data-testid="sf-sync-success"
              role="status"
              className="text-xs text-success pb-2"
            >
              ✓ {sfSyncSuccess}
            </p>
          )}

        </div>
      </div>}
    </div>
  )
}

// ── Main Setup Page ────────────────────────────────────────────────────────────

type SectionId = 'oauth-keys' | 'google-auth' | 'aes' | 'rh-portal' | 'data-sources' | 'settings' | 'ai-settings' | 'automation-settings'

const DATA_SOURCE_TOTAL = 3 // Red Hat Portal, Salesforce, Tableau/CCSP — Supportable removed

export default function SetupPage() {
  const [openSection, setOpenSection] = useState<SectionId | null>(null)
  const userToggledRef = useRef(false) // tracks whether user has interacted with accordion
  const [oauthKeysOk, setOauthKeysOk] = useState(false)
  const [googleAuthOk, setGoogleAuthOk] = useState<boolean | null>(null) // null = still checking
  const [aeCount, setAeCount] = useState<number | null>(null)
  const [rhOk, setRhOk] = useState<boolean | null>(null)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [dataSourcesHealth, setDataSourcesHealth] = useState<'loading' | 'healthy' | 'issues'>('loading')
  const [dataSourcesConnected, setDataSourcesConnected] = useState<number | null>(null)
  const [resetConfirm, setResetConfirm] = useState<'full' | 'data' | null>(null)

  // Dynamic page title
  useEffect(() => {
    document.title = 'Setup | ASA Command Center'
    return () => { document.title = 'ASA Command Center' }
  }, [])

  // Check initial states to determine auto-expand and badge data
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller

    // Check OAuth keys
    fetch('/api/setup/oauth-keys-status', { signal })
      .then(r => r.json())
      .then(d => { if (d.exists) setOauthKeysOk(true) })
      .catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })

    // Check Google auth + pending downgrade
    fetch('/api/oauth/status', { signal })
      .then(r => r.json())
      .then((d: OAuthStatus) => {
        setGoogleAuthOk(d.authorized && !d.expired)
      })
      .catch((e) => { if (e.name !== 'AbortError') setGoogleAuthOk(false) })

    // Check AE count
    fetch('/api/aes', { signal })
      .then(r => r.json())
      .then(d => { setAeCount((d.aes ?? []).length) })
      .catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })

    // Check RH Portal
    fetch('/api/auth/redhat/status', { signal })
      .then(r => r.json())
      // BKL-UX63: Require !sessionExpired — aligns Step 3 badge with Step 5
      .then(d => { setRhOk((d.hasSession && !d.sessionExpired) ?? false) })
      .catch((e) => { if (e.name !== 'AbortError') setRhOk(false) })

    // BKL-UX112: Poll the Data Sources counter on a recurring interval so the
    // badge never goes stale while the accordion is collapsed (DataSourcesSection
    // only mounts when the accordion is open, so its reactive onHealthChange
    // cannot drive the counter before first expansion).
    //
    // The derivation below MUST match DataSourcesSection's `rhConnected` /
    // `sfConnected` / `tableauConnected` logic exactly — single source of truth.
    // If these ever disagree, the header counter will contradict the card colors.
    //
    // BKL-UX65: Keeps the 10s initial timeout behaviour — if the very first
    // poll hasn't resolved within 10s, flip out of 'loading' into 'issues'.
    const computeConnected = async (sig: AbortSignal) => {
      const [rh, sf, tableau] = await Promise.all([
        fetch('/api/auth/redhat/status',               { signal: sig }).then(r => r.json()).catch(() => ({ hasSession: false, sessionExpired: false, lastScraped: null })),
        fetch('/api/auth/salesforce/status',           { signal: sig }).then(r => r.json()).catch(() => ({ hasSession: false, lastSync: null, syncError: null })),
        fetch('/api/bootstrap/tableau/session-status', { signal: sig }).then(r => r.json()).catch(() => ({ reachable: false, sessionValid: false })),
      ])
      // Mirror DataSourcesSection's derivation exactly (SetupPage.tsx ~L3094-3143):
      //   rhConnected    = hasSession && !sessionExpired && !!lastScraped
      //                    (card allows scraperRunning.rh to count; parent scope
      //                    has no access to that ref, so require lastScraped
      //                    instead — matches steady-state card color)
      //   sfConnected    = hasSession && !syncError(session expired) && !!lastSync
      //   tableauConnected = sessionValid
      const rhConnected = !!(rh.hasSession && !rh.sessionExpired && rh.lastScraped && rh.liveReachable !== false)
      const sfExpired = sf.sessionExpired || !!sf.syncError
      const sfConnected = !!(sf.hasSession && !sfExpired && sf.lastSync)
      const tableauConnected = tableau.sessionValid === true && tableau.reachable !== false
      return [rhConnected, sfConnected, tableauConnected].filter(Boolean).length
    }

    let firstResolved = false
    const refreshConnected = async () => {
      try {
        const connected = await computeConnected(signal)
        firstResolved = true
        setDataSourcesConnected(connected)
        setDataSourcesHealth(connected < DATA_SOURCE_TOTAL ? 'issues' : 'healthy')
      } catch (e) {
        if ((e as Error | undefined)?.name !== 'AbortError') { /* swallow network blips; next tick retries */ }
      }
    }
    refreshConnected()
    const timeout = setTimeout(() => {
      if (!firstResolved) setDataSourcesHealth('issues')
    }, 10_000)
    // Poll the counter every 10s so the badge reflects reality while the
    // accordion is collapsed. When the accordion is open, DataSourcesSection's
    // own onHealthChange callback also updates this state — both paths write
    // the same value, so there is no conflict.
    const counterInterval = setInterval(refreshConnected, 10_000)

    // OAuth return: open AEs section and clean URL so the child AutoBootstrapForm can restore state
    const params = new URLSearchParams(window.location.search)
    if (params.get('step') === '2') {
      setOpenSection('aes')
      window.history.replaceState({}, '', '/dashboard/setup')
    }
    // Listen for SaveAeButton saves (Auto Setup flow) to keep counter accurate
    const onAeSaved = (e: Event) => {
      const count = (e as CustomEvent).detail?.count
      if (typeof count === 'number') setAeCount(count)
      else fetch('/api/aes').then(r => r.json()).then(d => setAeCount((d.aes ?? []).length)).catch(() => {})
    }
    window.addEventListener('ae-saved', onAeSaved)
    return () => {
      controller.abort()
      clearTimeout(timeout)
      clearInterval(counterInterval)
      window.removeEventListener('ae-saved', onAeSaved)
    }
  }, [])

  // First-run auto-expand logic — fires only once before user interacts with accordion.
  // Uses a ref guard so background data refreshes never re-trigger auto-expand.
  useEffect(() => {
    if (userToggledRef.current) return // user already interacted — never auto-expand again
    if (openSection !== null) return // already auto-expanded from OAuth return or prior run
    if (!oauthKeysOk && aeCount !== null) {
      setOpenSection('oauth-keys')
    } else if (oauthKeysOk && googleAuthOk === false && aeCount !== null) {
      setOpenSection('google-auth')
    } else if (oauthKeysOk && googleAuthOk === true && aeCount === 0) {
      setOpenSection('aes')
    }
  }, [oauthKeysOk, googleAuthOk, aeCount])

  const toggleSection = (id: SectionId) => {
    userToggledRef.current = true // lock out auto-expand once user interacts
    setOpenSection(prev => prev === id ? null : id)
  }

  const doReset = async (full: boolean) => {
    setResetting(true)
    setResetConfirm(null)
    setResetError(null)
    try {
      const res = await fetch(`/api/setup/reset?confirm=true${full ? '&full=true' : ''}`, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as any
        setResetting(false)
        setResetError(d.error ?? `Reset failed (${res.status})`)
        return
      }
    } catch (e: any) {
      setResetting(false)
      setResetError(e?.message ?? 'Reset failed — server unreachable')
      return
    }
    // Use replace() to guarantee a full reload even if already on /dashboard/setup
    window.location.replace('/dashboard/setup')
  }

  return (
    <div className="min-h-screen bg-bg text-white flex flex-col">
      <div className="w-full max-w-2xl mx-auto px-4 py-12 flex-1">
        {/* Header — Concept B: Horizontal Brand Bar */}
        <div className="mb-10">
          <div className="flex items-start gap-4">
            {/* Red Hat brand icon */}
            <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-[#EE0000] shrink-0">
              <span className="text-white text-sm font-bold leading-none">RH</span>
            </div>
            {/* Title + subtitle */}
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold text-white leading-tight">Daily Brief Dashboard</h1>
              <p className="text-accent text-sm mt-0.5">ASA Command Center</p>
            </div>
            {/* Reset buttons — right side of flex row */}
            <div className="shrink-0 flex flex-col items-end gap-1">
              {resetError && (
                <div className="text-xs text-critical bg-critical/10 border border-critical/30 rounded px-2 py-1 max-w-[220px] text-right">
                  {resetError}
                </div>
              )}
              {resetConfirm ? (
                <div className="flex items-center gap-2 bg-critical/15 border border-critical/30 rounded-lg px-3 py-1.5">
                  <span className="text-xs text-critical">
                    {resetConfirm === 'full' ? 'Clears everything including OAuth keys.' : 'Clears data, keeps OAuth keys.'}
                  </span>
                  <button onClick={() => doReset(resetConfirm === 'full')} disabled={resetting} className="text-xs bg-critical hover:bg-critical/80 text-white px-2 py-0.5 rounded disabled:opacity-50">
                    {resetting ? 'Clearing…' : 'Confirm'}
                  </button>
                  <button onClick={() => setResetConfirm(null)} className="text-xs text-text-secondary hover:text-white">Cancel</button>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => setResetConfirm('full')}
                    className="text-xs text-text-secondary hover:text-critical transition-colors"
                    title="Clear everything including OAuth keys"
                  >
                    Full Reset
                  </button>
                  <button
                    onClick={() => setResetConfirm('data')}
                    className="text-xs text-text-secondary/70 hover:text-text-secondary transition-colors"
                    title="Clear data but keep OAuth keys"
                  >
                    Reset Data Only
                  </button>
                </>
              )}
            </div>
          </div>
          {/* Divider */}
          <div className="h-0.5 bg-gradient-to-r from-accent/50 to-transparent mt-4" />
        </div>

        {/* Q1: Reduce Permissions banner — only show when at least one AE is fully configured */}
        {aeCount !== null && aeCount > 0 && (
          <div className="mb-6 flex items-start gap-3 bg-warning/10 border border-warning/30/50 rounded-xl px-4 py-3">
            <span className="text-warning mt-0.5 shrink-0">&#x1f512;</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-warning">Reduce Drive permissions</p>
              <p className="text-xs text-text-secondary mt-0.5">Currently authorized with full Drive access. You can downgrade to read-only Drive for day-to-day use.</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <a
                href="/oauth/start?mode=normal"
                className="text-xs bg-warning hover:bg-warning/80 text-white px-3 py-1.5 rounded-lg font-medium transition-colors"
              >
                Reduce Permissions
              </a>
            </div>
          </div>
        )}

        {/* Accordion sections */}
        <div className="space-y-3">
          <AccordionSection
            id="oauth-keys"
            title="Step 1 of 5 — OAuth Keys"
            badge={
              oauthKeysOk
                ? <StatusBadge ok={true} label="Configured" />
                : <StatusBadge ok={false} label="Not configured" />
            }
            isOpen={openSection === 'oauth-keys'}
            onToggle={() => toggleSection('oauth-keys')}
          >
            <Step0OAuthKeys onReady={() => setOauthKeysOk(true)} />
          </AccordionSection>

          <AccordionSection
            id="google-auth"
            title="Step 2 of 5 — Google Auth"
            badge={
              googleAuthOk === null
                ? <StatusBadge ok={null} label="Checking..." />
                : googleAuthOk
                  ? <StatusBadge ok={true} label="Connected" />
                  : <StatusBadge ok={false} label="Not connected" />
            }
            isOpen={openSection === 'google-auth'}
            onToggle={() => toggleSection('google-auth')}
          >
            <GoogleAuthSection />
          </AccordionSection>

          <AccordionSection
            id="rh-portal"
            title="Step 3 of 5 — Connections"
            badge={
              dataSourcesHealth === 'loading'
                ? <span className="text-xs text-text-secondary">Checking...</span>
                : dataSourcesHealth === 'issues'
                  ? <span className="text-xs text-warning">{dataSourcesConnected ?? 0}/{DATA_SOURCE_TOTAL} connected</span>
                  : <span className="text-xs text-success">{DATA_SOURCE_TOTAL}/{DATA_SOURCE_TOTAL} connected</span>
            }
            isOpen={openSection === 'rh-portal'}
            onToggle={() => toggleSection('rh-portal')}
          >
            <DataSourcesSection
              onlyConnections={true}
              onHealthChange={(status, count) => { setDataSourcesHealth(status); if (count !== undefined) setDataSourcesConnected(count) }}
            />
          </AccordionSection>

          <AccordionSection
            id="aes"
            title="Step 4 of 5 — AEs & Customers"
            badge={
              aeCount !== null && aeCount > 0
                ? <span className="text-xs bg-success/15 text-success border border-success/30/50 px-2 py-0.5 rounded-full font-medium">
                    {aeCount} AE{aeCount !== 1 ? 's' : ''} configured
                  </span>
                : <StatusBadge ok={false} label="None configured" />
            }
            isOpen={openSection === 'aes'}
            onToggle={() => toggleSection('aes')}
          >
            <AEsCustomersSection onAeCountChange={setAeCount} />
          </AccordionSection>

          <AccordionSection
            id="data-sources"
            title="Step 5 of 5 — Data Sources"
            badge={
              dataSourcesHealth === 'loading'
                ? <span className="text-xs text-text-secondary">Checking...</span>
                : dataSourcesHealth === 'issues'
                  ? <span className="text-xs text-warning">{dataSourcesConnected ?? 0}/{DATA_SOURCE_TOTAL} connected</span>
                  : <span className="text-xs text-success">{DATA_SOURCE_TOTAL}/{DATA_SOURCE_TOTAL} connected</span>
            }
            isOpen={openSection === 'data-sources'}
            onToggle={() => toggleSection('data-sources')}
          >
            <DataSourcesSection
              hideConnections={true}
              onHealthChange={(status, count) => { setDataSourcesHealth(status); if (count !== undefined) setDataSourcesConnected(count) }}
            />
          </AccordionSection>

          <AccordionSection
            id="settings"
            title="Refresh Timer & Settings"
            badge={<span className="text-xs text-text-secondary">Optional</span>}
            isOpen={openSection === 'settings'}
            onToggle={() => toggleSection('settings')}
          >
            <div className="space-y-4">
              <RefreshTimerSettings />
              {/* BKL-E04: Morning Brief Email delivery settings */}
              <EmailSettingsSection />
              <a
                href="/dashboard"
                className="block w-full text-center bg-accent hover:bg-accent/80 text-white px-6 py-3 rounded-xl font-semibold text-base transition-colors"
              >
                Open Dashboard
              </a>
            </div>
          </AccordionSection>

          <AccordionSection
            id="ai-settings"
            title="AI & Intelligence Settings"
            badge={<span className="text-xs text-text-secondary">Optional</span>}
            isOpen={openSection === 'ai-settings'}
            onToggle={() => toggleSection('ai-settings')}
          >
            <AiIntelligenceSettings />
          </AccordionSection>

          <AccordionSection
            id="automation-settings"
            title="Automation & Limits"
            badge={<span className="text-xs text-text-secondary">Optional</span>}
            isOpen={openSection === 'automation-settings'}
            onToggle={() => toggleSection('automation-settings')}
          >
            <AutomationSettings />
          </AccordionSection>
        </div>

        {/* Quick link to dashboard */}
        <div className="mt-8 text-center">
          <a
            href="/dashboard"
            className="text-sm text-text-secondary hover:text-white transition-colors underline"
          >
            Go to Dashboard
          </a>
        </div>

        {/* Version footer */}
        <div className="mt-6 text-center">
          <VersionFooter />
        </div>
      </div>
    </div>
  )
}

// Also export as named for compatibility
export { SetupPage }
