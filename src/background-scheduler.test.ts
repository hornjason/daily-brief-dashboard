/**
 * Unit tests for et-time.ts nextEtTimeUtc DST edge cases.
 *
 * Tests migrated from background-scheduler.test.ts after ADR-028 migration.
 * Now testing the consolidated nextEtTimeUtc(hour, minute) function.
 *
 *   - Normal EST (winter, UTC-5): 2am ET = 7am UTC
 *   - Normal EDT (summer, UTC-4): 2am ET = 6am UTC
 *   - Spring forward (March 8, 2026): 2am ET is effectively 3am EDT = 7am UTC
 *   - Fall back (November 1, 2026): 2am ET first occurrence = 6am UTC (EDT)
 *   - Already past 2am: rolls to next day
 */
import { test, expect, describe } from 'bun:test'
import { nextEtTimeUtc } from '../src/lib/et-time.ts'

describe('nextEtTimeUtc(2, 0) — 2am ET', () => {
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

  test('returns 2am EDT (6am UTC) in summer', () => {
    // July 15 2026 01:00 UTC = July 14 9pm EDT — before 2am
    const now = new Date('2026-07-15T01:00:00Z')
    const result = nextEtTimeUtc(2, 0, now)
    expect(result.toISOString()).toBe('2026-07-15T06:00:00.000Z')
  })

  test('rolls to next day when already past 2am EDT', () => {
    // July 15 2026 08:00 UTC = July 15 4am EDT — already past 2am
    const now = new Date('2026-07-15T08:00:00Z')
    const result = nextEtTimeUtc(2, 0, now)
    expect(result.toISOString()).toBe('2026-07-16T06:00:00.000Z')
  })

  // ── Spring forward: March 8, 2026 (EST → EDT) ────────────────────────────
  // At 2am EST on this day, clocks spring to 3am EDT.
  // nextEtTimeUtc called before the transition (1:50am EST = 6:50am UTC)
  // should return 7am UTC (2am EST = instant when transition fires to 3am EDT).
  test('spring-forward: before transition returns 7am UTC (2am → 3am EDT moment)', () => {
    // 06:50 UTC = 1:50am EST — just before spring-forward at 2am / 7am UTC
    const now = new Date('2026-03-08T06:50:00Z')
    const result = nextEtTimeUtc(2, 0, now)
    expect(result.toISOString()).toBe('2026-03-08T07:00:00.000Z')
  })

  test('spring-forward: after transition rolls to next day (2am EDT = 6am UTC)', () => {
    // 09:00 UTC = 5am EDT — well after spring-forward; today's 2am already passed
    const now = new Date('2026-03-08T09:00:00Z')
    const result = nextEtTimeUtc(2, 0, now)
    expect(result.toISOString()).toBe('2026-03-09T06:00:00.000Z')
  })

  // ── Fall back: November 1, 2026 (EDT → EST) ──────────────────────────────
  // At 2am EDT clocks fall back to 1am EST. 2am happens twice:
  //   first  2am = 2am EDT = 6am UTC
  //   second 2am = 2am EST = 7am UTC
  // nextEtTimeUtc called before the first 2am (1:30am EDT = 5:30am UTC)
  // should return 6am UTC (first, EDT occurrence).
  test('fall-back: before first 2am returns 6am UTC (2am EDT)', () => {
    // 05:30 UTC = 1:30am EDT — before first 2am
    const now = new Date('2026-11-01T05:30:00Z')
    const result = nextEtTimeUtc(2, 0, now)
    expect(result.toISOString()).toBe('2026-11-01T06:00:00.000Z')
  })

  test('fall-back: after transition (2:30am EST = 7:30am UTC) rolls to next day', () => {
    // 07:30 UTC = 2:30am EST — past 2am EST (second occurrence), roll to tomorrow
    const now = new Date('2026-11-01T07:30:00Z')
    const result = nextEtTimeUtc(2, 0, now)
    expect(result.toISOString()).toBe('2026-11-02T07:00:00.000Z')
  })

  test('returns a future Date (never in the past)', () => {
    const now = new Date()
    const result = nextEtTimeUtc(2, 0, now)
    expect(result.getTime()).toBeGreaterThan(now.getTime())
  })
})
