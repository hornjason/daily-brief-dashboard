import { useState, useEffect } from 'react'
import { RefreshTimerSettings } from '../components/RefreshTimerSettings'
import {
  CheckCircle,
  XCircle,
  Copy,
  Check,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
  Loader2,
  Plus,
  Zap,
  Search,
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

interface StepStatus {
  customersOk: boolean | null
  authTokens: AuthTokens | null
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
  if (ok === null) return <span className="text-slate-400 text-sm">{label}: checking…</span>
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

// ── Step indicator ─────────────────────────────────────────────────────────────

const STEP_LABELS = ['OAuth Keys', 'Google Auth', 'Accounts', 'Domains', 'Red Hat Portal', 'Launch']

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-8">
      {STEP_LABELS.map((label, i) => {
        const done = i < current
        const active = i === current
        return (
          <div key={i} className="flex items-center">
            <div className="flex flex-col items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
                  done
                    ? 'bg-indigo-600 text-white'
                    : active
                    ? 'bg-indigo-600 text-white ring-2 ring-indigo-400 ring-offset-2 ring-offset-slate-900'
                    : 'bg-slate-700 text-slate-400'
                }`}
              >
                {done ? <Check className="w-4 h-4" /> : i + 1}
              </div>
              <span
                className={`mt-1 text-xs whitespace-nowrap ${
                  active ? 'text-white' : done ? 'text-indigo-400' : 'text-slate-500'
                }`}
              >
                {label}
              </span>
            </div>
            {i < STEP_LABELS.length - 1 && (
              <div
                className={`w-12 h-0.5 mb-5 mx-1 ${i < current ? 'bg-indigo-600' : 'bg-slate-700'}`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Template links ─────────────────────────────────────────────────────────────

const DATA_FILE_TEMPLATES = [
  {
    label: '[AE Name] Supportable',
    href: 'https://docs.google.com/spreadsheets/d/17EL8vf-WLRhRphWCmcWzW5aEAf5xbGqQ-dpJbinAU1c/edit',
    instruction: 'This is the account list source of truth. You need to run supportable pulls for each Account Number you support, downloading the sales information for Active contracts and placing it in a tab labeled the same name as the account. You should have 1 Account List tab and individual tabs for each customer\'s supportable pull, as shown in the template.',
  },
  {
    label: '[AE Name] CCSP',
    href: 'https://docs.google.com/spreadsheets/d/1HUlZsqQVIVCbyrgSU467f7vVSLoSOdGFNplyefJRGwg/edit',
    instruction: 'Run the CCSP report to generate cloud spend data — run one report for each territory you cover.',
  },
  {
    label: '[AE Name] Pipeline',
    href: 'https://docs.google.com/spreadsheets/d/1af6JuVNilnUhMII9x9-r1Pkvlp9o_1hEU3ul-JaTMLA/edit',
    instruction: 'Talk to your manager about running a Salescloud Opportunity report for each territory you cover.',
  },
]

// ── Step 1: Sheets import ──────────────────────────────────────────────────────

function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

interface FileCheckResult {
  aeName: string
  folderId: string
  supportable: { found: boolean; fileName?: string }
  ccsp: { found: boolean; fileName?: string }
  pipeline: { found: boolean; fileName?: string }
}

const AE_FOLDER_STRUCTURE = `My Drive/
├── Jane Smith/                     ← connect this folder
│   ├── Jane Smith Supportable      (Google Sheet)
│   ├── Jane Smith CCSP             (Google Sheet)
│   └── Jane Smith Pipeline         (Google Sheet)
└── Bob Jones/                      ← or connect this
    ├── Bob Jones Supportable
    ├── Bob Jones CCSP
    └── Bob Jones Pipeline`

function Step1Sheets({ onImported }: { onImported: () => void }) {
  const [aeFolders, setAeFolders] = useState<{ folderId: string; folderName: string | null; connectedAt: string | null }[]>([])
  const [addFolderUrl, setAddFolderUrl] = useState('')
  const [addFolderLoading, setAddFolderLoading] = useState(false)
  const [addFolderError, setAddFolderError] = useState<string | null>(null)

  const [discoverLoading, setDiscoverLoading] = useState(false)
  const [fileCheckResults, setFileCheckResults] = useState<FileCheckResult[]>([])
  const [accountPreview, setAccountPreview] = useState<{ name: string; ae: string }[] | null>(null)
  const [importLoading, setImportLoading] = useState(false)
  const [importDone, setImportDone] = useState(false)
  const [importCount, setImportCount] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/data-sources/status')
      .then(r => r.json())
      .then((d: { folders: { folderId: string; folderName: string | null; connectedAt: string | null }[] }) => setAeFolders(d.folders ?? []))
      .catch(() => {})
  }, [])

  async function handleAddFolder() {
    if (!addFolderUrl.trim()) return
    setAddFolderLoading(true)
    setAddFolderError(null)
    try {
      const r = await fetch('/api/data-sources/add-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderUrl: addFolderUrl.trim() }),
      })
      const d = await r.json()
      if (d.error) { setAddFolderError(d.error); return }
      setAeFolders(prev => [...prev.filter(f => f.folderId !== d.folderId), { folderId: d.folderId, folderName: d.folderName, connectedAt: d.connectedAt }])
      setAddFolderUrl('')
    } catch {
      setAddFolderError('Failed to connect — ensure Google Auth is complete (Step 1)')
    } finally {
      setAddFolderLoading(false)
    }
  }

  async function handleRemoveFolder(folderId: string) {
    try {
      await fetch('/api/data-sources/remove-folder', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId }),
      })
      setAeFolders(prev => prev.filter(f => f.folderId !== folderId))
      setFileCheckResults([])
      setAccountPreview(null)
    } catch {}
  }

  async function handleDiscover() {
    if (aeFolders.length === 0) { setError('Add at least one AE folder above before discovering.'); return }
    setDiscoverLoading(true)
    setError(null)
    setFileCheckResults([])
    setAccountPreview(null)
    try {
      const [checkRes, previewRes] = await Promise.all([
        fetch('/api/data-sources/check-files', { method: 'POST' }).then(r => r.json()),
        fetch('/api/sheets/bootstrap-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }).then(r => r.json()),
      ])
      if (checkRes.error) { setError(checkRes.error); return }
      setFileCheckResults(checkRes.results ?? [])
      if (previewRes.accounts?.length) {
        setAccountPreview(previewRes.accounts)
      } else if (!checkRes.results?.some((r: FileCheckResult) => r.supportable.found)) {
        setError('No Supportable file found. Check your file naming and folder structure above.')
      }
    } catch {
      setError('Discovery failed — ensure Google Auth is complete (Step 1)')
    } finally {
      setDiscoverLoading(false)
    }
  }

  async function handleConfirmImport() {
    setImportLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/sheets/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const d: { imported?: number; error?: string } = await r.json()
      if (d.error) { setError(d.error); return }
      setImportCount(d.imported ?? 0)
      setImportDone(true)
      onImported()
    } catch {
      setError('Import failed')
    } finally {
      setImportLoading(false)
    }
  }

  const canImport = fileCheckResults.some(r => r.supportable.found) && (accountPreview?.length ?? 0) > 0

  return (
    <div className="space-y-5">
      {/* AE Data Folders */}
      <div className="space-y-3 pb-5 border-b border-slate-700">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">AE Data Folders</h3>
            <p className="text-xs text-slate-400 mt-0.5">Connect a Google Drive folder for each AE you support. Each folder must contain the three required data files with correct naming before auto-discovery will work.</p>
          </div>
          {aeFolders.length > 0 && (
            <span className="text-xs bg-emerald-900/60 text-emerald-400 border border-emerald-700/50 px-2 py-0.5 rounded-full font-medium">
              {aeFolders.length} connected
            </span>
          )}
        </div>

        {aeFolders.length > 0 && (
          <div className="space-y-2">
            {aeFolders.map(f => (
              <div key={f.folderId} className="flex items-center justify-between bg-slate-900 rounded-lg px-3 py-2 border border-slate-700">
                <div className="flex items-center gap-2 min-w-0">
                  <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="text-sm text-white truncate">{f.folderName ?? f.folderId}</span>
                  {f.connectedAt && <span className="text-xs text-slate-500 shrink-0">{timeAgo(f.connectedAt)}</span>}
                </div>
                <button
                  onClick={() => handleRemoveFolder(f.folderId)}
                  className="text-slate-500 hover:text-red-400 transition-colors text-xs ml-3 shrink-0"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <input
            type="text"
            value={addFolderUrl}
            onChange={e => setAddFolderUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddFolder()}
            placeholder="Paste Google Drive folder URL…"
            className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
          <button
            onClick={handleAddFolder}
            disabled={addFolderLoading || !addFolderUrl.trim()}
            className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors shrink-0"
          >
            {addFolderLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Add
          </button>
        </div>
        {addFolderError && <p className="text-xs text-red-400">{addFolderError}</p>}

        {/* Drive folder structure */}
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-slate-300">Required Google Drive folder structure</p>
          <pre className="text-xs text-slate-400 font-mono bg-slate-900 rounded-lg p-3 border border-slate-700 overflow-x-auto">{AE_FOLDER_STRUCTURE}</pre>
          <p className="text-xs text-slate-500">One folder per AE, named to match the prefix in each data file. The folder name must match the AE name used in your Supportable, CCSP, and Pipeline files. This structure must be in place before running discovery.</p>
        </div>

        {/* Naming guidelines */}
        <div className="bg-slate-900/60 rounded-lg p-3 border border-slate-700/50 space-y-1.5">
          <p className="text-xs font-medium text-slate-300">Required file naming for auto-discovery:</p>
          <div className="space-y-1.5 text-xs text-slate-400">
            <div className="flex items-start gap-1.5"><div className="w-1 h-1 rounded-full bg-amber-400 mt-1.5 shrink-0" /><span>Your account and subscription data file must be named <code className="bg-slate-700 px-1 rounded text-amber-300">[AE Name] Supportable</code> — for example <code className="bg-slate-700 px-1 rounded text-slate-300">Jane Smith Supportable</code>.</span></div>
            <div className="flex items-start gap-1.5"><div className="w-1 h-1 rounded-full bg-amber-400 mt-1.5 shrink-0" /><span>Your cloud spend file must be named <code className="bg-slate-700 px-1 rounded text-amber-300">[AE Name] CCSP</code> — for example <code className="bg-slate-700 px-1 rounded text-slate-300">Jane Smith CCSP</code>.</span></div>
            <div className="flex items-start gap-1.5"><div className="w-1 h-1 rounded-full bg-amber-400 mt-1.5 shrink-0" /><span>Your pipeline file must be named <code className="bg-slate-700 px-1 rounded text-amber-300">[AE Name] Pipeline</code> — for example <code className="bg-slate-700 px-1 rounded text-slate-300">Jane Smith Pipeline</code>.</span></div>
            <div className="flex items-start gap-1.5"><div className="w-1 h-1 rounded-full bg-slate-500 mt-1.5 shrink-0" /><span className="text-slate-500">All three files must live inside the AE folder at its root. The folder and file naming must be complete before you run Discover below.</span></div>
          </div>
        </div>
      </div>

      {/* Required Data Files */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Required Data Files</p>
        {DATA_FILE_TEMPLATES.map((t) => (
          <div key={t.label} className="bg-slate-900 border border-slate-700 rounded-lg p-4 space-y-2">
            <p className="text-xs text-slate-400">{t.instruction}</p>
            <a
              href={t.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              View {t.label} template
            </a>
          </div>
        ))}
      </div>

      {/* Discover & Verify / Results */}
      {importDone ? (
        <div className="bg-emerald-950/50 border border-emerald-700 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" />
            <span className="text-sm font-semibold text-white">{importCount} accounts imported from Supportable files</span>
          </div>
          <button
            onClick={() => { setImportDone(false); setFileCheckResults([]); setAccountPreview(null) }}
            className="text-xs text-slate-400 hover:text-white transition-colors underline"
          >
            Re-discover
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <h2 className="text-2xl font-bold text-white mb-1">Discover & Verify</h2>
            <p className="text-slate-400 text-sm">Scan your connected AE folders for the required data files and preview accounts before importing.</p>
          </div>

          <button
            onClick={handleDiscover}
            disabled={discoverLoading || aeFolders.length === 0}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            {discoverLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            {discoverLoading ? 'Scanning folders…' : 'Discover & Verify'}
          </button>

          {aeFolders.length === 0 && (
            <p className="text-xs text-amber-400">Add at least one AE folder above to enable discovery.</p>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          {fileCheckResults.length > 0 && (
            <div className="space-y-4">
              {/* Per-folder file checklist */}
              <div className="space-y-3">
                {fileCheckResults.map(r => (
                  <div key={r.folderId} className="bg-slate-900 border border-slate-700 rounded-lg p-4 space-y-2">
                    <p className="text-sm font-medium text-white">{r.aeName}</p>
                    <div className="grid grid-cols-3 gap-2">
                      {(
                        [
                          { label: 'Supportable', result: r.supportable },
                          { label: 'CCSP', result: r.ccsp },
                          { label: 'Pipeline', result: r.pipeline },
                        ] as { label: string; result: { found: boolean; fileName?: string } }[]
                      ).map(({ label, result }) => (
                        <div
                          key={label}
                          className={`flex items-center gap-1.5 text-xs px-2 py-1.5 rounded ${
                            result.found ? 'bg-emerald-950/50 text-emerald-400' : 'bg-red-950/50 text-red-400'
                          }`}
                        >
                          {result.found
                            ? <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                            : <XCircle className="w-3.5 h-3.5 shrink-0" />}
                          <span>{label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Account preview */}
              {accountPreview && accountPreview.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{accountPreview.length} accounts discovered</p>
                  <div className="bg-slate-900 rounded-lg p-3 max-h-40 overflow-y-auto space-y-1 border border-slate-700">
                    {accountPreview.slice(0, 50).map((a) => (
                      <div key={a.name} className="flex items-center justify-between text-sm">
                        <span className="text-white">{a.name}</span>
                        <span className="text-slate-500 text-xs">{a.ae}</span>
                      </div>
                    ))}
                    {accountPreview.length > 50 && (
                      <p className="text-slate-500 text-xs pt-1">+ {accountPreview.length - 50} more</p>
                    )}
                  </div>
                </div>
              )}

              {/* Confirm & Import */}
              {canImport ? (
                <button
                  onClick={handleConfirmImport}
                  disabled={importLoading}
                  className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  {importLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                  {importLoading ? 'Importing…' : `Confirm & Import ${accountPreview?.length ?? 0} Accounts`}
                </button>
              ) : (
                <p className="text-xs text-amber-400">No Supportable file found in any connected folder. Check your file naming and folder structure, then discover again.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Step 2: Google Auth ────────────────────────────────────────────────────────

interface OAuthStatus {
  authorized: boolean
  expired?: boolean
  email?: string
  configuredAt: string | null
}

function Step2GoogleAuth() {
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
        Checking Google connection…
      </div>
    )
  }

  if (oauthStatus?.expired) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-2xl font-bold text-white mb-1">Google Workspace</h2>
          <p className="text-slate-400">Token expired — re-authenticate to continue.</p>
        </div>
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
        <div>
          <h2 className="text-2xl font-bold text-white mb-1">Google Workspace</h2>
          <p className="text-slate-400">Connected and verified.</p>
        </div>
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
      <div>
        <h2 className="text-2xl font-bold text-white mb-1">Connect Google Workspace</h2>
        <p className="text-slate-400">Authorize read access to Calendar, Gmail, Drive, and Sheets. One click — no scripts needed.</p>
      </div>

      {/* Main connect button */}
      <div className="bg-slate-800 rounded-xl p-6 border border-slate-700 space-y-4">
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
          <span className="text-amber-400 text-lg leading-none">💡</span>
          <div className="space-y-1">
            <p className="text-sm font-medium text-amber-200">For Red Hat teams: skip test-user approvals</p>
            <p className="text-sm text-slate-400">
              In the GCP Console → APIs & Services → OAuth consent screen, switch the app from
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

// ── Step 3: AI Provider ────────────────────────────────────────────────────────

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
└── [Your AE Accounts Folder]/        ← set AE_PARENT_FOLDER_ID to this
    ├── Acme Corporation/
    │   ├── Account Plan 2025.docx
    │   ├── Meeting Notes/
    │   │   ├── 2025-03-15 QBR Notes.docx
    │   │   └── 2025-02-10 Kickoff.docx
    │   └── Renewal Proposal Q2.docx
    ├── Contoso Ltd/
    │   └── ...
    └── [Next Account]/`

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

function Step3AIProvider({
  status,
  onTest,
}: {
  status: { ok: boolean; error?: string } | null
  onTest: (provider: string) => Promise<void>
}) {
  const [selected, setSelected] = useState('gemini')
  const [testing, setTesting] = useState(false)

  const provider = PROVIDERS[selected]

  async function handleTest() {
    setTesting(true)
    await onTest(selected)
    setTesting(false)
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-white mb-1">Configure AI Briefs</h2>
        <p className="text-slate-400">
          Choose an AI provider to generate account briefs. Add the shown variables to your <code className="bg-slate-700 px-1.5 py-0.5 rounded text-sm text-slate-200">.env</code> file and restart the server.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {Object.entries(PROVIDERS).map(([key, p]) => (
          <button
            key={key}
            onClick={() => setSelected(key)}
            className={`text-left p-3 rounded-xl border transition-colors ${
              selected === key
                ? 'border-indigo-500 bg-indigo-950/40'
                : 'border-slate-700 bg-slate-800 hover:border-slate-500'
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
          {/* Gemini manual flow */}
          <div className="bg-slate-800/50 rounded-xl p-5 border border-slate-700 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-slate-300">Sample brief prompt — copy into Gemini</p>
              <CopyButton text={GEMINI_SAMPLE_PROMPT} />
            </div>
            <pre className="text-xs text-slate-400 whitespace-pre-wrap font-mono bg-slate-900 rounded-lg p-3 border border-slate-700 max-h-52 overflow-y-auto">{GEMINI_SAMPLE_PROMPT}</pre>
            <p className="text-xs text-slate-500">
              If you connected AE folders in Step 1, subscription and CCSP data is available via the automated providers.
              For Gemini, add context from your account's Drive folder when pasting this prompt.
            </p>
          </div>

          {/* Drive folder structure */}
          <div className="bg-slate-800/50 rounded-xl p-5 border border-slate-700 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-slate-300">Recommended Google Drive folder structure</p>
            </div>
            <pre className="text-xs text-slate-400 font-mono bg-slate-900 rounded-lg p-3 border border-slate-700">{DRIVE_FOLDER_STRUCTURE}</pre>
            <p className="text-xs text-slate-500">
              Connect your root sales folder in Step 1. The dashboard searches all subfolders at any depth — pipeline files, CCSP tabs, and account documents are discovered automatically regardless of how many levels deep they are.
              You can connect at any level: your /Sales root, a region folder, or an individual AE folder. Deeper = more auto-discovery.
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="bg-slate-800 rounded-xl p-5 border border-slate-700 space-y-3">
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
              {testing ? 'Testing…' : 'Test Connection'}
            </button>
            {status && (
              <span className={`flex items-center gap-1.5 text-sm ${status.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                {status.ok
                  ? <><CheckCircle className="w-4 h-4" /> Connection successful</>
                  : <><XCircle className="w-4 h-4" /> {status.error ?? 'Connection failed'}</>
                }
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Step 3: Domain Detection ───────────────────────────────────────────────────

interface InferredDomain {
  customerName: string
  candidates: { domain: string; count: number; sources: string[] }[]
  currentDomain?: string
  error?: string
}

function Step3DomainDetection({ onSaved }: { onSaved: () => void }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [needsReview, setNeedsReview] = useState<InferredDomain[]>([])
  const [autoResolvedCount, setAutoResolvedCount] = useState(0)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [autoSaved, setAutoSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const saveDomains = async (domains: { name: string; domain: string }[]) => {
    const r = await fetch('/api/setup/save-domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains }),
    })
    const d = await r.json()
    if (!d.ok) throw new Error(d.error ?? 'Save failed')
  }

  useEffect(() => {
    fetch('/api/setup/infer-domains', { method: 'POST' })
      .then((r) => r.json())
      .then(async (d) => {
        const res: InferredDomain[] = d.results ?? []

        // Split: any candidate = auto-resolved, no candidates at all = needs review
        const auto: InferredDomain[] = []
        const gaps: InferredDomain[] = []
        for (const r of res) {
          if (r.candidates.length > 0) auto.push(r)
          else gaps.push(r)
        }

        // Pre-fill edits for gap rows
        const initial: Record<string, string> = {}
        for (const r of gaps) {
          initial[r.customerName] = r.currentDomain || r.candidates[0]?.domain || ''
        }

        setAutoResolvedCount(auto.length)
        setNeedsReview(gaps)
        setEdits(initial)

        // All resolved from Supportable — auto-save and done
        if (gaps.length === 0 && auto.length > 0) {
          const domains = auto.map(r => ({ name: r.customerName, domain: r.candidates[0].domain }))
          await saveDomains(domains).catch(() => {})
          setAutoSaved(true)
          onSaved()
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const domains = Object.entries(edits).map(([name, domain]) => ({ name, domain }))
      await saveDomains(domains)
      setSaved(true)
      onSaved()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-white mb-1">Auto-Detect Domains</h2>
        <p className="text-slate-400 text-sm">
          Extracting email domains from your Supportable files — the fastest and most accurate source.
        </p>
      </div>

      {loading && (
        <div className="flex items-center gap-3 py-8 justify-center text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Scanning Supportable files, web, and email signals…</span>
        </div>
      )}

      {error && (
        <div className="bg-red-900/20 border border-red-700/40 rounded-xl p-4 text-red-300 text-sm">
          {error.includes('No customers') || error.includes('not configured')
            ? 'No accounts found — complete Step 1 (Accounts) first.'
            : error.includes('Token') || error.includes('token') || error.includes('auth') || error.includes('OAuth')
            ? 'Google Auth error — complete Step 2 first, then return here.'
            : `Error scanning for domains: ${error}`}
        </div>
      )}

      {/* All resolved automatically */}
      {!loading && !error && autoSaved && (
        <div className="bg-emerald-950/50 border border-emerald-700 rounded-xl p-5 space-y-1">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" />
            <span className="text-sm font-semibold text-white">
              {autoResolvedCount} domains detected and saved automatically
            </span>
          </div>
          <p className="text-xs text-slate-400 pl-7">All domains resolved from contact emails in your Supportable files. Hit Next to continue.</p>
        </div>
      )}

      {/* Gaps need review */}
      {!loading && !error && needsReview.length > 0 && (
        <div className="space-y-4">
          {autoResolvedCount > 0 && (
            <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-950/30 border border-emerald-800/40 rounded-lg px-3 py-2">
              <CheckCircle className="w-3.5 h-3.5 shrink-0" />
              {autoResolvedCount} domain{autoResolvedCount !== 1 ? 's' : ''} auto-resolved from Supportable — {needsReview.length} need{needsReview.length === 1 ? 's' : ''} review below
            </div>
          )}
          <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
            {needsReview.map((r) => (
              <div key={r.customerName} className="bg-slate-700/50 rounded-lg px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-200 truncate">{r.customerName}</p>
                  {r.candidates.length > 0 && (
                    <p className="text-xs text-slate-500 mt-0.5">
                      best guess: {r.candidates[0].domain} via {r.candidates[0].sources.join(' + ')}
                    </p>
                  )}
                  {r.candidates.length === 0 && (
                    <p className="text-xs text-slate-500 mt-0.5 italic">No signal found — enter manually</p>
                  )}
                </div>
                <input
                  type="text"
                  value={edits[r.customerName] ?? ''}
                  onChange={(e) => setEdits((prev) => ({ ...prev, [r.customerName]: e.target.value }))}
                  placeholder="domain.com"
                  className="w-44 bg-slate-600 border border-slate-500 rounded-lg px-3 py-1.5 text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 pt-1">
            {saved ? (
              <span className="flex items-center gap-2 text-emerald-400 text-sm font-medium">
                <CheckCircle className="w-4 h-4" /> Domains saved
              </span>
            ) : (
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                {saving ? 'Saving…' : `Save ${needsReview.length} Domain${needsReview.length !== 1 ? 's' : ''}`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Step 4: Launch ─────────────────────────────────────────────────────────────

function Step5Launch({ status }: { status: StepStatus }) {
  const checks: Array<{ label: string; ok: boolean | null }> = [
    {
      label: 'Customers configured',
      ok: status.customersOk,
    },
    {
      label: 'Gmail token',
      ok: status.authTokens?.gmail ?? null,
    },
    {
      label: 'Drive token',
      ok: status.authTokens?.drive ?? null,
    },
    {
      label: 'Calendar token',
      ok: status.authTokens?.calendar ?? null,
    },
  ]

  const requiredOk = status.customersOk === true &&
    status.authTokens?.gmail === true &&
    status.authTokens?.drive === true &&
    status.authTokens?.calendar === true

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white mb-1">You're Ready!</h2>
        <p className="text-slate-400">
          Here's a summary of your setup. Required items must be green before the dashboard will work fully.
        </p>
      </div>

      <div className="bg-slate-800 rounded-xl p-5 border border-slate-700 space-y-3">
        <p className="text-sm font-medium text-slate-300 mb-2">Setup Checklist</p>
        {checks.map(({ label, ok }) => (
          <div key={label} className="flex items-center gap-2.5">
            {ok === null ? (
              <div className="w-4 h-4 rounded-full border border-slate-500" />
            ) : ok ? (
              <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : (
              <XCircle className="w-4 h-4 text-red-400 shrink-0" />
            )}
            <span className={`text-sm ${ok === true ? 'text-slate-200' : ok === false ? 'text-red-300' : 'text-slate-400'}`}>
              {label}
            </span>
          </div>
        ))}
      </div>

      {!requiredOk && (
        <div className="bg-amber-900/20 border border-amber-700/40 rounded-xl p-4">
          <p className="text-amber-300 text-sm">
            Some required items are not yet configured. The dashboard will load but some sections may be empty.
          </p>
        </div>
      )}

      <RefreshTimerSettings />

      <div className="space-y-3">
        <a
          href="/dashboard"
          className="block w-full text-center bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-semibold text-base transition-colors"
        >
          Open Dashboard
        </a>
        <p className="text-center text-xs text-slate-500">
          Restart the server if you changed any <code className="bg-slate-700 px-1 rounded">.env</code> settings.
        </p>
      </div>
    </div>
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
                placeholder='Paste the contents of gcp-oauth.keys.json here…'
                rows={6}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 font-mono text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-indigo-500 resize-none"
              />
              <button
                onClick={() => submit(pasteText)}
                disabled={!pasteText.trim() || uploading}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                {uploading ? 'Saving…' : 'Save Keys'}
              </button>
            </div>
          ) : (
            <label className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer w-fit">
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {uploading ? 'Uploading…' : 'Upload gcp-oauth.keys.json'}
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

// ── Step 5: Red Hat Portal ─────────────────────────────────────────────────────

interface RhStatus {
  hasSession: boolean
  sessionExpired: boolean
  lastScraped: string | null
  caseCount: number
  loginInProgress: boolean
  loginTimedOut: boolean
}

function Step5RedHat({ onConnected }: { onConnected: () => void }) {
  const [status, setStatus] = useState<RhStatus | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchStatus = async () => {
    try {
      const d: RhStatus = await fetch('/api/auth/redhat/status').then((r) => r.json())
      setStatus(d)
      if (d.hasSession && !d.loginInProgress && connecting) {
        setConnecting(false)
        // Trigger first scrape immediately after session saved
        fetch('/api/auth/redhat/sync', { method: 'POST' }).catch(() => {})
        onConnected()
      }
    } catch {}
  }

  useEffect(() => {
    fetchStatus()
  }, [])

  // Poll every 2s while login is in progress
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
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <CheckCircle className="w-5 h-5 text-emerald-400" />
          Red Hat Portal Connected
        </h2>
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
      <div>
        <h2 className="text-lg font-semibold text-white">Red Hat Portal</h2>
        <p className="text-slate-400 text-sm mt-1">
          Connect your Red Hat Customer Portal session to surface open support cases in the
          dashboard. A browser window will open — log in, then return here.
        </p>
      </div>

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
            Optional — you can skip this step and connect later from the dashboard.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Main wizard ────────────────────────────────────────────────────────────────

const OPTIONAL_STEPS = new Set([3, 4])

const LS_STEP_KEY = 'pai-setup-step'

export function SetupPage() {
  const [step, setStepRaw] = useState(() => {
    // URL param takes priority (e.g. OAuth redirect back), then localStorage, then 0
    const urlStep = parseInt(new URLSearchParams(window.location.search).get('step') ?? '', 10)
    if (!isNaN(urlStep)) return Math.min(Math.max(urlStep, 0), 5)
    const saved = parseInt(localStorage.getItem(LS_STEP_KEY) ?? '', 10)
    return isNaN(saved) ? 0 : Math.min(Math.max(saved, 0), 5)
  })

  const setStep = (fn: number | ((s: number) => number)) => {
    setStepRaw((prev) => {
      const next = typeof fn === 'function' ? fn(prev) : fn
      localStorage.setItem(LS_STEP_KEY, String(next))
      return next
    })
  }
  const [status, setStatus] = useState<StepStatus>({
    customersOk: null,
    authTokens: null,
  })

  // Check auth tokens
  const checkAuth = () => {
    fetch('/api/setup/check-auth')
      .then((r) => r.json())
      .then((d) => setStatus((s) => ({ ...s, authTokens: { ...(d.tokens ?? d), valid: d.valid, expired: d.expired, email: d.email } })))
      .catch(() => {})
  }

  useEffect(() => {
    checkAuth()
    // Initialize customersOk from server state (persists across page reloads)
    fetch('/api/sheets/status')
      .then((r) => r.json())
      .then((d) => { if (d.connected) setStatus((s) => ({ ...s, customersOk: true })) })
      .catch(() => {})
  }, [])

  const [oauthKeysOk, setOauthKeysOk] = useState(false)

  // Re-check auth when entering step 1 (0-indexed, Google Auth is now step 1)
  useEffect(() => {
    if (step === 1) checkAuth()
  }, [step])

  const [resetting, setResetting] = useState(false)

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
    localStorage.removeItem(LS_STEP_KEY)
    window.location.href = '/dashboard/setup'
  }

  const canGoNext = step < 5 && (step !== 0 || oauthKeysOk) && (step !== 2 || status.customersOk === true)
  const canGoBack = step > 0

  return (
    <div className="min-h-screen bg-slate-900 text-white flex flex-col">
      <div className="w-full max-w-2xl mx-auto px-4 py-12 flex-1">
        {/* Header */}
        <div className="text-center mb-10 relative">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-indigo-600 mb-3">
            <span className="text-xl">🗂️</span>
          </div>
          <h1 className="text-3xl font-bold text-white">Daily Brief Dashboard</h1>
          <p className="text-slate-400 mt-1 text-sm">Setup wizard — 6 steps to get started</p>
          <div className="absolute top-0 right-0 flex flex-col items-end gap-1">
            <button
              onClick={() => doReset(true)}
              disabled={resetting}
              className="text-xs text-slate-500 hover:text-red-400 transition-colors disabled:opacity-50"
              title="Clear everything including OAuth keys — simulate brand new user"
            >
              {resetting ? 'Clearing…' : 'Full Reset (new user)'}
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

        <StepIndicator current={step} />

        {/* Card */}
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700 mb-6">
          {step === 0 && (
            <Step0OAuthKeys onReady={() => setOauthKeysOk(true)} />
          )}
          {step === 1 && (
            <Step2GoogleAuth />
          )}
          {step === 2 && (
            <Step1Sheets onImported={() => setStatus((s) => ({ ...s, customersOk: true }))} />
          )}
          {step === 3 && (
            <Step3DomainDetection onSaved={() => {}} />
          )}
          {step === 4 && (
            <Step5RedHat onConnected={() => setStep((s) => s + 1)} />
          )}
          {step === 5 && (
            <Step5Launch status={status} />
          )}
        </div>

        {/* Navigation */}
        {step < 5 && (
          <div className="flex items-center justify-between">
            <button
              onClick={() => setStep((s) => s - 1)}
              disabled={!canGoBack}
              className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-30 text-white px-4 py-2 rounded-lg font-medium text-sm transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              Back
            </button>

            <div className="flex items-center gap-3">
              {step === 1 && status.authTokens && (status.authTokens.valid === false || status.authTokens.expired) && (
                <span className="text-xs text-amber-400">
                  {status.authTokens.expired ? 'Token expired — re-authenticate' : 'Auth incomplete — connect Google first'}
                </span>
              )}
              {step === 0 && !oauthKeysOk && (
                <span className="text-xs text-amber-400">Upload OAuth keys to continue</span>
              )}
              {step === 2 && status.customersOk !== true && (
                <span className="text-xs text-amber-400">Import accounts to continue</span>
              )}
              {OPTIONAL_STEPS.has(step) && (
                <button
                  onClick={() => setStep((s) => s + 1)}
                  className="text-sm text-slate-400 hover:text-white underline transition-colors"
                >
                  Skip
                </button>
              )}
              {canGoNext && (
                <button
                  onClick={() => setStep((s) => s + 1)}
                  className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition-colors"
                >
                  Next
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
