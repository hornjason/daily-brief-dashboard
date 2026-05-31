---
doc-type: architecture
status: active
owner: jason
updated: 2026-05-20
---

# Design Principles — Deep Module Architecture

## Mission & Vision

**This system exists to open opportunities, close bigger deals, and make customers successful** — by pulling together every signal Red Hat has about a customer and connecting it to actionable solutions, programs, and plays.

Red Hat has signals scattered everywhere — cases, subscriptions, cloud spend, pipeline, tech stack, partner ecosystems, sales plays, marketplace programs — and nobody is pulling them together intelligently to drive action for customers. This system does that.

**Every design decision must answer:** "Does this help surface what Red Hat can do for a specific customer based on their signals?" If it doesn't connect signals to actions, it's not serving the goal.

**Three capabilities this system must deliver:**
1. **Cross-reference engine** — Given a customer's signals, surface matching solutions from ecosystem catalog, marketplace programs, saleshub plays, partner demos, free trials, and interactive labs.
2. **AI-driven recommendation** — Signal-to-action mapping is inferred by AI from the full signal profile + solution portfolio. Not manually curated.
3. **Accumulation over time** — Historical signals compound. Trajectories matter. Nothing is lost on regeneration.

**This system scales with its data.** More signals, more history, more intelligence. Every module, contract, and consumer should be designed to grow with the product.

---

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
| `customer-core` | No | Product Alignment, Cloud & Marketplace, Tech Stack, Cases, Renewals & Pipeline |
| `people` | No | Key Relationships, Attendee Profiles, Partner Ecosystem, Outreach History |
| `narrative` | Yes | Strategic Position, Current Priorities, SWOT, MEDDPICC, Expansion Opportunities |
| `activity` | No | Engagement History, Action Items |
| `reference` | No | Product Lifecycle, Events, Industry News |

## Consumer → Group Mapping

