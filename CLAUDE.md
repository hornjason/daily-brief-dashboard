# DailyBriefDashboard — Project Instructions

## Read Before Touching Code

Read `ARCHITECTURE.md` and `PRINCIPLES.md` before making changes. They document intentional patterns that look like anti-patterns.

**Architectural truths (do not suggest alternatives):**
- Shared browser context is intentional — isolation breaks Tableau SSO
- No auth middleware is intentional — single-user localhost-only app
- Config files mutated at runtime is intentional — config IS the persistence layer
- In-memory mutex is safe — single-threaded Bun process

## Deploy

- **Always `make rebuild`** — never raw podman/docker commands
- **AGENTS: Never run `make rebuild`** — only Jason runs it, always from the project root. Agent rebuilds from worktrees wipe config and overwrite other agents' changes. Agents verify with `curl` only.
- **One rebuild, at the end, from project root** — when multiple agents work in parallel, all changes must be merged to main before a single rebuild. Never rebuild mid-task from a worktree.
- Verify: `curl -s http://localhost:7777/api/aes`
- Container: `pai-dashboard` | Port: `7777` | VNC: `localhost:6080`

## Backlog Discipline (Zero Exceptions)

**Verify before implementing.** Before working any backlog item, read the relevant source files and confirm the feature is actually absent. Many items will already be done — mark them DONE immediately and move on. Never rewrite working code.

**Update backlog at close-time.** The moment an item is verified done or implemented, update its Status in BACKLOG.md. Do not defer. Drift between code and backlog creates false work and instability.

**Scrapers are stable — don't touch without explicit instruction.** The scraper layer (rh-scraper.ts, ccsp-scraper.ts, supportable-scraper.ts, sf-scraper.ts, scraper-manager.ts) took significant effort to stabilize. Any change requires reading SCRAPER-RULES.md first and explicit confirmation from Jason before modifying.

**No parallelism in scrapers.** Supportable runs sequentially — APEX cookie collisions make parallel contexts unsafe. This is permanent, not a workaround. Do not design or implement parallel scraping approaches.

## Agent Briefing

- **Rook:** Shared browser context and no-auth are intentional — do not flag as vulnerabilities
- **Quinn:** Test as brand new user from scratch unless Jason says otherwise
- **Marcus:** Read the file before modifying; surgical fixes only; never touch scraper files without explicit instruction
- Include relevant `ARCHITECTURE.md` section in every agent prompt
- After every UI rebuild: spawn Quinn without being asked
- After every item close: spawn Rook on changed files + pattern siblings

## Security Baseline
See `docs/SECURITY-BASELINE.md` — read before touching any security-sensitive code.

## Scraper Rules
See `docs/SCRAPER-RULES.md` — read before touching any scraper code.

## Data Rules
See `docs/DATA-RULES.md` — read before touching cache, sheets, or territory sync code.

## Testing

- `make rebuild` after every code change
- API tests: `npx playwright test test/api/`
- Full suite: `npx playwright test` (~260 tests)
- Bootstrap E2E: `npx playwright test test/bootstrap-e2e.spec.ts --timeout=600000`
- State isolation: snapshot/restore per test via `POST /api/__test/snapshot` + `restore`

## Project Map

For module inventory, API endpoints, ADR index, design specs, timer reference, and doc catalog: `docs/PROJECT-MAP.md`
