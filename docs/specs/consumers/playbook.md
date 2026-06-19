---
doc-type: reference
status: active
owner: jason
updated: 2026-06-19
---

# Consumer Spec: Playbook

**Contract version:** v1.0
**Consumer type:** Customer Engagement Playbook (auto-generated + meeting note ingestion)
**Source file:** `src/playbook-generator.ts`
**Quality validator:** `src/quality-validators/playbook-validator.ts`

---

## Delivery Channels

| Channel | Endpoint | Consumer |
|---------|----------|----------|
| UI | `GET /api/customer/:name/playbook` | `playbook-routes.ts` |
| UI + Drive | `POST /api/customer/:name/playbook/generate` | `playbook-generator.ts` |
| Drive publish | `POST /api/customer/:name/playbook/publish` | `playbook-routes.ts` |

---

## Required Sections

### Narrative Sections (Gemini-generated)

| Section | Required? | Source | Notes |
|---------|-----------|--------|-------|
| strategicPosition | YES (>= 100 chars) | Gemini synthesis from signals, subscriptions, intelligence | 4-6 bullets: why customer matters, where Red Hat fits |
| keyRelationships | YES (>= 50 chars) | Gemini synthesis + getAccountTeam() + partners.json | Two markdown tables: Red Hat team + Certified Partners |
| currentPriorities | YES (>= 50 chars) | Gemini synthesis from signals | 4-6 bullets citing specific signals or data points |
| productAlignment | YES (>= 1 product) | Gemini synthesis + deterministic enrichment | Per-product: confidence (HIGH/MEDIUM/LOW), useCase, proofPoints, lifecycle, dashboardLink |
| expansionOpportunities | YES (non-empty) | Gemini synthesis from expansion analysis + value maps | 3-5 bullets with confidence, signal, and business value metrics |
| renewalsAndRisk | YES (non-empty) | Gemini synthesis from subscriptions + cases | Lead with renewal dates, then 3-4 risk factor bullets |
| swotAnalysis | YES (>= 100 chars) | Gemini synthesis | SWOT of the Red Hat relationship: Strengths, Weaknesses, Opportunities, Threats |
| meddpicc | YES (exactly 8 entries) | Gemini synthesis | MEDDPICC qualification: M, E, D1, D2, P, I, C1, C2 with status + evidence |

**Quality validator threshold:** 75

### Deterministic Sections (injected post-Gemini)

| Section | Source | Notes |
|---------|--------|-------|
| subscriptions | SF bookings sheet via readSheetCache() | SKU, quantity, status, dates |
| cases | fetchCases() filtered by customer | Case number, summary, status, severity, daysOpen |
| lifecycle | readProductLifecycleCache() | Per-product version, GA/EOL dates |
| teamMembers | getAccountTeam(customer) | Named team with roles |
| solutionPlays | templateAll() structured output | ADR-031 single data path |

### Empty-by-default Sections

| Section | Notes |
|---------|-------|
| openActionItems | Populated by meeting note ingestion |
| engagementHistory | Populated by meeting note ingestion |

---

## Mission Alignment Requirements

Playbook narrative sections MUST:

- **MA-1 Mission connection:** Every section helps the AE walk into a room with evidence connecting customer tech to business objectives
- **MA-2 Evidence chains:** Product alignment entries tie to SPECIFIC customer initiatives, not generic value props
- **MA-4 Dollar connection:** Expansion opportunities include business value metrics from value maps (e.g., "30% improvement in security staff productivity")
- **MA-5 Multi-threading:** keyRelationships identifies full Red Hat account team + certified partners
- **MA-7 Actionable output:** MEDDPICC qualification + SWOT drives next-step decisions

---

## Technical Compliance

- **TC-1:** `// @consumer-contract v1.0` declaration in source file
- **TC-2:** `loadCustomerSignals(slug, name, { ensureFresh: true })` called before generation
- **TC-3:** `templateAll(signals, team, { format: 'playbook' })` called for deterministic sections
- **TC-5:** `validateAndRetry()` wraps Gemini output before writing to disk
- **TC-7:** `getAccountTeam(customer)` + `toPromptContext(team)` for named stakeholders

---

## Testing

- **Architecture compliance:** File in CONSUMER_FILES list in `architecture-compliance.test.ts`
- **Validator unit test:** Covered by `playbook-validator.ts` validate() function
- **API regression:** Covered by existing playbook API tests in `test/api/`

---

## Implementation Notes

The playbook combines two generation paths:

1. **Auto-generation:** `generatePlaybook(customer)` loads all data sources, calls Gemini for 8 narrative sections with structured JSON schema, then injects deterministic data (proof points, lifecycle, dashboard links) post-Gemini. Quality gate (`validateAndRetry` with `playbookValidator`) validates the assembled PlaybookState and retries Gemini on failure.

2. **Meeting note ingestion:** `ingestMeetingNotes(existing, noteContent, docUrl)` merges new meeting notes into an existing playbook via Gemini, extracts action items, adds engagement history entries, and updates MEDDPICC fields with new evidence.

Both paths write the final PlaybookState atomically via `writePlaybook()`.
