---
doc-type: adr
status: proposed
owner: jason
updated: 2026-05-21
---

# ADR-030: Strategic Solution Intelligence Engine

**Date:** 2026-05-21
**References:** ADR-027 (Universal Signal Scoring Contract), ADR-029 (Portfolio Signal Customer Relevance), ADR-020 (Feature Module Registry)
**Deciders:** Serena Blackwood (architecture), Rayford (DA), Jason Horn (product owner)

## Status

Proposed

## Context

### The Strategic Gap

ADR-029 proved that cross-referencing portfolio data against customer data produces immediately actionable intelligence — 64% of signals matched on first deploy. But ADR-029 solved only one dimension: **what they own x what's happening** (subscriptions x lifecycle/updates/events). Two critical dimensions remain:

**Dimension 2: What they use x what we solve.** The tech-stack module detects third-party technologies (ServiceNow, VMware, Splunk) from intelligence, emails, and news. The `tech-positioning.json` file already maps 30+ technologies to Red Hat products and positioning statements. But these two systems don't talk to each other in a way that produces customer-facing solution plays. Detecting "they have ServiceNow" should automatically surface "EDA + Ansible automation conversation with quantified business value" — not just "ServiceNow (industry-tool, using)."

**Dimension 2 is the key missing piece.** It transforms tactical product conversations ("you need to renew RHEL") into strategic opportunity identification ("your ServiceNow + VMware stack maps to a $2M platform modernization play with OpenShift Virtualization + Event-Driven Ansible").

**Dimension 3: How they buy x what's available.** The CCSP module knows cloud spend per customer ($500K AWS, $200K Azure). The cloud-marketplace module knows available programs, private offers, and CPPO eligibility per hyperscaler. But they cross-reference at the signal level only — "customer has AWS spend" triggers a higher score on AWS marketplace signals. What's missing: aggregated solution context that says "this customer's $500K AWS spend makes them eligible for the AWS CPPO private offer program, which could pull $300K of new subscription revenue into the cloud marketplace."

### What Exists Today

| Data source | Module | What it knows | What it doesn't know |
|---|---|---|---|
| Customer subscriptions | subscriptions-module | Products they pay for | How those products relate to each other |
| Tech stack detection | tech-stack-module | Third-party tech they use | What Red Hat solution plays address that tech |
| Tech positioning | tech-positioning.json | RH product x competitor mapping | Business value, solution play structure, customer fit |
| CCSP cloud spend | ccsp-module | $ per hyperscaler per customer | Best contract vehicle, private offer eligibility |
| Cloud marketplace | cloud-marketplace-module | Available programs/offers per cloud | Which customers are eligible for which programs |
| Support cases | cases-module | Active cases, severity, product | Version-level correlation with lifecycle events |
| Pipeline | pipeline-module | Deals, stages, amounts | Cross-sell correlation with tech stack |
| Intelligence | intelligence-module | Company profile, whitespace | Structured solution play recommendations |
| Emails | emails-module | Communication history | Conversation themes mapped to solution areas |

### The Convergence Point

Each data source above is valuable individually. The strategic value comes from cross-referencing them in specific pairs and triples:

- **Tech stack x solution plays** = "They have ServiceNow → automation conversation"
- **Cloud spend x marketplace programs** = "They have $500K AWS → CPPO eligible"
- **Subscriptions x cases x lifecycle** = "RHEL 8 subscriptions + Sev1 RHEL case + RHEL 8 EOL in 5 weeks = urgent upgrade conversation"
- **Tech stack x cloud spend** = "VMware migration + $200K Azure spend → ARO opportunity"
- **Pipeline x tech stack** = "OpenShift deal in commit stage + ServiceNow detected → upsell Ansible AAP"

### Fundamental Constraint

The existing three-layer architecture (PRINCIPLES.md) is sound and must not be violated:
1. **Modules report facts, the registry scores** (ADR-027)
2. **Template engine renders deterministic sections** (Layer 2)
3. **Consumers are thin** (Layer 3)

