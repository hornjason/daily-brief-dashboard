---
doc-type: architecture
status: active
owner: jason
updated: 2026-05-21
---

# DailyBriefDashboard — Architecture Reference
*Last validated: 2026-05-06 | Owner: DA | Trigger: Review and update on any structural change to this doc*

**Read this before making recommendations.** This document exists specifically to prevent well-intentioned but incorrect suggestions from breaking intentional design decisions. Every section below describes a pattern that looks like an anti-pattern but isn't.

---

## What This App Is

A single-tenant, containerized intelligence dashboard for an Account Executive at Red Hat. It aggregates data from Red Hat Portal, Salesforce, Tableau (CCSP), Supportable 360, and Google services into a daily brief UI.

**Single user. Single container. No external traffic.** All HTTP endpoints are local (`localhost:7777`). There is no public internet exposure, no multi-tenancy, and no end-user authentication required.

---

## Intentional Design Decisions

### 1. Shared Browser Context (Do Not Isolate)

**Pattern:** A single `BrowserContext` (`_ctx`) is created during Red Hat SSO login and shared across all scrapers.

```
RH Portal SSO login → BrowserContext created
  └── adoptRhContext(_ctx)         → rh-scraper.ts
  └── adoptSupportableContext(_ctx) → supportable-scraper.ts
  └── adoptCcspContext(_ctx)        → ccsp-scraper.ts
  └── adoptSfContext(_ctx)          → sf-scraper.ts
```

**Why it's intentional:** Red Hat SSO uses SAML/OAuth with session cookies tied to a single browser session. Tableau SSO passthrough works *only* because the shared context carries those cookies. Creating an isolated `BrowserContext` per AE or per scraper means zero cookies — Tableau immediately redirects to the login wall. Copying cookies between contexts defeats isolation. There is no other path.

**What looks wrong:** Rook (security review 2026-03-29) flagged this as "High — shared SSO session, single point of compromise." The finding is technically correct in a generic web app. It does not apply here because (a) only internal server code opens pages in this context, (b) all scrapers are the same trust level, and (c) the alternative breaks the app.

**WONTFIX — architectural constraint.**

---

### 2. No Authentication Middleware

**Pattern:** All API endpoints are unauthenticated. No JWT, no session, no API key checks.

**Why it's intentional:** The server binds to `localhost:7777` only, inside a container with no public port exposure. The only clients are: the React dashboard (same origin, same machine) and the user themselves. Adding auth middleware adds friction and complexity with zero security benefit in this threat model.

**What looks wrong:** Any security scan will flag "unauthenticated endpoints." This is expected and acceptable.

**Standing rule:** Never add auth middleware. If OAuth keys get reset during a wipe, always preserve them. (Memory: `feedback_no_auth.md`)

---

### 3. In-Memory Module State (Scrapers)

**Pattern:** Scrapers use module-level booleans and timestamps as mutexes (`ccspScrapeRunning`, `supportableScrapeRunning`, etc.) rather than a database or queue.

**Why it's intentional:** Single-process Bun server. There is exactly one instance. A database or Redis queue for a single-user, single-process app is overengineering. The in-memory approach is correct and sufficient. The stale mutex (15-min auto-release) handles the only real failure case (process crash without cleanup).

**All four scrapers have stale mutex protection** (RH scraper brought into alignment 2026-03-30): `ccspScrapeRunning`, `supportableScrapeRunning`, and `_rhScrapeRunning` all auto-release after 15 minutes. Salesforce uses a fire-and-forget pattern (`isRunning: false` permanently) — it has no long-running page session to get stuck.

**Bootstrap included in `isAnyScraperRunning()` guard (BKL-W2-17, 2026-04-04):** `bootstrap-orchestrator.ts` exports `isBootstrapRunning()`, which returns `autoBootstrapState.running`. `background-scheduler.ts` includes this in `isAnyScraperRunning()`. Prevents scheduled scraper ticks from firing while a full bootstrap is in progress — bootstrap can take 10-20 minutes and concurrent scrapes would corrupt in-flight sheet writes.

**What looks wrong:** "Boolean mutex is not atomic." In a multi-threaded environment this would be a race condition. Node.js/Bun is single-threaded — the event loop serializes check-and-set, making this safe.

**Keep-alive expiry guard (added 2026-03-30):** The RH Portal 8-minute keep-alive timer calls `setSessionExpiredCallback` when session cookies expire. The callback previously called `closeScrapeContext()` unconditionally, killing the shared browser context and aborting all in-flight scrapers simultaneously. The guard now checks all three mutex flags before closing — if any scraper is running, the context close is deferred. Scrapers complete or fail naturally on their next page operation; mutexes release normally. `closeScrapeContext()` is only called when the system is idle.

---

### 3a. Sync Daemon as Single Profile Owner (ADR-006, 2026-04-30)

**The physical constraint:** Chromium enforces a `SingletonLock` file inside any persistent profile directory it opens. At most one OS process may hold a given profile dir at a time. The persistent profile at `/data/rh-profile` carries the SAML/OAuth cookies required for Tableau SSO passthrough — it cannot be cloned, shared, or opened by a second process.

**The invariant:** The L3 sync daemon (`scripts/sync-l3-daemon.ts`) is the sole process that may open `/data/rh-profile`. No other script, no `podman exec bun run ...` invocation, and no standalone caller may open this directory while the daemon is running.

**`syncAllPods()` requires initialized contexts:** `scripts/sync-pod-l3.ts` is a thin orchestrator. It does not initialize browser contexts — it asserts at the top of `syncAllPods()` that both `getScrapeContext()` (RH) and `getSfContext()` (SF) are non-null. Calling it without initialized contexts throws a clear error naming the daemon as the required entry point. This makes the contract explicit rather than implicit, preventing future agents or developers from accidentally reintroducing a standalone invocation.

**Trigger mechanism for manual immediate sync:**
- Touch `/data/cache/sync-trigger` inside the container, OR
- Run `make sync-now` (wraps the above `podman exec` call)
- The daemon polls every 30s; worst-case latency is 30s before the sync starts
- The trigger file is deleted atomically (before the sync starts) to prevent duplicate firing

**Why file-based trigger (not HTTP or signal):**
- Survives daemon restarts — file persists if daemon is mid-restart when `make sync-now` runs
- No new port, no new attack surface (ARCHITECTURE.md §2: no auth middleware standing rule)
- SIGUSR1 rejected: not persistent across restarts, awkward from sibling containers, no acknowledgement
- HTTP is the right next step when an admin UI exists (deferred to that milestone)

**What was removed:** The `SYNC_NOW=true bun run sync-pod-l3.ts` standalone invocation path was deleted. It failed with `SingletonLock: File exists` when the daemon was running (SF worked; CCSP did not — SF uses ephemeral sub-contexts). `make sync-now` is the only supported manual trigger.

**Runtime behavior — three timers:**

*Startup sequence:*
1. `initScrapeContext(PROFILE_DIR)` — opens persistent Chromium context on `/data/rh-profile`, restores SSO cookies
2. `adoptCcspContext(ctx)` — wires the CCSP scraper's module-level `_ctx` to the shared RH context (required; distinct from `getScrapeContext()`)
3. `initSfContext(PROFILE_DIR)` — opens SF Playwright context (non-fatal if it fails; SF shares the RH profile)
4. Boot cleanup — deletes any stale `/data/cache/sync-trigger` from a prior daemon crash

