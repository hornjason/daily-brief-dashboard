---
doc-type: adr
status: proposed
owner: serena
updated: 2026-06-22
---

# ADR-041: Structured Document Intelligence Enrichment Schema

**Date:** 2026-06-22
**References:** ADR-040 (Universal Structured Output), ADR-024 (Quality Gate), ADR-023 (callGemini), ADR-029 (Portfolio Signal Cross-Reference), ADR-035 (Signal Routing), ADR-038 (Dynamic Matching), PRINCIPLES.md (Three-Layer Architecture)
**Deciders:** Serena Blackwood (architecture), Rayford (DA)
**Trigger:** GitHub #866 -- SalesHub enrichment cannot surface documents by integration, competitor, or partner. When a customer has Ansible + ServiceNow in their tech stack, the ServiceNow ITSM content kit is invisible because the enrichment extracts per-document-type arrays with no classification by what the document is ABOUT.

## Status

Proposed

## Context

### The Problem: Enrichment Extracts Structure, Not Intelligence

The current enrichment pipeline (`src/lib/saleshub-product-enrichment.ts`) processes documents through 5 type-specific extraction configs -- content kits, messaging guides, battlecards, case studies, and competitive reviews. Each produces a type-specific shape (`ContentKitExtraction`, `DocumentExtraction`, `CaseStudyExtraction`, `CompetitiveReviewExtraction`). The `ProductEnrichment` aggregate groups them by document type.

This tells the system WHAT each document IS (a content kit, a battlecard). It does not tell the system what each document is ABOUT. A content kit about ServiceNow ITSM integration with Ansible looks identical to a content kit about AWS migration with OpenShift -- both are `ContentKitExtraction` objects with `actionableSteps`, `workshops`, `demos`, etc.

The fundamental constraint: **classification by document type is not the same as classification by document content.** The signal pipeline needs to know which technologies, competitors, partners, and use cases a document references -- not which editorial format it uses.

### What Exists Today

**Current extraction types and what they capture:**

| Type | Fields | What's missing |
|------|--------|---------------|
| `ContentKitExtraction` | cloudProvider, actionableSteps, workshops, demos, battlecards, internalMaterials, salesPlayAlignment | No integrations, no competitors, no use cases, no customer scenarios |
| `DocumentExtraction` | summary, keyPoints, talkTracks, links | Generic -- no structured classification at all |
| `CaseStudyExtraction` | customerName, industry, challenge, solution, results, productsUsed | Has productsUsed but no integrations, no competitor displacement |
| `CompetitiveReviewExtraction` | competitor, keyDifferentiators, competitorWeaknesses, talkTracks | Single competitor string -- no resolution against vocabulary |

**Cross-referencing modules that already exist but are disconnected:**

| Module | File | What it knows |
|--------|------|---------------|
| `product-vocabulary.ts` | `src/lib/product-vocabulary.ts` | Resolves RH product names to canonical slugs (ocp, aap, rhel, etc.) |
| `competitive-vocabulary.ts` | `src/lib/competitive-vocabulary.ts` | Resolves competitor tech names to displacement products and solution plays |
| `ecosystem-catalog.ts` | `src/lib/ecosystem-catalog.ts` | Partner solutions with platform, categories, resources, Ansible collections |
| `customer-product-context.ts` | `src/lib/customer-product-context.ts` | Customer owned products (subscriptions) and interest products (intelligence themes) |
| `customer-solution-context.ts` | `src/lib/customer-solution-context.ts` | Solution plays matched against customer tech stack |
| `tech-stack-module` | `src/modules/tech-stack-module.ts` | Customer's detected technology stack (from Gemini extraction) |

The data to match documents to customers exists. The enrichment just does not produce the fields needed to connect the two.

### Hard Constraints

