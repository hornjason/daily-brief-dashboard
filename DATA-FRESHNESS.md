---
doc-type: reference
status: active
owner: jason
updated: 2026-05-05
---

# Data Freshness Architecture

**Status: PROPOSAL — reviewed 2026-04-01, pending implementation approval**
Analysis by: Marcus Webb (source audit) + Serena Blackwood (architecture)
Priorities confirmed by: Jason Horn 2026-04-01

This document defines how each data source flows into the dashboard, what the current staleness gaps are, and the proposed automated sync plan to close them.

---

## Priority Ranking (Confirmed by Jason)

Ranked by how frequently data actually changes at source:

| Priority | Data Source | Change Frequency | Target Cadence | Notes |
|---|---|---|---|---|
| 1 | **RH Cases** | Multiple times daily | Every 1–2h | Sev1s need to be caught early; current 4h default is too slow |
| 2 | **SF Pipeline** | Daily (SF generates report at 1am ET) | Daily at 2am ET | Natural fit with SF report generation cycle |
| 3 | **CCSP / Tableau** | Infrequent; seen in arrears | Daily at 6:30am ET | ⚠️ Backlog: store diff between pulls to show trends over time |
| 4 | **Supportable** | Very infrequent | Daily at 7am ET | ⚠️ **FLAGGED: Scale risk at 200 customers — see below** |
| 5 | **Territory Mapping** | Infrequent | Daily at 1:45am ET | Low cost (one Sheets API read + diff, no Playwright) |

---

## Data Source Inventory

### Current State (verified 2026-04-01)

| Data Source | Source System | Intermediate Store | Full Chain | Source Sync Trigger | Max Staleness |
|---|---|---|---|---|---|
| **RH Cases** | RH Portal (Playwright) | None | Portal → file cache | Auto every 4h (heartbeat) | ~8h |
| **Supportable** | Supportable APEX (Playwright, VPN) | Google Sheet | APEX → GSheet → file cache | **Manual only** | **Unbounded** |
| **CCSP / Tableau** | Tableau Cloud (Playwright) | Google Sheet | Tableau → GSheet → file cache | **Manual only** | **Unbounded** |
| **SF Pipeline** | Salesforce Lightning (Playwright) | Google Sheet | SF → GSheet → file cache | **Manual / SF login** | **Unbounded** |
| **Territory Mapping** | RH Territory GSheet | None (GSheet is source) | GSheet → customers.json / aes.json | **Bootstrap only** | **Unbounded** |
| **Google Calendar** | Google Calendar API | None | API → response (live) | Every request | Real-time |
| **Gmail** | Gmail API | None | API → response (live) | Every request | Real-time |
| **RH Subscriptions API** | RH Management API | None | API → response (live) | Every request | Real-time |
| **Google Drive Docs** | Google Drive API | Brief cache | API → brief cache | On demand / daily brief | 24h (brief) |
| **AI Briefs** | All sources above | Brief cache | Composite → brief cache | On demand / startup | 24h |

## Architecture: Three-Tier Model

```
┌─────────────────────────────────────────────────────────────┐
│  TIER 1 — SOURCE SCRAPES (Playwright → source → GSheet)     │
│  • Automated: morning schedule (background-scheduler.ts)    │
│  • Manual break-glass: Admin page (hidden, /admin route)    │
│  • Live status feedback shown on Admin page while running   │
├─────────────────────────────────────────────────────────────┤
│  TIER 2 — CACHE SYNCS (GSheet → local JSON cache)           │
│  • Automated: background refresh timers (4h/24h)           │
│  • Manual: "Sync Now" buttons on Setup Data Sources page    │
│  • Fast (seconds), no Playwright, no VPN required           │
├─────────────────────────────────────────────────────────────┤
│  TIER 3 — DASHBOARD (reads local JSON cache)                │
│  • All API endpoints serve from data/cache/ files           │
│  • Real-time sources (Calendar, Gmail) bypass cache         │
└─────────────────────────────────────────────────────────────┘
```

