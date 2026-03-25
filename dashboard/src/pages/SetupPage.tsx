import { useState, useEffect } from 'react'
import {
  CheckCircle,
  XCircle,
  Copy,
  Check,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
  Loader2,
  RefreshCw,
  Link,
  Table2,
  Plus,
  Zap,
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
  provider: string
  testResult: { ok: boolean; error?: string } | null
}

interface SheetFile {
  id: string
  name: string
  webViewLink: string
  modifiedTime: string
}

interface SheetStatus {
  connected: boolean
  fileId?: string
  fileName?: string
  syncedAt?: string
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

const STEP_LABELS = ['Accounts', 'Google Auth', 'Domains', 'AI Provider', 'Launch']

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

// ── Step 1: Sheets import ──────────────────────────────────────────────────────

const HEADER_TEMPLATE = 'name\tdomain\tae\tsegment\tregion\taccountNumbers'
const EXAMPLE_ROW = 'Acme Corp\tacme.com\tJane Smith\tEnterprise\tAmericas\t12345,67890'

type Step1Tab = 'browse' | 'paste' | 'create'

const CUSTOMER_FIELDS: Array<{
  key: string
  label: string
  required: boolean
  aliases: string[]
  hint?: string
}> = [
  { key: 'name', label: 'Name', required: true, aliases: ['name', 'account name', 'company', 'customer', 'account'] },
  { key: 'domain', label: 'Domain', required: false, aliases: ['domain', 'email domain', 'website', 'url'], hint: 'auto-matched by name if blank' },
  { key: 'ae', label: 'AE', required: false, aliases: ['ae', 'account executive', 'rep', 'owner', 'salesperson'] },
  { key: 'segment', label: 'Segment', required: false, aliases: ['segment', 'tier', 'type', 'size'] },
  { key: 'region', label: 'Region', required: false, aliases: ['region', 'territory', 'geo', 'area'] },
  { key: 'accountNumbers', label: 'Account Numbers', required: false, aliases: ['account number', 'account id', 'rh account', 'account #'] },
]

function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function fuzzyMatch(header: string, aliases: string[]): boolean {
  const h = header.toLowerCase().trim()
  return aliases.some((a) => h === a || h.includes(a) || a.includes(h))
}

type ColMapVal = number | string | null

function buildAutoColumnMap(headers: string[]): Record<string, ColMapVal> {
  const map: Record<string, ColMapVal> = {}
  for (const field of CUSTOMER_FIELDS) {
    const idx = headers.findIndex((h) => fuzzyMatch(h, field.aliases))
    map[field.key] = idx >= 0 ? idx : null
  }
  return map
}

function SheetUrlInput({
  value,
  onChange,
  onSubmit,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
}) {
  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && value.trim() && onSubmit()}
        placeholder="https://docs.google.com/spreadsheets/d/…"
        className="flex-1 bg-slate-700 border border-slate-600 text-white rounded-lg px-3 py-2 text-sm placeholder:text-slate-500"
      />
      <button
        onClick={onSubmit}
        disabled={!value.trim()}
        className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
      >
        Load
      </button>
    </div>
  )
}

