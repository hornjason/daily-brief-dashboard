---
doc-type: consumer-spec
status: active
owner: jason
updated: 2026-06-19
---

# Consumer Spec: Customer Detail

## Overview
Generates the full customer intelligence view including AI brief, account intelligence, account plan, and aggregated signal data. The primary "deep dive" consumer for a single customer.

## Source Files
- `src/customer.ts` — all consumer logic (brief generation, intelligence aggregation, signal loading)

## Delivery
- **UI:** CustomerDetailPage — brief tab, intelligence tab, account plan tab, cases, subscriptions, emails, meetings

## API Endpoints
- `GET /api/customer/:name` — full customer data with signals
- `GET /api/customer/:name/brief` — AI brief (4h cache)
- `GET /api/customer/:name/intelligence` — account intelligence
- `POST /api/customer/:name/intelligence/generate` — manual trigger
- `GET /api/customer/:name/account-plan` — account plan markdown
- `POST /api/customer/:name/account-plan/generate` — trigger generation

## Required Sections
Customer detail aggregates across all signal sources:
- Brief (priority action, what changed, next steps, talking points)
- Intelligence (company context, industry analysis, competitive landscape)
- Account plan (strategic goals, key initiatives, Red Hat alignment)
- Signal stack (all scored signals from all modules)

## Quality Validator
- Brief: `src/quality-validators/brief-validator.ts`
- Intelligence: `src/quality-validators/intelligence-validator.ts`
- Account plan: `src/quality-validators/account-plan-validator.ts`

## TC Compliance
| Requirement | Status |
|---|---|
| @consumer-contract v1.0 | ✅ |
| ensureFresh | ✅ |
| templateAll | ✅ |
| validateAndRetry | ✅ |
| getAccountTeam | ✅ |
| Drive delivery | N/A (ui-only) |
