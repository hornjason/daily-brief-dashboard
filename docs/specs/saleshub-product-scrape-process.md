---
doc-type: spec
status: draft
owner: jason
updated: 2026-07-03
supersedes: SALESHUB-PRODUCT-FIRST-POC.md
---

# SalesHub Product Scraper — Universal Standard Operating Process

## Goal

Every document visible on a SalesHub product page must be captured, text-extracted, enriched with structured intelligence, and uploaded to Google Drive so the intelligence engine can deterministically match content to customer signals and TDP plays. The process must be identical for every product — give it a URL, it runs all 5 phases automatically.

## Why This Spec Exists

The AAP product scrape worked — 88 items verified against screenshots, enrichment flowing, signals matching customers. But that process was ad-hoc: manual checklists, human-verified screenshots, iterative fixes over 16 issues. When the same scraper ran against OCP-Virt without the same rigor, it captured only 3 of 8+ sections (13 of ~40+ items) and reported "0 gaps."

This spec codifies the AAP pattern so every product follows the same verified path. No product-specific logic, no manual checklists — the scraper verifies itself.

**Core problem:** The scraper has no way to know if it missed sections. It reports what it found and calls that complete. The completeness manifest compares "items captured" vs "items enriched" but never asks "did I capture everything on the page?"

## The 5-Phase Process

### Phase 1: INVENTORY (automated)

The scraper navigates to the SalesHub product page and builds a ground-truth inventory of everything visible. This is a visual sweep — expand everything, screenshot everything, build the checklist.

**Steps:**
1. Navigate to product page URL
2. Expand every accordion, carousel, and DocListPicker
3. Take per-section screenshots (one per section, saved to `docs/visual-inventory/{product-slug}/`)
4. Read the sidebar table of contents to discover ALL section names
5. Walk each section, list every document/item name visible
6. Save as `_product-source.json` — must match what's visible in the per-section screenshots
7. Build `CHECKLIST.md` in `docs/visual-inventory/{product-slug}/` — section-by-section table of every document name with status (✅ enriched, 📥 captured, ❌ not captured)

**Visual inventory directory:** `docs/visual-inventory/{product-slug}/`
- Per-section screenshots (PNG) — the source of truth
- `CHECKLIST.md` — section-by-section document name table with capture/enrichment status
- This directory is committed to the repo and persists across sessions
- Every reconciliation and Phase C verification compares against these screenshots and this checklist
- See `docs/visual-inventory/aap-product-page/CHECKLIST.md` for the canonical format

**Output:** `_product-source.json`
```json
{
  "name": "Red Hat Ansible Automation Platform",
  "slug": "red-hat-ansible-automation-platform",
  "source": "screenshots",
  "sourceFiles": ["aap-page-01.png", "aap-page-02.png"],
  "createdAt": "2026-07-03T12:00:00Z",
  "sections": {
    "product-news": {
      "title": "Product news",
      "type": "link-list",
      "items": [
        {"name": "AAP 2.6 one-slide overview", "group": "June 2026 - AAP 2.7"},
        {"name": "AAP 2.6 release overview + reference guide", "group": "June 2026 - AAP 2.7"}
      ]
    },
    "business-decks": {
      "title": "Business decks",
      "type": "carousel",
      "items": [
        {"name": "Pitch Deck - Red Hat Ansible Automation...", "format": "PPTX"}
      ]
    },
    "aiops": {
      "title": "AIOps",
      "type": "doclist-picker",
      "parentSection": "Domains",
      "items": [
        {"name": "Unlock the full potential of AIOps with automation", "format": "PDF"}
      ]
    }
  }
}
```

Each item has: `name` (always), plus optional `format`, `group`, `subSection`, `description`, `itemType`. No URLs — those come from the scrape. The source file captures what's *visible*, not what's *extractable*.

**This file must accurately reflect what's visible on the product page.** The page itself is the source of truth — `_product-source.json` is the machine-readable representation of it. Phase 2 output is compared against it, and any items in Phase 2 output that aren't in `_product-source.json` (i.e., not visible on the page) are noise and must be filtered out.

**Jason provides only the URL. Everything else is automated.**

### Phase 2: SCRAPE (same page session — automated)

Using the same expanded page from Phase 1, extract URLs, content, and files.

**Entry point:** `bun run scripts/scrape-saleshub-product-page.ts <url> --page-only`

Single page load — Phase 1 builds the inventory, Phase 2 extracts from the same DOM without reloading. No second navigation.

**Steps:**
1. Walk DOM sections using red header bar discovery for section structure
2. CDS interception captures page-visible document names + contentIds passively during scroll
3. Name search: for each CDS document, query Seismic API by exact name (`SearchTerm: doc.name`) to get download URLs + content types
4. ContentId viewer extraction: items with contentId but no URL navigate to `/Link/Content/{contentId}` and extract via `extractSinglePage`
5. Extract text: Google Docs/Slides via HTML export, external URLs via HTTP fetch
6. Download files: PPTX/PDF via API download URL or viewer→Download button→blob URL

