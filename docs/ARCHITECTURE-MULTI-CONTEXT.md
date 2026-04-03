# Multi-Context Browser Architecture for Parallel Supportable Scraping

**Date:** 2026-04-01
**Author:** Serena Blackwood (Architect Agent)
**Status:** DESIGN COMPLETE -- Pending implementation decision
**Related:** BKL-M57, AUTH-SCRAPER-AUDIT.md, ADR-001, ARCHITECTURE.md Section 1
**Scope:** Supportable 360 parallel scraping. Does not change RH, CCSP, or SF scrapers.

---

## 1. Problem Statement

Supportable 360 scraping is the system's primary bottleneck. At 22 customers (~44 account numbers), a full scrape takes ~66 minutes sequential. At 200 customers, it exceeds 5 hours even with ADR-008 batch rotation.

The root cause is `PARALLEL_PAGES=1`. Oracle APEX shares server-side session state across all pages within a single `BrowserContext` because cookies (especially the APEX session cookie) are shared. When multiple pages attempt concurrent APEX operations, they collide -- one page's form submission overwrites another's ViewState, producing DOM context destruction, error dialogs, and partial data.

Testing confirmed (2026-04-02):
- 5 parallel pages, 1 context: discovery worked, scraping crashed
- 3 parallel pages with stagger: partial success (some customers got 0 rows)
- 1 sequential page: all data correct (current stable state)

The fundamental constraint is **cookie isolation**. Two APEX pages cannot share cookies and operate independently.

---

## 2. Current State Architecture

```
                    RH SSO Login (VNC)
                         |
                         v
              launchPersistentContext(profileDir)
                         |
                         v
            +------ BrowserContext ------+  (single instance, _ctx)
            |      (shared cookies)      |
            |                            |
            |   _livePage (RH keep-alive)|  <-- preserves sessionStorage/PKCE
            |                            |
            +---+--------+--------+------+
                |        |        |
                v        v        v
           rh-scraper  ccsp   supportable
           (adopted)  (adopted) (adopted)
                |
                v
           sf-scraper
           (adopted, but can also initSfContext independently)
```

### Cookie Flow

```
profileDir/  (persistent Chromium profile on /data/rh-profile/)
    |
    v
BrowserContext._ctx
    |-- rh_sso_session cookie (~14h TTL) -- RH Portal auth
    |-- TAsessionID cookie (~30-90 min) -- RH Portal short-lived
    |-- Keycloak SSO cookies -- shared IdP session
    |-- Tableau Cloud session cookies (~8-24h) -- CCSP auth
    |-- APEX session cookie -- Supportable auth (VPN required)
    |-- SF sid cookie -- Salesforce auth
    |
    +-- ALL pages in this context share ALL cookies
```

### Ownership Model

| Module | Context Role | Lifecycle |
|--------|-------------|-----------|
| `rh-scraper.ts` | OWNER. Creates via `initScrapeContext()`. Destroys via `closeScrapeContext()`. Runs 8-min keep-alive. | Process lifetime |
| `rh-auth.ts` | CREATOR. Launches headed browser for initial login. Hands off to rh-scraper via `adoptScrapeContext()`. | Login flow only |
| `ccsp-scraper.ts` | CONSUMER. Receives via `adoptCcspContext()`. Creates ephemeral pages. Never closes context. | Depends on RH context |
| `supportable-scraper.ts` | CONSUMER. Receives via `adoptSupportableContext()`. Creates ephemeral pages. Never closes context. | Depends on RH context |
| `sf-scraper.ts` | HYBRID. Has `initSfContext()` (own persistent context) AND `adoptSfContext()` (shared context). Prefers adopted. | Can outlive RH context |

### Why Supportable Cannot Parallelize Today

```
Context (_ctx) -- one cookie jar
    |
    +-- Page A: navigate to APEX, submit account 12345
    |     APEX sets session cookie: ORA_APEX_SESSION=abc123
    |
    +-- Page B: navigate to APEX, submit account 67890
    |     APEX OVERWRITES session cookie: ORA_APEX_SESSION=def456
    |
    +-- Page A: clicks Export tab
    |     Sends ORA_APEX_SESSION=def456 (Page B's session!)
    |     APEX: "session mismatch" --> error dialog / page close
```

