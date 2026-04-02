# Timer Reference

Complete verified inventory of all timers in DailyBriefDashboard. 33 timers across 16 source files.
Last verified: 2026-04-01 (Marcus Webb deep-read of all source files).

---

## Group 1 — Background Recurring (Server-Side)

These run continuously from server startup for the process lifetime.

| # | Name | File | Interval | Configurable |
|---|------|------|----------|-------------|
| 1 | Subscriptions Refresh | `background-scheduler.ts` | 4h default | Yes |
| 2 | CCSP Refresh | `background-scheduler.ts` | 24h default | Yes |
| 3 | RH Scraper Tick | `background-scheduler.ts` | 15min tick / 4h scrape cadence | Scrape cadence: yes |
| 4 | RH Keep-Alive | `rh-scraper.ts` | 8min | No |
| 5 | SF Keep-Alive | `sf-scraper.ts` | 60min | No |
| 6 | Drive Watcher Poll | `background-scheduler.ts` | 10min | No |

---

### 1. Subscriptions Refresh — 4h default

**Data flow:** Google Sheets API → per-customer file cache (`data/cache/<slug>-sheets.json`)

Reads all Supportable Google Sheets and writes updated subscription rows to local cache. Does NOT hit Supportable directly — the sheets must already have been written by a manual scrape from Setup. Uses `knownSheetIds` from `aes[].supportableSheetId` to skip Drive BFS and avoid quota burns.

**Skip conditions:**
- Checks Drive `modifiedTime` against oldest `cachedAt` in cache — skips entirely if source file unchanged
- Empty-result guard: if 0 rows returned but cache has data, keeps existing (quota failure protection)
- Skipped if `customers.length === 0`

**Configurable:** Yes — `POST /api/settings/refresh`. Calling `rescheduleRefreshTimers()` clears and recreates the interval.

---

### 2. CCSP Refresh — 24h default

**Data flow:** Google Sheets API → `data/cache/ccsp-data.json`

Same pattern as Subscriptions. Reads CCSP Google Sheets (written previously by Tableau scraper) into local cache.

**Skip conditions:** Same Drive change check + empty-result guard. Skipped if no customers.

**Configurable:** Yes — same `POST /api/settings/refresh`.

---

### 3. RH Scraper Tick — 15min tick, 4h scrape cadence

**⚠ This is NOT a simple 4-hour setInterval.** It is a 15-minute heartbeat that checks elapsed time since the last successful scrape. The actual scrape only fires when elapsed time ≥ configured interval (default 4h). This is a deliberate workaround for Bun's unreliable long-interval timer behavior (see `docs/adr/ADR-007.md`).

**Data flow:** Red Hat Portal (live Playwright scrape) → `data/cache/cases.json`

Each tick computes `Date.now() - lastScraped`. If elapsed ≥ configured interval, calls `runRhScrapeWithState()` which launches Playwright pages against `access.redhat.com/support/cases`, scrapes open cases per account number, and writes atomically (tmp+rename) to the cases cache.

**The 15-min tick cannot be cleared** — no handle is stored. It runs for the full process lifetime.

**Guards:** `_rhScrapeRunning` mutex (15min stale auto-release), session marker file must exist, account numbers must be populated.

**Configurable:** The scrape cadence (checked by each tick) is configurable via `POST /api/settings/refresh`. The 15-minute tick itself is hardcoded.

---

### 4. RH Portal Keep-Alive — 8min

**Data flow:** Pings `access.redhat.com` → writes cookies to `<profileDir>/session-state.json`

Keeps the RH Portal Playwright session alive. First attempt: evaluates `keycloak.updateToken(60)` in the live page + pings the accounts API with Bearer token. Fallback: full page navigation to cases list. On failure, fires `_onSessionExpired` callback (server.ts checks all three scraper mutexes before calling `closeScrapeContext()`).

**Two instantiation paths:** `initScrapeContext()` (startup from persisted session) and `adoptScrapeContext()` (after fresh login). Both clear any existing timer first — no double-timer.

**Guard:** `_livePageBusy` flag — skips tick if Tableau login is using the live page.

