---
Status: SESSION ARTIFACT | Linked to: BKL-OPS-09 | Expires: point-in-time audit, no ongoing operational value
---

# Gemini AI Audit Report

**Generated:** 2026-04-10 | **Last updated:** 2026-04-12  
**Auditor:** Marcus Webb (Principal Engineer)  
**Scope:** All Gemini API call sites in `src/`  
**Customer count:** ~~106~~ **138 customers across 9 AEs** (updated 2026-04-12)

---

## 1. Summary

| Metric | Value |
|--------|-------|
| Total call sites | 15 |
| Models in use | `gemini-2.5-flash` (standard), `gemini-2.5-flash-lite` (high-volume) |
| thinkingBudget: 0 | All call sites (compliant) |
| Estimated daily cost (briefs only, 24h cache) | ~$0.056/day |
| Live cost 2026-04-12 (137 brief runs + 25 intelligence + expansion opps) | $1.12 |
| Biggest cost driver (one-time run) | `intelligence-company` (output-heavy: 6K output tokens at $2.50/1M) |
| Full 138-customer population run (all features) | ~$13.80 one-time |

**Top 3 cost drivers (full population run):**

1. `customer-product-intel` — ~$6.57 one-time (138 customers × 7 products, cached after)
2. `intelligence-company` + `intelligence-analysis` — ~$4.28 combined (138 customers, 7-day cache)
3. `brief-extract` + `doc-classify` — ~$0.31 per full-population brief cycle

**Key pricing correction (2026-04-12):** Prior estimates used $0.15/$0.60 for flash. Actual rates are $0.30/$2.50 per 1M input/output. This 4× output price difference explains why `intelligence-company` (6K avg output tokens) costs ~$0.016/call — not $0.004 as previously estimated.

---

## 2. Pricing Reference Table

Vertex AI pricing via Google Cloud, as of early 2026. Standard (non-batch) rates:

| Model | Input (per 1M tokens) | Output (per 1M tokens) | Notes |
|-------|----------------------|------------------------|-------|
| `gemini-2.5-flash` | $0.30 | $2.50 | Reasoning model, grounding-capable |
| `gemini-2.5-flash-lite` | $0.10 | $0.40 | High-volume, no reasoning |
| `gemini-2.0-flash` | $0.10 | $0.40 | Previous gen, still available |
| `gemini-2.0-flash-lite` | $0.075 | $0.30 | Previous gen lite |
| `gemini-2.5-pro` | $1.25 | $10.00 | Not in use, allowed in config |

**Note:** Prior version of this doc used $0.15/$0.60 for flash. These were incorrect. Corrected 2026-04-12 based on `gemini-cost-tracker.ts` PRICING constant. The $2.50/1M output rate is why output-heavy calls (intelligence-company, intelligence-analysis) are significantly more expensive than input-heavy ones.

**Batch API discount:** 50% off input and output for asynchronous/batch requests (available on all models).

**Context caching:** Reduces input token cost by ~75% for cached portions. Minimum 32K tokens, 1-hour minimum TTL. Charged at $0.0375/1M tokens/hour (flash) for storage.

---

## 3. Per-Call-Site Audit Table

### 3.1 Brief Pipeline