**Output:**
- `_product.json` — all discovered sections and items with URLs
- Downloaded files in `downloads/viewer/`
- Extracted text in `extracted/{section}/`

Each item in `_product.json` has: `name` + `url` (the machine-readable link the scraper found in the DOM).

### Phase 3: COMPARE (automated — new)

Compare scraper output against the Phase 1 inventory. Categorize every item into one of three buckets.

**Steps:**
1. Load `_product-source.json` (ground truth) and `_product.json` (scraper output)
2. Compare section-by-section:
   - Sections in source but not in scraper output → **MISSING SECTION** (scraper bug)
   - Sections in scraper but not in source → **EXTRA** (needs investigation)
3. For each item in each matched section, classify:
   - **CAPTURED** — item found in scraper output with a URL → counts toward coverage, eligible for enrichment
   - **AUTH-GATED** — item exists on page but requires OAuth/SSO to access (Google Docs needing auth, Forrester paywall, etc.) → excluded from coverage calculation, excluded from enrichment totals, logged with reason
   - **MISSING** — item visible on page, no auth barrier, but scraper didn't capture it → scraper bug, counts against coverage
4. Output `_completeness-manifest.json` with section-level and item-level coverage

**Coverage formula:**
```
coverage = CAPTURED / (CAPTURED + MISSING)
```
AUTH-GATED items are NOT in the denominator. They don't count for or against coverage. They don't count toward enrichment totals.

**Gate: if coverage < 80%, scraper has a bug — do not proceed to enrichment.**

Missing sections are scraper bugs to fix, not "acceptable gaps." Auth-gated items are known limitations documented per-item with a reason — not bugs.

### Phase 4: ENRICH + UPLOAD (automated)

**Enrichment:**
- Gemini enrichment with quality gate (14 checks, 85/100 threshold)
- Every extracted/downloaded document enriched with ≥5 of 10 intelligence fields:
  summary, keyPoints, useCases, talkTracks, links, productsReferenced, integrationsReferenced, competitorsReferenced, customerScenarios, actionableSteps

**Upload to Google Drive:**
The product folder becomes a complete reference of everything on the page:

| Item type | Drive representation | How |
|-----------|---------------------|-----|
| Downloadable file (PPTX, PDF) | Uploaded file | Direct upload to section subfolder |
| Google Doc/Slides | Google Drive shortcut | `application/vnd.google-apps.shortcut` with `shortcutDetails.targetId` |
| External web content (blog, webinar) | `.webloc` link file | Plist-format file with URL |
| Data files | Uploaded JSON | `_product.json`, `_enriched.json`, `_pipeline-manifest.json` |
| Visual proof | Uploaded PNG | `_page-screenshot.png` (post-expansion) |

**Every item on the product page has a corresponding entry in the Drive folder.** If it's a file → uploaded. If it's a Google Doc → shortcut. If it's a web page → link file.

**Dashboard links:** Every signal in the UI carries a clickable URL back to the source material. AE clicks a recommendation → goes directly to the original content.

### Phase 5: VERIFY (automated + manual)

Document-by-document verification — not counts, but name-level matching.

**Step 1: Drive Folder Audit (automated)**

Walk every item in `_product-source.json` and verify it exists in the Google Drive product folder:

```
For each section in _product-source.json:
  For each item in section:
    Look for matching entry in Drive folder (by document name):
      - File upload → file with matching name in section subfolder
      - Google Drive shortcut → shortcut with matching name
      - .webloc link file → link file with matching name
    Record: ✅ PRESENT / ❌ MISSING / ⚠️ NAME MISMATCH
```

**Output:** `_drive-verification.json`
```json
{
  "productSlug": "red-hat-ansible-automation-platform",
  "verifiedAt": "2026-07-03T12:00:00Z",
  "driveFolderId": "...",
  "sections": {
    "business-decks": {
      "title": "Business decks",
      "expected": [
        {"name": "Pitch Deck - Red Hat Ansible Automation...", "format": "PPTX"}
      ],
      "found": [
        {"name": "Pitch Deck - Red Hat Ansible Automation...", "driveFileId": "...", "driveType": "file"}
      ],
      "missing": [],
      "extra": []
    },
    "key-resources": {
      "title": "Key resources",
      "expected": [
        {"name": "Website"},
        {"name": "Release notes"}
      ],
      "found": [
        {"name": "Website", "driveFileId": "...", "driveType": "webloc"}
      ],
      "missing": [
        {"name": "Release notes", "reason": "no matching Drive entry"}
      ],
      "extra": []
    }
  },
  "summary": {
    "totalExpected": 88,
    "totalFound": 85,
    "totalMissing": 3,
    "totalExtra": 0,
    "coveragePercent": 96.6
  }
}
```

**Gate: every CAPTURED item from `_product-source.json` must have a matching entry in Drive.** AUTH-GATED items are listed separately with their reason — they don't count against Drive coverage. Missing items are logged individually by name — not hidden behind a count.

