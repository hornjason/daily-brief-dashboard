---
doc-type: reference
status: active
owner: jason
updated: 2026-05-05
---

# DailyBriefDashboard -- Enterprise Testing Strategy
*Status: Architecture/ADR — rationale only, not active commands | Last validated: 2026-04-20 | Trigger: Testing strategy changes, new test tiers added*

**Created:** 2026-04-10
**Author:** Serena Blackwood (Architect Agent)
**Status:** Approved for implementation
**Trigger:** 4 production data wipes by AI agent test runs in 10 days

---

## Problem Statement

Production data (105 customers, 9 AEs, all cached intelligence) has been wiped 4 times by test runs. The root causes are structural:

1. Destructive endpoints (`POST /api/setup/reset`, `POST /api/__test/restore`) have no guard against running with production data loaded
2. Frontend action buttons swallow errors with `catch(() => {})` -- features break silently
3. Test pyramid is inverted -- 396 tests are almost entirely E2E/API, zero unit tests
4. No seed data mechanism -- tests mutate live data because there is no alternative
5. Cache files are ephemeral -- wiped on every `make rebuild` with no auto-recovery

---

## Four Guardrail Layers (Defense in Depth)

### Layer 1: Customer-Count Guard Middleware (IMPLEMENTED)
**File:** `src/setup-routes.ts`
**What:** If `customers.length > 5`, `POST /api/setup/reset` returns 403 and `POST /api/__test/restore` (without prior snapshot) returns 403.
**Override:** Set `ALLOW_RESET=true` in container env for test environments only.
**Why 5?** Production always has 50-150 customers. Test fixtures have 1-3. The gap is enormous. Five is the safe ceiling for test data.

### Layer 2: Quinn Endpoint Allowlist
**File:** Test fixtures (`test/fixtures.ts` or Playwright global setup)
**What:** Quinn agent tests may only call endpoints from a curated allowlist. Destructive endpoints (`/api/setup/reset`, `/api/__test/restore`, `/api/bootstrap/auto`, `/api/bootstrap/pod`) are excluded unless the test explicitly opts in with a `DESTRUCTIVE_TEST=true` flag.
**How:** Playwright `globalSetup` wraps `page.route()` to intercept and block non-allowlisted POST calls. Any blocked call logs a warning with the endpoint name.

### Layer 3: Snapshot Enforcement
**File:** `src/setup-routes.ts` (already implemented)
**What:** `POST /api/__test/restore` requires a valid, non-stale (<24h) snapshot file on disk. Snapshots are one-time-use (consumed on restore). Snapshots read from in-memory state, not disk (fixes the 2026-04-08 stale-disk incident).
**Addition needed:** Snapshot should also log the customer count at snapshot time and refuse restore if the delta exceeds 50% (e.g., snapshot had 105 customers, restore is writing 2 -- something is wrong).

### Layer 4: ALLOW_RESET Environment Variable
**File:** Container env (Dockerfile / docker-compose / Makefile)
**What:** The env var `ALLOW_RESET=true` is NEVER set in the production container. It is only set in dedicated test containers or CI.
**Effect:** Without this env var, all destructive operations on datasets > 5 customers are blocked at the middleware level.

---

## Test Pyramid Target

```
Current state:          Target state:
    /  E2E  \  90%          /  E2E  \  15%
   / ~~~~~~~ \             / ~~~~~~~ \
  /   API     \  10%      /   API     \  25%
 / ~~~~~~~~~~~ \         / ~~~~~~~~~~~ \
/    Unit       \  0%   /    Unit       \  60%
```

### Unit Tests (60%) -- Bun native test runner
**Pattern:** Hono `app.request()` for route-level testing without a live server.
**Files:** `test/unit/*.test.ts`
**What gets unit-tested:**
- All route handlers via `app.request('/api/endpoint', { method: 'POST', body: ... })`
- Data transformation functions (slug generation, sanitization, domain inference)
- Config file parsing and validation
- Cache layer read/write/invalidation logic
- Health score calculation
- KPI aggregation

**Why Hono `app.request()`:** Zero network overhead, deterministic, sub-millisecond per test. Test the route logic without booting a server. This is the fundamental shift -- stop testing through a browser when you can test through a function call.

### API Tests (25%) -- Playwright against live server
**Files:** `test/api/*.spec.ts` (existing, mostly safe)
**What:** Read-only endpoint validation, response shape contracts, auth flow verification.
**Rule:** API tests NEVER call destructive endpoints. They verify data shape, status codes, and error messages only.

### E2E Tests (15%) -- Playwright browser tests
**Files:** `test/ui/*.spec.ts`, `test/e2e-*.spec.ts`
**What:** Critical user flows only -- setup wizard, bootstrap, customer detail page load, product intelligence page.
**Rule:** Every E2E test that touches state MUST wrap in snapshot/restore with a try/retry afterAll.

---

## Silent Failure Elimination

### Problem: 20+ `catch(() => {})` in frontend action buttons
When a "Generate Intelligence" or "Refresh Product" button fails, the user sees nothing. The button just stops working. This has hidden broken features for days.

### Solution: `useAction` Hook
**File:** `dashboard/src/hooks/useAction.ts` (new)

```typescript
// Pattern:
const { run, loading, error } = useAction(async () => {
  const res = await fetch('/api/customer/acme/intelligence/generate', { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
})

// In JSX:
<button onClick={run} disabled={loading}>
  {loading ? 'Generating...' : 'Generate Intelligence'}
</button>
{error && <div className="text-red-500">{error}</div>}
```

