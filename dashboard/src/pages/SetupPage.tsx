import { useState, useEffect, useCallback } from 'react'
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
    fetch('/api/setup/oauth-keys-status')
      .then((r) => r.json())
      .then((d) => { setExists(d.exists); if (d.exists) onReady() })
      .catch(() => setExists(false))
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
    fetch('/api/oauth/status')
      .then(r => r.json())
      .then((d: OAuthStatus) => setOauthStatus(d))
      .catch(() => setOauthStatus({ authorized: false, configuredAt: null }))
      .finally(() => setChecking(false))
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

      {/* Internal mode recommendation */}
      <div className="bg-amber-950/40 border border-amber-700/50 rounded-xl p-4 space-y-2">
        <div className="flex items-start gap-2">
          <span className="text-amber-400 text-lg leading-none">&#x1f4a1;</span>
          <div className="space-y-1">
            <p className="text-sm font-medium text-amber-200">For Red Hat teams: skip test-user approvals</p>
            <p className="text-sm text-slate-400">
              In the GCP Console &rarr; APIs &amp; Services &rarr; OAuth consent screen, switch the app from
              <strong className="text-slate-200"> External</strong> to
              <strong className="text-slate-200"> Internal</strong>. Any @redhat.com user can then
              connect without needing to be added individually.
            </p>
            <a
              href="https://console.cloud.google.com/apis/credentials/consent"
              target="_blank"
              rel="noreferrer"
              className="text-xs text-amber-400 hover:text-amber-300 underline inline-flex items-center gap-1"
            >
              Open GCP OAuth Consent Screen <ExternalLink className="w-3 h-3" />
            </a>
          </div>
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
  return { id: crypto.randomUUID(), name: '', domain: '', accountNumbers: '' }
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

