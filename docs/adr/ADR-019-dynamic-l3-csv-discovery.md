---
doc-type: adr
status: active
owner: jason
updated: 2026-06-24
---

# ADR-019: Dynamic L3 CSV Discovery for Pipeline and CCSP Refresh

**Date:** 2026-05-12

## Status

Proposed

## Context

The daily refresh path (`refreshPipeline()` and `refreshCCSP()`) reads data from Google Sheets whose IDs are stored statically in `aes.json`. These IDs are set during bootstrap and never updated. The L4 sync daemon writes fresh CSV files daily to the shared Drive folder with date-stamped names (`SF-PIPELINE-{reportId}-{pod}-{date}.csv`, `CCSP-{pod}-{date}.csv`). When the bootstrap-created sheet becomes unreachable, the refresh silently returns zero records.

Only the subscription (SF Bookings) sheet is truly static — it IS the source of truth. Pipeline and CCSP sheets are derived copies of CSVs.

## Decision

Read L3 CSVs directly from Drive during daily refresh, bypassing the intermediate Google Sheets for pipeline and CCSP.

### Data flow (before → after)

**Before:** L4 writes CSV → bootstrap reads CSV → bootstrap creates Sheet → refresh reads Sheet → writes cache
**After:** L4 writes CSV → refresh reads CSV → writes cache

### Discovery

New function `discoverL3Csv(folderId, namePrefix, podKey, driveApi)` in `src/lib/l3-csv-reader.ts`:
- Query: `name contains '{prefix}' and name contains '-{podKey}-'` in `podBookingsFolderId`
- Sort by `modifiedTime desc`, take first (most recent)
- Fallback: drop podKey filter if pod-specific search returns nothing
- Drive API injected for testability (same pattern as `l3-bootstrap.ts`)

### Change detection

1. L1 cache TTL check (24h) gates whether discovery runs at all (unchanged)
2. `modifiedTime` from discovery response compared against `cached.cachedAt`
3. Download only if CSV is newer — saves one API call vs current `checkFilesModified()`

### What stays the same

- `subscriptionSheetId` — static, SF Bookings sheet is the source of truth
- `pipelineSheetId` / `ccspSheetId` — remain on AE type as optional display-only fields
- Bootstrap still creates sheets for human viewing
- L1 disk cache TTL (24h) unchanged
- Stale-overwrite guard unchanged

## Consequences

**Positive:** Self-healing discovery, simpler data flow, one fewer quota bucket, testable via injected deps.

**Negative:** Two paths coexist temporarily (CSV-direct for refresh, sheet-based for bootstrap viewing).

**Risks:** L4 daemon not running → discovery returns null → stale-overwrite guard preserves cache (correct degradation). CSV name format change → constant in one file, not spread.

## Alternatives Considered

1. **Re-discover sheet IDs during refresh** — still requires the intermediate sheet to exist
2. **Store CSV file IDs in aes.json** — same staleness problem, L4 creates new files daily
3. **Run bootstrap on every refresh** — too heavy, creates folders and does territory matching
