---
doc-type: consumer-spec
status: active
owner: jason
updated: 2026-08-03
---

# Consumer Spec: Value Positioning

## Overview
Generates a proactive Value Proposition Brief for stalled or quiet customer accounts. Assembles customer intelligence, account plan, support cases, pipeline opportunities, and value maps into a professional proposal document designed to re-engage the customer with intelligence-backed Red Hat solutions.

## Source Files
- `src/value-positioning.ts` — domain logic (signal assembly, Gemini prompts, Drive upload)
- Routes are consumed via direct function calls, not HTTP endpoints (as of 2026-08-03)

## Delivery
- **Drive:** Google Doc in customer folder (`Value Positioning/` subfolder)
- **UI:** Customer detail page or batch generation trigger (exact UI surface TBD)

## API Endpoints
No dedicated HTTP routes as of 2026-08-03. Consumed via:
- Direct function call: `generateValuePositioning(customer)`
- Cached output read: `readCachedPositioning(customerSlug)`

## Required Sections
Structured JSON response with four required sections:
1. **currentState** — 2-3 paragraph summary of customer's current state, goals, and challenges
2. **solutionAlignment** — Array of Red Hat solutions mapped to customer needs, each with proof points (industry examples, case studies, or customer evidence)
3. **artOfPossible** — 2-3 paragraphs describing what the customer could achieve with Red Hat that they're not doing today
4. **nextSteps** — Concrete, actionable next steps with:
   - Specific dollar amounts from pipeline data
   - Specific deadlines (BY WHEN)
   - 2-3 stakeholder engagement paths (multi-threading)

## Quality Validator
`src/quality-validators/value-positioning-validator.ts` — validates structure, specificity, and proactive engagement elements.

## TC Compliance

| Requirement | Status | Reference |
|---|---|---|
| @consumer-contract v1.0 | ✅ | value-positioning.ts:30 |
| ensureFresh | ✅ | value-positioning.ts:368 (`loadCustomerSignals(slug, customer.name, { ensureFresh: true })`) |
| templateAll | ✅ | value-positioning.ts:369 (`templateAll(registrySignals, undefined, { format: 'brief' })`) |
| validateAndRetry | ✅ | value-positioning.ts:388-401 (full quality gate with retry logic) |
| getAccountTeam | ✅ | value-positioning.ts:360-364 (`getAccountTeam(customer)` + `toPromptContext()`) |
| Drive delivery | ✅ | value-positioning.ts:287-292 (`uploadPositioningToDrive()` → `Value Positioning/` subfolder) |
| callGemini | ✅ | value-positioning.ts:377-382 (via `callGemini()` wrapper with responseSchema) |
| GROUNDING_RULES import | ✅ | value-positioning.ts:27 (`GROUNDING_RULES_BLOCK` in system prompt at line 223) |

### Signal Assembly Details
The consumer assembles context from five sources (value-positioning.ts:131-206):
- **Intelligence cache** — Company and industry context
- **Account plan** — Existing account plan markdown if available
- **Support cases** — Total, open Sev-1, open Sev-2 counts
- **Pipeline** — Salesforce opportunities with ACV, forecast category
- **Value maps** — Which products have value map content available

### Structured Output Compliance (ADR-040)
Uses Gemini `responseSchema` for structured JSON output (value-positioning.ts:34-66). Schema enforces:
- `currentState` (STRING, required)
- `solutionAlignment` (ARRAY of OBJECT, required — each with `solution`, `alignment`, `proofPoints`)
- `artOfPossible` (STRING, required)
- `nextSteps` (ARRAY of STRING, required)

### Validation Gate
Two-stage validation (value-positioning.ts:271-283, 388-423):
1. **Structure validation** — `validatePositioningResult()` checks required fields, types, non-empty arrays
2. **Quality gate** — `validateAndRetry()` with `valuePositioningValidator` enforces specificity and proactive engagement rules

### Empty State Handling
Returns empty result structure (not an error) when no data is available (value-positioning.ts:338-354). Signals this via `signalSummary` object with all availability flags set to false.

### Drive Upload Path
Document uploaded to: `<Customer Drive Folder>/Value Positioning/<Customer Name> - Value Proposition Brief`

Markdown rendered with timestamp, structured sections, and numbered next steps (value-positioning.ts:296-324).

### System Prompt Requirements
System prompt (value-positioning.ts:210-223) enforces:
- Specificity (cite actual data, case numbers, dollar amounts, product names)
- Stakeholder multi-threading (2-3 engagement paths from account team data)
- Dollar amounts in next steps (from pipeline data)
- Specific deadlines (BY WHEN) for every action
- Grounding rules via `GROUNDING_RULES_BLOCK`
