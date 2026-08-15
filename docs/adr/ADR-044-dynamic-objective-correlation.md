---
doc-type: adr
status: accepted
owner: serena
updated: 2026-08-15
---

# ADR-044: Dynamic Objective Correlation for Campaign Emails

**Status:** Accepted
**Date:** 2026-08-15
**Decision Maker:** Serena Blackwood (Architecture Council)
**Extends:** ADR-043 (Two-Pass Campaign Generation)
**Drives:** #1068 (Campaign Quality), EMAIL-OUTREACH-SPEC.md

## Context

Campaign emails need financial and strategic objective data (EBITDA margins, YoY growth, security initiatives, operational targets) to appear in customer-facing email bodies. The current implementation uses:

1. **4 hardcoded `FINANCIAL_PATTERNS` regexes** (campaign-html-template.ts:779-784) — match "EBITDA margin of X%", "revenue growth of X%", etc. Brittle: actual signal formats like "25-30% EBITDA margins" don't match because patterns expect "EBITDA margin of X%".

2. **4 hardcoded `INITIATIVE_PATTERNS` regexes** (campaign-html-template.ts:786-791) — match "security initiative", "automation initiative", etc. Only catch the exact phrase structure "{keyword} initiative".

3. **Only scans `signal.headline` and `signal.metadata.company`** — misses signal body text (`detail`), structured intelligence data (`metadata.businessObjectives`, `metadata.initiatives`), and the intelligence cache's full company/industry markdown.

4. **`EMAIL_OBJECTIVE_TEMPLATES`** (line 918) — fill `{theme}` with the raw cleaned email subject (e.g., "Ansible Prospecting and the Upcoming SaaS Tax"), which positions Red Hat products as the THREAT ("Ansible... creates a direct headwind") instead of positioning the EXTERNAL threat (SaaS tax) and Red Hat as the SOLUTION.

5. **No persona awareness** — a CFO gets the same financial context as a CISO. The gold standard puts EBITDA into CFO emails and security posture into CISO emails.

### What Structured Data Already Exists

The intelligence module (`src/modules/intelligence-module.ts`) already extracts structured fields from the company intelligence markdown via `extractStructuredFields()`:

```typescript
metadata: {
  customerSlug,
  docType: 'company',
  businessObjectives: string[],   // Extracted from SWOT Opportunities
  initiatives: string[],          // Extracted from SWOT Strengths
  technologyStrategy: string | null,  // From Technological section
  detectedTechs: string[],       // From tech-stack cache
}
```

The intelligence pipeline prompt (`account-intelligence.ts:386`) already generates sections titled "Strategic Initiatives & Trigger Events" and "Financial Health" with priority ratings (HIGH/MEDIUM/LOW). This structured data is present in signals but bypassed by the regex-based extractors.

### The Fundamental Constraint

ADR-043 established that Pass 2 (template assembly) must be **deterministic** — no LLM in email body rendering. This constraint is correct and must be preserved. The question is: where does the objective data SELECTION happen — in Pass 1 (Gemini), in a deterministic pre-processing step, or both?

## Decision

**Three-layer objective pipeline: structured extraction at intelligence time, persona-aware selection at Pass 1, deterministic rendering at Pass 2.**

### Layer 1 — Structured Objective Extraction (Intelligence Pipeline)

When the intelligence pipeline generates company intelligence (`account-intelligence.ts`), it already produces rich markdown with financial metrics, strategic initiatives, and trigger events. The intelligence module's `extractStructuredFields()` already parses some of this.

**Extend the intelligence module to produce a `CustomerObjectiveProfile`:**

```typescript
interface CustomerObjectiveProfile {
  financial: ObjectiveEntry[]
  security: ObjectiveEntry[]
  operational: ObjectiveEntry[]
  innovation: ObjectiveEntry[]
  growth: ObjectiveEntry[]
}

interface ObjectiveEntry {
  objective: string          // "25-30% EBITDA margins target"
  metric: string | null      // "25-30%" — extracted numeric/percentage
  priority: 'HIGH' | 'MED' | 'LOW' | null
  source: string             // "Q2 2026 earnings call"
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
}
```

The extraction is deterministic: parse the intelligence markdown for section headers matching known categories, extract bullet points with metrics/priorities, and classify into the 5 categories by keyword proximity (same approach as `extractStructuredFields()` but deeper). This runs ONCE when intelligence is generated — not on every campaign generation.

The profile is stored alongside the intelligence cache: `data/cache/intelligence/{slug}-objectives.json`.