**What it replaces:** Every `fetch().then(...).catch(() => {})` pattern in action buttons.
**What it adds:** Loading state, error display, automatic error surfacing.
**Migration:** `grep -rn '.catch(() => {})' dashboard/src/` finds all 20+ instances. Replace one-by-one.

### ESLint CI Gate
**Rule:** Ban empty catch blocks in CI. Add to lint step:
```bash
if grep -rn '.catch(() => {})' dashboard/src/; then echo "FAIL: empty catch blocks found"; exit 1; fi
```
This is a zero-config gate that catches regressions immediately.

---

## Cache Resilience Plan

### Problem
Product intelligence caches, brief caches, and sheet data caches are wiped on every `make rebuild`. The weekly scheduler eventually re-seeds product caches, but between rebuild and Sunday the Product Intelligence page silently fails.

### Solution 1: Docker Volume for Cache Persistence
**File:** `Makefile`, `docker-compose.yml` (or Dockerfile)
**What:** Mount `data/cache/` as a named Docker volume. Caches survive `make rebuild`.
**Implementation:**
```makefile
# In Makefile rebuild target:
# Add: -v pai-dashboard-cache:/app/data/cache
```

### Solution 2: Startup Cache Warming
**File:** Server startup sequence (server.ts or background-scheduler.ts)
**What:** On boot, check if configured product slugs are missing summary caches. If missing, auto-trigger `refreshAllProducts()` in the background (non-blocking). Runs once per cold start.
**Already tracked as:** BKL-REG-02

### Solution 3: Seed Script (`make seed`)
**File:** `scripts/seed.ts` (new), Makefile target
**What:** Creates a minimal test dataset (1 AE, 3 customers with fake data) for development and testing. Does NOT touch production config files -- writes to a separate `data/test-config/` directory.
**Usage:** `make seed` before running tests. Tests point at `data/test-config/` instead of `data/config/`.

---

## Migration Path: Current State to Target State

### Phase 1: Stop the Bleeding (Week 1) -- P0
1. [DONE] Customer-count guard on `/api/setup/reset` and `/api/__test/restore`
2. Quinn endpoint allowlist in Playwright fixtures
3. ESLint/grep empty-catch ban in CI

### Phase 2: Shift the Pyramid (Weeks 2-3) -- P1
4. Create `test/unit/` directory with Bun test runner config
5. Write unit tests for 10 highest-risk route handlers using `app.request()`
6. Implement `useAction` hook and migrate 5 highest-traffic action buttons
7. Docker volume for cache persistence

### Phase 3: Full Coverage (Weeks 4-6) -- P2
8. Unit tests for all data transformation and cache functions
9. Migrate remaining 15+ action buttons to `useAction`
10. Seed script (`make seed`) for isolated test data
11. Startup cache warming for product intelligence

### Phase 4: Hardening (Ongoing) -- P3
12. Snapshot delta guard (refuse restore if customer count changes by >50%)
13. Stale fixture detection (compare `test/fixtures.ts` IDs against live data at test start)
14. Per-test timing budgets (fail tests that exceed 30s)

---

## What "Post-Wipe Resilience" Looks Like

When fully implemented, here is what happens if someone calls `POST /api/setup/reset?confirm=true`:

1. **Guard fires:** 105 customers loaded, ALLOW_RESET not set -> 403 response. Data untouched.
2. **If override is set (ALLOW_RESET=true in test env):** Reset proceeds, but this is a test container with fake data. Production is never at risk.
3. **If somehow data IS wiped (belt-and-suspenders):**
   - Config backup sheet (BKL-BACKUP-01) has latest aes.json + customers.json
   - `POST /api/admin/restore` rebuilds from Google Sheets
   - Startup cache warming re-seeds product intelligence
   - Docker volume preserved cache files through the rebuild
   - Recovery time: < 5 minutes instead of 1-2 hours

The fundamental constraint is: **production data and test data must never share the same execution context without a guard.** Every layer enforces this independently.

---

## Dangerous Test Inventory

| Test File | Risk | Current Guard | Needed Guard |
|-----------|------|--------------|--------------|
| `test/api/setup.spec.ts` | Calls `POST /api/setup/reset?confirm=true` | None (!) | Customer-count guard (done) |
| `test/bootstrap-e2e.spec.ts` | Mutates aes.json + customers.json | None (!) | Snapshot/restore wrapper |
| `test/e2e-carolanne.spec.ts` | Creates test AE data | Partial | Snapshot/restore wrapper |
| `test/lifecycle.spec.ts` | AE create/delete lifecycle | Snapshot/restore | OK (already guarded) |
| `test/qa-e2e-newuser.spec.ts` | Full setup wizard flow | Snapshot/restore | OK (already guarded) |
| `test/regression.spec.ts` | Read-only regression checks | Snapshot-wrapped | OK (safe) |
| `test/ui/customer-detail.spec.ts` | Read-only — all API calls mocked | page.route() mocks | OK (safe — no server writes) |

---

## File Reference

| Artifact | Path |
|----------|------|
| This strategy doc | `docs/BKL-TEST-STRATEGY.md` |
| Customer-count guard | `src/setup-routes.ts` (lines ~385-395, ~615-625) |
| Snapshot/restore endpoints | `src/setup-routes.ts` (lines ~590-670) |
| Quinn testing standard | `~/.claude/PAI/Testing/QUINN-STANDARD.md` |
| Quinn registry | `~/.claude/PAI/Testing/registries/dailybriefdashboard.md` |
| Backup/restore system | `src/backup-config.ts`, `src/backup-routes.ts` |
| Existing API tests (safe) | `test/api/*.spec.ts` |
| Existing E2E tests (dangerous) | `test/bootstrap-e2e.spec.ts`, `test/e2e-carolanne.spec.ts` |