function Step1Sheets({ onImported }: { onImported: () => void }) {
  const [tab, setTab] = useState<Step1Tab>('browse')
  const [sheetFiles, setSheetFiles] = useState<SheetFile[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [selectedFileId, setSelectedFileId] = useState('')
  const [selectedFileName, setSelectedFileName] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [headersLoading, setHeadersLoading] = useState(false)
  const [columnMap, setColumnMap] = useState<Record<string, ColMapVal>>({})
  const [pasteUrl, setPasteUrl] = useState('')
  const [importLoading, setImportLoading] = useState(false)
  const [importResult, setImportResult] = useState<{ imported: number; syncedAt: string } | null>(null)
  const [syncLoading, setSyncLoading] = useState(false)
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  const [sheetStatus, setSheetStatus] = useState<SheetStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [bootstrapUrl, setBootstrapUrl] = useState('')
  const [bootstrapAccounts, setBootstrapAccounts] = useState<{ name: string; ae: string }[] | null>(null)
  const [bootstrapSource, setBootstrapSource] = useState<'pipeline' | 'territory' | 'territory+pipeline' | 'manual' | null>(null)
  const [bootstrapLoading, setBootstrapLoading] = useState(false)
  const [bootstrapDone, setBootstrapDone] = useState(false)

  const [aeFolders, setAeFolders] = useState<{ folderId: string; folderName: string | null; connectedAt: string | null }[]>([])
  const [addFolderUrl, setAddFolderUrl] = useState('')
  const [addFolderLoading, setAddFolderLoading] = useState(false)
  const [addFolderError, setAddFolderError] = useState<string | null>(null)

  // On mount: check if already connected
  useEffect(() => {
    fetch('/api/sheets/status')
      .then((r) => r.json())
      .then((d: SheetStatus) => setSheetStatus(d))
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetch('/api/data-sources/status')
      .then(r => r.json())
      .then((d: { folders: { folderId: string; folderName: string | null; connectedAt: string | null }[] }) => setAeFolders(d.folders ?? []))
      .catch(() => {})
  }, [])

  // Fetch sheet list when browse tab is active (only if not already loaded)
  useEffect(() => {
    if (tab !== 'browse' || sheetFiles.length > 0) return
    setFilesLoading(true)
    fetch('/api/sheets/list')
      .then((r) => r.json())
      .then((d: { files: SheetFile[] }) => setSheetFiles(d.files ?? []))
      .catch(() => setError('Failed to load sheets'))
      .finally(() => setFilesLoading(false))
  }, [tab, sheetFiles.length])

  async function fetchHeaders(fileId: string, fileName: string) {
    setHeadersLoading(true)
    setError(null)
    setHeaders([])
    setColumnMap({})
    setSelectedFileId(fileId)
    setSelectedFileName(fileName)
    try {
      const r = await fetch(`/api/sheets/headers?fileId=${encodeURIComponent(fileId)}`)
      const d: { headers: string[]; fileName: string } = await r.json()
      setHeaders(d.headers)
      setColumnMap(buildAutoColumnMap(d.headers))
      if (d.fileName) setSelectedFileName(d.fileName)
    } catch {
      setError('Failed to load sheet headers')
    } finally {
      setHeadersLoading(false)
    }
  }

  function handlePasteSubmit() {
    const match = pasteUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)
    if (!match) {
      setError('Could not extract file ID from URL. Make sure it looks like: docs.google.com/spreadsheets/d/FILE_ID/edit')
      return
    }
    const fileId = match[1]
    fetchHeaders(fileId, '')
  }

  async function handleImport() {
    setImportLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/sheets/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: selectedFileId, fileName: selectedFileName, columnMap }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? 'Import failed')
      const d: { imported: number; syncedAt: string } = await r.json()
      setImportResult(d)
      setSyncedAt(d.syncedAt)
      onImported()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setImportLoading(false)
    }
  }

  async function handleSync() {
    setSyncLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/sheets/sync', { method: 'POST' })
      const d: { syncedAt: string } = await r.json()
      setSyncedAt(d.syncedAt)
    } catch {
      setError('Sync failed')
    } finally {
      setSyncLoading(false)
    }
  }

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
      setAddFolderError('Failed to connect — ensure Google Auth is complete (Step 2)')
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
    } catch {}
  }

  const nameVal = columnMap['name']
  const nameNotMapped = nameVal == null || (typeof nameVal === 'string' && !nameVal.trim())

  // Connected state: show summary + sync + change sheet
  if (sheetStatus?.connected) {
    return (
      <div className="space-y-5">
        {/* AE Data Folders */}
        <div className="space-y-3 pb-5 border-b border-slate-700">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-white">Sales Root Folder</h3>
              <p className="text-xs text-slate-400 mt-0.5">Connect your root sales folder — the dashboard searches all subfolders automatically at any depth.</p>
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
        </div>

        <div>
          <h2 className="text-2xl font-bold text-white mb-1">Add Your Accounts</h2>
          <p className="text-slate-400">Google Sheets is connected as your account source.</p>
        </div>
        <div className="bg-slate-800 rounded-xl p-5 border border-slate-700 space-y-3">
          <div className="flex items-center gap-2 text-slate-300">
            <Table2 className="w-4 h-4 text-emerald-400" />
            <span className="font-medium text-white">{sheetStatus.fileName}</span>
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleSync}
              disabled={syncLoading}
              className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
            >
              {syncLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Sync Now
            </button>
            <button
              onClick={() => setSheetStatus({ connected: false })}
              className="text-sm text-slate-400 hover:text-white underline transition-colors"
            >
              Change Sheet
            </button>
          </div>
          {(syncedAt ?? sheetStatus.syncedAt) && (
            <p className={`text-xs ${syncedAt ? 'text-emerald-400' : 'text-slate-400'}`}>
              Last synced: {timeAgo((syncedAt ?? sheetStatus.syncedAt)!)}
            </p>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      </div>
    )
  }

  function extractFileId(url: string): string {
    const m = url.match(/\/d\/([a-zA-Z0-9_-]{20,})/)
    return m ? m[1] : url.trim()
  }

  async function handleBootstrapPreview() {
    const manualFileId = extractFileId(bootstrapUrl)
    if (aeFolders.length === 0 && !manualFileId) {
      setError('Paste a Google Sheets or Drive URL first'); return
    }
    setBootstrapLoading(true)
    setError(null)
    try {
      const body = manualFileId ? { fileId: manualFileId } : {}
      const r = await fetch('/api/sheets/bootstrap-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d: { accounts?: { name: string; ae: string }[]; source?: 'pipeline' | 'territory' | 'territory+pipeline' | 'manual'; error?: string } = await r.json()
      if (d.error) setError(d.error)
      else if (!d.accounts?.length) setError('No accounts found. Check your folder connection or paste a pipeline URL.')
      else { setBootstrapAccounts(d.accounts); setBootstrapSource(d.source ?? null) }
    } catch {
      setError('Failed to read pipeline sheet')
    } finally {
      setBootstrapLoading(false)
    }
  }

  async function handleBootstrapImport() {
    setBootstrapLoading(true)
    setError(null)
    try {
      const manualFileId = extractFileId(bootstrapUrl)
      const body = manualFileId ? { fileId: manualFileId } : {}
      const r = await fetch('/api/sheets/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d: { imported?: number; error?: string } = await r.json()
      if (d.error) { setError(d.error); return }
      setBootstrapDone(true)
      setBootstrapAccounts(null)
      onImported()
    } catch {
      setError('Bootstrap failed')
    } finally {
      setBootstrapLoading(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* AE Data Folders */}
      <div className="space-y-3 pb-5 border-b border-slate-700">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">AE Data Folders</h3>
            <p className="text-xs text-slate-400 mt-0.5">Connect Google Drive folders to enable CCSP spend and subscription data in briefs.</p>
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
          <p className="text-xs font-medium text-slate-300">Recommended Google Drive folder structure</p>
          <pre className="text-xs text-slate-400 font-mono bg-slate-900 rounded-lg p-3 border border-slate-700 overflow-x-auto">{DRIVE_FOLDER_STRUCTURE}</pre>
          <p className="text-xs text-slate-500">One folder per account, named to match your customer list. The dashboard uses these to find account documents automatically.</p>
        </div>
        {/* Naming guidelines */}
        <div className="bg-slate-900/60 rounded-lg p-3 border border-slate-700/50 space-y-1.5">
          <p className="text-xs font-medium text-slate-300">Required naming conventions in your Territory Data spreadsheet:</p>
          <div className="space-y-1 text-xs text-slate-400">
            <div className="flex items-start gap-1.5"><div className="w-1 h-1 rounded-full bg-amber-400 mt-1.5 shrink-0" /><span>CCSP tab — name must contain <code className="bg-slate-700 px-1 rounded text-amber-300">CCSP</code> anywhere (e.g. "CCSP Raw Data", "Q1 CCSP")</span></div>
            <div className="flex items-start gap-1.5"><div className="w-1 h-1 rounded-full bg-amber-400 mt-1.5 shrink-0" /><span>Subscription tabs — tab name must contain the customer/account name (e.g. "Acme Corp", "Acme Corp Subs 2025")</span></div>
            <div className="flex items-start gap-1.5"><div className="w-1 h-1 rounded-full bg-amber-400 mt-1.5 shrink-0" /><span>Pipeline sheet — spreadsheet file name must contain <code className="bg-slate-700 px-1 rounded text-amber-300">pipeline</code> (case-insensitive)</span></div>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-2xl font-bold text-white mb-1">Add Your Accounts</h2>
        <p className="text-slate-400">Import your accounts from a Google Sheet, or bootstrap instantly from your pipeline data.</p>
      </div>

      {/* Bootstrap from pipeline */}
      {!bootstrapDone ? (
        <div className="bg-indigo-950/50 border border-indigo-700 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-indigo-400 shrink-0" />
            <span className="text-sm font-semibold text-white">Quick Start: Bootstrap from Pipeline</span>
            <span className="text-xs bg-indigo-700 text-indigo-200 px-2 py-0.5 rounded-full">Recommended</span>
          </div>
          <p className="text-sm text-slate-400">Paste your pipeline spreadsheet URL to pull account names and AE assignments directly.</p>
          {!bootstrapAccounts ? (
            <div className="space-y-2">
              {aeFolders.length > 0 ? (
                <p className="text-xs text-slate-400">
                  Pipeline sheets will be auto-discovered anywhere under your {aeFolders.length === 1 ? `"${aeFolders[0].folderName ?? 'connected'}"` : `${aeFolders.length} connected`} folder{aeFolders.length > 1 ? 's' : ''}.
                  {' '}If your pipeline file isn't named with "pipeline", paste its URL below to override.
                </p>
              ) : null}
              <input
                type="text"
                value={bootstrapUrl}
                onChange={(e) => setBootstrapUrl(e.target.value)}
                placeholder={aeFolders.length > 0 ? 'Optional: paste pipeline URL to override auto-discovery…' : 'https://docs.google.com/spreadsheets/d/...'}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={handleBootstrapPreview}
                disabled={bootstrapLoading || (aeFolders.length === 0 && !bootstrapUrl.trim())}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {bootstrapLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                Preview Accounts
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {bootstrapSource === 'territory' && (
                <p className="text-xs text-amber-400 flex items-center gap-1.5">
                  <span>⚠</span> No pipeline file found — accounts discovered from Supportable spreadsheet tabs. Add a pipeline file named with "pipeline" for richer data (ACV, close date, etc.).
                </p>
              )}
              {bootstrapSource === 'territory+pipeline' && (
                <p className="text-xs text-emerald-400 flex items-center gap-1.5">
                  <span>✓</span> Accounts from Supportable tabs + any additional accounts from pipeline.
                </p>
              )}
              <div className="bg-slate-900 rounded-lg p-3 max-h-40 overflow-y-auto space-y-1">
                {bootstrapAccounts.slice(0, 50).map((a) => (
                  <div key={a.name} className="flex items-center justify-between text-sm">
                    <span className="text-white">{a.name}</span>
                    <span className="text-slate-500 text-xs">{a.ae}</span>
                  </div>
                ))}
                {bootstrapAccounts.length > 50 && (
                  <p className="text-slate-500 text-xs pt-1">+ {bootstrapAccounts.length - 50} more</p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleBootstrapImport}
                  disabled={bootstrapLoading}
                  className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  {bootstrapLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                  Import {bootstrapAccounts.length} Accounts
                </button>
                <button onClick={() => setBootstrapAccounts(null)} className="text-sm text-slate-400 hover:text-white transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-emerald-950/50 border border-emerald-700 rounded-xl p-4 flex items-center gap-3">
          <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" />
          <div>
            <p className="text-sm font-medium text-white">
              {bootstrapSource === 'territory' && 'Accounts imported from Supportable spreadsheet tabs'}
              {bootstrapSource === 'territory+pipeline' && 'Accounts imported from Supportable tabs + pipeline'}
              {(bootstrapSource === 'pipeline' || bootstrapSource === 'manual') && 'Accounts imported from pipeline'}
              {!bootstrapSource && 'Accounts imported'}
            </p>
            <p className="text-xs text-slate-400">Connect a Google Sheet below to keep them in sync.</p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-900 rounded-lg p-1 w-fit">
        {([
          { id: 'browse' as Step1Tab, icon: <Table2 className="w-3.5 h-3.5" />, label: 'Browse My Sheets' },
          { id: 'paste' as Step1Tab, icon: <Link className="w-3.5 h-3.5" />, label: 'Paste Sheet URL' },
          { id: 'create' as Step1Tab, icon: <Plus className="w-3.5 h-3.5" />, label: 'Create New Sheet' },
        ] as const).map(({ id, icon, label }) => (
          <button
            key={id}
            onClick={() => { setTab(id); setError(null) }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === id ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      {/* Browse tab */}
      {tab === 'browse' && (
        <div className="bg-slate-800 rounded-xl p-5 border border-slate-700 space-y-3">
          {filesLoading ? (
            <div className="flex items-center gap-2 text-slate-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading your sheets…
            </div>
          ) : sheetFiles.length === 0 ? (
            <p className="text-slate-400 text-sm">No recent sheets found.</p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-300">Select a sheet:</p>
              <select
                className="w-full bg-slate-700 border border-slate-600 text-white rounded-lg px-3 py-2 text-sm"
                value={selectedFileId}
                onChange={(e) => {
                  const file = sheetFiles.find((f) => f.id === e.target.value)
                  if (file) fetchHeaders(file.id, file.name)
                }}
              >
                <option value="">— choose a sheet —</option>
                {sheetFiles.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} · {timeAgo(f.modifiedTime)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/* Paste URL tab */}
      {tab === 'paste' && (
        <div className="bg-slate-800 rounded-xl p-5 border border-slate-700 space-y-3">
          <p className="text-sm font-medium text-slate-300">Paste your Google Sheets URL</p>
          <SheetUrlInput value={pasteUrl} onChange={setPasteUrl} onSubmit={handlePasteSubmit} />
        </div>
      )}

      {/* Create New Sheet tab */}
      {tab === 'create' && (
        <div className="bg-slate-800 rounded-xl p-5 border border-slate-700 space-y-4">
          <a
            href="https://sheets.new"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 bg-emerald-700 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open Google Sheets
          </a>
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-slate-300">Copy this as row 1 (headers):</p>
            <CodeBlock code={HEADER_TEMPLATE.replace(/\t/g, '  ')} />
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-slate-300">Example row 2 (data):</p>
            <pre className="bg-slate-900 rounded-lg p-3 font-mono text-sm text-slate-500 border border-slate-700 overflow-x-auto">
              {EXAMPLE_ROW.replace(/\t/g, '  ')}
            </pre>
          </div>
          <div className="space-y-2 pt-1 border-t border-slate-700">
            <p className="text-sm font-medium text-slate-300">Paste your sheet URL here</p>
            <SheetUrlInput value={pasteUrl} onChange={setPasteUrl} onSubmit={handlePasteSubmit} />
          </div>
        </div>
      )}

      {/* Error */}
      {error && !headersLoading && (
        <p className="text-sm text-red-400">{error}</p>
      )}

      {/* Headers loading */}
      {headersLoading && (
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading columns…
        </div>
      )}

      {/* Column mapping */}
      {headers.length > 0 && !headersLoading && (
        <div className="bg-slate-800 rounded-xl p-5 border border-slate-700 space-y-4">
          <p className="text-sm font-medium text-slate-300">
            Map columns from <span className="text-white font-semibold">{selectedFileName}</span>
          </p>
          <div className="space-y-3">
            {CUSTOMER_FIELDS.map((field) => {
              const val = columnMap[field.key]
              const isCustom = typeof val === 'string'
              const isInvalid = field.required && !isCustom && val == null
              return (
                <div key={field.key} className="flex items-start gap-3">
                  <div className="w-36 shrink-0 pt-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-slate-200">{field.label}</span>
                      {field.required ? (
                        <span className="text-xs bg-red-900/50 text-red-300 px-1.5 py-0.5 rounded">required</span>
                      ) : (
                        <span className="text-xs bg-slate-700 text-slate-400 px-1.5 py-0.5 rounded">optional</span>
                      )}
                    </div>
                    {field.hint && (
                      <p className="text-xs text-slate-500 mt-0.5">{field.hint}</p>
                    )}
                  </div>
                  {isCustom ? (
                    <div className="flex-1 flex gap-2">
                      <input
                        type="text"
                        value={val}
                        onChange={(e) => setColumnMap((m) => ({ ...m, [field.key]: e.target.value }))}
                        placeholder={
                          field.key === 'domain' ? 'e.g. acme.com (applies to all rows)' :
                          field.key === 'ae' ? 'e.g. Jane Smith' :
                          field.key === 'segment' ? 'e.g. Enterprise' :
                          field.key === 'region' ? 'e.g. Americas West' :
                          `Custom ${field.label.toLowerCase()}…`
                        }
                        className="flex-1 bg-slate-700 border border-slate-600 text-white rounded-lg px-3 py-2 text-sm placeholder:text-slate-500"
                      />
                      <button
                        onClick={() => setColumnMap((m) => ({ ...m, [field.key]: null }))}
                        className="text-xs text-slate-400 hover:text-slate-200 px-2.5 py-1 bg-slate-700 border border-slate-600 rounded-lg whitespace-nowrap transition-colors"
                        title="Switch back to column mapping"
                      >
                        ← col
                      </button>
                    </div>
                  ) : (
                    <select
                      className={`flex-1 bg-slate-700 border rounded-lg px-3 py-2 text-sm text-white ${
                        isInvalid ? 'border-red-500' : 'border-slate-600'
                      }`}
                      value={val ?? ''}
                      onChange={(e) => {
                        const v = e.target.value
                        if (v === '__custom__') {
                          setColumnMap((m) => ({ ...m, [field.key]: '' }))
                        } else {
                          setColumnMap((m) => ({ ...m, [field.key]: v === '' ? null : Number(v) }))
                        }
                      }}
                    >
                      <option value="">(not mapped)</option>
                      {headers.map((h, i) => (
                        <option key={i} value={i}>{h}</option>
                      ))}
                      <option value="__custom__">✏ Enter custom value…</option>
                    </select>
                  )}
                </div>
              )
            })}
          </div>

          {importResult ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3 text-emerald-400 text-sm">
                <CheckCircle className="w-4 h-4 shrink-0" />
                Imported {importResult.imported} accounts from {selectedFileName}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleSync}
                  disabled={syncLoading}
                  className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                >
                  {syncLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  Sync Now
                </button>
                {syncedAt && (
                  <span className="text-xs text-slate-400">Last synced: {timeAgo(syncedAt)}</span>
                )}
              </div>
            </div>
          ) : (
            <button
              onClick={handleImport}
              disabled={nameNotMapped || importLoading}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              {importLoading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Importing…
                </>
              ) : (
                'Import Accounts'
              )}
            </button>
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

// ── Refresh Timer Settings ─────────────────────────────────────────────────────

interface RefreshIntervals {
  subscriptions: number
  ccsp: number
  pipeline: number
}

function RefreshTimerSettings() {
  const [intervals, setIntervals] = useState<RefreshIntervals | null>(null)
  const [draft, setDraft] = useState<RefreshIntervals | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/settings/refresh')
      .then(r => r.json())
      .then((d: { intervals: RefreshIntervals }) => {
        setIntervals(d.intervals)
        setDraft(d.intervals)
      })
      .catch(() => {})
  }, [])

  if (!draft) return null

  const handleSave = async () => {
    setSaving(true); setError(null)
    try {
      const res = await fetch('/api/settings/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Save failed'); return }
      setIntervals(data.intervals)
      setDraft(data.intervals)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(intervals)

  const fields: Array<{ key: keyof RefreshIntervals; label: string; hint: string }> = [
    { key: 'subscriptions', label: 'Subscriptions', hint: 'How often to sync product data from Supportable sheets' },
    { key: 'ccsp',          label: 'CCSP Spend',    hint: 'How often to refresh cloud spend data' },
    { key: 'pipeline',      label: 'Pipeline',      hint: 'How often to pull pipeline records' },
  ]

  return (
    <div className="bg-slate-800 rounded-xl p-5 border border-slate-700 space-y-4">
      <p className="text-sm font-medium text-slate-300">Auto-Refresh Intervals</p>
      <div className="space-y-3">
        {fields.map(({ key, label, hint }) => (
          <div key={key} className="flex items-center gap-3">
            <div className="flex-1">
              <p className="text-sm text-slate-200">{label}</p>
              <p className="text-xs text-slate-500">{hint}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="number"
                min={1}
                value={draft[key]}
                onChange={e => setDraft(prev => prev ? { ...prev, [key]: Number(e.target.value) } : prev)}
                className="w-20 bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <span className="text-xs text-slate-500 w-8">min</span>
            </div>
          </div>
        ))}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        onClick={handleSave}
        disabled={!dirty || saving}
        className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
      >
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <Check className="w-3.5 h-3.5" /> : <RefreshCw className="w-3.5 h-3.5" />}
        {saved ? 'Saved' : 'Save Intervals'}
      </button>
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
  const [results, setResults] = useState<InferredDomain[]>([])
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/setup/infer-domains', { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        const res: InferredDomain[] = d.results ?? []
        setResults(res)
        // Pre-fill edits with top candidate or existing domain
        const initial: Record<string, string> = {}
        for (const r of res) {
          initial[r.customerName] = r.currentDomain || r.candidates[0]?.domain || ''
        }
        setEdits(initial)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const domains = Object.entries(edits).map(([name, domain]) => ({ name, domain }))
      const r = await fetch('/api/setup/save-domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domains }),
      })
      const d = await r.json()
      if (!d.ok) throw new Error(d.error ?? 'Save failed')
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
          Scanning your Gmail and Calendar for signals to infer each customer's email domain.
          Review and edit before saving — domains improve email and meeting matching.
        </p>
      </div>

      {loading && (
        <div className="flex items-center gap-3 py-8 justify-center text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Scanning Gmail, Calendar, and web…</span>
        </div>
      )}

      {error && (
        <div className="bg-red-900/20 border border-red-700/40 rounded-xl p-4 text-red-300 text-sm">
          {error.includes('No customers') || error.includes('not configured')
            ? 'No accounts found — complete Step 1 (Sheets import) first.'
            : error.includes('Token') || error.includes('token') || error.includes('auth') || error.includes('OAuth')
            ? 'Google Auth error — complete Step 2 first, then return here.'
            : `Network error scanning for domains: ${error}`}
        </div>
      )}

      {!loading && results.length > 0 && (
        <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
          {results.map((r) => (
            <div key={r.customerName} className="bg-slate-700/50 rounded-lg px-4 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-200 truncate">{r.customerName}</p>
                {r.candidates.length > 0 && (
                  <p className="text-xs text-slate-500 mt-0.5">
                    {r.candidates[0].count} signal{r.candidates[0].count !== 1 ? 's' : ''} from {r.candidates[0].sources.join(' + ')}
                    {r.candidates.length > 1 && ` · also: ${r.candidates.slice(1, 3).map(c => c.domain).join(', ')}`}
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
      )}

      {!loading && !error && (
        <div className="flex items-center gap-3 pt-2">
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
              {saving ? 'Saving…' : 'Confirm & Save Domains'}
            </button>
          )}
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
    {
      label: 'AI provider tested',
      ok: status.testResult?.ok ?? null,
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

// ── Main wizard ────────────────────────────────────────────────────────────────

const OPTIONAL_STEPS = new Set([2, 3])

const LS_STEP_KEY = 'pai-setup-step'

export function SetupPage() {
  const [step, setStepRaw] = useState(() => {
    // URL param takes priority (e.g. OAuth redirect back), then localStorage, then 0
    const urlStep = parseInt(new URLSearchParams(window.location.search).get('step') ?? '', 10)
    if (!isNaN(urlStep)) return Math.min(Math.max(urlStep, 0), 4)
    const saved = parseInt(localStorage.getItem(LS_STEP_KEY) ?? '', 10)
    return isNaN(saved) ? 0 : Math.min(Math.max(saved, 0), 4)
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
    provider: 'pai',
    testResult: null,
  })

  // Check auth tokens
  const checkAuth = () => {
    fetch('/api/setup/check-auth')
      .then((r) => r.json())
      .then((d) => setStatus((s) => ({ ...s, authTokens: d.tokens ?? d })))
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

  // Re-check auth when entering step 1 (0-indexed)
  useEffect(() => {
    if (step === 1) checkAuth()
  }, [step])

  const handleTest = async (_provider: string) => {
    try {
      const r = await fetch('/api/config/test')
      const d = await r.json()
      setStatus((s) => ({ ...s, testResult: d }))
    } catch {
      setStatus((s) => ({ ...s, testResult: { ok: false, error: 'Could not reach server' } }))
    }
  }

  const [resetting, setResetting] = useState(false)

  const handleReset = async () => {
    if (!confirm('Clear all cached data, customers, and auth tokens? This resets to a clean slate.')) return
    setResetting(true)
    try {
      await fetch('/api/setup/reset', { method: 'POST' })
    } catch {}
    setResetting(false)
    localStorage.removeItem(LS_STEP_KEY)
    window.location.href = '/dashboard/setup'
  }

  const canGoNext = step < 4 && (step !== 0 || status.customersOk === true)
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
          <p className="text-slate-400 mt-1 text-sm">Setup wizard — 5 steps to get started</p>
          <button
            onClick={handleReset}
            disabled={resetting}
            className="absolute top-0 right-0 text-xs text-slate-500 hover:text-red-400 transition-colors disabled:opacity-50"
            title="Clear all data and start over"
          >
            {resetting ? 'Clearing…' : 'Reset & Start Over'}
          </button>
        </div>

        <StepIndicator current={step} />

        {/* Card */}
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700 mb-6">
          {step === 0 && (
            <Step1Sheets onImported={() => setStatus((s) => ({ ...s, customersOk: true }))} />
          )}
          {step === 1 && (
            <Step2GoogleAuth />
          )}
          {step === 2 && (
            <Step3DomainDetection onSaved={() => {}} />
          )}
          {step === 3 && (
            <Step3AIProvider status={status.testResult} onTest={handleTest} />
          )}
          {step === 4 && (
            <Step5Launch status={status} />
          )}
        </div>

        {/* Navigation */}
        {step < 4 && (
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
              {step === 1 && status.authTokens && !status.authTokens.allConfigured && (
                <span className="text-xs text-amber-400">Auth incomplete — connect Google first</span>
              )}
              {step === 0 && status.customersOk !== true && (
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
