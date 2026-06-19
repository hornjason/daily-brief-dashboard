import { useState, useCallback } from 'react'
import { useApi } from '../hooks/useApi'
import type { CalendarEvent, SupportCase, AccountInfo } from '../types'
import { formatTime, formatDay, formatDate, isToday, isThisWeek } from '../lib/format'
import Modal from './Modal'
import EmptyState from './EmptyState'
import {
  Calendar,
  Clock,
  Video,
  FileText,
  X,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  CheckCircle,
  Users,
  Package,
  ArrowRight,
  Sparkles,
  Loader2,
} from 'lucide-react'

function parseBriefText(text: string): { overview: string; talkingPoints: string[] } {
  const overviewMatch = text.match(/## Account Overview\n([\s\S]*?)(?=\n##)/) ?? text.match(/## Priority Action\n([\s\S]*?)(?=\n##)/)
  const overview = overviewMatch ? overviewMatch[1].replace(/\n?---\s*$/, '').trim().slice(0, 400) : ''
  const talkingMatch = text.match(/## Talking Points[^\n]*\n([\s\S]*?)(?=\n##|$)/)
  const talkingPoints = talkingMatch
    ? talkingMatch[1].split('\n').filter((l) => /^[-*]|\d+\./.test(l.trim()))
        .map((l) => l.replace(/^[-*\d.]+\s*\*{0,2}/, '').replace(/\*{0,2}$/, '').trim().slice(0, 120))
        .filter(Boolean).slice(0, 4)
    : []
  return { overview, talkingPoints }
}

interface CalendarStripProps {
  events: CalendarEvent[]
  allEvents: CalendarEvent[]
  cases: SupportCase[]
  accounts: AccountInfo[]
  loading: boolean
}

interface BriefSummary {
  overview: string
  talkingPoints: string[]
  openCasesNote: string
  cachedAt: string
  date: string
}

// ── Full calendar grid ────────────────────────────────────────────────────────

function getWeekDays(): Date[] {
  const now = new Date()
  const day = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1))
  monday.setHours(0, 0, 0, 0)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return d
  })
}

const HOUR_START = 7
const HOUR_END   = 20
const HOUR_HEIGHT = 56

function eventTop(start: string): number {
  const d = new Date(start)
  return ((d.getHours() - HOUR_START) + d.getMinutes() / 60) * HOUR_HEIGHT
}

