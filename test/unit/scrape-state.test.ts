// BKL-ARCH-06 issue #52: Unit tests for src/scrape-state.ts
//
// scrape-state.ts owns:
//   • Per-scraper running flag (acquire/release/isRunning)
//   • CircuitBreaker class + the three named breakers (rh-cases, ccsp, sf-pipeline)
//   • Convenience routes: resetCircuit, recordOutcome
//   • Reset hooks (registerResetAllHook) for cross-module cleanup
//
// These tests pin the public contract so the extraction from scraper-manager.ts
// is verifiable without booting the full server.

import { test, expect, describe, beforeEach } from 'bun:test'
import {
  acquire,
  release,
  isRunning,
  resetCircuit,
  recordOutcome,
  circuitBreakers,
  getCircuitBreakerStates,
  resetCircuitBreaker,
  resetAllCircuitBreakers,
  registerResetAllHook,
  CircuitBreaker,
} from '../../src/scrape-state.ts'

beforeEach(() => {
  // Reset every breaker between tests so state doesn't leak across cases.
  for (const cb of Object.values(circuitBreakers)) {
    cb.recordSuccess()
  }
  // Drain running flags (acquire-twice protection means we just release any held names).
  for (const name of ['rh-cases', 'ccsp', 'sf-pipeline', 'arbitrary-name']) {
    if (isRunning(name)) release(name)
  }
})

describe('running-flag mutex', () => {
  test('acquire flips isRunning to true', () => {
    expect(isRunning('rh-cases')).toBe(false)
    acquire('rh-cases')
    expect(isRunning('rh-cases')).toBe(true)
  })

  test('release flips isRunning back to false', () => {
    acquire('ccsp')
    release('ccsp')
    expect(isRunning('ccsp')).toBe(false)
  })

  test('acquire/release are independent across names', () => {
    acquire('rh-cases')
    expect(isRunning('rh-cases')).toBe(true)
    expect(isRunning('ccsp')).toBe(false)
    release('rh-cases')
    expect(isRunning('rh-cases')).toBe(false)
  })

  test('release on a never-acquired name is a no-op', () => {
    expect(() => release('never-set')).not.toThrow()
    expect(isRunning('never-set')).toBe(false)
  })
})

describe('circuit breaker lifecycle', () => {
  test('breaker stays closed below threshold', () => {
    const cb = new CircuitBreaker('test-cb', () => 3, () => 60_000)
    cb.recordFailure('boom')
    cb.recordFailure('boom')
    expect(cb.isOpen()).toBe(false)
    expect(cb.getState().state).toBe('closed')
  })

  test('breaker opens at threshold and reports state=open', () => {
    const cb = new CircuitBreaker('test-cb', () => 3, () => 60_000)
    cb.recordFailure('a')
    cb.recordFailure('b')
    cb.recordFailure('c')
    expect(cb.isOpen()).toBe(true)
    expect(cb.getState().state).toBe('open')
    expect(cb.getState().failures).toBe(3)
  })

  test('recordSuccess resets failure count and closes the breaker', () => {
    const cb = new CircuitBreaker('test-cb', () => 2, () => 60_000)
    cb.recordFailure('x')
    cb.recordFailure('y')
    expect(cb.isOpen()).toBe(true)
    cb.recordSuccess()
    expect(cb.isOpen()).toBe(false)
    expect(cb.getState().failures).toBe(0)
  })

  test('half-open after cooldown elapses', () => {
    const cb = new CircuitBreaker('test-cb', () => 1, () => 50) // threshold=1, cooldown=50ms
    cb.recordFailure('once')
    expect(cb.isOpen()).toBe(true)
    // Wait past cooldown.
    return new Promise<void>(resolve => setTimeout(() => {
      expect(cb.isOpen()).toBe(false)
      expect(cb.getState().state).toBe('half-open')
      resolve()
    }, 100))
  })

  test('session-expired pin holds breaker open even with low failure count', () => {
    const cb = new CircuitBreaker('test-cb', () => 999, () => 60_000)
    cb.recordFailure('auth gone', /* sessionExpired */ true)
    expect(cb.isOpen()).toBe(true)
  })
})

