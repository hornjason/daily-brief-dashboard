---
doc-type: adr
status: accepted
owner: jason
updated: 2026-05-21
---

# ADR-029: Portfolio Signal Customer Relevance via Subscription Cross-Reference

**Date:** 2026-05-21
**References:** ADR-027 (Universal Signal Scoring Contract), ADR-021 (Signal Contract), ADR-020 (Feature Module Registry)

## Status

Accepted

## Context

ADR-027 established centralized scoring with three specificity tiers: customer (floor 0.50), industry (floor 0.35), and general (floor 0.10, ceiling 0.35). Five modules produce portfolio-level data — Red Hat product information that is not inherently about any one customer, but IS directly relevant to customers who own or are exploring those products. Because these modules lack `customerSlug` in their signal metadata, the registry classifies them as `general`, clamps their scores to 0.35 maximum, and they fall into the Noise tier. Content generation filters them out before any consumer sees them.

**The five affected modules and what they produce:**

1. **`lifecycle-module`** (product-lifecycle) — End-of-life dates, version upgrades, EUS availability. Sets `score` directly (0.4-0.8) instead of `rawRelevance`, and provides no `customerSlug`. A customer's RHEL Extended Life Cycle expiring in 5 weeks is invisible even though the customer has active RHEL subscriptions.

2. **`product-intel-module`** (product-intel) — Product features and releases extracted from Drive docs. Returns an empty array (`return []`) with a comment: "will be enhanced when customer-product mapping exists." The mapping exists now via subscriptions.

3. **`value-map-module`** (value-maps) — Business value metrics from Drive decks. Already solved: implements `getCustomerProducts()` that reads `customers.json` subscriptions, sets `customerSlug` conditionally, and uses `rawRelevance`. This module is the prototype for the pattern the other four need.

4. **`rss-module`** (rh-rss) — Red Hat blog/press articles. Already has `productTags` per feed item and uses `rawRelevance`. Checks for customer name in headline (which rarely matches). Does NOT cross-reference `productTags` against customer subscriptions, so a "What's New in OpenShift 4.17" article scores as Noise even for customers running OpenShift.

5. **`events-module`** (rh-events) — Red Hat events. Has `productTags` on events. Filters by region. Sets `score` directly (0.4-0.8) instead of `rawRelevance`. Does NOT check whether the event's product tags match what the customer owns.

**The proven pattern already exists.** Two modules demonstrate the correct approach:

- `cloud-marketplace-module` cross-references CCSP cloud spend data. If the customer has spend on AWS, marketplace signals for AWS get `customerSlug` + `hasCloudSpend` in metadata, jumping to the customer specificity tier.
- `value-map-module` cross-references customer subscriptions via `getCustomerProducts()`. If the customer owns the product a value map covers, the signal gets `customerSlug`.

Both follow the same structural pattern: read customer data, check for a match, conditionally set `customerSlug` in metadata. The registry does the rest.

**Why this matters operationally:** Jason (Account Solution Architect) uses these signals as ammunition for customer conversations. "Your RHEL support expires in 5 weeks" is a compelling event. "Red Hat published this OpenShift AI guide" is expansion conversation material. "Red Hat Summit is next month and has OpenShift sessions" is an invitation opportunity. All of this intelligence exists in the system but is invisible because the scoring system correctly identifies it as non-customer-specific — because the modules never told it otherwise.

## Decision

### Core Principle: Portfolio Data Becomes Customer-Relevant Through Cross-Reference

Modules that produce portfolio-level data (about Red Hat products, not about specific customers) MUST cross-reference that data against what the customer owns (subscriptions) and what they are exploring (intelligence themes) before emitting signals. The `signals(customerSlug)` interface already passes the customer context — modules must use it.

This decision does NOT change ADR-027. The scoring algorithm, specificity detection, boosters, and clamping all remain identical. What changes is that modules provide richer metadata — specifically `customerSlug` when a cross-reference matches — so the existing scoring logic classifies them correctly.

### 1. Two Levels of Customer Relevance

Portfolio signals can match a customer in two ways, with different confidence levels:

| Match Level | Source | Metadata | Effect |
|-------------|--------|----------|--------|
| **Subscription match** | Customer has an active subscription for this product | `customerSlug` + `matchType: 'subscription'` | Specificity → `customer` (floor 0.50) |
| **Interest match** | Intelligence themes show the customer is evaluating/exploring this product | `customerSlug` + `matchType: 'interest'` + `context: 'evaluating'` | Specificity → `customer` (floor 0.50) + evaluating booster (+0.10) |
| **No match** | Customer has no subscription or interest overlap | No `customerSlug` | Specificity → `general` (ceiling 0.35) |

Subscription match is the primary mechanism — it uses hard data (what they pay for). Interest match is the secondary mechanism — it uses intelligence themes (what they are exploring). Both produce customer-tier signals, but interest match also triggers the existing `context: 'evaluating'` booster from ADR-027, scoring higher because active exploration is more actionable than passive ownership.

### 2. Shared Utility: `getCustomerProductContext(customerSlug)`

A single shared function extracts the customer's product context from two sources:

```typescript
// src/lib/customer-product-context.ts

interface CustomerProductContext {
  /** Product slugs from active subscriptions (hard data) */
  ownedProducts: string[]
  /** Product slugs from intelligence themes marked evaluating/exploring */
  interestProducts: string[]
  /** Combined set for simple "is this product relevant?" checks */
  allRelevantProducts: string[]
}

function getCustomerProductContext(customerSlug: string): CustomerProductContext
```

**Data sources:**
- `ownedProducts`: Read from `customers.json` → `customer.subscriptions[]` → normalize product names to slugs. This is the same logic currently duplicated in `value-map-module.ts`'s `getCustomerProducts()`.
- `interestProducts`: Read from `data/cache/intelligence/{customerSlug}.json` → extract product slugs from themes/recommendations where context indicates evaluation. Falls back to `data/cache/tech-stack/{customerSlug}.json` → entries with `context: 'evaluating'` or `'migrating_from'`.

**Why a shared utility instead of per-module implementation:**
- `getCustomerProducts()` is already duplicated (exists in `value-map-module.ts`, would need to be copied to 4 more modules).
- The subscription-to-slug normalization logic (mapping "Red Hat Enterprise Linux" → "rhel", "OpenShift Container Platform" → "ocp") is complex enough to own once.
- Interest-match logic reads from intelligence cache, which is a separate concern from any individual module's domain.
- All five modules need the same answer to the same question: "Does this customer care about this product?"

### 3. Per-Module Changes

Each module's `signals()` method gets a small change: call `getCustomerProductContext(customerSlug)`, check if its product data matches, and set metadata accordingly. The scoring algorithm is untouched.

#### 3a. `lifecycle-module` (product-lifecycle)

**Current state:** Sets `score` directly (0.4-0.8). No `rawRelevance`. No `customerSlug`. No subscription check.

**Change:**
- Replace `score` with `rawRelevance` (fix ADR-027 compliance — this module predates ADR-027 migration)
- Call `getCustomerProductContext(customerSlug)`
- For each product in the lifecycle cache, check if `product.slug` is in `ownedProducts` or `interestProducts`
- If subscription match: set `customerSlug`, `matchType: 'subscription'`, `redHatProducts: [product.slug]`
- If interest match: set `customerSlug`, `matchType: 'interest'`, `context: 'evaluating'`, `redHatProducts: [product.slug]`
- If no match: omit `customerSlug` (remains general)
- Map existing `score` to `rawRelevance`: EOL <90 days → 0.9, new version available → 0.7, default → 0.5

**Result:** "RHEL 8 — EOL Jun 2026" for a customer with RHEL subscriptions: specificity `customer` (floor 0.50) + rawRelevance 0.9 + endDate booster (+0.10) + redHatProducts booster (+0.10) = **~0.85 (High)**. Previously: clamped at 0.35 (Noise).

#### 3b. `product-intel-module` (product-intel)

**Current state:** Returns empty array. Comment says "will be enhanced when customer-product mapping exists."

**Change:**
- Implement the `signals()` method: read product summaries from cache, call `getCustomerProductContext(customerSlug)`
- For each product summary, check if its product slug matches `ownedProducts` or `interestProducts`
- Matched products: emit signal with `customerSlug`, `matchType`, `redHatProducts`, `rawRelevance: 0.7`
- Unmatched products: emit signal without `customerSlug`, `rawRelevance: 0.5`

