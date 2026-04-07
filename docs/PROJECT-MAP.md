# DailyBriefDashboard — Project Map

On-demand reference for agents. Not auto-loaded — read when you need orientation.

## Backend Modules

| Module | Purpose |
|--------|---------|
| `server.ts` | Hono routes, ~50 API endpoints |
| `src/health-score.ts` | 6-signal weighted health score (Cases 25%, Subs 20%, Meetings 15%, Emails 15%, Pipeline 15%, Cloud 10%); exports `computeConfidenceScore()` (0-100 composite, ADR-011) |
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
| `src/cache-layer.ts` | Brief/sheet/CCSP/pipeline cache helpers; exports `BRIEF_CACHE_TTL_MS` (4h, ADR-009) and `readLatestBriefCache()` |
| `src/pipeline.ts` | SF pipeline data fetch + dedup |
| `src/sheets.ts` | Google Sheets read/write, tab matching, quota retry |
| `src/google.ts` | Google OAuth, Drive API helpers |
| `src/product-release-radar.ts` | Life Cycle API + PDF/HTML scraping + Gemini synthesis per product; `SECTION_CAP=6000`, `TOTAL_CAP=18000` |
| `src/product-feature-radar.ts` | Drive corpus feature extraction; exports `getFeatureCache(slug)`, `extractProductFeatures()`, `enrichFeatures()`, `refreshAllFeatures()` |
| `src/product-drive-ingest.ts` | Drive folder listing + Markdown/doc content ingestion for each product |
| `src/product-intelligence.ts` | Q&A chat pipeline for product pages (BKL-AI16) |
| `src/product-intel-routes.ts` | Hono route handlers for all `/api/products/*` endpoints; loads feature cache and passes to customer intel generation |
| `src/customer-product-intel.ts` | `generateCustomerProductIntel()` — Gemini prompt with injected feature radar; outputs `featureTalkingPoints` (top 3-5 ranked features with reason + signalSource) |
| `src/account-plan.ts` | `generateAccountPlan()` — assembles 4 sources (sample plan, questions PDF, playbook, customer intel) and calls Gemini multimodal to produce a full account plan markdown; `ensureAccountPlansSubfolder()` creates `Account Plans/` in Drive (separate from `Account Intelligence/`); `readAccountPlan()` reads from cache |

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
- `docs/ADDING-NEW-AE.md` — AE onboarding runbook (bootstrap, post-triggers, validation)

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
- `docs/adr/ADR-009.md` — Brief cache: content-hash + 4h TTL invalidation
- `docs/adr/ADR-010.md` — Account intelligence: dual-write cache pattern (Drive + local JSON)
- `docs/adr/ADR-011.md` — Confidence Score: 0-100 composite replacing separate Renewal Risk
- `docs/adr/ADR-012.md` — Product Intelligence Hub: Drive optional, feature injection into customer intel, cap expansion, 7-product bootstrap scaffold

## Frontend Components (Notable)

| Component | Purpose |
|---|---|
| `DataQualityBadge` | Brief freshness pill — shows cached-at timestamp and staleness state on `CustomerDetailPage` |
| `AccountIntelligencePanel` | Intelligence pipeline status + Drive doc links on `CustomerDetailPage` |
| `AccountPlanPanel` | Account plan section on `CustomerDetailPage` — 3 states: not-generated (Generate button), generating (spinner + polling), generated (View/Download/Regenerate) |
| `MarkdownPreviewModal` | Full-screen modal with rendered markdown — tables, headers, lists, inline formatting; handles `javascript:` URI injection |
| `AccountPortfolioGrid` | Customer list grid; shows `confidenceScore` badge per customer |
| `AdminPage` | 3-step intelligence progress stepper for account intelligence pipeline |
| `MorningSummary` | Morning summary page; includes Gemini `synthesis` narrative block |
| `ProductsPage` | Products listing — Unified Stream layout (FeatureFilterBar + SpotlightStrip + FeatureListRow + FeatureDetailPanel) |
| `ProductIntelSection` | Per-product intelligence section; hardcodes all 7 slugs: rhel, ocp, ocp-virt, aap, rhel-ai, rh-ai-inference, rhoai |

## API Fields (2026-04-05/06 Additions — Phase 2 + Phase 3)

