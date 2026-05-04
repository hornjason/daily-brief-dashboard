// src/scraper-utils.ts
// Shared guards extracted from scraper modules (BKL-ARCH-SCRAPER-06).

/**
 * Throws if DISALLOW_LIVE_SCRAPE=1 is set (test environment block).
 * Must be the first check in any function that does live browser/network work.
 */
export function assertLiveScrapeAllowed(serviceName: string): void {
  if (process.env.DISALLOW_LIVE_SCRAPE === '1') {
    throw new Error(`[${serviceName}] DISALLOW_LIVE_SCRAPE=1 — live scrape blocked in test environment`)
  }
}
