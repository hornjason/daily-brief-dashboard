/**
 * src/lib/meeting-prep-refresh.ts
 * 2-hour-before auto-refresh for meeting prep (#646)
 *
 * Scans upcoming meetings, finds those starting within 2 hours that already
 * have a prep doc, and regenerates using update-in-place. Skips meetings
 * manually regenerated within the last hour.
 *
 * Pure domain logic — no I/O, no Google API calls, no scheduler registration.
 * Scheduler integration in background-scheduler.ts.
 */

import type { CalendarEvent, Customer } from '../types.ts'
import type { PrepHistoryEntry } from '../meeting-prep-service.ts'
import { toSlug } from '../cache-layer.ts'

// ── Constants ───────────────────────────────────────────────────────────────

const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000

// ── Types ───────────────────────────────────────────────────────────────────

export interface RefreshCandidate {
  event: CalendarEvent
  customer: Customer
  existingEntry: PrepHistoryEntry
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Find meetings starting within 2 hours that have existing prep docs
 * and haven't been regenerated within the last hour.
 *
 * @param events - Upcoming calendar events
 * @param customers - All customers
 * @param historyBySlug - Map of customer slug -> prep history entries
 * @returns Array of refresh candidates
 */
export function findMeetingsNeedingRefresh(
  events: CalendarEvent[],
  customers: Customer[],
  historyBySlug: Map<string, PrepHistoryEntry[]>,
): RefreshCandidate[] {
  const now = Date.now()
  const customerMap = new Map(customers.map(c => [c.name.toLowerCase(), c]))
  const results: RefreshCandidate[] = []

  for (const event of events) {
    // Skip solo meetings
    if (event.solo) continue

    // Must have customer match
    if (!event.customers?.length) continue

    const startMs = new Date(event.start).getTime()

    // Must be in the future, within 2 hours
    if (startMs <= now || startMs > now + TWO_HOURS_MS) continue

    // Find matching customer
    const customerName = event.customers[0]
    const customer = customerMap.get(customerName.toLowerCase())
    if (!customer) continue

    const slug = toSlug(customer.name)
    const history = historyBySlug.get(slug) ?? []

    // Find existing prep for this exact meeting (title + start time)
    const existingEntry = history.find(
      h => h.meetingTitle === event.title && h.meetingStart === event.start,
    )
    if (!existingEntry) continue

    // Skip if regenerated within the last hour
    const generatedAtMs = new Date(existingEntry.generatedAt).getTime()
    if (now - generatedAtMs < ONE_HOUR_MS) continue

    results.push({ event, customer, existingEntry })
  }

  return results
}