| Consumer | Groups | Filter |
|----------|--------|--------|
| Playbook | all | None — full output |
| Brief | `customer-core` (condensed) + `narrative` (strategic only) | Top signals only |
| Campaign | `customer-core` (product-filtered) | Signals matching campaign product |
| Meeting Prep | `customer-core` + `narrative` (priorities) | Filtered to attendee roles |
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
9. **Does every signal carry a source URL?** (#479) Every signal that references a source document, case, opportunity, partner solution, or article MUST populate the `url` field with a clickable link to the source. Intelligence without traceability is noise — users need one-click drill-down from recommendations to full details.
10. **Is this module ingesting ALL available data from its source?** (#478) If a module reads from a cache file or API, it must emit signals for the complete dataset, not a truncated subset. Content caps for Gemini prompts are the Gemini call's concern — the signal itself must carry the full record. Budget caps in the registry control what consumers see; modules must not pre-truncate their signal output.
11. **Does this callGemini() use the default model tier?** (#472) Never hardcode `model: 'lite'` or `model: 'full'` in callGemini options. Use the project default (set in ai-config.ts). Hardcoded tiers create invisible tech debt that persists across model migrations. Enforced by `test/unit/architecture-compliance.test.ts`.
12. **If this module cross-references other modules' signals, does it use `collectAllSignalsUnbudgeted()`?** (#482, ADR-032) Cross-referencing modules need the full signal set to avoid missing corroborating signals that were budget-capped out. Only `collectAllSignalsUnbudgeted()` provides the complete picture. Using `collectAllSignals()` for cross-referencing produces incomplete recommendations.

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

## Gemini Gateway Contract (MANDATORY — C7)

All Gemini calls MUST go through `callGemini()` from `src/gemini-call.ts`. No direct URL construction, no hardcoded model names, no inline `thinkingConfig` or `temperature`. The gateway handles:

- **Model resolution** — `'lite'` / `'full'` / `'pro'` → actual model ID from `ai-config.ts`
- **Endpoint routing** — Gemini 3.x → US multi-region (`aiplatform.us.rep.googleapis.com`), 2.x → regional
- **Thinking config** — 3.x: `thinkingLevel: 'minimal'`, 2.x: `thinkingBudget: 0` for Flash
- **Temperature gating** — 3.x models do not accept temperature/top_p/top_k
- **Output token budget** — 3.x: 16384 (thinking tokens consume budget), 2.x: model default
- **Cost tracking, delta caching, retry logic** — centralized, not duplicated per consumer

**Why:** When migrating from gemini-2.5-flash-lite to gemini-3.5-flash, only modules using `callGemini()` worked. The 10 modules with direct Vertex AI calls all hit 404 errors and required individual patching. Every future model migration has the same risk. One gateway, zero direct calls.

**Violation indicator:** `grep -rn 'aiplatform.googleapis.com' src/ | grep -v gemini-call.ts` — any matches are violations.

## Gemini Output Quality Gate Contract (MANDATORY — ADR-024)

Every module that calls Gemini for content extraction or generation MUST wrap the output with `validateAndRetry()` from `src/gemini-quality-gate.ts`. No exceptions — this was a hard-learned rule after cloud marketplace shipped extraction without validation and produced empty/degraded cache that replaced good data.

### The contract

1. **Create a validator** in `src/quality-validators/{module}-validator.ts` implementing `QualityValidator`
2. **Define checks** specific to the content type (minimum item counts, required fields populated, structural completeness)
3. **Wire `validateAndRetry()`** around the Gemini call in `syncNow()`
4. **Stale-overwrite guard** — if validated output scores lower than existing cache, keep existing cache
5. **Scorecard persistence** — save `.qualityScorecard` alongside the cached output

### Minimum checks for extraction modules (like cloud-marketplace, competitive-intel, tech-stack)

- Minimum record count (e.g., >= 3 cloud providers, >= 5 total offerings)
- Required fields populated (not empty strings)
- Output not smaller than existing cache without explanation
- No duplicate/repeated entries

### Anti-patterns

- ❌ Calling Gemini for extraction without `validateAndRetry()` — produces silent quality degradation
- ❌ Caching empty/degraded extraction output without comparing to existing cache — overwrites good data with bad
- ❌ Relying solely on `responseSchema` for quality — schema enforces structure, not content completeness

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

**Why:** Hero installs bootstrap from a container image that may be days old. The producing instance (Mac Mini for saleshub, hero install for cloud-marketplace) scrapes fresh data and writes to Drive. Without L3 refresh, other instances serve stale data until a rebuild. The Refresh button should always pull from the live source.

### The contract

| Field | Required | Purpose |
|-------|----------|---------|
| `driveFolderId` | Yes | Shared Drive folder where the producing instance writes the source file |
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
| `cloud-marketplace` | `cloud-marketplace/latest.json` | ✅ Implemented (#462) — syncNow + ensureFresh download from Drive |
| `ecosystem-catalog` | `ecosystem-catalog/*.json` | ✅ Implemented (#462) — syncNow + ensureFresh download from Drive |
| `product-intel` | Product corpus files | ✅ Has its own scraper (not Drive-dependent) |

### Bootstrap integration

During bootstrap (Setup Wizard step 1), ALL L3 Drive modules should pull fresh data before the first customer brief is generated. This ensures the hero install has current portfolio intelligence from day one.

## Anti-patterns

- ❌ Hardcoding `score` in a module — the registry scores, not the module
- ❌ Adding signal type to a Gemini prompt instruction — template it, don't prompt-engineer it
- ❌ Building a consumer that assembles its own signal context — use `templateAll()`
- ❌ Creating a feature without answering the 5 pre-flight questions
- ❌ Shipping without checking the signal debug endpoint for the new data
- ❌ Building a module with cached data but no `ensureFresh()` — consumers will generate with stale/missing data
- ❌ Hardcoding refresh sources in signal-loader — use the registry auto-discovery pattern
- ❌ Consumer calling `loadCustomerSignals()` WITHOUT `{ ensureFresh: true }` before generating output — produces content from stale/empty data
- ❌ Registering a module without `refreshEndpoint` — invisible in admin panel, users can't diagnose or fix
- ❌ Refresh endpoint that doesn't call `recordOutcome()` — "Last checked" never updates, appears broken
- ❌ Content hash check in `syncNow()` — hash checks belong in `ensureFresh()` only. `syncNow()` always re-fetches from source.
- ❌ Truncating source data inside a module before emitting signals — content caps for Gemini prompts are the Gemini call's concern, not the signal's. Budget caps in the registry handle consumer-side limits. (#478)
- ❌ Hardcoding `model: 'lite'` or `model: 'full'` in callGemini() — use project defaults from ai-config.ts. Only `model: 'pro'` is an allowed override, and only when justified. (#472)
- ❌ Emitting signals without a `url` field — every signal must be traceable to its source for one-click drill-down. (#479)
- ❌ Using wrong field names when reading cache data — verify field names against actual cache structure (e.g., `productDescription` not `productName`). (#473)
- ❌ Using `collectAllSignals()` (budgeted) for cross-referencing logic — budget caps may remove signals that are corroborating inputs to a recommendation. Use `collectAllSignalsUnbudgeted()` for cross-reference computation; let the registry budget-cap the recommendation module's output. (#482, ADR-032)

## Cross-Referencing Module Contract (MANDATORY — ADR-032)

Any module that reads OTHER modules' signals to produce composite outputs (recommendations, correlations, intelligence graphs) MUST:

1. Use `collectAllSignalsUnbudgeted()` — never the budgeted variant
2. Register as a feature module (not a standalone utility) — so its output is budget-capped, debuggable, and visible in admin
3. Set `rawRelevance` based on composite confidence (signal corroboration count + freshness + specificity) — never hardcode `score`
4. Use Gemini only for narrative synthesis (`narrative` field), never for decision logic (which signals match which solutions)
5. Cap its own output via registry budget (recommended: 5 per customer for composite recommendations)

The query helper's outputs flow through `templateAll()` like any other signal. Consumers never call the query helper directly.

## Enforcement: architecture-compliance.test.ts

**Every rule in this file is enforced by `test/unit/architecture-compliance.test.ts`.** This test runs on every `bun test` (Gate 1, pre-push). Failing tests block push. The test auto-discovers modules from the registry and filesystem — no hardcoded lists.

What it enforces:
- ADR-027: no hardcoded scores in modules (must use rawRelevance)
- Module contract: ensureFresh, cacheTtlMs, refreshEndpoint, displayName
- Consumer contract: must use templateAll(), must call ensureFresh=true
- Service extraction: route files thin, services have zero Hono imports
- ADR↔PRINCIPLES drift: new ADRs with mandatory requirements must update this file
- Pre-flight question count: cannot drop below current count
- Contract section integrity: all named sections must exist

**When adding a new contract or pre-flight question:** add the enforcement check to architecture-compliance.test.ts in the same PR. A contract without a test is a suggestion, not a rule.

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
