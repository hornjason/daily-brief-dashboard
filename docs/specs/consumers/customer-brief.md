---
doc-type: reference
status: active
owner: jason
updated: 2026-06-18
---

# Consumer Spec: Customer Brief

**Contract version:** v1.0
**Consumer type:** Daily intelligence brief per customer
**Source files:** `src/brief-pipeline.ts`, `src/customer.ts` (generateBrief function)
**API endpoint:** `GET /api/customer/:name/brief` (triggers generation on cache miss)
**UI surface:** CustomerDetailPage overview tab → BriefSection component
**Delivery:** Web UI only (Drive delivery: future enhancement)
**Quality validator:** `src/quality-validators/brief-validator.ts` (TO BE CREATED)

---

## Current State (Audit 2026-06-18)

**Failures against consumer contract:**
- MA-1 PARTIAL: Context anchor references stale data instead of customer intelligence
- MA-2 FAIL: No evidence chains (tech → problem → solution → outcome)
- MA-3 PARTIAL: Only 1 action, contract requires up to 3 ranked
- MA-4 FAIL: No dollar figures (renewal amounts, pipeline values)
- MA-5 FAIL: No multi-threading (only one stakeholder named)
- MA-6 FAIL: No Challenger insights
- MA-7 PARTIAL: Stale data mentioned but not handled as empty state
- TC-1 FAIL: No contract declaration
- TC-2 PARTIAL: Uses refreshStaleSignals, not loadCustomerSignals({ ensureFresh: true })
- TC-3 FAIL: Does NOT call templateAll() — uses raw extraction pipeline only
- TC-4 FAIL: No quality validator
- TC-6 FAIL: No Drive delivery
- TC-7 FAIL: No getAccountTeam() — uses generic titles not names

**Root cause:** The brief pipeline was built early (the first consumer) before templateAll(), the signal scoring contract (ADR-027), and the quality gate pattern (ADR-024) existed. It never caught up.

---

## Required Sections

| Section | Required? | Source | Notes |
|---------|-----------|--------|-------|
| Priority Action | YES | Gemini synthesis from scored signals | Must follow [Verb] [specific object] [by/before date] formula with dollar connection |
| What Changed | YES | Delta from previous brief | Top 5 changes with source citations |
| Risks & Renewals | CONDITIONAL | Pipeline + subscription signals | Only if applicable; must include dollar amounts |
| Meeting Prep | CONDITIONAL | Calendar + signal correlation | Only if meeting within 7 days |
| Competitive Signals | CONDITIONAL | Competitive intel signals | Only if detected |
| Company Profile | CONDITIONAL | Intelligence cache | Only if intelligence available |
| Technology Landscape | CONDITIONAL | Tech stack signals | Only if tech stack data available |
| Next Steps | YES | Gemini synthesis | 3 ranked actions with WHO/WHAT/WHEN |
| Data Freshness | YES | Module status | Gaps listed honestly |

**Minimum sections:** 4 (Priority Action + What Changed + Next Steps + Data Freshness)
**Min words per section:** 30

---

## Acceptance Criteria for Hardening

### Technical Compliance
- AC-1: `// @consumer-contract v1.0` declaration added to both `brief-pipeline.ts` and `customer.ts`
- AC-2: `loadCustomerSignals(slug, name, { ensureFresh: true })` called before brief generation (replacing current `refreshStaleSignals`)
- AC-3: `templateAll(signals, team, { format: 'brief' })` called to get deterministic sections — signals + deterministic context fed to synthesis prompt
- AC-4: Quality validator created at `src/quality-validators/brief-validator.ts` — checks: required sections present, no placeholder text, minimum content depth, Priority Action follows formula
- AC-5: `validateAndRetry()` called before caching brief output
- AC-6: `getAccountTeam(customer)` called — team context included in synthesis prompt so named people appear in output
- AC-7: Account team context passed to synthesis via `toPromptContext(team)` so brief references named stakeholders not generic titles

### Mission Alignment Fixes
- AC-8: Priority Action includes dollar figure (renewal amount, pipeline value, or expansion estimate)
- AC-9: Brief includes up to 3 ranked next steps with WHO (named person from account team or customer contact), WHAT (specific action), WHEN (date)
- AC-10: At least one evidence chain in the brief: customer tech/situation → business problem → Red Hat solution → measurable outcome
- AC-11: At least one Challenger insight: peer comparison, industry benchmark, or tech stack gap the customer hasn't surfaced
- AC-12: Empty states say "Insufficient data — suggest discovery call" not generic filler

### Testing
- AC-13: Architecture compliance test verifies: brief-pipeline.ts has contract declaration, imports quality validator, calls ensureFresh
- AC-14: API regression test: `GET /api/customer/:name/brief` returns response with required sections present and non-empty
- AC-15: Quality validator unit test: passes good output, fails bad output (empty sections, placeholder text, missing Priority Action)

---

## Implementation Notes

The key structural change: currently `generateBrief()` builds a raw XML corpus from Drive docs, emails, meetings, cases — then passes it directly to Gemini for extraction. It does NOT use templateAll(). The fix is to ALSO call `templateAll(signals, team, { format: 'brief' })` and include its deterministic sections as additional context for the synthesis prompt. This gives the brief access to: Product Alignment, Cloud Marketplace, Cases, Renewals, Tech Stack, Key Relationships — all the rich data that Meeting Prep and Campaigns already get.

The brief-pipeline's three-step process (Extract → Rank → Synthesize) remains — templateAll() output is added as supplementary context in Step 3 (Synthesize), not as a replacement for extraction.
