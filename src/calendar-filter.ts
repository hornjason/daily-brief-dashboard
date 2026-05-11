import type { calendar_v3 } from 'googleapis'

/**
 * Filter function to exclude subscribed/shared calendar events that appear
 * in the primary calendar view but weren't created by or sent to the user.
 *
 * Include events where:
 * 1. User is the organizer (organizer.self === true) — includes personal calendar blocks
 * 2. User is in the attendee list (some attendee has .self === true)
 *
 * Exclude events from subscribed calendars (e.g., team calendars, holiday calendars).
 *
 * @see https://github.com/hornjason/asaCommandCenter/issues/94
 */
export function isPrimaryCalendarEvent(ev: calendar_v3.Schema$Event): boolean {
  // 1. User is the organizer (includes personal events with no attendees)
  if (ev.organizer?.self === true) return true

  // 2. User is in the attendee list (invited to someone else's meeting)
  if (ev.attendees?.some((a) => a.self === true)) return true

  // Everything else is from a subscribed/shared calendar (no self references)
  return false
}
