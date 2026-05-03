// BKL-CCSP-RETRY-01 (GitHub issue #33):
// Regression tests for withCcspRetry() in scripts/ccsp-retry.ts
//
// withCcspRetry wraps a CCSP scrape call with two recoverable failure paths:
//   1. Transient timeouts/context errors → up to N retries with back-off,
//      rebuilding the browser context between attempts.
//   2. Tableau auth expired (peekTableauSessionExpired() === true) → throw
//      AuthExpiredError immediately. No retry, no back-off.
//
// Tests inject mocks for peekTableauSessionExpired, sleep, rebuildContext,
// and writeRetryStatus so the suite runs instantly without a real browser
// or any of the sync-pod-l3 import graph.

import { test, expect, describe, mock } from 'bun:test'
import {
  withCcspRetry,
  AuthExpiredError,
  DEFAULT_CCSP_RETRY_DELAYS_MS,
} from '../../scripts/ccsp-retry.ts'

// Helper: build a deps bag with sensible defaults that tests override per-case.
// Returns concrete bun:test mock instances (not `Mock<...>` interface) so each
// field exposes `.mock.calls` and friends to per-test assertions.
function makeDeps(overrides: {
  peekTableauSessionExpired?: ReturnType<typeof mock<() => boolean>>
  rebuildContext?: ReturnType<typeof mock<() => Promise<void>>>
  sleep?: ReturnType<typeof mock<(ms: number) => Promise<void>>>
  writeRetryStatus?: ReturnType<typeof mock<(info: { podKey: string; attempt: number; nextRetryAt: string }) => Promise<void>>>
} = {}) {
  return {
    peekTableauSessionExpired: overrides.peekTableauSessionExpired ?? mock(() => false),
    rebuildContext: overrides.rebuildContext ?? mock(async () => {}),
    sleep: overrides.sleep ?? mock(async (_ms: number) => {}),
    writeRetryStatus:
      overrides.writeRetryStatus ??
      mock(async (_info: { podKey: string; attempt: number; nextRetryAt: string }) => {}),
  }
}

const ZERO_DELAYS = [0, 0, 0]

// ── 1. Success on first attempt ───────────────────────────────────────────────

