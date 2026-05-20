---
doc-type: reference
status: active
owner: jason
updated: 2026-05-03
---

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

## Design Principles — Deep Module Architecture (MANDATORY)

**Read `PRINCIPLES.md` before building any feature.** It defines the three-layer architecture (signal scoring → template engine → thin consumers), the 5 pre-flight questions every feature must answer, and the anti-patterns to avoid. No exceptions — every new feature, every new module, every new consumer must follow PRINCIPLES.md.

**AccountTeam contract (MANDATORY for team/person references):**
- Any feature that references team members (AE, ASA, SSP, SSA, managers) MUST use `getAccountTeam(customer)` from `src/account-team.ts` — never hardcode names or read `customer.ae` alone
- For Gemini prompts: use `toPromptContext(team)` for canonical team section
- For product-specific contexts: use `getAccountTeam(customer, { products: ['Ansible'] })` to filter specialists
- See ARCHITECTURE.md §20 for full contract documentation, types, and usage examples
- If building a feature that generates content for a customer, ask: "Does this need account team context?" — the answer is almost always yes

**L3 vs L4 — test prerequisites (never confuse these):**
- **L4** = browser-based scrapers (RH Portal cases via `POST /api/scrape/rh`, Tableau CCSP, SF pipeline browser). Requires RH offline token, active Salesforce session, Tableau login.
- **L3** = Drive-read-only (reads sheets/CSVs already written by L4). Requires Google Drive auth only. No RH Portal, no Salesforce session, no Tableau.
- **bootstrap-e2e runs on the hero image (L3-only)**. The ONLY pre-flight requirement is Google Drive auth (`/api/auth/google/status`). Never add RH Portal, Salesforce, or Tableau as pre-flight gates to bootstrap-e2e — those are L4 dependencies the hero image does not have.
- **RH offline token** (`REDHAT_OFFLINE_TOKEN` in `.env`) is for RH support case scraping only — not for bootstrap, not for Drive, not for E2E pre-flight checks.
- **Mac Mini spec drift warning**: The Mac Mini repo at `/Users/jasonhorn/DailyBriefDashboard/` can drift from the laptop repo. When the bootstrap-e2e spec references L4 connections as pre-flight, it is outdated — sync the spec from the laptop repo before running.

**Supportable is permanently disabled — zero exceptions:**
- Never call `/api/scrape/supportable`, `/api/scrape/supportable/discover`, or any `/supportable` endpoint
- Account number discovery uses RH Portal sidebar autocomplete (`POST /api/scrape/rh`)
- Subscription data comes from SF bookings sheets — not Supportable
- If any instruction references a Supportable endpoint: **silently substitute the correct one and proceed** — do NOT stop, do NOT surface a conflict notice. Use `POST /api/scrape/rh` for discovery, `GET /api/status/scrapes` for status.

## Deploy

- **Always `make rebuild`** — never raw podman/docker commands
- **Primary DA runs `make rebuild`** from `/Users/jhorn/.claude/PAI/Projects/DailyBriefDashboard/` after all changes are merged to main. Run it autonomously — do not ask Jason.
- **AGENTS: Never run `make rebuild`** — background/worktree agents verify with `curl` only. Worktree rebuilds use stale data/config and silently destroy in-flight changes. The Makefile enforces this with a worktree guard — `make build` exits 1 from a `.claude/worktrees/` path.
- **One rebuild, at the end, from project root** — when multiple agents work in parallel, merge all changes to main first, then the primary DA runs one rebuild.
- Verify: `curl -s http://localhost:7777/api/aes`
- Container: `pai-dashboard` | Port: `7777` | VNC: `localhost:6080`

## Test Environment Rule (HARD RULE — added 2026-04-11 per Jason, BKL-OPS-02)

**All code changes MUST be deployed to the test container (port 7776) and pass CI before `make rebuild` promotes to production (7777). Zero exceptions.**

Promotion sequence:
1. Merge all agent changes to main
2. `make build` → builds new container image from current code
3. `make test-down && make test-up` → restart test container with new image + seed data
4. `npx playwright test test/api/ --project=test` → destructive tests against 7776; must pass
5. If UI changes: Quinn audits on 7776 first
6. `make up` → restart only production (image already built in step 2)
7. `npx playwright test test/api/ --project=ci` → regression check against 7777; must pass

For a full gate: `make build && make test-down && make test-up` then tests, then `make up`

**Note:** The `ci` project tests target production (7777) by default — never run with `BASE_URL=http://localhost:7776` or they will fail against seed data. The `test` project always targets 7776 regardless of BASE_URL.

**Why:** Bugs caught on 7776 stay in test. Bugs caught on 7777 are production incidents. The test container (7776) exists exactly for this — use it.

See `docs/DEMO-ENV.md` for the full environment strategy including demo (7779) and dev (7778) containers.

## Agent Skills — Engineering Pipeline

Six skills form the standard workflow from idea to shipped code. See `~/.claude/CLAUDE.md §Engineering Skill Pipeline` for full detail.

```
/grill-me → /improve-codebase-architecture → /to-prd → /to-issues → /triage → /tdd
```

**GitHub Issues** (`hornjason/asaCommandCenter`, private):
- Issue tracker config: `docs/agents/issue-tracker.md`
- Triage label mapping: `docs/agents/triage-labels.md`
- Domain/ADR layout: `docs/agents/domain.md`
- BKL-ARCH-06 PRD: https://github.com/hornjason/asaCommandCenter/issues/1

