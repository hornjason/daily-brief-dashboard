---
Last validated: 2026-04-24
---

# Auth & Scraper Enterprise Readiness Audit

**Date:** 2026-04-01
**Author:** Serena Blackwood (Architect Agent)
**Scope:** Comprehensive assessment of authentication flows, browser session management, scraper reliability, startup sequencing, error visibility, and scale readiness.
**Architecture:** Single-user, single-container deployment. Each AE runs their own container instance with their own credentials. "Onboarding others" means distributing the container image — not sharing a single instance. Multi-user isolation (G2, G3 below) is NOT required.

---

## A. Auth Flows (Per External Service)

### A1. Red Hat Portal SSO

| Aspect | Current State |
|--------|--------------|
| **Initial auth** | User clicks "Connect Red Hat" in dashboard. Backend launches a headed Chromium browser (`headless: false`) via Playwright `launchPersistentContext`. User completes SSO login visually via noVNC at `localhost:6080`. Polling loop (`2s interval, 5min timeout`) detects login by checking if `page.url()` lands on `access.redhat.com/support`. |
| **Credentials stored** | Session cookies in Chromium persistent profile directory (`data/rh-profile/`). A marker file (`rh-session.json`) records login timestamp. `session-state.json` stores `storageState()` (cookies + localStorage) after each successful keep-alive or scrape. |
| **Security** | Profile dir on bind-mounted volume. Marker and state files written with `mode: 0o600`. No plaintext passwords stored anywhere. |
| **Session expiry detection** | 8-minute keep-alive timer. Hybrid path: first tries `keycloak.updateToken()` via `page.evaluate` + hydra API ping. Falls back to full page navigation. If URL does not resolve to `access.redhat.com/support` after 20s wait, fires `_onSessionExpired` callback. |
| **Recovery** | On session expiry: callback marks `rhSessionExpired = true`, defers context close if any scraper is running (cascade guard). User must click "Reconnect" to re-authenticate. On container restart: `initScrapeContext()` opens persistent context, calls `restoreSessionCookies()` from `session-state.json`. If cookies are still valid (within ~14h rh_sso_session TTL), session resumes without user action. If expired, session file exists but scrapes fail with `SessionExpiredError`. |
| **Container restart** | Persistent profile dir survives restart (bind-mounted). Cookies restored automatically. sessionStorage is NOT persisted (fundamental Playwright limitation per ADR-001). Session survives restart only if `rh_sso_session` cookie (~14h TTL) is still valid. After ~14h, full re-login required. |
| **Failure modes** | (1) SSO page changed by Red Hat (selector drift). (2) VPN required for some downstream services but not RH Portal itself. (3) Xvfb/display not ready when Chromium launches. (4) Profile lock file left by unclean shutdown (mitigated: `clearProfileLocks()` removes `SingletonLock/Socket/Cookie`). (5) Keep-alive fires during active scrape (mitigated: cascade guard defers context close). |

### A2. Salesforce

| Aspect | Current State |
|--------|--------------|
| **Initial auth** | User clicks "Connect Salesforce". Backend launches headed browser to `redhatcrm.my.salesforce.com`. Auto-clicks "Red Hat Associate Internal Login" SSO button. SAML auto-completes if RH SSO session exists in shared profile. After SF login confirmed (`lightning.force.com` URL), backend navigates a second page to RH Portal to re-establish RH context. Both scrapers then share the same context. |
| **Credentials stored** | Same Chromium profile as RH. SF session cookies (`sid`, etc.) stored in profile dir. `sf-session-state.json` with `storageState()`. Marker file for session existence. |
| **Session expiry detection** | 10-minute keep-alive timer. Opens ephemeral page to SF Home (`/lightning/n/Home`). If URL does not include `lightning.force.com`, fires `_onSessionExpired`. Also: live probe (`sfLiveProbe()`) with 30s cache for status endpoint. Frontend derives expiry from both `sessionExpired` flag and `syncError` containing "session expired". |
| **Recovery** | Manual: user clicks "Connect Salesforce" again. No automatic re-auth. |
| **Container restart** | Same profile dir persists. SF cookies restored. Session survival depends on SF's session timeout (typically 2-12 hours depending on org settings). |
| **Failure modes** | (1) SF Lightning DOM changes (treegrid, iframe, header patterns). (2) SSO auto-click fails if button text changes. (3) Report in "paused" state requiring manual Run. (4) "Show More" loop stalls if SF virtualization changes. (5) SF org-level session timeout shorter than expected. |