The solution intelligence engine must operate as a data enrichment layer that feeds richer metadata into existing modules — not as a consumer that assembles its own prompts, and not as a scoring override that bypasses the registry.

## Decision

### Core Architecture: Cross-Reference Matrix as a Data Enrichment Layer

Introduce a **Solution Intelligence Layer** that sits between raw data sources and signal-producing modules. It reads from multiple data sources, computes cross-references, and provides enriched context that modules use to populate their signal metadata. The registry, template engine, and consumers remain untouched.

```
┌─────────────────────────────────────────────────────────┐
│ Data Sources (existing)                                 │
│ subscriptions, tech-stack cache, CCSP, cases,           │
│ pipeline, intelligence, emails, cloud-marketplace       │
└────────────────────┬────────────────────────────────────┘
                     │ reads
┌────────────────────▼────────────────────────────────────┐
│ Solution Intelligence Layer (NEW)                       │
│                                                         │
│  ┌──────────────────┐  ┌──────────────────────────────┐ │
│  │ solution-plays.  │  │ customer-solution-context.ts │ │
│  │ json             │  │ getCustomerSolutionContext() │ │
│  │ (static catalog) │  │ (cross-reference engine)     │ │
│  └──────────────────┘  └──────────────────────────────┘ │
│                                                         │
│  Outputs: SolutionPlay[], MarketplaceOpportunity[],     │
│           VersionCorrelation[]                          │
└────────────────────┬────────────────────────────────────┘
                     │ enriches metadata
┌────────────────────▼────────────────────────────────────┐
│ Signal-Producing Modules (existing, enhanced)           │
│ tech-stack-module, cloud-marketplace-module,            │
│ lifecycle-module, pipeline-module                       │
│                                                         │
│ Each calls getCustomerSolutionContext() to populate     │
│ richer metadata → registry scores correctly             │
└────────────────────┬────────────────────────────────────┘
                     │ scored signals
┌────────────────────▼────────────────────────────────────┐
│ Template Engine + Consumers (untouched)                  │
│ signal-templates.ts routes by metadata keys             │
│ New metadata keys → new or enhanced template sections   │
└─────────────────────────────────────────────────────────┘
```

### 1. Solution Play Catalog: `solution-plays.json`

A static JSON catalog that maps detected third-party technologies to Red Hat solution plays. This extends `tech-positioning.json` with structured business value and solution play context.

**Why a static file, not Gemini-generated:** Solution plays are curated domain knowledge — they represent Red Hat's actual go-to-market motions, not AI-generated opinions. They change when Red Hat's strategy changes (quarterly at most), not per-customer. Static files are deterministic, debuggable, and reviewable. Gemini is used only to detect technologies (tech-stack-module already does this) — the mapping from technology to solution play is a lookup, not a generation task.

```typescript
// config-templates/solution-plays.json
interface SolutionPlay {
  /** Unique identifier */
  id: string
  /** Human-readable name */
  name: string
  /** One-line description */
  summary: string
  /** Technologies that trigger this play (matches tech-stack detection) */
  triggerTechnologies: string[]
  /** Red Hat products involved in this play */
  redHatProducts: string[]
  /** Business value propositions (used in template rendering) */
  valueProps: string[]
  /** Which cloud providers amplify this play (optional) */
  cloudAmplifiers?: string[]
  /** Related solution plays that cross-sell */
  relatedPlays?: string[]
  /** Category for template section grouping */
  category: 'modernization' | 'automation' | 'security' | 'cloud' | 'ai' | 'platform'
}
```

**Example entries:**

