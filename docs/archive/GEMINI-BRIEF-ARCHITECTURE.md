# Gemini Brief Generation Architecture

**Date:** 2026-04-01
**Input:** 9-agent deep investigation on AI brief generation patterns
**Status:** Partially implemented — see "Implemented Changes (2026-04-04)" below

---

## Implemented Changes (2026-04-17) — ADR-013 Data Ingestion Tier Standard

**Major overhaul — all data paths now have a defined caching tier.** See `docs/adr/ADR-013.md` for the full standard.

### Brief Cache — Input Fingerprint Replaces TTL (ADR013-P2)

Brief invalidation is now SHA256 content-addressed, not time-based. `customer-routes.ts` computes a fingerprint from all brief inputs (emails + meetings + docs + cases + subscriptions + pipeline + CCSP) before calling `generateBrief()`. If the fingerprint matches the stored brief's `inputFingerprint`, the cached brief is returned with zero Gemini calls — regardless of age. A 7d safety-net TTL remains as a fallback for cases where upstream data changes without triggering a fingerprint change.

```
Cached brief exists
  ↓  condition 1: fingerprint matches stored inputFingerprint → return cache (0 Gemini calls)
  ↓  condition 2: (Date.now() - brief.cachedAt) >= 7d → safety-net TTL expiry
  ↓  force=true: always regenerate
```

Previous: 4h TTL (always hit Gemini 6x/day per customer). Now: content-addressed (only hits Gemini when inputs actually changed).

### Drive Doc Cache (ADR013-P0)

`cache-layer.ts` now has `readDocContentCache(fileId, modifiedTime)` / `writeDocContentCache()`. Before exporting any Drive doc, `customer.ts` checks for a cached version keyed by `{fileId}-{modifiedTime}`. Cache miss → export + write. Cache hit → read from disk, skip Drive API. PDF docs are also cached before the PDF-to-text extraction path. Same pattern for doc classifications: `readDocClassCache/writeDocClassCache` — Gemini classification runs at most once per `{fileId, modifiedTime}` pair.

### Email + Meeting Cache (ADR013-P1)

`fetchCustomerEmails()` and `fetchCustomerMeetings()` in `customer.ts` now check cache before hitting Google APIs. TTL: 2h. Cache key: `{customerSlug}-emails.json` / `{customerSlug}-meetings.json`. On cache miss: hit API, write result. On cache hit: return disk data (zero Gmail/Calendar calls).

### CCSP + Pipeline Write-Side Hash Guards (TOKEN-04)

`writeCCSPCache()` and `writePipelineCache()` now compute SHA256 of the payload before writing. If the hash matches the existing cached version, the write is skipped and `cachedAt` is NOT updated. This prevents daily CCSP/pipeline rewrites with identical content from cascading into brief regeneration.

### Intelligence TTL Tiering (TOKEN-02)

`INTELLIGENCE_CACHE_TTL_DAYS` split into two env vars:
- `INTELLIGENCE_COMPANY_TTL_DAYS` (default 14) — company brief changes on deal activity
- `INTELLIGENCE_INDUSTRY_TTL_DAYS` (default 30) — industry landscape changes quarterly

### Shared Industry Analysis Cache (TOKEN-05)

`generateIndustryAnalysis()` now checks a shared cache keyed by `{industry}-{region}` before calling Gemini. Cache file: `/data/cache/industry-analysis/{slug}.json` (30d TTL). First customer in a given industry writes the cache; all subsequent customers in the same industry read from it. For example, 10 Healthcare customers now share one grounded Gemini call per 30 days instead of 10.

---

## Implemented Changes (2026-04-04)

### 1. Brief Cache TTL (legacy — superseded by ADR013-P2 above)

Previously: `BRIEF_CACHE_TTL_MS = 4 * 60 * 60 * 1000` (4 hours). Now replaced by input fingerprint with 7d safety-net TTL.

### 2. Pipeline + CCSP Data Passed to generateBrief

`customer-routes.ts` now reads the pipeline cache and CCSP cache, filters each **per customer** (matching customer name), and passes both to `generateBrief()`. Previously `generateBrief` had no access to pipeline or cloud spend data.