---

## 3. Solution Path Evaluation

### Path A: Multi-BrowserContext (Full Cookie Isolation)

**Approach:** Switch Supportable scraping from `_ctx.newPage()` to `browser.newContext()` per worker. Each context has its own cookie jar, so each APEX session is fully isolated.

**Architecture change required:** The current system uses `launchPersistentContext()` which returns a BrowserContext directly -- there is no separate Browser object to call `newContext()` on. Multi-context requires switching to `chromium.launch()` (returns a Browser), then creating contexts from it.

**Auth challenge:** New contexts have zero cookies. Supportable requires RH SSO authentication. Two sub-options:

- **A1: storageState transfer.** After RH login, call `_ctx.storageState()` and use the resulting cookies/localStorage to bootstrap new contexts via `browser.newContext({ storageState })`. This is Playwright's documented pattern for auth reuse.

- **A2: Per-context SSO login.** Each new context navigates to Supportable, triggers SSO redirect, and completes login using the persistent profile's cookies. This is redundant and slow.

**Verdict on A1 vs A2:** A1 (storageState transfer) is the correct approach. The persistent context holds the RH SSO cookies. `storageState()` exports them. New contexts import them. The SSO cookies (rh_sso_session, Keycloak tokens) authenticate the user across all Red Hat properties including Supportable. Each context gets its own APEX session cookie on first navigation.

**Memory cost:** ~50-100MB per additional BrowserContext. At 3-5 parallel contexts, this is 150-500MB additional. Fits within the 4GB container memory limit.

### Path B: APEX HTTP Fast-Path (page.content() Extraction)

**Approach:** Instead of interacting with the APEX DOM (clicking Export, selecting format, downloading CSV), extract data directly from the raw HTML returned by `page.content()`. If APEX server-renders the subscription data into the HTML response, we can parse it without any DOM interaction.

**Key insight from RES01 research:** APEX has a dual render mode. If the data table is server-rendered (present in initial HTML), we can skip all DOM interaction. The extraction becomes: `page.goto()` then `page.content()` then parse HTML string. No clicks, no downloads, no ViewState conflicts.

**Why this might solve parallel without multi-context:** If we never interact with the DOM (no clicks, no form submissions), the pages do not trigger APEX server-side session state changes. Multiple pages could each do `goto()` + `content()` in the same context because they are read-only operations that do not mutate the APEX session.

**Critical question:** Does the Supportable export page (page 22, SalesReport layout) include subscription data in the server-rendered HTML? Or does it require a client-side AJAX call to populate?

**Assessment:** Based on the current scraper flow (navigate to page 22, select "Sales Export Format" saved report, Actions > Download > CSV), the data is NOT in the initial HTML of page 22. It requires server-side report execution triggered by the Actions menu. However, page 1 (after entering account number and clicking Go) may contain the subscription summary in its HTML. This needs empirical testing.

**Risk:** Even if page.content() works for extraction, we still need to navigate and submit account numbers, which means APEX session state IS being mutated. The `goto()` with account number in URL params may work, but the "Go" button click certainly triggers server-side state. Path B may reduce but not eliminate session contention.

### Path Comparison

| Criterion | Path A (Multi-Context) | Path B (HTTP Fast-Path) |
|-----------|----------------------|------------------------|
| Cookie isolation | Complete -- guaranteed | Partial -- avoids writes but session still shared |
| Architecture change | Significant -- new Browser lifecycle | Minimal -- extraction logic change only |
| Risk to existing scrapers | Medium -- must preserve shared context for CCSP/RH | Low -- only changes Supportable extraction |
| Parallelism guarantee | Strong -- each context is independent | Uncertain -- depends on APEX rendering mode |
| Fallback complexity | Medium -- restore path to single context | Low -- revert to current DOM extraction |
| Memory cost | +150-500MB | None |
| Implementation effort | L (3-5 days) | S (1-2 days) |

### Recommendation

**Implement Path B first (lower risk). If it does not achieve full parallelism, implement Path A.**

Path B is a pure logic change inside `supportable-scraper.ts`. It does not touch the browser lifecycle, does not affect other scrapers, and can be tested incrementally. Even if it only partially solves the problem, it provides value: faster per-account extraction even at PARALLEL_PAGES=1.

