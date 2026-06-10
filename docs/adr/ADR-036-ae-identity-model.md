---
doc-type: adr
status: active
owner: jason
updated: 2026-06-10
---

# ADR-036: AE Identity Model — Name-Centric, Territory Codes as Attributes

## Status
Accepted (2026-06-09)

## Context
Territory codes (TERR01, TERR02, etc.) were used as primary identifiers for AEs in the setup wizard and territory lookup APIs. When TOLA and High Plains enterprise territories merged into one sheet, territory codes overlapped — Shane Otto (TOLA) and Jeff Veldhuizen (High Plains) both had TERR03. This caused:

1. Wrong AE auto-fill in the setup wizard (selecting Jeff showed Shane)
2. Wrong customer list from territory-lookup API (cache keyed by territory code, first-match wins)
3. Territory keys missing the High Plains pod prefix (parser stripped it)

A 4-agent council debate (Architect, Engineer, Designer, Researcher) unanimously concluded: territory codes are attributes, not identifiers. The primary identity within a pod is the AE name.

## Decision
1. **AE name is the primary identity within a pod.** All lookup APIs accept an `aeName` parameter for disambiguation when territory codes overlap.
2. **Territory codes are attributes/metadata.** They're used for CCSP/Tableau scoping and SF report filtering, but never as identity keys.
3. **Territory sheet is the source of truth** for AE→territory mapping. No separate registry needed.
4. **Territory prefixes are preserved** by the parser. Cell content like `High_Plains_Terr03` routes to the correct pod (`CENTRAL_ENT_HIGH_PLAINS`) via declarative prefix matching on `RegionPodConfig.prefixes`.
5. **Territory lookup cache keys include aeName** to prevent cache collisions between AEs sharing territory codes.
6. **`parseTerritoryParts()` derives subregion by stripping `_TERRXX` suffix** instead of hardcoded segment count, supporting multi-word subregion names.

## Consequences

### Positive
- Overlapping territory codes no longer cause wrong AE selection
- Multi-word subregion names (HIGH_PLAINS, NORTHSTARS) work without code changes
- New territory sections can be added to a sheet by updating settings.json prefixes only
- CCSP scraper correctly scopes to the right Tableau pod for each territory

### Negative
- AE name changes in the sheet require re-bootstrapping (name is identity, not a display label)
- Cache grows slightly larger with aeName-qualified keys

### Risks
- Two AEs with identical names in the same pod would collide (mitigated: names are unique per pod in practice)

## PRINCIPLES.md Update
- Added anti-pattern: "Using territory codes as identity keys instead of AE names"
- Pre-flight question #17 will be added in Phase 2: "Does this feature reference AEs by territory code instead of name?"

## Related Issues
- #712 — Territory lookup AE name key
- #713 — Consolidate auto-fill paths
- #714 — parentFolderId for TOLA
- #719 — parseTerritoryParts multi-word subregion
- #715 — Phase 2: Person-picker UI (milestone)
- #718 — Phase 2: E2E test suite
- #720 — Phase 2: Ingest validation
