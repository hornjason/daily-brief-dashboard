import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatRelTime } from '../lib/format'
import CopyButton from '../components/CopyButton'
import { useApi } from '../hooks/useApi'
import { HeroStep3Connections } from '../components/HeroStep3Connections'
import { AEsCustomersSection } from './setup/AEsCustomersSection'
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

// ── Red Hat Portal ─────────────────────────────────────────────────────────────


// ── Main Setup Page ────────────────────────────────────────────────────────────

type SectionId = 'oauth-keys' | 'google-auth' | 'aes' | 'rh-portal' | 'data-sources' | 'settings' | 'ai-settings' | 'automation-settings' | 'data-freshness'

export default function SetupPage() {
  const [openSection, setOpenSection] = useState<SectionId | null>(null)
  const userToggledRef = useRef(false) // tracks whether user has interacted with accordion
  const [oauthKeysOk, setOauthKeysOk] = useState(false)
  const [googleAuthOk, setGoogleAuthOk] = useState<boolean | null>(null) // null = still checking
  const [aeCount, setAeCount] = useState<number | null>(null)
  const [rhTokenConfigured, setRhTokenConfigured] = useState<boolean | null>(null)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [sfSyncing, setSfSyncing] = useState(false)
  const [sfSyncSuccess, setSfSyncSuccess] = useState<string | null>(null)
  const [sfSyncError, setSfSyncError] = useState<string | null>(null)
  const sfSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pipelineRefreshing, setPipelineRefreshing] = useState(false)
  const [pipelineRefreshSuccess, setPipelineRefreshSuccess] = useState<string | null>(null)
  const [pipelineRefreshError, setPipelineRefreshError] = useState<string | null>(null)
  const pipelineRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [ccspRefreshing, setCcspRefreshing] = useState(false)
  const [ccspRefreshSuccess, setCcspRefreshSuccess] = useState<string | null>(null)
  const [ccspRefreshError, setCcspRefreshError] = useState<string | null>(null)
  const ccspRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [resetConfirm, setResetConfirm] = useState<'full' | 'data' | null>(null)
  // BKL-HERO-01 Phase 2 — gate Step 3 Connections accordion behind !isL3Only.
  const nodeRoleApi = useApi<{ isL3Only: boolean }>('/api/node-role')
  const isL3Only = nodeRoleApi.data?.isL3Only ?? true


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
      .then(() => { /* no-op — RH state removed (BKL-DEAD-CODE-RHSECTION-01) */ })
      .catch((e) => { if (e.name !== 'AbortError') { /* ignore */ } })

    // Check RH offline token configured (for Step 3 accordion badge)
    fetch('/api/settings/offline-token', { signal })
      .then(r => r.json())
      .then((d: { configured: boolean }) => setRhTokenConfigured(d.configured))
      .catch((e) => { if (e.name !== 'AbortError') setRhTokenConfigured(false) })

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

  const handleSfSync = async () => {
    setSfSyncing(true)
    setSfSyncSuccess(null)
    setSfSyncError(null)
    try {
      const r = await fetch('/api/scrape/sf-bookings-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (r.ok) {
        const d = await r.json().catch(() => ({})) as { customersMatched?: number; customersTotal?: number }
        const recordCount = d.customersMatched ?? d.customersTotal ?? 0
        setSfSyncSuccess(`✓ Sync complete — ${recordCount} rows`)
        if (sfSyncTimerRef.current) clearTimeout(sfSyncTimerRef.current)
        sfSyncTimerRef.current = setTimeout(() => setSfSyncSuccess(null), 8_000)
      } else {
        const err = await r.json().catch(() => ({})) as { error?: string }
        setSfSyncError(err.error ?? `Sync failed (${r.status})`)
      }
    } catch { setSfSyncError('Sync failed — network error') }
    finally { setSfSyncing(false) }
  }

  const handlePipelineRefresh = async () => {
    setPipelineRefreshing(true)
    setPipelineRefreshSuccess(null)
    setPipelineRefreshError(null)
    try {
      const r = await fetch('/api/refresh/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (r.ok) {
        const d = await r.json().catch(() => ({})) as { recordCount?: number }
        const count = d.recordCount ?? 0
        setPipelineRefreshSuccess(`✓ Refresh complete — ${count} rows`)
        if (pipelineRefreshTimerRef.current) clearTimeout(pipelineRefreshTimerRef.current)
        pipelineRefreshTimerRef.current = setTimeout(() => setPipelineRefreshSuccess(null), 8_000)
      } else {
        const err = await r.json().catch(() => ({})) as { error?: string }
        setPipelineRefreshError(err.error ?? `Refresh failed (${r.status})`)
      }
    } catch { setPipelineRefreshError('Refresh failed — network error') }
    finally { setPipelineRefreshing(false) }
  }

  const handleCcspRefresh = async () => {
    setCcspRefreshing(true)
    setCcspRefreshSuccess(null)
    setCcspRefreshError(null)
    try {
      const r = await fetch('/api/refresh/ccsp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (r.ok) {
        const d = await r.json().catch(() => ({})) as { recordCount?: number }
        const count = d.recordCount ?? 0
        setCcspRefreshSuccess(`✓ Refresh complete — ${count} rows`)
        if (ccspRefreshTimerRef.current) clearTimeout(ccspRefreshTimerRef.current)
        ccspRefreshTimerRef.current = setTimeout(() => setCcspRefreshSuccess(null), 8_000)
      } else {
        const err = await r.json().catch(() => ({})) as { error?: string }
        setCcspRefreshError(err.error ?? `Refresh failed (${r.status})`)
      }
    } catch { setCcspRefreshError('Refresh failed — network error') }
    finally { setCcspRefreshing(false) }
  }

  useEffect(() => {
    return () => {
      if (sfSyncTimerRef.current) clearTimeout(sfSyncTimerRef.current)
      if (pipelineRefreshTimerRef.current) clearTimeout(pipelineRefreshTimerRef.current)
      if (ccspRefreshTimerRef.current) clearTimeout(ccspRefreshTimerRef.current)
    }
  }, [])

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
          {/* BKL-093: OAuth Keys step removed — auto-provisioned from bundled defaults
              Step0OAuthKeys component preserved below for future re-use if needed */}
          {false && (
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
          )}

          <AccordionSection
            id="google-auth"
            title="Step 1 of 4 — Google Auth"
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

          {isL3Only ? (
            <HeroStep3Connections />
          ) : (
          <AccordionSection
            id="rh-portal"
            title="Step 2 of 4 — Connections"
            badge={
              rhTokenConfigured === null
                ? <StatusBadge ok={null} label="Checking..." />
                : rhTokenConfigured
                  ? <StatusBadge ok={true} label="Configured" />
                  : <StatusBadge ok={false} label="Not configured" />
            }
            isOpen={openSection === 'rh-portal'}
            onToggle={() => toggleSection('rh-portal')}
          >
            <HeroStep3Connections />
            {/* SF Pipeline Sync */}
            <div className="mt-4 pt-4 border-t border-gray-700 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-200">SF Pipeline Sync</p>
                <p className="text-xs text-gray-500 mt-0.5">Sync Salesforce bookings to AE subscription sheets</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <button
                  onClick={handleSfSync}
                  disabled={sfSyncing}
                  data-testid="sf-sync-btn"
                  className="px-3 py-1.5 text-xs font-medium rounded bg-gray-600 hover:bg-gray-500 disabled:opacity-40 text-white transition-colors"
                >
                  {sfSyncing ? 'Syncing...' : 'Sync Now'}
                </button>
                {sfSyncSuccess && (
                  <span data-testid="sf-sync-success" className="text-xs text-green-400">{sfSyncSuccess}</span>
                )}
                {sfSyncError && (
                  <span data-testid="sf-sync-error" role="alert" className="text-xs text-red-400">{sfSyncError}</span>
                )}
              </div>
            </div>
            {/* Pipeline Data Refresh */}
            <div className="mt-4 pt-4 border-t border-gray-700 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-200">Pipeline Data</p>
                <p className="text-xs text-gray-500 mt-0.5">Refresh pipeline opportunities from Drive</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <button
                  onClick={handlePipelineRefresh}
                  disabled={pipelineRefreshing}
                  data-testid="pipeline-refresh-btn"
                  className="px-3 py-1.5 text-xs font-medium rounded bg-gray-600 hover:bg-gray-500 disabled:opacity-40 text-white transition-colors"
                >
                  {pipelineRefreshing ? 'Refreshing...' : 'Refresh Now'}
                </button>
                {pipelineRefreshSuccess && (
                  <span data-testid="pipeline-refresh-success" className="text-xs text-green-400">{pipelineRefreshSuccess}</span>
                )}
                {pipelineRefreshError && (
                  <span data-testid="pipeline-refresh-error" role="alert" className="text-xs text-red-400">{pipelineRefreshError}</span>
                )}
              </div>
            </div>
            {/* CCSP Cloud Spend Refresh */}
            <div className="mt-4 pt-4 border-t border-gray-700 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-200">CCSP Cloud Spend</p>
                <p className="text-xs text-gray-500 mt-0.5">Refresh cloud marketplace revenue from Drive</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <button
                  onClick={handleCcspRefresh}
                  disabled={ccspRefreshing}
                  data-testid="ccsp-refresh-btn"
                  className="px-3 py-1.5 text-xs font-medium rounded bg-gray-600 hover:bg-gray-500 disabled:opacity-40 text-white transition-colors"
                >
                  {ccspRefreshing ? 'Refreshing...' : 'Refresh Now'}
                </button>
                {ccspRefreshSuccess && (
                  <span data-testid="ccsp-refresh-success" className="text-xs text-green-400">{ccspRefreshSuccess}</span>
                )}
                {ccspRefreshError && (
                  <span data-testid="ccsp-refresh-error" role="alert" className="text-xs text-red-400">{ccspRefreshError}</span>
                )}
              </div>
            </div>
          </AccordionSection>
          )}

          <AccordionSection
            id="aes"
            title="Step 3 of 4 — AEs & Customers"
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

          {aeCount !== null && aeCount > 0 && (
            <div data-testid="hero-open-dashboard" className="mt-2">
              <a
                href="/dashboard"
                className="block w-full text-center bg-accent hover:bg-accent/80 text-white px-6 py-3 rounded-xl font-semibold text-base transition-colors"
              >
                Open Dashboard
              </a>
            </div>
          )}
        </div>

        {/* Quick links */}
        <div className="mt-8 text-center space-y-2">
          <a
            href="/dashboard"
            className="block text-sm text-text-secondary hover:text-white transition-colors underline"
          >
            Go to Dashboard
          </a>
          <a
            href="/dashboard/admin"
            className="block text-sm text-text-secondary hover:text-white transition-colors underline"
          >
            System Health → Admin Page
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
