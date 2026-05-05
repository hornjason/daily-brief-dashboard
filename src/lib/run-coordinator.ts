// run-coordinator.ts
//
// Shared running-state contract between background-scheduler and
// bootstrap-orchestrator. Neither file imports the other; both import from
// run-coordinator only. This breaks the historical circular import where
// background-scheduler imported `isBootstrapRunning` from bootstrap-orchestrator
// and bootstrap-orchestrator imported `enqueueScraperTask` from background-scheduler.
//
// Scope semantics:
//   - Each scope is a string key ('bootstrap', 'sf-sync', etc).
//   - setRunning(scope, true)  → scope is active.
//   - setRunning(scope, false) → scope is no longer active.
//   - isAnyRunning() → true if at least one scope is currently active.
//
// The enqueue() helper is a deliberately minimal FIFO bridge for fire-and-forget
// post-bootstrap hand-offs. It is NOT a replacement for background-scheduler's
// rich `_scraperQueue` (coalescing, retry, telemetry, etc) — that queue stays
// internal to background-scheduler.

const _running = new Map<string, boolean>()

const _queue: Array<() => Promise<void>> = []
let _processing = false

/** Mark a scope as running (true) or no longer running (false). */
export function setRunning(scope: string, value: boolean): void {
  if (value) _running.set(scope, true)
  else _running.delete(scope)
}

/** Returns true if any scope is currently marked running. */
export function isAnyRunning(): boolean {
  return _running.size > 0
}

/**
 * FIFO task runner. Tasks execute in enqueue order, one at a time. Errors
 * thrown by a task are swallowed so a single failure cannot stall the queue —
 * callers that need failure visibility should handle it inside the task body
 * (e.g. log, record telemetry).
 *
 * The returned promise resolves when THIS task finishes (after any tasks
 * already ahead of it in the queue), not when the queue drains.
 */
export function enqueue(task: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolveTask) => {
    const wrapped = async () => {
      try { await task() } catch (e: any) {
        console.warn('[run-coordinator] task failed:', e?.message ?? String(e))
      }
      resolveTask()
    }
    if (_queue.length >= 100) {
      console.warn('[run-coordinator] queue overflow — task dropped')
      resolveTask()
      return
    }
    _queue.push(wrapped)
    if (_processing) return
    _processing = true
    void (async () => {
      try {
        while (_queue.length > 0) {
          const t = _queue.shift()!
          await t()
        }
      } finally {
        _processing = false
      }
    })()
  })
}