function eventHeight(start: string, end: string): number {
  const diff = (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000
  return Math.max(diff * HOUR_HEIGHT, 24)
}

function isSameDay(iso: string, day: Date): boolean {
  const d = new Date(iso)
  return d.getFullYear() === day.getFullYear()
    && d.getMonth() === day.getMonth()
    && d.getDate() === day.getDate()
}

function FullCalendarGrid({ events }: { events: CalendarEvent[] }) {
  const weekDays = getWeekDays()
  const hours = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i)
  const todayStr = new Date().toDateString()
  const gridHeight = (HOUR_END - HOUR_START) * HOUR_HEIGHT

  // Group events by day column index
  const eventsByCol = weekDays.map((day) =>
    events.filter((ev) => isSameDay(ev.start, day))
  )

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[700px]">
        {/* Day headers */}
        <div className="grid grid-cols-[48px_repeat(7,1fr)] border-b border-border">
          <div />
          {weekDays.map((day) => {
            const isCurrentDay = day.toDateString() === todayStr
            return (
              <div key={day.toISOString()} className={`py-2 text-center border-l border-border ${isCurrentDay ? 'bg-accent/5' : ''}`}>
                <div className={`text-xs font-medium ${isCurrentDay ? 'text-accent' : 'text-text-secondary'}`}>
                  {day.toLocaleDateString('en-US', { weekday: 'short' })}
                </div>
                <div className={`text-sm font-semibold mt-0.5 ${isCurrentDay ? 'text-accent' : 'text-text-primary'}`}>
                  {day.getDate()}
                </div>
              </div>
            )
          })}
        </div>

        {/* Grid body: time gutter + 7 day columns via CSS Grid */}
        <div className="grid grid-cols-[48px_repeat(7,1fr)]" style={{ height: `${gridHeight}px` }}>
          {/* Time gutter */}
          <div className="relative">
            {hours.map((hour) => (
              <div
                key={hour}
                className="text-right pr-2 text-xs text-text-secondary select-none absolute w-full"
                style={{ top: `${(hour - HOUR_START) * HOUR_HEIGHT - 7}px` }}
              >
                {hour % 12 === 0 ? '12' : hour % 12}{hour < 12 ? 'a' : 'p'}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {weekDays.map((day, colIndex) => {
            const isCurrentDay = day.toDateString() === todayStr
            const colEvents = eventsByCol[colIndex]

            return (
              <div
                key={day.toISOString()}
                className={`relative border-l border-border/40 ${isCurrentDay ? 'bg-accent/3' : ''}`}
              >
                {/* Hour grid lines */}
                {hours.map((hour) => (
                  <div
                    key={hour}
                    className="absolute w-full border-t border-border/40"
                    style={{ top: `${(hour - HOUR_START) * HOUR_HEIGHT}px`, height: `${HOUR_HEIGHT}px` }}
                  />
                ))}

                {/* Events positioned absolutely within their day column */}
                {colEvents.map((ev, i) => {
                  const isCustomer = ev.customers && ev.customers.length > 0
                  return (
                    <div
                      key={`${ev.title}-${ev.start}-${i}`}
                      className={`absolute left-0.5 right-0.5 rounded px-1.5 py-1 overflow-hidden cursor-pointer transition-opacity hover:opacity-90 ${
                        isCustomer ? 'bg-accent/20 border border-accent/40 text-accent' : 'bg-border/60 border border-border text-text-secondary'
                      }`}
                      style={{
                        top: `${eventTop(ev.start)}px`,
                        height: `${eventHeight(ev.start, ev.end ?? ev.start)}px`,
                        zIndex: 10,
                      }}
                      title={`${ev.title}\n${formatTime(ev.start)}${ev.customers?.length ? '\n' + ev.customers.join(', ') : ''}`}
                    >
                      <div className="text-xs font-medium leading-tight truncate">{ev.title}</div>
                      {eventHeight(ev.start, ev.end ?? ev.start) > 30 && (
                        <div className="text-xs opacity-75 leading-tight truncate">{formatTime(ev.start)}</div>
                      )}
                    </div>
                  )
                })}

                {/* Current-time indicator (red line) */}
                {isCurrentDay && (() => {
                  const now = new Date()
                  const h = now.getHours() + now.getMinutes() / 60
                  if (h < HOUR_START || h > HOUR_END) return null
                  const top = (h - HOUR_START) * HOUR_HEIGHT
                  return (
                    <div className="absolute left-0 right-0 z-20 flex items-center pointer-events-none" style={{ top: `${top}px`, transform: 'translateY(-1px)' }}>
                      <div className="w-2 h-2 rounded-full bg-critical shrink-0" />
                      <div className="h-px bg-critical flex-1" />
                    </div>
                  )
                })()}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Agenda Modal ──────────────────────────────────────────────────────────────

function AgendaModal({ event, onClose }: { event: CalendarEvent; onClose: () => void }) {
  return (
    <Modal open={true} onClose={onClose} title={event.title} icon={Clock} subtitle={`${formatTime(event.start)} · ${formatDay(event.start)}`}>
      {event.customers?.length ? (
        <div className="flex gap-1.5 mb-4 flex-wrap">
          {event.customers.map((c) => (
            <a key={c} href={`/dashboard/customer/${encodeURIComponent(c)}`} className="text-xs px-2 py-0.5 rounded bg-accent/15 text-accent hover:bg-accent/25 transition-colors">{c}</a>
          ))}
        </div>
      ) : null}
      <div className="max-h-80 overflow-y-auto">
        {event.description ? (
          <>
            <div className="text-xs text-text-secondary uppercase tracking-wide mb-2">Agenda / Notes</div>
            <p className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">{event.description}</p>
          </>
        ) : (
          <p className="text-sm text-text-secondary italic">No agenda or notes in this event.</p>
        )}
      </div>
      {(event.joinUrl || event.notesUrl) && (
        <div className="flex items-center gap-3 mt-4 pt-4 border-t border-border">
          {event.joinUrl && (
            <a href={event.joinUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-accent text-bg font-medium hover:bg-accent/80 transition-colors">
              <Video className="w-4 h-4" />Join Meeting
            </a>
          )}
          {event.notesUrl && (
            <a href={event.notesUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:border-accent/50 transition-colors">
              <FileText className="w-4 h-4" />Open Notes
            </a>
          )}
        </div>
      )}
    </Modal>
  )
}

// ── Customer prep card (Today mode) ──────────────────────────────────────────

function CustomerPrepCard({
  ev,
  brief,
  cases,
  accounts,
  onAgendaOpen,
}: {
  ev: CalendarEvent
  brief: BriefSummary | undefined
  cases: SupportCase[]
  accounts: AccountInfo[]
  onAgendaOpen: (ev: CalendarEvent) => void
}) {
  const [agendaExpanded, setAgendaExpanded] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generatedBrief, setGeneratedBrief] = useState<BriefSummary | null>(null)
  const [genError, setGenError] = useState<string | null>(null)
  const customerName = ev.customers?.[0] ?? ''
  const today = Date.now()

  const activeBrief = generatedBrief ?? brief

  const handleGenerate = useCallback(async () => {
    setGenerating(true)
    setGenError(null)
    try {
      const res = await fetch(`/customer/${encodeURIComponent(customerName)}/brief`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      const { overview, talkingPoints } = parseBriefText(json.text)
      setGeneratedBrief({ overview, talkingPoints, openCasesNote: '', cachedAt: json.cachedAt ?? new Date().toISOString(), date: new Date().toLocaleDateString('en-CA') })
    } catch (e: any) {
      setGenError(e.message)
    } finally {
      setGenerating(false)
    }
  }, [customerName])

  const customerCases = cases.filter(
    (c) => c.customerName?.toLowerCase() === customerName.toLowerCase()
  )
  const topCase = [...customerCases].sort((a, b) => parseInt(a.severity) - parseInt(b.severity))[0]
  const hasSev1 = customerCases.some((c) => c.severity === '1')

  const account = accounts.find((a) => a.name.toLowerCase() === customerName.toLowerCase())
  const expiringProducts = (account?.products ?? [])
    .map((p) => ({ ...p, daysLeft: p.endDate ? Math.ceil((new Date(p.endDate).getTime() - today) / 86_400_000) : 9999 }))
    .filter((p) => p.daysLeft < 90 && p.daysLeft > 0)
    .sort((a, b) => a.daysLeft - b.daysLeft)

  const borderColor = hasSev1 ? 'border-l-critical' : customerCases.length > 0 ? 'border-l-warning' : 'border-l-success'

  return (
    <div className={`bg-surface border border-border border-l-4 ${borderColor} rounded-xl flex flex-col`}>
      {/* Header */}
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="text-xs text-accent font-mono font-medium">{formatTime(ev.start)} · {formatDay(ev.start)}</div>
          <div className="flex items-center gap-1.5 shrink-0">
            {ev.notesUrl && (
              <a href={ev.notesUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 px-2 py-1 rounded bg-border/50 text-text-secondary hover:text-text-primary text-xs transition-colors">
                <FileText className="w-3 h-3" />Notes
              </a>
            )}
            {ev.joinUrl && (
              <a href={ev.joinUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 px-2 py-1 rounded bg-accent/10 border border-accent/20 text-accent hover:bg-accent/20 text-xs font-medium transition-colors">
                <Video className="w-3 h-3" />Join
              </a>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text-primary truncate" title={customerName}>{customerName}</div>
            <div className="text-xs text-text-secondary truncate mt-0.5" title={ev.title}>{ev.title}</div>
          </div>
          <a href={`/dashboard/customer/${encodeURIComponent(customerName)}`} className="shrink-0 text-text-secondary hover:text-accent transition-colors" title="Open account detail">
            <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      </div>

      {/* Attendees */}
      {(ev.attendeeDetails?.length || ev.attendees?.length) ? (() => {
        const displays = getAttendeeDisplays(ev)
        const customerAttendees = displays.filter(d => !d.isRedHat)
        const rhAttendees = displays.filter(d => d.isRedHat)
        const visibleCustomer = customerAttendees.slice(0, 3)
        const remaining = customerAttendees.length - 3 + rhAttendees.length
        return (
          <div className="px-4 pb-3 flex items-center gap-1.5 flex-wrap">
            <Users className="w-3 h-3 text-text-secondary shrink-0" />
            {visibleCustomer.map((d) => (
              <span key={d.email} className="text-xs bg-accent/10 text-accent px-1.5 py-0.5 rounded truncate max-w-[160px]" title={d.email}>
                {d.label}
              </span>
            ))}
            {rhAttendees.length > 0 && customerAttendees.length <= 3 && rhAttendees.slice(0, 2).map((d) => (
              <span key={d.email} className="text-xs bg-border/40 text-text-secondary px-1.5 py-0.5 rounded truncate max-w-[140px]" title={d.email}>
                {d.label}
              </span>
            ))}
            {remaining > 3 && <span className="text-xs text-text-secondary">+{remaining - 3}</span>}
          </div>
        )
      })() : null}

      {/* Agenda */}
      {ev.description && (
        <div className="px-4 pb-3">
          <div className="text-xs text-text-secondary uppercase tracking-wide mb-1">Agenda</div>
          <p className={`text-xs text-text-primary leading-relaxed ${agendaExpanded ? '' : 'line-clamp-2'}`}>{ev.description}</p>
          {ev.description.length > 120 && (
            <button onClick={() => setAgendaExpanded((v) => !v)} className="flex items-center gap-0.5 text-xs text-text-secondary hover:text-accent mt-1 transition-colors">
              {agendaExpanded ? <><ChevronUp className="w-3 h-3" />less</> : <><ChevronDown className="w-3 h-3" />more</>}
            </button>
          )}
        </div>
      )}

      {/* Brief overview */}
      {activeBrief?.overview ? (
        <div className="px-4 pb-3">
          <div className="text-xs text-text-secondary uppercase tracking-wide mb-1">Account Overview</div>
          <p className="text-xs text-text-primary leading-relaxed line-clamp-2">{activeBrief.overview}</p>
        </div>
      ) : (
        <div className="px-4 pb-3">
          {generating ? (
            <div className="flex items-center gap-1.5 text-xs text-text-secondary">
              <Loader2 className="w-3 h-3 animate-spin" />
              Generating brief…
            </div>
          ) : genError ? (
            <p className="text-xs text-critical italic">{genError}</p>
          ) : (
            <button
              onClick={handleGenerate}
              className="flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 transition-colors"
            >
              <Sparkles className="w-3 h-3" />
              Generate brief
            </button>
          )}
        </div>
      )}

      {/* Talking points */}
      {activeBrief?.talkingPoints && activeBrief.talkingPoints.length > 0 && (
        <div className="px-4 pb-3">
          <div className="text-xs text-text-secondary uppercase tracking-wide mb-1.5">Talking Points</div>
          <ul className="space-y-1.5">
            {activeBrief.talkingPoints.map((pt, j) => (
              <li key={j} className="text-xs text-text-primary flex gap-1.5 leading-snug">
                <span className="text-accent shrink-0 mt-0.5">·</span>
                <span>{pt}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Footer */}
      <div className="mt-auto px-4 py-3 border-t border-border space-y-2">
        {topCase ? (
          <div className="flex items-start gap-1.5 text-xs">
            <AlertTriangle className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${hasSev1 ? 'text-critical' : 'text-warning'}`} />
            <span className={hasSev1 ? 'text-critical' : 'text-warning'}>
              <span className="font-medium">Sev{topCase.severity}</span>
              {customerCases.length > 1 && ` (+${customerCases.length - 1} more)`}
              {' · '}
              <span className="text-text-secondary line-clamp-1" title={topCase.summary}>{topCase.summary}</span>
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs text-success">
            <CheckCircle className="w-3.5 h-3.5 shrink-0" />No open cases
          </div>
        )}
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
}

// ── Internal meeting card (Today mode) ───────────────────────────────────────

function InternalMeetingCard({ ev, onAgendaOpen }: { ev: CalendarEvent; onAgendaOpen: (ev: CalendarEvent) => void }) {
  return (
    <div className="bg-bg border border-border rounded-xl p-3.5 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5 min-w-0">
          <Clock className="w-3 h-3 text-text-secondary shrink-0" />
          <span className="text-xs font-mono text-text-secondary">{formatTime(ev.start)}</span>
          {ev.organizer && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-border/50 text-text-secondary truncate" title={ev.organizer}>{ev.organizer}</span>
          )}
        </div>
        <p className="text-sm text-text-primary truncate" title={ev.title}>{ev.title}</p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {ev.description && (
          <button onClick={() => onAgendaOpen(ev)} className="text-xs text-text-secondary hover:text-accent transition-colors" aria-label="View agenda">
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
        {ev.joinUrl && (
          <a href={ev.joinUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 px-2 py-1 rounded bg-border/50 text-text-secondary hover:text-text-primary text-xs transition-colors">
            <Video className="w-3 h-3" />Join
          </a>
        )}
      </div>
    </div>
  )
}

// ── Week card (This Week mode) ────────────────────────────────────────────────

function WeekCard({ ev, onAgendaOpen }: { ev: CalendarEvent; onAgendaOpen: (ev: CalendarEvent) => void }) {
  const isCustomer = ev.customers && ev.customers.length > 0
  return (
    <div className={`shrink-0 w-72 p-3.5 rounded-xl border transition-colors flex flex-col gap-2 ${
      isCustomer ? 'border-accent/30 bg-accent/5 hover:bg-accent/10' : 'border-border bg-bg hover:bg-border/20'
    }`}>
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Clock className="w-3.5 h-3.5 text-text-secondary" />
          <span className="text-xs font-mono text-accent">{formatTime(ev.start)}</span>
          <span className="text-xs text-text-secondary">{formatDay(ev.start)}</span>
        </div>
        <div className="text-sm font-medium text-text-primary truncate" title={ev.title}>{ev.title}</div>
      </div>
      {(ev.customers?.length || ev.organizer) ? (
        <div className="flex items-center gap-1.5 flex-wrap">
          {ev.customers?.map((c) => (
            <a key={c} href={`/dashboard/customer/${encodeURIComponent(c)}`} className="text-xs px-2 py-0.5 rounded bg-accent/15 text-accent hover:bg-accent/25 transition-colors">{c}</a>
          ))}
          {ev.organizer && (
            <span className="text-xs px-2 py-0.5 rounded bg-purple-500/15 text-purple-400 border border-purple-500/20">{ev.organizer}</span>
          )}
        </div>
      ) : null}
      {(ev.attendeeDetails?.length || ev.attendees?.length) ? (() => {
        const displays = getAttendeeDisplays(ev)
        const customerAttendees = displays.filter(d => !d.isRedHat)
        const rhAttendees = displays.filter(d => d.isRedHat)
        const visibleCustomer = customerAttendees.slice(0, 3)
        const remainingCount = Math.max(0, customerAttendees.length - 3) + rhAttendees.length
        return (
          <div className="flex items-center gap-1.5 flex-wrap">
            <Users className="w-3 h-3 text-text-secondary shrink-0" />
            {visibleCustomer.map((d) => (
              <span key={d.email} className="text-xs bg-accent/10 text-accent px-1.5 py-0.5 rounded truncate max-w-[140px]" title={d.email}>
                {d.label}
              </span>
            ))}
            {customerAttendees.length === 0 && rhAttendees.slice(0, 2).map((d) => (
              <span key={d.email} className="text-xs bg-border/40 text-text-secondary px-1.5 py-0.5 rounded truncate max-w-[120px]" title={d.email}>
                {d.label}
              </span>
            ))}
            {remainingCount > 0 && <span className="text-xs text-text-secondary">+{remainingCount}</span>}
          </div>
        )
      })() : null}
      {isCustomer && ev.description && (
        <button onClick={() => onAgendaOpen(ev)} className="text-left group">
          <p className="text-xs text-text-secondary leading-relaxed line-clamp-2 group-hover:text-text-primary transition-colors">{ev.description}</p>
          <span className="flex items-center gap-0.5 text-xs text-accent/70 group-hover:text-accent mt-0.5 transition-colors">
            View full agenda <ChevronRight className="w-3 h-3" />
          </span>
        </button>
      )}
      {isCustomer && (ev.joinUrl || ev.notesUrl) && (
        <div className="flex items-center gap-2 pt-1 border-t border-border/50">
          {ev.joinUrl && (
            <a href={ev.joinUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-accent text-bg font-medium hover:bg-accent/80 transition-colors">
              <Video className="w-3 h-3" />Join
            </a>
          )}
          {ev.notesUrl && (
            <a href={ev.notesUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-border text-text-secondary hover:text-text-primary hover:border-accent/50 transition-colors">
              <FileText className="w-3 h-3" />Notes
            </a>
          )}
        </div>
      )}
    </div>
  )
}

// ── Attendee display helpers ─────────────────────────────────────────────────

interface AttendeeDisplay {
  label: string
  isRedHat: boolean
  email: string
}

function getAttendeeDisplays(ev: CalendarEvent): AttendeeDisplay[] {
  const details = ev.attendeeDetails ?? []
  const emails = ev.attendees ?? []

  // If we have attendeeDetails, use them for richer display
  if (details.length > 0) {
    return details.map(d => ({
      label: d.displayName ?? d.email,
      isRedHat: d.email.endsWith('@redhat.com'),
      email: d.email,
    }))
  }

  // Fallback: use raw email list
  return emails.map(email => ({
    label: email,
    isRedHat: email.endsWith('@redhat.com'),
    email,
  }))
}

// ── Main component ────────────────────────────────────────────────────────────

const FOCUS_TITLES = /focus time|lunch|ooo|out of office|holiday/i

function isSoloOrFocus(ev: CalendarEvent): boolean {
  return !!ev.solo || FOCUS_TITLES.test(ev.title)
}

export function CalendarStrip({ events, allEvents, cases, accounts, loading }: CalendarStripProps) {
  const [range, setRange] = useState<'today' | 'week' | 'full'>('today')
  const [modalEvent, setModalEvent] = useState<CalendarEvent | null>(null)
  const [showInternal, setShowInternal] = useState(false)
  const briefsApi = useApi<Record<string, BriefSummary>>('/api/briefs')
  const briefs = briefsApi.data ?? {}

  // Today: use allEvents, strip solo/focus events always
  const todayAll = allEvents
    .filter((ev) => isToday(ev.start) && !isSoloOrFocus(ev))
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
  const todayCustomer = todayAll.filter((ev) => ev.customers && ev.customers.length > 0)
  const todayInternal = todayAll.filter((ev) => !ev.customers || ev.customers.length === 0)
  const visibleInternal = showInternal ? todayInternal : []

  // Week: customer-filtered events
  const weekSorted = [...events]
    .filter((ev) => isThisWeek(ev.start))
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

  // Full: allEvents for grid
  const fullSorted = [...allEvents].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

  const titleMap = { today: "Today's Meetings", week: "This Week", full: "Full Week View" }
  const countLabel = range === 'today'
    ? `${todayCustomer.length} customer${todayCustomer.length === 1 ? '' : 's'}${todayInternal.length > 0 ? ` · ${todayInternal.length} internal` : ''}`
    : range === 'week'
    ? `${weekSorted.length} meeting${weekSorted.length === 1 ? '' : 's'}`
    : ''

  return (
    <>
      {modalEvent && <AgendaModal event={modalEvent} onClose={() => setModalEvent(null)} />}
      <div className="bg-surface border border-border rounded-xl">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Calendar className="w-4 h-4 text-accent shrink-0" />
            <h2 className="text-base font-semibold text-text-primary">{titleMap[range]}</h2>
            {!loading && <span className="text-xs text-text-secondary truncate">{countLabel}</span>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {range === 'today' && todayInternal.length > 0 && (
              <button
                onClick={() => setShowInternal((v) => !v)}
                className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                  showInternal
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-border text-text-secondary hover:text-text-primary'
                }`}
              >
                {showInternal ? 'Hide' : 'Show'} Internal ({todayInternal.length})
              </button>
            )}
            <div className="flex rounded-lg overflow-hidden border border-border text-xs">
              {(['today', 'week', 'full'] as const).map((r, i) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={`px-3 py-1.5 transition-colors ${i > 0 ? 'border-l border-border' : ''} ${
                    range === r ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {r === 'today' ? 'Today' : r === 'week' ? 'This Week' : 'Full'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="p-4">
          {loading ? (
            <div className="space-y-3">
              <div className="h-16 bg-border/50 rounded-xl animate-pulse-slow" />
              <div className="h-16 bg-border/50 rounded-xl animate-pulse-slow" />
            </div>
          ) : range === 'full' ? (
            <FullCalendarGrid events={fullSorted} />
          ) : range === 'week' ? (
            weekSorted.length === 0 ? (
              <EmptyState icon={Calendar} title="No meetings this week" />
            ) : (
              <div className="flex gap-3 overflow-x-auto pb-1">
                {weekSorted.map((ev, i) => (
                  <WeekCard key={`${ev.title}-${ev.start}-${i}`} ev={ev} onAgendaOpen={setModalEvent} />
                ))}
              </div>
            )
          ) : (
            // Today mode
            todayCustomer.length === 0 && todayInternal.length === 0 ? (
              <EmptyState icon={Calendar} title="No meetings today" />
            ) : (
              <div className="space-y-4">
                {/* Customer meetings — full prep cards */}
                {todayCustomer.length > 0 && (
                  <div>
                    {visibleInternal.length > 0 && (
                      <div className="text-xs text-text-secondary uppercase tracking-wide mb-2">Customer Meetings</div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {todayCustomer.map((ev, i) => (
                        <CustomerPrepCard
                          key={`${ev.title}-${ev.start}-${i}`}
                          ev={ev}
                          brief={briefs[ev.customers?.[0] ?? '']}
                          cases={cases}
                          accounts={accounts}
                          onAgendaOpen={setModalEvent}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Internal meetings — compact list, only when toggled on */}
                {visibleInternal.length > 0 && (
                  <div>
                    {todayCustomer.length > 0 && (
                      <div className="text-xs text-text-secondary uppercase tracking-wide mb-2">Internal</div>
                    )}
                    <div className="space-y-2">
                      {visibleInternal.map((ev, i) => (
                        <InternalMeetingCard key={`${ev.title}-${ev.start}-${i}`} ev={ev} onAgendaOpen={setModalEvent} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          )}
        </div>
      </div>
    </>
  )
}
