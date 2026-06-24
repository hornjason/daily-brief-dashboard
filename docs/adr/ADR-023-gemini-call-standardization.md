---
doc-type: adr
status: active
owner: jason
updated: 2026-06-24
---

# ADR-023: Standardized Gemini call pattern

**Date:** 2026-05-15

## Status

Proposed

## Context

The dashboard makes 22 Gemini API calls across 12 files. Three shared primitives exist — `fetchGeminiWithRetry()` (429 retry with exponential backoff), `recordGeminiUsage()` (per-call cost tracking), and `getAiConfig()` (model selection) — but only 7 of 22 call sites use them consistently. The remaining 15 call sites construct their own fetch calls, with inconsistent or missing retry logic, no cost tracking, and timeouts ranging from 30s to 300s (or none at all). `news-provider.ts` is the worst offender: no timeout, no retry, no cost tracking.

A second problem: every scheduled refresh re-calls Gemini even when the input data hasn't changed. The intelligence pipeline regenerates identical customer briefs, news summaries, and product analyses on every cycle because there is no mechanism to detect that inputs are unchanged. At current customer counts (~40), this wastes roughly 30-40% of Gemini spend on duplicate calls.

Both problems have the same root cause: no single function that every Gemini call flows through. Each call site assembles its own request, so cross-cutting concerns (retry, cost tracking, delta detection) must be implemented 22 times or not at all.

## Decision

### Single `callGemini()` entry point

All Gemini calls flow through one function that composes the three existing primitives and adds delta detection:

```typescript
interface GeminiCallOptions {
  callType: string              // 'brief-synthesis', 'campaign-generation', etc.
  customerName?: string         // for cost attribution (omit for portfolio-level calls)
  model?: 'full' | 'lite' | 'pro'  // maps to ai-config models; defaults to 'full'
  timeoutMs?: number            // override default timeout tier
  temperature?: number          // override model default
  grounding?: boolean           // enable Google Search grounding
  responseSchema?: object       // for structured JSON output
  deltaKey?: string             // cache key for input-hash delta detection
}

interface GeminiResult {
  text: string                  // raw text response (or JSON string if responseSchema)
  cached: boolean               // true if returned from delta cache
  inputTokens: number           // 0 if cached
  outputTokens: number          // 0 if cached
  model: string                 // actual model used
}

function callGemini(
  systemPrompt: string,
  userPrompt: string,
  options: GeminiCallOptions
): Promise<GeminiResult>
```

Internally, `callGemini()` does four things in order:

1. **Delta check** — if `deltaKey` is provided, hash `systemPrompt + userPrompt + JSON.stringify(responseSchema ?? '')` with SHA-256. Compare against `data/cache/gemini-delta/{deltaKey}.json`. If the hash matches, return the cached result immediately with `cached: true`.
2. **Fetch** — delegate to `fetchGeminiWithRetry()` with the resolved model, timeout, and auth token.
3. **Cost tracking** — call `recordGeminiUsage()` with actual token counts from the response.
4. **Delta store** — if `deltaKey` is provided, write the hash and result to the cache file.

This function does not own business logic, prompt construction, or response parsing. Callers build their prompts, call `callGemini()`, and parse the result.

### Delta detection strategy

Input hashing, not output comparison. The hash covers the full prompt content (system + user + schema) because identical inputs to the same model produce functionally equivalent outputs. The cache is a simple JSON file per delta key:

```json
{
  "hash": "sha256:abc123...",
  "result": { "text": "...", "model": "gemini-2.5-flash" },
  "timestamp": "2026-05-15T10:00:00Z"
}
```

`deltaKey` is optional. Callers that need fresh results every time (e.g., grounded search for current news) omit it. Callers with stable inputs (e.g., customer brief from cached intelligence data) provide a key like `brief:{customerSlug}` or `product-intel:{customerSlug}`.

Cache files live under the existing `data/cache/` directory and are subject to the same container lifecycle as other caches — they survive restarts but not image rebuilds. No TTL or eviction — the hash comparison is the invalidation mechanism. If inputs change, the old cache is overwritten.

### Timeout tiers

Default timeouts when `timeoutMs` is not explicitly provided:

| Tier | Condition | Timeout | Rationale |
|------|-----------|---------|-----------|
| Structured | `responseSchema` present | 30s | Schema-constrained output is fast |
| Standard | Text generation, no grounding | 120s | Bulk of call sites today |
| Grounded | `grounding: true` | 120s | Google Search adds latency but 120s is sufficient |
| Long-form | `callType` in allow-list (campaigns, account plans) | 180s | Complex multi-section generation |
| Multimodal | Caller sets explicitly | 300s | PDF extraction, large context |

The function selects the tier based on options. Callers can always override with an explicit `timeoutMs`.

### Model resolution

`model: 'full' | 'lite' | 'pro'` maps to `getAiConfig()` values:

- `full` → `geminiModel` (currently `gemini-2.5-flash`)
- `lite` → `geminiModelLite` (currently `gemini-2.5-flash-lite`)
- `pro` → hardcoded `gemini-2.5-pro` (used only for campaigns and account plans)

This indirection means model upgrades happen in one place (`data-sources.json` AI config), not 22 call sites.

### Migration path

**Phase 1 — Create `callGemini()` (one PR):** Build the function in a new `src/gemini-call.ts`, composing existing primitives. No call sites change yet. Add unit tests for delta detection and timeout tier selection.

**Phase 2 — Migrate non-compliant call sites (12 PRs, each XS-S):** Convert each of the 15 direct-fetch call sites to use `callGemini()`. Each migration is independent and can be done in any order. Priority order by impact:

1. `news-provider.ts` — no retry, no timeout, no cost tracking (worst offender)
2. `product-intelligence.ts`, `customer-product-intel.ts` — high-volume callers
3. Remaining 12 files in any order

The 7 sites already using `fetchGeminiWithRetry` also migrate, but they gain only cost-tracking consistency and delta detection — lower priority.

**Phase 3 — Add delta keys to high-volume callers (after Phase 2):** Instrument `deltaKey` on intelligence generation, brief synthesis, and news summarization. Measure cache hit rate to validate the 30-40% cost reduction estimate.

## Consequences

**Positive:**
- Every Gemini call gets retry, cost tracking, and consistent timeouts automatically — impossible to forget
- Delta detection eliminates redundant API calls without changing business logic
- Cost attribution becomes complete — `news-provider.ts` calls finally appear in the cost dashboard
- Model changes propagate from one config file instead of 22 call sites
- New features get Gemini best practices for free — call `callGemini()` and go

**Negative:**
- One more abstraction layer between callers and the Gemini API — debugging requires understanding the wrapper
- Delta cache files add disk usage under `data/cache/` (negligible — JSON text, one file per delta key)
- 22 call sites must eventually migrate — Phase 2 is mechanical but takes time

**Risks:**
- Delta detection returns stale results if the hash doesn't capture all relevant inputs. Mitigation: hash covers the full prompt content, which already contains the serialized input data. If a caller constructs prompts from data not in the prompt text, they should not use `deltaKey`.
- Timeout tiers may not fit all future call patterns. Mitigation: callers can always override with explicit `timeoutMs`; tiers are defaults, not constraints.

## Alternatives Considered

**Middleware/interceptor pattern (wrap `fetch` globally):** Rejected because Gemini calls are a small subset of all fetch calls. A global interceptor would need to distinguish Gemini calls from Drive, Salesforce, and other API calls — more complexity than a purpose-built function.

**Per-module opt-in to existing primitives (no new function):** Rejected because this is the current state and it doesn't work. 15 of 22 call sites have opted out. A single function with a clean interface is the only way to make the right thing the easy thing.

**Output-based delta detection (compare Gemini responses):** Rejected because LLM outputs vary between identical calls due to temperature and model non-determinism. Input hashing is deterministic and simpler.

**TTL-based caching instead of input hashing:** Rejected because TTL doesn't know when inputs change. A 4-hour TTL would still regenerate unchanged briefs every 4 hours, and would also serve stale results when inputs genuinely change mid-window. Input hashing handles both cases correctly.

## References

- GitHub #228
- `src/gemini-fetch.ts` — existing retry infrastructure
- `src/gemini-cost-tracker.ts` — existing cost tracking
- `src/ai-config.ts` — existing model configuration