| # | Call Site | File | Function | Model | Max Output Tokens | thinkingBudget | Schedule | Frequency (138 customers) | Caching | Live Avg Input | Live Avg Output | Est. Cost/Call | Est. Daily Cost |
|---|----------|------|----------|-------|-------------------|----------------|----------|--------------------------|---------|----------------|-----------------|---------------|-----------------|
| 1 | **brief-extract** | `customer.ts:895` | `callLLMStructured()` | flash-lite | 8,192 | 0 | On-demand (page view) + startup pre-gen | ~20/day (24h cache, not all viewed daily) | 24h per customer | 4,839 ¹ | 2,489 ¹ | $0.0015 | $0.030 |
| 2 | **brief-synthesize** | `customer.ts:473` | `callLLM()` | flash-lite | 4,096 | 0 | On-demand (page view) + startup pre-gen | ~20/day (same trigger as extract) | 24h per customer | 2,547 ¹ | 540 ¹ | $0.00047 | $0.009 |
| 3 | **doc-classify** | `doc-extraction.ts:179` | `callGeminiStructured()` | flash-lite | 8,192 | 0 | During brief generation, per document | ~44/day (avg 2.2 docs/customer ¹, ~20 customers/day) | None (per-doc each cycle) | 897 ¹ | 605 ¹ | $0.00033 | $0.015 |
| 4 | **PDF text extraction** | `customer.ts:398` | inline fetch | flash-lite | 4,096 | 0 | During brief generation, per PDF (fallback only) | ~5/day (only when local PDF extraction fails) | None | ~3,000 | ~1,000 | $0.00055 | $0.003 |
| 5 | **morning-synthesis** | `dashboard-routes.ts:57` | `synthesizeMorningSummary()` | flash-lite | 1,024 | 0 | On-demand (dashboard page view) | ~2/day (4h cache) | 4h TTL | ~2,000 | ~500 | $0.00040 | $0.001 |

¹ Derived from live data 2026-04-12: 137 brief-extract calls (663K input / 341K output), 137 brief-synthesize calls (349K input / 74K output), 301 doc-classify calls (270K input / 182K output). Prior estimates assumed 12 docs/customer; live average is 2.2 docs/customer.

**Brief-extract token growth root cause:** `DOC_CONTENT_CAP` was raised from 3,000 → 8,000 chars per doc, and `TOTAL_CONTENT_CAP` from 20,000 → 80,000 chars total. These changes (code: `customer.ts:DOC_CONTENT_CAP`, `customer.ts:TOTAL_CONTENT_CAP`) allow 3-4× more document content per brief, explaining the input token increase on this call. The caps were raised deliberately to improve brief quality. Cap rollback would reduce cost but also reduce brief quality.

### 3.2 Account Intelligence

| # | Call Site | File | Function | Model | Max Output Tokens | thinkingBudget | Schedule | Frequency (138 customers) | Caching | Live Avg Input | Live Avg Output | Est. Cost/Call |
|---|----------|------|----------|-------|-------------------|----------------|----------|--------------------------|---------|----------------|-----------------|---------------|
| 6 | **intelligence-industry** | `account-intelligence.ts:137` | `callGeminiGroundedStructured()` | flash | 8,192 | 0 | Manual trigger / bootstrap | On-demand only | Permanent (customers.json) | ~500 | ~200 | $0.0007 |
| 7 | **intelligence-company** | `account-intelligence.ts:373` | `callGeminiGrounded()` | flash | 8,192 | 0 | Manual trigger / bootstrap | On-demand only | 7-day TTL (configurable) | 1,480 ² | 6,000 ² | $0.0156 |
| 8 | **intelligence-analysis** | `account-intelligence.ts:523` | `callGeminiGrounded()` | flash | 8,192 | 0 | Manual trigger / bootstrap | On-demand only | 7-day TTL (configurable) | ~1,500 | ~6,000 | $0.0156 |

² Derived from live data 2026-04-12: 25 intelligence-company calls (37K input / 150K output / $0.39). Output avg 6,000 tokens at $2.50/1M = $0.015/call output alone.

**intelligence-company output-heavy alert:** At an avg 6,000 output tokens per call vs 1,480 input, this call is 4:1 output-to-input ratio. With $2.50/1M output pricing, output cost alone is $0.015/call — 24× more expensive than input. Total per-call $0.0156 vs prior estimate of $0.0039. A full 138-customer refresh costs $2.15 for this call type alone (excluding grounding). Reducing `maxOutputTokens` from 8,192 to 2,048 would cap output and reduce cost; risk is truncated company intelligence narratives. See backlog BKL-AI-COST-06.

*Note: Calls 6-8 use Google Search grounding (adds ~$5/1000 queries). At 138 customers: 414 grounding queries = ~$2.07 per full population intelligence run.*

### 3.3 Product Intelligence

