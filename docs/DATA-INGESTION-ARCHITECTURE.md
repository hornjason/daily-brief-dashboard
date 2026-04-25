---
Last validated: 2026-04-25
Classification: Operational
Status: Reconstructed after 2026-04-23 git-history loss
Authority: This document is authoritative for the data-ingestion pipeline. Code is the only thing that ranks higher. When code and this doc disagree, fix the doc — but flag the drift in BACKLOG so the divergence is intentional, not silent.
---

# Data Ingestion Architecture

This is the load-bearing reference for how data enters DailyBriefDashboard. Five sources, four logical cache tiers, several scheduled refresh loops, and one offline-token bypass for Red Hat cases. Everything else in the dashboard reads from the artifacts these flows produce.

The doc was reconstructed from source on 2026-04-25 after `git filter-repo` lost the original between 2026-04-11 and 2026-04-23. The L1–L4 model lives canonically in `test/unit/ingest-0{1,2,3}*.ts` — those tests are the ground truth for tier semantics; this doc explains the surrounding flow.

---

## 1. The L1 → L4 Hierarchy

The pipeline thinks in four tiers. Not every flow uses every tier — the model is a vocabulary, not a contract every source obeys identically.

```
┌────────────────────────────────────────────────────────────────────┐
│  L1  In-process memory cache         (process lifetime, RAM only)  │
│        e.g. _podCsvCache in ccsp-scraper, JWT in redhat.ts          │
├────────────────────────────────────────────────────────────────────┤
│  L2  Per-AE materialised Google Sheet    (drive — written by us)   │
│        e.g. supportableSheetId, ccspSheetId, pipelineSheetId        │
├────────────────────────────────────────────────────────────────────┤
│  L3  POD-level shared source sheet       (drive — owned upstream)  │
│        e.g. SF Bookings POD sheet, CCSP Tableau export              │
├────────────────────────────────────────────────────────────────────┤
│  L4  Live system of record                                         │
│        Salesforce Lightning, Tableau Cloud, RH Portal, RH SSO       │
└────────────────────────────────────────────────────────────────────┘
```

**Reading rule.** Every flow tries L1 first and falls through to the next layer only when its freshness predicate fails. Writes always go down to the lowest layer that was reached, then propagate upward via the on-disk JSON cache (`data/cache/*.json`) which is the durable substrate beneath L1.

**Telemetry.** `src/ingest-events.ts` defines `emitCacheLevel({ ae, flow, level, rowCount })`. Producers are intended to fire this on every cache hit/miss so the dashboard can render layer-by-layer freshness. *(See Audit §3.4 — there are currently zero callers; the producer side was lost in the filter-repo incident.)*

---

## 2. Per-Source Flows

### 2.1 SF Bookings (subscriptions)

This is the customer-subscriptions flow. SF Bookings sheets in a shared POD Drive folder are the source of truth for which customers an AE has and what they bought.

```
Salesforce (system of record)                                      L4
        ↓  AEs / ops curate weekly
POD-level SF Bookings Google Sheet (shared folder)                 L3
        ↓  src/sf-bookings-reader.ts :: fetchSfBookingsRaw()
        ↓     1h on-disk raw cache (data/cache/sf-bookings-raw-*.json)  L1
        ↓  src/sf-bookings-reader.ts :: deriveSfCustomersByTerritory()
        ↓     filters by ae.tableauTerritories, derives net-new customers
Per-AE Subscriptions Sheet (writeSupportableSheet)                 L2
        ↓  src/sheets.ts :: fetchCustomerSheetData() / batchFetchSubscriptions()
data/cache/<slug>-sheets.json                                      L1 (disk)
        ↓  customer detail page / brief generation
```

**TTLs (from source):**
- L1 raw cache: `RAW_CACHE_TTL_MS` in `src/sf-bookings-reader.ts:40`
  - **Asserted contract: 24h** (`test/unit/ingest-01-sf-bookings-cache-ttl.test.ts:14`)
  - **Current source value: 1h** ⚠️ regression — see Audit §3.1
- L2 freshness gate: `CACHE_HIER_FRESH_MS = 24h` in `src/bootstrap-orchestrator.ts:~411` (per BKL-INGEST-02 test)
- L1 sheets cache (`<slug>-sheets.json`): no TTL — content-hash diffed in `cache-layer.ts:writeSheetCache()`. Replaced when source rows change.

