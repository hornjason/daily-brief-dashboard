---
doc-type: reference
status: active
owner: jason
updated: 2026-05-14
---

# DailyBriefDashboard — Project Map
*Last validated: 2026-04-21 | Owner: DA | Trigger: New module added, endpoint added/removed, new Operational or Architecture doc created, doc deleted*

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
| `src/bootstrap-orchestrator.ts` | 6-step AE setup: Drive folder → Customer folders → SF Bookings read → Write sheet → CCSP → Pipeline. Step 0 creates `appBackup` Google Sheet in `parentFolderId` root (idempotent). |
| `src/backup-config.ts` | `createBackupSheet(parentFolderId)` — creates/finds `appBackup` sheet. `_backupNowImmediate()` — debounced (10s) write of aes/customers/data-sources to Drive sheet. `restoreFromBackup()` — reads sheet back to disk. All operations use stored `backupSheetId` (Drive file ID), not sheet name. |
| `src/backup-routes.ts` | `POST /api/admin/backup`, `GET /api/admin/backup/status`, `POST /api/admin/backup/restore` |
| `src/region-config.ts` | `RegionConfig` interface (`id`, `label`, `type`, `territorySheetUrl`, `podBookingsFolderId`, `parentFolderId`, `pods`). `normalizeSettings()` — coerces raw JSON to typed settings. `coerceRegion()` — per-region coercion with safe defaults. `getRegionById()`. |
| `src/setup-routes.ts` | OAuth setup + territory sync routes. `runStartupDriveMerge()` — on startup, if any region has `parentFolderId`, fetches `Config/settings.json` from Drive and deep-merges (Drive wins on `regions[]`, local wins on all other keys). Best-effort — never crashes server. |
| `src/territory-sync.ts` | Territory sheet diff + auto-add/flag removals. Exports `isEnterpriseTab`, `extractEnterpriseAeMap`, `enterpriseTerritoryKey` — used by `dashboard-routes.ts` territory-names/territory-lookup endpoints for enterprise regions (e.g. TOLA). |
| `src/refresh-engine.ts` | refreshAll/Subscriptions/CCSP/Pipeline from Google Sheets |
| `src/cache-layer.ts` | ADR-013 canonical cache layer. Tiers: Tier 2 (email/meeting 2h TTL), Tier 3 (doc content + doc classification + brief fingerprint + CCSP/pipeline hash guards), Tier 4 (intelligence 14d/30d TTL + shared industry-analysis by industry+region). `BRIEF_CACHE_TTL_MS` is 7d safety-net (fingerprint is primary invalidator). |
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
| `src/ingest-events.ts` | SSE cache-level telemetry bus. Exports `emitCacheLevel(event)` (fire-and-forget, called at each L1/L2/L3/L4 cache hit in the waterfall), `onCacheLevel(handler)` / `offCacheLevel(handler)` (subscription hooks), `IngestCacheEvent` type. Powers `GET /api/ingest/events`. |

## Stack

- **Runtime:** Bun + Hono (server), React + Vite (dashboard)
- **Scraping:** Playwright (shared browser context)
- **AI:** Gemini (Vertex AI) — three-step pipeline in `src/brief-pipeline.ts`
- **External:** Google Sheets/Drive, Red Hat Portal, Salesforce, Tableau
- **Container:** Podman, `localhost/daily-brief-dashboard:latest` (multi-arch: amd64 + arm64)

## Architecture & Design Docs

- `ARCHITECTURE.md` — System design, data flows, intentional patterns
- `PRINCIPLES.md` — Design constraints
- `docs/ADDING-NEW-AE.md` — AE onboarding runbook (bootstrap, post-triggers, validation)
- `docs/ENVIRONMENTS.md` — Environment strategy: 4 containers (prod 7777, dev 7778, test 7776, demo 7779), promotion pipeline, tunnel setup

## ADRs