The pipeline filter matches on `opportunityName` or `accountName` containing the customer name. The CCSP filter matches on `accountName`. Both are passed as structured data into `buildXmlSources()`.

### 3. lastBriefDate Uses Actual Cached Date

`customer.ts` previously hardcoded `lastBriefDate` as "yesterday". It now calls `readLatestBriefCache(customerName)` and uses the `.date` field from the most recent cached brief file. This is the date stamp in the filename (e.g. `acme-corp-2026-04-03.json` → date `2026-04-03`). When no prior brief exists, it defaults to 30 days ago.

This fix enables accurate delta detection in the brief: Gemini now knows the actual date of the last generated brief and can focus on changes since that date.

### 4. Free/Trial Subscriptions Excluded from Brief XML

`buildXmlSources()` now calls `isFreeOrTrial(sub)` (from `health-score.ts`) and **excludes** matching subscriptions entirely from the `<source type="subscriptions">` XML block. Previously they were included with a `[FREE/TRIAL]` tag. Exclusion reduces noise and prevents Gemini from generating renewal urgency about non-commercial subscriptions.

### 5. Account Intelligence Docs Included in Brief XML

When an intelligence JSON cache exists at `data/cache/intelligence/{slug}.json` (written by the account intelligence pipeline), `buildXmlSources()` reads it and includes the content as:

```xml
<source type="account_intelligence" generated="{generatedAt}">
{intelligence content}
</source>
```

This closes the loop between the intelligence pipeline (Steps 2+3) and the brief pipeline — previously, intelligence docs were written to Drive but never read back into brief generation.

### 6. callLLMStructured Empty-Response Guard

`callLLMStructured()` in `customer.ts` now checks for an empty or null response from the Gemini API before calling `JSON.parse()`. Previously, an empty Gemini response caused an HTTP 500 (`JSON.parse` of empty string throws). The guard logs a warning and returns `null`, allowing the brief pipeline to fall back to single-pass synthesis.

---

## Executive Summary

Research across 100+ sources (Anthropic, Google, OpenAI docs, academic papers, enterprise case studies) converges on 7 findings that fundamentally reshape how the DailyBriefDashboard should generate customer intelligence briefs:

1. **250-word temporal delta briefs** beat comprehensive 900-word briefs on every adoption metric
2. **Three-step chain** (extract → rank → synthesize) outperforms single-pass (ACL 2024)
3. **XML-tagged source sections** are the gold standard for multi-source input
4. **Gemini `responseSchema`** + context caching = production architecture at 70-85% cost reduction
5. **Post-hoc citation** is more reliable than inline citation
6. **Simple prompts** beat complex prompts on modern reasoning models
7. **One AI error destroys trust permanently** — confidence levels and freshness timestamps are mandatory

---

## Architecture: Three-Step Brief Pipeline

### Current Architecture (Single Pass)
```
[All data concatenated as text] → [Single callLLM()] → [900-word markdown brief]
```

### New Architecture (Three-Step Chain)
```
Step 1: EXTRACT (per-source structured extraction)
  [XML-tagged sources] → [Gemini + responseSchema] → [Structured JSON: items per source]

Step 2: RANK (priority scoring)
  [Extracted items + previous brief] → [Score by urgency × impact × evidence] → [Top 5 items]

Step 3: SYNTHESIZE (brief composition)
  [Ranked items + constraints] → [Gemini] → [~250-word delta-first brief with citations]
```

**Why three steps:**
- ACL 2024: chaining consistently outperforms single-pass
- Self-Refine: 8.7-21.6 point improvement on GPT-4
- Separation of concerns: extraction accuracy ≠ synthesis quality
- Each step can be independently logged, evaluated, and improved

---

## Step 1: EXTRACT — Structured Source Extraction

### Input: XML-Tagged Source Blocks

Replace the current flat text concatenation with semantically tagged XML:

```xml
<customer>
  <name>{customer.name}</name>
  <ae>{customer.ae}</ae>
  <segment>{customer.segment}</segment>
  <last_interaction>{date of most recent meeting or email}</last_interaction>
  <last_brief_date>{date of last generated brief}</last_brief_date>
</customer>

<source type="subscriptions" synced="{syncDate}" count="{n}">
{subscription lines — product, quantity, expiry, days left}
</source>

<source type="support_cases" synced="{syncDate}" count="{n}">
{case lines — severity, case#, summary, days open, product}
</source>

<source type="calendar" window="next_14_days" count="{n}">
{meeting lines — title, date, attendees}
</source>

<source type="emails" window="last_30_days" count="{n}">
{email lines — date, subject, snippet, action_required flag}
</source>

<source type="documents" window="last_30_days" count="{n}">
{doc lines — name, modified date, content excerpt (400 chars)}
</source>

<source type="pipeline" synced="{syncDate}" count="{n}">
{opportunity lines — name, stage, amount, close date, age}
</source>

<source type="cloud_spend" synced="{syncDate}">
{CCSP ACV, delta from previous period}
</source>

<source type="previous_brief" date="{lastBriefDate}">
{full text of last generated brief — for delta detection}
</source>
```

**Key rules:**
- Every source includes `synced` date — Gemini knows data freshness
- Previous brief is always included as a source for delta detection
- `last_interaction` tells Gemini the temporal anchor for "what changed"
- Sources placed ABOVE the instructions (30% quality improvement per Anthropic)

### Extraction Prompt (Step 1)

```
You are extracting structured intelligence signals from customer data sources.
For each source, identify items that are NEW or CHANGED since {last_interaction_date}.

Extract into these categories:
- RISKS: Items requiring urgent attention (cases, expiring renewals, declining spend)
- CHANGES: Things that are different since last interaction
- OPPORTUNITIES: Expansion signals, positive momentum
- ACTIONS: Items requiring the SA to do something specific
- COMPETITIVE: Any competitor mentions or evaluation signals
- STAKEHOLDER: Contact engagement patterns, new contacts, silent contacts

For each item:
- Cite the exact source type and specific data point
- Rate confidence: HIGH (directly stated in data) or MEDIUM (inferred from patterns)
- Rate urgency: CRITICAL (act today), HIGH (act this week), MEDIUM (awareness)

If a source contains nothing noteworthy, omit it. Do not fabricate items.
```

### Extraction Response Schema (Gemini `responseSchema`)

```json
{
  "type": "object",
  "properties": {
    "customer_name": { "type": "string" },
    "extraction_date": { "type": "string" },
    "last_interaction": { "type": "string" },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "category": {
            "type": "string",
            "enum": ["RISK", "CHANGE", "OPPORTUNITY", "ACTION", "COMPETITIVE", "STAKEHOLDER"]
          },
          "text": {
            "type": "string",
            "description": "One-sentence description of the signal"
          },
          "source_type": {
            "type": "string",
            "enum": ["subscriptions", "support_cases", "calendar", "emails", "documents", "pipeline", "cloud_spend"]
          },
          "source_detail": {
            "type": "string",
            "description": "Specific reference: case#, email subject, doc name, opp name"
          },
          "confidence": {
            "type": "string",
            "enum": ["HIGH", "MEDIUM"]
          },
          "urgency": {
            "type": "string",
            "enum": ["CRITICAL", "HIGH", "MEDIUM"]
          },
          "is_new_since_last_brief": {
            "type": "boolean",
            "description": "True if this item was NOT in the previous brief"
          }
        },
        "required": ["category", "text", "source_type", "source_detail", "confidence", "urgency", "is_new_since_last_brief"]
      }
    },
    "data_gaps": {
      "type": "array",
      "items": {
        "type": "string",
        "description": "Sources that are stale (>7 days) or empty"
      }
    }
  },
  "required": ["customer_name", "extraction_date", "items", "data_gaps"]
}
```

**Why structured JSON extraction:**
- Gemini's `responseSchema` guarantees valid JSON every call
- Each item is independently scorable, sortable, and filterable
- Items can be reused across Morning Summary, Priority Action, and Brief
- `data_gaps` forces Gemini to flag missing/stale data instead of hallucinating

---

## Step 2: RANK — Priority Scoring

This step can be **deterministic** (no LLM call needed):