### A3. Google OAuth

| Aspect | Current State |
|--------|--------------|
| **Initial auth** | User visits `/oauth/start`. Redirected to Google consent screen. After approval, callback at `/oauth/callback` exchanges code for tokens. CSRF protection via `pendingOAuthStates` map with UUID tokens and 10-minute expiry. |
| **Credentials stored** | Single file `.google-token.json` in config dir with `mode: 0o600`. Contains access token, refresh token, expiry, scope level. Two scope tiers: `NORMAL_SCOPES` (read-only) and `BOOTSTRAP_SCOPES` (Drive write). |
| **Session expiry detection** | `/api/oauth/status` validates token by calling `gmail.users.getProfile()`. Checks for `invalid_grant`, `Token has been expired`, `invalid_token` errors. `makeAuth()` sets credentials from disk on every API call (googleapis client handles refresh internally using the refresh token). |
| **Recovery** | Automatic via refresh token (googleapis client refreshes transparently). If refresh token is revoked or expired (rare -- typically lasts indefinitely), user must re-authorize via `/oauth/start`. |
| **Container restart** | Token file on bind-mounted volume. Survives restart. Refresh token is long-lived. This is the most robust auth flow in the system. |
| **Failure modes** | (1) OAuth keys file (`gcp-oauth.keys.json`) missing. (2) User revokes app access in Google Account settings. (3) GCP project "Testing" mode limits to 100 users and tokens expire in 7 days (Critical for multi-user -- see Gap G1). (4) Quota exhaustion (429) -- mitigated by `withQuotaRetry()` with 61s backoff. |

### A4. Tableau (CCSP)

| Aspect | Current State |
|--------|--------------|
| **Initial auth** | No separate auth flow. Tableau SSO passthrough relies entirely on the shared browser context from RH Portal login. When navigating to `10ay.online.tableau.com`, Tableau redirects through Red Hat SSO, which auto-completes using existing cookies. |
| **Credentials stored** | None separately. Tableau session cookies live in the shared Chromium profile alongside RH and SF cookies. |
| **Session expiry detection** | Login wall detection at scrape time: checks if current URL includes `10ay.online.tableau.com` and does not include `/auth` or `/login`. Checks for password input fields. If detected, throws with "Tableau session required" message. Scheduled CCSP sync has pre-flight probe that checks for auth redirects. |
| **Recovery** | Manual: user must open Tableau in the VNC browser, complete SSO if needed. No programmatic recovery path. Bootstrap orchestrator has Tableau session-check routes. |
| **Container restart** | Depends on Tableau Cloud session cookie TTL (vendor-controlled, not documented publicly). Empirically 8-24 hours. May require VNC login after restart. |
| **Failure modes** | (1) Tableau Cloud URL or view path changes. (2) SSO redirect loop if RH session expired. (3) CSV download endpoint changes (`.csv` URL format). (4) DOM structure changes for filter dropdowns or data tables. (5) Filter value names change (Super Geo, Geo, Region, etc.). |

---

## B. Shared Browser Context

### B1. Why It Exists

The shared browser context is an architectural constraint, not a design choice. The SSO passthrough chain is:

```
RH Portal SSO login → Chromium profile gets SSO cookies
  Same profile → Salesforce SAML auto-auth (via RH IdP)
  Same profile → Tableau Cloud SSO passthrough
  Same profile → Supportable 360 SSO (VPN required)
```

All four external services authenticate through Red Hat's SSO (Keycloak). Creating isolated browser contexts per scraper would mean zero SSO cookies in each context -- Tableau and Supportable would hit their login walls immediately.

### B2. Lifecycle

