---
doc-type: spec
status: draft
owner: jason
updated: 2026-06-15
---

# SalesHub Product-First Restructure — Proof of Concept

## Goal

Prove the product-first SalesHub ingestion model works end-to-end by scraping ONE product page (Red Hat OpenShift Virtualization), creating the Drive folder structure, extracting high-value documents with Gemini, and emitting signals that cross-reference against customer data to produce actionable recommendations with specific links, calculators, and engagement steps.

## Why OpenShift Virtualization

- Has cloud provider content kits (AWS/ROSA, ARO, Google Cloud) — the Layer 3 proof point
- The AWS Content Kit contains the exact scenario Jason described: calculator + workshops + 5-step process
- Has Customer References (Win Wires, case studies)
- Has Demos & Videos — engagement resources
- Medium complexity — not overwhelming, not too simple
- Cross-referencing scenario maps directly: AWS spend + K8s + VMware → ROSA calculator

## Success Criteria

### SC-1: Product page scraping captures all sections
- [ ] Scraper navigates to OpenShift Virtualization product page on SalesHub
- [ ] Identifies all sections by walking red header bars in DOM
- [ ] Extracts: Product News, Business decks, Technical decks, Key resources, Demos & Videos, Customer References, Cloud Provider sections (ARO, ROSA, Google Cloud), Top services resources, Top training resources
- [ ] Reads TDP sidebar: "Virtualization" + "VM migration & modernization" links
- [ ] Reads sidebar metadata: contact email, Slack channel, product page links
- [ ] Captures inline text content (not just links) for Product News and descriptions
- [ ] Zero garbage entries ("arrow down", "0 item(s) selected", "Displaying slide 1 of 1")
- [ ] Produces `_product.json` with all discovered sections

### SC-2: Drive folder structure created correctly
- [ ] Creates `SalesHub Products/Red Hat OpenShift Virtualization/` in Drive
- [ ] Each section from the product page becomes a subfolder
- [ ] Expected structure:
  ```
  SalesHub Products/Red Hat OpenShift Virtualization/
  ├── _product.json
  ├── _enriched.json
  ├── Business decks/
  │   ├── Red Hat OpenShift Virtualization - Core Deck.pptx
  │   └── ...
  ├── Technical decks/
  │   └── OpenShift Virtualization - Technical.pptx
  ├── Key resources/
  │   ├── 15 reasons to adopt Red Hat OpenShift Virtualization.pdf
  │   ├── Get started with Red Hat OpenShift Virtualization.pdf
  │   └── ...
  ├── Demos & Videos/
  │   └── ...
  ├── Customer References/
  │   └── ...
  ├── Cloud Provider Kits/
  │   ├── AWS (ROSA)/
  │   │   ├── OpenShift Virt on ROSA Workshop Content Kit.docx
  │   │   ├── OpenShift Virt on Red Hat OpenShift Service on AWS.docx
  │   │   └── Messaging Guide OpenShift Virtualization ROSA.docx
  │   ├── Azure (ARO)/
  │   │   └── ...
  │   └── Google Cloud/
  │       └── ...
  ├── Top services resources/
  └── Top training resources/
  ```
- [ ] All documents downloaded and uploaded to correct subfolder
- [ ] Each file has a Drive URL that can be linked from signals

### SC-3: Layer 3 enrichment extracts actionable intelligence
- [ ] Gemini processes the AWS Content Kit document
- [ ] Extracts structured data:
  - Cloud Cost Avoidance steps (all 5 steps with links)
  - Calculator URL preserved and accessible
  - Contact name (Tommy Hamilton) preserved
  - Workshop/demo list with URLs
  - Internal sales material list with URLs
  - Sales Play Alignment references
- [ ] Gemini processes any available Messaging Guide
- [ ] Gemini processes any available Battlecard
- [ ] All extracted data stored in `_enriched.json` with links preserved
- [ ] Verification: read `_enriched.json`, confirm calculator URL is clickable, workshop URLs resolve

### SC-4: Signal emission with cross-referencing
- [ ] New module (or refactored saleshub module) loads `_product.json` + `_enriched.json`
- [ ] Emits product news signals:
  ```
  source: 'saleshub-products'
  type: 'product-release'
  headline: 'OpenShift Virtualization Engine (OVE) released'
  metadata: { productSlug, links: [...] }
  ```
