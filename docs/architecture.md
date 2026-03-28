# ASA Command Center — Architecture

## Overview

A personal operations dashboard for Account Solution Architects managing a Red Hat territory. Aggregates data from Salesforce, Red Hat Portal, Google Drive, Gmail, and Google Calendar into a single view per customer. Runs as a single container.

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

- **Subscription sheets** (`src/sheets.ts`) — Supportable-format Google Sheets per customer; product subscription data
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

### 3. Red Hat Portal (`src/rh-scraper.ts`, `src/rh-auth.ts`)
Playwright scrapes `access.redhat.com/support/cases` for open support cases. Requires an active SSO session maintained in a persistent Chromium profile (`RH_PROFILE_DIR`).

- Session stored in `.rh-session.json`; scrape context initialized on startup if session exists
- Scrape interval: configurable (default 4 hours)
- Session expiry detected via `SessionExpiredError`; triggers UI notification to re-authenticate

### 4. Red Hat Subscription API (`src/redhat.ts`)
Direct API calls to `api.access.redhat.com` using an offline token (`REDHAT_OFFLINE_TOKEN`) for subscription and case data that doesn't require browser auth.

### 5. Gmail + Calendar (`src/customer.ts`, `src/google.ts`)
Google OAuth token used to fetch recent customer emails and upcoming calendar events for the daily brief. Filtered to customer domain/name to exclude internal Red Hat noise.

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
│   ├── rh-account-discovery.ts— Discover customer account numbers from sheets
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
| `AE_PARENT_FOLDER_ID` | Google Drive root folder(s) for auto-discovery of pipeline/supportable sheets |
| `PIPELINE_FILE_ID` | Google Sheet ID where SF scraper writes the `Pipeline` tab |
| `SF_REPORT_ID` | Salesforce report ID to scrape |
| `REDHAT_OFFLINE_TOKEN` | Red Hat API offline token |
| `LLM_PROVIDER` | AI brief provider (`gemini`, `anthropic`, `openai`, `ollama`, `pai`) |
| `GOOGLE_CLOUD_PROJECT` | GCP project for Vertex AI / Gemini |
| `GEMINI_SERVICE_ACCOUNT_KEY` | Base64-encoded service account JSON for Vertex AI |
| `GITHUB_TOKEN` | GHCR push credentials |
| `CONFIG_DIR` | Path to config inside container (default `/data/config`) |
| `CACHE_DIR` | Path to cache inside container (default `/data/cache`) |
| `RH_PROFILE_DIR` | Path to Chromium profile (default `$CONFIG_DIR/.rh-chrome-profile`) |
