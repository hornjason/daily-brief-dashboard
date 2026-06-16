---
doc-type: adr
status: proposed
owner: jason
updated: 2026-06-15
---

# ADR-038: Dynamic Matching Replaces Handcrafted Mapping Files

**Date:** 2026-06-15
**References:** ADR-030 (Solution Intelligence Engine), ADR-027 (Signal Scoring), ADR-029 (Portfolio Signal Relevance), #819 (SalesHub Product-First POC)
**Deciders:** Serena Blackwood (architecture), Rayford (DA), Jason Horn (product owner)
**Council:** 4-agent debate (2026-06-15) — unanimous on dynamic matching requirement

## Status

Proposed — pending validation from multi-product scraping (3-5 products).

## Context

### The Problem: Handcrafted Intelligence Core

The intelligence engine's matching layer — where "customer uses VMware" becomes "recommend OpenShift Virtualization migration" — depends on 5 manually authored files:

| File | What it does | Consumers | Staleness risk |
|------|-------------|-----------|----------------|
| `solution-plays.json` | 16 plays with hardcoded trigger technology lists | 8 files (signal-query, recommended-actions, customer-solution-context, competitive-vocabulary, email-entity-extractor, solution-intelligence, templates, playbook) | Goes stale when new technologies emerge or play structures change |
| `tech-positioning.json` | 30 tools mapped to Red Hat alternatives | 1 file (tech-stack-module) | Goes stale when competitive landscape changes |
| `partners.json` | 13 partner names and contacts | 6 files (partner-catalog, people-service, meeting-prep, playbook, audience-filter) | Goes stale when partner relationships change |
| `product-roadmap.json` | Product release timeline | 1 file (meeting-prep-service) | Goes stale after every product release |
| `COMPETITOR_KEYWORDS` | 13 hardcoded competitor names in source code | 1 file (email-entity-extractor) | Goes stale when competitors enter/exit market |

The council debate (2026-06-15) identified this as a fundamental architectural weakness: "The system processes but doesn't learn. Static mappings are wrong from day one — every hardcoded mapping is an assertion that the relationship between a signal and an action is constant."

### The Opportunity: SalesHub Product Pages as Dynamic Source

SalesHub product pages (maintained by Red Hat product marketing) contain the same data — and more — in structured, curated form:

| Handcrafted data | Product page equivalent | How it maps |
|-----------------|----------------------|-------------|
| solution-plays.json trigger technologies | TDP sidebar + Sales Tactics table + Content Kit document names | "VM migration & modernization" tactic page names the technologies |
| tech-positioning.json competitor mapping | Competitive review documents per product | "Amazon Web Services or OpenShift: Virtualization" competitive review |
| partners.json | Partner messaging guides, co-sell content kits | "Commvault and OpenShift Virtualization Messaging Guide" |
| product-roadmap.json | Product News section (latest releases with dates) | "OpenShift Virtualization Engine (OVE) — Press Release, Blog post" |
| COMPETITOR_KEYWORDS | Competitive review document names + Battlecard names | Document names contain competitor names naturally |

The SalesHub product-first POC (#819) proved this works: 113 real document items from one product, with content types that directly map to the handcrafted data.

## Decision

### Phase 1: Coexistence (immediate — during POC validation)

Both systems run simultaneously. The product-first module (`saleshub-products-module`) emits signals from dynamic product page data. The existing modules (`solution-intelligence-module`, `recommended-actions-module`) continue to use `solution-plays.json`. Consumers get signals from both sources.

**Why coexistence first:** The dynamic data must prove it covers the same ground as the handcrafted data before we remove anything. Removing `solution-plays.json` prematurely breaks 8 files.

### Phase 2: Shadow comparison (after 3-5 products scraped)

Add a comparison endpoint: `GET /api/admin/matching-comparison` that shows:
- What `solution-plays.json` matches for a customer vs what product page data matches
- Coverage delta: are there triggers in solution-plays.json that no product page captures?
- New matches: does product page data find opportunities that solution-plays.json misses?

**Success criteria for Phase 2:** Product page data produces >= 90% of the same matches as `solution-plays.json`, plus additional matches from content kits, competitive reviews, and training resources.

### Phase 3: Replacement (after Phase 2 validation)

Replace each handcrafted file with its dynamic equivalent:

| Handcrafted file | Replacement source | Replacement mechanism | Timeline |
|-----------------|-------------------|----------------------|----------|
| `solution-plays.json` | Product page TDP/Tactics sections + Content Kit document analysis | `recommended-actions-module` reads from `saleshub-products-module` signals instead of JSON file | After Phase 2 validates coverage |
| `tech-positioning.json` | Product page competitive review documents + Gemini extraction | Tech-stack module uses product-derived competitor mappings | After solution-plays.json is replaced |
| `COMPETITOR_KEYWORDS` | Competitive review + Battlecard document names from product pages | `email-entity-extractor` derives keywords from product page data | Can be replaced immediately — just extract names from competitive docs |
| `product-roadmap.json` | Product News sections from product pages | Meeting prep reads product news signals instead of static JSON | Can be replaced immediately — product news has dates + links |
| `partners.json` | **KEEP** — local partner relationships (AHEAD, CDW, etc.) are not in SalesHub | This is user-specific configuration, not Red Hat product data | No replacement needed |

### What STAYS Handcrafted

`partners.json` contains local partner relationships specific to the AE's territory. SalesHub has Red Hat's global partner ecosystem, but not "my rep at CDW is John Smith, phone 555-1234." This is user configuration, not product intelligence.

## Consequences

**Positive:**
- Matching layer becomes self-updating — product marketing maintains the data
- New products, new competitive reviews, new content kits appear automatically
- No code deploys needed for the most common changes (new technology, new competitor)
- Content kits provide deeper engagement context than trigger lists ever could

**Negative:**
- Dependency on SalesHub scraper reliability — if scraping breaks, matching degrades
- Seismic SPA DOM may change without notice, breaking extraction
- Product page quality varies — some products have thin pages

**Mitigations:**
- Keep `solution-plays.json` as read-only fallback — if product page data is unavailable, fall back to static mapping
- Monitor: add staleness alert if product page data is >14 days old
- Shadow comparison catches regressions before replacement

## PRINCIPLES.md Update

Add to pre-flight questions:

> **18. Does this module use a handcrafted mapping file?** If yes, verify the same data is available from a dynamic source (product pages, API, scraper). Handcrafted files are fallbacks, not primary sources. New modules MUST NOT introduce new handcrafted mapping files — use dynamic sources from Day 1.

Add anti-pattern:

> **Anti-pattern: Hardcoded technology-to-solution mappings.** Never author a static JSON file that maps technologies to Red Hat solutions. The SalesHub product page scraper provides this mapping dynamically. If the product page doesn't have the mapping, that's a product marketing gap to report — not a JSON file to author.
