/**
 * scripts/ccsp-retry.ts — BKL-CCSP-RETRY-01 (GitHub issue #33)
 *
 * Retry wrapper for CCSP scraping calls in the L3 sync loop. Handles two
 * recoverable failure classes:
 *
 *   1. Transient timeouts / context errors → up to 3 retries with exponential
 *      back-off (120s → 300s → 600s) and a fresh browser context per retry.
 *   2. Tableau auth expired (peekTableauSessionExpired() === true) → throw
 *      CcspAuthExpiredError immediately, no retry. Auth state is shared across
 *      all PODs in the run, so the caller halts the rest of the loop.
 *
 * Extracted from scripts/sync-pod-l3.ts so it can be unit-tested without
 * pulling in the full sync orchestrator import graph (googleapis, scrapers,
 * email-sender, etc).
 *
 * The function takes its dependencies as an options bag so tests can inject
 * fakes (peek flag, sleep, context init, retry-status writer).
 */

import { CcspAuthExpiredError } from '../src/scraper-errors.ts'

// Re-export canonical type for callers that import from this module.
export { CcspAuthExpiredError }

/**
 * Backward-compatibility alias — one-release re-export window (BKL-ARCH-SCRAPER-05).
 * Existing `instanceof AuthExpiredError` checks keep working because this IS
 * CcspAuthExpiredError (same constructor reference).
 * @deprecated Use CcspAuthExpiredError from src/scraper-errors.ts directly.
 */
export const AuthExpiredError = CcspAuthExpiredError

/** Default exponential back-off in milliseconds. */
export const DEFAULT_CCSP_RETRY_DELAYS_MS: readonly number[] = [
  120_000,  // attempt 1 → wait 120s
  300_000,  // attempt 2 → wait 300s
  600_000,  // attempt 3 → wait 600s
]

export interface CcspRetryDeps {
  /** Reads the Tableau-session-expired flag without clearing it. */
  peekTableauSessionExpired: () => boolean
  /** Tears down + rebuilds the shared scrape browser context before each retry. */
  rebuildContext: () => Promise<void>
  /** Sleeps for the given ms. Tests pass an instant resolver. */
  sleep: (ms: number) => Promise<void>
  /**
   * Optional progress writer — called before each back-off wait so the
   * dashboard / sync-status.json shows `retry_in_progress` while waiting.
   * Failure is non-fatal; errors are swallowed by the caller.
   */
  writeRetryStatus?: (info: {
    podKey: string
    attempt: number
    nextRetryAt: string
  }) => Promise<void>
}

export interface CcspRetryResult<T> {
  /** The successful value returned by fn(). */
  value: T
  /** True if the value came from a retry attempt (attempt >= 2). */
  recovered: boolean
  /** 1-indexed attempt count that succeeded. */
  attempts: number
}

/**
 * Run `fn` with CCSP-aware retry semantics.
 *
 * Behaviour:
 *  - Try fn(). If it returns, resolve immediately with recovered=false.
 *  - If fn() throws and peekTableauSessionExpired() is true → throw
 *    AuthExpiredError(podKey). No retry, no back-off.
 *  - Otherwise sleep (delays[attempt-1]), call rebuildContext(), retry.
 *  - After delays.length unsuccessful attempts → throw the last error.
 *
 * @param fn        The CCSP scrape call to wrap. Must be idempotent.
 * @param podKey    Used for logging + AuthExpiredError message.
 * @param deps      Injected dependencies (peek, sleep, rebuild, status writer).
 * @param delays    Optional back-off schedule. Defaults to 120s/300s/600s.
 *                  Tests pass [0,0,0] to skip waits.
 */
export async function withCcspRetry<T>(
  fn: () => Promise<T>,
  podKey: string,
  deps: CcspRetryDeps,
  delays: readonly number[] = DEFAULT_CCSP_RETRY_DELAYS_MS,
): Promise<CcspRetryResult<T>> {
  const maxAttempts = delays.length + 1  // initial try + N retries
  let lastErr: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await fn()
      return { value, recovered: attempt > 1, attempts: attempt }
    } catch (err) {
      lastErr = err

      // Auth expired: shared session state is dead; do not retry.
      if (deps.peekTableauSessionExpired()) {
        throw new AuthExpiredError(podKey)
      }

      // Out of retries — bubble up the last error.
      if (attempt >= maxAttempts) {
        break
      }

      const delay = delays[attempt - 1]
      const nextRetryAt = new Date(Date.now() + delay).toISOString()
      const errMsg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[ccsp-retry] ${podKey}: attempt ${attempt}/${maxAttempts} failed (${errMsg}) — retrying in ${Math.round(delay / 1000)}s`,
      )

      // Best-effort progress write — failure is non-fatal.
      if (deps.writeRetryStatus) {
        try {
          await deps.writeRetryStatus({ podKey, attempt, nextRetryAt })
        } catch (writeErr: unknown) {
          const wMsg = writeErr instanceof Error ? writeErr.message : String(writeErr)
          console.warn(`[ccsp-retry] ${podKey}: retry-status write failed: ${wMsg}`)
        }
      }

      await deps.sleep(delay)

      try {
        await deps.rebuildContext()
      } catch (rebuildErr: unknown) {
        const rMsg = rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr)
        console.warn(`[ccsp-retry] ${podKey}: context rebuild failed: ${rMsg} — proceeding with retry anyway`)
      }
    }
  }

  // All retries exhausted.
  throw lastErr
}
