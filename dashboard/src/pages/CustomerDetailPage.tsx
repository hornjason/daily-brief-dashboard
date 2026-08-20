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
  Activity,
  Target,
  BarChart3,
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
import { AccountPlanPanel } from '../components/AccountPlanPanel'
import { CustomerQueryPanel } from '../components/CustomerQueryPanel'
import PriorityActionBanner from '../components/PriorityActionBanner'
import CustomerSignalBanner from '../components/CustomerSignalBanner'

import CitationTooltip from '../components/CitationTooltip'
import BriefDeltaMarker from '../components/BriefDeltaMarker'
import { renderMarkdownInline } from '../lib/markdown'
import TemporalDeltaSection from '../components/TemporalDeltaSection'
import { IntelligenceChangesCard } from '../components/IntelligenceChangesCard'
import CompetitiveSignalBadge from '../components/CompetitiveSignalBadge'
import StakeholderEngagementPanel from '../components/StakeholderEngagementPanel'
import { StatBadge } from '../components/StatBadge'
import type { PipelineOpp } from '../types'
import { CasesSection } from '../components/CasesSection'
import type { CaseItem } from '../components/CasesSection'
import { KeyContacts } from '../components/KeyContactsSection'
import { SubscriptionsSection } from '../components/SubscriptionsSection'
import { DriveSection } from '../components/DriveSection'
import { ProductIntelSection } from '../components/ProductIntelSection'
import { CustomerTabBar, type AccountTab, type TabEntry } from '../components/CustomerTabBar'
import { CampaignsTab } from '../components/tabs/CampaignsTab'
import { NewsTab } from '../components/tabs/NewsTab'
import { IntelligenceTab } from '../components/tabs/IntelligenceTab'
import { ToolsTab } from '../components/tabs/ToolsTab'
import { PlaybookTab } from '../components/tabs/PlaybookTab'
import { MeetingPrepContent } from './MeetingPrepPage'
import { MeetingPrepView } from '../components/MeetingPrepView'
import { TechStackTab } from '../components/tabs/TechStackTab'
import { CloudMarketplaceDetail } from '../components/CloudMarketplaceDetail'
import { IntelligenceInsightsCard } from '../components/RecommendationCard'
import { ExpansionMotionSection } from '../components/ExpansionMotionSection'
import { ExpansionOpportunitiesPanel } from '../components/ExpansionOpportunitiesPanel'

import { CollapsibleSection } from '../components/CollapsibleSection'
import { SidebarGroup } from '../components/SidebarGroup'
import { ProductOpportunities } from '../components/ProductOpportunities'

// ── Staleness indicators (ADR-037 F6) ────────────────────────────────────────

/** Section-to-module mapping for freshness lookup */
const SECTION_MODULE_MAP: Record<string, string> = {
  'tech-stack': 'tech-stack',
  'cases': 'cases',
  'pipeline': 'pipeline',
  'financials': 'cloud-marketplace',
  'cloud-marketplace': 'cloud-marketplace',
  'competitive-intel': 'competitive-intel',
  'subscriptions': 'subscriptions',
  'product-intel': 'customer-product-intel',
  'intelligence': 'intelligence',
  'activity-timeline': 'emails',
  'product-qa': 'tech-stack',
}

interface FreshnessModule {
  lastRefreshed: string | null
  level: 'fresh' | 'expiring-soon' | 'stale' | 'unknown'
  ttlMs?: number
}

interface RefreshStatusModule {
  status: string
  durationMs?: number
  reason?: string
}

interface RefreshStatus {
  inProgress: string | null
  modules: Record<string, RefreshStatusModule>
}

