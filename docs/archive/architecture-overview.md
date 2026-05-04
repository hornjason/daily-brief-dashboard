---
Last validated: 2026-04-24
---

> **Note:** The root `ARCHITECTURE.md` is the authoritative deep-dive reference (intentional design decisions, scraper internals, edge cases). This file provides a concise overview suitable for onboarding.

# DailyBriefDashboard — Architecture Overview

## Overview

A personal operations dashboard for Account Solution Architects managing a Red Hat territory. Aggregates data from Salesforce, Red Hat Portal, Google Drive, Gmail, and Google Calendar into a single view per customer. Runs as a single container.

---

## Node Roles

| `NODE_ROLE` env var | Role | What runs | What it does |
|---|---|---|---|
| unset | **Hero install (L3-only)** | Full app server + dashboard (`bun server.ts`) | Reads CCSP + Pipeline CSVs from shared Drive folder. No scrapers. No browser. RH Cases via Bearer token only. |
| `primary` | **Mac Mini sync daemon** | `scripts/sync-l3-daemon.ts` (long-running, no server) | Holds warm Playwright browser context. SSO keepalive every 2h. Scrapes Tableau (CCSP) + SF (Pipeline) for all pods at 5:30am ET. Writes L3 CSVs to `podBookingsFolderId`. Sends email summary. **No server. No GUI. No AEs.** |

**Role-as-entrypoint:** the container CMD declares the role. Hero → `bun server.ts`. Primary → `bun scripts/sync-l3-daemon.ts`. `NODE_ROLE=primary` is retained as a defense-in-depth guard inside per-scraper functions only, not as the primary control flow. This prevents any future code path from accidentally running L4 scrapes on a hero install regardless of how the scheduler is structured.

**Why long-running (not ephemeral cron):** RH SSO session cookies (Tableau + SF Lightning) expire in 4–10h idle. An ephemeral container running once daily would arrive to an expired session with no offline-refresh path. The daemon holds the browser context warm between runs via a 2h keepalive ping. Chromium profile persists in the `data-sync/` volume across restarts.

**Sync daemon** (`scripts/sync-l3-daemon.ts`) runs two internal timers. Timer 1: SSO keepalive every 2h visits Tableau + SF report URLs to prevent cookie expiry. Timer 2: daily sync at 5:30am ET calls `scripts/sync-pod-l3.ts` logic — iterates `settings.json regions → pods`, checks pod readiness, runs `scrapePodCcspRaw` + `runSfPodSync`, writes `sync-status.json` to Drive, sends summary email. No host crontab — the daemon IS the cron. Full spec: `docs/HERO-INSTALL.md § L3 Sync Daemon`.

Hero install wizard hides L4-only sections via `isL3Only` flag (`NODE_ROLE !== 'primary'`). Full wizard design: `docs/HERO-INSTALL.md`.

---

## Runtime

| Component | Technology |
|---|---|
| Server | Bun + Hono (TypeScript) |
| Frontend | React 18 + Vite + Tailwind CSS |
| Container | Podman / Docker (Containerfile) |
| Browser automation | Playwright (Chromium, headless + headed) |
| CI/CD | GitHub Actions → GHCR |

The dashboard is pre-built at container image build time (`dashboard/` → `dist/`). The Bun server serves the static files and all API routes from a single process on port 7777.

---

## Data Sources

### 1. Google (OAuth)
Authenticated via a single OAuth token covering Drive, Sheets (read/write), Gmail, and Calendar.

- **Subscription sheets** (`src/sheets.ts`) — Per-customer subscription data sourced from SF Bookings sheets (see §SF Bookings below)
- **CCSP spend sheets** (`src/sheets.ts`) — Cloud spend data from AE-managed Google Drive folders
- **Pipeline sheet** (`src/pipeline.ts`) — A Google Sheet with a `Pipeline` tab written by the SF scraper; read via Sheets API

### 2. Salesforce Pipeline (`src/sf-scraper.ts`, `src/sf-auth.ts`)
Playwright scrapes a Salesforce Lightning report directly from the DOM. REST API is blocked for SAML SSO sessions.

**Key scraping decisions:**
- Viewport set to 20,000px height to force all rows into the DOM (SF uses IntersectionObserver-based virtual rendering — default viewport captures ~125 rows; full height captures all ~148)
- Headers extracted from `th[scope="col"]` inside `iframe[src*="lightningReportApp"]`; "Column Actions" button text stripped
- Smart header dedup: SF renders two header rows (fixed + sticky-scroll); only halves the array if second half mirrors first half exactly
- Group/separator rows filtered out (fewer than 5 non-empty cells)
- Row counter cell (col A) stripped via `.slice(1)` on every data row
- Output written to a fixed `Pipeline` tab in the configured Google Sheet (`PIPELINE_FILE_ID`); clears `A1:AZ10000` before each write to remove stale columns

