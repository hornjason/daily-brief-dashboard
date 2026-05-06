---
doc-type: reference
status: active
owner: jason
updated: 2026-05-01
---

# Contributing to Daily Brief Dashboard
*Last validated: 2026-05-06 | Owner: DA | Trigger: Review and update on any structural change to this doc*

This guide is for developers who want to modify the code, fix bugs, or add features. If you just want to run the dashboard, see [README.md](README.md).

## Development Setup

### Prerequisites

- **Bun** runtime: `curl -fsSL https://bun.sh/install | bash`
- **Podman** (or Docker): for building and running the container
- **make**: for build/deploy commands
- **Git**: for version control

### Clone and Install

```bash
git clone https://github.com/hornjason/asaCommandCenter.git
cd asaCommandCenter

# Install server dependencies
bun install

# Install frontend dependencies
cd dashboard && bun install && cd ..
```

### Environment File

```bash
cp .env.example .env
# Edit .env with your settings — at minimum set REDHAT_OFFLINE_TOKEN
```

See [SETUP.md — Environment Variables](SETUP.md#environment-variables-reference) for the full variable reference.

### Run Locally (without container)

```bash
# Start the server with hot reload
bun --watch server.ts
```

The server starts at `http://localhost:7777`. The frontend is served from `dashboard/dist/` — rebuild it with:

```bash
cd dashboard && bun run build && cd ..
```

### Run in Container (production-like)

```bash
make rebuild    # builds image, pushes to GHCR, starts container
```

Individual targets:

| Command | What it does |
|---|---|
| `make build` | Build the container image locally |
| `make up` | Start the container (stops existing first) |
| `make down` | Stop and remove the container |
| `make logs` | Tail container logs |
| `make ps` | Show container status |
| `make rebuild` | Full cycle: build + push + up |

## Project Structure

```
DailyBriefDashboard/
  server.ts              # Hono HTTP server — all API routes
  src/                   # Backend TypeScript modules (scrapers, auth, cache)
  dashboard/             # React/Vite frontend (Tailwind CSS)
    src/pages/           # Page components (SetupPage, AdminPage, etc.)
    src/components/      # Shared UI components
  scripts/               # Utility scripts (auth, scraping, debug)
  data/                  # Runtime persistent data (volume-mounted)
  test/                  # Playwright E2E tests (~260 tests)
  docs/                  # ADRs, design specs, research
  Containerfile          # Multi-stage OCI build
  Makefile               # Build/deploy targets
  defaults.env           # Default env vars baked into the container image
  ARCHITECTURE.md        # Data flow, scraper design, module inventory
  BACKLOG.md             # Canonical issue tracker
```

For the full module inventory, API endpoint list, and ADR index, see `docs/PROJECT-MAP.md`.

## Architecture

Read [ARCHITECTURE.md](ARCHITECTURE.md) before making changes. Key things that look like anti-patterns but are intentional:

- **Shared browser context** across all scrapers — required for Tableau SSO passthrough
- **No auth middleware** — single-user, localhost-only app
- **Config files mutated at runtime** — `aes.json` and `customers.json` are the persistence layer
- **In-memory mutex** — safe because Bun is single-threaded

## Making Changes

### Skill-driven development workflow

New features and architecture refactors use a structured skill pipeline. Each skill picks up where the previous left off:

```
/grill-with-docs               → clarify requirements; enforces ARCHITECTURE.md + ADR terminology inline
/improve-codebase-architecture → (existing code) find shallow modules, design deep interfaces
/to-prd                        → write PRD from conversation context, publish to GitHub Issues
/to-issues                     → break PRD into vertical-slice issues (tracer bullets)
/triage                        → review each issue, post durable agent brief → ready-for-agent
/tdd                           → implement red-green-refactor per issue, tests at interface boundary
```

**When to use which:**
- `/grill-with-docs` — use this (not `/grill-me`) for all feature work here; cross-checks against `ARCHITECTURE.md` intentional patterns and `docs/archive/adr/`, updates `CONTEXT.md` inline
- `/improve-codebase-architecture` — before building on existing code; finds deepening candidates; skip for greenfield
- `/to-prd` — after grilling; synthesizes context into a PRD on GitHub Issues (`hornjason/asaCommandCenter`)
- `/to-issues` — for large features (6+ slices); skip for small single-file items
- `/triage` — after issues exist; posts the agent brief that Marcus works from
- `/tdd` — Marcus's implementation loop; one test → one impl, never bulk-test-then-bulk-impl

**Issue tracker:** `hornjason/asaCommandCenter` GitHub Issues. Label vocabulary in `docs/agents/triage-labels.md`.

**Architecture backlog:** 8 deepening candidates in `BACKLOG.md` (BKL-ARCH-01 through BKL-ARCH-08). Suggested execution order: #6 → #7 → #1 → #3 → #5 → #8.

### Simple bug fix / small change workflow

For surgical fixes and changes under ~10 lines that don't require a PRD:

1. Read [ARCHITECTURE.md](ARCHITECTURE.md) and verify the bug in source before touching anything
2. Create a branch: `git checkout -b fix/your-fix`
3. Make the surgical change — minimal scope, no bonus refactoring
4. Write a regression test (see Testing below) — mandatory before marking done
5. Run tests on 7776: `make build && make test-down && make test-up && npx playwright test test/api/ --project=test`
6. `make rebuild` to promote to production (7777)
7. Run CI regression check: `npx playwright test test/api/ --project=ci`

### Testing

Three layers — each catches different things:

| Layer | Files | Runner | What it catches |
|---|---|---|---|
| **Unit** | `src/*.test.ts` | `bun test src/` | Scraper logic, schedulers, parsers |
| **E2E UI** | `test/wizard.spec.ts` | Playwright | Setup page accordion, button states |
| **E2E API** | `test/api.spec.ts`, `test/regression.spec.ts` | Playwright | Endpoint contracts, historical bug regressions |

> **Rule:** UI tests verify rendering. API tests verify data correctness. Never use `page.route()` mocks to test business logic.

```bash
# Unit tests (fast, no server needed)
bun test src/

# E2E wizard UI tests (webServer auto-starts in CI)
CI=true bunx playwright test test/wizard.spec.ts

# Full E2E suite (requires running server)
bun run server.ts &
bunx playwright test

# Smoke test (requires running server)
bun scripts/smoke-test.ts
```

**Regression test rule:** Every production bug gets a test that fails before the fix, then passes after. Commit both in the same commit. See `docs/ADR-004-testing-strategy.md`.

Tests use state isolation via `POST /api/__test/snapshot` and `/restore` (disabled when `NODE_ENV=production`).

### Code Conventions

- **TypeScript** everywhere (server and frontend)
- **Hono** for HTTP routing (server.ts)
- **React 19** + **Tailwind CSS** + **TanStack Table** for the frontend
- **Playwright** for all scraping (headless Chromium) and E2E testing
- **Bun** as runtime and package manager
- Security: `sanitizeCell()` on Sheets writes, `sanitizeErr()` on API errors, `escapeXml()` on brief XML
- Cache files written with `mode: 0o600`
- Never overwrite non-empty cache with empty results (stale-overwrite guard)

### Environment Variable Defaults

The container ships with a `defaults.env` file that provides working defaults (including Gemini AI config). The entrypoint loads these for any variable not already set by the user's `--env-file .env`.

To change a default for all users, edit `defaults.env` and rebuild the image. To override for yourself, set the variable in your `.env` file — user values always win.

## CI/CD Pipeline

### Tier 1 — Every push and PR (`ci.yml`)

Runs automatically on every push to `main` and every PR. No real credentials needed.

```
test  →  publish (main only)  →  smoke (main only)
                                   e2e (every push/PR)
```

| Job | What it does |
|---|---|
| `test` | Unit tests + TypeScript check + dashboard build |
| `publish` | Build container → push to `ghcr.io` (needs `GHCR_TOKEN` secret) |
| `smoke` | Pull image → start → hit `/health` → verify `{"status":"ok"}` |
| `e2e` | Playwright wizard UI tests (credential-free, webServer auto-starts) |

**If publish fails with `permission_denied: write_package`** — the `GHCR_TOKEN` secret is expired. Create a new PAT at GitHub → Settings → Developer settings → Personal access tokens (classic) with `write:packages` scope. Add it as a repo secret named `GHCR_TOKEN`.

### Tier 2 — Release gate (`release.yml`)

Triggered by `make release-*`. Requires **manual approval** in the `production` GitHub Environment before real credentials are used. Runs the full E2E suite with live credentials and pushes the `:stable` and `:vX.Y.Z` container tags.

## Making a Release

```bash
make release-patch    # bug fix:     1.2.3 → 1.2.4
make release-minor    # new feature: 1.2.3 → 1.3.0
make release-major    # breaking:    1.2.3 → 2.0.0

make version          # print current version
```

Each command bumps `package.json`, commits, tags, and pushes — which triggers `release.yml` in CI.

| Change | Command |
|---|---|
| Bug fix, test update, label tweak | `release-patch` |
| New feature, new scraper, new UI section | `release-minor` |
| Breaking config change, renamed API endpoints | `release-major` |

## Secrets & Credentials

Full details in `docs/SECRETS-GUIDE.md`. Quick reference:

| Credential | Where it lives | Notes |
|---|---|---|
| Gemini service account | `defaults.env` (committed) | Shared, baked into image — rotate every 90 days |
| Google OAuth (personal) | `.env` (gitignored) | Each developer uses their own account |
| Salesforce | `.env` (gitignored) | Each developer |
| Red Hat SSO | `.env` (gitignored) | Each developer |
| `GHCR_TOKEN` | GitHub repo secret | CI only — PAT with `write:packages` |
| Real creds for release | GitHub `production` environment | CI only — requires manual approval gate |

**Never:** commit `.env`, add personal tokens to `defaults.env`, or use a code editor / Write tool to paste long base64 keys (corrupts encoding — paste manually into `.env` instead).

## Filing Bugs

Check [BACKLOG.md](BACKLOG.md) and [GitHub Issues](https://github.com/hornjason/asaCommandCenter/issues) first — the issue may already be tracked. If not:

1. Open an issue on [GitHub](https://github.com/hornjason/asaCommandCenter/issues) with label `bug` + `needs-triage`
2. Include: what you expected, what happened, and `podman logs pai-dashboard` output
3. Tag with severity: Critical (data loss/security), High (broken feature), Medium (degraded), Low (cosmetic)
4. Run `/triage` to move it to `ready-for-agent` with a durable agent brief before handing to Marcus

## Pull Requests

1. One PR per logical change — don't bundle unrelated fixes
2. Reference the BACKLOG item ID if applicable (e.g., "Fixes BKL-S01")
3. Include test evidence: screenshots, test output, or `curl` examples
4. Security scan is mandatory on every PR — changed files + related patterns

## Questions

Email **jhorn@redhat.com** or open a GitHub issue.