| Event | Action |
|-------|--------|
| **Created** | `startLoginBrowser()` in `rh-auth.ts` calls `chromium.launchPersistentContext(profileDir)`. After login confirmed, context is transferred to `rh-scraper.ts` via `adoptScrapeContext()`. |
| **Distributed** | `adoptScrapeContext()` also calls `adoptSfContext()` and `adoptSupportableContext()`. On startup, `initBackgroundScheduler()` calls `initScrapeContext()` then distributes via `adoptSfContext()`, `adoptSupportableContext()`, `adoptCcspContext()`. |
| **Destroyed** | `closeScrapeContext()` in `rh-scraper.ts` clears all references, stops keep-alive timers, closes the context. Called on: (a) session expiry when no scrapers running, (b) before headed login browser launch (release profile lock), (c) SIGTERM/SIGINT shutdown handler. |
| **Ownership** | `rh-scraper.ts` owns the context lifecycle. `sf-scraper.ts` explicitly does NOT close the context in `closeSfContext()` -- it only clears its reference. |

### B3. Crash Recovery

If the context crashes mid-scrape:
- All scrapers holding a reference to `_ctx` will get errors on their next page operation ("Target page closed", "Context destroyed").
- Each scraper's `try/finally` block catches the error, logs it, and releases its mutex.
- The stale mutex guard (15-minute auto-release) provides a safety net if the finally block doesn't execute.
- Recovery requires user to click "Reconnect" -- there is no automatic context recreation.
- The context CANNOT be recovered without a fresh login because the persistent profile is locked by the crashed Chromium process. `clearProfileLocks()` handles this on next `initScrapeContext()` call.

### B4. Dependency Graph

```
RH Portal Login (creates context)
  |
  +-- rh-scraper.ts (owns context, runs keep-alive)
  |     |-- Uses live page (preserves sessionStorage/PKCE)
  |     |-- 8-min keep-alive timer
  |
  +-- sf-scraper.ts (adopts context, does NOT own lifecycle)
  |     |-- Creates ephemeral pages for each scrape
  |     |-- 10-min keep-alive timer (ephemeral page to SF Home)
  |
  +-- ccsp-scraper.ts (adopts context, does NOT own lifecycle)
  |     |-- Creates ephemeral page per AE per scrape
  |     |-- No keep-alive (relies on RH keep-alive)
  |
  +-- supportable-scraper.ts (adopts context, does NOT own lifecycle)
        |-- Creates ephemeral pages for discovery + scrape
        |-- No keep-alive (relies on RH keep-alive)
```

**Critical insight:** If the RH keep-alive fails and the session expires, ALL four scrapers lose their sessions simultaneously. This is the single most impactful failure mode in the system.

---

## C. Scraper Reliability (Per Scraper)

### C1. RH Portal Cases

| Aspect | Detail |
|--------|--------|
| **Data produced** | `rh-cases.json` -- array of `SupportCase` objects (caseNumber, summary, status, severity, accountNumber, product). Only open cases (closed filtered out). |
| **Typical duration** | ~2-5s per account number. 22 customers with ~50 accounts total: ~2-4 minutes. |
| **Failure handling** | Per-account: errors caught, logged, scrape continues with next account. `SessionExpiredError` aborts entire scrape. Cache written atomically (`.tmp` + `rename`). Stale mutex: 15-min auto-release. |
| **Stale-data guard** | Atomic cache write prevents corruption. However, there is NO guard against overwriting good cache with empty results. If all accounts return 0 cases (e.g., session expired silently), the cache is overwritten with 0 cases. **Gap identified -- see G5.** |
| **Concurrency** | Mutex `_rhScrapeRunning`. Single-threaded Bun makes check-and-set atomic. `shouldCancel` callback for mid-scrape cancellation. |
| **Known failure modes** | (1) Column drift: header-based lookup with fallback indices. Warns if rows found but 0 kept. (2) Angular SPA not rendering: 15s table wait + 12s content sentinel. (3) Session expired during multi-account scrape. (4) Portal pagination (100-row limit): not handled -- only first page scraped per account. |

### C2. CCSP / Tableau

