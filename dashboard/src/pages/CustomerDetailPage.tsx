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
} from 'lucide-react'
import { useCustomerSSE } from '../hooks/useCustomerSSE'
import { formatDate, formatTime, formatRelTime } from '../lib/format'

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
    fetch('/api/accounts')
      .then((r) => r.json())
      .then((json) => {
        const acct = (json.customers ?? []).find(
          (c: any) => c.name.toLowerCase() === customerName.toLowerCase()
        )
        if (acct) setInfo({
          productCount: acct.productCount,
          totalLicenses: acct.totalLicenses,
          products: acct.products ?? [],
        })
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

  const sections = useMemo(() => {
    if (!data?.text) return {} as Record<string, string>
    const result: Record<string, string> = {}
    let current = ''
    for (const line of data.text.split('\n')) {
      const h = line.match(/^\*{2}(.+?)\*{2}$/)
      if (h) { current = h[1].trim(); result[current] = '' }
      else if (current) result[current] += line + '\n'
    }
    return result
  }, [data?.text])

  const overview = sections['Account Overview']?.trim() ?? ''
  const talkingPoints = sections['Talking Points & Prep']?.trim() ?? ''
  const casesNote = sections['Open Support Cases']?.trim() ?? ''

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

        {error && !loading && (
          <p className="text-sm text-critical italic">{error}</p>
        )}

        {!loading && !error && data && (
          <div className="space-y-4">
            {overview && (
              <p className={`text-sm text-text-primary leading-relaxed ${!expanded ? 'line-clamp-3' : ''}`}>
                {overview}
              </p>
            )}

            {talkingPoints && expanded && (
              <div>
                <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">Talking Points</p>
                <ul className="space-y-1.5">
                  {talkingPoints.split('\n').filter((l) => /^[-*]|\d+\./.test(l.trim())).map((line, i) => (
                    <li key={i} className="flex gap-2 text-sm text-text-primary">
                      <span className="text-accent mt-0.5 shrink-0">·</span>
                      <span>{line.replace(/^[-*\d.]+\s*\*{0,2}/, '').replace(/\*{0,2}$/, '').trim()}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {casesNote && casesNote !== 'No open support cases.' && expanded && (
              <div className="bg-critical/10 border border-critical/30 rounded-lg px-3 py-2.5">
                <p className="text-xs text-critical font-medium">{casesNote.split('\n')[0]}</p>
              </div>
            )}

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

function CasesSection({ cases, loading }: { cases: { caseNumber: string; summary: string; status: string; severity: string; daysOpen: number; product?: string }[]; loading: boolean }) {
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
            <div key={c.caseNumber} className={`px-3 py-2.5 rounded-lg ${severityBg(c.severity)}`}>
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
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
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

interface Contact {
  email: string
  meetingCount: number
}

function KeyContacts({ meetings, loading }: { meetings: any[]; loading: boolean }) {
  const contacts = useMemo((): Contact[] => {
    const counts = new Map<string, number>()
    for (const ev of meetings) {
      for (const email of ev.attendees ?? []) {
        counts.set(email, (counts.get(email) ?? 0) + 1)
      }
    }
    return Array.from(counts.entries())
      .map(([email, meetingCount]) => ({ email, meetingCount }))
      .sort((a, b) => b.meetingCount - a.meetingCount)
      .slice(0, 8)
  }, [meetings])

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
            const name = c.email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
            const domain = c.email.split('@')[1] ?? ''
            return (
              <div key={c.email} className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-border/60 flex items-center justify-center shrink-0 text-xs font-semibold text-text-secondary">
                  {name[0]?.toUpperCase() ?? '?'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-text-primary truncate">{name}</p>
                  <p className="text-xs text-text-secondary truncate">{domain}</p>
                </div>
                <span className="text-xs text-text-secondary shrink-0">{c.meetingCount}× met</span>
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

          <div className="hidden md:flex items-center gap-2">
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

      {/* Error banner */}
      {sse.error && (
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
          <KeyContacts meetings={sse.meetings} loading={sectionLoading} />
          <DriveSection files={sse.drive} loading={sectionLoading} />
        </aside>
      </div>
    </div>
  )
}
