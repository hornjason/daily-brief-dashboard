---
doc-type: reference
status: active
owner: jason
updated: 2026-05-17
---

# DailyBriefDashboard — Project State
*Last validated: 2026-05-13 | Owner: DA | Trigger: Review and update on any structural change to this doc*

**This is the authoritative snapshot of what exists right now.**
Read this before asking any "does X exist?" question. Update it after every deployment.

Last updated: 2026-05-18 — Quality gate (ADR-024) + meeting prep enrichment (ADR-025, #290). Four enrichment tables injected after Gemini sections 4-7: Product Alignment with confidence + proof points, Summit announcements, enhanced lifecycle with key changes + customer angle, RSS/blog intelligence with real URLs. Hybrid inline pattern: Gemini narrative + deterministic reference data.

---

## Frontend Pages

| URL | Component | Status | Notes |
|-----|-----------|--------|-------|
| `/dashboard` | App.tsx fallback | ✅ Working | Main portfolio: KPIs, pipeline, cloud spend, calendar, accounts grid, Morning Summary |
| `/dashboard/customer/:name` | CustomerDetailPage | ✅ Working | Brief, account intelligence, account plan, cases, subscriptions, emails, meetings |
| `/dashboard/products` | ProductsPage | ✅ Working | Product intelligence hub: feature radar, release notes, customer Q&A. Refresh All button scrapes all products + re-extracts features. Content quality gate rejects error pages before caching. |
| `/dashboard/products/:slug` | ProductDetailPage | ✅ Working | Single product: features, releases, Q&A chat |
| `/dashboard/setup` | SetupPage | ✅ Working | AE setup wizard + 6-step bootstrap orchestrator (1058 lines; AEsCustomersSection extracted to setup/AEsCustomersSection.tsx) |
| `/dashboard/admin` | AdminPage | ✅ Working | See Admin Page section below |
| `/dashboard/batch` | BatchPage | ✅ Working | Batch operations: multi-customer campaigns, news refresh, PitchBuilder/FinListics checklists |
| `/dashboard/rh-news` | RedHatNewsPage | ✅ Working | Full Red Hat RSS news feed: blog, press releases, developer blog. Product tag filtering. Linked from Pulse card "View All". |
| `/dashboard/meeting-prep` | MeetingPrepPage | ✅ Working | Meeting prep with mandatory context panel, HTML Google Docs output, Red Hat brand formatting. Calendar view with customer filter toggle. |
| `/dashboard/home` | HomePage | ✅ Working | Feature-first navigation hub |
| `/dashboard/accounts` | AccountsPage | ✅ Working | Account listing with module page shell |
| `/dashboard/calendar` | CalendarPage | ✅ Working | Calendar strip view |
| `/dashboard/campaigns` | CampaignsPage | ✅ Working | Campaign management |
| `/dashboard/events` | EventsPage | ✅ Working | Red Hat events with region filtering |
| `/dashboard/news` | NewsPage | ✅ Working | News aggregation from RSS feeds |
| `/dashboard/tools` | ToolsPage | ✅ Working | Utility tools |
| `/dashboard/book-of-business` | BookOfBusinessPage | ✅ Working | Book of business overview |

**SPA catch-all:** Unknown routes fall through to the main dashboard (no 404 page).

---

## Admin Page — What's Built

**Route:** `/dashboard/admin` → `AdminPage` component

| Panel | What it does |
|-------|-------------|
| Session Health | RH Portal + SF session status, expiry alerts, manual VNC open |
| Scraper Controls | RH cases, CCSP, SF pipeline: last run, last error, circuit breaker state, "Run Now" button. **Supportable: DISABLED** (SUPPORTABLE_DISABLED=true in scrape-api.ts) — use `POST /api/scrape/rh` for discovery |
| Scheduler Config | Edit 4 timer windows (HH:MM ET), enable/disable toggles, last-run display |
| Account Intelligence Pipeline | 3-step progress across all customers, "Generate All" trigger, error list |
| Gemini Usage | Daily + monthly tokens, cost USD, breakdown by call type |
| Product Sources | 7-product corpus status, cache timestamps, "Refresh" per product |

**Missing from Admin (backlog):**
- Backup / Restore controls (BKL-BACKUP-01 backend done — backup-config.ts + backup-routes.ts; Admin UI not yet wired)
- Test server trigger

---

## API Endpoint Groups

### Core Data
- `GET /api/aes` — AE list
- `GET /api/config` — Full AE + customer config
- `GET /api/accounts` — Customers with health scores + subscriptions
- `GET /api/kpis` — Portfolio KPIs
- `GET /api/kpis/history` — 90-day KPI sparklines
- `GET /api/cases/all` — All support cases
- `GET /api/ccsp` — Cloud spend (filterable by AE + products)
- `GET /api/pipeline` — SF pipeline summary
- `GET /api/morning-summary` — Top 3 priority signals
- `GET /api/pod/summary` — POD-level aggregates
- `GET /api/calendar` — Week view events

### Customer Intelligence
- `GET /api/customer/:name` — Full customer data
- `GET /api/customer/:name/brief` — AI brief (4h cache)
- `GET /api/customer/:name/intelligence` — Account intelligence
- `POST /api/customer/:name/intelligence/generate` — Manual trigger
- `GET /api/customer/:name/account-plan` — Account plan markdown
- `POST /api/customer/:name/account-plan/generate` — Trigger generation
- `GET /api/customer/:name/team` — Resolved account team (AE, ASA, SSP/SSA specialists)

### Account Team & Territory
- `POST /api/admin/territory-sync` — Manual territory sync trigger (populates team cache)
- Contract: `getAccountTeam(customer)` in `src/account-team.ts` — see ARCHITECTURE.md §20

### Campaigns
- `POST /api/customer/:name/campaigns/generate` — Generate campaign (Gemini Pro, pre-flight intelligence, 11 council rules)
- `GET /api/customer/:name/campaigns` — Campaign history list
- `GET /api/customer/:name/campaigns/:id/preview` — Render campaign HTML in browser
- `DELETE /api/customer/:name/campaigns/:id` — Remove campaign from cache
- `POST /api/campaigns/extract-material` — Gemini material decomposition (cached by URL hash)
- `DELETE /api/campaigns/extract-material?url=` — Clear extraction cache

### AE Voice
- `GET /api/ae/:name/style-guide` — Cached AE voice profile
- `POST /api/ae/:name/style-guide/detect` — Detect voice from AE emails

### News Radar
- `GET /api/customer/:name/news` — Cached news articles
- `POST /api/customer/:name/news/refresh` — Trigger fresh news search
- `GET /api/news/highlights` — High-significance stories for morning brief

### Tools & Artifacts
- `POST /api/customer/:name/tools/upload` — Upload file to Drive intelligence folder
- `GET /api/customer/:name/tools/artifacts` — List uploaded artifacts

### Feature Modules
- `GET /api/modules/status` — Registry status for all modules
- `POST /api/customer/:name/modules/:moduleName/sync` — Trigger module sync

### Batch Operations
- `POST /api/batch/execute` — Batch campaigns/news with SSE progress streaming

### Product Intelligence
- `GET /api/products` — All 7 products + cache status
- `GET /api/products/:slug` — Product detail + feature cache
- `POST /api/products/:slug/refresh` — On-demand refresh
- `GET /api/products/alerts` — Change detection flags

### Scraping
- `POST /api/scrape/supportable` — **DISABLED** (SUPPORTABLE_DISABLED=true in scrape-api.ts) — use `POST /api/scrape/rh` for discovery
- `POST /api/scrape/supportable/discover` — **DISABLED** (SUPPORTABLE_DISABLED=true in scrape-api.ts) — use `POST /api/scrape/rh` for discovery
- `GET /api/scrape/supportable/status` — Running state, statusMessage, lastRun (still returns status; scraper itself disabled)
- `POST /api/scrape/rh` — RH cases scrape
- `POST /api/scrape/salesforce` — SF pipeline scrape
- `POST /api/scrape/ccsp` — CCSP scrape
- `POST /api/scrape/all` — Queue all scrapers
- `GET /api/scraper-status` — All scraper states
- `POST /api/scrape/sf-bookings-sync` — Sync SF bookings sheets → AE subscription sheets (auto-discovers sheets from Drive folder)
- `GET /api/sf-bookings/pod-sheets` — List available POD sheets from shared Drive folder (used by bootstrap wizard dropdown)

### Setup & Bootstrap
- `POST /api/aes` — Create new AE
- `POST /api/aes/validate-folder` — Validate Drive folder before setup
- `POST /api/bootstrap/start` — Auto-bootstrap AE (SSE stream)
- `POST /api/bootstrap/auto` — Auto-bootstrap AE (accepts optional `podName` field — creates POD subfolder layer in Drive hierarchy)
- `POST /api/bootstrap/auto/cancel` — Gracefully cancel a running single-AE bootstrap (sets cancellation flag, stops after current step)
- `GET /api/bootstrap/auto/status` — Bootstrap progress

### Ingest Telemetry
- `GET /api/ingest/events` — Long-lived SSE stream; emits `event: connected` on connect, `event: cache-level` per tier hit during waterfall (ae, flow, level 1–4, rowCount, timestamp). Fire-and-forget in waterfall path. See docs/DATA-INGESTION-FLOW.md#sse-cache-level-telemetry.

### Admin & Ops
- `POST /api/admin/restore` — Rebuild customers + cache from GSheets (BKL-RESTORE-01 ✅)
- `GET /api/admin/gemini-usage` — Gemini cost tracking
- `GET /api/status/telemetry` — Scraper event summary
- `GET /api/settings/refresh` / `PUT` — Refresh interval config
- `GET /api/settings/scheduler` / `POST` — Scheduler timer config
- `GET /api/health-scores` — Per-customer confidence scores
- `GET /health` — Container health probe
- `GET /api/settings/from-drive` — Read Config/settings.json from Drive for a region
- `POST /api/config/backup` — Push local settings.json to Drive Config/settings.json (BKL-DRIVE-BACKUP-API-01 ✅)
- `POST /api/config/restore` — Pull Drive Config/settings.json and apply locally (BKL-DRIVE-BACKUP-API-01 ✅)

### Auth
- `GET /api/auth/redhat/status` — RH session state
- `POST /api/auth/redhat/start` — RH login (headed browser)
- `POST /api/auth/salesforce/start` — SF login
- `GET /api/auth/salesforce/status` — SF session state

### Test Isolation (production-safe only)
- `POST /api/__test/snapshot` — Snapshot in-memory AEs + customers (reads memory, not disk)
- `POST /api/__test/restore` — Restore from last snapshot

---

## Config Files

| File | Contents | Backed up? | If lost |
|------|----------|------------|---------|
| `aes.json` | AEs: name, folder IDs, sheet IDs, territories | ✅ `make backup-config` + Drive auto-sync | `make restore-config FILE=...` or reconstruct from bootstrap |
| `customers.json` | Customers: name, ae, accountNumbers, aliases, ccspCustomer flag | ⚠️ `POST /api/admin/restore` rebuilds from GSheets | 1-2h via restore endpoint |
| `data-sources.json` | Parent folder IDs, refresh intervals, scheduler times | ✅ `make backup-config` + Drive auto-sync | `make restore-config` or re-enter via Setup Wizard |
| `settings.json` | `podBookingsFolderId` — shared Drive folder containing NW/SW SF bookings sheets | ✅ `make backup-config` | `make restore-config` or re-enter folder ID (1 field) |
| `product-intel-config.json` | 7-product metadata: slugs, Drive folders, URLs | ✅ `make backup-config` | `make restore-config` or re-enter via Admin page |
| `product-alerts.json` | Change detection flags per product | ❌ No | Regenerated on next refresh |
| `.google-token.json` | Google OAuth (Drive, Sheets, Gmail, Calendar) | ❌ No — **preserve on resets** | Re-authenticate (5 min) |
| `.rh-session.json` | RH Portal session cookie | ❌ No | Re-login via Admin page |
| `.sf-session.json` | SF session flag | ❌ No | Re-login via Admin page |

**Implemented (BKL-BACKUP-01):** Config backup sheet created at POD Bootstrap; auto-syncs aes.json + customers.json + data-sources.json + product-intel-config.json on every save (backup-config.ts + backup-routes.ts). Admin page Backup/Restore buttons still pending.

---

## SF Bookings Architecture (as of 2026-04-08)

**Source of truth for customer subscriptions:** SF bookings Google Sheets in shared Drive folder.
**Supportable scraper is DISABLED** (SUPPORTABLE_DISABLED=true in scrape-api.ts). Use `POST /api/scrape/rh` for account number discovery.

### How it works
1. Shared Drive folder (`podBookingsFolderId` in `settings.json`) contains one sheet per POD
2. Sheet names include the territory keyword (e.g. "Northwest POD - Subscriptions")
3. Bootstrap and SF sync auto-discover sheets from the folder — **no sheet IDs stored anywhere**
4. Territory matching is word-level: "WESTCOM NORTHWEST" matches "Northwest POD - Subscriptions"
5. New POD = drop sheet in folder + name it with the territory word = auto-discovered

### Bootstrap step 3 behavior
- POD sheet found in Drive folder → reads SF sheet, derives customers by territory, writes subscription sheet
- No sheet found → step skipped with message; CCSP + pipeline steps continue normally

### Required SF report columns
See `docs/ARCHITECTURE.md` → "SF Bookings Sheet — Required Report Columns"

---

## Current Data State (2026-05-12)

**AEs:** 2 (Carolanne Farrell — Northwest Corp, Elmer Alvarez)
**Customers:** 23 (11 Carolanne, 12 Elmer)
**Pipeline:** $7.96M / 47 opps across both AEs
**CCSP:** $3.43M / 28 accounts (rolling 4-quarter display)
**Cases:** 2 open (1 Sev2 A10 Networks, 1 other)
**Products:** 29 unique, 2,243 licenses, 13 renewals within 90 days

**ADR-018 (2026-05-12):** Binary customer lifecycle — customers are active or gone, no `inactive` flag. AE removal deletes customers from customers.json, archives Drive folder IDs to `archived-customers.json`, purges all cache files. Global safety-net filter in `server-state.ts` prevents stale data leaks.

**ADR-019 (2026-05-12):** L3 refresh reads daily CSVs directly from Drive (SF-PIPELINE-*, CCSP-*) instead of static Google Sheet IDs. Self-healing discovery — always grabs most recent CSV by modifiedTime. Subscription sheet remains static.

**Multi-Region Architecture (3 regions, 9 pods configured):**

- **West Commercial** (4 pods — all active, L3 sync operational):
  - `WEST_COMM_CORP_NORTHWEST` — Northwest Corp
  - `WEST_COMM_CORP_SOUTHWEST` — Southwest Corp
  - `WEST_COMM_CORP_NORTH_CENTRAL` — North Central Corp
  - `WEST_COMM_CORP_SOUTH_CENTRAL` — South Central Corp

- **East Commercial** (4 pods configured):
  - `EAST_COMM_CORP_POD01` — Rough Riders
  - `EAST_COMM_CORP_POD02` — No sfReportId (skipped in L3 sync)
  - `EAST_COMM_CORP_POD03` — No sfReportId (skipped in L3 sync)
  - `EAST_COMM_CORP_POD05` — No sfReportId (skipped in L3 sync)

- **Central Enterprise TOLA** (1 pod — active, L3 sync operational):
  - `CENTRAL_ENT_TOLA` — TOLA POD

**L3 Sync:** Daily via sync-l3-daemon.ts. Drive folder: `14I0UH1CiSNNOqVHdZVS7tHOPibJMN5Oo`

---

## Testing Strategy

**Docs:** `docs/BKL-TEST-STRATEGY.md` (strategy, rationale), `docs/TESTING-RUNBOOK.md` (how to run tests safely)

**Production guards (BKL-TEST-11 + this session):**
- `POST /api/setup/reset` — blocks if >5 customers without `ALLOW_RESET=true`
- `POST /api/setup/save-customers` — blocks if >5 customers without `ALLOW_RESET=true`
- `POST /api/__test/restore` — blocks if no snapshot + >5 customers without `ALLOW_RESET=true`

**Test container (2026-04-10):**
- Container: `pai-dashboard-test`, port `7776`, data dir: `data-test/`, `ALLOW_RESET=true`
- Seed data: `scripts/seed-data/` (2 AEs, 5 fake customers with account numbers 990000x)
- `make seed` — reset `data-test/` from seed fixtures
- `make test-up` / `make test-down` — start/stop test container

**Unit tests (2026-04-10):** `test/unit/` — 27 pure-function tests covering slug, sanitize, account-numbers, setup-validation. Run: `bun test test/unit/`

**CI gate (2026-04-10):** `make lint` runs `scripts/check-empty-catches.sh` — fails build if any `.catch(() => {})` exists in `dashboard/src/`

**Open items:** BKL-TEST-12 (endpoint allowlist), BKL-TEST-18 (delta guard), BKL-TEST-19 (fixture detection), BKL-TEST-20 (setup.spec.ts wrapper), BKL-TEST-21 (complete unit coverage), BKL-TEST-22 (@destructive tag routing)

---

## Open Backlog (Quick Reference)

### On Hold
- **BKL-BOOT-03** ⏸ — On hold (1 open item remaining; all other backlog cleared or obsolete)

### Closed (2026-05-02)
- **BKL-ARCH-10** ✅ — AE management routes extracted to src/ae-routes.ts (322 lines); GitHub #21
- **BKL-ARCH-11** ✅ — Settings/config routes consolidated into src/settings-api.ts createSettingsRouter(); GitHub #22
- **BKL-ARCH-12** ✅ — Admin/monitoring/drive routes extracted to src/admin-routes.ts (127 lines); GitHub #24
- **server.ts now 1,061 lines** (down from 1,712 at session start today — −651 lines via ARCH-09 + ARCH-10 + ARCH-11 + ARCH-12)

### Closed / Obsolete (2026-04-10)
- **BKL-TEST-03** ✅ — Full Playwright suite wipes production data; workaround in place
- **BKL-RESTORE-02** ✅ — Restore endpoint alias population fixed
- **BKL-RH-PERF-02** ⏸ — Obsolete (blocked pending data that never materialized)
- **BKL-WIZ-01** ✅ — Bootstrap wizard Drive folder preview
- **BKL-WIZ-02** ✅ — POD Bootstrap cancel button (POST /api/bootstrap/auto/cancel)
- **BKL-PVIEW-08** ✅ — Morning brief collapse: bullet outline
- **BKL-DRIVE-01** ✅ — Drive folder hierarchy POD layer (podName field in POST /api/bootstrap/auto)
- **BKL-DOCS-01** ✅ — Runbook updated for RH scraper
- **BKL-TEST-07** ✅ — QA test artifact cleanup
- **BKL-RH-PERF-01** ✅ — Negative cache + smart waits + persistSessionState fix
- **BKL-BACKUP-01** ✅ — Config backup sheet auto-syncs on every save (backup-config.ts + backup-routes.ts)
- **BKL-PVIEW-07** ✅ — Merged ASA/Product views (via BKL-UX58)
- **BKL-PVIEW-09** ✅ — KPI tile counts filter by product chip
- **BKL-PVIEW-10** ✅ — Cases modal filters by product chip
- **BKL-PVIEW-11** ✅ — Renewals modal filters by product chip
- **BKL-PVIEW-12** ✅ — Pipeline section filters by product chip (via BKL-UX57)
- **BKL-UX55** ✅ — Cases show customer names
- **BKL-UX60** ✅ — RH Portal button opens VNC; status reflects scraper state
- **BKL-UX61** ✅ — Tableau shows Connected when CCSP data present
- **BKL-UX62** ✅ — Sync Now timestamp refreshes immediately after scrape
- **BKL-UX63** ✅ — Segment label on account cards (no data yet)

---

## Update Protocol

Update this file at the end of any session where:
- A new page or endpoint is added
- A backlog item changes status
- Config file list changes
- Current data state changes significantly

**Before asking "does X exist?" — read this file first.**
