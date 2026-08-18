---
doc-type: consumer-spec
status: active
owner: jason
updated: 2026-08-16
audience: EXTERNAL
---

# Consumer Spec: Campaign

## Overview

Generates personalized Red Hat sales campaign emails for a customer based on source material (email subject, campaign directive, or Google Doc/Slides URL) and customer intelligence signals. Output is a Google Doc sent to external customer contacts.

**Audience:** EXTERNAL — emails go directly to customer contacts. All internal data (pipeline $, support cases, subscription counts) must be stripped before output.

## Architecture

**Two-pass generation (ADR-043):**
- **Pass 1:** Gemini (temp 0.3) selects data — recipient names, signal indices, feature keys, peer proofs, challenger data points
- **Pass 2:** Deterministic template assembly — 8 composable blocks, zero LLM in email body

**Dynamic objective correlation (ADR-044):**
- Intelligence pipeline extracts `CustomerObjectiveProfile` with 5 categories (financial, security, operational, innovation, growth)
- Each entry has clean metric, priority, source, confidence
- Profile cached at `data/cache/intelligence/{slug}-objectives.json`

**Deterministic persona-metric selection (ADR-045):**
- Shared `persona-classifier.ts` classifies contacts using `CATEGORY_KEYWORDS` against full profile (title + leadership context + certifications)
- Pre-matches objectives to personas BEFORE Pass 1 — Gemini receives metrics as GIVENs, not choices
- `renderObjectiveBlock()` renders category-aware sentences with threat/solution separation

**Threat/solution separation (ADR-044/045):**
- Campaign directive carries `{ threat, solution }` — derived deterministically from content
- Threat is ALWAYS external (SaaS tax, vendor lock-in) — NEVER a Red Hat product
- Solution is ALWAYS Red Hat's value prop (self-managed automation, unified container platform)

## Source Files

| File | Role |
|------|------|
| `src/campaigns-routes.ts` | Thin HTTP adapter |
| `src/campaign-service.ts` | Domain logic — Gemini prompts, signal loading, material extraction, threat/solution derivation |
| `src/campaign-html-template.ts` | Pass 2 template engine — 8 email blocks, metrics table, HTML assembly |
| `src/modules/intelligence-module.ts` | CustomerObjectiveProfile extraction |
| `src/lib/executive-resolver.ts` | Contact resolution (Tier 1: intelligence, Tier 2: Gemini, Tier 3: email inference) |
| `src/ae-voice.ts` | AE voice profile — tone, phone, email |
| `src/quality-validators/campaign-validator.ts` | Quality validation |

## Shared Dependencies (ADR-045)

| Module | Function | Purpose |
|--------|----------|---------|
| `src/lib/persona-classifier.ts` | `classifyPersona()`, `preMatchObjectives()` | Persona-to-category classification, objective pre-matching |
| `src/lib/contact-quality.ts` | `isRealPersonName()` | Filter placeholder contacts |
| `src/lib/text-utils.ts` | `cleanEmailSubject()` | Email subject cleaning with acronym preservation |

## Delivery