**L2 short-circuit (BKL-INGEST-11).** If the AE's Subscriptions sheet was modified <24h ago AND the AE has at least one active customer in memory, skip L3. Empty in-memory customer list (cold start / wipe) forces L3 fall-through even if L2 looks fresh — `aeHasCustomers()` predicate, `bootstrap-orchestrator.ts`.

**Refresh:** `refresh-engine.ts :: refreshSubscriptions()` — heartbeat-driven, default interval from `getRefreshIntervals().subscriptions`. Uses `batchFetchSubscriptions()` to coalesce one Sheets `batchGet` per AE sheet (BKL-AE-03). Drive `modifiedTime` gate via `checkFilesModified()` skips refresh entirely when the source POD sheet is unchanged.

### 2.2 CCSP — Cloud Spend (Tableau)

```
Tableau Cloud — OverallCloudConsumptionDashboard                   L4
        ↓  src/ccsp-scraper.ts :: runCcspScrape() (Playwright, daily 6:30 ET)
        ↓     applies AE territory filter, downloads CSV from Raw Data tab
Per-AE CCSP Sheet (writeCcspSheet)                                  L2
        ↓  src/sheets.ts :: fetchCCSPData()
        ↓     in-memory POD-CSV cache (POD_CSV_CACHE_TTL_MS — see audit) L1
data/cache/ccsp-data.json   +   ccsp-delta.json (per-customer ΔACV)  L1 (disk)
        ↓  customer detail page / dashboard CCSP tile
```

**TTLs (from source):**
- L1 in-memory CCSP CSV cache: `POD_CSV_CACHE_TTL_MS = 24h` per BKL-INGEST-03 test contract
  - **Current source state: constant not present in `src/ccsp-scraper.ts`** ⚠️ — see Audit §3.2
- L1 disk cache (`ccsp-data.json`): no time TTL; invalidated by AE-set change via `isCCSPCacheStale()` in `cache-layer.ts:132`
- Drive `modifiedTime` gate: `≥ 24h` ⇒ stale, fall through (per BKL-INGEST-03 logic test)

**Refresh:**
- L4 scrape: daily 6:30am ET (`scheduleCcspSync` in `background-scheduler.ts:470`) — gated on a Tableau session pre-flight (8s probe, redirect to /signin = skip)
- L1/L2 cache refresh: `refresh-engine.ts :: refreshCCSP()` on heartbeat (default interval, see `RefreshTimerSettings`)
- AE-set change forces full refresh (BKL-CCSP-03) — empty result is valid for a brand-new AE set, so the "don't overwrite cache with empty" guard is skipped

### 2.3 SF Pipeline (opportunities)

```
Salesforce Lightning Report (SAML SSO — REST blocked)              L4
        ↓  src/sf-scraper.ts :: runSfPipelineSync() (Playwright, daily 2am ET)
        ↓     viewport hack: 20,000px height to defeat IntersectionObserver
Per-AE Pipeline Sheet "Pipeline" tab                                L2
        ↓  src/pipeline.ts :: fetchPipelineData()
data/cache/pipeline-data.json                                       L1 (disk)
        ↓  buildPipelineSummary() → /api/pipeline → PipelineSection.tsx
```

**TTLs:**
- L1 disk: no time TTL; invalidated when `aes.pipelineSheetId` set diverges from cached `fileIds`
- Drive `modifiedTime` gate: `checkFilesModified()` short-circuits refresh if all Pipeline sheets unchanged since cache time
- Empty-result guard: never overwrite a populated cache with `[]`

**Refresh:**
- L4 scrape: daily 2am ET (`schedulePipelineSync` in `background-scheduler.ts:773`) — gated on (a) presence of SF session, (b) SF Lightning pre-flight HTTP probe (8s, status <400)
- L1 cache: `refresh-engine.ts :: refreshPipeline()` — manual via `POST /api/refresh/pipeline`, post-bootstrap auto-trigger from `bootstrap-orchestrator.ts:1349`

### 2.4 RH Cases — two parallel transports

The cases flow is the only one with two distinct paths to the same data. Both write to the same cache (`data/cache/cases.json`) and are read by `src/redhat.ts :: fetchCases()`.

#### 2.4.1 Browser path (legacy, default in production)

