---
doc-type: reference
status: active
owner: jason
updated: 2026-06-19
---

# Consumer Spec: Meeting Prep

**Contract version:** v1.0
**Consumer type:** Pre-meeting intelligence brief + full meeting prep document
**Source files:** `src/lib/meeting-prep-intelligence.ts` (instant brief), `src/meeting-prep-service.ts` (full prep)
**Quality validators:** `src/quality-validators/meeting-prep-brief-validator.ts` (instant brief), `src/quality-validators/meeting-prep-validator.ts` (full prep)

---

## Delivery Channels

| Channel | Endpoint | Consumer |
|---------|----------|----------|
| UI (instant brief) | `GET /api/customer/:name/meeting-prep-brief` | `meeting-prep-intelligence.ts` |
| UI + Drive (full prep) | `POST /api/customer/:name/meeting-prep/generate` | `meeting-prep-service.ts` |

---

## Required Sections

### Instant Brief (`meeting-prep-intelligence.ts`)

| Section | Required? | Source | Notes |
|---------|-----------|--------|-------|
| talkingPoints | YES (exactly 3) | Gemini synthesis from scored tactics + templateAll context | Must follow evidence chain: situation -> impact -> solution -> outcome |
| challengerInsight | YES | Gemini synthesis | Industry benchmark, competitive gap, or tech stack insight the customer may not know |
| recentChanges | YES | Graph diff | Top 8 recent intelligence changes with timestamps |
| topEvidence | YES | Scored tactics evidence trail | Top 8 evidence facts with recency |
| materials | YES | Material index from top tactics | Up to 6 relevant materials with URLs |
| stakeholderPaths | YES (>= 2) | Account team minus self | Multi-threading: who to engage, in what role, for what reason |
| accountTeam | YES | getAccountTeam() | Named team members with roles |
| signalDensity | YES | Graph node types | Populated vs total signal types |
| qualityScore | CONDITIONAL | validateAndRetry scorecard | Present when quality gate runs |

**Minimum content depth:** 30 words per talking point
**Quality validator threshold:** 80

### Full Meeting Prep (`meeting-prep-service.ts`)

| Section | Required? | Source | Notes |
|---------|-----------|--------|-------|
| Meeting Objective | YES | Gemini synthesis | 1-5 lines, >= 50 chars |
| Who's in the Room | YES | Attendee profiles + account team | Attendee details with roles |
| Recent Interactions | YES | Engagement history | >= 2 bullet points |
| Value Play | YES | Gemini synthesis | Narrative, no tables, >= 50 chars |
| Discussion Questions | YES | Gemini synthesis | >= 5 items with attendee names |
| Open Items | CONDITIONAL | Carry-forward context | Present when relevant |
| Pipeline Opportunities | RECOMMENDED | Pipeline signals | >= 1 item |
| Action Items | YES | Gemini synthesis | >= 3 items with names and dates |

**Quality validator threshold:** 75

---

## Mission Alignment Requirements

All talking points in the instant brief MUST:

- **MA-2 Evidence chains:** [Customer situation] -> [Business impact] -> [Red Hat solution] -> [Measurable outcome]
- **MA-3 WHO/WHAT/BY WHEN:** Each talking point names who to ask, what to say, and by when
- **MA-4 Dollar connection:** At least 1 talking point connects to a dollar figure (pipeline, renewal, expansion, savings)
- **MA-5 Multi-threading:** stakeholderPaths identifies 2-3 engagement paths beyond the ASA
- **MA-6 Challenger insight:** One insight the customer may not know about their business/industry

---

## Technical Compliance

- **TC-1:** `// @consumer-contract v1.0` declaration in both source files
- **TC-2:** `loadCustomerSignals(slug, name, { ensureFresh: true })` called before generation
- **TC-3:** `templateAll(signals, team, { format: 'meeting-prep' })` called for deterministic sections
- **TC-5:** `validateAndRetry()` wraps Gemini output before returning
- **TC-7:** `getAccountTeam(customer)` + `toPromptContext(team)` for named stakeholders

---

## Testing

- **Architecture compliance:** Both files in CONSUMER_FILES list in `architecture-compliance.test.ts`
- **Validator unit test:** `test/unit/meeting-prep-brief-validator.test.ts` — passes good output, fails bad output
- **API regression:** Covered by existing meeting prep API tests

---

## Implementation Notes

The instant brief combines two data paths:
1. **Graph-based tactics:** Intelligence graph -> tactic scoring -> evidence trail (for specificity)
2. **Signal-based templates:** Registry signals -> templateAll() -> narrativeContext (for breadth)

Both are fed to Gemini as context for the 3 talking points + Challenger insight generation. The quality gate (validateAndRetry) ensures output meets mission alignment requirements before returning.
