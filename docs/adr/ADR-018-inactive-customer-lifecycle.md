---
doc-type: adr
status: active
owner: jason
updated: 2026-05-12
---

# ADR-018: Inactive Customer Lifecycle — Binary Active/Gone Model

**Status:** Accepted
**Date:** 2026-05-12
**Decision makers:** Council (Serena, Marcus, Aditi, Rook) + Jason

## Context

When AEs are removed from the wizard, their customers are marked `inactive: true` and preserved in `customers.json` if they have account numbers OR Drive folder IDs. This led to 94 inactive customers accumulating (9 old AEs) vs 12 active (1 current AE), inflating KPI case counts from 1 to 46.

Account numbers are cheap to rediscover (seconds via RH Portal scraper). Drive folder IDs represent curated work (intel briefs, customer docs).

## Decision

**Binary state model: customers are active or gone.**

1. No `inactive` flag — customers exist in `customers.json` or they don't
2. AE removal deletes customers entirely, with one exception: customers with `driveFolderId` get a lightweight archive record in `archived-customers.json` (name + folderId + archivedAt)
3. AE removal purges all cached files for removed customers
4. Global filter at `server-state.ts` load level ensures no endpoint can accidentally serve stale data
5. All 17+ redundant `!cu.inactive` filters are removed after the global filter is in place

## Alternatives Rejected

- **Three-tier retention** (purge/archive/soft-delete with 90-day TTL) — overengineered for a single-user app
- **Admin UI for inactive management** — scope creep; auto-cleanup is sufficient
- **Preserving account numbers** — they're discovery artifacts, not curated data

## Consequences

- Drive folder IDs are the only data preserved on AE removal
- Account numbers must be rediscovered if a customer returns under a new AE
- The `inactive` field is removed from the Customer type
- `archived-customers.json` becomes a lightweight audit trail
