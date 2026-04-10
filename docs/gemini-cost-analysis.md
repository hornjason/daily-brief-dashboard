# Gemini AI Cost Analysis & Call Inventory

**Last updated:** 2026-04-10
**Model tiers live:** `gemini-2.5-flash` (reasoning) + `gemini-2.5-flash-lite` (high-volume)

---

## Overview

DailyBriefDashboard makes Gemini calls across three functional areas:

1. **Brief pipeline** — per-customer, on-demand, Flash-Lite
2. **Account intelligence** — per-customer, one-time bootstrap + manual, Flash
3. **Product intelligence** — per-product (weekly) + customer×product matrix (weekly), Flash / Flash-Lite

The `intelligenceEnabled` flag in `data-sources.json → aiConfig` gates account intelligence and customer-product-intel. It does **not** gate briefs, doc-classify, or morning-synthesis — those always run.

---

## Full Call Inventory

| Call Type | File | Purpose | Trigger | Cache TTL | Model | Scope | Est. Calls/Week |
|-----------|------|---------|---------|-----------|-------|-------|-----------------|
| **brief-extract** | `customer.ts` | Extracts signals from each Drive doc: action items, decisions, pain points, stakeholders, timelines | On-demand (user opens customer page) | 24h | Flash-Lite | Per-customer | ~140 |
| **brief-synthesize** | `customer.ts` | Assembles signals into full customer brief narrative | On-demand (user opens customer page) | 24h | Flash-Lite | Per-customer | ~140 |
| **doc-classify** | `doc-extraction.ts` | Classifies every Drive doc in customer folder — action items, decisions, tech signals, competitive mentions | During brief generation, per-doc | None (runs per-doc each brief cycle) | Flash-Lite | Per-document | ~1,600 ⚠️ |
| **morning-synthesis** | `dashboard-routes.ts` | Portfolio-wide daily briefing: Priority Today, Actions Needed, Watch List | On-demand (user opens dashboard) | 4h | Flash-Lite | Portfolio | ~10 |
| **intelligence-grounded** | `account-intelligence.ts` | Industry/segment identification via Google Search grounding | Admin "Generate All" or bootstrap | Permanent (customers.json) | Flash | Per-customer | ~10/bootstrap |
| **intelligence-company** | `account-intelligence.ts` | Deep PESTLE + SWOT + competitive analysis via grounded search | Same as above | Permanent (Drive cache) | Flash | Per-customer | ~10/bootstrap |
| **intelligence-analysis** | `account-intelligence.ts` | Industry technology landscape analysis via grounded search | Same as above | Permanent (Drive cache) | Flash | Per-customer | ~10/bootstrap |
| **account-plan-generation** | `account-plan.ts` | Full account plan: template + PDF questions + playbook + intel | Manual only (Admin button) | Permanent (Drive) | Flash | Per-customer | On-demand |
| **product-release-radar** | `product-release-radar.ts` | Release notes summary: version, GA date, EOL, bullets | Scheduled weekly (Sun 6am ET) | Content hash | Flash | Per-product | ~7 |
| **product-feature-extraction** | `product-feature-radar.ts` | Structured feature list from slide decks + release notes | Scheduled weekly (Sun 6am ET) | Content hash | Flash-Lite | Per-product | ~7 |
| **product-feature-enrichment** | `product-feature-radar.ts` | Enriches top features with doc URL lookups | Scheduled weekly (if enabled) | Content hash | Flash-Lite | Per-product | ~35 (if on) |
| **customer-product-intel** | `customer-product-intel.ts` | Cross-references product + customer signals → expansion opportunities | Scheduled weekly (Sun 6am ET) | Content hash | Flash | Per-customer × per-product | ~1,000 ⚠️ |
| **product-query / product-qa** | `product-intelligence.ts` | Grounded Q&A for product questions | On-demand (user asks) | None | Flash-Lite | Ad-hoc | User-driven |

---

## Cost Breakdown

**Standard pricing (per 1M tokens):**

| Model | Input | Output |
|-------|-------|--------|
| `gemini-2.5-flash` | $0.30 | $2.50 |
| `gemini-2.5-flash-lite` | $0.10 | $0.40 |
| `gemini-2.5-pro` | $1.25 | $10.00 |

