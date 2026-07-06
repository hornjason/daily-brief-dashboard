---
doc-type: runbook
status: active
owner: jason
updated: 2026-07-06
---

# Adding a New SalesHub Product — Runbook

This runbook documents every step to add a new SalesHub product to the scraper pipeline, from prerequisites through verification. Written so an AI agent or human can follow it on the first try and get a fully enriched product.

Canonical spec: `docs/specs/saleshub-product-scrape-process.md`

---

## 1. Prerequisites

| Requirement | How to verify |
|---|---|
| Mac Mini SSH | `ssh jasonhorn@mini.local` |
| L4 container running | `podman ps \| grep pai-sync-l3` — must show `pai-sync-l3` with `DISPLAY=:99` |
| SSO cookies fresh | `session-state.json` exists in `/data/rh-profile/` inside the container. Stale cookies cause "Content not found" or login page redirects. |
| Google OAuth token | `google-token.json` present in container (for Google Docs Drive API export) |
| Gemini API key | Set in `.env` (for enrichment) |
| Python3 in container | `podman exec pai-sync-l3 python3 --version` — required for PPTX text extraction via zipfile |
| Product page URL | Must be `https://saleshub.redhat.com/Link/Content/DC...` format. Do NOT use `/products/slug` URLs. |

---

## 2. The Command

```bash
ssh jasonhorn@mini.local
podman exec -e DISPLAY=:99 pai-sync-l3 bun run scripts/scrape-saleshub-product-page.ts '<URL>' --page-only
```

`--page-only` means: CDS interception + Seismic name search is the primary document discovery method. Without this flag, the Seismic API query returns a superset of 100+ documents that are NOT all page-visible, producing overcounts and wrong section assignments.

Always use `--page-only` for new product scrapes.

---

## 3. What the Scraper Does (Detailed Flow)

All function names reference `scripts/scrape-saleshub-product-page.ts`.

### Step 1: CDS Interception Setup

`setupCdsInterception(page)` at L3106. Sets up a network listener for `/cds/*/publishedcontents` XHR responses BEFORE the page navigates. When DocListPicker widgets are later clicked, the browser fires CDS API calls — this interceptor captures each document's `name`, `format`, `contentId`, and `versionId` from the response payload.

Must be set up BEFORE navigation. Documents captured passively — no explicit API calls needed.

### Step 2: Seismic Auth Capture

`captureSeismicAuth(page)` intercepts a search API call on the DocCenter page during navigation. Captures: `Authorization` header, search URL, `teamsiteid`, `x-seismic-route`, `seismicclientname`. These credentials are reused for all subsequent Seismic API calls (name search, downloads).

### Step 3: Navigate to Product Page

`page.goto(url)` with 60-second timeout, followed by 8-second SPA hydration wait.

### Step 4: Multi-Pass Lazy Load Scroll