Path A is the correct long-term solution but requires careful architecture work to avoid breaking CCSP/Tableau SSO passthrough and the RH keep-alive pattern.

---

## 4. Target State Architecture (Path A)

If Path B is insufficient, implement this architecture.

```
                    RH SSO Login (VNC)
                         |
                         v
              launchPersistentContext(profileDir)
                         |
                         v
        +--------- PRIMARY CONTEXT ---------+   (persistent, _ctx)
        |        (shared cookies, owned       |
        |         by rh-scraper.ts)           |
        |                                     |
        |   _livePage (RH keep-alive)         |
        |                                     |
        +---+-----------+-----------+---------+
            |           |           |
            v           v           v
       rh-scraper   ccsp-scraper  sf-scraper
       (uses _livePage) (ephemeral  (adopted or
                        pages)     own context)
            |
            v
     storageState() export  <-- on demand, cached, refreshed every keep-alive
            |
            +-----> Supportable Worker Pool
                    |
        +-----------+-----------+
        |           |           |
        v           v           v
    WorkerCtx-1  WorkerCtx-2  WorkerCtx-3
    (isolated    (isolated    (isolated
     cookies)     cookies)     cookies)
        |           |           |
        v           v           v
    Page: APEX   Page: APEX   Page: APEX
    acct 12345   acct 67890   acct 11111
    ORA_APEX_    ORA_APEX_    ORA_APEX_
    SESSION=a    SESSION=b    SESSION=c
```

### 4.1 Component Changes

**New: SupportableWorkerPool** (in `supportable-scraper.ts` or new `supportable-worker.ts`)

```
Responsibilities:
- Manages N BrowserContext instances (N = PARALLEL_PAGES, default 3)
- Creates contexts from the PRIMARY context's Browser object
- Bootstraps each context with storageState from primary
- Assigns account numbers to workers round-robin
- Collects results, handles per-worker failures
- Closes worker contexts after batch completes
```

**Changed: Browser Lifecycle**

```
BEFORE:
  chromium.launchPersistentContext(profileDir) --> BrowserContext
  (no Browser object accessible)

AFTER:
  chromium.launch() --> Browser
  browser.newContext({ storageState: profileDir }) --> PRIMARY BrowserContext
  browser.newContext({ storageState: exportedState }) --> WORKER BrowserContext (x N)
```

CRITICAL: `launchPersistentContext()` does not expose a `Browser` object that supports `newContext()`. The persistent context IS the browser -- you cannot create additional contexts from it. This is the fundamental reason the current architecture cannot parallelize.

The migration must switch to `chromium.launch()` + `browser.newContext()` for the primary context. The persistent profile directory becomes the `storageState` source rather than the Chromium user data directory.

**Unchanged: CCSP, RH, SF scrapers** -- They continue using the PRIMARY context exactly as today.

### 4.2 Auth Flow for Worker Contexts

```
Step 1: User logs into RH Portal (unchanged -- VNC + persistent context)
            |
            v
Step 2: Primary context has SSO cookies
            |
            v
Step 3: Before Supportable batch starts:
            primaryCtx.storageState() --> { cookies: [...], origins: [...] }
            |
            v
Step 4: For each worker context:
            browser.newContext({ storageState: step3Result })
            |-- Worker now has rh_sso_session, Keycloak cookies
            |-- Worker navigates to Supportable URL
            |-- Supportable SSO redirect auto-completes (cookies present)
            |-- APEX assigns NEW session cookie to THIS context
            |-- Worker is fully authenticated with isolated APEX session
            |
            v
Step 5: Worker scrapes assigned accounts (parallel, no contention)
            |
            v
Step 6: Worker context closed after batch completes
```

**Key question: Does storageState export work for Supportable SSO?**

Yes. The Supportable SSO flow is: browser requests `supportable.corp.redhat.com` --> redirect to `sso.redhat.com` --> Keycloak checks for existing SSO session cookie --> if present, issues SAML assertion --> redirect back to Supportable --> APEX creates session. The `storageState()` export includes the `rh_sso_session` and Keycloak session cookies that make this transparent.