describe('named convenience routes', () => {
  test('resetCircuit clears a named breaker via recordSuccess', () => {
    circuitBreakers['rh-cases'].recordFailure('x')
    circuitBreakers['rh-cases'].recordFailure('y')
    circuitBreakers['rh-cases'].recordFailure('z')
    expect(circuitBreakers['rh-cases'].isOpen()).toBe(true)
    resetCircuit('rh-cases')
    expect(circuitBreakers['rh-cases'].isOpen()).toBe(false)
  })

  test('resetCircuit on unknown name is a safe no-op', () => {
    expect(() => resetCircuit('not-a-real-service')).not.toThrow()
  })

  test('recordOutcome(success=true) routes to recordSuccess', () => {
    circuitBreakers.ccsp.recordFailure('boom')
    expect(circuitBreakers.ccsp.getState().failures).toBe(1)
    recordOutcome('ccsp', true)
    expect(circuitBreakers.ccsp.getState().failures).toBe(0)
  })

  test('recordOutcome(success=false) routes to recordFailure with reason', () => {
    recordOutcome('sf-pipeline', false, 'http 503')
    expect(circuitBreakers['sf-pipeline'].getState().failures).toBe(1)
    expect(circuitBreakers['sf-pipeline'].getState().lastFailure).toBe('http 503')
  })

  test('recordOutcome(false) without reason uses "unknown"', () => {
    recordOutcome('rh-cases', false)
    expect(circuitBreakers['rh-cases'].getState().lastFailure).toBe('unknown')
  })
})

describe('getCircuitBreakerStates', () => {
  test('returns all three named services with closed state by default', () => {
    const states = getCircuitBreakerStates()
    expect(Object.keys(states).sort()).toEqual(['ccsp', 'rh-cases', 'sf-pipeline'])
    expect(states['rh-cases'].state).toBe('closed')
    expect(states.ccsp.state).toBe('closed')
    expect(states['sf-pipeline'].state).toBe('closed')
  })

  test('reflects per-service failure count', () => {
    circuitBreakers.ccsp.recordFailure('blip')
    const states = getCircuitBreakerStates()
    expect(states.ccsp.failures).toBe(1)
    expect(states['rh-cases'].failures).toBe(0)
  })
})

describe('resetCircuitBreaker (named)', () => {
  test('resets only the named service, leaves others alone', () => {
    circuitBreakers['rh-cases'].recordFailure('x')
    circuitBreakers.ccsp.recordFailure('y')
    resetCircuitBreaker('rh-cases')
    expect(circuitBreakers['rh-cases'].getState().failures).toBe(0)
    expect(circuitBreakers.ccsp.getState().failures).toBe(1)
  })
})

describe('resetAllCircuitBreakers + reset hooks', () => {
  test('clears every named breaker', () => {
    circuitBreakers['rh-cases'].recordFailure('a')
    circuitBreakers.ccsp.recordFailure('b')
    circuitBreakers['sf-pipeline'].recordFailure('c')
    resetAllCircuitBreakers()
    expect(circuitBreakers['rh-cases'].getState().failures).toBe(0)
    expect(circuitBreakers.ccsp.getState().failures).toBe(0)
    expect(circuitBreakers['sf-pipeline'].getState().failures).toBe(0)
  })

  test('fires registered reset hook (used by scraper-manager to clear _sfSessionExpired)', () => {
    let hookFired = 0
    const unregister = registerResetAllHook(() => { hookFired++ })
    try {
      resetAllCircuitBreakers()
      expect(hookFired).toBe(1)
      resetAllCircuitBreakers()
      expect(hookFired).toBe(2)
    } finally {
      unregister()
    }
  })

  test('unregister stops further hook firings', () => {
    let hookFired = 0
    const unregister = registerResetAllHook(() => { hookFired++ })
    resetAllCircuitBreakers()
    unregister()
    resetAllCircuitBreakers()
    expect(hookFired).toBe(1)
  })

  test('hook errors do not break reset', () => {
    const unregister = registerResetAllHook(() => { throw new Error('boom') })
    try {
      // Should not throw — hook errors are isolated.
      expect(() => resetAllCircuitBreakers()).not.toThrow()
    } finally {
      unregister()
    }
  })
})
