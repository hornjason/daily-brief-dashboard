---
doc-type: reference
status: active
owner: jason
updated: 2026-05-02
---

# CCSP Scraper Decomposition Brief (corrected)

**Status:** PROPOSED — supersedes the original issue #15 brief
**Date:** 2026-05-02
**Author:** Serena Blackwood (Architect) via Rayford (DA)
**Issue:** github.com/hornjason/asaCommandCenter#15
**Scope:** `src/ccsp-scraper.ts` — `scrapeOneAe` (lines 444–879)
**Constraint references:** `docs/SCRAPER-RULES.md`, `docs/adr/ADR-015-tableau-sso-shared-context.md`

---

## Problem Statement

Issue #15 calls for decomposition of `scrapeOneAe` (≈434 lines, cyclomatic ≈89). The original brief proposed seams that **do not exist in the actual code**:

- "HTML row parsing" — there is none. Data extraction is a CSV download via `page.waitForEvent('download')` against the Tableau `/RawData.csv` endpoint, parsed by `parseCsvToObjects()` (csv-parse.ts).
- "Generic retry-with-backoff" — there is none. The only retry-shaped code is a one-shot 5-minute SSO wait loop that polls `page.url()` every 2s and sets/clears `_tableauSessionExpired`. It is not a retry policy; it is a session-recovery handshake with the human at the VNC console.

The real complexity is **three sequential cache-tier branches** (in-memory POD cache → Drive POD cache → live Tableau path) plus the SSO recovery handshake embedded inside the live path. This brief re-specifies the seams against the actual code.

---

## Proposed Solution

Three extracted modules + one preserved orchestrator. Each module has a single, named responsibility. Extractions reduce `scrapeOneAe` from a sequential cache-walk-and-fetch to a thin orchestrator that calls them in order and post-filters the result.

```
┌──────────────────────────────────────────────────────────────┐
│ scrapeOneAe(page, ae, podBookingsFolderId)  [orchestrator]   │
│   1. compute window + currentPod                              │
│   2. ccsp-cache.tryMemoryCache(...)         → may early-return│
│   3. ccsp-cache.tryDriveCache(...)          → may early-return│
│   4. isPrimary() guard                                        │
│   5. ccsp-tableau-fetch.fetchPodCsv(page,…) → rows | throws   │
│   6. ccsp-cache.writeCaches(...)                              │
│   7. ccsp-row-filter.filterRows(rows, …)    → final result   │
└──────────────────────────────────────────────────────────────┘
```

The SSO recovery handshake stays inside `ccsp-tableau-fetch` because `_tableauSessionExpired` lifecycle is tightly coupled to the live navigation event that triggers it.

---

## Design Details

### Module 1 — `src/ccsp-cache.ts`

Owns the two-tier cache (in-memory + Drive). Encapsulates `_podCsvCache` (currently a module-level `let` in `ccsp-scraper.ts`). The cache becomes a single owner; ccsp-scraper holds no cache state after extraction.

```ts
// In-memory + Drive cache for full POD CSV (24h TTL).
// Owns: _podCsvCache module state, Drive list/get/create/delete for CCSP-<pod>-<date>.csv.

export interface PodCsvCacheEntry {
  rows: Record<string, string>[]
  period: string                // e.g. "FY26-Q1..Q4"
  pod: string                   // e.g. "WEST_COMM_CORP_NORTHWEST"
  driveFileId?: string          // present once Drive file written/discovered
}

export interface CacheLookupResult {
  hit: boolean
  rows?: Record<string, string>[]
  period?: string
  source?: 'memory' | 'drive'
}

/** Tier 1: in-memory cache, gated on pod match + Drive modifiedTime freshness (BKL-INGEST-03). */
export async function tryMemoryCache(
  pod: string,
): Promise<CacheLookupResult>

/** Tier 2: Drive cache lookup for CCSP-<pod>-<YYYY-MM-DD>.csv in the POD subscription folder.
 *  Side effect on hit: populates in-memory cache (with driveFileId) for subsequent AEs. */
export async function tryDriveCache(
  pod: string,
  podBookingsFolderId: string,
): Promise<CacheLookupResult>

/** After live fetch: populate memory cache and write/replace today's Drive cache file.
 *  Handles REG-CCSP-DUP-01 stale-file deletion. */
export async function writeCaches(
  pod: string,
  rows: Record<string, string>[],
  period: string,
  podBookingsFolderId: string | undefined,
): Promise<void>

/** Test seam — expose for unit tests / explicit invalidation. */
export function _resetMemoryCacheForTests(): void
```

**Maps to current code:** lines 463–510 (memory tier), 512–582 (Drive tier — minus the post-filter, which moves to `ccsp-row-filter`), 766–837 (write-back).

