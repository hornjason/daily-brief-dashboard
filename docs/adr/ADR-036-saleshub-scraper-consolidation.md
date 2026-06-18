---
doc-type: adr
status: proposed
owner: jason
updated: 2026-06-18
---

# ADR-036: SalesHub Scraper Consolidation

**Date:** 2026-06-18

## Status

Proposed

## Context

The system has two overlapping SalesHub scrapers that query the same Seismic API, download from the same DocCenter, upload to the same Google Drive, and extract the same text content:

**Scraper 1 — TDP/Tactic Scraper** (`scripts/scrape-saleshub.ts`, #448):
- Queries Seismic API facets to discover TDP, Play, and Tactic taxonomy names (~30 seconds, pure API)
- Queries Seismic API for documents per TDP filtered by 8 content types
- Bulk ZIP downloads all documents via DocCenter UI interaction
- Uploads to Drive under `SalesHub/SalesHub Content/{TDPs,Sales Plays}/` folders
- Extracts text from PDFs/PPTXs
- Outputs `saleshub-knowledge.json` with `tdps[]`, `salesPlays[]`, `tactics[]`, each containing a `documents[]` array with `driveUrl`, `extractedContent`, metadata
- Document-to-TDP matching relies on filename similarity after download — only 62 of 161 documents get a `driveUrl` matched back
- Constructs SalesHub DocCenter URLs using hardcoded `DOCCENTER_PROFILE` (`1d1918e9-b5b0-4428-b8fc-87e02ad44156`) in 6 files

**Scraper 2 — Product Page Scraper** (`scripts/scrape-saleshub-product-page.ts`, #819):
- Playwright walks individual product pages, discovers sections by DOM structure (red header bars)
- Queries Seismic API to enrich items with `versionId`, `contentId`, format metadata
- Per-document download with proper properties and circuit breaker
- Completeness auditing via `_completeness.json` and CDS network interception
- Delta detection — only downloads changed items on re-scrape
- Gemini enrichment produces content kits, messaging guides, battlecards (`_enriched.json`)
- Outputs per-product JSON: `_product.json` + `_enriched.json` in `config-templates/saleshub-products/{slug}/`
- Drive uploads per product folder with proper `driveUrl` storage
- Currently only OpenShift Virtualization scraped (POC), with ~21 total products planned

**The triggering incident:** All 12 SalesHub DocCenter URLs in the Strategic Motion tile returned 404 because SalesHub migrated from `/apps/doccenter/` to `/app/#/doccenter/` (#840). The URL fix landed, but it surfaced a deeper architectural problem: we construct fragile SalesHub DocCenter URLs from `DOCCENTER_PROFILE` + `versionId` when we already have stable Google Drive URLs from the product scraper.

**Overlap:**
- Both authenticate via the same Seismic Bearer token (`captureSeismicAuth()`)
- Both query the same Seismic search API with the same profile version ID
- Both download documents from the same DocCenter
- Both upload to the same Google Drive
- Both extract text content
- Both run sequentially in `sync-l3-daemon.ts`

**The 62/161 driveUrl gap:** The TDP scraper downloads documents via bulk ZIP (filenames assigned by DocCenter), then tries to match each file back to API metadata by filename similarity. This is inherently lossy — 99 of 161 documents get no `driveUrl` assigned, meaning their user-facing links fall back to fragile DocCenter URLs.

### Consumers of TDP scraper data

Seven source files import from `saleshub-knowledge-loader.ts`:

| Consumer | Functions used | What it needs |
|----------|---------------|---------------|
| `src/lib/motion-builder.ts` | `getTdpByName()` | TDP cheatsheet URL, customer deck URL (for `tdpUrl` on tactics) |
| `src/lib/material-index.ts` | `getTdpByName()`, `getAssetsByPlay()` | TDP `cheatsheetUrl`, `customerDeckUrl`, `whatToShare[]`, `whatToShow[]`, `documents[].driveUrl` |
| `src/lib/customer-solution-context.ts` | `getTacticsByTdp()`, `getAssetsByPlay()` | Tactics per TDP, assets per play for solution context |
| `src/campaign-service.ts` | `getSalesPlayByName()` | Sales play metadata for campaign generation |
| `src/meeting-prep-enrichment.ts` | `getTacticsByTdp()`, `getTdpByName()` | Tactics and TDP info for meeting prep talking points |
| `src/meeting-prep-service.ts` | `getTdpByName()`, `getSalesPlayByName()` | TDP and play metadata for meeting prep |
| `src/lib/templates/sales-alignment.ts` | `getTacticsByTdp()`, `getSalesPlayByName()` | Tactics and plays for sales alignment template |

Additionally, `src/scrape-api.ts` uses `getKnowledgeStats()`, `getKnowledgeCoverage()`, and `resetKnowledgeCache()` for admin endpoints.

## Decision

Consolidate into a single scraper methodology. The TDP scraper's taxonomy discovery (fast, API-only, valuable) stays. The TDP scraper's document downloading (slow, lossy, duplicative) is retired. Document URLs come from the product scraper's per-product data instead.

### What stays unchanged

1. **Seismic API facet query for taxonomy** — The TDP scraper's Step 2 (facet discovery) runs in ~30 seconds with zero browser interaction. It discovers TDP names, Sales Play names, Sales Tactic names, and their relationships. This is pure metadata and cannot be obtained from product pages. It stays as-is.

2. **Product page scraper** — `scrape-saleshub-product-page.ts` continues to scrape product pages, download documents, create Drive folders, and produce `_product.json` + `_enriched.json`. It scales from 1 product (current POC) to all 21 products.

3. **`saleshub-knowledge-loader.ts` public API** — All 7 consumer functions (`getTdpByName()`, `getTacticsByTdp()`, `getAssetsByPlay()`, `getTalkTrack()`, `getSalesPlayByName()`, `getTdpDescription()`, `getKnowledgeCoverage()`) keep their signatures. Consumers do not change.

### What gets retired

1. **TDP scraper document downloading** — Steps 3b, 4, 5 (API document queries, bulk ZIP download, Drive upload, text extraction, `documents[]` construction) in `scrape-saleshub.ts` are removed. The scraper keeps Steps 1-2 (auth + facet discovery) and Step 6 (knowledge JSON assembly) but no longer populates `documents[]`, `cheatsheetUrl`, or `customerDeckUrl` from downloaded files.

2. **`DOCCENTER_PROFILE` URL construction** — Lines in `scrape-saleshub.ts` that build URLs like `https://saleshub.redhat.com/app/#/doccenter/${DOCCENTER_PROFILE}/doc/${versionId}` are removed. All user-facing URLs become Drive URLs or are omitted until the product scraper covers that product.

3. **Bulk ZIP infrastructure** — `bulkDownloadByContentType()`, `uploadFileToDrive()`, `isRealDocument()`, `isEnglishDocument()`, and the Drive folder creation for `SalesHub Content/TDPs/` and `SalesHub Content/Sales Plays/` are removed from the TDP scraper.

### What changes

1. **`saleshub-knowledge-loader.ts` gains a product data reader** — In addition to reading `saleshub-knowledge.json`, the loader reads product scraper output (`config-templates/saleshub-products/{slug}/_product.json` and `_enriched.json`). Document URLs, cheatsheet URLs, and deck URLs are resolved from product data when available.

2. **URL resolution priority** — For any document link shown to a user:
   - First: Drive URL from product scraper's per-product Drive uploads (stable, always works)
   - Second: Drive URL from `_enriched.json` content kit extraction
   - Never: SalesHub DocCenter URL (internal use only, breaks on platform migrations)

3. **`material-index.ts` URL resolution** — `resolveSaleshubUrl()` is retired. All material links either have a Drive URL or are omitted. The `driveUrl` field on documents becomes the sole user-facing link source.

4. **`motion-builder.ts` tactic URL source** — `tdpUrl` on tactics currently points to `tdp.cheatsheetUrl` (a DocCenter URL). After consolidation, it points to the Drive URL of the cheatsheet document from the product scraper data, or is omitted if not yet scraped.

### The driveUrl contract

**Every document link shown to users MUST have a Google Drive URL.** SalesHub DocCenter URLs are used ONLY internally by the scraper for downloading. This is enforced by:

1. `material-index.ts` only emits `MaterialLink` entries that have a non-empty `url` field pointing to Drive
2. `motion-builder.ts` only sets `tdpUrl` when a Drive URL exists
3. `saleshub-knowledge-loader.ts` returns `undefined` for URL fields when no Drive URL is available (consumers already handle `undefined` — verified in all 7 files)
4. Architecture compliance test gains a new check: no `saleshub.redhat.com` URLs in signal metadata or template output

### Migration path

**Phase 1: Product scraper scale-out (prerequisite)**
- Scrape all 21 SalesHub products (currently only OpenShift Virtualization)
- Each product produces `_product.json` with section items including `versionId`, `contentId`, download path
- Drive uploads create stable `driveUrl` for each document
- Gemini enrichment produces `_enriched.json` for high-value documents (content kits, messaging guides, battlecards)
- Output: `config-templates/saleshub-products/{slug}/` for all 21 products

**Phase 2: Loader bridge**
- Add product data reader to `saleshub-knowledge-loader.ts`
- Build a product-slug-to-TDP mapping (e.g., `ocp-virt` maps to TDP "Virtualization")
- When `getTdpByName("Virtualization")` is called, the loader checks product data for `ocp-virt` and merges document URLs
- `cheatsheetUrl` and `customerDeckUrl` resolve from product data documents where `itemType` matches
- `documents[]` on TDP nodes populated from product scraper data, not TDP scraper downloads
- Fallback: if product data doesn't cover a TDP yet, existing knowledge JSON data (from the old scraper) is used — no data regression during transition

**Phase 3: TDP scraper slim-down**
- Remove document downloading from `scrape-saleshub.ts` (Steps 3b, 4, 5)
- Keep facet discovery (Steps 1, 2) and knowledge JSON assembly (Step 6)
- Knowledge JSON still contains `tdps[]`, `salesPlays[]`, `tactics[]` with their metadata (description, talk tracks, persona sections, customer lens, etc.) — just no `documents[]`, `cheatsheetUrl`, or `customerDeckUrl`
- Remove `DOCCENTER_PROFILE` constant and all DocCenter URL construction from `scrape-saleshub.ts`
- Remove `bulkDownloadByContentType()`, `uploadFileToDrive()`, `isRealDocument()`, `isEnglishDocument()`
- Remove the content dir creation and ZIP caching logic
- Estimated reduction: ~400 lines removed from `scrape-saleshub.ts`

**Phase 4: Cleanup**
- Remove `DOCCENTER_PROFILE` / `PROFILE_VERSION_ID` from files that only used it for URL construction (keep in files that use it for Seismic API queries)
- Remove `resolveSaleshubUrl()` from `material-index.ts`
- Update `ARCHITECTURE.md` section 31 to reflect the consolidated architecture
- Add architecture compliance test: grep for `saleshub.redhat.com` in signal metadata or template output — fail if found

### Risk: TDP documents without product pages

**Risk:** A TDP document exists in the Seismic API facets but is NOT on any of the 21 product pages. This means the product scraper never encounters it, never downloads it, and never creates a Drive URL for it.

**Analysis:** The TDP scraper discovers documents by querying `CustomProperties: [{ PropName: 'TDP', Values: ['Automation'] }]` — this returns all documents tagged to a TDP regardless of which product page they appear on. Some documents may be tagged to a TDP but not assigned to any product page (e.g., cross-cutting sales methodology documents, internal-only guides).

**Mitigation:**
1. **Phase 2 includes a gap audit.** After all 21 products are scraped, compare: unique `versionId` values from product scraper data vs. unique `versionId` values from the TDP scraper's API query. Documents in the API but not in any product page are logged as `_unmatched-tdp-docs.json`.
2. **Unmatched documents get no user-facing URL.** They are still discoverable via the taxonomy (TDP/Play/Tactic names remain in `saleshub-knowledge.json`), but their links are omitted from consumer output. This is better than showing a DocCenter URL that may 404.
3. **Future: direct API download for unmatched documents.** If the gap audit reveals high-value unmatched documents, a targeted download path using the Seismic download API (not bulk ZIP) can be added. This is deferred — the gap may be negligible once all 21 products are scraped.

**Expected gap size:** Small. Product pages are the primary content organization in SalesHub. TDP-tagged documents that don't appear on any product page are typically internal methodology guides or deprecated content. The 21 product pages should cover 90%+ of customer-shareable documents.

### Sync daemon integration

`sync-l3-daemon.ts` currently runs both scrapers sequentially. After consolidation:
1. Facet discovery (from slimmed TDP scraper) runs first (~30s)
2. Product page scraper runs for all 21 products (~10-15 min total with downloads)
3. Knowledge JSON is assembled from facets + product data
4. Single upload to Drive: `saleshub-knowledge.json` (taxonomy) + per-product folders (documents)

The two steps share the same Seismic auth token captured once at the start.

## Consequences

### Positive

1. **Eliminates the 62/161 driveUrl gap.** Product scraper downloads documents individually with proper metadata — every downloaded document gets a Drive URL. No lossy filename-matching after bulk ZIP.
2. **Eliminates fragile DocCenter URLs.** All user-facing links are Google Drive URLs. Platform URL migrations (like `/apps/` to `/app/#/`) no longer break the dashboard.
3. **Reduces scraper runtime.** Bulk ZIP download + unzip + match + upload takes ~6 min per content type batch (8 batches = ~48 min). Product scraper downloads are incremental (delta detection skips unchanged items) — subsequent runs are much faster.
4. **Richer document metadata.** Product scraper captures section context (which product page section a document belongs to), format, CDS inventory, completeness auditing. TDP scraper only captured content type and distribution terms.
5. **Gemini enrichment.** Product scraper's `_enriched.json` provides structured intelligence (content kit steps, calculator URLs, workshop links) that the TDP scraper never produced. This feeds directly into more actionable recommendations.
6. **Single download path.** One code path for downloading, one for uploading, one for text extraction. Bugs fixed once.

### Negative

1. **Temporary coverage gap during Phase 1.** Until all 21 products are scraped, some TDPs have no product-sourced document URLs. The fallback (existing knowledge JSON from old scraper) prevents data regression, but no new Drive URLs are created for unscraped products.
2. **Product-to-TDP mapping is imperfect.** Not every product page maps 1:1 to a TDP name. The mapping must be maintained as products and TDPs evolve. Mitigation: the mapping is data-driven (from product page sidebar TDP links), not hardcoded.
3. **Product scraper is slower per-product than bulk ZIP.** Individual document downloads with page navigation take longer than a single ZIP. But delta detection and 21-product parallelism potential offset this.

### Risks

1. **Seismic API changes.** Both scrapers depend on the same Seismic search API. If the API changes, both break. Consolidation does not increase this risk — it reduces the surface area (one fewer API query pattern).
2. **Product page DOM changes.** The product scraper relies on DOM structure (red header bars, widget containers). Seismic platform updates could break extraction. Mitigation: completeness auditing catches this — `_completeness.json` flags missing items.

## Acceptance Criteria

### Phase 1 (prerequisite)
- [ ] All 21 SalesHub products have `_product.json` files in `config-templates/saleshub-products/{slug}/`
- [ ] Each `_product.json` has section items with `versionId` populated from Seismic API
- [ ] Documents are downloaded to `config-templates/saleshub-products/{slug}/downloads/`
- [ ] Drive uploads create `driveUrl` for each downloaded document
- [ ] `_completeness.json` generated for each product showing CDS vs DOM vs download coverage

### Phase 2 (loader bridge)
- [ ] `saleshub-knowledge-loader.ts` reads product data from `config-templates/saleshub-products/`
- [ ] Product-slug-to-TDP mapping resolves correctly for all 6 TDP domains
- [ ] `getTdpByName("Virtualization")` returns documents from `ocp-virt` product data with Drive URLs
- [ ] `material-index.ts` returns only Drive URLs — zero DocCenter URLs in output
- [ ] Gap audit: `_unmatched-tdp-docs.json` lists documents in API but not in any product page
- [ ] All 7 consumer files produce identical or improved output (no regressions)
- [ ] Fallback works: TDPs without product data still return existing knowledge JSON data

### Phase 3 (TDP scraper slim-down)
- [ ] `scrape-saleshub.ts` reduced to auth + facet discovery + knowledge JSON assembly (~300 lines, down from ~830)
- [ ] No `bulkDownloadByContentType()`, `uploadFileToDrive()`, `isRealDocument()`, `isEnglishDocument()` in the file
- [ ] No `DOCCENTER_PROFILE` URL construction in user-facing output (internal API query use is allowed)
- [ ] `sync-l3-daemon.ts` runs facet discovery + product scraper sequentially, produces combined output
- [ ] Knowledge JSON still contains all taxonomy metadata (descriptions, talk tracks, persona sections)

### Phase 4 (cleanup)
- [ ] Architecture compliance test: `grep -r 'saleshub.redhat.com' src/` returns zero matches in signal metadata or template output
- [ ] `resolveSaleshubUrl()` removed from `material-index.ts`
- [ ] `ARCHITECTURE.md` section 31 updated to reflect consolidated architecture
- [ ] `DOCCENTER_PROFILE` removed from files that only used it for URL construction

## PRINCIPLES.md Update

**Pre-flight question 18 (existing, Gemini loops) already covers the product scraper's Gemini enrichment calls.**

**New anti-pattern to add:**
- "Constructing SalesHub DocCenter URLs (`saleshub.redhat.com/app/#/doccenter/...`) for user-facing links (ADR-036) — use Google Drive URLs from product scraper data. DocCenter URLs are internal-only, break on platform migrations."

**No new contract section needed** — the consolidation simplifies existing contracts (L3 Drive Refresh, Feature Module Registry) rather than adding new ones. The `driveUrl` contract is enforced by the existing architecture compliance test infrastructure with one new grep check.
