---
doc-type: reference
status: active
owner: jason
updated: 2026-06-18
---

# Consumer Contract v1.0

**Purpose:** Every consumer output must pass this contract before it's production-ready. The contract prevents code drift, enforces quality, and ensures every output serves the application mission.

**Mission test:** "Does this help Jason walk into a room with a solution that connects to a business problem?" If it only shows data without connecting to a conversation, it's not done.

**Enforcement:** `test/unit/architecture-compliance.test.ts` + per-consumer API regression tests + Playwright UI tests.

---

## Part 1: Mission Alignment (The "Walk Into the Room" Test)

Every consumer output must contain these elements. Outputs that show data without connecting to action FAIL the contract.

### MA-1: Immediate Context Anchor
The output must open with what's happening NOW — not historical summary. Recent cases, upcoming meetings, expiring renewals, new buying signals. If nothing is happening, say so explicitly.

### MA-2: Evidence Chains
Every recommendation must show: `Customer tech/situation → Business problem → Red Hat solution → Measurable outcome`. No recommendation without the chain. Example: "They run Ansible Tower 3.8 → upgrade path ending → AAP migration → consolidate automation + reduce licensing."

### MA-3: Actionable Next Steps
Three or fewer concrete steps ranked by deal potential and timing urgency. Each step names: WHO to contact, WHAT to say/do, BY WHEN. Not "discuss their strategy" — "Ask their VP Eng about the Q3 OpenShift rollout before the Sept renewal."

### MA-4: The Money Connection
Every output must connect to a dollar figure: pipeline opportunity, renewal at risk, expansion gap, competitive displacement value. If it can't connect to money, it's not sales intelligence.

### MA-5: Multi-Threading Paths
Outputs must identify 2-3 stakeholders to engage with a reason to reach each one. Deals die when you only talk to one person. Meeting preps especially: who ELSE should be in the room?

### MA-6: Insights the Customer Doesn't Know
At least one "teach them something about their own business" element: peer comparison, industry benchmark, tech stack gap they haven't surfaced, competitive move they're unaware of. Challenger Sale principle.

### MA-7: Honest Empty States
When data is insufficient for a recommendation, say "Insufficient tech stack visibility — suggest discovery call" rather than generic advice. Empty states guide toward intelligence gathering, not fake insights.

---

## Part 2: Technical Compliance

Every consumer source file must comply with these. Enforced by architecture-compliance.test.ts.

### TC-1: Contract Version Declaration
```typescript
// @consumer-contract v1.0
```
First line after imports. Test parses version, fails if missing or < current.

### TC-2: Signal Freshness (ensureFresh)
Consumer MUST call `loadCustomerSignals(slug, name, { ensureFresh: true })` before generation. Test assertion: grep source for `ensureFresh: true` before any `callGemini()` call.

### TC-3: Template Engine (templateAll)
All structured data via `templateAll(signals, team, { format })`. No consumer imports individual template functions. No consumer builds Gemini prompts from raw signal properties. Test assertion: zero imports from `src/lib/templates/*.ts` except `index.ts`.

### TC-4: Quality Validator (ADR-024)
Every consumer that calls Gemini MUST import and call `validateAndRetry()` before caching output. Validator must check:
- Required sections present (section count >= minimum per consumer type)
- No empty sections when data exists (signal count > 0 but section content empty = FAIL)
- No placeholder text ("TBD", "[Insert]", "TODO", "placeholder")
- Minimum content depth (avg words per section >= 50)
- Quality score logged to cache metadata

Test assertion: grep for `callGemini` → verify `validateAndRetry` import in same file.

### TC-5: Gemini Standardization (ADR-023)
All Gemini calls via `callGemini()` wrapper. No direct `@google/generative-ai` imports. Test assertion: zero direct model instantiation in consumer files.

### TC-6: Drive Delivery
Consumer outputs that generate documents MUST upload to Google Drive in the customer's folder with stable subfolder structure. Response includes `driveUrl`. Consumers that only display in the web UI (Customer Brief, Morning Summary) are exempt BUT must declare `delivery: 'ui-only'` in their contract declaration.

### TC-7: Account Team Integration
Consumers generating customer-specific content MUST call `getAccountTeam(customer)` and include team context. No hardcoded names. Test assertion: grep for `getAccountTeam` import in every consumer file.

---

## Part 3: Output Quality Requirements

Per-consumer minimum requirements. Each consumer spec (in `docs/specs/consumers/`) defines its required sections.