- [ ] Emits enablement/training signals:
  ```
  source: 'saleshub-products'
  type: 'recommendation'
  headline: 'Free interactive labs available for OpenShift Virtualization'
  metadata: { productSlug, resourceType: 'training', items: [...] }
  ```
- [ ] Emits cloud provider content kit signals:
  ```
  source: 'saleshub-products'
  type: 'recommendation'
  headline: 'OpenShift Virt on AWS engagement path available'
  metadata: {
    productSlug, cloudProvider: 'AWS',
    actionableSteps: [...],
    calculatorUrl: '...',
    workshopUrl: '...',
    contactName: 'Tommy Hamilton'
  }
  ```
- [ ] Cross-references against customer subscriptions (ADR-029):
  - Customer with OpenShift subscription → signals score as customer-tier (floor 0.50)
  - Customer with AWS cloud spend (CCSP) → cloud provider signals get additional booster
  - Customer with VMware in tech stack → VM migration signals get highest relevance

### SC-5: End-to-end recommendation test
- [ ] Pick a customer that has: OpenShift subscription + AWS cloud spend + VMware in tech stack
- [ ] Run `curl http://localhost:7777/api/customer/{slug}/signals/debug?source=saleshub-products`
- [ ] Verify signals appear with correct metadata
- [ ] Verify the recommendation includes:
  - Specific calculator link (not just "calculator exists")
  - Workshop name + URL
  - Contact name
  - Actionable steps from the content kit
- [ ] Verify a customer WITHOUT OpenShift/AWS gets these signals scored as noise (< 0.35)

## Architecture Decisions

### Product page sections are dynamic, not hardcoded
The scraper reads red header bars from the DOM and treats each as a section. No hardcoded field names. If Red Hat adds a new section next quarter, the scraper captures it automatically.

### Three-layer data model
- **Layer 1** (`_product.json`): Page structure + links + inline text. No Gemini. ~20-50KB per product.
- **Layer 2** (Drive files): Actual documents in product subfolders. Downloaded via existing Seismic API bulk path.
- **Layer 3** (`_enriched.json`): Gemini extraction of high-value documents. Content kits, messaging guides, battlecards only.

### L3 sync pattern (same as CCSP/Pipeline)
Mac Mini scrapes → writes to Drive → hero installs read from Drive. No hero-side scraping.

### Diff-based updates
Weekly scrape compares new `_product.json` against previous version. Only changed sections trigger re-download and re-enrichment.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `scripts/scrape-saleshub-products.ts` | Create | Product page scraper (Playwright, L4 Mac Mini only) |
| `src/modules/saleshub-products-module.ts` | Create | New module replacing saleshub-module + saleshub-content-module |
| `src/lib/saleshub-product-enrichment.ts` | Create | Layer 3 Gemini extraction for content kits/guides/battlecards |
| `src/lib/saleshub-product-drive-sync.ts` | Create | Drive folder creation + file upload + L3 sync |
| `config-templates/saleshub-products/` | Create | Directory for per-product JSON files (shipped in image) |
| `src/modules/saleshub-module.ts` | Keep (for now) | Existing module stays until all products are migrated |
| `src/modules/saleshub-content-module.ts` | Keep (for now) | Existing module stays until all products are migrated |

## Out of Scope (for POC)

- Migrating all 21 products (POC is OpenShift Virtualization only)
- Removing existing saleshub-module / saleshub-content-module
- EngagementBuilder consumer integration (next phase)
- ROI feedback loop (next phase)
- Following TDP links from sidebar to pull TDP page content
- ADR for the restructure (write after POC validates the approach)

## Verification Sequence

1. Run scraper against OpenShift Virtualization page on Mac Mini
2. Verify `_product.json` has all sections, zero garbage
3. Verify Drive folders created with all documents
4. Run Gemini enrichment on AWS Content Kit
5. Verify `_enriched.json` has calculator URL, steps, workshops
6. Load module, emit signals
7. Cross-reference against test customer
8. Read recommendation output — does it include specific calculator link and steps?
9. If yes → POC validated, scale to all products + write ADR
