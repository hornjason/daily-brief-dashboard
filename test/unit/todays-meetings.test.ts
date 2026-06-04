/**
 * Unit test for Today's Meetings section in /api/morning-summary
 * GitHub Issue #609 — Morning brief integration with meeting intelligence
 *
 * Tests:
 * 1. computeSignalDensityLevel correctly categorizes density
 * 2. buildTodaysMeetings returns meetings with signal density
 * 3. Meetings without customer match are excluded
 * 4. Returns empty array when no meetings today
 * 5. Each meeting has all required fields
 * 6. Returns limited density when no graph exists
 */

import { describe, test, expect } from 'bun:test'
import {
  computeSignalDensityLevel,
  buildTodaysMeetings,
  type TodaysMeeting,
} from '../../src/lib/todays-meetings.ts'

describe('computeSignalDensityLevel', () => {
  test('returns "high" when populated >= 8 of 12', () => {
    expect(computeSignalDensityLevel(8, 12)).toBe('high')
    expect(computeSignalDensityLevel(12, 12)).toBe('high')
    expect(computeSignalDensityLevel(10, 12)).toBe('high')
  })

  test('returns "medium" when populated >= 4 and < 8', () => {
    expect(computeSignalDensityLevel(4, 12)).toBe('medium')
    expect(computeSignalDensityLevel(7, 12)).toBe('medium')
    expect(computeSignalDensityLevel(5, 12)).toBe('medium')
  })

  test('returns "limited" when populated < 4', () => {
    expect(computeSignalDensityLevel(0, 12)).toBe('limited')
    expect(computeSignalDensityLevel(3, 12)).toBe('limited')
    expect(computeSignalDensityLevel(1, 12)).toBe('limited')
  })

  test('handles zero total gracefully', () => {
    expect(computeSignalDensityLevel(0, 0)).toBe('limited')
  })
})