- `docs/archive/adr/ADR-001-session-architecture.md` — Long-lived RH Portal sessions
- `docs/archive/adr/ADR-002-write-path-discipline.md` — No concurrent state mutation
- `docs/archive/adr/ADR-003-error-handling.md` — No silent failures, sanitized errors
- `docs/archive/ADR-004-testing-strategy.md` — API-layer testing (superseded by docs/archive/adr/ADR-004.md)
- `docs/archive/adr/ADR-005-code-organization.md` — Module boundaries
- `docs/archive/adr/ADR-004.md` — Sequential background refresh (numbering conflict — do not renumber)
- `docs/archive/adr/ADR-006.md` — Test snapshot/restore endpoints
- `docs/archive/adr/ADR-007.md` — Bun runtime, long-interval timer heartbeat
- `docs/archive/adr/ADR-009.md` — Brief cache: content-hash + 4h TTL invalidation
- `docs/archive/adr/ADR-010.md` — Account intelligence: dual-write cache pattern (Drive + local JSON)
- `docs/archive/adr/ADR-011.md` — Confidence Score: 0-100 composite replacing separate Renewal Risk
- `docs/archive/adr/ADR-012.md` — Product Intelligence Hub: Drive optional, feature injection into customer intel, cap expansion, 7-product bootstrap scaffold
- `docs/archive/adr/ADR-013.md` — Data Ingestion Tier Standard: 4-tier cache model (Live/Time-boxed/Content-addressed/Long-lived); Tier 3 is canonical pattern
- `docs/archive/adr/ADR-014.md` — Dual-Transport Architecture for RH Portal Case Refresh (Bearer token primary, browser fallback; 2026-04-18)

## Frontend Utilities

| Utility | Purpose |
|---|---|
| `dashboard/src/utils/productName.ts` | Product name normalization pipeline: `stripProductName()` (removes "Red Hat " prefix + packaging suffix), `normalizeProductName()` (maps raw names → 10 display labels: RHEL, OCP, AAP, Middleware, Storage, Trial, Free, Beta, Partner Subscriptions, Developer Subscriptions), `discoverAllProducts()` (deduped sorted labels from all accounts), `getProductGroupMembers()` (reverse-lookup for chip tooltips — LOG-03) |

## Frontend Components (Notable)

| Component | Purpose |
|---|---|
| `DataQualityBadge` | Brief freshness pill — shows cached-at timestamp and staleness state on `CustomerDetailPage` |
| `AccountIntelligencePanel` | Intelligence pipeline status + Drive doc links on `CustomerDetailPage` |
| `AccountPlanPanel` | Account plan section on `CustomerDetailPage` — 3 states: not-generated (Generate button), generating (spinner + polling), generated (View/Download/Regenerate) |
| `MarkdownPreviewModal` | Full-screen modal with rendered markdown — tables, headers, lists, inline formatting; handles `javascript:` URI injection |
| `AccountPortfolioGrid` | Customer list grid; product filter: matching subs expanded inline, non-matching collapsed behind "show N more"; AE grouping when filter active + 2+ AEs; react-window VariableSizeGrid virtualization for "All" mode; shows `confidenceScore` badge per customer |
| `AdminPage` | 3-step intelligence progress stepper for account intelligence pipeline |
| `KPICards` | Portfolio KPI summary bar; product-scoped when filter active — shows filtered/total ratio; case counts, expiring, and renewal counts scoped to matching subscriptions (LOG-04) |
| `MorningSummary` | Morning summary page; includes Gemini `synthesis` narrative block; customer bullets filtered to product-matching accounts when filter active (LOG-05); hidden in Product view mode |
| `Sidebar` | Navigation sidebar; ASA/Product view mode toggle (localStorage key: `dashboard-view-mode`); collapsed state shows stacked A/P compact buttons |
| `ProductsPage` | Products listing — Unified Stream layout (FeatureFilterBar + SpotlightStrip + FeatureListRow + FeatureDetailPanel) |
| `ProductIntelSection` | Per-product intelligence section; hardcodes all 7 slugs: rhel, ocp, ocp-virt, aap, rhel-ai, rh-ai-inference, rhoai |

## Product Filter — localStorage State Keys

| Key | Values | Purpose |
|---|---|---|
| `dashboard-view-mode` | `"asa"` \| `"product"` | ASA vs Product view mode toggle (Sidebar) |
| `ae-filter-selected` | AE first name string \| `""` | Single-select AE chip filter (App.tsx) |
| `product-filter-selected` | JSON array of label strings | Multi-select product chip filter (App.tsx) |

