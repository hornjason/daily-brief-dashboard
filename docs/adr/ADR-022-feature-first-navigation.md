---
doc-type: adr
status: accepted
owner: jason
updated: 2026-05-15
---

# ADR-022: Feature-first navigation with contract-driven auto-discovery

**Date:** 2026-05-15

## Status

Accepted

## Context

The dashboard sidebar currently scrolls to sections on a single long page. As feature modules multiply (Meeting Prep, Campaigns, News Radar, Business Value Tools), this scroll-to navigation becomes unmanageable — users can't discover capabilities and the page grows without bound. The sidebar needs to become a capability menu, and its entries need to stay in sync with the feature module registry (ADR-020) without manual wiring.

A secondary question: should navigation be customer-first (pick a customer, then see what you can do) or feature-first (see all capabilities, then scope to a customer)? B2B platform research (Salesforce, HubSpot, Gainsight, Clari, Gong) confirmed that feature-first with a customer filter is industry-standard — HubSpot uses the same hybrid category-then-feature pattern. No major platform requires customer selection before showing capabilities.

## Decision

### Feature-first navigation over customer-first

The sidebar is a capability menu. Each entry is a feature (Meeting Prep, Campaigns, News, etc.), not a customer. Account detail tabs remain as a secondary convenience path — users who are already in a customer context can access relevant features from there. Discoverability wins over contextual convenience.

### Server-side contract declarations

Modules declare their UI presence (`nav`, `accountTab`, `scope`) on the same `FeatureModule` contract used for data lifecycle and signals (ADR-020, ADR-021). The frontend calls `GET /api/feature-modules/nav` to discover sidebar entries. Single source of truth for module capabilities, at cost of an API dependency at startup.

### Two fixed sidebar groups: Actions and Intelligence

- **Actions** = things you do: Meeting Prep, Campaigns, Business Value Tools
- **Intelligence** = things you learn: News Radar, Product Lifecycle, RH Events

Fixed groups provide cognitive clarity at current scale. Dynamic grouping would require a group registry and add complexity without benefit — the dashboard has fewer than 10 features.

### Three module scopes: portfolio, customer, both

Modules declare their operating scope on the contract:

- **portfolio** — no customer picker (News, Products). Operates across the whole book.
- **customer** — customer picker required (Meeting Prep, Tools). Operates on one customer.
- **both** — portfolio default with picker as filter (Campaigns). Works either way.

Scope determines sidebar behavior (does clicking the nav entry show a customer picker?) and whether the module appears as an account detail tab.

### Page navigation replaces scroll-to navigation

Each concern gets its own route. The Home page slims to Morning Summary + Top Actions + KPI Cards — a 30-second morning glance, not a scrollable dashboard of everything.

### Composite Intelligence tab

The account detail Intelligence tab aggregates content from news-radar, product-lifecycle, and rh-events into a single view. It is a hardcoded composite, not a module. This prevents tab proliferation (3 extra tabs per customer) while each contributing module still gets its own sidebar page for portfolio-level access.

Adding a new intelligence source requires touching the composite component — acceptable trade-off at current scale versus building a tab plugin system.

## Consequences

**Positive:**
- New modules get sidebar entries and account tabs automatically by declaring `nav` and `accountTab` on the contract — no frontend wiring
- Feature-first layout makes capabilities discoverable to users who don't know what the dashboard offers
- Scope declarations prevent UI bugs (customer picker shown when irrelevant, or missing when required)
- Home page becomes a fast morning glance instead of an everything-page

**Negative:**
- More sidebar entries than the current single-page layout — visual density increases
- `GET /api/feature-modules/nav` adds a blocking API call at frontend startup
- Composite Intelligence tab is not contract-driven — new intelligence sources require manual integration
- Fixed groups (Actions/Intelligence) must be revised if feature count grows past ~12

**Risks:**
- Group taxonomy may not age well as features evolve. Mitigation: groups are a single constant — changing them is a one-line edit, not an architectural change.
- Startup API dependency could flash empty sidebar on slow networks. Mitigation: cache nav response; entries change only on deploy, not at runtime.

## Alternatives Considered

**Customer-first navigation (pick customer, then see features):** Rejected because it hides capabilities behind a customer selection step. Users doing portfolio-level work (news scanning, campaign batching) would have to pick an arbitrary customer to access features that aren't customer-specific.

**Frontend-only registry (hardcoded sidebar in React):** Rejected because it creates two sources of truth — modules declare lifecycle and signals on the server contract but navigation in the frontend. Every new module would require changes in two places.

**Fully dynamic grouping (modules declare their group):** Rejected as over-engineering. With fewer than 10 features, two fixed groups are sufficient. Dynamic grouping adds a group registry, ordering logic, and edge cases (empty groups, single-item groups) for no current benefit.

**Per-module account tabs instead of composite Intelligence tab:** Rejected because three extra tabs (News, Products, Events) per customer creates tab clutter. The composite view lets users see all intelligence in one scroll.

## References

- ADR-020: Feature Module Registry — the contract this extends
- ADR-021: Signal auto-discovery — the signal pattern this nav surfaces
- GitHub #230, #232
