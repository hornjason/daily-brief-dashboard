import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  RefreshCw,
  Shield,
  Calendar,
  Mail,
  FileText,
  Package,
  Key,
  ExternalLink,
  Video,
  AlertTriangle,
  CheckCircle,
  Clock,
  Users,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Cloud,
  TrendingUp,
  Settings,
  Copy,
  Check,
  Zap,
  X,
} from 'lucide-react'
import { BarChart, Bar, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import { useCustomerSSE } from '../hooks/useCustomerSSE'
import { formatDate, formatTime, formatRelTime, fmtCurrency as fmtAcv } from '../lib/format'
import { OppDetail } from '../components/PipelineSection'
import type { PipelineOpp } from '../types'

// ── Config / provider setup ───────────────────────────────────────────────────

interface ProviderInfo { vars: string[]; snippet: string; description: string }
interface DashboardConfig {
  briefProvider: string
  briefConfigured: boolean
  providers: Record<string, ProviderInfo>
}

let _configCache: DashboardConfig | null = null

function useDashboardConfig() {
  const [config, setConfig] = useState<DashboardConfig | null>(_configCache)
  useEffect(() => {
    if (_configCache) return
    fetch('/api/config').then(r => r.json()).then(d => { _configCache = d; setConfig(d) }).catch(() => {})
  }, [])
  return config
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className="shrink-0 p-1 rounded hover:bg-border/40 transition-colors text-text-secondary hover:text-text-primary"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
    </button>
  )
}