**Auth:** SF login uses the same Chromium profile as the Red Hat Portal. SSO cookies cover both domains. After RH login completes, `adoptSfContext()` shares the browser context with the SF scraper — no separate SF login needed if RH is authenticated.

**Schedule:** Syncs daily at 2am ET via a `setTimeout` reschedule loop (container-safe; no system cron). SF report generates at 1am ET.

### 3. Red Hat Cases (`src/case-client.ts`, `src/rh-cases-api.ts`, `src/rh-scraper.ts`)
Support cases are fetched via one of two transports, selected by `RH_CASES_TRANSPORT` env var:

- **Bearer (default):** `BearerCaseClient` in `case-client.ts` calls `fetchCasesViaSolr()` — POST to `access.redhat.com/hydra/rest/search/v2/cases` using a short-lived JWT from `REDHAT_OFFLINE_TOKEN`. No browser, no Playwright, no VNC. Works on hero installs. Stale-overwrite guard: if Bearer returns 0 cases, the existing cache is preserved rather than wiped.
- **Browser (emergency fallback):** Set `RH_CASES_TRANSPORT=browser` in `.env` and restart (no rebuild). Playwright scrapes `access.redhat.com/support/cases` via a persistent Chromium profile (`RH_PROFILE_DIR`). Requires an active SSO session; session expiry triggers a UI notification.

Scrape interval: configurable (default 4 hours). Cases cached at `data/cache/cases.json`.

### 4. Red Hat Subscription API (`src/redhat.ts`)
Direct API calls to `api.access.redhat.com` using an offline token (`REDHAT_OFFLINE_TOKEN`) for subscription and case data. Also provides `getToken()` used by the Bearer cases path.

### 5. Gmail + Calendar + AI Brief (`src/customer.ts`, `src/google.ts`)
Google OAuth token used to fetch recent customer emails and upcoming calendar events for the daily brief. Filtered to customer domain/name to exclude internal Red Hat noise.

**AI Brief:** Generated on-demand per customer via **Gemini on Vertex AI** (`gemini-2.5-flash` by default). Auth uses a service account key (`GEMINI_SERVICE_ACCOUNT_KEY`) — no separate API key or LLM provider selection. Result cached daily per customer in `data/cache/{customer}-{date}.json`.

---

## Pipeline Data Flow

```
Salesforce Lightning Report (DOM)
        ↓  Playwright scraper (sf-scraper.ts)
Google Sheet — "Pipeline" tab
        ↓  Sheets API read (pipeline.ts → fetchPipelineData)
pipeline-data.json  (data/cache/)
        ↓  buildPipelineSummary()
GET /api/pipeline  →  PipelineSection.tsx
```

**Field normalization in `parsePipelineRows`:**
- ACV: strips currency prefix and commas (`"USD 1,050,000.00"` → `1050000`)
- Renewal: handles `"1"`, `"true"`, `"yes"`, and SF checkbox strings (`"feature included"` → `true`, `"feature not included"` → `false`)
- Opportunity ID: preserved as `oppId` for direct SF deep-link generation in the UI

---

## Scheduling

| Data source | Schedule | Mechanism |
|---|---|---|
| Pipeline (SF → Sheet → cache) | Daily 2am ET | `setTimeout` reschedule loop |
| RH Portal scrape | Every 4h (configurable) | `setInterval` via `rescheduleRefreshTimers` |
| Subscription sheets | Every 4h (configurable) | `setInterval` via `rescheduleRefreshTimers` |
| CCSP spend | Daily (configurable) | `setInterval` via `rescheduleRefreshTimers` |
| Daily brief (AI summary) | On-demand per customer | Request-time generation + daily cache |

RH scrape, subscriptions, and CCSP intervals are user-configurable via Settings → Auto-Refresh Intervals. Pipeline is intentionally fixed (not configurable) because it depends on the SF report generation schedule.

---

## Auth Flows

### Google OAuth
1. User visits `/oauth/start` → redirected to Google consent screen
2. Callback at `/oauth/callback` → token stored at `GOOGLE_UNIFIED_TOKEN_PATH`
3. Single token covers Drive, Sheets (read + write), Gmail, Calendar, Cloud Platform

