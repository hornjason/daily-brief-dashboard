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

## What IS Worth Flagging

These are genuine concerns where security/quality recommendations are appropriate:

- **Formula injection in Google Sheets writes** — `sanitizeCell()` applied to all Sheets writes before `valueInputOption: 'RAW'` (fixed 2026-03-29)
- **Error messages leaking internal paths in API responses** — generic messages to client at 5 routes (RH login, SF login, Tableau, file check, folder connect), detail logged server-side (fully fixed 2026-03-31 — 2026-03-29 fix was incomplete)
- **driveFolderId format validation** — `/^[a-zA-Z0-9_-]{10,}$/` in `ccsp-scraper.ts` and `supportable-scraper.ts` (fixed 2026-03-29)
- **Territory string validation** — `/^[A-Z0-9_]+$/` before Playwright selectors in `ccsp-scraper.ts` (fixed 2026-03-29)
- **Cache file permissions** — `mode: 0o600` on all cache writes (fixed 2026-03-29)
- **Silent catch blocks** — 9 previously-silent write catches now log `console.warn` (fixed 2026-03-29)
- **Race conditions on async AE updates** — `patchAe()` used instead of `aes.map()` after `await` in bootstrap steps (fixed 2026-03-29)

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
| `src/rh-auth.ts` | Red Hat Portal SSO login browser management |
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

## Agent Briefing Checklist

Before spawning any specialist agent (Rook, Marcus, Quinn, etc.) on this codebase:

- [ ] Share this file or the relevant section
- [ ] Confirm the agent knows: single-user, single-container, localhost-only
- [ ] For security reviews: share Section 1 (shared context) and Section 2 (no auth) explicitly
- [ ] For any "why don't you use X" recommendation: check if it's covered in this doc first