| Aspect | Detail |
|--------|--------|
| **Data produced** | Per-AE Google Sheet ("CCSP Data" tab) with cloud consumption rows. Local cache `ccsp-data.json` via Sheet refresh. Also computes `ccsp-delta.json` for change detection. |
| **Typical duration** | 60-120s per AE (page load + viz render + CSV download or DOM scrape). Per-AE timeout: 120s hard cap. |
| **Failure handling** | Per-AE: errors caught, empty result pushed, scrape continues. Two-strategy extraction: (1) direct `.csv` URL with post-filtering, (2) DOM table fallback. Stale mutex: 15-min auto-release. Two-phase mutex: `ccspScrapeRunning` (Playwright) + `ccspInFlight` (Playwright + Sheet write). |
| **Stale-data guard** | Sheet write: skips write if 0 rows AND existing sheet (BKL-S17). Cache refresh (`refreshCCSP`): skips write if fetch returns 0 but cache has data. |
| **Concurrency** | Sequential per AE (no parallelism). Each AE gets a new ephemeral page. |
| **Known failure modes** | (1) Tableau Cloud URL or view structure changes. (2) CSV download endpoint ignores URL filter params -- post-filtering required. (3) DOM scrape fails if Tableau virtualizes rows beyond viewport. (4) Filter value names are hardcoded (Super Geo, Geo, Region, Segment). (5) Viz rendering timeout (45s for Raw Data tab to appear). (6) Login wall detection: checks URL + DOM for auth elements. |

### C3. Supportable 360

| Aspect | Detail |
|--------|--------|
| **Data produced** | Per-AE Google Sheet with "Accounts" summary tab + per-customer subscription tabs. Local cache via Sheet refresh. |
| **Typical duration** | ~90s per account number (navigate, Go, Export, download CSV, parse). 22 customers at ~2 accounts each: ~66 minutes. 200 customers: 5+ hours (mitigated by ADR-008 batch rotation). |
| **Failure handling** | Per-account: errors caught, logged, continues to next account. Retry: 2 attempts per account with fresh page on retry. Wall-clock timeout: 90s per account. APEX error dialog detection and dismissal. SSO redirect handling (page close by APEX, popup path). |
| **Stale-data guard** | Sheet write: skips if 0 results AND existing sheet (BKL-S17). Account discovery: preserves existing account numbers if discovery returns 0 (stale-overwrite guard). |
| **Concurrency** | `PARALLEL_PAGES = 1` (APEX session contention constraint). Serial processing only. Mutex: `supportableScrapeRunning` with 15-min stale guard. |
| **Known failure modes** | (1) APEX SSO page close behavior (handled: fresh page creation). (2) Two Export anchor modes (normal vs inline Customer Info panel -- handled: take last anchor). (3) VPN required. Scheduled sync retries VPN probe every 15min until 9am ET. (4) APEX error dialogs after Go or before download. (5) CSV format selection: 5 strategies tried in sequence. (6) Download stream failure. (7) `P0_LAYOUT` unreliable for account-load detection (documented in ARCHITECTURE.md). |

### C4. Salesforce Pipeline

| Aspect | Detail |
|--------|--------|
| **Data produced** | Per-AE Google Sheet ("Pipeline" tab). Local cache `pipeline-data.json` via Sheet refresh. |
| **Typical duration** | 30-120s per report (SAML redirect chain + iframe render + "Show More" loop + scroll loop). |
| **Failure handling** | Per-AE: errors caught and logged, continues to next AE. `SfSessionExpiredError` raised if not on Lightning after redirect chain. Session state persisted after successful scrape. |
| **Stale-data guard** | Sheet write: skips clear+write if 0 data rows (BKL-S17). Cache refresh: stale-overwrite guard in `refreshPipeline`. |
| **Concurrency** | No explicit mutex guard. Uses `_sfSyncRunning` flag with 15-min stale guard. Fire-and-forget pattern per the ARCHITECTURE.md note. |
| **Known failure modes** | (1) SF Lightning treegrid DOM changes. (2) SAML redirect chain timeout (120s). (3) Report in paused state ("Run Report" button). (4) Virtual scroll not loading all rows. (5) Header deduplication logic (fixed + sticky headers). (6) Column filter mismatch (KEEP_COLS set too narrow). (7) lightningReportApp iframe not loading (120s wait). |

---

## D. Startup Sequence

### D1. Container Boot Order

