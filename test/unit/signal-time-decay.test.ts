import { describe, test, expect } from 'bun:test'
import { applyTimeDecay } from '../../src/feature-module-registry.ts'

// Test the applyTimeDecay function for GitHub Issue #278
// Time-decay scoring for signals

describe('Signal time decay (#278)', () => {
  test('fresh signal keeps full score', () => {
    // Signal from today with score 0.8 should keep ~100% of score
    const signal = {
      source: 'test',
      type: 'event' as const,
      headline: 'Test Event',
      detail: 'Test detail',
      score: 0.8,
      timestamp: new Date().toISOString(),
    }

    const decayed = applyTimeDecay(signal)
    expect(decayed.score).toBeGreaterThanOrEqual(0.79)
    expect(decayed.score).toBeLessThanOrEqual(0.81)
  })

  test('15-day-old signal loses ~50% score', () => {
    // Signal from 15 days ago should have score * 0.5
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString()
    const signal = {
      source: 'test',
      type: 'event' as const,
      headline: 'Old Event',
      detail: 'Test detail',
      score: 0.8,
      timestamp: fifteenDaysAgo,
    }

    // Expected: 0.8 * (1 - 15/30) = 0.8 * 0.5 = 0.4
    const decayed = applyTimeDecay(signal)
    expect(decayed.score).toBeGreaterThanOrEqual(0.39)
    expect(decayed.score).toBeLessThanOrEqual(0.41)
  })

  test('30-day-old signal has minimum score 0.1', () => {
    // Signal at 30 days should hit floor
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const signal = {
      source: 'test',
      type: 'event' as const,
      headline: 'Very Old Event',
      detail: 'Test detail',
      score: 0.8,
      timestamp: thirtyDaysAgo,
    }

    // Expected: 0.8 * (1 - 30/30) = 0, but floor is 0.1 → 0.8 * 0.1 = 0.08
    const decayed = applyTimeDecay(signal)
    expect(decayed.score).toBeGreaterThanOrEqual(0.079)
    expect(decayed.score).toBeLessThanOrEqual(0.081)
  })

  test('expired signal gets score 0.05', () => {
    // Signal with expiresAt in the past should get 0.05
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const signal = {
      source: 'test',
      type: 'event' as const,
      headline: 'Expired Event',
      detail: 'Test detail',
      score: 0.8,
      timestamp: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      expiresAt: yesterday,
    }

    const decayed = applyTimeDecay(signal)
    expect(decayed.score).toBe(0.05)
  })

  test('signal without score is unchanged', () => {
    // No score = no decay applied
    const signal = {
      source: 'test',
      type: 'event' as const,
      headline: 'No Score Event',
      detail: 'Test detail',
      timestamp: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
    }

    const decayed = applyTimeDecay(signal)
    expect(decayed.score).toBeUndefined()
  })

  test('signal without expiresAt does not expire', () => {
    // Signal with no expiresAt should only time-decay, never hard-expire
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    const signal = {
      source: 'test',
      type: 'email' as const,
      headline: 'Old Email',
      detail: 'Test detail',
      score: 0.6,
      timestamp: tenDaysAgo,
      // no expiresAt
    }

    // Expected: 0.6 * (1 - 10/30) = 0.6 * 0.666... = 0.4
    const decayed = applyTimeDecay(signal)
    expect(decayed.score).toBeGreaterThanOrEqual(0.39)
    expect(decayed.score).toBeLessThanOrEqual(0.41)
  })
})