### Red Hat SSO
1. User clicks "Connect Red Hat Portal" in Setup wizard
2. `startLoginBrowser()` opens a headed Chromium window pointing to `access.redhat.com`
3. User completes SSO login in the browser window
4. Server polls `access.redhat.com/support/cases` until it returns cases (login detected)
5. Session persisted in `.rh-session.json`; Chromium profile saved to `RH_PROFILE_DIR`
6. On success, `adoptScrapeContext()` + `adoptSfContext()` share the browser context

### Salesforce (SAML SSO)
- Shares the RH Chromium profile — SSO cookies cover `*.force.com`
- If SF session expires independently, `SfSessionExpiredError` is thrown and surfaced in the UI
- Manual re-trigger available via POST `/api/auth/salesforce/sync`

---

## File Layout

```
/
├── server.ts                  — Hono API server (all routes)
├── Containerfile              — Container image definition
├── Makefile                   — Container operations (build/push/run)
├── src/
│   ├── pipeline.ts            — Pipeline fetch, parse, summary builder
│   ├── sf-scraper.ts          — Playwright SF report scraper + Sheet writer
│   ├── sf-auth.ts             — SF login browser + session management
│   ├── rh-scraper.ts          — Playwright RH portal case scraper
│   ├── rh-auth.ts             — RH login browser + session management
│   ├── rh-account-discovery.ts— Discover customer account numbers via RH Portal sidebar autocomplete
│   ├── rh-scraper-extract.ts  — DOM extraction helpers for RH scraper
│   ├── sheets.ts              — Google Sheets fetch (subscriptions, CCSP)
│   ├── customer.ts            — Customer brief generation (email, calendar, AI)
│   ├── redhat.ts              — Red Hat API client (cases, subscriptions)
│   ├── google.ts              — Google OAuth + Drive/Sheets/Gmail/Calendar clients
│   ├── drive-watcher.ts       — Drive change detection for cache invalidation
│   ├── domains.ts             — Customer domain inference
│   └── types.ts               — Shared server-side types
├── dashboard/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── SetupPage.tsx         — Setup wizard (Google, RH, SF, folders)
│   │   │   └── CustomerDetailPage.tsx — Per-customer view
│   │   └── components/
│   │       ├── PipelineSection.tsx   — Pipeline opps + opp detail drawer
│   │       ├── SupportCasesTable.tsx — Open RH cases
│   │       ├── CloudSpendSection.tsx — CCSP spend
│   │       ├── RefreshTimerSettings.tsx — Configurable refresh intervals
│   │       └── ...
│   └── dist/                  — Built at image build time, served by Bun
├── data/                      — Mounted volume (persists outside container)
│   ├── config/
│   │   ├── customers.json     — Customer list with account numbers, folder IDs
│   │   ├── .rh-session.json   — RH portal session token
│   │   ├── .sf-session.json   — SF session state
│   │   ├── .gdrive-server-credentials.json
│   │   └── .rh-chrome-profile/ — Persistent Chromium profile (SSO cookies)
│   └── cache/
│       ├── pipeline-data.json
│       ├── cases.json
│       ├── ccsp-data.json
│       └── {customer}-{date}.json  — Daily brief cache per customer
└── .github/workflows/ci.yml  — Test → build → push to GHCR on main
```

---

## Setup Wizard & Bootstrap Flow

This section documents the verified end-to-end flow from initial setup through ongoing scheduled operation. All details sourced from `server.ts` and `src/bootstrap-orchestrator.ts` (not inferred).

---

### Step 1 — One-Time Auth Setup

**Red Hat Portal Login**
- User clicks "Connect Red Hat Portal" in the Setup wizard
- Server calls `startLoginBrowser()` — opens a headed Chromium window at `access.redhat.com`
- User completes SSO login manually in that window
- Server polls `access.redhat.com/support/cases` until it detects a successful session
- Session persisted to `.rh-session.json`; Chromium profile (with SSO cookies) saved to `RH_PROFILE_DIR`
- On success, `adoptScrapeContext()` + `adoptSfContext()` share the browser context with all scrapers

**Google OAuth**
- User visits `/oauth/start` → redirected to Google consent screen
- Callback at `/oauth/callback` stores token at `GOOGLE_UNIFIED_TOKEN_PATH`
- Single token covers: Drive (read/write), Sheets (read/write), Gmail (read), Calendar (read), Cloud Platform (Vertex AI)

