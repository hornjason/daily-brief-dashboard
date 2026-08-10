---
doc-type: architecture
status: active
owner: jason
updated: 2026-08-03
---

# DailyBriefDashboard — Golden State Architecture

Single-tenant intelligence dashboard for a Red Hat Account Executive. Aggregates RH Portal, Salesforce, Tableau CCSP, Google services (Drive, Gmail, Calendar), and SalesHub into a daily brief UI. Container-only (`pai-dashboard` on port 7777), localhost-only, no auth middleware. Deployed via `make rebuild`.

Read this file first. Follow doc routing table for deeper detail.

---

## Architecture Layers

<!-- ASSERTION: count("src/modules/*-module.ts") == 35 -->
<!-- ASSERTION: count("src/quality-validators/*.ts") == 16 -->
<!-- ASSERTION: count("docs/adr/ADR-*.md") == 27 -->
<!-- ASSERTION: file_exists("src/lib/context-orchestrator.ts") -->
<!-- ASSERTION: file_exists("src/lib/grounding-rules.ts") -->
<!-- ASSERTION: grep("GROUNDING_RULES_BLOCK", "src/lib/grounding-rules.ts") -->

| # | Layer | Purpose | Key Contract | Status | Reference |
|---|---|---|---|---|---|
| 1 | Signal Producers | Modules emit facts with metadata | `rawRelevance` + metadata, registry scores via `scoreSignal()` (ADR-027) | ALIGNED | `PRINCIPLES.md` Layer 1 |
| 2 | Signal Scoring | Centralized scoring by specificity + boosters | `scoreSignal()` in `feature-module-registry.ts`, no hardcoded scores | ALIGNED | `ARCHITECTURE.md` §22 |
| 3 | Template Engine | Deterministic sections from scored signals | `templateAll()` is single data path (ADR-031) | ALIGNED | `src/lib/signal-templates.ts` |
| 4 | Consumers | Thin callers that slice template output | All 8 consumers use `buildConsumerContext` or `templateAll` | ALIGNED | `PRINCIPLES.md` Consumer table |
| 5 | Module Registry | Feature module lifecycle + auto-discovery | 35 modules via `FeatureModuleRegistry.register()` (ADR-020) | ALIGNED | `src/modules/*-module.ts` |
| 6 | Gemini Call Layer | Unified AI call wrapper | `callGemini()` in `gemini-call.ts`: retry, cost tracking, delta cache | ALIGNED | `ARCHITECTURE.md` §21 |
| 7 | Quality Validators | Output validation before caching | 16 validators in `src/quality-validators/` (ADR-024) | ALIGNED | `src/quality-validators/*.ts` |
| 8 | Scheduler | Centralized timer lifecycle | 11 tasks via `schedulerRegistry.register()` (ADR-028) | ALIGNED | `src/background-scheduler.ts` |
| 9 | Data Ingestion | 4-tier cache (L1-L4), Drive sync, scraper pipeline | L4 browser scrapes → Drive → L3 reads → L2 cache → L1 API | ALIGNED | `docs/DATA-INGESTION-ARCHITECTURE.md` |
| 10 | API Surface | HTTP endpoints, localhost-only | 26 route files, Hono framework, no auth middleware | ALIGNED | `PROJECT-STATE.md` |
| 11 | Context Orchestrator | Consumer context assembly | `buildConsumerContext` wraps `templateAll` + Layer 2/3 context | ALIGNED | `src/lib/context-orchestrator.ts` |
| 12 | Enforcement | Pre-commit + pre-push hooks, compliance tests | `architecture-compliance.test.ts`, `SkillEnforcement`, `SecurityValidator` | ALIGNED | `test/unit/architecture-compliance.test.ts` |

### Layer interactions

