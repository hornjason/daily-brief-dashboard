*Last validated: 2026-04-11 | Owner: DA | Trigger: New flows added, existing flows change*

# DailyBriefDashboard — End-to-End Flow Reference

A narrative walkthrough of every major flow in the app. Companion to `ARCHITECTURE.md` (which explains *why*) — this document explains *what happens, step by step*.

---

## Table of Contents

1. [First-Time Setup (Bootstrap)](#1-first-time-setup-bootstrap)
2. [RH Portal Session — Login, Keep-Alive, Expiry](#2-rh-portal-session)
3. [Supportable Sync — Full Discover + Scrape](#3-supportable-sync)
4. [RH Cases Scrape](#4-rh-cases-scrape)
5. [CCSP / Tableau Scrape](#5-ccsp--tableau-scrape)
6. [Salesforce Pipeline Sync](#6-salesforce-pipeline-sync)
7. [Gmail — Customer Email Pull](#7-gmail--customer-email-pull)
8. [Google Calendar — Meetings](#8-google-calendar--meetings)
9. [Dashboard Load (SSE + Cache)](#9-dashboard-load)
10. [Customer Detail Page](#10-customer-detail-page)
11. [Background Refresh Timers](#11-background-refresh-timers)
12. [Session Expiry & Reconnect](#12-session-expiry--reconnect)
13. [Data Flow Summary](#13-data-flow-summary)

---

## 1. First-Time Setup (Bootstrap)

**Trigger:** New AE added via the Setup page wizard.

**Pre-conditions:** Google OAuth active, RH Portal connected, Salesforce connected, VPN on.

### Step 1 — Territory lookup
1. User opens Setup page → "Add AE" wizard
2. User selects POD (e.g. `WEST_COMM_CORP_NORTHWEST`) from dropdown
3. Frontend calls `GET /api/territory-names?pod=WEST_COMM_CORP_NORTHWEST`
4. Server reads the Red Hat-owned **territory Google Sheet** (`TERRITORY_SHEET_ID`)
5. Returns list of territories + AE names for that POD
6. User selects territory number → AE name + customer list auto-populate from the sheet
7. User enters parent Drive folder URL and Salesforce report ID
8. User clicks "Set Up AE" → calls `POST /api/bootstrap/auto`

### Step 2 — Drive folder creation
- Creates `{Parent Folder}/{AE Name}/` in Google Drive
- Stores `driveFolderId` in `aes.json`

### Step 3 — Customer folders
- For each customer: creates `{AE Folder}/{Customer Name}/` subfolder in Drive
- Stores each customer's `driveFolderId` in `customers.json`

### Step 4 — Supportable discovery + scrape
- Opens Supportable 360 in the shared browser context
- For each customer: name-searches APEX (`buildNameCandidates()` progressive word-stripping fallback)
- Finds account numbers → writes to `customers.json` incrementally
- For each found account: enters account number in APEX, exports CSV, parses active rows
- Writes all rows to a new **Supportable Google Sheet** (`Supportable — {AE Name}`)
- Stores `supportableSheetId` in `aes.json`

### Step 5 — CCSP sheet
- Opens Tableau CCSP dashboard in the shared browser context
- Applies territory + POD filter to get only this AE's customers
- Exports data → writes to a new **CCSP Google Sheet** (`{AE Name} CCSP`)
- Stores `ccspSheetId` in `aes.json`

### Step 6 — Pipeline sheet
- Opens Salesforce report by ID in the shared browser context
- Scrapes opportunity rows → writes to a new **Pipeline Google Sheet** (`{AE Name} Pipeline`)
- Stores `pipelineSheetId` in `aes.json`

### Post-bootstrap
- All three sheet IDs now live in `aes.json`
- `customers.json` has account numbers for all customers
- Local `data/cache/` is NOT populated yet — cache fills on next dashboard load / manual refresh
- Bootstrap does NOT auto-trigger the background refresh timers

---

## 2. RH Portal Session

### Login
1. User clicks "Connect Red Hat Portal" on Setup page
2. Frontend calls `POST /api/auth/redhat/start`
3. Server calls `rh-auth.ts` → opens Chromium via `launchPersistentContext` (VNC visible at `localhost:6080`)
4. Browser navigates to RH Portal SSO URL
5. If 92+ cookies exist in profile: login completes instantly (existing session valid) — VNC window appears to close immediately. **This is normal** (BKL-S12).
6. If fresh login needed: SSO form appears in VNC — user completes login manually
7. On success: `rh-auth.ts` calls `adoptRhContext()` → shared `BrowserContext` is set
8. All four scrapers receive the shared context: `adoptSupportableContext()`, `adoptCcspContext()`, `adoptSfContext()`
9. Frontend polls `GET /api/auth/redhat/status` every 2s until `hasSession: true`
10. Session cookies written to `data/rh-profile/Default/` (persist across container restarts)

### Keep-Alive
- A timer fires every 8 minutes in `rh-scraper.ts`
- Navigates a background page to a lightweight RH Portal URL to keep the SSO session alive
- If the navigation fails: session is marked expired, `setSessionExpiredCallback` fires

### Session Expiry
- Keep-alive callback fires → checks mutex flags for all three scrapers
- If any scraper is running: defers context close (scraper fails naturally on next page op)
- If system is idle: `closeScrapeContext()` closes the shared browser context
- Dashboard shows "RH session expired" banner
- User must re-click "Connect Red Hat Portal" to restore session

---

## 3. Supportable Sync

**Trigger:** User clicks "Sync Now" on Setup page (Supportable Subscriptions section), or `POST /api/scrape/supportable/discover` called directly.

**Always uses the discover path** — name-search runs every sync to validate and refresh account numbers.

### Phase 1 — Discovery (serial, one customer at a time)
1. Pre-warm: navigate to Supportable URL, wait for APEX search input
2. Confirm session active (no SSO redirect) — if redirect: wait up to 5 min for user to complete VNC login
3. For each customer (in order):
   - `_onStatus("Discovering: {Customer} (N/total)…")` — visible in Setup page spinner
   - Navigate to Supportable search URL
   - Call `buildNameCandidates()` — generates progressive word-stripped search terms:
     - `supportableName` override if set, else derived from customer name
     - Tries full name → removes last word → repeats until 1 word remains
     - Example: `"Intrado Life & Safety"` → `"Intrado Life &"` → `"Intrado Life"` → `"Intrado"`
   - For each candidate: fills `#P0_CUSTOMER_NAME`, submits, waits for results
   - If match found: extracts account numbers from results table, stops trying candidates
   - Account numbers written to `customers.json` immediately (crash-safe incremental save)
   - **Stale-overwrite guard**: if 0 accounts found and customer already has account numbers, keep existing

### Phase 2 — Scrape (parallel up to PARALLEL_PAGES limit = 1)
1. Build flat job queue: one job per account number across all customers
2. `_onStatus("Scraping {Customer} (N/total)…")`
3. For each account number:
   - Open new page in shared browser context
   - Navigate to Supportable, fill `#P0_ACCOUNT_NUMBER`, click Go
   - Wait for Export link — handle two APEX render modes:
     - **Normal mode**: one Export anchor → click it
     - **Inline panel mode** (e.g. REI, Shutterfly): two Export anchors → always click last one
   - Navigate to page 22 (SalesReport), select "Sales Export Format", download CSV
   - Parse CSV: keep rows where `Status = "Active"` only
4. Aggregate rows per customer, call progress callback with account numbers + row count

### Phase 3 — Sheet write
1. Reuse existing `supportableSheetId` from `aes.json` (404 fallback: recreate if deleted)
2. Write **Accounts tab** — one row per customer with account numbers + row counts
3. Write **one tab per customer** — all active subscription rows
4. Log: `wrote N rows → "Customer Name"`
5. **Stale-overwrite guard**: if all customers returned 0 rows but existing sheet has data → skip write

### Multi-AE sequencing
- Sync button loops through all AEs
- After calling `/discover` for AE 1: polls status every 4s until `running: false`
- Then starts AE 2 — prevents 409 mutex collision

### Optional single-customer debug mode
```bash
POST /api/scrape/supportable/discover
{"aeName": "Elmer Alvarez", "customer": "Intrado Corporation"}
```
Runs discovery + scrape for one customer only — useful for targeted testing.

---

## 4. RH Cases Scrape

**Trigger:** Automatic timer (default: every 240 min) or `POST /api/scrape/rh`.

1. `rh-scraper.ts` uses the shared browser context (already logged in)
2. For each account number across all AEs' customers (~33 accounts):
   - Navigate to RH Portal support cases URL for that account
   - Wait for table to load
   - Scrape case rows: case number, summary, severity, status, last updated
   - Filter: keep only Open/Waiting cases (not Closed)
   - **Column detection**: tries header-match first, fallback to fixed column indices
3. Aggregate all cases into `data/cache/rh-cases.json`
4. Cache update triggers SSE push to any connected dashboard clients

---

## 5. CCSP / Tableau Scrape

**Trigger:** Bootstrap (Step 5) or `POST /api/bootstrap/ccsp` (manual re-scrape).

1. `ccsp-scraper.ts` uses the shared browser context
2. Navigates to Tableau CCSP dashboard URL
3. Applies territory filter — sets POD and Subregion from the AE's territory string
   - Territory format: `REGION_SEG_TYPE_POD_TERR##`
   - POD = everything except the last segment
4. Waits for Tableau iframe to render filtered data
5. Exports data: iterates customer rows, extracts cloud consumption spend per customer
6. Writes to **CCSP Google Sheet** (`{AE Name} CCSP`)
7. Stores/reuses `ccspSheetId` in `aes.json`
8. Background `refreshCCSP()` timer (default: 1440 min / 24h) then reads this sheet into `data/cache/ccsp-data.json`

---

## 6. Salesforce Pipeline Sync

**Trigger:** On Salesforce login completion, manual `POST /api/scrape/sf`, or daily pipeline refresh at 6am ET.

### Scrape (writes to sheet)
1. `sf-scraper.ts` uses the shared browser context (Salesforce SAML auto-login)
2. Navigates to SF report URL (`sfReportId` from `aes.json`)
3. Waits for report table to render
4. Scrapes opportunity rows: account name, opp name, close date, ACV, stage, opp number
5. Writes to **Pipeline Google Sheet** (`{AE Name} Pipeline`)

### Dedup (multiple AEs sharing same SF report)
- `fetchPipelineData()` in `src/pipeline.ts` reads all `pipelineSheetId`s for all AEs
- Deduplicates by `oppNumber` (fallback: `accountName|oppName|closeDate` composite key)
- Without dedup: two AEs with the same `sfReportId` produce doubled opportunity counts

### Cache refresh
- `refreshPipeline()` runs daily at 6am ET (hardcoded, not configurable)
- Reads Pipeline sheet → writes `data/cache/pipeline-data.json`
- Dashboard reads from cache only

---

## 7. Gmail — Customer Email Pull

**Trigger:** Dashboard load SSE, or `GET /api/emails` called by frontend.

1. `src/google.ts` uses the unified Google OAuth token
2. Calls Gmail API: `users.messages.list` with date filter (last N days)
3. Fetches message metadata (subject, sender, date, thread ID)
4. Filters by customer domain: keeps only emails where sender/recipient domain matches a known customer domain from `customers.json`
5. Strips `@redhat.com` internal emails — only external customer emails surfaced
6. Returns threaded email summaries per customer
7. Displayed in Customer Detail page under "Recent Emails"

---

## 8. Google Calendar — Meetings

**Trigger:** Dashboard load SSE, or `GET /api/calendar` called by frontend.

1. `src/google.ts` calls Calendar API: `events.list` for the AE's primary calendar
2. Fetches events in a rolling window (today ± N days)
3. For each event: extracts attendees, checks if any attendee email domain matches a known customer
4. **Customer matching**: company part of attendee email domain vs normalized customer name
   - `attendee@a10networks.com` → `a10networks` → matches "A10 Networks"
5. Organizer check: if organized by the AE (by display name or email first-name match) → tagged as AE-organized
6. Events with `ev.customers.length > 0` are surfaced — internal-only meetings filtered out
7. KPI stat cards (meetings count) use this same filtered set — matches CalendarStrip display

---

## 9. Dashboard Load

**Trigger:** User opens `http://localhost:7777/dashboard`.

1. React app initializes, opens SSE connection to `GET /api/sse`
2. Server pushes initial state: all cached data for all AEs
   - `GET /api/aes` → AE list + config
   - `GET /api/customers` → customer list with account numbers
   - `GET /api/kpis` → aggregated KPI counts (cases, meetings, pipeline ACV, etc.)
   - Subscription data from `data/cache/sheet-cache-*.json`
   - CCSP data from `data/cache/ccsp-data.json`
   - Pipeline data from `data/cache/pipeline-data.json`
3. Dashboard renders KPI cards, CalendarStrip, customer portfolio grid
4. All data reads from local JSON cache — no live API calls on load
5. SSE connection stays open; server pushes updates when background timers refresh cache

---

## 10. Customer Detail Page

**Trigger:** User clicks a customer card on the dashboard.

1. Navigate to `/dashboard/customer/{customerName}`
2. SSE connection scoped to that customer: `GET /api/customer/{name}/sse`
3. Server pushes per-customer data bundle:
   - **Cases**: filtered from `rh-cases.json` for this customer's account numbers
   - **Subscriptions**: read from `data/cache/sheet-cache-{aeSheetId}.json`, tab matching by customer name
   - **CCSP spend**: read from `data/cache/ccsp-data.json`, matched by customer name
   - **Pipeline**: read from `data/cache/pipeline-data.json`, matched by account name
   - **Meetings**: filtered from Calendar API, matched by customer domain
   - **Emails**: filtered from Gmail, matched by customer domain
   - **Account brief**: AI-generated summary (cached in `data/cache/brief-{customer}.json`)
4. Header renders two-row layout:
   - Row 1: breadcrumb nav, sync status
   - Row 2 left: health dot, customer name, `AccountCountPill` (account numbers popover), segment badge
   - Row 2 right: `StatBadge` cards (cases, subscriptions, licenses), next meeting, AE name

---

## 11. Background Refresh Timers

All timers run inside the single Bun process. Configured in `data/config/data-sources.json`.

| Timer | Default | What it does |
|---|---|---|
| RH cases scrape | 240 min | `runRhScrape()` → scrapes RH Portal → updates `rh-cases.json` |
| Subscriptions refresh | 240 min | `refreshSubscriptions()` → reads Supportable sheets → updates cache |
| CCSP refresh | 1440 min (24h) | `refreshCCSP()` → reads CCSP sheets → updates cache |
| Pipeline sync | Daily 6am ET | `refreshPipeline()` → reads Pipeline sheets → updates cache |

**Change intervals live** (no restart needed):
```bash
curl -X POST http://localhost:7777/api/settings/refresh \
  -H "Content-Type: application/json" \
  -d '{"subscriptions": 120, "ccsp": 720, "rhScrape": 120}'
```

**Stale-overwrite guard on all refresh paths:** if fetch returns 0 records but cache has data → keep existing cache. Protects against Google Sheets quota failures silently wiping good data.

---

## 12. Session Expiry & Reconnect

### What expires
- **RH Portal SSO** — 8-min keep-alive; if keep-alive fails, session expires
- **Salesforce** — long-lived session, but can expire after inactivity
- **Google OAuth** — token auto-refreshes; rarely expires

### RH Portal reconnect
1. Dashboard shows "RH session expired" banner
2. User clicks "Reconnect" on Setup page
3. Same flow as initial login (§2) — browser opens in VNC
4. On success: shared context re-adopted by all scrapers
5. If 92+ cookies exist: instant reconnect (no VNC interaction needed)
6. To force fresh login: `podman exec pai-dashboard rm -f /data/rh-profile/Default/Cookies`

### Salesforce reconnect
1. User clicks "Connect Salesforce" on Setup page
2. SAML auto-click flow (§9) — typically completes in seconds without VNC interaction

### VNC unavailable (x11vnc died)
Restart x11vnc without a rebuild:
```bash
podman exec -d pai-dashboard bash -c \
  "DISPLAY=:99 exec x11vnc -display :99 -nopw -localhost -rfbport 5900 -forever -quiet 2>/dev/null"
```
Note: `-d` flag required so the process survives shell exit.

---

## 13. Data Flow Summary

```
┌─────────────────────────────────────────────────────────────┐
│  SOURCE SYSTEMS                                              │
│  Red Hat Portal · Supportable 360 · Salesforce · Tableau    │
│  Gmail · Google Calendar · Territory Sheet (Red Hat)        │
└────────────────────────┬────────────────────────────────────┘
                         │ Stage 1: Playwright scrapers
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  GOOGLE SHEETS (persistent, human-readable)                 │
│  Supportable — {AE} · {AE} CCSP · {AE} Pipeline            │
└────────────────────────┬────────────────────────────────────┘
                         │ Stage 2: Sheets API refresh timers
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  LOCAL CACHE  data/cache/                                   │
│  sheet-cache-*.json · ccsp-data.json · pipeline-data.json   │
│  rh-cases.json · brief-*.json                               │
└────────────────────────┬────────────────────────────────────┘
                         │ /api/* endpoints (cache reads only)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  DASHBOARD  React + Vite                                    │
│  KPI Cards · CalendarStrip · Customer Portfolio             │
│  Customer Detail · Setup Page                               │
└─────────────────────────────────────────────────────────────┘

CONFIG LAYER  data/config/
  aes.json ──────── AE names, territories, Drive/sheet IDs
  customers.json ── customer names, account numbers
  (written at bootstrap, mutated by scrapes and setup wizard)
```

---

*Last updated: 2026-04-01. Companion docs: `ARCHITECTURE.md` (design decisions), `CLAUDE.md` (rules + deploy), `BACKLOG.md` (open work).*
