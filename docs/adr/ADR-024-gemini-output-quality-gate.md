---
doc-type: adr
status: active
owner: jason
updated: 2026-06-24
---

# ADR-024: Universal output quality gate for Gemini-generated content

**Date:** 2026-05-18

## Status

Proposed

## Context

GitHub Issue #289. Jason spends hours manually auditing Gemini-generated documents (campaigns, meeting prep, intelligence briefs, account plans) for missing revenue, employee counts, positioning data, and structural completeness. There is no automated validation, no retry on poor output, and no quality visibility.

Five root causes identified:
1. Lossy Google Doc conversion (HTML stripped during Doc creation)
2. Gemini prompts do not enforce output format
3. No validation of generated content
4. No auto-retry with error feedback
5. No quality scorecard for visibility

This ADR addresses root causes 3, 4, and 5. Root causes 1 and 2 are separate work items.

### Current state

`callGemini()` in `src/gemini-call.ts` (ADR-023) is the single entry point for all Gemini API calls. It handles delta caching, model selection, timeout tiers, and cost tracking. It does NOT inspect or validate the content it returns. Four generation paths use it:

| Path | File | callType(s) |
|------|------|-------------|
| Campaigns | `campaigns-routes.ts` | `campaign-generation` |
| Meeting prep | `meeting-prep-routes.ts` | `meeting-prep-attendee-research`, `meeting-prep-partner-research`, `meeting-prep-synthesis` |
| Account intelligence | `account-intelligence.ts` | `intelligence-grounded`, `intelligence-industry`, `intelligence-company`, `intelligence-analysis` |
| Account plans | `account-plan.ts` | `account-plan-generation` |

Note: `account-intelligence.ts` still uses its own `callGeminiGrounded()` and `callGeminiGroundedStructured()` wrappers around raw `fetchGeminiWithRetry()` — it has NOT yet migrated to `callGemini()` (ADR-023 Phase 2 pending). The quality gate design must work with both the migrated and un-migrated call patterns.

A content quality gate already exists for **scrapers** (`validateScrapedContent()` in `product-release-radar.ts`) but is structurally different — it validates input data (scraped HTML), not LLM output. The LLM output problem requires domain-specific validators that understand what each content type should contain.

## Decision

### Option 4: Middleware pattern — `validateAndRetry()` wrapper function

A new `src/gemini-quality-gate.ts` module exports a `validateAndRetry()` function that wraps any generation function. It does NOT extend or modify `callGemini()`.

**Why not the other options:**

- **Option 1 (extend `callGemini()` directly):** Rejected. `callGemini()` is a transport-level wrapper (ADR-023). It handles retry for HTTP 429s, cost tracking, and delta caching. Content validation is a business-logic concern — it needs to know what "good" campaign HTML looks like versus what "good" intelligence JSON looks like. Mixing transport and business validation in the same function violates single responsibility and makes `callGemini()` depend on every content type's schema. It also cannot work with `account-intelligence.ts` which bypasses `callGemini()` entirely.

- **Option 2 (`callGeminiWithQuality()` wrapper):** Rejected. A wrapper around `callGemini()` would only work for callers that use `callGemini()`. Account intelligence uses `callGeminiGrounded()`. Meeting prep has multi-step generation (attendee research, partner research, synthesis) where the quality gate applies to the final assembled output, not each individual Gemini call. The quality gate must operate at the output level, not the API-call level.

- **Option 3 (per-route validation):** Rejected. This is how it would naturally evolve without a decision — each route implements its own ad-hoc validation. It duplicates the retry-with-feedback loop, the scorecard recording, and the error-context assembly in every route. When the retry protocol changes (e.g., max retries, backoff, error format), every route must be updated independently.

### Architecture

```
Route handler (campaigns-routes.ts, etc.)
  │
  ├── Assembles prompts, calls Gemini (via callGemini or callGeminiGrounded)
  │   └── Gets raw text/JSON response
  │
  └── validateAndRetry(rawOutput, validator, retryFn)
        ├── validator.validate(rawOutput) → QualityScorecard
        │   ├── score >= threshold → return { output, scorecard }
        │   └── score < threshold →
        │       ├── retries < MAX_RETRIES (2)?
        │       │   ├── YES → retryFn(scorecard.failures) → new rawOutput → loop
        │       │   └── NO  → return { output: bestAttempt, scorecard, retriesExhausted: true }
        │       └── (select best attempt by score across all tries)
        └── Scorecard saved alongside output
```