- **Drive:** Google Doc in customer folder — PATCH update preserves stable URL across regenerations
- **UI:** CampaignConfigurator component, CampaignsTab on customer detail page
- **API:** `POST /api/customer/:name/campaigns/generate`
- **Batch:** `POST /api/batch/execute` with `action: 'campaigns'`

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/customer/:name/campaigns/generate` | Generate campaign for one customer |
| POST | `/api/batch/execute` | Batch generate for multiple customers |
| GET | `/api/customer/:name/campaigns` | Campaign history |
| GET | `/api/customer/:name/campaigns/:id/preview` | Render HTML preview |
| DELETE | `/api/customer/:name/campaigns/:id` | Delete campaign |
| POST | `/api/campaigns/extract-material` | Extract material content from URL |
| POST | `/api/ae/:name/style-guide/detect` | Auto-detect AE voice profile |

## Output Format

Campaign Google Doc contains these sections in order:

### 1. Header
- Campaign title (cleaned — no email prefixes, acronyms preserved)
- Customer name, generated date, AE + full account team
- Source material with descriptions

### 2. Target Contacts Table
- Name, Title, Email (confirmed or [inferred]), LinkedIn
- Only real person names — placeholder roles filtered out

### 3. Generation Config Table
- Model (Two-Pass ADR-043), AE voice, account team, email tiers, target personas, signals loaded, assembly method

### 4. Email Quality Checklist
- 10 quality dimensions — word limits, technical observations only, per-bullet links, named peer companies, forward-worthy, competitor-swap test, creepy line check, no filler

### 5. Customer Intelligence Dashboard
- Annual revenue, employees, product instances
- **"Why [Customer] Is a Strong Fit"** — rationale paragraph
- **📊 Business Metrics Used in Outreach** — table showing ONLY metrics that appear in emails, with category, metric text, and which email uses each
- Strategic Initiatives table with priorities
- Competitive Position table

### 6. Outreach Guardrails
- NEVER: pipeline $, support cases, subscription counts, layoff numbers
- CAREFUL: customer risks, ecosystem risks
- SAFE: public earnings, AI strategy, public law, existing relationship

### 7. Reference Material Table
- Source documents with key takeaways

### 8. Eligibility Table (if applicable)
- Product deployment types with SB 122 / regulatory status

### 9. Existing Red Hat Footprint
- Current products, expansion opportunities (sanitized — no NN- prefixes, no "— Pipeline")

### 10. Email Templates
- **Executive Outreach** (≤150 words) — colleague's note, designed to be forwarded down with "thoughts?"
- **Manager Outreach** (≤200 words) — technical depth, designed to be forwarded up with "we should look at this"

Each email contains:
- Recipient name + title in header
- Subject line (observation about their world — no product names)
- To: line with inferred email
- 8 composable blocks: opener, signalBridge (with persona-matched objective), relationshipLine, featureBullets (3 linked), referenceLine, peerPattern, challengerFrame (4 rotating closers), CTA (with specific dates)
- AE sign-off with name, title, email, phone

### 11. BV Talking Points
- Internal-only section — NOT in emails
- 3-4 business value categories with talking points and key metrics

## Quality Dimensions (14-point validation)

| # | Check | How Verified |
|---|-------|-------------|
| 1 | Title clean — no email prefixes, acronyms preserved | `cleanEmailSubject()` + unit test |
| 2 | No placeholder contacts | `isRealPersonName()` filter |
| 3 | Phone in sign-offs | Voice profile phone extraction |
| 4 | Email in sign-offs | Voice profile email extraction |
| 5 | Footprint clean — no NN-, no Pipeline, no Company intelligence | `sanitizeFootprint()` |
| 6 | No creepy lines in emails | `sanitizeCreepyLines()` — 18 sentence-level patterns |
| 7 | To: lines with inferred emails | Email backfill from domain config |
| 8 | Feature bullets linked | URL registry resolution |
| 9 | Challenger frame varies | 4 rotating closers by email index |
| 10 | Metrics table in Fit section | `renderMetricsTable()` — only shows used metrics |
| 11 | Objectives in email bodies | `renderObjectiveBlock()` — persona-matched |
| 12 | Red Hat never as threat | Structural `{ threat, solution }` separation |
| 13 | No old theme-as-threat pattern | cleanEmailSubject replaces raw email subject |
| 14 | Objective text renders naturally | Full objective label, not bare metric |

## Data Sources

| Source | What It Provides | Signal Type |
|--------|-----------------|------------|
| Intelligence brief | CustomerObjectiveProfile, strategic initiatives, financial health, leadership context | intelligence |
| Email signals | Campaign source material, contact email addresses | emails |
| Solution plays (SalesHub) | Peer proof — customer wins with metrics | saleshub-plays |
| Product catalog | Feature URLs for bullet links | saleshub-products |
| Subscription data | Existing Red Hat footprint, relationship line | subscriptions |
| Tech stack cache | Customer's technology landscape | tech-stack |
| Voice profile cache | AE tone, phone, email | ae-voice |
| Executive resolver cache | Resolved contacts with titles | executive-profiles |
| News radar | Recent company news for openers | news-radar |

## Contact Resolution

Three-tier resolution (executive-resolver.ts):
- **Tier 1:** Mine intelligence brief Leadership section — name + title (no API calls)
- **Tier 2:** Gemini grounding search — LinkedIn profiles, additional contacts
- **Tier 3:** Email inference — first-initial + last-name @ company domain

**Known gap:** Email format is hardcoded flast@. Should detect actual pattern from observed emails in Gmail cache. See ADR recommendation for email resolver shared library.

## Test Coverage

| Test File | Tests | What It Covers |
|-----------|-------|---------------|
| `test/unit/campaign-template-blocks.test.ts` | 72 | All 8 email blocks, renderObjectiveBlock, persona matching |
| `test/unit/campaign-output-audit.test.ts` | 36 | Gold standard compliance, metrics table, threat/solution |
| `test/unit/objective-profile.test.ts` | 14 | CustomerObjectiveProfile extraction from intelligence markdown |
| `test/unit/campaign-threat-solution.test.ts` | 13 | deriveThreatSolution, Red Hat never in threat position |
| **Total** | **137** | |

## Consumer Classification

**Audience: EXTERNAL** — output goes directly to customer contacts via email.

Internal data that must NEVER appear in output:
- Pipeline dollar amounts
- Support case numbers/counts
- Subscription counts/node counts
- SKU codes
- Layoff numbers
- Internal team assignments

This classification is enforced by `sanitizeCreepyLines()` which runs on every email block output.

## TC Compliance

| Requirement | Status |
|---|---|
| @consumer-contract v1.0 | ✅ Both files |
| ensureFresh | ✅ campaign-service.ts |
| templateAll | ✅ campaign-service.ts |
| validateAndRetry | ✅ campaign-service.ts |
| getAccountTeam | ✅ campaign-service.ts |
| Drive delivery | ✅ Google Doc PATCH update (stable URL) |
| Audience classification | ✅ EXTERNAL |
| ADR governance | ✅ ADR-043, ADR-044, ADR-045 |

## Pipeline Section Tracker (as of 2026-08-17)

Source of truth for what works, what's broken, and what test covers it. Update this table as each section ships.

### Pipeline Stages

```
EXTRACTION (one-time)
  ↓
