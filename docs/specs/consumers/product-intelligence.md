---
doc-type: consumer-spec
status: active
owner: jason
updated: 2026-08-03
---

# Consumer Spec: Product Intelligence

## Overview
Grounded Q&A system for Red Hat products (RHEL, OpenShift, Ansible Automation Platform) using Vertex AI Google Search grounding. Returns answer text with extracted source citations and confidence levels based on grounding metadata.

## Source Files
- `src/product-intel-routes.ts` — thin HTTP adapter (no domain logic)
- `src/product-intel-service.ts` — domain logic: batch orchestration, Drive folder setup, slide ingestion, territory aggregation
- `src/product-intelligence.ts` — core Q&A engine: Gemini grounded search, source extraction, confidence derivation
- `src/product-release-radar.ts` — product summary caching and release tracking
- `src/product-drive-ingest.ts` — Drive corpus refresh and caching
- `src/product-feature-radar.ts` — feature extraction and enrichment
- `src/customer-product-intel.ts` — customer-specific product intelligence generation

## Delivery
- **API-only**: Returns JSON responses, no Drive upload
- **UI**: Product Intelligence admin page + customer detail product intel tabs
- **Delivery Type**: `api-only` (no document generation)

## API Endpoints

### Core Product Intelligence
- `GET /api/products` — all cached product summaries
- `GET /api/products/config` — full product config array
- `GET /api/products/:slug` — single cached summary
- `POST /api/products/:slug/refresh` — fetch and synthesize product summary
- `POST /api/products/refresh-all` — refresh all product summaries
- `GET /api/products/alerts` — unacknowledged + all product alerts
- `POST /api/products/alerts/:id/acknowledge` — acknowledge alert

### Drive and Slides
- `POST /api/products/setup-drive-folders` — bootstrap Drive subfolders
- `POST /api/products/ingest-slides` — ingest Drive corpus
- `GET /api/products/slides-status` — cached Drive corpus status

### Customer Intelligence
- `GET /api/products/:slug/intel/:customerSlug` — cached customer intel
- `POST /api/products/:slug/intel/:customerSlug/generate` — generate customer intel
- `POST /api/products/intel/:customerSlug/generate-all` — generate all products for customer
- `POST /api/products/intel/generate-all-customers` — batch generation all customers × all products
- `GET /api/products/intel/generate-all-customers/status` — batch generation status

### Features
- `GET /api/products/features` — all products' feature caches
- `GET /api/products/:slug/features` — single product feature cache
- `POST /api/products/:slug/features/refresh` — extract + enrich features
- `POST /api/products/features/refresh-all` — refresh all product features

### What's New
- `GET /api/products/:slug/whats-new` — Gemini-synthesized sales talking points

### Territory Summary
- `GET /api/products/:slug/territory-summary` — aggregate customer intel across territory

### Customer Data Q&A
- `POST /api/customer-query` — query all customer data with natural language question

### Product Configuration
- `PATCH /api/products/:slug/sources` — update customSources and followLinks

## Required Sections
Product Intelligence is API-only and does not generate structured documents. Output varies by endpoint:

### Product Query (from `product-intelligence.ts`)
- Answer text (grounded response)
- Source citations (title + URL)
- Confidence level (HIGH/MEDIUM/LOW)

### Customer Data Query (from `product-intelligence.ts`)
- Answer text (grounded in customer data, not web search; rendered as markdown in UI via `lib/render-markdown.ts`)
- Data sources queried: subscriptions, support cases, docs corpus, pipeline/opportunities, tech stack, account intelligence
- Grounding: disabled (false) — answers from internal data only
- Confidence level: based on data section coverage (4+ sections with data = HIGH, 2-3 = MEDIUM, 0-1 = LOW)
- Sources: internal data section names (not web URLs)
- UI: `CustomerQueryPanel.tsx` — single unified input, no product tabs, markdown-rendered answers with confidence badge and data source badges

### Customer Product Intel (from `customer-product-intel.ts`)
- Customer context (name, subscriptions, support cases)
- Product summary and features
- Relevance score
- Priority action
- Slides text context
- Opportunity note

### Territory Summary (from `product-intel-service.ts`)
- Coverage count and breakdown by confidence
- Top priority actions (customer + action + confidence)
- Slides status (files ingested, last refreshed)
- Feature status (count, extracted/enriched timestamps)

## Quality Validator
**NONE** — Product Intelligence does not call Gemini for generation requiring quality validation. The `queryProductIntelligence()` function uses grounded search and returns structured data (answer, sources, confidence). No quality validator exists or is needed per ADR-024 requirements.

Note: `customer-product-intel.ts` calls Gemini via `generateCustomerProductIntel()` but does NOT import or use `validateAndRetry()`. This may be a gap requiring validator implementation.

## TC Compliance

| Requirement | Status | Evidence |
|---|---|---|
| **TC-1: @consumer-contract v1.0** | ❌ | Missing declaration in all source files |
| **TC-2: ensureFresh** | ⚠️ | Not applicable — no `loadCustomerSignals()` calls. Uses product-specific caching. |
| **TC-3: templateAll** | ⚠️ | Not applicable — does not generate customer-facing documents. Uses product-specific prompts. |
| **TC-4: validateAndRetry** | ⚠️ | `customer-product-intel.ts:40` calls `callGemini()` but does NOT import or use `validateAndRetry()`. Potential gap. |
| **TC-5: callGemini standardization** | ✅ | `product-intelligence.ts:113`, `product-intel-service.ts:537`, `customer-product-intel.ts:40` — all via `callGemini()` wrapper. No direct Gemini imports. |
| **TC-6: Drive delivery** | ⚠️ | Not applicable — API-only consumer, no document generation. |
| **TC-7: getAccountTeam** | ❌ | No `getAccountTeam()` import or usage in any source file. Customer context is passed but team context is not included. |

### Detailed Findings

**TC-1 Violation:**
- `src/product-intel-service.ts` — no contract declaration
- `src/product-intelligence.ts` — no contract declaration
- `src/product-intel-routes.ts` — no contract declaration
- `src/customer-product-intel.ts` — no contract declaration

**TC-4 Potential Gap:**
- `src/customer-product-intel.ts:40` — `callGemini()` invocation without quality validation
- No `validateAndRetry()` import in file
- Generated content includes structured fields (relevanceScore, priorityAction) that may benefit from validation

**TC-7 Violation:**
- No account team context in product intelligence queries
- Customer name is passed (`customerName?: string`) but team members are not included
- Product intel generation for customers does not reference AE/ASA/specialists

### Recommendations

1. **Add contract declarations** to all source files (TC-1)
2. **Evaluate TC-4 gap**: Does `customer-product-intel.ts` need quality validation? If yes, implement validator.
3. **Consider TC-7 enhancement**: Should product intel queries include account team context? If yes, add `getAccountTeam()` integration.
4. **Document exemptions**: Formalize that Product Intelligence is exempt from ensureFresh/templateAll/Drive delivery due to API-only delivery model.
