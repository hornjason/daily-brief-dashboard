---
Last validated: 2026-04-24
---

# DailyBriefDashboard — Development Principles

**Read this before designing any new feature, endpoint, or scraper change.**

These principles were distilled from real mistakes made during the 2026-03 build sprint. Each rule has a root cause. Knowing the root cause lets you apply the rule to cases it doesn't explicitly cover.

---

## 1. API Contract First

**Rule:** Define the endpoint shape before writing any implementation code.

**Checklist before adding any new endpoint:**
1. Does an endpoint already exist that does this or could be extended to do it?
2. What is the canonical URL pattern? (`/api/{resource}/{action}`)
3. What does success look like? What does failure look like? Write the response shape first.
4. Who calls this — bootstrap wizard, UI, background scheduler, test? All callers should use the same endpoint.

**What went wrong:** Bootstrap wizard got its own endpoints (`/api/bootstrap/supportable`, `/api/bootstrap/ccsp`). Later the UI needed the same scrapers. New ad-hoc endpoints added instead of asking "does this already exist?" Result: 10 endpoints doing the same category of work with different names.

**The question to ask early:** "Is this a new resource, or is this the same resource with a different caller?"

---

## 2. No Context-Specific Endpoints

**Rule:** Endpoints are named for the resource they operate on, not the UI context that first needed them.

| Wrong | Right |
|-------|-------|
| `/api/bootstrap/supportable` | `/api/scrape/supportable` |
| `/api/auth/redhat/sync` | `/api/scrape/rh` |
| `/api/bootstrap/ccsp` | `/api/scrape/ccsp` |

**Corollary:** The bootstrap wizard is a UI orchestrator. It calls standard API endpoints in sequence — it does not get its own backend endpoints. If bootstrap needs to scrape Supportable, it calls `/api/scrape/supportable`, same as the Data Sources page.

---

## 3. Name the Architecture Before You Build It

**Rule:** If you can't name the data flow in one sentence, you don't understand it well enough to build it yet.

**This project's two-stage pipeline:**
- **Type 1 (scrape):** Source system → Google Sheets via Playwright. Runs on demand or on a timer. Requires active session + VPN where applicable.
- **Type 2 (cache refresh):** Google Sheets → local JSON cache. Runs on a timer. Pure API calls, no browser required.

These are different operations with different triggers, different failure modes, and different endpoints. Mixing them up — or not naming them — is what caused the confusion about "what does refresh actually do?"

**The question to ask early:** "Is this a Type 1 scrape or a Type 2 cache refresh? Which stage does this new feature live in?"

---

## 4. Standardize Response Shapes

**Rule:** All endpoints in the same category return the same shape.

Every `POST /api/scrape/*` endpoint returns:
```typescript
{
  scraper: string
  status: 'ok' | 'partial' | 'error' | 'busy' | 'skipped'
  recordsWritten: number
  sheetUpdated: boolean
  cacheUpdated: boolean
  error: string | null
  durationMs: number
}
```

This means: one UI component handles all scraper results. One test assertion covers all scrapers. One error handler covers all failures.

**What went wrong:** Each scraper endpoint returned a different shape. The UI had four separate handlers with four separate error states, each with slightly different logic.

---

## 5. Audit Before Add

**Rule:** Before adding a new endpoint, search for existing ones. Before adding a new state variable, search for existing ones.

```
grep -r "api/scrape\|api/refresh\|api/auth" src/ dashboard/src/
```

If an endpoint already exists that does 80% of what you need, extend it — don't add a new one.

**The question to ask early:** "What would I grep for to find if this already exists?"

---

## 6. Source of Truth is Google Sheets — Protect It

**Rule:** Never overwrite a Google Sheet with empty or partial data. The Sheet is the source of truth. The local cache is a read cache.

Before any `sheets.spreadsheets.values.update()` call that clears and rewrites a sheet:
1. If `rows.length === 0` and the sheet already has data → **skip the write**, log a warning
2. If rows returned < expected threshold → log a warning, consider skipping

**What went wrong:** Scrapers cleared and rewrote their sheet even when the scrape returned 0 rows (session expired, quota hit, network failure). The local cache guard (`don't overwrite cache if new data is empty`) existed but only protected the cache — not the Sheet.

---

## 7. Session Checks Must Be Live Probes

**Rule:** "Connected" means a live request succeeded, not that a session file exists.

Before any scrape that requires an active session:
- Make a lightweight authenticated request to the target system
- Verify the response is NOT an auth redirect or error
- Only then start the scrape

**What went wrong:** All four connection cards showed "Connected" while a bootstrap run was failing because sessions had expired. `hasSession: true` just meant a session file existed on disk.

**The question to ask early:** "If I restart the container, would this status indicator still be accurate?"

---

## 8. Bun Timer Reliability

**Rule:** Never use `setInterval` with intervals longer than 1 hour in Bun. Use the 15-minute tick pattern instead.

```typescript
// Wrong — unreliable for long intervals
setInterval(() => refreshSubscriptions(), 4 * 60 * 60 * 1000)

// Right — 15-min tick checks elapsed time
setInterval(() => {
  const elapsed = Date.now() - lastRefreshed
  if (elapsed >= intervalMs) refreshSubscriptions()
}, 15 * 60 * 1000)
```

**What went wrong:** Subscription and CCSP refresh timers used raw `setInterval` with 4h+ intervals. Bun doesn't fire long intervals reliably — refreshes silently stopped.

---

## 9. The Gate Rule

**Before closing any backlog item:**
1. `make rebuild`
2. Run the narrowest test scope that covers the change
3. Rook Blackburn scans changed files + pattern siblings
4. 0 new failures vs baseline

**Before closing a security item:** Rook scans ALL scrapers, not just the changed one. Pattern siblings slip through without a full scan (confirmed: formula injection was fixed in one scraper, missed in sibling scrapers).

---

## 10. Maintenance Budget

**Rule:** Every new feature adds maintenance surface. Ask "what breaks if this feature's data source changes?" before building it.

This project has 4 external data sources (RH Portal, Supportable, Tableau, Salesforce). Each has its own session management, auth flow, and failure modes. Adding a 5th data source is not just adding an endpoint — it's adding a scraper, a session manager, a keep-alive, a mutex, a sheet writer, a cache refresher, and all associated failure handling.

**The question to ask early:** "What's the full maintenance cost of this feature, not just the build cost?"

---

## Quick Reference — Questions to Ask Before Any Change

| Situation | Question |
|-----------|----------|
| Adding an endpoint | Does one already exist for this resource? |
| Naming an endpoint | What context-free name describes the resource? |
| Writing to a Sheet | What happens if this returns 0 rows? |
| Adding a timer | Is the interval >1 hour? Use tick pattern if so. |
| Showing "Connected" | Is this a live probe or a flag read? |
| Building for bootstrap | Would the main UI also need this? Use same endpoint. |
| Closing a backlog item | Have Rook scan pattern siblings, not just changed files. |
| Adding a data source | What's the full maintenance cost? |
