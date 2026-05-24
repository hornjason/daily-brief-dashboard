/**
 * Proactive Meeting Prep — Unit Tests
 * GitHub Issue #195
 *
 * Tests the calendar scanning + auto-generation trigger + attendee cache.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { CalendarEvent, Customer } from '../../src/types'

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    title: 'Weekly Sync — Acme Corp',
    start: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days out
    end: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString(),
    attendees: ['alice@acme.com', 'bob@redhat.com'],
    needsPrep: true,
    customers: ['Acme Corp'],
    ...overrides,
  }
}

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    name: 'Acme Corp',
    domain: 'acme.com',
    driveFolderId: 'folder-123',
    ...overrides,
  }
}

// ── Import the module under test ────────────────────────────────────────────

// We test the pure functions directly; the scheduler registration is integration-level.
import {
  findMeetingsNeedingPrep,
  isAlreadyPrepped,
  buildAttendeeCache,
  readAttendeeCache,
  type AttendeeProfile,
} from '../../src/proactive-meeting-prep'

// ── Tests ────────────────────────────────────────────────────────────────────

describe('proactive-meeting-prep', () => {
  describe('findMeetingsNeedingPrep', () => {
    it('returns meetings 2-3 days out with customer matches', () => {
      const twoDaysOut = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
      const events: CalendarEvent[] = [
        makeEvent({ start: twoDaysOut, customers: ['Acme Corp'] }),
      ]
      const customers: Customer[] = [makeCustomer()]
      const history: Array<{ meetingTitle: string; meetingStart: string }> = []

      const result = findMeetingsNeedingPrep(events, customers, history)
      expect(result.length).toBe(1)
      expect(result[0].event.customers).toContain('Acme Corp')
      expect(result[0].customer.name).toBe('Acme Corp')
    })

    it('excludes meetings less than 1 day out', () => {
      const halfDayOut = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
      const events: CalendarEvent[] = [
        makeEvent({ start: halfDayOut, customers: ['Acme Corp'] }),
      ]
      const customers: Customer[] = [makeCustomer()]

      const result = findMeetingsNeedingPrep(events, customers, [])
      expect(result.length).toBe(0)
    })

    it('excludes meetings more than 3 days out', () => {
      const fiveDaysOut = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
      const events: CalendarEvent[] = [
        makeEvent({ start: fiveDaysOut, customers: ['Acme Corp'] }),
      ]
      const customers: Customer[] = [makeCustomer()]

      const result = findMeetingsNeedingPrep(events, customers, [])
      expect(result.length).toBe(0)
    })

    it('excludes solo meetings', () => {
      const twoDaysOut = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
      const events: CalendarEvent[] = [
        makeEvent({ start: twoDaysOut, solo: true, customers: ['Acme Corp'] }),
      ]
      const customers: Customer[] = [makeCustomer()]

      const result = findMeetingsNeedingPrep(events, customers, [])
      expect(result.length).toBe(0)
    })

    it('excludes meetings without customer match', () => {
      const twoDaysOut = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
      const events: CalendarEvent[] = [
        makeEvent({ start: twoDaysOut, customers: [] }),
      ]
      const customers: Customer[] = [makeCustomer()]

      const result = findMeetingsNeedingPrep(events, customers, [])
      expect(result.length).toBe(0)
    })

    it('excludes meetings with undefined customers', () => {
      const twoDaysOut = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
      const events: CalendarEvent[] = [
        makeEvent({ start: twoDaysOut, customers: undefined }),
      ]
      const customers: Customer[] = [makeCustomer()]

      const result = findMeetingsNeedingPrep(events, customers, [])
      expect(result.length).toBe(0)
    })
  })

  describe('isAlreadyPrepped', () => {
    it('returns true when meeting title + start match history', () => {
      const history = [
        { meetingTitle: 'Weekly Sync', meetingStart: '2026-05-26T10:00:00Z' },
      ]
      expect(isAlreadyPrepped('Weekly Sync', '2026-05-26T10:00:00Z', history)).toBe(true)
    })

    it('returns false when no history match', () => {
      const history = [
        { meetingTitle: 'Other Meeting', meetingStart: '2026-05-26T10:00:00Z' },
      ]
      expect(isAlreadyPrepped('Weekly Sync', '2026-05-26T10:00:00Z', history)).toBe(false)
    })

    it('returns false for empty history', () => {
      expect(isAlreadyPrepped('Weekly Sync', '2026-05-26T10:00:00Z', [])).toBe(false)
    })
  })

  describe('buildAttendeeCache', () => {
    it('creates attendee profiles from attendee details', () => {
      const profiles = buildAttendeeCache(
        ['alice@acme.com'],
        [{ email: 'alice@acme.com', displayName: 'Alice Johnson' }],
        'Acme Corp'
      )
      expect(profiles.length).toBe(1)
      expect(profiles[0].email).toBe('alice@acme.com')
      expect(profiles[0].displayName).toBe('Alice Johnson')
      expect(profiles[0].company).toBe('Acme Corp')
    })

    it('derives display name from email when not provided', () => {
      const profiles = buildAttendeeCache(
        ['bob.smith@acme.com'],
        [],
        'Acme Corp'
      )
      expect(profiles.length).toBe(1)
      expect(profiles[0].displayName).toBe('Bob Smith')
    })

    it('skips redhat.com attendees', () => {
      const profiles = buildAttendeeCache(
        ['alice@acme.com', 'internal@redhat.com'],
        [],
        'Acme Corp'
      )
      expect(profiles.length).toBe(1)
      expect(profiles[0].email).toBe('alice@acme.com')
    })

    it('merges with existing profiles preserving latest data', () => {
      const existing: AttendeeProfile[] = [{
        email: 'alice@acme.com',
        displayName: 'Alice Johnson',
        company: 'Acme Corp',
        lastSeen: '2026-05-01T00:00:00Z',
        title: 'VP Engineering',
      }]
      const profiles = buildAttendeeCache(
        ['alice@acme.com'],
        [{ email: 'alice@acme.com', displayName: 'Alice J.' }],
        'Acme Corp',
        existing
      )
      expect(profiles.length).toBe(1)
      expect(profiles[0].title).toBe('VP Engineering') // preserved from existing
      expect(profiles[0].displayName).toBe('Alice J.') // updated
    })
  })

  describe('readAttendeeCache', () => {
    it('returns empty array when no cache file exists', () => {
      const result = readAttendeeCache('nonexistent-slug')
      expect(result).toEqual([])
    })
  })
})
