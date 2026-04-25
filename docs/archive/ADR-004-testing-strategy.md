> **ARCHIVED 2026-04-20 — Superseded by `docs/adr/ADR-004.md`. Kept as permanent record.**

# ADR-004: Testing Strategy — Test at the API Layer

**Date:** 2026-03-29
**Status:** Superseded — the 3-tier model (API/Regression/UI) described here has evolved into the 5-layer testing architecture documented in `docs/TESTING-RUNBOOK.md` and `docs/BKL-TEST-STRATEGY.md`. This ADR is kept as a permanent record of the original decision and its rationale.
**Last validated:** 2026-04-20
**Context:** Post-incident review — render tests didn't catch data-layer bugs

---

## Context

Prior to March 2026, the test suite consisted entirely of Playwright UI tests (`test/wizard.spec.ts`, `test/dashboard.spec.ts`). These tests:
- Mocked API responses via `page.route()`
- Verified that UI components rendered correctly
- Tested the **presentation layer** only

The `tableauTerritories` stripping bug, the CCSP silent-failure bug, and the 2-word name truncation bug ALL passed these tests because the mock APIs returned clean data. The real bugs lived in the data mutation paths that the render tests never touched.

---

## Decision

**Tests must be placed at the layer where bugs actually occur.**

For this application, that means:

### Tier 1: API contract tests (`test/api.spec.ts`)
- Use `fetch()` directly against the live server (no browser)
- Verify every endpoint returns the correct HTTP status and JSON shape
- Run with: `bun run test:e2e`
- Added in Phase 1 (commit `b067cf6`): 13 tests

### Tier 2: Regression tests (`test/regression.spec.ts`)
- One test per previously-fixed production bug
- Must FAIL before the fix and PASS after
- Covers state mutations, round-trips, validation gates
- Added in Phase 1 (commit `b067cf6`): 8 tests, REG-001 through REG-004

### Tier 3: UI render tests (`test/wizard.spec.ts`, `test/dashboard.spec.ts`)
- Keep for layout and UX regressions
- Do NOT use to verify data correctness — that's Tier 1/2's job

---

## The Regression Test Rule

**Every production bug that reaches the running application gets a regression test before the fix is merged.**

Process:
1. Bug found in production
2. Write a test that reproduces it → test FAILS
3. Fix the bug → test PASSES
4. Commit both the test and the fix in the same commit (or test first, fix second)
5. Test file stays forever — it is the living record that this bug was real

This rule applies to all bugs, no matter how small.

---

## Test File Naming

| File | Contents |
|---|---|
| `test/regression.spec.ts` | REG-NNN: one per historical bug |
| `test/api.spec.ts` | Contract tests for all endpoints |
| `test/wizard.spec.ts` | UI: setup wizard render/interaction |
| `test/dashboard.spec.ts` | UI: dashboard render/interaction |

---

## Running Tests

```bash
# Start the server first
bun run server.ts &

# Run all API + regression tests (no browser)
bun run test:e2e

# Or against the container
podman run --rm -p 7777:7777 ghcr.io/hornjason/daily-brief-dashboard
BASE_URL=http://localhost:7777 bun run test:e2e
```

---

## What "API Layer" Means Here

The Hono server is the trust boundary. Tests that `fetch()` the live server exercise:
- Request validation (400 on bad input)
- Business logic (e.g., CCSP requires tableauTerritories)
- State persistence (POST then GET round-trip)
- Error conditions (missing session, wrong body shape)

These are the exactly the paths where all real bugs have occurred.

---

## Consequences

- New endpoints require at minimum a shape test in `api.spec.ts`
- New validation rules require a 400-case test in `api.spec.ts`
- Any "it was working and now it's not" bug triggers a regression test
- CI runs `bun run test:e2e` against the container after publish

---

## Related

- API tests added in `b067cf6`
- CI smoke test added in `9b28e6e` (runs /health post-publish)
- ESLint enforcement pending (ADR-003)
