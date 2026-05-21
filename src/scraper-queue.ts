// ── BKL-ARCH-331: Scraper queue extraction — slice 2 ─────────────────────────
// Serializes browser-context scrapers (RH, SF, CCSP, Supportable).
// All scrapers share one BrowserContext (SSO constraint). Running them
// concurrently causes "Target page, context or browser has been closed" errors.
// The queue ensures at most one browser-consuming scraper runs at a time.

import { _rhScrapeRunning, _sfSyncRunning, ccspInFlight, runRhScrapeWithState, runSfSyncForAes } from './scraper-manager.ts'
import { isAnyRunning } from './lib/run-coordinator.ts'
import { updateSchedulerField } from './settings-api.ts'
import { aes } from './server-state.ts'

// ── Scraper queue types and state ────────────────────────────────────────────

export interface ScraperTask {
  name: string             // human-readable label for logging
  run: () => Promise<void> // the actual scraper function
  source: 'startup' | 'scheduled' | 'heartbeat' | 'manual'
  enqueuedAt: number       // Date.now() when enqueued
}

const _scraperQueue: ScraperTask[] = []
let _scraperQueueRunning = false  // true while a task from the queue is executing

/** Check all four scraper mutex flags + bootstrap — returns true if ANY browser scraper is active.
 *  BKL-W2-17: includes isAnyRunning() (from run-coordinator) so scheduled scrapers wait while
 *  bootstrap runs. bootstrap-orchestrator publishes its running state via setRunning('bootstrap', …). */
function isAnyScraperRunning(): boolean {
  return _rhScrapeRunning || _sfSyncRunning || ccspInFlight || isAnyRunning()
}

/**
 * Enqueue a scraper task. If nothing is running, it starts immediately.
 * Duplicate tasks (same name) are coalesced — if the same scraper is already
 * queued, the new request is dropped to avoid piling up.
 */
export function enqueueScraperTask(task: ScraperTask): void {
  // Coalesce: skip if same scraper name is already pending in queue
  if (_scraperQueue.some(t => t.name === task.name)) {
    console.log(`[scraper-queue] ${task.name} already queued — skipping duplicate (source: ${task.source})`)
    return
  }
  _scraperQueue.push(task)
  const position = _scraperQueue.length
  console.log(`[scraper-queue] ${task.name} queued (source: ${task.source}), position ${position}`)
  runNextInQueue()
}

/** Pop the next task off the queue and run it, if nothing else is running.
 *  Exported so the scheduler heartbeat can drain the queue between ticks. */
export function runNextInQueue(): void {
  if (_scraperQueueRunning) return
  if (isAnyScraperRunning()) {
    // A scraper started outside the queue (e.g. legacy direct call) is still running.
    // We'll retry on the next heartbeat tick or when the current task finishes.
    if (_scraperQueue.length > 0) {
      console.log(`[scraper-queue] waiting — a scraper is still running (${_scraperQueue.length} tasks pending)`)
    }
    return
  }
  const task = _scraperQueue.shift()
  if (!task) return

  const waitMs = Date.now() - task.enqueuedAt
  console.log(`[scraper-queue] starting ${task.name} (waited ${Math.round(waitMs / 1000)}s, ${_scraperQueue.length} remaining)`)
  _scraperQueueRunning = true

  task.run()
    .catch(e => console.error(`[scraper-queue] ${task.name} failed:`, e?.message ?? e))
    .finally(() => {
      _scraperQueueRunning = false
      console.log(`[scraper-queue] ${task.name} finished (${_scraperQueue.length} remaining)`)
      // Process next task after a brief yield to let mutex flags settle
      setTimeout(() => runNextInQueue(), 500)
    })
}

/** Get current queue state — exposed for status endpoints and admin visibility. */
export function getScraperQueueStatus(): { running: string | null; pending: string[]; isAnyRunning: boolean } {
  const runningTask = _scraperQueueRunning ? 'active' : null
  return {
    running: runningTask,
    pending: _scraperQueue.map(t => t.name),
    isAnyRunning: isAnyScraperRunning(),
  }
}

