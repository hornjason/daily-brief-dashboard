---
doc-type: reference
status: active
owner: jason
updated: 2026-05-13
---

# DailyBriefDashboard — Documentation Index

**Start here.** Find the doc you need by what you're trying to do.

---

## I need to...

| I need to... | Read |
|---|---|
| Understand data flow end to end | `ARCHITECTURE.md §6` + `docs/DATA-INGESTION-ARCHITECTURE.md` |
| Understand why something is built a certain way | `ARCHITECTURE.md` — find the section by topic |
| Operate the L3 sync daemon (start, stop, status) | `ARCHITECTURE.md §3a` |
| Re-auth after Tableau or SF session expires | `docs/SYNC-DAEMON-SSO-PLAYBOOK.md` |
| Set up or diagnose the Mac Mini | `docs/MAC-MINI-DEMO-SETUP.md` |
| Set up a fresh machine from scratch | `docs/NEW-MACHINE-SETUP.md` |
| Back up or restore config for migration | `docs/NEW-MACHINE-SETUP.md §5` + `make backup-config` / `make restore-config` |
| Validate environment health | `make doctor` |
| Add a new AE to the dashboard | `docs/ADDING-NEW-AE.md` |
| Check what's open, broken, or in progress | `BACKLOG.md` + [GitHub Issues](https://github.com/hornjason/asaCommandCenter/issues) |
| Build a new feature using the skill pipeline | `CONTRIBUTING.md §Skill-driven development workflow` |
| Start a refactor (architecture deepening) | `/improve-codebase-architecture` → `CONTRIBUTING.md §Skill-driven development workflow` |
| Triage an issue and brief Marcus | `/triage` — see `docs/agents/triage-labels.md` for label vocabulary |
| Execute an architecture refactor (BKL-ARCH) | `docs/ARCHITECTURE-REFACTOR-PLAYBOOK.md` |
| See all scheduled timers and intervals | `TIMERS.md` |
| Understand the hero install / L3-only setup | `docs/HERO-INSTALL.md` |
| Check current system state (containers, AE count) | `PROJECT-STATE.md` |
| Set up Salesforce report for pipeline sync | `docs/SF-REPORT-SETUP.md` |
| Understand the test environment strategy | `docs/ENVIRONMENTS.md` |
| Run or debug tests | `docs/TESTING-RUNBOOK.md` |
| Understand the E2E bootstrap test flow and assertions | `docs/E2E-BOOTSTRAP-FLOW.md` |
| Understand security baseline and rules | `docs/SECURITY-BASELINE.md` |

---

## Active docs reference

Docs with `status: active` that are maintained and indexed here. All others are in `docs/archive/`.

| Doc | Type | What it covers |
|---|---|---|
| `ARCHITECTURE.md` | architecture | Intentional design decisions, scraper internals, all "why" |
| `BACKLOG.md` | backlog | Open items, bugs, in-progress work |
| `TIMERS.md` | reference | All 33 server timers + 3 sync daemon timers |
| `PROJECT-STATE.md` | reference | Live system state — containers, AE count, endpoints |
| `CLAUDE.md` | reference | Agent rules, deploy sequence, testing protocol |
| `docs/HERO-INSTALL.md` | architecture | L3-only install design, NODE_ROLE, sync daemon spec |
| `docs/SYNC-DAEMON-SSO-PLAYBOOK.md` | runbook | SSO re-auth step-by-step |
| `docs/MAC-MINI-DEMO-SETUP.md` | runbook | Mac Mini setup, tunnels, LaunchAgents, CI runner |
| `docs/NEW-MACHINE-SETUP.md` | runbook | Fresh machine setup, config backup/restore, make doctor |
| `docs/ADDING-NEW-AE.md` | runbook | Full AE onboarding flow |
| `docs/ENVIRONMENTS.md` | reference | Port map, test/prod/demo/dev containers |
| `docs/TESTING-RUNBOOK.md` | reference | Test suite, Playwright, state isolation |
| `docs/E2E-BOOTSTRAP-FLOW.md` | spec | New-user E2E journey — Drive hierarchy, Mermaid flowchart, gap analysis |
| `docs/DATA-INGESTION-ARCHITECTURE.md` | architecture | L1-L4 cache tiers, data flow detail |
| `docs/SF-REPORT-SETUP.md` | runbook | Salesforce report configuration |
| `docs/SECURITY-BASELINE.md` | reference | Security rules for Rook and Marcus |
| `docs/CI-RELEASE-PIPELINE.md` | runbook | CI/CD pipeline, release tagging, promotion sequence |
| `docs/DATA-GOVERNANCE.md` | reference | Data governance rules — ownership, retention, access |
| `docs/SECRETS-GUIDE.md` | reference | Secrets management — env vars, .env layout, rotation |
| `docs/DEMO-ENV.md` | reference | Demo environment (port 7779), tunnel, Mac Mini demo setup |
| `docs/SCRAPER-RULES.md` | reference | Scraper stability rules — read before touching scrapers |
| `docs/DATA-RULES.md` | reference | Cache, sheets, territory sync rules |
| `docs/PROJECT-MAP.md` | reference | Module inventory, API endpoints, timer reference |
| `PRINCIPLES.md` | reference | Deep module architecture — three-layer design, pre-flight questions, anti-patterns (ADR-027) |
| `docs/adr/ADR-027-universal-signal-scoring-contract.md` | adr | Signal scoring contract — centralized scoring, specificity, boosters, budget caps |
| `docs/FLOWS.md` | reference | End-to-end flow walkthroughs |
| `CONTRIBUTING.md` | reference | Development workflow — skill pipeline, testing, PRs, filing bugs |
| `docs/ARCHITECTURE-REFACTOR-PLAYBOOK.md` | runbook | Per-candidate loop for BKL-ARCH items: design → implement → close |
| `~/.claude/skills/grill-with-docs/` | reference | Grill skill for project feature work — enforces domain terminology, updates CONTEXT.md inline |
| `docs/agents/issue-tracker.md` | reference | GitHub Issues `gh` CLI commands for this repo |
| `docs/agents/triage-labels.md` | reference | Triage label vocabulary and creation commands |
| `docs/agents/domain.md` | reference | Domain doc layout for engineering skills |

---

## Archived docs

Historical ADRs, design specs, and superseded docs live in `docs/archive/`. They are kept for reference but not maintained.

- `docs/archive/adr/` — 15 architectural decision records (ADR-001 through ADR-015)
- `docs/archive/architecture-overview.md` — superseded by root `ARCHITECTURE.md`
- `docs/archive/FLOWS-root-duplicate.md` — superseded by `docs/FLOWS.md`
- Other design specs, research docs, and session reports

---

## Doc hygiene rules

Every active doc in this project must have a metadata header:

```
---
doc-type: [runbook | architecture | reference | backlog | spec]
status: [active | draft | archived]
owner: jason
updated: YYYY-MM-DD
---
```

The `doc-hygiene` skill enforces this automatically. Run `/doc-hygiene` at any time to audit all docs.
