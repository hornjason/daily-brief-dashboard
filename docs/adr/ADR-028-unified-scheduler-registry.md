---
doc-type: adr
status: accepted
owner: jason
updated: 2026-05-20
---

# ADR-028: Unified Scheduler Registry

**Date:** 2026-05-20

## Status

Accepted

## Context

Scheduling in `background-scheduler.ts` has grown organically to 1294 lines. There are currently 8 schedule functions that each follow an identical pattern:

1. Compute milliseconds until the next ET target time
2. `setTimeout` for that duration
3. Check an enabled flag
4. Run the task
5. Reschedule by calling themselves recursively

These functions are: `schedulePipelineSync`, `scheduleCcspSync`, `scheduleTerritorySync`, `scheduleKpiSnapshot`, `scheduleProductIntelRefresh`, `scheduleNewsRadarRefresh`, `scheduleRSSRefresh`, `scheduleEventsRefresh`. A ninth (`scheduleEmailDelivery`) follows a variant pattern with config re-read. `scheduleProductLifecycleRefresh` is a tenth.

Additionally, the file contains 6 near-identical `nextEtXxxUtc()` functions (2am, 1:45am, 5:30am, 6:30am, 7am, 8am, Sunday 6am) that each duplicate the same 15-line Intl.DateTimeFormat timezone calculation with only the hour/minute constants changed — a textbook case of the pattern `et-time.ts` was extracted to solve, but which was never backfilled into the existing functions.

The 15-minute heartbeat timer manages a separate set of interval-based refreshes (subscriptions, CCSP cache, RH scraper cadence) using elapsed-time checks against `_lastRun` timestamps.

**Problems this creates:**

1. **No single view of "what runs when."** An operator must read ~700 lines of scheduling code to understand the system's timing behavior. `TIMERS.md` exists as documentation but can drift from the code.
2. **Every new scheduled task requires 20-30 lines of boilerplate** that duplicates the setTimeout+reschedule+enabled-check pattern.
3. **The Feature Module Registry (ADR-020) already declares `refreshInterval` on each module**, but the actual scheduling is done by standalone functions in `background-scheduler.ts` that import from the registry. The registry knows the interval but does not own the scheduling — a split responsibility.
4. **Six `nextEtXxxUtc()` functions** duplicate timezone math that `et-time.ts` already encapsulates. Adding a new daily schedule time means copying another 15-line function.

**Constraints that must be preserved (non-negotiable):**

- ADR-007: `setTimeout` + reschedule for intervals >1h. No `setInterval` for long periods.
- The 15-minute heartbeat tick for short-interval checks (subscriptions, CCSP cache, RH scraper cadence) stays — it is the ADR-007 workaround for those timers.
- The scraper queue (`scraper-queue.ts`) stays separate — it serializes browser-context work, which is a different concern from scheduling.
- `et-time.ts` stays as the timezone utility.
- Scraper code is stable and must not be touched (CLAUDE.md standing rule).

## Decision

Introduce a **scheduler registry** (`src/scheduler-registry.ts`) that owns task scheduling. Modules declare their schedule at registration time; the registry manages the setTimeout lifecycle.

### Schedule Declaration

```typescript
interface ScheduleEntry {
  /** Unique task name — used for logging, status, admin visibility */
  name: string

  /** When to run. One of:
   *  - { type: 'daily', hour: number, minute: number }      — daily at ET time
   *  - { type: 'weekly', day: 0-6, hour: number, minute: number } — weekly at ET time
   *  - { type: 'interval', ms: number }                      — fixed interval (for <=1h only)
   *  - { type: 'heartbeat', intervalMs: number }              — checked on 15-min tick
   */
  schedule:
    | { type: 'daily'; hour: number; minute: number }
    | { type: 'weekly'; day: number; hour: number; minute: number }
    | { type: 'interval'; ms: number }
    | { type: 'heartbeat'; intervalMs: number }

  /** The work to perform */
  run: () => Promise<void>

  /** Whether this task is currently enabled. Re-checked at fire time. */
  enabled: () => boolean

  /** Optional: gate on NODE_ROLE=primary */
  primaryOnly?: boolean
}
```

### How It Works

1. **Registration:** Each module calls `SchedulerRegistry.register(entry)` at module-load time (same pattern as FeatureModuleRegistry and ScraperRegistry).

