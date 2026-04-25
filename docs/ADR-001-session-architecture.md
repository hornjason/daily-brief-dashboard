---
Last validated: 2026-04-24
---

# ADR-001: Robust Long-Lived Session Strategy for Red Hat Portal Access

**Status:** Proposed
**Date:** 2026-03-26
**Author:** Architect Agent (Serena Blackwood archetype)
**Decision:** Option C (Hybrid) with elements of Option D -- recommended

---

## 1. Problem Statement

The DailyBriefDashboard uses Playwright to scrape Red Hat's Customer Portal for support case data. Authentication goes through Red Hat SSO (Keycloak PKCE). The fundamental problem:

- **Headless Playwright sessions expire in 15-30 minutes**
- **Headed Chrome sessions to the same portal persist for days/weeks**
- **Current keep-alive** (navigate every 12 min) works while the server runs but breaks on restart
- **Session state restoration** from `session-state.json` is unreliable after restart

The system needs a session strategy that approaches the longevity of headed Chrome, degrades gracefully, and recovers automatically.

---

## 2. Root Cause Analysis (First Principles)

### Why headed Chrome sessions last days but Playwright headless dies in 30 minutes

The answer is NOT simply "cookies expire." The fundamental constraint chain is:

```
Layer 1: TAsessionID cookie       -- 30-90 min TTL, renewed by portal JS on activity
Layer 2: rh_sso_session cookie    -- ~14 hour TTL, renewed by SSO server on token refresh
Layer 3: Keycloak server session   -- tied to rh_sso_session, ~14h idle timeout
Layer 4: PKCE sessionStorage       -- code_verifier, per-page, survives reload but not new tab
Layer 5: Keycloak refresh token    -- embedded in SSO cookie flow, ~30 day lifetime
```

**In headed Chrome:**
- The portal's JavaScript runs continuously (Angular SPA), refreshing TAsessionID via API calls
- Service workers and background fetch keep rh_sso_session alive
- Chrome's process never terminates, so sessionStorage persists indefinitely
- When TAsessionID expires, the portal JS transparently refreshes via SSO redirect (invisible to user)
- The SSO redirect works because rh_sso_session is still valid AND the page retains PKCE sessionStorage

**In headless Playwright:**
- No continuous JS execution between explicit navigations
- No service workers (Playwright Chromium has limited SW support)
- TAsessionID expires silently between 12-min keep-alive intervals
- When keep-alive navigates, SSO redirect happens -- but this only works if rh_sso_session is still valid AND the PKCE flow can complete
- **Critical:** Playwright's `storageState()` does NOT include sessionStorage (confirmed by Playwright docs)
- On restart, cookies are restored but PKCE code_verifier in sessionStorage is lost
- Without code_verifier, the SSO redirect becomes a full login redirect

### The sessionStorage gap is the root cause of restart fragility

