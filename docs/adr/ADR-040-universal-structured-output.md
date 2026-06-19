---
doc-type: adr
status: proposed
owner: serena
updated: 2026-06-19
---

# ADR-040: Universal Structured Output Contract for Gemini Consumers

**Date:** 2026-06-19
**References:** ADR-023 (callGemini standardization), ADR-024 (quality gate), ADR-031 (template engine unification), PRINCIPLES.md (Three-Layer Architecture), Consumer Contract v1.0
**Deciders:** Serena Blackwood (architecture), Rayford (DA)
**Trigger:** Consumer contract convergence (#848) — Campaign stuck at B despite 101 signals across 23 sources. Root cause: freeform markdown generation at temperature 0.7 with no schema constraints allows Gemini to fabricate metrics and ignore pipeline data.

## Status

Proposed

## Context

### The Problem: Freeform Generation Enables Hallucination

9 consumers call Gemini for content generation. Their configurations vary widely:

| Consumer | responseSchema | Temperature | Structured data usage | Council Grade |
|----------|:-:|:-:|---|:-:|
| Customer Detail (customer.ts) | Yes | config (0.7 default) | — | A- |
| Brief Pipeline (brief-pipeline.ts) | Yes | config (0.7 default) | — | A- |
| Playbook (playbook-generator.ts) | Yes | 0.2-0.3 | Uses `templateAll().structured` | A- |
| Campaign (campaign-service.ts) | **No** | **0.7** | Ignores `structured` | **B** |
| Meeting Prep full (meeting-prep-service.ts) | **No** | implicit default | Ignores `structured` | — |
| Meeting Prep brief (meeting-prep-service.ts) | **No** | implicit default | Ignores `structured` | — |
| Account Plan (account-plan.ts) | **No** | **0.7** | Ignores `structured` | — |
| Morning Summary (dashboard-service.ts) | **No** | 0.4 | Ignores `structured` | — |
| Value Positioning (value-positioning.ts) | **No** | 0.5 | Ignores `structured` | — |

The pattern is clear: the three consumers that use responseSchema (Customer Detail, Brief Pipeline, Playbook) all scored A- in council grading. The six consumers without responseSchema produce output with varying degrees of hallucination, fabricated metrics, and ignored data.

Campaign is the sharpest case. With 101 signals across 23 sources loaded via `templateAll()`, including verified customer wins and real pipeline data in `structured.solutionPlays`, Gemini at temperature 0.7 still fabricated peer proof metrics and ignored pipeline dollars. The data was there. The model chose to invent instead of cite because nothing constrained it to cite.

### Why Prompt Engineering Alone Cannot Fix This

Five rounds of prompt refinement on Campaign did not fix the fundamental issue. Prompts that say "only use data from the context" are advisory — the model can still generate text that looks like it came from context but was fabricated. `responseSchema` with per-field descriptions is structural — the model MUST populate each defined field, and fields marked `nullable: true` force an explicit `null` instead of fabrication when data is absent.

Google's own Gemini 3 prompting guide recommends this exact pattern: "Rely ONLY on facts directly mentioned in the provided context. If the exact data is not in the context, state null." Combined with responseSchema's `nullable: true`, this creates a mechanical constraint: the model fills the field from context or produces null. There is no third option.

### The `structured` Data Gap

ADR-031 added `templateAll().structured.solutionPlays` which includes:
- `customerWins[]` — verified customer success stories from SalesHub
- `realWorldExamples[]` — peer proof points with measurable outcomes
- `extractedMetrics[]` — quantified results (cost savings, time reductions)

This is exactly the data Campaign needs to cite instead of fabricate. But 7 of 9 consumers never serialize `structured` into their Gemini prompt. The data flows through `templateAll()`, gets returned, and is discarded.

### Hard Constraints

1. **Approved models:** `gemini-2.5-pro` and `gemini-2.5-flash` only (org policy)
2. **Grounding + responseSchema incompatible:** Issue #425 guard in `callGemini()` — when both are set, responseSchema is dropped. Two-pass pattern required for consumers needing both.
3. **Variable-length output:** Campaign generates 6 emails (3 exec 90 words, 3 manager 200-250 words). Schema must handle arrays of variable-length items.
4. **Intentional signal filtering:** Campaign filters by product, Meeting Prep filters by attendee — signal drop detection must distinguish intentional filtering from data loss.
5. **Markdown-producing consumers:** Playbook, Account Plan, and some Meeting Prep sections produce long-form markdown. Schema must accommodate free-text fields within structure.

## Decision

### Three-Part Contract: Schema + Grounding Instruction + Temperature Ceiling

Every consumer that calls Gemini for content generation MUST use all three mechanisms. They are complementary, not alternatives.

#### Part 1: responseSchema (Structural Constraint)

Every consumer MUST define a `responseSchema` that matches its output structure. The schema enforces:

1. **Explicit field definitions** — every section the consumer needs is a named field in the schema
2. **Field-level descriptions** — each field's `description` tells Gemini WHERE to find the data: "Populate from the customer wins in the solution plays section. If no verified wins exist for this customer, set to null."
3. **`nullable: true` on every field that might lack data** — forces explicit null instead of fabrication
4. **`type: "array"` with `items` schema** for variable-length sections (emails, talking points, action items)

**Schema design principle for markdown-producing consumers:** Use `type: "string"` for fields that contain markdown content. The schema constrains WHAT sections exist and which CAN be null. The markdown within each field is free-text. This gives structural guarantees (all sections present, empty when no data) without constraining prose style.

Example for a markdown-heavy consumer like Account Plan:
```typescript
const ACCOUNT_PLAN_SCHEMA = {
  type: "object",
  properties: {
    executiveSummary: {
      type: "string", nullable: true,
      description: "2-3 paragraph strategic summary. Cite specific revenue figures from pipeline data and renewal dates from subscription data. If no pipeline data exists, state null."
    },
    whitespaceMap: {
      type: "string", nullable: true,
      description: "Markdown table: Business Units (rows) x Red Hat products (cols). Populate from subscription and tech stack signals. Use opportunity levels from solution plays confidence scores."
    },
    initiatives: {
      type: "array",
      items: {
        type: "object",
        properties: {
          objective: { type: "string", description: "Customer business objective from intelligence data" },
          solution: { type: "string", description: "Red Hat solution from solution plays. Must reference a specific play name." },
          estimatedDealSize: { type: "string", nullable: true, description: "From pipeline data. If no matching opportunity, state null." },
          timeline: { type: "string", nullable: true },
          nextSteps: { type: "string" }
        },
        required: ["objective", "solution", "nextSteps"]
      }
    }
  },
  required: ["executiveSummary", "whitespaceMap", "initiatives"]
}
```

**What this pattern achieves:** The model must either cite the specific data referenced in field descriptions or produce null. There is no room for "approximately $2M based on industry benchmarks" when the description says "From pipeline data. If no matching opportunity, state null."

#### Part 2: Strict Grounding Instruction (Prompt Constraint)

Every consumer's system prompt MUST include this grounding block (verbatim, not paraphrased):

```
## GROUNDING RULES (MANDATORY — ZERO EXCEPTIONS)
1. Every claim, metric, dollar amount, date, and name MUST come from the provided context.
2. If the context does not contain a specific data point, set the field to null.
3. Never extrapolate, estimate, or generate plausible-sounding data.
4. When citing a customer win or metric, include the source (e.g., "per SalesHub play: [play name]").
5. Peer comparisons MUST cite a named customer win from the solution plays data. Generic "industry peers" references are prohibited.
```

This grounding instruction is distinct from Google Search grounding (the `tools: [{ google_search: {} }]` option). Google Search grounding anchors to web results — this anchors to prompt context. They serve different purposes. A consumer can use both (via the two-pass pattern from #425) or just the prompt-level grounding instruction.

#### Part 3: Temperature Ceiling at 0.3

**Decision: Temperature ceiling of 0.3 for all consumers.** Not 0.1.

Rationale:
- 0.0 produces flat, repetitive output that sounds robotic — unacceptable for sales-facing content
- 0.1 is marginally better but still produces noticeable repetition across multiple sections
- 0.3 provides enough variation for natural-sounding prose while constraining fabrication
- The Playbook generator (highest-graded consumer) already uses 0.2-0.3 — this is a proven working range
- The Brief Pipeline uses `briefSynthesisTemperature` defaulting to 0.7 — this needs to decrease

**Current vs. required temperatures:**

| Consumer | Current | Required | Change |
|----------|:-------:|:--------:|:------:|
| Customer Detail | config (0.7) | 0.3 | Yes |
| Brief Pipeline | config (0.7) | 0.3 | Yes |
| Playbook | 0.2-0.3 | 0.2-0.3 | No |
| Campaign | 0.7 | 0.3 | Yes |
| Meeting Prep | default | 0.3 | Yes |
| Account Plan | 0.7 | 0.3 | Yes |
| Morning Summary | 0.4 | 0.3 | Yes |
| Value Positioning | 0.5 | 0.3 | Yes |

The `briefSynthesisTemperature` config field in `ai-config.ts` should have its default changed from 0.7 to 0.3. The config override mechanism remains — if a specific consumer needs exploration (e.g., a future creative-writing consumer), it can be set per-consumer.

### How `structured` Data Flows into the Schema

**Decision: Serialize `structured.solutionPlays` into the user prompt as a named section, with field descriptions in the schema pointing to it.**

This is a two-part mechanism:

**Step 1 — Prompt serialization:** Every consumer that calls `templateAll()` and receives `structured.solutionPlays` MUST serialize the plays into the Gemini user prompt as a dedicated section:

```
## VERIFIED SOLUTION PLAYS (Source: SalesHub — cite these, do not fabricate alternatives)

### Play: "Ansible Tower to AAP Migration"
- TDP: Network Automation
- Confidence: HIGH
- Customer Wins: ["Acme Corp reduced deployment time by 60%", "Beta Inc consolidated 3 tools into 1"]
- Real-World Examples: ["Fortune 500 manufacturer saved $1.2M annually"]
- Extracted Metrics: ["60% faster deployments", "$1.2M annual savings"]
- Talk Track: "Your current Ansible Tower 3.8 reaches EOL in Q1. The migration path..."
- Assets: [{ name: "AAP Migration Guide", url: "https://..." }]
```

**Step 2 — Schema field descriptions reference the section:** Schema field descriptions tell Gemini to cite from this section:

```typescript
peerProof: {
  type: "string", nullable: true,
  description: "Cite a specific customer win from the VERIFIED SOLUTION PLAYS section. Use the exact name and metric. If no matching play exists, set to null."
}
```

**Why this approach over embedding structured data in the schema itself:** responseSchema defines the OUTPUT shape, not the INPUT. Gemini reads the prompt for context and fills the schema fields. Putting solution play data into the schema itself would conflate input and output. The clean separation: prompt carries the facts, schema constrains the output, field descriptions bridge them.

### Signal Drop Detection

**Decision: Log-based detection with intentional-filter allowlist.**

After every consumer generates output, a signal coverage check runs:

```typescript
interface SignalCoverageReport {
  totalSignalsProvided: number        // signals that entered the prompt
  totalFieldsPopulated: number        // non-null fields in the schema output
  totalFieldsNull: number             // null fields in the schema output
  nullFieldNames: string[]            // which fields were null
  signalSourcesMissed: string[]       // signal source modules not cited in output
  coveragePercent: number             // populated / (populated + null) * 100
  intentionalFilters: string[]        // filters applied (e.g., "product:AAP", "attendee:VP Eng")
}
```

The check:
1. Counts non-null vs null fields in the schema output
2. Compares signal source modules in the prompt against citations in the output
3. Logs a WARNING (not error) when `coveragePercent < 50%` AND no intentional filters are active
4. If intentional filters ARE active (campaign product filter, meeting prep attendee filter), adjusts the baseline — coverage is measured against the filtered signal set, not the total

This is observability, not a hard gate. The quality validator (ADR-024) remains the hard gate. Signal coverage logging identifies patterns — "Campaign always drops tech stack signals" — that inform prompt and schema improvements over time.

**No new hard gate:** Adding a coverage threshold as a pass/fail gate would create false failures for consumers that legitimately filter signals. The ADR-024 quality validator already catches structural problems (empty sections, missing content). Signal coverage is a diagnostic tool, not a blocker.

### Phased Rollout

**Decision: Phased, not all-at-once.**

Rationale: All-at-once risks breaking working consumers while fixing broken ones. The three A- consumers (Customer Detail, Brief Pipeline, Playbook) already work. Changing their temperature or adding grounding instructions could degrade proven quality. Phase by impact.

#### Phase 1: Campaign (highest impact, currently broken)
**Files:** `src/campaign-service.ts`
**Changes:**
1. Add `CAMPAIGN_RESPONSE_SCHEMA` with per-email structure, `nullable: true` on peer proof fields
2. Add grounding instruction block to system prompt
3. Lower temperature from 0.7 to 0.3
4. Serialize `templateAll().structured.solutionPlays` into user prompt
5. Add signal coverage logging
6. Update `campaign-validator.ts` to check for null-vs-fabricated (peer proof fields should be null or a verbatim citation, never a generic claim)

**Verification:** Generate campaign for customer with known SalesHub data. Verify: (a) peer proof cites exact customer win names, (b) pipeline dollars match actual pipeline data, (c) null where no data exists. Generate for customer without SalesHub data. Verify: peer proof is null, not fabricated.

#### Phase 2: Account Plan + Meeting Prep (next highest impact)
**Files:** `src/account-plan.ts`, `src/meeting-prep-service.ts`
**Changes:**
1. Define responseSchema for Account Plan (all 12 required sections as fields)
2. Define responseSchema for Meeting Prep (attendee profiles, talking points, agenda as structured arrays)
3. Add grounding instructions to both
4. Lower Account Plan temperature from 0.7 to 0.3
5. Lower Meeting Prep to 0.3
6. Serialize `structured.solutionPlays` into both prompts
7. Add signal coverage logging

**Note on Meeting Prep:** Meeting Prep uses a multi-step generation (attendee research, partner research, synthesis). The responseSchema applies to the final synthesis step. Attendee research calls use a different schema specific to profile extraction. This is fine — the contract applies per-call, not per-consumer.

#### Phase 3: Value Positioning + Morning Summary + Dashboard (lower priority)
**Files:** `src/value-positioning.ts`, `src/dashboard-service.ts`
**Changes:**
1. Define responseSchema for each
2. Add grounding instructions
3. Lower Value Positioning from 0.5 to 0.3
4. Lower Morning Summary from 0.4 to 0.3

#### Phase 4: Retrofit existing A- consumers (defensive hardening)
**Files:** `src/customer.ts`, `src/brief-pipeline.ts`
**Changes:**
1. Add grounding instruction block (they already have responseSchema)
2. Lower `briefSynthesisTemperature` default from 0.7 to 0.3
3. Add signal coverage logging
4. Serialize `structured.solutionPlays` into brief prompt

**Why last:** These already work. Adding grounding instructions and lowering temperature is defensive. Do it after the broken consumers are fixed and the pattern is proven.

### Two-Pass Pattern for Consumers Needing Google Search Grounding

`account-intelligence.ts` currently uses `callGeminiGrounded()` which enables Google Search grounding. This consumer cannot use responseSchema in the same call (issue #425). The two-pass pattern:

1. **Pass 1 (grounded):** Call Gemini with `grounding: true`, no responseSchema. Get freeform research results.
2. **Pass 2 (structured):** Call Gemini with responseSchema, no grounding. Feed the Pass 1 output as context. Get structured, constrained output.

This pattern is already implemented for `account-intelligence.ts` (line 176: "Two-pass pattern (issue #425)"). No change needed there. Other consumers do NOT need Google Search grounding — they operate on cached local data, not web research.

### What This Does NOT Do

- Does NOT modify `callGemini()` or `gemini-call.ts` — the wrapper already supports responseSchema
- Does NOT remove the #425 guard — grounding + responseSchema remain incompatible at the API level
- Does NOT change the 10 council-validated campaign email rules — those are content guidelines, not structural constraints
- Does NOT change ADR-023 or ADR-024 — extends them
- Does NOT change the ADR-031 template engine — uses its `structured` output as designed
- Does NOT add a hard coverage gate — signal coverage is diagnostic logging only

## Consequences

**Positive:**
- **Eliminates fabrication structurally.** `nullable: true` + field descriptions create a mechanical constraint: cite data or null. No room for fabricated metrics.
- **`structured.solutionPlays` data reaches consumers.** Verified customer wins and real metrics flow from SalesHub through template engine into Gemini prompts where they can be cited.
- **Temperature alignment.** All consumers at 0.3 or below matches the proven Playbook pattern (A- grade).
- **Signal coverage logging.** First-time visibility into which signals Gemini uses vs ignores. Informs future prompt improvements.
- **Phased rollout.** Campaign (most broken) fixed first. Working consumers hardened last. Minimal risk to production quality.
- **Extends existing ADRs.** Uses `callGemini()`'s responseSchema support (ADR-023), quality validators (ADR-024), and `templateAll().structured` (ADR-031) as designed.

**Negative:**
- **responseSchema adds prompt size.** Schema definitions increase request token count by ~200-500 tokens per consumer. Negligible against the 2000-8000 token prompts.
- **Long-form markdown in schema fields.** For Account Plan and Playbook, individual fields may contain 500+ words of markdown. This works (Gemini handles it) but makes the schema verbose.
- **Temperature 0.3 may reduce stylistic variety.** Outputs across consumers will sound more similar in tone. Mitigation: this is a feature for sales content — consistency builds trust.
- **Migration effort.** 6 consumers need responseSchema definitions, grounding instructions, temperature changes, and structured data serialization. ~4-6 hours of Marcus work across 4 phases.

**Risks:**
- **responseSchema timeout.** The TIMEOUT_STRUCTURED constant in `callGemini()` is 30s. Complex schemas with many array fields may need more time. Mitigation: consumers can override with `timeoutMs: 120000` for schemas with >10 fields. Monitor latency in Phase 1.
- **Existing quality validators may need updates.** Current validators check for markdown patterns (regex for headers, section counting). With responseSchema, output is JSON. Validators must be updated to parse JSON and check field contents. This is part of each phase.
- **Two consumers (Campaign, Meeting Prep) have complex multi-step generation.** Applying responseSchema to the final synthesis step is straightforward. But if intermediate steps also fabricate, the final schema can only constrain the final output. Mitigation: intermediate steps for Campaign are product filtering (deterministic) and signal assembly (from `templateAll()`). Only the final Gemini call generates prose — that is where the schema applies.
- **`briefSynthesisTemperature` config override.** Users who have manually set this to a higher value in `data-sources.json` will keep their override. The default change from 0.7 to 0.3 only affects fresh installs and users who haven't customized it. This is correct behavior — the config override exists for a reason.

## PRINCIPLES.md Update

### New Pre-flight Question (add as #20)

**20. Does this consumer use responseSchema with strict grounding? (ADR-040)**
Every consumer that calls Gemini for content generation MUST use `responseSchema` with `nullable: true` on data-dependent fields, a strict grounding instruction block in the system prompt, and `temperature <= 0.3`. Field descriptions must reference specific data sections in the prompt (e.g., "Cite from VERIFIED SOLUTION PLAYS section"). Consumers that need Google Search grounding use the two-pass pattern: grounded call for research, structured call for output.

### New Anti-patterns (add to Anti-patterns list)

- Calling Gemini for content generation without `responseSchema` (ADR-040) — freeform output allows fabrication. Every consumer must define a schema with `nullable: true` on fields that might lack data.
- Temperature above 0.3 for content generation (ADR-040) — higher temperatures increase fabrication probability. Maximum 0.3 for all consumer calls. Creative exploration calls (future) may override via explicit config.
- Ignoring `templateAll().structured.solutionPlays` in consumer prompts (ADR-040) — verified customer wins and real metrics must be serialized into the Gemini prompt as a citable section. Discarding structured data forces Gemini to fabricate what it could cite.
- Using generic peer references instead of verified customer wins (ADR-040) — "industry peers report 30% improvement" is fabrication. "Acme Corp reduced deployment time by 60% (per SalesHub play: Network Automation)" is citation. Schema field descriptions enforce this.

### Consumer Contract Update (add to TC section in consumer-contract.md)

**TC-8: Structured Output (ADR-040)**
Every consumer that calls Gemini MUST use `responseSchema` with `nullable: true` on data-dependent fields. System prompt MUST include the mandatory grounding instruction block. Temperature MUST be <= 0.3. Test assertion: grep consumer for `responseSchema` usage in every `callGemini()` call; grep for grounding instruction block; grep for temperature value.

### Cross-reference index update (add row to table)

| Pre-flight # | ADR | Question |
|---|---|---|
| 20 | ADR-040 | Consumer responseSchema + grounding instruction + temperature ceiling |

## Alternatives Considered

### Alternative 1: Two-Pass Pattern for All Consumers (Extract Facts, Then Generate)

Call Gemini twice: first to extract structured facts from context, then to generate prose from the extracted facts.

**Rejected because:** Doubles Gemini cost for every consumer. The responseSchema + grounding instruction pattern achieves the same constraint in a single pass. The two-pass pattern is reserved for consumers that genuinely need Google Search grounding (which is incompatible with responseSchema) — currently only `account-intelligence.ts`.

### Alternative 2: Google Search Grounding for Prompt Context

Use `tools: [{ google_search: {} }]` to ground outputs.

**Rejected because:** Google Search grounding anchors to web results, not prompt context. The problem is not "Gemini doesn't know about Red Hat products" (web search would help). The problem is "Gemini fabricates metrics instead of citing the pipeline data already in the prompt" (web search is irrelevant). Prompt-level grounding instructions constrain citation to prompt context specifically.

### Alternative 3: thinkingBudget Increase

Increase thinkingBudget to improve reasoning about context.

**Rejected because:** thinkingBudget controls reasoning depth for complex problems, not factual fidelity. A model that "thinks harder" about fabricating metrics still fabricates metrics. The constraint must be structural (schema + grounding instruction), not reasoning-based.

### Alternative 4: Temperature 0.1 for All Consumers

Use 0.1 instead of 0.3 to minimize hallucination.

**Rejected because:** At 0.1, outputs across multiple sections become noticeably repetitive in sentence structure and phrasing. Sales content must sound natural and varied to build trust. 0.3 provides the constraint without the roboticness. The Playbook generator's proven 0.2-0.3 range validates this ceiling.

### Alternative 5: Prompt Engineering Only (No Schema)

More prompt iterations with stronger "cite only" instructions.

**Rejected because:** Five rounds already attempted on Campaign. Prompt instructions are advisory — Gemini can still produce text that looks like it came from context but was fabricated. responseSchema with `nullable: true` is structural — the model must populate or null each field. "Don't fabricate" vs "you literally cannot fabricate" is the difference.

## Implementation Brief for Marcus

### Phase 1: Campaign (highest priority)

**Files to modify (ONLY these):**
1. `src/campaign-service.ts` — add responseSchema, grounding instruction, lower temperature, serialize structured plays
2. `src/quality-validators/campaign-validator.ts` — update to validate JSON output instead of markdown

**Campaign Schema Design:**
```typescript
const CAMPAIGN_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    executiveEmails: {
      type: "array",
      items: {
        type: "object",
        properties: {
          recipientRole: { type: "string", description: "Executive role (CTO, VP Engineering, etc.)" },
          subject: { type: "string", description: "Email subject line — reference a specific customer situation, not generic" },
          body: { type: "string", description: "Email body, 90 words max. Must reference a specific business problem from the customer intelligence." },
          peerProof: { type: "string", nullable: true, description: "Cite a specific customer win from VERIFIED SOLUTION PLAYS. Use exact company name and metric. If no matching play, set null." },
          ctaLink: { type: "string", nullable: true, description: "Link to a specific asset from the solution plays linkedAssets. If none, set null." }
        },
        required: ["recipientRole", "subject", "body"]
      },
      description: "Exactly 3 executive-level emails, 90 words max each"
    },
    managerEmails: {
      type: "array",
      items: {
        type: "object",
        properties: {
          recipientRole: { type: "string" },
          subject: { type: "string" },
          body: { type: "string", description: "Email body, 200-250 words. Must connect to customer tech stack or pipeline data." },
          peerProof: { type: "string", nullable: true, description: "Cite a specific customer win from VERIFIED SOLUTION PLAYS. Use exact company name and metric. If no matching play, set null." },
          ctaLink: { type: "string", nullable: true, description: "Link to a specific asset from the solution plays linkedAssets. If none, set null." },
          techConnection: { type: "string", nullable: true, description: "Reference a specific technology from the customer's tech stack data. If no tech stack data, set null." }
        },
        required: ["recipientRole", "subject", "body"]
      },
      description: "Exactly 3 manager-level emails, 200-250 words each"
    }
  },
  required: ["executiveEmails", "managerEmails"]
}
```

**Acceptance Criteria:**
1. `campaign-service.ts` passes `responseSchema: CAMPAIGN_RESPONSE_SCHEMA` to `callGemini()` — verify with `grep -n 'responseSchema' src/campaign-service.ts`
2. System prompt in `campaign-service.ts` contains the verbatim grounding instruction block — verify with `grep -c 'GROUNDING RULES' src/campaign-service.ts` returning 1
3. Temperature set to 0.3 — verify with `grep 'temperature.*0.3' src/campaign-service.ts`
4. `templateAll().structured.solutionPlays` serialized into the user prompt — verify with `grep 'structured.solutionPlays\|solutionPlays' src/campaign-service.ts`
5. `campaign-validator.ts` updated to parse JSON output and check `peerProof` fields are null or contain a specific company name — verify with `grep 'peerProof' src/quality-validators/campaign-validator.ts`
6. Generate campaign for customer WITH SalesHub play data — peerProof fields cite exact play names, not fabricated metrics
7. Generate campaign for customer WITHOUT SalesHub play data — peerProof fields are null, not fabricated
8. `bun test --isolate test/unit/` passes with 0 failures
9. All 10 council-validated campaign email rules are preserved (verify they are still in the system prompt)

**Timeout note:** Campaign schema has ~10 fields across 6 emails. Default `TIMEOUT_STRUCTURED` is 30s. Campaign currently uses `long-form` timeout tier (180s). Override with `timeoutMs: 120000` since schema-constrained output is faster than freeform but campaign is multi-email.

### Phases 2-4: See rollout plan above for file paths, changes, and sequence.

## References

- GitHub #848 (Consumer contract convergence)
- GitHub #425 (Grounding + responseSchema incompatibility)
- ADR-023 (callGemini standardization — responseSchema support)
- ADR-024 (Quality gate — validator pattern)
- ADR-031 (Template engine — structured.solutionPlays)
- Consumer Contract v1.0 (`docs/specs/consumer-contract.md`)
- Google Gemini 3 Prompting Guide (nullable + field descriptions pattern)
- `src/gemini-call.ts` lines 223-240 (grounding/schema guard)
- `src/lib/templates/index.ts` lines 166-218 (structured.solutionPlays assembly)
