---
doc-type: adr
status: accepted
owner: jason
updated: 2026-06-08
---

# ADR-035: Signal Routing Expansion — Source-Specific with Metadata Fallback

**Date:** 2026-06-08
**References:** ADR-020 (Feature Module Registry), ADR-027 (Signal Scoring), #672-674 (routing fixes)
**Deciders:** Serena Blackwood (architecture), Rayford (DA), Council audit

## Status

Accepted

## Context

### Problem

7 of 30 producer modules emitted signals that fell to 'other' in routeSignal() and never appeared in deterministic consumer output. The original metadata-driven routing (checking hasCloudSpend, severity, infrastructure, etc.) worked for the initial 8 signal types but didn't cover newer modules like ecosystem-catalog, competitive-intel, intelligence, partner-catalog, saleshub, and emails.

### Root cause

These modules' signals carried metadata that didn't match any existing routing rule. Ecosystem-catalog set metadata.product to the full platform name ("Red Hat Ansible Automation Platform") which routed to 'product' but then failed filterByProduct() slug comparison. Intelligence, partner-catalog, saleshub, and emails had no routing-relevant metadata at all.

## Decision

### Source-specific routing before metadata routing

Expanded routeSignal() from 8 to 14 routes by adding source-specific checks BEFORE metadata-driven routing:

```typescript
if (signal.source === 'ecosystem-catalog') return 'ecosystem'
if (signal.source === 'competitive-intel') return 'competitive'
if (signal.source === 'intelligence') return 'intelligence'
if (signal.source === 'partner-catalog') return 'partner'
if (signal.source === 'saleshub-tactics' || signal.source === 'saleshub-plays') return 'saleshub'
if (signal.source === 'emails') return 'email'
// Then metadata-driven routing for remaining signals...
```

### Why source-specific before metadata

Ecosystem-catalog signals set metadata.product (the platform name), which caused them to route to 'product' incorrectly. Source-specific checks intercept these BEFORE metadata routing can misroute them.

### Trade-off acknowledged

Source-specific routing couples the template engine to producer identity — new modules must be explicitly added to routeSignal(). The ideal architecture is metadata-first routing where producers set metadata.category and the template engine routes by category alone.

### Mitigation: Architecture compliance test (#675)

A mandatory test verifies every registered producer module routes to a named section. New modules that fall to 'other' fail the test immediately. This prevents silent routing gaps regardless of which routing mechanism is used.

### Migration path

Future work: migrate source-specific checks to metadata-driven routing by having producers set metadata.category at emission time. This eliminates the coupling between routeSignal() and producer identity. Tracked as architectural debt, not blocking.

## Consequences

**Positive:**
- 7 previously invisible modules now produce visible consumer output
- Architecture compliance test prevents regression
- Zero consumer changes required — all consumers call templateAll()

**Negative:**
- Dual routing pattern (source-specific + metadata) requires documentation
- New modules must know to either set routing metadata OR be added to routeSignal()
- signal-templates.ts grew to 1,159 lines (decomposition tracked at #684)

## Anti-pattern

New modules MUST NOT rely on being added to routeSignal() as source-specific entries. They should set metadata that routes correctly via existing metadata rules. Source-specific entries are transitional debt for modules that pre-date this decision.

## PRINCIPLES.md Update

- Added pre-flight question Q16: signal routing verification
- Added anti-pattern: hardcoded product/competitor/technology vocabularies
- Updated Section Groups table with new section groups