```
entrypoint.sh:
  1. Xvfb :99 starts (virtual display)        ← background, immediate
  2. sleep 1                                    ← hard 1-second wait
  3. x11vnc starts (auto-respawn loop)          ← background
  4. websockify starts (noVNC bridge)           ← background
  5. bun run server.ts                          ← exec (foreground, PID 1)

server.ts startup:
  6. Hono app created, all routes registered
  7. app.listen(7777) starts HTTP server
  8. initBackgroundScheduler() called:
     a. refreshAll() if customers exist
     b. Schedule: territory (1:45am), pipeline (2am), CCSP (6:30am), supportable (7am), KPI (8am)
     c. setTimeout(5s) → initScrapeContext() → adopt to SF/Supportable/CCSP → run initial RH scrape
     d. 15-min heartbeat interval starts
     e. Drive watcher init
     f. Brief pre-generation (10s gaps between customers)
     g. SIGTERM/SIGINT shutdown handlers registered
```

### D2. Sequencing Assessment

**Explicit sequencing (good):**
- Xvfb gets 1-second head start before anything else.
- Scrape context init deferred 5 seconds after server start.
- Brief pre-generation is explicitly rate-limited.

**Race condition risks:**
- **Xvfb readiness (LOW risk):** 1-second sleep is empirically sufficient but not a readiness check. If Xvfb takes longer (e.g., under heavy container load), Chromium launch could fail. Mitigation: Chromium launch failures are caught and logged.
- **x11vnc before Xvfb (NONE):** x11vnc runs in a respawn loop, so if Xvfb isn't ready it just retries.
- **refreshAll before context ready (NONE):** `refreshAll()` reads from Google Sheets (no browser needed). Independent of browser context.
- **Multiple scrapers adopting context simultaneously (NONE):** Adoption is synchronous module-level assignment, serialized by Bun's event loop.

### D3. Chrome Launch Failure

If Chrome fails to launch (Xvfb not ready, profile locked, memory pressure):
- `initScrapeContext()` catches the error and logs it.
- `_context` remains null. All subsequent scrape attempts check for null context and throw "No browser context".
- The dashboard shows "Connect Red Hat Portal" status.
- User can retry via "Reconnect" button.
- **No automatic retry of context initialization.** This is a gap for unattended operation.

---

## E. Error Visibility

### E1. Dashboard-Visible Errors

| Error | Visible in UI? | Actionable? |
|-------|---------------|-------------|
| RH session expired | Yes -- status endpoint shows `sessionExpired: true` | Yes -- "Reconnect" button |
| SF session expired | Yes -- derived from `sessionExpired` flag or `syncError` | Yes -- "Connect Salesforce" button |
| Google OAuth expired | Yes -- `/api/oauth/status` returns `expired: true` | Yes -- re-auth flow |
| Scraper busy (mutex) | Yes -- status endpoints return `isRunning: true` | Wait |
| Stale data | Yes -- `isStale` flag (2x interval threshold) | Trigger manual scrape |
| Supportable VPN unreachable | Yes -- `/api/auth/supportable/check` probe | Connect VPN |
| Bootstrap progress | Yes -- step-by-step status with error details | Per-step detail messages |

### E2. Server-Log-Only Errors

| Error | Impact | Should be surfaced? |
|-------|--------|-------------------|
| Stale mutex auto-release | Scraper was stuck > 15min, force-recovered | Yes -- indicates reliability problem |
| Keep-alive hybrid path failure | Fell back to full page navigation | No -- transparent degradation |
| Column drift warning (RH cases: rows found but 0 kept) | Potential data loss | Yes -- critical for data trust |
| Quota 429 retry | 61-second wait mid-operation | Informational |
| Profile lock file removal | Previous unclean shutdown | Informational |
| Post-scrape account count validation (< 50% expected) | Possible partial scrape | Yes -- data completeness warning |
| Scraper validation warnings (BKL-M21) | Partial scrape detection | Yes -- should show in status |

### E3. Error Message Quality

**Good:** `SessionExpiredError` and `SfSessionExpiredError` have clear, actionable messages ("reconnect via the dashboard").

**Gap:** Many errors are sanitized via `sanitizeErr()` which strips file paths but produces messages like "AE scrape timed out after 120s" -- technically correct but not actionable for the user. The user cannot distinguish between "Tableau is down" and "VPN disconnected" from the error message alone.

---

## F. Scale Assessment

### F1. Customer Count Impact