| Term | Definition |
|---|---|
| **Source scrape** | Playwright goes to the actual source system (Supportable APEX, Tableau, SF Lightning, RH Portal) or reads the territory GSheet directly. Writes to GSheet (or cache for RH Cases). Only way to get fresh data. |
| **Cache sync** | Reads an already-written GSheet → updates the local JSON cache. No new data fetched from source. Background refresh timers and Setup "Sync Now" buttons are cache syncs. |
| **Admin page** | Hidden page (/admin). No link in the app — accessed by triple-clicking the version number in Setup footer. Contains manual source scrape triggers with live status + background scheduler configuration (schedule times, intervals, enable/disable per source). Break-glass for when automated morning runs fail. |
| **"Sync Now" in Setup** | Cache sync only — GSheet → local cache → dashboard. Fast, no Playwright. |

---

### The Core Gap

**Three critical gaps exist:**

1. **Background timers are cache syncs, not source scrapes.** Timers 1 (subscriptions, 4h) and 2 (CCSP, 24h) read from an already-written GSheet → update local cache. They do NOT go back to Supportable APEX or Tableau. If nobody triggers a manual "Sync Now", the GSheet never updates — the background timers just keep re-reading the same stale data.

2. **The daily 2am pipeline timer is also a cache sync only.** Timer 7 calls `refreshPipeline()` (GSheet → cache). It does NOT call `runSfPipelineSync()` (SF → GSheet). So SF pipeline data is only as fresh as the last "Sync Now" or last SF login.

3. **Territory mapping has no sync at all.** The POD → AE → customer name mapping is read once at bootstrap and never refreshed. New customers added to the territory sheet are invisible to the dashboard indefinitely.

---

## Proposed: Automated Morning Sync Sequence

> **This is a proposal. Not yet implemented.**

All times Eastern (ET). Handles EST/EDT via `Intl.DateTimeFormat` (same pattern as existing Pipeline timer).

| Time | Data Source | Operation | Max Staleness After |
|---|---|---|---|
| **1:45 AM** | Territory Mapping | Read territory GSheet → diff → auto-add new customers → flag removals | ~24h |
| **2:00 AM** | SF Pipeline | **Scrape SF** report → write GSheet → read GSheet → update cache | ~28h |
| **6:30 AM** | CCSP / Tableau | **Scrape Tableau** → write GSheet (cache picks up on next 24h tick) | ~48h |
| **7:00 AM** | Supportable | **Scrape Supportable APEX** → write GSheet — ⚠️ SEE SCALE FLAG | ~48h |
| Continuous | RH Cases | Heartbeat scrape — **proposed: tighten to 1–2h default** | ~4h |
| On demand | Calendar / Gmail / Drive | Live API calls (unchanged) | Real-time |

**Why this order:**
- Territory sync runs first — new customers must exist in `customers.json` before subsequent scrapers include them
- SF at 2am — isolated, no browser context competition; SF report generated at ~1am ET so 2am catches it
- CCSP before Supportable — faster, no VPN dependency, fails fast if Tableau session is dead
- Supportable last — longest, VPN-dependent, benefits from browser context already warmed

---

## ⚠️ OPEN FLAG: Supportable Scale Risk at 200 Customers

**Current performance:** `PARALLEL_PAGES=1` (Supportable APEX session contention — cannot increase). At 22 customers: ~33 minutes. At 200 customers: **estimated 5+ hours**. A 7am scrape finishing at noon is not acceptable.

**Two options to resolve before implementing Phase 3:**

**Option A — Incremental (only scrape changed/stale customers):**
Only scrape customers whose sheet data is older than X days (configurable threshold). Most customers won't change daily. Could reduce a 200-customer run to 20–30 customers on a typical day.
- Risk: A customer that stopped updating their subscription data would never be scraped.
- Mitigation: Full sweep on a weekly cadence regardless.

**Option B — Staggered batch rotation:**
Scrape a fixed batch per day (e.g. 50 customers/day in rotating groups), so every customer is refreshed within a rolling 4-day window.
- Predictable runtime (~33 min/day regardless of customer count).
- No customer goes more than 4 days without a refresh.
- Simpler to implement than staleness-based selection.

