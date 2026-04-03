# Contributing to Daily Brief Dashboard

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

### Workflow

1. Read [ARCHITECTURE.md](ARCHITECTURE.md) and [BACKLOG.md](BACKLOG.md) for context
2. Create a branch: `git checkout -b feature/your-feature`
3. Make your changes — surgical fixes only, minimal scope
4. Test locally: `bun --watch server.ts` + verify in browser
5. Run tests: `bunx playwright test`
6. Build and verify in container: `make rebuild`
7. Push and open a PR

### Testing

```bash
# Unit tests
bun test src/

# Full E2E suite (~260 tests)
bunx playwright test

# API tests only
bunx playwright test test/api/

# Bootstrap E2E (long — 10 min timeout)
bunx playwright test test/bootstrap-e2e.spec.ts --timeout=600000

# Smoke test (requires running server)
bun scripts/smoke-test.ts
```

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

## Filing Bugs

Check [BACKLOG.md](BACKLOG.md) first — the issue may already be tracked. If not:

1. Open an issue on [GitHub](https://github.com/hornjason/asaCommandCenter/issues)
2. Include: what you expected, what happened, and `podman logs pai-dashboard` output
3. Tag with severity: Critical (data loss/security), High (broken feature), Medium (degraded), Low (cosmetic)

## Pull Requests

1. One PR per logical change — don't bundle unrelated fixes
2. Reference the BACKLOG item ID if applicable (e.g., "Fixes BKL-S01")
3. Include test evidence: screenshots, test output, or `curl` examples
4. Security scan is mandatory on every PR — changed files + related patterns

## Questions

Email **jhorn@redhat.com** or open a GitHub issue.