### OQ-1: Required Sections
Each consumer declares its required sections in a `CONSUMER_SPEC` export:
```typescript
export const CONSUMER_SPEC = {
  name: 'meeting-prep',
  contractVersion: '1.0',
  delivery: 'drive',
  requiredSections: ['context-anchor', 'attendee-profiles', 'talking-points', 'action-items'],
  minSections: 4,
  minWordsPerSection: 50,
  geminiCalls: true,
  qualityValidator: 'meeting-prep-validator',
}
```

### OQ-2: No Empty Sections When Data Exists
If signals exist for a section (e.g., cases module has records), the section MUST have content. Empty sections when data is available = quality gate FAIL.

### OQ-3: Specificity Requirement
Outputs must reference specific names, dates, dollar amounts, product names — not generic language. Test: output must contain at least 3 of: customer name, a person's name, a dollar amount, a date, a product name.

### OQ-4: Temporal Awareness
Outputs must reference recent events (last 30 days) when they exist. Stale-only content when fresh signals are available = quality gate FAIL.

---

## Part 4: Testing Requirements

### TR-1: API Regression Test
Every consumer endpoint has a Playwright test in `test/api/` that:
- Triggers generation for a known customer
- Verifies response shape matches expected schema
- Verifies required sections are present and non-empty
- Verifies Drive URL is present (if delivery: 'drive')
- Verifies no placeholder text in output

### TR-2: UI Test (where applicable)
Consumers with UI surfaces have Playwright tests in `test/ui-regression.spec.ts` that:
- Generate button triggers generation, shows progress indicator
- Output renders visibly (not hidden behind errors)
- Links are clickable
- Regenerate works and updates content

### TR-3: Quality Validator Test
Each quality validator has a unit test in `test/unit/` that:
- Passes a good output → returns passing score
- Passes a bad output (empty sections, placeholder text) → returns failing score
- Verifies retry is triggered on failure

### TR-4: Architecture Compliance Enforcement
New tests added to `architecture-compliance.test.ts`:
- Every consumer file has `@consumer-contract v1.0` declaration
- Every consumer that imports `callGemini` also imports a quality validator
- Every consumer calls `ensureFresh: true`
- Every consumer with `delivery: 'drive'` has a Drive upload path
- Every consumer imports `getAccountTeam`
- Consumer count matches expected (regression guard against silent removal)

### TR-5: Output Snapshot Test
For one known customer, snapshot the output structure (section names, field presence, markdown headings) and diff on every test run. Catches silent section removal.

---

## Part 5: Per-Consumer Specs

Individual specs live at `docs/specs/consumers/{consumer-name}.md` and define:
- Required sections for this specific consumer
- Minimum content depth per section
- Expected delivery target (Drive folder path, UI route, both)
- Quality validator file
- API endpoint(s)
- UI surface (page, tab, component)
- Test file locations

### Consumer Registry

| # | Consumer | Spec File | Status |
|---|----------|-----------|--------|
| 1 | Customer Brief | `consumers/customer-brief.md` | TODO |
| 2 | Meeting Prep | `consumers/meeting-prep.md` | TODO |
| 3 | Campaigns | `consumers/campaigns.md` | TODO |
| 4 | Playbook | `consumers/playbook.md` | TODO |
| 5 | Account Plan | `consumers/account-plan.md` | TODO |
| 6 | Email Outreach | `consumers/email-outreach.md` | TODO |
| 7 | Morning Summary | `consumers/morning-summary.md` | TODO |
| 8 | EngagementBuilder | `consumers/engagement-builder.md` | TODO |
| 9 | Value Positioning | `consumers/value-positioning.md` | TODO |

---

## Audit Process

For each consumer, the audit follows this sequence:

1. **Read** — Read the consumer source code, understand what it generates
2. **Generate** — Generate a REAL output against a real customer
3. **Review** — Read the full output, check against contract requirements
4. **Identify gaps** — What's missing, thin, broken, or not meeting the contract?
5. **Spec** — Write the per-consumer spec at `docs/specs/consumers/{name}.md`
6. **Fix** — Wire validators, add ensureFresh, upgrade content, fix delivery
7. **Test** — Add API test, UI test, quality validator test, compliance test
8. **Verify** — Generate again, confirm contract compliance
9. **Ship** — Commit, rebuild, Quinn walks it

---

## Contract Governance

- This contract is versioned. Current: v1.0.
- Changes require council review.
- Every consumer must declare its contract version in source.
- architecture-compliance.test.ts fails the build if any consumer is below current version.
- Per-consumer specs are updated when the consumer changes.
- ADR to be written formalizing this contract (ADR-039 or next available).
