import { describe, expect, test } from 'bun:test'
import type { calendar_v3 } from 'googleapis'
import { isPrimaryCalendarEvent } from '../../src/calendar-filter'

describe('calendar-primary-filter', () => {
  test('includes events where user is organizer', () => {
    const event: calendar_v3.Schema$Event = {
      summary: 'My Meeting',
      organizer: { self: true, email: 'user@example.com' },
      attendees: [
        { email: 'user@example.com', self: true },
        { email: 'other@example.com', self: false },
      ],
    }
    expect(isPrimaryCalendarEvent(event)).toBe(true)
  })

  test('includes events where user is invited attendee (not organizer)', () => {
    const event: calendar_v3.Schema$Event = {
      summary: 'Their Meeting',
      organizer: { self: false, email: 'other@example.com' },
      attendees: [
        { email: 'other@example.com', self: false },
        { email: 'user@example.com', self: true },
      ],
    }
    expect(isPrimaryCalendarEvent(event)).toBe(true)
  })

  test('includes personal events with no attendees (calendar blocks)', () => {
    const event: calendar_v3.Schema$Event = {
      summary: 'Focus Time',
      organizer: { self: true, email: 'user@example.com' },
      attendees: undefined,
    }
    expect(isPrimaryCalendarEvent(event)).toBe(true)
  })

  test('includes personal events with empty attendee list', () => {
    const event: calendar_v3.Schema$Event = {
      summary: 'Deep Work',
      organizer: { self: true, email: 'user@example.com' },
      attendees: [],
    }
    expect(isPrimaryCalendarEvent(event)).toBe(true)
  })

  test('excludes events from subscribed calendars (no self references)', () => {
    const event: calendar_v3.Schema$Event = {
      summary: 'Company Holiday',
      organizer: { self: false, email: 'holidays@example.com' },
      attendees: [
        { email: 'team@example.com', self: false },
      ],
    }
    expect(isPrimaryCalendarEvent(event)).toBe(false)
  })

  test('excludes team calendar events (not invited, just subscribed)', () => {
    const event: calendar_v3.Schema$Event = {
      summary: 'Team Standup',
      organizer: { self: false, email: 'team@example.com' },
      attendees: undefined,
    }
    expect(isPrimaryCalendarEvent(event)).toBe(false)
  })

  test('excludes shared calendar events with no organizer.self', () => {
    const event: calendar_v3.Schema$Event = {
      summary: 'Shared Event',
      organizer: { email: 'shared@example.com' },
      attendees: [
        { email: 'someone@example.com', self: false },
      ],
    }
    expect(isPrimaryCalendarEvent(event)).toBe(false)
  })
})
