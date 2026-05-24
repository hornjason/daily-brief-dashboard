// test/unit/signal-aging.test.ts
// GitHub Issue #281 — Tests for visual signal aging utilities

import { describe, test, expect } from 'bun:test'
import { formatRelativeTime, signalOpacity } from '../../dashboard/src/lib/signal-aging'

describe('formatRelativeTime', () => {
  test('shows "just now" for timestamps under 60 seconds', () => {
    const now = new Date()
    const thirtySecondsAgo = new Date(now.getTime() - 30 * 1000).toISOString()
    expect(formatRelativeTime(thirtySecondsAgo)).toBe('just now')
  })

  test('shows minutes for timestamps under 1 hour', () => {
    const now = new Date()
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
    expect(formatRelativeTime(fiveMinutesAgo)).toBe('5m ago')
  })

  test('shows hours for timestamps under 24 hours', () => {
    const now = new Date()
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(threeHoursAgo)).toBe('3h ago')
  })

  test('shows days for timestamps under 7 days', () => {
    const now = new Date()
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(threeDaysAgo)).toBe('3d ago')
  })

  test('shows weeks for timestamps under 4 weeks', () => {
    const now = new Date()
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(twoWeeksAgo)).toBe('2w ago')
  })

  test('shows months for timestamps under 12 months', () => {
    const now = new Date()
    const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(threeMonthsAgo)).toBe('3mo ago')
  })

  test('shows years for timestamps over 12 months', () => {
    const now = new Date()
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(oneYearAgo)).toBe('1y ago')
  })

  test('handles future timestamps gracefully', () => {
    const now = new Date()
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(tomorrow)).toBe('future')
  })
})

describe('signalOpacity', () => {
  test('returns 1.0 for fresh signals (< 7 days)', () => {
    const now = new Date()
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString()
    expect(signalOpacity(threeDaysAgo)).toBe(1.0)
  })

  test('returns 1.0 at exactly 7 days boundary', () => {
    const now = new Date()
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
    expect(signalOpacity(sevenDaysAgo)).toBe(1.0)
  })

  test('returns 0.5 for very old signals (>= 30 days)', () => {
    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    expect(signalOpacity(thirtyDaysAgo)).toBe(0.5)

    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString()
    expect(signalOpacity(sixtyDaysAgo)).toBe(0.5)
  })

  test('returns intermediate opacity for signals between 7-30 days', () => {
    const now = new Date()
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
    const opacity = signalOpacity(fourteenDaysAgo)

    // 14 days is roughly midpoint between 7 and 30 days
    // Expected opacity ~0.85 (1.0 - ((14-7)/(30-7)) * 0.5 ≈ 1.0 - 0.15 = 0.85)
    expect(opacity).toBeGreaterThan(0.75)
    expect(opacity).toBeLessThan(0.90)
  })

  test('uses continuous decay curve (no sudden jumps)', () => {
    const now = new Date()

    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const nineDaysAgo = new Date(now.getTime() - 9 * 24 * 60 * 60 * 1000).toISOString()

    const opacity8 = signalOpacity(eightDaysAgo)
    const opacity9 = signalOpacity(nineDaysAgo)

    // Opacity should decrease smoothly, not jump
    expect(opacity9).toBeLessThan(opacity8)
    const diff = opacity8 - opacity9
    expect(diff).toBeLessThan(0.05) // Small gradual change
  })

  test('handles very fresh signals (just now)', () => {
    const now = new Date().toISOString()
    expect(signalOpacity(now)).toBe(1.0)
  })
})
