import { useApi } from '../hooks/useApi'
import type { CalendarEvent, SupportCase, AccountInfo } from '../types'
import { formatTime, formatDay, formatDate } from '../lib/format'
import {
  FileText,
  AlertTriangle,
  Video,
  ExternalLink,
  Users,
  Package,
  ChevronDown,
  ChevronUp,
  ArrowRight,
  CheckCircle,
} from 'lucide-react'
import { useState } from 'react'

interface BriefSummary {
  overview: string
  talkingPoints: string[]
  openCasesNote: string
  cachedAt: string
  date: string
}

interface MeetingPrepCardsProps {
  events: CalendarEvent[]
  cases: SupportCase[]
  accounts: AccountInfo[]
  loading: boolean
}

export function MeetingPrepCards({ events, cases, accounts, loading }: MeetingPrepCardsProps) {
  const briefsApi = useApi<Record<string, BriefSummary>>('/api/briefs')
  const [agendaExpanded, setAgendaExpanded] = useState<Record<string, boolean>>({})

  const cutoff = new Date(Date.now() + 48 * 60 * 60 * 1000)
  const now = new Date()
  const upcoming = events.filter((ev) => {
    const start = new Date(ev.start)
    return start >= now && start <= cutoff && ev.customers && ev.customers.length > 0
  })

  if (loading) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-3">
          <FileText className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">Meeting Prep (Next 48h)</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-64 bg-surface border border-border rounded-xl animate-pulse-slow" />
          ))}
        </div>
      </div>
    )
  }

  if (upcoming.length === 0) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-3">
          <FileText className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">Meeting Prep (Next 48h)</h2>
        </div>
        <div className="bg-surface border border-border rounded-xl p-6 text-center text-text-secondary text-sm">
          No customer meetings in the next 48 hours
        </div>
      </div>
    )
  }

  const briefs = briefsApi.data ?? {}
  const today = Date.now()

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <FileText className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">Meeting Prep (Next 48h)</h2>
        <span className="text-xs text-text-secondary">{upcoming.length} meeting{upcoming.length === 1 ? '' : 's'}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {upcoming.map((ev, i) => {
          const customerName = ev.customers?.[0] ?? ''
          const brief = briefs[customerName]
          const customerCases = cases.filter(
            (c) => c.customerName?.toLowerCase() === customerName.toLowerCase()
          )
          const topCase = customerCases.sort((a, b) => parseInt(a.severity) - parseInt(b.severity))[0]
          const hasSev1 = customerCases.some((c) => c.severity === '1')

          // Expiring products for this customer
          const account = accounts.find((a) => a.name.toLowerCase() === customerName.toLowerCase())
          const expiringProducts = (account?.products ?? [])
            .map((p) => ({
              ...p,
              daysLeft: p.endDate ? Math.ceil((new Date(p.endDate).getTime() - today) / 86_400_000) : 9999,
            }))
            .filter((p) => p.daysLeft < 90 && p.daysLeft > 0)
            .sort((a, b) => a.daysLeft - b.daysLeft)

          const cardKey = `${ev.title}-${ev.start}-${i}`
          const isAgendaExpanded = agendaExpanded[cardKey] ?? false

          const borderColor = hasSev1
            ? 'border-l-critical'
            : customerCases.length > 0
            ? 'border-l-warning'
            : 'border-l-success'

          return (
            <div
              key={cardKey}
              className={`bg-surface border border-border border-l-4 ${borderColor} rounded-xl flex flex-col`}
            >
              {/* ── Header ── */}
              <div className="px-4 pt-4 pb-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="text-xs text-accent font-mono font-medium">
                    {formatTime(ev.start)} · {formatDay(ev.start)}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {ev.notesUrl && (
                      <a
                        href={ev.notesUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 px-2 py-1 rounded bg-border/50 text-text-secondary hover:text-text-primary text-xs transition-colors"
                        title="Open meeting notes"
                      >
                        <FileText className="w-3 h-3" />
                        Notes
                      </a>
                    )}
                    {ev.joinUrl && (
                      <a
                        href={ev.joinUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 px-2 py-1 rounded bg-accent/10 border border-accent/20 text-accent hover:bg-accent/20 text-xs font-medium transition-colors"
                        title="Join meeting"
                      >
                        <Video className="w-3 h-3" />
                        Join
                      </a>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-text-primary truncate">{customerName}</div>
                    <div className="text-xs text-text-secondary truncate mt-0.5">{ev.title}</div>
                  </div>
                  <a
                    href={`/dashboard/customer/${encodeURIComponent(customerName)}`}
                    className="shrink-0 text-text-secondary hover:text-accent transition-colors"
                    title="Open account detail"
                  >
                    <ArrowRight className="w-4 h-4" />
                  </a>
                </div>
              </div>

              {/* ── Attendees ── */}
              {ev.attendees && ev.attendees.length > 0 && (
                <div className="px-4 pb-3 flex items-center gap-1.5 flex-wrap">
                  <Users className="w-3 h-3 text-text-secondary shrink-0" />
                  {ev.attendees.slice(0, 3).map((email) => (
                    <span
                      key={email}
                      className="text-xs bg-border/40 text-text-secondary px-1.5 py-0.5 rounded truncate max-w-[120px]"
                      title={email}
                    >
                      {email.split('@')[0]}
                    </span>
                  ))}
                  {ev.attendees.length > 3 && (
                    <span className="text-xs text-text-secondary">+{ev.attendees.length - 3}</span>
                  )}
                </div>
              )}

              {/* ── Agenda / description ── */}
              {ev.description && (
                <div className="px-4 pb-3">
                  <div className="text-xs text-text-secondary uppercase tracking-wide mb-1">Agenda</div>
                  <p className={`text-xs text-text-primary leading-relaxed ${isAgendaExpanded ? '' : 'line-clamp-2'}`}>
                    {ev.description}
                  </p>
                  {ev.description.length > 120 && (
                    <button
                      onClick={() => setAgendaExpanded((p) => ({ ...p, [cardKey]: !isAgendaExpanded }))}
                      className="flex items-center gap-0.5 text-xs text-text-secondary hover:text-accent mt-1 transition-colors"
                    >
                      {isAgendaExpanded
                        ? <><ChevronUp className="w-3 h-3" />less</>
                        : <><ChevronDown className="w-3 h-3" />more</>
                      }
                    </button>
                  )}
                </div>
              )}

              {/* ── Brief overview ── */}
              {brief?.overview ? (
                <div className="px-4 pb-3">
                  <div className="text-xs text-text-secondary uppercase tracking-wide mb-1">Account Overview</div>
                  <p className="text-xs text-text-primary leading-relaxed line-clamp-2">{brief.overview}</p>
                </div>
              ) : (
                <div className="px-4 pb-3">
                  <p className="text-xs text-text-secondary italic">No brief cached</p>
                </div>
              )}

              {/* ── Talking points ── */}
              {brief?.talkingPoints && brief.talkingPoints.length > 0 && (
                <div className="px-4 pb-3">
                  <div className="text-xs text-text-secondary uppercase tracking-wide mb-1.5">Talking Points</div>
                  <ul className="space-y-1.5">
                    {brief.talkingPoints.map((pt, j) => (
                      <li key={j} className="text-xs text-text-primary flex gap-1.5 leading-snug">
                        <span className="text-accent shrink-0 mt-0.5">·</span>
                        <span>{pt}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* ── Footer: cases + renewals ── */}
              <div className="mt-auto px-4 py-3 border-t border-border space-y-2">
                {/* Top case */}
                {topCase ? (
                  <div className="flex items-start gap-1.5 text-xs">
                    <AlertTriangle className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${hasSev1 ? 'text-critical' : 'text-warning'}`} />
                    <span className={hasSev1 ? 'text-critical' : 'text-warning'}>
                      <span className="font-medium">Sev{topCase.severity}</span>
                      {customerCases.length > 1 && ` (+${customerCases.length - 1} more)`}
                      {' · '}
                      <span className="text-text-secondary line-clamp-1">{topCase.summary}</span>
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-xs text-success">
                    <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                    No open cases
                  </div>
                )}

                {/* Expiring products */}
                {expiringProducts.length > 0 && (
                  <div className="flex items-start gap-1.5 text-xs">
                    <Package className="w-3.5 h-3.5 shrink-0 mt-0.5 text-warning" />
                    <span className="text-warning">
                      <span className="font-medium">Renewal:</span>{' '}
                      <span className="text-text-secondary">
                        {expiringProducts[0].productDescription} — {expiringProducts[0].daysLeft}d
                        {expiringProducts.length > 1 && ` (+${expiringProducts.length - 1} more)`}
                      </span>
                    </span>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
