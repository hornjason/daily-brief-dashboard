# DailyBriefDashboard — Project Map

On-demand reference for agents. Not auto-loaded — read when you need orientation.

## Backend Modules

| Module | Purpose |
|--------|---------|
| `server.ts` | Hono routes, ~50 API endpoints |
| `src/health-score.ts` | 6-signal weighted health score (Cases 25%, Subs 20%, Meetings 15%, Emails 15%, Pipeline 15%, Cloud 10%) |
| `src/brief-pipeline.ts` | Three-step brief: `rankItems()` deterministic scorer + `buildSynthesisPrompt()` |
| `src/customer.ts` | Brief generation: `generateBrief()`, `extractSignals()`, `buildXmlSources()`, `callLLM()` |
| `src/kpi-history.ts` | Daily metric snapshots, 90-day rolling window, sparkline data |
| `src/doc-extraction.ts` | Drive document classification + structured extraction |
| `src/email-extraction.ts` | Email intelligence: action items, competitive mentions, silent contacts |
| `src/calendar-extraction.ts` | Meeting prep assembly from calendar + email + cases |
| `src/background-scheduler.ts` | All scheduled timers (ADR-007 self-rescheduling setTimeout pattern) |
| `src/settings-api.ts` | Refresh intervals, scheduler config, weather settings |
| `src/scraper-manager.ts` | RH/SF scrape orchestration, mutex guards, session lifecycle |
| `src/bootstrap-orchestrator.ts` | 6-step AE setup: Drive → Customers → Supportable → Sheets → CCSP → Pipeline |
| `src/territory-sync.ts` | Territory sheet diff + auto-add/flag removals |
| `src/refresh-engine.ts` | refreshAll/Subscriptions/CCSP/Pipeline from Google Sheets |
| `src/cache-layer.ts` | Brief/sheet/CCSP/pipeline cache helpers |
| `src/pipeline.ts` | SF pipeline data fetch + dedup |
| `src/sheets.ts` | Google Sheets read/write, tab matching, quota retry |
| `src/google.ts` | Google OAuth, Drive API helpers |

## Stack

- **Runtime:** Bun + Hono (server), React + Vite (dashboard)
- **Scraping:** Playwright (shared browser context)
- **AI:** Gemini (Vertex AI) — three-step pipeline in `src/brief-pipeline.ts`
- **External:** Google Sheets/Drive, Red Hat Portal, Salesforce, Tableau, Supportable 360
- **Container:** Podman, `localhost/daily-brief-dashboard:latest`

## Architecture & Design Docs

- `ARCHITECTURE.md` — System design, data flows, intentional patterns
- `PRINCIPLES.md` — Design constraints
- `docs/UNIFIED-REDESIGN-SPEC.md` — Redesign: health scores, morning summary, priority actions, sparklines
- `docs/GEMINI-BRIEF-ARCHITECTURE.md` — Brief pipeline prompts, schemas, sub-pipelines
- `docs/INFORMATION-ARCHITECTURE-V2.md` — Information architecture (Serena)
- `docs/VISUAL-DESIGN-SPEC.md` — Visual design (Aditi)

## ADRs

- `docs/ADR-001-session-architecture.md` — Long-lived RH Portal sessions
- `docs/ADR-002-write-path-discipline.md` — No concurrent state mutation
- `docs/ADR-003-error-handling.md` — No silent failures, sanitized errors
- `docs/ADR-004-testing-strategy.md` — API-layer testing
- `docs/ADR-005-code-organization.md` — Module boundaries
- `docs/adr/ADR-004.md` — Sequential background refresh (numbering conflict — do not renumber)
- `docs/adr/ADR-006.md` — Test snapshot/restore endpoints
- `docs/adr/ADR-007.md` — Bun runtime, long-interval timer heartbeat
- `docs/adr/ADR-008.md` — Supportable batch rotation

## Operations

- `TIMERS.md` — Full inventory of 34 timers
- `DATA-FRESHNESS.md` — Per-source sync chains
- `BACKLOG.md` — All items with status
- `ROADMAP.md` — Priority tracks
- `FLOWS.md` — User + data flows
- `EXECUTION-PLAN.md` — Implementation phasing

## Morning Sync Sequence

| Time (ET) | Source | Timer | Notes |
|---|---|---|---|
| 1:45 AM | Territory Sheet | 33 | GSheet → customers.json diff |
| 2:00 AM | SF Pipeline | 7 | SF Lightning → GSheet → cache |
| 6:30 AM | CCSP / Tableau | 31 | Tableau → GSheet + delta |
| 7:00 AM | Supportable | 32 | Batch rotation (ADR-008) |
| 8:00 AM | KPI Snapshot | 34 | Daily metrics → kpi-history.json |
| Continuous | RH Cases | 3 | 15-min heartbeat, configurable interval |

All schedule times configurable via Admin page. Floors enforced server-side.

## Stale Docs (do not use as authoritative)

- `docs/architecture.md` → superseded by root `ARCHITECTURE.md`
- `docs/ARCHITECTURE-oauth-multiAE.md` → captured in `ARCHITECTURE.md` §7
