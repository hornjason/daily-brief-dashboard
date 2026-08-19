---
doc-type: architecture
status: active
owner: serena-blackwood
updated: 2026-08-19
---

# Full Campaign Pipeline Architecture Review

**Author:** Serena Blackwood (Architect)
**Date:** 2026-08-19
**Scope:** Root cause analysis of 128 commits in 5 weeks; simplification proposal for all consumers

---

## 1. Root Cause Analysis

### The architectural smell: an accretion pipeline, not a designed one

The campaign pipeline was not designed top-down. It was built incrementally: extraction worked, so Pass 0 was added. Pass 0 worked, so Pass 1 was added. Pass 1 worked, so 8 template blocks were added. The blocks worked, so a polish pass was added. Each addition was reasonable in isolation. The result is a 4,300-line pipeline across two files that does too many things at too many abstraction levels.

**128 commits in 5 weeks breaks down to one root cause per category:**

| Category | Root Cause | Why it keeps recurring |
|---|---|---|
| URLs/References (29) | Links pass through 8+ stages; each stage can lose, garble, or duplicate them | No single owner of link lifecycle |
| Quality fixes (40) | Template blocks produce raw output that needs post-hoc cleanup | Blocks don't validate their own output |
| Contacts (10) | Executive resolution is interleaved with email generation | Resolution should complete before assembly begins |
| Word limits (8) | Truncation happens at field level, not at output level | Truncation scattered across 4 files |
| Data leaks (7) | Sanitization is a deny-list pattern (strip known bad) instead of allow-list (emit known good) | Gemini invents content; sanitizers chase it |
| Polish pass (6) | LLM rewrites text containing structural markup | Fundamental separation-of-concerns violation |

**The single deepest root cause:** The pipeline mixes data selection, content assembly, content transformation, and format conversion into one linear flow. When any stage produces unexpected output, every downstream stage must handle it defensively. This creates an exponential surface area for bugs.

### Why 40 "quality fix" commits?

The 8 template blocks (`buildOpener`, `buildSignalBridge`, `buildRelationshipLine`, `buildFeatureBullets`, `buildPeerPattern`, `buildChallengerFrame`, `buildReferenceLine`, `buildCTA`) each independently:
- Access raw signals
- Apply their own truncation/filtering
- Make their own formatting decisions
- Produce markdown-ish text with no output contract

There is no shared output contract. Each block returns a `string`. The only validation is human review of the final email. When a block produces garbage, you find out in Google Docs, then trace back through 8 blocks to find the source. Hence 40 commits of "strip this prefix," "filter that pattern," "dedup this bullet."

### Why does the URL pipeline have 8+ stages?

Current link lifecycle (traced from source code):

```
email/doc extraction → referenceMaterialData[]
    ↓
materialUrlMap (regex extraction from augmentedMaterial)
    ↓
isInternalUrl() filter
    ↓
isHomepageUrl() filter
    ↓
deterministicRefMaterials[] assembly
    ↓
buildReferenceLine() (renders markdown links)
    ↓
assembleEmail() (concatenates blocks)
    ↓
polishEmailBody() (Gemini rewrites — DESTROYS links)
    ↓
re-injection regex (tries to restore links)
    ↓
applyInlineFormatting() (markdown → HTML)
    ↓
bare URL catch-all (creates DUPLICATE links)
```

That is 11 stages. Each stage operates on a different representation of the same data. There is no link object that flows through the pipeline — instead, links are extracted, serialized to text, parsed back, sent to an LLM that garbles them, re-extracted with regex, and converted again.

The fundamental constraint: **a link is structured data (text + URL). Serializing it to text, then asking an LLM to preserve the text representation, then parsing it back is always going to be fragile.** Links should stay as structured data until the final HTML render.

---

## 2. Simplification Proposal

### Current architecture (7 stages, 2 LLM calls in render path)

```
Extraction → Pass 0 (LLM: personas) → Exec Resolution → Pass 1 (LLM: data selection)
    → 8 Template Blocks → Pass 3 (LLM: polish) → Re-injection → HTML → Drive
```

**LLM calls in render path:** Pass 1 (data selection) + Pass 3 (polish) = 2
**Total LLM calls including prep:** Pass 0 + Pass 1 + Pass 3 = 3
**Lines of code:** ~4,300 across 2 files + ~1,300 in 7 lib files = ~5,600

### Proposed architecture (5 stages, 1 LLM call in render path)

