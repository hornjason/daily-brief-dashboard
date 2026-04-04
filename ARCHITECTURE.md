# DailyBriefDashboard — Architecture Reference

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

### 4. Config Written Back to Disk During Runtime

**Pattern:** `aes.json` and `customers.json` are read at startup and written back during bootstrap, scrape, and setup wizard flows. The server mutates its own config files.

**Why it's intentional:** These are user-controlled config files, not application state. The setup wizard and bootstrap process are the UX for editing them. There is no database. Config IS the persistence layer.

**What looks wrong:** "App writes to its own config at runtime" sounds like a self-modifying application. It isn't — it's a config editor with a web UI.

**Key safety:** `saveAes()` uses atomic write (`.tmp` + `rename`) to prevent corruption. `patchAe()` re-reads from disk before merging to prevent async clobber races.

---

### 5. Container-Only Architecture

**Pattern:** No systemd, no launchd, no host cron jobs, no host-level tooling. Everything runs inside the `pai-dashboard` Podman container.

**Why it's intentional:** Reproducibility and isolation. The container has its own Playwright, Bun, and VNC server. The Makefile (`make rebuild`) is the single deploy mechanism.

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

---

### 7. OAuth Token Stored in a Single File

**Pattern:** One `google-token.json` covers all Google API scopes (Sheets, Drive, Gmail, Calendar). Two scope tiers: `NORMAL_SCOPES` (read-only operations) and `BOOTSTRAP_SCOPES` (Drive write, needed for sheet creation).

**Why it's intentional:** Single-user app. The token is for the AE's own Google account. Separate tokens per scope would require the user to re-auth multiple times.

**What looks wrong:** "Broad OAuth scope." The scope matches what the app actually does — it needs Drive write access to create spreadsheets in the AE's folder.

---

### 8. Bootstrap Drive Folder Structure

Auto-bootstrap creates the following hierarchy under the configured **parent** Drive folder:

```
📁 {Parent Folder}/                    ← provided by user in wizard (parentFolderId)
   └── 📁 {AE Name}/                  ← created in Step 1; ID stored as driveFolderId in aes.json
          ├── 📁 {Customer 1}/         ← created in Step 2; ID stored in customers.json
          ├── 📁 {Customer 2}/
          ├── ...
          ├── 📊 Supportable — {AE Name}   ← created in Step 4; ID stored as supportableSheetId
          ├── 📊 {AE Name} CCSP            ← created in Step 5; ID stored as ccspSheetId
          └── 📊 {AE Name} Pipeline        ← created in Step 6; ID stored as pipelineSheetId
```

**`driveFolderId` vs `parentFolderId`:**
- `parentFolderId` — entered in the wizard; where bootstrap creates the AE subfolder. Not stored.
- `driveFolderId` — the AE's own folder created by Step 1. Stored in `aes.json`. Used as the parent for all subsequent sheet and customer folder creation.

Customer folder names use `normalizeCustomerName()` — strips legal suffixes (Inc, LLC, Corp), state codes (`- CA`), parentheticals. Bootstrap is idempotent: existing folder IDs are reused from `aes.json`/`customers.json` on re-runs.

**Customer type has `driveFolderId?: string`** — stored on each `Customer` entry in `customers.json` after the folder is created in Step 2.

**Bootstrap does NOT populate local cache:** Steps 5 and 6 write CCSP and pipeline data directly to Google Sheets. The local JSON cache files in `data/cache/` are populated separately when the dashboard loads and triggers scrapes. `api/status/scrapes` sync timestamps ARE set during bootstrap.

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
| `src/rh-scraper.ts` | Red Hat Portal case scraper (Playwright) |
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

## §11. Data Refresh Architecture — Two-Stage Pipeline

There are two completely separate operations that are both loosely called "refresh." Understanding the distinction is critical to knowing what's stale and what's not.

### Stage 1 — Scrape: source system → Google Sheets

Scrapers go out to live external systems and write new data into Google Sheets. This is the only stage that generates new data.

| Scraper | Source | Writes to | Automatic timer? | Configurable? |
|---|---|---|---|---|
| RH cases | RH Portal (Playwright) | Local cases cache (`rh-cases.json`) | Yes — 15-min tick, runs when elapsed > `rhScrape` interval | Yes — `rhScrape` in data-sources.json (default: 240 min) |
| Supportable | Supportable 360 (Playwright, VPN) | Google Sheets per AE | **No** — bootstrap only | N/A |
| CCSP | Tableau (Playwright) | Google Sheets per AE | **No** — bootstrap only | N/A |
| SF pipeline | Salesforce report (Playwright) | Google Sheets per AE | **No** — manual trigger or on SF login | N/A |

**Gap:** Supportable and CCSP sheets are only populated once — during the initial bootstrap. They are never automatically re-scraped after that. The Google Sheet data ages indefinitely until bootstrap is re-run or a manual scrape is triggered via the bootstrap API endpoints (`POST /api/bootstrap/supportable`, `POST /api/bootstrap/ccsp`). This is a known limitation, not a bug — the scrapers require Playwright sessions that may require VPN or Tableau login, making fully automated re-scrape impractical without session management improvements.

### Stage 2 — Refresh: Google Sheets → local JSON cache

Refresh functions read from already-populated Google Sheets and update the local `data/cache/` JSON files. The dashboard reads from cache only — it never calls Google APIs directly.

| Function | Reads from | Writes to | Timer | Configurable? | Drive-change check? |
|---|---|---|---|---|---|
| `refreshSubscriptions()` | Supportable sheet (Sheets API) | `data/cache/sheet-cache-*.json` | Yes — interval timer | Yes — `subscriptions` in data-sources.json (default: 240 min) | Yes — skips if sheet unchanged |
| `refreshCCSP()` | CCSP sheet (Sheets API) | `data/cache/ccsp-data.json` | Yes — interval timer | Yes — `ccsp` in data-sources.json (default: 1440 min / 24h) | Yes — skips if sheet unchanged |
| `refreshPipeline()` | Pipeline sheet (Sheets API) | `data/cache/pipeline-data.json` | Yes — daily at 2am ET | **No** — hardcoded daily | Yes — skips if sheet unchanged |
| `refreshAll()` | Both subscriptions + CCSP | Both caches | On startup + `/api/refresh` | N/A | Via above functions |

`refreshAll()` is called on server startup (if customers exist) and via `POST /api/refresh`. It does **not** include pipeline.

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

## §15. Admin Page — Operational Panels (2026-04-04)

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

## Agent Briefing Checklist

Before spawning any specialist agent (Rook, Marcus, Quinn, etc.) on this codebase:

- [ ] Share this file or the relevant section
- [ ] Confirm the agent knows: single-user, single-container, localhost-only
- [ ] For security reviews: share Section 1 (shared context) and Section 2 (no auth) explicitly
- [ ] For any "why don't you use X" recommendation: check if it's covered in this doc first