**Caveat:** `storageState()` exports cookies and localStorage but NOT sessionStorage. The primary context's `_livePage` preserves sessionStorage for the RH keep-alive's Keycloak `updateToken()` call. Worker contexts will not have this sessionStorage. This is fine -- workers do not run keep-alive. They authenticate via cookie-based SSO redirect, not Keycloak JS adapter.

### 4.3 Impact on _livePage Pattern

The `_livePage` in `rh-scraper.ts` is the original login page kept alive to preserve sessionStorage (PKCE state, Keycloak adapter JS state). It is used exclusively by the 8-minute keep-alive timer.

**Impact of multi-context on _livePage:**

| Concern | Impact | Mitigation |
|---------|--------|------------|
| _livePage must stay in PRIMARY context | None -- it already is. Worker contexts do not affect it. | N/A |
| Keep-alive fires during Supportable batch | Low -- keep-alive navigates _livePage, which is in primary context. Workers are in separate contexts. No conflict. | N/A |
| Session expiry during Supportable batch | Medium -- if RH session expires, workers' cookies become invalid. Workers will fail on their next APEX navigation with an SSO redirect. | Workers detect SSO redirect (URL check) and abort cleanly. Partial results are preserved. |
| _livePageBusy flag | None -- only set by Tableau login flow, not Supportable. | N/A |

**Conclusion:** The _livePage pattern is unaffected by multi-context. It operates in the primary context, and worker contexts are ephemeral.

### 4.4 Impact on CCSP/Tableau SSO Passthrough

CCSP/Tableau requires the shared browser context because Tableau SSO passthrough relies on RH SSO cookies present in the context. CCSP never runs concurrently with Supportable (both are scheduled scrapes with mutual exclusion via mutexes).

**Impact:** None. CCSP continues using the PRIMARY context. Worker contexts are created only during Supportable batches and destroyed after.

**Scheduling safety:** The Supportable scheduler (7:00am ET) and CCSP scheduler (6:30am ET) already have non-overlapping windows. The `supportableScrapeRunning` and `ccspScrapeRunning` mutexes prevent concurrent execution. Worker contexts are created inside the Supportable mutex window and destroyed before release.

### 4.5 Impact on SF Scraper

SF scraper has a dual-mode design:
- **Adopted mode:** Uses the shared context from RH login (via `adoptSfContext()`)
- **Independent mode:** Creates its own persistent context (via `initSfContext()`)

**Impact:** None. SF scraper either shares the PRIMARY context (unchanged) or creates its own. It never interacts with worker contexts. The `initSfContext()` call in `scrapeSfReport()` is guarded by `if (_context) return` -- if the context was already adopted, it does not create a new one.

### 4.6 Session Persistence Across Restarts

**Current behavior:**
- Persistent Chromium profile at `data/rh-profile/` stores cookies across restarts
- `session-state.json` stores exported storageState as backup
- `restoreSessionCookies()` re-imports cookies on startup if profile cookies expired

**Multi-context impact:**
- Worker contexts are ephemeral -- they do not persist across restarts
- The PRIMARY context continues to use the persistent profile directory
- `session-state.json` continues to work as-is
- Workers are only created during active Supportable batches, which happen after startup

**Migration from launchPersistentContext to launch + newContext:**

This is the highest-risk change. Today, `launchPersistentContext(profileDir)` means Chromium reads/writes cookies to `profileDir` automatically. With `chromium.launch()` + `browser.newContext()`, the profile directory is not used for automatic cookie persistence.

**Two approaches to maintain persistence:**

**Approach 1: Hybrid lifecycle (RECOMMENDED)**
Keep `launchPersistentContext()` for the PRIMARY context. Do NOT migrate to `chromium.launch()`. Instead, use the persistent context's `browser()` handle -- but note: `launchPersistentContext` returns a BrowserContext whose `.browser()` returns a Browser, but this Browser's `newContext()` creates contexts that share the underlying Chromium process (and its profile directory).

Wait -- this is the critical architectural finding: **`launchPersistentContext().browser().newContext()` DOES create isolated contexts.** Each context has its own cookie jar, localStorage, and session storage. They share the Chromium process (same binary, same memory pool) but NOT cookies. This is documented Playwright behavior.