| Component | 22 Customers | 50 Customers | 200 Customers |
|-----------|-------------|-------------|---------------|
| RH Case Scrape | ~4 min | ~10 min | ~40 min |
| Supportable Full Run | ~33 min | ~75 min | **5+ hours** |
| Supportable Batch (ADR-008) | N/A | ~25 min/batch | **~65 min/batch** |
| CCSP (per AE) | 2 min | 2 min | 2 min (per-AE, not per-customer) |
| SF Pipeline (per AE) | 1-2 min | 1-2 min | 1-2 min (per-AE report) |
| Google Sheets refresh | ~30s | ~60s | ~3-5 min |
| Brief pre-generation | ~4 min (10s gaps) | ~8 min | **~33 min** |

### F2. Bottlenecks

1. **Supportable APEX (critical):** PARALLEL_PAGES=1 makes this O(n) with no parallelism. ADR-008 batch rotation is the mitigation, splitting 200 customers into 3-day cycles (~67/day). Even so, 67 customers at 90s each = ~100 minutes. This is the system's primary bottleneck.

2. **Google Sheets Quota:** "Read requests per minute per user" quota. Mitigated by `knownSheetIds` fast path (bypasses Drive BFS traversal). `withQuotaRetry()` handles 429s with 61s backoff. At 200 customers, a full subscription refresh touching all sheets could exhaust quota within a single cycle.

3. **Chromium Memory:** Single persistent context with `--shm-size=256m`. Each ephemeral page adds ~50-100MB. With scrapers creating and closing pages rapidly, memory pressure can cause OOM kills. At 200 customers with brief pre-generation running concurrently, this is a concern.

4. **RH Case Scrape at Scale:** 200 customers with multiple account numbers (potentially 400+ accounts). At 2-5s per account, this is 13-33 minutes. Combined with 8-minute keep-alive interval, the scrape could span 2-4 keep-alive cycles. Session expiry mid-scrape is increasingly likely at scale.

5. **Brief Pre-generation:** 200 customers at 10s each = ~33 minutes of sequential Drive/Gmail/Calendar API calls on startup. This runs concurrently with everything else, competing for Google API quota.

### F3. Multi-AE Impact

The current system supports multiple AEs (via `aes.json`). Each AE multiplies:
- CCSP scrapes (one Tableau scrape per AE)
- Pipeline scrapes (one SF report per AE)
- Google Sheet creates/writes (3 sheets per AE: Supportable, CCSP, Pipeline)

At 5 AEs with 40 customers each = 200 customers total. The AE loop is sequential for all scrapers, so this is additive.

---

## G. Enterprise Readiness Gaps (Prioritized)

### P0 -- Blockers (Must fix before ANY additional users)

| ID | Gap | Impact | Fix Approach | Effort |
|----|-----|--------|-------------|--------|
| **G1** | **GCP OAuth in "Testing" mode** | Testing-mode tokens expire in 7 days. Any new user's Google connection will silently break after one week. Refresh tokens are not issued in Testing mode for external users. The current single user works because they are likely the project owner. | Switch GCP OAuth consent screen to "Internal" (for @redhat.com accounts -- no review needed) or "Production" (requires Google review). Internal mode gives all org users permanent refresh tokens. | 1 hour (GCP Console change) |
| **G2** | **Single-user config architecture** | `aes.json` and `customers.json` are global. All users see the same AEs and customers. There is no per-user isolation of configuration, cache, or browser sessions. ADR-001 Phase 5 (multi-user) is unimplemented. | Design per-user config directories as outlined in ADR-001 Section 7. Each user needs: own `aes.json`, `customers.json`, profile dir, cache dir. Shared: OAuth keys, container infrastructure. | 5-8 days |
| **G3** | **Single shared browser context** | One Chromium instance, one set of SSO cookies. Cannot serve two users simultaneously -- their RH Portal sessions conflict. Logging in as User B destroys User A's session. | Phase 1: Accept single-concurrent-user limitation, queue scrapes. Phase 2: Per-user profile directories with serialized Chromium access (only one browser active at a time, users take turns). | Phase 1: 2 days. Phase 2: 5-8 days. |

### P1 -- High Priority (Fix before production-quality onboarding)