```json
[
  {
    "id": "vmware-migration",
    "name": "VMware to OpenShift Virtualization Migration",
    "summary": "Consolidate VMs and containers on a single OpenShift platform, eliminating VMware licensing.",
    "triggerTechnologies": ["VMware", "vSphere", "ESXi", "Tanzu", "vCenter"],
    "redHatProducts": ["ocp", "rhel", "acm"],
    "valueProps": [
      "Eliminate VMware licensing costs (avg 40-60% reduction)",
      "Consolidate VM and container workloads on one platform",
      "Multi-cluster management with ACM for hybrid deployments"
    ],
    "cloudAmplifiers": ["AWS", "Azure", "Google"],
    "relatedPlays": ["platform-modernization", "cloud-native-adoption"],
    "category": "modernization"
  },
  {
    "id": "itsm-automation",
    "name": "IT Service Management Automation with EDA",
    "summary": "Automate ServiceNow ticket resolution and CMDB updates with Event-Driven Ansible.",
    "triggerTechnologies": ["ServiceNow", "SNOW", "ITSM"],
    "redHatProducts": ["aap", "rhel"],
    "valueProps": [
      "Reduce mean-time-to-resolution by automating ticket triage and remediation",
      "Keep CMDB accurate with automated discovery and reconciliation",
      "Event-driven workflows trigger Ansible jobs on ServiceNow events"
    ],
    "relatedPlays": ["network-automation", "security-automation"],
    "category": "automation"
  },
  {
    "id": "cloud-native-adoption",
    "name": "Cloud-Native Application Platform",
    "summary": "Standardize on OpenShift as the enterprise Kubernetes platform with built-in CI/CD and security.",
    "triggerTechnologies": ["Kubernetes", "K8s", "Docker", "EKS", "AKS", "GKE"],
    "redHatProducts": ["ocp", "acs", "rhdh", "quay"],
    "valueProps": [
      "Enterprise Kubernetes with security, CI/CD, and observability built in",
      "Advanced Cluster Security for supply chain and runtime protection",
      "Developer Hub for self-service developer portals"
    ],
    "cloudAmplifiers": ["AWS", "Azure", "Google"],
    "relatedPlays": ["vmware-migration", "ai-ml-platform"],
    "category": "platform"
  }
]
```

**Relationship to `tech-positioning.json`:** `tech-positioning.json` provides per-technology positioning (one tech → one RH response). `solution-plays.json` provides per-solution-play context (one business outcome → multiple triggers, multiple products, business value). They are complementary:
- `tech-positioning.json` answers: "They have VMware → what do we say?" (tactical)
- `solution-plays.json` answers: "They have VMware → what solution play do we run?" (strategic)

Both files live in `config-templates/` and are copied to `config/` at bootstrap. Both are static, curated, and reviewable.

### 2. Customer Solution Context: `customer-solution-context.ts`

A shared utility (same pattern as `customer-product-context.ts` from ADR-029) that computes the full cross-reference matrix for a customer.

