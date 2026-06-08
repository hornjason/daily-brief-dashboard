/**
 * Upcoming Events template — GitHub Issue #684
 * Extracted from signal-templates.ts
 */

import type { Signal } from '../../feature-module-registry.ts'
import { routeSignal } from './route-signal.ts'

/**
 * Upcoming Events section (#377): signals from rh-events showing upcoming
 * summits, workshops, webinars relevant to the customer.
 *
 * Renders: Event name, Date, Format, Location
 */
export function templateUpcomingEvents(signals: Signal[]): string | null {
  const eventSignals = signals.filter(s => routeSignal(s) === 'event')
  if (eventSignals.length === 0) return null

  const rows: string[] = []
  rows.push('| Event | Date | Format | Location |')
  rows.push('|-------|------|--------|----------|')

  for (const s of eventSignals.slice(0, 8)) {
    const m = s.metadata ?? {}
    const event = s.headline.slice(0, 50)
    const date = s.timestamp
      ? new Date(s.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'TBD'
    const format = String(m.format ?? 'TBD')
    const location = String(m.location || (format === 'virtual' ? 'Virtual' : 'TBD'))
    rows.push(`| ${event} | ${date} | ${format} | ${location} |`)
  }

  return rows.join('\n')
}
