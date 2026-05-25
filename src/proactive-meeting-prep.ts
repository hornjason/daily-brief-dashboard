/**
 * Proactive Meeting Prep — Calendar Scanner & Auto-Generation
 * GitHub Issue #195
 *
 * Scans upcoming calendar events, detects customer meetings 2-3 days out,
 * and auto-generates meeting prep documents. Caches attendee profiles
 * for repeat contacts so they don't need re-research.
 *
 * Pure domain logic — no HTTP, no scheduler registration.
 * Scheduler integration in background-scheduler.ts.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import type { CalendarEvent, Customer } from './types.ts'
import { CACHE_DIR } from './lib/paths.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface AttendeeProfile {
  email: string
  displayName: string
  company: string
  title?: string
  lastSeen: string
  signals?: string[]
}

export interface PrepCandidate {
  event: CalendarEvent
  customer: Customer
}

// ── Attendee Cache ───────────────────────────────────────────────────────────

function attendeeCacheDir(): string {
  return resolve(CACHE_DIR, 'attendees')
}

function attendeeCachePath(slug: string): string {
  return resolve(attendeeCacheDir(), `${slug}.json`)
}

export function readAttendeeCache(slug: string): AttendeeProfile[] {
  const path = attendeeCachePath(slug)
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return []
  }
}

export function writeAttendeeCache(slug: string, profiles: AttendeeProfile[]): void {
  const dir = attendeeCacheDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(attendeeCachePath(slug), JSON.stringify(profiles, null, 2), { mode: 0o600 })
}

// ── Attendee Profile Builder ─────────────────────────────────────────────────

function deriveDisplayName(email: string): string {
  const local = email.split('@')[0] ?? ''
  return local
    .split(/[._-]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export function buildAttendeeCache(
  attendees: string[],
  attendeeDetails: Array<{ email: string; displayName?: string }>,
  customerName: string,
  existingProfiles?: AttendeeProfile[],
): AttendeeProfile[] {
  const existing = existingProfiles ?? []
  const existingMap = new Map(existing.map(p => [p.email.toLowerCase(), p]))
  const now = new Date().toISOString()

  const externalAttendees = attendees.filter(e => !e.endsWith('@redhat.com'))

  return externalAttendees.map(email => {
    const detail = attendeeDetails.find(d => d.email === email)
    const prev = existingMap.get(email.toLowerCase())
    const displayName = detail?.displayName || prev?.displayName || deriveDisplayName(email)

    return {
      email,
      displayName,
      company: prev?.company || customerName,
      title: prev?.title, // preserved from previous enrichment
      lastSeen: now,
      signals: prev?.signals,
    }
  })
}

// ── Prep Detection ───────────────────────────────────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000

export function isAlreadyPrepped(
  meetingTitle: string,
  meetingStart: string,
  history: Array<{ meetingTitle: string; meetingStart: string }>,
): boolean {
  return history.some(h =>
    h.meetingTitle === meetingTitle && h.meetingStart === meetingStart
  )
}

export function findMeetingsNeedingPrep(
  events: CalendarEvent[],
  customers: Customer[],
  history: Array<{ meetingTitle: string; meetingStart: string }>,
): PrepCandidate[] {
  const now = Date.now()
  const oneDayOut = now + ONE_DAY_MS
  const threeDaysOut = now + 3 * ONE_DAY_MS

  const customerMap = new Map(customers.map(c => [c.name.toLowerCase(), c]))

  return events
    .filter(ev => {
      // Must be 1-3 days out
      const start = new Date(ev.start).getTime()
      if (start < oneDayOut || start > threeDaysOut) return false

      // Must not be solo
      if (ev.solo) return false

      // Must have customer match
      if (!ev.customers?.length) return false

      // Must not already be prepped
      if (isAlreadyPrepped(ev.title, ev.start, history)) return false

      return true
    })
    .map(ev => {
      const customerName = ev.customers![0]
      const customer = customerMap.get(customerName.toLowerCase())
      if (!customer) return null
      return { event: ev, customer }
    })
    .filter((c): c is PrepCandidate => c !== null)
}

// ── Scan Runner (called by scheduler) ────────────────────────────────────────

export async function runProactivePrepScan(
  fetchCalendarFn: () => Promise<CalendarEvent[]>,
  customers: Customer[],
  generatePrepFn: (customer: Customer, meeting: { meetingTitle: string; meetingStart: string; attendees: string[]; attendeeDetails?: Array<{ email: string; displayName?: string }> }) => Promise<{ docUrl: string; title: string; generatedAt: string }>,
  readHistoryFn: (slug: string) => Array<{ meetingTitle: string; meetingStart: string }>,
  toSlugFn: (name: string) => string,
  notifyFn?: (title: string, message: string) => Promise<void>,
): Promise<{ generated: number; skipped: number; errors: string[] }> {
  const errors: string[] = []
  let generated = 0
  let skipped = 0

  let events: CalendarEvent[]
  try {
    events = await fetchCalendarFn()
  } catch (e: any) {
    return { generated: 0, skipped: 0, errors: [`Calendar fetch failed: ${e.message}`] }
  }

  // Collect all history across customers for dedup
  const allHistory: Array<{ meetingTitle: string; meetingStart: string }> = []
  for (const c of customers) {
    const slug = toSlugFn(c.name)
    allHistory.push(...readHistoryFn(slug))
  }

  const candidates = findMeetingsNeedingPrep(events, customers, allHistory)

  for (const { event, customer } of candidates) {
    const slug = toSlugFn(customer.name)
    try {
      console.log(`[proactive-prep] Auto-generating prep for "${event.title}" (${customer.name})`)

      // Update attendee cache before generating
      const existingAttendees = readAttendeeCache(slug)
      const updatedAttendees = buildAttendeeCache(
        event.attendees ?? [],
        event.attendeeDetails ?? [],
        customer.name,
        existingAttendees
      )
      writeAttendeeCache(slug, updatedAttendees)

      await generatePrepFn(customer, {
        meetingTitle: event.title,
        meetingStart: event.start,
        attendees: event.attendees ?? [],
        attendeeDetails: event.attendeeDetails,
      })

      generated++

      if (notifyFn) {
        await notifyFn(
          'Meeting Prep Ready',
          `Auto-generated prep for "${event.title}" (${customer.name}) on ${new Date(event.start).toLocaleDateString()}`
        ).catch(() => {})
      }
    } catch (e: any) {
      errors.push(`${customer.name}: ${e.message}`)
      console.error(`[proactive-prep] Failed for ${customer.name}:`, e.message)
    }
  }

  skipped = events.filter(ev => {
    if (!ev.customers?.length) return false
    return isAlreadyPrepped(ev.title, ev.start, allHistory)
  }).length

  console.log(`[proactive-prep] Scan complete: ${generated} generated, ${skipped} skipped, ${errors.length} errors`)
  return { generated, skipped, errors }
}