```typescript
// src/lib/customer-solution-context.ts

interface CustomerSolutionContext {
  /** Solution plays triggered by detected technologies */
  activeSolutionPlays: ActiveSolutionPlay[]
  /** Cloud marketplace opportunities based on spend + available programs */
  marketplaceOpportunities: MarketplaceOpportunity[]
  /** Version-level correlations (subscription version x case x lifecycle) */
  versionCorrelations: VersionCorrelation[]
  /** Cross-sell opportunities from pipeline x tech stack */
  crossSellSignals: CrossSellSignal[]
}

interface ActiveSolutionPlay {
  /** Reference to solution-plays.json entry */
  playId: string
  playName: string
  /** Technologies detected for THIS customer that trigger this play */
  matchedTechnologies: string[]
  /** Confidence based on tech detection confidence */
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  /** Red Hat products involved */
  redHatProducts: string[]
  /** Business value propositions */
  valueProps: string[]
  /** Cloud amplification if customer has spend on a relevant cloud */
  cloudAmplifier?: { provider: string; spend: number }
  /** Category for template routing */
  category: string
}

interface MarketplaceOpportunity {
  /** Cloud provider */
  provider: string
  /** Customer's current spend */
  currentSpend: number
  /** Available programs from cloud-marketplace cache */
  eligiblePrograms: string[]
  /** Private offer potential (based on spend thresholds) */
  privateOfferEligible: boolean
  /** Existing Red Hat subscriptions that could move to marketplace */
  movableSubscriptions: string[]
}

interface VersionCorrelation {
  /** Product with version-level data */
  product: string
  /** Subscription version (e.g., "RHEL 8") */
  subscriptionVersion: string
  /** Active cases on this version */
  activeCases: number
  /** Lifecycle event (e.g., "EOL Jun 2026") */
  lifecycleEvent?: string
  /** Urgency: whether cases + lifecycle create an amplified signal */
  amplified: boolean
}

interface CrossSellSignal {
  /** Pipeline deal product */
  pipelineProduct: string
  /** Related technology detected in tech stack */
  relatedTech: string
  /** Recommended cross-sell product */
  crossSellProduct: string
  /** Pipeline stage (for timing the conversation) */
  stage: string
}

function getCustomerSolutionContext(customerSlug: string): CustomerSolutionContext
```

**Data sources the function reads (all existing caches, no new scraper dependencies):**

| Cross-reference | Reads | Produces |
|---|---|---|
| Tech x Solution plays | `data/cache/tech-stack/{slug}.json` + `config/solution-plays.json` | `activeSolutionPlays[]` |
| Cloud spend x Programs | `data/cache/ccsp.json` + `data/cache/cloud-marketplace/latest.json` + `config/customers.json` (subscriptions) | `marketplaceOpportunities[]` |
| Subscriptions x Cases x Lifecycle | `data/cache/{slug}-sheets.json` + `data/cache/rh-cases/{slug}.json` + `data/cache/lifecycle.json` | `versionCorrelations[]` |
| Pipeline x Tech stack | `data/cache/pipeline/{slug}.json` + `data/cache/tech-stack/{slug}.json` | `crossSellSignals[]` |

**Why a single function, not four separate ones:** These cross-references share data reads. Tech stack data is needed for both solution plays and cross-sell. Subscriptions are needed for both marketplace opportunities and version correlations. Reading once and computing four outputs is simpler and cheaper than four separate functions each reading overlapping files.

### 3. How Modules Use the Solution Context

Modules that produce signals call `getCustomerSolutionContext()` alongside `getCustomerProductContext()` (from ADR-029) to populate richer metadata. The registry scores the same way — no scoring changes.

#### 3a. `tech-stack-module` Enhancement

**Current:** Detects technologies, sets `customerSlug`, `confidence`, `redHatProducts`, `context` in metadata. The `redHatPositioning` field is a one-liner from `tech-positioning.json`.

**Enhancement:** After detecting technologies, also look up matching solution plays. For each technology with a matching play:
- Add `solutionPlayId` and `solutionPlayName` to metadata
- Add `valueProps` array to metadata
- Add `solutionCategory` to metadata
- If customer has cloud spend on a `cloudAmplifier` for this play, add `cloudAmplifier` metadata

**Effect on scoring:** No change. The signal already has `customerSlug` (customer tier). The additional metadata enables the template engine to render richer content — the score stays the same, but the output is more actionable.

**New metadata fields for template routing:**

| Field | Used by template | Renders as |
|---|---|---|
| `solutionPlayId` | Tech Stack section (enhanced) | Solution play name + value props |
| `solutionPlayName` | Tech Stack section | Human-readable play name |
| `valueProps` | Tech Stack section | Bulleted business value under the tech entry |
| `cloudAmplifier` | Tech Stack section | "Amplified by $500K AWS spend" note |

#### 3b. `cloud-marketplace-module` Enhancement

**Current:** Cross-references newsletter data against CCSP spend. If customer has spend on a cloud provider, sets `customerSlug` + `hasCloudSpend` + `acvPlus`.