| ID | Gap | Impact | Fix Approach | Effort |
|----|-----|--------|-------------|--------|
| **G4** | **No automatic browser context recovery** | If Chromium crashes or the session expires overnight, the system stays in a degraded state until a human clicks "Reconnect". For a tool other users rely on, this means mornings where data is stale and nobody knows why. | Implement auto-recovery: on session expiry or context crash, attempt `initScrapeContext()` with existing profile. If cookies are still valid, session resumes. If not, emit a push notification (ntfy.sh) telling the user to reconnect. Rate-limit to one attempt per 30 minutes. | 3-4 days |
| **G5** | **RH Cases cache lacks stale-overwrite guard** | Unlike Supportable, CCSP, and Pipeline scrapers, the RH case scraper has no guard against writing 0 cases over good cached data. A silently expired session could produce 0 cases and overwrite the cache. | Add the same pattern: `if (allCases.length === 0 && existingCacheHasCases) { skip write }`. Log a warning. Already implemented for the other three scrapers. | 1 hour |
| **G6** | **No session health dashboard** | Users cannot see at a glance: "RH session expires in 6 hours", "SF session expired 2 hours ago", "Tableau session untested since yesterday". The status endpoints exist but the information is scattered and not proactive. | Build a "Data Sources Health" panel showing: per-source session status, cookie TTL estimate, last successful scrape, staleness indicator, and one-click reconnect. ADR-001 proposed `SessionHealth` interface is a good starting point. | 3-4 days |
| **G7** | **Scheduled scrapes proceed silently when session is dead** | CCSP and Supportable scheduled syncs at 6:30am/7am ET will attempt to scrape with an expired session. They detect the failure and skip, but the user doesn't know data wasn't refreshed until they check the dashboard. | Add push notification (ntfy.sh, already integrated) on scheduled scrape skip due to expired session. Example: "CCSP sync skipped -- Tableau session expired. Reconnect via dashboard." | 2 hours |
| **G8** | **RH case pagination not handled** | The scraper only fetches the first page (100 cases per `size=100` URL param). Accounts with >100 open cases will have incomplete data. Unlikely at 22 customers but possible at scale. | Add pagination: check for "Next" button or total count indicator, increment `p` param until all pages fetched. | 2-3 days |
| **G9** | **Container memory limits undefined** | Makefile sets `--shm-size=256m` but no overall memory limit. At 200 customers with concurrent brief pre-generation and scraping, Chromium + Bun could exhaust container memory and get OOM-killed. | Add `--memory=2g` (or appropriate limit) to Makefile. Monitor RSS usage during peak scrape + brief generation. Consider staggering brief pre-gen to not overlap with morning scrape window. | 1 day |

### P2 -- Medium Priority (Improve for operational quality)

| ID | Gap | Impact | Fix Approach | Effort |
|----|-----|--------|-------------|--------|
| **G10** | **Xvfb readiness not verified** | 1-second `sleep` in `entrypoint.sh` instead of readiness probe. Under load, Xvfb could need longer. | Replace `sleep 1` with a loop that checks `xdpyinfo` until display :99 is available. | 1 hour |
| **G11** | **Scraper validation warnings not surfaced in UI** | BKL-M21 partial-scrape detection logs warnings but doesn't update any status endpoint. | Add `partialScrapeWarning` field to `/api/status/scrapes` response. Show warning badge in dashboard. | 2 hours |
| **G12** | **SF scraper has no explicit stale-mutex guard** | Unlike RH/CCSP/Supportable which check `started_at > 15min`, the SF sync running flag in `scrape-api.ts` does have a 15-min check, but `runSfSyncForAes` in `scraper-manager.ts` also has one. Redundant but safe. However, the `isRunning: false permanently` note in ARCHITECTURE.md suggests this was an afterthought. | Verify both code paths consistently use the 15-min stale guard. Add to `scrape-api.ts` status endpoint. | 1 hour |
| **G13** | **Tableau filter values are hardcoded** | `Super Geo=AMERICAS`, `Geo=NA_COMM`, etc. are hardcoded in `ccsp-scraper.ts`. Other Red Hat AEs in different geos cannot use the CCSP scraper without code changes. | Move filter values to `aes.json` as configurable `tableauFilters` per AE. Default to current values. | 2-3 days |
| **G14** | **No scraper telemetry / history** | No record of past scrape runs (duration, records scraped, errors). Only the last run's status is stored in memory. Container restart loses all history. | Write scrape results to an append-only log file (`data/cache/scrape-log.json`). Show in admin panel as "Scrape History". | 2-3 days |
| **G15** | **Google Sheets quota scaling** | At 200 customers across 5 AEs, the morning refresh cycle could make 1000+ Sheets API calls. The per-user quota of 60 read requests/minute means a full refresh takes 15+ minutes of rate-limited calls. | Implement batch read API (`spreadsheets.values.batchGet`) to fetch multiple ranges in one call. Implement change-detection more aggressively (Drive watcher skip if no changes). | 3-5 days |
| **G16** | **No onboarding documentation** | No guide for "I'm a new AE, how do I set this up?" The setup wizard exists but the prerequisites (GCP project, OAuth keys, VPN access, SF report IDs) are undocumented. | Write `docs/ONBOARDING.md` with step-by-step guide covering: GCP OAuth setup, first-run wizard walkthrough, connecting each data source, verifying data flow. | 1-2 days |
| **G17** | **SF report "Show More" loop unbounded** | The scroll + load-more loop has a 30-iteration limit but no overall timeout. If SF returns rows slowly, this could run for 90+ seconds. The `loadAttempts < 30` guard exists but doesn't account for the 3s waitForTimeout between iterations. | Add an overall wall-clock timeout (e.g., 5 minutes) wrapping the entire scroll loop. | 1 hour |