| # | Call Site | File | Function | Model | Max Output Tokens | thinkingBudget | Schedule | Frequency | Caching | Est. Input Tokens | Est. Output Tokens | Est. Cost/Call |
|---|----------|------|----------|-------|-------------------|----------------|----------|-----------|---------|-------------------|-------------------|---------------|
| 9 | **product-release-radar** | `product-release-radar.ts:313` | inline fetch | flash | 2,048 | 0 | Weekly (Sunday 6am ET) | 7/week (RHEL, OCP, OCP-Virt, AAP, RHEL-AI, RH-AI-Inference, RHOAI) | Content hash (permanent until content changes) | ~6,000 | ~1,000 | $0.0043 |
| 10 | **product-feature-extraction** | `product-feature-radar.ts:343` | inline fetch | flash | 16,384 | 0 | Weekly (Sunday 6am ET) | 7/week | Content hash | ~8,000 | ~4,000 | $0.0124 |
| 11 | **product-feature-enrichment** | `product-feature-radar.ts:579` | inline fetch | flash | 1,024 | 0 | Weekly (after feature extraction) | ~70/week (max 10 features x 7 products) | Content hash | ~3,000 | ~500 | $0.00215 |
| 12 | **customer-product-intel** | `customer-product-intel.ts:361` | inline fetch | flash | 8,192 | 0 | Weekly (Sunday 6am ET) | ~966/week (138 customers x 7 products) | Content hash (permanent until product or customer data changes) | ~6,000 | ~2,000 | $0.0068 |
| 13 | **product-query (Q&A)** | `product-intelligence.ts:173` | `callGeminiGroundedRaw()` | flash-lite | 4,096 | 0 | On-demand (user asks question) | ~2/day (user-driven) | None | ~1,500 | ~1,000 | $0.00055 |

**Product count updated 2026-04-12:** Expanded from 3 (RHEL, OCP, AAP) to 7 products (+ OCP-Virt, RHEL-AI, RH-AI-Inference, RHOAI). This 2.3× product growth multiplies weekly customer-product-intel cost proportionally: from ~318 calls/week to ~966 calls/week.

### 3.4 Expansion Opportunities (NEW — added 2026-04-12)

| # | Call Site | File | Function | Model | Max Output Tokens | thinkingBudget | Schedule | Frequency | Caching | Est. Input Tokens | Est. Output Tokens | Est. Cost/Call |
|---|----------|------|----------|-------|-------------------|----------------|----------|-----------|---------|-------------------|-------------------|---------------|
| 14 | **expansion-opportunities** | `expansion-opportunities.ts:242` | inline fetch | flash | 4,096 | 0 | On-demand (`POST /api/customers/:id/expansion-opportunities`) | ~138/run (one per customer, triggered manually or in batch) | None detected | ~500 | ~500 | ~$0.001 |

*Note: Live data from 2026-04-12 shows $0.002 for 2 calls = ~$0.001/call. Small flash call — inputs are customer profile + product catalog, output is a list of 0-3 opportunities. Full 138-customer run: ~$0.14.*

### 3.5 Account Plans

| # | Call Site | File | Function | Model | Max Output Tokens | thinkingBudget | Schedule | Frequency | Caching | Est. Input Tokens | Est. Output Tokens | Est. Cost/Call |
|---|----------|------|----------|-------|-------------------|----------------|----------|-----------|---------|-------------------|-------------------|---------------|
| 15 | **account-plan** | `account-plan.ts:236` | `callGeminiMultimodal()` | flash | 8,192 | 0 | Manual only (Admin button) | ~2/week | Permanent (Drive) | ~20,000 (includes PDF vision) | ~4,000 | $0.016 |

*Note: Cost/call corrected to $0.016 using $0.30/$2.50 flash pricing. 20K input × $0.30/1M + 4K output × $2.50/1M = $0.006 + $0.010 = $0.016.*

---

## 4. Full Population Cost Estimate

**Updated 2026-04-12:** 138 customers, 7 products, corrected flash pricing ($0.30/$2.50), live-calibrated token averages.

### 4.1 Account Intelligence (generate-intelligence per customer)

Each customer triggers 3 Gemini calls (industry ID, company intel, industry analysis):

