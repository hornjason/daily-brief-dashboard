/**
 * MeetingPrepPage — Module page for meeting preparation
 * GitHub Issue #229
 *
 * Meeting-first flow: shows all upcoming meetings from calendar,
 * grouped by day. Each meeting shows auto-detected customer.
 * Select any meeting → generate prep doc.
 * Route: /dashboard/meeting-prep
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { ModulePageShell, useModulePage } from '../components/ModulePageShell'
import { useApi } from '../hooks/useApi'
import { FileText, Calendar, Clock, Users, ExternalLink, Loader2, CheckCircle, AlertCircle, ChevronRight, Filter, Trash2, X, Target } from 'lucide-react'

interface CalendarEvent {
  title: string
  start: string
  end: string
  attendees?: string[]
  attendeeDetails?: Array<{ email: string; displayName?: string; linkedinUrl?: string }>
  customers?: string[]
  needsPrep?: boolean
  solo?: boolean
  joinUrl?: string
  recurringEventId?: string
  description?: string
}

interface PrepHistoryEntry {
  meetingTitle: string
  meetingStart: string
  docUrl: string
  title: string
  generatedAt: string
  customerName?: string
}

type GenerationStep = 'idle' | 'researching' | 'loading' | 'generating' | 'saving' | 'done' | 'error'

const STEP_LABELS: Record<GenerationStep, string> = {
  idle: '',
  researching: 'Researching attendees...',
  loading: 'Loading intelligence...',
  generating: 'Generating document...',
  saving: 'Saving to Drive...',
  done: 'Complete',
  error: 'Generation failed',
}

const STEP_ORDER: GenerationStep[] = ['researching', 'loading', 'generating', 'saving', 'done']

function formatDate(iso: string) {
  // Date-only strings (YYYY-MM-DD) are parsed as UTC midnight.
  // Append T12:00 to avoid timezone shift showing the wrong day.
  const d = iso.length === 10 ? new Date(iso + 'T12:00:00') : new Date(iso)
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function formatTime(start: string, end: string) {
  const s = new Date(start)
  const e = new Date(end)
  return `${s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} – ${e.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}

function formatDateShort(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function MeetingCard({
  meeting,
  onPrep,
  generatingKey,
  generationStep,
  generationResult,
  generationError,
  accounts,
  highlighted,
}: {
  meeting: CalendarEvent
  onPrep: (meeting: CalendarEvent, overrideCustomer?: string, context?: { objective?: string; productFocus?: string[]; notes?: string }) => void
  generatingKey: string | null
  generationStep: GenerationStep
  generationResult: { docUrl: string; title: string } | null
  generationError: string | null
  accounts: string[]
  /** #661: Whether this meeting card should be highlighted (scrolled-to + visually emphasized) */
  highlighted?: boolean
}) {
  const meetingKey = `${meeting.title}:${meeting.start}`
  const isGenerating = generatingKey === meetingKey && !['idle', 'done', 'error'].includes(generationStep)
  const isDone = generatingKey === meetingKey && generationStep === 'done'
  const hasError = generatingKey === meetingKey && generationStep === 'error'
  const cardRef = useRef<HTMLDivElement>(null)

  const attendeeList = (meeting.attendees ?? []).filter(Boolean)
  const autoCustomer = meeting.customers?.[0]
  const [manualCustomer, setManualCustomer] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  // #661: Auto-show context panel when this card is highlighted from a recommendation
  const [showContext, setShowContext] = useState(highlighted ?? false)

  // #661: Scroll highlighted card into view on mount
  useEffect(() => {
    if (highlighted && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [highlighted])
  const [objective, setObjective] = useState('')
  const [notes, setNotes] = useState('')
  const [linkedinUrls, setLinkedinUrls] = useState<Record<string, string>>({})
  // Initialize attendee names from calendar displayName if available
  const [attendeeNames, setAttendeeNames] = useState<Record<string, string>>(() => {
    const names: Record<string, string> = {}
    for (const detail of meeting.attendeeDetails ?? []) {
      if (detail.displayName) names[detail.email] = detail.displayName
    }
    return names
  })
  const customerMatch = manualCustomer ?? autoCustomer

  const handleGenerate = () => {
    const context = (objective || notes) ? {
      objective: objective || undefined,
      notes: notes || undefined,
    } : undefined
    // Merge attendee names and LinkedIn URLs into attendeeDetails for this meeting
    const enrichedMeeting = { ...meeting }
    const hasNames = Object.values(attendeeNames).some(v => v.trim())
    const hasUrls = Object.values(linkedinUrls).some(v => v.trim())
    if (hasNames || hasUrls) {
      const existingDetails = meeting.attendeeDetails ?? []
      const externalAttendees = (meeting.attendees ?? []).filter(e => !e.endsWith('@redhat.com'))
      enrichedMeeting.attendeeDetails = externalAttendees.map(email => {
        const existing = existingDetails.find(d => d.email === email)
        return {
          email,
          displayName: attendeeNames[email]?.trim() || existing?.displayName,
          ...(linkedinUrls[email] ? { linkedinUrl: linkedinUrls[email] } : {}),
        }
      })
    }
    onPrep(enrichedMeeting, manualCustomer ?? undefined, context)
    setShowContext(false)
  }

  return (
    <div ref={cardRef} className={`p-4 rounded-lg bg-surface border transition-colors ${
      highlighted ? 'border-accent/50 ring-1 ring-accent/20' : 'border-border/50 hover:border-border'
    }`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-text-primary">{meeting.title}</h3>
          <div className="flex items-center gap-3 mt-1.5 text-xs text-text-secondary">
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatTime(meeting.start, meeting.end)}
            </span>
            {meeting.recurringEventId && (
              <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/30 text-xs">
                Recurring
              </span>
            )}
            {customerMatch && (
              <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/30 text-xs">
                {customerMatch}
              </span>
            )}
          </div>
          {attendeeList.length > 0 && (
            <div className="flex items-center gap-1 mt-2 text-xs text-text-secondary">
              <Users className="w-3 h-3 shrink-0" />
              <span className="truncate">
                {attendeeList.slice(0, 4).map(email => {
                  const detail = (meeting.attendeeDetails ?? []).find(d => d.email === email)
                  return detail?.displayName ? `${detail.displayName} (${email})` : email
                }).join(', ')}
                {attendeeList.length > 4 ? ` +${attendeeList.length - 4}` : ''}
              </span>
            </div>
          )}
          {meeting.description && (
            <p className="mt-2 text-xs text-text-secondary/80 line-clamp-2 italic">
              {meeting.description}
            </p>
          )}
          {!autoCustomer && !manualCustomer && (
            <button
              onClick={() => setShowPicker(!showPicker)}
              className="mt-2 text-xs text-accent hover:text-accent/80 transition-colors flex items-center gap-1"
            >
              <ChevronRight className={`w-3 h-3 transition-transform ${showPicker ? 'rotate-90' : ''}`} />
              Tag as customer meeting
            </button>
          )}
          {manualCustomer && !autoCustomer && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/30">
                {manualCustomer}
              </span>
              <button onClick={() => { setManualCustomer(null); setShowPicker(false) }} className="text-xs text-text-secondary hover:text-text-primary">✕</button>
            </div>
          )}
          {showPicker && !manualCustomer && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {accounts.map(name => (
                <button
                  key={name}
                  onClick={() => { setManualCustomer(name); setShowPicker(false) }}
                  className="text-xs px-2 py-1 rounded bg-surface-hover border border-border text-text-secondary hover:text-text-primary hover:border-accent transition-colors"
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-2">
          {isDone && generationResult ? (
            generationResult.docUrl ? (
              <a
                href={generationResult.docUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-green-400 bg-green-400/10 rounded-md hover:bg-green-400/20 transition-colors"
              >
                <CheckCircle className="w-3.5 h-3.5" />
                View Doc
                <ExternalLink className="w-3 h-3" />
              </a>
            ) : (
              <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-yellow-400 bg-yellow-400/10 rounded-md">
                <AlertCircle className="w-3.5 h-3.5" />
                Doc saved to Drive
              </div>
            )
          ) : isGenerating ? (
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>{STEP_LABELS[generationStep]}</span>
            </div>
          ) : hasError ? (
            <button
              onClick={() => onPrep(meeting)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-400 hover:text-red-300 transition-colors"
            >
              <AlertCircle className="w-3.5 h-3.5" />
              Retry
            </button>
          ) : (
            <button
              onClick={() => setShowContext(!showContext)}
              title={customerMatch ? `Prep for ${customerMatch}` : 'General meeting prep'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors text-accent bg-accent/10 hover:bg-accent/20"
            >
              <FileText className="w-3.5 h-3.5" />
              {customerMatch ? 'Prep Now' : 'Quick Prep'}
            </button>
          )}
        </div>
      </div>

      {/* Context input panel — required before generation */}
      {showContext && !isGenerating && !isDone && (
        <div className="mt-3 pt-3 border-t border-border/30 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Meeting Context</span>
            <button onClick={() => setShowContext(false)} className="text-text-secondary hover:text-text-primary">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">
              What is the goal of this meeting? <span className="text-red-400">*</span>
            </label>
            <textarea
              value={objective}
              onChange={e => setObjective(e.target.value)}
              placeholder="e.g., This is a recurring OpenShift cadence call to discuss their OCP adoption, review open items, and align on next steps for cluster expansion..."
              rows={2}
              className="w-full text-xs px-3 py-2 rounded-md bg-surface-hover border border-border/50 text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent resize-none"
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">Additional context (optional)</label>
            <p className="text-xs text-text-secondary/70 mb-1">
              e.g., Insight is the preferred partner. Customer evaluating 3 clusters for edge deployment...
            </p>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Add any relevant background, partner relationships, or recent developments..."
              rows={2}
              className="w-full text-xs px-3 py-2 rounded-md bg-surface-hover border border-border/50 text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent resize-none"
            />
          </div>
          {/* Attendee details — name + LinkedIn URL inputs for external attendees (#385, #430) */}
          {attendeeList.filter(e => !e.endsWith('@redhat.com')).length > 0 && (
            <div>
              <label className="text-xs text-text-secondary block mb-1">Attendee Details (optional)</label>
              <p className="text-xs text-text-secondary/70 mb-2">
                Add names for attendees the system couldn't identify from the calendar invite
              </p>
              <div className="space-y-3">
                {attendeeList.filter(e => !e.endsWith('@redhat.com')).map(email => (
                  <div key={email} className="space-y-1">
                    <span className="text-xs text-text-secondary font-medium" title={email}>{email}</span>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 flex items-center gap-1">
                        <span className="text-xs text-text-secondary/60 shrink-0">Name:</span>
                        <input
                          type="text"
                          value={attendeeNames[email] ?? ''}
                          onChange={e => setAttendeeNames(prev => ({ ...prev, [email]: e.target.value }))}
                          placeholder="e.g., Sarah Kim, IT Director"
                          className="flex-1 text-xs px-2 py-1 rounded-md bg-surface-hover border border-border/50 text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent"
                        />
                      </div>
                      <div className="flex-1 flex items-center gap-1">
                        <span className="text-xs text-text-secondary/60 shrink-0">LinkedIn:</span>
                        <input
                          type="url"
                          value={linkedinUrls[email] ?? ''}
                          onChange={e => setLinkedinUrls(prev => ({ ...prev, [email]: e.target.value }))}
                          placeholder="https://linkedin.com/in/..."
                          className="flex-1 text-xs px-2 py-1 rounded-md bg-surface-hover border border-border/50 text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={handleGenerate}
              disabled={!objective.trim()}
              className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md transition-colors ${
                objective.trim()
                  ? 'text-white bg-accent hover:bg-accent/90'
                  : 'text-text-secondary bg-surface-hover cursor-not-allowed'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              Generate Prep Doc
            </button>
            {!objective.trim() && (
              <span className="text-xs text-text-secondary">Enter the meeting goal to continue</span>
            )}
          </div>
        </div>
      )}

      {isGenerating && (
        <div className="mt-3 pt-3 border-t border-border/30">
          <div className="flex items-center gap-2">
            {STEP_ORDER.slice(0, -1).map((step, i) => {
              const currentIdx = STEP_ORDER.indexOf(generationStep)
              const isActive = i === currentIdx
              const isComplete = i < currentIdx
              return (
                <div key={step} className="flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full transition-colors ${
                    isComplete ? 'bg-green-400' : isActive ? 'bg-accent animate-pulse' : 'bg-surface-hover'
                  }`} />
                  {i < STEP_ORDER.length - 2 && (
                    <div className={`w-6 h-px ${isComplete ? 'bg-green-400' : 'bg-surface-hover'}`} />
                  )}
                </div>
              )
            })}
          </div>
          <p className="text-xs text-text-secondary mt-1.5">{STEP_LABELS[generationStep]}</p>
        </div>
      )}

      {hasError && generationError && (
        <div className="mt-3 pt-3 border-t border-border/30">
          <p className="text-xs text-red-400/80">{generationError}</p>
        </div>
      )}
    </div>
  )
}

function useGenerationProgress() {
  const [step, setStep] = useState<GenerationStep>('idle')
  const simulateProgress = useCallback(() => {
    setStep('researching')
    setTimeout(() => setStep('loading'), 3000)
    setTimeout(() => setStep('generating'), 8000)
  }, [])
  const complete = useCallback(() => setStep('done'), [])
  const fail = useCallback(() => setStep('error'), [])
  const reset = useCallback(() => setStep('idle'), [])
  return { step, simulateProgress, complete, fail, reset }
}

export function MeetingPrepContent({ customerName: propCustomer }: { customerName?: string } = {}) {
  const { customer: contextCustomer } = useModulePage()
  const customer = propCustomer ?? contextCustomer

  // #661: Read highlight param from URL for auto-selecting a meeting
  const highlightParam = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('highlight') || ''
  }, [])

  // Fetch ALL calendar events (no customer filter required)
  const calendarApi = useApi<{ events: CalendarEvent[]; range: string }>('/api/calendar?range=week&all=true')
  const [history, setHistory] = useState<PrepHistoryEntry[]>([])
  const [historyCustomer, setHistoryCustomer] = useState<string | null>(null)

  // Generation state
  const [generatingKey, setGeneratingKey] = useState<string | null>(null)
  const [generationResult, setGenerationResult] = useState<{ docUrl: string; title: string } | null>(null)
  const [generationError, setGenerationError] = useState<string | null>(null)
  const { step, simulateProgress, complete, fail, reset } = useGenerationProgress()

  // Fetch history for selected customer
  useEffect(() => {
    if (!customer) { setHistory([]); setHistoryCustomer(null); return }
    setHistoryCustomer(customer)
    fetch(`/api/customer/${encodeURIComponent(customer)}/meeting-prep/history`)
      .then(r => r.ok ? r.json() : { history: [] })
      .then(d => setHistory(d.history ?? []))
      .catch(() => setHistory([]))
  }, [customer])

  // Filter: show all meetings or only customer-matched
  // When embedded in account tab (propCustomer set), default to customer-only
  const [showAll, setShowAll] = useState(false)

  // Group meetings by date
  const groupedMeetings = useMemo(() => {
    const events = calendarApi.data?.events ?? []

    // When propCustomer is set (embedded in account tab), strictly filter to that customer
    if (propCustomer && !showAll) {
      const customerOnly = events.filter(e =>
        e.customers?.some(c => c.toLowerCase() === propCustomer.toLowerCase())
      )
      const sorted = [...customerOnly].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
      const groups: Record<string, CalendarEvent[]> = {}
      for (const evt of sorted) {
        const d = new Date(evt.start)
        const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        if (!groups[dateKey]) groups[dateKey] = []
        groups[dateKey].push(evt)
      }
      return groups
    }

    const external = showAll
      ? events
      : events.filter(e => (e.customers?.length ?? 0) > 0)

    // If customer selected, show customer meetings first, then others
    const sorted = customer
      ? [...external].sort((a, b) => {
          const aMatch = a.customers?.some(c => c.toLowerCase() === customer.toLowerCase()) ? 0 : 1
          const bMatch = b.customers?.some(c => c.toLowerCase() === customer.toLowerCase()) ? 0 : 1
          if (aMatch !== bMatch) return aMatch - bMatch
          return new Date(a.start).getTime() - new Date(b.start).getTime()
        })
      : [...external].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

    const groups: Record<string, CalendarEvent[]> = {}
    for (const evt of sorted) {
      // Use local date for grouping — toISOString() shifts to UTC which can move the day
      const d = new Date(evt.start)
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      if (!groups[dateKey]) groups[dateKey] = []
      groups[dateKey].push(evt)
    }
    return groups
  }, [calendarApi.data, customer, propCustomer, showAll])

  // Fetch account names for manual customer tagging
  const accountsApi = useApi<{ customers: { name: string }[] }>('/api/accounts')
  const accountNames = useMemo(() =>
    (accountsApi.data?.customers ?? []).map(c => c.name).sort(),
    [accountsApi.data]
  )

  const handlePrep = async (meeting: CalendarEvent, overrideCustomer?: string, context?: { objective?: string; productFocus?: string[]; notes?: string }) => {
    const customerName = overrideCustomer ?? meeting.customers?.[0] ?? '_general'

    const meetingKey = `${meeting.title}:${meeting.start}`
    setGeneratingKey(meetingKey)
    setGenerationResult(null)
    setGenerationError(null)
    reset()
    simulateProgress()

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 180_000) // 3 min timeout

      const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/meeting-prep/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingTitle: meeting.title,
          meetingStart: meeting.start,
          attendees: meeting.attendees ?? [],
          attendeeDetails: meeting.attendeeDetails,
          recurringEventId: meeting.recurringEventId,
          ...(context ? { context } : {}),
        }),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Generation failed' }))
        throw new Error(err.error ?? 'Generation failed')
      }

      const result = await res.json()
      setGenerationResult({ docUrl: result.docUrl, title: result.title })
      complete()

      if (customerName !== '_general') {
        fetch(`/api/customer/${encodeURIComponent(customerName)}/meeting-prep/history`)
          .then(r => r.ok ? r.json() : { history: [] })
          .then(d => setHistory(d.history ?? []))
          .catch(() => {})
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        // Timeout — check if the doc was actually created
        try {
          const histRes = await fetch(`/api/customer/${encodeURIComponent(customerName)}/meeting-prep/history`)
          const histData = await histRes.json()
          const latest = histData.history?.[0]
          if (latest && new Date(latest.generatedAt).getTime() > Date.now() - 300_000) {
            setGenerationResult({ docUrl: latest.docUrl, title: latest.title })
            complete()
            setHistory(histData.history)
            return
          }
        } catch { /* fall through to error */ }
      }
      setGenerationError(e.message ?? 'Generation failed')
      fail()
    }
  }

  const handleDelete = async (index: number) => {
    const entry = history[index]
    const target = entry?.customerName || customer || historyCustomer
    if (!target) return
    if (!confirm(`Delete "${entry.title || entry.meetingTitle}"?\nThis will also remove the Google Drive document.`)) return

    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(target)}/meeting-prep/${index}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        setHistory(prev => prev.filter((_, i) => i !== index))
      }
    } catch { /* silent */ }
  }

  const dateKeys = Object.keys(groupedMeetings).sort()
  const totalMeetings = dateKeys.reduce((sum, k) => sum + groupedMeetings[k].length, 0)

  // #661: Determine which meeting to highlight
  // If highlight param matches a meeting title (substring match), highlight it
  // If only one upcoming customer meeting exists, highlight it automatically
  const highlightedMeetingKey = useMemo(() => {
    if (!customer) return ''
    const allMeetings = dateKeys.flatMap(k => groupedMeetings[k])
    const customerMeetings = allMeetings.filter(m =>
      m.customers?.some(c => c.toLowerCase() === customer.toLowerCase())
    )

    if (highlightParam) {
      const match = customerMeetings.find(m =>
        m.title.toLowerCase().includes(highlightParam.toLowerCase())
      )
      if (match) return `${match.title}:${match.start}`
    }

    // Auto-highlight if only one upcoming customer meeting
    if (customerMeetings.length === 1) {
      return `${customerMeetings[0].title}:${customerMeetings[0].start}`
    }

    return ''
  }, [dateKeys, groupedMeetings, customer, highlightParam])

  if (calendarApi.loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      {/* Summary + filter toggle */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-text-secondary">
          {totalMeetings} {showAll ? 'total' : 'customer'} meeting{totalMeetings !== 1 ? 's' : ''}
          {customer && <span className="text-accent ml-1">· filtered for {customer}</span>}
        </div>
        <button
          onClick={() => setShowAll(!showAll)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            showAll
              ? 'text-accent bg-accent/10 border border-accent/30'
              : 'text-text-secondary bg-surface-hover border border-border/50 hover:text-text-primary'
          }`}
        >
          <Filter className="w-3.5 h-3.5" />
          {showAll ? 'All Meetings' : 'Customer Only'}
        </button>
      </div>

      {/* Meetings grouped by date */}
      {dateKeys.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-12">
          <div className="text-center space-y-3 max-w-md">
            <Calendar className="w-12 h-12 text-text-secondary mx-auto" />
            <p className="text-sm text-text-secondary">No upcoming meetings with external attendees found.</p>
          </div>
        </div>
      ) : (
        dateKeys.map(dateKey => (
          <div key={dateKey}>
            <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">
              {formatDate(dateKey)}
            </h3>
            <div className="space-y-2">
              {groupedMeetings[dateKey].map((meeting, i) => {
                const meetingKey = `${meeting.title}:${meeting.start}`
                return (
                  <MeetingCard
                    key={`${meeting.title}-${meeting.start}-${i}`}
                    meeting={meeting}
                    onPrep={handlePrep}
                    generatingKey={generatingKey}
                    generationStep={step}
                    generationResult={generationResult}
                    generationError={generationError}
                    accounts={accountNames}
                    highlighted={highlightedMeetingKey === meetingKey}
                  />
                )
              })}
            </div>
          </div>
        ))
      )}

      {/* Prep History */}
      {history.length > 0 && (
        <div className="pt-6 border-t border-border">
          <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">
            Previous Prep Docs
          </h3>
          <div className="space-y-2">
            {history.map((entry, i) => (
              <div
                key={i}
                className="flex items-center justify-between p-3 rounded-lg bg-surface/50 border border-border/30 hover:border-border transition-colors group"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-text-primary truncate">
                    {entry.title || entry.meetingTitle}
                  </p>
                  <p className="text-xs text-text-secondary mt-0.5">
                    {formatDateShort(entry.meetingStart)} · Generated {formatDateShort(entry.generatedAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-3">
                  {entry.docUrl && (
                    <a
                      href={entry.docUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-text-secondary hover:text-accent transition-colors"
                      title="Open in Google Docs"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  )}
                  <button
                    onClick={() => handleDelete(i)}
                    className="text-text-secondary/50 hover:text-red-400 transition-colors"
                    title="Delete from history and Drive"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function MeetingPrepPage() {
  return (
    <ModulePageShell
      title="Meeting Prep"
      icon="FileText"
      scope="both"
    >
      <MeetingPrepContent />
    </ModulePageShell>
  )
}