## Wizard Endpoints (2026-05-03 — BKL-ONBOARD-10)

| Endpoint | Description |
|----------|-------------|
| `POST /api/wizard/setup-region` | Creates a region from a Google Sheets territory URL. Body: `{ sheetUrl, label, sfReportId }`. Idempotent on `territorySheetUrl`. Returns `{ success: true, regionId }`. regionId is the Google Sheets spreadsheet ID. |
| `GET /api/wizard/seed-sheets` | Returns the two built-in seed territory sheet URLs as `{ sheets: string[] }`. |
| `GET /api/settings/regions` | Lists all configured regions as `{ regions: { id, label, type }[] }`. Normalizes legacy flat settings schema. |

## Ingestion Telemetry Endpoint (2026-04-19)

| Endpoint | Description |
|----------|-------------|
| `GET /api/ingest/events` | Long-lived SSE stream. Emits `event: connected` on connect; `event: cache-level` with `{type, ae, flow, level, rowCount?, timestamp}` at each L1/L2/L3/L4 cache hit during bootstrap and refresh. Does not fire during onboarding (first-time folder creation). Use `curl -N http://localhost:7776/api/ingest/events` to monitor. |

## API Fields (2026-04-05/06 Additions — Phase 2 + Phase 3)

| Endpoint | Field | Description |
|---|---|---|
| `GET /api/morning-summary` | `synthesis` | Gemini-generated 3-5 sentence portfolio narrative; 4h cached in `morning-synthesis.json` |
| `GET /api/customer/:name` (and list) | `confidenceScore` | `ConfidenceScoreBreakdown` from `computeConfidenceScore()` — 0-100 composite with sub-scores |
| `POST /api/products/:slug/intel/:customerSlug/generate` | — | Generates `CustomerProductIntel` for a specific customer+product pair; injects feature radar into prompt |
| `POST /api/customers/:id/account-plan/generate` | `{ ok, generatedAt, driveUrl }` | Triggers Gemini account plan generation; in-flight guard returns 409 if already running; uploads to `Account Plans/` Drive subfolder |
| `GET /api/customers/:id/account-plan` | `{ markdown, generatedAt, driveUrl } \| { notGenerated: true }` | Returns cached account plan markdown or not-generated sentinel |
| `GET /api/pod/summary` | `{ totalCustomers, totalAEs, openCases, openCasesByProduct, expiringNext90Days, productMix }` | Aggregated POD-level KPIs; runtime aggregation across all customer + RH cases caches; 30s in-memory TTL; customer deduplication by lowercase name |
| `GET /api/ccsp` | — | Cloud spend data; accepts optional `?products=OCP,RHEL` param — filters records by `productOfferingGroup` before aggregating (LOG-06) |
| `GET /api/products` | — | Lists all 7 product configs with feature cache status |
| `GET /api/products/:slug` | — | Returns `ProductSummary` + `ProductFeatureCache` for a single product |
| `POST /api/products/:slug/refresh` | — | On-demand re-scrape + re-synthesis for a product |
| `CustomerProductIntel` response | `featureTalkingPoints` | Top 3-5 feature radar items ranked by relevance to this customer; each has `feature`, `status`, `version`, `reason`, `signalSource` |

## Cache Files

