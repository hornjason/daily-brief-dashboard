---
doc-type: adr
status: active
owner: jason
updated: 2026-05-30
---

# ADR-032: Intelligence Substrate — Cross-Referencing Query Helper

**Date:** 2026-05-30
**References:** ADR-030 (Solution Intelligence Engine), ADR-027 (Universal Signal Scoring), ADR-020 (Feature Module Registry), #482 (cross-referencing query helper), #382 (Intelligence Graph epic)
**Deciders:** Serena Blackwood (architecture), Rayford (DA)

## Status

Active

### Amendments

- **2026-06-24 (#888):** Promoted recommended-actions as primary intelligence output on expansion motion.
  - `collectAllSignalsUnbudgeted` and `getRecommendations` already implemented in `signal-loader.ts` / `signal-query.ts`.
  - `nodeMatchesTdp` / `normalizeTdp` used by motion builder for TDP matching.
  - `signalAudience: 'customer-specific'` corrected on module registration.
  - `UNIFIED_INTELLIGENCE` feature flag gates population of `unstructuredRecommendations` on `StrategicMotion`.
  - Recommended actions rendered as "Additional Intelligence" section in expansion motion UI.

## Context

### What exists today

ADR-030 (Solution Intelligence Engine) shipped three cross-reference dimensions:
1. Tech x Solution plays — detected technologies trigger structured plays with value props
2. Cloud spend x Marketplace programs — CCSP data identifies eligible programs and private offers
3. Subscriptions x Cases x Lifecycle — version correlations surface upgrade urgency

These produce enriched signals that flow through the template engine to consumers. 29 modules now produce 2,377 signals across 23 customers. `collectAllSignals()` returns a flat scored array. All consumers filter with `.filter()`.

### What is missing

ADR-030 cross-references **individual data dimensions** (tech x plays, spend x programs). What is missing is the **composite cross-referencing** that queries the full solution portfolio against a customer's complete signal profile and returns ranked recommended actions. Issue #482 describes this as "the cross-referencing brain."

The gap: a customer has VMware in their tech stack (from tech-stack-module), an expiring RHEL subscription (from subscriptions-module), a Sev2 case about VM performance (from cases-module), and $200K Azure spend (from CCSP). Today, these produce four independent signals. What should happen: a single recommended action — "OCP-Virt migration play — customer has VMware, expiring RHEL, VM performance issues, and $200K Azure spend that could fund the migration through ARO" — with links to the play assets, partner solutions, and labs.

### The fundamental constraint

This system is single-user, single-container, localhost-only. 23 customers, ~100 signals per customer after budget caps. The data fits entirely in memory. The question is not "how do we build a query engine that scales to millions of signals" — it is "how do we compose a 150-line function that reads existing caches and returns ranked actions."

### Hard constraints from PRINCIPLES.md

1. **Layer 1 producer.** The query helper produces `RecommendedAction[]` — these are facts about which solutions match which signals. This is Layer 1 work.
2. **No Gemini for decision logic.** The cross-referencing is deterministic. Gemini is used only for the narrative "why this, why now" sentence per recommendation.
3. **Budget caps in registry, not in modules.** The query helper must not pre-filter signals. It needs the full signal set.
4. **JSON files are canonical source of truth.** No new persistence layer.
5. **Template engine routes output.** Consumers never call the query helper directly.

## Decision

### 1. RecommendedAction Interface

```typescript
interface RecommendedAction {
  /** Composite narrative: "Acme has VMware + expiring RHEL → OCP-Virt migration play" */
  action: string
  /** Confidence based on signal corroboration count + freshness + specificity */
  confidence: 'high' | 'medium' | 'emerging'
  /** The signals that triggered this recommendation (2+ = high confidence) */
  triggerSignals: Signal[]
  /** The matched solution from the portfolio */
  solution: {
    name: string
    type: 'play' | 'partner' | 'program' | 'product' | 'incentive'
    /** Link to solution brief, catalog entry, or program page */
    url?: string
    /** Links to associated assets — decks, labs, case studies, design guides */
    assets?: Array<{
      name: string
      url: string
      type: 'deck' | 'lab' | 'case-study' | 'design-guide' | 'demo' | 'video' | 'documentation'
    }>
  }
  /** One-click actions for the consumer UI */
  actions: string[]
  /** Gemini-generated "why this, why now" — populated lazily, may be absent */
  narrative?: string
}
```

**Changes from the proposed shape in #482:**
- `solution.assets` is typed as `Array<{ name, url, type }>` instead of `string[]`. Assets need structured metadata so consumers can render appropriate icons and labels. The ecosystem catalog module already has typed resources (`solution-brief`, `case-study`, `design-guide`, `lab`, `video`, `documentation`) — reuse those types.
- `narrative` field added (optional). This is the Gemini-generated "why this, why now" sentence. Optional because it is populated lazily (see Decision 5).
- `actions` remains `string[]` as proposed. These are display labels for UI buttons — "Draft email", "Prep meeting", "View play deck". The consumer maps them to routes.

### 2. Layer Placement — Registered Feature Module

The query helper is a **registered feature module** in the Feature Module Registry, not a standalone utility.

**Module name:** `recommended-actions`
**Scope:** `customer`
**Signal type:** `recommendation`

```typescript
FeatureModuleRegistry.register({
  name: 'recommended-actions',
  displayName: 'Recommended Actions',
  scope: 'customer',
  // No refreshInterval — derived from other modules' signals
  // No ensureFresh — relies on upstream modules' ensureFresh()
  // No cachePaths — pure computation (5-min result cache, in-memory only)
  
  async signals(customerSlug: string): Promise<Signal[]> {
    const actions = queryRecommendedActions(customerSlug)
    return actions.map(ra => ({
      source: 'recommended-actions',
      type: 'recommendation',
      headline: ra.action,
      detail: ra.narrative ?? ra.solution.name,
      rawRelevance: ra.confidence === 'high' ? 0.95
                  : ra.confidence === 'medium' ? 0.75
                  : 0.55,
      timestamp: new Date().toISOString(),
      url: ra.solution.url,
      metadata: {
        customerSlug,
        solutionType: ra.solution.type,
        solutionName: ra.solution.name,
        triggerSignalCount: ra.triggerSignals.length,
        confidence: ra.confidence.toUpperCase(),
        redHatProducts: extractProducts(ra),
        actions: ra.actions,
        assets: ra.solution.assets,
      },
    }))
  },
  
  async fetch() {},
  async cleanup() {},
  async syncNow() {},
})
```

**Why a registered module (not a standalone utility):**
- Auto-discovered by `collectAllSignals()` — consumers get recommendations without code changes
- Budget-capped by the registry (cap: 5 per customer — recommendations are high-signal, low-volume)
- Visible in admin Data Sources panel
- Participates in compliance checks (architecture-compliance.test.ts)
- Debug endpoint (`/api/customer/:name/signals/debug`) shows recommendations alongside other signals

**Why NOT extending `solution-intelligence-module`:**
- ADR-030's module produces signals about individual cross-references (one play, one marketplace opportunity, one version correlation)
- This module produces composite recommendations that may span multiple ADR-030 outputs
- Separate modules = separate budget caps, separate debug visibility, separate admin panel entries
- ADR-030 is an input to this module, not the same concern

### 3. Budget Cap Exception — Pre-Budget-Cap Signal Access

**The problem:** `collectAllSignals()` applies per-source budget caps. The query helper needs ALL customer signals for comprehensive cross-referencing — a capped signal set could miss a tech-stack signal that, combined with a capped-out case signal, forms a high-confidence recommendation.

**The solution:** Two-phase signal collection in `signal-loader.ts`.

```typescript
// New export in signal-loader.ts
export async function collectAllSignalsUnbudgeted(
  customerSlug: string
): Promise<Signal[]> {
  // Same as collectAllSignals() but skips the budget-cap step
  // Returns ALL scored signals from ALL modules
}
```

**How the query helper uses it:**

```typescript
// src/lib/signal-query.ts
export function queryRecommendedActions(customerSlug: string): RecommendedAction[] {
  // Step 1: Get ALL signals (no budget caps)
  const allSignals = collectAllSignalsUnbudgeted(customerSlug)
  
  // Step 2: Cross-reference against solution portfolio
  const recommendations = crossReference(allSignals, portfolio)
  
  // Step 3: Rank by composite confidence
  return rankAndCap(recommendations, MAX_RECOMMENDATIONS)
}
```

**Why this is safe:**
- `collectAllSignalsUnbudgeted()` is used ONLY by the query helper — it is not exported to consumers
- The query helper's own output goes through `signals()` on the module → registry scores → budget cap (5 per customer) → consumers
- The unbounded set is read-only, in-memory, and scoped to one customer at a time
- At 23 customers and ~100 signals per customer (uncapped), the full set is ~2,300 signals total — trivially fits in memory

**What does NOT change:** `collectAllSignals()` continues to apply budget caps for all other consumers. The `recommended-actions` module is the only caller of the unbounded variant.

### 4. Phase 2 Trigger Thresholds for SignalIndex

The council was unanimous: an inverted index (SignalIndex) is premature at current volumes. Flat scan over `collectAllSignalsUnbudgeted()` is sufficient. Document the thresholds that trigger a move to indexed access.

**Measurement thresholds — all three must be exceeded simultaneously:**

| Metric | Threshold | How to measure | Current value |
|--------|-----------|----------------|---------------|
| Cold-start time for `queryRecommendedActions()` | > 2 seconds | `console.time()` around the full function | ~50ms estimated (flat scan over ~100 signals) |
| Total signal count across all customers | > 50,000 | `collectAllSignalsUnbudgeted()` length summed across all customers | ~2,300 |
| Process RSS memory attributed to signal caches | > 200MB | `process.memoryUsage().rss` delta before/after signal load | ~15MB estimated |

**When thresholds are exceeded (all three simultaneously):**
1. File a new issue referencing #382 (Intelligence Graph epic)
2. Design SignalIndex with inverted indexes on: `metadata.customerSlug`, `metadata.redHatProducts[]`, `signal.type`, `metadata.solutionPlayId`
3. The index is a read-through cache — `collectAllSignalsUnbudgeted()` remains the source of truth
4. Consumers of SignalIndex use a query API: `signalIndex.query({ customer, products, types })` instead of `.filter()`

**Monitoring:** Add the three metrics to the existing `/api/admin/scheduler-status` response as `signalSubstrate: { coldStartMs, totalSignals, signalMemoryMb }`. This makes the thresholds observable from the admin panel without new infrastructure.

### 5. Gemini Narrative — Lazy Generation with Cache

**Decision:** Generate the "why this, why now" narrative **lazily on first consumer access**, not at recommendation computation time.

**Rationale:**
- `queryRecommendedActions()` is called during `signals()` on every `collectAllSignals()` invocation. Adding a Gemini call per recommendation per customer would make signal collection slow and expensive.
- Recommendations change when underlying signals change (tech stack refreshes, new case filed, subscription expires). Pre-generating narratives that immediately become stale wastes Gemini calls.
- Consumers that need the narrative (Morning Summary, Customer Detail) can request it on demand. Consumers that don't need it (signal debug, admin panel) skip the cost entirely.

**Implementation:**

```typescript
// src/lib/recommendation-narrative.ts

const NARRATIVE_CACHE = new Map<string, { text: string; generatedAt: number }>()
const NARRATIVE_TTL_MS = 4 * 60 * 60 * 1000 // 4 hours, matches brief cache TTL

export async function getRecommendationNarrative(
  recommendation: RecommendedAction,
  customerName: string
): Promise<string> {
  const key = `${customerName}:${recommendation.solution.name}`
  const cached = NARRATIVE_CACHE.get(key)
  if (cached && Date.now() - cached.generatedAt < NARRATIVE_TTL_MS) {
    return cached.text
  }
  
  const narrative = await callGemini({
    prompt: buildNarrativePrompt(recommendation, customerName),
    // Uses project default model tier (no hardcoded 'lite' or 'full')
  })
  
  NARRATIVE_CACHE.set(key, { text: narrative, generatedAt: Date.now() })
  return narrative
}
```

**Where narratives are injected:**
- **Morning Summary** — top 3 recommendations per customer get narratives, injected into the synthesis prompt
- **Customer Detail page** — recommendations rendered in the Strategic Opportunities template section, narratives loaded on expand/click
- **Playbook generator** — recommendations included in the narrative context for Gemini

**Where narratives are NOT injected:**
- Signal debug endpoint — raw recommendation data only
- Admin panel — counts and confidence levels only
- `collectAllSignals()` — signals carry `narrative: undefined`, populated on demand

### 6. Cross-Reference Algorithm

`src/lib/signal-query.ts` — the core function.

**Input:** All customer signals (unbounded) + solution portfolio (solution-plays.json, ecosystem-catalog cache, cloud-marketplace cache, saleshub-knowledge.json)

**Algorithm:**

```
Step 1: Bucket signals by type
  tech-stack → techSignals[]
  subscription → subSignals[]
  case → caseSignals[]
  cloud-spend → cloudSignals[]
  pipeline → pipelineSignals[]
  
Step 2: Cross-reference each bucket against the portfolio
  For each techSignal:
    Match triggerTechnologies in solution-plays.json → SolutionPlay
    Match platform in ecosystem-catalog cache → PartnerSolution[]
    Match TDP in saleshub-knowledge.json → SalesHubTactic[]
    
  For each subSignal:
    Match product against product-lifecycle.json → LifecycleEvent
    Match product against product-intel cache → NewFeature[]
    
  For each caseSignal:
    Extract technology mentions → re-check against solution-plays.json
    
  For each cloudSignal:
    Match provider against cloud-marketplace programs → Program[]
    Match against saleshub cloud-specific plays → SalesPlay[]

Step 3: Merge corroborating signals into composite recommendations
  Group by solution play / partner solution / program
  A recommendation requires 2+ trigger signals (corroboration threshold)
  Single-signal matches are demoted to 'emerging' confidence
  
Step 4: Score composite confidence
  confidence = f(triggerCount, avgFreshness, avgSpecificity)
  'high'     = 3+ triggers, all < 30 days old, all customer-specific
  'medium'   = 2+ triggers, mixed freshness/specificity
  'emerging' = 1 trigger, or all triggers > 90 days old

Step 5: Rank and cap
  Sort by confidence (high > medium > emerging), then by trigger count
  Cap at MAX_RECOMMENDATIONS (10 per customer, budget-capped to 5 by registry)
```

**Performance note:** Steps 1-5 are pure synchronous computation over in-memory arrays. No async, no I/O, no Gemini. The 5-minute result cache (in-memory Map keyed by customerSlug) prevents redundant computation when multiple consumers request signals for the same customer within a short window.

### 7. Template Engine Integration

Recommendation signals route to the existing **Strategic Opportunities** section (created by ADR-030) via the `solutionType` metadata key.

**New routing rule in `routeSignal()` (signal-templates.ts):**

```typescript
if (signal.type === 'recommendation') → Strategic Opportunities section
```

**Rendering within Strategic Opportunities:**

Recommendations render as a new sub-section **above** the existing Solution Plays, Marketplace Opportunities, and Urgent Correlations sub-sections:

```markdown
## Strategic Opportunities

### Recommended Actions
| Action | Confidence | Trigger Signals | Solution | Assets |
|--------|-----------|-----------------|----------|--------|
| VMware + expiring RHEL → OCP-Virt migration | HIGH (3 signals) | VMware detected, RHEL 8 EOL, VM perf case | [OCP-Virt Migration Play](url) | [Lab](url), [Design Guide](url) |

### Solution Plays
(existing ADR-030 content)

### Marketplace Opportunities
(existing ADR-030 content)
```

**Consumer mapping:**

| Consumer | Recommended Actions? | Max shown |
|----------|---------------------|-----------|
| Playbook | Yes | All (up to budget cap 5) |
| Brief | Yes (top 2 by confidence) | 2 |
| Campaign | Product-filtered | Matching only |
| Meeting Prep | Yes (framed for meeting context) | 3 |
| Morning Summary | Yes (top 1 per customer) | 1 per customer |

### 8. Signal Budget

| Source | Max per customer | Rationale |
|--------|-----------------|-----------|
| `recommended-actions` | 5 | Composite recommendations are high-signal. 5 is enough to surface the top strategic plays without drowning other signals. |

Added to `SIGNAL_BUDGETS` in `feature-module-registry.ts`.

### 9. Implementation Files

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/signal-query.ts` | Create | Core cross-referencing function (~150-200 lines) |
| `src/lib/recommendation-narrative.ts` | Create | Lazy Gemini narrative generation + 4h cache |
| `src/modules/recommended-actions-module.ts` | Create | Feature module registration |
| `src/signal-loader.ts` | Modify | Add `collectAllSignalsUnbudgeted()` export |
| `src/lib/signal-templates.ts` | Modify | Add routing for `type === 'recommendation'`, render sub-section |
| `src/feature-module-registry.ts` | Modify | Add budget cap entry (5) |
| `test/unit/signal-query.test.ts` | Create | Unit tests for cross-referencing logic |
| `test/unit/recommended-actions-module.test.ts` | Create | Module registration + signal emission tests |

### 10. What Does NOT Change

- **ADR-027 scoring algorithm** — `scoreSignal()`, `detectSpecificity()`, clamping: untouched
- **ADR-030 solution intelligence module** — untouched. It continues to produce individual cross-reference signals. This module produces composite recommendations.
- **Existing modules' signal contracts** — all 29 modules: untouched
- **Consumer contracts** — `templateAll()` interface: untouched (one new routing rule added)
- **Scraper layer** — zero scraper changes
- **Signal interface** — no new fields on `Signal`. `metadata` bag supports all required keys.
- **`collectAllSignals()`** — continues to apply budget caps for all existing callers

## Consequences

**Positive:**

- **Signal-to-action transformation.** Individual signals become composite recommended actions with linked assets and one-click next steps. This is the core value proposition of PRINCIPLES.md: "use intelligence to open opportunities."
- **Zero new data dependencies.** Reads existing caches (solution-plays.json, ecosystem-catalog, cloud-marketplace, saleshub-knowledge). No new scrapers, APIs, or auth tokens.
- **Lazy narrative = minimal Gemini cost.** Narratives generated only when consumers request them, cached for 4 hours. A customer with 5 recommendations viewed once costs 5 Gemini calls per 4 hours — not per signal collection cycle.
- **Observable thresholds.** Phase 2 (SignalIndex) is gated on measurable metrics exposed in the admin panel. No premature optimization.
- **Extends proven patterns.** Registered module (ADR-020), metadata-based routing (ADR-027), strategic opportunities section (ADR-030), result caching (same pattern as brief cache).

**Negative:**

- **Two collection paths.** `collectAllSignals()` (budgeted) and `collectAllSignalsUnbudgeted()` (unbounded) must stay in sync. Mitigation: the unbounded variant is a thin wrapper that calls the same scoring logic, just skips the cap step.
- **Recommendation quality depends on upstream signal quality.** Garbage-in from tech-stack-module (false positive VMware detection) produces garbage-out recommendations. Mitigation: confidence scoring demotes single-signal matches to 'emerging'; corroboration (2+ signals) is required for 'high' confidence.
- **Narrative cache invalidation.** Narratives are cached 4 hours even if underlying signals change within that window. Mitigation: this matches brief cache TTL. Users can force-refresh via the existing `force=true` parameter on consumers.

**Risks:**

- **Recommendation noise.** Low-confidence matches could produce many 'emerging' recommendations that clutter output. Mitigation: budget cap of 5 per customer, plus ranking by confidence ensures only the strongest recommendations surface.
- **Cross-reference false positives.** A case mentioning "VMware" in passing (e.g., "customer asked about VMware compatibility") could trigger a full VMware migration play. Mitigation: tech-stack-module's confidence level flows through — LOW confidence tech detection produces LOW confidence cross-reference. The corroboration requirement (2+ signals) further reduces false positives.

## Alternatives Considered

### Alternative 1: SignalIndex with Inverted Indexes Now

Build a full inverted index over all signals for efficient cross-referencing.

**Rejected because:** Council unanimous — premature at 1,300 signals per customer (uncapped). Flat scan over ~100 signals completes in <50ms. The index adds complexity (invalidation, memory management, consistency) without measurable benefit. Thresholds documented for future implementation when data volume justifies it.

### Alternative 2: ML-Based Recommendation Engine

Train a model on historical signal-to-action patterns.

**Rejected because:** Single-tenant data volume too small. 23 customers do not produce enough training signal. Rule-based cross-referencing with Gemini narrative is the right approach at this scale.

### Alternative 3: Standalone Recommendations Page

Build a new `/dashboard/recommendations` page.

**Rejected because:** Council decided contextual surfacing only. Recommendations should appear where the user already looks — Morning Summary ("top 1 per customer") and Customer Detail ("all for this customer"). A standalone page creates a new destination users must remember to visit. Recommendations have more impact embedded in existing workflows.

### Alternative 4: Consumer-Side Cross-Referencing

Have each consumer (playbook, brief, meeting prep) do its own cross-referencing.

**Rejected because:** Violates PRINCIPLES.md Layer 3 — consumers are thin. Multiple consumers implementing cross-reference logic means inconsistent recommendations across surfaces. One producer, many consumers.

### Alternative 5: Extend solution-intelligence-module Instead of New Module

Add recommendation logic to ADR-030's `solution-intelligence-module.ts`.

**Rejected because:** Different concerns. ADR-030 produces individual cross-reference signals (one play, one opportunity). This module produces composite recommendations that aggregate multiple ADR-030 outputs plus additional portfolio data. Separate modules = separate budget caps, separate debug visibility, clearer admin panel.

## PRINCIPLES.md Update

### New pre-flight question (add as #12):

> **12. If this module cross-references other modules' signals, does it use `collectAllSignalsUnbudgeted()`?** (#482) Cross-referencing modules need the full signal set to avoid missing corroborating signals that were budget-capped out. Only `collectAllSignalsUnbudgeted()` provides the complete picture. Using `collectAllSignals()` for cross-referencing produces incomplete recommendations.

### New anti-pattern:

> - Using `collectAllSignals()` (budgeted) for cross-referencing logic — budget caps may remove signals that are corroborating inputs to a recommendation. Use `collectAllSignalsUnbudgeted()` for cross-reference computation; let the registry budget-cap the recommendation module's output. (#482)

### New contract section:

> ## Cross-Referencing Module Contract (MANDATORY — ADR-032)
>
> Any module that reads OTHER modules' signals to produce composite outputs (recommendations, correlations, intelligence graphs) MUST:
>
> 1. Use `collectAllSignalsUnbudgeted()` — never the budgeted variant
> 2. Register as a feature module (not a standalone utility) — so its output is budget-capped, debuggable, and visible in admin
> 3. Set `rawRelevance` based on composite confidence (signal corroboration count + freshness + specificity) — never hardcode `score`
> 4. Use Gemini only for narrative synthesis (`narrative` field), never for decision logic (which signals match which solutions)
> 5. Cap its own output via registry budget (recommended: 5 per customer for composite recommendations)
>
> The query helper's outputs flow through `templateAll()` like any other signal. Consumers never call the query helper directly.

### Section group table update (in PRINCIPLES.md):

Add `recommendation` to the `customer-core` group (deterministic, no Gemini for the signal itself — Gemini is only for the optional narrative).