```mermaid
graph TD
    A[Signal Producers<br/>35 modules] -->|rawRelevance + metadata| B[Signal Scoring<br/>scoreSignal]
    B -->|scored signals| C[Template Engine<br/>templateAll]
    C -->|deterministic + narrative| D[Context Orchestrator<br/>buildConsumerContext]
    D -->|consumer context| E[Consumers<br/>8 thin callers]
    E -->|raw output| F[Quality Validators<br/>16 validators]
    F -->|validated| G[Cache / Drive]
    H[Gemini Call Layer<br/>callGemini] -.->|AI generation| E
    I[Data Ingestion<br/>L1-L4] -->|signals| A
    J[Scheduler<br/>11 tasks] -->|triggers| I
    K[Module Registry<br/>FeatureModuleRegistry] -->|lifecycle| A
```

### Enforcement stack

```mermaid
graph LR
    A[Pre-commit hooks] --> B[Pre-push gate<br/>unit tests + typecheck]
    B --> C[architecture-compliance.test.ts<br/>ADR drift detection]
    C --> D[Quality validators<br/>per-consumer output gate]
    D --> E[Ship DURABILITY<br/>doc cascade check]
```

---

## Module Registry Snapshot

<!-- ASSERTION: grep("schedulerRegistry.register", "src/background-scheduler.ts") -->
<!-- ASSERTION: count("src/*-routes.ts") == 26 -->

| Category | Count | Location |
|---|---|---|
| Feature modules | 35 | `src/modules/*-module.ts` |
| Quality validators | 16 | `src/quality-validators/*.ts` |
| ADRs (active) | 27 | `docs/adr/ADR-*.md` |
| Scheduled tasks | 11 | `src/background-scheduler.ts` |
| Consumers | 8 | See `PRINCIPLES.md` Consumer → File table |
| Grounding rules | 6 | `src/lib/grounding-rules.ts` |
| Route files | 26 | `src/*-routes.ts` |

### Scheduler Tasks

11 registered tasks via `schedulerRegistry.register()` in `src/background-scheduler.ts`. Each task has a cron expression, handler function, and optional dependencies. Registry contract defined in `src/scheduler-registry.ts` (ADR-028).

### Consumer Context Pipeline

8 consumers use `buildConsumerContext()` from `src/lib/context-orchestrator.ts`. Each consumer calls `templateAll()` for deterministic signal assembly, then passes through quality validators. Consumer defaults defined in `CONSUMER_DEFAULTS` (context-orchestrator.ts). See `PRINCIPLES.md` Consumer table for the full list.

### Quality Validators

16 validators in `src/quality-validators/*.ts`. Each validator runs on consumer output before caching. Validators enforce output quality: section count, content presence, formatting rules, and domain-specific checks (ADR-024).

### Route Files and API Surface

26 route files at `src/*-routes.ts` using Hono framework. Localhost-only, no auth middleware. Each route file uses `createRouter()` and is registered in `server.ts`. See `PROJECT-STATE.md` for full endpoint inventory.

### Data Hygiene

Zero real data in source or committed config (ADR-042). Five zero-rules govern every commit:

| Rule | What it prohibits |
|------|-------------------|
| Zero org-specific URLs | Salesforce instance URLs, internal dashboard links, Tableau endpoints |
| Zero real customer data | Real customer names, account IDs in source or test fixtures |
| Zero personal identifiers | Real email addresses, team member names, phone numbers |
| Zero hardcoded credentials | API keys, tokens, passwords, service account paths |
| Zero infrastructure IDs | Google Drive folder IDs, Slack channel IDs, internal hostnames |

**Enforcement stack:**

| Layer | Mechanism | Trigger |
|-------|-----------|---------|
| Pre-commit hook | `scripts/hooks/pre-commit` — scans staged files for sensitive patterns | Every commit |
| Control Plane scanner | `scanSensitiveData()` — audits full codebase | On demand + scheduled |
| Architecture compliance | `architecture-compliance.test.ts` — verifies no regressions | Every `bun test` |

### Universal Check Categories

Beyond the five zero-rules, the enforcement stack detects these universal categories:

| # | Category | Enforcement | Example Pattern |
|---|----------|-------------|-----------------|
| 1 | API keys and provider tokens | Hook + Scanner | `AKIA...`, `sk-...`, `ghp_...`, `sk_live_...`, `xoxb-...` |
| 2 | Private keys and certificates | Hook + Scanner | `BEGIN PRIVATE KEY`, `.pem`, `.p12` |
| 3 | Database connection strings | Hook + Scanner | `postgres://user:pass@host`, `mongodb://...` |
| 4 | JWT tokens | Hook + Scanner | `eyJhbG...` (Base64-encoded JSON header) |
| 5 | Private/internal IP addresses | Scanner only | `10.x.x.x`, `172.16.x.x`, `192.168.x.x` |
| 6 | Email addresses | Scanner only | Real addresses (non-`@example.com`) |
| 7 | Internal hostnames | Scanner only | `.internal`, `.local`, `.corp`, `.lan` |

**Config pattern:** Real config files are `.gitignore`d. Committed `-example` templates document required fields with placeholder values. Reference: `docs/adr/ADR-042-data-hygiene.md`, `PRINCIPLES.md` Q23.

---

## Known Gaps

<!-- ASSERTION: grep("buildConsumerContext", "src/account-plan.ts") -->
<!-- ASSERTION: grep("buildConsumerContext", "src/campaign-service.ts") -->

### HIGH — Code Drift

| File | Issue | ADR Violated |
|---|---|---|
| `src/account-discovery.ts` | Missing `supportsAllDrives` on Drive API calls | ADR-019 (L3 CSV discovery) |
| `src/product-intelligence.ts` | Triple ADR violation: direct Gemini call bypasses `callGemini()`, no quality validator, no `ensureFresh` | ADR-023, ADR-024, ADR-020 |

### MEDIUM — Doc Debt

| Item | Status |
|---|---|
| ADR-040 (Universal Structured Output) | Proposed — not yet implemented |
| Email Outreach consumer | Missing `ensureFresh` contract |

---

## Doc Routing Table

| If touching... | Read first |
|---|---|
| Any module | `PRINCIPLES.md` (pre-flight questions), `ARCHITECTURE.md` §26 (compliance) |
| Scrapers | `docs/SCRAPER-RULES.md`, `ARCHITECTURE.md` §1-§3a |
| Consumers | `PRINCIPLES.md` (Consumer table, ensureFresh contract) |
| Gemini calls | `docs/adr/ADR-023`, `docs/adr/ADR-024`, `docs/adr/ADR-040` |
| Scheduler | `docs/adr/ADR-028`, `ARCHITECTURE.md` §28 |
| Signals / scoring | `docs/adr/ADR-027`, `PRINCIPLES.md` Layer 1-2 |
| Drive / L3 sync | `ARCHITECTURE.md` §3a, §6, `docs/DATA-INGESTION-ARCHITECTURE.md` |
| Tests | `docs/TESTING-RUNBOOK.md`, `test/unit/architecture-compliance.test.ts` |
| Deploy | `CLAUDE.md` (Deploy section), `Makefile` |
| New feature | `PRINCIPLES.md` (23 pre-flight questions), `docs/MODULE-DEVELOPER-GUIDE.md` |
| ADRs | `docs/adr/`, `PRINCIPLES.md` (ADR → PRINCIPLES enforcement) |
| UI / React | `PROJECT-STATE.md`, `dashboard/src/` |

---

## Anti-patterns — Top 5 Drift Causes

1. **Hardcoded scores in modules** — Use `rawRelevance` + metadata; `scoreSignal()` computes final score
2. **Consumers assembling own signal context** — Call `buildConsumerContext` or `templateAll`, never raw signals
3. **Bypassing `callGemini()` wrapper** — Loses retry, cost tracking, delta cache, timeout tiers
4. **Missing `ensureFresh()` on cached modules** — Consumers generate from stale/empty data
5. **ADR without PRINCIPLES.md update** — Creates rules nobody checks; `architecture-compliance.test.ts` catches this
