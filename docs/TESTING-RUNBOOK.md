# Testing Runbook

## TL;DR — Run all tests safely

```bash
# 1. Start test container with seed data
make seed && make test-up

# 2. Run read-only API tests against production (safe)
npx playwright test --project=ci

# 3. Run destructive tests against test container
BASE_URL=http://localhost:7776 npx playwright test test/api/

# 4. Run unit tests (no container needed)
bun test test/unit/

# 5. Clean up
make test-down
```

## Container Map

| Container | Port | Data Dir | ALLOW_RESET | Purpose |
|-----------|------|----------|-------------|---------|
| `pai-dashboard` | 7777 | `data/` | not set | **Production** — never wipe |
| `pai-dashboard-dev` | 7778 | `data-dev/` | not set | Dev snapshot of production |
| `pai-dashboard-test` | 7776 | `data-test/` | `true` | **Testing** — safe to wipe |

## What is seed data?

`data-test/` contains 2 fake AEs and 5 fake customers (Acme Corp, Globex Industries, Wayne Enterprises, Initech, Stark Industries) with pre-populated brief, sheets, CCSP, and intelligence caches. Account numbers are 990000x — guaranteed not to match real accounts.

Run `make seed` to reset `data-test/` back to this known state after any test run.

## Safe tests (run against port 7777)

These tests are read-only and safe to run against production:
- `test/api/customers.spec.ts` — GET endpoints only
- `test/api/intelligence.spec.ts` — GET endpoints only  
- `test/api/error-paths.spec.ts` — validation only
- `test/navigation-regression.spec.ts` — browser navigation only

## Destructive tests (run against port 7776 ONLY)

These tests write, reset, or wipe data:
- `test/api/setup.spec.ts` — calls POST /api/setup/reset and save-customers
- `test/lifecycle.spec.ts` — creates/deletes AEs
- `test/bootstrap-e2e.spec.ts` — full bootstrap flow

**Always run with `BASE_URL=http://localhost:7776`** or the production guard will block them.

## Resetting test state mid-run

```bash
make seed && make test-up
```

This stops the test container, wipes data-test/, re-seeds it from scripts/seed-data/, and restarts.

## CI gate for empty catches

```bash
make lint
```

Fails if any `.catch(() => {})` pattern exists in `dashboard/src/`. All action buttons must use `useAction` hook or explicit error logging.

## Adding new seed data

1. Edit files in `scripts/seed-data/` (NOT `data-test/` — that gets overwritten by `make seed`)
2. Run `make seed` to populate `data-test/` from your updated seed files
3. Run `make test-up` to apply to the running test container
