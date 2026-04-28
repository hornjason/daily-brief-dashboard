# ADR-015: Tableau SSO Must Complete in the Shared Scrape Context

**Status:** PROPOSED — awaiting Jason sign-off before implementation  
**Date:** 2026-04-28  
**Author:** Serena Blackwood (Architect) via Rayford (DA)  
**References:** BKL-CONN-TABLEAU-CTX-01, ADR-001

---

## Context

The system has an established architectural truth (ADR-001, CLAUDE.md): **the shared Chromium browser context is intentional — isolation breaks Tableau SSO.** The shared context (owned by `rh-scraper.ts`) maintains a single headed Chromium process that all scrapers (RH Portal, SF, CCSP) share. Tableau's session model requires that SSO complete in the same browser instance that will later make VizQL/CSV requests.

### What Changed (and broke things)

BKL-CONN-TABLEAU-CTX-01 introduced an **isolated** persistent Chromium context (`TABLEAU_AUTH_PROFILE_DIR`) for the Tableau SSO login step alone. The intent was to prevent renderer crashes in the shared context when Tableau's SSO chain ran. Cookies from the isolated login were written to `tableau-session.json` and injected into the shared context via `ctx.addCookies()`.

### Why the Bridge Doesn't Work

Tableau Cloud's session model is not reducible to cookies. When SSO completes:

1. **VizQL session is JS-initialized** — Tableau's embedded viz bootstraps a `tabid`, `sessionId`, and associated localStorage/IndexedDB state tied to the originating browser process. Injecting the Tableau cookies into a different Chromium profile (different JS heap, different `tabid`) produces a session that passes the URL check but fails on the first actual VizQL/CSV request.

2. **Okta tokens are app-scoped** — The SSO chain's Okta session cookies (`workgroup_session_id`, `tsi.session.*`) are issued for a specific Okta application integration (Tableau Online's specific SAML/OIDC config). The shared context's Okta cookies came from RH Portal SSO — a different Okta app. Without the right Okta tokens, every navigation in the shared context re-triggers the SSO wall.

3. **The failure is silent** — The shared context lands on `10ay.online.tableau.com` (passes URL check → `sessionValid: true`), but the CSV endpoint returns HTML (SSO redirect page) or `\n` — indistinguishable from a filter error without the new `auth_redirect` / `csv_empty` classifier.

**Result:** CCSP consistently returns 0 records after Tableau VNC login, because the login happened in the wrong context.

---

## Decision

**Do Tableau SSO in the shared scrape context, not the isolated profile.**

The isolated `TABLEAU_AUTH_PROFILE_DIR` context is retained only as a historical artifact and eventually removed. The login flow becomes:

1. Acquire the shared Chromium context via `getScrapeContext()` with a `setLivePageBusy(true)` guard (prevents RH/SF scrape races during the login window).
2. Open a new page on the shared context, navigate to `TABLEAU_URL`.
3. `waitForTableauLogin()` polls the new page URL (same logic as today, no change).
4. On success, save cookies to `tableau-session.json` **only as a cold-start restore hint** — not as the primary auth mechanism.
5. Close only the page (not the context). Clear `setLivePageBusy`.
6. `restoreTableauSession(ctx)` is called at each `runCcspScrape` start only if the shared context has **zero** `tableau.com` cookies (cold-start after container restart). Never overwrite a live login.

This is consistent with the original architectural truth: SSO must complete in the context that will make the data requests.

---

## Implementation Notes (for Marcus)

**Files to change:**
- `src/tableau-auth.ts` — `startTableauLoginBrowser()`: replace isolated-context launch with shared-context page acquisition
- `src/ccsp-scraper.ts` — `restoreTableauSession()`: gate on "shared context has zero tableau cookies" (add a check before `ctx.addCookies()`)
- `src/bootstrap-orchestrator.ts` — no import changes needed; `startTableauLoginBrowser` signature stays the same

**Files NOT to change:**
- `rh-scraper.ts` — `getScrapeContext()` stays exactly as-is
- `scraper-manager.ts` — status reporting unchanged
- `TABLEAU_AUTH_PROFILE_DIR` isolated context — leave in place for now, stop using it

**Guard required:**  
Before opening the Tableau login page on the shared context, check `isLivePageBusy()`. If another scrape is in flight, return an appropriate error. The new flow must not preempt an active RH Portal or SF scrape.

**Regression tests to add:**
- Assert shared context is used for login (no `launchPersistentContext(TABLEAU_AUTH_PROFILE_DIR)` call from login path)
- Assert `restoreTableauSession` is gated on zero tableau cookies in shared context
- Assert VNC login page is opened on the shared context's page (not a new persistent context)

---

## Rejected Alternatives

| Option | Reason rejected |
|--------|----------------|
| A: Fix cookie injection between isolated and shared contexts | Tableau Cloud VizQL session bound to originating browser JS environment; cookies alone cannot transfer it |
| C: Tableau REST API (Personal Access Token / Connected App) | Requires Red Hat tenant admin to provision; doesn't grant CSV export access to embedded views |
| D: Use isolated profile for both login AND scraping | Forks the scraper architecture; duplicates all mutex/health/session-restore paths; breaks `getScrapeContext()` adoption pattern in 3 files |

---

## Consequences

- **Positive:** Tableau SSO and CCSP scraping in the same browser instance; VizQL session is valid; CSV endpoint returns real data.
- **Positive:** `sessionValid` in the status endpoint becomes meaningful (based on actual shared-context cookie presence, not a stale file).
- **Risk:** Tableau login page navigates in the shared context — if the SSO chain causes renderer instability, it affects RH Portal/SF scraping too. Mitigation: `setLivePageBusy(true)` prevents concurrent scraping during login. The original BKL-CONN-TABLEAU-CTX-01 crash was from a VizQL animation, not the SSO chain itself.
- **Neutral:** `TABLEAU_AUTH_PROFILE_DIR` isolated context becomes dead code; clean it up in a follow-on PR after Option B is verified working.
