---
Last validated: 2026-04-30
---

# ADR-006: Sync Daemon Context Ownership and External Trigger IPC

**Status:** Proposed
**Date:** 2026-04-30
**Deciders:** Serena Blackwood (architecture), Rayford (DA)
**Related:** ARCHITECTURE.md §1 (Shared Browser Context), ADR-001 (Long-lived sessions), ADR-007 (Self-rescheduling setTimeout — closed, not re-opened)

---

## 1. Context

The L3 sync daemon (`scripts/sync-l3-daemon.ts`) is a long-lived process that maintains two browser contexts against a single persistent Chromium profile dir (`/data/rh-profile`):

- **RH context** (`initScrapeContext`) — used by `src/ccsp-scraper.ts` for Tableau CCSP scraping; depends on Red Hat SSO cookies surviving across runs.
- **SF context** (`initSfContext`) — used by `src/sf-scraper.ts` for Salesforce bookings; runs in ephemeral sub-contexts per scrape.

`syncAllPods()` in `scripts/sync-pod-l3.ts` is the orchestrator that calls `scrapePodCcspRaw` (RH) and `runSfPodSync` (SF) for each pod. Both downstream scrapers rely on **module-level state** (`_context`, `_profileDir`) initialized by `initScrapeContext` / `initSfContext`. `syncAllPods()` itself does **not** call those initializers — it assumes the caller has done so.

### The Fundamental Constraint

Chromium enforces a `SingletonLock` file inside any profile directory it opens. **At most one process may hold a given profile dir at a time.** This is not a configuration choice; it is a safety invariant of the browser. The persistent profile is what carries the SAML/OAuth cookies that make Tableau SSO passthrough possible (ARCHITECTURE.md §1) — it cannot be cloned, copied, or sharded per-process.

Therefore: **the daemon is the single legitimate owner of the RH profile dir for the lifetime of the process.** Any external trigger that wants a fresh sync must route through the daemon, not bypass it.

### Pressure That Surfaced This Decision