**Enhancement:** Also check `marketplaceOpportunities` from solution context:
- If customer has `privateOfferEligible: true`, add `privateOfferEligible: true` to metadata
- If customer has `movableSubscriptions` (RH subscriptions that could be purchased through marketplace), add them to metadata
- Add `eligiblePrograms` to metadata for template rendering

**Effect on scoring:** `privateOfferEligible` becomes a new booster (+0.10) in the registry — this is a revenue signal. Adding one booster to the registry's existing booster table is a minimal change to ADR-027's scoring function, consistent with how `hasCloudSpend` and `acvPlus` boosters were added.

**New booster:**

| Metadata field | Effect | Rationale |
|---|---|---|
| `privateOfferEligible` | +0.10 | Private offers = new subscription revenue channel |

#### 3c. New Module: `solution-intelligence-module.ts`

A new module registered with `FeatureModuleRegistry` that produces solution-play signals directly. This is separate from tech-stack-module because:
- Tech-stack-module produces signals about individual technologies
- Solution-intelligence-module produces signals about aggregated solution plays (which may involve multiple technologies)

```typescript
FeatureModuleRegistry.register({
  name: 'solution-intelligence',
  displayName: 'Solution Intelligence',
  scope: 'customer',
  // No refreshInterval — derived from tech-stack + CCSP caches, refreshes when they do
  // No ensureFresh — relies on tech-stack-module.ensureFresh() and cloud-marketplace.ensureFresh()
  cachePaths: () => [], // Pure computation, no cache of its own

  async signals(customerSlug: string): Promise<Signal[]> {
    const ctx = getCustomerSolutionContext(customerSlug)
    const signals: Signal[] = []

    // Solution play signals
    for (const play of ctx.activeSolutionPlays) {
      signals.push({
        source: 'solution-intelligence',
        type: 'solution-play',
        headline: `${play.playName} — ${play.matchedTechnologies.join(', ')} detected`,
        detail: play.valueProps.join('; '),
        rawRelevance: play.confidence === 'HIGH' ? 0.9 : play.confidence === 'MEDIUM' ? 0.7 : 0.5,
        timestamp: new Date().toISOString(),
        metadata: {
          customerSlug,
          solutionPlayId: play.playId,
          solutionCategory: play.category,
          redHatProducts: play.redHatProducts,
          matchedTechnologies: play.matchedTechnologies,
          valueProps: play.valueProps,
          confidence: play.confidence,
          context: 'evaluating', // Tech detection implies evaluation context
          cloudAmplifier: play.cloudAmplifier,
        },
      })
    }

    // Marketplace opportunity signals
    for (const opp of ctx.marketplaceOpportunities) {
      if (!opp.privateOfferEligible && opp.eligiblePrograms.length === 0) continue
      signals.push({
        source: 'solution-intelligence',
        type: 'marketplace-opportunity',
        headline: `${opp.provider} marketplace: ${opp.privateOfferEligible ? 'Private offer eligible' : opp.eligiblePrograms[0]}`,
        detail: `$${Math.round(opp.currentSpend).toLocaleString()} ${opp.provider} spend. ${opp.movableSubscriptions.length > 0 ? `Movable subscriptions: ${opp.movableSubscriptions.join(', ')}` : ''}`,
        rawRelevance: opp.privateOfferEligible ? 0.85 : 0.7,
        timestamp: new Date().toISOString(),
        metadata: {
          customerSlug,
          provider: opp.provider,
          hasCloudSpend: true,
          acvPlus: opp.currentSpend,
          privateOfferEligible: opp.privateOfferEligible,
          eligiblePrograms: opp.eligiblePrograms,
          movableSubscriptions: opp.movableSubscriptions,
        },
      })
    }

    // Version correlation signals (amplified)
    for (const vc of ctx.versionCorrelations) {
      if (!vc.amplified) continue // Only emit when cases + lifecycle amplify each other
      signals.push({
        source: 'solution-intelligence',
        type: 'version-correlation',
        headline: `${vc.product}: ${vc.activeCases} active cases + ${vc.lifecycleEvent ?? 'version event'}`,
        detail: `Version ${vc.subscriptionVersion} has ${vc.activeCases} open cases and approaching ${vc.lifecycleEvent}. Urgency: combined case load and lifecycle event amplify each other.`,
        rawRelevance: 0.9,
        timestamp: new Date().toISOString(),
        metadata: {
          customerSlug,
          product: vc.product,
          redHatProducts: [vc.product],
          severity: vc.activeCases > 3 ? 1 : 2, // Triggers severity booster
          context: 'migrating_from', // Version correlation implies migration need
        },
      })
    }

    return signals
  },

  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  async syncNow(): Promise<void> {},
})
```

