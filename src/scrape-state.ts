// BKL-ARCH-06 issue #52: scrape-state ownership module.
//
// Why this file exists
// --------------------
// `rh-auth.ts` and `sf-auth.ts` both need to call `resetAllCircuitBreakers()`
// after a successful re-authentication. Previously those functions were
// defined in `scraper-manager.ts`, which itself imports from `rh-auth.ts` and
// `sf-auth.ts` for orchestration. That formed a circular import:
//
//     scraper-manager  ──imports── rh-auth   ──imports── scraper-manager
//                              \── sf-auth   ──imports── scraper-manager
//
// Extracting the circuit breaker + running-flag state into a standalone
// module that neither auth file nor scraper-manager.ts depends on for
// anything else breaks the cycle. Auth files now import from
// `./scrape-state.ts` instead of `./scraper-manager.ts`.
//
// scraper-manager.ts re-exports the same names so existing callers
// (scrape-api.ts, etc.) keep working unchanged.
//
// Cross-module reset behavior
// ---------------------------
// `resetAllCircuitBreakers()` historically also flipped scraper-manager's
// `_sfSessionExpired` flag back to false. We can't import that flag here
// without recreating a cycle, so this module exposes `registerResetAllHook()`
// — scraper-manager.ts registers a hook at module init that clears the flag.
// Same observable behavior, no cycle.

import { getAutomationConfig } from './ai-config.ts'

// ── CircuitBreaker class ────────────────────────────────────────────────────
//
// BKL-SR03-F1: threshold/cooldownMs are read lazily via getter functions so
// that changes saved through POST /api/settings/automation take effect on the
// live breakers without a container restart. Do NOT bake config values into
// instance fields at construction.

export class CircuitBreaker {
  private _failureCount = 0
  private _openedAt: number | null = null
  private _lastFailure: string | null = null
  _sessionExpired = false
  _sessionExpiredAt: number | null = null
  readonly name: string
  private readonly _getThreshold: () => number
  private readonly _getCooldownMs: () => number

  constructor(
    name: string,
    getThreshold: () => number = () => 3,
    getCooldownMs: () => number = () => 5 * 60 * 1000,
  ) {
    this.name = name
    this._getThreshold = getThreshold
    this._getCooldownMs = getCooldownMs
  }

  /** Current threshold — read lazily from config every call (BKL-SR03-F1). */
  get threshold(): number {
    return this._getThreshold()
  }

  /** Current cooldownMs — read lazily from config every call (BKL-SR03-F1). */
  get cooldownMs(): number {
    return this._getCooldownMs()
  }

  /** Returns true if the circuit is open (service should be skipped). */
  isOpen(): boolean {
    // Session-expiry pin: hold open for 4 hours after a SessionExpiredError
    if (this._sessionExpired) {
      const elapsed = Date.now() - (this._sessionExpiredAt ?? 0)
      if (elapsed < 4 * 60 * 60 * 1000) {
        return true
      }
      // 4-hour window elapsed — clear the pin and fall through to normal logic
      this._sessionExpired = false
      this._sessionExpiredAt = null
      console.log(`[circuit-breaker] ${this.name}: session-expiry pin cleared after 4h — allowing retry`)
    }
    const threshold = this._getThreshold()
    const cooldownMs = this._getCooldownMs()
    if (this._failureCount < threshold) return false
    // Check if cooldown has elapsed — if so, allow a retry (half-open)
    if (this._openedAt && (Date.now() - this._openedAt) >= cooldownMs) {
      console.log(`[circuit-breaker] ${this.name}: cooldown elapsed — allowing retry (half-open)`)
      return false
    }
    return true
  }

  recordSuccess(): void {
    if (this._failureCount > 0) {
      console.log(`[circuit-breaker] ${this.name}: success — resetting (was at ${this._failureCount} failures)`)
    }
    this._failureCount = 0
    this._openedAt = null
    this._lastFailure = null
    this._sessionExpired = false
    this._sessionExpiredAt = null
  }

  recordFailure(reason: string, sessionExpired = false): void {
    this._failureCount++
    this._lastFailure = reason
    if (sessionExpired) {
      this._sessionExpired = true
      this._sessionExpiredAt = Date.now()
      console.warn(`[circuit-breaker] ${this.name}: session-expiry pin set — held open for 4h`)
    }
    const threshold = this._getThreshold()
    const cooldownMs = this._getCooldownMs()
    if (this._failureCount >= threshold) {
      this._openedAt = Date.now()
      console.warn(`[circuit-breaker] ${this.name}: OPEN after ${this._failureCount} failures — cooldown ${cooldownMs / 1000}s (last: ${reason})`)
    } else {
      console.warn(`[circuit-breaker] ${this.name}: failure ${this._failureCount}/${threshold} (${reason})`)
    }
  }