```
RH Portal — access.redhat.com/support/cases                        L4
        ↓  src/rh-scraper.ts :: runRhScrapeWithState() (Playwright)
        ↓     persistent Chromium profile (RH_PROFILE_DIR)
        ↓     rh_sso_session cookie ~14h, TAsessionID renewed via keepalive
data/cache/cases.json                                               L1 (disk)
        ↓  src/redhat.ts :: fetchCases() → fetchCustomerCases(customer)
```

**Schedule:** heartbeat-driven, configurable via `getRefreshIntervals().rhScrape` (default 4h). 15-min tick checks elapsed time and enqueues through the scraper queue (`background-scheduler.ts:1184`).

**Session lifecycle:** keep-alive timer fires every 8 minutes — first attempts `keycloak.updateToken()` via `page.evaluate`, falls back to full page navigation. Storage state persisted to disk after each successful keep-alive so container restarts inherit session. Auto-recovery on context death up to 5 attempts with exponential backoff.

#### 2.4.2 Bearer path (offline-token, browser-free) — **the path the missing doc emphasised**

```
.env  REDHAT_OFFLINE_TOKEN  (long-lived refresh token)
        ↓  src/redhat.ts :: getToken()
        ↓     POST sso.redhat.com/auth/realms/redhat-external/protocol/openid-connect/token
        ↓     grant_type=refresh_token  client_id=rhsm-api
        ↓  in-memory Bearer JWT (cachedToken, expires_in − 60s)    L1
        ↓  src/rh-cases-api.ts :: fetchCasesViaSolr(accountNumbers)
        ↓     POST access.redhat.com/hydra/rest/search/v2/cases
        ↓     SOLR: q=case_accountNumber:(N1 OR N2 …)
src/case-client.ts :: BearerCaseClient.fetchCases()                L4
        ↓  recordScrapeSuccess() — clears sessionExpired, stamps lastScraped
data/cache/cases.json                                               L1 (disk)
```

**Why this path exists.** The browser scrape is heavy (Playwright, persistent Chromium, SSO renewal). The offline token is a refresh-only credential issued from the Red Hat SSO console; it survives indefinitely until revoked. Bearer-auth has sufficient privileges to reach the same SOLR endpoint the DOM scraper hits. No Playwright. No VNC re-auth. No 8-minute keep-alive loop.

**Phase status (per `src/rh-cases-api.ts:14`):** "Phase 1 — fetch-only, validates the API path. No wiring into production data flow — that is a later phase." `BearerCaseClient` is implemented and the success-stamping regression test (BKL-BUG-04) passes, but it is not the default RH ingest path in production. Toggling between paths is a design decision still pending — the missing original doc may have specified it.

**Account number cap.** SOLR query bounded to 1000 accounts per call (BKL-SEC-13) — `rh-cases-api.ts:103`.

**Token refresh.** `redhat.ts:13` — JWT cached in process memory; refresh fired when `now > tokenExpiry − 60s`. No persistent token cache; container restart re-exchanges.

### 2.5 Account Intelligence / Briefs

Briefs are the only flow that fans **out** rather than in. Each customer's brief is generated by aggregating the four ingest flows above plus Drive docs / Gmail / Calendar.

```
For each customer at first page view (or pre-gen on startup):
        ┌─→ readSheetCache(customer)        — L1 SF Bookings disk cache
        ├─→ readPipelineCache()  — L1 SF Pipeline cache (filtered by name)
        ├─→ readCCSPCache()      — L1 CCSP cache (filtered by accountName)
        ├─→ fetchCustomerCases() — L1 cases.json (filtered by accountNumber)
        ├─→ fetchCustomerSubscriptions()  — L4 RHSM REST API (Bearer)
        ├─→ fetchCustomerMeetings/Emails/Docs — L4 Google APIs
        └─→ writeCustomerDocsCorpus()  — caches Drive doc text per customer
                ↓
        generateBrief()  →  Gemini on Vertex AI (gemini-2.5-flash)
                ↓
        data/cache/<slug>-<YYYY-MM-DD>.json   L1 (disk, daily, 24h TTL)
                ↓
        invalidateBriefCaches() on Drive change (drive-watcher.ts)
```

