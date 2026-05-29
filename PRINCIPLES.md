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
| Meeting Prep | ✅ Yes | ✅ Implemented (#426) |
| Email Outreach | ✅ Yes | ❌ **MISSING** — uses stale signals |
| Account Brief | ✅ Yes (on-demand generation) | ✅ Implemented (on first view) |
| Account Plan | ✅ Yes | ❌ **MISSING** |

## Consumer Output Quality Rule — Business Objective Tie-back (MANDATORY)

Every consumer output (meeting prep, playbook, campaign, email outreach, account brief) that references a Red Hat product, partner solution, or ecosystem resource MUST tie it to a specific customer business objective. Generic product pitches damage trust. The pattern is:

**Solution → Business Objective → Specific Ask → Linkback**

Example (bad): "Ask about expanding Ansible Automation Platform usage."
Example (good): "Fred Hutch's Overlake expansion requires rapid infrastructure provisioning. The [Cisco + Red Hat network automation solution](catalog-link) with [free interactive labs](lab-link) lets Fred Hutch evaluate automated provisioning without procurement. Ask Mike Thompson: has the network team evaluated this for the Overlake timeline?"

This is enforced by requiring Gemini prompts for all consumers to:
1. Receive customer business objectives as context (from intelligence module)
2. Instruct Gemini to cite a specific business objective for every product/solution reference
3. Include linkback URLs for every referenced asset (solution brief, lab, trial, design guide, case study)

If no business objective is known for the customer, the consumer should flag this as a data gap — not fall back to generic positioning.

## syncNow vs ensureFresh Contract (MANDATORY)

Every registered module implements two refresh methods with distinct purposes:

| Method | Called by | Purpose | Cache behavior |
|--------|-----------|---------|----------------|
| `syncNow(customerName)` | Refresh button, manual API call, admin panel | Re-fetch from source | **Always re-fetches.** Never checks content hash. Never returns early based on cached data. The user clicked Refresh because they want fresh data. |
| `ensureFresh(customerSlug)` | Pre-flight refresh before content generation | Ensure data is current | **Checks TTL first**, then optionally checks content hash. Skips if data is fresh. Optimized for speed — consumers call this before generating output. |

**The rule:** Content hash checks, cache-hit skips, and "unchanged input" shortcuts belong in `ensureFresh()` ONLY. `syncNow()` always goes to source. No exceptions.

**Why this matters:** When a user clicks Refresh in the admin panel or on a module tab, they expect fresh data from source. A silent cache-hit return makes the button feel broken. Content hash optimization is valuable for automated pre-flight refresh (where speed matters and the user isn't watching), but it must never intercept a manual refresh.

## L3 Drive Refresh Contract (MANDATORY for portfolio-scope modules)

Every module that produces portfolio-wide data (not per-customer) MUST support pulling fresh data from Google Drive — not just re-reading a local file baked into the container image.

**Why:** Hero installs bootstrap from a container image that may be days old. The Mac Mini scrapes fresh data and writes to Drive. Without L3 refresh, hero instances serve stale data until a rebuild. The Refresh button should always pull from the live source.

### The contract

| Field | Required | Purpose |
|-------|----------|---------|
| `driveFolderId` | Yes | Shared Drive folder where the Mac Mini writes the source file |
| `driveFileName` | Yes | Filename to download (e.g., `saleshub-knowledge.json`) |
| `localCachePath` | Yes | Where to write the downloaded file locally |
| `syncNow()` | Yes | Downloads fresh file from Drive, replaces local cache, reloads data |
| `ensureFresh()` | Yes | Checks local file mtime vs TTL, downloads from Drive if stale |

### Implementation pattern

```typescript
async syncNow(): Promise<void> {
  // 1. Download from Drive → local cache
  const driveFile = await downloadFromDrive(driveFolderId, driveFileName)
  writeFileSync(localCachePath, driveFile)
  // 2. Reload from fresh local cache
  resetCache()
  const data = loadData()
  recordOutcome({ success: true, recordCount: data.length })
}

async ensureFresh(customerSlug: string): Promise<void> {
  const mtime = statSync(localCachePath).mtimeMs
  if (Date.now() - mtime < cacheTtlMs) return // fresh enough
  await syncNow('') // pull from Drive
}
```

### Modules that need L3 Drive refresh

| Module | Drive file | Status |
|--------|-----------|--------|
| `saleshub-content` | `saleshub-knowledge.json` | ❌ **TODO** — reads baked-in config-templates only |
| `saleshub` | `saleshub-knowledge.json` | ❌ **TODO** — same file, same gap |
| `cloud-marketplace` | `cloud-marketplace/latest.json` | ❌ **TODO** — reads local cache only |
| `ecosystem-catalog` | `ecosystem-catalog/*.json` | ❌ **TODO** — reads local cache only |
| `product-intel` | Product corpus files | ✅ Has its own scraper (not Drive-dependent) |

### Bootstrap integration

During bootstrap (Setup Wizard step 1), ALL L3 Drive modules should pull fresh data before the first customer brief is generated. This ensures the hero install has current portfolio intelligence from day one.

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
- ❌ Content hash check in `syncNow()` — hash checks belong in `ensureFresh()` only. `syncNow()` always re-fetches from source.

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