```typescript
function rankItems(items: ExtractedItem[]): ExtractedItem[] {
  const urgencyScore = { CRITICAL: 100, HIGH: 60, MEDIUM: 20 };
  const categoryScore = { RISK: 50, ACTION: 40, COMPETITIVE: 30, CHANGE: 20, OPPORTUNITY: 15, STAKEHOLDER: 10 };
  const confidenceScore = { HIGH: 1.0, MEDIUM: 0.7 };
  const newBonus = 25; // new items since last brief get a boost

  return items
    .map(item => ({
      ...item,
      score: (urgencyScore[item.urgency] + categoryScore[item.category])
             * confidenceScore[item.confidence]
             + (item.is_new_since_last_brief ? newBonus : 0)
    }))
    .sort((a, b) => b.score - a.score);
}
```

**Top item becomes the Priority Action.** Top 3-5 items become the brief content.

**Why deterministic ranking:**
- Faster (no API call)
- Deterministic (same inputs = same output)
- Tunable (adjust weights without prompt engineering)
- Research says hybrid (rules + LLM) is best, but rules alone are sufficient for v1

---

## Step 3: SYNTHESIZE — Brief Composition

### Synthesis Prompt

```
You are writing a 250-word customer intelligence brief for a Red Hat Account Solution Architect.
The SA uses this brief to prepare for customer interactions.

RULES:
- Lead with what CHANGED since {last_interaction_date}. This is the most important section.
- The FIRST SENTENCE must state the single most important action the SA should take.
- Every factual claim must cite its source as [Source: {source_type}].
- Maximum 5 bullet points per section. 3 is better than 5.
- If data is stale or missing, say so: "[Source: {type}, last synced {date} — may be outdated]"
- Do not include generic company descriptions the SA already knows.
- Do not include information that hasn't changed since the last brief.
- Instead of "No pipeline opportunities" — omit the section entirely.
- Keep total brief under 250 words.

FORMAT:
## Priority Action
[One sentence: what to do, why, by when]

## What Changed Since {last_interaction_date}
- [change 1] [Source: {type}]
- [change 2] [Source: {type}]
- [change 3] [Source: {type}]

## Risks & Renewals (only if applicable)
- [risk with timeline] [Source: {type}]

## Meeting Prep (only if meeting within 3 days)
- [talking point 1]
- [talking point 2]

## Competitive Signals (only if detected)
- [competitor mention with context] [Source: {type}]

DATA FRESHNESS:
{list of data_gaps from Step 1}

ITEMS TO SYNTHESIZE (pre-ranked, most important first):
{top 5 ranked items from Step 2 as JSON}
```

### Key Design Decisions

**Why 250 words, not 900:**
- 80% of people stop reading after 250 words (Axios HQ, N=651 orgs)
- 75-100 words = 51% peak response rate
- The current 900-word brief crosses the cognitive overload threshold
- Research: "sellers overwhelmed by tools are 45% less likely to hit quota"

**Why delta-first, not overview-first:**
- Trigger events predict 400% higher buying probability vs. static data
- "After a seller reads an account profile once, they never read it again" (Johannes/contrarian)
- The ONLY section with repeat readership is "what changed"

**Why omit empty sections instead of "No data":**
- "No pipeline opportunities" wastes cognitive bandwidth
- Empty sections train the SA to skim past headers
- Research: "remove extraneous information" improves decision quality

**Why confidence and freshness:**
- Single AI error → statistically massive trust decline (PMC, F=45.327)
- Expert users (your most valuable audience) abandon fastest after an error
- Better 3 verified facts than 10 uncertain ones
- The first 14 days are make-or-break

---

## Static Brief Sections (Generated Once, Cached)

These sections don't change daily and should NOT be regenerated with each brief:

| Section | Regenerate When | Cache Duration |
|---------|----------------|----------------|
| Company Profile | Monthly or on trigger (acquisition, funding) | 30 days |
| Technology Landscape | Monthly or when new doc/email signals detected | 30 days |
| Product Portfolio | When subscription data changes | Until next scrape |
| Stakeholder Map | When new contacts appear in email/calendar | 7 days |

**Implementation:** Store as `{slug}-static-{section}.json`. Include a `generatedAt` timestamp. Regenerate on trigger events, not daily.

The daily brief focuses ONLY on: temporal delta, priority action, risks/renewals, meeting prep, and competitive signals.