**Salesforce**
- No separate login — Salesforce SSO cookies are already present in the shared RH Chromium profile
- `adoptSfContext()` points the SF scraper at the same browser context

---

### Step 2 — Setup Wizard (Per AE)

1. **Select POD + Territory from dropdowns** — e.g. "Northwest" + "Terr01"
   - Server reads the territory Google Sheet live (`1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8`) via `/api/territory-names` and `/api/territory-lookup`
   - `podPrefixFromTabTitle()` maps the sheet tab name to a territory prefix
   - AE name and sanitized customer list populated automatically from the sheet
2. **Review/edit customer list** — user can add, rename, or delete entries; edits are reflected before bootstrap runs
3. **Add Google Drive parent folder URL** — inline validation via "Validate" button (Drive API lookup; green checkmark + folder name shown on success)
4. **Add Salesforce report ID** — the per-AE pipeline report only; NOT used for customer or account discovery
5. **Click "Setup AE"** — writes to `data/config/aes.json` and immediately triggers Auto-Bootstrap

---

### Step 3 — Auto-Bootstrap (6 Steps, Runs Automatically)

`POST /api/bootstrap/auto` returns `{started: true}` immediately. The 6-step sequence runs async; client polls `GET /api/bootstrap/auto/status` for progress.

**Step 1 — Create Drive Folder**
- Server calls Drive API to create `/ <Parent Folder> / <AE Name> /`
- Subfolder ID saved to AE config in `aes.json`
- Idempotent: reuses existing folder if re-bootstrapping

**Step 2 — Create Customer Folders**
- Creates `{Customer Name}/` subfolder for each customer under the AE folder
- Uses `normalizeCustomerName()` to strip legal suffixes (Inc, LLC, Corp), state codes, parentheticals
- Stores `driveFolderId` on each `Customer` entry in `customers.json`
- Idempotent: existing folder IDs reused on re-runs

**Step 3 — Read SF Bookings Sheet**
- Reads the POD SF Bookings sheet from the shared Drive folder (`podBookingsFolderId` in `settings.json`)
- Sheet matched to AE's territory by file name (word-level matching against `tableauTerritories`)
- Derives customer list with subscription data and aliases
- Account numbers are discovered later by the RH Cases scraper (searches RH Portal by customer alias)
- Saves customers and aliases to `data/config/customers.json`

**Step 4 — Write Subscriptions Sheet**
- Subscription rows from SF Bookings written to the AE's Google Sheet
- One tab per customer
- Clears existing tab content before writing each set of rows

**Step 5 — Create CCSP Sheet**
- Creates a CCSP cloud spend sheet in the AE's Drive folder
- Stores `ccspSheetId` in `aes.json`

**Step 6 — Sync Pipeline Sheet**
- Creates/updates the Pipeline Google Sheet using the AE's Salesforce report
- Stores `pipelineSheetId` in `aes.json`
- Populates local pipeline cache (`data/cache/pipeline-data.json`)

> **Note on account discovery:** Supportable 360 is disabled. Account numbers are discovered by the RH Cases scraper, which searches the RH Portal sidebar autocomplete using the customer's canonical alias (from SF Bookings). This happens asynchronously after bootstrap — not during bootstrap itself.

---

### Step 4 — Ongoing Scheduled Refreshes

| Data | Schedule | Trigger |
|---|---|---|
| Subscriptions (SF Bookings sheets) | Every 240 min (configurable) | `setInterval` via `rescheduleRefreshTimers` |
| CCSP cloud spend | Every 1440 min (configurable) | `setInterval` via `rescheduleRefreshTimers` |
| Salesforce pipeline | Daily 2am ET | `setTimeout` reschedule loop |
| RH Portal open cases | Every 4h (configurable) | `setInterval` via `rescheduleRefreshTimers` |
| Daily brief (AI summary) | On-demand per customer | Request-time generation + daily cache |

---

### Data Flow Summary

```
Territory Google Sheet
  (live read via Sheets API)
        ↓
  AE name + customer list
        ↓
  Setup Wizard review
        ↓
  "Setup AE" → aes.json
        ↓
  Auto-Bootstrap (6 steps)
    │
    ├─ Step 1: Drive API → create AE subfolder
    ├─ Step 2: Drive API → create per-customer subfolders
    ├─ Step 3: SF Bookings sheet → customer names + subscriptions
    ├─ Step 4: Sheets API → write subscriptions to Google Sheet
    ├─ Step 5: Create CCSP sheet
    └─ Step 6: SF Playwright → pipeline rows → pipelineSheetId

  Post-bootstrap (async):
    RH Cases scraper → account discovery via RH Portal sidebar autocomplete

Dashboard reads:
  data/cache/*.json  ←  scheduled refreshes  ←  SF Bookings / SF / RH Portal / Sheets
```