describe('withCcspRetry — success on first attempt', () => {
  test('returns result without retry, recovered=false, attempts=1', async () => {
    const fn = mock(async () => ({ rows: [{ a: '1' }, { a: '2' }] }))
    const deps = makeDeps()

    const result = await withCcspRetry(fn, 'POD_TEST', deps, ZERO_DELAYS)

    expect(result.value).toEqual({ rows: [{ a: '1' }, { a: '2' }] })
    expect(result.recovered).toBe(false)
    expect(result.attempts).toBe(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(deps.sleep).toHaveBeenCalledTimes(0)
    expect(deps.rebuildContext).toHaveBeenCalledTimes(0)
    expect(deps.peekTableauSessionExpired).toHaveBeenCalledTimes(0)
    expect(deps.writeRetryStatus).toHaveBeenCalledTimes(0)
  })
})

// ── 2. Transient failure on attempt 1, success on attempt 2 ───────────────────

describe('withCcspRetry — recovers after one transient failure', () => {
  test('returns success with recovered=true, attempts=2, sleeps once, rebuilds once', async () => {
    let calls = 0
    const fn = mock(async () => {
      calls++
      if (calls === 1) throw new Error('timeout: viz did not load')
      return { rows: [{ a: 'x' }] }
    })
    const deps = makeDeps()

    const result = await withCcspRetry(fn, 'POD_RECOVER', deps, ZERO_DELAYS)

    expect(result.value).toEqual({ rows: [{ a: 'x' }] })
    expect(result.recovered).toBe(true)
    expect(result.attempts).toBe(2)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(deps.sleep).toHaveBeenCalledTimes(1)
    expect(deps.rebuildContext).toHaveBeenCalledTimes(1)
    // peek is checked once per failure, before deciding to retry
    expect(deps.peekTableauSessionExpired).toHaveBeenCalledTimes(1)
    // retry-status writer fires once before the sleep
    expect(deps.writeRetryStatus).toHaveBeenCalledTimes(1)
    expect(deps.writeRetryStatus.mock.calls[0][0].podKey).toBe('POD_RECOVER')
    expect(deps.writeRetryStatus.mock.calls[0][0].attempt).toBe(1)
    expect(typeof deps.writeRetryStatus.mock.calls[0][0].nextRetryAt).toBe('string')
  })
})

// ── 3. Auth expired on first failure → AuthExpiredError, no retry ─────────────

describe('withCcspRetry — auth-expired aborts immediately', () => {
  test('throws AuthExpiredError, no retry, no sleep, no rebuild', async () => {
    const fn = mock(async () => {
      throw new Error('navigation failed: tableau-online login redirect')
    })
    const deps = makeDeps({
      peekTableauSessionExpired: mock(() => true),
    })

    let caught: unknown
    try {
      await withCcspRetry(fn, 'POD_AUTH', deps, ZERO_DELAYS)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(AuthExpiredError)
    expect((caught as AuthExpiredError).message).toContain('POD_AUTH')
    expect((caught as AuthExpiredError).name).toBe('AuthExpiredError')
    // Only one fn call — no retry attempted
    expect(fn).toHaveBeenCalledTimes(1)
    expect(deps.sleep).toHaveBeenCalledTimes(0)
    expect(deps.rebuildContext).toHaveBeenCalledTimes(0)
    expect(deps.writeRetryStatus).toHaveBeenCalledTimes(0)
    // peek consulted exactly once on the failure
    expect(deps.peekTableauSessionExpired).toHaveBeenCalledTimes(1)
  })
})

// ── 4. Three transient failures → throws last error after exhausting retries ──

describe('withCcspRetry — exhausted retries surface the last error', () => {
  test('throws the last fn() error after delays.length+1 attempts', async () => {
    let attempt = 0
    const fn = mock(async () => {
      attempt++
      throw new Error(`transient #${attempt}`)
    })
    const deps = makeDeps()

    let caught: unknown
    try {
      // delays=[0,0,0] → 1 initial + 3 retries = 4 total attempts
      await withCcspRetry(fn, 'POD_EXHAUST', deps, ZERO_DELAYS)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    // Must be the LAST error, not the first
    expect((caught as Error).message).toBe('transient #4')
    expect(fn).toHaveBeenCalledTimes(4)
    // Slept between each retry (3 times) — not after the final failure
    expect(deps.sleep).toHaveBeenCalledTimes(3)
    expect(deps.rebuildContext).toHaveBeenCalledTimes(3)
    expect(deps.writeRetryStatus).toHaveBeenCalledTimes(3)
    // Should NOT be an AuthExpiredError
    expect(caught).not.toBeInstanceOf(AuthExpiredError)
  })
})

// ── 5. AuthExpiredError class shape ───────────────────────────────────────────

describe('AuthExpiredError', () => {
  test('has correct name property and includes podKey in message', () => {
    const err = new AuthExpiredError('POD_FOO')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AuthExpiredError')
    expect(err.message).toContain('POD_FOO')
    expect(err.message).toContain('Tableau auth expired')
  })

  test('instanceof AuthExpiredError works after throw/catch', () => {
    let caught: unknown
    try {
      throw new AuthExpiredError('POD_BAR')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AuthExpiredError)
    expect(caught).toBeInstanceOf(Error)
  })
})

// ── 6. DEFAULT_CCSP_RETRY_DELAYS_MS shape ─────────────────────────────────────

describe('DEFAULT_CCSP_RETRY_DELAYS_MS', () => {
  test('is a 3-element array of [120s, 300s, 600s] in milliseconds', () => {
    expect(DEFAULT_CCSP_RETRY_DELAYS_MS).toHaveLength(3)
    expect(DEFAULT_CCSP_RETRY_DELAYS_MS[0]).toBe(120_000)
    expect(DEFAULT_CCSP_RETRY_DELAYS_MS[1]).toBe(300_000)
    expect(DEFAULT_CCSP_RETRY_DELAYS_MS[2]).toBe(600_000)
  })
})

// ── 7. writeRetryStatus failure is non-fatal ──────────────────────────────────

describe('withCcspRetry — non-fatal writeRetryStatus error', () => {
  test('retry continues even if writeRetryStatus throws', async () => {
    let calls = 0
    const fn = mock(async () => {
      calls++
      if (calls === 1) throw new Error('transient')
      return { rows: [] }
    })
    const deps = makeDeps({
      writeRetryStatus: mock(async () => { throw new Error('drive offline') }),
    })

    const result = await withCcspRetry(fn, 'POD_WRITE_FAIL', deps, ZERO_DELAYS)
    expect(result.recovered).toBe(true)
    expect(result.attempts).toBe(2)
  })
})

// ── 8. rebuildContext failure is non-fatal ────────────────────────────────────

describe('withCcspRetry — non-fatal rebuildContext error', () => {
  test('retry continues even if rebuildContext throws', async () => {
    let calls = 0
    const fn = mock(async () => {
      calls++
      if (calls === 1) throw new Error('transient')
      return { rows: [] }
    })
    const deps = makeDeps({
      rebuildContext: mock(async () => { throw new Error('chromium crashed') }),
    })

    const result = await withCcspRetry(fn, 'POD_REBUILD_FAIL', deps, ZERO_DELAYS)
    expect(result.recovered).toBe(true)
    expect(result.attempts).toBe(2)
  })
})