**Constraint preservation:** module-level `let _podCsvCache` becomes a private `let` inside `ccsp-cache.ts` — single owner, single mutator. Behavior is identical.

---

### Module 2 — `src/ccsp-tableau-fetch.ts`

Owns the live Tableau fetch path: URL build, page navigation, SSO recovery handshake, CSV download, response classification. This module owns `_tableauSessionExpired` state and exposes the existing `consumeTableauSessionExpired()` / `peekTableauSessionExpired()` accessors (moved here verbatim).

```ts
// Live Tableau fetch — only the leader instance calls this.
// Owns: _tableauSessionExpired lifecycle, embed URL construction, SSO 5-min wait loop.

export interface TableauFetchInput {
  page: Page                                  // page from shared scrape context (ADR-015)
  aeName: string                              // for logging only
  territoryFilters: ReturnType<typeof parseTerritoryParts>
  validTerritories: string[]                  // first element drives POD; full set for client filter (downstream)
  years: string[]
  quarters: string[]
}

export interface TableauFetchResult {
  rows: Record<string, string>[]              // full POD dataset, unfiltered by territory/quarter
  classification: 'csv_ok' | 'csv_empty' | 'auth_redirect' | 'csv_zero_rows' | 'csv_summary_view'
}

/** Navigate to the embed URL, wait through SSO handshake if needed, capture CSV download.
 *  Throws on 5-min SSO timeout. Sets _tableauSessionExpired during the wait window. */
export async function fetchPodCsv(input: TableauFetchInput): Promise<TableauFetchResult>

/** State accessors — moved from ccsp-scraper.ts. */
export function consumeTableauSessionExpired(): boolean
export function peekTableauSessionExpired(): boolean
```

**Maps to current code:** lines 590–769 + 870–877. The `_tableauSessionExpired` flag (line 212) and its accessors (215–224) move to this module. `ccsp-scraper.ts` re-exports them so `scraper-manager.ts` and the status endpoint see no signature change.

**SCRAPER-RULES preservation:**
- The shared `BrowserContext` is **not** acquired here — caller passes `page` (already obtained via `_ctx.newPage()` wrapped in 30s `Promise.race` upstream in `runCcspScrape`). This module never calls `getScrapeContext()`. ADR-015 invariant intact.
- The `ccspScrapeRunning || ccspInFlight` mutex remains in `runCcspScrape` (lines 883+) — this module is invoked under the mutex by the orchestrator.
- `_tableauSessionExpired` set→consume coherence: the flag is set on line 633, cleared on 653 or left set on 660. Moving the entire lifecycle (set, clear, and accessors) into one module **strengthens** coherence — no caller can corrupt it.

---

### Module 3 — `src/ccsp-row-filter.ts` ← **golden-file unit test target**

Owns the deterministic, post-download row filtering: territory filter + quarter filter against the full POD CSV. This is the **one pure function** in the decomposition — no IO, no globals, no time. Identical logic appears three times in the current code (memory cache hit, Drive cache hit, post-live-fetch); extraction collapses three duplicates into one.

```ts
/** Pure: filter a full POD CSV result down to one AE's territory list + the rolling quarter window.
 *  Deterministic; no IO; no clock; no globals. Unit-tested with a golden CSV fixture. */
export function filterRowsForAe(
  rows: Record<string, string>[],
  validTerritories: string[],
  quarters: string[],
): Record<string, string>[]
```

**Maps to current code:** lines 489–509 (memory tier filter), 558–580 (Drive tier filter), 840–869 (post-live filter). All three are the same logic with cosmetic logging differences. The function picks the territory column (`Account Territory Name` / `Account Territory`) and the quarter column (any header containing `fiscal year quarter`, case-insensitive, whitespace-collapsed) by header-normalization rules already present in the current code.

**Golden-file test plan (Marcus):**
- Fixture: `test/fixtures/ccsp-pod-sample.csv` — a real POD CSV slice (≤200 rows) with multiple territories and at least 5 quarters spanning the window.
- Cases:
  1. Single territory, current quarters → expected row count
  2. Multiple territories, current quarters → expected row count
  3. Empty `validTerritories` → returns input unchanged (territory filter skipped)
  4. Quarter column missing → returns territory-filtered, quarter pass-through (warns in current code; pure version returns silently)
  5. Territory column missing → returns input unchanged
- Test file: `test/unit/ccsp-row-filter.test.ts` — runs under `bun test test/unit/`, gating before Playwright per existing unit_test_gate rule.

**Why this is the golden-file target and not the others:**
- `ccsp-cache` touches Drive API (network IO) and module state — not pure.
- `ccsp-tableau-fetch` requires a live `Page` and SSO state — not pure.
- `ccsp-row-filter` is string-in / string-out. It is also the highest-leverage correctness surface: every cache tier and the live path funnel through it, and BKL-CCSP-04 / BKL-PERF-04 / BKL-CCSP-CSV-01 are all client-side filter bugs.