/**
 * Flush all 4 scrapers immediately after RH re-authentication.
 * Ordering: RH first (account numbers needed by Supportable), then SF and CCSP
 * (can start after RH since they don't depend on RH account numbers), Supportable last
 * (depends on RH account numbers being populated).
 * Coalesce guard in enqueueScraperTask prevents duplicates if already queued.
 */
export async function flushScrapersAfterAuth(): Promise<void> {
  console.log('[scraper-queue] post-auth flush: enqueueing all 4 scrapers')

  // RH first — populates account numbers consumed by Supportable
  // BKL-BOOT-SCRAPE-ORDER-01: skip if no AEs configured (same guard as catch-up and heartbeat)
  if (aes && aes.length > 0) {
    enqueueScraperTask({
      name: 'rh-cases',
      run: async () => {
        await runRhScrapeWithState()
        updateSchedulerField('rhLastRun', new Date().toISOString())
      },
      source: 'manual',
      enqueuedAt: Date.now(),
    })
  } else {
    console.log('[scraper-queue] post-auth flush: no AEs configured — skipping rh-cases')
  }

  // SF pipeline — independent of RH, can queue after RH
  const { aes: capturedAes } = await import('./server-state.ts')
  if (capturedAes.some((a: any) => !!a.sfReportId)) {
    enqueueScraperTask({
      name: 'sf-pipeline',
      run: async () => {
        await runSfSyncForAes(capturedAes)
      },
      source: 'manual',
      enqueuedAt: Date.now(),
    })
  }

  // BKL-ARCH-L4-SPLIT: CCSP and Supportable post-auth enqueue removed.
  // These scrapers run in Dockerfile.l4 only (Mac Mini primary node).
  // Hero installs flush only RH Cases and SF Pipeline on re-auth.
}

// ── ntfy.sh push notification helper ─────────────────────────────────────────
// Exported for use by both retry logic and scheduler watchdog alerts
const _NTFY_TOPIC_SCHED = process.env.NTFY_TOPIC ?? 'asa-command-center'
export async function notify(title: string, message: string, priority: 'default' | 'high' | 'urgent' = 'default'): Promise<void> {
  try {
    await fetch(`https://ntfy.sh/${_NTFY_TOPIC_SCHED}`, {
      method: 'POST',
      headers: { 'Title': title.slice(0, 64), 'Priority': priority, 'Content-Type': 'text/plain' },
      body: message.slice(0, 512),
    })
  } catch (e: any) {
    console.warn('[ntfy] scheduler notification failed:', e?.message ?? e)
  }
}

// ── BKL-INGEST-06: Retry helper for scheduled scrape failures ────────────────
// When a scheduled scrape's run callback throws, scheduleRetry() re-enqueues
// the same task after a back-off delay (5m → 10m → 15m). After all delays
// are exhausted, fires an urgent ntfy push so a human can intervene via VNC.
//
// The retry wrapper rethrows after scheduling the retry so the scraper queue's
// failure logging path still records the error — the queue's catch handler
// only logs, it does not act on the error.
export const RETRY_DELAYS = [5 * 60_000, 10 * 60_000, 15 * 60_000]

export function scheduleRetry(name: string, run: () => Promise<void>, delays: number[], attempt: number): void {
  if (attempt >= delays.length) {
    // All retries exhausted — notify urgently so a human can investigate via VNC.
    notify(`${name} sync failed`, `Scheduled sync failed after ${delays.length} retries — check VNC`, 'urgent').catch(() => {})
    return
  }
  const delay = delays[attempt]
  console.warn(`[${name}] retry ${attempt + 1}/${delays.length} in ${Math.round(delay / 60_000)}m`)
  setTimeout(() => {
    enqueueScraperTask({
      name,
      run: async () => {
        try {
          await run()
        } catch (e: any) {
          console.warn(`[${name}] retry ${attempt + 1} failed: ${e?.message ?? e}`)
          scheduleRetry(name, run, delays, attempt + 1)
          throw e
        }
      },
      source: 'scheduled',
      enqueuedAt: Date.now(),
    })
  }, delay)
}
