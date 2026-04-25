# Testing Runbook
*Last validated: 2026-04-23 | Owner: DA | Trigger: Makefile changes, playwright.config.ts changes, new test files added or removed*

> **Quick links:** [Agent Quick Reference](#agent-quick-reference) · [Flake SLO](#flake-slo) · [Test Tier Runtime Budgets](#test-tier-runtime-budgets)

---

## Agent Quick Reference

**Read this first. Full details for each topic are in sections below.**

### Marcus — writing a test for a bug fix

1. Pick the tier (wrong tier = false signal):

| Bug type | Tier | Location | Run command |
|---|---|---|---|
| Pure logic (no I/O) | unit | `test/unit/*.test.ts` | `bun test test/unit/` |
| API/seam/SSE/multi-module | integration | `test/integration/*.spec.ts` | `bunx playwright test --project=integration-tier` |
| UI/AE filter/user-visible flow | e2e | `test/regression.spec.ts` | `bunx playwright test --project=e2e-tier` |
| Onboarding/factory-reset | e2e destructive | `test/qa-e2e-newuser.spec.ts` | `bunx playwright test test/qa-e2e-newuser.spec.ts --project=e2e-tier --workers=1` |

2. Test must be deterministic. If it ever fails intermittently → tag immediately:
   `test.fixme('BKL-FLAKE-[spec-name]: [reason] — detected [date]')` → fix or delete within the sprint.

3. If touching `ai-fingerprint.ts`, `customer.ts` (corpus-delta gate), or `ai-events.ts` → run `npx stryker run`. Score must stay ≥ 88%.

4. Never move to DONE without a test or a documented reason it's untestable.

---

### Quinn — reading a test run

1. After any Playwright run with `CI=true`, check `test-results/test-metrics.json`:
   - `flows` → per-flow pass rates for 5 tracked flows (first-run-bootstrap, brief-generation, ae-filter, corpus-delta, new-user-flow)
   - `flake_candidates` → specs that needed retries to pass — flag these
   - Any tracked flow below 100% must be called out before declaring the gate green

2. Targeted run commands:
   - `bunx playwright test --project=integration-tier` — seam tests only
   - `bunx playwright test --project=e2e-tier` — UI/flow tests only
   - `bunx playwright test --project=smoke` — fast prod gate (<30s)

3. When UI changes ship intentionally, regenerate visual baselines:
   `bunx playwright test test/visual-baseline.spec.ts --update-snapshots`
   Stable surfaces: dashboard shell, brief card, wizard step 1. Never update without verifying the change was intentional.

---

### DA — CI gates at a glance

| Gate | Trigger | Blocks |
|---|---|---|
| tsc + unit tests | every PR | merge |
| playwright ci project | every PR | merge |
| qa-e2e-newuser | every PR | merge |
| Stryker mutation score | nightly (22:00 PT) | alert if <88%, never blocks PR |
| Visual baselines | every CI run | merge (on diff >2%) |
| test-metrics.json | every CI run (artifact) | reviewed by Quinn |

---

## Why we test

Every time code changes, something that worked before could silently break. Tests are automated checks that run the code and verify it still does what it's supposed to do — before the change reaches production and before a real customer sees a broken dashboard.

There are different kinds of tests for different kinds of breakage. This runbook explains all of them.

---

## The Five Testing Layers

Think of these as concentric rings — each one catches a different category of problem:

```
┌─────────────────────────────────────────────────────┐
│  Layer 5: LLM Eval (weekly)                         │  AI output quality
│  ┌───────────────────────────────────────────────┐  │
│  │  Layer 4: Release Gate (manual / v* tag)      │  │  Real credentials E2E
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │  Layer 3: Nightly L3 (Mac Mini, 2am)    │  │  │  Live OAuth pipeline
│  │  │  ┌───────────────────────────────────┐  │  │  │
│  │  │  │  Layer 2: CI (every PR + push)    │  │  │  │  Automated gate
│  │  │  │  ┌─────────────────────────────┐  │  │  │  │
│  │  │  │  │  Layer 1: Dev loop (local)  │  │  │  │  │  Before commit
│  │  │  │  └─────────────────────────────┘  │  │  │  │
│  │  │  └───────────────────────────────────┘  │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## Layer 1 — Developer loop (local, before every commit)

This is what happens on your machine during development. No GitHub involved yet.

The canonical 10-step dev loop is defined in `CLAUDE.md` and is mandatory — no step is optional:

### Step 1: Verify backlog state

Before touching anything, read the relevant source files and confirm the feature or bug is actually what the backlog says it is. BACKLOG.md drifts — the code does not lie. Many items are already done.

### Step 2: Does this need real account data?

Ask before starting the test container:
- **Yes** (the fix involves real Drive files, real scrapers, real OAuth) → `make test-rebuild-live` — preserves existing `data-test/`, does not wipe
- **No** (logic fix, UI change, anything testable with fake data) → `make test-rebuild` — seeds fake accounts

Never seed without asking this question first. Seeding wipes real data from the test container.

```bash
make test-rebuild-live  # real OAuth, preserves data-test/
make test-rebuild       # fake seed data, safe to wipe
make test-up            # no source changes, fast restart — same image
```

The test container runs on **port 7776**. Production runs on **port 7777**. They are completely separate.

**What is seed data?**
Fake customer data in `scripts/seed-data/` — 2 fake AEs, 5 fake customers (Acme Corp, Globex Industries, Wayne Enterprises, Initech, Stark Industries). Account numbers are 990000x — guaranteed not to match any real Red Hat account. Pre-populated with fake briefs, CCSP data, and intelligence caches so tests don't need to generate anything live.

### globalSetup pod contract validation (added 2026-04-20)

`test/globalSetup.ts` now includes a non-fatal pod contract health check that runs at suite start:

1. Verifies `KNOWN_CUSTOMER` exists on the active pod — warns if the pod's customer data doesn't include the fixture customer
2. Verifies AEs have `ccspSheetId` populated — warns if fixture drift has left AE config stale
3. Logs pod identification (pod name, AE count, customer count) so fixture drift is immediately visible in run output

These are **warnings, not failures** — the suite still runs so non-CCSP tests pass on a fresh container. If CCSP or intelligence tests fail with "empty data", check the globalSetup output first: it will name the drift.

**Fixture currency** (`test/fixtures.ts` and `test/globalSetup.ts`): If the pod is rebuilt or switched (e.g., NW → SW), the CAROLANNE fixture constants (`sfReportId`, `ccspSheetId`, `pipelineSheetId`, `supportableSheetId`) must be re-synced to live values from `GET /api/aes`. The pod contract validation will surface any mismatch.

---

### Test maintenance patterns (added 2026-04-23)

These patterns were established to keep the test suite green regardless of what auth sessions or data are present on the test container.

**Pattern 1 — Dynamic customer discovery (replaces hardcoded KNOWN_CUSTOMER)**

Never hardcode a customer name in a test. Use `getKnownCustomer()` from `test/regression.spec.ts`:

```typescript
async function getKnownCustomer(baseUrl = BASE_URL): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/accounts`)
    if (!res.ok) return null
    const body = await res.json()
    const customers = body?.customers ?? body ?? []
    if (!Array.isArray(customers) || customers.length === 0) return null
    return customers[0].name ?? null
  } catch { return null }
}

// Usage — always skip, never fall back to a hardcoded name:
const dynamicCustomer = await getKnownCustomer()
if (!dynamicCustomer) { console.log('No customers available — skipping'); return }
```

**Pattern 2 — Skip guards for auth-dependent tests**

Tests that require live auth (RH Portal, Salesforce, Tableau) must check before asserting:

```typescript
// RH Portal
const rhRes = await fetch(`${BASE}/api/auth/redhat/status`).catch(() => null)
if (rhRes) {
  const rh = await rhRes.json().catch(() => ({}))
  if (!rh.hasSession || rh.sessionExpired) { console.log('No RH session — skipping'); return }
}

// Salesforce (in describe-level beforeEach)
test.beforeEach(async () => {
  const sfRes = await fetch(`${BASE}/api/auth/salesforce/status`).catch(() => null)
  if (sfRes) {
    const sf = await sfRes.json().catch(() => ({}))
    if (!sf.hasSession || sf.sessionExpired) test.skip(true, 'Salesforce session not active')
  }
})
```

**Pattern 3 — Live-data guard for @destructive suites**

Suites that wipe and reset data (qa-e2e-newuser) must detect real production data BEFORE running the reset. Real data = non-test AE names + >10 customers:

```typescript
test.beforeAll(async ({ request }) => {
  const preAesRes = await request.get(`${BASE}/api/aes`)
  const preAes: any[] = (await preAesRes.json()).aes ?? []
  const preHealth = await (await request.get(`${BASE}/health`)).json()
  const hasRealData = preAes.length > 0 &&
    !preAes.every((a: any) => /test|contract|acme/i.test(a.name ?? ''))
  if (hasRealData || (preHealth.customers ?? 0) > 10) {
    test.skip(true, 'Container has real production data — @destructive suite skipped')
    return
  }
  // ... proceed with snapshot + reset
})
```

**Pattern 4 — Bootstrap-completion guard for serial chains**

When serial tests depend on a previous test's bootstrap completing, guard on the shared status variable:

```typescript
// Shared state set by the "all steps complete" test:
let ae1BootstrapStatus: any = null
// ...
ae1BootstrapStatus = status  // set in "all 6 steps" test

// In downstream tests:
if (!ae1BootstrapStatus) { test.skip(true, 'Bootstrap did not complete'); return }
```

**Seed wipe behavior (updated 2026-04-23)**

`make seed` now wipes `data-test/cache/` completely before copying fresh seed files. This prevents stale real-customer cache files from persisting under fake-seed config.

`make test-rebuild-live` and `make test-up-live` now clean stale session files (`.rh-session.json`, `.sf-session.json`, Chrome cookies) before starting. This prevents dead sessions from carrying over between test runs.

**data-test/ sync strategy**

`data-test/config/` should mirror production `data/config/` for `make test-rebuild-live` runs:

```bash
cp data/config/aes.json data-test/config/aes.json
cp data/config/customers.json data-test/config/customers.json
make test-up-live
```

Do this whenever production AE or customer config changes significantly.

---

### Step 3: Research before implementing

For any non-trivial change, a researcher agent (CodexResearcher, PerplexityResearcher, or ClaudeResearcher) gathers API docs, known gotchas, and existing patterns before any code is written. Skip only for purely mechanical fixes (typo, config value swap, copy-paste of an existing pattern).

### Step 4: Code the fix (Marcus Webb)

Marcus writes the change informed by research findings. Reads the source file first. Surgical fixes only — never touches scraper files without explicit instruction.

### Step 5: Full Playwright suite on 7776

Marcus runs the test suite against the test container and reports output to the DA. The DA reads the output and signs off. Worktree agent results do not satisfy this gate — must be run against the real test container.

```bash
bunx playwright test --project=test   # destructive tests on 7776
bunx playwright test --project=ci     # read-only regression on 7777
bun test test/unit/                   # unit tests (no container needed)
```

Playwright is a browser automation tool. It opens a real Chrome browser, navigates to the dashboard, clicks buttons, fills forms, and asserts the right things appear on screen or the right API responses come back. This catches things unit tests can't — like a React component that crashes on render, or an API endpoint that returns the wrong shape.

**The two Playwright projects:**

| Project | Target port | What tests run | Can it wipe data? |
|---------|------------|----------------|-------------------|
| `test` | 7776 (test container) | Everything including destructive resets | Yes — safe |
| `ci` | 7777 (production) | Read-only only — never writes or wipes | No |

**Never mix these up.** Running `--project=test` destructive tests against port 7777 wipes production data.

### Step 6: "Do we have a test for this?"

Mandatory question after every fix. If no regression test exists for the bug, Marcus writes one in the same session before the item closes. A fix without a test means the bug can silently come back.

### Step 7: `make rebuild` to production (DA only)

The DA runs `make rebuild` from the project root. No agent or manual docker/podman command — only `make rebuild`. Only after steps 1–6 pass.

### Step 8: Quinn Torres verifies on 7777

Quinn validates visually on production after every rebuild with UI changes. Checks that the UI looks and functions correctly — not just that it loads. Spawned automatically after every rebuild, not on request.

### Step 9: Rook Blackburn scans changed files

Rook scans all changed files plus pattern siblings for security issues. Mandatory every build cycle. Spawned automatically, not on request.

### Step 10: Update BACKLOG.md + docs

The moment an item is done: update its status in BACKLOG.md, update affected docs with a new `Last validated` date, delete any session artifact docs linked to the closed item.

---

## Layer 2 — CI (every PR and every push to main)

**Trigger:** Automatically starts whenever a pull request is opened against main, or a commit is pushed to main.

**Location:** `.github/workflows/ci.yml`

**Purpose:** Catch problems before bad code reaches production. No human needs to start this — GitHub starts it automatically.

### The four CI jobs

```
PR or push to main
    │
    ├── job 1: "Unit tests & type check"     ← runs immediately, ~3 min
    │
    └── job 2: "Integration & E2E tests"     ← runs in parallel, ~25 min
    │     (needs build artifact from job 1)
    │
    └── (main push only, not PRs):
          ├── job 3: "Build & push container image"   ← runs after job 1, ~5 min
          └── job 4: "Container smoke test"           ← runs after job 3, ~2 min
```

### Job 1: "Unit tests & type check"

**What it does, step by step:**
1. `bun install` — installs all dependencies (same versions as production, locked)
2. `cd dashboard && bunx tsc --noEmit` — TypeScript compiler checks every file for type errors. Does NOT produce output files — just checks. If you pass a string where a number is expected, this fails.
3. `bun test src/ test/unit/` — runs all unit tests (23+ files in `test/unit/` + embedded test files in `src/`)
4. `cd dashboard && bun run build` — Vite builds the React frontend into static files. If any import is broken or a component has a syntax error, this fails.
5. Uploads the built files as an artifact for job 2 to download

**What this catches:** Type errors, broken imports, logic bugs in isolated functions, build failures.

**Does this run on PRs?** Yes — and it's a **required status check**. The merge button is locked until this passes.

### Job 2: "Integration & E2E tests"

**What it does, step by step:**
1. `bun install` — installs dependencies
2. `bunx playwright install --with-deps chromium` — downloads a headless Chrome browser
3. Downloads the dashboard build artifact from job 1 (so it uses the exact same built files)
4. **Seeds test data:** Copies fake customer data from `scripts/seed-data/` into `config/` and `cache/` directories. Renames brief cache files to today's date so TTL checks don't expire them. Sets up 5 fake customers.
5. Starts the Bun server pointed at the seeded `config/` directory
6. `bunx playwright test --project=ci --workers=2` — runs all tests tagged for CI

**What `--project=ci` includes:**
- API contract tests — calls every GET/POST endpoint and verifies the response shape
- Regression tests — specific scenarios that caught bugs in the past, now locked in as tests
- UI tests — loads dashboard pages in a real browser, checks components render correctly
- Navigation tests — clicks through the app, verifies no broken routes or 404s
- Performance tests — checks response times don't regress
- Accessibility tests — basic a11y checks

**What `--project=ci` deliberately excludes:**
- `@live` tagged tests — need real OAuth sessions OR real production case/customer data (not available in CI seed)
- `@destructive` tagged tests — need real data to reset (seed data is already reset)
- Bootstrap E2E — needs real Google Drive/Sheets credentials

**`@live` tag policy:** Use `@live` for any test that requires real production data — not just OAuth sessions. Tests waiting on the Cases badge, territory names from real scrapes, or disk-cache URLs from live RH Portal all require `@live`. Without it the test times out (20-30s) on seed data.

**What this catches:** Broken API endpoints, React components that crash, wrong response shapes, navigation errors, UI regressions.

**Does this run on PRs?** Yes — and it's a **required status check**. The merge button is locked until this passes.

**Important:** In CI, there is no Docker container. The server runs as a raw Bun process. This means container-specific issues (startup sequence, env var injection, file permissions) are NOT caught here. That's what job 4 (smoke test) catches.

### Job 3: "Build & push container image" (main push only, not PRs)

**What it does:** Builds the Docker/Podman container image and pushes it to the GitHub Container Registry (ghcr.io). This is what gets pulled when you run `make rebuild` on your machine.

**Why not on PRs?** We don't push an image for every PR — only for code that's been reviewed and merged to main.

**What this catches:** Containerfile errors, missing files, build-time environment issues.

### Job 4: "Container smoke test" (main push only)

**What it does:**
1. Pulls the freshly-pushed container image
2. Starts it on port 7777
3. Waits up to 60 seconds for it to respond
4. Calls `GET /health` and verifies the response body is `{"status":"ok"}`
5. Stops and removes the container

**Why this exists:** Job 2 runs the server as a raw process. This job runs it as an actual container. These can fail differently — a missing env var that's implicit on your machine might not exist in the container. The smoke test catches that before the image is tagged `:latest`.

**What this catches:** Container startup failures, missing environment variables, port binding issues, health check regressions.

### Branch protection gates

In GitHub Settings → Branches → main, two checks are **required before any PR can merge:**

- `Unit tests & type check` — job 1 must be green
- `Integration & E2E tests` — job 2 must be green

"Require branches to be up to date before merging" is also enabled — a PR that was green yesterday can't merge if main moved forward in the meantime. It must be rebased/updated and re-run.

---

## Layer 3 — Nightly L3 (Mac Mini, 02:00 PT every night)

**Location:** `.github/workflows/nightly.yml`

**Why it exists:** CI (Layer 2) uses fake data and no real credentials. It can't test "does a real bootstrap actually write to Google Drive?" or "does the RH Portal scraper return real account data?" The Mac Mini has live OAuth sessions for Google, Salesforce, RH Portal, and Tableau — it's the only machine that can run these tests.

**Trigger:** Automatically at 02:00 PT every night via cron schedule, or manually.

**Runner:** Mac Mini (self-hosted GitHub Actions runner, not GitHub's cloud machines)

### Job 1: Pre-flight health check (~30 seconds)

Before committing to the full 90-minute suite, checks:
- Is the test container (port 7776) responding?
- Are OAuth sessions valid for all 4 services?

If any check fails, the nightly logs a warning and skips the full suite rather than wasting 90 minutes failing on an expired session. A voice alert fires on the Mac Mini.

### Job 2: L3 onboarding suite (`make onboarding-check`, ~50-90 min)

Six phases that test the full end-to-end customer onboarding pipeline with real credentials:

| Phase | What it tests | Why it matters |
|-------|--------------|----------------|
| 0 | Pre-flight auth | Verify all 4 OAuth sessions are active before starting |
| 1 | Clean slate wipe | `POST /api/setup/reset` clears all AEs + customers; OAuth tokens preserved |
| 2 | AE #1 bootstrap | Full single-AE bootstrap: validates Drive parent folder, creates config sheet, creates 4 customer sub-sheets, runs RH Portal scraper, generates CCSP data, generates a brief via Gemini. Asserts 4 sheet IDs in config, customers.json has entries, Drive folders exist. |
| 3 | AE #2 sequential | Bootstraps a second AE. Asserts AE #1's data is unchanged. Verifies CCSP cache is reused (not regenerated). |
| 4 | Pre-POD wipe | Resets again. Verifies connections survive a reset. |
| 5 | POD bootstrap | Bootstraps all AEs as a POD. Runs intelligence doc generation for all customers. Verifies CCSP + pipeline data. |
| 6 | UI sweep | Opens the dashboard in a browser. Checks every major tile renders. Checks account detail pages. Verifies no 4xx or 5xx errors in the browser console. |

**What this catches that CI doesn't:**
- Google Drive permissions errors
- Salesforce API schema changes
- RH Portal scraper session expiry
- Gemini generation failures under real load
- Race conditions in the bootstrap orchestrator that only appear with real network latency

**Does this block merging?** No — `continue-on-error` is set. If it fails, it sends a voice alert and logs to GitHub Actions, but doesn't block the branch.

---

## Layer 4 — Release gate (manual or `v*` tag)

**Location:** `.github/workflows/release.yml`

**Trigger:** Manually via `workflow_dispatch`, or when a git tag matching `v*` is pushed (e.g. `v1.2.0`).

**Purpose:** The final gate before a versioned production release. Requires explicit human approval in GitHub Settings → Environments → production before any job runs.

**What it does:**
1. Waits for a named approver to click Approve in GitHub
2. Runs the full E2E suite with real credentials (Google, Salesforce, RH Portal, RH Password)
3. Only if that passes: builds and pushes the versioned image as `:v1.2.0` and `:stable`

**What `:stable` means:** The last release-gated image. `make rebuild` on your machine pulls `:latest` (every main push). A production deployment would use `:stable` or a specific version tag.

**What this catches:** Anything Layer 2 and 3 didn't catch, plus the production environment approval requirement means no version ships without a deliberate decision.

---

## Layer 5 — LLM Eval (weekly, or on prompt changes)

**Location:** `.github/workflows/eval.yml`

**Trigger:** Every Sunday at 03:00 UTC, or when files in `prompts/**` or `eval/**` change, or manually.

**Purpose:** The other layers test whether the app works. This layer tests whether the AI output is good.

**What it does:**
1. Takes 10 synthetic (fake) customer profiles from `eval/goldens/archetypes.yaml`
2. Runs each through the brief synthesis prompt against Gemini Flash
3. A second Gemini Flash instance acts as judge, scoring each brief 1-5 on four dimensions:
   - **Factuality** — did the brief only include facts from the input signals? (5 = every claim grounded, 1 = fabricated specifics)
   - **Completeness** — did it cover all signal categories that matter? (5 = nothing missed, 1 = ignored most input)
   - **Actionability** — did it surface a concrete next action for the SA? (5 = specific, time-bound action, 1 = no actions at all)
   - **No-hallucinations** — did it avoid inventing names, dates, or numbers? (5 = verbatim from signals, 1 = invented specifics)
4. Reports pass/fail per archetype. Results saved to `eval/results/latest.json`.

**Current baseline (2026-04-18):** 2/10 pass. Consistent actionability gap — model summarizes situations rather than leading with concrete next actions. Tracked as BKL-BRIEF-PROMPT-01.

**Does this block merging?** No — `continue-on-error: true`. It's informational only. Use it to track whether prompt changes improve or regress quality.

**Cost:** ~$0.05 per run (10 archetypes × Gemini Flash pricing). Runs once a week.

**What this catches:** Prompt regressions when the synthesis prompt is changed. Model behavior drift across Gemini version updates.

---

## Test file reference

### Unit tests (`test/unit/`)

No browser, no server. Pure function input/output testing.

| File | What it tests |
|------|--------------|
| `gemini-fetch.test.ts` | `fetchGeminiWithRetry` — Retry-After header parsing, exponential backoff, mid-loop re-parse |
| `ingest-bug-ingest11-l2-cold-start.test.ts` | BKL-INGEST-11 regression — L2 SF Bookings short-circuit guards on `aeHasCustomers`; prevents zero-customer state when customers.json is wiped but AE sheets are still fresh (12 tests) |
| *(other unit test files)* | Individual helper functions |

### Regression tests (`test/regression.spec.ts`)

The most important test file. Contains one test per past bug. When a bug is fixed, a regression test is added so it can never silently come back. Each test is tagged with its BKL backlog ID.

**Current coverage (as of 2026-04-18):** 127 tests across 19 endpoints. Notable gaps: backup/restore (0 tests — BKL-TEST-P1-04), product intelligence mutations (0 tests — BKL-TEST-P2-02).

### UI regression tests (`test/ui-regression.spec.ts`)

Playwright tests that check specific UI flows that have broken before. Runs in CI against the seeded test data.

### API tests (`test/api/`)

Contract tests for API endpoints — verify response shapes, status codes, and required fields. Safe to run against production (read-only).

| File | Endpoints covered |
|------|------------------|
| `customers.spec.ts` | GET /api/aes, /api/briefs, customer detail GETs |
| `intelligence.spec.ts` | GET /api/intelligence/status, /validate-all |
| `error-paths.spec.ts` | 400/404/422 validation responses |
| `setup.spec.ts` | POST /api/setup/reset, /save-customers (**destructive — test container only**) |

### UI tests (`test/ui/`)

Full browser tests for individual dashboard pages and components.

| File | What it covers |
|------|---------------|
| `customer-detail.spec.ts` | Case modal open/close lifecycle, SSE stream handling, backdrop click |
| `dashboard.spec.ts` | Main dashboard renders, tiles load, no console errors |
| `product-filter.spec.ts` | Product filter chip bar, KPI/ACV/CCSP all reflect filter state |

### E2E and lifecycle tests

| File | What it covers | Container |
|------|---------------|-----------|
| `test/lifecycle.spec.ts` | Create/delete AEs, verify data isolation | 7776 only |
| `test/bootstrap-e2e.spec.ts` | Full bootstrap flow with seed data | 7776 only |
| `test/bootstrap-onboarding.spec.ts` | Full 6-phase onboarding with real OAuth (`make onboarding-check`) | 7776 + live auth |

---

## Container reference

| Container | Port | Data directory | Can reset? | Use for |
|-----------|------|---------------|-----------|---------|
| `pai-dashboard` | 7777 | `data/` | No | Production — never wipe |
| `pai-dashboard-dev` | 7778 | `data-dev/` | No | Dev snapshot of production |
| `pai-dashboard-test` | 7776 | `data-test/` | Yes | All testing |

---

## Quick command reference

```bash
# Unit tests only (no container needed, ~5s)
bun test test/unit/

# Start test container with fake seed data
make test-up          # fast restart, same image
make test-rebuild     # rebuild image first (use after source changes)
make test-up-live     # preserve real data + OAuth sessions

# Run Playwright tests
bunx playwright test --project=test   # destructive tests (7776 only)
bunx playwright test --project=ci     # read-only regression (7777)

# Full onboarding E2E (needs live OAuth on 7776, ~50-90 min)
make onboarding-check

# Reset test data mid-run
make seed             # wipe data-test/ and re-seed from scripts/seed-data/

# Lint check (catches empty catch blocks on action buttons)
make lint

# LLM eval (needs GEMINI_SERVICE_ACCOUNT_KEY in .env)
bash eval/run-eval.sh
```

---

## Reset Between Tests

To wipe all cache + config between test runs (keeps OAuth keys intact):

```bash
curl -X POST http://localhost:7776/api/setup/reset?confirm=true
```

This deletes all cache files, `customers.json`, and `aes.json` — the same operation as the "Reset Data Only" button in the Setup page. Requires `ALLOW_RESET=true` (test container only — this flag is NOT set on port 7777 production).

**When to use:** Before any cold-start bootstrap test where you need a clean slate. Also used between repeated ingestion runs to verify L3/L4 waterfall paths.

---

## SSE Cache-Level Monitoring During Tests

To observe the L1→L4 cache waterfall in real time during a bootstrap or refresh run:

```bash
curl -N http://localhost:7776/api/ingest/events
```

Expected event sequence on a warm L1 run:
```
event: connected
data: {"type":"connected","timestamp":"..."}

event: cache-level
data: {"type":"cache-level","ae":"Carolanne Farrell","flow":"sf-bookings","level":"L1","rowCount":42,"timestamp":"..."}
```

On a cold L3 run (after reset), expect `"level":"L3"` events for `ccsp` and `pipeline` flows, and `"level":"L3"` for `sf-bookings`.

**Note:** These events only fire on the waterfall path (second+ bootstrap run, daily refresh). Onboarding (first-time folder creation for a new AE) does NOT emit cache-level events — this is expected behavior.

**Baseline timings** (2026-04-19, Carolanne Farrell, 11 customers):

| Run type | Condition | Time |
|----------|-----------|------|
| Cold onboarding (new Drive folder) | No L1, L2, or L3 cache | 27.2s |
| L2 warm | L1 wiped, AE GSheets fresh | ~15s |
| L1 warm | Local cache present and fresh | ~5s |

---

## Adding new seed data

1. Edit files in `scripts/seed-data/` — **not** `data-test/` directly (it gets overwritten)
2. Run `make seed` to populate `data-test/` from your updated seed files
3. Run `make test-up` to apply to the running test container

---

## When a test fails in CI

**Job 1 failure (Unit tests & type check):**
- TypeScript error → read the tsc output, fix the type
- Unit test failure → the function broke — fix the function, not the test
- Build failure → broken import or component syntax error

**Job 2 failure (Integration & E2E tests):**
- GitHub uploads a Playwright HTML report as an artifact on failure
- Download it from the Actions run → open `index.html` → see screenshots + traces of the exact failure
- Common causes: API response shape changed, React component crashes on new data shape, new endpoint not covered by seed data

**Nightly L3 failure:**
- Voice alert fires on Mac Mini
- Check GitHub Actions → nightly workflow → which phase failed
- Most common: OAuth session expired (RH Portal ~8h, Salesforce ~24h)
- Fix: refresh the session via the dashboard UI on 7776, then re-trigger manually

---

## Flake SLO

A flaky test is a test that passes sometimes and fails sometimes without any code changes to the code it exercises. Flakes erode trust in the whole suite — when devs see a red run, they need to believe it means the code is broken, not the test. One persistent flake poisons the whole gate.

**Definition:** any test that fails more than 1 run out of the last 7 runs (≈15% flake rate) is a flake candidate and must be quarantined.

**Process (24-hour quarantine window):**

Within 24 hours of identifying a flake, the owner of the affected area tags the test with `test.fixme()` and a structured reason:

```ts
test.fixme('BKL-FLAKE-[spec-name]: [reason] — detected [date]', async ({ page }) => {
  // … existing test body unchanged …
});
```

Example:

```ts
test.fixme('BKL-FLAKE-customer-detail-sse: SSE disconnect races modal close — detected 2026-04-19', async ({ page }) => {
```

This tells Playwright to skip the test but keep the code visible in the suite so it can't silently rot.

**Immediate action (no 7-run wait):** any test that emits intermittent timeout or network errors — even on a single run — gets a quarantine tag immediately. Do not wait for the statistical threshold. A flake you've seen once you will see again.

**Sprint rule:** `.fixme` quarantine tags older than one sprint (2 weeks) must be resolved. Resolve = either (a) fix the underlying flake and re-enable the test, or (b) delete the test if the flake is unfixable and the coverage is redundant. `.fixme` is not a permanent state. Tags older than 1 sprint without resolution are a process violation.

**Tracking (until BKL-OBS-01 ships automated detection):** manually check `playwright-report/` artifacts in CI runs for tests that showed up on the retry path (Playwright's `retries: 2` in CI masks flakes as green — look at the HTML report to see which tests needed a retry to pass). Flakes surface as `flaky` status in the report summary. Record candidates in BACKLOG.md under the `BKL-FLAKE-*` prefix.

**BKL-OBS-01** will ship automated flake tracking that queries the last 7 runs from the CI history and posts candidates to a GitHub issue automatically. Until then, the manual check above is the gate.

### Current quarantined flakes (tagged 2026-04-20)

| BKL ID | Spec | Failure pattern | Fix approach |
|---|---|---|---|
| `BKL-FLAKE-REG005` | `regression.spec.ts` REG-005 `fromCache: true` poll | Parallel tests force-regenerate the same customer brief mid-poll, so second call never hits cache | Move to test container (7776) with snapshot/restore isolation, or use a dedicated fixture customer not shared with other tests |
| `BKL-FLAKE-UI-REG008` | `ui-regression.spec.ts` SF Sync Now text persistence | Under `fullyParallel: true`, another test navigates away before the persisted text assertion fires | Replace `networkidle` wait with explicit `locator.waitFor()` on the timestamp element (serial mode reduces probability but doesn't eliminate the root cause) |
| `BKL-FLAKE-PRODUCT-INTEL` | `ui/product-intel.spec.ts` 500 error banner | Mock route for POST `/api/products/features/refresh` sporadically not intercepted before real request fires | Register `page.route()` before page load in `beforeEach` with `page.unrouteAll()` teardown — the route timing is the root cause, not parallel load |

> **⚠ Latent flake cluster (BKL-TEST-AUDIT-08):** `ui-regression.spec.ts` uses `waitForLoadState('networkidle')` in 10+ locations. Under `fullyParallel: true`, networkidle is unreachable when other parallel tests share the same origin. BKL-FLAKE-UI-REG008 is one manifestation; the other 9 uses are latent flakes masked by CI `retries: 2`. Fix: replace all with element-specific `locator.waitFor()`.

---

## Spec Inventory

> **Note:** This table is the interim reference until BKL-TEST-MONITOR-01 ships a live test-health dashboard. When the dashboard is live, this section will be removed — the dashboard is the source of truth.
> Last updated: 2026-04-22 | 49 spec files | **580 passed / 0 failed / 26 skipped** (NW pod, parallel CI run 2026-04-20)
>
> **Known issues found in council audit 2026-04-22:** (1) `live-scrapers.spec.ts` Test 4 calls permanently-disabled Supportable endpoint — fails nightly silently (BKL-TEST-AUDIT-03). (2) `e2e-carolanne.spec.ts` and `quinn-*.spec.ts` testIgnore entries are dead — no matching files exist on disk (BKL-TEST-AUDIT-04). (3) `qa-ae-section.spec.ts` exclusion comment is inaccurate — file does GET-only, not POST (BKL-TEST-AUDIT-04). (4) This table is missing `qa-ae-section.spec.ts` — it exists on disk but is excluded from both CI and this inventory.

| File | Project/Tier | Tests | What It Validates |
|---|---|---|---|
| `accessibility.spec.ts` | ci / e2e-tier | 2 | axe-core WCAG 2.1 AA scan on dashboard + setup; BKL-A11Y-01 color-contrast known issue |
| `api.spec.ts` | ci / e2e-tier | 12 | Health, AE config CRUD, bootstrap pre-checks, RH + SF auth status shapes |
| `bootstrap-e2e.spec.ts` | **excluded (testIgnore)** | 18 | Full wizard bootstrap for Carolanne Farrell — 6 steps, SF customers, brief generation |
| `bootstrap-onboarding.spec.ts` | test (destructive) | 39 | 6-phase onboarding smoke: pre-flight → wipe → AE #1 → AE #2 → POD wipe → POD bootstrap |
| `dashboard.spec.ts` | ci / e2e-tier | 8 | RH session banner, noVNC reconnect flow |
| `lifecycle.spec.ts` | test (destructive) | 4 | AE add/remove lifecycle with snapshot/restore wrapping |
| `live-scrapers.spec.ts` | live-scrapers (@live) | 6 | Serial scraper pipeline — RH Cases, SF, CCSP, full pipeline freshness. **⚠ Test 4 calls permanently-disabled Supportable endpoint (BKL-TEST-AUDIT-03) — fails nightly.** |
| `navigation-regression.spec.ts` | ci / e2e-tier | 6 | Sidebar nav regression, active class CSS |
| `performance.spec.ts` | ci / e2e-tier | 8 | Response-time budgets for all key endpoints |
| `product-filter.spec.ts` | ci / e2e-tier | 10 | Product filter chips — render, click, multi-select, localStorage, clear |
| `qa-e2e-newuser.spec.ts` | test (destructive) | 24 | Brand-new user journey: factory state → wizard → AE config → dashboard |
| `regression.spec.ts` | ci / e2e-tier | 314 | Comprehensive bug-fix regression — one test per previously-fixed issue |
| `rh-bearer-phase2.spec.ts` | test (@live @destructive) | 10 | RH Bearer transport regression (ADR-014) |
| `rh-solr-compare.spec.ts` | test (@live @destructive) | 2 | Server-side SOLR cases shape, timing, multi-account OR queries |
| `smoke-prod.spec.ts` | smoke | 6 | Post-rebuild prod gate on 7777: health, customers, AE list, brief, console, circuit breakers |
| `ui-regression.spec.ts` | ci / e2e-tier | 30 | UI regression items — BKL-UX77/83/84/102/109/110/111/UX97 |
| `ux84-validation.spec.ts` | ci | 1 | BKL-UX84 parent Drive folder safety — empty-on-load, disabled-until-validated |
| `visual-baseline.spec.ts` | ci / e2e-tier | 3 | Screenshot regression: dashboard shell, brief card, wizard step 1 |
| `wizard.spec.ts` | ci / e2e-tier | 25 | Setup accordion sections — OAuth, Google Auth, Connections, Full POD, Bootstrap flow |
| `api/auth.spec.ts` | ci | 8 | Auth status endpoint shapes for `/api/auth/redhat`, `/api/scraper-status` |
| `api/bootstrap.spec.ts` | ci | 11 | Bootstrap API surface — status, reset, auth guards, duplicate-prevention, tableau |
| `api/customers.spec.ts` | ci | 21 | Per-customer endpoints — ccsp, pipeline, brief caching, BKL-AI20/21, industry/segment |
| `api/error-paths.spec.ts` | ci | 18 | Input validation error codes across territory, settings, data-sources |
| `api/intelligence.spec.ts` | ci | 25 | Intelligence job status, pipeline byOwner, CCSP cache, BKL-INTEL-05/07 |
| `api/routes.spec.ts` | ci | 6 | Route coverage — reset guards, accounts shape, AE validation |
| `api/setup.spec.ts` | test (destructive) | 22 | Reset gate, save-customers, infer-domains, pod-config, validate-folder |
| `api/sheets.spec.ts` | ci | 11 | Sheets API — status, list, headers, import, sync, bootstrap-preview |
| `api/territory.spec.ts` | ci | 12 | Territory API contract — territory-names + territory-lookup regex validation |
| `contracts/api-contracts.spec.ts` | ci | 19 | Zod schema contracts for all major API shapes |
| `integration/ae-isolation.spec.ts` | integration-tier | 3 | Multi-AE isolation — pipeline filter, CCSP byAE, customer AE attribution |
| `integration/corpus-delta-callsite.spec.ts` | integration-tier | 3 | Corpus delta gate at `customer.ts` — SSE emission, forensic-trail invariant |
| `integration/corpus-delta.spec.ts` | integration-tier | 3 | Corpus delta mode — accounts endpoint, briefs cache path, shouldUseDeltaMode |
| `integration/fingerprint-invalidation.spec.ts` | integration-tier | 1 | BKL-AI-FP-02 fingerprint cache — cache:hit / cache:bypass emission |
| `integration/sse-contract.spec.ts` | integration-tier | 2 | SSE handshake schema — connected event, text/event-stream content-type |
| `integration/sse-events.spec.ts` | integration-tier | 4 | SSE event bus — handshake, trigger-to-emission, schema, terminal-event E2E |
| `ui/account-intelligence.spec.ts` | ci | 3 | AccountIntelligencePanel Generate — POST fires, running state, error surface |
| `ui/account-plan.spec.ts` | ci | 3 | AccountPlanPanel Generate — POST fires, plan appears, error surface |
| `ui/bootstrap-config-block.spec.ts` | ci | 7 | BootstrapConfigBlock — territory sheet, POD dropdown, SF Report auto-fill |
| `ui/bootstrap-recovery.spec.ts` | ci | 7 | Bootstrap state machine — in-progress, error, completed, reset, null-steps |
| `ui/customer-detail.spec.ts` | ci | 7 | CustomerDetailPage — case modal, comment load, Escape, BKL-UI-05 parity |
| `ui/dashboard-empty-state.spec.ts` | ci | 6 | Dashboard with empty cache — pipeline, cloud spend, SSE, no console errors |
| `ui/dashboard-pending.spec.ts` | ci (all skipped) | 4 | Gap backlog placeholders — per-section refresh, per-section error display |
| `ui/product-filter-coverage.spec.ts` | ci | 5 | AAP chip cascades to KPI tiles, account cards, renewal tiles, CCSP URL |
| `ui/product-intel.spec.ts` | ci | 4 | ProductIntelSection Generate — POST fires, intel appears, error banner |
| `ui/rh-session.spec.ts` | ci | 5 | RH Connect POST, SF session display, polling, BKL-W2-11 SF sync trigger |
| `ui/setup-oauth.spec.ts` | ci | 4 | SetupPage OAuth Keys — Replace flow, paste/upload toggle, Save, invalid-JSON |
| `ui/tableau.spec.ts` | ci | 6 | Tableau states — valid/invalid/unreachable, open-login, territory discovery |
| `ui/wizard-validation.spec.ts` | ci | 14 | AutoBootstrapForm validation — disabled gates, SF ID regex, folder URL, territory failure |

---

## Test Tier Runtime Budgets

Each tier has a runtime contract. If a test exceeds its tier's budget, it either belongs in a heavier tier or it's doing work that should be factored out (mocked, stubbed, or moved to a fixture). Budgets are per-spec unless otherwise noted.

| Tier | Budget | Runner | Scope |
|------|--------|--------|-------|
| unit | <1s per test | `bun test` (bun:test) | Pure function input/output, no I/O, no browser |
| contract | <10s per spec | Playwright (`ci` project) | API endpoints — response shape, status codes, required fields |
| integration | <60s per spec | Playwright (`integration-tier` project) | Cross-module flows on test container (7776) |
| e2e | <90s per spec | Playwright (`e2e-tier` project) | Full user journeys in a browser against the test container |
| smoke | <30s total | Playwright (`smoke` project) | Fast prod gate — single happy-path check against 7777 |

**How this maps to `playwright.config.ts` projects:**

- Unit tests: run via `bun test test/unit/` — NOT a Playwright project. They use the `bun:test` API, not `@playwright/test`.
- Contract tests: covered by the existing `ci` project (read-only, safe against prod).
- Integration tests: the new `integration-tier` project matches `test/integration/**/*.spec.ts`.
- E2E tests: the new `e2e-tier` project matches top-level `test/*.spec.ts` (with root-level `testIgnore` filtering out bootstrap-e2e, quinn-*, qa-ae-section).
- Smoke tests: the new `smoke` project matches `test/smoke-prod.spec.ts` only.

**Budget violations:** if a spec consistently runs over budget, open a BACKLOG item (`BKL-SLOW-[spec-name]`) to either (a) split the spec, (b) stub out the slow dependency, or (c) promote the spec to the next tier up. Do not silently let the spec keep running over budget — suite runtime regressions cascade.
