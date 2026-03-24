import { useApi } from '../hooks/useApi'
import type { CalendarEvent, SupportCase } from '../types'
import { formatTime, formatDay } from '../lib/format'
import { FileText, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react'
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
  loading: boolean
}

export function MeetingPrepCards({ events, cases, loading }: MeetingPrepCardsProps) {
  const briefsApi = useApi<Record<string, BriefSummary>>('/api/briefs')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-48 bg-surface border border-border rounded-xl animate-pulse-slow" />
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

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <FileText className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">Meeting Prep (Next 48h)</h2>
        <span className="text-xs text-text-secondary">{upcoming.length} meeting{upcoming.length === 1 ? '' : 's'}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {upcoming.map((ev, i) => {
          const customerName = ev.customers?.[0] ?? ''
          const brief = briefs[customerName]
          const customerCases = cases.filter(
            (c) => c.customerName?.toLowerCase() === customerName.toLowerCase()
          )
          const hasCases = customerCases.length > 0
          const hasSev1 = customerCases.some((c) => c.severity === '1')
          const cardKey = `${ev.title}-${ev.start}-${i}`
          const isExpanded = expanded[cardKey] ?? false

          return (
            <div
              key={cardKey}
              className={`bg-surface border rounded-xl border-l-4 flex flex-col ${
                hasCases ? 'border-l-critical border-border' : 'border-l-success border-border'
              }`}
            >
              {/* Header */}
              <div className="p-4 pb-3">
                <div className="flex items-start justify-between mb-1">
                  <div className="text-xs text-accent font-mono">
                    {formatTime(ev.start)} · {formatDay(ev.start)}
                  </div>
                  {brief && (
                    <span className="text-xs text-text-secondary">{brief.date}</span>
                  )}
                </div>
                <div className="text-sm font-semibold text-text-primary">{customerName}</div>
                <div className="text-xs text-text-secondary truncate mt-0.5">{ev.title}</div>
              </div>

              {/* Brief overview */}
              {brief?.overview ? (
                <div className="px-4 pb-3">
                  <div className="text-xs text-text-secondary uppercase tracking-wide mb-1">Account Overview</div>
                  <p className={`text-xs text-text-primary leading-relaxed ${isExpanded ? '' : 'line-clamp-3'}`}>
                    {brief.overview}
                  </p>
                </div>
              ) : (
                <div className="px-4 pb-3">
                  <p className="text-xs text-text-secondary italic">No brief cached — click a customer to generate</p>
                </div>
              )}

              {/* Talking points (expanded only) */}
              {isExpanded && brief?.talkingPoints && brief.talkingPoints.length > 0 && (
                <div className="px-4 pb-3">
                  <div className="text-xs text-text-secondary uppercase tracking-wide mb-1">Talking Points</div>
                  <ul className="space-y-1">
                    {brief.talkingPoints.map((pt, j) => (
                      <li key={j} className="text-xs text-text-primary flex gap-1.5">
                        <span className="text-accent mt-0.5">·</span>
                        <span>{pt}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Footer */}
              <div className="mt-auto px-4 py-3 border-t border-border flex items-center justify-between">
                {hasCases ? (
                  <div className="flex items-center gap-1.5 text-xs">
                    <AlertTriangle className={`w-3.5 h-3.5 ${hasSev1 ? 'text-critical' : 'text-warning'}`} />
                    <span className={hasSev1 ? 'text-critical' : 'text-warning'}>
                      {customerCases.length} open case{customerCases.length === 1 ? '' : 's'}
                      {hasSev1 ? ' (Sev1)' : ''}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-xs text-success">
                    <div className="w-1.5 h-1.5 rounded-full bg-success" />
                    No open cases
                  </div>
                )}

                {brief?.overview && (
                  <button
                    onClick={() => setExpanded((prev) => ({ ...prev, [cardKey]: !isExpanded }))}
                    className="text-xs text-text-secondary hover:text-text-primary flex items-center gap-1 transition-colors"
                  >
                    {isExpanded ? <><ChevronUp className="w-3 h-3" /> Less</> : <><ChevronDown className="w-3 h-3" /> More</>}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
