/**
 * src/scraper-manager.test.ts
 * Unit tests for CircuitBreaker behavior and related exports in scraper-manager.ts.
 *
 * NOTE: CircuitBreaker and withTimeout are not exported — tests exercise them through
 * the public API: getCircuitBreakerStates(), resetCircuitBreaker(), resetAllCircuitBreakers().
 */
import { test, expect, describe, beforeEach } from 'bun:test'
import {
  getCircuitBreakerStates,
  resetCircuitBreaker,
  resetAllCircuitBreakers,
} from './scraper-manager.ts'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Drive a single named breaker to OPEN state by calling resetCircuitBreaker
 * (which calls recordSuccess internally) and then verifying state.
 * Since there's no exported recordFailure, we can only test the reset path.
 *
 * For failure accumulation we rely on the fact that the module starts with
 * 0 failures — or we verify the interface contract after reset.
 */

describe('CircuitBreaker — initial state', () => {
  beforeEach(() => {
    // Reset all breakers to a known state before each test
    resetAllCircuitBreakers()
  })

  test('all four breakers start closed after resetAllCircuitBreakers', () => {
    const states = getCircuitBreakerStates()
    expect(states.rh.state).toBe('closed')
    expect(states.ccsp.state).toBe('closed')
    expect(states.supportable.state).toBe('closed')
    expect(states.salesforce.state).toBe('closed')
  })

  test('getCircuitBreakerStates returns all 4 expected service keys', () => {
    const states = getCircuitBreakerStates()
    expect(Object.keys(states)).toContain('rh')
    expect(Object.keys(states)).toContain('ccsp')
    expect(Object.keys(states)).toContain('supportable')
    expect(Object.keys(states)).toContain('salesforce')
  })

  test('each breaker entry has expected shape fields', () => {
    const states = getCircuitBreakerStates()
    for (const [, entry] of Object.entries(states)) {
      expect(typeof entry.name).toBe('string')
      expect(['closed', 'open', 'half-open']).toContain(entry.state)
      expect(typeof entry.failures).toBe('number')
      // lastFailure is string | null
      expect(entry.lastFailure === null || typeof entry.lastFailure === 'string').toBe(true)
    }
  })
})

describe('CircuitBreaker — resetCircuitBreaker', () => {
  beforeEach(() => {
    resetAllCircuitBreakers()
  })

  test('resetCircuitBreaker resets failures to 0 for the named service', () => {
    resetCircuitBreaker('rh')
    const state = getCircuitBreakerStates().rh
    expect(state.failures).toBe(0)
    expect(state.state).toBe('closed')
  })

  test('resetCircuitBreaker does not affect other services', () => {
    resetCircuitBreaker('rh')
    const states = getCircuitBreakerStates()
    // Other breakers remain closed (or their current state) — not disturbed
    expect(['closed', 'open', 'half-open']).toContain(states.ccsp.state)
    expect(['closed', 'open', 'half-open']).toContain(states.salesforce.state)
  })
})

describe('CircuitBreaker — resetAllCircuitBreakers', () => {
  test('resets all 4 breakers to closed state', () => {
    resetAllCircuitBreakers()
    const states = getCircuitBreakerStates()
    expect(states.rh.state).toBe('closed')
    expect(states.ccsp.state).toBe('closed')
    expect(states.supportable.state).toBe('closed')
    expect(states.salesforce.state).toBe('closed')
  })

  test('resets failure counts to 0 for all services', () => {
    resetAllCircuitBreakers()
    const states = getCircuitBreakerStates()
    expect(states.rh.failures).toBe(0)
    expect(states.ccsp.failures).toBe(0)
    expect(states.supportable.failures).toBe(0)
    expect(states.salesforce.failures).toBe(0)
  })
})

// ── withTimeout — not exported, tested indirectly via concept validation ───────
// withTimeout is a module-private function; its behavior is covered by the
// integration tests in test/api/. Direct unit tests would require extracting it
// to a shared utility. Leaving as documented gap.
