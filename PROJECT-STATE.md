# DailyBriefDashboard — Project State

**This is the authoritative snapshot of what exists right now.**
Read this before asking any "does X exist?" question. Update it after every deployment.

Last updated: 2026-04-10 (session — BKL-RH-PERF-01, BACKUP-01, PVIEW-09/10/11, UX55/60/61/62/63 closed; alias fallback fix; 106 customers, discovery in progress; intelligenceEnabled=false)

---

## Frontend Pages

| URL | Component | Status | Notes |
|-----|-----------|--------|-------|
| `/dashboard` | App.tsx fallback | ✅ Working | Main portfolio: KPIs, pipeline, cloud spend, calendar, accounts grid, Morning Summary |
| `/dashboard/customer/:name` | CustomerDetailPage | ✅ Working | Brief, account intelligence, account plan, cases, subscriptions, emails, meetings |
| `/dashboard/products` | ProductsPage | ✅ Working | Product intelligence hub: feature radar, release notes, customer Q&A |
| `/dashboard/products/:slug` | ProductDetailPage | ✅ Working | Single product: features, releases, Q&A chat |
| `/dashboard/setup` | SetupPage | ✅ Working | AE setup wizard + 6-step bootstrap orchestrator |
| `/dashboard/admin` | AdminPage | ✅ Working | See Admin Page section below |

**SPA catch-all:** Unknown routes fall through to the main dashboard (no 404 page).

---

## Admin Page — What's Built

**Route:** `/dashboard/admin` → `AdminPage` component

| Panel | What it does |
|-------|-------------|
| Session Health | RH Portal + SF session status, expiry alerts, manual VNC open |
| Scraper Controls | RH cases, CCSP, SF pipeline: last run, last error, circuit breaker state, "Run Now" button |
| Scheduler Config | Edit 4 timer windows (HH:MM ET), enable/disable toggles, last-run display |
| Account Intelligence Pipeline | 3-step progress across all customers, "Generate All" trigger, error list |
| Gemini Usage | Daily + monthly tokens, cost USD, breakdown by call type |
| Product Sources | 7-product corpus status, cache timestamps, "Refresh" per product |

**Missing from Admin (backlog):**
- Backup / Restore controls (planned — BKL-BACKUP-01)
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

### Product Intelligence
- `GET /api/products` — All 7 products + cache status
- `GET /api/products/:slug` — Product detail + feature cache
- `POST /api/products/:slug/refresh` — On-demand refresh
- `GET /api/products/alerts` — Change detection flags

### Scraping
- `POST /api/scrape/supportable` — Full scrape (requires aeName + customers) — not used in bootstrap
- `POST /api/scrape/supportable/discover` — Discover account numbers (aeName optional — omit for all AEs)
- `GET /api/scrape/supportable/status` — Running state, statusMessage, lastRun
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
- `GET /api/bootstrap/auto/status` — Bootstrap progress

### Admin & Ops
- `POST /api/admin/restore` — Rebuild customers + cache from GSheets (BKL-RESTORE-01 ✅)
- `GET /api/admin/gemini-usage` — Gemini cost tracking
- `GET /api/status/telemetry` — Scraper event summary
- `GET /api/settings/refresh` / `PUT` — Refresh interval config
- `GET /api/settings/scheduler` / `POST` — Scheduler timer config
- `GET /api/health-scores` — Per-customer confidence scores
- `GET /health` — Container health probe

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
| `aes.json` | AEs: name, folder IDs, sheet IDs, territories | ❌ No automated backup | Reconstruct from bootstrap |
| `customers.json` | Customers: name, ae, accountNumbers, aliases, ccspCustomer flag | ⚠️ `POST /api/admin/restore` rebuilds from GSheets | 1-2h via restore endpoint |
| `data-sources.json` | Parent folder IDs, refresh intervals, scheduler times | ❌ No | Re-enter via Setup Wizard |
| `settings.json` | `podBookingsFolderId` — shared Drive folder containing NW/SW SF bookings sheets | ❌ No | Re-enter folder ID (1 field) |
| `product-intel-config.json` | 7-product metadata: slugs, Drive folders, URLs | ❌ No | Re-enter via Admin page |
| `product-alerts.json` | Change detection flags per product | ❌ No | Regenerated on next refresh |
| `.google-token.json` | Google OAuth (Drive, Sheets, Gmail, Calendar) | ❌ No — **preserve on resets** | Re-authenticate (5 min) |
| `.rh-session.json` | RH Portal session cookie | ❌ No | Re-login via Admin page |
| `.sf-session.json` | SF session flag | ❌ No | Re-login via Admin page |

**Planned (BKL-BACKUP-01):** Config backup sheet created at POD Bootstrap; auto-syncs aes.json + customers.json + data-sources.json + product-intel-config.json on every save. Admin page Backup/Restore buttons.

---

## SF Bookings Architecture (as of 2026-04-08)

**Source of truth for customer subscriptions:** SF bookings Google Sheets in shared Drive folder.
**Supportable scraper is NOT used in bootstrap.** Only RH cases scraper runs for account number discovery.

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

## Current Data State (2026-04-10)

- **AEs:** 9 (SW POD only — NW pod was removed during SW wipe/re-bootstrap 2026-04-10)
  - **SW POD (9):** TBH, Peter Niklaus, Oren Shaolian, Sherry Gayo, Amanda Mejia, Alex Smith, Beena Patel, O'Neil Hopson, Cameron Floyd
  - **NW POD:** Not currently configured (NW AEs were in aes.json through commit 389c2b8; removed when SW was re-bootstrapped)
- **Customers:** 105 SW customers (fresh bootstrap 2026-04-10)
  - 60 customers with RH Portal account numbers discovered
  - 66 RH support cases cached (2 sev1, 10 sev2)
  - 47 cases found via name-search during discovery
- **SF bookings sheets:** SW pipeline sheets per AE (individual sheets per AE, not a shared pod sheet)
- **Territory sheet:** `1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8` (in data-sources.json)
- **SF pipeline report:** `00OPe00000k5m9ZMAQ` (SW report)
- **Account intelligence:** Not yet run post-bootstrap (queued)

---

## Open Backlog (Quick Reference)

### Critical / P0
- **BKL-TEST-03** 🔴 — Full Playwright suite wipes production data; workaround: ban `npx playwright test`; fix: dedicated test server

### High / P1
- **BKL-RESTORE-02** 🔴 — Restore endpoint doesn't populate aliases, blocking RH discovery post-restore
- **BKL-RH-PERF-02** ⏸ — BLOCKED 1 week pending failure audit data from PR1

### Medium / P2
- **BKL-WIZ-01** 🟡 — Bootstrap wizard Drive folder preview missing (Marcus in progress)
- **BKL-WIZ-02** 🟡 — POD Bootstrap no cancel button (Marcus in progress)
- **BKL-PVIEW-08** 🟡 — Morning brief collapse: show bullet outline (Marcus in progress)
- **BKL-DRIVE-01** 🔴 — Drive folder hierarchy missing POD layer
- **BKL-DOCS-01** 🔴 — Stale runbook references Supportable instead of RH scraper
- **BKL-TEST-07** 🔴 — QA test runs leave artifact data in dashboard

### Closed this session (2026-04-10)
- **BKL-RH-PERF-01** ✅ — Negative cache + smart waits + persistSessionState fix
- **BKL-BACKUP-01** ✅ — Config backup sheet auto-syncs on every save
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