### Interface definitions

```typescript
// ── src/gemini-quality-gate.ts ──────────────────────────────────────────────

/** A single quality check result */
export interface QualityCheck {
  name: string          // e.g., 'revenue-populated', 'positioning-count'
  passed: boolean
  expected: string      // human-readable: "revenue field non-empty"
  actual: string        // human-readable: "revenue: ''"
  severity: 'required' | 'recommended'
}

/** Scorecard produced by a validator */
export interface QualityScorecard {
  contentType: string   // 'campaign' | 'meeting-prep' | 'intelligence' | 'account-plan'
  score: number         // 0-100, percentage of checks passed
  checks: QualityCheck[]
  failures: QualityCheck[]  // convenience: checks.filter(c => !c.passed)
  passThreshold: number     // the threshold used (e.g., 80)
  passed: boolean           // score >= passThreshold
  timestamp: string
  attempt: number       // 1-based attempt number
}

/** Interface that each content type implements */
export interface QualityValidator {
  contentType: string
  passThreshold: number   // 0-100
  validate(output: string): QualityScorecard
}

/** Result from validateAndRetry */
export interface QualityGateResult {
  output: string                 // best output (highest-scoring attempt)
  scorecard: QualityScorecard    // scorecard for the returned output
  attempts: number               // total attempts made (1 = passed first try)
  retriesExhausted: boolean      // true if max retries hit without passing
}

/** Options for the quality gate */
export interface QualityGateOptions {
  maxRetries?: number    // default: 2
  validator: QualityValidator
}

/**
 * Validate output and retry with error feedback if quality is below threshold.
 *
 * @param initialOutput - The raw Gemini output text from the first generation
 * @param options       - Validator and retry config
 * @param retryFn       - Called with failure descriptions; must return a new Gemini output.
 *                        The caller owns prompt construction and Gemini invocation.
 *                        Receives: (failures: QualityCheck[], attempt: number) => Promise<string>
 */
export async function validateAndRetry(
  initialOutput: string,
  options: QualityGateOptions,
  retryFn: (failures: QualityCheck[], attempt: number) => Promise<string>
): Promise<QualityGateResult>
```

### Retry behavior

1. `retryFn` receives the list of `QualityCheck` failures. The caller (route handler) appends these as structured feedback to the Gemini prompt: "Your previous output failed these checks: [list]. Please fix specifically: [list]. Return the complete output."
2. Maximum 2 retries (3 total attempts). This is a hard cap — Gemini output quality plateaus after 2 corrections.
3. If all attempts fail, return the highest-scoring attempt with `retriesExhausted: true`. Never fail the request entirely — a low-quality output is better than no output.
4. Each retry is a fresh Gemini call (not cached by delta detection). The `retryFn` caller should either omit `deltaKey` or use a retry-specific key.

### Validators (Phase 1 — four validators)

Each validator lives in `src/quality-validators/` as a separate file:

**`campaign-validator.ts`:**
- Positioning sections >= 2 (count `## ` headers in output)
- Revenue/employee data present (regex for revenue patterns, employee count)
- Email body length >= 200 chars per persona
- Subject line present per persona
- CTA link present
- Pass threshold: 70

**`meeting-prep-validator.ts`:**
- Attendee research section present
- At least 1 attendee bio populated (not just name)
- Talking points section >= 3 items
- Agenda section present
- Pass threshold: 75

**`intelligence-validator.ts`:**
- Signal count >= 5 (count structured signals in output)
- Company overview section present and >= 200 chars
- Industry section present
- Revenue/employee data populated
- Risk signals section present
- Pass threshold: 80

**`account-plan-validator.ts`:**
- All 12 required sections present (regex for section headers)
- Whitespace map table present (pipe-delimited table)
- Initiatives section has >= 3 items
- Actions table present with Owner column populated
- Pass threshold: 75

### Scorecard persistence

The scorecard is saved alongside the generated output in the existing cache structure:

```
data/cache/intelligence/{slug}.json          → add .qualityScorecard field
data/cache/campaigns/{id}/campaign.json      → add .qualityScorecard field
data/cache/meeting-prep/{id}.json            → add .qualityScorecard field
data/cache/intelligence/{slug}-account-plan-meta.json → add .qualityScorecard field
```

No new cache files. The scorecard rides on the existing cache entry. Callers write it after `validateAndRetry()` returns.