2. **Startup:** `SchedulerRegistry.start()` is called once from `initBackgroundScheduler()`. For each registered entry:
   - `daily` and `weekly` entries: compute next fire time using `et-time.ts` (the single parameterized `nextEtTimeUtc(hour, minute)` function), set a `setTimeout`, and self-reschedule after execution.
   - `interval` entries: use `setInterval` (safe for <=1h per ADR-007).
   - `heartbeat` entries: added to the existing 15-minute tick's check loop.

3. **Enabled check at fire time:** When a timer fires, the registry calls `entry.enabled()` before `entry.run()`. If disabled, it reschedules without running. This preserves the current pattern where config is re-read on each cycle.

4. **Primary-only gating:** Entries with `primaryOnly: true` are skipped on hero installs (checked once at `start()` time via `isPrimary()`).

5. **Status tracking:** The registry tracks `lastRun`, `lastSuccess`, `lastError`, and `nextRun` per entry. Exposed via a single `GET /api/admin/scheduler-status` endpoint.

6. **Admin visibility:** A single endpoint returns the complete schedule table — what runs, when it last ran, when it will run next, whether it is enabled. This replaces reading 700 lines of code or trusting TIMERS.md.

### What the Scheduler Registry Owns

- setTimeout lifecycle for daily/weekly tasks (currently in 8 standalone `scheduleXxx()` functions)
- Next-fire-time computation for ET-based schedules (currently in 6 `nextEtXxxUtc()` functions)
- Status tracking for all scheduled tasks
- The admin status endpoint

### What the Scheduler Registry Does NOT Own

- The 15-minute heartbeat `setInterval` itself — it stays in `background-scheduler.ts`. Heartbeat entries are callbacks registered into the existing tick, not new timers.
- Scraper queue serialization — stays in `scraper-queue.ts`.
- Retry logic (`scheduleRetry`) — stays alongside the scraper queue (it enqueues into the scraper queue, not the scheduler).
- Business logic inside `run()` callbacks — modules own their work.
- Startup catch-up logic — stays in `initBackgroundScheduler()` (it depends on sync-state, not schedule state).

### Consolidation of `nextEtXxxUtc()` Functions

The six near-identical timezone functions are replaced by a single parameterized function in `et-time.ts`:

```typescript
/** Compute the next occurrence of a given ET time. */
export function nextEtTimeUtc(hour: number, minute: number, now?: Date): Date
/** Compute the next occurrence of a given ET weekday + time. */
export function nextEtWeekdayTimeUtc(day: number, hour: number, minute: number, now?: Date): Date
```

All existing callers (`nextEt2amUtc`, `nextEt145amUtc`, `nextEt530amUtc`, `nextEt630amUtc`, `nextEt7amUtc`, `nextEt8amUtc`, `nextEtSunday6amUtc`) become thin wrappers or are removed entirely when the scheduler registry calls `et-time.ts` directly.

### Integration with Feature Module Registry

Feature modules that declare `refreshInterval` on their ADR-020 contract are **not** automatically registered with the scheduler. The module's standalone `scheduleXxxRefresh()` function is replaced by a `SchedulerRegistry.register()` call co-located with the `FeatureModuleRegistry.register()` call. This keeps the two registries independent — FeatureModuleRegistry owns lifecycle (cleanup, signals, sync-now), SchedulerRegistry owns timing.

A future unification where FeatureModuleRegistry delegates to SchedulerRegistry is possible but not required by this ADR. The two registries solve different problems and forcing them together would create a framework that fights the app (ADR-020 Consequence: "must not become a framework").

### Migration Strategy

1. **Phase 1 — Infrastructure:** Create `scheduler-registry.ts` with the `ScheduleEntry` interface, `register()`, `start()`, and status tracking. Add parameterized `nextEtTimeUtc()` and `nextEtWeekdayTimeUtc()` to `et-time.ts`. No behavioral change.

2. **Phase 2 — Migrate feature module schedules:** Convert `scheduleProductIntelRefresh`, `scheduleNewsRadarRefresh`, `scheduleProductLifecycleRefresh`, `scheduleRSSRefresh`, `scheduleEventsRefresh` to `SchedulerRegistry.register()` calls. These are the simplest — they already delegate to `FeatureModuleRegistry.get(name).fetch()`. Remove the standalone functions. ~200 lines deleted.

3. **Phase 3 — Migrate core schedules:** Convert `schedulePipelineSync`, `scheduleTerritorySync`, `scheduleKpiSnapshot`, `scheduleEmailDelivery` to registry entries. These have more complex pre-flight logic (session checks, probe calls) that stays in the `run()` callback. ~300 lines moved from inline functions to registered callbacks.