---

### 5. Salesforce Keep-Alive — 60min

**Data flow:** Navigates to `lightning.force.com/lightning/n/Home` → writes to `<profileDir>/sf-session-state.json`

Keeps the Salesforce Playwright session alive. Uses an ephemeral page — never touches the shared RH live page.

**Important:** `closeSfContext()` does NOT close the BrowserContext (it is owned by the RH scraper). Only clears the timer and nulls the reference.

---

### 6. Drive Watcher Poll — 10min

**Data flow:** Drive Changes API (delta pageToken) → deletes stale brief cache files

Polls Drive for file changes in AE customer folders. For each customer with changed files, deletes `data/cache/<slug>-<date>.json` so the next brief request regenerates from fresh data.

**No stored handle** — runs for full process lifetime.

**Dependencies:** `AE_PARENT_FOLDER_IDS` env var, `initDriveWatcher()` must have succeeded at startup.

---

## Group 2 — Scheduled Daily Events

| # | Name | File | Schedule | Configurable |
|---|------|------|----------|-------------|
| 7 | Pipeline 2am Sync | `background-scheduler.ts` | 2:00 AM ET daily | Yes |
| 31 | CCSP 6:30am Scrape | `background-scheduler.ts` | 6:30 AM ET daily | Yes |
| 32 | Supportable 7am Batch Rotation | `background-scheduler.ts` | 7:00 AM ET daily | Yes |
| 33 | Territory Sheet 1:45am Sync | `background-scheduler.ts` | 1:45 AM ET daily | Yes |

### 7. Pipeline Daily Sync — 2:00 AM ET

**Mechanism:** Self-rescheduling `setTimeout` chain — NOT a `setInterval`. Calculates ms until next 2am ET via `nextEt2amUtc()`, which handles EST/EDT transitions correctly using `Intl.DateTimeFormat`. After each run (success or error), reschedules itself for the next day.

**Data flow (BKL-M33 fixed):** If SF session active → `runSfSyncForAes()` (Salesforce Lightning → GSheet) then after 60s → `refreshPipeline()` (GSheet → `data/cache/pipeline-data.json`). If no SF session → skip source scrape, run `refreshPipeline()` only (cache refresh from existing GSheet) with a warning log.

SF generates the daily pipeline report at ~1am ET; the 2am target ensures it's ready before the scrape fires.

**Why not setInterval:** Avoids Bun long-interval unreliability. The reschedule pattern also correctly recalculates the target time after each run, so drift or container restarts don't cause missed days.

---

### 31. CCSP Daily Scrape — 6:30 AM ET

**Mechanism:** Self-rescheduling `setTimeout` chain — same pattern as Timer 7 (Pipeline). Calculates ms until next 6:30am ET via `nextEt630amUtc()`.

**Data flow:** Tableau (live Playwright scrape) → `data/cache/ccsp-data.json` + `data/cache/ccsp-delta.json`

Pre-flight probes Tableau base URL — if the session is dead (redirect to auth/signin), the scrape is skipped and rescheduled for the next day. After scraping, computes per-customer ACV delta by comparing pre- and post-scrape cache and writes it to `ccsp-delta.json`.

**Skip conditions:** No AEs configured, Tableau session dead, Tableau probe fails.

---

### 32. Supportable Daily Batch Rotation — 7:00 AM ET (ADR-008)

**Mechanism:** Self-rescheduling `setTimeout` chain. VPN probe with 15-min retry until 9am ET hard stop.

**Data flow:** Supportable APEX (live Playwright scrape) → Google Sheets

Batch rotation strategy (ADR-008): customers are split into 3 groups by modulo index. One group is scraped per day, rotating via `batchIndex` in `data/config/batch-state.json`. Every customer is refreshed within a 3-day window.

**Skip conditions:** No customers configured, VPN unreachable by 9am ET. Batch index always advances (even on error) to prevent stuck retries.

---

### 33. Territory Sheet 1:45 AM ET Sync

**Mechanism:** Self-rescheduling `setTimeout` chain. Calculates ms until next 1:45am ET via `nextEt145amUtc()`.