function BriefSetupCard({ config, onTestDone }: { config: DashboardConfig; onTestDone: () => void }) {
  const [selected, setSelected] = useState('pai')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; preview?: string } | null>(null)

  const provider = config.providers[selected]

  async function runTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await fetch('/api/config/test')
      const j = await r.json()
      setTestResult(j)
      if (j.ok) { _configCache = null; setTimeout(onTestDone, 1500) }
    } catch {
      setTestResult({ ok: false, error: 'Could not reach server' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-border/60 flex items-center gap-2">
        <Settings className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">AI Brief Setup Required</h2>
      </div>
      <div className="px-5 py-4 space-y-4">
        <p className="text-xs text-text-secondary leading-relaxed">
          No AI provider is configured. Pick one below and add the variables to your <code className="bg-border/40 px-1 rounded">.env</code> file, then restart the server.
        </p>

        {/* Provider tabs */}
        <div className="flex gap-1 flex-wrap">
          {Object.entries(config.providers).map(([key, p]) => (
            <button
              key={key}
              onClick={() => setSelected(key)}
              className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                selected === key
                  ? 'bg-accent/10 border-accent/30 text-accent'
                  : 'border-border text-text-secondary hover:text-text-primary hover:border-text-secondary'
              }`}
            >
              {key === 'pai' ? 'PAI' : key === 'openai' ? 'OpenAI' : key === 'anthropic' ? 'Anthropic' : 'Ollama'}
            </button>
          ))}
        </div>

        {provider && (
          <div className="space-y-2">
            <p className="text-xs text-text-secondary">{provider.description}</p>
            <div className="bg-bg rounded-lg border border-border/60 overflow-hidden">
              <div className="flex items-start justify-between gap-2 px-3 py-2.5">
                <pre className="text-xs text-success font-mono whitespace-pre leading-relaxed flex-1">{provider.snippet}</pre>
                <CopyButton text={provider.snippet} />
              </div>
            </div>
            {selected === 'ollama' && (
              <p className="text-xs text-text-secondary">
                Install Ollama: <code className="bg-border/40 px-1 rounded">brew install ollama && ollama pull llama3</code>
              </p>
            )}
          </div>
        )}

        {/* Test button */}
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={runTest}
            disabled={testing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/10 border border-accent/30 text-accent text-xs hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            <Zap className={`w-3.5 h-3.5 ${testing ? 'animate-pulse' : ''}`} />
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
          {testResult && (
            <span className={`text-xs ${testResult.ok ? 'text-success' : 'text-critical'}`}>
              {testResult.ok ? `✓ Connected — ${testResult.preview?.slice(0, 60)}…` : `✗ ${testResult.error}`}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Brief fetch ───────────────────────────────────────────────────────────────

interface BriefData {
  text: string
  cachedAt: string
  fromCache: boolean
}

function useBrief(name: string) {
  const [data, setData] = useState<BriefData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  async function fetch_(force = false) {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/customer/${encodeURIComponent(name)}/brief${force ? '?force=true' : ''}`,
        { signal: controller.signal }
      )
      if (res.status === 404) throw new Error('NOT_FOUND')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      setData(json)
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    fetch_()
    return () => abortRef.current?.abort()
  }, [name])

  return { data, loading, error, refresh: () => fetch_(true) }
}

// ── Account info (products + licenses from sheet cache) ──────────────────────

interface SheetProduct {
  sku: string
  productDescription: string
  quantity: number
  status: string
  startDate?: string
  endDate?: string
}

interface AccountInfo {
  productCount: number
  totalLicenses: number
  products: SheetProduct[]
}

function useAccountInfo(customerName: string): AccountInfo | null {
  const [info, setInfo] = useState<AccountInfo | null>(null)
  useEffect(() => {
    const encoded = encodeURIComponent(customerName)
    fetch('/api/accounts')
      .then((r) => r.json())
      .then((json) => {
        const acct = (json.customers ?? []).find(
          (c: any) => c.name.toLowerCase() === customerName.toLowerCase()
        )
        if (acct && (acct.products ?? []).length > 0) {
          setInfo({ productCount: acct.productCount, totalLicenses: acct.totalLicenses, products: acct.products })
        } else {
          // Cache empty — fetch from sheet then re-read accounts
          fetch(`/customer/${encoded}/sheetdata`)
            .then((r) => r.json())
            .then((sd) => {
              const products = sd.rows ?? []
              setInfo({
                productCount: new Set(products.map((p: any) => p.productDescription)).size,
                totalLicenses: products.reduce((s: number, p: any) => s + p.quantity, 0),
                products,
              })
            })
            .catch(() => {})
        }
      })
      .catch(() => {})
  }, [customerName])
  return info
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getHealth(cases: { severity: string }[]) {
  if (cases.some((c) => c.severity === '1')) return { color: '#F85149', label: 'Critical' }
  if (cases.length > 0) return { color: '#D29922', label: 'Attention' }
  return { color: '#3FB950', label: 'Healthy' }
}

function expiryColor(daysLeft: number): string {
  if (daysLeft < 30) return 'text-critical'
  if (daysLeft < 90) return 'text-warning'
  return 'text-success'
}

function mimeLabel(mimeType: string): string {
  const m: Record<string, string> = {
    'application/vnd.google-apps.document': 'Doc',
    'application/vnd.google-apps.spreadsheet': 'Sheet',
    'application/vnd.google-apps.presentation': 'Slides',
    'application/pdf': 'PDF',
  }
  return m[mimeType] ?? 'File'
}

function nextMeetingLabel(meetings: any[]): string {
  const next = meetings[0]
  if (!next) return ''
  const diff = new Date(next.start).getTime() - Date.now()
  const hours = Math.floor(diff / 3_600_000)
  if (hours <= 0) return 'Starting now'
  if (hours < 1) return 'In < 1h'
  if (hours < 24) return `In ${hours}h`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Tomorrow'
  return `In ${days}d`
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`bg-border/40 rounded animate-pulse-slow ${className}`} />
}

// ── Brief section ─────────────────────────────────────────────────────────────

function BriefSection({ name }: { name: string }) {
  const { data, loading, error, refresh } = useBrief(name)
  const [expanded, setExpanded] = useState(false)
  const config = useDashboardConfig()
  const [configDismissed, setConfigDismissed] = useState(false)

  // Show setup card if provider not configured and brief hasn't loaded
  if (config && !config.briefConfigured && !data && !configDismissed) {
    return <BriefSetupCard config={config} onTestDone={() => { setConfigDismissed(true); refresh() }} />
  }

  const sections = useMemo(() => {
    if (!data?.text) return {} as Record<string, string>
    const result: Record<string, string> = {}
    let current = ''
    for (const line of data.text.split('\n')) {
      const h = line.match(/^##\s+(.+)$/)
      if (h) { current = h[1].trim(); result[current] = '' }
      else if (current && line !== '---') result[current] += line + '\n'
    }
    return result
  }, [data?.text])

  const overview = Object.entries(sections).find(([k]) => k.startsWith('Account Overview'))?.[1]?.trim() ?? ''
  // Sections rendered in order when expanded (skip Account Overview and Products & Subscriptions — shown in side tile)
  const expandedSections = Object.entries(sections).filter(([k]) =>
    !k.startsWith('Account Overview') && !k.startsWith('Products')
  )

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between border-b border-border/60">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">Account Brief</h2>
          {data?.fromCache && (
            <span className="text-xs text-text-secondary bg-border/40 px-2 py-0.5 rounded-full">
              {data.cachedAt ? formatRelTime(data.cachedAt) : 'cached'}
            </span>
          )}
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border text-xs text-text-secondary hover:text-text-primary hover:border-text-secondary transition-all disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Regenerate
        </button>
      </div>

      <div className="px-5 py-4">
        {loading && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/6" />
          </div>
        )}

        {error && !loading && error === 'NOT_FOUND' && (
          <div className="text-center py-6 space-y-3">
            <p className="text-base font-semibold text-text-primary">Customer not found</p>
            <p className="text-sm text-text-secondary">No data found for "{name}". This customer may not exist or hasn't been configured yet.</p>
            <a
              href="/dashboard"
              className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to Dashboard
            </a>
          </div>
        )}

        {error && !loading && error !== 'NOT_FOUND' && (
          <p className="text-sm text-critical italic">{error}</p>
        )}

        {!loading && !error && data && (
          <div className="space-y-4">
            {overview && (
              <p className={`text-sm text-text-primary leading-relaxed ${!expanded ? 'line-clamp-3' : ''}`}>
                {overview}
              </p>
            )}

            {expanded && expandedSections.map(([title, content]) => {
              const isCases    = title.startsWith('Open Support Cases')
              const isPipeline = title.startsWith('Pipeline Opportunities')
              const isTech     = title.startsWith('Technology Landscape')
              const lines = content.split('\n').filter((l) => l.trim())

              return (
                <div key={title}>
                  <p className={`text-xs font-semibold uppercase tracking-wide mb-2 ${isPipeline ? 'text-accent' : 'text-text-secondary'}`}>
                    {title}
                  </p>

                  {isCases && content.includes('✅') ? (
                    <p className="text-sm text-text-secondary italic">✅ No open support cases.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {lines.map((line, i) => {
                        const isSub    = line.match(/^###\s+(.+)$/)
                        const isBullet = /^[-*✓]|\d+\./.test(line.trim())

                        if (isSub) {
                          return <li key={i} className="text-sm font-semibold text-text-primary pt-1">{isSub[1]}</li>
                        }

                        if (isBullet) {
                          // Pipeline: bold signal → product: pitch  (format: **signal** → product: pitch)
                          const pipelineMatch = isPipeline && line.match(/\*\*(.+?)\*\*\s*→\s*(.+)/)
                          if (pipelineMatch) {
                            return (
                              <li key={i} className="text-sm">
                                <span className="font-semibold text-accent">{pipelineMatch[1]}</span>
                                <span className="text-text-primary"> → {pipelineMatch[2]}</span>
                              </li>
                            )
                          }

                          // Tech landscape: ✓ Category: value
                          const techMatch = isTech && line.match(/^[✓-]\s*(.+)$/)
                          if (techMatch) {
                            return (
                              <li key={i} className="flex gap-2 text-sm text-text-primary">
                                <span className="text-green-500 mt-0.5 shrink-0">✓</span>
                                <span>{techMatch[1].replace(/^\*{0,2}/, '').replace(/\*{0,2}$/, '').trim()}</span>
                              </li>
                            )
                          }

                          // Standard bullet
                          return (
                            <li key={i} className="flex gap-2 text-sm text-text-primary">
                              <span className="text-accent mt-0.5 shrink-0">·</span>
                              <span>{line.replace(/^[-*✓\d.]+\s*\*{0,2}/, '').replace(/\*{0,2}$/, '').trim()}</span>
                            </li>
                          )
                        }

                        return <li key={i} className="text-sm text-text-primary">{line}</li>
                      })}
                    </ul>
                  )}
                </div>
              )
            })}

            <button
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-accent hover:opacity-80 transition-opacity"
            >
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              {expanded ? 'Collapse brief' : 'Expand full brief'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Activity Timeline ─────────────────────────────────────────────────────────

type TLItemType = 'meeting' | 'email' | 'doc'

interface TLItem {
  id: string
  type: TLItemType
  timestamp: string
  title: string
  subtitle: string
  isFuture: boolean
  joinUrl?: string
  viewUrl?: string
  actionRequired?: boolean
}

const TL_STYLES: Record<TLItemType, { bar: string; icon: typeof Calendar; label: string }> = {
  meeting: { bar: 'bg-tl-meeting', icon: Calendar,  label: 'Meeting' },
  email:   { bar: 'bg-tl-email',   icon: Mail,      label: 'Email'   },
  doc:     { bar: 'bg-tl-doc',     icon: FileText,  label: 'Doc'     },
}

function ActivityTimeline({
  meetings,
  emails,
  drive,
  loading,
}: {
  meetings: any[]
  emails: any[]
  drive: any[]
  loading: boolean
}) {
  const [showAll, setShowAll] = useState(false)

  const items = useMemo((): TLItem[] => {
    const now = Date.now()
    const all: TLItem[] = []

    for (const ev of meetings) {
      all.push({
        id: `m-${ev.start}-${ev.title}`,
        type: 'meeting',
        timestamp: ev.start,
        title: ev.title,
        subtitle: ev.attendees?.length
          ? `${ev.attendees.length} external attendee${ev.attendees.length !== 1 ? 's' : ''}`
          : '',
        isFuture: new Date(ev.start).getTime() > now,
        joinUrl: ev.joinUrl,
      })
    }

    for (const em of emails) {
      all.push({
        id: `e-${em.date}-${em.subject}`,
        type: 'email',
        timestamp: em.date,
        title: em.subject || '(no subject)',
        subtitle: em.from,
        isFuture: false,
        actionRequired: em.actionRequired,
      })
    }

    for (const f of drive) {
      if (!f.modifiedTime) continue
      all.push({
        id: `d-${f.modifiedTime}-${f.name}`,
        type: 'doc',
        timestamp: f.modifiedTime,
        title: f.name,
        subtitle: mimeLabel(f.mimeType),
        isFuture: false,
        viewUrl: f.webViewLink,
      })
    }

    return all.sort((a, b) => {
      // Future meetings first (soonest first), then past items (newest first)
      if (a.isFuture && !b.isFuture) return -1
      if (!a.isFuture && b.isFuture) return 1
      if (a.isFuture && b.isFuture) return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    })
  }, [meetings, emails, drive])

  const visible = showAll ? items : items.slice(0, 10)

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-border/60 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">Activity</h2>
          {!loading && (
            <span className="text-xs text-text-secondary">{items.length} items</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-text-secondary">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-tl-meeting inline-block" />Meetings</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-tl-email inline-block" />Emails</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-tl-doc inline-block" />Docs</span>
        </div>
      </div>

      <div className="divide-y divide-border/40">
        {loading && (
          <div className="px-5 py-4 space-y-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="w-1 h-12 rounded-full shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && items.length === 0 && (
          <p className="px-5 py-6 text-sm text-text-secondary italic">No recent activity found</p>
        )}

        {!loading && visible.map((item) => {
          const style = TL_STYLES[item.type]
          const Icon = style.icon
          return (
            <div
              key={item.id}
              className={`flex gap-0 group ${item.isFuture ? 'bg-accent/3' : ''}`}
            >
              {/* Color bar */}
              <div className={`w-1 shrink-0 ${style.bar} ${item.isFuture ? 'opacity-100' : 'opacity-50'}`} />

              {/* Content */}
              <div className="flex-1 px-4 py-3 flex items-start justify-between gap-3 min-w-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <Icon className="w-3 h-3 text-text-secondary shrink-0" />
                    <p className={`text-xs font-medium leading-snug truncate ${item.isFuture ? 'text-text-primary' : 'text-text-primary'}`}>
                      {item.actionRequired && <AlertTriangle className="w-3 h-3 inline mr-1 text-warning" />}
                      {item.title}
                    </p>
                    {item.isFuture && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20 shrink-0 font-medium">
                        upcoming
                      </span>
                    )}
                  </div>
                  {item.subtitle && (
                    <p className="text-xs text-text-secondary truncate pl-5">{item.subtitle}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-text-secondary whitespace-nowrap">
                    {item.isFuture ? `${formatDate(item.timestamp)} · ${formatTime(item.timestamp)}` : formatDate(item.timestamp)}
                  </span>
                  {item.joinUrl && (
                    <a
                      href={item.joinUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 px-2 py-1 rounded bg-accent/10 border border-accent/20 text-accent text-xs font-medium hover:bg-accent/20 transition-colors"
                    >
                      <Video className="w-3 h-3" />
                      Join
                    </a>
                  )}
                  {item.viewUrl && (
                    <a
                      href={item.viewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-text-secondary hover:text-text-primary"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              </div>
            </div>
          )
        })}

        {!loading && items.length > 10 && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="w-full px-5 py-3 text-xs text-text-secondary hover:text-accent transition-colors flex items-center justify-center gap-1.5"
          >
            {showAll ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {showAll ? 'Show less' : `Show ${items.length - 10} more`}
          </button>
        )}
      </div>
    </div>
  )
}

// ── Cases section ─────────────────────────────────────────────────────────────

type CaseItem = { caseNumber: string; summary: string; status: string; severity: string; daysOpen: number; product?: string }

const SEV_LABELS: Record<string, { label: string; color: string; bg: string; border: string }> = {
  '1': { label: 'Sev 1 — Critical', color: 'text-critical',      bg: 'bg-critical/15', border: 'border-critical/30' },
  '2': { label: 'Sev 2 — High',     color: 'text-warning',       bg: 'bg-warning/15',  border: 'border-warning/30' },
  '3': { label: 'Sev 3 — Normal',   color: 'text-yellow-400',    bg: 'bg-yellow-500/10', border: 'border-yellow-500/20' },
  '4': { label: 'Sev 4 — Low',      color: 'text-text-secondary', bg: 'bg-border/30',  border: 'border-border' },
}

function fmtCommentDate(iso: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function CaseDetailModal({ c, onClose }: { c: CaseItem; onClose: () => void }) {
  const portalUrl = `https://access.redhat.com/support/cases/#/case/${c.caseNumber}`
  const sev = SEV_LABELS[c.severity] ?? SEV_LABELS['4']
  const statusColor = (s: string) =>
    s.toLowerCase().includes('waiting on red hat') ? 'text-critical' :
    s.toLowerCase().includes('waiting on customer') ? 'text-success' : 'text-text-secondary'

  const [comment, setComment] = useState<{ author: string; body: string; createdAt: string } | null | 'loading'>('loading')

  useEffect(() => {
    fetch(`/api/cases/${c.caseNumber}/latest-comment`)
      .then((r) => r.json())
      .then((d) => setComment(d.comment ?? null))
      .catch(() => setComment(null))
  }, [c.caseNumber])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl w-full max-w-lg shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Shield className="w-4 h-4 text-accent shrink-0" />
            <span className="font-mono text-sm text-text-secondary">{c.caseNumber}</span>
            <span className={`text-xs font-bold px-2 py-0.5 rounded border ${sev.bg} ${sev.border} ${sev.color}`}>
              {sev.label}
            </span>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-text-primary leading-relaxed">{c.summary}</p>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="bg-bg/50 rounded-lg px-3 py-2.5">
              <p className="text-text-secondary mb-1">Status</p>
              <p className={`font-medium ${statusColor(c.status)}`}>{c.status}</p>
            </div>
            <div className="bg-bg/50 rounded-lg px-3 py-2.5">
              <p className="text-text-secondary mb-1">Days Open</p>
              <p className="font-medium text-text-primary">{c.daysOpen === 0 ? '—' : `${c.daysOpen}d`}</p>
            </div>
            {c.product && (
              <div className="col-span-2 bg-bg/50 rounded-lg px-3 py-2.5">
                <p className="text-text-secondary mb-1">Product</p>
                <p className="font-medium text-text-primary">{c.product}</p>
              </div>
            )}
          </div>

          {/* Latest comment — only rendered if available */}
          {comment === 'loading' && (
            <div className="pt-1 border-t border-border/50">
              <div className="h-3 w-24 bg-border/40 rounded animate-pulse mt-2 mb-2" />
              <div className="h-8 bg-border/30 rounded animate-pulse" />
            </div>
          )}
          {comment && comment !== 'loading' && (
            <div className="pt-1 border-t border-border/50">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-medium text-text-secondary">Latest update</span>
                {comment.createdAt && (
                  <span className="text-xs text-text-secondary/75">· {fmtCommentDate(comment.createdAt)}</span>
                )}
                {comment.author && (
                  <span className="text-xs text-text-secondary/75">· {comment.author}</span>
                )}
              </div>
              <p className="text-xs text-text-primary/80 leading-relaxed line-clamp-4 bg-bg/40 rounded-lg px-3 py-2.5">
                {comment.body}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-border">
          <a
            href={portalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full bg-accent/10 hover:bg-accent/20 border border-accent/30 text-accent text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            Open in Red Hat Portal
          </a>
        </div>
      </div>
    </div>
  )
}

function CasesSection({ cases, loading }: { cases: CaseItem[]; loading: boolean }) {
  const [selected, setSelected] = useState<CaseItem | null>(null)

  function severityBg(sev: string) {
    if (sev === '1') return 'border-l-2 border-critical bg-critical/5'
    if (sev === '2') return 'border-l-2 border-warning bg-warning/5'
    return 'border-l-2 border-transparent'
  }
  function statusColor(status: string) {
    if (status.toLowerCase().includes('waiting on red hat')) return 'text-critical'
    if (status.toLowerCase().includes('waiting on customer')) return 'text-success'
    return 'text-text-secondary'
  }

  return (
    <>
      <div className="bg-surface border border-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Shield className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">Support Cases</h2>
          {!loading && <span className="text-xs text-text-secondary">{cases.length} open</span>}
        </div>

        {loading && (
          <div className="space-y-3">
            {[1, 2].map((i) => <Skeleton key={i} className="h-12" />)}
          </div>
        )}

        {!loading && cases.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-success py-1">
            <CheckCircle className="w-4 h-4" />
            No open support cases
          </div>
        )}

        {!loading && cases.length > 0 && (
          <div className="space-y-1">
            {cases.map((c) => (
              <div
                key={c.caseNumber}
                onClick={() => setSelected(c)}
                className={`px-3 py-2.5 rounded-lg cursor-pointer hover:brightness-125 transition-all group ${severityBg(c.severity)}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-mono text-text-secondary">{c.caseNumber}</span>
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${c.severity === '1' ? 'bg-critical/20 text-critical' : c.severity === '2' ? 'bg-warning/20 text-warning' : 'bg-border/40 text-text-secondary'}`}>
                        Sev{c.severity}
                      </span>
                      {c.product && <span className="text-xs text-text-secondary truncate">{c.product}</span>}
                    </div>
                    <p className="text-xs text-text-primary leading-snug line-clamp-2">{c.summary}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`text-xs font-medium ${statusColor(c.status)}`}>{c.status}</div>
                    <div className="text-xs text-text-secondary mt-0.5">{c.daysOpen}d open</div>
                    <ExternalLink className="w-3 h-3 text-text-secondary/80 group-hover:text-accent mt-1 ml-auto transition-colors" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && <CaseDetailModal c={selected} onClose={() => setSelected(null)} />}
    </>
  )
}

// ── Subscriptions section ─────────────────────────────────────────────────────

function SubscriptionsSection({ products, loading }: { products: SheetProduct[]; loading: boolean }) {
  const today = Date.now()
  const sorted = useMemo(() =>
    [...products]
      .map((p) => ({
        ...p,
        daysLeft: p.endDate ? Math.ceil((new Date(p.endDate).getTime() - today) / 86_400_000) : 9999,
      }))
      .sort((a, b) => a.daysLeft - b.daysLeft),
    [products]
  )

  return (
    <div className="bg-surface border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Package className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">Products</h2>
        {!loading && <span className="text-xs text-text-secondary">{products.length}</span>}
      </div>

      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}
        </div>
      )}

      {!loading && products.length === 0 && (
        <p className="text-sm text-text-secondary italic py-1">No product data cached — run sheet sync</p>
      )}

      {!loading && sorted.length > 0 && (
        <div className="space-y-1">
          {sorted.map((p, i) => (
            <div key={i} className="flex items-center gap-3 py-2 border-b border-border/40 last:border-0">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-text-primary truncate">{p.productDescription}</p>
                <p className="text-xs text-text-secondary mt-0.5">
                  Qty: {p.quantity.toLocaleString()}{p.sku ? ` · ${p.sku}` : ''}
                </p>
              </div>
              <div className="text-right shrink-0">
                {p.endDate ? (
                  <>
                    <p className={`text-xs font-semibold ${expiryColor(p.daysLeft)}`}>
                      {p.daysLeft < 0 ? 'Expired' : `${p.daysLeft}d`}
                    </p>
                    <p className="text-xs text-text-secondary">{formatDate(p.endDate)}</p>
                  </>
                ) : (
                  <p className="text-xs text-text-secondary">—</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Key Contacts ──────────────────────────────────────────────────────────────

const SKIP_EMAILS = /noreply|no-reply|gemini-notes|calendar-notification|notifications|donotreply|bounce|mailer-daemon|jhorn@redhat\.com/i

function parseEmailAddress(raw: string): string {
  const angleMatch = raw.match(/<([^>]+)>/)
  const email = angleMatch ? angleMatch[1].trim() : raw.replace(/^"[^"]*"\s*/, '').trim()
  return email.toLowerCase()
}

function parseSenderName(raw: string): string | null {
  const angleMatch = raw.match(/^"?([^"<]+?)"?\s*</)
  if (angleMatch) {
    const name = angleMatch[1].trim().replace(/^"|"$/g, '')
    if (name && !name.includes('@')) return name
  }
  return null
}

interface Contact {
  email: string
  name: string
  interactions: number
  sources: Set<'meeting' | 'email'>
}

function KeyContacts({ meetings, emails, loading }: { meetings: any[]; emails: any[]; loading: boolean }) {
  const contacts = useMemo((): Contact[] => {
    const map = new Map<string, Contact>()

    function touch(email: string, rawName: string | null, source: 'meeting' | 'email') {
      if (!email || !email.includes('@') || SKIP_EMAILS.test(email)) return
      const existing = map.get(email)
      if (existing) {
        existing.interactions++
        existing.sources.add(source)
        if (!existing.name && rawName) existing.name = rawName
      } else {
        const fallback = email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
        map.set(email, { email, name: rawName ?? fallback, interactions: 1, sources: new Set([source]) })
      }
    }

    for (const ev of meetings) {
      for (const addr of ev.attendees ?? []) {
        touch(addr.toLowerCase(), null, 'meeting')
      }
    }

    for (const em of emails) {
      if (!em.from) continue
      const email = parseEmailAddress(em.from)
      const name = parseSenderName(em.from)
      touch(email, name, 'email')
    }

    return Array.from(map.values())
      .sort((a, b) => b.interactions - a.interactions)
      .slice(0, 10)
  }, [meetings, emails])

  if (!loading && contacts.length === 0) return null

  return (
    <div className="bg-surface border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Users className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">Key Contacts</h2>
        {!loading && <span className="text-xs text-text-secondary">{contacts.length}</span>}
      </div>

      {loading && (
        <div className="space-y-2.5">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8" />)}
        </div>
      )}

      {!loading && (
        <div className="space-y-2">
          {contacts.map((c) => {
            const domain = c.email.split('@')[1] ?? ''
            const isExternal = !domain.endsWith('redhat.com')
            return (
              <div key={c.email} className="flex items-center gap-3">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-semibold ${
                  isExternal ? 'bg-accent/15 text-accent' : 'bg-border/60 text-text-secondary'
                }`}>
                  {c.name[0]?.toUpperCase() ?? '?'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-text-primary truncate">{c.name}</p>
                  <p className="text-xs text-text-secondary truncate">{c.email}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {c.sources.has('meeting') && <span title="Met in meeting"><Calendar className="w-3 h-3 text-text-secondary" /></span>}
                  {c.sources.has('email') && <span title="Email contact"><Mail className="w-3 h-3 text-text-secondary" /></span>}
                  <span className="text-xs text-text-secondary">{c.interactions}×</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Drive section ─────────────────────────────────────────────────────────────

function DriveSection({ files, loading }: { files: any[]; loading: boolean }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <FileText className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">Drive Documents</h2>
        {!loading && <span className="text-xs text-text-secondary">{files.length} recent</span>}
      </div>

      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}
        </div>
      )}

      {!loading && files.length === 0 && (
        <p className="text-sm text-text-secondary italic py-1">No documents in last 90 days</p>
      )}

      {!loading && files.length > 0 && (
        <div className="space-y-1">
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-3 py-1.5">
              <span className="text-xs font-medium text-text-secondary bg-border/40 px-1.5 py-0.5 rounded shrink-0 w-10 text-center">
                {mimeLabel(f.mimeType)}
              </span>
              <div className="min-w-0 flex-1">
                {f.webViewLink ? (
                  <a
                    href={f.webViewLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-text-primary hover:text-accent transition-colors flex items-center gap-1 truncate"
                  >
                    <span className="truncate">{f.name}</span>
                    <ExternalLink className="w-3 h-3 shrink-0" />
                  </a>
                ) : (
                  <span className="text-xs text-text-primary truncate">{f.name}</span>
                )}
              </div>
              {f.modifiedTime && (
                <span className="text-xs text-text-secondary shrink-0">{formatDate(f.modifiedTime)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Cloud Spend (CCSP) ────────────────────────────────────────────────────────

interface CCSPData {
  totalAcv: number
  cachedAt?: string
  byQuarter: { quarter: string; acv: number }[]
  byPartner: { partner: string; acv: number }[]
}

function useCCSP(customerName: string) {
  const [data, setData] = useState<CCSPData | null>(null)
  useEffect(() => {
    fetch(`/customer/${encodeURIComponent(customerName)}/ccsp`)
      .then((r) => r.json())
      .then((json) => setData(json))
      .catch(() => {})
  }, [customerName])
  return data
}

const PARTNER_COLORS: Record<string, string> = {
  AWS: '#FF9900', Google: '#4285F4', Microsoft: '#00A4EF', Other: '#6B7280',
}


function CloudSpendCard({ customerName }: { customerName: string }) {
  const data = useCCSP(customerName)

  // Don't render until loaded, and hide entirely if no spend
  if (!data || data.totalAcv === 0) return null

  return (
    <div className="bg-surface border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Cloud className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">Cloud Spend (CCSP)</h2>
        <span className="text-xs text-text-secondary">2025</span>
      </div>

      {/* Total */}
      <div className="mb-4">
        <div className="text-2xl font-bold text-text-primary">{fmtAcv(data.totalAcv)}</div>
        <div className="text-xs text-text-secondary">marketplace revenue</div>
      </div>

      {/* Partner breakdown */}
      {data.byPartner.length > 0 && (
        <div className="mb-4 space-y-2">
          {data.byPartner.map(({ partner, acv }) => {
            const pct = data.totalAcv > 0 ? (acv / data.totalAcv) * 100 : 0
            const color = PARTNER_COLORS[partner] ?? PARTNER_COLORS.Other
            return (
              <div key={partner}>
                <div className="flex justify-between text-xs mb-0.5">
                  <span className="text-text-primary font-medium">{partner}</span>
                  <span className="text-text-secondary">{fmtAcv(acv)} · {pct.toFixed(0)}%</span>
                </div>
                <div className="h-1.5 bg-border rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Quarterly trend */}
      {data.byQuarter.length > 1 && (
        <div>
          <div className="text-xs text-text-secondary mb-2">Quarterly trend</div>
          <ResponsiveContainer width="100%" height={56}>
            <BarChart data={data.byQuarter} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                content={({ active, payload, label }) =>
                  active && payload?.length ? (
                    <div className="bg-surface border border-border rounded px-2 py-1 text-xs shadow">
                      <div className="text-text-secondary">{label}</div>
                      <div className="text-text-primary font-semibold">{fmtAcv(payload[0].value as number)}</div>
                    </div>
                  ) : null
                }
              />
              <Bar dataKey="acv" radius={[3, 3, 0, 0]}>
                {data.byQuarter.map((_, i) => (
                  <Cell key={i} fill={i === data.byQuarter.length - 1 ? '#00BCD4' : '#00BCD440'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="flex justify-between text-xs text-text-secondary mt-1 px-0.5">
            {data.byQuarter.map(({ quarter }) => (
              <span key={quarter}>{quarter.replace('20', '').replace('-', ' ')}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Pipeline Card ─────────────────────────────────────────────────────────────

const PIPE_STAGE_COLORS: Record<string, string> = {
  Commit:       '#3FB950',
  'Best Case':  '#D29922',
  Pipeline:     '#58A6FF',
  Closed:       '#A371F7',
  Omitted:      '#6B7280',
}

function pipeDate(iso: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

function pipeUrgency(iso: string): 'overdue' | 'urgent' | 'soon' | 'ok' {
  if (!iso) return 'ok'
  const days = (new Date(iso).getTime() - Date.now()) / 86_400_000
  if (days < 0) return 'overdue'
  if (days <= 30) return 'urgent'
  if (days <= 90) return 'soon'
  return 'ok'
}

const PIPE_URGENCY_COLORS: Record<string, string> = {
  overdue: 'text-critical', urgent: 'text-warning', soon: 'text-accent', ok: 'text-text-secondary',
}

interface AccountPipelineData {
  totalAcv: number
  openCount: number
  opps: PipelineOpp[]
  closedOpps: PipelineOpp[]
  cachedAt: string | null
}

function usePipeline(customerName: string) {
  const [data, setData] = useState<AccountPipelineData | null>(null)
  useEffect(() => {
    fetch(`/customer/${encodeURIComponent(customerName)}/pipeline`)
      .then((r) => r.json())
      .then((json) => setData(json))
      .catch(() => {})
  }, [customerName])
  return data
}

function PipelineCard({ customerName }: { customerName: string }) {
  const data = usePipeline(customerName)
  const [selectedOpp, setSelectedOpp] = useState<PipelineOpp | null>(null)

  if (!data) return null
  if (data.openCount === 0 && data.closedOpps.length === 0) return null

  const closedAcv = data.closedOpps.reduce((s, o) => s + o.acv, 0)

  return (
    <div className="bg-surface border border-border rounded-xl p-5">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">Open Pipeline</h2>
        {data.openCount > 0 && (
          <span className="text-xs text-text-secondary">{data.openCount} open</span>
        )}
      </div>

      {/* Total ACV */}
      {data.openCount > 0 && (
        <div className="mb-4">
          <div className="text-2xl font-bold text-text-primary">{fmtAcv(data.totalAcv)}</div>
          <div className="text-xs text-text-secondary">open ACV</div>
        </div>
      )}

      {/* Opp rows */}
      {data.opps.length > 0 && (
        <div className="overflow-y-auto max-h-48 mb-3">
          {data.opps.map((opp) => {
            const urgency = pipeUrgency(opp.closeDate)
            const stageColor = PIPE_STAGE_COLORS[opp.forecastCategory] ?? PIPE_STAGE_COLORS.Omitted
            return (
              <div
                key={opp.oppNumber}
                onClick={() => setSelectedOpp(opp)}
                className="flex items-center gap-2 py-1.5 px-1 -mx-1 hover:bg-border/20 rounded cursor-pointer"
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: stageColor }} />
                <span className="text-xs font-medium shrink-0 w-10" style={{ color: stageColor }}>
                  {opp.forecastCategory === 'Best Case' ? 'Best' : opp.forecastCategory}
                </span>
                <span className="text-xs text-text-primary truncate flex-1 min-w-0">{opp.oppName}</span>
                <span className={`text-xs shrink-0 ${PIPE_URGENCY_COLORS[urgency]}`}>{pipeDate(opp.closeDate)}</span>
                <span className="text-xs font-mono text-text-primary shrink-0">{fmtAcv(opp.acv)}</span>
                {opp.renewal && <span className="text-xs text-text-secondary/75 shrink-0">↻</span>}
              </div>
            )
          })}
        </div>
      )}

      {/* Closed summary */}
      {data.closedOpps.length > 0 && (
        <div className="pt-2 border-t border-border/40">
          <span className="text-xs text-text-secondary">
            Closed: {data.closedOpps.length} {data.closedOpps.length === 1 ? 'opp' : 'opps'} · {fmtAcv(closedAcv)}
          </span>
        </div>
      )}

      {selectedOpp && <OppDetail opp={selectedOpp} onClose={() => setSelectedOpp(null)} />}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function CustomerDetailPage() {
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const customerName = decodeURIComponent(name ?? '')

  const sse = useCustomerSSE(customerName)
  const accountInfo = useAccountInfo(customerName)
  const health = getHealth(sse.cases)

  const sectionLoading = sse.loading
  const meta = sse.meta
  const nextLabel = nextMeetingLabel(sse.meetings)

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      {/* Header */}
      <header className="bg-surface border-b border-border px-6 h-16 flex items-center justify-between shrink-0 sticky top-0 z-10">
        {/* Left: nav + identity */}
        <div className="flex items-center gap-4 min-w-0">
          <button
            onClick={() => navigate('/dashboard')}
            className="text-text-secondary hover:text-text-primary transition-colors shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="w-3 h-3 rounded-full shrink-0"
              style={{ backgroundColor: health.color }}
              title={health.label}
            />
            <h1 className="text-base font-bold text-text-primary truncate">{customerName}</h1>
          </div>

          <div className="hidden md:flex items-center gap-2 flex-wrap">
            {meta?.accountNumbers && meta.accountNumbers.length > 0 && (
              <span className="text-xs px-2 py-0.5 rounded bg-border/40 text-text-secondary font-mono">
                #{meta.accountNumbers.join(' · #')}
              </span>
            )}
            {meta?.segment && (
              <span className="text-xs px-2 py-0.5 rounded bg-accent/10 text-accent border border-accent/20 font-medium">
                {meta.segment}
              </span>
            )}
            {meta?.ae && (
              <span className="text-xs px-2 py-0.5 rounded bg-border/50 text-text-secondary">{meta.ae}</span>
            )}
          </div>
        </div>

        {/* Right: stats + sync */}
        <div className="flex items-center gap-6">
          {/* Inline KPIs */}
          <div className="hidden lg:flex items-center gap-5 text-xs">
            <div className="flex items-center gap-1.5">
              <Shield className={`w-3.5 h-3.5 ${sse.cases.some((c) => c.severity === '1') ? 'text-critical' : sse.cases.length > 0 ? 'text-warning' : 'text-success'}`} />
              <span className="font-semibold text-text-primary">{sectionLoading ? '—' : sse.cases.length}</span>
              <span className="text-text-secondary">cases</span>
            </div>
            {accountInfo && (
              <>
                <div className="flex items-center gap-1.5">
                  <Package className="w-3.5 h-3.5 text-text-secondary" />
                  <span className="font-semibold text-text-primary">{accountInfo.productCount}</span>
                  <span className="text-text-secondary">products</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-text-secondary" />
                  <span className="font-semibold text-text-primary">{accountInfo.totalLicenses.toLocaleString()}</span>
                  <span className="text-text-secondary">licenses</span>
                </div>
              </>
            )}
            {nextLabel && (
              <div className="flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-accent" />
                <span className="font-semibold text-accent">{nextLabel}</span>
              </div>
            )}
          </div>

          {/* Sync state */}
          <div className="text-xs text-text-secondary">
            {sse.completedAt ? (
              <span>Synced {formatRelTime(sse.completedAt)}</span>
            ) : sectionLoading ? (
              <span className="flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Loading…
              </span>
            ) : null}
          </div>
        </div>
      </header>

      {/* Error banner — suppress when customer doesn't exist (meta never received = 404) */}
      {sse.error && sse.meta !== null && (
        <div className="bg-warning/10 border-b border-warning/30 px-6 py-2 flex items-center gap-2 text-sm text-warning shrink-0">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {sse.error}
        </div>
      )}

      {/* Two-column body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left column — 65% */}
        <main className="w-full lg:w-[65%] overflow-y-auto p-6 pr-3 space-y-6">
          <BriefSection name={customerName} />
          <CloudSpendCard customerName={customerName} />
          <PipelineCard customerName={customerName} />
          <ActivityTimeline
            meetings={sse.meetings}
            emails={sse.emails}
            drive={sse.drive}
            loading={sectionLoading}
          />
        </main>

        {/* Right column — 35%, sticky scroll */}
        <aside className="hidden lg:block w-[35%] overflow-y-auto p-6 pl-3 space-y-4 border-l border-border/40">
          <SubscriptionsSection products={accountInfo?.products ?? []} loading={accountInfo === null} />
          <CasesSection cases={sse.cases} loading={sectionLoading} />
          <KeyContacts meetings={sse.meetings} emails={sse.emails} loading={sectionLoading} />
          <DriveSection files={sse.drive} loading={sectionLoading} />
        </aside>
      </div>
    </div>
  )
}
