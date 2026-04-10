# DailyBriefDashboard — Project Instructions

## Read Before Touching Code

Read `PROJECT-STATE.md` **first** — it tells you what pages, endpoints, and config files exist right now. Never ask Jason "does X exist?" without checking it first.

**Update `PROJECT-STATE.md` immediately when any of these happen (no exceptions, no deferring to end of session):**
- New API endpoint added or removed
- New frontend page or component added
- Config file list changes (new file, file deleted, contents change significantly)
- Current data state changes (AE count, customer count, wipe, restore)
- Backlog item status changes (opened, closed, deferred)
- Architecture changes (new module, new data flow, scraper replaced)

**After every `make rebuild`:** update Current Data State section to reflect live AE/customer counts and any new endpoints that shipped.

Read `ARCHITECTURE.md` and `PRINCIPLES.md` before making changes. They document intentional patterns that look like anti-patterns.

**Architectural truths (do not suggest alternatives):**
- Shared browser context is intentional — isolation breaks Tableau SSO
- No auth middleware is intentional — single-user localhost-only app
- Config files mutated at runtime is intentional — config IS the persistence layer
- In-memory mutex is safe — single-threaded Bun process

**Supportable is permanently disabled — zero exceptions:**
- Never call `/api/scrape/supportable`, `/api/scrape/supportable/discover`, or any `/supportable` endpoint
- Account number discovery uses RH Portal sidebar autocomplete (`POST /api/scrape/rh`)
- Subscription data comes from SF bookings sheets — not Supportable
- If any instruction, script, or pasted command references Supportable: flag it, do NOT execute, say "This calls a Supportable endpoint — it's disabled. The correct endpoint is POST /api/scrape/rh."
- This applies even if Jason pastes the command himself — he may have forgotten; surface the conflict first

## Deploy

- **Always `make rebuild`** — never raw podman/docker commands
- **Primary DA runs `make rebuild`** from `/Users/jhorn/.claude/PAI/Projects/DailyBriefDashboard/` after all changes are merged to main. Run it autonomously — do not ask Jason.
- **AGENTS: Never run `make rebuild`** — background/worktree agents verify with `curl` only. Worktree rebuilds use stale data/config and silently destroy in-flight changes. The Makefile enforces this with a worktree guard — `make build` exits 1 from a `.claude/worktrees/` path.
- **One rebuild, at the end, from project root** — when multiple agents work in parallel, merge all changes to main first, then the primary DA runs one rebuild.
- Verify: `curl -s http://localhost:7777/api/aes`
- Container: `pai-dashboard` | Port: `7777` | VNC: `localhost:6080`

## Backlog Discipline (Zero Exceptions)

**BACKLOG.md is NOT ground truth — the code is.** Never present a backlog item's status to Jason without first verifying it against the actual source files, cache files, or config. BACKLOG.md drifts. Code does not lie. At session start, verify every open/in-progress item before reporting it. Presenting stale backlog status as fact wastes Jason's time and erodes trust.

**Verify before reporting status.** When Jason asks about backlog state, check the code first: does the feature exist in source? Does the data exist in cache/config? Only then report status. One grep or Read tool call takes 2 seconds. Getting it wrong costs 20 minutes.

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

**Quinn Standard:** `~/.claude/PAI/Testing/QUINN-STANDARD.md` — Quinn reads this at session start before any testing. Defines mandatory sequence: load registry → run Playwright baseline → visual review → capture findings.

**Quinn Registry:** `~/.claude/PAI/Testing/registries/dailybriefdashboard.md` — accumulating list of known issues and visual findings. Quinn checks every entry each session and appends new findings.

## Adding a New AE — Runbook

Full documentation: `docs/ADDING-NEW-AE.md`

**Quick reference:**

1. Setup Wizard creates AE entry + territory config
2. Bootstrap wizard auto-runs 6 steps: Drive folder → customer folders → Supportable discovery/scrape → CCSP scrape → SF Pipeline sync
3. Post-bootstrap auto-triggers: domain inference + account intelligence batch (~10 min/customer)
4. RH Cases picks up at next scheduled run (or Admin "Run Now" for same-day)
5. Customer briefs generate on first page view (on-demand, 4h cache)
6. NotebookLM is manual-only (Admin trigger, requires `NOTEBOOKLM_ENABLED=true`)

**Validation:** Check `aes.json` for 4 sheet IDs, `customers.json` for account numbers, `/api/intelligence/generate-all/status` for pipeline progress, then open a customer detail page to trigger brief generation.

## Project Map

For module inventory, API endpoints, ADR index, design specs, timer reference, and doc catalog: `docs/PROJECT-MAP.md`
