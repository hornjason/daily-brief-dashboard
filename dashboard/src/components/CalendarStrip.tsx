import { useState } from 'react'
import type { CalendarEvent } from '../types'
import { formatTime, formatDay, isToday, isThisWeek } from '../lib/format'
import { Calendar, Clock, Video, FileText, X, ChevronRight } from 'lucide-react'

interface CalendarStripProps {
  events: CalendarEvent[]
  allEvents: CalendarEvent[]
  loading: boolean
}

// ── Full calendar grid helpers ────────────────────────────────────────────────

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

const HOUR_START = 7   // 7 AM
const HOUR_END   = 20  // 8 PM
const HOUR_HEIGHT = 56 // px per hour

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

// ── Full Calendar View ────────────────────────────────────────────────────────

function FullCalendarGrid({ events }: { events: CalendarEvent[] }) {
  const weekDays = getWeekDays()
  const hours = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i)
  const todayStr = new Date().toDateString()

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[700px]">
        {/* Day headers */}
        <div className="grid grid-cols-[48px_repeat(7,1fr)] border-b border-border mb-0">
          <div />
          {weekDays.map((day) => {
            const isCurrentDay = day.toDateString() === todayStr
            return (
              <div
                key={day.toISOString()}
                className={`py-2 text-center border-l border-border ${isCurrentDay ? 'bg-accent/5' : ''}`}
              >
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

        {/* Time grid */}
        <div
          className="grid grid-cols-[48px_repeat(7,1fr)] relative"
          style={{ height: `${(HOUR_END - HOUR_START) * HOUR_HEIGHT}px` }}
        >
          {/* Hour labels + rows */}
          {hours.map((hour) => (
            <div
              key={hour}
              className="contents"
            >
              <div
                className="text-right pr-2 text-xs text-text-secondary select-none"
                style={{ position: 'absolute', top: `${(hour - HOUR_START) * HOUR_HEIGHT - 7}px`, width: '44px' }}
              >
                {hour % 12 === 0 ? '12' : hour % 12}{hour < 12 ? 'a' : 'p'}
              </div>
              {weekDays.map((day) => (
                <div
                  key={day.toISOString()}
                  className="border-l border-t border-border/40"
                  style={{
                    position: 'absolute',
                    left: `${48 + weekDays.indexOf(day) * (100 / 7)}%`,
                    width: `${100 / 7}%`,
                    top: `${(hour - HOUR_START) * HOUR_HEIGHT}px`,
                    height: `${HOUR_HEIGHT}px`,
                  }}
                />
              ))}
            </div>
          ))}

          {/* Events */}
          {events.map((ev, i) => {
            const colIndex = weekDays.findIndex((day) => isSameDay(ev.start, day))
            if (colIndex === -1) return null
            const isCustomer = ev.customers && ev.customers.length > 0
            const top = eventTop(ev.start)
            const height = eventHeight(ev.start, ev.end ?? ev.start)
            const leftPct = (48 / 700 * 100) + colIndex * ((100 - 48 / 700 * 100) / 7)

            return (
              <div
                key={`${ev.title}-${ev.start}-${i}`}
                className={`absolute rounded px-1.5 py-1 overflow-hidden cursor-pointer transition-opacity hover:opacity-90 ${
                  isCustomer
                    ? 'bg-accent/20 border border-accent/40 text-accent'
                    : 'bg-border/60 border border-border text-text-secondary'
                }`}
                style={{
                  top: `${top}px`,
                  height: `${height}px`,
                  left: `calc(48px + ${colIndex} * ((100% - 48px) / 7) + 2px)`,
                  width: `calc((100% - 48px) / 7 - 4px)`,
                  zIndex: 10,
                }}
                title={`${ev.title}\n${formatTime(ev.start)}${ev.customers?.length ? '\n' + ev.customers.join(', ') : ''}`}
              >
                <div className="text-xs font-medium leading-tight truncate">{ev.title}</div>
                {height > 30 && (
                  <div className="text-xs opacity-75 leading-tight truncate">{formatTime(ev.start)}</div>
                )}
                {height > 44 && ev.customers?.length ? (
                  <div className="text-xs opacity-75 leading-tight truncate">{ev.customers.join(', ')}</div>
                ) : null}
              </div>
            )
          })}

          {/* Current time indicator */}
          {(() => {
            const now = new Date()
            const hours24 = now.getHours() + now.getMinutes() / 60
            if (hours24 < HOUR_START || hours24 > HOUR_END) return null
            const top = (hours24 - HOUR_START) * HOUR_HEIGHT
            const todayCol = weekDays.findIndex((d) => d.toDateString() === todayStr)
            if (todayCol === -1) return null
            return (
              <div
                className="absolute z-20 flex items-center pointer-events-none"
                style={{
                  top: `${top}px`,
                  left: '44px',
                  right: 0,
                  transform: 'translateY(-1px)',
                }}
              >
                <div className="w-2 h-2 rounded-full bg-critical shrink-0 ml-1" />
                <div
                  className="h-px bg-critical flex-1"
                  style={{
                    marginLeft: `calc(${todayCol} * ((100% - 12px) / 7))`,
                    width: `calc((100% - 12px) / 7)`,
                    flex: 'none',
                  }}
                />
              </div>
            )
          })()}
        </div>
      </div>
    </div>
  )
}

// ── Agenda Modal ─────────────────────────────────────────────────────────────

function AgendaModal({ event, onClose }: { event: CalendarEvent; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-border rounded-2xl w-full max-w-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Clock className="w-3.5 h-3.5 text-accent" />
              <span className="text-xs font-mono text-accent">{formatTime(event.start)}</span>
              <span className="text-xs text-text-secondary">{formatDay(event.start)}</span>
            </div>
            <h3 className="text-sm font-semibold text-text-primary">{event.title}</h3>
            {event.customers?.length && (
              <div className="flex gap-1.5 mt-1.5 flex-wrap">
                {event.customers.map((c) => (
                  <a
                    key={c}
                    href={`/customer/${encodeURIComponent(c)}`}
                    className="text-xs px-2 py-0.5 rounded bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
                  >
                    {c}
                  </a>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary transition-colors mt-0.5 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Agenda / description */}
        <div className="px-5 py-4 max-h-80 overflow-y-auto">
          {event.description ? (
            <>
              <div className="text-xs text-text-secondary uppercase tracking-wide mb-2">Agenda / Notes</div>
              <p className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">
                {event.description}
              </p>
            </>
          ) : (
            <p className="text-sm text-text-secondary italic">No agenda or notes in this event.</p>
          )}
        </div>

        {/* Actions */}
        {(event.joinUrl || event.notesUrl) && (
          <div className="px-5 py-3.5 border-t border-border flex items-center gap-3">
            {event.joinUrl && (
              <a
                href={event.joinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-accent text-bg font-medium hover:bg-accent/80 transition-colors"
              >
                <Video className="w-4 h-4" />
                Join Meeting
              </a>
            )}
            {event.notesUrl && (
              <a
                href={event.notesUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:border-accent/50 transition-colors"
              >
                <FileText className="w-4 h-4" />
                Open Notes
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export function CalendarStrip({ events, allEvents, loading }: CalendarStripProps) {
  const [range, setRange] = useState<'today' | 'week' | 'full'>('today')
  const [modalEvent, setModalEvent] = useState<CalendarEvent | null>(null)

  const sourceEvents = range === 'full' ? allEvents : events
  const filtered = sourceEvents.filter((ev) => {
    if (range === 'today') return isToday(ev.start)
    return isThisWeek(ev.start)
  })

  const sorted = [...filtered].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  )

  const title = range === 'today' ? "Today's Meetings"
    : range === 'week'  ? "This Week's Meetings"
    : "Full Week View"

  return (
    <>
    {modalEvent && <AgendaModal event={modalEvent} onClose={() => setModalEvent(null)} />}
    <div className="bg-surface border border-border rounded-xl">
      {/* Header */}
      <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          <span className="text-xs text-text-secondary ml-2">
            {sorted.length} meeting{sorted.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex rounded-lg overflow-hidden border border-border text-xs">
          {(['today', 'week', 'full'] as const).map((r, i) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 transition-colors ${i > 0 ? 'border-l border-border' : ''} ${
                range === r
                  ? 'bg-accent/15 text-accent'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {r === 'today' ? 'Today' : r === 'week' ? 'This Week' : 'Full'}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className={range === 'full' ? 'p-4' : 'p-4'}>
        {loading ? (
          <div className="space-y-3">
            <div className="h-16 bg-border/50 rounded-xl animate-pulse-slow" />
            <div className="h-16 bg-border/50 rounded-xl animate-pulse-slow" />
          </div>
        ) : range === 'full' ? (
          <FullCalendarGrid events={sorted} />
        ) : sorted.length === 0 ? (
          <p className="text-text-secondary text-sm text-center py-6">
            No meetings {range === 'today' ? 'today' : 'this week'}
          </p>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-1">
            {sorted.map((ev, i) => {
              const isCustomer = ev.customers && ev.customers.length > 0
              return (
                <div
                  key={`${ev.title}-${ev.start}-${i}`}
                  className={`shrink-0 w-72 p-3.5 rounded-xl border transition-colors flex flex-col gap-2 ${
                    isCustomer
                      ? 'border-accent/30 bg-accent/5 hover:bg-accent/10'
                      : 'border-border bg-bg hover:bg-border/20'
                  }`}
                >
                  {/* Time + title */}
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Clock className="w-3.5 h-3.5 text-text-secondary" />
                      <span className="text-xs font-mono text-accent">{formatTime(ev.start)}</span>
                      <span className="text-xs text-text-secondary">{formatDay(ev.start)}</span>
                    </div>
                    <div className="text-sm font-medium text-text-primary truncate">
                      {ev.title}
                    </div>
                  </div>

                  {/* Customer tags */}
                  {(ev.customers?.length || ev.organizer) && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {ev.customers?.map((c) => (
                        <a
                          key={c}
                          href={`/customer/${encodeURIComponent(c)}`}
                          className="text-xs px-2 py-0.5 rounded bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
                        >
                          {c}
                        </a>
                      ))}
                      {ev.organizer && (
                        <span className="text-xs px-2 py-0.5 rounded bg-purple-500/15 text-purple-400 border border-purple-500/20">
                          {ev.organizer}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Notes excerpt — customer meetings only, click to expand */}
                  {isCustomer && ev.description && (
                    <button
                      onClick={() => setModalEvent(ev)}
                      className="text-left group"
                    >
                      <p className="text-xs text-text-secondary leading-relaxed line-clamp-2 group-hover:text-text-primary transition-colors">
                        {ev.description}
                      </p>
                      <span className="flex items-center gap-0.5 text-xs text-accent/70 group-hover:text-accent mt-0.5 transition-colors">
                        View full agenda <ChevronRight className="w-3 h-3" />
                      </span>
                    </button>
                  )}

                  {/* Actions — customer meetings only */}
                  {isCustomer && (ev.joinUrl || ev.notesUrl) && (
                    <div className="flex items-center gap-2 pt-1 border-t border-border/50">
                      {ev.joinUrl && (
                        <a
                          href={ev.joinUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-accent text-bg font-medium hover:bg-accent/80 transition-colors"
                        >
                          <Video className="w-3 h-3" />
                          Join
                        </a>
                      )}
                      {ev.notesUrl && (
                        <a
                          href={ev.notesUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-border text-text-secondary hover:text-text-primary hover:border-accent/50 transition-colors"
                        >
                          <FileText className="w-3 h-3" />
                          Notes
                        </a>
                      )}
                    </div>
                  )}

                  {ev.needsPrep && !isCustomer && (
                    <div className="flex items-center gap-1">
                      <div className="w-1.5 h-1.5 rounded-full bg-warning" />
                      <span className="text-xs text-warning">Prep needed</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
    </>
  )
}
