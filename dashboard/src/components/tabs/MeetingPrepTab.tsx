/**
 * GitHub Issue #261: Meeting Prep tab UI implementation
 * Feature: Customer-scoped meeting prep generation and history
 * Status: Initial implementation
 */

import { useState, useEffect, useMemo } from 'react'
import { Calendar, ExternalLink, RefreshCw, Users, Clock } from 'lucide-react'
import { formatRelTime, formatDate, formatTime } from '../../lib/format'
import { useApi } from '../../hooks/useApi'

interface MeetingPrepTabProps {
  customerName: string
}

interface CalendarEvent {
  id?: string
  title: string
  start: string
  end: string
  attendees?: string[]
  customers?: string[]
  needsPrep?: boolean
  solo?: boolean
  joinUrl?: string
}

interface PrepHistoryEntry {
  meetingTitle: string
  meetingStart: string
  docUrl: string
  title: string
  generatedAt: string
  customerName?: string
}

export function MeetingPrepTab({ customerName }: MeetingPrepTabProps) {
  const calendarApi = useApi<{ events: CalendarEvent[]; range: string }>('/api/calendar?range=week&all=true')
  const [history, setHistory] = useState<PrepHistoryEntry[]>([])

  // Generation state
  const [generatingKey, setGeneratingKey] = useState<string | null>(null)
  const [generationResult, setGenerationResult] = useState<{ docUrl: string; title: string } | null>(null)
  const [generationError, setGenerationError] = useState<string | null>(null)

  // Filter events to this customer
  const customerEvents = useMemo(() => {
    if (!calendarApi.data?.events) return []
    return calendarApi.data.events.filter(e =>
      e.customers?.some(c => c.toLowerCase() === customerName.toLowerCase())
    ).sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
  }, [calendarApi.data, customerName])

  // Fetch history for this customer
  useEffect(() => {
    fetch(`/api/customer/${encodeURIComponent(customerName)}/meeting-prep/history`)
      .then(r => r.ok ? r.json() : { history: [] })
      .then(data => setHistory(data.history || []))
      .catch(() => setHistory([]))
  }, [customerName])

  // Generate prep handler
  const handleGenerate = async (meeting: CalendarEvent) => {
    const key = meeting.id || meeting.title
    setGeneratingKey(key)
    setGenerationError(null)
    setGenerationResult(null)

    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/meeting-prep/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingTitle: meeting.title,
          meetingStart: meeting.start,
          attendees: meeting.attendees ?? [],
        })
      })

      // BKL-TEST-07: Check res.ok before treating as success
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Generation failed' }))
        throw new Error(err.error || 'Generation failed')
      }

      const data = await res.json()
      setGenerationResult({ docUrl: data.docUrl, title: data.title })

      // Refresh history after successful generation
      fetch(`/api/customer/${encodeURIComponent(customerName)}/meeting-prep/history`)
        .then(r => r.ok ? r.json() : { history: [] })
        .then(data => setHistory(data.history || []))
        .catch(() => {})
    } catch (err: unknown) {
      setGenerationError(err instanceof Error ? err.message : 'Generation failed')
    } finally {
      setGeneratingKey(null)
    }
  }

  const hasUpcoming = customerEvents.length > 0
  const hasHistory = history.length > 0

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Calendar className="w-5 h-5 text-accent" />
          <h1 className="text-2xl font-bold text-text-primary">Meeting Prep</h1>
        </div>
        <p className="text-sm text-text-secondary">
          Generate AI-powered meeting preparation materials for {customerName}. Each prep document includes customer intelligence, recent activity, product focus areas, and suggested talking points.
        </p>
      </div>

      {/* Upcoming Meetings */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <Clock className="w-4 h-4" />
          Upcoming Meetings
        </h2>

        {calendarApi.loading && (
          <div className="p-4 text-center text-text-secondary text-sm">
            <RefreshCw className="w-4 h-4 inline animate-spin mr-2" />
            Loading calendar events...
          </div>
        )}

        {!calendarApi.loading && !hasUpcoming && (
          <div className="bg-bg-secondary/50 rounded-lg border border-border p-6 text-center">
            <Calendar className="w-8 h-8 text-text-secondary/30 mx-auto mb-2" />
            <p className="text-sm text-text-secondary">No upcoming meetings with {customerName}</p>
          </div>
        )}

        {hasUpcoming && (
          <div className="space-y-2">
            {customerEvents.map((meeting) => {
              const meetingKey = meeting.id || meeting.title
              const isGenerating = generatingKey === meetingKey

              return (
                <div
                  key={meetingKey}
                  className="bg-bg-secondary/50 rounded-lg border border-border p-4 hover:border-accent/30 transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium text-text-primary truncate">{meeting.title}</h3>
                      <div className="flex items-center gap-4 mt-1 text-sm text-text-secondary">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5" />
                          {formatDate(meeting.start)}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5" />
                          {formatTime(meeting.start)}
                        </span>
                        {meeting.attendees && meeting.attendees.length > 0 && (
                          <span className="flex items-center gap-1">
                            <Users className="w-3.5 h-3.5" />
                            {meeting.attendees.length} attendee{meeting.attendees.length !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => handleGenerate(meeting)}
                      disabled={isGenerating}
                      className="px-4 py-2 bg-accent text-white rounded-md hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium whitespace-nowrap"
                    >
                      {isGenerating ? (
                        <span className="flex items-center gap-2">
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          Generating...
                        </span>
                      ) : (
                        'Prep Now'
                      )}
                    </button>
                  </div>

                  {generationError && generatingKey === meetingKey && (
                    <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded text-sm text-red-400">
                      {generationError}
                    </div>
                  )}

                  {generationResult && generatingKey === null && (
                    <div className="mt-3 p-3 bg-green-500/10 border border-green-500/20 rounded flex items-center justify-between">
                      <span className="text-sm text-green-400">Prep generated successfully</span>
                      <a
                        href={generationResult.docUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-accent hover:text-accent-hover flex items-center gap-1"
                      >
                        Open Doc
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* History */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-text-primary">Past Prep Documents</h2>

        {!hasHistory && (
          <div className="bg-bg-secondary/50 rounded-lg border border-border p-6 text-center">
            <p className="text-sm text-text-secondary">No prep documents yet</p>
          </div>
        )}

        {hasHistory && (
          <div className="space-y-2">
            {history.map((entry, idx) => (
              <div
                key={idx}
                className="bg-bg-secondary/50 rounded-lg border border-border p-4 hover:border-accent/30 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium text-text-primary truncate">{entry.meetingTitle}</h3>
                    <div className="flex items-center gap-4 mt-1 text-sm text-text-secondary">
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5" />
                        {formatDate(entry.meetingStart)}
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" />
                        Generated {formatRelTime(entry.generatedAt)}
                      </span>
                    </div>
                  </div>

                  <a
                    href={entry.docUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-4 py-2 bg-bg-secondary border border-border rounded-md hover:border-accent text-sm font-medium flex items-center gap-2 whitespace-nowrap"
                  >
                    Open Doc
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
