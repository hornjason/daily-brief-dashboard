---
Last validated: 2026-04-24
---

# Gemini AI Audit Report

**Generated:** 2026-04-10  
**Auditor:** Marcus Webb (Principal Engineer)  
**Scope:** All Gemini API call sites in `src/`  
**Customer count:** 106 customers across 2 PODs  

---

## 1. Summary

| Metric | Value |
|--------|-------|
| Total call sites | 14 |
| Models in use | `gemini-2.5-flash` (standard), `gemini-2.5-flash-lite` (high-volume) |
| thinkingBudget: 0 | All call sites (compliant) |
| Estimated daily cost (intelligence off) | ~$0.44/day |
| Estimated daily cost (intelligence on) | ~$0.94/day |
| Biggest cost driver | `doc-classify` (~65% of daily cost with intelligence off) |
| Full 106-customer population run | ~$6.40 one-time |

**Top 3 cost drivers (daily, intelligence on):**

1. `doc-classify` — ~$0.41/day (no result caching, runs per-doc every brief cycle)
2. `customer-product-intel` — ~$0.50/day (106 customers x 3 products weekly)
3. `brief-extract` + `brief-synthesize` — ~$0.014/day (24h cache keeps this low)

---

## 2. Pricing Reference Table

Vertex AI pricing via Google Cloud, as of early 2026. Standard (non-batch) rates:

| Model | Input (per 1M tokens) | Output (per 1M tokens) | Notes |
|-------|----------------------|------------------------|-------|
| `gemini-2.5-flash` | $0.15 | $0.60 | Reasoning model, grounding-capable |
| `gemini-2.5-flash-lite` | $0.075 | $0.30 | High-volume, no reasoning |
| `gemini-2.0-flash` | $0.10 | $0.40 | Previous gen, still available |
| `gemini-2.0-flash-lite` | $0.075 | $0.30 | Previous gen lite |
| `gemini-2.5-pro` | $1.25 | $10.00 | Not in use, allowed in config |

**Batch API discount:** 50% off input and output for asynchronous/batch requests (available on all models).

**Context caching:** Reduces input token cost by ~75% for cached portions. Minimum 32K tokens, 1-hour minimum TTL. Charged at $0.0375/1M tokens/hour (flash) for storage.

---

## 3. Per-Call-Site Audit Table

### 3.1 Brief Pipeline

| # | Call Site | File | Function | Model | Max Output Tokens | thinkingBudget | Schedule | Frequency (106 customers) | Caching | Est. Input Tokens | Est. Output Tokens | Est. Cost/Call | Est. Daily Cost |
|---|----------|------|----------|-------|-------------------|----------------|----------|--------------------------|---------|-------------------|-------------------|---------------|-----------------|
| 1 | **brief-extract** | `customer.ts:895` | `callLLMStructured()` | flash-lite | 8,192 | 0 | On-demand (page view) + startup pre-gen | ~20/day (24h cache, not all viewed daily) | 24h per customer | ~4,000 | ~2,000 | $0.0009 | $0.018 |
| 2 | **brief-synthesize** | `customer.ts:473` | `callLLM()` | flash-lite | 4,096 | 0 | On-demand (page view) + startup pre-gen | ~20/day (same trigger as extract) | 24h per customer | ~3,000 | ~1,500 | $0.0007 | $0.014 |
| 3 | **doc-classify** | `doc-extraction.ts:179` | `callGeminiStructured()` | flash-lite | 8,192 | 0 | During brief generation, per document | ~230/day (avg ~12 docs/customer, ~20 customers/day) | None (per-doc each cycle) | ~2,500 | ~500 | $0.0003 | $0.069 |
| 4 | **PDF text extraction** | `customer.ts:398` | inline fetch | flash-lite | 4,096 | 0 | During brief generation, per PDF (fallback only) | ~5/day (only when local PDF extraction fails) | None | ~3,000 | ~1,000 | $0.0005 | $0.003 |
| 5 | **morning-synthesis** | `dashboard-routes.ts:57` | `synthesizeMorningSummary()` | flash-lite | 1,024 | 0 | On-demand (dashboard page view) | ~2/day (4h cache) | 4h TTL | ~2,000 | ~500 | $0.0003 | $0.001 |

### 3.2 Account Intelligence