| File | Written by | Read by | TTL/Notes |
|---|---|---|---|
| `data/cache/{slug}-{date}.json` | `writeBriefCache()` | `readBriefCache()`, `readLatestBriefCache()` | Tier 3 — input fingerprint (SHA256 of all inputs); 7d safety-net TTL (ADR013-P2) |
| `data/cache/{slug}-sheets.json` | `writeSheetCache()` | `readSheetCache()` | Tier 3 — SHA256 hash guard; updated on sheet refresh |
| `data/cache/{slug}-emails.json` | `writeEmailCache()` | `readEmailCache()` | Tier 2 — 2h TTL (ADR013-P1) |
| `data/cache/{slug}-meetings.json` | `writeMeetingCache()` | `readMeetingCache()` | Tier 2 — 2h TTL (ADR013-P1) |
| `data/cache/docs/{fileId}-{modifiedTime}.json` | `writeDocContentCache()` | `readDocContentCache()` | Tier 3 — content-addressed by fileId+modifiedTime; no TTL (ADR013-P0) |
| `data/cache/doc-classifications/{fileId}-{modifiedTime}.json` | `writeDocClassCache()` | `readDocClassCache()` | Tier 3 — content-addressed by fileId+modifiedTime; no TTL (ADR013-P0) |
| `data/cache/industry-analysis/{slug}.json` | `writeIndustryAnalysisCache()` | `readIndustryAnalysisCache()` | Tier 4 — shared by industry+region key; 30d TTL (TOKEN-05) |
| `data/cache/intelligence/{slug}.json` | `account-intelligence.ts` Steps 2+3 | `buildXmlSources()` in `customer.ts` | Tier 4 — company: 14d TTL, industry: 30d TTL (TOKEN-02, ADR-010) |
| `data/cache/intelligence/{slug}-account-plan.md` | `generateAccountPlan()` in `account-plan.ts` | `readAccountPlan()` | No TTL; overwritten on each manual generation; includes `<!-- Generated: ISO -->` header |
| `data/cache/intelligence/{slug}-account-plan-meta.json` | `savePlanMeta()` in `account-plan.ts` | `readAccountPlan()` | Stores `driveUrl` + `generatedAt` sidecar |
| `data/cache/intelligence-jobs.json` | `setJob()` in `account-intelligence.ts` | Job status polling | Persisted across restarts via `initJobPersistence()` |
| `data/cache/morning-synthesis.json` | `synthesizeMorningSummary()` in `dashboard-routes.ts` | `GET /api/morning-summary` | 4h TTL (`MORNING_SYNTHESIS_TTL_MS`) |
| `data/cache/pipeline-data.json` | `writePipelineCache()` | `readPipelineCache()` | Tier 3 — SHA256 hash guard; updated daily at 2am ET (TOKEN-04) |
| `data/cache/ccsp-data.json` | `writeCCSPCache()` | `readCCSPCache()` | Tier 3 — SHA256 hash guard; updated on CCSP refresh (TOKEN-04) |
| `data/cache/product-intel/{slug}-features.json` | `refreshAllFeatures()` in `product-feature-radar.ts` | `getFeatureCache(slug)` | Updated on product Drive corpus refresh; includes `corpusHash` for cache invalidation |
| `data/cache/product-intel/{slug}-summary.json` | `product-release-radar.ts` synthesis | `GET /api/products/:slug` | Updated on product release radar refresh |
| `data/cache/product-intel/{slug}-customer-intel/{customer}.json` | `generateCustomerProductIntel()` | `GET /api/products/:slug/intel/:customerSlug` | Content hash includes `productFeaturesHash`; invalidated when corpus changes |

## Operations

- `docs/TIMERS.md` — Full inventory of timers (re-validation pending)
- `BACKLOG.md` — All items with status
- `docs/FLOWS.md` — User + data flows
- `docs/ADDING-NEW-AE.md` — Complete runbook for onboarding a new AE (bootstrap → validation)
- `docs/HERO-INSTALL.md` — Hero install design: L3-only wizard flow (Step 0–4), data sources, what's built vs. pending, flow diagrams
- `docs/MAC-MINI-DEMO-SETUP.md` — Mac Mini setup: demo environment, CI runner, stability asset (nightly tests, post-deploy smoke, visual regression, multi-arch builds)

## Data Pipeline Summary

Full inventory in `ARCHITECTURE.md` §17. Quick reference:

| Pipeline | Type | Schedule / Trigger |
|---|---|---|
| RH Cases | Bearer token SOLR (default) or browser scrape fallback | Heartbeat interval (default 4h, configurable) |
| CCSP / Tableau | Browser scrape (primary only) → writes L3 CSV to Drive | Daily 6:30 AM ET |
| SF Pipeline | Browser scrape (primary only) → writes L3 CSV to Drive | Daily 2:00 AM ET |
| SF Bookings | POD GSheet read (no scraper) | On bootstrap / refresh |
| Account Intelligence | Gemini + grounding | Post-bootstrap + Admin "Generate All" |

