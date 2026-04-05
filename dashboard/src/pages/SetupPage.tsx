import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatRelTime } from '../lib/format'
import { RefreshTimerSettings } from '../components/RefreshTimerSettings'
import { EmailSettingsSection } from '../components/EmailSettingsSection'
import CopyButton from '../components/CopyButton'
import {
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
      navigate('/admin')
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
                className="w-full bg-bg border border-border rounded-lg p-3 font-mono text-xs text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent resize-none"
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
  status: 'pending' | 'running' | 'done' | 'error'
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

function AutoBootstrapProgress({ state, onReset, tableauSessionNeeded }: { state: AutoBootstrapState; onReset?: () => void; tableauSessionNeeded?: boolean | null }) {
  const hasError = state.steps.some(s => s.status === 'error')

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
    const label = `Step ${stepIndex + 1}: ${s === 'done' ? 'Complete' : s === 'running' ? 'Running' : s === 'error' ? 'Failed' : 'Pending'} — ${stepName}`
    switch (s) {
      case 'pending': return <span aria-label={label} className="relative z-10 inline-flex w-6 h-6 rounded-full border-2 border-border bg-bg items-center justify-center" />
      case 'running': return <span aria-label={label} className="relative z-10 inline-flex w-6 h-6 rounded-full border-2 border-accent bg-bg items-center justify-center"><Loader2 className="w-3.5 h-3.5 animate-spin text-accent" /></span>
      case 'done':    return <span aria-label={label} className="relative z-10 inline-flex w-6 h-6 rounded-full border-2 border-success bg-bg items-center justify-center"><CheckCircle className="w-3.5 h-3.5 text-success" /></span>
      case 'error':   return <span aria-label={label} className="relative z-10 inline-flex w-6 h-6 rounded-full border-2 border-critical bg-bg items-center justify-center"><XCircle className="w-3.5 h-3.5 text-critical" /></span>
    }
  }

  return (
    <div className="mt-4 space-y-4" aria-live="polite">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-text-primary">
          {state.completedAt ? `Setup ${hasError ? 'finished with errors' : 'complete'} — ${state.aeName}` : `Setting up ${state.aeName}…`}
        </p>
        {state.running && elapsed && (
          <p className="text-xs text-text-secondary">{elapsed}</p>
        )}
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
                step.status === 'error'   ? 'text-critical' :
                step.status === 'done'    ? 'text-success' :
                step.status === 'running' ? 'text-white font-medium' :
                'text-text-secondary'
              }>
                {step.name}
              </span>
              {step.detail && (
                <p className={`text-xs mt-0.5 truncate max-w-lg ${step.status === 'error' ? 'text-critical/80' : 'text-text-secondary'}`} {...(step.status === 'error' ? { role: 'alert' } : {})}>{step.detail}</p>
              )}
              {/* Tableau login prompt — only shown when reachable but session invalid */}
              {step.name === 'Create CCSP Sheet' && step.status === 'done' && tableauSessionNeeded === true && (
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="text-xs text-warning">Tableau session required to populate CCSP data</span>
                  <button
                    onClick={async () => {
                      await fetch('/api/bootstrap/tableau/open-login', { method: 'POST' })
                      window.open('http://localhost:6080/vnc.html?autoconnect=1&resize=scale', 'tableau-login', 'width=1280,height=900')
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
          {/* Q4: Per-step retry guidance for failed steps */}
          {hasError && (() => {
            const failedSteps = state.steps.filter(s => s.status === 'error')
            if (failedSteps.length === 0) return null
            const hintFor = (stepName: string): string => {
              if (stepName.toLowerCase().includes('rh portal') || stepName.toLowerCase().includes('red hat') || stepName.toLowerCase().includes('account'))
                return 'RH Portal auth failed — scroll up to Step 3 and reconnect.'
              if (stepName.toLowerCase().includes('supportable'))
                return 'Supportable sheet failed — check VPN connection and retry.'
              if (stepName.toLowerCase().includes('drive') || stepName.toLowerCase().includes('folder'))
                return 'Drive folder failed — verify Google Auth is connected in Step 2.'
              if (stepName.toLowerCase().includes('ccsp') || stepName.toLowerCase().includes('tableau'))
                return 'CCSP sheet failed — connect Tableau in Data Sources (Step 5).'
              if (stepName.toLowerCase().includes('pipeline') || stepName.toLowerCase().includes('salesforce'))
                return 'Pipeline sheet failed — check Salesforce connection in Step 5.'
              if (stepName.toLowerCase().includes('territory'))
                return 'Territory lookup failed — verify Google Sheets access in Step 2.'
              return 'Step failed — check server logs and click "Clear stuck state" to retry.'
            }
            return (
              <div className="mb-3 space-y-1">
                {failedSteps.map((s, i) => (
                  <p key={i} className="text-xs text-warning bg-warning/10 border border-warning/20 rounded px-2 py-1.5">
                    <span className="font-medium">{s.name}</span> — {hintFor(s.name)}
                  </p>
                ))}
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
                    {unmatched.length} customer{unmatched.length !== 1 ? 's' : ''} had no Supportable matches:
                  </p>
                  <ul className="mt-0.5 list-disc list-inside">
                    {unmatched.map(name => (
                      <li key={name} className="text-xs text-warning">{name}</li>
                    ))}
                  </ul>
                  <p className="text-xs text-text-secondary mt-1">Check that the name exactly matches what Supportable shows. Edit the customer list and re-run to correct.</p>
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

function AutoBootstrapForm() {
  const [aeName, setAeName] = useState('')
  const [sfReportId, setSfReportId] = useState('')
  const [sfReportIdError, setSfReportIdError] = useState<string | null>(null)
  const [sfReports, setSfReports] = useState<SfReport[]>([])
  const [customerText, setCustomerText] = useState('')
  const [parentFolderId, setParentFolderId] = useState('')
  const [folderName, setFolderName] = useState<string | null>(null)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [knownAes, setKnownAes] = useState<Array<{ name: string; tableauTerritories?: string[]; accounts?: string[] }>>([])
  const bootstrapStartingRef = useRef(false)

  // Territory picker state — pod + terrNum are source of truth; territoryInput is derived
  const [pod, setPod] = useState('')
  const [terrNum, setTerrNum] = useState('')
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

  const PENDING_KEY = 'pai_pending_bootstrap'

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/bootstrap/auto/status', { signal: controller.signal })
      .then(r => r.json())
      .then((d: AutoBootstrapState) => { if (d.running || d.completedAt) setBootstrapState(d) })
      .catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })
    fetch('/api/aes', { signal: controller.signal })
      .then(r => r.json())
      .then((d: { aes: Array<{ name: string; tableauTerritories?: string[]; accounts?: string[] }> }) => setKnownAes(d.aes ?? []))
      .catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })
    fetch('/api/sf/reports', { signal: controller.signal })
      .then(r => r.json())
      .then((d: { reports: SfReport[] }) => { if (d.reports?.length) setSfReports(d.reports) })
      .catch(() => {})

    // Restore form state after OAuth redirect — check sessionStorage directly (no URL guard).
    // The key is set just before the OAuth redirect and consumed here on first mount.
    // No URL dependency needed; the key is ephemeral and removed immediately after reading.
    const saved = sessionStorage.getItem(PENDING_KEY)
    if (saved) {
      try {
        const { sfReportId: savedSf, parentFolderId: savedPf, pod: savedPod, terrNum: savedTn } = JSON.parse(saved)
        if (savedSf) setSfReportId(savedSf)
        if (savedPf) setParentFolderId(savedPf)
        if (savedPod) setPod(savedPod)
        if (savedTn) setTerrNum(savedTn)
        setAutoStartPending(true)
        sessionStorage.removeItem(PENDING_KEY)
      } catch {}
    }
    return () => controller.abort()
  }, [])

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

  // Auto-start bootstrap once all fields are populated after OAuth return redirect
  useEffect(() => {
    if (!autoStartPending) return
    if (!aeName.trim() || !sfReportId.trim() || !territoryInput || !customerText.trim()) return
    setAutoStartPending(false)
    startBootstrap()
  }, [autoStartPending, aeName, sfReportId, territoryInput, customerText])

  function handleAeNameBlur() {
    if (!customerText.trim()) {
      const match = knownAes.find(a => a.name.toLowerCase() === aeName.trim().toLowerCase())
      if (match?.accounts?.length) {
        setCustomerText(match.accounts.join('\n'))
      }
    }
  }

  // Start auto-bootstrap
  const startBootstrap = async () => {
    // E2: prevent double-trigger from autoStartPending or rapid clicks
    if (bootstrapStartingRef.current) return
    bootstrapStartingRef.current = true

    const customerNames = customerText.split('\n').map(s => s.trim()).filter(Boolean)
    const territories = territoryInput.split(',').map(s => s.trim()).filter(Boolean)

    if (!aeName.trim() || !sfReportId.trim() || !territories.length || !customerNames.length) {
      bootstrapStartingRef.current = false
      return
    }

    // Q11: SF Report ID format check
    if (!/^00O[a-zA-Z0-9]{12,15}$/.test(sfReportId.trim())) {
      setSfReportIdError('Must start with 00O and be 15–18 characters (e.g. 00OPe000001abcDEF)')
      bootstrapStartingRef.current = false
      return
    }

    setPreflightError(null)
    setSfReportIdError(null)

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
        const vr = await fetch('/api/aes/validate-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderUrl: parentFolderId.trim() }),
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
          sfReportId: sfReportId.trim(),
          tableauTerritories: territories,
          customerNames,
          parentFolderId: parentFolderId.trim() || undefined,
        }),
      })
      const d = await r.json()
      if (d.error) {
        if (d.action === 'redirect' && d.url) {
          // Need elevated Google permissions — save form state, then redirect to bootstrap OAuth
          sessionStorage.setItem(PENDING_KEY, JSON.stringify({
            sfReportId: sfReportId.trim(),
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
        setBootstrapState(d)
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
    // Q13: preserve sfReportId across AE resets — most AEs share the same SF report
    const preservedSfReportId = sfReportId
    setBootstrapState(null); setAeName(''); setCustomerText(''); setPod(''); setTerrNum('')
    setSfReportId(preservedSfReportId)
    setTableauSessionNeeded(null)
    bootstrapStartingRef.current = false
  }
  const customerNames = customerText.split('\n').map(s => s.trim()).filter(Boolean)
  const territories = territoryInput.split(',').map(s => s.trim()).filter(Boolean)
  const canStart = aeName.trim() && sfReportId.trim() && territories.length > 0 && customerNames.length > 0

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
      <div className="bg-accent/10 border border-accent/30 rounded-xl px-4 py-3 space-y-1.5">
        <p className="text-sm font-medium text-accent">Automated AE setup — one click to fully configured</p>
        <p className="text-xs text-accent/80 leading-relaxed">
          Creates a Drive folder, discovers RH Portal account numbers, and generates all data sheets automatically.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <div>
          <label className="block text-xs text-text-secondary mb-1">AE Name *</label>
          <input
            type="text"
            value={aeName}
            onChange={e => setAeName(e.target.value)}
            onBlur={handleAeNameBlur}
            placeholder="Jane Smith"
            className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent"
          />
        </div>

        <div>
          <label className="block text-xs text-text-secondary mb-1">SF Report ID *</label>
          {sfReports.length > 0 ? (
            <select
              value={sfReportId}
              onChange={e => { setSfReportId(e.target.value); setSfReportIdError(null) }}
              className={`w-full bg-surface border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent ${sfReportIdError ? 'border-critical' : 'border-border'}`}
            >
              <option value="">— Select a report —</option>
              {sfReports.map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={sfReportId}
              onChange={e => { setSfReportId(e.target.value); setSfReportIdError(null) }}
              onBlur={() => {
                const val = sfReportId.trim()
                if (val && !/^00O[a-zA-Z0-9]{12,15}$/.test(val)) {
                  setSfReportIdError('Must start with 00O and be 15–18 characters (e.g. 00OPe000001abcDEF)')
                }
              }}
              placeholder="00OPe000001abcDEF"
              className={`w-full bg-surface border rounded-lg px-3 py-2 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent ${sfReportIdError ? 'border-critical' : 'border-border'}`}
            />
          )}
          {sfReportIdError && <p className="text-xs text-critical mt-1">{sfReportIdError}</p>}
          <p className="text-xs text-text-secondary mt-1.5">
            Paste your Salesforce Pipeline report ID or full Lightning URL. Required columns: Opportunity Name, Account Name, Amount, Stage, Forecast Category, Close Date, Opportunity Owner.{' '}
            <a href="/docs/SF-REPORT-SETUP.md" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Setup guide →</a>
          </p>
        </div>

        <div>
          <label className="block text-xs text-text-secondary mb-0.5">Account Territories *</label>
          <p className="text-xs text-text-secondary mb-2">Selects your territory for CCSP scoping and auto-fills AE name + customer list from the territory sheet. Select your POD then the territory number.</p>
          <div className="space-y-2">
            <div className="flex gap-2">
              <div className="flex-1">
                <p className="text-xs text-text-secondary mb-1">POD / Region</p>
                <select
                  value={pod}
                  onChange={e => { setPod(e.target.value); setTerrNum('') }}
                  className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent"
                >
                  <option value="">Select POD…</option>
                  <option value="WEST_COMM_CORP_NORTHWEST">Northwest Corp</option>
                  <option value="WEST_COMM_CORP_SOUTHWEST">Southwest Corp</option>
                  <option value="WEST_COMM_CORP_NORTHCENTRAL">North Central Corp</option>
                  <option value="WEST_COMM_CORP_SOUTHCENTRAL">South Central Corp</option>
                </select>
              </div>
              <div className="w-48">
                <p className="text-xs text-text-secondary mb-1">Territory</p>
                <select
                  value={terrNum}
                  onChange={e => setTerrNum(e.target.value)}
                  disabled={!pod}
                  className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent disabled:opacity-40"
                >
                  <option value="">Select…</option>
                  {podTerritoryOptions.map(opt => (
                    <option key={opt.num} value={opt.num}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>
            {territoryInput && (
              <p className="text-xs text-text-secondary font-mono">{territoryInput}</p>
            )}
            {matchedAe ? (
              <p className="text-xs text-success">→ {matchedAe.name}{matchedAe.accounts?.length ? ` · ${matchedAe.accounts.length} accounts pre-loaded` : ''}</p>
            ) : territoryLoading ? (
              <p className="text-xs text-text-secondary flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading territory data from sheet…</p>
            ) : territoryInput && !aeName ? (
              <p className="text-xs text-warning">No AE data for this territory — enter AE name and accounts manually below</p>
            ) : territoryInput && aeName ? (
              <p className="text-xs text-success">→ {aeName} · loaded from territory sheet</p>
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
            value={customerText}
            onChange={e => setCustomerText(e.target.value)}
            placeholder={"Acme Corp\nGlobex Industries\nStark Enterprises"}
            rows={5}
            className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent resize-y"
          />
          {customerNames.length > 0 && (
            <p className="text-xs text-text-secondary mt-1">{customerNames.length} customer(s) — names must match Supportable exactly. Edit before starting if needed.</p>
          )}
        </div>

        <div>
          <label className="block text-xs text-text-secondary mb-1">Parent Drive Folder (optional)</label>
          <input
            type="text"
            value={parentFolderId}
            onChange={e => { setParentFolderId(e.target.value); setFolderName(null); setFolderError(null) }}
            onBlur={async () => {
              const val = parentFolderId.trim()
              if (!val) { setFolderName(null); setFolderError(null); return }
              try {
                const r = await fetch('/api/aes/validate-folder', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ folderUrl: val }),
                })
                const d = await r.json()
                if (d.error) { setFolderError('Folder not found — check the URL'); setFolderName(null) }
                else { setFolderName(d.folderName); setFolderError(null) }
              } catch { setFolderError('Could not reach Drive API'); setFolderName(null) }
            }}
            placeholder="Paste Google Drive folder URL or leave blank for My Drive root"
            className={`w-full bg-surface border rounded-lg px-3 py-2 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent ${folderError ? 'border-critical' : folderName ? 'border-success' : 'border-border'}`}
          />
          {folderName && <p className="text-xs text-success mt-1">✓ {folderName}</p>}
          {folderError && <p className="text-xs text-critical mt-1">✗ {folderError}</p>}
        </div>
      </div>

      {/* Hierarchy preview — shows exactly what bootstrap creates (D2: no per-customer subfolders) */}
      {aeName.trim() && (
        <div className="bg-bg border border-border rounded-lg p-3 text-xs font-mono space-y-0.5">
          <p className="text-text-secondary mb-1 font-sans text-xs font-medium">What will be created:</p>
          <p className="text-text-primary">
            📁 {folderName ? <span className="text-success">{folderName}</span> : parentFolderId.trim() ? <span className="text-accent">parent folder</span> : 'My Drive'}/
          </p>
          <p className="text-text-primary pl-4">└── 📁 {aeName.trim()}/</p>
          <p className="text-text-secondary pl-8">├── 📊 Supportable Sheet</p>
          <p className="text-text-secondary pl-8">├── 📊 CCSP Sheet</p>
          <p className="text-text-secondary pl-8">└── 📊 Pipeline Sheet</p>
        </div>
      )}

      {/* Q5: Prerequisites callout — shown before starting bootstrap */}
      <div className="bg-accent/5 border border-accent/20 rounded-lg px-3 py-2.5 text-xs text-text-secondary space-y-1">
        <p className="font-medium text-text-primary text-xs">Before you start:</p>
        <ul className="space-y-0.5 list-disc list-inside">
          <li>This takes <span className="text-white">7–15 minutes</span> to complete</li>
          <li>You must be connected to <span className="text-white">Red Hat VPN</span></li>
          <li>A <span className="text-white">Tableau VNC popup</span> will appear mid-run — leave it open</li>
        </ul>
      </div>

      {preflightError && (
        <p className="text-xs text-critical bg-critical/10 border border-critical/30 rounded px-3 py-2">{preflightError}</p>
      )}

      <div className="flex justify-end pt-1">
        <button
          onClick={startBootstrap}
          disabled={!canStart || starting}
          className="flex items-center gap-2 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          {starting ? 'Starting...' : 'Set Up AE'}
        </button>
      </div>
    </div>
  )
}

function AEsCustomersSection({ onAeCountChange }: { onAeCountChange?: (count: number) => void }) {
  const [mode, setMode] = useState<'auto' | 'manual'>('auto')
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

        // Manual mode only shows AEs that have been fully bootstrapped (have a Drive folder)
        const configuredAes = serverAes.filter(ae => ae.driveFolderId)
        if (configuredAes.length > 0) setMode('manual') // auto-switch to edit view when AEs exist
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

  return (
    <div className="space-y-5">
      {/* Mode toggle */}
      <div className="flex items-center gap-1 bg-surface rounded-lg p-1 w-fit">
        <button
          onClick={() => setMode('auto')}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            mode === 'auto'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:text-white'
          }`}
        >
          Auto Setup
        </button>
        <button
          onClick={() => setMode('manual')}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            mode === 'manual'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:text-white'
          }`}
        >
          Edit / View
        </button>
      </div>

      {mode === 'auto' ? (
        <AutoBootstrapForm />
      ) : (
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
                  saveMsg?.includes(`AE #${aeIdx + 1}`) ? 'border-critical' : 'border-border'
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
                  onChange={e => updateAE(ae.id, { folderUrl: e.target.value })}
                  placeholder="https://drive.google.com/drive/folders/..."
                  className="flex-1 bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent"
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
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-text-secondary mb-1">Supportable Sheet ID</label>
                <input
                  type="text"
                  value={ae.supportableSheetId}
                  onChange={e => updateAE(ae.id, { supportableSheetId: e.target.value })}
                  placeholder="Google Sheet ID"
                  className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white placeholder-text-secondary focus:outline-none focus:border-accent"
                />
              </div>
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
                    <th className="text-left py-2 pr-2 font-medium">Supportable Name</th>
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
                          value={c.supportableName}
                          onChange={e => updateCustomer(ae.id, c.id, { supportableName: e.target.value })}
                          placeholder="If different in Supportable"
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
                          className="text-text-secondary/50 hover:text-critical transition-colors p-1"
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

  const fetchStatus = async (signal?: AbortSignal) => {
    try {
      const d: RhStatus = await fetch('/api/auth/redhat/status', { signal }).then((r) => r.json())
      setStatus(d)
      if (d.hasSession && !d.sessionExpired) onConnected?.()
      if (d.loginInProgress) loginStartedRef.current = true
      if (d.hasSession && !d.loginInProgress && connecting && loginStartedRef.current) {
        setConnecting(false)
        popupRef.current?.close()
        popupRef.current = null
        fetch('/api/scrape/rh', { method: 'POST', signal }).catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })
      }
    } catch (e: any) { if (e.name !== 'AbortError') { /* ignore */ } }
  }

  useEffect(() => {
    const controller = new AbortController()
    fetchStatus(controller.signal)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!connecting) return
    const controller = new AbortController()
    const interval = setInterval(() => fetchStatus(controller.signal), 2_000)
    return () => { controller.abort(); clearInterval(interval) }
  }, [connecting])

  const handleConnect = async () => {
    setError(null)
    loginStartedRef.current = false
    setConnecting(true)
    try {
      const res = await fetch('/api/auth/redhat/start', { method: 'POST' })
      const d = await res.json()
      if (d.error) {
        // Sanitize raw Playwright/Chromium errors into user-readable messages
        const raw: string = d.error
        let msg: string
        if (raw.includes('locked the profile') || raw.includes('in use by another') || raw.includes('SingletonLock')) {
          msg = 'Browser profile was locked by a stale process. The lock has been cleared — try connecting again.'
        } else if (raw.includes('has been closed') || raw.includes('Target page')) {
          msg = 'Browser session closed unexpectedly — try connecting again.'
        } else if (raw.includes('Login already in progress')) {
          msg = 'Login already in progress — cancel first or wait.'
        } else {
          msg = raw.split(/\n|Browser logs:/)[0].trim()
          if (msg.length > 140) msg = msg.slice(0, 140) + '…'
        }
        setError(msg)
        setConnecting(false)
      } else {
        // Open VNC viewer as a popup — store reference so we can close it when login completes
        popupRef.current = window.open('http://localhost:6080/vnc.html?autoconnect=1&resize=scale', 'rh-login', 'width=1280,height=900')
      }
    } catch (e: any) {
      setError(e.message)
      setConnecting(false)
    }
  }

  const handleCancel = async () => {
    await fetch('/api/auth/redhat/session', { method: 'DELETE' }).catch(() => {})
    popupRef.current?.close()
    popupRef.current = null
    setConnecting(false)
    fetchStatus()
  }

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
              <p className="text-white text-sm font-medium">Browser window opened</p>
              <p className="text-text-secondary text-xs mt-0.5">
                Log in to access.redhat.com, then return here. Session saves automatically.
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

function DataSourcesSection({ onHealthChange }: { onHealthChange?: (status: 'loading' | 'healthy' | 'issues') => void }) {
  const [supportableStatus, setSupportableStatus] = useState<{
    running: boolean
    lastScrape: string | null
    lastError: string | null
    recordCount?: number | null
  } | null>(null)
  const [sfStatus, setSfStatus] = useState<{
    hasSession: boolean
    lastSync: string | null
    rowCount: number
    syncError: string | null
    reportConfigured: boolean
  } | null>(null)
  const [rhStatus, setRhStatus] = useState<{
    hasSession: boolean
    sessionExpired: boolean
    lastScraped: string | null
    caseCount: number
  } | null>(null)

  const [ccspStatus, setCcspStatus] = useState<{
    running: boolean
    lastScrape: string | null
    lastError: string | null
    recordCount?: number | null
  } | null>(null)
  const [scraping, setScraping] = useState(false)
  const [scrapeError, setScrapeError] = useState<string | null>(null)
  const [supportableSyncMsg, setSupportableSyncMsg] = useState<string | null>(null)
  const supportablePollMsgRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [ccspScraping, setCcspScraping] = useState(false)
  const [ccspScrapeError, setCcspScrapeError] = useState<string | null>(null)
  const [ccspSyncedAt, setCcspSyncedAt] = useState<string | null>(null)
  const [sfSyncing, setSfSyncing] = useState(false)
  const [sfSyncError, setSfSyncError] = useState<string | null>(null)
  const [rhSyncing, setRhSyncing] = useState(false)
  const [rhSyncError, setRhSyncError] = useState<string | null>(null)

  // BKL-G22: Poll /api/scraper-status so Sync buttons reflect live running state
  // even when a scrape was triggered externally or on page load mid-run.
  const [scraperRunning, setScraperRunning] = useState<{
    rh: boolean; supportable: boolean; ccsp: boolean; salesforce: boolean
  }>({ rh: false, supportable: false, ccsp: false, salesforce: false })
  const scraperPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    const fetchScraperStatus = () => {
      fetch('/api/scraper-status')
        .then(r => r.json())
        .then(d => {
          const s = d.scrapers ?? {}
          setScraperRunning({
            rh:         s['rh-cases']?.state === 'running',
            supportable: s['supportable']?.state === 'running',
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

  // Connection flow state
  const [tableauStatus, setTableauStatus] = useState<{ reachable: boolean; sessionValid: boolean } | null>(null)
  const [supportableReachable, setSupportableReachable] = useState<boolean | null>(null)
  const [supportableVpnError, setSupportableVpnError] = useState(false)
  const [supportableConnecting, setSupportableConnecting] = useState(false)
  const supportableVncRef = useRef<Window | null>(null)
  const [sfConnecting, setSfConnecting] = useState(false)
  const sfVncRef = useRef<Window | null>(null)
  const [tableauConnecting, setTableauConnecting] = useState(false)
  const tableauVncRef = useRef<Window | null>(null)

  // Polling interval refs for cleanup
  const supportablePollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sfPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const tableauPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshAll = (signal?: AbortSignal) => {
    fetch('/api/auth/supportable/check', { method: 'POST', signal }).then(r => r.json()).then(d => setSupportableReachable(d.reachable)).catch((e) => { if (e.name !== 'AbortError') setSupportableReachable(false) })
    fetch('/api/scrape/supportable/status', { signal }).then(r => r.json()).then(setSupportableStatus).catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })
    fetch('/api/scrape/ccsp/status', { signal }).then(r => r.json()).then(setCcspStatus).catch((e) => { if (e.name !== 'AbortError') setCcspStatus({ running: false, lastScrape: null, lastError: 'Unreachable' }) })
    fetch('/api/auth/salesforce/status', { signal }).then(r => r.json()).then(setSfStatus).catch((e) => { if (e.name !== 'AbortError') setSfStatus({ hasSession: false, lastSync: null, rowCount: 0, syncError: 'Unreachable', reportConfigured: false }) })
    fetch('/api/auth/redhat/status', { signal }).then(r => r.json()).then(setRhStatus).catch((e) => { if (e.name !== 'AbortError') setRhStatus({ hasSession: false, sessionExpired: false, lastScraped: null, caseCount: 0 }) })
    fetch('/api/bootstrap/tableau/session-status', { signal }).then(r => r.json()).then(setTableauStatus).catch((e) => { if (e.name !== 'AbortError') setTableauStatus({ reachable: false, sessionValid: false }) })
  }

  useEffect(() => {
    const controller = new AbortController()
    refreshAll(controller.signal)
    return () => controller.abort()
  }, [])

  // Cleanup polling intervals on unmount
  useEffect(() => {
    return () => {
      if (supportablePollRef.current) clearInterval(supportablePollRef.current)
      if (sfPollRef.current) clearInterval(sfPollRef.current)
      if (tableauPollRef.current) clearInterval(tableauPollRef.current)
    }
  }, [])

  const VNC_URL = 'http://localhost:6080/vnc.html?autoconnect=1&resize=scale'

  const handleSupportableConnect = async () => {
    setSupportableConnecting(true)
    setSupportableVpnError(false)
    try {
      const res = await fetch('/api/auth/supportable/check', { method: 'POST' })
      const { reachable } = await res.json()
      if (reachable) {
        setSupportableReachable(true)
      } else {
        setSupportableVpnError(true)
      }
    } catch {
      setSupportableVpnError(true)
    } finally {
      setSupportableConnecting(false)
    }
  }

  const handleSfConnect = async () => {
    setSfConnecting(true)

    // Pre-check: if already fully connected (session + lastSync), skip VNC and just re-sync
    if (!sfConnected) {
      try {
        const res = await fetch('/api/auth/salesforce/status')
        const status = await res.json()
        setSfStatus(status)
        const expired = status.sessionExpired || status.syncError?.toLowerCase().includes('session expired')
        if (status.hasSession && !expired) {
          // Session exists but lastSync is missing (e.g. after container restart).
          // Trigger a sync to populate lastSync instead of silently bailing.
          setSfConnecting(false)
          await fetch('/api/scrape/salesforce', { method: 'POST' }).catch(() => {})
          return
        }
      } catch { /* fall through */ }
    }

    // Start login and open VNC
    try {
      const res = await fetch('/api/auth/salesforce/start', { method: 'POST' })
      const d = await res.json()
      if (d.error) { setSfConnecting(false); return }
    } catch { setSfConnecting(false); return }

    sfVncRef.current = window.open(VNC_URL, 'sf-vnc', 'width=1280,height=900')

    sfPollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/auth/salesforce/status')
        const status = await res.json()
        setSfStatus(status)
        const expired = status.sessionExpired || status.syncError?.toLowerCase().includes('session expired')
        if (status.hasSession && !expired) {
          if (sfPollRef.current) clearInterval(sfPollRef.current)
          sfPollRef.current = null
          setSfConnecting(false)
          sfVncRef.current?.close()
          sfVncRef.current = null
        }
      } catch { /* ignore */ }
    }, 3_000)

    setTimeout(() => {
      if (sfPollRef.current) { clearInterval(sfPollRef.current); sfPollRef.current = null }
      setSfConnecting(false)
    }, 120_000)
  }

  const handleTableauCancel = () => {
    if (tableauPollRef.current) { clearInterval(tableauPollRef.current); tableauPollRef.current = null }
    setTableauConnecting(false)
    tableauVncRef.current?.close()
    tableauVncRef.current = null
  }

  const handleTableauConnect = async () => {
    setTableauConnecting(true)

    // Always re-probe live session status — cached tableauStatus may be stale
    // (Tableau SSO sessions expire faster than RH Portal sessions)
    try {
      const res = await fetch('/api/bootstrap/tableau/session-status')
      const status = await res.json()
      setTableauStatus(status)
      if (status.sessionValid) {
        setTableauConnecting(false)
        return
      }
    } catch { /* fall through to VNC flow */ }

    // Not logged in — open VNC so user can log in
    tableauVncRef.current = window.open(VNC_URL, 'tableau-vnc', 'width=1280,height=900')

    // IMPORTANT: await open-login before starting wait-for-login to avoid a race
    // condition where wait-for-login sees the pre-navigation page state (stale
    // Tableau URL or the initial domcontentloaded before SSO redirect) and returns
    // a false-positive sessionValid: true — which immediately closes the VNC window.
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
      }
      setTableauConnecting(false)
    }

    // Primary: server-side Playwright URL detection
    fetch('/api/bootstrap/tableau/wait-for-login')
      .then(r => r.json())
      .then(status => resolveLogin(status.sessionValid))
      .catch(() => resolveLogin(false))

    // Fallback: poll session-status every 5s — catches cases where wait-for-login
    // detection misses the login (SSO URL variation, slow redirect chain)
    tableauPollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/bootstrap/tableau/session-status')
        const status = await res.json()
        if (status.sessionValid) resolveLogin(true)
      } catch { /* retry next tick */ }
    }, 5_000)

    // Hard cap — stop polling after 120s regardless
    setTimeout(() => resolveLogin(false), 120_000)
  }

  const handleRhSync = async () => {
    setRhSyncError(null)
    setRhSyncing(true)
    try {
      if (!rhStatus?.hasSession) {
        setRhSyncError('No active session — connect in the RH Portal section above first.')
        return
      }
      await fetch('/api/scrape/rh', { method: 'POST' })
      setTimeout(() => fetch('/api/auth/redhat/status').then(r => r.json()).then(setRhStatus).catch(() => {}), 3_000)
    } catch (e: any) {
      setRhSyncError(`Sync failed: ${e.message}`)
    } finally {
      setRhSyncing(false)
    }
  }

  const handleSfSync = async () => {
    setSfSyncError(null)
    setSfSyncing(true)
    try {
      const res = await fetch('/api/refresh/pipeline', { method: 'POST' })
      const d = await res.json()
      if (d.error) { setSfSyncError(d.error); return }
      setTimeout(() => fetch('/api/auth/salesforce/status').then(r => r.json()).then(setSfStatus).catch(() => {}), 1_000)
    } catch (e: any) {
      setSfSyncError('Sync failed. Check server logs for details.')
    } finally {
      setSfSyncing(false)
    }
  }

  const handleRunScrape = async () => {
    setScrapeError(null)
    setScraping(true)
    try {
      const res = await fetch('/api/refresh/subscriptions', { method: 'POST' })
      const d = await res.json()
      if (d.error) { setScrapeError(d.error); return }
      const newStatus = await fetch('/api/scrape/supportable/status').then(r => r.json()).catch(() => null)
      if (newStatus) setSupportableStatus(newStatus)
    } catch (e: any) {
      setScrapeError('Sync failed — check server logs for details.')
    } finally {
      setScraping(false)
    }
  }

  const handleRunCcspScrape = async () => {
    setCcspScrapeError(null)
    setCcspSyncedAt(null)
    setCcspScraping(true)
    try {
      const res = await fetch('/api/refresh/ccsp', { method: 'POST' })
      const d = await res.json()
      if (d.error) { setCcspScrapeError(d.error); return }
      const newStatus = await fetch('/api/scrape/ccsp/status').then(r => r.json()).catch(() => null)
      if (newStatus) setCcspStatus(newStatus)
      setCcspSyncedAt(d.refreshedAt ?? new Date().toISOString())
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
      {label}
    </button>
  )

  // Derived statuses for card border accents
  // BKL-ADM03: session file persists through failed scrapes, so also require
  // that a successful scrape has completed (lastScraped timestamp exists) for RH,
  // and that last sync completed without error for SF.
  const rhScrapeOk = !!rhStatus?.lastScraped
  const rhSessionActive = (rhStatus?.hasSession && !rhStatus?.sessionExpired) ?? false
  const rhConnected = rhSessionActive && rhScrapeOk
  const sfExpired = sfStatus?.syncError?.toLowerCase().includes('session expired')
  const sfScrapeOk = !!sfStatus?.lastSync && !sfStatus?.syncError
  const sfSessionActive = (sfStatus?.hasSession && !sfExpired) ?? false
  const sfConnected = sfSessionActive && sfScrapeOk
  const supportableConnected = supportableReachable === true
  const supportableRunning = supportableStatus?.running ?? false
  const supportableErrored = !!supportableStatus?.lastError || (!supportableStatus?.lastScrape && !supportableStatus?.running)

  // Poll for status message while supportable scrape is running
  useEffect(() => {
    if (supportableRunning) {
      supportablePollMsgRef.current = setInterval(async () => {
        const s = await fetch('/api/scrape/supportable/status').then(r => r.json()).catch(() => null)
        setSupportableSyncMsg(s?.statusMessage ?? null)
        if (!s?.running) {
          clearInterval(supportablePollMsgRef.current!)
          supportablePollMsgRef.current = null
          setSupportableSyncMsg(null)
          setSupportableStatus(s)
        }
      }, 1_500)
    } else {
      if (supportablePollMsgRef.current) {
        clearInterval(supportablePollMsgRef.current)
        supportablePollMsgRef.current = null
      }
      setSupportableSyncMsg(null)
    }
    return () => {
      if (supportablePollMsgRef.current) clearInterval(supportablePollMsgRef.current)
    }
  }, [supportableRunning])
  const ccspConnected = ccspStatus?.lastScrape && !ccspStatus?.running && !ccspStatus?.lastError
  const ccspRunning = ccspStatus?.running ?? false
  const tableauConnected = tableauStatus?.sessionValid ?? false

  const allStatusesLoaded = rhStatus !== null && sfStatus !== null && ccspStatus !== null && tableauStatus !== null
  const anyErrors = (rhStatus && !rhConnected) || (sfStatus && !sfConnected) || (ccspStatus && !!ccspStatus.lastError) || (tableauStatus && !tableauConnected)

  useEffect(() => {
    if (!onHealthChange) return
    if (!allStatusesLoaded) { onHealthChange('loading'); return }
    onHealthChange(anyErrors ? 'issues' : 'healthy')
  }, [allStatusesLoaded, anyErrors, onHealthChange])

  return (
    <div className="space-y-6">
      {/* ── CONNECTIONS ── */}
      <div>
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">Connections</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 min-[1440px]:grid-cols-4 gap-3">

          {/* Red Hat Portal */}
          <div className={`flex flex-col bg-surface/50 border border-border rounded-xl p-4 border-l-[3px] min-h-[160px] ${rhConnected ? 'border-l-success' : rhSessionActive ? 'border-l-warning' : 'border-l-border'}`}>
            <div className="flex items-center justify-between mb-1">
              <div>
                <p className="text-sm font-medium text-white">Red Hat Portal</p>
                <p className="text-xs text-text-secondary">Support cases</p>
              </div>
              <div className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${rhConnected ? 'bg-success' : rhSessionActive ? 'bg-warning' : 'bg-surface-active'}`} />
                <span className={`text-xs ${rhConnected ? 'text-success' : rhSessionActive ? 'text-warning' : 'text-text-secondary'}`}>
                  {rhConnected ? 'Connected' : rhSessionActive ? 'Session Active' : 'Not connected'}
                </span>
              </div>
            </div>
            <div className="mt-auto pt-3">
              <button
                onClick={() => document.getElementById('rh-portal')?.scrollIntoView({ behavior: 'smooth' })}
                className="bg-surface-hover hover:bg-surface-active text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                {rhConnected ? 'Reconnect' : 'Connect'}
              </button>
            </div>
          </div>

          {/* Supportable 360 */}
          <div className={`flex flex-col bg-surface/50 border border-border rounded-xl p-4 border-l-[3px] min-h-[160px] ${supportableConnected ? 'border-l-success' : supportableConnecting ? 'border-l-warning' : 'border-l-border'}`}>
            <div className="flex items-center justify-between mb-1">
              <div>
                <p className="text-sm font-medium text-white">Supportable 360</p>
                <p className="text-xs text-text-secondary">Supportable Subscriptions</p>
              </div>
              <div className="flex items-center gap-1.5">
                {supportableConnecting ? (
                  <>
                    <Loader2 className="w-2.5 h-2.5 animate-spin text-warning" />
                    <span className="text-xs text-warning">Connecting</span>
                  </>
                ) : supportableReachable === null ? (
                  <>
                    <Loader2 className="w-2.5 h-2.5 animate-spin text-text-secondary" />
                    <span className="text-xs text-text-secondary">Checking...</span>
                  </>
                ) : (
                  <>
                    <span className={`w-2 h-2 rounded-full ${supportableConnected ? 'bg-success' : 'bg-surface-active'}`} />
                    <span className={`text-xs ${supportableConnected ? 'text-success' : 'text-text-secondary'}`}>
                      {supportableConnected ? 'Connected' : 'Not connected'}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="mt-auto pt-3">
              {/* Q7: hint corrected — VPN alone is not enough; RH Portal session required */}
              {!rhConnected && (
                <div className="mb-2 text-xs text-text-secondary flex items-center gap-1">
                  <Shield className="w-3 h-3" />
                  <span>Requires active RH Portal session</span>
                </div>
              )}
              <button
                onClick={handleSupportableConnect}
                disabled={!rhConnected || supportableConnecting}
                className="bg-surface-hover hover:bg-surface-active disabled:opacity-40 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
              >
                {supportableConnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />}
                {supportableConnecting ? 'Checking...' : supportableConnected ? 'Reconnect' : 'Connect'}
              </button>
              {supportableVpnError && <p className="text-xs text-critical mt-2">VPN not detected — connect to Red Hat VPN and try again.</p>}
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
                <span className={`w-2 h-2 rounded-full ${sfConnected ? 'bg-success' : (sfExpired || sfSessionActive) ? 'bg-warning' : 'bg-surface-active'}`} />
                <span className={`text-xs ${sfConnected ? 'text-success' : (sfExpired || sfSessionActive) ? 'text-warning' : 'text-text-secondary'}`}>
                  {sfConnected ? 'Connected' : sfExpired ? 'Expired' : sfSessionActive ? 'Session Active' : 'Not connected'}
                </span>
              </div>
            </div>
            <div className="mt-auto pt-3">
              <button
                onClick={handleSfConnect}
                disabled={sfConnecting}
                className="bg-surface-hover hover:bg-surface-active disabled:opacity-40 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
              >
                {sfConnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />}
                {sfConnecting ? 'Connecting...' : sfConnected ? 'Reconnect' : 'Connect'}
              </button>
              {sfStatus?.syncError && <p className="text-xs text-critical mt-2">{sfStatus.syncError}</p>}
              {!sfStatus?.reportConfigured && (
                <p className="text-xs text-text-secondary mt-2">SF Report ID required — configure in AEs & Customers above.</p>
              )}
            </div>
          </div>

          {/* Tableau */}
          <div className={`flex flex-col bg-surface/50 border border-border rounded-xl p-4 border-l-[3px] min-h-[160px] ${tableauConnected ? 'border-l-success' : tableauConnecting ? 'border-l-warning' : 'border-l-border'}`}>
            <div className="flex items-center justify-between mb-1">
              <div>
                <p className="text-sm font-medium text-white">Tableau</p>
                <p className="text-xs text-text-secondary">CCSP cloud spend</p>
              </div>
              <div className="flex items-center gap-1.5">
                {tableauConnecting ? (
                  <>
                    <Loader2 className="w-2.5 h-2.5 animate-spin text-warning" />
                    <span className="text-xs text-warning">Connecting</span>
                  </>
                ) : tableauStatus === null ? (
                  <>
                    <Loader2 className="w-2.5 h-2.5 animate-spin text-text-secondary" />
                    <span className="text-xs text-text-secondary">Checking...</span>
                  </>
                ) : (
                  <>
                    <span className={`w-2 h-2 rounded-full ${tableauConnected ? 'bg-success' : 'bg-surface-active'}`} />
                    <span className={`text-xs ${tableauConnected ? 'text-success' : 'text-text-secondary'}`}>
                      {tableauConnected ? 'Connected' : 'Not connected'}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="mt-auto pt-3">
              {/* Q10: hint when RH Portal is disconnected */}
              {!rhConnected && !tableauConnecting && (
                <div className="mb-2 text-xs text-text-secondary flex items-center gap-1">
                  <Shield className="w-3 h-3" />
                  <span>Connect Red Hat Portal first</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleTableauConnect}
                  disabled={!rhConnected || tableauConnecting}
                  title={!rhConnected ? 'Connect Red Hat Portal first' : undefined}
                  className="bg-surface-hover hover:bg-surface-active disabled:opacity-40 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
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
              {tableauConnecting && <p className="text-xs text-text-secondary mt-2">Log in to Tableau in the VNC window — the page may briefly show the RH Portal as part of SSO, then redirect to Tableau. Window closes automatically when done.</p>}
            </div>
          </div>

        </div>
      </div>

      {/* ── SYNC ── */}
      <div>
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">Sync</h3>
        <div className="divide-y divide-border/50">

          {/* Red Hat Cases */}
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-white">Red Hat Cases</p>
              {rhStatus?.lastScraped ? (
                <p className="text-xs text-text-secondary">Synced {timeAgo(rhStatus.lastScraped)} — {rhStatus.caseCount}</p>
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

          {/* Supportable Subscriptions */}
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-white">Supportable Subscriptions</p>
              {supportableStatus?.lastScrape ? (
                <p className="text-xs text-text-secondary">Synced {timeAgo(supportableStatus.lastScrape)}{supportableStatus.recordCount ? ` — ${supportableStatus.recordCount}` : ''}</p>
              ) : (
                <p className="text-xs text-text-secondary">Subscription data</p>
              )}
              {supportableStatus?.lastError && <p className="text-xs text-critical">{supportableStatus.lastError}</p>}
            </div>
            <div className="flex items-center">
              {!rhConnected && <span className="text-xs text-text-secondary mr-3">Requires active RH Portal session</span>}
              <SyncButton onClick={handleRunScrape} loading={scraping || scraperRunning.supportable} disabled={!rhConnected || supportableRunning || scraperRunning.supportable} label="Sync Now" />
            </div>
          </div>
          {scrapeError && <p role="alert" className="text-xs text-critical pb-2">{scrapeError}</p>}
          {supportableRunning && (
            <div className="flex items-center gap-2 pb-2 text-xs text-warning">
              <svg className="w-3 h-3 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              <span>{supportableSyncMsg ?? 'Sync in progress…'}</span>
            </div>
          )}

          {/* CCSP (Tableau) */}
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-white">CCSP (Tableau)</p>
              {ccspStatus?.lastScrape ? (
                <p className="text-xs text-text-secondary">Synced {timeAgo(ccspStatus.lastScrape)}{ccspStatus.recordCount ? ` — ${ccspStatus.recordCount}` : ''}</p>
              ) : (
                <p className="text-xs text-text-secondary">Cloud spend</p>
              )}
              {ccspStatus?.lastError && <p className="text-xs text-critical">{ccspStatus.lastError}</p>}
            </div>
            <div className="flex items-center">
              {!rhConnected && <span className="text-xs text-text-secondary mr-3">Requires active Tableau session</span>}
              <SyncButton onClick={handleRunCcspScrape} loading={ccspScraping || scraperRunning.ccsp} disabled={ccspRunning || scraperRunning.ccsp} label="Sync Now" />
            </div>
          </div>
          {ccspScrapeError && <p role="alert" className="text-xs text-critical pb-2">{ccspScrapeError}</p>}
          {ccspSyncedAt && !ccspScrapeError && <p className="text-xs text-success pb-2">Synced {timeAgo(ccspSyncedAt)}{ccspStatus?.recordCount ? ` — ${ccspStatus.recordCount}` : ''}</p>}

          {/* Pipeline (Salesforce) */}
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-white">Pipeline (Salesforce)</p>
              {sfStatus?.lastSync ? (
                <p className="text-xs text-text-secondary">Synced {timeAgo(sfStatus.lastSync)} — {sfStatus.rowCount}</p>
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

        </div>
      </div>
    </div>
  )
}

// ── Main Setup Page ────────────────────────────────────────────────────────────

type SectionId = 'oauth-keys' | 'google-auth' | 'aes' | 'rh-portal' | 'data-sources' | 'settings'

export default function SetupPage() {
  const [openSection, setOpenSection] = useState<SectionId | null>(null)
  const [oauthKeysOk, setOauthKeysOk] = useState(false)
  const [googleAuthOk, setGoogleAuthOk] = useState<boolean | null>(null) // null = still checking
  const [aeCount, setAeCount] = useState<number | null>(null)
  const [rhOk, setRhOk] = useState<boolean | null>(null)
  const [resetting, setResetting] = useState(false)
  const [dataSourcesHealth, setDataSourcesHealth] = useState<'loading' | 'healthy' | 'issues'>('loading')
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
      .then(d => { setRhOk((d.hasSession && !d.sessionExpired) ?? false) })
      .catch((e) => { if (e.name !== 'AbortError') setRhOk(false) })

    // Eagerly resolve Data Sources badge without waiting for accordion to open
    Promise.all([
      fetch('/api/auth/redhat/status',              { signal }).then(r => r.json()).catch(() => ({ hasSession: false })),
      fetch('/api/auth/salesforce/status',           { signal }).then(r => r.json()).catch(() => ({ hasSession: false })),
      fetch('/api/scrape/ccsp/status',              { signal }).then(r => r.json()).catch(() => ({ lastError: 'Unreachable' })),
      fetch('/api/bootstrap/tableau/session-status', { signal }).then(r => r.json()).catch(() => ({ reachable: false, sessionValid: false })),
    ]).then(([rh, sf, ccsp, tableau]) => {
      const anyErrors = !(rh.hasSession) || !!(rh.sessionExpired) || !(sf.hasSession) || !!(ccsp.lastError) || !(tableau.sessionValid)
      setDataSourcesHealth(anyErrors ? 'issues' : 'healthy')
    }).catch(() => { /* aborted — ignore */ })

    // OAuth return: open AEs section and clean URL so the child AutoBootstrapForm can restore state
    const params = new URLSearchParams(window.location.search)
    if (params.get('step') === '2') {
      setOpenSection('aes')
      window.history.replaceState({}, '', '/dashboard/setup')
    }
    return () => controller.abort()
  }, [])

  // First-run auto-expand logic
  useEffect(() => {
    if (openSection !== null) return // user already toggled something
    if (!oauthKeysOk && aeCount !== null) {
      setOpenSection('oauth-keys')
    } else if (oauthKeysOk && googleAuthOk === false && aeCount !== null) {
      setOpenSection('google-auth')
    } else if (oauthKeysOk && googleAuthOk === true && aeCount === 0) {
      setOpenSection('aes')
    }
  }, [oauthKeysOk, googleAuthOk, aeCount, openSection])

  const toggleSection = (id: SectionId) => {
    setOpenSection(prev => prev === id ? null : id)
  }

  const doReset = async (full: boolean) => {
    setResetting(true)
    setResetConfirm(null)
    try {
      await fetch(`/api/setup/reset?confirm=true${full ? '&full=true' : ''}`, { method: 'POST' })
    } catch {}
    setResetting(false)
    window.location.href = '/dashboard/setup'
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
                    className="text-xs text-text-secondary/50 hover:text-text-secondary transition-colors"
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
            title="Step 3 of 5 — Red Hat Portal"
            badge={
              rhOk === null
                ? <StatusBadge ok={null} label="Checking..." />
                : rhOk
                  ? <StatusBadge ok={true} label="Connected" />
                  : <StatusBadge ok={false} label="Required" />
            }
            isOpen={openSection === 'rh-portal'}
            onToggle={() => toggleSection('rh-portal')}
          >
            <RedHatPortalSection onConnected={() => setRhOk(true)} />
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
                  ? <span className="text-xs text-warning">Issues detected</span>
                  : <span className="text-xs text-success">All connected</span>
            }
            isOpen={openSection === 'data-sources'}
            onToggle={() => toggleSection('data-sources')}
          >
            <DataSourcesSection onHealthChange={setDataSourcesHealth} />
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