**Result:** Product intelligence for products the customer owns surfaces at Medium-High instead of being invisible.

#### 3c. `rss-module` (rh-rss)

**Current state:** Has `productTags` per item. Checks customer name in headline (rare match). Uses `rawRelevance` correctly. Does NOT check productTags against subscriptions.

**Change:**
- Call `getCustomerProductContext(customerSlug)`
- Normalize each item's `productTags` to slugs
- If any productTag matches `allRelevantProducts`: set `customerSlug`, `matchType`, `redHatProducts`
- Keep existing customer-name-in-headline check (both can fire — name match takes priority)

**Result:** "What's New in OpenShift 4.17" for an OpenShift customer: specificity `customer` (floor 0.50) + rawRelevance 0.9 (fresh) + redHatProducts booster (+0.10) = **~0.70 (High)**. Previously: rawRelevance 0.9 but clamped at 0.35 (Noise).

#### 3d. `events-module` (rh-events)

**Current state:** Has `productTags` per event. Filters by region. Sets `score` directly (0.4-0.8). No subscription check.

**Change:**
- Replace `score` with `rawRelevance` (ADR-027 compliance)
- Call `getCustomerProductContext(customerSlug)`
- Check event's `productTags` against `allRelevantProducts`
- If product match: set `customerSlug`, `matchType`, `redHatProducts`
- If no product match but regional match: emit without `customerSlug` (general tier, still visible to admin but not content generation)
- Map existing `score` to `rawRelevance`: within 14 days → 0.9, within 30 days → 0.7, within 90 days → 0.5

**Result:** "Red Hat Summit — OpenShift AI Workshop" for a customer exploring OpenShift AI: specificity `customer` (floor 0.50) + rawRelevance 0.9 + redHatProducts booster (+0.10) + evaluating booster (+0.10) = **~0.85 (High)**. Previously: clamped at 0.35 (Noise).

#### 3e. `value-map-module` (value-maps)

**Current state:** Already implements the subscription cross-reference pattern correctly via `getCustomerProducts()`. Uses `rawRelevance` and conditional `customerSlug`.

**Change:**
- Replace local `getCustomerProducts()` with shared `getCustomerProductContext(customerSlug).ownedProducts`
- Add interest-match path: also check `interestProducts` for upsell value maps
- No other changes — this module is already compliant

### 4. Product Tag to Slug Normalization

RSS feed productTags and event productTags use human-readable strings ("OpenShift", "Ansible Automation Platform", "RHEL"). Subscription data uses product names ("Red Hat Enterprise Linux", "OpenShift Container Platform"). Both need normalization to a canonical slug set.

The shared utility includes a normalizer:

```typescript
const PRODUCT_SLUG_MAP: Record<string, string> = {
  'openshift': 'ocp',
  'openshift container platform': 'ocp',
  'openshift ai': 'rhoai',
  'enterprise linux': 'rhel',
  'rhel': 'rhel',
  'ansible': 'aap',
  'ansible automation platform': 'aap',
  'advanced cluster security': 'acs',
  'advanced cluster management': 'acm',
  'quay': 'quay',
  'developer hub': 'rhdh',
  'satellite': 'satellite',
  'insights': 'insights',
  // ... extensible
}

function normalizeProductSlug(name: string): string | undefined
```

This consolidates the normalization logic already in `value-map-module.ts` (lines 52-61) into a shared location.

### 5. What Does NOT Change

- **ADR-027 scoring algorithm** — `scoreSignal()`, `detectSpecificity()`, boosters, clamping: untouched
- **Specificity tiers** — customer/industry/general ranges: untouched
- **Signal budget caps** — per-source limits: untouched
- **Consumer contracts** — `collectAllSignals()`, `templateAll()`, consumer budgets: untouched
- **Other modules** — pipeline, ccsp, cases, tech-stack, subscriptions, cloud-marketplace, news-radar, intelligence: untouched
- **The `Signal` interface** — no new fields needed; `metadata` bag already supports all required keys

## Consequences

**Positive:**