*Timer 1 — SSO keepalive (every 2h):* Opens a new page, navigates Tableau viz embed (`/t/site/views/OverallCloudConsumptionDashboard/CloudConsumption`), waits for SSO redirect chain to complete, validates viz rendered (Raw Data tab visible), then navigates SF Lightning home (`/lightning/page/home`). Auto-fills email from `TABLEAU_USER_EMAIL` if session expired. After Tableau+SF checks, probes the RH browser context health via `isContextHealthy()` (5s timeout on `ctx.pages()`). If the context is dead/unresponsive (e.g. Chromium process died after extended uptime), auto-recovers from saved cookies on disk via `recoverScrapeContext()` and re-adopts CCSP context — no container restart or re-login needed. Sends alert email if recovery fails. (#223). Also monitors container RSS memory — if RSS exceeds 3GB (75% of 4GB limit), triggers `proactiveRecycle()` to kill all Chrome processes and relaunch a fresh context before memory pressure causes rendering failures.

*Timer 2 — trigger poller (every 30s):* Checks for `/data/cache/sync-trigger`. If present: deletes it atomically, runs `syncAllPods()` using live contexts. Discards trigger if a sync is already running.

*Timer 3 — daily sync (5:30am ET = 09:30 UTC):* Calls `scheduleNextSync()` → `setTimeout` → `runSyncCycle()` → `syncAllPods()`. Self-reschedules for next day after each run. Before calling `syncAllPods()`, runs a rendering health check via `canContextRender()` — if the browser can't render a page (zombie Chromium), triggers `proactiveRecycle()` first.

*Timer 5 — proactive browser recycle (every 12h):* Persists session cookies → closes browser contexts (`closeScrapeContext()` + `closeSfContext()`) → kills all orphan Chrome processes via `pkill` → re-initializes contexts from persisted profile → re-adopts CCSP and SF scrapers. Prevents Chrome memory leaks from accumulating to the point where iframes stop rendering (~48h degradation observed pre-fix).

**Per-pod sync steps (inside `syncAllPods()`):**
1. Skip pods with no `sfReportId` or no Bookings GSheet in Drive
2. **CCSP** — fetches rolling 4 completed calendar quarters from Tableau (e.g. 2025-Q2 → 2026-Q1 via `getRollingFyWindow()`). Downloads as CSV, deletes stale Drive cache file, writes fresh `CCSP-{POD_NAME}-{DATE}.csv`
3. **SF Pipeline** — downloads the pre-built nightly scheduled Salesforce report (you configure this in SF). Writes `SF-PIPELINE-{reportId}-{POD_NAME}-{DATE}.csv`. Skips if today's file already exists.
4. After all pods: writes `sync-status.json` to Drive (first region's `podBookingsFolderId`), sends summary email

**Email notifications (all sent to jhorn@redhat.com):**

| Trigger | Subject |
|---|---|
| Sync succeeded | `L3 Sync Complete — {date} \| {N} pods synced, {N} skipped` |
| Sync had errors | `L3 Sync FAILED — {date} \| {N} synced, {N} skipped, {N} errors` |
| Keepalive detected expired session | `L3 Sync Daemon — Keepalive Failed {date}` |
| `syncAllPods()` threw unexpectedly | `L3 Sync Daemon — Fatal Error {date}` |

The sync summary email includes an HTML table: one row per pod with pod key, CCSP row count, SF row count, and OK/SKIPPED/ERROR status.

**Container identity:** The sync daemon runs as a **separate podman container named `pai-sync-l3`** — it is NOT a process inside `pai-dashboard`. Uses the L4 daemon image (`daily-brief-l4-daemon:latest`, built via `make build-l4`), launched with `SYNC_DAEMON=true` and `NODE_ROLE=primary`. It mounts `data-sync/` (not `data/`) and exposes no ports. The container runs with `--init` flag (tini/catatonit) for proper zombie Chrome process reaping — without this, orphaned Chromium renderer processes accumulate and are never cleaned up.

```
pai-dashboard   ← app server, port 7777
pai-sync-l3     ← sync daemon, no port, SYNC_DAEMON=true
```

**How to check status (Mac Mini — run from project root):**
```bash
# SSH to Mac Mini first
ssh jasonhorn@100.97.86.25    # via Tailscale (preferred)
ssh ssh.jasonhorn.io          # via Cloudflare tunnel (fallback)

# Check if container exists and is running
podman ps -a --filter name=pai-sync-l3
# Nothing → never started; run: make sync-up
# Exited  → crashed; run: make sync-up to recreate
# Up      → healthy; check logs below

# Then from the project root
make sync-up      # start (or restart) the daemon container
make sync-logs    # stream live daemon logs (tail -f style)
make sync-status  # recent log tail (last ~50 lines, filtered)
make sync-now     # trigger an immediate sync (30s max latency)
```

**Prerequisite for `make sync-up`:** `data-sync/config/settings.json` must exist (bootstrapped separately from the main `data/` volume). The Makefile exits with an error if this file is missing.

**Log patterns to watch for in `make sync-logs`:**

| Log line | Meaning | Action |
|---|---|---|
| `L3 Sync Complete — {date} \| {N} pods synced` | Healthy run | None |
| `L3 Sync FAILED — {date} \| {N} errors` | Partial/full failure | Check per-pod output; check CCSP/SF session state |
| `L3 Sync Daemon — Keepalive Failed {date}` | RH or SF session expired | Re-auth via VNC (`http://mac.tail2fe7c7.ts.net:6080/vnc.html`) |
| `L3 Sync Daemon — Fatal Error {date}` | Crash in `syncAllPods()` | Check daemon container logs; restart if needed |

**Drive status check:** Open any pod's bookings folder → `sync-status.json` — contains `completedAt` timestamp and per-pod results array.

**Never do:**
- Do NOT run `SYNC_NOW=true bun run sync-pod-l3.ts` directly — that path is deleted
- Do NOT run `podman exec bun run sync-pod-l3.ts` while daemon is running — SingletonLock on `/data/rh-profile` will throw
- `make sync-now` is the ONLY supported manual trigger

---

**Container image & runtime stack:**

`pai-sync-l3` uses a dedicated L4 daemon image (`daily-brief-l4-daemon:latest`, built via `Dockerfile.l4`). This image contains Playwright + Chromium + browser scrapers but NOT the dashboard UI or API server. The `SYNC_DAEMON=true` env var tells entrypoint.sh to run `sync-l3-daemon.ts` instead of `server.ts`.

`entrypoint.sh` always boots the complete VNC display stack first, regardless of mode:
```
Xvfb :99        ← virtual display (Playwright needs this — headless:false renders here)
openbox         ← window manager (gives VNC a visible desktop)
x11vnc          ← VNC server with auto-respawn loop
websockify      ← noVNC WebSocket bridge (port 6080 — not exposed in standard sync-up)
→ SYNC_DAEMON=true? exec bun run scripts/sync-l3-daemon.ts
→ else:          exec bun run server.ts  (never reaches this in pai-sync-l3)
```

The full server (`server.ts`), React frontend, and all API routes are present in the image but never started. What runs in the daemon is: the daemon process, all scraper modules (CCSP/Tableau + SF), Drive/Sheets clients, and the email sender.

**Built on:** Bun (TypeScript runtime), Playwright/Chromium, full dashboard codebase.

`make sync-up-vnc` is a variant that exposes port 6082 → VNC. Used during re-auth sessions when you need browser access inside the daemon container.

---

**Troubleshooting runbook:**

**Symptom: Not in `podman ps` at all**
```bash
podman ps -a --filter name=pai-sync-l3
# Shows nothing → container was never created or was rm'd
make sync-up    # create and start it
```

**Symptom: Container shows `Exited` status**
```bash
podman logs pai-sync-l3 --tail 30    # read why it exited before restarting
```
Most common cause: RH context init failed (stale cookies → redirect to login on first Chromium open). If you see:
```
[sync-daemon] RH context init failed: ...
```
→ Cookies in `/data-sync/rh-profile` are expired. The daemon calls `process.exit(1)` on this — it cannot recover without re-auth. See **Re-auth procedure** below.

**Symptom: Keepalive failure email / `Keepalive Failed` in logs**
```
[sync-daemon] keepalive FAILED: Tableau session expired — redirected to ...
[sync-daemon] keepalive FAILED: SF session expired — redirected to ...
```
The daemon is still running but SSO cookies are stale. The next sync will fail. Re-auth now before the daily sync fires. See **Re-auth procedure** below.

**Symptom: RH context auto-recovered in keepalive**
```
[sync-daemon] keepalive: RH context dead — attempting auto-recovery
[sync-daemon] keepalive: RH context recovered from saved cookies
```
The Chromium process backing the RH browser context died (common after ~6 days uptime / memory pressure). The keepalive detected it and re-initialized from saved cookies — no action needed. If you see `RH context recovery FAILED` instead, the saved cookies are also bad — follow the **Re-auth procedure** below.

**Symptom: Sync ran but specific pods show ERROR in email**
Check the per-pod error in the summary email HTML table. Common causes:
- `sfReportId` not set for that pod in `data-sync/config/settings.json` → pod skipped or errored
- Tableau view for that pod's region not accessible (CCSP) → check Tableau session
- SF report not yet generated (SF scheduled reports run nightly) → wait, or check SF directly

**Symptom: No daily sync email (sync silently not running)**
```bash
make sync-status    # check container is still Up
make sync-logs      # look for: "[sync-daemon] next sync in Xm"
```
If container is Up but no next-sync log entry: daemon may have crashed internally without exiting. `make sync-down && make sync-up` to restart cleanly.

**Symptom: `make sync-now` does nothing / sync doesn't start**
```bash
podman ps --filter name=pai-sync-l3    # confirm container is Up
make sync-logs                          # watch for trigger file detection
```
If container is Up and you see no `[sync-daemon] trigger file detected` within 30s, check:
```bash
podman exec pai-sync-l3 ls /data/cache/sync-trigger    # did the touch land?
```
If the file is there but not consumed, the daemon's trigger poller may be stuck — restart.

---

**Re-auth procedure (session expired):**

The daemon stores SSO cookies in a persistent Chromium profile at `/data-sync/rh-profile`. When Keycloak/SAML sessions expire (RH Portal: 8h absolute; SF/Tableau: varies), those cookies go stale and must be renewed by logging in again inside the daemon's browser.

1. **Stop the current daemon** (releases the SingletonLock on the profile):
   ```bash
   make sync-down
   ```

2. **Start the VNC variant** (same daemon but with port 6082 exposed):
   ```bash
   make sync-up-vnc
   ```

3. **Open VNC in browser:**
   ```
   http://mac.tail2fe7c7.ts.net:6082/vnc.html    (Tailscale required)
   ```

4. **Inside VNC — log in to each service:**
   - Open Chromium → navigate to RH Portal → complete SSO login
   - Navigate to Tableau → confirm it loads without redirect to login
   - Navigate to SF Lightning home → confirm it loads

5. **Stop VNC variant, start standard daemon:**
   ```bash
   make sync-down
   make sync-up        # now has fresh cookies; no VNC port exposed
   ```

6. **Verify recovery:**
   ```bash
   make sync-logs      # watch for: "[sync-daemon] keepalive OK"
   make sync-now       # trigger an immediate sync to confirm data flows
   ```

---

### 4. Config Written Back to Disk During Runtime

**Pattern:** `aes.json` and `customers.json` are read at startup and written back during bootstrap, scrape, and setup wizard flows. The server mutates its own config files.

**Why it's intentional:** These are user-controlled config files, not application state. The setup wizard and bootstrap process are the UX for editing them. There is no database. Config IS the persistence layer.

**What looks wrong:** "App writes to its own config at runtime" sounds like a self-modifying application. It isn't — it's a config editor with a web UI.

**Key safety:** `saveAes()` uses atomic write (`.tmp` + `rename`) to prevent corruption. `patchAe()` re-reads from disk before merging to prevent async clobber races.

---

### 5. Container-Only Architecture

**Pattern:** No systemd, no launchd, no host cron jobs, no host-level tooling. Everything runs inside the `pai-dashboard` Podman container.

**Why it's intentional:** Reproducibility and isolation. The container has its own Playwright, Bun, and VNC server. The Makefile (`make rebuild`) is the single deploy mechanism.

**Multi-arch images (2026-05-14):** The hero image (`daily-brief-dashboard`) is built as a multi-arch manifest (linux/amd64 + linux/arm64). `make build` builds natively first (full Dockerfile.hero), then cross-compiles only the runtime stage (`Dockerfile.hero-runtime`) for the other architecture using the pre-built dashboard artifacts. This avoids esbuild crashes under QEMU emulation. The L4 daemon image remains amd64-only (Chromium binary dependency).

**Rules that follow:**
- Always deploy with `make rebuild` — never raw `podman run` or `docker run`
- Never assume host paths exist inside the container
- Data lives in `/data` volume mount (`data/config/`, `data/cache/`, `data/rh-profile/`)
- Test new features in a fresh container, not dev environment

---

### 6. Data Flows One Way: Scrape → Sheet → Cache → API

```
Playwright scraper
  → Google Sheets (source of truth for external data)
    → sheets.ts fetchCCSPData / fetchCustomerSheetData (reads sheets)
      → server cache (ccsp-data.json, customers cache)
        → /api/* endpoints (serve from cache)
          → React dashboard
```

**Why it's intentional:** Google Sheets serves as the persistent, human-readable store for scraped data. The AE can open the sheet and see/edit data directly. The cache layer means the dashboard is fast even when Google API is slow. Scrapers only run on-demand or on schedule — not on every page load.

**What looks wrong:** "Data goes through Google Sheets instead of a database." Intentional — sheets are the user-visible artifact and the persistence layer simultaneously.

**Sheet ID fast paths (quota protection):** Both `fetchCCSPData` and `fetchCustomerSheetData` accept a `knownSheetIds?: string[]` parameter. When provided, they skip the Drive BFS traversal and `sheets.spreadsheets.get` calls on every spreadsheet — instead going directly to the known sheet IDs. `refreshSubscriptions`, `refreshAll`, and `refreshCCSP` pass `aes.map(a => a.supportableSheetId / ccspSheetId)` directly. Without this, 22-customer subscription refresh burns the Sheets API `Read requests per minute per user` quota before reaching most customers.

**Stale-overwrite guard:** `refreshSubscriptions`, `refreshAll`, `refreshCCSP`, and `refreshPipeline` all check: if fetch returns 0 records but cache has data, skip the write. Quota failures return `[]` silently; without this guard a quota failure permanently wipes good cached data.

**CCSP column detection resilience (ADR-017):** `parseCcspRows` in `src/lib/ccsp-resolvers.ts` uses pattern-based column detection with confidence scoring. When Tableau CSV headers misalign with data positions (discovered 2026-05-07: "Account Name" header at column A but actual account names at column B), the parser samples first 10 data rows and identifies columns by content patterns (Salesforce ID regex, decimal ACV values, quarter format) instead of trusting header positions. When header/pattern mismatch detected, uses pattern-detected columns. Prevents future Tableau export format drift from breaking CCSP data ingestion.

---

### 6a. Customer Data Structure and Domain Inference

**Customer record fields:**
- `name` — Short/brand name (e.g., "Interval", "National Grid")
- `aliases` — Legal entity names (e.g., ["Interval International, Inc.", "National Grid USA Service Company, Inc."])
- `domain` — Primary email domain for Gmail/Calendar searches (e.g., "intervalworld.com")
- `aliasDomains` — Additional email domains for subsidiaries, acquisitions, regional offices (e.g., ["subsidiary.com", "acquired-co.com"])

**Gmail/Calendar search behavior:**
All searches use **both** `domain` + `aliasDomains`. Example query for customer with domain="acme.com" and aliasDomains=["widget.com"]:
```typescript
(from:@acme.com OR to:@acme.com OR from:@widget.com OR to:@widget.com OR subject:"Acme Corp") after:2024-01-01
```

This handles:
- Acquired companies keeping old email domain (Widget Co → Acme Corp, but @widget.com emails still active)
- Subsidiaries with different domains (parent @company.com, subsidiary @company-intl.com)
- Regional offices (@company.com, @company.eu)

**Domain inference waterfall:**

Triggered via Admin UI "Infer Domains" button or POST `/api/setup/infer-domains`. Updates `domain` field only (not `aliasDomains` — those are manually curated).

```
waterfallInferDomain(companyName)
  1. Gemini LLM via Vertex AI
     - Input: customer.aliases[0] OR customer.name
     - Prompt: "What is primary website domain for {name}?"
     - tools: [{ google_search: {} }]  ← Google Search grounding enabled
     - Returns: domain string or null
  
  2. Clearbit Company API (if LLM returns null)
     - Input: same companyName
     - Returns: domain from /v2/companies/find
  
  3. Validation: isPublicDomain()
     - Rejects: localhost, 192.168.x.x, 10.x.x.x, 172.16.x.x, .local
     - Returns: validated domain or null
```

**Why aliases[0] (legal entity name) is used first:**
Short names often resolve to wrong domains. Example: "Interval" → interval.com (wrong), but "Interval International, Inc." → intervalworld.com (correct). Legal entity names in `aliases[0]` provide better specificity for LLM and Clearbit lookups.

**Google Search grounding (BKL-DOMAIN-01):**
Gemini calls include `tools: [{ google_search: {} }]` to enable web search when the company lacks training data in model weights. No PII sent — only company names from `customers.json`. Essential for companies founded after model training cutoff or with limited online presence.

**Data flow:**
- Admin triggers inference → POST `/api/setup/infer-domains`
- For each customer: `waterfallInferDomain(customer.aliases[0] ?? customer.name)`
- Updates `customers.json` with inferred `domain` value
- Gmail/Calendar searches use updated domain on next sync

**Manual `aliasDomains` curation:**
UI provides comma-separated input field "Alias Domains" in Setup wizard customer table. Server-side validation via `isPublicDomain()` rejects invalid entries. Use when:
- Customer has multiple active email domains
- Subsidiary uses different domain than parent
- Acquired company emails still active under old domain

---

### 6b. Account Provenance Tracking and Auto-Healing (#82, v1.7.0-rc8)

**Pattern:** Every discovered or generated `accountNumbers` entry carries provenance metadata tracking what logic version produced it (`appVersion`), how it was discovered (`discoveredBy`), and when (`discoveredAt`).

**Why it's intentional:** Bug fixes to discovery logic don't self-heal without provenance tracking. Example: Continental Broadband had 7 wrong accounts from a buggy v1.7.0-rc6 matcher. Deploying the fix left stale data forever — manual intervention (wipe cache, re-trigger) required.

**Data structure:**
```typescript
interface AccountProvenance {
  accountNumber: string
  discoveredBy: 'rh-scraper' | 'rh-cases-api' | 'manual' | 'pre-rc8'
  appVersion: string         // from package.json
  discoveredAt: string       // ISO8601 timestamp
}

interface Customer {
  accountNumbers: string[]
  accountProvenance?: AccountProvenance[]   // one entry per account
  // ...
}
```

**Stamping at discovery time:**
Both RH Portal discovery paths (`src/rh-scraper.ts` browser path + `src/rh-cases-api.ts` bearer path) call `stampProvenance()` immediately after discovering accounts. The stamped entries are merged with existing provenance via `mergeProvenance()`, which preserves manual entries (`discoveredBy === 'manual'`) and replaces all automated entries.

**Startup healer flow:**
1. `server.ts` calls `healStaleAccountNumbers()` once at container startup (before scheduled scrapes)
2. Healer migrates pre-rc8 accounts: any customer with `accountNumbers` but no `accountProvenance` gets stamped as `discoveredBy: 'pre-rc8'`
3. Healer detects stale accounts: any non-manual provenance entry with `appVersion !== APP_VERSION` is flagged
4. Healer queues re-discovery: enqueues one RH cases scrape task via `enqueueScraperTask()` to refresh all stale customers
5. Re-discovery runs asynchronously (scraper-manager picks up the queued task)

**Manual entry preservation (CRITICAL):**
`mergeProvenance()` filters existing provenance to keep only `discoveredBy === 'manual'` entries before appending new automated discoveries. This ensures account numbers manually added by the user (via Setup wizard or direct JSON edit) are NEVER overwritten by automated discovery.

**Exposed via API:**
`/api/accounts` response includes `accountProvenance` array for each customer (added at `src/territory-routes.ts:99`). Frontend can display provenance metadata, show staleness warnings, or filter by discovery method.

**Why not a database migration?**
`customers.json` is the persistence layer (§4). The migration is live: on first read at startup, the healer stamps any provenance-less accounts as `'pre-rc8'` and writes back to disk. No separate schema version or migration script needed.

**Future expansion (Phase 2 backlog):**
Extract provenance module for reuse across all discovered/generated data: domain inference, AI briefs, product intel, industry classification, any cache with logic-dependent data. Same stamping pattern, same healing flow.

---

### 7. OAuth Token Stored in a Single File

**Pattern:** One `google-token.json` covers all Google API scopes (Sheets, Drive, Gmail, Calendar). Two scope tiers: `NORMAL_SCOPES` (read-only operations) and `BOOTSTRAP_SCOPES` (Drive write, needed for sheet creation).

**Why it's intentional:** Single-user app. The token is for the AE's own Google account. Separate tokens per scope would require the user to re-auth multiple times.

**What looks wrong:** "Broad OAuth scope." The scope matches what the app actually does — it needs Drive write access to create spreadsheets in the AE's folder.

---

### 8. Bootstrap Drive Folder Structure

The app uses **two separate Drive roots** that serve completely different purposes. They are independent — neither contains the other, and they are configured by separate IDs.

#### Root 1 — Subscription Data folder (`podBookingsFolderId` in `settings.json`)

A single shared Drive folder, **completely independent** of `parentFolderId`. All app instances and deployments read/write here. Its ID is preserved across all installs and never recreated. All PODs land in this one flat folder — segmented by naming convention, not subfolders.

```
📁 Subscription Data/                       ← podBookingsFolderId in settings.json (shared, single folder)
   ├── 📊 {POD Name} POD - Subscriptions    ← L3 SF Bookings (Red Hat ops writes; app reads only)
   ├── 📄 CCSP-{POD_NAME}-{DATE}.csv        ← L3 CCSP (app writes after Tableau L4 scrape)
   └── 📄 SF-PIPELINE-{reportId}-{POD_NAME}.csv ← L3 Pipeline (app writes after SF L4 scrape)
```

- All L3 data — SF Bookings sheets, CCSP CSVs, and Pipeline CSVs — lives here.
- Files are never deleted. New PODs/regions just add more files as the territory expands.
- Independent of `parentFolderId` — same folder ID across every install.

#### Root 2 — CommandCenter folder (`parentFolderId`, locked after first bootstrap)

Per-install, **not** shared across instances. Set once on first AE bootstrap, then locked (see BKL-UX-FOLDER-LOCK-01). Stored in `aes.json` (first-wins).

```
📁 CommandCenter/                            ← parentFolderId (per-install, locked after first bootstrap)
   ├── 📁 Config/                           ← initial scaffolding (created on first bootstrap, idempotent)
   │     ├── 📊 appBackup                   ← spreadsheet backup of config snapshot
   │     └── 📄 settings.json               ← config snapshot for backup/restore
   ├── 📁 Products/                         ← initial scaffolding (created on first bootstrap, idempotent)
   │     ├── 📁 aap/
   │     ├── 📁 rhel/
   │     ├── 📁 ocp/
   │     ├── 📁 ocp-virt/
   │     ├── 📁 rhel-ai/
   │     ├── 📁 rh-ai-inference/
   │     └── 📁 rhoai/
   └── 📁 {AE Name}/                        ← per-AE folder, created by bootstrap Step 1; ID stored as driveFolderId in aes.json
         ├── 📁 {Customer 1}/                ← created in Step 2; ID stored in customers.json
         ├── 📁 {Customer 2}/
         ├── ...
         ├── 📊 Supportable — {AE Name}     ← L2, created in Step 4; ID stored as supportableSheetId
         ├── 📊 {AE Name} CCSP              ← L2, created in Step 5; ID stored as ccspSheetId
         └── 📊 {AE Name} Pipeline          ← L2, created in Step 6; ID stored as pipelineSheetId
```

**ID storage and identity:**
- `parentFolderId` — the CommandCenter root. Stored in `aes.json`. First-wins: validated and locked on the first bootstrap (single-AE or POD), then reused for all subsequent AE/POD bootstraps without re-asking (BKL-UX-FOLDER-LOCK-01).
- `podBookingsFolderId` — the Subscription Data folder. Stored in `settings.json`. Independent of `parentFolderId`; never recreated.
- `driveFolderId` — the AE's own folder created by Step 1 under CommandCenter. Stored in `aes.json`. Used as the parent for all per-AE sheet and customer folder creation.

**Initial bootstrap scaffolding (idempotent):**
- `Config/` and `Products/` (with the seven product slug subfolders) are created once on first bootstrap. Re-runs detect existing folders by name and skip creation.
- `appBackup` is a spreadsheet that belongs in `Config/`.
- Product corpus folders belong under `Products/[slug]/`.

Customer folder names use `normalizeCustomerName()` — strips legal suffixes (Inc, LLC, Corp), state codes (`- CA`), parentheticals. Bootstrap is idempotent: existing folder IDs are reused from `aes.json`/`customers.json` on re-runs.

**Customer type has `driveFolderId?: string`** — stored on each `Customer` entry in `customers.json` after the folder is created in Step 2.

**Bootstrap does NOT populate local cache:** Steps 5 and 6 write CCSP and pipeline data directly to Google Sheets. The local JSON cache files in `data/cache/` are populated separately when the dashboard loads and triggers scrapes. `api/status/scrapes` sync timestamps ARE set during bootstrap.

**Step 5 L3 data flow (populate-data-sheets.ts):** `readCcsp` downloads `CCSP-{pod}-*.csv` from `podBookingsFolderId`, filters by territory, writes full rows to the CCSP sheet. `readPipeline` searches for `SF-PIPELINE-{pod}-*.csv` in `podBookingsFolderId` with a fallback to any SF-PIPELINE file in the folder. Sheet tabs are renamed at creation time ("CCSP Data" for CCSP, "Pipeline" for Pipeline) so `fetchCCSPData` and `fetchPipelineData` find the correct tabs. The AE folder is found via `ctx.parentFolderId` (CommandCenter root), NOT `aeFolderId` — passing `aeFolderId` caused a nested folder bug (BKL-BOOTSTRAP-NESTED-FOLDER-01, fixed 2026-05-06).

**Known implementation gaps (pending — see BACKLOG.md):**
- **BKL-DRIVE-SCAFFOLD-01** — `Config/` and `Products/` are not yet created as part of initial bootstrap scaffolding.
- **BKL-DRIVE-APPBACKUP-01** — `appBackup` is currently written to the Subscription Data folder; should be in `Config/` under CommandCenter.
- **BKL-DRIVE-PRODUCTS-ROOT-01** — Product slug folders are currently created directly under CommandCenter root; should be under `Products/`.

---

### 9. Salesforce Authentication Flow

Salesforce login is automated via SAML auto-click — no manual form fill required. The connect flow:

1. User clicks "Connect Salesforce" in Data Sources section
2. Frontend calls `POST /api/auth/salesforce/start`
3. Backend opens SF login in the shared browser context (VNC at `localhost:6080`)
4. SAML auto-click completes login automatically in a few seconds
5. Frontend polls `GET /api/auth/salesforce/status` every 2s until `hasSession && !sessionExpired`
6. Cancel: `DELETE /api/auth/salesforce/session` stops the login and closes the browser popup

**Session expiry detection uses two signals** — not just the `sessionExpired` flag. The frontend derives:
```typescript
const sfExpired = sfStatus?.sessionExpired || sfStatus?.syncError?.toLowerCase().includes('session expired')
const sfConnected = sfStatus?.hasSession && !sfExpired
```
This covers the case where the Playwright flag resets on container restart but `syncError` still carries the expired-session message from a previous failed sync.

---

### 10. Supportable APEX — Two Account Render Modes

Supportable 360 is an APEX Oracle app. After entering an account number and clicking Go, APEX renders account detail in one of two modes:

**Normal mode** — APEX renders a tab row on the page. One "Export" anchor in the DOM. Clicking it navigates to page 22 (SalesReport layout) where the CSV download is performed.

**Inline Customer Information panel mode** — APEX renders account data inline on page 1. This mode is triggered by certain accounts (e.g. REI/627962, Shutterfly/565461). Two "Export" anchors appear in the DOM:
1. An orange "Export" link inside the product family table (first in DOM) — clicking this stays on page 1, wrong target
2. An "Export" TAB at the bottom of the Customer Info panel (last in DOM) — clicking this navigates to page 22, correct target

**`P0_LAYOUT` is NOT a reliable indicator** of which mode is active. It stays set to `"Entitlements"` on page 1 for ALL accounts in both modes — it cannot be used to detect account-load completion.

**Correct approach** (see `src/supportable-scraper.ts`): `waitForSelector('a:has-text("Export")', {timeout: 12000})` to wait for any Export link, then `page.$$('a:has-text("Export")')` to get all anchors, then click `[length - 1]` (last). Works for both modes — normal accounts have one anchor (index 0 = last), inline accounts have two (index 1 = last = correct tab).

**What looks wrong:** "Always taking the last element" seems fragile. It is safe — APEX's tab row anchor is always last in DOM order, after any inline table links.

---

### 10a. Supportable Sequential Architecture (Council Decision 2026-04-03)

Subscription scraping is strictly sequential: one page processes one account at a time. Parallel APEX tabs crash Chromium under container memory constraints (2GB shm, 8GB mem) due to Oracle APEX's single-cookie session model causing DOM context collisions between tabs.

**Discovery** stays parallel (up to 3 pages via `DISCOVERY_PARALLEL`) because it only reads `page.content()` — no downloads, no DOM mutation, no export clicks. Discovery sessions are created via "New Session" button which spawns isolated APEX app instances (304→305→306).

**Page lifecycle:** Fresh page every 10 accounts (`ACCOUNTS_PER_PAGE_CYCLE`). Old page navigates to `about:blank` before close (flushes DOM). Session heartbeat keeps APEX alive across long scrape runs.

**Promise containment:** All `page.waitForEvent('download')` calls have `.catch(() => null)` at creation to prevent unhandled rejections if the page dies mid-download. `process.on('unhandledRejection')` in server.ts is a safety net.

---

### 12. Cold-Start Auth-Gate and Circuit Breaker Reset

**Pattern:** On container startup, the server performs an auth pre-flight check before firing any scrapers. If the RH session is stale (expired cookies from overnight), the initial scrape is skipped entirely — no circuit breaker penalty — and the system waits for manual re-authentication via VNC.

**Cold-start lifecycle:**
```
Container starts
  → Auth pre-flight: open test page, check RH session validity
  → Session valid?
      YES → enqueue initial scrape immediately
      NO  → skip scrape (no CB penalty), wait for manual auth via VNC
```

**Why it's intentional:** Before this change, startup used a blind 10-second delay then fired all scrapers. If the container had been stopped overnight, cookies were always expired — scrapers would accumulate 15+ failures, tripping circuit breakers into OPEN state. Even after the user VNC-logged in and re-authenticated, the circuit breakers stayed open for their cooldown period. The auth pre-flight eliminates this false-failure accumulation entirely.

**Circuit breaker reset on re-authentication:** When a user completes RH Portal or Salesforce SSO login (via VNC), all circuit breakers are reset to CLOSED state. This ensures that re-authentication immediately restores full scraper capability without waiting for cooldown timers.

**Re-auth adopts ALL scrapers:** Both `rh-auth.ts` and `sf-auth.ts` call all four adoption functions on successful login:
```
Re-auth (RH or SF SSO)
  → adoptRhContext(ctx)
  → adoptSupportableContext(ctx)
  → adoptCcspContext(ctx)
  → adoptSfContext(ctx)
  → Reset all circuit breakers to CLOSED
  → Enqueue immediate scrape
```

**Manual "Run Now" overrides circuit breakers:** The admin page "Run Now" buttons reset the relevant circuit breaker before enqueueing the scrape. When a user explicitly clicks "Run Now", it always executes a real attempt regardless of breaker state. The button text changes to "Force Run" when the breaker is OPEN, and each scraper card shows BREAKER OPEN/HALF-OPEN badges with failure count.

**What looks wrong:** "Resetting circuit breakers defeats the purpose." In a multi-tenant system, yes. Here, a circuit breaker trip from expired cookies is not a real failure signal — it's an auth problem. Once auth is restored, the failure condition is resolved. The breaker reset is semantically correct: the underlying cause has been addressed.

---

## What IS Worth Flagging

These are genuine concerns where security/quality recommendations are appropriate:

- **Formula injection in Google Sheets writes** — `sanitizeCell()` applied to all Sheets writes before `valueInputOption: 'RAW'` (fixed 2026-03-29)
- **Error messages leaking internal paths in API responses** — generic messages to client at 5 routes (RH login, SF login, Tableau, file check, folder connect), detail logged server-side (fully fixed 2026-03-31 — 2026-03-29 fix was incomplete)
- **driveFolderId format validation** — `/^[a-zA-Z0-9_-]{10,}$/` in `ccsp-scraper.ts` and `supportable-scraper.ts` (fixed 2026-03-29)
- **Territory string validation** — `/^[A-Z0-9_]+$/` before Playwright selectors in `ccsp-scraper.ts` (fixed 2026-03-29)
- **Cache file permissions** — `mode: 0o600` on all cache writes (fixed 2026-03-29)
- **Silent catch blocks** — 9 previously-silent write catches now log `console.warn` (fixed 2026-03-29)
- **Race conditions on async AE updates** — `patchAe()` used instead of `aes.map()` after `await` in bootstrap steps (fixed 2026-03-29)
- **Telemetry ENOENT** — `SCRAPE_LOG_PATH` now uses `process.env.CACHE_DIR` instead of hardcoded relative path (fixed 2026-04-03)

---

### 11. RH SSO Cascade Failure Pattern

**Pattern:** When the Red Hat Portal 8-minute keep-alive timer fires a session-expiry callback during an active scrape, all three RH-dependent scrapers (CCSP, Supportable, RH cases) fail simultaneously — not just the one that triggered expiry.

**Why it cascades:** All three scrapers share the same `BrowserContext` (see §1). The keep-alive callback originally called `closeScrapeContext()` unconditionally, destroying the shared context mid-operation. This aborted any page operations in all three scrapers at once with a `Target page closed` error.

**The guard (added 2026-03-30, `server.ts` ~line 3685):**
```typescript
setSessionExpiredCallback(() => {
  recordScrapeExpired()
  notify(...)
  if (supportableScrapeRunning || ccspScrapeRunning || _rhScrapeRunning) {
    console.warn('[session] RH session expired during active scrape — deferring context close')
    return  // ← defers; scrapers fail naturally on next page op, then mutexes release
  }
  closeScrapeContext().catch(() => {})
})
```

**What happens when deferred:** The scrape continues with an expired session. The next network request to the RH Portal will fail (typically a 401 or redirect to login). The scraper catches this, marks the scrape as failed, and releases its mutex. The keep-alive guard runs again on the NEXT expiry tick and closes the context cleanly when idle.

**Failure symptoms (before guard):** All three scrapers fail simultaneously with "Target page closed". The keep-alive timer fires every ~8 minutes. If a scrape takes longer than 8 minutes, it will hit the expiry window.

**What looks wrong:** "Session expiry deferred — context not closed immediately." This is correct behavior. Closing mid-scrape is worse than letting the scraper fail gracefully on the next operation.

**UI implication:** When the session expires during a scrape, the dashboard should show a "RH session expired" notification (TODO: `BKL-S09b` — notification when expiry fires while scrape is active; keep-alive guard currently only logs server-side). For now: check the scrape status endpoint; `lastError` on any scraper will reflect the post-expiry failure message.

---

## Key Files

| File | Purpose |
|---|---|
| `server.ts` | Hono HTTP server, all API routes, background refresh timers |
| `src/rh-scraper.ts` | Red Hat Portal case scraper — browser path (Playwright, Mac Mini `NODE_ROLE=primary` only) |
| `src/rh-cases-api.ts` | Red Hat Portal case scraper — bearer API path (SOLR REST API, hero installs `NODE_ROLE` unset) |
| `src/supportable-scraper.ts` | Supportable 360 subscription scraper (Playwright, APEX Oracle) |
| `src/ccsp-scraper.ts` | Tableau CCSP cloud spend scraper (Playwright) |
| `src/sf-scraper.ts` | Salesforce pipeline scraper (Playwright) |
| `src/sheets.ts` | Google Sheets reader (cache layer feed) |
| `src/google.ts` | Google OAuth + unified token management |
| `src/rh-auth.ts` | Red Hat Portal SSO login browser management + full scraper adoption |
| `src/sf-auth.ts` | Salesforce SSO login + full scraper adoption + CB reset |
| `data/config/aes.json` | AE configuration: territories, Drive folder IDs, sheet IDs |
| `data/config/customers.json` | Customer list: names, account numbers |
| `data/cache/` | JSON caches for CCSP, pipeline, subscriptions |
| `dashboard/` | React/Vite frontend (build with `npm run build` from this dir) |
| `Makefile` | `make rebuild` is the only deploy command |

---

## Test Infrastructure

The e2e suite (Tiers 1–5, ~260 tests) uses a layered approach:

### Test directory layout

```
test/
  fixtures.ts                  ← serverState fixture, API helpers, factory functions
  contracts/
    schemas.ts                 ← Zod schemas for API contract validation (test-only)
    api-contracts.spec.ts      ← contract tests (read-only, hit live server)
  api/                         ← API endpoint tests (request fixture only)
  ui/                          ← UI state machine tests (page fixture + route mocks)
  accessibility.spec.ts        ← axe-core WCAG 2.1 AA on main pages
  performance.spec.ts          ← response-time budget assertions
  e2e-carolanne.spec.ts        ← end-to-end flow for a configured AE
  qa-*.spec.ts                 ← QA-specific flows
  wizard.spec.ts               ← Setup wizard UI tests
  regression.spec.ts           ← Regression guards
```

### State isolation: serverState fixture

Tests that mutate `aes.json` or `customers.json` are automatically isolated by the `serverState` fixture in `test/fixtures.ts`. It:
1. Calls `POST /api/__test/snapshot` before the test to capture config state
2. Calls `POST /api/__test/restore` after the test to put it back

The fixture is `auto: true` — it applies to every test without opt-in. This enables `fullyParallel: true` in playwright.config.ts.

**Test-only endpoints** (`POST /api/__test/snapshot`, `POST /api/__test/restore`) are registered in `server.ts` only when `NODE_ENV !== 'production'`. See ADR-006 for the full decision rationale.

### Zod contract layer

`test/contracts/schemas.ts` contains Zod schemas for all major API response shapes. These are used only in `test/contracts/api-contracts.spec.ts` — never imported by production code.

### Performance budgets

| Endpoint | Budget |
|---|---|
| `GET /api/aes` | < 200ms |
| `GET /api/bootstrap/auto/status` | < 500ms |
| `GET /api/bootstrap/tableau/session-status` | < 500ms |
| `GET /api/customer/:name/ccsp` | < 1000ms |
| `GET /api/customer/:name/pipeline` | < 1000ms |

### 3-Tier Test Structure (Wave 2, 2026-04-03)

The test suite is organized into three tiers with different run requirements:

#### Tier 1 — Unit tests (Bun native runner)

```
bun test src/
```

Fast, in-process, no server required. Covers pure logic: auth helpers, status store, scraper state mutations.

Key files:
- `src/rh-auth.test.ts` — `isPortalUrl()`, `getRhStatus()`, `recordScrapeSuccess/Expired()`
- `src/scraper-manager.test.ts` — `CircuitBreaker` state machine, session-expiry pin behavior
- `src/scraper-status-store.test.ts` — `recordOutcome()`, `markRunning()`, `consecutiveFailures` increment/reset

#### Tier 2 — API contract tests (Playwright `ci` project)

```
npx playwright test --project=ci
```

Runs against a live server. Excludes `@live` tagged tests via `grepInvert: /@live/`. Suitable for CI (GitHub Actions `ci.yml`). Covers API endpoint contracts, auth spec, and UI flows without requiring a live scraper session.

#### Tier 3 — @live scraper pipeline tests (Playwright `live-scrapers` project)

```
npx playwright test test/live-scrapers.spec.ts --project=live-scrapers
```

Runs only `@live` tagged tests. Requires:
- Running container at `BASE_URL` (default: `http://localhost:7777`)
- Active RH Portal session (logged in via VNC — verified by auth pre-flight)
- VPN connectivity for Supportable tests
- SF session active for Salesforce tests

Tests:
1. `@live RH Cases` — POST /api/scrape/rh, poll status, assert `recordCount > 0`
2. `@live SF Pipeline` — POST /api/scrape/salesforce, poll status, assert `recordCount > 0`
3. `@live CCSP` — POST /api/scrape/ccsp, poll status, assert `recordCount > 0`
4. `@live Supportable` — POST /api/scrape/supportable (300s timeout), verify customer `accountNumbers` populated
5. `@live Full pipeline` — assert all 4 scrapers `isStale: false`, `lastError: null`
6. `@live Source-to-cache` — assert `lastSuccess` within 60 minutes for RH, SF, CCSP

Timeout budgets: 120s for RH/SF/CCSP, 300s for Supportable (APEX Oracle is slow).

### Session Health Watchdog (Wave 2, 2026-04-03)

The 15-minute heartbeat tick in `src/background-scheduler.ts` includes a lightweight session watchdog:

1. **RH session expiry alert:** Calls `getRhStatus(sessionPath)` on each tick. If `sessionExpired` transitions from false to true, fires an ntfy `high` priority alert: "Red Hat Portal session expired — log in via VNC to restore scraping". Deduplicated via `_lastWatchdogSessionExpired` flag — fires once per expiry event, not every 15 minutes.

2. **Login timeout alert:** If `loginTimedOut` is true and `_lastWatchdogSessionExpired` was false, fires: "Login attempt timed out — retry via dashboard Connect button".

3. **Consecutive failure alerts:** Reads `getStatus()` from scraper-status-store. Any scraper with `consecutiveFailures >= 5` fires an ntfy `high` alert. Tracked via `_alertedScrapers: Set<string>` — alert clears when failures return to 0.

**Security:** All ntfy body strings are STATIC. No session tokens, cookie values, URLs, profile paths, or raw `e.message` are interpolated into notification bodies. Error strings are passed through `sanitizeErr()` before inclusion.

---

## Tab Matching Safety (BKL-M14, 2026-03-31)

`tabMatchesCustomer` in `src/sheets.ts` matches spreadsheet tab names to customer names for Supportable sheet lookups. The bidirectional substring approach (`normTab.includes(normCust) || normCust.includes(normTab)`) is correct for long names but caused a **data corruption incident** when a 3-char customer name ("EBS") matched mid-word inside unrelated tab names.

**Fixed pattern (do not revert):**
- Names ≤ 4 chars after normalization → whole-word regex `(^|\s)shorter(\s|$)` only
- Names > 4 chars → bidirectional substring (original logic)

**Scope guard (do not remove):**
- `fetchCustomerAccountNumbers` called with `knownSheetIds` must be scoped to the customer's own AE sheet only
- SSE endpoint scopes via `aes.find(a => a.name === customer.ae)` before building `supportableIds`
- Passing ALL AE sheet IDs for a single-customer lookup is a bug — causes cross-AE tab name collisions

---

## §11. Data Refresh Architecture — Hero vs L4 Daemon

Two deployment targets with distinct data responsibilities. Understanding which data layer each operates on is critical.

### Hero install (NODE_ROLE unset) — L3 reader + RH cases

The hero install reads pre-populated data from Google Drive (L3) and fetches RH cases via Bearer token — **no Playwright browser required**.

| Data Source | Method | Writes to | Timer | Notes |
|---|---|---|---|---|
| **RH cases** | `REDHAT_OFFLINE_TOKEN` → Bearer token → Hydra SOLR API (pure HTTP) | `data/cache/cases.json` | 15-min heartbeat tick | **No browser** — uses offline token exchange (ADR-014). `RH_CASES_TRANSPORT` defaults to `'bearer'`. Browser path retained as disaster recovery only (`RH_CASES_TRANSPORT=browser`). |
| **CCSP** | Google Drive API → CSV discovery (ADR-019) | `data/cache/ccsp-data.json` | Interval timer (default 24h) | **L3 read** — reads CSVs written by L4 daemon. No browser needed. |
| **Pipeline** | Google Drive API → CSV discovery (ADR-019) | `data/cache/pipeline-data.json` | Daily at 2am ET | **L3 read** — reads CSVs written by L4 daemon. No browser needed. |
| **Subscriptions** | Google Sheets API → SF Bookings sheet | `data/cache/sheet-cache-*.json` | Interval timer (default 240 min) | **L3 read** — reads sheets populated by bootstrap. No browser needed. |

**Supportable is permanently disabled** (`SUPPORTABLE_DISABLED=true`). Account number discovery uses SOLR name search via Bearer token (hero) or RH Portal sidebar autocomplete via Playwright (primary node only).

### L4 daemon (NODE_ROLE=primary, Mac Mini) — browser-based scrapers

The L4 daemon runs browser-based scrapers that write to the L3 shared Drive folder. Built with `Dockerfile.l4`, separate image from the hero install.

| Scraper | Source | Writes to | Notes |
|---|---|---|---|
| **CCSP/Tableau** | Tableau (Playwright browser) | L3 shared Drive folder (CSV) | Requires Tableau SSO login |
| **SF Pipeline** | Salesforce Lightning (Playwright browser) | L3 shared Drive folder (CSV) | Requires SF OAuth session |

The L4 daemon writes CSVs to Drive → the hero install's `refreshCCSP()` and `refreshPipeline()` read those CSVs via Drive API.

### Scraper queue (hero + primary)

`src/scraper-queue.ts` serializes operations that share browser context or session state. On the hero install with bearer transport, the queue primarily serializes account number discovery and SF pipeline sync. On the primary node, it also serializes CCSP/Tableau and Supportable browser scrapes. The queue exists in both images for the `flushScrapersAfterAuth()` post-authentication path.

## §27. Service Module Pattern (#334, 2026-05-20)

All 5 major route files have been extracted into service modules. Route files are thin HTTP adapters; services contain pure domain logic with zero Hono imports.

| Route file | Lines | Service file | Lines |
|---|---|---|---|
| `campaigns-routes.ts` | 211 | `campaign-service.ts` | 627 |
| `meeting-prep-routes.ts` | 174 | `meeting-prep-service.ts` | 1190 |
| `dashboard-routes.ts` | 193 | `dashboard-service.ts` | 1313 |
| `customer-routes.ts` | 796 | `customer-service.ts` | 668 |
| `product-intel-routes.ts` | 361 | `product-intel-service.ts` | 740 |

**Pattern:** Route handler = parse request → call service → return c.json(result). Service = pure business logic, independently testable, zero framework dependency.

**Adding new endpoints:** Create the domain function in the service module, then add a thin route handler.

## §28. Scheduler Registry (ADR-028, 2026-05-20)

`src/scheduler-registry.ts` — centralized scheduler with 4 schedule types (daily, weekly, interval, heartbeat). Modules register their schedule; the registry owns setTimeout lifecycle and status tracking.

Admin endpoint: `GET /api/admin/scheduler-status` — shows all scheduled tasks, next run time, last success/failure.

Phase 1 (infrastructure) shipped. Phases 2-5 (migrating existing schedule functions) in future sessions. See `docs/adr/ADR-028-unified-scheduler-registry.md`.

### Refresh functions (hero install, L3 → L2)

| Function | Reads from | Writes to | Timer | Configurable? |
|---|---|---|---|---|
| `refreshSubscriptions()` | SF Bookings sheet (Sheets API) | `data/cache/sheet-cache-*.json` | Interval | Yes — `subscriptions` in data-sources.json |
| `refreshCCSP()` | L3 CSV files (Drive API, ADR-019) | `data/cache/ccsp-data.json` | Interval | Yes — `ccsp` in data-sources.json |
| `refreshPipeline()` | L3 CSV files (Drive API, ADR-019) | `data/cache/pipeline-data.json` | Daily 2am ET | No — hardcoded daily |
| `refreshAll()` | Subscriptions + CCSP | Both caches | Startup + `/api/refresh` | N/A |

### How to configure intervals

Intervals are stored in `data/config/data-sources.json` under `refreshIntervals`. All values are in minutes.

```json
{
  "refreshIntervals": {
    "subscriptions": 240,
    "ccsp": 1440,
    "rhScrape": 240
  }
}
```

Change via API (live, no restart needed):
```bash
curl -X POST http://localhost:7777/api/settings/refresh \
  -H "Content-Type: application/json" \
  -d '{"subscriptions": 120, "ccsp": 720, "rhScrape": 120}'
```

Or read current intervals:
```bash
curl http://localhost:7777/api/settings/refresh
```

Pipeline sync (2am ET), CCSP scrape (6:30am ET), Supportable batch (7am ET), and Territory sync (1:45am ET) are configurable via `schedulerConfig` in the same `data-sources.json` file. Each source has `*Time` (HH:MM ET), `*Enabled` (boolean), and `*LastRun` (ISO string or null) fields. Enable/disable is checked at the start of each timer callback (timers always reschedule, disabled ones skip the scrape). Floor enforcement on the POST endpoint prevents overly frequent runs (SF Pipeline/Supportable: 12h, CCSP/Territory: 6h).

### Territory Lookup Cache

`GET /api/territory-lookup` and `GET /api/territory-names` use in-memory `Map` caches (keyed by territory code and pod respectively) with a 1-hour TTL. Cache is bypassed with `?force=true`. Cleared on server restart. No disk writes.

### Full data flow

```
Source systems (RH Portal, Supportable, Tableau, Salesforce)
    ↓  Stage 1: Scrapers (Playwright) — writes new data to Google Sheets
Google Sheets (Supportable sheet, CCSP sheet, Pipeline sheet)
    ↓  Stage 2: Refresh functions (Sheets API) — reads sheets into local cache
data/cache/ (sheet-cache-*.json, ccsp-data.json, pipeline-data.json)
    ↓  Dashboard reads cache only
Dashboard UI
```

---

## §12. Brief Cache Architecture (ADR-009)

### Two-Condition Invalidation

Brief cache files live at `data/cache/{slug}-{date}.json`. Each file contains `{ text, cachedAt }`. The brief route regenerates the cached brief when either condition is true:

```
Condition 1 (sheet staleness): sheet.cachedAt > brief.cachedAt
Condition 2 (TTL): Date.now() - brief.cachedAt >= BRIEF_CACHE_TTL_MS (4 hours)
force=true: always regenerate, bypasses both conditions
```

`BRIEF_CACHE_TTL_MS = 4 * 60 * 60 * 1000` is exported from `src/cache-layer.ts`.

**Why both conditions:** Sheet staleness alone caused brief regeneration on every scrape tick. TTL alone could miss important sheet changes within the 4h window. Combined, the brief regenerates at most every 4h AND on any sheet data change.

**Drive-watcher invalidation** (`invalidateBriefCaches()`) still works — it deletes the cache file entirely, causing immediate regeneration on next request regardless of TTL.

### lastBriefDate Delta Detection

`buildXmlSources()` calls `readLatestBriefCache(customerName)` to find the most recent cached brief file (sorted by date suffix in filename). The `.date` field (e.g. `"2026-04-03"`) is passed into the XML as `<last_brief_date>`. Gemini uses this to focus the brief on changes since that date. Previously this was hardcoded to "yesterday."

---

## §13. Account Intelligence Pipeline — Dual-Write Cache Pattern (ADR-010)

The account intelligence pipeline runs on demand per customer and produces structured intelligence about account health, stakeholder engagement, and risk signals.

### Write path

```
POST /api/intelligence/:customer/generate
  ├── Step 1: Gather signals
  ├── Steps 2+3: Run in parallel (Promise.allSettled)
  ├── Write → Google Drive document (source of truth)
  └── Write → data/cache/intelligence/{slug}.json (local read cache)
```

Job state (progress, status, errors) is persisted to `data/cache/intelligence-jobs.json` via `setJob()`. `initJobPersistence(cacheDir)` is called from `server.ts` on startup.

### Read path (brief generation)

`buildXmlSources()` in `customer.ts` checks for `data/cache/intelligence/{slug}.json`. If present, its content is included in the brief XML as `<source type="account_intelligence" generated="{generatedAt}">`. If absent (pipeline never run), the source is silently omitted.

**Why local JSON, not Drive read-back:** Drive API adds 500-2000ms latency per brief request. Local file read is <1ms. Drive remains authoritative — the local copy is a fast read cache only.

### Brief XML input sources (as of 2026-04-04)

```xml
<source type="subscriptions">    — from sheet cache (active, non-free/trial subs only)
<source type="support_cases">    — from RH cases cache
<source type="calendar">         — from Google Calendar API
<source type="emails">           — from Gmail API
<source type="documents">        — from Google Drive docs (Google Docs + PDFs via Gemini multimodal)
<source type="pipeline">         — from pipeline cache, filtered per customer
<source type="cloud_spend">      — from CCSP cache, filtered per customer
<source type="account_intelligence"> — from data/cache/intelligence/{slug}.json (if exists)
<source type="previous_brief">   — from readLatestBriefCache() for delta detection
```

### PDF content extraction (BKL-R25, 2026-04-04)

PDFs in customer Drive folders are extracted via Gemini multimodal (`inlineData` with `mimeType: application/pdf`) in `_fetchCustomerDocsImpl()`. Two safety gates:
- **Size gate:** PDFs > 15MB are skipped (not sent to Gemini) — prevents Vertex AI errors and runaway token cost
- **Log injection prevention:** `f.name` is sanitized (`replace(/[\r\n]/g, ' ').slice(0, 200)`) before being interpolated into `console.warn` messages

Extracted text is capped at `DOC_CONTENT_CAP` (8K chars) per file, same as Google Docs. Falls through to next file on any extraction error.

**Pending (BKL-R25b):** Pre-convert PDF to Markdown locally (e.g. `pdf-parse`) before sending to Gemini. Would reduce input tokens ~60-80% by sending structured text instead of raw PDF bytes.

**Free/trial subscription exclusion:** `isFreeOrTrial()` (from `health-score.ts`) filters out subscriptions matching keywords (`free`, `beta`, `trial`, `eval`, etc.) before they are included in the XML. This prevents Gemini from generating renewal urgency for non-commercial subscriptions.

---

## §14. Morning Summary — Gemini Synthesis Layer

`GET /api/morning-summary` assembles portfolio signals (priority actions, health scores, recent cases) across all customers. A new synthesis step calls Gemini to produce a 3-5 sentence narrative covering:
- Most urgent issues requiring action today
- Patterns across customers
- Top 3 recommended actions for the day

**Cache:** `data/cache/morning-synthesis.json` with `MORNING_SYNTHESIS_TTL_MS` (4 hours). The synthesis is non-blocking — if Gemini fails, the summary endpoint returns without the `synthesis` field rather than erroring.

**Response shape:**
```json
{
  "signals": [...],
  "synthesis": "string — Gemini-generated narrative (optional, absent on failure)"
}
```

---

## §15. Product Filter / POD View (BKL-PVIEW-01–04, 2026-04-07)

A product-centric view mode layered on top of the existing ASA dashboard. All filter state is client-side via localStorage; the backend has one product-aware endpoint (`GET /api/ccsp`).

### View modes

Two modes toggled in `Sidebar.tsx` (localStorage key: `dashboard-view-mode`):

| Mode | Key | Behavior |
|------|-----|----------|
| ASA | `"asa"` | Default view — AE filter chip bar, calendar, morning summary all visible |
| Product | `"product"` | Morning summary hidden; product chip bar shown; AE chips remain |

### Filter chip bars (App.tsx)

**AE chip bar** — single-select radio group. Shows each AE's first name + customer count + worst-health dot (color = lowest confidence score across that AE's customers). Persisted in localStorage key `ae-filter-selected`. When an AE is selected, `selectedAe` prop threads down to the grid.

**Product chip bar** — multi-select. Labels sourced from `discoverAllProducts()` (live from subscription data). Each chip shows a `title` tooltip listing the raw subscription names in that group (`getProductGroupMembers()` — LOG-03). Persisted in localStorage key `product-filter-selected`.

### Product name normalization (`dashboard/src/utils/productName.ts`)

Raw subscription names (e.g., `"Red Hat Ansible Automation Platform, Standard (100 Managed Nodes)"`) are mapped through a two-step pipeline:

1. `stripProductName()` — removes `"Red Hat "` prefix + everything after the first comma
2. `normalizeProductName()` — keyword-match to one of 10 display labels:

| Label | Matches |
|-------|---------|
| Beta | `beta` |
| Free | `free` |
| Trial | `trial` |
| AAP | `ansible` |
| Storage | `storage` |
| OCP | `openshift` |
| RHEL | `enterprise linux`, `satellite` |
| Middleware | `runtimes`, `integration` |
| Partner Subscriptions | `partner` |
| Developer Subscriptions | `developer subscription` |

First match wins. Names that don't match any rule pass through as-is.

### Filter propagation

| Surface | How filter is applied |
|---------|----------------------|
| `AccountPortfolioGrid` | `selectedProducts` prop; matching subs expanded inline on each card; non-matching collapsed behind "show N more" toggle |
| AE grouping | When filter active + 2+ AEs: cards grouped by AE with "N matching / M hidden" header; zero-match AE groups collapsed |
| `KPICards` | Receives `filteredAccounts` (matching accounts only); shows filtered/total ratio for cases; expiring + renewal counts scoped to matching subs (LOG-04) |
| `MorningSummary` | Customer bullets filtered to product-matching accounts (LOG-05) |
| `GET /api/ccsp?products=OCP,RHEL` | Server-side: maps labels → `productOfferingGroup` values, filters CCSP records before aggregation (LOG-06) |

### Virtualization (Phase 4)

`AccountPortfolioGrid` uses **react-window VariableSizeGrid** for the "All" mode. A `ResizeObserver` computes responsive column count. Each row is fixed at 240px height. This keeps 80-160 card portfolios in `~50ms` render time.

### `GET /api/pod/summary`

Runtime aggregation endpoint for portfolio-level KPIs:

```
totalCustomers        — deduplicated by lowercase name across all AEs
totalAEs              — AE count from aes.json
openCases             — sum of open cases across all customers
openCasesByProduct    — Map<productLabel, caseCount>
expiringNext90Days    — count of subscriptions expiring within 90 days
productMix            — normalized label → customer count
```

30-second in-memory TTL. No disk cache — recomputed from existing customer + cases cache files.

---

## §16. Account Plan Generation (BKL-AI17, 2026-04-06)

`src/account-plan.ts` — on-demand Gemini multimodal pipeline that assembles a full account plan for a customer.

### Source assembly

Four sources are combined at generation time:

| Source | Location | Format | Notes |
|--------|----------|--------|-------|
| Sample account plan | `/app/config/account-plan/sample.pdf` | Base64 inlineData | Bundled in image via `Containerfile` |
| Account planning questions | `/app/config/account-plan/questions.pdf` | Base64 inlineData | Image-based PDF — passed via Gemini vision |
| Account planning playbook | `/app/config/account-plan/playbook.pdf` | Base64 inlineData | Always included; A/B test confirmed significantly better output |
| Customer intel | `data/cache/intelligence/{slug}.json` | Text injection | Per-customer signals from the intelligence pipeline |

Config dir is `APP_CONFIG_DIR = /app/config/account-plan/` inside the container, configurable via env var.

### Drive isolation

`ensureAccountPlansSubfolder(customerFolderId)` creates or finds an `Account Plans/` subfolder in the customer's Drive folder — **separate from `Account Intelligence/`**. This is intentional: `fetchCustomerDocs()` only ingests `Account Intelligence/` docs. If generated plans were written there, they would feed back into their own generation prompt on the next brief run.

### Write path

```
POST /api/customers/:id/account-plan/generate
  ├── In-flight guard (_accountPlanInFlight Set) → 409 if duplicate
  ├── Read 3 PDF sources from /app/config/account-plan/
  ├── Read customer intel from cache
  ├── Call Gemini multimodal (inlineData for PDFs)
  ├── Write → data/cache/intelligence/{slug}-account-plan.md
  ├── Write → data/cache/intelligence/{slug}-account-plan-meta.json (driveUrl + generatedAt)
  └── Upload → Drive Account Plans/ subfolder
```

**In-flight guard:** `_accountPlanInFlight` is a module-level `Set<string>`. The route returns 409 if a generation is already running for that customer. Prevents double-click cost explosion.

### Read path

```
GET /api/customers/:id/account-plan
  ├── readAccountPlan(slug, cacheDir)
  ├── If cache hit → { markdown, generatedAt, driveUrl }
  └── If no cache → { notGenerated: true }
```

### Required output sections

The system prompt explicitly requires 12 sections. Sections 10-12 are structurally enforced:

- **Whitespace Map** — markdown table: Business Units (rows) × Red Hat products (cols), with opportunity level (🟢/🟡/⚪) and Opportunity Status
- **Initiatives** — 3-5 customer-centric initiatives with: Customer Objective, Red Hat Solution, Estimated Deal Size, Timeline, Next Steps, Tagged Potential Opportunity
- **Actions & Next Steps** — numbered markdown table: #, Action, Owner (AE/ASA name from customers.json), Target Date, Status

### Frontend

`AccountPlanPanel.tsx` — 3-state component on `CustomerDetailPage`:
1. **Not generated** — "Generate Account Plan" button
2. **Generating** — spinner + polls `GET /api/customers/:id/account-plan` every 3 seconds
3. **Generated** — View (opens `MarkdownPreviewModal`) / Download / Regenerate

`MarkdownPreviewModal.tsx` — full-screen modal with custom markdown renderer. Handles headers, lists, bold, italic, inline code, code blocks, tables (pipe syntax), horizontal rules. Security: `javascript:` URIs in link targets are blocked; rendered as `<span>` instead of `<a>`.

---

## §17. Admin Page — Operational Panels (2026-04-04)

### Session Health Panel (BKL-M50d)

`dashboard/src/components/SessionHealthPanel.tsx` — a 4-tile status grid on the Admin page showing at-a-glance health for all data sources. Fetches three endpoints in parallel (`/api/auth/redhat/status`, `/api/auth/salesforce/status`, `/api/scraper-status`) on mount, then polls every 30 seconds.

```
RH Portal tile    — hasSession, sessionExpired, lastScraped, caseCount
Salesforce tile   — hasSession, sessionExpired|syncError, lastSync, rowCount
CCSP tile         — state (fresh/stale/failed/running), lastSuccess, recordCount
Supportable tile  — state (fresh/stale/failed/running), lastSuccess, recordCount
```

**SF expired logic:** `expired = sf.sessionExpired || !!sf.syncError` — any non-null `syncError` degrades status. This covers the case where `sessionExpired` resets on container restart but `syncError` still carries the expired message from the prior failed sync.

### Browser Crash Banner (BKL-W2-13)

`detectBrowserCrash()` in `scrape-api.ts` scans the last 5 telemetry log entries. If any entry has a `browser_crashed` event type, returns `true`. The `/api/scraper-status` response includes `browserRestartNeeded: detectBrowserCrash()`. The Admin page shows a dismissible red banner when `browserRestartNeeded` is true, prompting the user to run `make restart` via VNC.

### Wall-Clock Timeout Guard (BKL-M58 partial)

`wallTimeout(ms, label)` in `scrape-api.ts` returns a `Promise<never>` that rejects after `ms` milliseconds with a labeled error. Supportable discover tasks (both per-AE and all-AE loops) are wrapped in `Promise.race([discoverPromise, wallTimeout(10 * 60 * 1000, '...')])`. Prevents a hung APEX page from blocking the scrape queue indefinitely.

---

## §18. Product Intelligence Hub — Phase 2 + Phase 3 (2026-04-05/06)

### Products supported (7)

| Slug | Display Name |
|---|---|
| `rhel` | Red Hat Enterprise Linux |
| `ocp` | OpenShift Container Platform |
| `ocp-virt` | OpenShift Virtualization |
| `aap` | Ansible Automation Platform |
| `rhel-ai` | RHEL AI |
| `rh-ai-inference` | AI Inference |
| `rhoai` | OpenShift AI |

Config lives in `data/config/product-intel-config.json`. New products are added by editing that JSON — no code changes required.

### Scraper resilience: content quality gate (BKL-SCRAPE-01)

`validateScrapedContent()` in `product-release-radar.ts` validates all scraped text before it enters the content hash / cache pipeline. Rejects content that matches error patterns (403 pages, login walls, SSO redirects) or falls below minimum length. If all sources fail validation, the previous known-good cache is preserved — bad content never poisons the hash baseline. The same gate is applied in `product-feature-radar.ts` for enrichment fetches. No custom User-Agent headers are set on public URL fetches — docs.redhat.com blocks browser-like UA strings.

### Phase 2: Drive corpus optional + expanded product set

`driveFolder` on each `ProductConfig` is now `string | null`. Products without a configured Drive folder use release-notes-only synthesis. The generate route (`product-intel-routes.ts`) no longer requires `driveFolder` to be set before running — the Drive ingest step is silently skipped when the field is null.

**Content budget (in `product-feature-radar.ts`):**
- `SECTION_CAP` raised from 3500 → 6000 chars per section
- `TOTAL_CAP` raised from 9000 → 18000 chars total corpus per product

### Phase 3: Feature radar injected into customer briefs

**Data flow:**

```
product-feature-radar.ts
  → getFeatureCache(slug)          ← reads data/cache/product-intel/{slug}-features.json
       |
       v
product-intel-routes.ts (POST /api/products/:slug/generate-customer-intel)
  → passes productFeatures + productFeaturesHash to generateCustomerProductIntel()
       |
       v
customer-product-intel.ts: generateCustomerProductIntel()
  → injects features as structured block (4000-char cap) into Gemini prompt
  → content hash includes productFeaturesHash (corpusHash) for cache invalidation
  → returns CustomerProductIntel with featureTalkingPoints field
```

**New field on `CustomerProductIntel`:**

```typescript
featureTalkingPoints: Array<{
  feature: string        // exact feature name from feature radar
  status: string         // "GA" | "Tech Preview" | "Roadmap"
  version: string | null
  reason: string         // why this specific customer should care
  signalSource: string   // case#/SKU name/doc title/pipeline deal
}>
```

Ranked top 3-5 features selected by Gemini from the feature radar, each anchored to a specific customer signal. Returns `[]` when no features were provided or none are relevant.

**Account intelligence caps (in `customer-product-intel.ts`):**
- Company content cap: 2000 → 6000 chars
- Industry content cap: 1000 → 2000 chars

### Product Documentation Auto-Discovery

**Decision:** Discovery-first hybrid (Council 2026-05-08, Issue #75, BKL-PRODUCT-DOC-DISCOVERY-01)

**Problem:** Red Hat documentation structure changes broke single-pattern auto-discovery (AAP changed from `release_notes` to `whats_new-*` pages, causing feature extraction to fail).

**Solution:** Multi-pattern sequential discovery with content validation:

1. **Try 4 patterns sequentially:**
   - `release[_-]notes` (RHEL, OCP, OCP-Virt)
   - `whats[_-]new` (AAP 2.6+)
   - `changelog` (future-proofing)
   - `new[_-]features` (future-proofing)

2. **Content validation on discovered URLs:**
   - HTML must be >1KB (not 404 page or redirect)
   - Must contain version string pattern (`/\d+\.\d+/`)

3. **Config override:** `seeds.releaseNotesDocNames` array takes precedence when present (skips auto-discovery entirely). Used for products where naming conventions deviate significantly or manual override is needed.

4. **Graceful degradation:** If all patterns fail, returns empty string (logged to console).

**Why discovery-first:** Zero-config onboarding for 95% of products. Config serves as escape hatch for edge cases only. New products added to product-intel-config.json work immediately without code changes.

**Files:** `src/product-feature-radar.ts` (fetchLatestReleaseNotesContent, lines 148-240)

**Regression test:** REG-030 in `test/regression.spec.ts` validates AAP feature extraction works with whats_new pattern.

### Bootstrap wizard: Product Intelligence scaffold

The setup wizard (`SetupPage.tsx`) shows the Product Intelligence folder tree only for the first AE (`knownAes.length === 0`). The shared `Product Intelligence/` Drive folder with 7 product subfolders is a one-time scaffold — second+ AEs share the same Drive folder and do not re-create it.

```
📁 Product Intelligence/   ← created on first AE only
   ├── 📁 rhel/
   ├── 📁 ocp/
   ├── 📁 ocp-virt/
   ├── 📁 aap/
   ├── 📁 rhel-ai/
   ├── 📁 rh-ai-inference/
   └── 📁 rhoai/
```

### Key files

| File | Purpose |
|---|---|
| `src/product-release-radar.ts` | Life Cycle API + PDF/HTML scraping + Gemini synthesis per product |
| `src/product-feature-radar.ts` | Feature extraction from Drive corpus; `getFeatureCache(slug)`, `SECTION_CAP=6000`, `TOTAL_CAP=18000` |
| `src/product-drive-ingest.ts` | Drive folder listing + Markdown/doc content ingestion per product |
| `src/product-intelligence.ts` | Q&A chat pipeline (BKL-AI16); separate from release radar |
| `src/product-intel-routes.ts` | All `/api/products/*` endpoints; loads feature cache and passes to customer intel |
| `src/customer-product-intel.ts` | `generateCustomerProductIntel()`; Gemini prompt with feature injection; `featureTalkingPoints` output |
| `dashboard/src/pages/ProductsPage.tsx` | Products listing (Unified Stream layout: FeatureFilterBar + SpotlightStrip + FeatureListRow + FeatureDetailPanel) |
| `dashboard/src/components/ProductIntelSection.tsx` | Per-product intel section component; hardcodes all 7 slugs |
| `data/config/product-intel-config.json` | Product definitions: slugs, Drive folder IDs, seed URLs, refresh intervals |
| `data/cache/product-intel/` | Feature caches (`{slug}-features.json`), summaries (`{slug}-summary.json`), customer intel (`{slug}-customer-intel/{customer}.json`) |

---

## Agent Briefing Checklist

Before spawning any specialist agent (Rook, Marcus, Quinn, etc.) on this codebase:

- [ ] Share this file or the relevant section
- [ ] Confirm the agent knows: single-user, single-container, localhost-only
- [ ] For security reviews: share Section 1 (shared context) and Section 2 (no auth) explicitly
- [ ] For any "why don't you use X" recommendation: check if it's covered in this doc first

---

## §13. Scraper Status Layer Architecture

### Two-tier status system

The status layer is a hybrid of two mechanisms. Understanding which fields come from which source is critical for reading status correctly.

**Tier 1 — ScraperStatusStore** (`src/scraper-status-store.ts`):
- Disk-backed: persisted to `data/cache/scraper-status.json`
- Survives container restarts
- Fields: `lastRun`, `lastSuccess`, `lastError`, `recordCount`, `state`, `consecutiveFailures`
- Updated by: full browser scrapes AND (after 2026-04-06) sheet-based syncs via `recordOutcome()`
- Service name keys: `'rh-cases'`, `'ccsp'`, `'supportable'`, `'sf-pipeline'`

**Tier 2 — In-memory module variables** (in each scraper module):
- Lives in process memory only
- Resets to null/false on every container restart
- Exists for: `lastScraped` (rh-auth.ts), `lastCcspScrape` (ccsp-scraper.ts), `lastSupportableScrape` (supportable-scraper.ts), `lastSfSync` / `lastSfRowCount` (sf-scraper.ts)
- Most are now superseded by disk-backed alternatives (see below)

### Status endpoint field sources (as of 2026-04-06)

| Endpoint | `lastScrape`/`lastSync` source | `recordCount` source | Survives restart? |
|---|---|---|---|
| `GET /api/scrape/rh/status` | `lastScraped` (in-memory) | `store.recordCount` | Partial — store survives, `lastScraped` resets |
| `GET /api/scrape/supportable/status` | `readSheetCache()` max `cachedAt` (disk) | `store.recordCount` | Yes |
| `GET /api/scrape/ccsp/status` | `readCCSPCache()?.cachedAt` (disk) | `readCCSPCache()?.records.length` (disk) | Yes |
| `GET /api/scrape/salesforce/status` | `lastSfSync` (in-memory, seeded from cache at startup) | `store.recordCount` | Yes (via `initSfSyncFromCache`) |

### When sheet-based sync updates the store

`refresh-engine.ts` calls `recordOutcome()` after every successful cache write:
- `refreshCCSP()` → `recordOutcome('ccsp', { success: true, recordCount })`
- `refreshSubscriptions()` → `recordOutcome('supportable', { success: true, recordCount })`
- `refreshPipeline()` → `recordOutcome('sf-pipeline', { success: true, recordCount })`

This means a "Sync Now" from the Setup page Data Sources section (GSheet → cache) correctly updates the store's `lastSuccess` and `state`, even without a browser scrape.

### CCSP sheet access constraint

The Sheets API uses a service account (`SHEETS_TOKEN_PATH`). The service account can only access sheets it created. User-created CCSP sheets are inaccessible (API returns "not found"). The correct CCSP flow is:
1. Admin panel → Run CCSP Sync (Tableau → creates/writes service-account-owned sheet → cache)
2. Setup page → CCSP Sync Now (reads service-account sheet → cache) — works once step 1 has run

If `ccspSheetId` is lost (AE re-bootstrap), `writeCcspSheet` creates a new blank sheet rather than finding the existing one (BKL-SCRAPER-01 — pending fix with Jason's approval).

---

## §19. Data Pipeline Inventory

Complete inventory of every data pipeline in the system, organized by execution model.

### Browser-based scrapers (Playwright)

| Pipeline | Schedule | Trigger | Notes |
|---|---|---|---|
| **RH Cases** | Heartbeat interval (default 240 min, configurable via `rhScrape` in data-sources.json) | Automatic timer tick; manual via Admin "Run Now" | Runs for all account numbers in customers.json. 15-min tick checks elapsed time against configured interval. |
| **Supportable** | Daily 7:00 AM ET | `schedulerConfig.supportableTime` | Rotating 3-batch (ADR-008). Single BrowserContext, strictly sequential — no parallelism (APEX cookie collisions). Requires VPN. |
| **CCSP / Tableau** | Daily 6:30 AM ET | `schedulerConfig.ccspTime` | Tableau SSO via shared browser context. Writes to service-account-owned Google Sheet. |
| **SF Pipeline** | Daily 2:00 AM ET | `schedulerConfig.sfPipelineTime` | Salesforce Lightning report export. Requires active SF session. |

All schedule times configurable via Admin page or `POST /api/settings/scheduler`. Floors enforced server-side (SF/Supportable: 12h, CCSP/Territory: 6h).

### Intelligence pipelines (Gemini + Google Search grounding)

| Pipeline | Trigger | Cache | Notes |
|---|---|---|---|
| **Account Intelligence** | Post-bootstrap auto-trigger; manual via Admin "Generate All" (`POST /api/intelligence/generate-all`) | `data/cache/intelligence/{slug}.json` (dual-write: Drive doc + local JSON, ADR-010) | Three steps: (1) industry/segment classification, (2) company brief + industry analysis via Gemini with Google Search grounding, (3) Drive docs write. ~10 min/customer. |
| **Customer Briefs** | On-demand per page view (`GET /api/customer/:name/brief`) | `data/cache/{slug}-{date}.json` | 4h TTL (ADR-009). Auto-invalidates when source sheet data is newer than cached brief. `force=true` bypasses both conditions. |
| **Product Intelligence** | Weekly Sunday 6:00 AM ET | `data/cache/product-intel/{slug}-features.json`, `{slug}-summary.json` | Regenerates feature radar (AAP/OCP/RHEL/etc.) for all 7 products. Feature cache injected into customer product intel generation. |
| **Morning Synthesis** | On-demand via `GET /api/morning-summary` | `data/cache/morning-synthesis.json` | 4h TTL. Gemini narrative summarizing portfolio signals. Non-blocking — endpoint returns without `synthesis` field on failure. |

### Live on-demand (no persistent cache except brief output)

| Pipeline | Trigger | Data Window | Notes |
|---|---|---|---|
| **Gmail** | Fetched per brief generation | Last 30 days | Domain + name matching against customer. Included in brief XML as `<source type="emails">`. |
| **Calendar** | Fetched per dashboard load | 2-week window (Mon–Mon) | Google Calendar API, primary calendar only (`calendarId: 'primary'`). Subscribed/shared calendars excluded. Included in brief XML as `<source type="calendar">`. |
| **Google Drive docs** | Crawled per brief generation | All docs in customer folder | Depth 5 traversal. Google Docs + PDFs (Gemini multimodal extraction, 15MB size gate). 8K char cap per doc. |

### Other pipelines

| Pipeline | Trigger | Notes |
|---|---|---|
| **Domain Inference** | Auto-runs post-bootstrap for all new customers | High-confidence results auto-saved to customers.json. |
| **Territory Sync** | Daily 1:45 AM ET | GSheet diff against customers.json. Auto-adds new customers, flags removals. |
| **KPI Snapshot** | Daily 8:00 AM ET | Daily metric snapshots to `kpi-history.json`. 90-day rolling window. |
| **NotebookLM** | Manual only | Requires `NOTEBOOKLM_ENABLED=true` env var. Admin trigger only. |

## §20. Account Team Data Contract

Standardized resolution of account team members (AE, ASA, SSP/SSA specialists, managers) for all features that need team context.

### Key module: `src/account-team.ts`

| Export | Purpose |
|---|---|
| `getAccountTeam(customer)` | Returns `AccountTeamMember[]` — canonical team for a customer |
| `getOperatorProfile()` | Returns logged-in user from `user-settings.json` |
| `persistTeamCache(teamData)` | Single writer for territory team cache |
| `invalidateTeamCache()` | Clear in-memory cache (called after writes) |
| `toPromptContext(team)` | Canonical Markdown serialization for Gemini prompts |

### Data sources (priority order)

1. **Territory sheets** → parsed by `extractTeamMembers()` in `territory-sync.ts`, cached to `cache/territory-teams.json`, loaded into memory on first call
2. **Operator profile** → `config/user-settings.json` fields `operatorName` + `operatorTitle` (fallback when no territory data)
3. **Customer record** → `customer.ae` field for AE name

### Territory team structure

Per-territory (per AE column in sheet): Account SA → ASA name.
Per-pod (shared column): Product SSP/SSA specialists, Partner Sales Executive, Consulting Services Manager.

Territory lookup uses `ae.tableauTerritories[0]` as hash key into the cache, with AE name string matching as fallback.

### Types (`src/types.ts`)

- `AccountTeamRole` = `'ae' | 'asa' | 'ssp' | 'ssa' | 'manager'`
- `AccountTeamMember` = `{ name, title, role }`
- `TerritoryTeamEntry` = `{ territory, aeName, asa?, specialists[], partnerSales?, consultingManager? }`
- `TerritoryTeamsCache` = `{ updatedAt, teams: Record<string, TerritoryTeamEntry> }`

### Current consumers

| Feature | How it uses the contract |
|---|---|
| **Campaigns** (`campaigns-routes.ts`) | `getAccountTeam(customer)` → metadata line + config table in HTML |
| **Account Plans** (`account-plan.ts`) | `getOperatorProfile()` → ASA name in plan prompt |
| **Team endpoint** (`admin-routes.ts`) | `GET /api/customer/:name/team` → full JSON team |
| **Territory sync** (`admin-routes.ts`) | `POST /api/admin/territory-sync` → manual trigger |

### Adding a new consumer

```typescript
import { getAccountTeam, toPromptContext } from './account-team.ts'

const team = getAccountTeam(customer)
const promptSection = toPromptContext(team)
// promptSection = "## Account Team\n- Account Executive: Elmer Alvarez\n- Account Solution Architect: Jason Horn\n..."
```

### Known bugs (fixed 2026-04-06)

- **`makeAuth` missing import** in `src/account-intelligence.ts` — caused intelligence generation to crash on startup when `makeAuth` was called but not imported from `google-auth-library`.
- **`google` (googleapis) missing import** in `src/account-intelligence.ts` — caused Drive docs write step (Step 3) to fail with `google is not defined`. Both caught when triggering "Generate All" to restore industry/segment labels after customers.json restore.

## §21. Gemini Output Quality Gate (ADR-024, 2026-05-18)

`validateAndRetry()` in `src/gemini-quality-gate.ts` validates all Gemini-generated content before it is saved to cache or Drive. It operates as a middleware pattern — wrapping the output of any generation function, regardless of whether that function uses `callGemini()` or the legacy `callGeminiGrounded()` path.

### Quality loop

1. Route generates content via Gemini (any method)
2. Route calls `validateAndRetry(rawOutput, { validator }, retryFn)`
3. Validator runs domain-specific checks, produces a `QualityScorecard`
4. If score >= threshold: return output + scorecard
5. If score < threshold: call `retryFn(failures, attempt)` — the route rebuilds the prompt with structured error feedback and calls Gemini again
6. Max 2 retries. Best-scoring attempt always returned (never fails the request)

### Per-content validators

| Validator | File | Threshold | Key checks |
|-----------|------|-----------|------------|
| Campaign | `quality-validators/campaign-validator.ts` | 70 | Positioning >= 2, email count >= 4, subject lines, body length, varied features, no internal data |
| Meeting prep | `quality-validators/meeting-prep-validator.ts` | 75 | 10 numbered sections, partner context table, Why Red Hat >= 4 rows, discussion questions with named attendees, action items with names + dates |
| Intelligence | `quality-validators/intelligence-validator.ts` | 80 | Executive summary, company overview >= 200 chars, revenue/employee data, >= 3 competitive signals, regional coverage, source citations |
| Account plan | `quality-validators/account-plan-validator.ts` | 75 | >= 10 sections, whitespace map table, >= 3 initiatives, actions table with owners, team members, Red Hat products |

### Scorecard persistence

Scorecards are stored in the existing cache entry for each output (`.qualityScorecard` field). No new cache files.

### Enrichment tables (ADR-025)

Four deterministic enrichment tables are injected after sections 4-7 post-Gemini via `insertAfterNumberedSection()`. All builders are pure sync functions in `src/meeting-prep-enrichment.ts`:

| Builder | After Section | Data Sources | Key Output |
|---------|--------------|--------------|------------|
| `buildProductAlignmentTable` | 4. Why Red Hat | Value maps, customer product intel, product summaries | Confidence (HIGH/MEDIUM/LOW), proof point metrics, Summit news cross-refs |
| `buildSummitAnnouncementsTable` | 5. What's New | Product summaries, RSS feeds, product roadmap | Recent announcements with recency framing, capped at 8 rows |
| `buildEnhancedLifecycleTable` | 6. Product Lifecycle | Lifecycle cache, roadmap, product summaries | Key Changes + Customer Angle columns |
| `buildRSSIntelligenceTable` | 7. Expansion | RSS feed cache | Blog posts with real URLs as markdown links, customer relevance |

Enrichment tables are additive — they cannot cause a previously-passing quality gate to fail. The validator runs on raw Gemini output for retry decisions, then the enriched output is rescored for cache persistence.

### Key constraint

This module does NOT modify `callGemini()` or any transport-level code. `callGemini()` handles HTTP retry (429s), cost tracking, and delta caching. The quality gate handles business-logic validation. Separate concerns.

## §22. Customer Engagement Playbook (ADR-026, 2026-05-18)

Persistent, per-customer intelligence that accumulates over time. Replaces throwaway meeting prep with a living document. Meeting prep becomes a derived view.

### Playbook state

`data/cache/playbooks/{customer-slug}.json` — single JSON file per customer with 8 sections:

| Section | Source | Gemini vs Deterministic |
|---------|--------|------------------------|
| 1. Strategic Position | Intelligence, account plan, meeting notes | Gemini narrative |
| 2. Key Relationships | Account team, meeting attendees, partners | Gemini + deterministic team data |
| 3. Current Priorities | Intelligence, meeting notes (freshest wins) | Gemini narrative |
| 4. Product Alignment | Value maps, subscriptions, product radar, lifecycle | Gemini use cases + deterministic proof points, links |
| 5. Open Action Items | Extracted from meeting notes | Structured data (tracked persistently) |
| 6. Engagement History | Meeting notes summaries, campaigns | Append-only structured log |
| 7. Expansion Opportunities | Expansion analysis, feature radar | Gemini narrative |
| 8. Renewals & Risk | Subscriptions, open cases | Gemini wrapping deterministic data |

### Meeting note ingestion

`POST /api/customer/:name/playbook/ingest-notes` with `{ docUrl: string }`. Reads Google Doc via Drive API, Gemini full-state merge (current playbook + new notes → updated playbook). Extracts action items, adds engagement history entry.

### Derived meeting prep

When a playbook exists, `meeting-prep-routes.ts` reads from it (filtered for attendees) with a shorter Gemini prompt. Falls back to existing flow when no playbook exists. Gate: `if (readPlaybook(slug)) { derived } else { existing }`.

### Feature module

Registered as `playbook` in Feature Module Registry (ADR-020). Contributes action items and engagement entries to universal signal stack. **Must declare `accountTab`** for the tab to appear on the customer detail page — tabs are dynamically loaded from `/api/feature-modules/nav`.

### API surface

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/customer/:name/playbook` | Read playbook state |
| POST | `/api/customer/:name/playbook/generate` | Generate from data sources |
| POST | `/api/customer/:name/playbook/ingest-notes` | Merge meeting notes |
| POST | `/api/customer/:name/playbook/publish` | Google Doc snapshot |
| PATCH | `/api/customer/:name/playbook/action-items/:id` | Toggle action item |
| GET | `/api/customer/:name/playbook/history` | Ingestion provenance |
| POST | `/api/playbook/generate-all` | Batch generate |
| GET | `/api/playbook/generate-all/status` | Batch progress |

## §22. Universal Signal Scoring (ADR-027, 2026-05-19)

All signal scoring is centralized in `feature-module-registry.ts`. Modules NEVER set `score` directly — they provide `rawRelevance` (0-1 within-domain ranking) and structured `metadata`. The registry's `scoreSignal()` function determines the final score.

### Specificity detection
The registry examines metadata to classify each signal:
- **customer** (floor 0.50, ceiling 1.00): has `customerSlug`, `accountNumber`, `severity`, or `acvPlus`
- **industry** (floor 0.35, ceiling 0.69): has `industryMatch`
- **general** (floor 0.10, ceiling 0.35): neither customer nor industry indicators

### Boosters (from metadata)
`redHatProducts` non-empty (+0.10), `acvPlus`/`amount` > 0 (+0.10), `confidence: HIGH` (+0.05), `context: evaluating/migrating_from` (+0.10), `severity` 1 (+0.15) / 2 (+0.10), `endDate` within 90 days (+0.10), `hasCloudSpend` (+0.10), `confidence: LOW` (-0.10).

### Per-source budget caps
Applied in `collectAllSignals()` after scoring. pipeline=10, ccsp=8, cases=8, cloud-marketplace=10, tech-stack=8, rh-rss=5, subscriptions=5, intelligence=5, value-maps=3, news-radar=5, default=5.

### Signal debug
`GET /api/customer/:name/signals/debug` returns every signal with score, tier, rawRelevance, metadata, and tier classification (Critical/High/Medium/Low/Noise).

### Delta cache invalidation
`SCORING_VERSION` constant in `gemini-call.ts` is included in the delta cache hash. Bump it when scoring logic changes to invalidate all cached Gemini responses.

Full spec: `docs/adr/ADR-027-universal-signal-scoring-contract.md`. Design principles: `PRINCIPLES.md`.

## §23. Cloud Marketplace Module (#306, 2026-05-19)

`src/modules/cloud-marketplace-module.ts` ingests Red Hat's monthly Cloud Marketplaces newsletter via Gmail API, extracts linked Google Slides/Docs, reads them via Drive API export, and uses Gemini structured extraction to parse per-cloud marketplace data.

### Pipeline
1. Gmail API search (`subject:"Cloud Marketplaces and Private Offers Newsletter"`)
2. Extract Google Slides/Docs/Drive URLs from email HTML body
3. `drive.files.export` each file as plain text
4. Gemini structured extraction → per-cloud sections (AWS, Google, Microsoft, Oracle)
5. Cache at `data/cache/cloud-marketplace/latest.json`
6. Signals cross-reference customer CCSP cloud spend

### Signal types
- `product-release`: marketplace offerings (RHEL HPC, OpenShift AI, etc.)
- `product-intel`: programs (EDP, CPPO, Cloud Commit, MACC) and incentives (SPIFFs, sales boosts)

### Scoring (ADR-027)
Signals with `hasCloudSpend: true` and `acvPlus > 0` score Critical (customer has active spend on that hyperscaler + marketplace offering available). Programs have `rawRelevance: 0.8` (directly actionable), incentives `0.75`, offerings `0.7`.

Refresh: `POST /api/refresh/cloud-marketplace`. Budget cap: 10 signals per customer. Auto-discovered in Data Freshness dashboard.

## §24. Signal Template Engine (#326, 2026-05-20)

`src/lib/signal-templates.ts` — shared deterministic template engine for all signal consumers. Replaces per-consumer inline signal formatting with a centralized module.

Signals arrive already scored from the registry (§22). The template engine ONLY formats — no scoring, no Gemini calls. Returns:
- **`deterministic`** — structured markdown sections (product alignment, cloud marketplace, renewals, cases, tech stack, key relationships)
- **`narrativeContext`** — top N signals formatted for Gemini prompts (format varies by consumer)

### Signal routing

Signals auto-route to sections by metadata keys (priority order):
1. `hasCloudSpend` or `provider` → Cloud Marketplace
2. `severity` or `caseNumber` → Cases
3. `renewal` or `stage + closeDate` → Renewals
4. `infrastructure` or `confidence + context(eval/migrate)` → Tech Stack
5. `redHatProducts` or `product` → Product Alignment
6. Fallback: source name

### Consumer integration

| Consumer | File | Format | Uses deterministic? | maxNarrative |
|----------|------|--------|---------------------|-------------|
| Playbook | `playbook-generator.ts` | `playbook` | Yes | 40 |
| Brief | `brief-pipeline.ts` | `brief` | No | 10 |
| Campaign | `campaigns-routes.ts` | `campaign` | No | 20 |
| Meeting Prep | `meeting-prep-routes.ts` | `meeting-prep` | Yes | 20 |

Adding new template sections: add function + routing case in `routeSignal()` + wire into `templateAll()`. All consumers auto-receive. Design principles: `PRINCIPLES.md`. Full design: GitHub issue #326.

## §25. Pre-flight Signal Refresh (#328, 2026-05-20)

Universal auto-discovery signal refresh before content generation. When any consumer calls `loadCustomerSignals(slug, name, { ensureFresh: true })`, ALL registered modules that implement `ensureFresh()` refresh their data before signals are collected.

### Architecture

The `FeatureModule` interface has two optional fields:
```typescript
ensureFresh?: (customerSlug: string) => Promise<void>  // refresh stale data
cacheTtlMs?: number                                     // how long data is fresh
```

`ensureSignalsCurrent()` in `signal-loader.ts`:
1. Gets ALL registered modules from `FeatureModuleRegistry.getRegisteredModules()`
2. Calls `ensureFresh()` on every module that implements it
3. Runs all refreshes in parallel (`Promise.allSettled`)
4. 30-second timeout — anything not done is abandoned
5. Fail-open — refresh failures don't block generation
6. Returns `{ refreshed, skipped, failed }` for logging

### Auto-discovery contract

New modules automatically participate by implementing `ensureFresh()`. No hardcoded source list. No consumer changes needed. The registry is the single source of truth for what gets refreshed.

### Current implementations

| Module | TTL | Refresh action |
|--------|-----|---------------|
| emails | 4h | `fetchCustomerEmails()` |
| account-plan | 7d | `generateAndSaveAccountPlan()` |
| intelligence | 14d | `runIntelligencePipeline()` |

### Consumer integration

All 4 consumers pass `{ ensureFresh: true }`:
- `playbook-generator.ts` → `loadCustomerSignals(slug, name, { ensureFresh: true })`
- `customer.ts` (brief generation) → `ensureSignalsCurrent()` before `collectAllSignals()`
- `campaigns-routes.ts` → `loadCustomerSignals(slug, name, { ensureFresh: true })`
- `meeting-prep-routes.ts` → `loadCustomerSignals(slug, name, { ensureFresh: true })`

Page-load and display endpoints use default `ensureFresh: false` — they read current state without triggering refresh.

### Adding pre-flight to a new module

1. Add `ensureFresh(customerSlug)` to your module — check cache freshness, refresh if stale
2. Add `cacheTtlMs` to your module — how long your data is considered fresh
3. Done. `loadCustomerSignals({ ensureFresh: true })` will call your `ensureFresh()` automatically.

## §26. Architecture Compliance Gate (#329, 2026-05-20)

Two-layer enforcement of the three-layer architecture (scoring → templates → thin consumers).

### Build-time gate

`test/unit/architecture-compliance.test.ts` runs with `bun test` and checks:
- **No hardcoded scores:** Module files must use `rawRelevance`, never `score:` directly
- **Consumer template usage:** All consumer files must import from `signal-templates.ts`
- **Consumer pre-flight:** All consumers must use `loadCustomerSignals({ ensureFresh: true })` or `ensureSignalsCurrent()`
- **Module coverage report:** Advisory listing of modules with `signals()` but missing `ensureFresh`/`cacheTtlMs`

All checks use auto-discovery from the registry and file system — no hardcoded lists. New modules and consumers are automatically checked.

### Runtime compliance

`GET /api/modules/compliance` returns:
```json
{
  "totalModules": 21,
  "signalProducers": 18,
  "withEnsureFresh": 3,
  "compliant": ["emails", "intelligence", "account-plan"],
  "advisory": ["news-radar", "cases", ...],
  "exempt": ["campaigns", "tools", "meeting-prep"],
  "score": 17
}
```

Admin page Feature Modules section shows compliance warnings per module.

## §27. Solution Intelligence Engine (ADR-030, 2026-05-21)

Cross-reference layer that sits between data caches and signal-producing modules. Reads from multiple existing caches, computes cross-references, and provides enriched context.

### Architecture

```
Data Sources (existing caches)
  tech-stack, CCSP, cloud-marketplace, cases, lifecycle, pipeline, subscriptions
       ↓ reads
Solution Intelligence Layer
  solution-plays.json (static catalog, 16 plays, 6 TDPs)
  customer-solution-context.ts → getCustomerSolutionContext()
       ↓ enriches
solution-intelligence-module.ts (registered, budget=8)
tech-stack-module.ts (enriches signals with play metadata)
       ↓ scored signals
Template Engine → Strategic Opportunities section
  Sub-sections: Solution Plays, Marketplace Opportunities, Urgent Correlations
       ↓
Consumers (playbook, brief, campaign, meeting-prep) — zero changes
```

### Key files

| File | Purpose |
|------|---------|
| `config-templates/solution-plays.json` | Static catalog: 16 plays with TDP refs, trigger technologies, value props |
| `src/lib/customer-solution-context.ts` | Cross-reference engine: 4 output arrays, 5-min TTL result cache |
| `src/modules/solution-intelligence-module.ts` | Registered module: emits solution-play, marketplace, version-correlation signals |
| `src/modules/tech-stack-module.ts` | Enhanced: adds solutionPlayId/Name/Tdp/valueProps to tech signals |
| `src/lib/signal-templates.ts` | Strategic Opportunities section with 3 sub-sections |
| `scripts/scrape-saleshub.ts` | SalesHub scraper (Mac Mini L4 daemon) |
| `scripts/sync-saleshub-drive.ts` | Syncs scraped data to Drive L4 folder |

### Cross-reference matrix (Phase 1-3)

| Cross-reference | Reads | Produces |
|---|---|---|
| Tech × Solution plays | tech-stack cache + solution-plays.json | `activeSolutionPlays[]` |
| Cloud spend × Programs | CCSP cache + cloud-marketplace cache + subscriptions | `marketplaceOpportunities[]` |
| Cases × Lifecycle | rh-cases cache + product-lifecycle.json | `versionCorrelations[]` |
| Pipeline × Tech stack | pipeline cache + tech-stack cache + catalog | `crossSellSignals[]` |

### Constraints

- No Gemini calls — pure deterministic computation
- No new data dependencies — reads existing caches only
- Registry scores unchanged — ADR-027 scoring applies automatically
- Consumers unchanged — new signals route through existing templateAll()