---

## Summary: Readiness Assessment

### Current State: Ready for Single-User Production

The system is well-engineered for a single-user deployment:
- Auth flows handle the fundamental SSO constraint correctly
- Session persistence via Chromium profiles is the right approach
- Keep-alive timers are properly tuned
- Stale-data guards are in place (with one gap at G5)
- Error sanitization prevents info leaks
- Atomic writes prevent cache corruption
- The test suite (260 tests) provides confidence

### Onboarding Other AEs: Ready After Phase 1

**Clarification:** This is a single-user-per-container architecture. Each AE runs their own container with their own credentials. G2 (per-user config isolation) and G3 (per-user browser profiles) are NOT required — they were assessed for a multi-user shared instance which is not the deployment model.

**What IS needed for onboarding:**
1. **G1** — GCP OAuth "Testing" mode limits token lifetime to 7 days. Switch to "Internal" so refresh tokens last indefinitely. Each new AE sets up their own GCP project or you share OAuth keys.
2. **G16** — Onboarding documentation. Step-by-step guide for a new AE: GCP setup, container run, first-run wizard, connecting each data source.
3. **Stability fixes (G4, G5, G6)** — The container must run reliably overnight without manual intervention.

### Recommended Sequence (Single-User Stability Focus)

```
Phase 1 (Week 1): Critical stability — must fix before sharing
  G5  - Add RH cases stale-overwrite guard             (1 hour)
  G4  - Automatic browser context recovery             (3-4 days)
  G7  - Push notifications on scheduled scrape skip    (2 hours)
  G10 - Xvfb readiness check in entrypoint.sh          (1 hour)
  BKL-M49 - Scraper startup sequencing / queue         (2-3 days)

Phase 2 (Week 2): Operational visibility
  G6  - Session health dashboard panel                 (3-4 days)
  G11 - Surface scraper validation warnings in UI      (2 hours)
  G14 - Scraper telemetry / history                    (2-3 days)
  G9  - Container memory limits                        (1 day)

Phase 3 (Week 3): Onboarding enablement
  G1  - Switch GCP OAuth to Internal mode              (1 hour)
  G16 - Onboarding documentation (ONBOARDING.md)       (1-2 days)
  G13 - Configurable Tableau filters per geo           (2-3 days)

Phase 4 (Week 4+): Scale
  G8  - RH case pagination                            (2-3 days)
  G15 - Sheets quota optimization                     (3-5 days)
```

**G2 and G3 are NOT on the roadmap** — single-user-per-container is the correct architecture.

### The Fundamental Constraint

The deepest architectural constraint in this system is the shared browser context. It exists because Red Hat's SSO binds authentication to a browser session, and four downstream services (Portal, SF, Tableau, Supportable) all authenticate through that same SSO. This is not a design flaw -- it is the only viable approach given the vendor constraint (confirmed by the 401s from hydra API with Bearer tokens per ADR-001).

For a single-user container, this constraint is manageable — the scraper queue (BKL-M49) ensures one scraper runs at a time within the same context. The key reliability gap is automatic recovery when the context crashes (G4).