### Delta cache interaction

The quality gate runs AFTER `callGemini()` returns, including after delta cache hits. If a cached result was previously validated and passed, its scorecard is already in the output cache. If the cached result was never validated (generated before the quality gate existed), the validator runs on the cached text — no Gemini call needed, just local validation.

This means: old cached outputs get retroactively scored on first access after the quality gate ships. No migration needed.

### What this does NOT do

- Does NOT modify `callGemini()` or `gemini-call.ts` — that module stays transport-only
- Does NOT fix Google Doc conversion (root cause 1 — separate issue)
- Does NOT enforce prompt output format (root cause 2 — separate issue, though retry feedback partially compensates)
- Does NOT add UI for quality visibility (Phase 2 scope)
- Does NOT migrate `account-intelligence.ts` to `callGemini()` — works with the existing `callGeminiGrounded()` pattern

## Consequences

**Positive:**
- Every generated output gets a quality scorecard — makes quality visible and measurable
- Auto-retry catches the most common Gemini failures (missing sections, truncated output) without human intervention
- Validators are per-content-type — each can enforce domain-specific rules
- Scorecard data enables future quality dashboards and trend analysis
- Works with both `callGemini()` and legacy `callGeminiGrounded()` paths
- Retry cost is bounded: max 2 additional Gemini calls per generation, and only when quality is genuinely below threshold

**Negative:**
- Retry adds latency: worst case 3x generation time for a single output
- Validators are regex/string-based heuristics — they can false-positive on well-structured output that happens to use different formatting
- Scorecard adds ~1-2KB per cached output (negligible)

**Risks:**
- Validators too strict → excessive retries → wasted Gemini spend. Mitigation: start with conservative thresholds (70-80%) and tune based on actual scorecard data.
- Validators too loose → quality gate never fires → no value. Mitigation: review scorecard distribution after 2 weeks, tighten thresholds where pass rate is >98%.
- Retry prompt format confuses Gemini → worse output on retry than original. Mitigation: structured feedback format ("Check: X. Expected: Y. Got: Z.") is clear and actionable. If retry scores lower than original, `validateAndRetry` returns the highest-scoring attempt regardless of order.

## Phase 1 Scope (this ADR)

**Create:**
- `src/gemini-quality-gate.ts` — `validateAndRetry()`, types, scorecard writer
- `src/quality-validators/campaign-validator.ts`
- `src/quality-validators/meeting-prep-validator.ts`
- `src/quality-validators/intelligence-validator.ts`
- `src/quality-validators/account-plan-validator.ts`

**Modify:**
- `src/campaigns-routes.ts` — wrap generation output with `validateAndRetry()`
- `src/meeting-prep-routes.ts` — wrap synthesis output with `validateAndRetry()`
- `src/account-intelligence.ts` — wrap company/industry generation output with `validateAndRetry()`
- `src/account-plan.ts` — wrap generation output with `validateAndRetry()`
- Each route's cache write to include `.qualityScorecard` field

**Leave alone:**
- `src/gemini-call.ts` — no changes
- `src/gemini-fetch.ts` — no changes
- `src/gemini-auth.ts` — no changes
- `src/gemini-cost-tracker.ts` — no changes
- All scraper files — no changes
- Dashboard frontend — no changes (Phase 2)

**Tests:**
- Unit tests for each validator (known-good and known-bad outputs)
- Unit test for `validateAndRetry()` retry loop (mock retryFn)
- Integration test: generate a campaign and verify scorecard is present in cache

## Alternatives Considered

See Options 1-3 analysis in the Decision section above.

**Gemini-as-judge (use a second Gemini call to evaluate output):** Rejected. Adds cost (judge call is nearly as expensive as the generation call), latency, and recursive quality problems (who validates the judge?). Regex/string heuristics are fast, free, deterministic, and sufficient for structural validation. Content quality (tone, accuracy of claims) is a separate problem not addressed here.

**JSON Schema enforcement via `responseSchema`:** Already used where applicable. But most generation paths produce markdown/HTML, not JSON. Schema enforcement doesn't help with "is the revenue field populated in the HTML" — that requires content inspection.

## References

- GitHub #289
- ADR-023 (`callGemini()` standardization)
- `src/product-release-radar.ts` — existing scraper quality gate pattern
- `src/gemini-call.ts` — transport-level wrapper (not modified)
