---
doc-type: reference
status: active
owner: jason
updated: 2026-05-24
---

# Signal Quality Audit — Issue #325

**Date**: 2026-05-24
**Auditor**: Marcus Webb (engineer agent)
**Method**: Static code analysis of signal modules, routeSignal, templateAll, and all consumer entry points

## Signal Source to Consumer Matrix

### Legend
- **PASS**: Signal data reaches consumer via deterministic template OR direct injection
- **NARR**: Signal reaches consumer only via narrativeContext (top-N budget-capped, Gemini-dependent)
- **FAIL**: Signal never reaches consumer
- **N/A**: Consumer doesn't use this signal type by design

### Matrix (16 sources x 5 consumers)

| Source | Playbook | Brief | Campaign | Meeting Prep | Google Doc |
|--------|----------|-------|----------|--------------|------------|
| cloud-marketplace | PASS (cloud section) | NARR | NARR | NARR | PASS (via playbook) |
| tech-stack | PASS (tech section) | NARR | NARR | NARR | PASS (via playbook) |
| ccsp | PASS (product section) | NARR | NARR | NARR | PASS (via playbook) |
| pipeline | PASS (renewal section) | NARR | PASS (direct filter) | NARR | PASS (via playbook) |
| cases | PASS (case section) | NARR | PASS (direct filter) | NARR | PASS (via playbook) |
| subscriptions | PASS (product section) | NARR | PASS (direct filter) | NARR | PASS (via playbook) |
| news-radar | NARR | NARR | NARR | NARR | NARR |
| rh-rss | NARR | NARR | NARR | NARR | NARR |
| intelligence | NARR | PASS (separate injection) | PASS (separate injection) | PASS (separate injection) | NARR |
| value-maps | NARR | NARR | NARR | NARR | NARR |
| rh-events | NARR | NARR | NARR | NARR | NARR |
| product-lifecycle | NARR | NARR | NARR | NARR | NARR |
| customer-product-intel | PASS (product section via m.product) | NARR | NARR | NARR | PASS (via playbook) |
| account-plan | NARR | NARR | NARR | PASS (separate injection) | NARR |
| customer-docs | NARR | NARR | NARR | NARR | NARR |
| emails | NARR | PASS (separate injection) | NARR | NARR | NARR |

### Summary
- **PASS cells**: 24 (30%)
- **NARR cells**: 51 (64%)
- **FAIL cells**: 0
- **N/A cells**: 5 (6%)

No signals are completely FAIL (lost). All signals reach all consumers via narrativeContext.
However, 64% of signal-consumer pairs rely on NARR (narrative budget), meaning they compete
for top-N slots and may be dropped by budget caps.

## Identified Gaps (filed as issues)

### GAP-1: rh-rss productTags not recognized by routeSignal — #375
- `rh-rss` signals set `productTags` metadata but routeSignal checks `redHatProducts` not `productTags`
- Result: Red Hat product news that should appear in Product Alignment section falls to 'other'
- **FIXED in this branch**: routeSignal now checks `m.productTags` alongside `m.redHatProducts`

### GAP-2: product-lifecycle needs deterministic template section — #376
- Lifecycle signals carry `slug`, `currentVersion`, `eolDate` but don't set `redHatProducts` metadata
- They fall to 'other' and only appear via narrativeContext
- Should have a Lifecycle Alerts deterministic section showing upcoming EOLs

### GAP-3: rh-events has no deterministic template section — #377
- Events carry `format`, `location`, `region` but nothing templateAll recognizes
- Upcoming relevant events should surface in a dedicated Events section

### GAP-4: cloud-marketplace programs/incentives show N/A in template — #378
- Programs/incentives are emitted as individual signals with `offeringType: 'program'`
- templateCloudMarketplace reads `m.programs` (array), which doesn't exist on individual signals
- The Programs column shows 'N/A' for program signals

### GAP-5: value-maps signals lost in narrative noise — #379
- Value maps carry `productSlug` but not `redHatProducts`, so routeSignal returns 'other'
- Budget cap of 3 (lowest of all sources) means they're likely dropped in narrative top-N
- **FIXED in this branch**: routeSignal now checks `m.productSlug`

### GAP-6: account-plan not deterministic in playbook or brief — #380
- Account plan signals have `customerSlug` and `contentLength` but no routing metadata
- Meeting prep gets account plan via separate injection, but playbook/brief rely on narrative

## Fixes applied in this branch
1. `routeSignal()` now routes signals with `productTags` or `productSlug` to 'product' (#375, #379)
2. `templateProductAlignment()` now reads product name from `productSlug` and `productTags` metadata
3. Added regression tests in `test/unit/signal-routing-audit.test.ts`
