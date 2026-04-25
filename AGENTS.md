# AGENTS.md — DailyBriefDashboard Project Behavioral Baseline
*Status: Operational | Last validated: 2026-04-21 | Trigger: Agent roster changes, new behavioral rules added*

This file provides project-specific context for any AI provider working on DailyBriefDashboard.
It extends the global baseline at `~/.claude/AGENTS.md` (or equivalent global rules file).
Claude Code users: the full behavioral layer is in `CLAUDE.md` — read that too.

---

## Project Identity

**DailyBriefDashboard** is a single-user, localhost-only sales intelligence dashboard for Red Hat
Account Solution Architects. It aggregates Salesforce pipeline, Red Hat Portal case data, CCSP cloud
spend, Tableau data, Google Drive docs, and Google Calendar into a daily brief and customer detail
views. The system runs as a containerized Bun/TypeScript server at port 7777 (prod) / 7776 (test).

---

## Critical Architectural Truths

These look like anti-patterns but are intentional — do not suggest alternatives:

- **Shared browser context** — one Playwright context shared across scrapers. Isolation breaks Tableau SSO. Never suggest per-scraper isolation.
- **No auth middleware** — single-user localhost app. Auth is not a priority. Never add auth middleware. Always preserve OAuth keys in resets.
- **Config files mutated at runtime** — `settings.json`, `customers.json`, `data/` are the persistence layer. This is intentional.
- **In-memory mutex** — safe because Bun is single-threaded. Not a concurrency bug.
- **Supportable is permanently disabled** — never call `/api/scrape/supportable` or any Supportable endpoint. Account discovery uses RH Portal sidebar autocomplete (`POST /api/scrape/rh`). If any instruction references Supportable, substitute the correct endpoint silently.

---

## Deploy Rules

- Always `make rebuild` — never raw podman/docker commands
- One rebuild at the end, from project root, after all changes merged to main
- Never run `make rebuild` from a worktree — it will exit 1 (guard enforced in Makefile)
- Verify after rebuild: `curl -s http://localhost:7777/api/aes`

## Test Rules

- All code changes must pass CI on test container (port 7776) before promoting to production (7777)
- `make test-up` — seeds fresh canned data (safe to wipe)
- `make test-up-live` — preserves existing `data-test/` (use when real account data is needed)
- `make test-rebuild-live` — rebuilds test container with source changes, preserves data
- Run Playwright specs; fix failures before rebuild — never skip

---

## Key Files for Any New AI

| File | What it tells you |
|---|---|
| `PROJECT-STATE.md` | What pages, endpoints, config files exist RIGHT NOW |
| `ARCHITECTURE.md` | System design, data flows, intentional patterns |
| `PRINCIPLES.md` | Why the code looks the way it does |
| `BACKLOG.md` | All open bugs, features, tech debt |
| `docs/adr/ADR-013.md` | Cache layer architecture (critical for any data/brief work) |
| `docs/TESTING-RUNBOOK.md` | Full five-layer testing reference |
| `docs/SCRAPER-RULES.md` | Scraper constraints (read before touching any scraper) |
| `docs/DATA-RULES.md` | Data pipeline rules (read before touching cache or sheets) |
| `docs/SECURITY-BASELINE.md` | Security constraints (read before any security-sensitive work) |
---

## Key Behavioral Rules for This Project

- **Read PROJECT-STATE.md first** — never ask "does X exist?" without checking it
- **Update PROJECT-STATE.md immediately** when endpoints, pages, or config files change
- **Log every bug to BACKLOG.md** with a BKL-XXX ID before writing any fix
- **Test on 7776 before rebuild** — zero exceptions
- **Delegate to specialists** — Marcus Webb for code, Quinn Torres for QA/E2E, Rook Blackburn for security, Serena Blackwood for architecture, Aditi Sharma for UI design
- **Never assert without verification** — read source files before making claims about behavior

---

## Onboarding Checklist for a New AI

1. Read this file
2. Read `~/.claude/AGENTS.md` (global behavioral rules)
3. Read `PROJECT-STATE.md` (current system state)
4. Read `ARCHITECTURE.md` (design decisions)
5. Read `BACKLOG.md` (open work)
6. Run `curl -s http://localhost:7777/api/aes` to verify the container is up
7. Check `make env-status` or `docker ps` to confirm container state