**TTLs:**
- Brief disk cache: `BRIEF_CACHE_TTL_MS = 24h` (`cache-layer.ts:23`), date-stamped per local day
- Stale-overwrite guard: a write is rejected if the existing cached brief is >1.5× the size and the new one is <500 chars (truncated Gemini output / pre-gen vs on-demand race)
- Drive watcher polls every 10 min (`DRIVE_WATCHER_INTERVAL_MS`) and invalidates brief caches for affected customers

---

## 3. Schedule Reference (exact, from source)

| Job | When | Mechanism | File:Function |
|---|---|---|---|
| Pipeline sync | Daily **2:00am ET** | `setTimeout` reschedule | `background-scheduler.ts:773` `schedulePipelineSync` |
| Territory sync | Daily **1:45am ET** | `setTimeout` reschedule | `background-scheduler.ts:692` `scheduleTerritorySync` |
| CCSP scrape | Daily **6:30am ET** | `setTimeout` reschedule | `background-scheduler.ts:470` `scheduleCcspSync` |
| Supportable batch | Daily **7:00am ET** | `setTimeout` reschedule, 3-batch rotation | `background-scheduler.ts:570` `scheduleSupportableSync` *(disabled per CLAUDE.md)* |
| KPI snapshot | Daily **8:00am ET** | `setTimeout` reschedule | `background-scheduler.ts:368` `scheduleKpiSnapshot` |
| Email brief | User-configured (HH:MM in tz) | `setTimeout` reschedule, re-reads config each cycle | `background-scheduler.ts:900` `scheduleEmailDelivery` |
| Product Intel weekly | Sunday **6:00am ET** | `setTimeout` reschedule | `background-scheduler.ts:1440` `scheduleProductIntelRefresh` |
| Heartbeat tick | Every **15 min** | `setInterval(RH_SCRAPE_TICK_MS)` | `background-scheduler.ts:1170` |
| └── RH scrape | When elapsed ≥ `intervals.rhScrape` (default 4h) | enqueued via heartbeat | same |
| └── Subscriptions refresh | When elapsed ≥ `intervals.subscriptions` | heartbeat fires `refreshSubscriptions()` | same |
| └── CCSP refresh | When elapsed ≥ `intervals.ccsp` | heartbeat fires `refreshCCSP()` | same |
| Drive watcher poll | Every **10 min** | `setInterval(DRIVE_WATCHER_INTERVAL_MS)` | `background-scheduler.ts:1278` |
| Brief pre-gen (startup) | 1 customer per **10s** | `setTimeout` chain | `background-scheduler.ts:1296` |
| Sheet health check | **5s** after startup | one-shot | `background-scheduler.ts:1086` |
| Domain inference sweep | **30s** after startup | one-shot, batches of 3 | `background-scheduler.ts:1369` |
| Product Intel cache seed | **15s** after startup | one-shot | `background-scheduler.ts:1339` |

**Why setTimeout-reschedule, not setInterval?** ADR-007 — Bun's `setInterval` is unreliable for intervals over ~1h. The reschedule loop is container-safe (no system cron available in the container) and survives daylight-savings transitions because each fire calculates the next ET offset fresh.

---

## 4. The Scraper Queue (BKL-M49)

All four browser-driven scrapers share one Playwright `BrowserContext` because Tableau SSO breaks under context isolation. The queue serialises them.

```
enqueueScraperTask({ name, run, source: 'startup'|'scheduled'|'heartbeat'|'manual', enqueuedAt })
        ↓
   coalesce: drop if same name already pending
        ↓
   runNextInQueue() — guarded by isAnyScraperRunning():
          rh ‖ sf ‖ ccsp ‖ ccsp-in-flight ‖ supportable ‖ bootstrap
        ↓
   task.run().finally(setTimeout 500ms → next)
```

**Post-auth flush ordering** (`flushScrapersAfterAuth`): RH → SF → CCSP → Supportable. RH first because Supportable depends on the account numbers RH discovers. Supportable enqueue is gated on a VPN probe to `supportable.corp.redhat.com:4443` (BKL-G30 Gap 6) — but Supportable is permanently disabled in this codebase (CLAUDE.md), so this branch is dead in practice.

---

## 5. The Drive `modifiedTime` Gate

Every refresh that consults a Google Sheet first asks Drive: "has this file changed since I last cached it?" If not, skip the read entirely.