| Step | Model | Calls | Input Tokens/Call | Output Tokens/Call | Subtotal |
|------|-------|-------|-------------------|-------------------|----------|
| Industry identification | flash (grounded) | 138 | 500 | 200 | $0.09 |
| Company intelligence | flash (grounded) | 138 | 1,480 | 6,000 | $2.15 |
| Industry analysis | flash (grounded) | 138 | 1,500 | 6,000 | $2.15 |
| Google Search grounding | - | 414 queries | - | - | $2.07 |
| **Subtotal** | | **414 calls** | | | **$6.46** |

*Note: Customers with no Drive folder fail cleanly (skipped, not crashed). ~15-20% skip rate for intelligence calls applies to calls 7-8 only; call 6 (industry ID) still runs. Estimated actual with skip rate: ~$5.50.*

*Root cause: intelligence-company averages 6,000 output tokens at $2.50/1M = $0.015 output cost alone per call. This is the single most expensive per-call operation in the system. (Verified from live data: 25 calls on 2026-04-12 → $0.39 = $0.0156/call average.)*

### 4.2 Product Hub Features Refresh (7 products: RHEL, OCP, OCP-Virt, AAP, RHEL-AI, RH-AI-Inference, RHOAI)

| Step | Model | Calls | Input Tokens/Call | Output Tokens/Call | Subtotal |
|------|-------|-------|-------------------|-------------------|----------|
| Release radar | flash | 7 | 6,000 | 1,000 | $0.030 |
| Feature extraction | flash | 7 | 8,000 | 4,000 | $0.087 |
| Feature enrichment | flash | ~70 | 3,000 | 500 | $0.151 |
| **Subtotal** | | **~84 calls** | | | **$0.268** |

*Product count grew from 3 → 7 between April 2026-04-10 and 2026-04-12 audit. This doubles weekly product hub cost.*

### 4.3 Per-Customer Product Intelligence (138 customers × 7 products)

| Step | Model | Calls | Input Tokens/Call | Output Tokens/Call | Subtotal |
|------|-------|-------|-------------------|-------------------|----------|
| Customer-product intel | flash | 966 | 6,000 | 2,000 | $6.57 |
| **Subtotal** | | **966 calls** | | | **$6.57** |

*Largest single-component cost. 138 × 7 = 966 calls vs prior estimate of 318 (3 products, 106 customers). Cost increased ~10× since prior estimate due to both product count growth (2.3×) and pricing correction (3.2× per call).*

### 4.4 Brief Generation (all 138 customers)

Each customer triggers extract + synthesize + ~2.2 doc-classify calls (live average):

| Step | Model | Calls | Input Tokens/Call | Output Tokens/Call | Subtotal |
|------|-------|-------|-------------------|-------------------|----------|
| Brief extract | flash-lite | 138 | 4,839 | 2,489 | $0.207 |
| Brief synthesize | flash-lite | 138 | 2,547 | 540 | $0.065 |
| Doc classify | flash-lite | ~304 | 897 | 605 | $0.101 |
| PDF extraction (fallback) | flash-lite | ~10 | 3,000 | 1,000 | $0.006 |
| **Subtotal** | | **~590 calls** | | | **$0.379** |

*Note: Prior estimate used 12 docs/customer for doc-classify. Live 2026-04-12 data (301 doc-classify for 137 customers) shows 2.2 avg docs/customer. Actual doc-classify cost is ~4× lower than previously estimated.*

### 4.5 Expansion Opportunities (138 customers)

| Step | Model | Calls | Input Tokens/Call | Output Tokens/Call | Subtotal |
|------|-------|-------|-------------------|-------------------|----------|
| Expansion opportunities | flash | 138 | ~500 | ~500 | $0.138 |
| **Subtotal** | | **138 calls** | | | **$0.138** |

### 4.6 Full Population Total

| Component | Calls | Cost |
|-----------|-------|------|
| Account Intelligence | 414 | $6.46 |
| Product Hub Refresh | 84 | $0.27 |
| Customer-Product Intel | 966 | $6.57 |
| Brief Generation | 590 | $0.38 |
| Expansion Opportunities | 138 | $0.14 |
| **Grand Total** | **~2,192 calls** | **~$13.82** |

With skip rate for no-data customers (~15-20%): **~$11.50 estimated actual cost**.

