/**
 * test/unit/meeting-prep-refresh.test.ts
 * Tests for 2-hour auto-refresh scheduler (#646)
 *
 * Covers:
 * - AC-9: Finds meetings within 2hr window that have existing prep docs
 * - AC-11: Skips meetings regenerated within the last hour
 * - AC-13: Scheduler finds meetings within 2hr window
 * - AC-14: Recently regenerated preps are skipped
 */
import { describe, it, expect } from 'bun:test'
import {
  findMeetingsNeedingRefresh,
  type RefreshCandidate,
} from '../../src/lib/meeting-prep-refresh.ts'
import type { CalendarEvent, Customer } from '../../src/types.ts'
import type { PrepHistoryEntry } from '../../src/meeting-prep-service.ts'

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEvent(
  title: string,
  startOffsetMs: number,
  customers: string[] = ['Acme Corp'],
  recurringEventId?: string,
): CalendarEvent {
  return {
    title,
    start: new Date(Date.now() + startOffsetMs).toISOString(),
    end: new Date(Date.now() + startOffsetMs + 60 * 60 * 1000).toISOString(),
    attendees: ['user@acme.com'],
    needsPrep: true,
    solo: false,
    customers,
    recurringEventId,
  }
}

function makeCustomer(name: string): Customer {
  return {
    name,
  } as Customer
}

function makeHistoryEntry(
  meetingTitle: string,
  meetingStart: string,
  generatedAt: string,
  docId?: string,
): PrepHistoryEntry {
  return {
    meetingTitle,
    meetingStart,
    docUrl: 'https://docs.google.com/doc/1',
    title: `Prep: ${meetingTitle}`,
    generatedAt,
    customerName: 'Acme Corp',
    docId: docId ?? 'doc-123',
  }
}

const CUSTOMERS = [makeCustomer('Acme Corp')]

// ── Tests ──────────────────────────────────────────────────────────────────

describe('findMeetingsNeedingRefresh', () => {
  it('AC-9/AC-13: finds meetings starting within 2 hours that have existing prep', () => {
    const now = Date.now()
    // Meeting in 90 minutes — within the 2hr window
    const events = [makeEvent('Weekly Sync', 90 * 60 * 1000)]
    const meetingStart = events[0].start

    const historyBySlug = new Map<string, PrepHistoryEntry[]>([
      ['acme-corp', [makeHistoryEntry('Weekly Sync', meetingStart, new Date(now - 3 * 60 * 60 * 1000).toISOString())]],
    ])

    const result = findMeetingsNeedingRefresh(events, CUSTOMERS, historyBySlug)
    expect(result.length).toBe(1)
    expect(result[0].event.title).toBe('Weekly Sync')
    expect(result[0].customer.name).toBe('Acme Corp')
  })

  it('skips meetings more than 2 hours away', () => {
    const events = [makeEvent('Future Sync', 3 * 60 * 60 * 1000)]
    const meetingStart = events[0].start

    const historyBySlug = new Map<string, PrepHistoryEntry[]>([
      ['acme-corp', [makeHistoryEntry('Future Sync', meetingStart, new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString())]],
    ])

    const result = findMeetingsNeedingRefresh(events, CUSTOMERS, historyBySlug)
    expect(result.length).toBe(0)
  })

  it('skips meetings already in the past', () => {
    const events = [makeEvent('Past Sync', -30 * 60 * 1000)]
    const meetingStart = events[0].start

    const historyBySlug = new Map<string, PrepHistoryEntry[]>([
      ['acme-corp', [makeHistoryEntry('Past Sync', meetingStart, new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString())]],
    ])

    const result = findMeetingsNeedingRefresh(events, CUSTOMERS, historyBySlug)
    expect(result.length).toBe(0)
  })

  it('skips meetings without an existing prep doc in history', () => {
    const events = [makeEvent('New Meeting', 90 * 60 * 1000)]
    const historyBySlug = new Map<string, PrepHistoryEntry[]>([
      ['acme-corp', []],
    ])

    const result = findMeetingsNeedingRefresh(events, CUSTOMERS, historyBySlug)
    expect(result.length).toBe(0)
  })

  it('AC-11/AC-14: skips meetings regenerated within the last hour', () => {
    const now = Date.now()
    const events = [makeEvent('Weekly Sync', 90 * 60 * 1000)]
    const meetingStart = events[0].start

    // Generated 30 minutes ago — within the 1hr skip window
    const historyBySlug = new Map<string, PrepHistoryEntry[]>([
      ['acme-corp', [makeHistoryEntry('Weekly Sync', meetingStart, new Date(now - 30 * 60 * 1000).toISOString())]],
    ])

    const result = findMeetingsNeedingRefresh(events, CUSTOMERS, historyBySlug)
    expect(result.length).toBe(0)
  })

  it('includes meetings regenerated more than 1 hour ago', () => {
    const now = Date.now()
    const events = [makeEvent('Weekly Sync', 90 * 60 * 1000)]
    const meetingStart = events[0].start

    // Generated 2 hours ago — outside the skip window
    const historyBySlug = new Map<string, PrepHistoryEntry[]>([
      ['acme-corp', [makeHistoryEntry('Weekly Sync', meetingStart, new Date(now - 2 * 60 * 60 * 1000).toISOString())]],
    ])

    const result = findMeetingsNeedingRefresh(events, CUSTOMERS, historyBySlug)
    expect(result.length).toBe(1)
  })

  it('matches history by meeting title AND start time', () => {
    const events = [makeEvent('Weekly Sync', 90 * 60 * 1000)]
    const meetingStart = events[0].start

    // History has same title but different start time
    const historyBySlug = new Map<string, PrepHistoryEntry[]>([
      ['acme-corp', [makeHistoryEntry('Weekly Sync', '2026-01-01T10:00:00Z', new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString())]],
    ])

    const result = findMeetingsNeedingRefresh(events, CUSTOMERS, historyBySlug)
    expect(result.length).toBe(0)
  })

  it('skips solo meetings', () => {
    const ev = makeEvent('Solo Time', 90 * 60 * 1000)
    ev.solo = true
    const events = [ev]
    const historyBySlug = new Map<string, PrepHistoryEntry[]>([
      ['acme-corp', [makeHistoryEntry('Solo Time', ev.start, new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString())]],
    ])

    const result = findMeetingsNeedingRefresh(events, CUSTOMERS, historyBySlug)
    expect(result.length).toBe(0)
  })
})
