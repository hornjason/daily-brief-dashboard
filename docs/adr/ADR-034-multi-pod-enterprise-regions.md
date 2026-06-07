---
doc-type: adr
status: accepted
owner: jason
updated: 2026-06-06
---

# ADR-034: Multi-Pod Enterprise Regions

**Date:** 2026-06-06
**References:** #629 (hidden pod support), #630 (prefix-based territory routing), #631 (AE dropdown dedup), #632 (CCSP multi-pod fetch), #636 (this ADR)
**Deciders:** Jason Horn (DA), Marcus Webb (engineer)

## Status

Accepted

## Context

### Enterprise regions originally assumed single-pod

The region configuration model (`RegionPodConfig`) assumed a 1:1 mapping between enterprise regions and pods. Each region had exactly one pod with one set of territories, one SF report, and one set of AE columns.

### TOLA absorbed High Plains

The TOLA enterprise region absorbed the High Plains territory but kept legacy territory naming conventions. Territory codes like `High_Plains_Terr03` still exist in Salesforce reports and Tableau views, but the organizational unit is now TOLA. This required multiple pods under one region — a TOLA pod for TOLA-native territories and a High Plains pod for legacy High Plains territories — both reading from the same combined SF report.

### The routing problem

Without multi-pod support, territory codes from the absorbed region could not be routed to the correct pod configuration. The system needed to:
1. Map territory codes to pods based on naming prefixes
2. Hide absorbed pods from user-facing UI (they are implementation details, not user-visible regions)
3. Aggregate AEs across multiple pods without duplication
4. Fetch CCSP data from all pods in a region

## Decision

Multi-pod enterprise regions use four mechanisms:

### 1. Hidden pods (`hidden?: boolean` on `RegionPodConfig`)

Pods marked `hidden: true` are filtered from all user-facing surfaces but remain visible to internal data routing. This separates the organizational concept (one enterprise region) from the data reality (multiple territory groupings).

**Enforcement points for `hidden`:**
- `/api/regions/catalog` — `buildCatalogRegion()` filters hidden pods from the catalog response
- `/api/settings/pod-config` — `scrape-api.ts` filters hidden pods from `flattenPodSfReports()` and `flattenPodLabels()`
- Setup wizard dropdown — uses the pod-config API, so inherits the hidden filter automatically

### 2. Declarative prefix routing (`prefixes?: string[]` on `RegionPodConfig`)

Territory-code-to-pod mapping is declarative. A pod with `prefixes: ['High_Plains']` claims any territory code starting with `High_Plains_` (e.g., `High_Plains_Terr03`). This replaces hardcoded string matching and scales to future territory absorptions.

### 3. Combined SF report

Two pods can share one `sfReportId` when their territories appear in a single combined Salesforce report. The system reads one report and routes rows to the correct pod based on territory code prefixes.

### 4. AE dropdown deduplication

AEs spanning multiple pods (appearing in both a visible and a hidden pod) appear once in the UI dropdown. `extractEnterpriseAeAccounts()` collects AE data from all matching AE columns across all pods in the region, deduplicating by AE name while preserving all territory keys.

### 5. CCSP multi-pod fetch

The CCSP scraper iterates all unique pods in `tableauTerritories` via `getUniquePodFilters()`. This ensures CCSP data is fetched for territories in both the primary and hidden pods.

### 6. Account aggregation

`extractEnterpriseAeAccounts()` collects accounts from all matching AE columns across all pods in the region, not just the first pod.

## Consequences

### Positive

- Enterprise regions with absorbed territories work without manual territory remapping
- Legacy territory naming is preserved — no Salesforce report changes required
- Hidden pods keep the UI clean while maintaining full data routing
- Prefix-based routing is declarative and extensible — future absorptions only require config changes
- No code changes needed for consumers — filtering happens at the API layer

### Negative

- Configuration complexity increases — region config must correctly mark hidden pods and set prefixes
- Debugging territory routing requires understanding the prefix mapping

### Known limitations

- Six `[0]` callsites in the codebase assume single territory per AE. These are accidentally correct for same-pod multi-territory scenarios but would break if an AE had territories across different pods with different Tableau view configurations.
- `parseTerritoryParts()` in `lib/territory.ts` does not know about prefixes — CCSP uses `getUniquePodFilters()` instead of the territory parser for multi-pod routing.

## PRINCIPLES.md Update

Added "Multi-pod Enterprise Region Contract (ADR-034)" section with 5 enforcement rules covering hidden pod filtering, declarative prefix routing, CCSP multi-pod fetch, and AE dropdown dedup.

Added anti-pattern: "Hardcoding territory-to-pod mapping instead of using declarative `prefixes` on `RegionPodConfig`."