```
Extraction → Pass 0 (LLM: personas + data selection, merged)
    → Exec Resolution → Template Assembly (typed blocks) → HTML → Drive
```

**LLM calls in render path:** 0
**Total LLM calls including prep:** 1 (merged Pass 0 + Pass 1)
**Target lines of code:** ~2,500 across 2 files + ~800 in lib

### Key changes

**Change 1: Merge Pass 0 and Pass 1 into a single LLM call.**

Pass 0 selects personas. Pass 1 selects data per persona. These are the same decision. The current split exists because Pass 0 was added after Pass 1 was already built. But the schema can express both: "For this customer, which personas matter, and for each persona, which signals/features/proofs should the email use?"

This eliminates one LLM call and the Pass 0 → Exec Resolution → Pass 1 handoff chain (where data gets lost between stages).

**Change 2: Kill the polish pass entirely.**

The prior council finding (Option A, placeholder isolation) is the right *tactical* fix for the link problem. But the *strategic* question is: should the polish pass exist at all?

The polish pass exists because template-assembled text "reads like a template." But 128 commits later, the templates are sophisticated — they use voice tokens, opener rotation, signal-driven context, persona-matched objectives, pre-matched peer proofs. The gap between raw template output and polished output has narrowed to: (a) smoother sentence transitions, and (b) a more conversational greeting.

The cost of that gap: 6 polish commits, 29 URL commits (mostly caused by polish), and a 45-second Gemini call per email. For 6 emails, that's 4.5 minutes of LLM time just for sentence smoothing.

**Recommendation: Kill Pass 3. Invest those 35 commits into better templates.**

Specifically:
- Move the "colleague's note" voice into the template blocks themselves (opener already does this)
- Add 3-4 greeting templates that rotate per contact
- Let the AE voice profile drive sentence structure, not a rewrite pass

If quality drops noticeably without polish, add it back as Option A (placeholder isolation). But try without it first.

**Change 3: Links as structured data, not text.**

Instead of rendering `[text](url)` into block output and then parsing it back:

```typescript
interface BlockOutput {
  text: string           // plain text, no markup
  links: LinkRef[]       // structured link data
  metrics: MetricRef[]   // structured metric data
}

interface LinkRef {
  anchor: string         // display text
  url: string            // href
  position: 'inline' | 'reference'  // inline in text vs. reference section
}
```

Every block returns `BlockOutput`. The HTML renderer consumes `BlockOutput` and places links at render time. Links never pass through text serialization. Links never pass through an LLM. Links never need re-injection.

This eliminates: `materialUrlMap`, `deterministicRefMaterials`, `sanitizeReferenceLine`, `buildReferenceLine` URL logic, the re-injection block, the bare URL catch-all, and `isInternalUrl`/`isHomepageUrl` (which move to extraction time).

**Change 4: Block output contracts.**

Each block currently returns `string`. Change to `BlockOutput` with validation:

```typescript
function buildOpener(...): BlockOutput {
  // ... build text ...
  return validateBlock('opener', { text, links, metrics })
}
```

`validateBlock` checks:
- Text is under word limit for this block type
- No speculation patterns in text
- No coaching language in text
- Links are well-formed (URL parses, anchor is non-empty)
- Metrics reference real data (not Gemini-invented)

This moves 40 commits of post-hoc quality fixes into per-block validation. When a block produces bad output, it fails at the block level with a clear error, not in the final email where it's mixed with 7 other blocks.

**Change 5: Single-file consumer pattern.**