**Data flow:** Google Sheets (territory sheet) → `data/config/customers.json` + `data/cache/territory-notifications.json`

Compares territory Google Sheet accounts against current customers list. New accounts are auto-added to `customers.json`. Removed accounts are NOT auto-deleted — they are written as pending notifications to `territory-notifications.json` for human review via `GET /api/territory/notifications`.

**Skip conditions:** No AEs configured, Google auth token missing. Runs before Pipeline sync (1:45am vs 2:00am) so new customers are available for pipeline data.

---

## Group 3 — Startup One-Time Tasks

These fire once at server boot and do not repeat.

| # | Name | File | Delay | Trigger condition |
|---|------|------|-------|------------------|
| 8 | Scrape context init + initial RH scrape | `background-scheduler.ts` | 5s | RH session marker file exists |
| 9 | Startup full refresh | `background-scheduler.ts` | Immediate | `customers.length > 0` |
| 10 | Brief pre-generation | `background-scheduler.ts` | Immediate IIFE, 10s between customers | `isBriefConfigured()` |
| 11 | Account discovery | `bootstrap-orchestrator.ts` | Immediate IIFE | Customers missing account numbers |
| 12 | Drive watcher init | `background-scheduler.ts` | Immediate IIFE | `AE_PARENT_FOLDER_IDS` env var set |

**Timer 8:** Opens persistent Chromium, shares the browser context with SF/Supportable/CCSP scrapers, then triggers first RH scrape. 5-second delay gives the server time to fully initialize before Chrome opens.

**Timer 9:** `refreshAll()` — reads all Supportable + CCSP sheets → populates cache on first load. Immediately followed by `rescheduleRefreshTimers()` to set up Timers 1 and 2.

**Timer 10:** For every customer missing a brief cache file, fetches Calendar + Gmail + Drive + Cases + Subscriptions + Sheet data, calls `generateBrief()` (LLM), writes to `data/cache/<slug>-<date>.json`. Rate-limited to 1 customer per 10 seconds to stay within Drive API quota. Re-checks cache before each customer in case a user request already generated it while waiting.

**Timer 11:** Reads existing Supportable Google Sheets to recover account numbers at boot. Sheets-based only — not a live scrape. Writes recovered account numbers to `customers.json` then triggers `runRhScrapeWithState()`.

**Timer 12:** Fetches Drive `startPageToken`, builds folder-to-customer map by scanning AE parent folders 3 levels deep. Required before Timer 6 can detect changes.

---

## Group 4 — Per-Operation Timeouts

These fire during active operations and are not recurring. Each protects one operation from hanging indefinitely.

| # | Name | File | Duration | Mechanism |
|---|------|------|----------|-----------|
| 13 | Bootstrap hard timeout | `bootstrap-orchestrator.ts` | 60 min | `setTimeout` |
| 14 | RH login poll | `rh-auth.ts` | 2s tick / 5min max | `while` + `setTimeout` |
| 15 | SF login poll | `sf-auth.ts` | 2s tick / 5min max | `while` + `setTimeout` |
| 16 | CCSP per-AE timeout | `ccsp-scraper.ts` | 2 min | `Promise.race` |
| 17 | Supportable per-account timeout | `supportable-scraper.ts` | 90 sec | `Promise.race` |
| 18 | RH scraper stale mutex | `scraper-manager.ts` | 15min threshold | Guard condition on entry |
| 19 | SF sync stale mutex | `scraper-manager.ts` | 15min threshold | Guard condition on entry |
| 20 | CCSP/Supportable stale mutex | `ccsp-scraper.ts`, `supportable-scraper.ts` | 15min threshold | Guard condition on entry |
| 21 | `rhGet`/`rhPost` abort | `redhat.ts` | 15 sec | `AbortController` |
| 22 | VPN reachability probe | `scraper-manager.ts` | 8 sec | `AbortSignal.timeout` |
| 23 | Google Sheets quota retry | `google.ts` | 61 sec (on 429 only) | `setTimeout` |