**Why deterministic extraction, not a second Gemini call:** The intelligence markdown is already structured with section headers and priority ratings. Regex/parsing is reliable for this format because WE control the prompt that generates the markdown (unlike arbitrary signal text). The prompt (line 386-396) explicitly structures "Strategic Initiatives & Trigger Events" with HIGH/MEDIUM/LOW ratings. Parsing our own structured output is deterministic and free.

### Layer 2 — Persona-Aware Selection (Pass 1 — Gemini)

ADR-043's `EmailSelection` schema is extended with an optional `objectiveIndex` field:

```typescript
interface EmailSelection {
  // ... existing fields from ADR-043 ...
  objectiveIndex: number | null   // Index into CustomerObjectiveProfile's flattened list
  objectiveCategory: 'financial' | 'security' | 'operational' | 'innovation' | 'growth' | null
}
```

Gemini (Pass 1) receives the `CustomerObjectiveProfile` as context alongside signals and contacts. It selects which objective is most relevant for each email based on:
- Recipient role/title (CFO → financial, CISO → security)
- Campaign directive theme
- Signal relevance

Gemini returns an INDEX into the profile — not the objective text itself. This keeps the stochastic surface minimal: Gemini selects WHICH objective, not the objective content.

**Why Gemini selects, not a deterministic function:** Role-to-category mapping is straightforward for canonical titles (CFO → financial), but real titles are messy: "VP of Digital Transformation" could be innovation or operational. "Head of Platform Engineering" could be innovation or operational. Gemini's judgment handles the long tail without maintaining a growing title-mapping table. The cost is one enum selection per email — zero hallucination surface because the VALUE comes from the deterministic profile.

### Layer 3 — Deterministic Rendering (Pass 2 — Template)

`buildObjectiveContext()` and `buildObjectiveCorrelation()` are replaced by `renderObjectiveBlock()`:

```typescript
function renderObjectiveBlock(
  profile: CustomerObjectiveProfile,
  selection: { objectiveIndex: number | null; objectiveCategory: string | null },
  campaignTheme: { threat: string; solution: string },
): string
```

Key design changes:

1. **Threat/solution separation:** The campaign directive now carries structured `{ threat, solution }` instead of a raw title string. "Ansible Prospecting and the Upcoming SaaS Tax" becomes `{ threat: "SaaS tax and vendor lock-in", solution: "self-managed automation" }`. This prevents the template from ever positioning Red Hat products as threats.

2. **Template uses objective from profile, not regex:** The template looks up `profile[category][index]` — no pattern matching needed. The objective text is what the intelligence pipeline extracted, not a regex capture.

3. **Category-aware templates:** Five template variants, each designed for its category:
   - Financial: "{metric} discipline means {threat} creates direct headwind — {solution} protects this trajectory."
   - Security: "{objective} makes {threat} a strategic exposure — {solution} reduces this surface."
   - Operational: "Given {objective}, {threat} adds operational overhead — {solution} consolidates this."
   - Innovation: "{objective} depends on infrastructure that {threat} could constrain — {solution} accelerates this roadmap."
   - Growth: "With {objective}, {threat} introduces friction — {solution} removes this barrier."

4. **Fallback:** When no objective profile exists (intelligence not yet run), the block renders empty — no generic filler.

### Campaign Directive Structure

The `campaignDirective` field on campaign config is extended to support structured threat/solution:

```typescript
interface CampaignDirective {
  raw: string                        // Freeform directive text (backward compatible)
  threat?: string                    // External threat (never a Red Hat product)
  solution?: string                  // Red Hat's value proposition
  primaryCategory?: ObjectiveCategory  // Hint for objective selection
}
```

When `threat` and `solution` are provided, the template uses them directly. When only `raw` is provided (backward compatibility), Pass 1 extracts threat/solution from the raw text. The `raw` field MUST be sanitized: if it contains a Red Hat product name in a negative frame, the template strips it before rendering.

### Removal of Hardcoded Patterns

`FINANCIAL_PATTERNS`, `INITIATIVE_PATTERNS`, `THEME_CATEGORIES`, `CORRELATION_TEMPLATES`, and `EMAIL_OBJECTIVE_TEMPLATES` are all deleted. They are replaced by:

1. `CustomerObjectiveProfile` — structured data from intelligence, not regex
2. `renderObjectiveBlock()` — category-aware template, not pattern-matched string
3. Persona-category selection in Pass 1 — Gemini judgment, not keyword matching

## Consequences

### Positive