`campaign-service.ts` (2,245 lines) does too much:
- Material extraction orchestration (→ already in `material-extraction.ts`)
- Gemini prompt construction (→ keep here, this is the consumer's LLM contract)
- Drive upload (→ already in `lib/drive-client.ts`)
- Cache management (→ extract to `lib/campaign-cache.ts`)
- Contact resolution orchestration (→ extract to `lib/campaign-contacts.ts`)
- URL extraction and filtering (→ move to extraction time)
- Quality validation (→ already in `lib/campaign-output-validator.ts`)

Target: `campaign-service.ts` drops to ~800 lines. The orchestration is:
1. Extract material (existing module)
2. Build consumer context (existing `buildConsumerContext`)
3. Call merged Pass 0+1 (one LLM call)
4. Resolve executives (extracted module)
5. Assemble emails (template blocks with `BlockOutput`)
6. Render HTML (single pass, links placed at render time)
7. Upload to Drive (existing module)
8. Cache result (extracted module)

---

## 3. URL Pipeline Redesign: 11 Stages to 3

### Current: 11 stages

See lifecycle diagram above. Each stage operates on a different text representation.

### Proposed: 3 stages

**Stage 1: Extract (at material ingestion time)**
```typescript
interface ExtractedLink {
  anchor: string
  url: string
  source: 'document' | 'email' | 'supplemental'
  isInternal: boolean   // classified once, at extraction
  isHomepage: boolean   // classified once, at extraction
}
```

All URL filtering (`isInternalUrl`, `isHomepageUrl`) happens here. The output is a clean `ExtractedLink[]` that is the single source of truth for the entire pipeline. No regex re-extraction later.

**Stage 2: Select (in merged Pass 0+1)**
The LLM receives link anchors (not URLs) as selectable options. It picks which links are relevant per persona. URLs are not in the LLM prompt — only anchor text.

```
Available reference materials: [1] SB 122 Tax Analysis, [2] SSP Product Updates, [3] Ansible ROI Study
For the CFO persona, select relevant materials by number: [1, 3]
```

**Stage 3: Render (in HTML assembly)**
```typescript
function renderLink(link: ExtractedLink): string {
  return `<a href="${escapeHtml(link.url)}">${escapeHtml(link.anchor)}</a>`
}
```

Links go from structured data to HTML in one step. No intermediate markdown. No LLM exposure. No re-injection.

---

## 4. Consumer Generalization

PRINCIPLES.md already defines the pattern: producers emit signals, `templateAll()` assembles sections, consumers are thin. The campaign pipeline violates this by building its own signal context (40+ lines of `productFitSections` parsing, `enrichedSignals` assembly, `structuredPlays` derivation).

### Shared modules (extract from campaign, reuse across consumers)

| Module | Current location | Consumers that need it |
|---|---|---|
| `LinkRegistry` | scattered across campaign-service.ts | Campaign, Meeting Prep, Playbook, Email Outreach |
| `BlockOutput` types + validators | doesn't exist | All consumers that assemble text |
| `ExecResolver` | campaign-service.ts:1270-1532 | Campaign, Meeting Prep, Email Outreach |
| `PersonaSelector` (merged Pass 0+1) | persona-selector.ts + campaign-service.ts | Campaign, Meeting Prep, Account Plan |
| `QualityGate` | email-quality-checks.ts | All consumers |

### Consumer template

Every new consumer follows this pattern:

```typescript
async function generateConsumerOutput(customer, source, config): Promise<ConsumerResult> {
  // 1. Extract source material → ExtractedLink[] + content
  const material = await extractMaterial(source)

  // 2. Build context (shared)
  const context = await buildConsumerContext(customer)

  // 3. AI selection (one call — personas + data selection)
  const selection = await selectForConsumer(material, context, CONSUMER_SCHEMA)

  // 4. Resolve contacts if needed
  const contacts = await resolveExecutives(selection.personas, customer)

  // 5. Assemble blocks → BlockOutput[]
  const blocks = assembleBlocks(selection, context, contacts)

  // 6. Render to output format (HTML, markdown, etc.)
  const output = renderBlocks(blocks, CONSUMER_FORMAT)

  // 7. Validate
  validateOutput(output, CONSUMER_QUALITY_GATE)

  // 8. Persist
  return persist(output, customer, config)
}
```

Steps 1, 2, 4, 5, 6, 7 are shared code. Steps 3 and 8 are consumer-specific (different schemas, different persistence targets). This is 80% shared, 20% consumer-specific. The current campaign pipeline is ~20% shared, ~80% bespoke.

---

## 5. Migration Path

### Phase 1: BlockOutput types (non-breaking, 1 week)

1. Define `BlockOutput` interface in `src/lib/block-output.ts`
2. Add `validateBlock()` with the quality checks currently scattered across 40 commits
3. Change each of the 8 `build*` functions to return `BlockOutput` instead of `string`
4. `assembleEmail()` consumes `BlockOutput[]`, concatenates `.text`, collects `.links`
5. Existing `string` return is a thin wrapper: `block.text` with links inlined as markdown
6. **No behavior change.** This is a type-level refactor. All 8 blocks continue to produce the same text.

**Acceptance:** All existing tests pass. `BlockOutput` interface is enforced by TypeScript.

### Phase 2: Link isolation (non-breaking, 1 week)

1. Implement Option A from prior council finding (placeholder isolation in polish pass)
2. OR skip directly to Phase 3 (kill polish). Decision depends on whether Phase 3 ships in the same cycle.
3. Extract `LinkRegistry` from scattered URL handling
4. Move `isInternalUrl`/`isHomepageUrl` to extraction time
5. Delete `materialUrlMap` assembly from `campaign-service.ts` (lines 1704-1743)

**Acceptance:** Zero broken links in output for 5 test customers. `materialUrlMap` deleted.

### Phase 3: Kill polish pass (potentially breaking, 1 week)

1. Add conversational greeting templates to `buildOpener` (3-4 variants)
2. Integrate AE voice tokens into all 8 blocks (currently only opener uses them)
3. Remove `polishEmailBody()` call from `generateCampaignFromStructured`
4. Generate campaigns for 3 customers, compare quality with/without polish
5. If quality is acceptable: delete `polishEmailBody()` and the re-injection block
6. If quality drops: implement Option A (placeholder isolation) and keep polish

**Acceptance:** Quality comparison for 3 customers shows no regression in actionability. Total generation time drops by 50%+ (4.5 min of LLM polish eliminated).

### Phase 4: Merge Pass 0 + Pass 1 (breaking, 2 weeks)

1. Design unified schema that produces personas + per-persona data selection in one call
2. Update `persona-selector.ts` to emit the combined schema
3. Update `campaign-service.ts` to consume the combined output
4. Delete `callGeminiForCampaignSelection` (Pass 1 as separate call)
5. Update contract assertions

**Acceptance:** One LLM call produces equivalent output to current Pass 0 + Pass 1. Generation time drops further.

### Phase 5: Extract shared modules (non-breaking, 2 weeks)

1. Extract `ExecResolver` from `campaign-service.ts`
2. Extract `CampaignCache` from `campaign-service.ts`
3. Define consumer template pattern in `src/lib/consumer-pattern.ts`
4. Refactor campaign to follow the template
5. Build meeting prep consumer using the same template (proving reusability)

**Acceptance:** `campaign-service.ts` < 1,000 lines. Meeting prep consumer < 500 lines of consumer-specific code.

---

## 6. Acceptance Criteria — How We Know It Worked

### Leading indicators (measure weekly)

| Metric | Current | Target | How to measure |
|---|---|---|---|
| Campaign commits/week | 25.6 | < 5 | `git log --oneline --after=DATE src/campaign* \| wc -l` |
| campaign-html-template.ts lines | 2,061 | < 1,200 | `wc -l` |
| campaign-service.ts lines | 2,245 | < 1,000 | `wc -l` |
| LLM calls in render path | 2 | 0 | Count `callGemini` in template file |
| URL-related functions | 11 | 3 | Grep for `url\|link\|Url\|Link` function definitions |
| Link lifecycle stages | 11 | 3 | Manual trace |
| Time to generate 6-email campaign | ~7 min | ~2 min | Wall clock |

### Lagging indicators (measure after 4 weeks)

| Metric | Target | How to measure |
|---|---|---|
| Broken links in output | 0 per week | QA review of generated campaigns |
| Post-hoc quality fix commits | < 2 per week | Commit categorization |
| New consumer onboarding time | < 3 days | Time to build meeting prep consumer |
| Consumer-specific code | < 30% of total | Lines in consumer file vs shared libs |

### Kill criteria (stop and reassess)

- Quality drops measurably after killing polish (Phase 3): revert, implement placeholder isolation
- Merged Pass 0+1 produces worse persona selection: keep separate calls
- BlockOutput types add friction without catching bugs: simplify the interface

---

## Summary

The campaign pipeline is an accretion of reasonable decisions that produced an unreasonable whole. The fix is not more patches — it is structural simplification:

1. **Links as structured data** — never serialize to text until final HTML render
2. **Block output contracts** — catch quality issues at the block level, not in the final email
3. **Kill the polish pass** — invest in better templates instead of LLM rewriting
4. **Merge Pass 0 + Pass 1** — one AI decision, not two
5. **Extract shared modules** — 80% shared code across all consumers

The fundamental constraint is that LLMs are unreliable text transformers. Every time you send structured data through an LLM and try to preserve it, you create a maintenance burden. The solution is to keep structured data out of LLM scope entirely — which is exactly what PRINCIPLES.md Layer 2 already says. The pipeline just drifted from that principle over 128 commits.