A `SYNC_NOW=true bun run sync-pod-l3.ts` standalone path was added for manual testing. Run via `podman exec` inside the same container, it failed with `SingletonLock: File exists` for CCSP because the daemon already held the profile lock. (SF worked because it uses ephemeral sub-contexts that don't touch the persistent profile.) A file-based trigger (`/data/cache/sync-trigger`, polled every 30s by a second timer in the daemon) was added as the immediate fix and is currently working for SF; CCSP is expected to work because the daemon's RH context is already initialized when the trigger fires.

Two architectural questions remain open:

- **Q1 (Context ownership):** Should `syncAllPods()` initialize its own contexts, or remain a thin orchestrator that requires the daemon to have initialized them?
- **Q2 (IPC mechanism):** Is the file-based trigger the right long-term IPC, or should we evolve to an HTTP endpoint or a POSIX signal?

---

## 2. Decision

### Q1 — Context ownership: **Option A. `syncAllPods()` remains a thin orchestrator. The daemon owns context lifecycle. The contract is documented explicitly.**

Rationale:

1. **Single-owner invariant matches the physical constraint.** The Chromium `SingletonLock` already enforces "one process owns the profile dir." Mirroring that invariant in the code — one process (the daemon) owns context init, every other caller routes through it — keeps the software model isomorphic to the underlying constraint. Patterns that match physics are timeless; patterns that fight physics generate recurring bugs.

2. **Self-init in `syncAllPods()` is a leaky abstraction.** Even if guarded by an `if (!_context)` check, a self-initializing `syncAllPods()` would suggest to future readers (and future agents) that it is safe to call from any process. It is not. The next caller who runs it via `podman exec` re-encounters the `SingletonLock` failure we just removed. The code would silently invite the bug back.

3. **The implicit caller contract becomes explicit, not eliminated.** The fix is not to make `syncAllPods()` self-contained — it is to make the contract loud. Add a precondition assertion at the top of `syncAllPods()`: throw a clear error if `_context` is unset, with a message that names the daemon as the required entry point.

4. **Eliminates the SYNC_NOW standalone path entirely.** The `SYNC_NOW=true bun run sync-pod-l3.ts` invocation is removed. Manual immediate sync is achieved exclusively by triggering the daemon (Q2). One entry point, one owner.

5. **No regression risk for the daemon's own scheduled runs.** The daemon already initializes contexts at startup before its scheduler ever calls `syncAllPods()`. The contract is already satisfied for the only legitimate caller.

### Q2 — IPC mechanism: **Option A (file-based trigger) for now, with an explicit migration path to Option B (HTTP endpoint) when an admin UI lands.**

Rationale:

1. **The file-based trigger already works and is appropriate to current scale.** Single-user, single-container, localhost-only. There is exactly one daemon and at most one human triggering a sync. The coordination problem is trivial; the simplest mechanism that solves it correctly is the right one.

2. **File-based wins on persistence-across-crashes.** If the daemon is mid-restart when `touch /data/cache/sync-trigger` runs, the trigger file remains and is consumed on the next poll cycle. HTTP and signals both lose the request silently if the daemon is not up at the instant the trigger arrives. For a single-user dashboard this matters because the user should not have to know whether the daemon is currently restarting.

3. **No new attack surface, no new port, no new dependency.** ARCHITECTURE.md §2 establishes "no auth middleware" as a standing rule premised on no externally-reachable endpoints. Adding an HTTP trigger endpoint — even on `127.0.0.1:3001` — expands that surface and creates a future attack vector if container networking ever changes. File-based has zero such surface.

4. **SIGUSR1 is rejected.** Signals are not persistent across daemon restarts, are awkward to send from a sibling container or a UI, and provide no acknowledgement. They are the right tool for "reload config" in classic Unix daemons, not for "run a multi-minute scrape job."

5. **HTTP is the right next step, not the right step now.** When an admin UI or a status endpoint is built (BACKLOG: future), the daemon will already need an internal HTTP surface. At that point migrate the trigger to `POST /sync/trigger` on a localhost-only port, deprecate the file trigger over one release cycle, and document the migration. Until then, the file trigger is sufficient and reversible — it can be removed in a single commit when superseded.

6. **The 30s polling interval is acceptable.** Trigger latency is bounded by the polling interval. For a manual sync that itself takes 5–15 minutes, a worst-case 30s wait is invisible. If latency ever matters, the polling interval is a one-line change.

### Hardening Requirements (binding on the implementer)

The decision is contingent on these guardrails:

- **H1 — Precondition assertion in `syncAllPods()`:** First lines of the function must assert that both contexts are initialized. Throw a clear error naming the daemon as the required entry point if not.
- **H2 — Remove `SYNC_NOW` standalone path:** The `SYNC_NOW=true bun run sync-pod-l3.ts` code path is deleted. There is no standalone invocation of `syncAllPods()`.
- **H3 — Trigger file consumption is atomic:** The daemon's trigger poller must `fs.rename` the trigger file to a transient name (or delete it) **before** starting the sync, not after. This prevents a duplicate trigger if the sync takes longer than the polling interval.
- **H4 — Concurrent-trigger guard:** If a sync is already in progress when the trigger fires, the daemon logs and discards the trigger (does not queue). This matches the existing module-level mutex pattern (ARCHITECTURE.md §3).
- **H5 — Document the contract:** ARCHITECTURE.md must be updated with a new section ("Sync Daemon as Single Profile Owner") that names the contract, the trigger mechanism, and the rationale.

---

## 3. Consequences

### Positive

- The code model matches the physical constraint (`SingletonLock`) — this is the timeless property.
- One entry point for sync execution. No second class of caller to reason about.
- File-based IPC has zero new surface area, survives daemon restarts, and is trivially replaceable later.
- Future readers (human and agent) cannot accidentally re-introduce the standalone path because it does not exist.

### Negative / Trade-offs

- **30s worst-case trigger latency.** Acceptable given sync duration; documented.
- **Trigger has no acknowledgement channel.** Caller sees "file consumed" by checking the file is gone, not "sync succeeded." For a single-user system this is acceptable; an HTTP endpoint with 202 Accepted + status URL is the proper long-term answer (deferred to UI work).
- **Trigger files must be cleaned up on daemon startup** to avoid replaying a stale trigger from a prior crash. One-time read+delete on daemon boot.
- **The standalone `SYNC_NOW` test ergonomic is lost.** Mitigation: a one-line wrapper (`make sync-now` → `podman exec ... touch /data/cache/sync-trigger`) gives the same UX without the architectural cost.

### Reversibility

High. Migrating from file-trigger to HTTP-trigger is a localized change in the daemon and the `make sync-now` target. No on-disk data format depends on the trigger mechanism.

---

## 4. Alternatives Considered

### Q1 alternatives

- **Q1-B: `syncAllPods()` self-initializes contexts (no-op if already set).** Rejected. Hides the single-owner invariant; invites the next caller to run it standalone, which immediately re-encounters `SingletonLock`. Trades a clear precondition error for a confusing browser-level crash.
- **Q1-C: Pass contexts as explicit arguments to `syncAllPods(rhCtx, sfProfile)`.** Rejected for now. Cleaner in the abstract but requires a larger refactor of the scraper modules' module-level state, and ARCHITECTURE.md §3 deliberately preserves that pattern. Q1-A captures the same correctness benefit (explicit precondition) at a fraction of the change surface. Revisit if scrapers ever move off module-level state for unrelated reasons.

### Q2 alternatives

- **Q2-B: HTTP trigger endpoint inside the container (`POST /sync/trigger` on internal port).** Deferred, not rejected. Right answer when an admin UI exists. Premature now: adds a port, expands the no-auth surface (ARCHITECTURE.md §2), and provides no benefit over the file trigger at current scale.
- **Q2-C: SIGUSR1 signal handler.** Rejected. Not persistent across daemon restarts; awkward from sibling containers or UIs; no acknowledgement; mismatched semantics for a long-running job.
- **Q2-D: External job queue (Redis, SQLite-backed).** Rejected. Massive over-engineering for a single-user, single-process system. ARCHITECTURE.md §3 explicitly names "database or Redis queue for a single-user, single-process app is overengineering."
- **Q2-E: Restart the daemon to force a fresh sync.** Rejected and already documented as ruled out — destroys SSO session continuity, defeats the purpose of the daemon.

---

## 5. Open Questions for Jason

1. **`make sync-now` ergonomics.** Confirm that a Makefile target wrapping `podman exec ... touch /data/cache/sync-trigger` is the desired manual-sync UX, replacing the deleted `SYNC_NOW=true` path. If you want a synchronous "wait for completion" UX, that requires the HTTP endpoint (Q2-B) and should be promoted now rather than deferred.
2. **Trigger acknowledgement.** Is "fire-and-forget with logs" acceptable for manual triggers, or do you want a status file (`/data/cache/sync-status.json`) the trigger writes so the caller can poll for completion? Cheap to add; not strictly required.
3. **Daemon-boot trigger cleanup.** Confirm the daemon should delete any pre-existing `/data/cache/sync-trigger` on startup (preventing replay of a stale trigger from a prior crash). Recommended yes.
