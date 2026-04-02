# Gemini LLM Cost Analysis — Daily Brief Generation

**Date:** April 1, 2026
**Author:** Jason Horn / PAI
**Model:** gemini-2.5-flash-lite (via Vertex AI)
**Use case:** Per-customer intelligence brief generation for Account Solution Architects

---

## Overview

The DailyBriefDashboard generates AI-powered customer intelligence briefs using Google's Gemini LLM via Vertex AI. Each brief synthesizes subscriptions, support cases, meetings, emails, and Drive documents into a structured account summary with talking points and pipeline opportunities.

This document estimates the cost of scaling brief generation to 373 accounts with daily refresh.

---

## How Gemini Is Used

There is a single LLM function (`generateBrief`) that produces a per-customer brief. It is triggered in three ways:

| Trigger | When | Calls |
|---------|------|-------|
| **Startup pre-generation** | Container restart | 1 per customer missing cached brief (rate-limited: 1 every 10s) |
| **On-demand** | User views a customer in the dashboard | 1 per customer, only if cache is missing or stale |
| **Drive watcher invalidation** | Background polling detects a file change | Deletes cached brief; next dashboard visit regenerates |

Briefs are generated once and cached until invalidated. There is no scheduled recurring regeneration.

---

## Token Estimation Per Call

| Component | Estimated Tokens |
|-----------|-----------------|
| **Input** (system prompt + customer data: emails, meetings, cases, subscriptions, doc excerpts) | ~2,500 |
| **Output** (structured brief, capped at 8,192 tokens, typically <900 words) | ~1,000 |
| **Total per call** | ~3,500 |

---

## Model Pricing Comparison

Vertex AI pricing as of April 2026 (per 1M tokens):

| Model | Input | Output | Per-Call Cost |
|-------|-------|--------|---------------|
| **gemini-2.5-flash** (current) | $0.15 | $0.60 | $0.000975 |
| **gemini-2.5-flash-lite** (recommended) | $0.10 | $0.40 | $0.000650 |
| **gemini-2.0-flash-lite** | $0.075 | $0.30 | $0.000488 |

---

## Cost Estimate: 373 Accounts on gemini-2.5-flash-lite

### Base Scenario — 1x Daily Refresh

| | Per Call | Daily (373) | Monthly (30d) | Yearly |
|---|---------|-------------|---------------|--------|
| Input (~2,500 tokens) | $0.00025 | $0.093 | $2.80 | $33.58 |
| Output (~1,000 tokens) | $0.00040 | $0.149 | $4.48 | $53.73 |
| **Total** | **$0.00065** | **$0.24** | **$7.28** | **$87.31** |

### Scaling Scenarios

| Scenario | Daily | Monthly | Yearly |
|----------|-------|---------|--------|
| 1x daily refresh | $0.24 | $7.28 | $87 |
| 1x daily + 10% force refreshes | $0.27 | $8.01 | $96 |
| 2x daily (AM + PM refresh) | $0.48 | $14.56 | $175 |
| 2x daily + Drive invalidations (~50/day) | $0.52 | $15.53 | $186 |

---

## Cost Control Levers

| Lever | How | Impact |
|-------|-----|--------|
| **Model selection** | `GEMINI_MODEL` env var | Switch between flash/flash-lite models |
| **Output cap** | `maxOutputTokens` in `callLLM()` | Currently 8,192; briefs use ~1,000. Lowering to 2,048 adds a safety margin without affecting quality |
| **Caching** | Built-in — briefs regenerate only on cache miss or invalidation | Primary cost control; no cache = 22x more calls on restart |
| **Rate limiting** | Startup pre-gen is 1 call per 10 seconds | Prevents burst spend on restart |
| **Batch API** | Vertex AI offers 50% discount for batch/async requests | Would require code changes but halves cost |

---

## Recommendation

**Use gemini-2.5-flash-lite at $7.28/month for 373 accounts.** This is the newest lite model with strong brief quality at roughly half the cost of the current gemini-2.5-flash. Even at aggressive 2x daily usage with invalidations, cost stays under $16/month.

For comparison:
- Current model (gemini-2.5-flash): ~$10.93/month for 373 accounts
- Cheapest option (gemini-2.0-flash-lite): ~$5.46/month, slightly older model

The cost difference between models is negligible at this scale. Optimize for brief quality over savings.