| # | Call Site | File | Function | Model | Max Output Tokens | thinkingBudget | Schedule | Frequency (106 customers) | Caching | Est. Input Tokens | Est. Output Tokens | Est. Cost/Call |
|---|----------|------|----------|-------|-------------------|----------------|----------|--------------------------|---------|-------------------|-------------------|---------------|
| 6 | **intelligence-industry** | `account-intelligence.ts:137` | `callGeminiGroundedStructured()` | flash | 8,192 | 0 | Manual trigger / bootstrap | On-demand only | Permanent (customers.json) | ~500 | ~200 | $0.0002 |
| 7 | **intelligence-company** | `account-intelligence.ts:373` | `callGeminiGrounded()` | flash | 8,192 | 0 | Manual trigger / bootstrap | On-demand only | 7-day TTL (configurable) | ~2,000 | ~6,000 | $0.0039 |
| 8 | **intelligence-analysis** | `account-intelligence.ts:523` | `callGeminiGrounded()` | flash | 8,192 | 0 | Manual trigger / bootstrap | On-demand only | 7-day TTL (configurable) | ~2,000 | ~6,000 | $0.0039 |

*Note: Calls 6-8 use Google Search grounding (adds ~$5/1000 queries). At current volumes, grounding cost is negligible (~$0.50 per full population run).*

### 3.3 Product Intelligence

| # | Call Site | File | Function | Model | Max Output Tokens | thinkingBudget | Schedule | Frequency | Caching | Est. Input Tokens | Est. Output Tokens | Est. Cost/Call |
|---|----------|------|----------|-------|-------------------|----------------|----------|-----------|---------|-------------------|-------------------|---------------|
| 9 | **product-release-radar** | `product-release-radar.ts:313` | inline fetch | flash | 2,048 | 0 | Weekly (Sunday 6am ET) | 3/week (RHEL, OCP, AAP) | Content hash (permanent until content changes) | ~6,000 | ~1,000 | $0.0015 |
| 10 | **product-feature-extraction** | `product-feature-radar.ts:343` | inline fetch | flash | 16,384 | 0 | Weekly (Sunday 6am ET) | 3/week | Content hash | ~8,000 | ~4,000 | $0.0036 |
| 11 | **product-feature-enrichment** | `product-feature-radar.ts:579` | inline fetch | flash | 1,024 | 0 | Weekly (after feature extraction) | ~30/week (max 10 features x 3 products) | Content hash | ~3,000 | ~500 | $0.0008 |
| 12 | **customer-product-intel** | `customer-product-intel.ts:361` | inline fetch | flash | 8,192 | 0 | Weekly (Sunday 6am ET) | ~318/week (106 customers x 3 products) | Content hash (permanent until product or customer data changes) | ~6,000 | ~2,000 | $0.0021 |
| 13 | **product-query (Q&A)** | `product-intelligence.ts:173` | `callGeminiGroundedRaw()` | flash-lite | 4,096 | 0 | On-demand (user asks question) | ~2/day (user-driven) | None | ~1,500 | ~1,000 | $0.0004 |

### 3.4 Account Plans

| # | Call Site | File | Function | Model | Max Output Tokens | thinkingBudget | Schedule | Frequency | Caching | Est. Input Tokens | Est. Output Tokens | Est. Cost/Call |
|---|----------|------|----------|-------|-------------------|----------------|----------|-----------|---------|-------------------|-------------------|---------------|
| 14 | **account-plan** | `account-plan.ts:236` | `callGeminiMultimodal()` | flash | 8,192 | 0 | Manual only (Admin button) | ~2/week | Permanent (Drive) | ~20,000 (includes PDF vision) | ~4,000 | $0.0054 |

---

## 4. Full Population Cost Estimate

A single full-populate run across all 106 customers:

### 4.1 Account Intelligence (generate-intelligence per customer)

Each customer triggers 3 Gemini calls (industry ID, company intel, industry analysis):

| Step | Model | Calls | Input Tokens/Call | Output Tokens/Call | Subtotal |
|------|-------|-------|-------------------|-------------------|----------|
| Industry identification | flash (grounded) | 106 | 500 | 200 | $0.02 |
| Company intelligence | flash (grounded) | 106 | 2,000 | 6,000 | $0.41 |
| Industry analysis | flash (grounded) | 106 | 2,000 | 6,000 | $0.41 |
| Google Search grounding | - | 318 queries | - | - | $1.59 |
| **Subtotal** | | **318 calls** | | | **$2.43** |

