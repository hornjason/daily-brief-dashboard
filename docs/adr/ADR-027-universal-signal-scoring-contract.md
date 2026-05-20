---
doc-type: adr
status: accepted
owner: jason
updated: 2026-05-20
---

# ADR-027: Universal Signal Scoring Contract

**Date:** 2026-05-19 (updated 2026-05-20)
**References:** ADR-020 (Feature Module Registry), ADR-021 (Signal Contract), #317 (universal confidence model)

## Status

Accepted

## Context

ADR-021 established a flat `Signal` interface with an optional `score` field (0-1 float). In practice, every module invented its own scoring semantics — RSS scores 0.3-0.6 via keyword matching while pipeline scores 0.4-0.9 via stage names. This produces three problems:

1. **Score flooding.** RSS emits ~130 signals at 0.3-0.6, consuming the entire signal budget before high-value modules (pipeline, CCSP, cloud-marketplace) contribute.
2. **Score incomparability.** 0.7 from RSS means something different than 0.7 from pipeline.
3. **No enforcement.** Each module author decides their own scale with no guardrails.

## Decision

### Core Principle: Modules Report Facts, the Registry Scores

**Modules MUST NOT set `score` directly.** Modules provide raw data and structured metadata. The registry's centralized scoring function determines the final score for every signal. This prevents modules from gaming or miscalibrating their own importance.

### 1. Specificity — Determined by the Registry, Not the Module

The registry examines each signal's metadata to classify its **specificity** — how close and specific the data is to THIS customer. The more specific, the higher the score. Less specific = less scoring.

| Specificity | Definition | How the registry detects it | Score range |
|-------------|-----------|---------------------------|-------------|
| `customer` | Data is about THIS specific customer — their tech, their spend, their cases, their deals | `metadata.customerSlug` present, or customer name/account number in headline | 0.50 – 1.00 |
| `industry` | Relevant to the customer's industry/segment but not named specifically | `metadata.industryMatch === true`, or industry keyword match | 0.35 – 0.69 |
| `general` | Red Hat ecosystem news with no customer or industry tie | Neither customer nor industry indicators present | 0.10 – 0.35 |

**Enforcement:** The registry clamps scores to these ranges. A general signal can never score above 0.35. A customer-specific signal can never score below 0.50. This is structural — no module can override it.

### 2. Scoring Tiers (Result of Specificity + Boosters)

| Tier | Range | Meaning | What lands here |
|------|-------|---------|----------------|
| Critical | 0.90-1.00 | Revenue impact, urgent action needed | Sev1 case, committed pipeline deal, evaluating/migrating tech with RH mapping |
| High | 0.70-0.89 | Directly actionable in customer conversation | Customer tech stack with RH products, $100K+ cloud spend, marketplace offer on their hyperscaler, customer in news headline |
| Medium | 0.50-0.69 | Useful context, not the main story | $20K spend, general product lifecycle, industry news match, subscription data |
| Low | 0.35-0.49 | Background awareness | Industry trends, low-confidence tech, small pipeline deals |
| Noise | 0.00-0.34 | Filtered from content generation | Generic Red Hat blog posts, no customer relevance |

### 3. How Modules Provide Data (Signal Interface Changes)

```typescript
export interface Signal {
  source: string           // module name (e.g., 'tech-stack', 'ccsp')
  type: string             // signal type (e.g., 'technology', 'cloud-spend')
  headline: string         // one-line summary
  detail: string           // supporting context
  timestamp: string        // when this data was collected
  url?: string             // source URL if applicable
  rawRelevance?: number    // 0-1: module's within-domain ranking (optional)
  metadata?: Record<string, any>  // structured facts for scoring
  // score is REMOVED from module control — set only by registry
}
```

**`rawRelevance`** is the module's opinion of how important this signal is *relative to other signals from the same module*. It does NOT determine the final score — it only influences ordering within the specificity tier. A rawRelevance of 0.9 from RSS still scores lower than rawRelevance 0.5 from tech-stack if the RSS signal is `general` and the tech-stack signal is `customer`.

**`metadata`** carries structured facts the scoring function uses:

| Metadata field | Used by | Effect |
|---------------|---------|--------|
| `customerSlug` | Specificity detection | Marks signal as customer-specific |
| `industryMatch` | Specificity detection | Marks as industry-relevant |
| `redHatProducts` | Booster | +0.10 if non-empty array |
| `acvPlus` or `amount` | Booster | +0.10 if > 0 (revenue attached) |
| `confidence` | Booster/penalty | HIGH: +0.05, LOW: -0.10 |
| `context` | Booster | `evaluating` or `migrating_from`: +0.10 |
| `severity` | Booster | 1: +0.15, 2: +0.10 |
| `endDate` | Booster | Within 90 days: +0.10 (renewal urgency) |
| `cloudPartner` | Booster | Matched to customer CCSP: +0.10 |
| `hasCloudSpend` | Booster | Customer has spend on this hyperscaler: +0.10 |

### 4. Centralized Scoring Function (in `feature-module-registry.ts`)

