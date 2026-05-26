---
doc-type: architecture
status: active
owner: jason
updated: 2026-05-20
---

# Design Principles — Deep Module Architecture

Every feature in this project follows three architectural layers. Violating these principles creates one-off gaps that require manual discovery and surgical fixes. Design for least complexity from the start.

## The Three Layers

### Layer 1: Signal producers report facts, the registry scores AND refreshes them (ADR-027, #328)
- Modules NEVER set `score` directly. They set `rawRelevance` + structured `metadata`.
- The registry's `scoreSignal()` determines specificity (customer/industry/general) and applies boosters from metadata.
- New signal sources automatically get correct scoring by providing the right metadata fields.
- **Pre-flight refresh (#328):** Modules implement optional `ensureFresh(customerSlug)` + `cacheTtlMs`. Before content generation, `loadCustomerSignals({ ensureFresh: true })` auto-refreshes ALL stale modules in parallel. New modules get refresh for free by implementing `ensureFresh()`. No hardcoded lists.
- Reference: `docs/adr/ADR-027-universal-signal-scoring-contract.md`, ARCHITECTURE.md §25

### Layer 2: Template engine renders deterministic sections from scored signals (#326)
- Deterministic sections (product alignment, cloud marketplace, renewals, cases, tech stack) are TEMPLATED from signals — never sent to Gemini for editorial judgment.
- Gemini only handles narrative synthesis (strategic position, priorities, SWOT, MEDDPICC).
- Signals auto-route to template sections by metadata keys:
  - `hasCloudSpend` / `cloudPartner` / `provider` → Cloud & Marketplace
  - `redHatProducts` / `product` / `managedService` → Product Alignment
  - `severity` / `caseNumber` → Cases
  - `renewal` / `stage` / `closeDate` → Renewals & Pipeline
  - `confidence` / `context` / `infrastructure` → Tech Stack
- New signal sources auto-template into the right section. No consumer code changes, no prompt engineering.
- Reference: `src/lib/signal-templates.ts`

### Layer 3: Consumers are thin — they call the template engine and slice
- Every consumer (playbook, brief, campaign, meeting prep, email outreach) calls `templateAll(signals, team, { format })`.
- Consumers declare which section groups they need and any filters (product, attendee role).
- No consumer builds its own Gemini prompt from raw signals.

## Section Groups

| Group | Gemini? | Sections |
|-------|---------|----------|
| `customer-core` | No | Product Alignment, Cloud & Marketplace, Tech Stack, Cases, Renewals & Pipeline |
| `people` | No | Key Relationships, Attendee Profiles, Partner Ecosystem, Outreach History |
| `narrative` | Yes | Strategic Position, Current Priorities, SWOT, MEDDPICC, Expansion Opportunities |
| `activity` | No | Engagement History, Action Items |
| `reference` | No | Product Lifecycle, Events, Industry News |

## Consumer → Group Mapping

| Consumer | Groups | Filter |
|----------|--------|--------|
| Playbook | all | None — full output |
| Brief | `customer-core` (condensed) + `narrative` (strategic only) | Top signals only |
| Campaign | `customer-core` (product-filtered) | Signals matching campaign product |
| Meeting Prep | `customer-core` + `narrative` (priorities) | Filtered to attendee roles |
| Email Outreach | `customer-core` (condensed) | Product + cloud spend for customer |

## Pre-flight Questions for Every New Feature (MANDATORY)

Answer these before writing code. If you can't answer them, you're not ready to build.

1. **Is this a producer, consumer, or both?** Producer → implement `signals()` with `rawRelevance` + metadata. Consumer → call `templateAll()`.
2. **What metadata does this emit?** Map every field to ADR-027 boosters. Missing `customerSlug` = scores as general (low).
3. **Which template section does this data belong in?** Route by metadata keys. If no section fits, define a new one.
4. **Does every consumer that should see this data actually see it?** Trace the signal through template engine to each consumer output. Verify with the debug endpoint: `GET /api/customer/:name/signals/debug`
5. **What happens when this data is missing or stale?** Module health guard should flag it. Admin page should show actionable fix.
6. **Does this module implement `ensureFresh()`?** If it produces signals with a cache, it MUST implement `ensureFresh()` + `cacheTtlMs` so pre-flight refresh covers it automatically. No module should be invisible to the refresh system.
7. **If this is a consumer that generates output, does it call `ensureFresh: true`?** Any consumer that produces user-facing content (campaigns, meeting prep, playbooks, account plans, email outreach) MUST call `loadCustomerSignals(slug, name, { ensureFresh: true })` before generation. This guarantees all signal modules are current before the output is built. Without this, consumers generate from empty or stale data — producing low-quality output that damages trust. No consumer may skip this. The cost (a few seconds of cache checks + selective refresh) is always worth it vs generating from stale signals.
8. **Does this module appear in the admin Data Sources panel?** Every registered module must have: a `refreshEndpoint` (so users can manually refresh), a display name that matches Signal Quality names, and `recordOutcome()` called after every refresh so "Last checked" updates. If a module is invisible to the admin panel, it's invisible to the user — they can't diagnose or fix stale data.

## Consumer → ensureFresh Contract

| Consumer | Must call `ensureFresh: true`? | Current status |
|----------|-------------------------------|----------------|
| Playbook | ✅ Yes | ✅ Implemented |
| Campaign | ✅ Yes | ❌ **MISSING** — uses stale signals |
| Meeting Prep | ✅ Yes | ❌ **MISSING** — uses stale signals |
| Email Outreach | ✅ Yes | ❌ **MISSING** — uses stale signals |
| Account Brief | ✅ Yes (on-demand generation) | ✅ Implemented (on first view) |
| Account Plan | ✅ Yes | ❌ **MISSING** |

## Anti-patterns

- ❌ Hardcoding `score` in a module — the registry scores, not the module
- ❌ Adding signal type to a Gemini prompt instruction — template it, don't prompt-engineer it
- ❌ Building a consumer that assembles its own signal context — use `templateAll()`
- ❌ Creating a feature without answering the 5 pre-flight questions
- ❌ Shipping without checking the signal debug endpoint for the new data
- ❌ Building a module with cached data but no `ensureFresh()` — consumers will generate with stale/missing data
- ❌ Hardcoding refresh sources in signal-loader — use the registry auto-discovery pattern
- ❌ Consumer calling `loadCustomerSignals()` WITHOUT `{ ensureFresh: true }` before generating output — produces content from stale/empty data
- ❌ Registering a module without `refreshEndpoint` — invisible in admin panel, users can't diagnose or fix
- ❌ Refresh endpoint that doesn't call `recordOutcome()` — "Last checked" never updates, appears broken

## Signal Scoring Quick Reference (ADR-027)

| Tier | Range | Meaning |
|------|-------|---------|
| Critical | 0.90-1.00 | Revenue impact, urgent action |
| High | 0.70-0.89 | Directly actionable in conversation |
| Medium | 0.50-0.69 | Useful context |
| Low | 0.35-0.49 | Background awareness |
| Noise | 0.00-0.34 | Filtered from content generation |

Specificity enforcement:
- `customer` signals: floor 0.50, ceiling 1.00
- `industry` signals: floor 0.35, ceiling 0.69
- `general` signals: floor 0.10, ceiling 0.35

Boosters (from metadata): redHatProducts (+0.10), acvPlus/amount (+0.10), HIGH confidence (+0.05), evaluating/migrating context (+0.10), severity 1 (+0.15) / severity 2 (+0.10), endDate within 90 days (+0.10), hasCloudSpend (+0.10).