1. **ADR-040:** responseSchema with `nullable: true`, strict grounding instruction, temperature <= 0.3
2. **ADR-024:** Quality validator with `validateAndRetry()` -- enrichment already uses this pattern
3. **ADR-023:** All Gemini calls through `callGemini()`
4. **ADR-029:** Customer cross-referencing for scoring -- portfolio signals need `customerSlug` from subscription/interest match
5. **ADR-038:** No new handcrafted mapping files -- use dynamic sources (product-vocabulary, competitive-vocabulary, ecosystem-catalog)
6. **ADR-035:** Signal routing -- `saleshub-products` source already routes to `'product'` category; this must not break
7. **PRINCIPLES.md:** Deterministic templating for rendering; Gemini only for extraction/classification
8. **Vocabulary resolver rule (PRINCIPLES.md):** No hardcoded product/competitor/technology names
9. **Existing `extractWithGemini<T>(config)` pattern:** The recently refactored generic extraction ceremony should be the mechanism; no parallel extraction pattern
10. **Batching rule (#841):** Max 5 concurrent Gemini calls via `Promise.allSettled()`, unchanged docs skipped via delta check, docs > 10MB skipped

## Decision

### Core Principle: Every Document Gets a Single, Universal Intelligence Extraction

Replace the 5 type-specific extraction configs with ONE universal `DocumentIntelligence` extraction config. Every document -- regardless of editorial format -- gets the same structured intelligence fields. The document type (content kit, battlecard, etc.) becomes ONE field in the schema, not the organizing principle of the extraction.

This is the same insight behind ADR-027 (modules report facts, the registry scores): **enrichment reports facts about document content, the signal pipeline scores and routes them.** The enrichment should not decide relevance; it should extract what the document is about and let the existing cross-referencing modules determine relevance per customer.

### 1. The `DocumentIntelligence` Type

```typescript
export interface DocumentIntelligence {
  documentName: string
  documentCategory: DocumentCategory
  summary: string

  // What the document is ABOUT (structured classification)
  productsReferenced: ProductReference[]
  integrationsReferenced: IntegrationReference[]
  competitorsReferenced: CompetitorReference[]
  partnerSolutions: PartnerSolutionReference[]
  useCases: string[]
  customerScenarios: CustomerScenario[]
  cloudProviders: string[]

  // Who the document is FOR
  audience: 'internal' | 'partner' | 'customer' | 'mixed'

  // What the document CONTAINS (preserved from current extraction)
  keyPoints: string[]
  talkTracks: string[]
  links: Array<{ name: string; url: string }>
  actionableSteps: Array<{ step: string; url?: string }>
  workshops: Array<{ name: string; url: string }>
  demos: Array<{ name: string; url: string }>

  // Provenance
  enrichedAt: string
  sourceProductSlug: string  // which RH product page this document came from
}

export type DocumentCategory =
  | 'content-kit'
  | 'messaging-guide'
  | 'battlecard'
  | 'case-study'
  | 'competitive-review'
  | 'solution-brief'
  | 'design-guide'
  | 'workshop'
  | 'demo'
  | 'reference-architecture'
  | 'migration-guide'
  | 'other'

export interface ProductReference {
  name: string          // as extracted from document (e.g., "Ansible Automation Platform")
  slug: string | null   // resolved via product-vocabulary.ts -- null if unresolvable
}

export interface IntegrationReference {
  technology: string    // as extracted (e.g., "ServiceNow", "Cisco ACI")
  category: string      // e.g., "ITSM", "Networking", "CI/CD", "Monitoring"
}

export interface CompetitorReference {
  name: string          // as extracted (e.g., "VMware", "Puppet")
  context: string       // e.g., "displacement", "comparison", "migration-from"
}

export interface PartnerSolutionReference {
  partnerName: string   // as extracted (e.g., "ServiceNow", "CrowdStrike")
  solutionArea: string  // e.g., "ITSM", "Security", "Observability"
}

export interface CustomerScenario {
  scenario: string      // e.g., "Migrating from VMware to OpenShift Virtualization"
  industry: string | null
}
```

### 2. The Enrichment Aggregate Changes

```typescript
// BEFORE: ProductEnrichment grouped by document type
export interface ProductEnrichment {
  productSlug: string
  enrichedAt: string
  contentKits: ContentKitExtraction[]
  messagingGuides: DocumentExtraction[]
  battlecards: DocumentExtraction[]
  caseStudies: CaseStudyExtraction[]
  competitiveReviews: CompetitiveReviewExtraction[]
}

// AFTER: ProductEnrichment is a flat list of intelligence extractions
export interface ProductEnrichment {
  productSlug: string
  enrichedAt: string
  documents: DocumentIntelligence[]

  // Backward compatibility -- old consumers that read typed arrays
  // These are computed views, not separate extractions.
  contentKits: ContentKitExtraction[]       // DEPRECATED -- will be removed
  messagingGuides: DocumentExtraction[]     // DEPRECATED -- will be removed
  battlecards: DocumentExtraction[]         // DEPRECATED -- will be removed
  caseStudies: CaseStudyExtraction[]        // DEPRECATED -- will be removed
  competitiveReviews: CompetitiveReviewExtraction[] // DEPRECATED -- will be removed
}
```

The deprecated arrays are populated from `documents` at serialization time by filtering on `documentCategory`. This maintains backward compatibility while the codebase migrates to the new `documents` array. They should be removed once all consumers read from `documents`.

### 3. ExtractionConfig for DocumentIntelligence

A single `ExtractionConfig<DocumentIntelligence>` replaces the 5 type-specific configs. The extraction uses responseSchema (ADR-040) with field descriptions that reference the document content.

**responseSchema structure (Gemini constraint):**

```typescript
const DOCUMENT_INTELLIGENCE_SCHEMA = {
  type: "object",
  properties: {
    documentCategory: {
      type: "string",
      enum: ["content-kit", "messaging-guide", "battlecard", "case-study",
             "competitive-review", "solution-brief", "design-guide",
             "workshop", "demo", "reference-architecture", "migration-guide", "other"],
      description: "The editorial format/type of this document based on its structure and content."
    },
    summary: {
      type: "string",
      description: "1-2 sentence summary of the document's primary purpose and content."
    },
    productsReferenced: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Red Hat product name as mentioned in the document." }
        },
        required: ["name"]
      },
      description: "All Red Hat products mentioned in the document. Extract exact product names."
    },
    integrationsReferenced: {
      type: "array",
      items: {
        type: "object",
        properties: {
          technology: { type: "string", description: "Third-party technology name (e.g., ServiceNow, Cisco ACI, Splunk)." },
          category: { type: "string", description: "Technology category: ITSM, Networking, CI/CD, Monitoring, Security, Cloud, Storage, Virtualization, Database, or Other." }
        },
        required: ["technology", "category"]
      },
      nullable: true,
      description: "Third-party technologies this document discusses integration with. Set null if the document does not reference any third-party integrations."
    },
    competitorsReferenced: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Competitor company or product name." },
          context: { type: "string", enum: ["displacement", "comparison", "migration-from", "coexistence"], description: "How the competitor is referenced in the document." }
        },
        required: ["name", "context"]
      },
      nullable: true,
      description: "Competitor technologies or products referenced. Set null if no competitors are mentioned."
    },
    partnerSolutions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          partnerName: { type: "string", description: "Technology partner company name." },
          solutionArea: { type: "string", description: "Solution category: ITSM, Security, Observability, Networking, Storage, or Other." }
        },
        required: ["partnerName", "solutionArea"]
      },
      nullable: true,
      description: "Partner solutions referenced as complementary to Red Hat products. Set null if no partner solutions are mentioned."
    },
    useCases: {
      type: "array",
      items: { type: "string" },
      nullable: true,
      description: "Specific use cases the document addresses (e.g., 'Network automation', 'Container security', 'VM migration'). Set null if no specific use cases are described."
    },
    customerScenarios: {
      type: "array",
      items: {
        type: "object",
        properties: {
          scenario: { type: "string", description: "Customer scenario described (e.g., 'Migrating from VMware to OpenShift Virtualization')." },
          industry: { type: "string", nullable: true, description: "Industry if mentioned. Set null if industry-agnostic." }
        },
        required: ["scenario"]
      },
      nullable: true,
      description: "Customer scenarios or use cases with industry context. Set null if none described."
    },
    cloudProviders: {
      type: "array",
      items: { type: "string" },
      nullable: true,
      description: "Cloud providers referenced (AWS, Azure, Google Cloud, IBM Cloud). Set null if not cloud-specific."
    },
    audience: {
      type: "string",
      enum: ["internal", "partner", "customer", "mixed"],
      description: "Primary audience for this document based on its content and tone."
    },
    keyPoints: {
      type: "array",
      items: { type: "string" },
      description: "Key messaging points or value propositions from the document."
    },
    talkTracks: {
      type: "array",
      items: { type: "string" },
      nullable: true,
      description: "Recommended talk tracks for sales conversations. Set null if none present."
    },
    links: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          url: { type: "string" }
        },
        required: ["name", "url"]
      },
      description: "All hyperlinks from the document. Preserve URLs exactly."
    },
    actionableSteps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          step: { type: "string" },
          url: { type: "string", nullable: true }
        },
        required: ["step"]
      },
      nullable: true,
      description: "Actionable steps with optional URLs. Set null if none present."
    },
    workshops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          url: { type: "string" }
        },
        required: ["name", "url"]
      },
      nullable: true,
      description: "Workshops or labs referenced. Set null if none."
    },
    demos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          url: { type: "string" }
        },
        required: ["name", "url"]
      },
      nullable: true,
      description: "Demos or interactive experiences referenced. Set null if none."
    }
  },
  required: ["documentCategory", "summary", "productsReferenced", "audience", "keyPoints", "links"]
}
```

**Why a single universal extraction:**

- **Fewer Gemini calls per product.** Currently 5 extraction configs require understanding the document type BEFORE extraction (the caller picks the config). With one config, every document gets the same extraction regardless of type. The `documentCategory` field lets the model classify the type as part of extraction, not as a prerequisite.
- **Richer extraction.** A battlecard currently only gets competitor + differentiators + weaknesses. With the universal schema, a battlecard about VMware vs OpenShift Virtualization also captures `integrationsReferenced: [{ technology: "vSphere", category: "Virtualization" }]` and `useCases: ["VM migration"]`. The same VMware data is what makes it matchable to a customer with VMware in their tech stack.
- **Consistent quality gate.** One validator, one retry loop, one scorecard. The current 4 validators (`contentKitValidator`, `documentExtractionValidator`, `caseStudyValidator`, `competitiveReviewValidator`) each check different fields with different thresholds. One universal validator with weighted checks is simpler and more maintainable.

### 4. Post-Extraction Resolution (No Gemini)

After Gemini extracts the raw `DocumentIntelligence`, a deterministic post-processing step resolves names against vocabulary modules. This runs OUTSIDE Gemini -- pure TypeScript, no LLM.

```
Gemini extraction (per document)
  -> Raw DocumentIntelligence (names as extracted from text)
    -> resolveProductReferences(doc.productsReferenced)
       Uses product-vocabulary.ts resolveToSlug()
       Sets slug field on each ProductReference
    -> resolveCompetitorReferences(doc.competitorsReferenced)
       Uses competitive-vocabulary.ts getDisplacementTarget()
       Annotates with displacement RH product slug
    -> resolvePartnerSolutions(doc.partnerSolutions)
       Uses ecosystem-catalog.ts findSolutionsByPartner()
       Annotates with catalog match (resources, collections, URL)
    -> Resolved DocumentIntelligence (enriched with vocabulary cross-refs)
```

**Why deterministic resolution instead of asking Gemini to resolve:**
- Product slugs change when `product-intel-config.json` is updated -- Gemini's training data has no access to the live config
- Competitive vocabulary is built from solution plays and competitive intel decks -- dynamic data that Gemini cannot see
- Ecosystem catalog is scraped from catalog.redhat.com -- live data that changes weekly
- Resolution is exact string matching and substring matching -- does not benefit from LLM reasoning
- This follows ADR-038: dynamic sources, not hardcoded mappings, and not LLM-generated mappings

### 5. Customer Cross-Referencing at Signal-Emit Time

The `saleshub-products-module.ts` `signals(customerSlug)` method already cross-references customer subscriptions (ADR-029 pattern). This decision extends that cross-referencing to use the new `integrationsReferenced` and `competitorsReferenced` fields.

**Current cross-referencing (subscription match only):**
```
customer owns AAP -> signals about AAP product page -> customerSlug set -> customer tier (floor 0.50)
```

**Extended cross-referencing (integration + competitor match):**
```
customer has ServiceNow in tech stack
  -> document has integrationsReferenced: [{ technology: "ServiceNow" }]
    -> signal gets customerSlug + metadata.matchType: 'integration'
    -> customer tier (floor 0.50)

customer has VMware in tech stack
  -> document has competitorsReferenced: [{ name: "VMware", context: "migration-from" }]
    -> signal gets customerSlug + metadata.matchType: 'competitor-displacement'
    -> customer tier (floor 0.50) + context: 'migrating_from' booster (+0.10)
```

**How the matching works at signal-emit time:**

```typescript
function matchDocumentToCustomer(
  doc: DocumentIntelligence,
  customerSlug: string
): { matched: boolean; matchType: string; matchedItems: string[] } {
  // 1. Load customer tech stack from tech-stack-module cache
  const techStack = loadTechStackCache(customerSlug)
  if (!techStack) return { matched: false, matchType: '', matchedItems: [] }

  const techNames = techStack.technologies.map(t => t.name.toLowerCase())

  // 2. Check integration matches
  const integrationMatches = (doc.integrationsReferenced ?? [])
    .filter(i => techNames.some(t =>
      t.includes(i.technology.toLowerCase()) ||
      i.technology.toLowerCase().includes(t)
    ))

  if (integrationMatches.length > 0) {
    return {
      matched: true,
      matchType: 'integration',
      matchedItems: integrationMatches.map(i => i.technology)
    }
  }

  // 3. Check competitor matches (customer has the competitor tech -> displacement opportunity)
  const competitorMatches = (doc.competitorsReferenced ?? [])
    .filter(c => techNames.some(t =>
      t.includes(c.name.toLowerCase()) ||
      c.name.toLowerCase().includes(t)
    ))

  if (competitorMatches.length > 0) {
    return {
      matched: true,
      matchType: competitorMatches[0].context === 'migration-from'
        ? 'competitor-displacement' : 'competitor-context',
      matchedItems: competitorMatches.map(c => c.name)
    }
  }

  // 4. Check partner solution matches
  const partnerMatches = (doc.partnerSolutions ?? [])
    .filter(p => techNames.some(t =>
      t.includes(p.partnerName.toLowerCase()) ||
      p.partnerName.toLowerCase().includes(t)
    ))

  if (partnerMatches.length > 0) {
    return {
      matched: true,
      matchType: 'partner',
      matchedItems: partnerMatches.map(p => p.partnerName)
    }
  }

  return { matched: false, matchType: '', matchedItems: [] }
}
```

**Signal metadata emitted for matched documents:**

```typescript
metadata: {
  customerSlug,
  matchType: 'integration' | 'competitor-displacement' | 'competitor-context' | 'partner',
  matchedTechnologies: ['ServiceNow'],
  documentCategory: doc.documentCategory,
  documentName: doc.documentName,
  redHatProducts: doc.productsReferenced.map(p => p.slug).filter(Boolean),
  sourceProductSlug: doc.sourceProductSlug,
  integrationsReferenced: doc.integrationsReferenced,
  links: doc.links.slice(0, 3),  // top 3 links for template rendering
}
```

This metadata feeds the existing ADR-027 scoring system. `customerSlug` present = customer tier (floor 0.50). `redHatProducts` present = +0.10 booster. `matchType: 'competitor-displacement'` with `context: 'migrating_from'` = +0.10 booster. A ServiceNow ITSM content kit for a customer with ServiceNow in their stack will score 0.70+ (High tier) -- directly actionable in conversation.

### 6. Template Rendering for Matched Documents

The template engine (`src/lib/signal-templates.ts`) already has a `templateSalesHubInsights()` function for the `'saleshub'` route. This function is extended to render integration-matched documents using deterministic templating (no Gemini).

**Template output for an integration-matched document:**

```markdown
### ServiceNow ITSM Integration -- Content Kit
**Matched:** Customer uses ServiceNow (detected in tech stack)
**Products:** Ansible Automation Platform
**Use cases:** ITSM automation, ticket-driven remediation
- [ServiceNow ITSM Content Kit](https://saleshub.redhat.com/...)
- [Interactive Lab: Ansible + ServiceNow](https://labs.redhat.com/...)
- [Solution Brief: Automating ITSM with Ansible](https://redhat.com/...)
```

This is pure deterministic templating from structured data. No Gemini involvement in rendering.

### 7. Quality Validator

A single `documentIntelligenceValidator` replaces the current 4 validators. Checks:

| Check | Severity | Rule |
|-------|----------|------|
| `productsReferenced` non-empty | required | Every RH product document references at least one RH product |
| At least 1 of `integrations`, `useCases`, `competitors`, `partnerSolutions` populated | required | A document with zero classification is useless for matching |
| `summary` length >= 20 chars | required | Non-trivial summary |
| `keyPoints` >= 1 | required | At least one key point extracted |
| `links` count >= 1 | recommended | Most documents have at least one link |
| `documentCategory` is valid enum | required | Must be a recognized category |
| `audience` is valid enum | required | Must be a recognized audience |

Pass threshold: 75 (consistent with other validators in the system).

### 8. Migration Path

**Phase 1 (this ADR):**
- New `DocumentIntelligence` type in `saleshub-product-types.ts`
- New universal `ExtractionConfig<DocumentIntelligence>` in `saleshub-product-enrichment.ts`
- Post-extraction vocabulary resolution (product, competitor, partner)
- Quality validator in `quality-validators/document-intelligence-validator.ts`
- `ProductEnrichment.documents` array populated
- Deprecated arrays (`contentKits`, `messagingGuides`, etc.) populated from `documents` for backward compat
- `saleshub-products-module.ts` `signals()` extended with integration/competitor/partner matching
- `templateSalesHubInsights()` updated for integration-matched document rendering

**Phase 2 (future -- tracked as backlog):**
- Remove deprecated arrays from `ProductEnrichment`
- Migrate all consumers reading typed arrays to `documents`
- Add `documentCategory` filter to signal debug endpoint

## Consequences

**Positive:**
- **Closes the matching gap.** Documents about ServiceNow/VMware/Cisco integrations become findable when customers have those technologies in their stack. This was impossible before because the enrichment did not capture what documents are about.
- **Reduces Gemini calls.** One extraction per document instead of routing to 5 different extraction configs. The `documentCategory` is a field in the schema, not a prerequisite for choosing the schema.
- **Leverages existing infrastructure.** ADR-040 responseSchema, ADR-024 quality gate, ADR-029 customer cross-referencing, ADR-035 signal routing, vocabulary resolvers -- all existing patterns, no new infrastructure.
- **Deterministic matching.** Customer matching uses exact string comparison against tech stack and vocabulary resolvers. No Gemini involved in matching -- only in extraction.
- **Backward compatible.** Deprecated arrays maintain existing consumer behavior during migration.
- **One quality validator instead of four.** Simpler to maintain, consistent thresholds.

**Negative:**
- **Larger responseSchema.** The universal schema has ~15 top-level fields vs 5-8 in the type-specific schemas. This increases prompt token count by ~300-500 tokens per extraction. Negligible against document content (2000-10000 tokens).
- **Coarser extraction.** Type-specific prompts could be tuned for each document type (battlecard prompts emphasize differentiators, case study prompts emphasize results). The universal prompt must handle all types. Mitigation: responseSchema field descriptions provide type-specific guidance via the `documentCategory` field.
- **Migration period with dual data.** Both `documents` and deprecated typed arrays exist in `ProductEnrichment` until Phase 2. Slightly larger cache files.

**Risks:**
- **Integration name matching precision.** Substring matching ("ServiceNow" in tech stack vs "ServiceNow" in document) may false-positive on short names. Mitigation: use the same matching threshold as tech-stack-module (minimum 4 characters for substring match). Apply the competitive-vocabulary resolver for known competitor names to get canonical forms.
- **responseSchema timeout.** The schema has ~15 fields with nested arrays. Campaign schema (ADR-040) with ~10 fields across 6 emails uses 120s timeout. Document intelligence schema is comparable. Use `timeoutMs: 90000` (model: lite + structured output is faster than model: pro + freeform).
- **Quality gate threshold.** Starting at 75 -- same as account-plan-validator. If pass rate is too low (< 70% of documents), lower to 60. If pass rate is > 98%, tighten to 85. Review after 1 week of enrichment data.

## Alternatives Considered

### Alternative 1: Add Integration Fields to Existing Type-Specific Extractions

Add `integrationsReferenced`, `competitorsReferenced`, etc. to each of the 5 existing extraction types.

**Rejected because:** This multiplies the maintenance surface -- every new classification field must be added to all 5 types and all 5 extraction prompts. The fundamental problem (classification by type, not by content) remains. A content kit and a battlecard about the same ServiceNow integration would have the same integration fields but different shapes, making cross-type queries complex.

### Alternative 2: Two-Pass Extraction (Type-Specific + Classification)

Keep existing type-specific extraction, add a second Gemini call for classification only.

**Rejected because:** Doubles Gemini cost per document. The existing extraction already reads the full document content -- there is no information in the classification pass that was not available in the first pass. A single pass with a richer schema captures both structure and classification simultaneously.

### Alternative 3: Rule-Based Classification Without Gemini

Use regex/keyword matching on document content to detect integrations and competitors without Gemini.

**Rejected because:** Document content is unstructured text (Google Docs HTML, PDFs). Keyword matching cannot distinguish "ServiceNow" as a referenced integration vs "ServiceNow" as a passing mention or a competitor comparison. Gemini's language understanding is needed to classify the ROLE of each reference (integration vs comparison vs displacement). Post-extraction vocabulary resolution is still rule-based -- the split is correct: Gemini for understanding context, rules for resolving to canonical identifiers.

### Alternative 4: Per-Consumer Enrichment

Each consumer (playbook, brief, campaign) runs its own Gemini call to extract what it needs from documents.

**Rejected because:** This violates the thin-consumer principle (PRINCIPLES.md Layer 3). Consumers call `templateAll()` and slice -- they do not run their own Gemini extraction. The enrichment is a producer concern (Layer 1). Consumers should not even know that documents exist as raw text.

## PRINCIPLES.md Update

### New Pre-flight Question (add as #22)

**22. Does this module enrich SalesHub documents? (ADR-041)**
Every module that enriches SalesHub product documents MUST use the universal `DocumentIntelligence` schema with `responseSchema` (ADR-040). Extraction must populate `productsReferenced`, and at least one of `integrationsReferenced`, `useCases`, `competitorsReferenced`, or `partnerSolutions`. Post-extraction resolution against vocabulary modules (`product-vocabulary.ts`, `competitive-vocabulary.ts`, `ecosystem-catalog.ts`) is mandatory -- never ask Gemini to resolve to canonical slugs.

### New Anti-pattern

- Extracting SalesHub documents into type-specific schemas without content classification (ADR-041) -- type-specific extraction (content kit vs battlecard) tells the system WHAT the document IS but not what it is ABOUT. Every extraction must include structured classification fields (`integrationsReferenced`, `competitorsReferenced`, `partnerSolutions`, `useCases`) so the signal pipeline can match documents to customers by technology overlap. Without these fields, documents are invisible to customers who should see them.

### Consumer-File Mapping Update

The entry for `src/lib/saleshub-product-enrichment.ts` remains in the "Gemini Callers -- Not Consumers" table (Role: Producer, Why excluded: Enriches SalesHub product documents with Gemini). No change needed -- it is already listed.

### Cross-reference Index Update

| Pre-flight # | ADR | Question |
|---|---|---|
| 22 | ADR-041 | SalesHub document enrichment uses DocumentIntelligence schema |

## Implementation Brief for Marcus

### Exact `DocumentIntelligence` TypeScript Interface

See Section 1 of this ADR for the complete type definitions. All types go in `src/types/saleshub-product-types.ts`.

New types to add:
- `DocumentIntelligence`
- `DocumentCategory` (union type)
- `ProductReference`
- `IntegrationReference`
- `CompetitorReference`
- `PartnerSolutionReference`
- `CustomerScenario`

Modify `ProductEnrichment` to add `documents: DocumentIntelligence[]` field. Keep existing typed arrays but mark with `// DEPRECATED` comment.

### ExtractionConfig for DocumentIntelligence

In `src/lib/saleshub-product-enrichment.ts`:

1. Add the `DOCUMENT_INTELLIGENCE_SCHEMA` constant (from Section 3 of this ADR)
2. Add a new system prompt with the ADR-040 mandatory grounding block:
   ```
   ## GROUNDING RULES (MANDATORY -- ZERO EXCEPTIONS)
   1. Every claim MUST come from the provided document content.
   2. If the document does not mention a technology, product, or competitor, set the field to null.
   3. Never extrapolate or infer integrations that are not explicitly discussed.
   4. Preserve all URLs exactly as they appear.
   ```
3. Create `documentIntelligenceConfig: ExtractionConfig<DocumentIntelligence>` with:
   - `callType: 'document-intelligence-extraction'`
   - `systemPrompt`: extraction prompt + grounding block
   - `userPromptFn`: standard content injection
   - `validator`: new `documentIntelligenceValidator`
   - `parseResult`: maps raw JSON to `DocumentIntelligence`, calls resolution functions
4. `callGemini` opts must include `responseSchema: DOCUMENT_INTELLIGENCE_SCHEMA` and `temperature: 0.3`
5. Keep `extractWithGemini<T>` as the extraction mechanism -- the new config plugs into the existing ceremony

### Post-Extraction Resolution Functions

Create `src/lib/document-intelligence-resolver.ts`:

1. `resolveProductReferences(refs: ProductReference[]): ProductReference[]` -- calls `resolveToSlug()` from `product-vocabulary.ts` on each `ref.name`, sets `ref.slug`
2. `resolveCompetitorReferences(refs: CompetitorReference[]): CompetitorReference[]` -- calls `getDisplacementTarget()` from `competitive-vocabulary.ts` on each `ref.name` (logs displacement RH product if found)
3. `resolvePartnerSolutions(refs: PartnerSolutionReference[]): PartnerSolutionReference[]` -- calls `findSolutionsByPartner()` from `ecosystem-catalog.ts` on each `ref.partnerName` (annotates with catalog match)

These are pure functions -- no Gemini, no async (vocabulary modules are in-memory singletons).

### Quality Validator

Create `src/quality-validators/document-intelligence-validator.ts`:

```typescript
export const documentIntelligenceValidator: QualityValidator = {
  contentType: 'document-intelligence',
  passThreshold: 75,
  validate(output: string): QualityScorecard {
    // Parse JSON, check:
    // - productsReferenced.length >= 1 (required)
    // - At least 1 of: integrationsReferenced, useCases,
    //   competitorsReferenced, partnerSolutions non-empty (required)
    // - summary.length >= 20 (required)
    // - keyPoints.length >= 1 (required)
    // - documentCategory is valid enum (required)
    // - audience is valid enum (required)
    // - links.length >= 1 (recommended)
  }
}
```

### Customer Cross-Referencing in `saleshub-products-module.ts`

In the `signals(customerSlug)` method:

1. For each `DocumentIntelligence` in the enrichment:
   a. Call `matchDocumentToCustomer(doc, customerSlug)` (see Section 5 of this ADR)
   b. If matched: emit signal with `customerSlug` in metadata, `matchType`, `matchedTechnologies`
   c. If not matched: emit signal WITHOUT `customerSlug` (general tier, per existing behavior)
2. Tech stack cache: read from `data/cache/tech-stack/{customerSlug}.json` (same path tech-stack-module uses)
3. The existing subscription-based cross-referencing stays -- this ADDS integration/competitor matching alongside it

### Template Rendering

In `src/lib/signal-templates.ts`, extend `templateSalesHubInsights()`:

1. Check signal metadata for `matchType` field
2. If `matchType` is present (integration/competitor/partner match):
   - Render document name + matched technology + use cases
   - Include top 3 links as linkbacks
   - Include source product slug for context
3. If no `matchType`: render existing format (product-level document listing)

### Files to Create

| File | Purpose |
|------|---------|
| `src/lib/document-intelligence-resolver.ts` | Post-extraction vocabulary resolution (product, competitor, partner) |
| `src/quality-validators/document-intelligence-validator.ts` | Quality validator for DocumentIntelligence extraction |

### Files to Modify

| File | What changes |
|------|-------------|
| `src/types/saleshub-product-types.ts` | Add DocumentIntelligence + sub-types. Add `documents` to ProductEnrichment. Mark typed arrays deprecated. |
| `src/lib/saleshub-product-enrichment.ts` | Add `documentIntelligenceConfig`. Add `DOCUMENT_INTELLIGENCE_SCHEMA`. Add `enrichDocumentIntelligence()` function. Update `enrichProductDocuments()` to populate `documents` array AND backward-compat typed arrays. |
| `src/modules/saleshub-products-module.ts` | Extend `signals()` with `matchDocumentToCustomer()`. Add tech stack cache reading. |
| `src/lib/signal-templates.ts` (in `templateSalesHubInsights()`) | Add integration-match rendering with linkbacks. |
| `src/quality-validators/product-enrichment-validator.ts` | Add `documentIntelligenceValidator` export (or keep old validators for backward compat during migration). |

### Files NOT to Touch

- `src/lib/templates/route-signal.ts` -- `'saleshub-products'` source already routes to `'product'`. No change needed.
- `src/lib/customer-product-context.ts` -- used as-is for subscription matching (already works)
- `src/lib/customer-solution-context.ts` -- used as-is for solution play matching
- `src/lib/product-vocabulary.ts` -- used as-is via `resolveToSlug()`
- `src/lib/competitive-vocabulary.ts` -- used as-is via `getDisplacementTarget()`
- `src/lib/ecosystem-catalog.ts` -- used as-is via `findSolutionsByPartner()`
- Any scraper files -- download pipeline unchanged
- Any consumer files -- consumers get this via `templateAll()` automatically (PRINCIPLES.md Layer 3)

### Test Plan

1. Unit test: `documentIntelligenceValidator` with known-good and known-bad outputs
2. Unit test: `resolveProductReferences` with >=2 known product names resolving to correct slugs
3. Unit test: `resolveCompetitorReferences` with >=2 known competitor names
4. Unit test: `matchDocumentToCustomer` with a mock tech stack containing ServiceNow, verifying an Ansible+ServiceNow content kit matches
5. Integration test: `enrichProductDocuments` produces `documents[]` with `integrationsReferenced` populated for a known content kit
6. Architecture compliance: verify `routeSignal()` still returns `'product'` for `source: 'saleshub-products'` signals
7. Existing tests pass: `bun test --isolate test/unit/`

## References

- GitHub #866 (Redesign product page enrichment)
- ADR-040 (Universal Structured Output)
- ADR-024 (Quality Gate)
- ADR-023 (callGemini standardization)
- ADR-029 (Portfolio Signal Cross-Reference)
- ADR-035 (Signal Routing Expansion)
- ADR-038 (Dynamic Matching Replaces Handcrafted Mappings)
- `src/lib/saleshub-product-enrichment.ts` (current enrichment)
- `src/types/saleshub-product-types.ts` (current types)
- `src/modules/saleshub-products-module.ts` (signal emission)
- `src/lib/product-vocabulary.ts` (product name resolution)
- `src/lib/competitive-vocabulary.ts` (competitor name resolution)
- `src/lib/ecosystem-catalog.ts` (partner solutions)
- `src/lib/customer-product-context.ts` (customer product cross-referencing)