**Why it exists.** Drive `files.get(fields:'modifiedTime')` is one cheap call. A full Sheets `values.get` over a POD bookings sheet is ~5000 rows × 30 cols and burns Sheets quota fast across many AEs. The gate cuts ~80% of Sheets reads in steady state.

**Where it fires.**
- `refresh-engine.ts:131` — subscriptions refresh checks the configured Supportable source file
- `refresh-engine.ts:163` — CCSP refresh checks all `cached.fileIds`
- `refresh-engine.ts:197` — pipeline refresh checks all AE pipeline sheet IDs
- `bootstrap-orchestrator.ts:~411` (per BKL-INGEST-02) — L2 short-circuit during SF Bookings ingestion
- `ccsp-scraper.ts` — POD CSV cache invalidation (per BKL-INGEST-03)

**Failure mode.** If the Drive call itself fails (auth, quota, network), the gate fails closed: the refresh proceeds. We trade a quota burn for correctness — silent staleness is worse.

---

## 6. The Google Sheets Intermediate Layer

There is one design decision in this pipeline that surprises every reviewer: we write to Google Sheets **even though** we read from Google Sheets in the next breath.

The pattern: scrape L4 → write Per-AE Sheet (L2) → read it back in the cache layer.

**Why we do it instead of going scraper → memory → cache → display:**

1. **Audit and override.** AEs can open the sheet, see what the scraper saw, edit it, and the next refresh picks up the edits. There is no other way to surface "the scraper got this row wrong" without rebuilding it as a UI feature.
2. **Backup substrate.** Drive is durable; the container's `data/` is not (rebuilds wipe it). Re-bootstrap an AE on a fresh container and the L2 sheets re-hydrate the L1 caches without re-running the L4 scrape.
3. **Multi-AE coordination.** Pipeline reads from N AE sheets in one `batchGet`. Without the materialised sheet, we'd have to keep N raw scrape outputs in sync.
4. **Decoupling.** The dashboard never depends on the scraper running successfully *today*. As long as L2 is fresh-enough, the dashboard is fresh-enough.

This is why CLAUDE.md says "Config files mutated at runtime is intentional — config IS the persistence layer." The same logic applies one layer up: the L2 sheets ARE the persistence layer for scraped data.

---

## 7. Cold-start and Failure-mode Discipline

**Empty-result guard (every refresh).** A successful API call returning 0 rows is treated as suspect. If the existing cache has data and the new fetch returns `[]`, the cache is preserved. Quota failures and auth blips return empty silently — overwriting would silently destroy good data. Bypassed only when (a) the AE set legitimately changed (BKL-CCSP-03) or (b) `force=true`.

**Auto-clear runaway account numbers.** `validateCachedAccountNumbers()` on startup — any customer with >50 cached account numbers is auto-cleared (likely an APEX search false-positive); 20–50 is warned but kept. Result is persisted to `customers.json`.

**Cold-start L2 short-circuit defeat (BKL-INGEST-11).** A warm L2 SF Bookings cache alone is not enough to skip L3 — the AE must also have at least one active customer in memory. Otherwise a cold-started container with a fresh-looking L2 would never derive customers from the source POD sheet.

**Sheet ID health check.** 5s after startup, fire-and-forget — every configured `ccspSheetId` / `pipelineSheetId` / `supportableSheetId` gets a `spreadsheets.get(fields:'spreadsheetId')` ping. Failures land in container logs. Doesn't gate anything; just makes silent misconfiguration visible.

---

## 8. Where this doc is incomplete

The original document was lost. Rebuilding from source captures the state of the code today. Three areas the original may have specified but I could not infer with confidence:

1. **The cutover plan from browser-based RH scrape to Bearer-token transport.** Phase 1 is implemented; the routing logic that picks browser vs Bearer at runtime is not present in source today. The original doc may have proposed a feature flag or a migration order.
2. **Account Intelligence weekly batch timing.** The weekly Sunday 6am ET refresh exists for product feature radar; the per-customer account-intelligence batch trigger lives in `account-intelligence.ts`, but its cadence relative to the ingestion flows is not documented.
3. **The `emitCacheLevel` consumer.** The producer infrastructure (`ingest-events.ts`) exists. No dashboard route or SSE endpoint subscribes to it today. The original doc likely described where the L1–L4 telemetry was meant to surface.

These are flagged in `BACKLOG.md` for clarification with Jason.
