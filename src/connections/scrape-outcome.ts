// src/connections/scrape-outcome.ts
//
// Scrape outcome tracking with grace period for transient failures.
//
// A single transient scrape failure should NOT flip a connection to
// "Session expired" in the UI. We require either:
//   (a) an explicit auth-signal error (SessionExpiredError / SfSessionExpiredError),
//       in which case we expire immediately, OR
//   (b) two consecutive failures, which we treat as session likely dead.
//
// recordScrapeSuccess() resets the failure count so a single recovered run
// closes the grace window.
//
// BKL-SEC-CONN-01: failureCounts persisted to disk with 10-minute TTL so a
// server restart between two failures does not silently reset the grace window
// and miss a real auth expiry.

import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

export type ConnectionId = 'rh' | 'sf' | 'tableau'

const failureCounts: Record<ConnectionId, number> = { rh: 0, sf: 0, tableau: 0 }

const FAILURE_COUNTS_PATH = `${process.env.CONFIG_DIR ?? 'data/config'}/failure-counts.json`

function loadFailureCountsFromDisk(): void {
  try {
    const raw = readFileSync(FAILURE_COUNTS_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as { counts: Record<string, number>; savedAt: number }
    // Discard if older than 10 minutes
    if (Date.now() - parsed.savedAt > 10 * 60 * 1000) return
    for (const id of ['rh', 'sf', 'tableau'] as ConnectionId[]) {
      if (Number.isFinite(parsed.counts[id])) failureCounts[id] = parsed.counts[id]
    }
  } catch {
    // File missing or corrupt — start fresh (safe default)
  }
}

function persistFailureCounts(): void {
  const data = JSON.stringify({ counts: { ...failureCounts }, savedAt: Date.now() })
  writeFile(FAILURE_COUNTS_PATH, data, 'utf-8').catch(() => {})
}

// Load at module initialization
loadFailureCountsFromDisk()

export class SessionExpiredError extends Error {
  readonly isAuthSignal = true
  constructor(message: string) {
    super(message)
    this.name = 'SessionExpiredError'
  }
}

export interface ScrapeOutcome {
  /** True if caller should flip to 'expired' state */
  shouldExpire: boolean
  failureCount: number
}

export function recordScrapeFailure(id: ConnectionId, error: unknown): ScrapeOutcome {
  failureCounts[id]++
  // Recognize both the connection-layer SessionExpiredError above and
  // any error class whose name ends with 'SessionExpiredError'
  // (e.g. SfSessionExpiredError from sf-scraper, SessionExpiredError from rh-scraper).
  const isAuthError = error instanceof SessionExpiredError ||
    (error instanceof Error && /SessionExpiredError$/.test(error.name)) ||
    (error instanceof Error && (error as any).isAuthSignal === true)
  const shouldExpire = isAuthError || failureCounts[id] >= 2
  persistFailureCounts()
  return { shouldExpire, failureCount: failureCounts[id] }
}

export function recordScrapeSuccess(id: ConnectionId): void {
  failureCounts[id] = 0
  persistFailureCounts()
}

export function getFailureCount(id: ConnectionId): number {
  return failureCounts[id]
}

/** Test-only — reset all counters. */
export function __resetFailureCountsForTests(): void {
  failureCounts.rh = 0
  failureCounts.sf = 0
  failureCounts.tableau = 0
  persistFailureCounts()
}