**Hero installs (L3-only):** CCSP and Pipeline read from shared Drive CSVs written by the primary Mac Mini. No Tableau or SF scraper runs. RH Cases uses Bearer token only. See `docs/HERO-INSTALL.md`.
| Customer Briefs | Gemini | On-demand; input fingerprint cache (7d safety-net TTL) — Gemini only on input change (ADR013-P2) |
| Product Intelligence | Gemini + Drive corpus | Weekly Sunday 6:00 AM ET |
| Morning Synthesis | Gemini | On-demand, 4h cache |
| Gmail | Google API | 2h TTL cache (ADR013-P1) — live call only on first request per window |
| Calendar | Google API | 2h TTL cache (ADR013-P1) — live call only on first request per window |
| Drive docs | Google API | Content-addressed by fileId+modifiedTime (ADR013-P0) — re-exported only on change |
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
| 8:00 AM | KPI Snapshot | 34 | Daily metrics → kpi-history.json |
| Continuous | RH Cases | 3 | 15-min heartbeat, configurable interval |

All schedule times configurable via Admin page. Floors enforced server-side.

## Testing Infrastructure

### Container Map

| Container | Port | Data Dir | ALLOW_RESET | Purpose |
|-----------|------|----------|-------------|---------|
| `pai-dashboard` | 7777 | `data/` | not set | **Production** — never wipe |
| `pai-dashboard-dev` | 7778 | `data-dev/` | not set | Dev snapshot of production |
| `pai-dashboard-test` | 7776 | `data-test/` | `true` | **Testing** — safe to wipe |

### Makefile Targets

| Target | Description |
|--------|-------------|
| `make doctor` | Environment health check — validates podman, config files, .env, image, container, API |
| `make backup-config` | Snapshot config files to `backups/config-backup-YYYYMMDD.tar.gz` for migration |
| `make restore-config FILE=...` | Restore config from backup tarball |
| `make seed` | Resets `data-test/` from canonical fixture source in `scripts/seed-data/` (2 AEs, 5 fake customers) |
| `make test-up` | Starts `pai-dashboard-test` container on port 7776 with `ALLOW_RESET=true` |
| `make test-down` | Stops and removes `pai-dashboard-test` container |
| `make test-logs` | Tails logs from the test container |
| `make lint` | Runs `scripts/check-empty-catches.sh` — fails if any `.catch(() => {})` exists in `dashboard/src/` |
| `make audit-docs` | Doc staleness audit — flags Operational docs with `Last validated` > 90 days old, dead file refs, un-archived session artifacts; exits 1 if errors (BKL-OPS-09) |

### Unit Tests

Location: `test/unit/`

| File | What it tests |
|------|--------------|
| `test/unit/slug.test.ts` | Customer slug generation |
| `test/unit/sanitize.test.ts` | `sanitizeCell()` and `sanitizeErr()` helpers |
| `test/unit/account-numbers.test.ts` | Account number validation and normalization |
| `test/unit/ingest-bug-ingest11-l2-cold-start.test.ts` | BKL-INGEST-11 regression — L2 SF Bookings short-circuit `aeHasCustomers` guard (12 tests) |
| *(23 unit test files total — ai-*, cache-*, ingest-01 through ingest-10, destructive-guard, vertex-429, and others)* | |

Run with: `bun test test/unit/` (no container needed)

### Production Guards

The following endpoints block destructive operations when >5 customers are loaded and `ALLOW_RESET=true` is not set:
- `POST /api/setup/reset`
- `POST /api/setup/save-customers`
- `POST /api/__test/restore` (also requires an existing snapshot)

### Reference

**Running tests → `docs/TESTING-RUNBOOK.md`** — commands, project routing (ci vs test), container map, seed data, safe vs destructive split.
**Why the system is designed this way → `docs/BKL-TEST-STRATEGY.md`** — guardrail rationale, production wipe history, architecture decisions. Read for context, not for commands.

## Stale Docs (do not use as authoritative)

- `docs/ARCHITECTURE-oauth-multiAE.md` → captured in `ARCHITECTURE.md` §7