---

## Document Extraction Sub-Pipeline

Google Drive docs need special handling before feeding into the main brief pipeline.

### Document Classification (Per-Doc)

```
Classify this document and extract structured fields:

DOCUMENT: {doc.name} (modified: {doc.modifiedTime})
CONTENT: {doc.content.slice(0, 2000)}

Classify as one of: MEETING_NOTES, ACCOUNT_PLAN, TECHNICAL_DOC, PROPOSAL, OTHER

Extract (if present):
- action_items: [{text, owner, deadline}]
- decisions: [{text, participants}]
- stakeholders_mentioned: [{name, role, sentiment}]
- technical_signals: [{technology, context: "using" | "evaluating" | "migrating_from"}]
- competitive_mentions: [{competitor, context}]
- timelines: [{event, date}]
- pain_points: [{text, severity}]
```

**Key insight (from research):** Dual-prompt chaining for meeting notes — extract action items/decisions separately from summaries. This prevents the LLM from conflating summaries with commitments.

**When to use full-context vs. RAG:**
- Meeting notes, account plans (<50 pages): Full context — benefits from holistic understanding
- Large technical doc sets: RAG with 512-token chunks + 128-token overlap
- Cross-document synthesis (multiple docs per customer): RAG with per-doc extraction first

---

## Email Intelligence Sub-Pipeline

### Action Item Extraction

```
Classify each email and extract intelligence:

For each email:
1. Classification: ACTION_REQUIRED | FYI | RESPONSE_NEEDED
   Signals: questions directed at recipient, modal verbs ("you should", "can you"),
   deadline language ("by Friday"), CC vs TO positioning

2. Action Items: [{text, owner, deadline, confidence}]
   Look for: commitment verbs ("I will", "please", "can you"), implied deadlines,
   follow-up requests

3. Competitive Mentions: [{competitor, context, risk_level: HIGH|MEDIUM|LOW}]
   Beyond keywords: indirect references ("the other vendor", "their platform"),
   evaluation context ("bake-off", "POC with", "comparing", "shortlist")

4. Stakeholder Signals: [{contact, sentiment: POSITIVE|NEUTRAL|NEGATIVE, signal}]
   Engagement changes, role mentions, escalation language
```

### Engagement Frequency (Deterministic, No LLM)

```typescript
function detectGoneSilent(contacts: ContactHistory[]): SilentContact[] {
  return contacts
    .filter(c => {
      const daysSinceEmail = daysBetween(c.lastEmailDate, now);
      const baseline30d = c.emailCount30dBaseline; // first 30d frequency
      const current30d = c.emailCountLast30d;
      // Alert on >50% frequency drop from baseline OR 14+ day gap
      return (current30d < baseline30d * 0.5) || daysSinceEmail > 14;
    })
    .map(c => ({
      email: c.email,
      lastContact: c.lastEmailDate,
      daysSilent: daysBetween(c.lastEmailDate, now),
      previousFrequency: c.baselineFrequency,
      currentFrequency: c.currentFrequency
    }));
}
```

---

## Calendar Intelligence Sub-Pipeline

### Meeting Prep Data Assembly

For each meeting in the next 3 days, assemble:

1. **Attendee context** — role, last interaction date, email frequency, sentiment trend
2. **Open action items** — from prior meetings with these attendees
3. **Account health signals** — cases, renewals, pipeline changes since last meeting
4. **Competitive context** — any competitor mentions from emails with these contacts
5. **Stakeholder coverage** — who's engaged, who's missing, who went silent

**This data feeds into the `## Meeting Prep` section of the brief.**

---

## Gemini API Configuration

### System Instruction (Cached 24h via Context Caching)

```
You are a customer intelligence extraction system for a Red Hat Account Solution Architect.
Your job is to identify what changed, what's at risk, and what the SA should do next.

Rules:
- Only use information present in the provided data sources
- Every claim must reference a specific source
- If data is missing or stale, flag it explicitly
- Prefer 3 verified facts over 10 uncertain ones
- Never fabricate connections between sources
- Never include generic information the SA already knows
```

### API Call Configuration