*If using Batch API (50% discount) for all non-interactive calls (intelligence, product hub, customer-product-intel): ~$8.50.*

**Comparison to prior estimate:** Was ~$3.75 (106 customers, 3 products, wrong flash pricing). Now ~$13.82. Delta explained:
- Intelligence: $2.43 → $6.46 (+$4.03, due to corrected output pricing and 38% more customers)
- Product hub: $0.04 → $0.27 (+$0.23, due to 7 products vs 3 + corrected pricing)
- Customer-product-intel: $0.67 → $6.57 (+$5.90, due to 138×7 vs 106×3 and corrected pricing)
- Brief: $0.61 → $0.38 (-$0.23, fewer doc-classify calls than estimated)

---

## 5. Optimization Recommendations (Ranked by Savings Potential)

*Council analysis completed 2026-04-12. Backlog items BKL-AI-COST-05 through BKL-AI-COST-08 created from these recommendations.*

### Rank 1: customer-product-intel subscription gate — BKL-AI-COST-05 (saves ~$3.95-$4.56/weekly run)

**Current:** Runs for every customer × every product weekly (966 calls/week), even if the customer has zero subscriptions to that product. ~60-70% of calls produce `relevanceScore: NONE`.  
**Fix:** In `customer-product-intel.ts`, skip generation if customer has no matching product subscriptions in their SF bookings data.  
**Expected reduction:** ~580-670 calls/week eliminated at $0.0068/call.  
**Risk:** Low. Zero-relevance results are never displayed.  
**Backlog:** BKL-AI-COST-05

### Rank 2: doc-classify recent-document filter — BKL-AI-COST-04 (DONE infrastructure; enable config)

**Current:** `docClassifyMaxAgeDays` defaults to `0` (unlimited). Admin UI setting already exists (BKL-AI-COST-04, DONE 2026-04-10).  
**Action needed:** Set `docClassifyMaxAgeDays: 30` in Admin AI Settings. No code change required.  
**Expected reduction:** ~75% of doc-classify calls eliminated.  
**Risk:** None.

### Rank 3: intelligence-company output cap reduction — BKL-AI-COST-06 (saves ~$1.05/full-population-run)

**Current:** `maxOutputTokens: 8,192` for intelligence-company. Live avg output: 6,000 tokens at $2.50/1M = $0.015 output cost/call.  
**Fix:** Reduce maxOutputTokens to 2,048. Would cap output cost to $0.005/call.  
**Expected reduction:** ~60% output token reduction, saving ~$1.05 per full 138-customer intelligence run.  
**Risk:** Medium. May truncate detailed company narratives. Requires quality validation before deploying.  
**Backlog:** BKL-AI-COST-06

### Rank 4: Batch API for weekly scheduled jobs — BKL-AI-COST-07 (saves ~50% of cacheable costs)

**Current:** All calls use standard synchronous API.  
**Candidates (latency-insensitive):** `product-release-radar`, `product-feature-extraction`, `product-feature-enrichment`, `customer-product-intel`, `intelligence-company`, `intelligence-analysis`.  
**At 138 customers:** Batch-eligible calls total ~$13.80/run. 50% discount = ~$6.90 saved per full run.  
**Risk:** Medium. Requires Vertex AI Batch API integration (different endpoint, polling for completion, results via GCS bucket).  
**Note:** Implement after BKL-AI-COST-05 (subscription gate) — that reduces call volume first.  
**Backlog:** BKL-AI-COST-07

### Rank 5: Brief TTL extension for inactive customers — BKL-AI-COST-08 (saves ~$0.01/day)

**Current:** 24h TTL for all customers.  
**Fix:** Extend to 48h for customers with no meetings or emails in 7 days.  
**Expected reduction:** ~50% fewer brief regenerations for inactive accounts.  
**Risk:** Low.  
**Backlog:** BKL-AI-COST-08

### Rank 6: Model downgrade opportunities (no formal backlog — evaluate when needed)

