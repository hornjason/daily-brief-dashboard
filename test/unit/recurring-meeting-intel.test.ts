/**
 * Recurring Meeting Intelligence — Unit Tests
 * GitHub Issue #269
 *
 * Tests series detection, action item extraction, carry-forward logic,
 * and Drive folder scanning for recent docs.
 */

import { describe, it, expect } from 'bun:test'
import type { CalendarEvent } from '../../src/types'

import {
  detectRecurringSeries,
  extractActionItems,
  findPreviousPrepForSeries,
  buildCarryForwardContext,
  type PrepHistoryWithSeries,
} from '../../src/recurring-meeting-intel'

// ── Test Helpers ─────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    title: 'Weekly Sync — Acme Corp',
    start: '2026-05-26T10:00:00Z',
    end: '2026-05-26T11:00:00Z',
    attendees: ['alice@acme.com'],
    needsPrep: true,
    customers: ['Acme Corp'],
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('recurring-meeting-intel', () => {
  describe('detectRecurringSeries', () => {
    it('identifies events with the same recurringEventId as a series', () => {
      const events: CalendarEvent[] = [
        makeEvent({ recurringEventId: 'abc123', start: '2026-05-19T10:00:00Z' }),
        makeEvent({ recurringEventId: 'abc123', start: '2026-05-26T10:00:00Z' }),
        makeEvent({ recurringEventId: 'abc123', start: '2026-06-02T10:00:00Z' }),
      ]

      const series = detectRecurringSeries(events)
      expect(series.size).toBe(1)
      expect(series.get('abc123')?.length).toBe(3)
    })

    it('returns empty map for events with no recurringEventId', () => {
      const events: CalendarEvent[] = [
        makeEvent({ recurringEventId: undefined }),
        makeEvent({ recurringEventId: undefined }),
      ]

      const series = detectRecurringSeries(events)
      expect(series.size).toBe(0)
    })

    it('groups different series separately', () => {
      const events: CalendarEvent[] = [
        makeEvent({ recurringEventId: 'series-a' }),
        makeEvent({ recurringEventId: 'series-b' }),
        makeEvent({ recurringEventId: 'series-a' }),
      ]

      const series = detectRecurringSeries(events)
      expect(series.size).toBe(2)
      expect(series.get('series-a')?.length).toBe(2)
      expect(series.get('series-b')?.length).toBe(1)
    })
  })

  describe('extractActionItems', () => {
    it('extracts action items from markdown content', () => {
      const content = `## 10. Action Items
| Who | Action | When |
|---|---|---|
| Jason | Follow up on cluster expansion | Next week |
| Alice | Share migration timeline | Before Friday |

## Some Other Section
More text`

      const items = extractActionItems(content)
      expect(items.length).toBe(2)
      expect(items[0]).toContain('Jason')
      expect(items[0]).toContain('Follow up on cluster expansion')
      expect(items[1]).toContain('Alice')
    })

    it('returns empty array when no action items section', () => {
      const content = `## 1. Meeting Objective
Some objective text

## 2. Attendees
Some attendees`

      const items = extractActionItems(content)
      expect(items).toEqual([])
    })

    it('handles bullet-style action items', () => {
      const content = `### 10. Action Items
- Jason: Follow up on cluster expansion (next week)
- Alice: Share migration timeline (before Friday)

## Footer`

      const items = extractActionItems(content)
      expect(items.length).toBe(2)
    })
  })

  describe('findPreviousPrepForSeries', () => {
    it('finds the most recent prep with matching recurringEventId', () => {
      const history: PrepHistoryWithSeries[] = [
        { meetingTitle: 'Weekly Sync', meetingStart: '2026-05-26T10:00:00Z', docUrl: 'url2', title: 'doc2', generatedAt: '2026-05-24T00:00:00Z', recurringEventId: 'abc123' },
        { meetingTitle: 'Weekly Sync', meetingStart: '2026-05-19T10:00:00Z', docUrl: 'url1', title: 'doc1', generatedAt: '2026-05-17T00:00:00Z', recurringEventId: 'abc123' },
      ]

      const prev = findPreviousPrepForSeries('abc123', '2026-06-02T10:00:00Z', history)
      expect(prev).not.toBeNull()
      expect(prev!.meetingStart).toBe('2026-05-26T10:00:00Z')
    })

    it('excludes the current meeting start from results', () => {
      const history: PrepHistoryWithSeries[] = [
        { meetingTitle: 'Weekly Sync', meetingStart: '2026-05-26T10:00:00Z', docUrl: 'url1', title: 'doc1', generatedAt: '2026-05-24T00:00:00Z', recurringEventId: 'abc123' },
      ]

      const prev = findPreviousPrepForSeries('abc123', '2026-05-26T10:00:00Z', history)
      expect(prev).toBeNull()
    })

    it('returns null when no matching series in history', () => {
      const history: PrepHistoryWithSeries[] = [
        { meetingTitle: 'Other Meeting', meetingStart: '2026-05-19T10:00:00Z', docUrl: 'url1', title: 'doc1', generatedAt: '2026-05-17T00:00:00Z', recurringEventId: 'xyz789' },
      ]

      const prev = findPreviousPrepForSeries('abc123', '2026-05-26T10:00:00Z', history)
      expect(prev).toBeNull()
    })
  })

  describe('buildCarryForwardContext', () => {
    it('formats action items for Gemini prompt', () => {
      const actionItems = [
        'Jason: Follow up on cluster expansion (next week)',
        'Alice: Share migration timeline (before Friday)',
      ]
      const previousDate = '2026-05-19T10:00:00Z'

      const context = buildCarryForwardContext(actionItems, previousDate)
      expect(context).toContain('Outstanding from Last Meeting')
      expect(context).toContain('May 19')
      expect(context).toContain('Follow up on cluster expansion')
      expect(context).toContain('Share migration timeline')
    })

    it('returns empty string when no action items', () => {
      const context = buildCarryForwardContext([], '2026-05-19T10:00:00Z')
      expect(context).toBe('')
    })
  })
})
