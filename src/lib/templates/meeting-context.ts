/**
 * Meeting Context Correlation template — GitHub Issue #987
 * Renders correlated meeting-context signals into deterministic markdown.
 * Pure deterministic output — no Gemini calls.
 */

import type { Signal } from '../../feature-module-registry.ts'
import { routeSignal } from './route-signal.ts'

/**
 * Render meeting-context signals into a deterministic markdown section.
 * Groups by meeting, shows attendees, use cases, related docs, and timeline.
 *
 * Returns null if no meeting-context signals are present.
 */
export function templateMeetingContext(signals: Signal[]): string | null {
  const mcSignals = signals.filter(s => routeSignal(s) === 'meeting-context')
  if (mcSignals.length === 0) return null

  const lines: string[] = ['## Meeting Context']

  for (const signal of mcSignals.slice(0, 5)) {
    const m = signal.metadata ?? {}
    const title = String(m.meetingTitle ?? 'Untitled Meeting')
    const meetingDate = m.meetingDate ? new Date(String(m.meetingDate)).toLocaleDateString() : ''
    const attendees = Array.isArray(m.attendeeEmails) ? m.attendeeEmails as string[] : []
    const useCases = Array.isArray(m.useCases) ? m.useCases as Array<{ description: string; category: string; confirmationLevel: string }> : []
    const relatedDocs = Array.isArray(m.relatedDocs) ? m.relatedDocs as Array<{ id: string; name: string; modifiedTime: string }> : []
    const sourceThreads = Array.isArray(m.sourceThreadIds) ? m.sourceThreadIds as string[] : []

    lines.push('')
    lines.push(`### ${title}`)
    if (meetingDate) lines.push(`**Date:** ${meetingDate}`)

    // Attendees
    if (attendees.length > 0) {
      lines.push(`**Attendees:** ${attendees.join(', ')}`)
    }

    // Use cases
    if (useCases.length > 0) {
      lines.push('')
      lines.push('**Customer-Stated Use Cases:**')
      for (const uc of useCases) {
        const level = uc.confirmationLevel ? ` (${uc.confirmationLevel})` : ''
        lines.push(`- ${uc.description} — *${uc.category}*${level}`)
      }
    }

    // Related docs
    if (relatedDocs.length > 0) {
      lines.push('')
      lines.push('**Related Documents (within ±7 days):**')
      for (const doc of relatedDocs.slice(0, 5)) {
        const modified = doc.modifiedTime ? ` — ${new Date(doc.modifiedTime).toLocaleDateString()}` : ''
        lines.push(`- ${doc.name}${modified}`)
      }
    }

    // Source thread count
    if (sourceThreads.length > 0) {
      lines.push('')
      lines.push(`*Correlated from ${sourceThreads.length} email thread(s)*`)
    }
  }

  return lines.join('\n')
}