Up to 8 scroll passes. Each pass scrolls in viewport-height increments, waiting for `scrollHeight` to stabilize between passes. Ensures lazy-loaded content at page bottom is rendered. (Issue #942)

### Step 5: Expand All Accordions

`expandAllAccordions(page)` at L1642. Clicks chevron icons on collapsed accordion panels. 800ms pause per click to allow DOM rendering. Content inside collapsed accordions is invisible to later extraction steps.

### Step 6: Expand Domain DocListPickers

`expandDomainDocListPickers(page)` at L1674. Clicks DocListPicker widgets inside accordion panels. 4-second wait per click — this is the wait for the CDS API response that Step 1's interceptor captures.

CRITICAL: This step triggers CDS interception to capture domain-section documents. If DocListPickers don't expand, CDS captures 0 documents.

### Step 7: Build Product Source Inventory

`buildProductSourceInventory(page)` at L1363. Reads the sidebar table of contents (TOC) and walks DOM widgets to create the ground-truth baseline. Writes `_product-source.json` — the inventory of everything visible on the page BEFORE extraction logic runs.

This file IS the source of truth for completeness (see Section 5).

### Step 8: Red Header Section Extraction

`extractRedHeaderSections(page)` at L831. Walks the DOM for links, tables, and cards under each red header bar section. Uses `page.evaluate()` to extract `a[href]` elements, table rows, and card content from each section.

### Step 9: Carousel Click-Through

`captureCarouselViewerUrls(page)` at L1790. Clicks each card in carousel widgets, captures the viewer URL that opens, then navigates back. Adds discovered card names to the appropriate section. Max 10 scroll attempts per carousel.

### Step 10: Screenshot

Re-expands accordions and DocListPickers (carousel navigation may have collapsed them), then captures `page.screenshot({ fullPage: true })`.

KNOWN LIMITATION: Single `fullPage` screenshot may miss collapsed panels if re-expansion fails silently.

### Step 11: CDS Name Search

For each CDS-captured document NOT already in a section, POST to Seismic search API with `SearchTerm: doc.name`. Returns `downloadUrl` and `contentType`. Assigns to section via the `typeToSection` mapping (see Section 6). 100% hit rate on tested products. Code at L3834.

### Step 12: Phase 3a — Inline Viewer Extraction (PRIMARY path)

For each item in the download queue, extraction path depends on URL type:

| Condition | Method |
|---|---|
| Has URL, Seismic viewer | `extractWithFollowThrough()` at L2187 — handles nav pages, follows links 1 level deep |
| Has URL, Google Docs/Slides | Google Drive API export as `text/plain` (NOTE: loses hyperlinks — should be `text/html`) |
| Has URL, external `redhat.com` | HTTP fetch with SSO cookie detection |
| Has `contentId`, no URL | Builds `/Link/Content/{contentId}` viewer URL, extracts via `extractSinglePage()` at L2115 (issue #973) |
| No URL, no contentId | Skipped |

All extracted content saved to `extracted/{section-slug}/`. Cache: `existsSync(extractPath)` skips already-extracted items.

### Step 13: Phase 3a2 — Viewer Downloads

Downloads binary files (PPTX, PDF) from the viewer:
- **PDF**: Clicks the `aria-label="Download"` button
- **PPTX/DOCX**: Intercepts `download/formats` POST, calls Seismic download API with captured auth

### Step 14: Phase 3b — File Downloads (FALLBACK)

Three-tier fallback when viewer download fails:
1. Viewer click (Download button)
2. Three-dot menu → Download option
3. Direct Seismic API download

Circuit breaker engages after 5 consecutive failures.

### Step 15: PPTX Text Extraction

During enrichment, Python3 one-liner extracts slide XML text from PPTX files via `zipfile` module. Falls back to base64 encoding if extracted text < 100 chars (Gemini may reject large binaries in base64 fallback).

### Step 16: Enrichment

Gemini enrichment with 14-check quality gate (85/100 threshold). Extracts 10 intelligence fields per document:

1. `summary`
2. `keyPoints`
3. `useCases`
4. `talkTracks`
5. `links`
6. `productsReferenced`
7. `integrationsReferenced`
8. `competitorsReferenced`
9. `customerScenarios`
10. `actionableSteps`

Generic opener rejection (#963) filters boilerplate intros. Release notes filtering (#969) prevents changelog noise from polluting intelligence. Writes `_enriched.json`.

### Step 17: Drive Upload

Uploads to Google Drive product folder:
- `_product.json` — all sections and items with URLs
- `_enriched.json` — enrichment data for all documents
- `_pipeline-manifest.json` — pipeline gate data
- Downloaded files (PPTX, PDF) to section subfolders

### Step 18: Completeness Manifest

`generateCompletenessManifest()` at L3225. Compares scraper output against `_product-source.json`. Classifies every item as CAPTURED / AUTH-GATED / MISSING. Coverage formula:

```
coverage = CAPTURED / (CAPTURED + MISSING)
```

AUTH-GATED items are excluded from the denominator. Gate: coverage < 80% = scraper bug, do not proceed to enrichment.

---

## 4. Expected Output

A successful scrape produces log output like:

```
[product-scraper] === Summary ===
  Product: <name>
  Sections: <N>
  Total items: <N>
[pipeline-manifest] Diff: +N new, +N enriched
[product-scraper] Phase 3 coverage gate: 100.0% (passed)
[product-scraper] Step 6: Running inline enrichment...
[product-scraper] Enriching N documents inline...
[quality-gate:document-intelligence] attempt 1/3, score 100/85
[product-scraper] Enrichment complete: N documents enriched
```

If the coverage gate shows < 80%, the scraper has a bug — do not proceed. Check `_completeness-manifest.json` for which items are MISSING.

---

## 5. Verification Checklist

After scrape completes, verify all five:

1. **Pipeline manifest** — `_pipeline-manifest.json`: check `gate0` (DOM count), `gate1` (scraped count), `gate2` (enriched count). All three should be non-zero.
2. **Completeness manifest** — `_completeness-manifest.json`: coverage %, list of MISSING items. Coverage should be >= 80%.
3. **Drive verification** — `_drive-verification.json`: Drive folder audit. Every CAPTURED item should have a matching Drive entry.
4. **Section count vs sidebar TOC** — Visual check: compare the number of sections in `_product.json` against the sidebar TOC in the screenshot. They should match.
5. **Enrichment spot-check** — Read 3-5 entries in `_enriched.json`. Each should have a non-empty `summary`, `keyPoints`, and `useCases` at minimum.

---

## 6. typeToSection Mapping

The mapping from Seismic content type to section name (L3834-L3851):

| Content Type | Section Name |
|---|---|
| `Business presentation` | `Business decks` |
| `Technical presentation` | `Technical decks` |
| `Competitive review` | `Competitive` |
| `Battlecard` | `Competitive` |
| `Case study` | `Customer References` |
| `Customer go-live report` | `Customer References` |
| `Customer success snapshot` | `Customer References` |
| `Video` | `Demos & Videos` |
| `E-book` | `Key resources` |
| `Overview` | `Key resources` |
| `Reference architecture` | `Technical resources` |
| `Datasheet` | `Resources` |
| `Cheatsheet` | `Resources` |
| `Campaign guide` | `Campaign resources` |
| `Email` | `Email templates` |
| `Template` | `Templates` |

If a new product has content types not in this map, items fall to the `page-documents` catch-all section. To fix: add the new content type → section name mapping to the `typeToSection` object at L3834 in `scripts/scrape-saleshub-product-page.ts`.

---

## 7. Approaches That DO NOT Work

These were all tried during the OCP-V sessions (5+ days of debugging) and failed. Do NOT retry them.

1. **`document.body.innerText` for section assignment** — DocListPicker panels are collapsed; names are not in visible text (only ~3038 chars captured). Fails silently — items appear to match but are assigned to wrong sections.

2. **`document.body.textContent`** — Returns a single blob with no newlines (~13431 chars). Cannot be parsed line-by-line for name matching.

3. **Per-section DOM `textContent`** — Cards contain section headers and metadata, not document names. Matching against this text produces false positives.

4. **Keyword matching for section assignment** — Terms like "OpenShift" + "Virtualization" match everything on an OCP-V page. Items get assigned to wrong sections because the keywords are too broad.

5. **`versionId` cross-reference between CDS and API** — CDS interception and the DocCenter API use DIFFERENT `versionId` values for the same document. Cross-referencing by `versionId` produces wrong matches. Use `name` matching instead.

6. **DocListPicker panel clicking via `expandDomainDocListPickers`** — Only targets accordion children, not standalone panels outside accordions. Standalone DocListPickers require separate handling.

7. **Removing `--page-only` flag** — The Seismic API returns 100+ documents (a superset of what's page-visible). This overcounts items and assigns them to wrong sections because many API-returned documents have no page context.

---

## 8. Known Limitations

1. **Single fullPage screenshot** — May miss collapsed panels if accordion/DocListPicker re-expansion fails silently after carousel navigation.

2. **Google Docs export as plain text** — Current export uses `text/plain` MIME type, which loses hyperlinks. Should use `text/html` to preserve `<a href>` tags (see ADR/memory on HTML export).

3. **No differential enrichment** — Re-enriches ALL documents on every scrape run. No delta detection. Large products (80+ items) take proportionally longer on re-runs.

4. **Carousel scroll capped at 10 attempts** — Products with more than ~10 carousel items in a single widget may have incomplete capture.

5. **No cross-product dedup** — The same document appearing on multiple product pages gets scraped, enriched, and uploaded separately for each product.

6. **`extract-product-content.ts` is a SEPARATE script** — It has different logic from the main `scrape-saleshub-product-page.ts`. Do not confuse them. The runbook command uses the main scraper only.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Content not found" or login page in viewer | SSO cookies expired | Re-run SSO keepalive or restart container with fresh `session-state.json` |
| Gemini timeout on enrichment | Large documents (28K+ chars) | Retry — enrichment has 3 attempts per document with backoff |
| 0 CDS documents captured | DocListPickers didn't expand (selector mismatch on new product) | Check `expandDomainDocListPickers` selectors match the new product's DOM structure |
| 0 enriched but items extracted | Enrichment gate blocked (coverage < 80%) | Check `_completeness-manifest.json` for MISSING items; fix scraper section discovery |
| Python3 not found | PPTX extraction falls back to base64 | Verify `python3` is available in container: `podman exec pai-sync-l3 which python3` |
| Items in wrong sections | `typeToSection` mapping missing for new content type | Add the content type → section name entry at L3834 |

---

## 10. Currently Scraped Products

| Product | URL | Last Scraped | Sections | Enriched |
|---|---|---|---|---|
| AAP | `https://saleshub.redhat.com/Link/Content/DC6cbpX7BPhjbGCP6T6WH7B43M9B` | 2026-07-04 | 26 | 85 |
| OCP-V | `https://saleshub.redhat.com/Link/Content/DCgpj38D4BgP2G4RCTjcVQ483WhP` | 2026-07-04 | 14 | 27 |
