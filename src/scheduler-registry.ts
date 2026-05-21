// src/scheduler-registry.ts
// ADR-028: Unified Scheduler Registry — Phase 1 infrastructure
//
// Owns setTimeout lifecycle for scheduled tasks. Modules declare their schedule
// at registration time; the registry manages timers, tracks last-run/next-run,
// and exposes status via admin endpoint.
//
// Does NOT own:
// - The 15-minute heartbeat setInterval (stays in background-scheduler.ts)
// - Scraper queue serialization (stays in scraper-queue.ts)
// - Retry logic (stays alongside scraper queue)
// - Startup catch-up logic (depends on sync-state, not schedule state)

import { nextEtTimeUtc, nextEtWeekdayUtc } from './lib/et-time'

export interface ScheduleEntry {
  /** Unique task name — used for logging, status, admin visibility */
  name: string

  /** When to run */
  type: 'daily' | 'weekly' | 'interval' | 'heartbeat'

  /** For daily: hour + minute (ET) */
  hour?: number
  minute?: number

  /** For weekly: dayOfWeek (0=Sun) + hour + minute */
  dayOfWeek?: number

  /** For interval: intervalMs */
  intervalMs?: number

  /** Whether this task is currently enabled. Can be boolean or function re-checked at fire time. */
  enabled: boolean | (() => boolean)

  /** The work to perform */
  run: () => Promise<void>

  /** ISO timestamp of last run */
  lastRun?: string

  /** ISO timestamp of next scheduled run (computed) */
  nextRun?: string

  /** Last error message if task failed */
  lastError?: string

  /** Current state */
  state: 'idle' | 'running' | 'error'
}

export interface ScheduleStatus {
  name: string
  type: 'daily' | 'weekly' | 'interval' | 'heartbeat'
  enabled: boolean
  state: 'idle' | 'running' | 'error'
  lastRun?: string
  nextRun?: string
  lastError?: string
  hour?: number
  minute?: number
  dayOfWeek?: number
  intervalMs?: number
}

export class SchedulerRegistry {
  private entries: Map<string, ScheduleEntry> = new Map()
  private timers: Map<string, NodeJS.Timeout> = new Map()

  /**
   * Register a new schedule entry.
   * Throws if an entry with the same name already exists.
   */
  register(
    entry: Omit<ScheduleEntry, 'state' | 'lastRun' | 'nextRun' | 'lastError'>,
  ): void {
    if (this.entries.has(entry.name)) {
      throw new Error(`Schedule entry '${entry.name}' is already registered`)
    }

    const fullEntry: ScheduleEntry = {
      ...entry,
      state: 'idle',
    }

    // Compute initial nextRun for daily/weekly entries
    if (entry.type === 'daily' && entry.hour !== undefined && entry.minute !== undefined) {
      const next = nextEtTimeUtc(entry.hour, entry.minute)
      fullEntry.nextRun = next.toISOString()
    } else if (
      entry.type === 'weekly' &&
      entry.dayOfWeek !== undefined &&
      entry.hour !== undefined &&
      entry.minute !== undefined
    ) {
      const next = nextEtWeekdayUtc(entry.dayOfWeek, entry.hour, entry.minute)
      fullEntry.nextRun = next.toISOString()
    }

    this.entries.set(entry.name, fullEntry)
  }

  /**
   * Start the timer for a specific entry.
   */
  start(name: string): void {
    const entry = this.entries.get(name)
    if (!entry) {
      console.warn(`[scheduler-registry] Cannot start '${name}' — not registered`)
      return
    }

    // Don't start if already running
    if (this.timers.has(name)) {
      console.warn(`[scheduler-registry] '${name}' already started`)
      return
    }

    if (entry.type === 'daily' || entry.type === 'weekly') {
      this.scheduleDailyOrWeekly(name, entry)
    } else if (entry.type === 'interval') {
      this.scheduleInterval(name, entry)
    } else if (entry.type === 'heartbeat') {
      // Heartbeat entries are managed by the existing 15-min tick in background-scheduler.ts
      // They don't get their own timer — they're checked on each heartbeat tick.
      console.log(
        `[scheduler-registry] '${name}' registered as heartbeat — managed by heartbeat tick`,
      )
    }
  }