function AutoBootstrapProgress({ state, onReset }: { state: AutoBootstrapState; onReset?: () => void }) {
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
                <p className="text-xs text-slate-500 mt-0.5 truncate max-w-xs">{step.detail}</p>
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
          {onReset && (
            <button onClick={onReset} className="mt-3 text-xs text-indigo-400 hover:text-indigo-300 underline">
              Add another AE
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function AutoBootstrapForm() {
  const [aeName, setAeName] = useState('')
  const [sfReportId, setSfReportId] = useState('')
  const [customerText, setCustomerText] = useState('')
  const [parentFolderId, setParentFolderId] = useState('')

  // Territory picker state
  const [territoryInput, setTerritoryInput] = useState('')
  const [discoveredTerritories, setDiscoveredTerritories] = useState<string[] | null>(null)
  const [selectedTerritories, setSelectedTerritories] = useState<string[]>([])
  const [discoveringTerritories, setDiscoveringTerritories] = useState(false)
  const [territoryError, setTerritoryError] = useState<string | null>(null)

  // Bootstrap state
  const [bootstrapState, setBootstrapState] = useState<AutoBootstrapState | null>(null)
  const [starting, setStarting] = useState(false)

  // Discover territories
  const discoverTerritories = async () => {
    setDiscoveringTerritories(true)
    setTerritoryError(null)
    try {
      const r = await fetch('/api/bootstrap/tableau/territories')
      const d = await r.json()
      if (d.error) {
        setTerritoryError(d.error)
      } else {
        setDiscoveredTerritories(d.territories ?? [])
      }
    } catch (e: any) {
      setTerritoryError(e.message || 'Failed to discover territories')
    } finally {
      setDiscoveringTerritories(false)
    }
  }

  // Toggle territory selection
  const toggleTerritory = (t: string) => {
    setSelectedTerritories(prev =>
      prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]
    )
  }

  // Start auto-bootstrap
  const startBootstrap = async () => {
    const customerNames = customerText.split('\n').map(s => s.trim()).filter(Boolean)
    const territories = discoveredTerritories
      ? selectedTerritories
      : territoryInput.split(',').map(s => s.trim()).filter(Boolean)

    if (!aeName.trim() || !sfReportId.trim() || !territories.length || !customerNames.length) return

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
        setTerritoryError(d.error)
        return
      }
      // Start polling
      setBootstrapState({ running: true, aeName: aeName.trim(), steps: [], error: null, completedAt: null })
    } catch (e: any) {
      setTerritoryError(e.message)
    } finally {
      setStarting(false)
    }
  }

  // Poll bootstrap status
  useEffect(() => {
    if (!bootstrapState?.running && !starting) return
    const interval = setInterval(async () => {
      try {
        const r = await fetch('/api/bootstrap/auto/status')
        const d: AutoBootstrapState = await r.json()
        setBootstrapState(d)
        if (!d.running) clearInterval(interval)
      } catch {}
    }, 2_000)
    return () => clearInterval(interval)
  }, [bootstrapState?.running, starting])

  const resetForm = () => { setBootstrapState(null); setAeName(''); setSfReportId(''); setCustomerText(''); setSelectedTerritories([]) }
  const customerNames = customerText.split('\n').map(s => s.trim()).filter(Boolean)
  const territories = discoveredTerritories ? selectedTerritories : territoryInput.split(',').map(s => s.trim()).filter(Boolean)
  const canStart = aeName.trim() && sfReportId.trim() && territories.length > 0 && customerNames.length > 0

  if (bootstrapState && (bootstrapState.running || bootstrapState.completedAt)) {
    return (
      <div>
        <AutoBootstrapProgress state={bootstrapState} onReset={bootstrapState.completedAt && !bootstrapState.running ? resetForm : undefined} />
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
      <p className="text-sm text-slate-400">
        Automatically create a Drive folder, discover account numbers, and generate all data sheets for a new AE.
      </p>

      <div className="grid grid-cols-1 gap-3">
        <div>
          <label className="block text-xs text-slate-400 mb-1">AE Name *</label>
          <input
            type="text"
            value={aeName}
            onChange={e => setAeName(e.target.value)}
            placeholder="Jane Smith"
            className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">SF Report ID *</label>
          <input
            type="text"
            value={sfReportId}
            onChange={e => setSfReportId(e.target.value)}
            placeholder="00OPe..."
            className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">Account Territories *</label>
          {discoveredTerritories ? (
            <div className="space-y-2">
              <div className="max-h-48 overflow-y-auto bg-slate-800 border border-slate-600 rounded-lg p-2 space-y-1">
                {discoveredTerritories.map(t => (
                  <label key={t} className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer hover:bg-slate-700/50 px-2 py-1 rounded">
                    <input
                      type="checkbox"
                      checked={selectedTerritories.includes(t)}
                      onChange={() => toggleTerritory(t)}
                      className="rounded border-slate-600"
                    />
                    {t}
                  </label>
                ))}
              </div>
              {selectedTerritories.length > 0 && (
                <p className="text-xs text-emerald-400">{selectedTerritories.length} selected</p>
              )}
              <button
                onClick={() => { setDiscoveredTerritories(null); setSelectedTerritories([]) }}
                className="text-xs text-slate-500 hover:text-slate-400 transition-colors"
              >
                Switch to manual input
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={territoryInput}
                  onChange={e => setTerritoryInput(e.target.value)}
                  placeholder="WEST_COMM_CORP_NORTHWEST_TERR01 (comma-separated)"
                  className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
                <button
                  onClick={discoverTerritories}
                  disabled={discoveringTerritories}
                  className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors shrink-0"
                >
                  {discoveringTerritories ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
                  Discover
                </button>
              </div>
              {territoryError && (
                <p className="text-xs text-red-400">{territoryError}</p>
              )}
            </div>
          )}
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">Customer Names * (one per line)</label>
          <textarea
            value={customerText}
            onChange={e => setCustomerText(e.target.value)}
            placeholder={"Acme Corp\nGlobex Industries\nStark Enterprises"}
            rows={5}
            className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-y"
          />
          {customerNames.length > 0 && (
            <p className="text-xs text-slate-500 mt-1">{customerNames.length} customer(s)</p>
          )}
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">Parent Drive Folder ID (optional)</label>
          <input
            type="text"
            value={parentFolderId}
            onChange={e => setParentFolderId(e.target.value)}
            placeholder="Leave blank to create in My Drive root"
            className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>

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

  // Load AEs and customers from server
  useEffect(() => {
    Promise.all([
      fetch('/api/aes').then(r => r.json()),
      fetch('/customers').then(r => r.json()),
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
          domain?: string
          accountNumbers?: string[]
          ae?: string
        }> = Array.isArray(customerList) ? customerList : []

        if (serverAes.length === 0) {
          setAes([makeBlankAE()])
        } else {
          // If any AE already has a driveFolderId, default to manual mode
          if (serverAes.some(ae => ae.driveFolderId)) setMode('manual')
          setAes(serverAes.map(ae => ({
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
                domain: c.domain ?? '',
                accountNumbers: (c.accountNumbers ?? []).join(', '),
              })),
          })).map(ae => ({
            ...ae,
            customers: ae.customers.length > 0 ? ae.customers : [makeBlankCustomer()],
          })))
        }
      })
      .catch(() => setAes([makeBlankAE()]))
      .finally(() => setLoading(false))
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
    if (!confirm('Remove this AE and all its customers?')) return
    setAes(prev => prev.filter(a => a.id !== aeId))
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
        alert(d.error)
      } else {
        updateAE(aeId, { folderId: d.folderId, folderName: d.folderName })
      }
    } catch {
      alert('Failed to validate folder — ensure Google Auth is complete')
    } finally {
      setValidatingFolder(null)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveMsg(null)
    try {
      // Build AE objects for the server
      const serverAes = aes
        .filter(a => a.name.trim())
        .map(a => ({
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
          Manual / Existing
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
            <button
              onClick={() => removeAE(ae.id)}
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-red-400 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Remove AE
            </button>
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

  const fetchStatus = async () => {
    try {
      const d: RhStatus = await fetch('/api/auth/redhat/status').then((r) => r.json())
      setStatus(d)
      if (d.hasSession && !d.loginInProgress && connecting) {
        setConnecting(false)
        fetch('/api/auth/redhat/sync', { method: 'POST' }).catch(() => {})
      }
    } catch {}
  }

  useEffect(() => {
    fetchStatus()
  }, [])

  useEffect(() => {
    if (!connecting) return
    const interval = setInterval(fetchStatus, 2_000)
    return () => clearInterval(interval)
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
        // Open VNC viewer as a popup so the login browser appears as a native-feeling window
        window.open('http://localhost:6080/vnc.html?autoconnect=1&resize=scale', 'rh-login', 'width=1280,height=900')
      }
    } catch (e: any) {
      setError(e.message)
      setConnecting(false)
    }
  }

  const handleCancel = async () => {
    await fetch('/api/auth/redhat/session', { method: 'DELETE' }).catch(() => {})
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
  } | null>(null)
  const [scraping, setScraping] = useState(false)

  useEffect(() => {
    fetch('/api/bootstrap/supportable/status')
      .then(r => r.json())
      .then(setSupportableStatus)
      .catch(() => {})

    fetch('/api/auth/salesforce/status')
      .then(r => r.json())
      .then(setSfStatus)
      .catch(() => {})
  }, [])

  const handleRunScrape = async () => {
    setScraping(true)
    try {
      // Fetch current AEs to send with the scrape
      const aeData = await fetch('/api/aes').then(r => r.json())
      const aes = aeData.aes ?? []
      if (aes.length === 0) {
        alert('No AEs configured — add AEs first.')
        return
      }
      await fetch('/api/bootstrap/supportable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aes }),
      })
      // Refresh status
      const newStatus = await fetch('/api/bootstrap/supportable/status').then(r => r.json())
      setSupportableStatus(newStatus)
    } catch (e: any) {
      alert(`Scrape failed: ${e.message}`)
    } finally {
      setScraping(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">Connection status for external data sources.</p>

      <div className="grid grid-cols-1 gap-3">
        {/* Red Hat Portal */}
        <div className="bg-slate-900 rounded-lg p-4 border border-slate-700 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-white">Red Hat Portal</span>
            <a href="#rh-portal" className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
              Configure above
            </a>
          </div>
          <p className="text-xs text-slate-500">Support cases are pulled via browser session.</p>
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
            <p className="text-xs text-slate-500">
              Last sync: {timeAgo(sfStatus.lastSync)} — {sfStatus.rowCount} rows
            </p>
          )}
          {sfStatus?.syncError && (
            <p className="text-xs text-red-400">{sfStatus.syncError}</p>
          )}
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
          <div className="flex items-center gap-3">
            <button
              onClick={handleRunScrape}
              disabled={scraping || (supportableStatus?.running ?? false)}
              className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
            >
              {scraping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
              Run Scrape
            </button>
            <span className="text-xs text-slate-500">Requires VPN connection</span>
          </div>
        </div>

        {/* CCSP / Tableau */}
        <div className="bg-slate-900 rounded-lg p-4 border border-slate-700 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-white">CCSP (Tableau)</span>
            <span className="text-xs text-slate-500 bg-slate-800 px-2 py-0.5 rounded">Coming soon</span>
          </div>
          <p className="text-xs text-slate-500">Cloud consumption data via Tableau will be supported in a future release.</p>
        </div>
      </div>
    </div>
  )
}

// ── AI Provider ────────────────────────────────────────────────────────────────

const GEMINI_SAMPLE_PROMPT = `You are a Red Hat Account Solution Architect's AI assistant. Generate a customer intelligence brief for:

Customer: [ACCOUNT NAME]
AE: [YOUR NAME] | Segment: [Commercial/Enterprise/Public Sector] | Region: [Region]

Context from your account Drive folder:
[Paste relevant notes, emails, or document excerpts for this account]

Write a structured brief with these sections:

**Account Overview** — 2-3 sentences on who they are and account health.

**Products & Subscriptions in Use** — List active Red Hat products and quantities.

**Customer Objectives & Priorities** — 3-5 bullets on what they're trying to achieve.

**Current Opportunities** — Active deals, renewals, or expansion conversations.

**Open Support Cases** — List open cases with severity and days open.

**Talking Points & Prep** — 4-6 specific, actionable bullets for your next interaction.

Keep each section tight and scannable. Total brief under 400 words.`

const DRIVE_FOLDER_STRUCTURE = `My Drive/
\u2514\u2500\u2500 [Your AE Accounts Folder]/        \u2190 set AE_PARENT_FOLDER_ID to this
    \u251c\u2500\u2500 Acme Corporation/
    \u2502   \u251c\u2500\u2500 Account Plan 2025.docx
    \u2502   \u251c\u2500\u2500 Meeting Notes/
    \u2502   \u2502   \u251c\u2500\u2500 2025-03-15 QBR Notes.docx
    \u2502   \u2502   \u2514\u2500\u2500 2025-02-10 Kickoff.docx
    \u2502   \u2514\u2500\u2500 Renewal Proposal Q2.docx
    \u251c\u2500\u2500 Contoso Ltd/
    \u2502   \u2514\u2500\u2500 ...
    \u2514\u2500\u2500 [Next Account]/`

const PROVIDERS: Record<string, { label: string; snippet: string; description: string; recommended?: boolean; manual?: boolean }> = {
  gemini: {
    label: 'Google Gemini',
    snippet: '',
    description: 'Manual prompt — no API key. Copy prompt and run in Gemini.',
    recommended: true,
    manual: true,
  },
  'claude-code': {
    label: 'Claude Code',
    snippet: 'LLM_PROVIDER=claude-code',
    description: 'Uses your Claude Code login. No API key needed.',
  },
  pai: {
    label: 'PAI (default)',
    snippet: 'LLM_PROVIDER=pai',
    description: 'Uses your local PAI infrastructure. No API key needed.',
  },
  openai: {
    label: 'OpenAI',
    snippet: 'LLM_PROVIDER=openai\nOPENAI_API_KEY=sk-...',
    description: 'GPT-4o via the OpenAI API. Requires an API key.',
  },
  anthropic: {
    label: 'Anthropic',
    snippet: 'LLM_PROVIDER=anthropic\nANTHROPIC_API_KEY=sk-ant-...',
    description: 'Claude via the Anthropic API. Requires an API key.',
  },
  ollama: {
    label: 'Ollama',
    snippet: 'LLM_PROVIDER=ollama\nOLLAMA_MODEL=llama3\nOLLAMA_BASE_URL=http://localhost:11434',
    description: 'Local models via Ollama. No API key needed.',
  },
}

function AIProviderSection() {
  const [selected, setSelected] = useState('gemini')
  const [testing, setTesting] = useState(false)
  const [testStatus, setTestStatus] = useState<{ ok: boolean; error?: string } | null>(null)

  const provider = PROVIDERS[selected]

  async function handleTest() {
    setTesting(true)
    try {
      const r = await fetch('/api/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: selected }),
      })
      const d = await r.json()
      setTestStatus(d.ok ? { ok: true } : { ok: false, error: d.error ?? 'Test failed' })
    } catch (e: any) {
      setTestStatus({ ok: false, error: e.message })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-slate-400 text-sm">
        Choose an AI provider to generate account briefs. Add the shown variables to your <code className="bg-slate-700 px-1.5 py-0.5 rounded text-sm text-slate-200">.env</code> file and restart the server.
      </p>

      <div className="grid grid-cols-2 gap-2">
        {Object.entries(PROVIDERS).map(([key, p]) => (
          <button
            key={key}
            onClick={() => setSelected(key)}
            className={`text-left p-3 rounded-xl border transition-colors ${
              selected === key
                ? 'border-indigo-500 bg-indigo-950/40'
                : 'border-slate-700 bg-slate-900 hover:border-slate-500'
            }`}
          >
            <div className="flex items-center gap-2">
              <div
                className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                  selected === key ? 'border-indigo-500 bg-indigo-500' : 'border-slate-500'
                }`}
              >
                {selected === key && <div className="w-2 h-2 rounded-full bg-white" />}
              </div>
              <span className="text-sm font-medium text-white">{p.label}</span>
              {p.recommended && (
                <span className="text-xs bg-emerald-900/60 text-emerald-400 border border-emerald-700/50 px-1.5 py-0.5 rounded font-medium">Recommended</span>
              )}
            </div>
            <p className="text-xs text-slate-400 mt-1 ml-6">{p.description}</p>
          </button>
        ))}
      </div>

      {provider.manual ? (
        <>
          <div className="bg-slate-900/50 rounded-xl p-5 border border-slate-700 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-slate-300">Sample brief prompt — copy into Gemini</p>
              <CopyButton text={GEMINI_SAMPLE_PROMPT} />
            </div>
            <pre className="text-xs text-slate-400 whitespace-pre-wrap font-mono bg-slate-900 rounded-lg p-3 border border-slate-700 max-h-52 overflow-y-auto">{GEMINI_SAMPLE_PROMPT}</pre>
          </div>

          <div className="bg-slate-900/50 rounded-xl p-5 border border-slate-700 space-y-3">
            <p className="text-sm font-medium text-slate-300">Recommended Google Drive folder structure</p>
            <pre className="text-xs text-slate-400 font-mono bg-slate-900 rounded-lg p-3 border border-slate-700">{DRIVE_FOLDER_STRUCTURE}</pre>
          </div>
        </>
      ) : (
        <>
          <div className="bg-slate-900 rounded-xl p-5 border border-slate-700 space-y-3">
            <p className="text-sm font-medium text-slate-300">Add to your <code className="bg-slate-700 px-1 rounded">.env</code> file:</p>
            <CodeBlock code={provider.snippet} />
            {selected === 'claude-code' && (
              <p className="text-xs text-slate-500">
                Requires the <code className="bg-slate-700 px-1 rounded">claude</code> CLI installed and logged in.
                Install at{' '}
                <a href="https://claude.ai/code" target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-300 underline">
                  claude.ai/code
                </a>
                {' '}then run <code className="bg-slate-700 px-1 rounded">claude login</code>.
              </p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleTest}
              disabled={testing}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-medium text-sm transition-colors"
            >
              {testing ? 'Testing...' : 'Test Connection'}
            </button>
            {testStatus && (
              <span className={`flex items-center gap-1.5 text-sm ${testStatus.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                {testStatus.ok
                  ? <><CheckCircle className="w-4 h-4" /> Connection successful</>
                  : <><XCircle className="w-4 h-4" /> {testStatus.error ?? 'Connection failed'}</>
                }
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Main Setup Page ────────────────────────────────────────────────────────────

type SectionId = 'oauth-keys' | 'google-auth' | 'aes' | 'rh-portal' | 'data-sources' | 'ai-provider' | 'settings'

export default function SetupPage() {
  const [openSection, setOpenSection] = useState<SectionId | null>(null)
  const [oauthKeysOk, setOauthKeysOk] = useState(false)
  const [googleAuthOk, setGoogleAuthOk] = useState(false)
  const [aeCount, setAeCount] = useState<number | null>(null)
  const [rhOk, setRhOk] = useState(false)
  const [resetting, setResetting] = useState(false)

  // Check initial states to determine auto-expand and badge data
  useEffect(() => {
    // Check OAuth keys
    fetch('/api/setup/oauth-keys-status')
      .then(r => r.json())
      .then(d => { if (d.exists) setOauthKeysOk(true) })
      .catch(() => {})

    // Check Google auth
    fetch('/api/oauth/status')
      .then(r => r.json())
      .then((d: OAuthStatus) => { if (d.authorized && !d.expired) setGoogleAuthOk(true) })
      .catch(() => {})

    // Check AE count
    fetch('/api/aes')
      .then(r => r.json())
      .then(d => { setAeCount((d.aes ?? []).length) })
      .catch(() => {})

    // Check RH Portal
    fetch('/api/auth/redhat/status')
      .then(r => r.json())
      .then(d => { if (d.hasSession) setRhOk(true) })
      .catch(() => {})
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
    const msg = full
      ? 'Full reset: clears everything including OAuth keys. You will need to re-upload the keys file. Continue?'
      : 'Clear all cached data, customers, and auth tokens? OAuth keys will be kept.'
    if (!confirm(msg)) return
    setResetting(true)
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
            <button
              onClick={() => doReset(true)}
              disabled={resetting}
              className="text-xs text-slate-500 hover:text-red-400 transition-colors disabled:opacity-50"
              title="Clear everything including OAuth keys"
            >
              {resetting ? 'Clearing...' : 'Full Reset'}
            </button>
            <button
              onClick={() => doReset(false)}
              disabled={resetting}
              className="text-xs text-slate-600 hover:text-slate-400 transition-colors disabled:opacity-50"
              title="Clear data but keep OAuth keys"
            >
              Reset Data Only
            </button>
          </div>
        </div>

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
            id="data-sources"
            title="Data Sources"
            badge={<span className="text-xs text-slate-500">Status</span>}
            isOpen={openSection === 'data-sources'}
            onToggle={() => toggleSection('data-sources')}
          >
            <DataSourcesSection />
          </AccordionSection>

          <AccordionSection
            id="ai-provider"
            title="AI Provider"
            badge={<span className="text-xs text-slate-500">Optional</span>}
            isOpen={openSection === 'ai-provider'}
            onToggle={() => toggleSection('ai-provider')}
          >
            <AIProviderSection />
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
