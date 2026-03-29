import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { RefreshTimerSettings } from '../components/RefreshTimerSettings'
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
  Trash2,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

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
  customers: WizardCustomer[]
}

interface WizardCustomer {
  id: string
  name: string
  supportableName: string
  domain: string
  accountNumbers: string
}

// ── Small helpers ──────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }}
      className="flex items-center gap-1.5 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 px-2 py-1 rounded transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function StatusBadge({ ok, label }: { ok: boolean | null; label: string }) {
  if (ok === null) return <span className="text-slate-400 text-sm">{label}: checking...</span>
  return (
    <span className={`flex items-center gap-1.5 text-sm ${ok ? 'text-emerald-400' : 'text-red-400'}`}>
      {ok ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
      {label}
    </span>
  )
}

function CodeBlock({ code, copyable = true }: { code: string; copyable?: boolean }) {
  return (
    <div className="relative">
      <pre className="bg-slate-900 rounded-lg p-3 font-mono text-sm text-slate-300 border border-slate-700 overflow-x-auto whitespace-pre-wrap">
        {code}
      </pre>
      {copyable && (
        <div className="absolute top-2 right-2">
          <CopyButton text={code} />
        </div>
      )}
    </div>
  )
}

function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
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
    <section id={id} className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-slate-750 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          {isOpen
            ? <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
            : <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />}
          <span className="text-base font-semibold text-white">{title}</span>
        </div>
        {badge && <div className="shrink-0 ml-3">{badge}</div>}
      </button>
      {isOpen && (
        <div className="px-6 pb-6 pt-0 border-t border-slate-700/50">
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
        <p className="text-sm text-slate-400">
          This app needs a GCP OAuth keys file to authenticate with Google. Your admin has shared this file internally.
        </p>
      </div>

      {exists === true ? (
        <div className="flex items-center gap-2 text-emerald-400 text-sm">
          <CheckCircle className="w-4 h-4" />
          OAuth keys already configured — you're good to go.
        </div>
      ) : (
        <div className="space-y-4">
          {GDRIVE_KEYS_URL && (
            <a
              href={GDRIVE_KEYS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors w-fit"
            >
              <ExternalLink className="w-4 h-4" />
              Open OAuth Keys in Google Drive
            </a>
          )}

          {/* Mode toggle */}
          <div className="flex gap-1 bg-slate-900 rounded-lg p-1 w-fit">
            {(['paste', 'upload'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  mode === m ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-white'
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
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 font-mono text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-indigo-500 resize-none"
              />
              <button
                onClick={() => submit(pasteText)}
                disabled={!pasteText.trim() || uploading}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                {uploading ? 'Saving...' : 'Save Keys'}
              </button>
            </div>
          ) : (
            <label className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer w-fit">
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {uploading ? 'Uploading...' : 'Upload gcp-oauth.keys.json'}
              <input type="file" accept=".json,application/json" className="hidden" onChange={handleFile} disabled={uploading} />
            </label>
          )}

          {error && (
            <p className="text-sm text-red-400 flex items-center gap-1.5">
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
      <div className="flex items-center gap-2 text-slate-400 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        Checking Google connection...
      </div>
    )
  }

  if (oauthStatus?.expired) {
    return (
      <div className="space-y-4">
        <div className="bg-amber-950/50 border border-amber-700 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <XCircle className="w-5 h-5 text-amber-400" />
            <span className="font-semibold text-white">Session Expired</span>
          </div>
          <p className="text-sm text-slate-400">Your Google token is no longer valid. Click below to re-authenticate.</p>
          <button
            onClick={() => window.location.href = '/oauth/start'}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
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
        <div className="bg-emerald-950/50 border border-emerald-700 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-emerald-400" />
            <span className="font-semibold text-white">Google Workspace Connected</span>
            {oauthStatus.email && (
              <span className="text-sm text-slate-400 ml-1">· {oauthStatus.email}</span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            {['Gmail (read)', 'Google Drive (read)', 'Google Calendar (read)', 'Google Sheets (read)'].map(s => (
              <div key={s} className="flex items-center gap-1.5 text-emerald-400">
                <Check className="w-3.5 h-3.5" />
                <span>{s}</span>
              </div>
            ))}
          </div>
          {oauthStatus.configuredAt && (
            <p className="text-xs text-slate-500">Connected {timeAgo(oauthStatus.configuredAt)}</p>
          )}
          <button
            onClick={() => window.location.href = '/oauth/start'}
            className="text-sm text-slate-400 hover:text-white underline transition-colors"
          >
            Re-authorize
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <p className="text-slate-400 text-sm">Authorize read access to Calendar, Gmail, Drive, and Sheets. One click — no scripts needed.</p>

      <div className="bg-slate-900 rounded-xl p-6 border border-slate-700 space-y-4">
        <a
          href="/oauth/start"
          className="flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-lg font-medium transition-colors w-full text-center"
        >
          <ExternalLink className="w-4 h-4" />
          Connect Google Workspace
        </a>
        <div className="grid grid-cols-2 gap-1.5 text-xs text-slate-500">
          {['Gmail (read-only)', 'Google Drive (read-only)', 'Calendar (read-only)', 'Sheets (read-only)'].map(s => (
            <div key={s} className="flex items-center gap-1">
              <div className="w-1 h-1 rounded-full bg-slate-600" />
              {s}
            </div>
          ))}
        </div>
      </div>


      {/* Not a test user fallback */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 space-y-2">
        <p className="text-sm font-medium text-slate-300">Not a test user yet?</p>
        <p className="text-sm text-slate-400">
          If the connection fails with "Access Denied", your Google account needs to be added to the app first.
        </p>
        <a
          href="mailto:jhorn@redhat.com?subject=Dashboard%20Access%20Request&body=Hi%20Jason%2C%0A%0APlease%20add%20me%20as%20a%20test%20user%20for%20the%20PAI%20Dashboard%20OAuth%20app.%0A%0AMy%20Red%20Hat%20Google%20email%3A%20%5Benter%20your%20email%20here%5D%0A%0AThanks!"
          className="inline-flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          Request Access from Jason
        </a>
      </div>
    </div>
  )
}

// ── AEs & Customers ────────────────────────────────────────────────────────────

function makeBlankCustomer(): WizardCustomer {
  return { id: crypto.randomUUID(), name: '', supportableName: '', domain: '', accountNumbers: '' }
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
}

function AutoBootstrapProgress({ state, onReset, tableauSessionNeeded }: { state: AutoBootstrapState; onReset?: () => void; tableauSessionNeeded?: boolean | null }) {
  const hasError = state.steps.some(s => s.status === 'error')

  const statusIcon = (s: AutoBootstrapStep['status']) => {
    switch (s) {
      case 'pending': return <span className="relative z-10 inline-flex w-6 h-6 rounded-full border-2 border-slate-600 bg-slate-900 items-center justify-center" />
      case 'running': return <span className="relative z-10 inline-flex w-6 h-6 rounded-full border-2 border-indigo-500 bg-slate-900 items-center justify-center"><Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" /></span>
      case 'done':    return <span className="relative z-10 inline-flex w-6 h-6 rounded-full border-2 border-emerald-500 bg-slate-900 items-center justify-center"><CheckCircle className="w-3.5 h-3.5 text-emerald-400" /></span>
      case 'error':   return <span className="relative z-10 inline-flex w-6 h-6 rounded-full border-2 border-red-500 bg-slate-900 items-center justify-center"><XCircle className="w-3.5 h-3.5 text-red-400" /></span>
    }
  }

  return (
    <div className="mt-4 space-y-4" aria-live="polite">
      <p className="text-sm font-semibold text-slate-300">
        {state.completedAt ? `Setup ${hasError ? 'finished with errors' : 'complete'} — ${state.aeName}` : `Setting up ${state.aeName}…`}
      </p>

      {/* Step list with connector lines */}
      <div className="relative">
        {state.steps.map((step, i) => (
          <div key={i} className="relative flex gap-3">
            {/* Vertical connector line */}
            {i < state.steps.length - 1 && (
              <div className="absolute left-3 top-6 bottom-0 w-px bg-slate-700" />
            )}
            {/* Icon */}
            <div className="flex-shrink-0 mt-0.5">{statusIcon(step.status)}</div>
            {/* Content row — highlight running step */}
            <div className={`flex-1 mb-2 rounded px-2 py-1 text-sm ${step.status === 'running' ? 'bg-slate-800/60' : ''}`}>
              <span className={
                step.status === 'error'   ? 'text-red-400' :
                step.status === 'done'    ? 'text-emerald-300' :
                step.status === 'running' ? 'text-white font-medium' :
                'text-slate-500'
              }>
                {step.name}
              </span>
              {step.detail && (
                <p className="text-xs text-slate-500 mt-0.5 truncate max-w-lg">{step.detail}</p>
              )}
              {/* Tableau login prompt — only shown when reachable but session invalid */}
              {step.name === 'Create CCSP Sheet' && step.status === 'done' && tableauSessionNeeded === true && (
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="text-xs text-amber-400">Tableau session required to populate CCSP data</span>
                  <button
                    onClick={async () => {
                      await fetch('/api/bootstrap/tableau/open-login', { method: 'POST' })
                      window.open('http://localhost:6080/vnc.html?autoconnect=1&resize=scale', 'tableau-login', 'width=1280,height=900')
                    }}
                    className="text-xs bg-amber-600 hover:bg-amber-500 text-white px-2 py-0.5 rounded"
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
        <div className={`rounded-lg border p-3 text-sm ${hasError ? 'border-amber-700 bg-amber-950/30' : 'border-emerald-700 bg-emerald-950/30'}`}>
          <p className={`font-medium mb-2 ${hasError ? 'text-amber-400' : 'text-emerald-400'}`}>
            {hasError ? 'Completed with errors — some steps may need retry' : 'All done! Resources are ready.'}
          </p>
          {/* Resource links from step details */}
          <div className="grid grid-cols-2 gap-1.5">
            {state.steps.filter(s => s.status === 'done' && s.detail).map((s, i) => (
              <span key={i} className="text-xs text-slate-400 truncate">{s.name}: <span className="text-slate-300">{s.detail}</span></span>
            ))}
          </div>
          {/* Surface customers with 0 accounts discovered */}
          {(() => {
            const discoverStep = state.steps.find(s => s.name === 'Discover Account Numbers' || s.name?.includes('Discover'))
            const zeroMatches = discoverStep?.detail?.match(/(\d+)\/(\d+)/)
            const matched = zeroMatches ? parseInt(zeroMatches[1]) : null
            const total = zeroMatches ? parseInt(zeroMatches[2]) : null
            if (matched !== null && total !== null && matched < total) {
              return (
                <div className="mt-2 bg-amber-950/40 border border-amber-700/50 rounded-lg px-3 py-2">
                  <p className="text-xs text-amber-300 font-medium">{total - matched} customer{total - matched !== 1 ? 's' : ''} had no Supportable matches</p>
                  <p className="text-xs text-slate-400 mt-0.5">Check that the customer name in the list exactly matches the name in Supportable. Edit the customer list and re-run to correct.</p>
                </div>
              )
            }
            return null
          })()}
          <div className="mt-3 flex items-center gap-3">
            <a
              href="#aes"
              onClick={() => document.getElementById('aes')?.scrollIntoView({ behavior: 'smooth' })}
              className="text-xs text-indigo-400 hover:text-indigo-300 underline"
            >
              Edit AE / customers
            </a>
            {onReset && (
              <button onClick={onReset} className="text-xs text-slate-400 hover:text-slate-300 underline">
                Add another AE
              </button>
            )}
            {hasError && (
              <button
                onClick={() => fetch('/api/bootstrap/auto/reset', { method: 'POST' })}
                className="text-xs text-slate-400 hover:text-slate-300 underline"
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
      .then(r => r.json())
      .then((d: { territories?: { num: string; aeName: string }[] }) => {
        setPodTerritoryNames(d.territories ?? [])
        if (!d.territories?.length) setPodNamesError('Could not load territory names from sheet — showing generic list')
      })
      .catch((e) => { if (e.name !== 'AbortError') { setPodTerritoryNames([]); setPodNamesError('Could not load territory names from sheet — showing generic list') } })
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
      .then(r => r.json())
      .then((d: { aeName?: string; accounts?: string[]; error?: string }) => {
        if (d.error) {
          setTerritoryError(d.error.includes('not found') ? null : d.error)
          return
        }
        if (d.aeName) setAeName(d.aeName)
        if (d.accounts?.length) setCustomerText(d.accounts.join('\n'))
      })
      .catch((e) => { if (e.name !== 'AbortError') setTerritoryError(e.message) })
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
    setBootstrapState(null); setAeName(''); setSfReportId(''); setCustomerText(''); setPod(''); setTerrNum('')
    setTableauSessionNeeded(null)
    bootstrapStartingRef.current = false
  }
  const customerNames = customerText.split('\n').map(s => s.trim()).filter(Boolean)
  const territories = territoryInput.split(',').map(s => s.trim()).filter(Boolean)
  const canStart = aeName.trim() && sfReportId.trim() && territories.length > 0 && customerNames.length > 0

  if (autoStartPending) {
    return (
      <div className="flex items-center gap-3 py-6 text-slate-400 text-sm">
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
      <div className="bg-indigo-950/50 border border-indigo-700/40 rounded-xl px-4 py-3 space-y-1.5">
        <p className="text-sm font-medium text-indigo-200">Automated AE setup — one click to fully configured</p>
        <p className="text-xs text-indigo-300/80 leading-relaxed">
          Creates a Drive folder, discovers RH Portal account numbers, and generates all data sheets automatically.
          Setup requires temporary full Drive access — you'll be prompted to downgrade to read-only once complete.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <div>
          <label className="block text-xs text-slate-400 mb-1">AE Name *</label>
          <input
            type="text"
            value={aeName}
            onChange={e => setAeName(e.target.value)}
            onBlur={handleAeNameBlur}
            placeholder="Jane Smith"
            className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">SF Report ID *</label>
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
            className={`w-full bg-slate-800 border rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 ${sfReportIdError ? 'border-red-500' : 'border-slate-600'}`}
          />
          {sfReportIdError && <p className="text-xs text-red-400 mt-1">{sfReportIdError}</p>}
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-0.5">Account Territories *</label>
          <p className="text-xs text-slate-500 mb-2">Selects your territory for CCSP scoping and auto-fills AE name + customer list from the territory sheet. Select your POD then the territory number.</p>
          <div className="space-y-2">
            <div className="flex gap-2">
              <div className="flex-1">
                <p className="text-xs text-slate-500 mb-1">POD / Region</p>
                <select
                  value={pod}
                  onChange={e => { setPod(e.target.value); setTerrNum('') }}
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                >
                  <option value="">Select POD…</option>
                  <option value="WEST_COMM_CORP_NORTHWEST">Northwest Corp</option>
                  <option value="WEST_COMM_CORP_SOUTHWEST">Southwest Corp</option>
                  <option value="WEST_COMM_CORP_NORTHCENTRAL">North Central Corp</option>
                  <option value="WEST_COMM_CORP_SOUTHCENTRAL">South Central Corp</option>
                </select>
              </div>
              <div className="w-48">
                <p className="text-xs text-slate-500 mb-1">Territory</p>
                <select
                  value={terrNum}
                  onChange={e => setTerrNum(e.target.value)}
                  disabled={!pod}
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-40"
                >
                  <option value="">Select…</option>
                  {podTerritoryOptions.map(opt => (
                    <option key={opt.num} value={opt.num}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>
            {territoryInput && (
              <p className="text-xs text-slate-500 font-mono">{territoryInput}</p>
            )}
            {matchedAe ? (
              <p className="text-xs text-emerald-400">→ {matchedAe.name}{matchedAe.accounts?.length ? ` · ${matchedAe.accounts.length} accounts pre-loaded` : ''}</p>
            ) : territoryLoading ? (
              <p className="text-xs text-slate-400 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading territory data from sheet…</p>
            ) : territoryInput && !aeName ? (
              <p className="text-xs text-amber-400">No AE data for this territory — enter AE name and accounts manually below</p>
            ) : territoryInput && aeName ? (
              <p className="text-xs text-emerald-400">→ {aeName} · loaded from territory sheet</p>
            ) : null}
            {podNamesError && (
              <p className="text-xs text-amber-400">{podNamesError}</p>
            )}
            {territoryError && (
              <p className="text-xs text-red-400">{territoryError}</p>
            )}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-slate-400">Customer Names * (one per line)</label>
            <a
              href="https://docs.google.com/spreadsheets/d/1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8/edit?gid=294606982#gid=294606982"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300"
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
            className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-y"
          />
          {customerNames.length > 0 && (
            <p className="text-xs text-slate-500 mt-1">{customerNames.length} customer(s) — names must match Supportable exactly. Edit before starting if needed.</p>
          )}
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">Parent Drive Folder (optional)</label>
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
            className={`w-full bg-slate-800 border rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 ${folderError ? 'border-red-500' : folderName ? 'border-emerald-500' : 'border-slate-600'}`}
          />
          {folderName && <p className="text-xs text-emerald-400 mt-1">✓ {folderName}</p>}
          {folderError && <p className="text-xs text-red-400 mt-1">✗ {folderError}</p>}
        </div>
      </div>

      {/* Hierarchy preview — shows exactly what bootstrap creates (D2: no per-customer subfolders) */}
      {aeName.trim() && (
        <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs font-mono space-y-0.5">
          <p className="text-slate-400 mb-1 font-sans text-xs font-medium">What will be created:</p>
          <p className="text-slate-300">
            📁 {folderName ? <span className="text-emerald-300">{folderName}</span> : parentFolderId.trim() ? <span className="text-indigo-300">parent folder</span> : 'My Drive'}/
          </p>
          <p className="text-slate-300 pl-4">└── 📁 {aeName.trim()}/</p>
          <p className="text-slate-500 pl-8">├── 📊 Supportable Sheet</p>
          <p className="text-slate-500 pl-8">├── 📊 CCSP Sheet</p>
          <p className="text-slate-500 pl-8">└── 📊 Pipeline Sheet</p>
        </div>
      )}

      {preflightError && (
        <p className="text-xs text-red-400 bg-red-950/30 border border-red-800/50 rounded px-3 py-2">{preflightError}</p>
      )}

      <div className="flex justify-end pt-1">
        <button
          onClick={startBootstrap}
          disabled={!canStart || starting}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          {starting ? 'Starting...' : 'Set Up AE'}
        </button>
      </div>
    </div>
  )
}

function AEsCustomersSection() {
  const [mode, setMode] = useState<'auto' | 'manual'>('auto')
  const [aes, setAes] = useState<WizardAE[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [validatingFolder, setValidatingFolder] = useState<string | null>(null)
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null)
  const [folderValidateError, setFolderValidateError] = useState<string | null>(null)
  const [scrapeError, setScrapeError] = useState<string | null>(null)

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
        }> = aeData.aes ?? []
        const serverCustomers: Array<{
          name: string
          supportableName?: string
          domain?: string
          accountNumbers?: string[]
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
            customers: serverCustomers
              .filter(c => c.ae === ae.name)
              .map(c => ({
                id: crypto.randomUUID(),
                name: c.name,
                supportableName: c.supportableName ?? '',
                domain: c.domain ?? '',
                accountNumbers: (c.accountNumbers ?? []).join(', '),
              })),
          })).map(ae => ({
            ...ae,
            customers: ae.customers.length > 0 ? ae.customers : [makeBlankCustomer()],
          })))
        }
      })
      .catch((e) => { if (e.name !== 'AbortError') setAes([makeBlankAE()]) })
      .finally(() => setLoading(false))
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
    setSaving(true)
    setSaveMsg(null)
    try {
      // Fetch current server AEs so we can preserve server-managed fields
      // (tableauTerritories, accounts, etc.) that the Edit/View form doesn't expose
      const serverState = await fetch('/api/aes').then(r => r.json()).catch(() => ({ aes: [] }))
      const serverAeMap = new Map<string, Record<string, unknown>>(
        (serverState.aes ?? []).map((a: Record<string, unknown>) => [a.name as string, a])
      )

      // Build AE objects for the server — merge wizard fields over server state
      const serverAes = aes
        .filter(a => a.name.trim())
        .map(a => ({
          ...(serverAeMap.get(a.name.trim()) ?? {}),  // preserve server-only fields
          name: a.name.trim(),
          driveFolderId: a.folderId,
          ...(a.sfReportId.trim() ? { sfReportId: a.sfReportId.trim() } : {}),
          ...(a.tableauUrl.trim() ? { tableauUrl: a.tableauUrl.trim() } : {}),
          ...(a.supportableSheetId ? { supportableSheetId: a.supportableSheetId } : {}),
          ...(a.pipelineSheetId ? { pipelineSheetId: a.pipelineSheetId } : {}),
          ...(a.ccspSheetId ? { ccspSheetId: a.ccspSheetId } : {}),
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
            ae: a.name.trim(),
          }))
      )

      await fetch('/api/setup/save-customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customers: allCustomers }),
      })

      setSaveMsg(`Saved ${serverAes.length} AE(s) and ${allCustomers.length} customer(s)`)
    } catch (e: any) {
      setSaveMsg(`Error: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading AE configuration...
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Mode toggle */}
      <div className="flex items-center gap-1 bg-slate-800 rounded-lg p-1 w-fit">
        <button
          onClick={() => setMode('auto')}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            mode === 'auto'
              ? 'bg-indigo-600 text-white'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          Auto Setup
        </button>
        <button
          onClick={() => setMode('manual')}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            mode === 'manual'
              ? 'bg-indigo-600 text-white'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          Edit / View
        </button>
      </div>

      {mode === 'auto' ? (
        <AutoBootstrapForm />
      ) : (
      <>
      <p className="text-sm text-slate-400">
        Configure your Account Executives and their customers. Each AE can have a Drive folder, Salesforce report, and Tableau dashboard.
      </p>

      {aes.map((ae, aeIdx) => (
        <div key={ae.id} className="bg-slate-900 rounded-xl p-5 border border-slate-700 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-300">AE #{aeIdx + 1}</span>
            {removeConfirmId === ae.id ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-400">Remove this AE and all customers?</span>
                <button onClick={() => confirmRemoveAE(ae.id)} className="text-xs bg-red-700 hover:bg-red-600 text-white px-2 py-0.5 rounded">Remove</button>
                <button onClick={() => setRemoveConfirmId(null)} className="text-xs text-slate-400 hover:text-white">Cancel</button>
              </div>
            ) : (
              <button
                onClick={() => removeAE(ae.id)}
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-red-400 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Remove AE
              </button>
            )}
          </div>

          {/* AE fields */}
          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">AE Name</label>
              <input
                type="text"
                value={ae.name}
                onChange={e => updateAE(ae.id, { name: e.target.value })}
                placeholder="Jane Smith"
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Drive Folder URL</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={ae.folderUrl}
                  onChange={e => updateAE(ae.id, { folderUrl: e.target.value })}
                  placeholder="https://drive.google.com/drive/folders/..."
                  className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
                <button
                  onClick={() => validateFolder(ae.id)}
                  disabled={!ae.folderUrl.trim() || validatingFolder === ae.id}
                  className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors shrink-0"
                >
                  {validatingFolder === ae.id
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <CheckCircle className="w-4 h-4" />}
                  Validate
                </button>
              </div>
              {ae.folderName && ae.folderId && (
                <p className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
                  <CheckCircle className="w-3 h-3" />
                  {ae.folderName}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">SF Report ID (optional)</label>
                <input
                  type="text"
                  value={ae.sfReportId}
                  onChange={e => updateAE(ae.id, { sfReportId: e.target.value })}
                  placeholder="Salesforce report ID"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Tableau URL (optional)</label>
                <input
                  type="text"
                  value={ae.tableauUrl}
                  onChange={e => updateAE(ae.id, { tableauUrl: e.target.value })}
                  placeholder="Paste your Tableau dashboard URL"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>
          </div>

          {/* Customer table */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Customers</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-500 uppercase tracking-wide border-b border-slate-700">
                    <th className="text-left py-2 pr-2 font-medium">Customer Name</th>
                    <th className="text-left py-2 pr-2 font-medium">Supportable Name</th>
                    <th className="text-left py-2 pr-2 font-medium">Domain</th>
                    <th className="text-left py-2 pr-2 font-medium">Account Numbers</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {ae.customers.map(c => (
                    <tr key={c.id} className="border-b border-slate-800/50">
                      <td className="py-1.5 pr-2">
                        <input
                          type="text"
                          value={c.name}
                          onChange={e => updateCustomer(ae.id, c.id, { name: e.target.value })}
                          placeholder="Acme Corp"
                          className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          type="text"
                          value={c.supportableName}
                          onChange={e => updateCustomer(ae.id, c.id, { supportableName: e.target.value })}
                          placeholder="If different in Supportable"
                          className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          type="text"
                          value={c.domain}
                          onChange={e => updateCustomer(ae.id, c.id, { domain: e.target.value })}
                          placeholder="acme.com"
                          className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          type="text"
                          value={c.accountNumbers}
                          onChange={e => updateCustomer(ae.id, c.id, { accountNumbers: e.target.value })}
                          placeholder="1234567, 2345678"
                          className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                        />
                      </td>
                      <td className="py-1.5">
                        <button
                          onClick={() => removeCustomer(ae.id, c.id)}
                          className="text-slate-600 hover:text-red-400 transition-colors p-1"
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
              className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors mt-1"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Customer
            </button>
          </div>
        </div>
      ))}

      {folderValidateError && (
        <p className="text-xs text-red-400 bg-red-950/30 border border-red-800/50 rounded px-3 py-2">{folderValidateError}</p>
      )}

      <div className="flex items-center justify-between pt-2">
        <button
          onClick={addAE}
          className="flex items-center gap-1.5 text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add AE
        </button>

        <div className="flex items-center gap-3">
          {saveMsg && (
            <span className={`text-sm ${saveMsg.startsWith('Error') ? 'text-red-400' : 'text-emerald-400'}`}>
              {saveMsg}
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors"
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

function RedHatPortalSection() {
  const [status, setStatus] = useState<RhStatus | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const popupRef = useRef<Window | null>(null)

  const fetchStatus = async (signal?: AbortSignal) => {
    try {
      const d: RhStatus = await fetch('/api/auth/redhat/status', { signal }).then((r) => r.json())
      setStatus(d)
      if (d.hasSession && !d.loginInProgress && connecting) {
        setConnecting(false)
        popupRef.current?.close()
        popupRef.current = null
        fetch('/api/auth/redhat/sync', { method: 'POST', signal }).catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })
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
    setConnecting(true)
    try {
      const res = await fetch('/api/auth/redhat/start', { method: 'POST' })
      const d = await res.json()
      if (d.error) {
        setError(d.error)
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

  if (status?.hasSession && !connecting) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <CheckCircle className="w-5 h-5 text-emerald-400" />
          <span className="font-semibold text-white">Red Hat Portal Connected</span>
        </div>
        <p className="text-slate-400 text-sm">
          Support cases will sync automatically every 4 hours.
          {status.lastScraped && (
            <> Last synced {timeAgo(status.lastScraped)} — {status.caseCount} cases.</>
          )}
        </p>
        <button
          onClick={handleConnect}
          className="text-sm text-slate-400 hover:text-white underline transition-colors"
        >
          Reconnect session
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-slate-400 text-sm">
        Connect your Red Hat Customer Portal session to surface open support cases in the
        dashboard. A browser window will open — log in, then return here.
      </p>

      {connecting ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 bg-indigo-900/30 border border-indigo-700/50 rounded-lg p-4">
            <Loader2 className="w-5 h-5 text-indigo-400 animate-spin shrink-0" />
            <div>
              <p className="text-white text-sm font-medium">Browser window opened</p>
              <p className="text-slate-400 text-xs mt-0.5">
                Log in to access.redhat.com, then return here. Session saves automatically.
              </p>
            </div>
          </div>
          {status?.loginTimedOut && (
            <p className="text-amber-400 text-sm">Login timed out — try again.</p>
          )}
          <button
            onClick={handleCancel}
            className="text-sm text-slate-500 hover:text-slate-300 underline transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <button
            onClick={handleConnect}
            className="flex items-center gap-2 bg-red-700 hover:bg-red-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            Connect Red Hat Portal
          </button>
          {error && (
            <p className="text-red-400 text-sm flex items-center gap-1.5">
              <XCircle className="w-4 h-4" /> {error}
            </p>
          )}
          <p className="text-slate-500 text-xs">
            Optional — you can skip this and connect later from the dashboard.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Data Sources ───────────────────────────────────────────────────────────────

function DataSourcesSection() {
  const [supportableStatus, setSupportableStatus] = useState<{
    running: boolean
    lastScrape: string | null
    lastError: string | null
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
    lastScraped: string | null
    caseCount: number
  } | null>(null)

  const [ccspStatus, setCcspStatus] = useState<{
    running: boolean
    lastScrape: string | null
    lastError: string | null
  } | null>(null)
  const [scraping, setScraping] = useState(false)
  const [scrapeError, setScrapeError] = useState<string | null>(null)
  const [ccspScraping, setCcspScraping] = useState(false)
  const [ccspScrapeError, setCcspScrapeError] = useState<string | null>(null)
  const [sfSyncing, setSfSyncing] = useState(false)
  const [sfSyncError, setSfSyncError] = useState<string | null>(null)
  const [rhSyncing, setRhSyncing] = useState(false)
  const [rhSyncError, setRhSyncError] = useState<string | null>(null)

  const refreshAll = (signal?: AbortSignal) => {
    fetch('/api/bootstrap/supportable/status', { signal }).then(r => r.json()).then(setSupportableStatus).catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })
    fetch('/api/bootstrap/ccsp/status', { signal }).then(r => r.json()).then(setCcspStatus).catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })
    fetch('/api/auth/salesforce/status', { signal }).then(r => r.json()).then(setSfStatus).catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })
    fetch('/api/auth/redhat/status', { signal }).then(r => r.json()).then(setRhStatus).catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })
  }

  useEffect(() => {
    const controller = new AbortController()
    refreshAll(controller.signal)
    return () => controller.abort()
  }, [])

  const handleRhSync = async () => {
    setRhSyncError(null)
    setRhSyncing(true)
    try {
      if (!rhStatus?.hasSession) {
        setRhSyncError('No active session — connect in the RH Portal section above first.')
        return
      }
      await fetch('/api/auth/redhat/sync', { method: 'POST' })
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
      if (!sfStatus?.hasSession) {
        setSfSyncError('No active session — connect Salesforce first.')
        return
      }
      const res = await fetch('/api/auth/salesforce/sync', { method: 'POST' })
      const d = await res.json()
      if (d.error) { setSfSyncError(d.error); return }
      setTimeout(() => fetch('/api/auth/salesforce/status').then(r => r.json()).then(setSfStatus).catch(() => {}), 3_000)
    } catch (e: any) {
      setSfSyncError(`Sync failed: ${e.message}`)
    } finally {
      setSfSyncing(false)
    }
  }

  const handleRunScrape = async () => {
    setScrapeError(null)
    setScraping(true)
    try {
      // Pre-check: Red Hat Portal session required (needs VPN + active browser session)
      const rhCheck = await fetch('/api/auth/redhat/status').then(r => r.json()).catch(() => ({ hasSession: false }))
      if (!rhCheck.hasSession) {
        setScrapeError('Red Hat Portal session required — connect in the RH Portal section above, then retry.')
        return
      }
      const aeData = await fetch('/api/aes').then(r => r.json())
      const aes = aeData.aes ?? []
      if (aes.length === 0) {
        setScrapeError('No AEs configured — add AEs first in the AEs & Customers section.')
        return
      }
      await fetch('/api/bootstrap/supportable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aes }),
      })
      const newStatus = await fetch('/api/bootstrap/supportable/status').then(r => r.json())
      setSupportableStatus(newStatus)
    } catch (e: any) {
      setScrapeError(`Scrape failed: ${e.message}`)
    } finally {
      setScraping(false)
    }
  }

  const handleRunCcspScrape = async () => {
    setCcspScrapeError(null)
    setCcspScraping(true)
    try {
      const rhCheck = await fetch('/api/auth/redhat/status').then(r => r.json()).catch(() => ({ hasSession: false }))
      if (!rhCheck.hasSession) {
        setCcspScrapeError('Red Hat Portal session required — connect in the RH Portal section above, then retry.')
        return
      }
      const res = await fetch('/api/bootstrap/ccsp', { method: 'POST' })
      const d = await res.json()
      if (d.error) { setCcspScrapeError(d.error); return }
      const newStatus = await fetch('/api/bootstrap/ccsp/status').then(r => r.json())
      setCcspStatus(newStatus)
    } catch (e: any) {
      setCcspScrapeError(`Scrape failed: ${e.message}`)
    } finally {
      setCcspScraping(false)
    }
  }

  const SyncButton = ({ onClick, loading, disabled, label }: { onClick: () => void; loading: boolean; disabled: boolean; label: string }) => (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
      {label}
    </button>
  )

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">Connection status for external data sources.</p>

      <div className="grid grid-cols-1 gap-3">
        {/* Red Hat Portal */}
        <div className="bg-slate-900 rounded-lg p-4 border border-slate-700 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-white">Red Hat Portal</span>
            {rhStatus?.hasSession
              ? <StatusBadge ok={true} label="Connected" />
              : <StatusBadge ok={false} label="Not connected" />}
          </div>
          {rhStatus?.lastScraped && (
            <p className="text-xs text-slate-500">Last sync: {timeAgo(rhStatus.lastScraped)} — {rhStatus.caseCount} cases</p>
          )}
          {!rhStatus?.hasSession && (
            <p className="text-xs text-slate-500">
              <a href="#rh-portal" className="text-indigo-400 hover:text-indigo-300">Connect above</a> to sync support cases and run Supportable scrapes.
            </p>
          )}
          {rhStatus?.hasSession && (
            <div className="flex items-center gap-3 pt-1">
              <SyncButton onClick={handleRhSync} loading={rhSyncing} disabled={false} label="Sync Cases" />
            </div>
          )}
          {rhSyncError && <p className="text-xs text-red-400">{rhSyncError}</p>}
        </div>

        {/* Salesforce */}
        <div className="bg-slate-900 rounded-lg p-4 border border-slate-700 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-white">Salesforce</span>
            {sfStatus?.hasSession
              ? <StatusBadge ok={true} label="Connected" />
              : <StatusBadge ok={false} label="Not connected" />}
          </div>
          {sfStatus?.lastSync && (
            <p className="text-xs text-slate-500">Last sync: {timeAgo(sfStatus.lastSync)} — {sfStatus.rowCount} rows</p>
          )}
          {sfStatus?.syncError && <p className="text-xs text-red-400">{sfStatus.syncError}</p>}
          {sfStatus?.hasSession && sfStatus?.reportConfigured && (
            <div className="flex items-center gap-3 pt-1">
              <SyncButton onClick={handleSfSync} loading={sfSyncing} disabled={false} label="Sync Pipeline" />
            </div>
          )}
          {!sfStatus?.reportConfigured && (
            <p className="text-xs text-slate-500">SF Report ID required — configure in AEs & Customers above.</p>
          )}
          {sfSyncError && <p className="text-xs text-red-400">{sfSyncError}</p>}
        </div>

        {/* Supportable */}
        <div className="bg-slate-900 rounded-lg p-4 border border-slate-700 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-white">Supportable</span>
            {supportableStatus?.running
              ? <span className="flex items-center gap-1 text-xs text-amber-400"><Loader2 className="w-3 h-3 animate-spin" /> Running</span>
              : supportableStatus?.lastScrape
                ? <StatusBadge ok={true} label={`Last: ${timeAgo(supportableStatus.lastScrape)}`} />
                : <StatusBadge ok={false} label="Not scraped" />}
          </div>
          {supportableStatus?.lastError && (
            <p className="text-xs text-red-400">{supportableStatus.lastError}</p>
          )}
          <div className="flex items-center gap-3 pt-1">
            <SyncButton onClick={handleRunScrape} loading={scraping} disabled={supportableStatus?.running ?? false} label="Run Scrape" />
            {!rhStatus?.hasSession && (
              <span className="text-xs text-slate-500">Requires VPN + RH Portal session</span>
            )}
          </div>
          {scrapeError && <p className="text-xs text-red-400 mt-1">{scrapeError}</p>}
        </div>

        {/* CCSP (Tableau) */}
        <div className="bg-slate-900 rounded-lg p-4 border border-slate-700 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-white">CCSP (Tableau)</span>
            {ccspStatus?.running
              ? <span className="flex items-center gap-1 text-xs text-amber-400"><Loader2 className="w-3 h-3 animate-spin" /> Running</span>
              : ccspStatus?.lastScrape
                ? <StatusBadge ok={true} label={`Last: ${timeAgo(ccspStatus.lastScrape)}`} />
                : <StatusBadge ok={false} label="Not scraped" />}
          </div>
          {ccspStatus?.lastError && (
            <p className="text-xs text-red-400">{ccspStatus.lastError}</p>
          )}
          <div className="flex items-center gap-3 pt-1">
            <SyncButton onClick={handleRunCcspScrape} loading={ccspScraping} disabled={ccspStatus?.running ?? false} label="Run Scrape" />
            {!rhStatus?.hasSession && (
              <span className="text-xs text-slate-500">Requires VPN + RH Portal session</span>
            )}
          </div>
          {ccspScrapeError && <p className="text-xs text-red-400 mt-1">{ccspScrapeError}</p>}
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
  const [googleAuthOk, setGoogleAuthOk] = useState(false)
  const [aeCount, setAeCount] = useState<number | null>(null)
  const [rhOk, setRhOk] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetConfirm, setResetConfirm] = useState<'full' | 'data' | null>(null)
  const [pendingDowngrade, setPendingDowngrade] = useState(false)
  const [dismissingDowngrade, setDismissingDowngrade] = useState(false)

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
      .then((d: OAuthStatus & { pendingDowngrade?: boolean }) => {
        if (d.authorized && !d.expired) setGoogleAuthOk(true)
        if (d.pendingDowngrade) setPendingDowngrade(true)
      })
      .catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })

    // Check AE count
    fetch('/api/aes', { signal })
      .then(r => r.json())
      .then(d => { setAeCount((d.aes ?? []).length) })
      .catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })

    // Check RH Portal
    fetch('/api/auth/redhat/status', { signal })
      .then(r => r.json())
      .then(d => { if (d.hasSession) setRhOk(true) })
      .catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })

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
    } else if (oauthKeysOk && !googleAuthOk && aeCount !== null) {
      setOpenSection('google-auth')
    } else if (oauthKeysOk && googleAuthOk && aeCount === 0) {
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
      await fetch(`/api/setup/reset${full ? '?full=true' : ''}`, { method: 'POST' })
    } catch {}
    setResetting(false)
    window.location.href = '/dashboard/setup'
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white flex flex-col">
      <div className="w-full max-w-2xl mx-auto px-4 py-12 flex-1">
        {/* Header */}
        <div className="text-center mb-10 relative">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-indigo-600 mb-3">
            <span className="text-xl">&#x1f5c2;&#xfe0f;</span>
          </div>
          <h1 className="text-3xl font-bold text-white">Daily Brief Dashboard</h1>
          <p className="text-slate-400 mt-1 text-sm">Settings — configure each section independently</p>
          <div className="absolute top-0 right-0 flex flex-col items-end gap-1">
            {resetConfirm ? (
              <div className="flex items-center gap-2 bg-red-950/60 border border-red-700/60 rounded-lg px-3 py-1.5">
                <span className="text-xs text-red-300">
                  {resetConfirm === 'full' ? 'Clears everything including OAuth keys.' : 'Clears data, keeps OAuth keys.'}
                </span>
                <button onClick={() => doReset(resetConfirm === 'full')} disabled={resetting} className="text-xs bg-red-700 hover:bg-red-600 text-white px-2 py-0.5 rounded disabled:opacity-50">
                  {resetting ? 'Clearing…' : 'Confirm'}
                </button>
                <button onClick={() => setResetConfirm(null)} className="text-xs text-slate-400 hover:text-white">Cancel</button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => setResetConfirm('full')}
                  className="text-xs text-slate-500 hover:text-red-400 transition-colors"
                  title="Clear everything including OAuth keys"
                >
                  Full Reset
                </button>
                <button
                  onClick={() => setResetConfirm('data')}
                  className="text-xs text-slate-600 hover:text-slate-400 transition-colors"
                  title="Clear data but keep OAuth keys"
                >
                  Reset Data Only
                </button>
              </>
            )}
          </div>
        </div>

        {/* Reduce Permissions banner — shown after bootstrap completes */}
        {pendingDowngrade && (
          <div className="mb-6 flex items-start gap-3 bg-amber-950/40 border border-amber-700/50 rounded-xl px-4 py-3">
            <span className="text-amber-400 mt-0.5 shrink-0">&#x1f512;</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-amber-200">Setup complete — reduce Drive permissions</p>
              <p className="text-xs text-slate-400 mt-0.5">Bootstrap used full Drive access to create folders and sheets. You can now downgrade to read-only Drive for day-to-day use.</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <a
                href="/oauth/start?mode=normal"
                className="text-xs bg-amber-600 hover:bg-amber-500 text-white px-3 py-1.5 rounded-lg font-medium transition-colors"
              >
                Reduce Permissions
              </a>
              <button
                onClick={async () => {
                  setDismissingDowngrade(true)
                  await fetch('/api/oauth/dismiss-downgrade', { method: 'POST' }).catch(() => {})
                  setPendingDowngrade(false)
                  setDismissingDowngrade(false)
                }}
                disabled={dismissingDowngrade}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-50"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Accordion sections */}
        <div className="space-y-3">
          <AccordionSection
            id="oauth-keys"
            title="OAuth Keys"
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
            title="Google Auth"
            badge={
              googleAuthOk
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
            title="Red Hat Portal"
            badge={
              rhOk
                ? <StatusBadge ok={true} label="Connected" />
                : <StatusBadge ok={null} label="Optional" />
            }
            isOpen={openSection === 'rh-portal'}
            onToggle={() => toggleSection('rh-portal')}
          >
            <RedHatPortalSection />
          </AccordionSection>

          <AccordionSection
            id="aes"
            title="AEs & Customers"
            badge={
              aeCount !== null && aeCount > 0
                ? <span className="text-xs bg-emerald-900/60 text-emerald-400 border border-emerald-700/50 px-2 py-0.5 rounded-full font-medium">
                    {aeCount} AE{aeCount !== 1 ? 's' : ''} configured
                  </span>
                : <StatusBadge ok={false} label="None configured" />
            }
            isOpen={openSection === 'aes'}
            onToggle={() => toggleSection('aes')}
          >
            <AEsCustomersSection />
          </AccordionSection>

          <AccordionSection
            id="data-sources"
            title="Data Sources"
            badge={<span className="text-xs text-slate-500">Status</span>}
            isOpen={openSection === 'data-sources'}
            onToggle={() => toggleSection('data-sources')}
          >
            <DataSourcesSection />
          </AccordionSection>

          <AccordionSection
            id="settings"
            title="Refresh Timer & Settings"
            badge={<span className="text-xs text-slate-500">Optional</span>}
            isOpen={openSection === 'settings'}
            onToggle={() => toggleSection('settings')}
          >
            <div className="space-y-4">
              <RefreshTimerSettings />
              <a
                href="/dashboard"
                className="block w-full text-center bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-semibold text-base transition-colors"
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
            className="text-sm text-slate-400 hover:text-white transition-colors underline"
          >
            Go to Dashboard
          </a>
        </div>
      </div>
    </div>
  )
}

// Also export as named for compatibility
export { SetupPage }
