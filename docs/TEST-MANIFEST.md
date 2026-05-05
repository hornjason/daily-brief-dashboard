---
doc-type: reference
status: active
owner: jason
updated: 2026-05-05
---

# Test Manifest

Status: Operational | Last validated: 2026-04-22 | Trigger: When test files added or tier config changes

Complete inventory of all test spec files, their tier classification, target environment, and run cadence.

## Playwright Projects (from playwright.config.ts)

| Project | Target | Grep/Match | Purpose |
|---|---|---|---|
| `ci` | 7777 (prod) | grepInvert: `@live\|@destructive` | Safe CI gate against production |
| `live-scrapers` | 7777 | grep: `@live`, match: `live-scrapers*.spec.ts` | Live credential tests (local only) |
| `test` | 7776 (test) | grep: `@destructive` | Destructive tests against test container |
| `integration-tier` | 7776 | match: `integration/**/*.spec.ts` | Integration seam tests |
| `e2e-tier` | 7776 | match: `test/*.spec.ts` | E2E UI flow tests |
| `smoke` | 7777 | match: `smoke-prod.spec.ts` | Fast prod gate (<30s) |
| `demo` | 7779 (mini) | match: `smoke-prod.spec.ts` + `test/*.spec.ts`, grepInvert: `@destructive` | Demo instance validation |

Global testIgnore: `bootstrap-e2e.spec.ts`, `unit/**`, `ux84-validation.spec.ts`, `visual-baseline.spec.ts`

## Run Commands

| Tier | Command |
|---|---|
| Unit | `bun test test/unit/` |
| Integration | `bunx playwright test --project=integration-tier` |
| E2E | `bunx playwright test --project=e2e-tier` |
| CI (safe prod) | `bunx playwright test --project=ci` |
| Destructive | `bunx playwright test --project=test` |
| Live scrapers | `bunx playwright test --project=live-scrapers` |
| Smoke | `bunx playwright test --project=smoke` |
| Demo | `bunx playwright test --project=demo` |
| Visual baselines | `bunx playwright test test/visual-baseline.spec.ts --update-snapshots` |

## Spec File Inventory

### Unit Tests (`bun test`, not Playwright)

| File | Tier | Env | Cadence | Status |
|---|---|---|---|---|
| `test/unit/account-numbers.test.ts` | unit | none | CI | active |
| `test/unit/ai-02-account-intel-ttl.test.ts` | unit | none | CI | active |
| `test/unit/ai-03-disallow-gemini.test.ts` | unit | none | CI | active |
| `test/unit/ai-04-ai-events.test.ts` | unit | none | CI | active |
| `test/unit/ai-05-corpus-delta.test.ts` | unit | none | CI | active |
| `test/unit/ai-events-mutations.test.ts` | unit | none | CI | active |
| `test/unit/ai-fingerprint-mutations.test.ts` | unit | none | CI | active |
| `test/unit/ai-fingerprint.test.ts` | unit | none | CI | active |
| `test/unit/cache-01-brief-filter.test.ts` | unit | none | CI | active |
| `test/unit/destructive-guard.test.ts` | unit | none | CI | active |
| `test/unit/gemini-fetch.test.ts` | unit | none | CI | active |
| `test/unit/ingest-01-sf-bookings-cache-ttl.test.ts` | unit | none | CI | active |
| `test/unit/ingest-02-sf-bookings-l2-freshness.test.ts` | unit | none | CI | active |
| `test/unit/ingest-03-ccsp-l3-drive-ttl.test.ts` | unit | none | CI | active |
| `test/unit/ingest-04-disallow-live-scrape.test.ts` | unit | none | CI | active |
| `test/unit/ingest-06-scheduler-retry.test.ts` | unit | none | CI | active |
| `test/unit/ingest-09-sync-state.test.ts` | unit | none | CI | active |
| `test/unit/ingest-10-refresh-l1-ttl.test.ts` | unit | none | CI | active |
| `test/unit/ingest-bug-ingest11-l2-cold-start.test.ts` | unit | none | CI | active |
| `test/unit/ingest-bug04-bearer-records-success.test.ts` | unit | none | CI | active |
| `test/unit/sanitize.test.ts` | unit | none | CI | active |
| `test/unit/slug.test.ts` | unit | none | CI | active |
| `test/unit/vertex-429.test.ts` | unit | none | CI | active |

### Integration Tests (Playwright, `--project=integration-tier`)

| File | Tier | Env | Cadence | Status |
|---|---|---|---|---|
| `test/integration/ae-isolation.spec.ts` | integration | 7776 | CI | active (@destructive) |
| `test/integration/cache-waterfall.spec.ts` | integration | 7776 | CI | active (@destructive) |
| `test/integration/corpus-delta-callsite.spec.ts` | integration | 7776 | CI | partial (3 skipped, @destructive) |
| `test/integration/corpus-delta.spec.ts` | integration | 7776 | CI | active (@destructive) |
| `test/integration/fingerprint-invalidation.spec.ts` | integration | 7776 | CI | partial (3 skipped, @destructive) |
| `test/integration/sse-contract.spec.ts` | integration | 7776 | CI | active (@destructive) |
| `test/integration/sse-events.spec.ts` | integration | 7776 | CI | partial (8 skipped, @destructive) |