If this works, we do NOT need to migrate away from `launchPersistentContext()`. The primary context keeps its persistent profile. Worker contexts are created from the same Browser instance with `storageState` injection.

**Verification needed:** Confirm that `context.browser().newContext({ storageState })` works on a context returned by `launchPersistentContext()`. Playwright docs suggest `browser()` returns the Browser only for contexts created via `browser.newContext()`, not for persistent contexts. If `.browser()` returns null for persistent contexts, we need Approach 2.

**Approach 2: Full migration to launch + newContext**
```
chromium.launch(browserArgs) --> browser
browser.newContext({ storageStatePath: profileDir + '/Default/...' }) --> primaryCtx
browser.newContext({ storageState: exported }) --> workerCtx1
browser.newContext({ storageState: exported }) --> workerCtx2
```

This loses automatic cookie persistence to the profile directory. We must explicitly save and restore:
- Save: After each keep-alive, `primaryCtx.storageState({ path: sessionStateFile })`
- Restore: On startup, `browser.newContext({ storageState: sessionStateFile })`

This is already partially implemented (`persistSessionState()` and `restoreSessionCookies()`), but it becomes the ONLY persistence mechanism instead of a backup.

---

## 5. Path B: HTTP Fast-Path Detailed Evaluation

### What We Need to Verify

The Supportable flow today is:
1. Navigate to page 1 (landing)
2. Enter account number in P0_ACCOUNT_NUMBER field
3. Click "Go" button
4. Wait for Export tab/link to appear
5. Click Export (last anchor) -- navigates to page 22
6. Select "Sales Export Format" saved report
7. Actions > Download > CSV
8. Intercept download, parse CSV

Steps 2-7 all involve DOM interaction that mutates APEX server-side state.

### Fast-Path Hypothesis

If we can construct a URL that directly renders the subscription data as HTML (page 22 with account number and report preset), we could:
1. `page.goto(constructedUrl)` -- single navigation, no clicks
2. `const html = await page.content()` -- get server-rendered HTML
3. Parse HTML for data table rows
4. No DOM interaction, no APEX session mutation

### What Needs Testing

1. **URL structure:** Does `f?p=304:22:SESSION_ID::NO:RP:P22_ACCOUNT_NUMBER:12345` work to load page 22 directly with an account number? APEX URL syntax supports passing item values.

2. **Session ID requirement:** APEX URLs include a session ID segment. Each context/page gets its own session ID on first navigation. Can we extract the session ID from the initial navigation and construct URLs with it?

3. **Server-side rendering:** Does page 22 with the Sales Export Format report render subscription rows in the HTML, or does it require additional AJAX calls?

4. **Data completeness:** The CSV download currently provides all fields (subscription number, product, status, start/end dates, support level, etc.). Does the HTML table on page 22 contain the same fields?

### Risk Assessment for Path B

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Page 22 data requires AJAX, not in initial HTML | High | Path B fails entirely | Fall through to Path A |
| URL construction does not bypass Go button | Medium | Still need DOM interaction | May still reduce steps (skip download flow) |
| HTML table has fewer columns than CSV export | Medium | Data loss | Compare field sets, supplement from page 1 if needed |
| APEX session ID changes between requests | Low | URL construction breaks | Extract session ID per-page, refresh as needed |
| Supportable admin disables direct URL access | Low | Page 22 redirect blocked | Fall through to Path A |

### Partial Path B: Hybrid Approach

Even if full Path B does not work, a hybrid is valuable:

1. Navigate to page 1 normally (single page, sequential)
2. Submit account number + click Go (DOM interaction, sequential)
3. When on page 22: use `page.content()` to extract HTML table instead of CSV download
4. This eliminates: Actions menu click, Download button, CSV format selection, download stream interception

This hybrid saves ~20-30 seconds per account (download flow) even without parallelism. At 44 accounts, that is 15-22 minutes saved.

---

## 6. Migration Plan

### Phase 0: Empirical Testing (1 day)

Before any code changes, test two things manually via VNC:

1. Open Supportable page 22 with an account number in the URL (try APEX URL parameters)
2. View page source on page 22 -- is the data table server-rendered?

These two tests determine whether Path B is viable.

### Phase 1: Path B Implementation (1-2 days, low risk)