```
function scoreSignal(signal: Signal, customerSlug: string): number {
  // Step 1: Detect specificity
  specificity = detectSpecificity(signal, customerSlug)
  
  // Step 2: Base score from specificity floor + rawRelevance within tier range
  tierFloor = specificityFloors[specificity]
  tierCeiling = specificityCeilings[specificity]
  tierRange = tierCeiling - tierFloor
  rawRelevance = signal.rawRelevance ?? 0.5
  baseScore = tierFloor + (rawRelevance * tierRange)
  
  // Step 3: Apply boosters/penalties from metadata
  adjustedScore = baseScore + sum(applicableBoosters(signal.metadata))
  
  // Step 4: Clamp to specificity range
  finalScore = clamp(adjustedScore, tierFloor, tierCeiling)
  
  // Step 5: Time decay (existing — linear over 30 days)
  return applyTimeDecay({ ...signal, score: finalScore })
}
```

### 5. Per-Source Signal Budget

Applied in `collectAllSignals()` AFTER scoring. Take at most N signals per source, sorted by score descending.

| Source | Max per customer | Rationale |
|--------|-----------------|-----------|
| pipeline | 10 | Each opportunity is distinct |
| ccsp | 8 | One per product line typical |
| cases | 8 | Active cases are high-signal |
| cloud-marketplace | 5 | Few hyperscalers, each matters |
| tech-stack | 8 | Customer-specific research, high value |
| rh-rss | 5 | Noise-prone, cap hard |
| subscriptions | 5 | One per product family |
| intelligence | 5 | Curated summaries |
| value-maps | 3 | Rarely more than 3 objective clusters |
| news-radar | 5 | Curated customer news |

Default for unlisted modules: **5**.

### 6. Consumer Contract

Consumers call `collectAllSignals(customerSlug)` which returns budget-capped, scored, time-decayed, sorted signals. Consumers only slice to their own total budget:

| Consumer | Budget | Purpose |
|----------|--------|---------|
| playbook-generator.ts | 40 | Full customer playbook |
| brief-pipeline.ts | 10 | Daily brief |
| campaigns-routes.ts | 20 | Campaign context |
| meeting-prep-routes.ts | 15 | Meeting prep |

### 7. Signal Debug Endpoint

`GET /api/customer/:name/signals/debug` — returns every signal with:
- Raw signal data (headline, detail, source, metadata)
- Detected specificity (customer/industry/general)
- Base score before boosters
- Applied boosters/penalties with reasons
- Final score after clamping
- Tier classification

This lets Jason review signal scoring without reading code.

## Per-Module Scoring Examples

**tech-stack** — customer-specific research:
- `metadata: { customerSlug, confidence: 'HIGH', redHatProducts: ['OpenShift'], context: 'evaluating' }`
- Specificity: `customer` (floor 0.50)
- Boosters: +0.05 (HIGH confidence) + 0.10 (RH products) + 0.10 (evaluating)
- **Final: 0.90 (Critical)** — they're evaluating tech that maps to our products

**cloud-marketplace** — customer has hyperscaler spend:
- `metadata: { customerSlug, cloudPartner: 'AWS', hasCloudSpend: true, acvPlus: 643000 }`
- Specificity: `customer` (floor 0.50)
- Boosters: +0.10 (hasCloudSpend) + 0.10 (revenue > 0)
- **Final: 0.85 (High)** — marketplace offer on their active hyperscaler

**rh-rss** — generic Red Hat blog:
- `metadata: {}` (no customer slug, no industry match)
- Specificity: `general` (floor 0.10, ceiling 0.35)
- No boosters
- **Final: 0.20 (Noise)** — filtered from content generation

**rh-rss** — customer name in headline:
- `metadata: { customerSlug: 'crowdstrike' }`
- Specificity: `customer` (floor 0.50)
- **Final: 0.55 (Medium)** — news about them, but RSS is broad

## Implementation Approach

1. Add `scoreSignal()` and `detectSpecificity()` to `feature-module-registry.ts`
2. Add `SIGNAL_BUDGETS` constant map
3. Update `collectAllSignals()` to: score each signal → budget-cap per source → sort → return
4. Update each module to: remove `score` field from signals, add `rawRelevance` and structured `metadata`
5. Add `/api/customer/:name/signals/debug` endpoint
6. Update ARCHITECTURE.md with signal scoring section

## Consequences

**Positive:**
- Module authors don't think about scoring — they just report facts
- Customer-specific data structurally cannot score below Medium
- Generic data structurally cannot score above Low
- Scoring is debuggable via API without reading code
- New modules automatically get correct scoring by providing metadata

**Negative:**
- Every module needs metadata migration (one-time)
- Centralized scoring function is a single point of complexity — but also a single point to debug

**Risks:**
- Booster values are judgment calls. Mitigation: debug endpoint + 2-week review period.
- Some modules may lack metadata fields. Mitigation: signals without metadata get `general` specificity and low scores, which is the safe default (under-score, not over-score).
