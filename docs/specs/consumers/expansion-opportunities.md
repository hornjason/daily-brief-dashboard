---
doc-type: consumer-spec
status: active
owner: jason
updated: 2026-08-03
---

# Consumer Spec: Expansion Opportunities

## Overview
Cross-product expansion analysis that recommends Red Hat products the customer doesn't currently subscribe to. Analyzes comprehensive customer signals (intelligence cache, subscriptions, cases, Drive docs, pipeline, product features) to identify up to 3 expansion opportunities with confidence ratings and specific feature matches.

## Source Files
- `src/expansion-opportunities.ts` — domain logic (signal loading, Gemini analysis, recommendation generation)

## Delivery
- **Drive:** Cached JSON at `data/cache/intelligence/{slug}-expansion.json`
- **UI:** CustomerDetailPage expansion tab, displays recommendations with confidence badges

## API Endpoints
- `POST /api/customer/:name/expansion-opportunities/generate` — generate expansion recommendations
- `GET /api/customer/:name/expansion-opportunities` — cached recommendations

## Required Sections
Expansion output includes:
- Recommendations array (0-3 products)
- Per-recommendation:
  - Product slug and display name
  - Why field (1-2 sentences citing specific signal)
  - Features array (2-3 relevant feature names)
  - Confidence level (HIGH/MEDIUM/LOW)
- Empty state when customer has all products
- Empty state when insufficient signal data

## Quality Validator
None currently — Gemini output is validated inline (lines 267-278):
- Product slug must match unsubscribed products list
- Why field capped at 500 chars
- Features array capped at 3 items
- Confidence must be HIGH/MEDIUM/LOW

## TC Compliance
| Requirement | Status | Evidence |
|---|---|---|
| @consumer-contract v1.0 | ❌ Missing | No contract declaration |
| ensureFresh | ❌ Missing | No call to loadCustomerSignals with ensureFresh |
| templateAll | ❌ Not used | Builds Gemini prompt manually (lines 210-240) |
| validateAndRetry | ❌ Missing | No quality validator file or validateAndRetry call |
| getAccountTeam | ❌ Missing | No import or usage |
| Drive delivery | ⚠️ Partial | Writes JSON cache (line 73) but NOT Google Doc |
| callGemini | ✅ src/expansion-opportunities.ts:245 | Uses callGemini wrapper correctly |
| GROUNDING_RULES import | ❌ Missing | No grounding rules applied to Gemini prompt |

### TC Compliance Details

**TC-1 (Contract Declaration):** Missing `// @consumer-contract v1.0` at top of file.

**TC-2 (ensureFresh):** Consumer loads signals manually (lines 78-106) instead of using `loadCustomerSignals(slug, name, { ensureFresh: true })`. No signal freshness guarantee.

**TC-3 (templateAll):** Builds Gemini prompt manually from raw signal properties (lines 210-240) instead of using `templateAll(signals, team, { format })`. Violates deep module architecture — prompt logic should be centralized in template engine.

**TC-4 (validateAndRetry):** No quality validator file exists. Inline validation (lines 267-278) checks structure but not content quality (placeholder text, specificity, depth).

**TC-5 (callGemini):** ✅ Correctly uses `callGemini()` wrapper (line 245) with call metadata.

**TC-6 (Drive delivery):** Writes JSON cache locally but does NOT upload Google Doc to customer Drive folder like campaign consumer does. Should write to `Expansion Opportunities/` subfolder.

**TC-7 (getAccountTeam):** Missing import and usage. Recommendations should include account team context in prompt to personalize outreach suggestions.

**GROUNDING_RULES:** No import from `src/lib/gemini-grounding.ts`. Gemini prompt lacks grounding rules that enforce evidence chains and prevent generic advice.

### Mission Alignment Gaps

**MA-1 (Context Anchor):** Recommendations don't indicate what's happening NOW — no temporal signal (recent cases, pipeline movement, upcoming renewal).

**MA-2 (Evidence Chains):** "Why" field cites signals but doesn't complete the full chain: `Customer tech → Business problem → RH solution → Measurable outcome`. Currently stops at signal citation.

**MA-3 (Actionable Steps):** Recommendations lack WHO to contact, WHAT to say, BY WHEN. Just lists product + rationale.

**MA-4 (Money Connection):** No pipeline value, ACV estimate, or expansion revenue potential in output.

**MA-5 (Multi-Threading):** Doesn't identify stakeholders to engage per product recommendation.

**MA-6 (Teach Insight):** Doesn't surface peer comparisons, benchmarks, or competitive moves the customer doesn't know.

**MA-7 (Empty States):** ✅ Handles two empty states correctly: all products covered (line 134), insufficient signals (line 192).
