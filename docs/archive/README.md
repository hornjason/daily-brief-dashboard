---
Status: SESSION ARTIFACT | Linked to: doc-archive-2026-04-20 | Expires: permanent archive index
---

# docs/archive/

Historical documents that are no longer operationally referenced. Kept for traceability — not for current commands or guidance.

| File | Original purpose | Archived | Why |
|---|---|---|---|
| `TEST-AUDIT.md` | Council audit record + remediation plan | 2026-04-20 | All P0/P1/P2 remediation items completed. Council session logs preserved for traceability. Operational guidance migrated to TESTING-RUNBOOK.md. |
| `TEST-COVERAGE.md` | Coverage reference (~175 tests) | 2026-04-20 | Stale — test count grew to 580+. Superseded by Spec Inventory section in TESTING-RUNBOOK.md. |
| `TEST-COVERAGE-AUDIT.md` | One-time gap audit (2026-04-18) | 2026-04-20 | All gaps tracked in BACKLOG.md. Point-in-time artifact with no ongoing operational value. |

| `ROADMAP.md` | Feature roadmap (~82 items as of 2026-04-01) | 2026-04-20 | Stale; BACKLOG.md is canonical planning source; item count wrong |
| `DATA-FRESHNESS.md` | Data freshness proposal | 2026-04-20 | Status: PROPOSAL from 2026-04-01; never implemented; cache architecture in ADR-013 |
| `EXECUTION-PLAN.md` | Implementation execution plan | 2026-04-20 | Generated 2026-04-01 from stale roadmap; historical planning artifact |
| `ADR-004-testing-strategy.md` | Early testing strategy ADR | 2026-04-20 | Superseded by docs/adr/ADR-004.md; 3-tier model evolved into 5-layer architecture |
| `W3-12-PRODUCT-INTELLIGENCE-HUB.md` | Product Intelligence Hub design | 2026-04-20 | All 3 phases complete; implementation is truth; architecture in ADR-012 |
| `auto-bootstrap-ui-spec.md` | AutoBootstrap UI design spec | 2026-04-20 | Feature shipped; spec superseded by implementation |
| `DESIGN-COUNCIL-W3.md` | W3 binding design standards | 2026-04-20 | Binding constraints extracted to PRINCIPLES.md; council record preserved here |
| `DESIGN-SPEC-SubscriptionTiers.md` | Subscription tier display spec | 2026-04-20 | April 2026 spec, no implementation status, no active backlog link |
| `GEMINI-BRIEF-ARCHITECTURE.md` | Brief pipeline Gemini architecture | 2026-04-20 | "Partially implemented" — dangerous for agents; code is truth; PROJECT-MAP removed |
| `INFORMATION-ARCHITECTURE-V2.md` | IA redesign spec v2 | 2026-04-20 | April 2026 spec, 892 lines, no implementation status |
| `ingestion-flow.md` | Legacy ingestion flow reference | 2026-04-20 | Superseded by ai-ingestion-flow.md (validated 2026-04-19) |
| `SESSION-REPORT-2026-04-18.md` | Session report 2026-04-18 | 2026-04-20 | Self-labeled SESSION ARTIFACT |
| `UNIFIED-REDESIGN-SPEC.md` | Unified redesign spec | 2026-04-20 | April 2026 spec, "no code changes yet", no backlog link |
| `VISUAL-DESIGN-SPEC.md` | Visual design spec v1.0 | 2026-04-20 | April 2026 spec, 942 lines, no implementation status |
| `research-ai-customer-intelligence-2026.md` | AI customer intelligence research | 2026-04-20 | Researcher artifact from April 2026; no ongoing operational value |
| `research-redhat-product-data-apis.md` | Red Hat product data API research | 2026-04-20 | Researcher artifact from April 2026; no ongoing operational value |

| `GEMINI-AUDIT.md` | One-time Gemini API call-site audit (Marcus Webb, 2026-04-10) | 2026-04-21 | Point-in-time audit report; no ongoing operational value |

Do not link to these docs from agent instructions or CLAUDE.md. Use `docs/TESTING-RUNBOOK.md` instead.
