/**
 * Unit tests for ET timezone utilities.
 *
 * Tests the parameterized timezone functions that replace 7 copy-pasted
 * implementations in background-scheduler.ts.
 */
import { test, expect, describe } from 'bun:test'
import { nextEtTimeUtc, nextEtWeekdayUtc } from '../../src/lib/et-time.ts'

describe('nextEtTimeUtc', () => {
  test('returns 2am EST (7am UTC) when before 2am in winter', () => {
    // Jan 15 2026 01:30 UTC = Jan 14 8:30pm EST — before 2am
    const now = new Date('2026-01-15T01:30:00Z')
    const result = nextEtTimeUtc(2, 0, now)
    expect(result.toISOString()).toBe('2026-01-15T07:00:00.000Z')
  })

  test('rolls to next day when already past 2am EST', () => {
    // Jan 15 2026 09:00 UTC = Jan 15 4am EST — already past 2am
    const now = new Date('2026-01-15T09:00:00Z')
    const result = nextEtTimeUtc(2, 0, now)
    expect(result.toISOString()).toBe('2026-01-16T07:00:00.000Z')
  })

  test('returns 1:45am EST (6:45am UTC) in winter', () => {
    // Jan 15 2026 01:00 UTC = Jan 14 8pm EST — before 1:45am
    const now = new Date('2026-01-15T01:00:00Z')
    const result = nextEtTimeUtc(1, 45, now)
    expect(result.toISOString()).toBe('2026-01-15T06:45:00.000Z')
  })

  test('returns 6:30am EDT (10:30am UTC) in summer', () => {
    // July 15 2026 01:00 UTC = July 14 9pm EDT — before 6:30am
    const now = new Date('2026-07-15T01:00:00Z')
    const result = nextEtTimeUtc(6, 30, now)
    expect(result.toISOString()).toBe('2026-07-15T10:30:00.000Z')
  })

  test('returns 7am EDT (11am UTC) in summer', () => {
    // July 15 2026 02:00 UTC = July 14 10pm EDT — before 7am
    const now = new Date('2026-07-15T02:00:00Z')
    const result = nextEtTimeUtc(7, 0, now)
    expect(result.toISOString()).toBe('2026-07-15T11:00:00.000Z')
  })

  test('returns 5:30am EST (10:30am UTC) in winter', () => {
    // Jan 15 2026 03:00 UTC = Jan 14 10pm EST — before 5:30am
    const now = new Date('2026-01-15T03:00:00Z')
    const result = nextEtTimeUtc(5, 30, now)
    expect(result.toISOString()).toBe('2026-01-15T10:30:00.000Z')
  })

  test('returns 8am EDT (12pm UTC) in summer', () => {
    // July 15 2026 04:00 UTC = July 15 12am EDT — before 8am
    const now = new Date('2026-07-15T04:00:00Z')
    const result = nextEtTimeUtc(8, 0, now)
    expect(result.toISOString()).toBe('2026-07-15T12:00:00.000Z')
  })

  test('spring-forward: before transition returns correct UTC', () => {
    // 06:50 UTC = 1:50am EST — just before spring-forward at 2am
    const now = new Date('2026-03-08T06:50:00Z')
    const result = nextEtTimeUtc(2, 0, now)
    expect(result.toISOString()).toBe('2026-03-08T07:00:00.000Z')
  })

  test('fall-back: before first 2am returns 6am UTC (2am EDT)', () => {
    // 05:30 UTC = 1:30am EDT — before first 2am
    const now = new Date('2026-11-01T05:30:00Z')
    const result = nextEtTimeUtc(2, 0, now)
    expect(result.toISOString()).toBe('2026-11-01T06:00:00.000Z')
  })

  test('returns a future Date (never in the past)', () => {
    const now = new Date()
    const result = nextEtTimeUtc(2, 0, now)
    expect(result.getTime()).toBeGreaterThan(now.getTime())
  })
})

describe('nextEtWeekdayUtc', () => {
  test('returns next Sunday 6am EDT when called on Monday', () => {
    // Monday July 14 2026 10am EDT
    const monday = new Date('2026-07-13T14:00:00Z')
    const result = nextEtWeekdayUtc(0, 6, 0, monday)
    // Next Sunday July 19 at 6am EDT = 10am UTC
    expect(result.toISOString()).toBe('2026-07-19T10:00:00.000Z')
  })

  test('rolls to next week when already past target time on same weekday', () => {
    // Sunday July 19 2026 12pm EDT (already past 6am)
    const sunday = new Date('2026-07-19T16:00:00Z')
    const result = nextEtWeekdayUtc(0, 6, 0, sunday)
    // Next Sunday July 26 at 6am EDT = 10am UTC
    expect(result.toISOString()).toBe('2026-07-26T10:00:00.000Z')
  })

  test('returns same day when before target time on target weekday', () => {
    // Sunday July 19 2026 2am EDT (before 6am)
    const sunday = new Date('2026-07-19T06:00:00Z')
    const result = nextEtWeekdayUtc(0, 6, 0, sunday)
    // Same Sunday at 6am EDT = 10am UTC
    expect(result.toISOString()).toBe('2026-07-19T10:00:00.000Z')
  })

  test('handles EST/EDT transition for weekly schedule', () => {
    // Winter: Sunday Jan 18 2026 2am EST (before 6am)
    const winterSunday = new Date('2026-01-18T07:00:00Z')
    const result = winterSunday.getTime() < new Date('2026-01-18T11:00:00Z').getTime()
      ? nextEtWeekdayUtc(0, 6, 0, winterSunday)
      : nextEtWeekdayUtc(0, 6, 0, winterSunday)
    // Same Sunday at 6am EST = 11am UTC
    expect(result.toISOString()).toBe('2026-01-18T11:00:00.000Z')
  })

  test('returns a future Date (never in the past)', () => {
    const now = new Date()
    const result = nextEtWeekdayUtc(0, 6, 0, now)
    expect(result.getTime()).toBeGreaterThan(now.getTime())
  })
})