**Prerequisite:** Phase 0 confirms data is accessible via HTML.

1. Add `extractFromHTML(html: string)` function to `supportable-scraper.ts`
   - Parses HTML table rows from page.content() output
   - Returns same data structure as CSV parsing

2. Modify per-account scrape flow:
   - After navigating to page 22 (current Export tab click)
   - Try `page.content()` extraction FIRST
   - If successful, skip CSV download flow entirely
   - If extraction returns 0 rows, fall back to CSV download (current behavior)

3. Measure: time per account should drop from ~90s to ~40-50s

**Rollback:** Remove `extractFromHTML` call, revert to CSV-only path. No architecture changes to undo.

### Phase 2: Parallel Testing with Path B (1 day, medium risk)

If Phase 1 succeeds:

1. Set `PARALLEL_PAGES=3` temporarily
2. Run against 6 test accounts (2 per page)
3. Observe: do parallel pages with content()-only extraction avoid APEX session collision?
4. If yes: Path B solves the problem. Skip Path A.
5. If no: Proceed to Phase 3.

**Rollback:** Set `PARALLEL_PAGES=1`.

### Phase 3: Multi-Context Architecture (3-5 days, higher risk)

Only if Phases 1-2 do not achieve sufficient parallelism.

**Step 3a: Verify Browser.newContext() availability**
Test whether `launchPersistentContext().browser().newContext()` works. This determines whether we use Approach 1 (hybrid) or Approach 2 (full migration).

**Step 3b: Implement SupportableWorkerPool**
- New function: `createWorkerContext(storageState)` -- creates isolated context
- New function: `runWorkerBatch(workerCtx, accountNumbers)` -- scrapes accounts in one context
- Modify `scrapeAllAccounts()` to distribute accounts across N workers
- Worker count configurable: `PARALLEL_PAGES` env var (default 3, max 5)

**Step 3c: Integrate with existing lifecycle**
- `storageState()` export happens before batch start
- Worker contexts created inside `supportableScrapeRunning` mutex window
- Worker contexts destroyed in `finally` block (guaranteed cleanup)
- Primary context unchanged -- CCSP, RH, SF continue using it

**Step 3d: If Approach 2 required -- migrate primary context**
- Replace `launchPersistentContext()` in `initScrapeContext()` with `chromium.launch()` + `browser.newContext()`
- Move cookie persistence to explicit save/restore cycle
- Update `rh-auth.ts` `startLoginBrowser()` to use launch + newContext pattern
- Update all `adoptXxxContext()` calls to receive the new context type

**Rollback per step:**
- 3b: Remove worker pool, revert to single-page sequential
- 3c: Revert scrapeAllAccounts() to original
- 3d: Revert to launchPersistentContext() -- most disruptive rollback

### Phase 4: Validation and Tuning (1-2 days)

1. Run full Supportable batch with parallel workers against all customers
2. Verify data completeness: every customer should have same row count as sequential
3. Monitor memory: `process.memoryUsage()` + container RSS
4. Tune PARALLEL_PAGES: find optimal balance between speed and stability
5. Verify RH keep-alive still works during parallel batch
6. Verify CCSP can still scrape after a parallel Supportable batch completes

---

## 7. Restore Path (Emergency Rollback)

If multi-context causes production issues after deployment:

### Immediate Rollback (< 5 minutes)

1. Set environment variable: `PARALLEL_PAGES=1`
2. Restart container: `make rebuild`
3. System reverts to sequential single-context scraping
4. No code changes needed -- the worker pool code path is gated behind `PARALLEL_PAGES > 1`

### Code Rollback (if architecture migration was done)

If Phase 3d (full migration to launch + newContext) was implemented and causes issues:

1. Git revert the migration commit(s)
2. `make rebuild`
3. System returns to `launchPersistentContext()` pattern

**Critical safeguard:** The `PARALLEL_PAGES` env var must gate ALL multi-context code paths. At `PARALLEL_PAGES=1`, the system must behave identically to the pre-migration state. This is the restore path contract.

### Data Safety