**Decision made 2026-04-01 by Jason: Option B — batch rotation.**
3 groups × ~67 customers, rotating daily. ~65 min/day. Every customer refreshed within a 3-day window. Predictable runtime regardless of total customer count. Phase 3 is now unblocked — write ADR-008 before implementation.
Initial load (BKL-M44): run to completion with no time-box. Batching is for ongoing daily rotation only, not the one-time initial load.

---

## Configurable Intervals — Protected Design

All sync intervals should be configurable but with enforced server-side floors to prevent users from setting aggressive intervals that cause performance issues or quota exhaustion.

**UI approach:** Settings are accessible but placed in an **Advanced** subsection of Setup — one level deeper than the main data sources panel. Not hidden, but not prominently front-and-center.

**Server-side floors (hard minimums, rejected with error message if violated):**

| Source | Proposed Floor | Reason |
|---|---|---|
| RH Cases | 30 min | Session keep-alive fires every 8 min; scrape below 30 min adds no value |
| SF Pipeline | 12h | SF report only regenerates daily |
| CCSP | 6h | Tableau session stress; data changes slowly |
| Supportable | 12h | PARALLEL_PAGES=1; at scale a run takes hours |
| Territory | 6h | GSheet API quota; data changes rarely |

**Ceiling (soft max, warn but allow):** None proposed — users can set very long intervals if they want stale data.

---

## Session Pre-Flight Requirements

Each automated scrape must verify its session is live before starting. Failure = log + skip, not crash.

| Scraper | Pre-Flight Check | On Failure |
|---|---|---|
| Territory | Google OAuth token valid | Skip, log error |
| SF Pipeline | Read `sf-session-state.json` timestamp; attempt keep-alive if stale | Skip, set `sfSyncError`, surface in status |
| CCSP / Tableau | Load lightweight Tableau page; check for SSO redirect | Skip, set status "Tableau session expired" |
| Supportable | VPN probe: `fetch` supportable.corp.redhat.com with 8s timeout | Retry every 15 min until 9:00 AM, then stop |

---

## Retry Policy

| Scraper | Retry | Hard Stop |
|---|---|---|
| Territory | Once at 2:00 AM if 1:45 AM fails | No retry after |
| SF Pipeline | Once at 2:15 AM if 2:00 AM fails | No retry after |
| CCSP | No retry — session-dependent | — |
| Supportable | Every 15 min if VPN probe fails | 9:00 AM ET |

---

## Two-Tier Timestamp Model

Currently the dashboard conflates two different timestamps. The proposal separates them:

| Timestamp | Meaning | Current State |
|---|---|---|
| `lastSourceSync` | When data was last pulled from the actual source system | Tracked for RH Cases only |
| `lastCacheRefresh` | When the local JSON cache was last updated from GSheet | Tracked via `cachedAt` in cache files |

**Jason cares about `lastSourceSync` only.** The `lastCacheRefresh` is internal plumbing.

### Proposed Dashboard UX

Each data section shows:
- **"Subscriptions from Supportable as of 6h ago"** — green if within expected window, yellow at 2x, red at 4x
- **Staleness badge tooltip:** "Last synced: [absolute timestamp]. Expected: daily at 7am ET. [Reason if stale: VPN unreachable / session expired]"
- No separate "last cache refreshed" display

---

## Implementation Phases

### Phase 1 — SF Pipeline 2am Source Scrape *(low risk, ~15 lines)*
**Files:** `src/background-scheduler.ts`
**Priority rank:** 2

Extend Timer 7 (`schedulePipelineSync`) to call `runSfSyncForAes()` before `refreshPipeline()`. SF session keep-alive (Timer 5, every 60 min) already ensures session is live at 2am. Add SF session pre-flight check; if expired, fall through to cache-only refresh and log.

**Before:** `2:00 AM → refreshPipeline()` [GSheet → cache only]
**After:** `2:00 AM → runSfSyncForAes()` [SF → GSheet] `→ refreshPipeline()` [GSheet → cache]

**Backlog:** BKL-M33

---

### Phase 2 — CCSP Daily 6:30am Source Scrape
**Files:** `src/background-scheduler.ts`, `src/scraper-manager.ts`
**Priority rank:** 3

Self-rescheduling `setTimeout` chain targeting 6:30am ET (same pattern as Timer 7). Calls `runCcspScrape()` after Tableau session pre-flight check. No VPN dependency.