---

### Known Gaps & Caveats

| Issue | Status |
|---|---|
| Customer name in territory sheet vs SF Bookings name | SF Bookings alias column provides canonical name; RH Portal discovery uses aliases |
| Bootstrap `completedAt` set on first run even if steps fail | Cosmetic — data flows correctly; status polling shows step-level state |
| SF REST API | Blocked for SAML SSO sessions — Playwright DOM scraping required |
| Supportable 360 | Disabled — do not use; account discovery uses RH Portal, subscriptions use SF Bookings |

---

## Container

The container image is built and pushed two ways:

| Path | When | Target |
|---|---|---|
| `make rebuild` | Local dev | `ghcr.io/hornjason/daily-brief-dashboard:latest` |
| GitHub Actions `ci.yml` | Every push to `main` (after tests pass) | `ghcr.io/hornjason/asacommandcenter:latest` + SHA tag |

The `data/` directory is mounted as a volume so config, credentials, cache, and the Chromium profile survive container restarts and rebuilds.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `AE_PARENT_FOLDER_ID` | Google Drive root folder(s) for auto-discovery of pipeline/subscription sheets |
| `PIPELINE_FILE_ID` | Google Sheet ID where SF scraper writes the `Pipeline` tab |
| `SF_REPORT_ID` | Salesforce report ID to scrape |
| `REDHAT_OFFLINE_TOKEN` | Red Hat API offline token |
| `GOOGLE_CLOUD_PROJECT` | GCP project for Vertex AI (Gemini brief generation) |
| `GOOGLE_CLOUD_LOCATION` | Vertex AI region (default `us-central1`) |
| `GEMINI_SERVICE_ACCOUNT_KEY` | Base64-encoded service account JSON for Vertex AI |
| `GEMINI_MODEL` | Gemini model override (default `gemini-2.5-flash`) |
| `GITHUB_TOKEN` | GHCR push credentials |
| `CONFIG_DIR` | Path to config inside container (default `/data/config`) |
| `CACHE_DIR` | Path to cache inside container (default `/data/cache`) |
| `RH_PROFILE_DIR` | Path to Chromium profile (default `$CONFIG_DIR/.rh-chrome-profile`) |

---

## SF Bookings Sheet — Required Report Columns

The SF bookings reader (`src/sf-bookings-reader.ts`) requires these exact column names in the exported Google Sheet. The sheet must be placed in the shared POD bookings Drive folder (`podBookingsFolderId` in `settings.json`).

| Column | Required | Purpose |
|--------|----------|---------|
| `ACCOUNT_NAME` | ✅ | Customer matching — most specific (billing entity) |
| `ACCOUNT_SALES_GROUP_NAME` | ✅ | Customer matching — fallback (sales entity) |
| `ACCOUNT_GLOBAL_SALES_GROUP_NAME` | ✅ | Customer matching — fallback (holding company) |
| `OPPORTUNITY_TERRITORY_NAME` | ✅ | Filters rows to the AE's assigned territory |
| `PRODUCT_DESCRIPTION` | ✅ | Subscription/product name |
| `PRODUCT_QUANTITY` | ✅ | Quantity |
| `OPPORTUNITY_LINE_START_DATE` | ✅ | Subscription start date |
| `OPPORTUNITY_LINE_END_DATE` | ✅ | Subscription end date (used to derive Active/Expired) |
| `PRODUCT_FORECAST_OFFERING_GROUP` | ✅ | Product group — "CCSP" in value = CCSP-only customer |
| `PRODUCT_CODE` | ✅ | Internal SKU |

### Adding a New POD

1. Export the SF subscription report filtered to that POD's territories
2. Upload the resulting sheet to the shared Drive folder (`podBookingsFolderId`)
3. Name the file to include the territory name (e.g. "Northeast" for NORTHEAST territory)
4. The bootstrap wizard and SF sync will auto-discover it — no code or config changes needed

### How Territory Matching Works

Sheet file names are matched against AE `tableauTerritories` using word-level matching.
Example: territory `"WESTCOM NORTHWEST"` → words `["westcom", "northwest"]` → matches file named `"Northwest POD - Subscriptions"` because `"northwest"` appears in the file name.

Name the file after the key territory word for reliable matching.