**Weekly estimate (intelligence disabled — current state):**

| Category | Calls/wk | Avg tokens | Model | Cost/wk |
|----------|----------|------------|-------|---------|
| brief-extract + brief-synthesize | 140 | ~4,500 | Lite | ~$0.10 |
| doc-classify | 1,600 | ~6,000 | Lite | ~$2.90 |
| morning-synthesis | 10 | ~3,000 | Lite | ~$0.01 |
| product-release-radar | 7 | ~8,000 | Flash | ~$0.03 |
| product-feature-extraction | 7 | ~8,000 | Lite | ~$0.01 |
| **Total (intelligence off)** | | | | **~$3.05/wk** |

**With intelligence enabled (adds account intel + customer-product-intel):**

| Category | Calls/wk | Avg tokens | Model | Cost/wk |
|----------|----------|------------|-------|---------|
| customer-product-intel | 1,000 | ~10,000 | Flash | ~$3.50 |
| Account intelligence | ~10/bootstrap | ~16,000 | Flash | ~$0.05/mo |
| **Total (intelligence on)** | | | | **~$6.55/wk** |

---

## Recommendations

### P1 — High Impact, Low Risk

**1. Filter doc-classify to recent documents**

Current behavior: every brief generation classifies ALL docs in the customer's Drive folder — up to 50 docs. Most are months or years old and produce no new signals.

Estimated waste: ~1,200 unnecessary calls/week (~$2.20/wk).

Fix: In `doc-extraction.ts`, skip documents not modified in the last 30 days, or cap at the 5 most recently modified. Expected reduction: ~75% of doc-classify calls, saving ~$2/week (~$104/year).

**2. Gate customer-product-intel on subscription match**

Current behavior: runs for every customer × every product weekly, even if the customer has zero subscriptions to that product (result will always be `relevanceScore: NONE`).

Estimated waste: 60-70% of ~1,000 weekly calls are zero-relevance.

Fix: In `customer-product-intel.ts`, skip generation if `customer.subscriptions` contains no matching product. This requires reading `subscriptions` before triggering the Gemini call. Expected reduction: ~600 calls/week, saving ~$2.10/week (~$109/year).

---

### P2 — Medium Impact, Verify First

**3. Verify product-feature-enrichment is disabled**

Check `product-feature-radar.ts` for the `featureEnrichment` flag. If enabled, it adds ~35 calls/week at low cost. Disable unless you see concrete value from the enriched descriptions in the UI.

**4. Verify account intelligence trigger is bootstrap-only**

Confirm `intelligence-company` and `intelligence-analysis` are only triggered by:
- Bootstrap wizard (first-time AE setup)
- Admin "Generate All" button

They should NOT trigger on customer page load or brief generation. Each call is ~16K tokens on Flash at ~$0.05/call. One accidental trigger per customer per day = $1.50/day.

**5. Consider extending brief TTL for low-activity customers**

Current TTL is 24h for all customers. For customers with no meetings or emails in 7 days, extending to 48h would halve brief costs for inactive accounts without any visible UX impact.

---

### P3 — Future Consideration

**6. Batch API for weekly scheduled jobs**

Vertex AI offers 50% discount on batch/async requests. The `product-release-radar`, `product-feature-extraction`, and `customer-product-intel` weekly jobs are good candidates — they're latency-insensitive and high-volume. Implementation would require wrapping calls in the Vertex batch API. Potential saving: ~$1.50/week once intelligence is on.

---

## Current State (2026-04-10)

- `intelligenceEnabled: false` — only briefs, doc-classify, and product radar running
- Flash-Lite routing live for: brief-extract, brief-synthesize, doc-classify, product-qa, morning-synthesis
- Flash retained for: account-intelligence, account-plan, customer-product-intel, product-release-radar
- Cost tracker rates corrected to standard pricing (not batch)
- Weekly cost at current state: ~$3/week

**Biggest wins available:**
1. doc-classify recent-doc filter → saves ~$2/week immediately (P1)
2. customer-product-intel subscription gate → saves ~$2/week when intelligence re-enabled (P1)
3. Combined P1 fixes bring estimated weekly cost from $6.55 → ~$2.55 when intelligence is on