| Endpoint | Field | Description |
|---|---|---|
| `GET /api/morning-summary` | `synthesis` | Gemini-generated 3-5 sentence portfolio narrative; 4h cached in `morning-synthesis.json` |
| `GET /api/customer/:name` (and list) | `confidenceScore` | `ConfidenceScoreBreakdown` from `computeConfidenceScore()` — 0-100 composite with sub-scores |
| `POST /api/products/:slug/generate-customer-intel` | — | Generates `CustomerProductIntel` for a specific customer+product pair; injects feature radar into prompt |
| `POST /api/customers/:id/account-plan/generate` | `{ ok, generatedAt, driveUrl }` | Triggers Gemini account plan generation; in-flight guard returns 409 if already running; uploads to `Account Plans/` Drive subfolder |
| `GET /api/customers/:id/account-plan` | `{ markdown, generatedAt, driveUrl } \| { notGenerated: true }` | Returns cached account plan markdown or not-generated sentinel |
| `GET /api/products` | — | Lists all 7 product configs with feature cache status |
| `GET /api/products/:slug` | — | Returns `ProductSummary` + `ProductFeatureCache` for a single product |
| `POST /api/products/:slug/refresh` | — | On-demand re-scrape + re-synthesis for a product |
| `CustomerProductIntel` response | `featureTalkingPoints` | Top 3-5 feature radar items ranked by relevance to this customer; each has `feature`, `status`, `version`, `reason`, `signalSource` |

## Cache Files

| File | Written by | Read by | TTL/Notes |
|---|---|---|---|
| `data/cache/{slug}-{date}.json` | `writeBriefCache()` | `readBriefCache()`, `readLatestBriefCache()` | Daily date-stamp; 4h TTL enforced at read time (ADR-009) |
| `data/cache/{slug}-sheets.json` | `writeSheetCache()` | `readSheetCache()` | No TTL; updated on each sheet refresh |
| `data/cache/intelligence/{slug}.json` | `account-intelligence.ts` Steps 2+3 | `buildXmlSources()` in `customer.ts` | No TTL; overwritten on each intelligence run (ADR-010) |
| `data/cache/intelligence/{slug}-account-plan.md` | `generateAccountPlan()` in `account-plan.ts` | `readAccountPlan()` | No TTL; overwritten on each manual generation; includes `<!-- Generated: ISO -->` header |
| `data/cache/intelligence/{slug}-account-plan-meta.json` | `savePlanMeta()` in `account-plan.ts` | `readAccountPlan()` | Stores `driveUrl` + `generatedAt` sidecar |
| `data/cache/intelligence-jobs.json` | `setJob()` in `account-intelligence.ts` | Job status polling | Persisted across restarts via `initJobPersistence()` |
| `data/cache/morning-synthesis.json` | `synthesizeMorningSummary()` in `dashboard-routes.ts` | `GET /api/morning-summary` | 4h TTL (`MORNING_SYNTHESIS_TTL_MS`) |
| `data/cache/pipeline-data.json` | `writePipelineCache()` | `readPipelineCache()` | Updated daily at 2am ET |
| `data/cache/ccsp-data.json` | `writeCCSPCache()` | `readCCSPCache()` | Updated on CCSP refresh |
| `data/cache/product-intel/{slug}-features.json` | `refreshAllFeatures()` in `product-feature-radar.ts` | `getFeatureCache(slug)` | Updated on product Drive corpus refresh; includes `corpusHash` for cache invalidation |
| `data/cache/product-intel/{slug}-summary.json` | `product-release-radar.ts` synthesis | `GET /api/products/:slug` | Updated on product release radar refresh |
| `data/cache/product-intel/{slug}-customer-intel/{customer}.json` | `generateCustomerProductIntel()` | `GET /api/products/:slug/generate-customer-intel` | Content hash includes `productFeaturesHash`; invalidated when corpus changes |

## Operations

- `TIMERS.md` — Full inventory of 34 timers
- `DATA-FRESHNESS.md` — Per-source sync chains
- `BACKLOG.md` — All items with status
- `ROADMAP.md` — Priority tracks
- `FLOWS.md` — User + data flows
- `EXECUTION-PLAN.md` — Implementation phasing
- `docs/ADDING-NEW-AE.md` — Complete runbook for onboarding a new AE (bootstrap → validation)

## Data Pipeline Summary

Full inventory in `ARCHITECTURE.md` §17. Quick reference:

| Pipeline | Type | Schedule / Trigger |
|---|---|---|
| RH Cases | Browser scrape | Heartbeat interval (default 4h, configurable) |
| Supportable | Browser scrape | Daily 7:00 AM ET, 3-batch rotation |
| CCSP / Tableau | Browser scrape | Daily 6:30 AM ET |
| SF Pipeline | Browser scrape | Daily 2:00 AM ET |
| Account Intelligence | Gemini + grounding | Post-bootstrap + Admin "Generate All" |
| Customer Briefs | Gemini | On-demand per page view, 4h cache |
| Product Intelligence | Gemini + Drive corpus | Weekly Sunday 6:00 AM ET |
| Morning Synthesis | Gemini | On-demand, 4h cache |
| Gmail | Google API | Per brief generation (30 days) |
| Calendar | Google API | Per dashboard load (30 days) |
| Drive docs | Google API | Per brief generation (customer folder) |
| Domain Inference | Automated | Post-bootstrap |
| Territory Sync | Google Sheets | Daily 1:45 AM ET |
| KPI Snapshot | Internal | Daily 8:00 AM ET |
| NotebookLM | Manual | Admin trigger only |

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