function useModuleFreshness() {
  const [freshness, setFreshness] = useState<Record<string, FreshnessModule>>({})
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus | null>(null)

  useEffect(() => {
    let active = true

    async function fetchFreshness() {
      try {
        const res = await fetch('/api/admin/freshness')
        if (!res.ok) return
        const data = await res.json()
        if (active) setFreshness(data.modules ?? data)
      } catch { /* silently fail */ }
    }

    async function fetchRefreshStatus() {
      try {
        const res = await fetch('/api/admin/refresh-all/status')
        if (!res.ok) return
        const data = await res.json()
        if (active) setRefreshStatus(data)
      } catch { /* silently fail */ }
    }

    fetchFreshness()
    fetchRefreshStatus()

    const interval = setInterval(() => {
      fetchFreshness()
      fetchRefreshStatus()
    }, 30_000)

    return () => { active = false; clearInterval(interval) }
  }, [])

  return { freshness, refreshStatus }
}

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

function StalenessIndicator({
  sectionName,
  freshness,
  refreshStatus,
}: {
  sectionName: string
  freshness: Record<string, FreshnessModule>
  refreshStatus: RefreshStatus | null
}) {
  const moduleName = SECTION_MODULE_MAP[sectionName]
  if (!moduleName) return null

  // Check if this module is currently being refreshed
  const isRefreshing = refreshStatus?.inProgress === moduleName ||
    refreshStatus?.modules?.[moduleName]?.status === 'in-progress' ||
    refreshStatus?.modules?.[moduleName]?.status === 'pending'

  if (isRefreshing) {
    return (
      <span className="text-xs text-blue-400 flex items-center gap-1">
        <RefreshCw className="w-3 h-3 animate-spin" />
        Refreshing...
      </span>
    )
  }

  const mod = freshness[moduleName]
  if (!mod) return null

  const isStale = mod.level === 'stale'
  const timeStr = relativeTime(mod.lastRefreshed)
  if (!timeStr) return null

  return (
    <span className={`text-xs ${isStale ? 'text-amber-400' : 'text-text-secondary/60'}`}>
      Updated {timeStr}{isStale ? ' (stale)' : ''}
    </span>
  )
}

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
  ccspCustomer: boolean
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
        const ccspCustomer = acct?.ccspCustomer ?? false
        if (acct && (acct.products ?? []).length > 0) {
          setInfo({ productCount: acct.productCount, totalLicenses: acct.totalLicenses, products: acct.products, ccspCustomer })
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
                ccspCustomer,
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
    return <span key={i}>{renderMarkdownInline(part)}</span>
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

  const overview = Object.entries(sections).find(([k]) => k.startsWith('Account Overview') || k.startsWith('Priority Action'))?.[1]?.trim() ?? ''

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
  maxItems = 5,
}: {
  meetings: any[]
  emails: any[]
  drive: any[]
  loading: boolean
  maxItems?: number
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

  const visible = showAll ? items : items.slice(0, maxItems)

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

        {!loading && items.length > maxItems && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="w-full px-5 py-3 text-xs text-text-secondary hover:text-accent transition-colors flex items-center justify-center gap-1.5"
          >
            {showAll ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {showAll ? 'Show less' : `Show ${items.length - maxItems} more`}
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
                  <span className="text-text-secondary">{fmtCurrency(acv)} · {(pct ?? 0).toFixed(0)}%</span>
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
                <span className="text-xs font-medium shrink-0 w-14 overflow-hidden text-ellipsis whitespace-nowrap" style={{ color: stageColor }}>
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

// Tab component mapping (GitHub Issue #240)
const TAB_COMPONENTS: Record<string, React.ComponentType<{ customerName: string }>> = {
  campaigns: CampaignsTab,
  'news-radar': NewsTab,
  'meeting-prep': ({ customerName }: { customerName: string }) => <MeetingPrepContent customerName={customerName} />,
  'meeting-prep-brief': ({ customerName }: { customerName: string }) => <MeetingPrepView customerName={customerName} />,
  tools: ToolsTab,
  intelligence: IntelligenceTab,
  playbook: PlaybookTab,
  'tech-stack': TechStackTab,
}

function renderTabContent(activeTab: string, customerName: string) {
  // Intelligence is always a known component
  if (activeTab === 'intelligence') {
    return <IntelligenceTab customerName={customerName} />
  }

  // Try to find registered component for this module
  const Component = TAB_COMPONENTS[activeTab]
  if (Component) {
    return <Component customerName={customerName} />
  }

  // Fallback for unknown tabs
  return (
    <div className="p-6 flex items-center justify-center h-full">
      <div className="text-center space-y-2">
        <p className="text-sm text-text-secondary">Coming soon</p>
        <p className="text-xs text-text-secondary/60">Tab: {activeTab}</p>
      </div>
    </div>
  )
}

// ── Signal Inventory Panel (GitHub Issue #273) ─────────────────────────────

// ── Structured overview types (#779 Layer 3 compliance) ─────────────────────

interface CustomerOverviewView {
  crossRefBySource: Record<string, { subscription: number; interest: number }>
  ownedProducts: string[]
  expansionProducts: string[]
}

function SignalInventoryPanel({ customerName }: { customerName: string }) {
  const [inventory, setInventory] = useState<any>(null)
  const [overview, setOverview] = useState<CustomerOverviewView | null>(null)
  const [expanded, setExpanded] = useState(false)

  const fetchData = () => {
    // Fetch inventory (source counts) and structured overview (cross-ref) in parallel
    fetch(`/api/customer/${encodeURIComponent(customerName)}/signals/inventory`)
      .then(r => r.ok ? r.json() : null)
      .then(setInventory)
      .catch(() => setInventory(null))
    fetch(`/api/customer/${encodeURIComponent(customerName)}/overview`)
      .then(r => r.ok ? r.json() : null)
      .then(setOverview)
      .catch(() => setOverview(null))
  }

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 30_000)
    return () => clearInterval(interval)
  }, [customerName])

  if (!inventory) return null

  const sources = Object.entries(inventory.sources ?? {}) as [string, { count: number }][]
  const activeSources = sources.filter(([, v]) => v.count > 0).length
  const totalSignals = inventory.totalSignals ?? 0

  // Cross-reference data comes from the structured overview API (#779)
  const crossrefBySource = overview?.crossRefBySource ?? {}
  const ownedProducts = overview?.ownedProducts ?? []
  const expansionProducts = overview?.expansionProducts ?? []

  // Known module names for detecting missing sources
  const ALL_MODULES = ['product-lifecycle', 'rh-rss', 'rh-events', 'ccsp', 'value-maps', 'intelligence', 'customer-docs', 'subscriptions', 'emails', 'cases', 'pipeline', 'customer-product-intel', 'account-plan']
  const presentSources = new Set(sources.map(([k]) => k))
  const missingSources = ALL_MODULES.filter(m => !presentSources.has(m))

  return (
    <div className="bg-bg-secondary/30 rounded-lg border border-border p-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-text-secondary" />
          <span className="text-sm font-medium text-text-primary">Signal Sources</span>
          <span className="text-xs text-text-secondary">
            {activeSources} active · {totalSignals} signals
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); fetchData() }}
            className="p-0.5 text-text-secondary/50 hover:text-accent transition-colors"
            title="Refresh signal inventory"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
          <ChevronDown className={`w-4 h-4 text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {expanded && (
        <div className="mt-3 space-y-1.5">
          {sources.map(([source, info]) => {
            const xref = crossrefBySource[source]
            return (
              <div key={source} className="flex items-center justify-between text-xs py-1 px-2 rounded bg-bg-secondary/50">
                <div className="flex items-center gap-2">
                  <span className="text-green-400">✓</span>
                  <span className="text-text-primary">{source}</span>
                  {xref && xref.subscription > 0 && (
                    <span className="text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded text-xs font-medium border border-green-400/20">
                      {xref.subscription} owned
                    </span>
                  )}
                  {xref && xref.interest > 0 && (
                    <span className="text-accent bg-accent/10 px-1.5 py-0.5 rounded text-xs font-medium border border-accent/20">
                      {xref.interest} expansion
                    </span>
                  )}
                </div>
                <span className="text-text-secondary">{info.count} signal{info.count !== 1 ? 's' : ''}</span>
              </div>
            )
          })}

          {missingSources.map(source => (
            <div key={source} className="flex items-center justify-between text-xs py-1 px-2 rounded bg-bg-secondary/50">
              <div className="flex items-center gap-2">
                <span className="text-red-400">✗</span>
                <span className="text-text-secondary">{source}</span>
              </div>
              <span className="text-text-secondary/50">no data</span>
            </div>
          ))}

          {(ownedProducts.length > 0 || expansionProducts.length > 0) && (
            <div className="pt-2 mt-2 border-t border-border">
              <div className="text-xs text-text-secondary mb-1.5" title="Products detected across all signal sources for this customer. Green = active subscription, blue = expansion opportunity.">
                Products Matched
                <span className="ml-1 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-text-secondary/20 text-[9px] text-text-secondary cursor-help">?</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {ownedProducts.map(p => (
                  <span key={p} className="text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded text-xs font-medium border border-green-400/20 uppercase">
                    {p}
                  </span>
                ))}
                {expansionProducts.map(p => (
                  <span key={p} className="text-accent bg-accent/10 px-1.5 py-0.5 rounded text-xs font-medium border border-accent/20 uppercase">
                    {p}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function CustomerDetailPage() {
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const customerName = decodeURIComponent(name ?? '')
  const customerSlug = customerName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')

  const [activeTab, setActiveTab] = useState<AccountTab>('overview')
  const [widgetOpen, setWidgetOpen] = useState(false)

  const sse = useCustomerSSE(customerName)
  const accountInfo = useAccountInfo(customerName)

  // Per-section staleness (ADR-037 F6)
  const { freshness, refreshStatus } = useModuleFreshness()

  // Fetch tabs from Feature Module Registry (GitHub Issue #240)
  const [tabs, setTabs] = useState<TabEntry[]>([
    { id: 'overview', label: 'Overview', order: 0 },
    { id: 'intelligence', label: 'Intelligence', order: 9999 }
  ])

  useEffect(() => {
    fetch('/api/feature-modules/nav')
      .then(r => r.json())
      .then((modules: Array<{ name: string; accountTab?: { label: string; order?: number } }>) => {
        const moduleTabs = modules
          .filter(m => m.accountTab && (m.name in TAB_COMPONENTS))
          .map(m => ({
            id: m.name,
            label: m.accountTab!.label,
            order: m.accountTab!.order ?? Number.MAX_SAFE_INTEGER
          }))
          .sort((a, b) => a.order - b.order)

        setTabs([
          { id: 'overview', label: 'Overview', order: 0 },
          ...moduleTabs,
          { id: 'intelligence', label: 'Intelligence', order: 9999 }
        ])
      })
      .catch(err => {
        console.warn('[CustomerDetailPage] Failed to fetch module tabs:', err)
        // Fallback to hardcoded tabs on error
      })
  }, [])

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

  // BKL-HERO-18: L4 gating — matches App.tsx:222-223 pattern
  const nodeRoleApi = useApi<{ isL3Only: boolean }>('/api/node-role')
  const isL3Only = nodeRoleApi.data?.isL3Only ?? true

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
  const [healthPopoverOpen, setHealthPopoverOpen] = useState(false)
  const healthPopoverRef = useRef<HTMLDivElement>(null)
  const healthHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!healthPopoverOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (healthPopoverRef.current && !healthPopoverRef.current.contains(e.target as Node)) {
        setHealthPopoverOpen(false)
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setHealthPopoverOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [healthPopoverOpen])
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

  // Per-customer refresh (ADR-037 F5) with completion feedback (#759)
  const [customerRefreshing, setCustomerRefreshing] = useState(false)
  const [refreshResult, setRefreshResult] = useState<'success' | 'error' | null>(null)
  const handleRefreshCustomer = async () => {
    const slug = customerName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    setCustomerRefreshing(true)
    setRefreshResult(null)
    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(slug)}/refresh-all`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        console.error('Customer refresh failed:', (data as { error?: string }).error)
        setRefreshResult('error')
      } else {
        setRefreshResult('success')
        setTimeout(() => setRefreshResult(null), 3000)
      }
    } catch (err) {
      console.error('Network error refreshing customer:', err)
      setRefreshResult('error')
    } finally {
      setCustomerRefreshing(false)
    }
  }

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

        {/* Row 2: hero bar (slim — v2.0 Phase 1) */}
        <div className="py-3 px-6 bg-surface/60 border-b border-border/40">
          <div className="flex items-center gap-4 flex-wrap">
            {/* Health dot + numeric score + breakdown popover */}
            {(sectionLoading || sse.meta !== null) && (
              <div
                ref={healthPopoverRef}
                className="relative flex items-center gap-1.5 shrink-0 cursor-pointer"
                onMouseEnter={() => { healthHoverTimer.current = setTimeout(() => setHealthPopoverOpen(true), 200) }}
                onMouseLeave={() => { if (healthHoverTimer.current) clearTimeout(healthHoverTimer.current) }}
                onClick={() => setHealthPopoverOpen(v => !v)}
              >
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: health.color }}
                  title={health.label}
                />
                {healthScore && (
                  <span className="text-xs font-semibold text-text-primary tabular-nums">{healthScore.score}/100</span>
                )}
                {healthPopoverOpen && healthScore?.breakdown && (
                  <div className="absolute top-full left-0 mt-2 w-80 bg-surface border border-border rounded-xl shadow-lg p-4 z-50">
                    <h4 className="text-sm font-semibold text-text-primary mb-3">Health Score Breakdown</h4>
                    <div className="space-y-2">
                      {Object.entries(healthScore.breakdown).map(([key, { score, signal }]) => (
                        <div key={key}>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-text-secondary capitalize">{key.replace(/-/g, ' ')}</span>
                            <span className="text-text-primary font-medium tabular-nums">{score}/100</span>
                          </div>
                          <div className="h-1.5 bg-border rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{
                                width: `${score}%`,
                                backgroundColor: score >= 70 ? '#22c55e' : score >= 40 ? '#eab308' : '#ef4444',
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
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
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-text-primary">{customerName}</h1>
                {meta?.industry && (
                  <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-full bg-accent/10 text-accent border border-accent/20">
                    {meta.industry}
                  </span>
                )}
              </div>
              {(meta?.ae || meta?.segment) && (
                <span className="text-xs text-text-secondary">
                  {meta.ae ? `AE: ${meta.ae}` : ''}{meta.ae && meta.segment ? ' · ' : ''}{meta.segment ?? ''}
                </span>
              )}
            </div>

            {/* Right-aligned: next meeting + Meeting Prep + refresh */}
            <div className="ml-auto flex items-center gap-4">
              {nextLabel && (
                <div className="flex items-center gap-1.5 text-xs">
                  <Calendar className="w-3.5 h-3.5 text-accent" />
                  <span className="font-semibold text-accent">{nextLabel}</span>
                </div>
              )}
              <button
                onClick={() => setActiveTab('meeting-prep-brief' as any)}
                className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors font-medium"
                title="Open pre-meeting intelligence brief"
              >
                <Zap className="w-3.5 h-3.5" />
                Meeting Prep
              </button>
              <button
                onClick={handleRefreshCustomer}
                disabled={customerRefreshing}
                className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-xs text-text-secondary hover:text-text-primary hover:border-text-secondary transition-all disabled:opacity-50"
                title="Refresh all data sources for this customer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${customerRefreshing ? 'animate-spin' : ''}`} />
                {customerRefreshing ? 'Refreshing...' : 'Refresh'}
              </button>
              {refreshResult === 'success' && <span className="text-green-400 text-xs ml-1">Refreshed</span>}
              {refreshResult === 'error' && <span className="text-red-400 text-xs ml-1">Refresh failed</span>}
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

      {/* Tab bar (GitHub Issue #142, #240) */}
      <CustomerTabBar tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

      {/* Error banner */}
      {sse.error && (
        <div className="bg-warning/10 border-b border-warning/30 px-6 py-2 flex items-center gap-2 text-sm text-warning shrink-0">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {sse.error}
        </div>
      )}

      {/* Tab content area — two-column starts immediately after tab bar */}
      {activeTab === 'overview' ? (
        /* Two-column body (65/35 — BKL-G14) */
        <div className="flex flex-1 overflow-hidden">
          {/* Left column — 65% */}
          <main className="w-full lg:w-[65%] overflow-y-auto p-6 pr-3 space-y-6">
          {/* Priority Action Banner (conditional — v2.0 position 1) */}
          {priorityAction && (
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
          )}

          {/* Account Brief (v2.0 position 2) */}
          <BriefSection name={customerName} />

          {/* Sales Strategy (v2.0 position 3) */}
          <ExpansionMotionSection
            customerSlug={customerName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}
            customerName={customerName}
          />

          {/* Collapsible: Temporal changes (#619) */}
          <CollapsibleSection
            sectionName="temporal-changes"
            title="What Changed"
            icon={<Clock className="w-4 h-4" />}
            summaryText={`Brief-over-brief delta`}
          >
            <div className="p-4 space-y-4">
              <TemporalDeltaSection customerName={customerName} />
              <IntelligenceChangesCard customerSlug={customerName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')} />
            </div>
          </CollapsibleSection>

          {/* Deep Dive — parent collapsible wrapping 4 sub-sections (Phase 3 #1020) */}
          <CollapsibleSection
            sectionName="deep-dive"
            title="Deep Dive"
            icon={<BookOpen className="w-4 h-4" />}
            summaryText="Product Intel · Cloud Spend · Activity · Q&A"
          >
            <div className="p-4 space-y-4">
              {/* Product Intelligence */}
              <CollapsibleSection
                sectionName="product-intel"
                title="Product Intelligence"
                icon={<Package className="w-4 h-4" />}
                summaryText="Product lifecycle and intel"
                summaryExtra={<StalenessIndicator sectionName="product-intel" freshness={freshness} refreshStatus={refreshStatus} />}
              >
                <div className="p-4">
                  <ProductIntelSection
                    customerName={customerName}
                    customerSlug={customerName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}
                  />
                </div>
              </CollapsibleSection>

              {/* Cloud Spend + Pipeline */}
              <CollapsibleSection
                sectionName="financials"
                title="Cloud Spend & Pipeline"
                icon={<Cloud className="w-4 h-4" />}
                summaryText="CCSP revenue and open opps"
                summaryExtra={<StalenessIndicator sectionName="financials" freshness={freshness} refreshStatus={refreshStatus} />}
              >
                <div className="p-4 space-y-4">
                  <CloudSpendCard customerName={customerName} />
                  <PipelineCard customerName={customerName} />
                </div>
              </CollapsibleSection>

              {/* Activity Timeline (compressed Phase 3) */}
              <CollapsibleSection
                sectionName="activity-timeline"
                title="Activity"
                icon={<Clock className="w-4 h-4" />}
                summaryText={(() => {
                  if (sectionLoading) return 'Loading...'
                  const allDates = [
                    ...sse.meetings.map(m => new Date(m.start).getTime()),
                    ...sse.emails.map(e => new Date(e.date).getTime()),
                  ].filter(d => d <= Date.now())
                  const lastContactMs = allDates.length > 0 ? Math.max(...allDates) : 0
                  const lastContactDays = lastContactMs > 0 ? Math.round((Date.now() - lastContactMs) / 86_400_000) : null
                  const thirtyDaysAgo = Date.now() - 30 * 86_400_000
                  const now = new Date()
                  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
                  const mtgsThisMonth = sse.meetings.filter(m => new Date(m.start).getTime() >= monthStart && new Date(m.start).getTime() <= Date.now()).length
                  const emails30d = sse.emails.filter(e => new Date(e.date).getTime() >= thirtyDaysAgo).length
                  const parts: string[] = []
                  if (lastContactDays !== null) parts.push(`Last contact: ${lastContactDays === 0 ? 'today' : `${lastContactDays}d ago`}`)
                  parts.push(`${mtgsThisMonth} meeting${mtgsThisMonth !== 1 ? 's' : ''} this month`)
                  parts.push(`${emails30d} email${emails30d !== 1 ? 's' : ''} in 30d`)
                  return parts.join(' · ')
                })()}
                summaryExtra={<StalenessIndicator sectionName="activity-timeline" freshness={freshness} refreshStatus={refreshStatus} />}
              >
                <div className="p-0">
                  <ActivityTimeline
                    meetings={sse.meetings}
                    emails={sse.emails}
                    drive={sse.drive}
                    loading={sectionLoading}
                    maxItems={5}
                  />
                </div>
              </CollapsibleSection>

            </div>
          </CollapsibleSection>
        </main>

        {/* Right column — 35%, 3 collapsible groups (#1027) */}
        <aside className="hidden lg:block w-[38%] p-6 pl-3 space-y-4 border-l border-border/40">
          {/* Group 1: Opportunities (default expanded) */}
          <SidebarGroup
            title="Opportunities"
            icon={<Target className="w-4 h-4" />}
            defaultExpanded={true}
            storageKey={`${customerSlug}:opportunities`}
          >
            <ProductOpportunities customerName={customerName} />
            <ExpansionOpportunitiesPanel customerName={customerName} />
            <IntelligenceInsightsCard customerName={customerName} />
          </SidebarGroup>

          {/* Group 2: People */}
          <SidebarGroup
            title="People"
            icon={<Users className="w-4 h-4" />}
            storageKey={`${customerSlug}:people`}
          >
            <KeyContacts meetings={sse.meetings} emails={sse.emails} loading={sectionLoading} />
            {stakeholderContacts.length > 0 && (
              <StakeholderEngagementPanel contacts={stakeholderContacts} />
            )}
          </SidebarGroup>

          {/* Group 3: Account Data */}
          <SidebarGroup
            title="Account Data"
            icon={<BarChart3 className="w-4 h-4" />}
            storageKey={`${customerSlug}:account-data`}
          >
            <AccountIntelligencePanel customerName={customerName} />
            <AccountPlanPanel customerName={customerName} />
            <SubscriptionsSection products={accountInfo?.products ?? []} loading={accountInfo === null} ccspCustomer={accountInfo?.ccspCustomer ?? false} />
            {!isL3Only && <CasesSection cases={sse.cases} loading={sectionLoading} />}
            <div className="bg-surface border border-border rounded-xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <Cloud className="w-4 h-4 text-accent" />
                <h2 className="text-base font-semibold text-text-primary">Cloud Marketplace</h2>
                <StalenessIndicator sectionName="cloud-marketplace" freshness={freshness} refreshStatus={refreshStatus} />
              </div>
              <CloudMarketplaceDetail customerName={customerName} />
            </div>
            <DriveSection files={sse.drive} loading={sectionLoading} />
            <SignalInventoryPanel customerName={customerName} />
          </SidebarGroup>
        </aside>
        </div>
      ) : (
        /* Non-Overview tab content (GitHub Issue #240 — dynamic mapping) */
        <div className="flex-1 overflow-y-auto">
          {renderTabContent(activeTab, customerName)}
        </div>
      )}

      {/* Floating Product Q&A Widget — persists across tabs */}
      <div className="fixed bottom-6 right-6 z-50">
        {widgetOpen && (
          <div className="absolute bottom-12 right-0 w-[400px] max-h-[500px] bg-surface border border-border rounded-xl shadow-lg overflow-hidden flex flex-col mb-2">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-text-primary">Ask about {customerName}</h3>
                <p className="text-xs text-text-secondary mt-0.5">AI-powered Q&amp;A across all account data</p>
              </div>
              <button onClick={() => setWidgetOpen(false)} className="text-text-secondary hover:text-text-primary p-1">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <CustomerQueryPanel customerName={customerName} />
            </div>
          </div>
        )}
        <button
          onClick={() => setWidgetOpen(v => !v)}
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-surface border border-accent/30 text-accent text-sm shadow-lg hover:bg-surface-elevated hover:border-accent transition-colors"
        >
          <Sparkles className="w-4 h-4" />
          Ask about this account
        </button>
      </div>
    </div>
  )
}
