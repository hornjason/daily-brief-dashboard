---
doc-type: consumer-spec
status: active
owner: jason
updated: 2026-08-03
---

# Consumer Spec: Account Intelligence

## Overview
Generates AI-powered company and industry intelligence for customers using Google Gemini with search grounding. Produces two documents per customer: Company Intelligence (PESTLE + SWOT analysis, leadership changes, technology landscape, Red Hat product fit) and Industry Analysis (global market structure, technology trends, vendor ecosystem).

## Source Files
- `src/account-intelligence.ts` — full pipeline orchestration (industry identification, company brief generation, industry analysis generation, Drive doc writing)
- `src/quality-validators/intelligence-validator.ts` — validates section completeness and content depth

## Delivery
- **Drive:** Two Google Docs in customer's "Account Intelligence" subfolder:
  - `{CustomerName} - Company Intelligence`
  - `{CustomerName} - Industry Analysis`
- **UI:** CustomerDetailPage "Intelligence" tab (links to Drive docs)

## API Endpoints
- `POST /api/intelligence/:customerName/generate` — trigger pipeline (async)
- `GET /api/intelligence/:customerName/status` — poll job status
- `GET /api/intelligence/generate-all/status` — batch progress tracker
- `POST /api/intelligence/validate-all` — batch validation sweep
- `POST /api/intelligence/:customerName/requeue` — reset job to pending

## Required Sections

### Company Intelligence Document
Required sections per `COMPANY_INTEL_USER_PROMPT`:
- Executive Summary (3-5 sentences)
- Company Overview
- Leadership & Organizational Changes
- PESTLE Analysis (6 subsections)
- SWOT Analysis (4 subsections)
- Competitive Landscape
- Strategic Initiatives & Trigger Events
- Financial Health
- Technology Landscape Assessment
- Whitespace & Opportunity Mapping (4 subsections: RHEL, OpenShift, Ansible, Red Hat AI)
- Recommended Next Steps
- Watchpoints
- Sources

### Industry Analysis Document
Required sections per `INDUSTRY_ANALYSIS_USER_PROMPT`:
- Executive Summary (5-7 sentences)
- Industry Structure Analysis
- Subsegment Technology Landscape
- Value Chain Mapping & Technology Enablement
- Emerging Technology Deep-Dive (6 subsections: Cloud-Native, AI/ML, Automation, IoT, Digital Twins, Cybersecurity)
- Technology Adoption Chain
- IT Vendor Ecosystem
- Strategic Outlook & Recommendations
- Sources

## Quality Validator
`src/quality-validators/intelligence-validator.ts` — checks:
- Required sections present (minimum 12 for company, 8 for industry)
- No empty sections when data exists
- No placeholder text ("TBD", "[Insert]", "TODO", "[UNVERIFIED]")
- Minimum content depth (≥50 words per section)
- Quality score ≥7.0 threshold

## TC Compliance

| Requirement | Status | Evidence |
|---|---|---|
| @consumer-contract v1.0 | ❌ Missing | Contract declaration absent from source file |
| ensureFresh | ⚠️ Partial | Cache TTL check at 1142-1208, but NOT `loadCustomerSignals(slug, name, { ensureFresh: true })` — uses own cache (`readIntelligenceCache`) instead of signal pipeline |
| templateAll | ❌ Not Applicable | Intelligence generation uses direct Gemini prompts (lines 469-479, 656-662) with hardcoded templates — not customer signal templates. This is intentional (generates from grounded search, not existing signals) but means templateAll contract doesn't apply |
| validateAndRetry | ✅ Lines 494-511 | `validateAndRetry()` called with `intelligenceValidator` before caching company brief; retry loop includes formatted feedback |
| getAccountTeam | ⚠️ Indirect | Line 457 reads `customer.ae` only (not full team context); Account Intelligence AI Prompts doc (line 464) may include custom team context but not via `getAccountTeam()` |
| Drive delivery | ✅ Lines 1001-1028 | `writeIntelligenceDocs()` creates/replaces docs in "Account Intelligence" subfolder; URLs returned and cached |
| callGemini | ✅ Lines 182, 200, 482, 665 | All Gemini calls via `callGemini()` wrapper with grounding enabled |
| GROUNDING_RULES import | ❌ Not Used | No import of GROUNDING_RULES — grounding enabled via `grounding: true` flag in callGemini options (lines 193, 488, 672) |

### Notes on Partial Compliance

**ensureFresh:** Intelligence pipeline maintains its own two-tier cache system (company TTL 14d, industry TTL 30d) separate from the main signal pipeline. Lines 1142-1208 implement TTL checks that skip regeneration when cache is fresh. This is architecturally intentional (intelligence is a distinct data source, not derived from customer signals) but violates the consumer contract assumption that all consumers build from shared signal state.

**templateAll:** Not applicable — intelligence doesn't use customer signal templates. Instead it uses hardcoded analytical prompts (`COMPANY_INTEL_SYSTEM_PROMPT`, `INDUSTRY_ANALYSIS_SYSTEM_PROMPT`) that instruct Gemini to perform grounded research. The consumer contract was designed for signal-driven content generation; intelligence is research-driven.

**getAccountTeam:** Currently reads only `customer.ae` (line 457) for the AE name field in Gemini prompts. Full account team context (ASA, SSP, SSA) is not included in the intelligence generation prompts. Consider whether PESTLE/SWOT/Recommended Next Steps sections would benefit from knowing the full account team (e.g., "contact the ASA about OpenShift adoption").

**Contract Misalignment:** This consumer represents a distinct architectural pattern (grounded AI research pipeline) that doesn't fit the signal-template-consumer model the contract was designed for. Consider either:
1. Exempting intelligence from consumer-contract v1.0 via a declared `contractVersion: 'n/a'` with rationale
2. Evolving consumer-contract v2.0 to cover research-driven consumers explicitly
3. Creating a separate `@research-pipeline v1.0` contract for AI-generated intelligence flows