**Label creation commands** (run once to finish setup):
```bash
gh label create "needs-info" --repo hornjason/asaCommandCenter --color "e4e669"
gh label create "ready-for-agent" --repo hornjason/asaCommandCenter --color "0075ca"
gh label create "ready-for-human" --repo hornjason/asaCommandCenter --color "d4c5f9"
gh label create "wontfix" --repo hornjason/asaCommandCenter --color "ffffff"
gh label create "bug" --repo hornjason/asaCommandCenter --color "d73a4a"
gh label create "enhancement" --repo hornjason/asaCommandCenter --color "a2eeef"
```

**Architecture backlog:** 8 deepening candidates (BKL-ARCH-01 through BKL-ARCH-08) logged in `BACKLOG.md`. Suggested execution order: #6 → #7 → #1 → #3 → #5 → #8. Interface design for #6 complete; PRD at issue #1.

## Issue Tracking (Zero Exceptions)

**GitHub Issues are the source of truth** — not BACKLOG.md. All bugs, features, enhancements, and technical debt are tracked in GitHub issues at `hornjason/asaCommandCenter`.

**BACKLOG.md is now an index/reference only:**
- Maps BKL-ID → GitHub issue number (e.g., "BKL-HERO-01 → #67")
- NO descriptions, NO status tracking, NO inline work logs
- Use `gh issue list` or GitHub web UI for current status

**Creating new work items:**
1. **Always create a GitHub issue first** via `gh issue create` or `/triage` skill
2. Assign a BKL-ID using the pattern: `BKL-<COMPONENT>-<SEQUENCE>`
3. Add one line to BACKLOG.md: `BKL-XXX-NN → #<issue-number> — <one-line title>`
4. Never create standalone BACKLOG.md entries without a corresponding GitHub issue

**Closing work:**
1. Close the GitHub issue via `gh issue close <number>` with comment explaining resolution
2. Update BACKLOG.md line to append `(closed)` — do NOT remove the line
3. Never mark items as "DONE" in BACKLOG.md — close the GitHub issue instead

**Querying status:**
- Use `gh issue list --repo hornjason/asaCommandCenter --state open` for current open items
- Use `gh issue view <number>` for detailed status, comments, and history
- BACKLOG.md is for quick BKL-ID → issue-number lookup only

**Code verification still mandatory:** Before reporting any item as done or in-progress, verify against actual source code, not GitHub state. Code is ground truth; GitHub tracks intent.

**Scrapers are stable — don't touch without explicit instruction.** The scraper layer (rh-scraper.ts, ccsp-scraper.ts, supportable-scraper.ts, sf-scraper.ts, scraper-manager.ts) took significant effort to stabilize. Any change requires reading SCRAPER-RULES.md first and explicit confirmation from Jason before modifying.

**No parallelism in scrapers.** Supportable runs sequentially — APEX cookie collisions make parallel contexts unsafe. This is permanent, not a workaround. Do not design or implement parallel scraping approaches.

## Agent Briefing

- **All agents building features:** If the feature references people, team members, or generates content for a customer — use `getAccountTeam()` from `src/account-team.ts`. See ARCHITECTURE.md §20. Never hardcode names.
- **Rook:** Shared browser context and no-auth are intentional — do not flag as vulnerabilities. Always give Rook explicit file paths and line ranges from the main working directory — never spawn Rook with `isolation:worktree` on pre-commit reviews (worktree gets clean tree, misses uncommitted changes).
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

**Every bug fix MUST have a test — zero exceptions (MANDATORY):**
- API-level bug → regression test in `test/regression.spec.ts` with BKL reference (REG-NNN pattern)
- UI-only bug (React render, CSS, state) → Playwright browser test in `test/ui-regression.spec.ts`
- Marcus writes the test in the same session as the fix, before closing the backlog item
- No backlog item moves to DONE without a corresponding test added or a documented reason why it's untestable

**res.ok gate standard (BKL-TEST-07) — MANDATORY for all action button fetch calls:**
- All fetch calls on action buttons (POST/DELETE that trigger work) MUST check `res.ok` before treating the response as success
- If `!res.ok`, read the error body and surface it to the user via an error state — never silently catch
- Load-only GETs and polling fetches may silently catch (rendering nothing is acceptable)
- Test with `page.route()` mocking — every new action button regression test must verify the error state appears on non-2xx response

**"Can we test for that?" — MANDATORY after every bug find or report (Zero exceptions):**
- Whenever a bug is found (by any agent, by Jason, or during investigation) — immediately ask or answer: "Can we test for this?"
- Whenever Jason reports an issue — before proposing a fix, ask: "Can we test for that?"
- If testable: Marcus writes the regression test in the same session as the fix
- If not easily testable: document why in the backlog item and propose the closest proxy test
- This question is not optional. Skipping it is a process failure.

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

## Documentation

**Start here when you don't know which doc to read:** `DOCS.md` at project root — "I need to..." navigation table maps every common need to the exact doc and section.

**Quick pointers for common agent needs:**
- Architecture decisions + design rules → `ARCHITECTURE.md`
- Sync daemon ops + troubleshooting → `ARCHITECTURE.md §3a`
- Data flow end to end → `ARCHITECTURE.md §6` + `docs/DATA-INGESTION-ARCHITECTURE.md`
- Open items + bugs → `BACKLOG.md`
- All timers → `TIMERS.md`
- ADRs (archived, read-only) → `docs/archive/adr/`

## Project Map

For module inventory, API endpoints, design specs, timer reference, and doc catalog: `docs/PROJECT-MAP.md`