- **Scales to all customers** — uses each customer's own intelligence data, not hardcoded patterns
- **Persona-aware** — CFO gets EBITDA context, CISO gets security posture, deterministically
- **No regex maintenance** — new financial formats (ranges, European notation, fiscal years) work automatically because the intelligence pipeline already captured them
- **Red Hat never positioned as threat** — structural guarantee via `{ threat, solution }` separation
- **Batch-compatible** — objective profiles are cached at intelligence time, not computed per campaign
- **Deterministic in Pass 2** — template renders from structured profile, no LLM
- **Testable** — `renderObjectiveBlock()` is a pure function with known inputs

### Negative

- **Depends on intelligence freshness** — customers without recent intelligence get no objective correlation (acceptable: the fallback is rendering nothing rather than rendering wrong)
- **One-time migration** — existing `extractFinancialTargets` / `extractBusinessObjectives` callers need updating
- **Structured directive** — campaign UI needs a threat/solution input (can be derived from raw directive as migration path)

### Neutral

- **Intelligence pipeline change** — adding `CustomerObjectiveProfile` extraction is additive, not disruptive
- **Pass 1 schema extension** — adding `objectiveIndex` and `objectiveCategory` is backward-compatible (both nullable)

## Alternatives Considered

| Option | Verdict | Reason |
|--------|---------|--------|
| A: Better regexes | Rejected | Whack-a-mole — every new financial format needs a new pattern. Violates PRINCIPLES.md vocabulary resolver rule ("no hardcoded vocabularies") |
| B: Gemini extracts objectives per campaign | Rejected | Repeats extraction work on every campaign run. Intelligence pipeline already does this. Also violates "Pass 2 must be deterministic" |
| C: Static role→category mapping table | Rejected | Works for CEO/CFO/CISO but breaks on real titles ("VP Digital Transformation"). Becomes another hardcoded mapping to maintain (violates ADR-038) |
| D: Full objective profile without Gemini selection | Rejected | All objectives dumped into every email regardless of persona relevance. Loses the persona-awareness requirement |

## Implementation Phases

### Phase 1 — Objective Profile Extraction (intelligence pipeline)
- Add `CustomerObjectiveProfile` extraction to `intelligence-module.ts`
- Parse intelligence markdown for financial metrics, strategic initiatives, priorities
- Write to `data/cache/intelligence/{slug}-objectives.json`
- Backfill for all existing customers with intelligence cache

### Phase 2 — Pass 1 Schema Extension (campaign-service)
- Add `objectiveIndex` and `objectiveCategory` to `EmailSelection` schema
- Include `CustomerObjectiveProfile` in Pass 1 Gemini context
- Add `threat`/`solution` to campaign directive structure

### Phase 3 — Template Rendering (campaign-html-template)
- Replace `buildObjectiveContext()` / `buildObjectiveCorrelation()` with `renderObjectiveBlock()`
- Delete `FINANCIAL_PATTERNS`, `INITIATIVE_PATTERNS`, `THEME_CATEGORIES`, `CORRELATION_TEMPLATES`, `EMAIL_OBJECTIVE_TEMPLATES`
- Add `sanitizeCreepyLines()` gate on rendered objective text

### Phase 4 — Cleanup
- Remove `extractFinancialTargets()` and `extractBusinessObjectives()` exports
- Update architecture compliance test if these functions were referenced

## PRINCIPLES.md Update

### New Anti-pattern

> - Hardcoded financial/initiative pattern regexes for objective extraction (ADR-044) — use `CustomerObjectiveProfile` from intelligence cache. Hardcoded patterns miss format variations, require code changes for new patterns, and can't differentiate objectives by persona category.

### New Pre-flight Question

> 24. **Does this consumer need customer business objectives?** (ADR-044) If the consumer generates persona-targeted content (campaigns, email outreach), it MUST read `CustomerObjectiveProfile` from the intelligence cache — never extract objectives via regex from signal text. Objective selection per email is done in Pass 1 (Gemini) via `objectiveIndex`; rendering is deterministic in Pass 2 via `renderObjectiveBlock()`. If no objective profile exists, render nothing — never fall back to generic positioning.

## References

- ADR-043: Two-Pass Campaign Generation (extended, not modified)
- ADR-038: Dynamic Matching Replaces Handcrafted Mappings (aligns)
- ADR-040: Universal Structured Output (aligns — structured schema in Pass 1)
- PRINCIPLES.md: Vocabulary Resolver Rule, Consumer Output Quality Rule
- `src/modules/intelligence-module.ts`: existing `extractStructuredFields()`
- `src/account-intelligence.ts:386`: "Strategic Initiatives & Trigger Events" section prompt
