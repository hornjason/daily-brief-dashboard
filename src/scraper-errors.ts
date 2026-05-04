/**
 * src/scraper-errors.ts — BKL-ARCH-SCRAPER-05
 *
 * Scraper-domain error types. Lives in src/ (scraper domain) rather than
 * scripts/ (orchestrator layer). scripts/ccsp-retry.ts re-exports
 * CcspAuthExpiredError under the legacy AuthExpiredError alias for one
 * release of backward compatibility.
 */

/** Base class for all scraper-domain errors. */
export abstract class ScraperError extends Error {
  abstract readonly retryable: boolean
}

/**
 * Thrown when peekTableauSessionExpired() returns true during a CCSP retry.
 * The auth state is shared across all PODs in the run, so the caller halts
 * the rest of the loop.
 *
 * retryable = false — auth must be re-established externally; no point in
 * retrying the same scrape call.
 */
export class CcspAuthExpiredError extends ScraperError {
  readonly retryable = false
  constructor(public readonly podKey: string) {
    super(`Tableau auth expired during CCSP sync (pod: ${podKey})`)
    this.name = 'CcspAuthExpiredError'
  }
}