describe('buildTodaysMeetings', () => {
  const makeEvent = (title: string, start: string, customers: string[]) => ({
    title,
    start,
    end: start,
    solo: false,
    attendees: ['someone@external.com'],
    customers,
  })

  const makeCustomer = (name: string) => ({
    name,
    ae: 'Test AE',
    ccspCustomer: false,
  })

  // Today's date for test events
  const todayNoon = new Date()
  todayNoon.setHours(12, 0, 0, 0)
  const todayStr = todayNoon.toISOString()

  // Yesterday (should be excluded)
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  yesterday.setHours(12, 0, 0, 0)
  const yesterdayStr = yesterday.toISOString()

  test('returns meetings with customer match and signal density', () => {
    const events = [makeEvent('Q3 Review', todayStr, ['Acme Corp'])]
    const customers = [makeCustomer('Acme Corp')]

    // Mock graph loader that returns a graph with 6 active node types
    const mockGraphLoader = (_slug: string) => ({
      nodes: {
        n1: { type: 'subscription', history: { status: 'active' } },
        n2: { type: 'case', history: { status: 'active' } },
        n3: { type: 'pipeline', history: { status: 'active' } },
        n4: { type: 'contact', history: { status: 'active' } },
        n5: { type: 'news', history: { status: 'active' } },
        n6: { type: 'tech-stack', history: { status: 'active' } },
      },
      edges: [],
    })

    const result = buildTodaysMeetings(events as any, customers as any, mockGraphLoader as any)

    expect(result).toHaveLength(1)
    expect(result[0].customerName).toBe('Acme Corp')
    expect(result[0].customerSlug).toBe('acme-corp')
    expect(result[0].meetingTitle).toBe('Q3 Review')
    expect(result[0].densityLevel).toBe('medium')
    expect(result[0].meetingPrepUrl).toBe('/dashboard/customer/acme-corp/meeting-prep')
  })

  test('excludes meetings without customer match', () => {
    const events = [makeEvent('Internal Sync', todayStr, [])]
    const customers = [makeCustomer('Acme Corp')]

    const result = buildTodaysMeetings(events as any, customers as any, () => null)

    expect(result).toHaveLength(0)
  })

  test('excludes meetings not today', () => {
    const events = [makeEvent('Yesterday Sync', yesterdayStr, ['Acme Corp'])]
    const customers = [makeCustomer('Acme Corp')]

    const result = buildTodaysMeetings(events as any, customers as any, () => null)

    expect(result).toHaveLength(0)
  })

  test('returns limited density when no graph exists', () => {
    const events = [makeEvent('Intro Call', todayStr, ['New Co'])]
    const customers = [makeCustomer('New Co')]

    const result = buildTodaysMeetings(events as any, customers as any, () => null)

    expect(result).toHaveLength(1)
    expect(result[0].densityLevel).toBe('limited')
    expect(result[0].densityDetail).toEqual({ populated: 0, total: 12 })
  })

  test('returns high density for customers with rich intelligence', () => {
    const events = [makeEvent('Exec Review', todayStr, ['Big Corp'])]
    const customers = [makeCustomer('Big Corp')]

    const mockGraphLoader = (_slug: string) => ({
      nodes: Object.fromEntries(
        ['subscription', 'case', 'pipeline', 'contact', 'news', 'tech-stack',
         'cloud-spend', 'intelligence', 'event', 'product'].map((t, i) => [
          `n${i}`, { type: t, history: { status: 'active' } },
        ])
      ),
      edges: [],
    })

    const result = buildTodaysMeetings(events as any, customers as any, mockGraphLoader as any)

    expect(result).toHaveLength(1)
    expect(result[0].densityLevel).toBe('high')
  })

  test('lists multiple meetings for same customer', () => {
    const events = [
      makeEvent('Morning Standup', todayStr, ['Acme Corp']),
      makeEvent('Afternoon Review', todayStr, ['Acme Corp']),
    ]
    const customers = [makeCustomer('Acme Corp')]

    const result = buildTodaysMeetings(events as any, customers as any, () => null)

    expect(result).toHaveLength(2)
    expect(result[0].customerName).toBe('Acme Corp')
    expect(result[1].customerName).toBe('Acme Corp')
  })

  test('TodaysMeeting interface has all required fields', () => {
    const meeting: TodaysMeeting = {
      customerName: 'Test',
      customerSlug: 'test',
      meetingTitle: 'Meeting',
      meetingStart: todayStr,
      densityLevel: 'high',
      densityDetail: { populated: 10, total: 12 },
      meetingPrepUrl: '/dashboard/customer/test/meeting-prep',
    }

    expect(meeting.customerName).toBeDefined()
    expect(meeting.customerSlug).toBeDefined()
    expect(meeting.meetingTitle).toBeDefined()
    expect(meeting.meetingStart).toBeDefined()
    expect(meeting.densityLevel).toBeDefined()
    expect(meeting.densityDetail).toBeDefined()
    expect(meeting.meetingPrepUrl).toBeDefined()
  })

  test('excludes historical nodes from density count', () => {
    const events = [makeEvent('Meeting', todayStr, ['Test Co'])]
    const customers = [makeCustomer('Test Co')]

    const mockGraphLoader = (_slug: string) => ({
      nodes: {
        n1: { type: 'subscription', history: { status: 'active' } },
        n2: { type: 'case', history: { status: 'historical' } },
        n3: { type: 'pipeline', history: { status: 'active' } },
        n4: { type: 'contact', history: { status: 'historical' } },
      },
      edges: [],
    })

    const result = buildTodaysMeetings(events as any, customers as any, mockGraphLoader as any)

    expect(result).toHaveLength(1)
    // Only 2 active nodes (subscription, pipeline) — historical excluded
    expect(result[0].densityDetail.populated).toBe(2)
    expect(result[0].densityLevel).toBe('limited')
  })
})