### 4. Template Engine Enhancement

The solution-play and marketplace-opportunity signals need template sections. Two options:

**Option A: Enhance existing sections.** Solution plays render in the Tech Stack section (they're tech-derived). Marketplace opportunities render in the Cloud Marketplace section (they're cloud-derived). Version correlations render in the Cases section (they're case-derived).

**Option B: New "Strategic Opportunities" section.** A dedicated template section that aggregates solution plays, marketplace opportunities, and version correlations into a strategic overview.

**Decision: Option B** — a new "Strategic Opportunities" section. Rationale:
- Solution plays are strategically different from individual tech stack entries. "ServiceNow detected" (tech stack) vs "ITSM Automation play with EDA" (strategic) serve different purposes in a conversation.
- Mixing them into existing sections dilutes both — the tech stack section becomes too long, and solution plays lose their strategic framing.
- The template engine already routes by metadata keys; adding a new routing key (`solutionPlayId`) to a new section is the established pattern.

**New template section: `templateStrategicOpportunities(signals)`**

Routes signals where `metadata.solutionPlayId` or `metadata.privateOfferEligible` or `type === 'version-correlation'` are present.

Renders as:

```markdown
## Strategic Opportunities

### Solution Plays
| Play | Trigger Technologies | Products | Business Value |
|------|---------------------|----------|----------------|
| VMware Migration | VMware, vSphere | OCP, RHEL, ACM | Eliminate VMware licensing (40-60% reduction) |

### Marketplace Opportunities
| Provider | Spend | Programs | Private Offer |
|----------|-------|----------|---------------|
| AWS | $500K | CPPO, EDP | Eligible |

### Urgent Correlations
| Product | Version | Cases | Lifecycle Event | Action |
|---------|---------|-------|-----------------|--------|
| RHEL | 8.x | 3 active | EOL Jun 2026 | Upgrade conversation |
```

**Section group assignment:** `customer-core` (deterministic, no Gemini). Added to the existing group table in PRINCIPLES.md.

**Consumer mapping update:**

| Consumer | Gets Strategic Opportunities? | Rationale |
|----------|-------------------------------|-----------|
| Playbook | Yes | Full customer view |
| Brief | Yes (condensed — top 2 plays only) | Strategic highlight |
| Campaign | Product-filtered subset | Only plays involving campaign product |
| Meeting Prep | Yes | Strategic framing for meetings |
| Email Outreach | Top 1 play only | Brief hook for outreach |

### 5. What Does NOT Change

- **ADR-027 scoring algorithm** — `scoreSignal()`, `detectSpecificity()`, clamping: untouched (one new booster added, consistent with existing pattern)
- **ADR-029 cross-reference utility** — `customer-product-context.ts`: untouched. The new `customer-solution-context.ts` is a peer, not a replacement.
- **Existing modules' signal contracts** — pipeline, cases, subscriptions, RSS, events, lifecycle, intelligence, news: untouched
- **Consumer contracts** — `collectAllSignals()`, `templateAll()`, consumer budgets: untouched (one new section added to `templateAll`)
- **Scraper layer** — zero scraper changes. All data sources are existing caches.
- **Signal interface** — no new fields. `metadata` bag already supports all required keys.

### 6. Implementation Phases

#### Phase 1: Solution Play Catalog + Tech Stack Enrichment (Smallest Valuable Increment)

**Delivers:** "They have ServiceNow → ITSM Automation play with EDA" with business value propositions in the playbook/brief.

**Files to create:**
- `config-templates/solution-plays.json` — initial catalog (15-20 plays covering the most common technology triggers)
- `src/lib/customer-solution-context.ts` — `getCustomerSolutionContext()` function (Phase 1: only `activeSolutionPlays` populated; other fields return empty arrays)

**Files to modify:**
- `src/modules/tech-stack-module.ts` — call `getCustomerSolutionContext()`, add solution play metadata to tech signals
- `src/lib/signal-templates.ts` — add `templateStrategicOpportunities()` function and routing for `solutionPlayId` metadata
- `src/lib/signal-templates.ts` — update `templateAll()` to include the new section

**No new modules in Phase 1.** Tech-stack-module carries the solution play context in its existing signals. This avoids new module registration, new budget allocation, and signal duplication.

**Estimated scope:** ~200 lines of new code + ~50 lines of JSON catalog.

#### Phase 2: Cloud Marketplace Cross-Reference

**Delivers:** "$500K AWS spend + CPPO eligible + RHEL subscription could move to marketplace" in playbook/brief.

**Files to create:**
- `src/modules/solution-intelligence-module.ts` — new module (marketplace opportunity signals only in Phase 2)

**Files to modify:**
- `src/lib/customer-solution-context.ts` — populate `marketplaceOpportunities` (reads CCSP cache + cloud-marketplace cache + subscriptions)
- `src/feature-module-registry.ts` — add `privateOfferEligible` booster (+0.10) to scoring function
- `src/lib/signal-templates.ts` — add marketplace opportunities sub-section to Strategic Opportunities

**Estimated scope:** ~150 lines of new code + ~20 lines of registry changes.

#### Phase 3: Version Correlations + Cross-Sell

**Delivers:** "3 active RHEL 8 cases + EOL in 5 weeks = urgent upgrade conversation" and "OpenShift deal in commit + ServiceNow detected → upsell AAP."

**Files to modify:**
- `src/lib/customer-solution-context.ts` — populate `versionCorrelations` (reads subscriptions + cases + lifecycle) and `crossSellSignals` (reads pipeline + tech-stack)
- `src/modules/solution-intelligence-module.ts` — add version correlation and cross-sell signal types

**Estimated scope:** ~200 lines of new code.

### 7. Signal Budget for New Module

| Source | Max per customer | Rationale |
|---|---|---|
| solution-intelligence | 8 | Solution plays (cap 3) + marketplace opps (cap 3) + version correlations (cap 2) |

Added to `SIGNAL_BUDGETS` in `feature-module-registry.ts`.

## Consequences

**Positive:**

- **Tactical to strategic transformation.** Individual technology detections become structured solution plays with business value propositions. "ServiceNow detected" becomes "ITSM Automation play: reduce MTTR by automating ticket triage with Event-Driven Ansible."
- **Zero new data dependencies.** All cross-references use existing caches. No new scrapers, no new APIs, no new auth tokens.
- **Extends proven patterns.** `customer-solution-context.ts` follows the exact pattern of `customer-product-context.ts` (ADR-029). Static catalog (`solution-plays.json`) follows the pattern of `tech-positioning.json`. New module follows `FeatureModuleRegistry` pattern (ADR-020).
- **Progressive delivery.** Phase 1 delivers the highest-value piece (solution plays) with ~250 lines of code. Phases 2 and 3 add incremental value without rearchitecting Phase 1.
- **Curated, not generated.** Solution plays are domain expertise encoded as data, not Gemini outputs. They're deterministic, reviewable, and change only when Red Hat's strategy changes.
- **Template engine routes automatically.** New metadata keys (`solutionPlayId`, `privateOfferEligible`) route to the Strategic Opportunities section via existing metadata-based routing. No consumer code changes.

**Negative:**

- **Solution play catalog requires curation.** Someone must write and maintain the initial 15-20 entries. This is a feature, not a bug — it forces the strategic plays to be explicit and reviewable — but it is manual work.
- **Two static mapping files.** `tech-positioning.json` and `solution-plays.json` overlap in their technology-to-product mappings. They serve different purposes (tactical positioning vs strategic plays) but could drift. Mitigation: `solution-plays.json` references `triggerTechnologies` by the same names used in `tech-positioning.json`.
- **Tech-stack-module becomes richer.** Adding solution play metadata increases signal detail size. Bounded by existing per-source budget cap (8 signals).

**Risks:**

- **Solution play false positives.** Low-confidence tech detection (e.g., "VMware" mentioned once in a news article) could trigger a full solution play. Mitigation: confidence from tech-stack-module flows through to solution play confidence. LOW confidence tech = LOW confidence play = lower rawRelevance = lower score. The scoring system handles this.
- **Solution play catalog completeness.** Missing entries mean missed opportunities. Mitigation: Phase 1 covers the 15-20 most common triggers (VMware, ServiceNow, Splunk, Terraform, Jenkins, Kubernetes, Docker, AWS/Azure/GCP managed services, etc.). Admin panel could show "unmatched technologies" for catalog expansion over time.
- **Marketplace opportunity data freshness.** Cloud marketplace programs change. Mitigation: cloud-marketplace-module already refreshes weekly from Gmail newsletter. Solution intelligence inherits that freshness.

## Alternatives Considered

### Alternative 1: Gemini-Generated Solution Plays Per Customer

Use Gemini to analyze each customer's tech stack and generate bespoke solution recommendations.

**Rejected because:**
- PRINCIPLES.md prohibits prompt engineering in data producers — "template deterministic data, use Gemini only for narrative synthesis"
- Non-deterministic: same input produces different output on each run
- Expensive: one Gemini call per customer per refresh cycle
- Not reviewable: Jason can't audit what Gemini decided to recommend
- Solution plays are domain expertise, not inference — they should be curated

### Alternative 2: Extend `customer-product-context.ts` Instead of New File

Add solution context to the existing `getCustomerProductContext()` function.

**Rejected because:**
- `customer-product-context.ts` answers one question: "Does this customer care about this Red Hat product?" (ADR-029, a clear bounded scope)
- Solution context answers a different question: "What strategic plays apply to this customer?" (involves third-party tech, cloud spend, cases — different data sources)
- Combining them makes the function do too much. Two focused utilities are better than one overloaded one.
- `getCustomerProductContext()` is called by 5 modules and is well-tested. Adding complexity risks breaking ADR-029.

### Alternative 3: Consumer-Side Assembly of Solution Context

Have playbook-generator.ts and brief-pipeline.ts assemble solution plays from raw signals at render time.

**Rejected because:**
- Violates PRINCIPLES.md Layer 3: "Consumers are thin — they call the template engine and slice"
- Every consumer would need solution-play matching logic
- New consumers would need to remember to add it
- Signals should represent truth at the source (ADR-029's core lesson)

### Alternative 4: New Scoring Tier for Solution Plays

Add a "strategic" specificity tier above "customer" for solution plays.

**Rejected because:**
- ADR-027's three tiers (customer/industry/general) are sufficient
- Solution play signals are customer-specific (they have `customerSlug` from tech detection) — they belong in the customer tier
- The `evaluating` context booster (+0.10) and `redHatProducts` booster (+0.10) already push high-confidence solution plays into the High/Critical range
- A fourth tier adds complexity for all modules when only one module (solution-intelligence) would use it