### API Tests (Playwright, `--project=ci` or `--project=test`)

| File | Tier | Env | Cadence | Status |
|---|---|---|---|---|
| `test/api/auth.spec.ts` | e2e | 7777 | CI | active |
| `test/api/bootstrap.spec.ts` | e2e | 7777 | CI | active |
| `test/api/customers.spec.ts` | e2e | 7777 | CI | partial (3 skipped, has @live) |
| `test/api/error-paths.spec.ts` | e2e | 7777 | CI | active |
| `test/api/intelligence.spec.ts` | e2e | 7777 | CI | active (has @live) |
| `test/api/routes.spec.ts` | e2e | 7776 | CI | partial (1 skipped, @destructive) |
| `test/api/setup.spec.ts` | e2e | 7776 | CI | partial (3 skipped, @destructive) |
| `test/api/sheets.spec.ts` | e2e | 7777 | CI | partial (3 skipped) |
| `test/api/territory.spec.ts` | e2e | 7777 | CI | active |
| `test/contracts/api-contracts.spec.ts` | e2e | 7777 | CI | partial (3 skipped) |

### E2E / UI Tests (Playwright, `--project=e2e-tier` or `--project=ci`)

| File | Tier | Env | Cadence | Status |
|---|---|---|---|---|
| `test/accessibility.spec.ts` | e2e | 7777 | CI | active |
| `test/api.spec.ts` | e2e | 7777 | CI | active (@destructive subset) |
| `test/bootstrap-onboarding.spec.ts` | e2e | 7776 | CI | partial (8 skipped, @destructive) |
| `test/dashboard.spec.ts` | e2e | 7777 | CI | partial (1 skipped, has @live) |
| `test/lifecycle.spec.ts` | e2e | 7776 | CI | active (@destructive) |
| `test/navigation-regression.spec.ts` | e2e | 7777 | CI | partial (3 skipped) |
| `test/performance.spec.ts` | e2e | 7777 | CI | partial (4 skipped) |
| `test/product-filter.spec.ts` | e2e | 7777 | CI | partial (8 skipped) |
| `test/qa-e2e-newuser.spec.ts` | e2e | 7776 | CI | partial (11 skipped, @destructive) |
| `test/regression.spec.ts` | e2e | 7777 | CI | partial (43 skipped, has @live/@destructive) |
| `test/rh-bearer-phase2.spec.ts` | e2e | 7777 | manual | partial (6 skipped, @live) |
| `test/rh-solr-compare.spec.ts` | e2e | 7777 | manual | partial (7 skipped, @live) |
| `test/smoke-prod.spec.ts` | smoke | 7777 | CI | active |
| `test/ui-regression.spec.ts` | e2e | 7777 | CI | partial (30 skipped, has @live) |
| `test/wizard.spec.ts` | e2e | 7777 | CI | active |

### UI Sub-directory Tests (Playwright, `--project=ci`)

| File | Tier | Env | Cadence | Status |
|---|---|---|---|---|
| `test/ui/account-intelligence.spec.ts` | e2e | 7777 | CI | active |
| `test/ui/account-plan.spec.ts` | e2e | 7777 | CI | active |
| `test/ui/bootstrap-config-block.spec.ts` | e2e | 7777 | CI | active |
| `test/ui/bootstrap-recovery.spec.ts` | e2e | 7777 | CI | partial (1 skipped) |
| `test/ui/calendar.spec.ts` | e2e | 7777 | CI | active |
| `test/ui/customer-detail.spec.ts` | e2e | 7777 | CI | partial (2 skipped, @live) |
| `test/ui/dashboard-empty-state.spec.ts` | e2e | 7777 | CI | active |
| `test/ui/dashboard-pending.spec.ts` | e2e | 7777 | CI | partial (2 skipped) |
| `test/ui/pipeline-behavioral.spec.ts` | e2e | 7777 | CI | partial (1 skipped) |
| `test/ui/product-filter-coverage.spec.ts` | e2e | 7777 | CI | active |
| `test/ui/product-intel.spec.ts` | e2e | 7777 | CI | partial (1 skipped) |
| `test/ui/rh-session.spec.ts` | e2e | 7777 | CI | active |
| `test/ui/setup-oauth.spec.ts` | e2e | 7777 | CI | active |
| `test/ui/tableau.spec.ts` | e2e | 7777 | CI | active |
| `test/ui/wizard-validation.spec.ts` | e2e | 7777 | CI | partial (6 skipped) |

### Live / Manual-only Tests

| File | Tier | Env | Cadence | Status |
|---|---|---|---|---|
| `test/live-scrapers.spec.ts` | live | 7777 | manual | active (@live) |
| `test/live-scraper-e2e.spec.ts` | live | 7777 | manual | active (@live) |

### Excluded from CI (testIgnore)

| File | Tier | Env | Cadence | Status |
|---|---|---|---|---|
| `test/bootstrap-e2e.spec.ts` | e2e | 7776 | manual | excluded (testIgnore) |
| `test/ux84-validation.spec.ts` | e2e | 7777 | manual | excluded (testIgnore, session artifact) |
| `test/visual-baseline.spec.ts` | e2e | 7777 | nightly | excluded (testIgnore, platform-specific) |