---

### What stays in `scrapeOneAe` after extraction

```ts
async function scrapeOneAe(page: Page, ae: AE, podBookingsFolderId?: string): Promise<CcspResult> {
  const territories = ae.tableauTerritories ?? []
  const validTerritories = territories.filter(t => /^[A-Z0-9_]+$/.test(t) || (console.warn(...), false))
  const { years, quarters, label } = getRollingFyWindow()
  const territoryFilters = validTerritories.length > 0
    ? parseTerritoryParts(validTerritories[0])
    : { pod: '', subregion: '', segment: 'Commercial', subsegment: 'Commercial', region: 'NA_COMM_COMMERCIAL' }
  const pod = territoryFilters.pod

  // Tier 1
  const mem = await ccspCache.tryMemoryCache(pod)
  if (mem.hit) return { aeName: ae.name, rows: filterRowsForAe(mem.rows!, validTerritories, quarters), accountPeriod: mem.period! }

  // Tier 2
  if (podBookingsFolderId) {
    const drv = await ccspCache.tryDriveCache(pod, podBookingsFolderId)
    if (drv.hit) return { aeName: ae.name, rows: filterRowsForAe(drv.rows!, validTerritories, quarters), accountPeriod: drv.period! }
  }

  // L4 leader gate
  if (!isPrimary()) return { aeName: ae.name, rows: [], accountPeriod: label }

  // Live
  const { rows } = await fetchPodCsv({ page, aeName: ae.name, territoryFilters, validTerritories, years, quarters })
  await ccspCache.writeCaches(pod, rows, label, podBookingsFolderId)
  return { aeName: ae.name, rows: filterRowsForAe(rows, validTerritories, quarters), accountPeriod: label }
}
```

**Estimated post-refactor metrics for `scrapeOneAe`:**
- Lines: **~30** (down from 434)
- Cyclomatic: **~6** (down from 89) — one early-return per cache tier, one leader gate, one happy path

These are estimates derived from the orchestrator sketch above. Marcus should measure with `npx eslint --rule 'complexity: [error, 1]' src/ccsp-scraper.ts` (or equivalent) post-extraction and adjust if drift is meaningful.

---

## Trade-offs & Decisions

| Decision | Rationale |
|----------|-----------|
| Three modules, not five | Five (URL build + nav + SSO + download + classify) over-fragments. The SSO handshake is coupled to the navigation event (it fires when nav lands on `/auth`). Splitting them creates a state-passing problem with no readability win. |
| `ccsp-cache` owns both tiers | Tiers share state (Drive hit populates memory; memory file-id check requires Drive metadata). Splitting would push state coordination back into the orchestrator. |
| `_tableauSessionExpired` moves with `ccsp-tableau-fetch` | The flag is meaningful only inside the live path; the status endpoint reads it via the existing `consumeTableauSessionExpired` accessor, which can be re-exported from `ccsp-scraper.ts` for a zero-diff public surface. |
| `ccsp-row-filter` is pure | This is the lever for golden-file tests and the only surface where unit tests can lock in behavior without a browser. |

---

## SCRAPER-RULES Invariants — Constraint Audit

| Rule | Invariant | Preserved by |
|------|-----------|--------------|
| Shared BrowserContext (ADR-015, ADR-001) | Tableau SSO and CSV fetch must occur in the same context | `ccsp-tableau-fetch` accepts `page` from caller; never creates its own context |
| CCSP two-phase mutex (`ccspScrapeRunning \|\| ccspInFlight`) | Both flags must gate live scrapes | Mutex stays in `runCcspScrape`; orchestrator calls extracted modules under the existing guard |
| `_ctx.newPage()` 30s `Promise.race` (BKL-CCSP-06) | Page creation must time out | Page creation stays in `runCcspScrape`; `ccsp-tableau-fetch` receives the already-wrapped page |
| `_tableauSessionExpired` lifecycle | Set inside SSO wait, consumed by `consumeTableauSessionExpired()` | Entire flag (set, clear, accessors) moves to one owner module — coherence strengthened, not weakened |
| CCSP territory filter derivation (BKL-CCSP-05) | Territory-aware Segment/Subsegment/Region/POD parsing | `parseTerritoryParts` stays in `ccsp-scraper.ts` (or moves to a shared `lib/`); both `ccsp-tableau-fetch` and orchestrator import it. No logic change. |
| No parallelism in scrapers | Sequential per-AE | Orchestrator structure unchanged — still called serially from `runCcspScrape`'s for-loop |
| Auth pre-flight before startup scrape | RH session checked before scrape | Lives in `runCcspScrape` — out of decomposition scope |

