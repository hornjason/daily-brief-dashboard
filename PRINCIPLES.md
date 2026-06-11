---
doc-type: architecture
status: active
owner: jason
updated: 2026-06-10
---

# Design Principles — Deep Module Architecture

Every feature in this project follows three architectural layers. Violating these principles creates one-off gaps that require manual discovery and surgical fixes. Design for least complexity from the start.

## The Three Layers

### Layer 1: Signal producers report facts, the registry scores AND refreshes them (ADR-027, #328)
- Modules NEVER set `score` directly. They set `rawRelevance` + structured `metadata`.
- The registry's `scoreSignal()` determines specificity (customer/industry/general) and applies boosters from metadata.
- New signal sources automatically get correct scoring by providing the right metadata fields.
- **Pre-flight refresh (#328):** Modules implement optional `ensureFresh(customerSlug)` + `cacheTtlMs`. Before content generation, `loadCustomerSignals({ ensureFresh: true })` auto-refreshes ALL stale modules in parallel. New modules get refresh for free by implementing `ensureFresh()`. No hardcoded lists.
- Reference: `docs/adr/ADR-027-universal-signal-scoring-contract.md`, ARCHITECTURE.md §25

### Layer 2: Template engine renders deterministic sections from scored signals (#326)
- Deterministic sections (product alignment, cloud marketplace, renewals, cases, tech stack) are TEMPLATED from signals — never sent to Gemini for editorial judgment.
- Gemini only handles narrative synthesis (strategic position, priorities, SWOT, MEDDPICC).
- Signals auto-route to template sections by metadata keys:
  - `hasCloudSpend` / `cloudPartner` / `provider` → Cloud & Marketplace
  - `redHatProducts` / `product` / `managedService` → Product Alignment
  - `severity` / `caseNumber` → Cases
  - `renewal` / `stage` / `closeDate` → Renewals & Pipeline
  - `confidence` / `context` / `infrastructure` → Tech Stack
- New signal sources auto-template into the right section. No consumer code changes, no prompt engineering.
- Reference: `src/lib/signal-templates.ts`

### Layer 3: Consumers are thin — they call the template engine and slice
- Every consumer (playbook, brief, campaign, meeting prep, email outreach) calls `templateAll(signals, team, { format })`.
- Consumers declare which section groups they need and any filters (product, attendee role).
- No consumer builds its own Gemini prompt from raw signals.

## Section Groups

| Group | Gemini? | Sections |
|-------|---------|----------|
| `customer-core` | No | Product Alignment, Cloud & Marketplace, Tech Stack, Cases, Renewals & Pipeline, Competitive Landscape, Company & Industry Intelligence, Email Intelligence |
| `people` | No | Key Relationships, Attendee Profiles, Partner Ecosystem, Outreach History, Partner Ecosystem Solutions, Specialized Partners |
| `narrative` | Yes | Strategic Position, Current Priorities, SWOT, MEDDPICC, Expansion Opportunities |
| `activity` | No | Engagement History, Action Items |
| `reference` | No | Product Lifecycle, Events, Industry News |
| `sales-enablement` | No | Sales Plays & Tactics |

## Consumer → Group Mapping

All consumers receive the expanded section groups automatically via `templateAll()`. No consumer changes required when new sections are added.

| Consumer | Groups | Filter |
|----------|--------|--------|
| Playbook | all (including `sales-enablement`) | None — full output |
| Brief | `customer-core` (condensed) + `narrative` (strategic only) | Top signals only |
| Campaign | `customer-core` (product-filtered) | Signals matching campaign product |
| Meeting Prep | `customer-core` + `narrative` (priorities) + `sales-enablement` | Filtered to attendee roles |
| Email Outreach | `customer-core` (condensed) | Product + cloud spend for customer |

## Pre-flight Questions for Every New Feature (MANDATORY)

Answer these before writing code. If you can't answer them, you're not ready to build.

1. **Is this a producer, consumer, or both?** Producer → implement `signals()` with `rawRelevance` + metadata. Consumer → call `templateAll()`.
2. **What metadata does this emit?** Map every field to ADR-027 boosters. Missing `customerSlug` = scores as general (low).
3. **Which template section does this data belong in?** Route by metadata keys. If no section fits, define a new one.
4. **Does every consumer that should see this data actually see it?** Trace the signal through template engine to each consumer output. Verify with the debug endpoint: `GET /api/customer/:name/signals/debug`
5. **What happens when this data is missing or stale?** Module health guard should flag it. Admin page should show actionable fix.
6. **Does this module implement `ensureFresh()`?** If it produces signals with a cache, it MUST implement `ensureFresh()` + `cacheTtlMs` so pre-flight refresh covers it automatically. No module should be invisible to the refresh system.
7. **If this is a consumer that generates output, does it call `ensureFresh: true`?** Any consumer that produces user-facing content (campaigns, meeting prep, playbooks, account plans, email outreach) MUST call `loadCustomerSignals(slug, name, { ensureFresh: true })` before generation. This guarantees all signal modules are current before the output is built. Without this, consumers generate from empty or stale data — producing low-quality output that damages trust. No consumer may skip this. The cost (a few seconds of cache checks + selective refresh) is always worth it vs generating from stale signals.
8. **Does this module appear in the admin Data Sources panel?** Every registered module must have: a `refreshEndpoint` (so users can manually refresh), a display name that matches Signal Quality names, and `recordOutcome()` called after every refresh so "Last checked" updates. If a module is invisible to the admin panel, it's invisible to the user — they can't diagnose or fix stale data.
9. **If this module calls Gemini, does it have a quality validator?** (ADR-024) Every module that generates content via Gemini MUST have a quality validator in `src/quality-validators/`. The validator checks the output for completeness, specificity, and structural correctness before caching. Quality scorecard is saved alongside the output. No Gemini-generated content may be cached without validation. Existing validators: `campaign-validator.ts`, `meeting-prep-validator.ts`, `intelligence-validator.ts`, `account-plan-validator.ts`, `playbook-validator.ts`, `tech-stack-validator.ts`. Reference: `docs/adr/ADR-024-gemini-output-quality-gate.md`.
10. **Does this module register with `FeatureModuleRegistry` with all required fields?** (ADR-020) Every feature module MUST implement: `name`, `cachePaths(slug)`, `fetch(customerName)`, `cleanup(customerName)`, `syncNow(customerName)`. Optional but expected: `refreshInterval` (for scheduled execution), `signals(customerSlug)` (if producing signals), `displayName` (for admin UI), `scope` ('customer'|'portfolio'|'both'), `nav` (sidebar entry), `accountTab` (customer detail tab). TypeScript enforces the interface at compile time, but incomplete implementations (empty methods, missing recordOutcome) slip through. Reference: `docs/adr/ADR-020-feature-module-registry.md`.
11. **If this module produces signals, do metadata fields map to ADR-027 scoring boosters?** (ADR-021) Every `signals()` implementation should emit metadata that maps to the scoring system: `customerSlug` (→ customer-tier, floor 0.50), `redHatProducts` (→ +0.10 booster), `confidence` (HIGH → +0.05), `context` (evaluating/migrating → +0.10), `severity` (1 → +0.15, 2 → +0.10), `endDate` within 90 days (→ +0.10), `hasCloudSpend` (→ +0.10), `acvPlus`/`amount` (→ +0.10). Missing `customerSlug` = scores as general (ceiling 0.35 = Noise). Reference: `docs/adr/ADR-021-signal-contract-auto-discovery.md`.
12. **If this module calls Gemini, does it use `callGemini()`?** (ADR-023) Every Gemini API call MUST go through `callGemini()` in `src/gemini-call.ts`. This wrapper provides: retry with backoff (429/503), cost tracking via `recordGeminiUsage()`, timeout tiers (fast/standard/long), input-hash delta caching via `deltaKey`, and model selection. Modules that bypass `callGemini()` lose retry, cost visibility, and timeout management. Exception: `account-intelligence.ts` uses `callGeminiGrounded()` (ADR-023 Phase 2 migration pending). Reference: `docs/adr/ADR-023-gemini-call-standardization.md`.
13. **If this module's signals feed playbook generation, do they support attribution?** (ADR-026) Modules whose signals are consumed by the playbook generator MUST include `sourceNoteId` in signal metadata for provenance tracking. When meeting notes are merged with existing playbook state, the merge prompt receives all contributing signals — each must be attributable. Modules that don't support attribution produce playbook sections that can't trace back to their source. Reference: `docs/adr/ADR-026-customer-engagement-playbook.md`.
14. **Does this module need scheduled execution?** (ADR-028) If a module needs to run on a timer (daily, weekly, interval), it MUST call `SchedulerRegistry.register()` instead of using `setInterval`/`setTimeout` directly. The registry provides: timer lifecycle management, enabled-check-at-fire-time, `primaryOnly` flag (skip on hero installs), status tracking (`lastRun`, `nextRun`, `lastError`), and visibility via `GET /api/admin/scheduler-status`. Reference: `docs/adr/ADR-028-unified-scheduler-registry.md`.
15. **Does this module produce portfolio-level data?** (ADR-029) Modules that emit signals about Red Hat products (not customer-specific data) MUST cross-reference against customer subscriptions/interests using `getCustomerProductContext(customerSlug)`. Without this, portfolio signals score as general tier (ceiling 0.35 = Noise) even when directly relevant to a customer who owns that product. With the cross-reference, matching signals get `customerSlug` set → customer tier (floor 0.50). Reference: `docs/adr/ADR-029-signal-scoring-evolution.md`.
16. **Does this module's signal route to a named template section?** (ADR-035) Every producer module must emit signals with metadata that routes to a specific section in `routeSignal()` — never to 'other'. If the signal doesn't fit an existing section, add a new route and template function before shipping the module. Signals that fall to 'other' are invisible in deterministic output. Reference: `docs/adr/ADR-035-signal-routing-expansion.md`.
17. **Does this module declare `cacheTtlMs` for heartbeat visibility?** (ADR-037) Every module that caches data MUST declare `cacheTtlMs` in its FeatureModuleRegistry registration. The heartbeat staleness monitor uses this to flag expired data in the admin panel. Modules without `cacheTtlMs` are invisible to staleness monitoring — their data can go stale indefinitely without warning. Reference: `docs/adr/ADR-037-post-upgrade-freshness.md`.

## Vocabulary Resolver Rule (MANDATORY)

No hardcoded product, competitor, or technology vocabularies. Every keyword list, product name, competitor name, and technology mapping must be derived from a dynamic source of truth — not authored as a const array in source code. Dynamic sources: `product-vocabulary.ts` (RH product names), `competitive-vocabulary.ts` (competitor tech), `rh-product-catalog.json` (canonical catalog). When a module needs to match product or technology names, it imports from the vocabulary resolver — never maintains its own list.

## Consumer → File Mapping (Compliance-Enforced)

<!-- PARSED BY test/unit/architecture-compliance.test.ts — keep format exact -->

| Consumer | Source File | templateAll | getExpansionMotion | ensureFresh |
|----------|-----------|:-----------:|:------------------:|:-----------:|
| Customer Detail | src/customer.ts | ✅ | — | — |
| Brief Pipeline | src/brief-pipeline.ts | ✅ | — | — |
| Campaign (standard) | src/campaign-service.ts | ✅ | — | ✅ |
| Meeting Prep | src/meeting-prep-service.ts | ✅ | — | ✅ |
| Playbook | src/playbook-generator.ts | ✅ | — | ✅ |
| Account Plan | src/account-plan.ts | ✅ | — | — |
| Morning Summary | src/dashboard-service.ts | ✅ | — | — |
| Value Positioning | src/value-positioning.ts | ✅ | — | — |

## Gemini Callers — Not Consumers (Excluded from templateAll check)

<!-- PARSED BY test/unit/architecture-compliance.test.ts — keep format exact -->

| File | Role | Why excluded |
|------|------|-------------|
| src/account-intelligence.ts | Producer | Extracts company/industry intel from web |
| src/ae-voice.ts | Internal | Generates AE voice profile |
| src/doc-extraction.ts | Producer | Extracts content from documents |
| src/event-enricher.ts | Producer | Enriches events with descriptions |
| src/material-extraction.ts | Producer | Extracts content from sales materials |
| src/modules/cloud-marketplace-module.ts | Producer | Extracts cloud marketplace data |
| src/modules/competitive-intel-module.ts | Producer | Extracts competitive intelligence |
| src/news-provider.ts | Producer | Generates news summaries |
| src/product-intel-service.ts | Producer | Product intelligence extraction |
| src/product-intelligence.ts | Producer | Product intelligence extraction |
| src/customer-product-intel.ts | Producer | Extracts customer-specific product intelligence |
| src/product-release-radar.ts | Producer | Monitors product release updates |
| src/expansion-opportunities.ts | Producer | Identifies expansion opportunities |
| src/domain-waterfall.ts | Producer | Domain waterfall intelligence extraction |
| src/lib/motion-builder.ts | Internal | Builds strategic motion from graph |
| src/lib/motion-campaign-service.ts | Internal | Generates motion-based campaign content |
| src/lib/gemini-tactic-recommender.ts | Internal | Scores and recommends tactics |
| src/lib/meeting-prep-intelligence.ts | Consumer | Generates meeting prep talking points |
| src/lib/initiative-extractor.ts | Producer | Extracts customer initiatives |
| src/product-feature-radar.ts | Producer | Tracks product feature updates |
| src/modules/tech-stack-module.ts | Producer | Extracts customer tech stack |
| src/customer/doc-extractors.ts | Producer | Extracts content from customer documents |

## Consumer → ensureFresh Contract

| Consumer | Must call `ensureFresh: true`? | Current status |
|----------|-------------------------------|----------------|
| Playbook | ✅ Yes | ✅ Implemented |
| Campaign | ✅ Yes | ❌ **MISSING** — uses stale signals |
| Meeting Prep | ✅ Yes | ✅ Implemented (#426) |
| Email Outreach | ✅ Yes | ❌ **MISSING** — uses stale signals |
| Account Brief | ✅ Yes (on-demand generation) | ✅ Implemented (on first view) |
| Account Plan | ✅ Yes | ❌ **MISSING** |

## Consumer Output Quality Rule — Business Objective Tie-back (MANDATORY)

Every consumer output (meeting prep, playbook, campaign, email outreach, account brief) that references a Red Hat product, partner solution, or ecosystem resource MUST tie it to a specific customer business objective. Generic product pitches damage trust. The pattern is:

**Solution → Business Objective → Specific Ask → Linkback**

Example (bad): "Ask about expanding Ansible Automation Platform usage."
Example (good): "Fred Hutch's Overlake expansion requires rapid infrastructure provisioning. The [Cisco + Red Hat network automation solution](catalog-link) with [free interactive labs](lab-link) lets Fred Hutch evaluate automated provisioning without procurement. Ask Mike Thompson: has the network team evaluated this for the Overlake timeline?"

This is enforced by requiring Gemini prompts for all consumers to:
1. Receive customer business objectives as context (from intelligence module)
2. Instruct Gemini to cite a specific business objective for every product/solution reference
3. Include linkback URLs for every referenced asset (solution brief, lab, trial, design guide, case study)

If no business objective is known for the customer, the consumer should flag this as a data gap — not fall back to generic positioning.

## syncNow vs ensureFresh Contract (MANDATORY)

Every registered module implements two refresh methods with distinct purposes:

| Method | Called by | Purpose | Cache behavior |
|--------|-----------|---------|----------------|
| `syncNow(customerName)` | Refresh button, manual API call, admin panel | Re-fetch from source | **Always re-fetches.** Never checks content hash. Never returns early based on cached data. The user clicked Refresh because they want fresh data. |
| `ensureFresh(customerSlug)` | Pre-flight refresh before content generation | Ensure data is current | **Checks TTL first**, then optionally checks content hash. Skips if data is fresh. Optimized for speed — consumers call this before generating output. |

**The rule:** Content hash checks, cache-hit skips, and "unchanged input" shortcuts belong in `ensureFresh()` ONLY. `syncNow()` always goes to source. No exceptions.

**Why this matters:** When a user clicks Refresh in the admin panel or on a module tab, they expect fresh data from source. A silent cache-hit return makes the button feel broken. Content hash optimization is valuable for automated pre-flight refresh (where speed matters and the user isn't watching), but it must never intercept a manual refresh.

## L3 Drive Refresh Contract (MANDATORY for portfolio-scope modules)

Every module that produces portfolio-wide data (not per-customer) MUST support pulling fresh data from Google Drive — not just re-reading a local file baked into the container image.

**Why:** Hero installs bootstrap from a container image that may be days old. The Mac Mini scrapes fresh data and writes to Drive. Without L3 refresh, hero instances serve stale data until a rebuild. The Refresh button should always pull from the live source.

### The contract

| Field | Required | Purpose |
|-------|----------|---------|
| `driveFolderId` | Yes | Shared Drive folder where the Mac Mini writes the source file |
| `driveFileName` | Yes | Filename to download (e.g., `saleshub-knowledge.json`) |
| `localCachePath` | Yes | Where to write the downloaded file locally |
| `syncNow()` | Yes | Downloads fresh file from Drive, replaces local cache, reloads data |
| `ensureFresh()` | Yes | Checks local file mtime vs TTL, downloads from Drive if stale |

### Implementation pattern

```typescript
async syncNow(): Promise<void> {
  // 1. Download from Drive → local cache
  const driveFile = await downloadFromDrive(driveFolderId, driveFileName)
  writeFileSync(localCachePath, driveFile)
  // 2. Reload from fresh local cache
  resetCache()
  const data = loadData()
  recordOutcome({ success: true, recordCount: data.length })
}

async ensureFresh(customerSlug: string): Promise<void> {
  const mtime = statSync(localCachePath).mtimeMs
  if (Date.now() - mtime < cacheTtlMs) return // fresh enough
  await syncNow('') // pull from Drive
}
```

### Modules that need L3 Drive refresh

| Module | Drive file | Status |
|--------|-----------|--------|
| `saleshub-content` | `saleshub-knowledge.json` | ✅ Implemented (#460) — syncNow + ensureFresh download from Drive |
| `saleshub` | `saleshub-knowledge.json` | ✅ Implemented (#442) — syncNow downloads from Drive |
| `cloud-marketplace` | `cloud-marketplace/latest.json` | ✅ Implemented (#703) — ensureFresh reads from Drive, syncNow extracts + uploads to Drive |
| `ecosystem-catalog` | `ecosystem-catalog/*.json` | ❌ **TODO** — reads local cache only |
| `product-intel` | Product corpus files | ✅ Has its own scraper (not Drive-dependent) |

### Bootstrap integration

During bootstrap (Setup Wizard step 1), ALL L3 Drive modules should pull fresh data before the first customer brief is generated. This ensures the hero install has current portfolio intelligence from day one.

## Feature Module Registry Contract (ADR-020)

Every feature module registers with `FeatureModuleRegistry.register()`. The interface:

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | Yes | Unique identifier (e.g., 'tech-stack', 'news-radar') |
| `displayName` | Yes | Human-readable label for admin UI |
| `cachePaths(slug)` | Yes | Returns cache file paths for cleanup |
| `refreshEndpoint` | Yes | API endpoint for manual refresh (admin panel button) |
| `refreshInterval` | No | If set, module is scheduled for automatic catch-up |
| `scope` | No | 'customer' (per-customer data) / 'portfolio' (Red Hat-wide) / 'both' |
| `fetch(customerName)` | Yes | Pull fresh data |
| `cleanup(customerName)` | Yes | Remove data on customer archive |
| `syncNow(customerName)` | Yes | Manual refresh — always re-fetches from source |
| `ensureFresh(customerSlug)` | No | Pre-flight cache check — may skip via TTL/hash |
| `cacheTtlMs` | No | How long cached data is fresh (used by ensureFresh) |
| `signals(customerSlug)` | No | If set, module contributes to the signal stack (ADR-021) |
| `nav` | No | Sidebar entry: `{ group, label, icon }` — auto-discovered by frontend |
| `accountTab` | No | Customer detail tab: `{ label, icon, order }` — auto-discovered |

## Module Navigation Contract (ADR-022)

Modules with `nav` and `accountTab` declarations are auto-discovered by the frontend via `GET /api/feature-modules/nav`. No hardcoded routing.

| Declaration | Effect |
|-------------|--------|
| `nav.group` | Sidebar category ('actions' or 'intelligence') |
| `nav.label` | Human-readable sidebar menu entry |
| `nav.icon` | Lucide icon name for sidebar |
| `accountTab.label` | Tab label on customer detail page |
| `accountTab.order` | Tab sort order (lower = further left) |
| `scope` | Controls visibility: 'portfolio' (no customer picker) / 'customer' (picker required) / 'both' |

## Gemini Call Standardization Contract (ADR-023)

All Gemini API calls MUST go through `callGemini()` in `src/gemini-call.ts`:

| Feature | What callGemini provides |
|---------|-------------------------|
| Retry | Automatic retry with backoff on 429/503 |
| Cost tracking | Records input/output tokens via `recordGeminiUsage()` |
| Timeout tiers | `fast` (30s), `standard` (60s), `long` (180s) |
| Delta caching | `deltaKey` parameter — skips Gemini call if input hash unchanged |
| Model selection | Respects `getGeminiModel()` / `getGeminiModelLite()` |
| Error sanitization | Strips sensitive data from error messages |

Exception: `account-intelligence.ts` uses `callGeminiGrounded()` (Phase 2 migration pending).

## Playbook State Contract (ADR-026)

Playbooks persist at `data/cache/playbooks/{slug}.json` with versioned state:

| Field | Purpose |
|-------|---------|
| `version` | Schema version (currently 1) for future migration |
| `sections` | 8 named sections (strategicPosition, keyRelationships, currentPriorities, productAlignment, openActionItems, engagementHistory, expansionOpportunities, renewalsAndRisk) |
| `deterministic` | Injected post-Gemini: subscriptions, cases, lifecycle, teamMembers, solutionPlays |
| `sources` | Provenance array — which meeting notes/signals contributed to each section |

Modules contributing to playbook generation MUST support `sourceNoteId` attribution in signal metadata. When Gemini merges old playbook state with new meeting notes, all contributing signals are included — each must be traceable.

## Scheduler Registry Contract (ADR-028)

Every scheduled task MUST call `SchedulerRegistry.register()` instead of creating its own timers:

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | Yes | Unique task identifier |
| `schedule.type` | Yes | 'daily' (hour+minute ET), 'weekly' (day+hour+minute), 'interval' (ms), 'heartbeat' (on 15-min tick) |
| `run` | Yes | Async callback — the work to execute |
| `enabled` | Yes | Function re-checked at fire time — skip if returns false |
| `primaryOnly` | No | If true, skip on hero installs (only Mac Mini primary node runs it) |

The registry owns timer lifecycle, status tracking (`lastRun`, `nextRun`, `lastError`), and visibility via `GET /api/admin/scheduler-status`.

## Portfolio Signal Relevance Contract (ADR-029)

Portfolio-level modules (product lifecycle, RSS, events, value maps) MUST cross-reference customer data before emitting signals. Call `getCustomerProductContext(customerSlug)` in `signals()`:

| Match type | Action | Scoring effect |
|------------|--------|---------------|
| Subscription match | Set `metadata.customerSlug` + `matchType: 'subscription'` | Customer tier (floor 0.50) |
| Interest match | Set `metadata.customerSlug` + `context: 'evaluating'` | Customer tier + evaluating booster (+0.10) |
| No match | Omit `customerSlug` | General tier (ceiling 0.35 = Noise) |

Without this, a "RHEL 9.5 EOL" signal scores as Noise even for customers with 500 RHEL subscriptions.

## Solution Intelligence Contract (ADR-030)

Modules that produce cross-referenced intelligence MUST call `getCustomerSolutionContext(customerSlug)`:

| Output field | Source | Template routing |
|-------------|--------|-----------------|
| `activeSolutionPlays[]` | Tech stack × solution-plays.json | Strategic Opportunities section |
| `marketplaceOpportunities[]` | Cloud spend × marketplace programs | Cloud & Marketplace section |
| `versionCorrelations[]` | Cases × product lifecycle | Cases section (amplified) |
| `crossSellSignals[]` | Pipeline × tech stack × ecosystem catalog | Expansion Opportunities narrative |

Modules add to signal metadata: `solutionPlayId`, `solutionPlayName`, `solutionTdp`, `matchedTechnologies`, `privateOfferEligible` (→ +0.10 booster), `cloudAmplifier`.

## Template Engine Unification Contract (ADR-031)

Every consumer MUST call `templateAll(signals, team, options)` as the single data path:

| Output field | Use for |
|-------------|---------|
| `deterministic` | Markdown document body (playbook, account plan) |
| `narrativeContext` | Gemini prompt input (narrative sections only) |
| `sections.{name}` | Individual section access (string or null) |
| `structured.solutionPlays` | React/HTML component rendering |

Consumers select which section groups they need via options. They MUST NOT:
- Call individual template functions (`templateSalesAlignment()`, `templateStrategicOpportunities()`)
- Import `getCustomerSolutionContext()` directly
- Assemble their own signal context from registry signals

## Anti-patterns

- ❌ Hardcoding `score` in a module — the registry scores, not the module
- ❌ Adding signal type to a Gemini prompt instruction — template it, don't prompt-engineer it
- ❌ Building a consumer that assembles its own signal context — use `templateAll()`
- ❌ Creating a feature without answering the 16 pre-flight questions
- ❌ Shipping without checking the signal debug endpoint for the new data
- ❌ Building a module with cached data but no `ensureFresh()` — consumers will generate with stale/missing data
- ❌ Hardcoding refresh sources in signal-loader — use the registry auto-discovery pattern
- ❌ Consumer calling `loadCustomerSignals()` WITHOUT `{ ensureFresh: true }` before generating output — produces content from stale/empty data
- ❌ Registering a module without `refreshEndpoint` — invisible in admin panel, users can't diagnose or fix
- ❌ Refresh endpoint that doesn't call `recordOutcome()` — "Last checked" never updates, appears broken
- ❌ Content hash check in `syncNow()` — hash checks belong in `ensureFresh()` only. `syncNow()` always re-fetches from source.
- ❌ Caching Gemini output without a quality validator (ADR-024) — every Gemini-generated output must be validated before caching. No validator = no quality visibility = silent degradation.
- ❌ Calling Gemini directly instead of through `callGemini()` (ADR-023) — bypasses retry, cost tracking, timeout tiers, and delta caching.
- ❌ Using `setInterval`/`setTimeout` for scheduled work instead of `SchedulerRegistry.register()` (ADR-028) — hides schedule visibility, duplicates timer boilerplate, no `primaryOnly` gating.
- ❌ Portfolio-level signals without `customerSlug` cross-reference (ADR-029) — they score as general (ceiling 0.35 = Noise) even when directly relevant to customers who own the product.
- ❌ Consumers calling individual template functions (`templateSalesAlignment()`, etc.) instead of `templateAll()` (ADR-031) — bypasses the single data path, produces inconsistent coverage across consumers.
- ❌ Soft-deleting customers with `inactive: true` flag instead of binary active/archived model (ADR-018) — accumulates stale data, confuses cleanup logic, inflates metrics.
- ❌ Reading L3 CSV data via static sheet IDs instead of `discoverL3Csv()` (ADR-019) — becomes stale when source files change, skips change detection, breaks on sheet re-creation.
- ❌ Hardcoding product, competitor, or technology vocabularies as const arrays (ADR-035) — use vocabulary resolvers (`product-vocabulary.ts`, `competitive-vocabulary.ts`, `rh-product-catalog.json`). Hardcoded lists drift from source of truth, miss new products/competitors, and require code changes instead of data updates.
- ❌ Shipping a producer module whose signals fall to 'other' in `routeSignal()` (ADR-035) — invisible in deterministic output. Every signal must route to a named section. Architecture compliance test enforces this.
- ❌ Caching empty extraction results as "fresh" (ADR-037) — when Gemini extraction returns 0 items (timeout, API error, org policy block), do NOT write `technologies: []` or `clouds: []` to cache with a valid `cachedAt` timestamp. Empty results with valid timestamps look "fresh" to `ensureFresh()`, preventing re-extraction indefinitely. Either skip the write entirely, or mark the cache as `status: 'error'` so the next ensureFresh retries.
- ❌ Registering a module without `cacheTtlMs` (ADR-037) — invisible to heartbeat staleness monitoring. Data can go stale for weeks without any admin panel indicator. Every cached module MUST declare its TTL.

## ADR → PRINCIPLES.md Enforcement (MANDATORY)

Every ADR that creates a mandatory requirement MUST have a corresponding update in this file. ADRs are decisions; PRINCIPLES.md is enforcement. An ADR without a pre-flight question or anti-pattern entry is a rule nobody checks.

**When creating or updating an ADR, answer these:**

1. **Does this ADR create a mandatory requirement for modules?** If yes → add a pre-flight question above.
2. **Does this ADR define something modules must NOT do?** If yes → add to the Anti-patterns list above.
3. **Does this ADR define a new contract between components?** If yes → add a contract section (like syncNow/ensureFresh, L3 Drive Refresh) above.

**ADR template — mandatory sections:**

Every ADR in `docs/adr/` must include these sections:
- `## Status` — Proposed | Accepted | Deprecated
- `## Context` — why this decision is needed
- `## Decision` — what was decided
- `## Consequences` — positive, negative, risks
- `## PRINCIPLES.md Update` — **NEW (mandatory)**: state which pre-flight question, anti-pattern, or contract section was added/updated. If none needed, explicitly state "No PRINCIPLES.md update required — this ADR does not create mandatory module requirements." This section prevents drift between decisions and enforcement.

**Automated enforcement:** `test/unit/architecture-compliance.test.ts` includes 4 drift detection tests that run on every `bun test`. If a new ADR creates mandatory requirements without updating this file, the build fails. This is the final safety net — convention + test + cross-reference index.

**Cross-reference index — ADRs that created pre-flight questions:**

| Pre-flight # | ADR | Question |
|---|---|---|
| 1-3 | ADR-027 | Signal scoring: rawRelevance, metadata, template routing |
| 4 | ADR-021 | Signal auto-discovery: consumer visibility |
| 5-6 | ADR-020, #328 | Module registration: ensureFresh, cacheTtlMs |
| 7 | ADR-021 | Consumer ensureFresh contract |
| 8 | ADR-020 | Admin panel visibility: refreshEndpoint, recordOutcome |
| 9 | ADR-024 | Quality validator for Gemini output |
| 10 | ADR-020 | Full FeatureModule contract registration |
| 11 | ADR-021, ADR-027 | Signal metadata maps to scoring boosters |
| 12 | ADR-023 | Use callGemini() wrapper for all Gemini calls |
| 13 | ADR-026 | Playbook signal attribution + merge support |
| 14 | ADR-028 | Use SchedulerRegistry for scheduled work |
| 15 | ADR-029 | Portfolio modules cross-ref customer context |
| 16 | ADR-035 | Signal routing: every module routes to a named section |
| 17 | ADR-037 | cacheTtlMs for heartbeat visibility + no empty cache as fresh |

## Signal Scoring Quick Reference (ADR-027)

| Tier | Range | Meaning |
|------|-------|---------|
| Critical | 0.90-1.00 | Revenue impact, urgent action |
| High | 0.70-0.89 | Directly actionable in conversation |
| Medium | 0.50-0.69 | Useful context |
| Low | 0.35-0.49 | Background awareness |
| Noise | 0.00-0.34 | Filtered from content generation |

Specificity enforcement:
- `customer` signals: floor 0.50, ceiling 1.00
- `industry` signals: floor 0.35, ceiling 0.69
- `general` signals: floor 0.10, ceiling 0.35

Boosters (from metadata): redHatProducts (+0.10), acvPlus/amount (+0.10), HIGH confidence (+0.05), evaluating/migrating context (+0.10), severity 1 (+0.15) / severity 2 (+0.10), endDate within 90 days (+0.10), hasCloudSpend (+0.10).
