import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import {
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
  AlertCircle,
  CheckCircle,
  Clock,
  Users,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  Sparkles,
  Cloud,
  TrendingUp,
  Settings,
  Zap,
  X,
  BookOpen,
} from 'lucide-react'
import { BarChart, Bar, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import { useCustomerSSE } from '../hooks/useCustomerSSE'
import { formatDate, formatTime, formatRelTime, fmtCurrency } from '../lib/format'
import { OppDetail } from '../components/PipelineSection'
import CopyButton from '../components/CopyButton'
import { AccountCountPill } from '../components/AccountCountPill'
import BriefAgePill from '../components/BriefAgePill'
import { DataQualityBadge } from '../components/DataQualityBadge'
import { AccountIntelligencePanel } from '../components/AccountIntelligencePanel'
import PriorityActionBanner from '../components/PriorityActionBanner'
import CustomerSignalBanner from '../components/CustomerSignalBanner'
import HealthScoreHero from '../components/HealthScoreHero'
import CitationTooltip from '../components/CitationTooltip'
import BriefDeltaMarker from '../components/BriefDeltaMarker'
import TemporalDeltaSection from '../components/TemporalDeltaSection'
import CompetitiveSignalBadge from '../components/CompetitiveSignalBadge'
import StakeholderEngagementPanel from '../components/StakeholderEngagementPanel'
import { StatBadge } from '../components/StatBadge'
import type { PipelineOpp } from '../types'
import { CasesSection } from '../components/CasesSection'
import type { CaseItem } from '../components/CasesSection'
import { KeyContacts } from '../components/KeyContactsSection'
import { SubscriptionsSection } from '../components/SubscriptionsSection'
import { DriveSection } from '../components/DriveSection'

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
        <h2 className="text-base font-semibold text-text-primary">AI Brief Setup Required</h2>
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
  // meetings[] spans 30 days back → 30 days forward sorted ascending.
  // Take the first meeting that started within the last 2h (may be in-progress)
  // or is upcoming. Meetings older than 2h are over — show nothing.
  const now = Date.now()
  const twoHoursAgo = now - 2 * 60 * 60 * 1000
  const next = meetings.find(m => new Date(m.start).getTime() >= twoHoursAgo)
  if (!next) return ''
  const diff = new Date(next.start).getTime() - now
  const mins = Math.floor(diff / 60_000)
  if (mins < 0) return 'Meeting in progress'
  if (mins < 5) return 'Starting soon'
  if (mins < 60) return `In ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `In ${hours}h`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Tomorrow'
  return `In ${days}d`
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`bg-border/40 rounded animate-pulse-slow ${className}`} />
}

// ── Inline Sparkline (BKL-G05) ───────────────────────────────────────────────

function InlineSparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const w = 32
  const h = 12
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w
    const y = h - ((v - min) / range) * (h - 2) - 1
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  // Trend coloring
  const trend = values[values.length - 1] >= values[0] ? '#3FB950' : '#F85149'

  return (
    <svg width={w} height={h} className="shrink-0" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={trend}
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ── Brief text helpers (R07/R14) ──────────────────────────────────────────────

function renderBriefWithCitations(text: string) {
  const parts = text.split(/(\[Source: [^\]]+\])/g)
  let citationIndex = 0
  return parts.map((part, i) => {
    const match = part.match(/^\[Source: (.+)\]$/)
    if (match) {
      citationIndex++
      return <CitationTooltip key={i} index={citationIndex} source={match[1]} />
    }
    return <span key={i}>{part}</span>
  })
}

function renderLineWithDelta(line: string) {
  if (line.startsWith('\u25B2 ')) {
    return (
      <>
        <BriefDeltaMarker />
        <span>{line.slice(2)}</span>
      </>
    )
  }
  return <>{renderBriefWithCitations(line)}</>
}

// ── Brief section ─────────────────────────────────────────────────────────────

function BriefSection({ name }: { name: string }) {
  const { data, loading, error, refresh } = useBrief(name)
  const [expanded, setExpanded] = useState(false)
  const config = useDashboardConfig()
  const [configDismissed, setConfigDismissed] = useState(false)

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

  // BKL-G16: Reorder brief sections by spec hierarchy
  // Priority Action > What Changed > Key Risks > Competitive Signals > Meetings > Pipeline > Cases > Subscriptions
  // Skip Account Overview (shown above) and Products (shown in side tile)
  const SECTION_ORDER: string[] = [
    'Priority Action',
    'What Changed',
    'Risks',
    'Key Risks',
    'Competitive Signal',
    'Talking Points',
    'Meeting',
    'Pipeline',
    'Open Support Cases',
    'Cases',
    'Key Insights',
    'Company Profile',
    'Subscription',
    'Technology Landscape',
    'Data Freshness',
  ]

  const expandedSections = useMemo(() => {
    const entries = Object.entries(sections).filter(([k]) =>
      !k.startsWith('Account Overview') && !k.startsWith('Products')
    )
    // Sort: known sections by spec order, unknown sections appended at end
    return entries.sort(([a], [b]) => {
      const aIdx = SECTION_ORDER.findIndex(prefix => a.toLowerCase().startsWith(prefix.toLowerCase()))
      const bIdx = SECTION_ORDER.findIndex(prefix => b.toLowerCase().startsWith(prefix.toLowerCase()))
      const aOrder = aIdx >= 0 ? aIdx : SECTION_ORDER.length + 1
      const bOrder = bIdx >= 0 ? bIdx : SECTION_ORDER.length + 1
      return aOrder - bOrder
    })
  }, [sections])

  // Parse competitive signals from brief "## Competitive Signals" section
  const competitiveSignals = useMemo(() => {
    const csSection = Object.entries(sections).find(([k]) => k.startsWith('Competitive Signal'))?.[1]
    if (!csSection) return []
    return csSection.split('\n')
      .map(l => l.trim())
      .filter(l => /^[-*]/.test(l))
      .map(line => {
        const clean = line.replace(/^[-*]\s*/, '')
        // Try to extract competitor name before "mentioned" or first word(s) before context
        const mentionMatch = clean.match(/^(.+?)\s+(?:mentioned|evaluation|migration|replacement|competing)/i)
        const competitor = mentionMatch ? mentionMatch[1].replace(/\*+/g, '').trim() : clean.split(/\s+/).slice(0, 2).join(' ').replace(/\*+/g, '')
        return { competitor, context: clean }
      })
      .filter(s => s.competitor.length > 0)
  }, [sections])

  // Show setup card if provider not configured and brief hasn't loaded
  // NOTE: Moved after all hooks to comply with React Rules of Hooks (BKL-G16)
  if (config && !config.briefConfigured && !data && !configDismissed) {
    return <BriefSetupCard config={config} onTestDone={() => { setConfigDismissed(true); refresh() }} />
  }

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between border-b border-border/60">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-accent" />
          <h2 className="text-base font-semibold text-text-primary">Account Brief</h2>
          <BriefAgePill generatedAt={data?.cachedAt} />
          <DataQualityBadge cachedAt={data?.cachedAt ?? null} />
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border text-xs text-text-secondary hover:text-text-primary hover:border-text-secondary transition-all disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Refreshing…' : '↻ Refresh Brief'}
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

        {error && !loading && (
          <p className="text-sm text-critical italic">{error}</p>
        )}

        {!loading && !error && data && (
          <div className="space-y-4">
            {overview && (
              <p className={`text-sm text-text-primary leading-relaxed ${!expanded ? 'line-clamp-3' : ''}`}>
                {renderBriefWithCitations(overview)}
              </p>
            )}

            {competitiveSignals.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-text-secondary font-medium">Competitive:</span>
                {competitiveSignals.map((s, i) => (
                  <CompetitiveSignalBadge key={i} competitor={s.competitor} context={s.context} />
                ))}
              </div>
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
                                <span className="text-success mt-0.5 shrink-0">✓</span>
                                <span>{techMatch[1].replace(/^\*{0,2}/, '').replace(/\*{0,2}$/, '').trim()}</span>
                              </li>
                            )
                          }

                          // Standard bullet
                          return (
                            <li key={i} className="flex gap-2 text-sm text-text-primary">
                              <span className="text-accent mt-0.5 shrink-0">·</span>
                              <span>{renderLineWithDelta(line.replace(/^[-*✓\d.]+\s*\*{0,2}/, '').replace(/\*{0,2}$/, '').trim())}</span>
                            </li>
                          )
                        }

                        return <li key={i} className="text-sm text-text-primary">{renderLineWithDelta(line)}</li>
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
          <h2 className="text-base font-semibold text-text-primary">Activity</h2>
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
                  <div className="flex items-center gap-2 mb-0.5 min-w-0">
                    <Icon className="w-3 h-3 text-text-secondary shrink-0" />
                    <p className={`text-sm font-medium leading-snug truncate ${item.isFuture ? 'text-text-primary' : 'text-text-primary'}`} title={item.title}>
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
                    <p className="text-xs text-text-secondary truncate pl-5" title={item.subtitle}>{item.subtitle}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-text-secondary whitespace-nowrap">
                    {item.isFuture ? `${formatDate(item.timestamp)} · ${formatTime(item.timestamp)}` : formatDate(item.timestamp)}
                  </span>
                  {item.joinUrl && (
                    <a
                      href={item.joinUrl?.startsWith('https://') ? item.joinUrl : '#'}
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
                      href={item.viewUrl?.startsWith('https://') ? item.viewUrl : '#'}
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

// ── Cases section — extracted to src/components/CasesSection.tsx ─────────────

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

  // Don't render until loaded
  if (!data) return null

  // Zero spend — show minimal indicator instead of hiding entirely
  if (data.totalAcv === 0) {
    return (
      <div className="bg-surface border border-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-2">
          <Cloud className="w-4 h-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">Cloud Spend (CCSP)</h2>
        </div>
        <p className="text-xs text-text-secondary">No cloud spend data found for this customer.</p>
      </div>
    )
  }

  return (
    <div className="bg-surface border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Cloud className="w-4 h-4 text-accent" />
        <h2 className="text-base font-semibold text-text-primary">Cloud Spend (CCSP)</h2>
        <span className="text-xs text-text-secondary">2025</span>
      </div>

      {/* Total */}
      <div className="mb-4">
        <div className="text-2xl font-bold text-text-primary tabular-nums">{fmtCurrency(data.totalAcv)}</div>
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
                  <span className="text-text-secondary">{fmtCurrency(acv)} · {pct.toFixed(0)}%</span>
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
                      <div className="text-text-primary font-semibold">{fmtCurrency(payload[0].value as number)}</div>
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
        <h2 className="text-base font-semibold text-text-primary">Open Pipeline</h2>
        {data.openCount > 0 && (
          <span className="text-xs text-text-secondary">{data.openCount} open</span>
        )}
      </div>

      {/* Total ACV */}
      {data.openCount > 0 && (
        <div className="mb-4">
          <div className="text-2xl font-bold text-text-primary tabular-nums">{fmtCurrency(data.totalAcv)}</div>
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
              <button
                key={opp.oppNumber}
                onClick={() => setSelectedOpp(opp)}
                className="w-full text-left flex items-center gap-2 py-1.5 px-1 -mx-1 hover:bg-border/20 rounded cursor-pointer min-w-0"
                tabIndex={0}
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: stageColor }} />
                <span className="text-xs font-medium shrink-0 w-10" style={{ color: stageColor }}>
                  {opp.forecastCategory === 'Best Case' ? 'Best' : opp.forecastCategory}
                </span>
                <span className="text-sm text-text-primary truncate flex-1 min-w-0" title={opp.oppName}>{opp.oppName}</span>
                <span className={`text-xs shrink-0 ${PIPE_URGENCY_COLORS[urgency]}`}>{pipeDate(opp.closeDate)}</span>
                <span className="text-xs font-mono text-text-primary shrink-0">{fmtCurrency(opp.acv)}</span>
                {opp.renewal && <span className="text-xs text-text-secondary/75 shrink-0">↻</span>}
              </button>
            )
          })}
        </div>
      )}

      {/* Closed summary */}
      {data.closedOpps.length > 0 && (
        <div className="pt-2 border-t border-border/40">
          <span className="text-xs text-text-secondary">
            Closed: {data.closedOpps.length} {data.closedOpps.length === 1 ? 'opp' : 'opps'} · {fmtCurrency(closedAcv)}
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

  // Priority Action (R13)
  const [priorityAction, setPriorityAction] = useState<{ text: string; severity: 'critical' | 'high' | 'medium'; source: string } | null>(null)
  useEffect(() => {
    if (customerName) {
      fetch(`/api/customer/${encodeURIComponent(customerName)}/priority-action`)
        .then(r => r.json())
        .then(d => setPriorityAction(d.action ?? null))
        .catch(() => {})
    }
  }, [customerName])

  // Stakeholder Engagement (R31)
  const stakeholderApi = useApi<{ contacts: { name: string; email?: string; lastContact?: string; frequency?: string; daysSilent?: number; emailCount30d?: number; emailCount60d?: number; emailCount90d?: number }[] }>(
    `/api/customer/${encodeURIComponent(customerName ?? '')}/stakeholder-engagement`,
    { enabled: !!customerName }
  )
  const stakeholderContacts = stakeholderApi.data?.contacts ?? []

  // Header stat data: CCSP + Pipeline (BKL-G05)
  const [headerCcsp, setHeaderCcsp] = useState<{ totalAcv: number; byQuarter: { quarter: string; acv: number }[] } | null>(null)
  const [headerPipeline, setHeaderPipeline] = useState<{ totalAcv: number; opps: { acv: number }[] } | null>(null)
  useEffect(() => {
    if (customerName) {
      fetch(`/customer/${encodeURIComponent(customerName)}/ccsp`)
        .then(r => r.json())
        .then(d => setHeaderCcsp(d))
        .catch(() => {})
      fetch(`/customer/${encodeURIComponent(customerName)}/pipeline`)
        .then(r => r.json())
        .then(d => setHeaderPipeline(d))
        .catch(() => {})
    }
  }, [customerName])

  // Health Score Hero (R12)
  const [healthScore, setHealthScore] = useState<{ score: number; status: 'red' | 'yellow' | 'green'; breakdown: Record<string, { score: number; signal: string }> } | null>(null)
  useEffect(() => {
    if (customerName) {
      fetch(`/api/health-scores/${encodeURIComponent(customerName)}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => d ? setHealthScore(d) : null)
        .catch(() => {})
    }
  }, [customerName])

  // NotebookLM URL (BKL-AI11)
  const [notebookUrl, setNotebookUrl] = useState<string | null>(null)
  useEffect(() => {
    if (customerName) {
      fetch('/customers')
        .then(r => r.json())
        .then((list: Array<{ name: string; notebookUrl?: string }>) => {
          const match = list.find(c => c.name === customerName)
          setNotebookUrl(match?.notebookUrl ?? null)
        })
        .catch(() => {})
    }
  }, [customerName])

  const health = getHealth(sse.cases)

  const sectionLoading = sse.loading
  const meta = sse.meta
  const nextLabel = nextMeetingLabel(sse.meetings)

  // SSE progress tracking (BKL-UX30)
  const sseProgress = useMemo(() => {
    const sections = [
      { key: 'meta', arrived: sse.meta !== null },
      { key: 'cases', arrived: sse.cases.length > 0 || (!sse.loading && sse.meta !== null) },
      { key: 'meetings', arrived: sse.meetings.length > 0 || (!sse.loading && sse.meta !== null) },
      { key: 'emails', arrived: sse.emails.length > 0 || (!sse.loading && sse.meta !== null) },
      { key: 'drive', arrived: sse.drive.length > 0 || (!sse.loading && sse.meta !== null) },
      { key: 'subscriptions', arrived: sse.subscriptions.length > 0 || (!sse.loading && sse.meta !== null) },
    ]
    const arrived = sections.filter(s => s.arrived).length
    return arrived / sections.length
  }, [sse.meta, sse.cases, sse.meetings, sse.emails, sse.drive, sse.subscriptions, sse.loading])

  // Detect customer not found: SSE finished loading and no meta received
  // (either with an error, or the stream completed without sending meta)
  const customerNotFound = !sectionLoading && meta === null

  // Scroll to top on customer change
  useEffect(() => { window.scrollTo(0, 0) }, [customerName])

  // Set document title
  useEffect(() => {
    document.title = customerName
      ? `${customerName} | ASA Command Center`
      : 'ASA Command Center'
    const metaDesc = document.querySelector('meta[name="description"]')
    if (metaDesc) {
      metaDesc.setAttribute('content', customerName
        ? `Account detail for ${customerName} — ASA Command Center`
        : 'ASA Command Center')
    }
    return () => { document.title = 'ASA Command Center' }
  }, [customerName])

  // Customer not found — render a clean error state
  if (customerNotFound) {
    return (
      <div className="min-h-screen bg-bg flex flex-col items-center justify-center p-6">
        <div className="bg-surface border border-border rounded-xl p-8 max-w-md w-full text-center space-y-4">
          <AlertTriangle className="w-10 h-10 text-warning mx-auto" />
          <h1 className="text-lg font-semibold text-text-primary">Customer not found</h1>
          <p className="text-sm text-text-secondary">
            No customer matching <span className="font-mono text-text-primary">"{customerName}"</span> was found in the configured accounts.
          </p>
          <button
            onClick={() => navigate('/dashboard')}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/10 border border-accent/30 text-accent text-sm font-medium hover:bg-accent/20 transition-colors"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      {/* Header — Row 1: breadcrumb nav */}
      <header className="sticky top-0 z-10 shrink-0">
        <div className="bg-surface border-b border-border px-6 h-12 flex items-center justify-between">
          {/* Left: breadcrumb with back arrow */}
          <nav className="flex items-center gap-1.5 text-xs text-text-secondary min-w-0">
            <button
              onClick={() => navigate('/dashboard')}
              className="hover:text-text-primary transition-colors shrink-0 flex items-center gap-1"
              aria-label="Back to accounts"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              Accounts
            </button>
            <span className="text-text-secondary/50 shrink-0">/</span>
            <span className="text-text-primary font-medium truncate" title={customerName}>{customerName}</span>
          </nav>

          {/* Right: sync state */}
          <div className="text-xs text-text-secondary">
            {sse.completedAt ? (
              <span>Synced {formatRelTime(sse.completedAt)}</span>
            ) : sectionLoading ? (
              <span className="flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Loading...
              </span>
            ) : null}
          </div>
        </div>

        {/* Row 2: hero name + stat badges */}
        <div className="py-4 px-6 bg-surface/60 border-b border-border/40 min-h-[4rem]">
          <div className="flex items-center gap-4 flex-wrap">
            {/* Health dot + numeric score (BKL-G13) */}
            {(sectionLoading || sse.meta !== null) && (
              <div className="flex items-center gap-1.5 shrink-0">
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: health.color }}
                  title={health.label}
                />
                {healthScore && (
                  <span className="text-xs font-semibold text-text-primary tabular-nums">{healthScore.score}/100</span>
                )}
              </div>
            )}
            {/* Customer not found indicator */}
            {!sectionLoading && sse.meta === null && (
              <div className="flex items-center gap-2 text-warning text-sm">
                <AlertTriangle className="w-4 h-4" />
                Customer not found
              </div>
            )}
            <h1 className="text-xl font-bold text-text-primary">{customerName}</h1>

            {meta?.accountNumbers && meta.accountNumbers.length > 0 && (
              <AccountCountPill accountNumbers={meta.accountNumbers.map(String)} />
            )}

            {/* Stat badges */}
            {(sectionLoading || sse.meta !== null) && (
              <>
                <StatBadge
                  icon={<AlertCircle className={`w-3.5 h-3.5 ${sse.cases.some((c) => c.severity === '1') ? 'text-critical' : sse.cases.length > 0 ? 'text-warning' : 'text-success'}`} />}
                  value={sse.cases.length}
                  label="Cases"
                  loading={sectionLoading}
                />
                <StatBadge
                  icon={<Package className="w-3.5 h-3.5 text-text-secondary" />}
                  value={accountInfo?.productCount ?? 0}
                  label="Products"
                  loading={!accountInfo}
                />
                <StatBadge
                  icon={<Key className="w-3.5 h-3.5 text-text-secondary" />}
                  value={accountInfo?.totalLicenses?.toLocaleString() ?? '0'}
                  label="Licenses"
                  loading={!accountInfo}
                />
                {/* BKL-G05: Cloud$ stat badge with sparkline */}
                <StatBadge
                  icon={
                    <div className="flex items-center gap-1">
                      <Cloud className="w-3.5 h-3.5 text-text-secondary" />
                      {headerCcsp?.byQuarter && headerCcsp.byQuarter.length >= 2 && (
                        <InlineSparkline values={headerCcsp.byQuarter.map(q => q.acv)} />
                      )}
                    </div>
                  }
                  value={headerCcsp ? fmtCurrency(headerCcsp.totalAcv) : '$0'}
                  label="Cloud$"
                  loading={!headerCcsp}
                />
                {/* BKL-G05: Pipeline ACV stat badge with sparkline */}
                <StatBadge
                  icon={
                    <div className="flex items-center gap-1">
                      <TrendingUp className="w-3.5 h-3.5 text-text-secondary" />
                      {headerPipeline?.opps && headerPipeline.opps.length >= 2 && (
                        <InlineSparkline values={headerPipeline.opps.map(o => o.acv)} />
                      )}
                    </div>
                  }
                  value={headerPipeline ? fmtCurrency(headerPipeline.totalAcv) : '$0'}
                  label="Pipeline"
                  loading={!headerPipeline}
                />
              </>
            )}

            {meta?.segment && (
              <span className="text-xs px-2 py-0.5 rounded bg-accent/10 text-accent border border-accent/20 font-medium">
                {meta.segment}
              </span>
            )}

            {/* Right-aligned: next meeting + AE */}
            <div className="ml-auto flex items-center gap-4">
              {nextLabel && (
                <div className="flex items-center gap-1.5 text-xs">
                  <Calendar className="w-3.5 h-3.5 text-accent" />
                  <span className="font-semibold text-accent">{nextLabel}</span>
                </div>
              )}
              {meta?.ae && (
                <span className="text-sm text-text-secondary">{meta.ae}</span>
              )}
              {notebookUrl && (
                <a
                  href={notebookUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-accent hover:underline"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  Notebook
                </a>
              )}
            </div>
          </div>
        </div>

        {/* SSE progress bar (BKL-UX30) */}
        {sectionLoading && sseProgress < 1 && (
          <div className="h-0.5 bg-border">
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{ width: `${sseProgress * 100}%` }}
            />
          </div>
        )}
      </header>

      {/* Error banner */}
      {sse.error && (
        <div className="bg-warning/10 border-b border-warning/30 px-6 py-2 flex items-center gap-2 text-sm text-warning shrink-0">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {sse.error}
        </div>
      )}

      {/* Priority Action Banner (R13 + BKL-G03) */}
      {priorityAction && (
        <div className="px-6 pt-4">
          <PriorityActionBanner action={priorityAction} customerName={customerName} />
        </div>
      )}

      {/* Customer Signal Banner (BKL-F10a) — top signal with action chips */}
      {/* TODO: wire real signal data — derive from priorityAction or dedicated signal endpoint */}
      {priorityAction && (
        <div className="px-6 pt-3">
          <CustomerSignalBanner
            signal={priorityAction.text}
            priority={priorityAction.severity === 'critical' ? 'urgent' : 'this-week'}
            chips={[
              ...(priorityAction.source.toLowerCase().includes('case') && priorityAction.source.match(/\d{8,}/)
                ? [{ label: 'View Case', href: `https://access.redhat.com/support/cases/#/case/${priorityAction.source.match(/(\d{8,})/)?.[1]}`, variant: 'case' as const }]
                : []),
              { label: 'Schedule', href: `https://calendar.google.com/calendar/r/eventedit?text=${encodeURIComponent(`Follow up: ${priorityAction.text.slice(0, 60)}`)}`, variant: 'calendar' as const },
            ]}
          />
        </div>
      )}

      {/* Health Score Hero (R12) */}
      {healthScore && (
        <div className="px-6 pt-4">
          <HealthScoreHero score={healthScore.score} status={healthScore.status} breakdown={healthScore.breakdown as any} />
        </div>
      )}

      {/* Two-column body (65/35 — BKL-G14) */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left column — 65% */}
        <main className="w-full lg:w-[65%] overflow-y-auto p-6 pr-3 space-y-6">
          <TemporalDeltaSection customerName={customerName} />
          <BriefSection name={customerName} />
          <CloudSpendCard customerName={customerName} />
          <PipelineCard customerName={customerName} />
          <ActivityTimeline
            meetings={sse.meetings}
            emails={sse.emails}
            drive={sse.drive}
            loading={sectionLoading}
          />
          <AccountIntelligencePanel customerName={customerName} />
        </main>

        {/* Right column — 35%, sticky scroll */}
        <aside className="hidden lg:block w-[38%] overflow-y-auto p-6 pl-3 space-y-4 border-l border-border/40">
          {/* W3-05: Tile order — Cases first (most actionable), then Contacts, Products, Drive, Stakeholders */}
          <CasesSection cases={sse.cases} loading={sectionLoading} />
          <KeyContacts meetings={sse.meetings} emails={sse.emails} loading={sectionLoading} />
          <SubscriptionsSection products={accountInfo?.products ?? []} loading={accountInfo === null} />
          <DriveSection files={sse.drive} loading={sectionLoading} />
          {/* BKL-G14: StakeholderEngagementPanel moved to bottom of right column */}
          {stakeholderContacts.length > 0 && (
            <div className="bg-surface border border-border rounded-xl p-5">
              <StakeholderEngagementPanel contacts={stakeholderContacts} />
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