**No invariant is moved, weakened, or restructured.** Every constraint that was true before is true after, with the same enforcement point or a strictly narrower one.

---

## Implementation Plan (for Marcus)

Recommended order — each step is a stand-alone PR-able unit:

1. **Extract `ccsp-row-filter.ts` first** (the pure function). Add `test/unit/ccsp-row-filter.test.ts` with the golden-file fixture. Replace the three duplicated filter blocks in `ccsp-scraper.ts` with calls to `filterRowsForAe`. Run `bun test test/unit/` then full Playwright. **Smallest, lowest-risk change; locks in the golden-file gate before any structural move.**
2. **Extract `ccsp-cache.ts`**. Move `_podCsvCache`, `POD_CSV_CACHE_TTL_MS`, the memory-tier block, the Drive-tier block, and the cache-write block. Add unit tests for the pure parts of cache logic (header normalization, freshness check) where possible; integration coverage stays in Playwright.
3. **Extract `ccsp-tableau-fetch.ts`**. Move `_tableauSessionExpired` + accessors, URL build, navigation, SSO wait loop, download, classification. Re-export `consumeTableauSessionExpired` / `peekTableauSessionExpired` from `ccsp-scraper.ts` to keep the public surface stable for `scraper-manager.ts` and status endpoints.
4. **Reduce `scrapeOneAe`** to the orchestrator sketch. Measure cyclomatic and lines; report deltas in the PR description.

Each step ships with: (a) test gate green on 7776, (b) `make rebuild`, (c) post-rebuild Quinn pass on 7777, (d) BACKLOG.md status updated.

---

## Testing Strategy

- **Unit (new):** `test/unit/ccsp-row-filter.test.ts` — golden-file, 5 cases above. Gates before Playwright.
- **Integration (existing):** `test/regression.spec.ts` CCSP cases continue to validate end-to-end behavior — should pass without modification because the orchestrator's externally-observable behavior is unchanged.
- **Bootstrap E2E (existing):** `test/bootstrap-e2e.spec.ts` exercises the cache write-back path; should pass unchanged.
- **What we are NOT testing live:** the Tableau SSO handshake (requires VNC). Coverage stays via the existing `_tableauSessionExpired` flag exposed to status endpoints.

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Module-level state move (`_podCsvCache`) introduces race or stale-read | Low (single-threaded Bun) | Single owner; expose `_resetMemoryCacheForTests` for snapshot/restore in tests |
| `_tableauSessionExpired` consumer (status endpoint) breaks on import path change | Medium | Re-export from `ccsp-scraper.ts` as a deliberate compatibility layer |
| Golden-file fixture drifts as Tableau adds/removes columns | Low | Test reads columns by normalized header name (same as production code), not by index |
| Step 3 (live-fetch extraction) regresses SSO recovery | Medium | Manual VNC test required after step 3; no programmatic substitute exists |

---

## Acceptance Criteria (line-level, for Marcus completion report)

- [ ] `src/ccsp-row-filter.ts` exists; exports `filterRowsForAe(rows, validTerritories, quarters)`; pure (no imports from `googleapis`, no `Date.now`, no `process.env`).
- [ ] `test/unit/ccsp-row-filter.test.ts` exists with 5 cases; passes under `bun test test/unit/`.
- [ ] `src/ccsp-cache.ts` exists; owns `_podCsvCache` (no longer declared in `ccsp-scraper.ts`); exports `tryMemoryCache`, `tryDriveCache`, `writeCaches`.
- [ ] `src/ccsp-tableau-fetch.ts` exists; owns `_tableauSessionExpired` (no longer declared in `ccsp-scraper.ts`); exports `fetchPodCsv`, `consumeTableauSessionExpired`, `peekTableauSessionExpired`.
- [ ] `ccsp-scraper.ts` re-exports `consumeTableauSessionExpired` and `peekTableauSessionExpired` so external callers (status endpoint, scraper-manager) need no edits.
- [ ] `scrapeOneAe` body is ≤ 50 lines; cyclomatic ≤ 10 (measured, not estimated).
- [ ] No call to `getScrapeContext()` or `launchPersistentContext` introduced in any new file.
- [ ] Full Playwright suite green on 7776 and 7777 post-rebuild.

---

## What this brief explicitly does NOT do

- Does **not** reopen ADR-015. Shared-context-for-SSO is a given.
- Does **not** introduce parallelism, retries, or backoff.
- Does **not** propose new abstractions (interfaces, classes, factories) beyond the three named module boundaries.
- Does **not** change `parseTerritoryParts`, `getRollingFyWindow`, or `parseCsvToObjects`.
- Does **not** touch `runCcspScrape`, `scrapePodCcspRaw`, or `filterCcspRowsForAe` (the existing exported helper at line 1268 — note the name collision; Marcus should rename one to disambiguate during step 1).
