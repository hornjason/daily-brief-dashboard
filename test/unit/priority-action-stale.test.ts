import { describe, test, expect } from 'bun:test'

// Note: isActionStale is not exported from dashboard-routes.ts (internal implementation detail)
// We duplicate the logic here for unit testing. Integration test in regression.spec.ts verifies
// the actual endpoint behavior.
function isActionStale(text: string): boolean {
  const datePatterns = [
    /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/gi,
    /\d{1,2}\/\d{1,2}\/\d{4}/g,
    /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/gi,
  ]

  for (const pattern of datePatterns) {
    const matches = text.match(pattern)
    if (matches) {
      for (const match of matches) {
        try {
          const parsed = new Date(match)
          // 24h grace period: action is stale if date is more than 24h in the past
          if (!isNaN(parsed.getTime()) && parsed.getTime() < Date.now() - 24 * 60 * 60 * 1000) {
            return true
          }
        } catch {
          // Date parsing failed - treat as not stale (conservative)
        }
      }
    }
  }

  return false
}

describe('Priority action staleness (#279)', () => {
  test('action with past date is detected as stale', () => {
    const text = 'Schedule meeting before Tuesday, May 13, 2026'
    expect(isActionStale(text)).toBe(true)
  })

  test('action with future date is not stale', () => {
    const text = 'Schedule meeting before December 31, 2026'
    expect(isActionStale(text)).toBe(false)
  })

  test('action without any date is not stale', () => {
    const text = 'Review pipeline opportunities and follow up'
    expect(isActionStale(text)).toBe(false)
  })

  test('action with numeric date format (past) is stale', () => {
    const text = 'Complete review by 5/13/2026'
    expect(isActionStale(text)).toBe(true)
  })

  test('action with numeric date format (future) is not stale', () => {
    const text = 'Complete review by 12/31/2026'
    expect(isActionStale(text)).toBe(false)
  })

  test('action with day-of-week format (past) is stale', () => {
    const text = 'Schedule before Tuesday, May 13'
    // Will be stale because May 13 (2026) is past
    expect(isActionStale(text)).toBe(true)
  })

  test('action with multiple dates picks the earliest', () => {
    const text = 'Follow up from May 13, 2026 meeting and schedule next meeting for June 1, 2026'
    // Should detect May 13 as stale
    expect(isActionStale(text)).toBe(true)
  })

  test('action with relative date reference (today) is not stale', () => {
    const text = 'Follow up with customer today about pipeline'
    // "today" is not matched by our patterns (intentional - relative dates are always current)
    expect(isActionStale(text)).toBe(false)
  })

  test('action with malformed date is not stale', () => {
    const text = 'Schedule meeting on Funuary 99, 2026'
    // Invalid date parsing should not crash - treat as not stale
    expect(isActionStale(text)).toBe(false)
  })
})