  /**
   * Start all registered entries.
   */
  startAll(): void {
    for (const name of this.entries.keys()) {
      this.start(name)
    }
  }

  /**
   * Stop the timer for a specific entry.
   */
  stop(name: string): void {
    const timer = this.timers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(name)
      console.log(`[scheduler-registry] '${name}' stopped`)
    }
  }

  /**
   * Stop all running timers (graceful shutdown).
   */
  stopAll(): void {
    for (const name of this.timers.keys()) {
      this.stop(name)
    }
  }

  /**
   * Get status of all registered entries.
   */
  getStatus(): ScheduleStatus[] {
    return Array.from(this.entries.values()).map(entry => {
      const enabled = typeof entry.enabled === 'function' ? entry.enabled() : entry.enabled
      return {
        name: entry.name,
        type: entry.type,
        enabled,
        state: entry.state,
        lastRun: entry.lastRun,
        nextRun: entry.nextRun,
        lastError: entry.lastError,
        hour: entry.hour,
        minute: entry.minute,
        dayOfWeek: entry.dayOfWeek,
        intervalMs: entry.intervalMs,
      }
    })
  }

  /**
   * Get a specific entry by name.
   */
  get(name: string): ScheduleEntry | undefined {
    return this.entries.get(name)
  }

  // ── Private scheduling methods ───────────────────────────────────────────────

  private scheduleDailyOrWeekly(name: string, entry: ScheduleEntry): void {
    const computeNext = () => {
      if (entry.type === 'daily') {
        return nextEtTimeUtc(entry.hour!, entry.minute!)
      } else {
        return nextEtWeekdayUtc(entry.dayOfWeek!, entry.hour!, entry.minute!)
      }
    }

    const schedule = () => {
      const next = computeNext()
      entry.nextRun = next.toISOString()
      const msUntil = next.getTime() - Date.now()

      console.log(
        `[scheduler-registry] '${name}' next run in ${Math.round(msUntil / 60_000)}m (${next.toISOString()})`,
      )

      const timer = setTimeout(async () => {
        this.timers.delete(name) // Clear timer before execution
        await this.executeTask(name, entry)
        schedule() // Reschedule for next occurrence
      }, msUntil)

      this.timers.set(name, timer)
    }

    schedule()
  }

  private scheduleInterval(name: string, entry: ScheduleEntry): void {
    if (!entry.intervalMs) {
      console.warn(`[scheduler-registry] '${name}' interval entry has no intervalMs — skipping`)
      return
    }

    const schedule = () => {
      const timer = setTimeout(async () => {
        this.timers.delete(name)
        await this.executeTask(name, entry)
        schedule() // Reschedule
      }, entry.intervalMs)

      this.timers.set(name, timer)
    }

    schedule()
  }

  private async executeTask(name: string, entry: ScheduleEntry): Promise<void> {
    // Check enabled at fire time
    const enabled = typeof entry.enabled === 'function' ? entry.enabled() : entry.enabled
    if (!enabled) {
      console.log(`[scheduler-registry] '${name}' disabled — skipping`)
      return
    }

    entry.state = 'running'
    const startTime = Date.now()

    try {
      await entry.run()
      entry.lastRun = new Date().toISOString()
      entry.state = 'idle'
      entry.lastError = undefined
      console.log(
        `[scheduler-registry] '${name}' completed in ${Date.now() - startTime}ms`,
      )
    } catch (e: any) {
      entry.lastRun = new Date().toISOString()
      entry.state = 'error'
      entry.lastError = e?.message ?? String(e)
      console.error(`[scheduler-registry] '${name}' failed:`, e?.message ?? e)
    }
  }
}

// Singleton instance
export const schedulerRegistry = new SchedulerRegistry()