**Notes:**
- **Timers 18–20** are not real timers — they are elapsed-time checks evaluated when a scrape is called. If `scrapeRunning === true` and `Date.now() - startedAt > 15min`, the mutex is force-released.
- **Timer 23** only fires on HTTP 429 / `RESOURCE_EXHAUSTED`. Waits 61 seconds then retries once. Applied in all 3 scrapers.

---

## Group 5 — Frontend Polling Timers

Active in the browser while specific UI states are active. All self-clear when their condition is resolved.

| # | Name | File | Interval | Hard timeout | Active while |
|---|------|------|----------|-------------|-------------|
| 24 | Bootstrap status poll | `SetupPage.tsx` | 2s | — | `bootstrapState.running` |
| 25 | RH login status poll | `SetupPage.tsx` | 2s | — | `connecting` (RH) |
| 26 | SF login status poll | `SetupPage.tsx` | 3s | 120s | `connecting` (SF) |
| 27 | Supportable completion poll | `SetupPage.tsx` | 4s | — | Supportable sync in progress |
| 28 | Supportable status message poll | `SetupPage.tsx` | 1.5s | — | `supportableRunning` |
| 29 | RH session banner poll | `App.tsx` | 2s (reconnecting) / 5min (idle) | — | App lifetime |

---

## Group 6 — TTL Cache (Not a Timer)

| # | Name | File | TTL | Mechanism |
|---|------|------|-----|-----------|
| 30 | Weather cache | `settings-api.ts` | 30 min | Timestamp check on each `GET /api/weather` request |

Not a timer — checks `Date.now() - cachedAt` on each request. No background work.

---

## Configurable Timers Summary

7 of 33 timers are configurable at runtime via `POST /api/settings/refresh`:

| Timer | Setting key | Default |
|-------|-------------|---------|
| Subscriptions Refresh (#1) | `subscriptions` | 240 min |
| CCSP Refresh (#2) | `ccsp` | 1440 min |
| RH Scrape cadence (#3) | `rhScrape` | 240 min |
| Pipeline 2am Sync (#7) | `sfPipelineTime` / `sfPipelineEnabled` | 02:00 ET / enabled |
| CCSP 6:30am Scrape (#31) | `ccspTime` / `ccspEnabled` | 06:30 ET / enabled |
| Supportable 7am Batch (#32) | `supportableTime` / `supportableEnabled` | 07:00 ET / enabled |
| Territory 1:45am Sync (#33) | `territoryTime` / `territoryEnabled` | 01:45 ET / enabled |

Settings stored in `data/config/data-sources.json` under `refreshIntervals` (timers 1-3) and `schedulerConfig` (timers 7, 31-33). Changing refresh intervals calls `rescheduleRefreshTimers()` which clears and recreates Timers 1 and 2, and immediately takes effect on Timer 3's next tick. Scheduler config enable/disable flags are checked at the start of each timer's callback -- disabled timers still reschedule but skip the actual scrape work. Floor enforcement (min hours between runs) is validated server-side on the POST endpoint.

---

## Key Non-Obvious Behaviors

1. **Timer 3 is not a 4h setInterval.** It is a 15min heartbeat that checks elapsed time. Any scrape delay is up to 15min past the configured interval. This is intentional (Bun ADR-007).

2. **Timer 7 (Pipeline 2am) self-reschedules** — not a `setInterval`. Recalculates the exact target time after each run, handles EST/EDT automatically.

3. **Timers 1 and 2 skip silently if the source sheet hasn't changed.** They check Drive `modifiedTime` before reading. Under normal conditions (no manual scrape since last tick), they do no work.

4. **Timers 4 and 5 have two instantiation paths.** Fresh login → `adoptScrapeContext()`. Startup from persisted session → `initScrapeContext()`. Both clear any existing timer before creating a new one.

5. **Timers 3 and 6 have no stored handles** and cannot be stopped or rescheduled at runtime.

6. **SF keep-alive (Timer 5) does not close the browser.** `closeSfContext()` only clears the timer — the BrowserContext is owned by the RH scraper and stays open.
