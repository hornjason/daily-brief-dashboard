---
doc-type: adr
status: accepted
owner: serena
updated: 2026-05-18
---

# ADR-025: Meeting prep enrichment — sections 4-7 gold standard alignment

**Date:** 2026-05-18

## Status

Proposed

## Context

GitHub Issue #290. The meeting prep generator produces a 10-section document via Gemini. Sections 4-7 are informational but not actionable compared to Jason's gold standard doc. The gold standard has:

- **Section 4 (Why Red Hat):** Confidence scores (HIGH/MEDIUM), specific proof point metrics ($2B ARR, 667% ROI, Forrester TEI), and Summit news cross-references
- **Section 5 (What's New):** Separate Summit/event announcements with recency framing ("these are days old"), three columns: Announcement, What's New, Why It Matters
- **Section 6 (Product Lifecycle):** Enhanced with Key Changes and Customer Angle columns beyond the basic version/EOL table
- **Section 7 (Expansion Opportunities):** Currently basic; gold standard has this elsewhere but RSS/blog intelligence is a separate timely section

The ADR-024 council decision established the hybrid inline pattern: Gemini generates narrative, system inserts deterministic reference tables via `insertAfterNumberedSection()`. This pattern is already proven for the "Other Certified Partners" table in section 2.

### Data sources already cached and available

| Source | File/Module | Data Available |
|--------|-------------|----------------|
| Product announcements | `product-release-radar.ts` → `getAllProductSummaries()` | version, GA date, EOL, summary bullets, sources |
| Product lifecycle | `product-lifecycle.ts` → `readProductLifecycleCache()` | current version, next version, next expected, GA, EOL, EUS |
| Product roadmap | `data/config/product-roadmap.json` → `loadProductRoadmap()` | next version, expected date, highlights |
| Value maps | `value-map-loader.ts` → `getValueMap(slug)` | business objectives, impact metrics, solution enablers |
| RSS feeds | `data/cache/rss/rh-feeds.json` → `loadRSSFeedItems()` | title, link, pubDate, source, productTags |
| Customer product intel | `customer-product-intel.ts` → `getCachedCustomerProductIntel()` | relevanceScore, priorityAction, featureTalkingPoints |
| Expansion opportunities | `expansion-opportunities.ts` → `getCachedExpansionOpportunities()` | product, confidence, why |
| CCSP cloud spend | `readCCSPCache()` | ACV, cloud partner, products, quarters |

This is a wiring problem, not a data collection problem.

### Prompt length concern

The current prompt is already substantial (~10K tokens with all context sections). Adding more context risks Gemini losing focus on earlier sections. The fundamental constraint is: the more structured data we ask Gemini to incorporate, the less reliably it incorporates any single piece.

## Decision

**Option 2: Enrich existing sections + hybrid inject.** Keep the 10-section structure. Gemini generates narrative for all 10 sections as it does today. The system deterministically injects enrichment tables after sections 4, 5, 6, and 7 post-Gemini, using the same `insertAfterNumberedSection()` pattern already proven for section 2.

### Why this option

**Option 1 (expand to 14 sections) rejected:** Adding 4 new sections to the Gemini prompt increases prompt complexity and reduces output quality on all sections. The prompt already has 10 sections with detailed format instructions. Going to 14 pushes Gemini past the point where it reliably follows all instructions. It also means rewriting the quality gate validator for a new section numbering scheme, which breaks existing scorecard history comparability.

**Option 3 (split generation — system generates sections 4-7 entirely) rejected:** Sections 4-7 need narrative that ties data to the specific customer. A pure data table for "Why Red Hat" without customer-specific framing is less useful than Gemini's current output. The gold standard works because it has BOTH narrative framing AND deterministic data. Removing Gemini from these sections loses the customer-specific angle.

**Option 2 is the right choice because:**
1. It preserves the proven Gemini narrative generation for all 10 sections
2. It adds deterministic data that Gemini cannot reliably produce (exact metrics, URLs, confidence calculations)
3. It uses the same `insertAfterNumberedSection()` pattern already working for section 2
4. It requires zero changes to the Gemini prompt (no risk of degrading existing output)
5. Quality gate validator stays stable — same 10 sections, same checks
6. Each enrichment table is independently testable without Gemini

### Architecture: four enrichment table builders

Each builder is a pure function that takes customer data and returns a markdown string (or empty string if no data). The route calls them after `validateAndRetry()` and before Drive upload, using `insertAfterNumberedSection()`.

```
Gemini generates 10-section document
  │
  ├── validateAndRetry() — existing quality gate
  │
  ├── insertAfterNumberedSection(content, 2, otherPartnersTable)  ← existing
  ├── insertAfterNumberedSection(content, 4, proofPointsTable)    ← NEW
  ├── insertAfterNumberedSection(content, 5, summitAnnouncementsTable) ← NEW
  ├── insertAfterNumberedSection(content, 6, lifecycleEnrichedTable)   ← NEW
  ├── insertAfterNumberedSection(content, 7, rssIntelligenceTable)     ← NEW
  │
  └── Upload to Drive as HTML
```

**Insertion order matters.** Inserts must happen in reverse section order (7, 6, 5, 4) because each insert shifts subsequent section positions. Alternatively, insert in forward order but re-find section headers each time — `insertAfterNumberedSection` already does header re-matching per call, so forward order is safe.

### Section 4 enrichment: Product Alignment with Confidence + Proof Points

**Injected after:** Section 4 (Why Red Hat)

**Builder:** `buildProductAlignmentTable(customer, productSlugs)`

**Data sources:**
- `getValueMap(slug)` — business value metrics per product
- `getCachedCustomerProductIntel(slug, customerSlug)` — relevance score, feature talking points
- `getAllProductSummaries()` — latest announcements for Summit cross-reference
- `readSheetCache(customerName)` — subscription data for use case inference

**Output format:**
```markdown
**Product Alignment — Confidence & Proof Points**
| Red Hat Product | Customer Use Case | Confidence | Key Proof Points | Summit/Recent News |
|---|---|---|---|---|
| OpenShift | Container platform modernization | HIGH | 667% ROI (Forrester TEI), $2B ARR platform | **OCP 4.17 GA** — HCP improvements |
| AAP | Infrastructure automation | MEDIUM | 60% reduction in manual tasks (IDC) | AutoML announced — automates lifecycle |
```

**Confidence scoring logic (deterministic, no Gemini):**
- **HIGH**: Customer has active subscription for this product AND (`getCachedCustomerProductIntel` relevanceScore is HIGH or CRITICAL) AND value map exists
- **MEDIUM**: Customer has active subscription OR relevance score is MEDIUM
- **LOW**: No subscription, relevance score is LOW or NONE, but product appears in expansion opportunities

**Proof points source:** Parsed from value map text. The value maps file contains structured metrics (ROI percentages, cost reductions, analyst citations). A regex extractor pulls metrics matching patterns like `\d+%`, `\$[\d,.]+[BMK]`, and named analyst reports (Forrester, IDC, Gartner).

**Summit/Recent News cross-reference:** For each product, check `getAllProductSummaries()` for announcements within the last 30 days. If found, bold the announcement and include a one-line summary. If the product has an RSS item tagged to it within 14 days, include that instead/additionally.

### Section 5 enrichment: Summit/Event Announcements

**Injected after:** Section 5 (What's New)

**Builder:** `buildSummitAnnouncementsTable(productSlugs, rssItems, productSummaries)`

**Data sources:**
- `getAllProductSummaries()` — product announcements with dates
- `loadRSSFeedItems()` — RSS feed items with recency
- `loadProductRoadmap()` — upcoming releases with expected dates

**Output format:**
```markdown
**Recent Announcements (last 30 days) — your customer's team may not have seen these yet**
| Announcement | What's New | Released | Why It Matters |
|---|---|---|---|
| AAP 2.6 GA | Ansible Lightspeed GA, Event-Driven Ansible 1.2 | May 12, 2026 | Automates AI lifecycle tasks |
| OCP 4.17.2 | HCP multi-cluster improvements | May 8, 2026 | Reduces cluster management overhead |
| RHEL AI 1.5 | InstructLab model training | Coming June 2026 | On-premise AI model customization |
```

**Recency framing:** Items within 7 days get "(days old)" suffix. Items with future expected dates get "Coming [Month Year]" prefix. This matches the gold standard's urgency framing.

**Filtering:** Only products the customer subscribes to, plus products in expansion opportunities. Capped at 8 rows to keep the table scannable.

### Section 6 enrichment: Enhanced Product Lifecycle

**Injected after:** Section 6 (Product Lifecycle)

**Builder:** `buildEnhancedLifecycleTable(customer, productSlugs, lifecycleCache, roadmapData, productSummaries)`

**Data sources:**
- `readProductLifecycleCache()` — version, EOL, GA dates
- `loadProductRoadmap()` — next version highlights
- `getAllProductSummaries()` — summary bullets as "key changes"

**Output format:**
```markdown
**Enhanced Lifecycle — Key Changes & Customer Angle**
| Product | Current | Next Release | Expected | Key Changes | Customer Angle |
|---|---|---|---|---|---|
| OCP | 4.17 | 4.18 | Q3 2026 | HCP GA, improved GitOps | Your 50-node cluster benefits from HCP cost reduction |
| AAP | 2.6 | 2.7 | Q4 2026 | Lightspeed enhancements, EDA 1.3 | Automates playbook creation across your 100 managed nodes |
| RHEL | 9.6 | 9.7 | Q1 2027 | Image mode improvements | Simplifies your 200-host fleet management |
```

**Key Changes:** Pulled from `roadmapData.highlights` (manually maintained) merged with `productSummaries.summaryBullets` (auto-generated). Cap at 3 items per product, comma-separated.

**Customer Angle:** Built deterministically from subscription data. Template: "Your {quantity} {unit} benefits from {first key change}". Falls back to a generic angle if no subscription quantity data exists. This is NOT Gemini-generated — it's a simple template fill from `readSheetCache()` quantities and the first highlight.

### Section 7 enrichment: RSS/Blog Intelligence

**Injected after:** Section 7 (Expansion Opportunities)

**Builder:** `buildRSSIntelligenceTable(productSlugs, rssItems, customerName)`

**Data sources:**
- `loadRSSFeedItems()` — cached RSS items with title, link, pubDate, source, productTags

**Output format:**
```markdown
**Latest Red Hat Blog & News Intelligence — fresh content to reference in conversation**
| Date | Source | Title | Customer Relevance |
|---|---|---|---|
| May 15 | Red Hat Blog | [Ansible Lightspeed: From Pilot to Production](https://...) | Reference in AAP discussion — their team is evaluating Lightspeed |
| May 12 | Press Release | [Red Hat Summit 2026 Keynote Recap](https://...) | Share with attendees as context for this meeting |
| May 10 | Developer Blog | [OpenShift 4.17 Migration Guide](https://...) | Relevant if discussing upgrade path |
```

**Customer Relevance column:** Simple rule-based (not Gemini):
- If RSS item's productTags match customer's subscribed products: "Reference in {product} discussion"
- If RSS item is a Summit/keynote item: "Share with attendees as context for this meeting"
- If RSS item mentions migration/upgrade: "Relevant if discussing upgrade path"
- Default: "General Red Hat news — share if relevant"

**Links preserved:** URLs are kept as markdown links. This is a key reason for hybrid inject — Gemini strips or halluccinates URLs. The system inserts real, verified links.

**Filtering:** Last 30 days, product-filtered, capped at 8 items, sorted by date descending.

### New file: `src/meeting-prep-enrichment.ts`

All four builder functions live in a single new module. Each function is a pure function (data in, markdown string out) with no side effects, no Gemini calls, and no async operations (all data sources are read from existing caches).

```typescript
// src/meeting-prep-enrichment.ts

export function buildProductAlignmentTable(
  customer: Customer,
  productSlugs: string[],
  options: {
    productSummaries: ProductSummary[]
    rssItems: RSSItem[]
    customerSlug: string
  }
): string

export function buildSummitAnnouncementsTable(
  productSlugs: string[],
  rssItems: RSSItem[],
  productSummaries: ProductSummary[],
  roadmapData: ProductRoadmapEntry[]
): string

export function buildEnhancedLifecycleTable(
  customer: Customer,
  productSlugs: string[],
  lifecycleCache: ProductLifecycleCache | null,
  roadmapData: ProductRoadmapEntry[],
  productSummaries: ProductSummary[]
): string

export function buildRSSIntelligenceTable(
  productSlugs: string[],
  rssItems: RSSItem[],
  customerName: string
): string
```

### Integration into `meeting-prep-routes.ts`

After the existing `validateAndRetry()` call and the existing `otherPartnersTable` insert:

```typescript
// Existing
if (otherPartnersTable) {
  prepContent = insertAfterNumberedSection(prepContent, 2, otherPartnersTable)
}

// NEW — enrichment tables (sections 4-7)
const alignmentTable = buildProductAlignmentTable(customer, productSlugs, {
  productSummaries, rssItems: relevantRSS, customerSlug: slug,
})
if (alignmentTable) {
  prepContent = insertAfterNumberedSection(prepContent, 4, alignmentTable)
}

const summitTable = buildSummitAnnouncementsTable(
  productSlugs, relevantRSS, productSummaries, roadmapData
)
if (summitTable) {
  prepContent = insertAfterNumberedSection(prepContent, 5, summitTable)
}

const lifecycleTable = buildEnhancedLifecycleTable(
  customer, productSlugs, lifecycleCache, roadmapData, productSummaries
)
if (lifecycleTable) {
  prepContent = insertAfterNumberedSection(prepContent, 6, lifecycleTable)
}

const rssTable = buildRSSIntelligenceTable(productSlugs, relevantRSS, customer.name)
if (rssTable) {
  prepContent = insertAfterNumberedSection(prepContent, 7, rssTable)
}
```

### Quality gate validator updates

The meeting prep validator (`meeting-prep-validator.ts`) needs NO changes for the enrichment tables. The validator runs BEFORE the tables are inserted (it validates Gemini's raw output). The enrichment tables are additive — they cannot cause a previously-passing output to fail.

However, add one new RECOMMENDED check to validate that enrichment tables were successfully inserted:

```typescript
// After the existing checks, add enrichment presence checks
checks.push({
  name: 'enrichment-product-alignment',
  passed: output.includes('Product Alignment') && output.includes('Confidence'),
  expected: 'Product Alignment enrichment table present with Confidence column',
  actual: output.includes('Product Alignment') ? 'table found' : 'table not found',
  severity: 'recommended',  // not required — data may genuinely be empty
})
```

**Important:** These checks run on the FINAL output (after insertion), not on Gemini's raw output. This means the validator must be called twice: once on raw output (for retry decisions), once on enriched output (for scorecard persistence). Or more simply: the scorecard saved to cache should reflect the enriched output. Add a `rescoreAfterEnrichment()` call after all insertions that re-runs the validator on the final content and overwrites the scorecard.

### Proof point metric extractor

A utility function in `meeting-prep-enrichment.ts` that parses value map text for quantified metrics:

```typescript
function extractProofPoints(valueMapText: string): string[] {
  const metrics: string[] = []
  // Match patterns: "667% ROI", "$2B ARR", "60% reduction", "Forrester TEI"
  const patterns = [
    /\d+%\s+\w+/g,                           // percentage metrics
    /\$[\d,.]+[BMK]?\s+\w+/g,                // dollar metrics
    /(?:Forrester|IDC|Gartner|ESG)\s+\w+/g,  // analyst citations
  ]
  for (const p of patterns) {
    const matches = valueMapText.match(p) ?? []
    metrics.push(...matches.slice(0, 3))
  }
  return [...new Set(metrics)].slice(0, 4) // dedupe, cap at 4
}
```

## Consequences

**Positive:**
- Sections 4-7 match gold standard quality with deterministic data (confidence scores, proof points, URLs, recency)
- Zero risk to Gemini output quality — prompt is unchanged
- Each enrichment table is independently testable (pure functions, no Gemini dependency)
- Links and URLs are real and verified — not hallucinated by Gemini
- Confidence scoring is deterministic and explainable (not an LLM judgment)
- Pattern reuse — same `insertAfterNumberedSection()` proven for section 2

**Negative:**
- Customer Angle in lifecycle table is template-based, not as nuanced as Gemini-generated prose
- Proof point extraction via regex may miss non-standard metric formats in value maps
- Four additional table inserts add ~2-4KB to the final document

**Risks:**
- `insertAfterNumberedSection` relies on Gemini numbering sections correctly. If Gemini renumbers or uses different header formats, inserts land in wrong positions. **Mitigation:** The quality gate already validates all 10 sections exist with correct numbering. If validation fails, enrichment is skipped (empty string returned).
- RSS cache may be empty or stale. **Mitigation:** All builders return empty string when no data is available. The document is still valid without enrichment.
- Value map parsing may return low-quality proof points for some products. **Mitigation:** If fewer than 2 metrics are extracted, the Proof Points column shows "See value map documentation" instead of partial data.

## Phase 1 Scope (this ADR)

**Create:**
- `src/meeting-prep-enrichment.ts` — four builder functions + proof point extractor

**Modify:**
- `src/meeting-prep-routes.ts` — call builders after validateAndRetry, insert tables
- `src/quality-validators/meeting-prep-validator.ts` — add recommended checks for enrichment presence on final output; add `rescoreAfterEnrichment()` pattern

**Leave alone:**
- `src/gemini-quality-gate.ts` — no changes
- `src/gemini-call.ts` — no changes
- Gemini prompt in `meeting-prep-routes.ts` — no changes to the system or user prompt
- All data source modules — no changes (read-only consumers)
- Dashboard frontend — no changes (Phase 2 scope if quality dashboard needed)

**Tests:**
- Unit tests for each builder function (known inputs, expected markdown output)
- Unit test for `extractProofPoints()` against real value map text samples
- Unit test for confidence scoring logic (HIGH/MEDIUM/LOW boundaries)
- Integration test: generate meeting prep and verify enrichment tables present in final output

## Implementation notes for Marcus

**Files to create:**
1. `src/meeting-prep-enrichment.ts` — all four builders, pure functions, sync only. Import types from existing modules but call no async APIs. All data is passed in as arguments.

**Files to modify:**
1. `src/meeting-prep-routes.ts`:
   - Import the four builders from `meeting-prep-enrichment.ts`
   - After line ~855 (after `otherPartnersTable` insert), add the four enrichment table inserts
   - The data needed (`productSummaries`, `relevantRSS`, `lifecycleCache`, `roadmapData`) is already loaded earlier in the function
   - `customerSlug` is already available as `slug`
   - `productSlugs` is already computed

2. `src/quality-validators/meeting-prep-validator.ts`:
   - Add 4 recommended checks for enrichment table presence
   - These run on final enriched output only (not on raw Gemini output during retry loop)
   - Export a `rescoreEnrichedOutput(output: string): QualityScorecard` that re-runs full validation on enriched content

**Type imports needed in `meeting-prep-enrichment.ts`:**
```typescript
import type { Customer } from './types.ts'
import type { ProductSummary } from './product-release-radar.ts'
import type { ProductLifecycleCache } from './product-lifecycle.ts'
```

**RSS item type (inline or imported):**
```typescript
interface RSSItem {
  title: string
  link: string
  pubDate: string
  source: string
  productTags: string[]
}
```

**Subscription data access:**
```typescript
import { readSheetCache } from './cache-layer.ts'
const subCache = readSheetCache(customer.name)
```

**Value map access:**
```typescript
import { getValueMap } from './value-map-loader.ts'
const text = getValueMap(slug) // returns string | null
```

**Customer product intel access:**
```typescript
import { getCachedCustomerProductIntel } from './customer-product-intel.ts'
const intel = getCachedCustomerProductIntel(productSlug, customerSlug)
```

## References

- GitHub #290
- ADR-024 (quality gate — `validateAndRetry()` and `insertAfterNumberedSection()`)
- `src/meeting-prep-routes.ts` — existing route with hybrid inject pattern
- `src/quality-validators/meeting-prep-validator.ts` — existing validator
- Gold standard meeting prep doc (from MeetingPrep skill)
