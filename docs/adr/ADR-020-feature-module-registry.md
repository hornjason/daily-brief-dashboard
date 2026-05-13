---
doc-type: adr
status: proposed
owner: jason
updated: 2026-05-12
---

# ADR-020: Feature Module Registry

**Date:** 2026-05-12

## Status

Proposed

## Context

The dashboard is adding four new feature surfaces: Campaigns, News Radar, Business Value Tools, and enhanced NotebookLM sync. Today, each feature (briefs, product intel, health scoring, etc.) manages its own cache lifecycle, refresh timers, and cleanup independently. There is no shared contract — routes are independently wired, timers are scattered between a centralized heartbeat and standalone `setTimeout` schedulers, and customer archival cleanup only handles orphaned cache files without cascading to timers, status entries, or external resources.

The `ScraperRegistry` proves a self-registration pattern works in this codebase (each scraper implements `ScraperDescriptor` and calls `ScraperRegistry.register()`). But no equivalent exists for non-scraper features.

Adding four features without a shared contract would deepen the ad-hoc wiring and make customer archival cleanup, refresh scheduling, and NotebookLM sync harder to maintain.

## Decision

Introduce a `FeatureModuleRegistry` with a `FeatureModule` TypeScript interface that every new feature implements. The registry manages lifecycle centrally; modules declare their footprint.

### The Contract

```typescript
interface FeatureModule {
  name: string                          // unique identifier (e.g., 'campaigns', 'news-radar')
  cachePaths: (slug: string) => string[] // cache files for a given customer slug
  driveArtifacts?: (slug: string) => string[] // Drive folder paths this module writes to
  notebookSources?: boolean             // true if this module produces NotebookLM-syncable content
  refreshInterval?: number              // ms between scheduled refreshes (null = on-demand only)
  fetch: (customerName: string) => Promise<void>   // pull fresh data
  cleanup: (customerName: string) => Promise<void>  // remove all data for an archived customer
  syncNow: (customerName: string) => Promise<void>  // manual trigger (exposed via API)
}
```

### Startup Catch-Up

On container startup (30s delay), the registry checks each module's `lastRun` against its `refreshInterval`. If stale (elapsed > interval), it runs `fetch()` for all customers. Modules with `refreshInterval: null` (on-demand only) are skipped. This handles missed scheduled windows when the container was down.

```typescript
FeatureModuleRegistry.startupCatchUp(customerNames)
// Returns: [{ moduleName, action: 'skipped'|'ran'|'failed', reason }]
```

### Registration

Each module self-registers at module-load time (same pattern as `ScraperRegistry`):

```typescript
FeatureModuleRegistry.register({ name: 'campaigns', ... })
```

### What the Registry Owns

- **Refresh scheduling:** Modules with `refreshInterval` are added to the 15-min heartbeat tick. The registry tracks `lastRun` per module and fires `fetch()` when the interval elapses.
- **Customer archive cleanup:** When a customer is archived, the registry calls `cleanup()` on every registered module. This replaces the current cache-files-only orphan cleanup with a full cascade.
- **Sync Now endpoints:** The registry auto-exposes `POST /api/customer/:name/modules/:moduleName/sync` for every registered module.
- **Status reporting:** The registry tracks last run, last error, and record count per module (same shape as `ScraperStatusStore`).

### What the Registry Does NOT Own

- **Route mounting:** Each module still creates and mounts its own Hono router. The registry is for lifecycle, not HTTP routing.
- **UI rendering:** React components remain independent. The registry is server-side only.
- **Business logic:** `fetch()`, `cleanup()`, and `syncNow()` implementations are entirely module-owned.

### Migration Strategy

Only new features (Campaigns, News Radar, Tools, NotebookLM sync enhancements) use the registry initially. Existing features (briefs, product intel, health scoring, account intelligence) are migrated one-at-a-time in future work when they are already being modified — no dedicated migration effort.

A future backlog item will audit existing features for contract adoption and define the migration order.

## Consequences

**Positive:**
- New features get lifecycle management for free — register and go
- Customer archival becomes a single `FeatureModuleRegistry.cleanupAll(customerName)` call
- TypeScript enforces the contract — missing `cleanup()` is a compile error
- Sync Now is automatic for every module — no per-feature endpoint wiring
- Pattern is proven by `ScraperRegistry` precedent in this codebase

**Negative:**
- Two systems coexist until existing features migrate (ad-hoc + registry)
- Registry adds a small abstraction layer — must not become a framework that fights the app
- Modules must be careful about `cleanup()` ordering if they have cross-dependencies

**Risks:**
- Over-engineering the interface before real usage validates it. Mitigation: start with the four new modules, evolve the interface based on actual needs, not speculation.

## Alternatives Considered

**Config-driven registry (JSON file):** Rejected because module behaviors (Gemini calls, Drive writes, ContentCampaign pipeline) require actual logic, not declarative config. A JSON file can declare paths but can't express fetch/cleanup logic.

**No registry — continue ad-hoc:** Rejected because four new features would quadruple the ad-hoc wiring and make archival cleanup even more incomplete.