**Step 2: Enrichment Audit (automated)**

For each CAPTURED document present in Drive, verify it also has an enrichment entry in `_enriched.json` with ≥5 populated intelligence fields. AUTH-GATED items are excluded from enrichment totals — they were never downloaded, so they can't be enriched.

**Step 3: Signal Verification (automated)**

1. Trigger hero refresh (`downloadProductsFromDrive()`)
2. `curl` the signals API for a customer with matching subscriptions
3. Verify signal count > 0 and each signal has a non-empty source URL

**Step 4: UI Verification (Quinn)**

Quinn opens localhost:7776, navigates to a customer detail page, verifies product signals render with clickable links.

## Artifacts

| Artifact | Purpose | Location |
|----------|---------|----------|
| Spec | This document | `docs/specs/saleshub-product-scrape-process.md` |
| Visual inventory (SOURCE OF TRUTH) | Per-section screenshots + checklist | `docs/visual-inventory/{product-slug}/` |
| Machine inventory | Automated inventory (must match visual) | `config-templates/saleshub-products/{slug}/_product-source.json` |
| Completeness gate | Scrape vs source comparison | `config-templates/saleshub-products/{slug}/_completeness-manifest.json` |
| Drive verification | Document-by-name Drive audit | `config-templates/saleshub-products/{slug}/_drive-verification.json` |
| Entry point | One input: product page URL | `bun run scripts/scrape-saleshub-product-page.ts <url> --page-only` |

## What Needs to Change (Code)

1. **`generateCompletenessManifest()`** — upgrade to compare against `_product-source.json` (not just `_enriched.json`). If source file exists, compare section-by-section. Report missing sections as scraper bugs, not "0 gaps."

2. **`_page-screenshot.png`** — move screenshot capture to AFTER all sections are expanded (#964). Makes the screenshot useful for verification.

3. **`_product-source.json` generation** — Phase 1 of the scraper. Schema above. Must match the per-section screenshots in `docs/visual-inventory/{slug}/`. Serves as the machine-readable baseline the scraper measures itself against.

## What Does NOT Change

- The scraper code itself (section discovery, DOM walking, extraction)
- The enrichment pipeline (quality gate, Gemini prompts)
- The Drive upload path (sync daemon)
- The ship skill (already enforces specs)

## Success Criteria

- [ ] SC-1: Given a product URL, the scraper produces `_product-source.json` with every page-visible section and item name. Threshold: 0 sections missing from sidebar TOC.
- [ ] SC-2: `_completeness-manifest.json` compares `_product.json` against `_product-source.json` at section and item level. Threshold: manifest flags every MISSING section (sections in source not in scraper output).
- [ ] SC-3: Coverage gate blocks enrichment when coverage < 80%. Threshold: enrichment does not run when gate fails.
- [ ] SC-4: `_drive-verification.json` confirms every CAPTURED document from `_product-source.json` exists in the Google Drive product folder by name — as a file upload, shortcut, or link file. AUTH-GATED items listed separately, excluded from coverage. Threshold: 0 CAPTURED items in `missing` array. Verification is name-level, not count-level.
- [ ] SC-5: Process works identically for AAP and OCP-Virt without product-specific code paths. Threshold: same script, same arguments (only URL differs).
- [ ] SC-6: AE-facing signals carry clickable URLs back to source material. Threshold: 100% of signals have a non-empty URL pointing to original content.

## Out of Scope

- API-sourced items without viewer URLs (100 items per product — requires Seismic API auth, separate follow-up)
- Auth-gated Google Docs (requires service account or user OAuth)
- Forrester/analyst paywall content
- File-to-text extraction for downloaded PDFs/PPTXs (enrichment uses Gemini on the binary directly)

## Related Issues

- #932 — Goal: Deterministic product page content capture (parent goal)
- #964 — Full-page screenshot after expanding all sections
- #942 — Scraper page scroll does not trigger full lazy load
- #967 — Fix 3 scraper extraction gaps
- #916 — SalesHub product enrichment not uploaded to Drive after scrape
- #970 — Exclude generated data from Docker image
- #971 — Deduplicate Drive folders

## Verification Sequence (for each new product)

1. Run scraper with product URL → Phase 1 produces `_product-source.json`
2. Phase 2 scrapes → `_product.json` + downloads + extracted text
3. Phase 3 compare → `_completeness-manifest.json` shows coverage
4. If coverage < 80% → fix scraper section discovery, re-run from Phase 1
5. If coverage ≥ 80% → Phase 4 enriches + uploads to Drive
6. Phase 5 Step 1 → `_drive-verification.json` audits every document by name against Drive folder
7. Phase 5 Step 2 → enrichment audit confirms each Drive doc has ≥5 intelligence fields
8. Phase 5 Step 3 → signal API check for matching customers
9. Phase 5 Step 4 → Quinn UI verification on localhost:7776
10. Any missing items in Drive verification → fix upload, re-run Phase 4+5