  getState(): { name: string; state: 'closed' | 'open' | 'half-open'; failures: number; lastFailure: string | null } {
    let state: 'closed' | 'open' | 'half-open' = 'closed'
    const threshold = this._getThreshold()
    const cooldownMs = this._getCooldownMs()
    if (this._failureCount >= threshold) {
      state = (this._openedAt && (Date.now() - this._openedAt) >= cooldownMs) ? 'half-open' : 'open'
    }
    return { name: this.name, state, failures: this._failureCount, lastFailure: this._lastFailure }
  }
}

// ── Named breakers (one per known service) ─────────────────────────────────

const _thresholdGetter   = (): number => getAutomationConfig().circuitBreakerThreshold
const _cooldownMsGetter  = (): number => getAutomationConfig().circuitBreakerCooldownMs

export const circuitBreakers: Record<'rh-cases' | 'ccsp' | 'sf-pipeline', CircuitBreaker> = {
  'rh-cases':    new CircuitBreaker('rh-cases',    _thresholdGetter, _cooldownMsGetter),
  ccsp:          new CircuitBreaker('ccsp',        _thresholdGetter, _cooldownMsGetter),
  'sf-pipeline': new CircuitBreaker('sf-pipeline', _thresholdGetter, _cooldownMsGetter),
}

/** Get circuit breaker states for all services — exposed for /api/status endpoint. */
export function getCircuitBreakerStates(): Record<string, ReturnType<CircuitBreaker['getState']>> {
  return {
    'rh-cases':    circuitBreakers['rh-cases'].getState(),
    ccsp:          circuitBreakers.ccsp.getState(),
    'sf-pipeline': circuitBreakers['sf-pipeline'].getState(),
  }
}

/** Reset a single circuit breaker — used when auth is re-established. */
export function resetCircuitBreaker(service: 'rh-cases' | 'ccsp' | 'sf-pipeline'): void {
  circuitBreakers[service].recordSuccess()
  console.log(`[circuit-breaker] ${service}: reset by auth event`)
}

// ── Reset hooks (cross-module side-effects on resetAllCircuitBreakers) ─────
//
// scraper-manager.ts registers a hook at module init to clear its
// `_sfSessionExpired` module-local flag whenever we reset all breakers. We
// can't reach that flag from here without re-introducing the cycle this
// module exists to break.

type ResetAllHook = () => void
const _resetAllHooks: Set<ResetAllHook> = new Set()

/**
 * Register a callback fired on every `resetAllCircuitBreakers()` call.
 * Returns an unregister function. Hook errors are caught and logged so a
 * single bad hook can't block the rest of the reset path.
 */
export function registerResetAllHook(hook: ResetAllHook): () => void {
  _resetAllHooks.add(hook)
  return () => { _resetAllHooks.delete(hook) }
}

/** Reset ALL circuit breakers — called on re-authentication (cold-start recovery). */
export function resetAllCircuitBreakers(): void {
  for (const [name, cb] of Object.entries(circuitBreakers)) {
    if (cb.getState().failures > 0 || cb._sessionExpired) {
      cb.recordSuccess()
      console.log(`[circuit-breaker] ${name}: reset by auth event`)
    }
  }
  // Run cross-module cleanup hooks (scraper-manager clears _sfSessionExpired here).
  for (const hook of _resetAllHooks) {
    try {
      hook()
    } catch (e: any) {
      console.warn('[scrape-state] resetAll hook failed:', e?.message ?? e)
    }
  }
}

// ── Running-flag mutex (issue #52 public interface) ────────────────────────
//
// Bun is single-threaded, so a Map<string, boolean> is sufficient. The
// per-scraper inner mutexes (e.g. `_rhScrapeRunning` in rh-scraper.ts) remain
// authoritative for the actual scraper-managed lifecycle. This map is the
// generic mutex surface specified in the issue contract.

const _running: Map<string, boolean> = new Map()

/** Mark a named scraper as running. */
export function acquire(name: string): void {
  _running.set(name, true)
}

/** Mark a named scraper as stopped. */
export function release(name: string): void {
  _running.set(name, false)
}

/** Query whether a named scraper is currently running. */
export function isRunning(name: string): boolean {
  return _running.get(name) === true
}

// ── Generic outcome routing (issue #52 public interface) ───────────────────

/**
 * Reset the named circuit breaker (recordSuccess equivalent).
 * Safe no-op if the name isn't a known breaker.
 */
export function resetCircuit(name: string): void {
  const cb = (circuitBreakers as Record<string, CircuitBreaker>)[name]
  cb?.recordSuccess()
}

/**
 * Record a scrape outcome on the named breaker.
 * Routes to recordSuccess() or recordFailure(reason) on the breaker.
 * Safe no-op if the name isn't a known breaker.
 */
export function recordOutcome(name: string, success: boolean, reason?: string): void {
  const cb = (circuitBreakers as Record<string, CircuitBreaker>)[name]
  if (!cb) return
  if (success) cb.recordSuccess()
  else cb.recordFailure(reason ?? 'unknown')
}