Also: store per-pull delta in CCSP cache to enable trend display (BKL-M35).

**Backlog:** BKL-M33 (extend), BKL-M35 (CCSP trend diff)

---

### Phase 3 — Supportable Daily 7am Source Scrape *(BLOCKED — scale decision required)*
**Files:** `src/background-scheduler.ts`, `src/scraper-manager.ts`
**Priority rank:** 4
**⚠️ BLOCKED:** Must resolve Option A (incremental) vs Option B (batch rotation) for 200-customer scale before implementation. See scale flag above.

**Backlog:** BKL-M33 (extend), BKL-M36 (scale decision)

---

### Phase 4 — Territory Sheet Daily Sync at 1:45am *(prerequisite: parser extraction)*
**Files:** `src/background-scheduler.ts`, `src/territory-sync.ts` (new), `src/bootstrap-orchestrator.ts`
**Priority rank:** 5

1. Extract territory sheet parser from `server.ts` into `src/territory-sync.ts`
2. `syncTerritorySheet()`: read GSheet → diff → `{ toAdd, toRemove, toFlag }`
3. Auto-add new customers + targeted mini-bootstrap (Supportable + CCSP + Pipeline for new customers only)
4. Flag destructive changes → dashboard notification — never auto-delete
5. Drive folder idempotency check for new customers
6. Timer: 1:45am ET daily

**Backlog:** BKL-M34 (primary), BKL-M32 (drift), BKL-M15 (territory cache)

---

### Phase 5 — RH Cases Interval Tighten
**Files:** `src/settings-api.ts`
**Priority rank:** 1 (highest — cases change most frequently)

Lower the default `rhScrape` interval from 240 min (4h) to 60–120 min. Enforce 30 min server-side floor. No structural change — just a default value update and floor enforcement.

**Backlog:** BKL-M37

---

### Phase 6 — Configurable Intervals with Protected UI
**Files:** `src/settings-api.ts`, `dashboard/src/pages/SetupPage.tsx`
**Priority rank:** Enables all above phases

Add interval settings for all 5 sources to `POST /api/settings/refresh`. Enforce server-side floors. Surface in an Advanced subsection of Setup page — accessible but not prominent.

**Backlog:** BKL-M38

---

### Phase 7 — Dashboard Freshness UX
**Files:** `src/scraper-manager.ts`, `dashboard/src/pages/SetupPage.tsx`, `dashboard/src/components/`

1. Track `lastSourceSync` separately from `lastCacheRefresh` in `/api/status/scrapes`
2. Per-section "as of X ago" labels
3. Staleness badges (yellow at 2x expected interval, red at 4x or null)
4. Badge tooltip: absolute timestamp + reason if stale

**Backlog:** BKL-M39

---

## Backlog Cross-Reference

| Backlog Item | Phase | Status | Description |
|---|---|---|---|
| BKL-M32 — Territory sheet drift | Phase 4 | 🔴 Open | Root cause; Phase 4 closes it |
| BKL-M33 — Pipeline/CCSP/Supportable auto source sync | Phases 1–3 | 🔴 Open | Core freshness fix |
| BKL-M34 — Territory sheet background sync | Phase 4 | 🔴 Open | Daily 1:45am sync |
| BKL-M15 — Territory lookup quota | Phase 4 prereq | 🔴 Open | Cache territory reads |
| BKL-M19 — Subscription/CCSP raw setInterval > 1h | Phase 2/3 | 🔴 Open | Bun timer bug |
| BKL-M35 — CCSP trend diff between pulls | Phase 2 | 🆕 New | Show delta in dashboard |
| BKL-M36 — Supportable scale decision (200 customers) | Phase 3 blocker | ✅ Done 2026-04-01 | Option B: batch rotation (3×67 customers/day) |
| BKL-M37 — RH Cases default interval tighten (4h → 1–2h) | Phase 5 | 🆕 New | Cases change most frequently |
| BKL-M38 — Configurable intervals with server-side floors | Phase 6 | 🆕 New | Protected Advanced settings UI |
| BKL-M39 — Dashboard freshness UX (staleness badges) | Phase 7 | 🆕 New | Per-section source timestamps |