The persistent context profile directory stores cookies and localStorage on disk (like Chrome's profile), but sessionStorage is in-memory only. When the Playwright process dies, sessionStorage dies with it. The next process starts with cookies but no PKCE state, and the first SSO renewal attempt fails.

### Why 15-30 min and not 14 hours?

Because TAsessionID (30-90 min) expires first. When the keep-alive tries to renew it, the SSO redirect checks for PKCE state in sessionStorage. In a new page (or after restart), that state is missing. The redirect falls through to a full login form instead of transparent renewal.

If we could keep PKCE sessionStorage alive, the session would last as long as rh_sso_session (~14 hours). If we could also refresh rh_sso_session, it would last indefinitely.

---

## 3. API Landscape Analysis

### APIs that accept Bearer tokens (from offline token exchange)

| API | Base URL | Works | Scope |
|-----|----------|-------|-------|
| Subscription Management | `api.access.redhat.com/management/v1/` | Yes | Full account subscriptions |
| Support Cases (filter) | `api.access.redhat.com/support/v1/cases/filter` | Yes | **Owner-only cases** |
| Support Cases (by ID) | `api.access.redhat.com/support/v1/cases/{id}` | Yes | If user has access |
| Case Comments | `api.access.redhat.com/support/v1/cases/{id}/comments` | Yes | If user has access |

### APIs that require browser session cookies ONLY

| API | Base URL | Evidence |
|-----|----------|----------|
| Hydra Accounts | `access.redhat.com/hydra/rest/accounts/` | Returns 401 without browser cookies |
| Portal Case List (HTML) | `access.redhat.com/support/cases/` | Full Angular SPA, needs session |

### The critical gap

The Support Cases API (`/support/v1/cases/filter`) with Bearer token only returns cases where the authenticated user is the **direct owner or contact**. The portal UI, by contrast, shows all cases across the entire account (by account number). This is the data the dashboard needs.

**There is no documented Bearer-token API that provides account-level case listing.**

The hydra accounts API (used for account discovery) definitively requires browser session cookies -- the 401 response confirms this.

### Token lifecycle

- **Offline token:** Never expires if used every 30 days
- **Access token:** 15-minute TTL, obtained by exchanging offline token
- **client_id:** `rhsm-api` -- this is the only documented client_id for API access
- **Scope limitation:** The `rhsm-api` client appears to have a different audience than the portal's internal PKCE client, meaning its tokens cannot access portal-internal APIs like hydra

---

## 4. Option Evaluation

### Option A: Browser-Only with Better Keep-Alive

**Approach:** Keep the current Playwright-based architecture but improve session longevity through better keep-alive strategies.

**Specific techniques:**
1. **Preserve the live page** (already implemented) -- keep the original login page alive, never close it
2. **Inject sessionStorage persistence** -- serialize sessionStorage to disk alongside cookies, restore via `addInitScript()` on new pages
3. **Reduce keep-alive interval** -- from 12 min to 8 min (well within TAsessionID's 30-min minimum)
4. **Simulate realistic activity** -- instead of just navigating, execute portal JS that the SPA normally runs (API calls, Angular digest cycles)
5. **Pre-emptive SSO renewal** -- before rh_sso_session expires (~14h), proactively trigger an SSO redirect while the page still has valid PKCE state

**Strengths:**
- Single execution model (browser only)
- Full access to all portal data including account-level cases and hydra API
- Closest to how a human uses the portal

**Weaknesses:**
- Playwright Chromium fundamentally lacks headed Chrome's background execution model
- Service workers don't run reliably in Playwright headless
- Memory overhead of persistent Chromium process (~200-400 MB)
- Still breaks on server restart unless sessionStorage is explicitly preserved
- Fragile -- depends on Red Hat not changing their SPA behavior

**Maximum achievable session lifetime:** ~14 hours (rh_sso_session TTL) with good keep-alive, indefinite if pre-emptive SSO renewal works.

**Restart recovery:** Possible with sessionStorage serialization, but untested territory.

---

### Option B: Token-Based API Access (No Browser)

**Approach:** Eliminate Playwright entirely. Use the offline token to get access tokens and call Red Hat APIs directly.

**What works:**
- Subscription data (renewals, entitlements) -- fully supported
- Case details and comments for known case numbers -- fully supported
- Case listing for user's own cases -- supported via `/support/v1/cases/filter`

**What does NOT work:**
- Account-level case listing (all cases across an account number) -- **no API exists**
- Hydra accounts API (account discovery) -- requires browser cookies, rejects Bearer
- Account number discovery for new customers -- requires hydra

**Strengths:**
- Zero browser overhead (no Playwright, no Chromium)
- No session expiry concern (offline token lasts 30+ days, access tokens refresh in milliseconds)
- Restart-proof (just re-exchange the offline token)
- Simpler architecture, fewer moving parts

**Weaknesses:**
- **Cannot replace the core use case** -- account-level case listing requires browser
- Account discovery impossible without hydra API
- Would require users to manually provide case numbers or account numbers
- Defeats the purpose of automated monitoring

**Verdict:** Insufficient as sole strategy. Cannot replace browser for account-level data.

---

### Option C: Hybrid -- Browser for Login/Discovery, Token API for Data

**Approach:** Use the browser minimally (login, account discovery, account-level case list scraping) and the token API maximally (case details, comments, subscriptions, renewals).

**Architecture:**

```
                    +---------------------------+
                    |     Session Manager        |
                    |  (orchestrates both tiers) |
                    +------+----------+---------+
                           |          |
              +------------+          +------------+
              |                                    |
     +--------v--------+              +-----------v-----------+
     |  Browser Tier    |              |  Token API Tier        |
     |  (Playwright)    |              |  (fetch + Bearer)      |
     +-----------------+              +------------------------+
     | - Login/auth     |              | - Case details by ID   |
     | - Account disc.  |              | - Case comments        |
     | - Account-level  |              | - Subscriptions        |
     |   case listing   |              | - Renewals             |
     | - Hydra API      |              | - Any future REST APIs |
     +-----------------+              +------------------------+
              |                                    |
              v                                    v
     +------------------+              +---------------------+
     | cases-cache.json  |              | Direct API response  |
     | (scraped list)    |              | (no caching needed)  |
     +------------------+              +---------------------+
```

**Key insight:** The browser only needs to run for two operations:
1. **Periodic case list scraping** (every 30-60 min is sufficient for dashboard freshness)
2. **Account discovery** (rare -- only when adding new customers)

Between scrapes, the browser can be idle (no keep-alive needed if we accept that each scrape might need to re-authenticate). The token API handles everything else.

**Session lifecycle:**

```
1. Server starts
2. Check: is offline token configured?
   Yes -> Token tier is immediately available (subscriptions, renewals, case details)
   No  -> Prompt user to configure offline token
3. Check: is browser session restorable?
   Yes -> Restore and verify, then scrape
   No  -> Show "browser login needed" status, serve cached data
4. User triggers browser login (headed, one-time)
5. Browser scrapes case list -> writes cache
6. Browser stays alive with keep-alive for subsequent scrapes
7. If browser session dies -> serve cached data + token API data
8. If server restarts -> token tier resumes instantly, browser session attempted
```

**Strengths:**
- Token API provides immediate, restart-proof access to most data
- Browser session is a "nice to have" enhancement, not a hard dependency
- Graceful degradation is built into the architecture
- Reduces browser usage from continuous to periodic
- Account-level case listing still works when browser is healthy

**Weaknesses:**
- Two authentication mechanisms to maintain
- More complex code paths
- Browser tier still has the same session longevity challenges
- Cache staleness during browser-down periods

**Maximum achievable uptime:** Token tier: 100% (offline token never expires if refreshed). Browser tier: same as Option A with improvements.

---

### Option D: Session State Serialization/Restoration

**Approach:** Perfect the save/restore cycle so server restarts are transparent.

**What needs to be serialized:**

| State | Included in storageState()? | Included in profile dir? | Action needed |
|-------|---------------------------|-------------------------|---------------|
| Cookies (all) | Yes | Yes | Already handled |
| localStorage | Yes | Yes | Already handled |
| sessionStorage | **NO** | **NO** | Must add manual serialization |
| IndexedDB | No | Yes (profile dir) | Profile dir handles this |
| Service Worker registrations | No | Yes (profile dir) | Profile dir handles this |
| In-flight PKCE state | **NO** | **NO** | Must serialize from sessionStorage |

**Implementation:**

```typescript
// Before shutdown or periodically
async function serializeFullState(page: Page, profileDir: string): Promise<void> {
  // 1. storageState covers cookies + localStorage
  const storageState = await page.context().storageState()

  // 2. Manually capture sessionStorage (THE MISSING PIECE)
  const sessionStorageData = await page.evaluate(() => {
    const data: Record<string, string> = {}
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)!
      data[key] = sessionStorage.getItem(key)!
    }
    return data
  })

  const fullState = {
    ...storageState,
    sessionStorage: sessionStorageData,
    savedAt: new Date().toISOString(),
  }

  await writeFile(
    resolve(profileDir, 'session-state.json'),
    JSON.stringify(fullState)
  )
}

// On restore
async function restoreFullState(context: BrowserContext, statePath: string): Promise<Page> {
  const state = JSON.parse(readFileSync(statePath, 'utf-8'))
  const page = await context.newPage()

  // Restore sessionStorage before any navigation
  if (state.sessionStorage) {
    await context.addInitScript((data: Record<string, string>) => {
      for (const [key, value] of Object.entries(data)) {
        try { sessionStorage.setItem(key, value) } catch {}
      }
    }, state.sessionStorage)
  }

  return page
}
```

**Strengths:**
- Directly addresses the root cause (sessionStorage loss)
- Minimal architectural change from current system
- If it works, restarts become transparent

**Weaknesses:**
- PKCE code_verifier may be one-time-use (Keycloak may reject replayed verifiers)
- sessionStorage restoration via addInitScript runs before page load but Keycloak may generate new PKCE state on each redirect, invalidating restored state
- Cookie expiry is absolute time-based -- restored cookies may already be expired
- No guarantee that the Keycloak server-side session is still valid after restart
- This is the most fragile option because it fights against the SSO system's design

**Verdict:** Valuable as a technique within Options A or C, but insufficient as sole strategy. The PKCE verifier replay problem may be a hard blocker.

---

## 5. Trade-offs Matrix

| Criterion | A: Browser+ | B: Token-Only | C: Hybrid | D: Serialization |
|-----------|------------|---------------|-----------|------------------|
| Account-level cases | Yes | **No** | Yes | Yes |
| Hydra account discovery | Yes | **No** | Yes | Yes |
| Restart resilience | Poor | **Excellent** | Good | Fair |
| Session longevity | ~14h | **Indefinite** | ~14h browser / indefinite token | ~14h if restore works |
| Memory overhead | High (Chromium) | **None** | Medium (periodic Chromium) | High (Chromium) |
| Implementation complexity | Low | Low | **Medium** | Medium |
| Graceful degradation | None (all or nothing) | N/A | **Built-in** | None |
| User interaction on failure | Full re-login | None | **Minimal** | Full re-login |
| Multi-user support | Hard (1 Chromium per user) | Easy (1 token per user) | **Medium** | Hard |
| Fragility (RH changes) | High | Low | **Medium** | Very High |

---

## 6. Recommendation: Option C (Hybrid) with Option D Techniques

### Architecture

The recommended approach is a **tiered session architecture** where:

1. **Token Tier (Always Available):** Offline token provides instant, restart-proof access to subscriptions, renewals, case details, and comments. This is the foundation.

2. **Browser Tier (Best-Effort Enhancement):** Playwright provides account-level case listing and hydra account discovery. Enhanced with sessionStorage serialization (Option D) for restart resilience.

3. **Cache Tier (Degraded Fallback):** When browser tier is down, serve the last-known case list from cache with staleness indicator.

### Degradation Chain

```
TIER 1 (Full)     : Browser alive + Token API
                     -> All data live, account-level cases, full discovery

TIER 2 (Partial)  : Browser down + Token API + Cache
                     -> Subscriptions/renewals live, cases from cache
                     -> Dashboard shows "Case data from X minutes ago"

TIER 3 (Minimal)  : Token API only + Cache (browser never authenticated)
                     -> Same as Tier 2 but case cache may be very stale
                     -> Dashboard shows "Connect Red Hat Portal for live cases"

TIER 4 (Offline)  : No token + No browser + Cache only
                     -> Everything from cache, all data stale
                     -> Dashboard shows "Configure Red Hat credentials"
```

### Session Health Monitor

```typescript
interface SessionHealth {
  tier: 1 | 2 | 3 | 4
  tokenApiHealthy: boolean
  browserSessionHealthy: boolean
  cacheAge: number | null          // minutes since last scrape
  cookieExpiry: {
    TAsessionID: Date | null       // 30-90 min
    rh_sso_session: Date | null    // ~14 hours
  }
  nextScheduledScrape: Date | null
  lastHealthCheck: Date
}

// Health check runs every 5 minutes (low overhead -- just checks cookie expiry times)
// Does NOT navigate or make API calls unless cookie expiry is imminent
async function checkSessionHealth(): Promise<SessionHealth> {
  // 1. Check token API: try a lightweight call (e.g., /management/v1/subscriptions?limit=1)
  // 2. Check browser: inspect cookie jar for TAsessionID and rh_sso_session expiry
  // 3. If TAsessionID expiry < 10 min: trigger keep-alive navigation
  // 4. If rh_sso_session expiry < 2 hours: trigger pre-emptive SSO renewal
  // 5. Compute tier from results
}
```

### Browser Session Longevity Strategy

Within the hybrid architecture, maximize browser tier uptime with:

1. **sessionStorage serialization** (from Option D) -- serialize after every successful scrape and keep-alive
2. **Restore with addInitScript** -- on restart, inject sessionStorage before first navigation
3. **Smart keep-alive** -- navigate every 8 min only when browser tier is active, stop when idle
4. **Pre-emptive SSO renewal** -- at rh_sso_session 12h mark (2h before expiry), trigger a full page reload that forces SSO redirect while PKCE state is still valid
5. **Graceful session death** -- when browser session dies, log the failure mode, mark tier degradation, and notify via dashboard status

### Key Implementation Detail: The sessionStorage Restore Gambit

This is the highest-risk, highest-reward technique in the architecture:

```
On restart:
1. Launch persistent context (profile dir has cookies)
2. Create new page with addInitScript that restores sessionStorage
3. Navigate to portal
4. Three outcomes:
   a. Portal loads (cookies valid, sessionStorage not needed) -> SUCCESS
   b. SSO redirect, transparent renewal works (rh_sso_session valid) -> SUCCESS
   c. SSO redirect, lands on login form (everything expired) -> TIER DEGRADATION

Outcome (a) is likely if restart was quick (< 30 min, TAsessionID still valid)
Outcome (b) is likely if restart was moderate (< 14h, rh_sso_session valid)
Outcome (c) only if restart was very long (> 14h) or cookies corrupted
```

The PKCE sessionStorage restore may or may not help with outcome (b). The SSO redirect generates new PKCE state, so the restored verifier is likely irrelevant. What actually matters is whether the **rh_sso_session cookie** is still valid and the Keycloak server-side session hasn't expired. If both are true, SSO transparent renewal works regardless of sessionStorage.

This means: **sessionStorage serialization is less important than we initially thought.** The real session longevity bottleneck is rh_sso_session's ~14-hour TTL, and the real restart constraint is whether cookies in the profile dir are still valid.

---

## 7. Multi-User Onboarding

### Minimum setup per user:

1. **Offline token** (required): User visits `https://access.redhat.com/management/api`, generates token, pastes into app config. This enables Token Tier immediately.

2. **Browser login** (optional, enhances): User clicks "Connect Portal" in dashboard, logs in via headed browser once. This enables Browser Tier.

### Per-user isolation:

```
config/
  users/
    user-abc/
      .env                    # REDHAT_OFFLINE_TOKEN
      profile/                # Playwright persistent context dir
      session-state.json      # Serialized session state
      cases-cache.json        # Last scraped case data
```

Each user gets an isolated profile directory. Only one headless Chromium process runs at a time (scrapes are serialized across users to avoid resource contention).

### Adding users without restart:

The server watches `config/users/` for new directories. When a new user dir appears with a valid `.env`, the token tier activates immediately. Browser login can be triggered via the dashboard.

---

## 8. Implementation Plan

### Phase 1: Token Tier Foundation (LOW RISK -- do first)

**Goal:** Make subscriptions, renewals, and case details available without any browser dependency.

1. Extract `getToken()` and `rhGet()`/`rhPost()` from `redhat.ts` into `rh-token-api.ts`
2. Add health check endpoint: `GET /api/rh/health` returns `SessionHealth`
3. Add explicit tier tracking in server state
4. Modify dashboard to show current tier and data freshness
5. Test: server restart with only offline token configured should immediately serve subscription data

**Dependencies:** None
**Effort:** 1-2 days
**Risk:** Very low -- this code already exists, just needs restructuring

### Phase 2: Session Health Monitor (MEDIUM RISK)

**Goal:** Proactive detection of session degradation before scrapes fail.

1. Implement `checkSessionHealth()` with cookie expiry inspection
2. Add health check interval (every 5 min)
3. Add pre-emptive keep-alive trigger when TAsessionID is near expiry
4. Add dashboard health indicator showing cookie TTLs
5. Test: let session idle, verify health monitor detects degradation before scrape fails

**Dependencies:** Phase 1 (tier tracking)
**Effort:** 1-2 days
**Risk:** Medium -- cookie expiry parsing from Playwright's cookie jar may have edge cases

### Phase 3: sessionStorage Serialization (MEDIUM-HIGH RISK)

**Goal:** Improve restart resilience by preserving full session state.

1. Add `serializeFullState()` to `rh-scraper.ts` (cookies + sessionStorage)
2. Call after every successful scrape and keep-alive
3. Add `restoreFullState()` to startup sequence
4. Add graceful shutdown hook (SIGTERM/SIGINT) that serializes before exit
5. Test: restart server within 30 min window, verify session survives

**Dependencies:** Phase 2 (health monitor verifies restoration success)
**Effort:** 2-3 days
**Risk:** Medium-high -- may not work if Keycloak server-side session is invalidated

### Phase 4: Graceful Degradation Chain (LOW RISK)

**Goal:** When browser tier fails, degrade smoothly instead of erroring.

1. Implement tier degradation logic in session manager
2. Modify `fetchCases()` to return cached data with staleness when browser is down
3. Add "Reconnect Portal" button that only appears when in Tier 2+
4. Add automatic tier promotion when browser session recovers
5. Test: kill browser process, verify dashboard shows cached data with warning

**Dependencies:** Phases 1-3
**Effort:** 1-2 days
**Risk:** Low -- mostly UI and control flow

### Phase 5: Multi-User Support (FUTURE)

**Goal:** Support multiple Red Hat users with isolated sessions.

1. Implement per-user config directory structure
2. Add user management UI (add/remove users)
3. Serialize scrape operations across users
4. Per-user health monitoring
5. Test: two users configured, both scraping different account sets

**Dependencies:** Phases 1-4
**Effort:** 3-5 days
**Risk:** Medium -- Chromium memory pressure with multiple profile dirs

---

## 9. Success Metrics

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| Session uptime (no restart) | ~15-30 min | >12 hours | Log session health transitions |
| Time-to-recovery after restart | Manual re-login (minutes) | <30 seconds (token tier) | Measure first successful API call after restart |
| Data availability during outage | 0% (error page) | 100% (cached + token data) | Monitor tier during simulated failures |
| User interaction for setup | Browser login + wait | Paste offline token (30 sec) | Count required user actions |
| User interaction for recovery | Browser re-login | None (automatic degradation) | Count required user actions |

---

## 10. Open Questions

1. **Can the Support Cases API filter by account number with Bearer token?** The current code uses `POST /support/v1/cases/filter` with `{ offset, maxResults }` but does not pass an `accountNumber` filter. It may be possible to add `accountNumber` to the filter body and get account-level results without browser scraping. **This should be tested before Phase 1.**

2. **Does Keycloak invalidate server-side sessions on client disconnect?** If Keycloak keeps the server-side session alive for the full 14h regardless of client activity, then restart resilience is much better than expected. The session would survive any restart within that window.

3. **Are there undocumented Red Hat API endpoints** that accept Bearer tokens and provide account-level case listing? The portal's Angular SPA makes XHR calls -- intercepting those URLs during a live session could reveal APIs that accept Bearer tokens.

4. **Can the offline token be exchanged with a different client_id** that has broader portal scope? The `rhsm-api` client_id may have limited audience claims. A different client_id (if one exists) might grant access to hydra and portal-internal APIs.

---

## 11. Appendix: Research Findings

### Playwright storageState() limitations (confirmed)

From Playwright docs: "Session storage is specific to a particular domain and is not persisted across page loads. Playwright does not provide API to persist session storage." Manual serialization via `page.evaluate()` and restoration via `context.addInitScript()` is the documented workaround.

### Red Hat offline token lifecycle (confirmed)

- Generated at `https://access.redhat.com/management/api`
- Never expires if used every 30 days
- Exchange via POST to `sso.redhat.com/.../token` with `client_id=rhsm-api`, `grant_type=refresh_token`
- Access token valid 15 minutes
- Works against `api.access.redhat.com/management/v1/` and `api.access.redhat.com/support/v1/`

### Hydra API authentication (confirmed)

- `access.redhat.com/hydra/rest/accounts/` returns HTTP 401 without browser session cookies
- This is an internal portal API, not designed for external API access
- No Bearer token authentication supported