Worker contexts do not write to the persistent profile directory. If workers crash or produce bad data:
- The stale-overwrite guard in `supportable-scraper.ts` prevents empty results from overwriting good sheet data
- Each customer's sheet tab is written independently -- a failure for one customer does not affect others
- The primary context's cookie state is never modified by workers

---

## 8. Risk Matrix

| Risk | Severity | Likelihood | Phase | Mitigation |
|------|----------|-----------|-------|------------|
| `browser().newContext()` returns null on persistent context | HIGH | Medium | 3a | Test early. If confirmed, use Approach 2. |
| storageState export missing critical SSO cookies | HIGH | Low | 3b | Compare exported cookies with browser DevTools. SSO cookies are standard HTTP cookies, not httpOnly-restricted from export. |
| Worker context fails Supportable SSO redirect | HIGH | Low | 3b | Worker navigates to Supportable URL; if SSO redirect fails, log and fall back to primary context (sequential). |
| Memory pressure from 3-5 additional contexts | MEDIUM | Medium | 3b | Monitor RSS. Set PARALLEL_PAGES=2 if memory tight. Each context is ~50-100MB. |
| CCSP breaks after multi-context migration | HIGH | Low | 3d | CCSP uses PRIMARY context, unchanged. But if primary context behavior changes (Approach 2), verify Tableau SSO still works. |
| RH keep-alive fails with new Browser lifecycle | HIGH | Low | 3d | Keep-alive uses _livePage in primary context. If primary context is now non-persistent, verify sessionStorage preservation. |
| APEX rate-limits parallel connections from same IP | MEDIUM | Low | 3b | Supportable is an internal Red Hat tool on VPN. Rate limiting is unlikely. If detected: reduce PARALLEL_PAGES. |
| Container restart loses all sessions (Approach 2) | HIGH | Medium | 3d | Explicit storageState save on every keep-alive tick + SIGTERM handler. Already partially implemented. |
| Worker context leaks (not closed on error) | MEDIUM | Medium | 3b | `finally` block with `context.close()`. Stale worker detection: close any context older than 30 minutes. |
| Partial scrape: some workers succeed, some fail | LOW | High | 3b | Expected behavior. Preserve partial results. Log per-worker success/failure. Retry failed accounts in next batch. |

---

## 9. Decision Framework

```
Start
  |
  v
Phase 0: Can page 22 data be extracted from HTML?
  |
  +-- YES --> Phase 1: Implement HTML extraction
  |             |
  |             v
  |           Phase 2: Test parallel with HTML-only extraction
  |             |
  |             +-- Parallel works --> DONE (Path B solved it)
  |             |
  |             +-- Parallel fails --> Phase 3: Multi-Context
  |
  +-- NO --> Phase 1 (hybrid): Use HTML for partial speedup (skip download)
               |
               v
             Phase 3: Multi-Context (required for parallelism)
```

### Success Criteria

| Metric | Current | Target (Path B) | Target (Path A) |
|--------|---------|-----------------|-----------------|
| Time per account | ~90s | ~40s | ~30s (parallel) |
| Total time, 44 accounts | ~66 min | ~30 min | ~15-20 min |
| Total time, 200 accounts (batch of 67) | ~100 min | ~45 min | ~20-25 min |
| Data completeness | 100% | 100% | 100% (with partial result handling) |
| Memory overhead | Baseline | +0 | +150-300MB |

---

## 10. Architectural Principles Applied

**Fundamental constraint identification:** The constraint is not "Playwright cannot handle parallel pages." It is "Oracle APEX ties server-side session state to browser cookies." This is a vendor constraint, not a tool constraint. The solution must address cookie isolation, not page management.

**Simplest solution first:** Path B (content extraction) is simpler, lower risk, and may be sufficient. Do not build multi-context unless empirically necessary.

**Preserve what works:** The shared browser context is correct for RH/CCSP/SF. Multi-context is ONLY for Supportable workers. The primary context's lifecycle, keep-alive, and SSO passthrough must remain unchanged.

**Fallback at every step:** Each phase has a defined rollback. The `PARALLEL_PAGES=1` env var is the emergency brake. No phase burns bridges with the previous state.

**Memory budget:** Worker contexts are ephemeral (created for batch, destroyed after). The steady-state memory footprint does not change. Peak memory increases by ~50-100MB per worker during Supportable batches only.