PASS 0: selectPersonas() → PersonaBrief[] (12 fields/persona, role-based AI)
  ↓
EXECUTIVE RESOLUTION (Tier 1 intel → Tier 2 Gemini → Tier 3 email inference)
  ↓
PASS 1: callGeminiForCampaignSelection() → CAMPAIGN_SELECTION_SCHEMA (data only, no prose)
  ↓
PASS 2: generateCampaignFromStructured() → deterministic HTML (zero LLM)
```

### Section Status

| § | Section | Pipeline Stage | Status | Issue | Test |
|---|---------|---------------|--------|-------|------|
| 1 | Header + Source Material | Extraction + account team | ✅ PASS | — | spec-compliance |
| 2 | Target Contacts | Exec Resolution | ✅ PASS | #1136: re-pad shipped | L3 pipeline |
| 2a | — 3 exec + 3 manager split | Exec Resolution | ✅ PASS | #1137: tier split shipped | L3 pipeline |
| 2b | — LinkedIn on all contacts | Exec Resolution | ✅ PASS | #1139: Tier 1b enrichment shipped | L3 pipeline |
| 3 | Generation Config | Pass 2 metadata | ✅ PASS | — | spec-compliance |
| 4 | Quality Checklist | Pass 2 `runEmailQualityCheck()` | ✅ PASS | #1099: word counts shipped | L3 pipeline |
| 5 | Intelligence Dashboard | `renderDashboardMetrics()` | ✅ PASS | #1104 closed | output-audit |
| 5a | "Why Customer Is Fit" | Pass 0 → `renderFitFromPass0()` | ✅ PASS | — | spec-compliance |
| 5b | Business Metrics Table | `renderMetricsTable()` | ⚠️ VERIFY | #1097 closed — confirm diverse categories | output-audit |
| 5c | Strategic Initiatives | `renderStructuredIntelSections()` | ✅ PASS | #1088 closed | output-audit |
| 5d | Competitive Position | Same renderer from intel | ✅ PASS | #1106 closed | output-audit |
| 6 | ~~Guardrails~~ | REMOVED (#1107) | ✅ RESOLVED | — | — |
| 7 | Reference Material | Extraction → referenceMaterialData | ✅ PASS | #1070: URL discovery shipped | L3 pipeline |
| 8 | Eligibility (conditional) | Gemini selection | ✅ PASS | — | spec-compliance |
| 9 | Footprint | `deriveFootprint()` from Pass 0 + signals | ✅ PASS | #1124: data leaks shipped | L3 pipeline |
| 10a | Executive Emails (3, ≤150w) | Pass 1 → Pass 2 assembly | ✅ PASS | #1136 + #1137 shipped | L3 pipeline |
| 10b | Manager Emails (3, ≤200w) | Pass 1 → Pass 2 assembly | ✅ PASS | #1137: tier split shipped | L3 pipeline |
| 10c | Peer Proof in emails | `buildPeerPattern()` | ✅ PASS | #1138: fallback shipped | L3 pipeline |
| 11 | BV Talking Points | Pass 0 briefs → template | ✅ PASS | — | spec-compliance |

**Legend:** ✅ = data flows correctly through pipeline and renders per spec. ⚠️ = works but edge cases fail. ❌ = broken data path.

### Legacy Path Removal

| Item | Status | Issue |
|------|--------|-------|
| Remove `generateCampaignHTML` function | ✅ DONE | #1134 |
| Remove `USE_STRUCTURED_CAMPAIGNS` flag + freeform branch | ✅ DONE | #1134 |
| Remove convergence comparison code | ✅ DONE | #1134 |
| Convert `generateCampaignFromPlay()` to structured path | ✅ DONE | #1135 |
| Audit + close #1063-#1066 (two-pass issues already implemented) | TODO | — |

### Test Matrix

| Layer | Test File | Tests | What It Catches | Gap |
|-------|-----------|-------|-----------------|-----|
| **L1: Unit (fixture)** | `campaign-spec-compliance.test.ts` | 105 | Template rendering bugs, missing sections | None |
| **L1: Unit (fixture)** | `campaign-template-blocks.test.ts` | 72 | 8 email blocks, objective rendering | None |
| **L2: Output audit** | `campaign-real-output-audit.test.ts` | 49 | Data that reaches output but renders wrong | Good |
| **L2: Output audit** | `campaign-output-audit.test.ts` | 36 | Gold standard structural compliance | Needs update |
| **L3: Pipeline integration** | `campaign-pipeline.test.ts` | 63 | Wiring failures between stages | ✅ CLOSED |

### Issue Plan (execution order)

| Priority | Issue | Depends On | Section Fixed | Status |
|----------|-------|-----------|---------------|--------|
| P0-1 | #1134: Remove legacy path | — | All (single path) | ✅ SHIPPED |
| P0-2 | #1135: Convert `generateCampaignFromPlay()` | #1134 | Play-based campaigns | ✅ SHIPPED |
| P1-1 | #1124: Footprint data leaks | — | §9 | ✅ SHIPPED |
| P1-2 | #1136: Contact re-pad after filter | — | §2, §10a | ✅ SHIPPED |
| P1-3 | #1137: Exec + manager tier split (3+3) | #1136 | §2, §10b | ✅ SHIPPED |
| P1-4 | #1138: Peer proof SalesHub fallback | — | §10c | ✅ SHIPPED |
| P1-5 | #1139: Tier 1 LinkedIn enrichment | — | §2b | ✅ SHIPPED |
| P1-6 | #1099: Quality checklist 11→16 | — | §4 | ✅ SHIPPED |
| P1-7 | #1070: Reference URL discovery | — | §7 | ✅ SHIPPED |
| P1-8 | #1140: Pipeline integration test (L3) | P1-1 through P1-7 | ALL | ✅ SHIPPED |
| P1-9 | #1141: Pipeline data contract assertions | #1140 | Stage boundaries | ✅ SHIPPED |

## Known Gaps (remaining after tracker)

- [ ] Email resolver hardcodes flast@ — needs evidence-based pattern detection
- [ ] Shared libs (contact-quality.ts, persona-classifier.ts) not yet extracted
- [ ] Gold standard not updated to reflect current output format
- [ ] UI does not show metrics preview or threat/solution override