*Note: Customers with no account numbers or subscriptions are automatically skipped (written as stub). Expect ~15-20% skip rate, reducing actual cost to ~$2.00.*

### 4.2 Product Hub Features Refresh (3 products: RHEL, OCP, AAP)

| Step | Model | Calls | Input Tokens/Call | Output Tokens/Call | Subtotal |
|------|-------|-------|-------------------|-------------------|----------|
| Release radar | flash | 3 | 6,000 | 1,000 | $0.005 |
| Feature extraction | flash | 3 | 8,000 | 4,000 | $0.011 |
| Feature enrichment | flash | ~30 | 3,000 | 500 | $0.023 |
| **Subtotal** | | **~36 calls** | | | **$0.039** |

### 4.3 Per-Customer Product Intelligence (106 customers x 3 products)

| Step | Model | Calls | Input Tokens/Call | Output Tokens/Call | Subtotal |
|------|-------|-------|-------------------|-------------------|----------|
| Customer-product intel | flash | 318 | 6,000 | 2,000 | $0.67 |
| **Subtotal** | | **318 calls** | | | **$0.67** |

### 4.4 Brief Generation (all 106 customers)

Each customer triggers extract + synthesize + ~12 doc-classify calls:

| Step | Model | Calls | Input Tokens/Call | Output Tokens/Call | Subtotal |
|------|-------|-------|-------------------|-------------------|----------|
| Brief extract | flash-lite | 106 | 4,000 | 2,000 | $0.093 |
| Brief synthesize | flash-lite | 106 | 3,000 | 1,500 | $0.072 |
| Doc classify | flash-lite | ~1,272 | 2,500 | 500 | $0.429 |
| PDF extraction (fallback) | flash-lite | ~25 | 3,000 | 1,000 | $0.013 |
| **Subtotal** | | **~1,509 calls** | | | **$0.607** |

### 4.5 Full Population Total

| Component | Calls | Cost |
|-----------|-------|------|
| Account Intelligence | 318 | $2.43 |
| Product Hub Refresh | 36 | $0.04 |
| Customer-Product Intel | 318 | $0.67 |
| Brief Generation | 1,509 | $0.61 |
| **Grand Total** | **~2,181 calls** | **~$3.75** |

With skip rate for no-data customers: **~$3.25 estimated actual cost**.

*If using Batch API (50% discount) for all non-interactive calls: ~$1.90.*

---

## 5. Optimization Recommendations (Ranked by Savings Potential)

### Rank 1: doc-classify recent-document filter (saves ~$0.30/day, ~$110/year)

**Current:** Every brief generation classifies ALL docs in the customer's Drive folder. `docClassifyMaxAgeDays` defaults to `0` (unlimited).  
**Fix:** Set `docClassifyMaxAgeDays: 30` in AI config. Documents older than 30 days produce no new signals.  
**Expected reduction:** ~75% of doc-classify calls eliminated.  
**Risk:** None. Old docs are static; their signals are already captured in prior briefs.  
**Implementation:** One config change in `data-sources.json` under `aiConfig`.

### Rank 2: customer-product-intel subscription gate (saves ~$0.35/day when intelligence on, ~$128/year)

**Current:** Runs for every customer x every product weekly, even if the customer has zero subscriptions to that product.  
**Fix:** In `customer-product-intel.ts`, skip generation if the customer has no matching product subscriptions. ~60-70% of calls produce `relevanceScore: NONE`.  
**Expected reduction:** ~200 calls/week eliminated.  
**Risk:** Low. Zero-relevance results are never displayed to the user.

### Rank 3: Batch API for weekly scheduled jobs (saves ~$0.24/day when intelligence on, ~$88/year)

**Current:** All calls use standard synchronous API.  
**Candidates:** `product-release-radar`, `product-feature-extraction`, `product-feature-enrichment`, `customer-product-intel` -- all run weekly on Sunday, latency-insensitive.  
**Expected reduction:** 50% cost reduction on ~354 calls/week.  
**Risk:** Medium. Requires Vertex AI batch API integration (different endpoint, polling for results).

### Rank 4: Brief TTL extension for inactive customers (saves ~$0.01/day, ~$4/year)