| Call Site | Current Model | Could Use | Quality Impact | Annual Savings (138 customers) |
|-----------|--------------|-----------|---------------|-------------------------------|
| product-release-radar | flash | flash-lite | Low risk — structured extraction from docs | ~$0.01/week |
| product-feature-extraction | flash | flash-lite | Low risk — structured JSON extraction | ~$0.06/week |
| customer-product-intel | flash | flash-lite | Medium risk — cross-referencing requires reasoning | ~$3.30/week (but Rank 1 gate is better) |
| expansion-opportunities | flash | flash-lite | Low risk — simple matching logic | ~$0.04/run |
| intelligence-company | flash | flash | Already optimal — grounded search requires flash | — |
| intelligence-analysis | flash | flash | Already optimal — grounded search requires flash | — |

---

## 6. Live Cost Snapshot — 2026-04-12

Full demo day: 137 brief runs (all 138 customers), 25 intelligence-company calls, 301 doc-classify calls, 2 expansion-opportunities calls.

| Call Type | Calls | Input Tokens | Output Tokens | Cost | Notes |
|-----------|-------|-------------|--------------|------|-------|
| brief-extract | 137 | 663K | 341K | $0.20 | All 138 customers (1 used cache) |
| brief-synthesize | 137 | 349K | 74K | $0.065 | — |
| doc-classify | 301 | 270K | 182K | $0.10 | 2.2 docs/customer avg |
| intelligence-company | 25 | 37K | 150K | $0.39 | 25 of 138 customers; rest cached |
| expansion-opportunities | 2 | ~1K | ~1K | $0.002 | Pre-batch; full batch not yet in tracker |
| **Total** | **649** | **~1.32M** | **~748K** | **$1.12** | — |

**Key observations from live data:**
- intelligence-company ($0.39) cost more than all brief calls ($0.265) despite only 25 calls vs 274 brief calls. Confirms output-heavy diagnosis.
- doc-classify: 2.2 docs/customer is far below the 12 docs/customer previously estimated. Prior daily cost estimate ($0.069) was ~14× too high.
- brief-extract input (663K / 137 = 4,839 tokens avg) is 3-4× higher than older estimates (~1,500 tokens) — confirms DOC_CONTENT_CAP and TOTAL_CONTENT_CAP increases drove input growth.

## 7. Compliance Check

| Requirement | Status | Notes |
|-------------|--------|-------|
| thinkingBudget: 0 on all flash calls | PASS | All 14 call sites set `thinkingConfig: { thinkingBudget: 0 }` |
| Token usage recording (BKL-M52) | PASS | All call sites call `recordGeminiUsage()` |
| Timeout protection | PARTIAL | 8 of 14 sites use `AbortSignal.timeout()`. Missing on: `customer.ts` callLLM, callLLMStructured, `doc-extraction.ts` callGeminiStructured, `dashboard-routes.ts` synthesizeMorningSummary |
| Error handling on API failure | PASS | All sites catch and log errors |
| Model selection via config | PASS | All sites use `getGeminiModel()` or `getGeminiModelLite()` from settings-api.ts |
| No hardcoded API keys | PASS | All use service account JWT or OAuth token |

---

## 8. Call Site Reference Index

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
| `src/expansion-opportunities.ts` | 242 | inline fetch | expansion-opportunities |
| `src/account-plan.ts` | 236 | `callGeminiMultimodal()` | account-plan |

---

## 9. API Trigger → Data Flow Map

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

### 9.4 Expansion Opportunities

| Call Site | Triggering API(s) | Reads | Writes |
|-----------|------------------|-------|--------|
| **expansion-opportunities** | `POST /api/customers/:id/expansion-opportunities` (single) · batch endpoint for all customers | Customer intelligence cache, product catalog from `customers.json`, product features | Response only (no persistent cache) |

### 9.5 Background Scheduler Triggers (No HTTP, Time-based)

| Schedule | Call Sites Triggered | Source |
|----------|---------------------|--------|
| Sunday 6am ET (weekly) | product-release-radar, product-feature-extraction, product-feature-enrichment, customer-product-intel (all 138 customers × 7 products) | `background-scheduler.ts` cron |
| Startup (15s delay) | Checks for missing product summary caches, triggers `refreshAllProducts()` if needed | `background-scheduler.ts` IIFE (BKL-STARTUP-01) |