```typescript
const generationConfig = {
  responseMimeType: "application/json",
  responseSchema: extractionSchema, // Step 1 schema above
  // Thinking budget: 4096 for extraction (needs reasoning), 0 for synthesis (already ranked)
};

// Context caching for system instruction + schema
const cachedContent = await cacheManager.create({
  model: 'gemini-2.5-flash',
  systemInstruction: SYSTEM_INSTRUCTION,
  contents: [], // schema docs, few-shot examples
  ttl: '86400s', // 24 hours
});
```

**Cost model:**
- Cached tokens: 10% of standard cost (90% discount)
- System instruction + schema + examples ≈ 2,000 tokens → cached
- Variable customer data ≈ 3,000-8,000 tokens per brief → not cached
- Estimated cost per brief: ~$0.001-0.003 (vs. current ~$0.01-0.03)

---

## Anti-Patterns to Avoid (Research-Backed)

| Anti-Pattern | Why It Fails | What to Do Instead |
|--------------|-------------|-------------------|
| 900-word comprehensive brief | 80% stop reading at 250 words | Delta-first 250-word brief |
| Generic company overview | Read once, never again | Cache static sections, regenerate monthly |
| 14 AI action items from a meeting | Busywork multiplier — seller knew the 2-3 that matter | ONE priority action |
| Complex multi-section prompt | Worse output on modern models | Simple constraints + `responseSchema` |
| Inline citations in single pass | 50-90% don't support claims | Post-hoc citation or grounding-before-synthesis |
| "No pipeline opportunities" | Wastes cognitive bandwidth | Omit empty sections entirely |
| Daily regeneration of static data | Wastes tokens, adds noise | Cache Company Profile/Tech Landscape for 30d |
| No confidence levels | One error destroys trust forever | HIGH/MEDIUM confidence + data freshness dates |

---

## Implementation Plan

### Phase 1: Prompt Restructure (BKL-R01, R02, R03) — 1-2 days
1. Restructure `generateBrief()` in `customer.ts` to use XML-tagged sources
2. Add `previous_brief` as a source for delta detection
3. Add `last_interaction` date computation from calendar/email data
4. Shorten output to ~250 words with delta-first format
5. Add source citations and data freshness warnings
6. Add `responseSchema` for structured JSON output

### Phase 2: Three-Step Pipeline — 2-3 days
1. Split into `extractSignals()` → `rankItems()` → `composeBrief()`
2. Implement extraction schema with Gemini `responseSchema`
3. Implement deterministic ranking function
4. Implement synthesis prompt with ranked items as input
5. Add context caching for system instruction + schema

### Phase 3: Document & Email Sub-Pipelines — 3-5 days
1. Add document classification and structured extraction
2. Add email action item and competitive mention extraction
3. Add stakeholder engagement frequency tracking
4. Add meeting prep data assembly from calendar + email + cases
5. Feed sub-pipeline outputs into the main extraction step

### Phase 4: Static Section Caching — 1 day
1. Separate Company Profile and Technology Landscape into cached static briefs
2. Add trigger-based regeneration (new doc signals, monthly timer)
3. Include static section age in brief output

---

## Source Documents

All research files in `~/.claude/MEMORY/RESEARCH/2026-04/`:
- `2026-04-01_ai-brief-generation-patterns/LANDSCAPE.md` — Full landscape synthesis
- `prompt-engineering-customer-intelligence-briefs.md` — Ava: prompt patterns + templates
- `ai-email-calendar-intelligence-extraction.md` — Ava: email/calendar extraction
- `ai-document-intelligence-extraction.md` — Ava: document extraction patterns
- `2026-04-01_multi-source-customer-intelligence-synthesis.md` — Alex: multi-source synthesis
- `ai-sales-brief-adoption-vs-shelfware.md` — Alex: adoption research
- `2026-04-01_gemini-prompt-engineering-patterns.md` — Alex: Gemini-specific patterns
- Johannes contrarian analysis (agent output, key findings in LANDSCAPE.md)
- Johannes real-world implementations (agent output, key findings in LANDSCAPE.md)
- `prompt-patterns-customer-intelligence-briefs.md` — Johannes: production prompt templates

*Synthesized from 9 research agents, 100+ sources, cross-validated*
