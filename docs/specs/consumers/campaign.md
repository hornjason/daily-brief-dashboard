---
doc-type: consumer-spec
status: active
owner: jason
updated: 2026-06-19
---

# Consumer Spec: Campaign

## Overview
Generates personalized Red Hat sales campaign emails for a customer based on a content material (PDF, PPTX, Google Doc/Slides) and customer intelligence signals.

## Source Files
- `src/campaigns-routes.ts` — thin HTTP adapter
- `src/campaign-service.ts` — domain logic (Gemini prompts, signal loading, material extraction)

## Delivery
- **Drive:** Google Doc in customer folder (`Campaigns/` subfolder)
- **UI:** CampaignsPage, CustomerDetailPage campaigns tab

## API Endpoints
- `POST /api/customer/:name/campaigns/generate` — generate campaign
- `GET /api/customer/:name/campaigns` — campaign history
- `GET /api/customer/:name/campaigns/:id/preview` — render HTML preview
- `DELETE /api/customer/:name/campaigns/:id` — delete campaign
- `POST /api/campaigns/extract-material` — extract material content

## Required Sections
Campaign output includes role-specific email templates:
- Executive summary positioning
- Per-role emails (3-5 roles: CTO, VP Eng, DevOps Lead, etc.)
- Each email: subject line, body with evidence chains, call to action

## Quality Validator
`src/quality-validators/campaign-validator.ts` — validates email structure, specificity, no placeholder text.

## TC Compliance
| Requirement | Status |
|---|---|
| @consumer-contract v1.0 | ✅ Both files |
| ensureFresh | ✅ campaign-service.ts |
| templateAll | ✅ campaign-service.ts |
| validateAndRetry | ✅ campaign-service.ts |
| getAccountTeam | ✅ campaign-service.ts |
| Drive delivery | ✅ Google Doc upload |
