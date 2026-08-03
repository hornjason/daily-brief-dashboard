---
doc-type: consumer-spec
status: active
owner: jason
updated: 2026-08-03
---

# Consumer Spec: Account Plan

## Overview
Generates AI-powered account plans for customers by assembling customer intelligence, sample plan templates, playbook guidance, and a questions reference PDF to produce structured account plans via Gemini with multimodal input (text + PDF vision).

## Source Files
- `src/account-plan.ts` — domain logic (Gemini multimodal calls, signal loading, quality gates, Drive delivery)
- `src/account-plans-routes.ts` — thin HTTP adapter (NOT YET CREATED — API endpoints exist but are inline in account-plan.ts or elsewhere)

## Delivery
- **Drive:** Google Doc in customer folder (`Account Plans/` subfolder — separate from Account Intelligence to avoid feedback loops)
- **UI:** AccountPlanPage (NOT VERIFIED — check project map for actual page name)

## API Endpoints
- `POST /api/customer/:name/account-plan/generate` (NOT VERIFIED — check routes file)
- `GET /api/customer/:name/account-plan` (NOT VERIFIED — check routes file)
- `POST /api/customer/:name/account-plan/cy27` — CY27 variant using cy27-planning-deck.txt (NOT VERIFIED)
- `POST /api/customer/:name/midyear-update` — CY27 Midyear Update (5 sections for RHSC) (NOT VERIFIED)

## Required Sections
Full account plan output includes:
1. Executive Summary (scorecard overview)
2. Team Members (AE + ASA names and roles)
3. Scorecard (% scores per category)
4. Customer View (all numbered questions: ACV ambition, ACV goal, growth %, why Red Hat, etc.)
5. Account Intelligence — structured subsections: Executive Summary, Business Objectives/Challenges/Initiatives with IT funding, Market & Competition, Innovation Adopter Persona (Rogers Diffusion)
6. Customer Ecosystem — structured subsections: Executive Summary, Partner Growth Strategy (CY27 Q#4), Cloud Providers with marketplace spend, Committed Spend Agreements, Cloud Adoption Level, Specialized Partners (SIs, MSPs, ISVs, OEMs)
7. Key Stakeholders (names, titles, engagement status, Economic Buyer identification)
8. Technical Landscape — per-TDP assessments (Server/Cloud OS, Virtualization, Container Management, Application Platform, Mission Critical Automation, Red Hat AI) with analysis + maturity rating (1-5), plus Security/Compliance/Sovereignty & Accessibility (Q#16), Key Applications/Workloads, Hardware & Storage
9. Customer Success (health, open cases, risk)
10. Whitespace Map — markdown table mapping Business Units/Functions (rows) × Red Hat products (columns) with opportunity level indicators
11. Initiatives — 3-5 customer-centric initiatives with: Customer Objective, Red Hat Solution, Estimated Deal Size, Timeline, Next Steps, Tagged Opportunity
12. Actions & Next Steps — numbered markdown table with columns: #, Action, Owner, Target Date, Status

## Quality Validator
`src/quality-validators/account-plan-validator.ts` — validates required sections, no placeholder text, content depth, grounding rules compliance.

## TC Compliance

| Requirement | Status |
|---|---|
| @consumer-contract v1.0 | ✅ account-plan.ts:15 |
| ensureFresh | ✅ account-plan.ts:559 `loadCustomerSignals(slug, name, { ensureFresh: true })` |
| templateAll | ✅ account-plan.ts:560 `await templateAll(registrySignals, teamMembers, { format: 'playbook' })` |
| validateAndRetry | ✅ account-plan.ts:617-633 quality gate with accountPlanValidator |
| getAccountTeam | ✅ account-plan.ts:24 import, line 558 `getAccountTeam(customer)` call |
| Drive delivery | ✅ account-plan.ts:241-244 `ensureAccountPlansSubfolder()` + line 656 `upsertAccountPlanDoc()` upload |
| callGemini | ✅ account-plan.ts:26 import, lines 268-277 via `callGeminiForAccountPlan()` wrapper |
| GROUNDING_RULES import | ⚠️ Partial — grounding rules enforced in SYSTEM_PROMPT (lines 203-232) and schema constraints (lines 40-197), but no separate `GROUNDING_RULES` constant import. Rules are inlined in prompts. |

## Notes

- **ADR-040:** Uses structured response schema (ACCOUNT_PLAN_RESPONSE_SCHEMA) and converts JSON response to markdown via `convertAccountPlanJsonToMarkdown()` (lines 282-426)
- **Multimodal input:** Questions PDF as base64 vision input via `callGeminiForAccountPlan()` — Gemini reads questions image while processing text context
- **Quality gate:** Mandatory `validateAndRetry()` with retry on failure (ADR-024 compliance)
- **Signal enrichment:** Uses `templateAll()` deterministic sections for signal context + VERIFIED SOLUTION PLAYS section for grounding (lines 555-579)
- **Separate Drive folder:** Account Plans subfolder prevents feedback loops into brief pipeline (ADR-0016 compliance)
- **CY27 variants:** `generateAccountPlanCY27()` (lines 914-924) and `generateMidyearUpdate()` (lines 772-876) are thin wrappers with different playbook/schema/output
- **Temperature:** Fixed 0.3 for all account plan generation (ADR-040)
- **Routes file missing:** API endpoints exist but routes are likely inlined elsewhere or in a routes file not yet extracted — needs verification against PROJECT-STATE.md

## Gaps

1. **Routes file not extracted:** No dedicated `account-plans-routes.ts` — endpoints may be inlined in main server file or mixed with other routes
2. **GROUNDING_RULES not imported:** Grounding rules are inlined in SYSTEM_PROMPT and schema descriptions rather than imported from a shared constant — means rules could drift if updated in one consumer but not others
3. **UI page reference unverified:** Spec assumes AccountPlanPage exists but this needs verification against actual page structure