- **5 modules contribute actionable intelligence** instead of being filtered as Noise. Lifecycle EOL dates, product updates, relevant RSS articles, matching events, and value proof points all surface to content generation.
- **Zero changes to scoring logic.** The fix is entirely in how modules populate metadata — the registry already knows how to score customer-specific signals. This validates ADR-027's design: modules report facts, the registry scores.
- **Shared utility eliminates duplication.** `getCustomerProducts()` in `value-map-module.ts` becomes `getCustomerProductContext()` in a shared location. Four other modules use the same function instead of each reimplementing subscription parsing.
- **Interest-match enables expansion intelligence.** Products the customer is evaluating (from tech-stack intelligence) trigger customer-tier scoring on lifecycle, RSS, and events — exactly the "ammunition for expansion conversations" Jason described.
- **Existing booster stack amplifies correctly.** Subscription match + endDate <90 days = EOL urgency. Interest match + evaluating context = expansion opportunity. The boosters were designed for this; they just never received the metadata to fire.

**Negative:**

- **Subscription data dependency.** If `customers.json` has no subscriptions for a customer (bootstrap not complete, SF bookings sheet empty), all five modules continue scoring as general. This is the safe default — under-score, not over-score — but it means newly added customers see no portfolio signal relevance until bootstrap runs.
- **Intelligence cache dependency for interest match.** Customers without intelligence briefs get subscription-match only. This is acceptable — subscription match alone fixes the primary problem. Interest match is a bonus that improves over time as intelligence accumulates.
- **Product slug normalization is a maintained mapping.** New Red Hat products require adding entries to `PRODUCT_SLUG_MAP`. Mitigation: the mapping is in one file, not scattered across five modules. Unknown product names fall through without crashing — they just do not match.

**Risks:**

- **False positives from loose product matching.** A customer subscribed to "RHEL" matches every RHEL lifecycle signal, RHEL RSS article, and RHEL event. This is intentional — RHEL is relevant to RHEL customers — but could produce volume. Mitigation: per-source budget caps (ADR-027) limit RSS to 5, events to 5, lifecycle to 5, product-intel to 5. Volume is bounded.
- **Interest-match confidence.** Intelligence themes are Gemini-generated and may include speculative product mentions. Mitigation: interest-match signals still go through the full scoring pipeline. A speculative mention produces a Medium signal (0.50-0.60), not a Critical one. Only subscription-match + urgency boosters reach High/Critical.

## Alternatives Considered

### Option 2: New Specificity Tier ("Portfolio")

Add a fourth specificity tier between general and customer: `portfolio` with floor 0.36, ceiling 0.49.

**Rejected because:**
- Changes ADR-027 for all modules when only 5 need the fix
- Creates a permanent middle tier that incentivizes modules to avoid the work of cross-referencing customer data
- 0.36-0.49 still falls in the Low tier, which is "background awareness" — not useful enough for content generation
- The real problem is that these signals ARE customer-specific when cross-referenced; they deserve customer-tier scoring, not a compromise tier

### Option 3: Raise General Ceiling Above 0.35

Allow general signals to score up to 0.49 or 0.60.

**Rejected because:**
- Lets actual noise through (generic Red Hat blog posts with no product relevance)
- Defeats the purpose of the general ceiling, which exists to prevent RSS flood
- The five modules are not "better general signals" — they are customer-specific signals that lack the metadata to prove it

### Option 4: Per-Module Score Overrides in Registry Config

Add a config map in the registry that says "lifecycle signals should have floor 0.50 regardless of metadata."

**Rejected because:**
- Violates ADR-027's core principle: "Modules report facts, the registry scores"
- Creates a second scoring path (config overrides vs. metadata-driven)
- Does not actually make the signals customer-specific — just artificially boosts them
- Would need constant tuning as new modules are added

### Option 5: Consumer-Side Product Filtering

Keep signals as general, but have consumers (playbook, brief) explicitly include lifecycle/RSS signals that match the customer's products.

**Rejected because:**
- Violates PRINCIPLES.md Layer 3: "Consumers are thin — they call the template engine and slice"
- Every consumer would need product-matching logic, duplicating the cross-reference 4+ times
- New consumers would need to remember to add the same logic
- The signal stack should represent truth; consumers should not need to second-guess it