4. **Phase 4 — Migrate heartbeat entries:** Convert subscriptions refresh and CCSP cache refresh to `heartbeat`-type entries, removing the `_lastRun` timestamp tracking from `background-scheduler.ts` (the registry tracks this). ~50 lines removed.

5. **Phase 5 — Cleanup:** Remove the 6 `nextEtXxxUtc()` functions. Remove `_heartbeatStarted` and related state. `background-scheduler.ts` becomes a thin orchestrator: `initBackgroundScheduler()` calls `SchedulerRegistry.start()`, runs startup-only tasks (validation, catch-up, auth pre-flight, Drive watcher init, brief pre-generation), and owns the scraper queue drain on heartbeat.

**Each phase is independently shippable and testable.** Phase 1 has zero behavioral change. Phases 2-4 can be done in any order.

## Consequences

**Positive:**

- **Single source of truth for "what runs when"** — `SchedulerRegistry.getAll()` returns the complete schedule table. Operators no longer read 700 lines of scheduling code. TIMERS.md can be generated from the registry.
- **New scheduled tasks require ~5 lines** (a `register()` call with name, schedule, run, enabled) instead of 20-30 lines of boilerplate.
- **Six duplicated timezone functions become two parameterized functions** — ~90 lines of duplication removed.
- **Admin status endpoint** provides runtime visibility into next-run times, last-run outcomes, and enabled state.
- **Consistent enabled-check-at-fire-time pattern** — currently some functions check enabled at the top, some don't. The registry enforces the check.
- **background-scheduler.ts shrinks from ~1300 lines to ~400 lines** (startup orchestration + scraper queue + session watchdog).

**Negative:**

- **New abstraction layer** — developers must understand the registry to add or modify schedules. Mitigated by: the registry API is 3 functions (`register`, `start`, `getAll`), and the pattern is already proven by FeatureModuleRegistry and ScraperRegistry in this codebase.
- **Two registries coexist** (FeatureModuleRegistry for lifecycle, SchedulerRegistry for timing). This is intentional — merging them creates a monolithic framework. But it means a new feature module with a schedule makes two `register()` calls.
- **Migration effort** — 5 phases of work to fully consolidate. Mitigated by: each phase is independently shippable, and Phase 1 has zero risk.

**Risks:**

- **Over-engineering the schedule declaration types.** Mitigation: start with the 4 types shown (daily, weekly, interval, heartbeat) because those are exactly the 4 patterns that exist today. Do not add cron expressions, retry policies, or dependency chains to the schedule declaration — those are separate concerns handled by existing code (scraper queue retry, startup catch-up).

## Alternatives Considered

### Option 2: Declarative Schedule Table in data-sources.json

A config file mapping task names to ET times and enabled flags, read by a single scheduler loop.

**Rejected because:**
- The run callbacks contain real logic (Gemini calls, Drive writes, session probes) that cannot be expressed declaratively.
- Config-file-driven scheduling creates a split between "what to run" (config) and "how to run" (code) that is harder to trace than co-located `register()` calls.
- ADR-020 already rejected config-driven registry for the same reason: "module behaviors require actual logic, not declarative config."

### Option 3: Keep As-Is, Extract to schedule-registry.ts

Move the 8 `scheduleXxx()` functions and 6 `nextEtXxxUtc()` functions to a new file without changing the pattern. Pure code motion.

**Rejected because:**
- It solves the "file is too long" problem but not the "no single view of what runs when" problem.
- Every new scheduled task still requires duplicating the boilerplate.
- The `nextEtXxxUtc()` duplication remains.
- It defers the architectural improvement to a future decision when the file is even longer.

### Option 4: Feature Module Registry Owns Scheduling

Extend FeatureModuleRegistry to interpret `refreshInterval` and manage timers directly.

**Rejected because:**
- Not all scheduled tasks are feature modules. Pipeline sync, territory sync, KPI snapshot, and email delivery are core infrastructure — they don't have cache paths, cleanup handlers, or signals. Forcing them into the FeatureModule contract would require dummy implementations.
- ADR-020 explicitly scoped the registry to lifecycle (cleanup, signals, sync-now), not timing. Expanding it conflates two concerns.
- "Must not become a framework that fights the app" — ADR-020 consequence.