**Current:** 24h TTL for all customers.  
**Fix:** Extend to 48h for customers with no meetings or emails in 7 days.  
**Expected reduction:** ~50% fewer brief regenerations for inactive accounts.  
**Risk:** Low. Inactive accounts have no new data to surface.

### Rank 5: Context caching for brief system prompts (saves ~$0.005/day)

**Current:** System prompts sent inline with every call.  
**Fix:** Use Vertex AI context caching for the brief synthesis and extraction system prompts (they're identical across all customers).  
**Expected reduction:** ~75% input token cost reduction on brief calls.  
**Risk:** Low, but requires minimum 32K tokens cached. Brief prompts may be too small to qualify.  
**Note:** A TODO comment exists in `brief-pipeline.ts:7` referencing this optimization.

### Rank 6: Model downgrade opportunities

| Call Site | Current Model | Could Use | Quality Impact |
|-----------|--------------|-----------|---------------|
| product-release-radar | flash | flash-lite | Low risk -- structured extraction from docs |
| product-feature-extraction | flash | flash-lite | Low risk -- structured JSON extraction |
| customer-product-intel | flash | flash-lite | Medium risk -- cross-referencing requires reasoning |
| account-plan | flash | flash | Already optimal (multimodal + long output) |
| intelligence-company | flash | flash | Already optimal (grounded search required) |
| intelligence-analysis | flash | flash | Already optimal (grounded search required) |

Downgrading release-radar and feature-extraction to flash-lite would save ~$0.02/week. Minimal impact.

---

## 6. Compliance Check

| Requirement | Status | Notes |
|-------------|--------|-------|
| thinkingBudget: 0 on all flash calls | PASS | All 14 call sites set `thinkingConfig: { thinkingBudget: 0 }` |
| Token usage recording (BKL-M52) | PASS | All call sites call `recordGeminiUsage()` |
| Timeout protection | PARTIAL | 8 of 14 sites use `AbortSignal.timeout()`. Missing on: `customer.ts` callLLM, callLLMStructured, `doc-extraction.ts` callGeminiStructured, `dashboard-routes.ts` synthesizeMorningSummary |
| Error handling on API failure | PASS | All sites catch and log errors |
| Model selection via config | PASS | All sites use `getGeminiModel()` or `getGeminiModelLite()` from settings-api.ts |
| No hardcoded API keys | PASS | All use service account JWT or OAuth token |

---

## 7. Call Site Reference Index

Quick lookup for code review:

| File | Line | Function | callType |
|------|------|----------|----------|
| `src/customer.ts` | 473 | `callLLM()` | brief-synthesize |
| `src/customer.ts` | 895 | `callLLMStructured()` | brief-extract |
| `src/customer.ts` | 398 | inline fetch (PDF) | pdf-extract |
| `src/doc-extraction.ts` | 179 | `callGeminiStructured()` | doc-classify |
| `src/dashboard-routes.ts` | 57 | `synthesizeMorningSummary()` | morning-synthesis |
| `src/account-intelligence.ts` | 54 | `callGeminiGrounded()` | intelligence-grounded |
| `src/account-intelligence.ts` | 137 | `callGeminiGroundedStructured()` | intelligence-industry |
| `src/account-intelligence.ts` | 373 | `callGeminiGrounded()` | intelligence-company |
| `src/account-intelligence.ts` | 523 | `callGeminiGrounded()` | intelligence-analysis |
| `src/product-release-radar.ts` | 313 | inline fetch | product-release-radar |
| `src/product-feature-radar.ts` | 343 | inline fetch | product-feature-extraction |
| `src/product-feature-radar.ts` | 579 | inline fetch | product-feature-enrichment |
| `src/customer-product-intel.ts` | 361 | inline fetch | customer-product-intel |
| `src/product-intelligence.ts` | 173 | `callGeminiGroundedRaw()` | product-query |
| `src/account-plan.ts` | 236 | `callGeminiMultimodal()` | account-plan |

---

## 8. API Trigger → Data Flow Map

Each Gemini call site mapped to the HTTP endpoint(s) that trigger it, what it reads, and what it writes.

### 8.1 Brief Pipeline

| Call Site | Triggering API(s) | Reads | Writes |
|-----------|------------------|-------|--------|
| **brief-extract** | `GET /customer/:name/brief` (on-demand, page view) · `POST /api/briefs/pregen-all` (batch) · startup pre-gen (BKL-STARTUP-01) | Drive docs corpus (Google Drive), customer case data, emails/calendar (Google), SF pipeline from `customers.json` | Brief JSON cache in memory (24h TTL) |
| **brief-synthesize** | Same as brief-extract (runs after extract in same pipeline) | Output of brief-extract call | Final brief markdown in response / in-memory cache |
| **doc-classify** | Triggered during brief-extract pipeline, per Drive document | Individual Drive document content (fetched by `doc-extraction.ts`) | Classified doc type + relevance tag, stored in-memory doc cache |
| **pdf-extract** | Same brief pipeline (fallback when local PDF parse fails) | Raw PDF bytes from Drive | Extracted text passed to brief-extract |
| **morning-synthesis** | `GET /api/dashboard` (dashboard page view, 4h cache) | All customers' briefs from memory cache, current date | Morning summary markdown in response |

### 8.2 Account Intelligence

| Call Site | Triggering API(s) | Reads | Writes |
|-----------|------------------|-------|--------|
| **intelligence-industry** | `POST /api/customer/:name/generate-intelligence` (single) · `POST /api/intelligence/generate-all` (batch) | Company name, Gemini Grounding (Google Search) | `industry` + `segment` fields in `customers.json` (permanent cache) |
| **intelligence-company** | Same as intelligence-industry | Company name, Gemini Grounding (Google Search) | Company intelligence docs to Google Drive customer folder (7-day TTL) |
| **intelligence-analysis** | Same as intelligence-industry | Company name, industry from prior step, Gemini Grounding (Google Search) | Industry analysis docs to Google Drive customer folder (7-day TTL) |

*Note: The batch endpoint `POST /api/intelligence/generate-all` queues all customers sequentially. Status polled via `GET /api/intelligence/generate-all/status`.*

### 8.3 Product Intelligence

| Call Site | Triggering API(s) | Reads | Writes |
|-----------|------------------|-------|--------|
| **product-release-radar** | `POST /api/products/:slug/refresh` (manual) · background scheduler (Sunday 6am ET weekly) | RH product documentation pages (fetched via Playwright/Drive) | Product release notes cache `data/cache/product-radar-*.json` (content-hash gated) |
| **product-feature-extraction** | `POST /api/products/:slug/features/refresh` (manual) · `POST /api/products/features/refresh-all` (batch) · background scheduler | Product documentation content (same source as radar) | Feature list `data/cache/product-features-*.json` (content-hash gated) |
| **product-feature-enrichment** | Same as feature-extraction (runs after extraction in pipeline) | Feature list from extraction step | Enriched feature metadata in same `product-features-*.json` cache |
| **customer-product-intel** | `POST /api/products/:slug/intel/:customerSlug/generate` (single) · `POST /api/products/intel/:customerSlug/generate-all` (all products for one customer) · `POST /api/products/intel/generate-all-customers` (batch all) · background scheduler | Customer subscription data from `customers.json`, product features from cache, Drive intelligence docs | `data/cache/product-intel-{productSlug}-{customerSlug}.json` (content-hash gated) |
| **product-query (Q&A)** | `POST /api/products/:slug/ask` or equivalent Q&A endpoint in `customer-routes.ts` | User question text, product context, Gemini Grounding (Google Search) | Response in API reply only (no persistent cache) |

### 8.4 Account Plans

| Call Site | Triggering API(s) | Reads | Writes |
|-----------|------------------|-------|--------|
| **account-plan** | `POST /api/customers/:id/account-plan/generate` (Admin button, manual only) | Customer brief, Drive docs (PDFs included via multimodal), SF pipeline data, RH case history | Account plan document written to customer's Google Drive folder (permanent) |

### 8.5 Background Scheduler Triggers (No HTTP, Time-based)

| Schedule | Call Sites Triggered | Source |
|----------|---------------------|--------|
| Sunday 6am ET (weekly) | product-release-radar, product-feature-extraction, product-feature-enrichment, customer-product-intel (all 106 customers) | `background-scheduler.ts` cron |
| Startup (15s delay) | Checks for missing product summary caches, triggers `refreshAllProducts()` if needed | `background-scheduler.ts` IIFE (BKL-STARTUP-01) |
