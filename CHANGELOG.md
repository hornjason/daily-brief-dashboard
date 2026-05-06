---
doc-type: reference
status: active
owner: jason
updated: 2026-05-06
---

# Changelog

All notable changes to DailyBriefDashboard are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

## [1.6.0] — 2026-05-06

### Added
- Bootstrap E2E automated test suite — 18 tests covering full setup flow end-to-end on real data
- East Commercial territory support — AE name parsing, region seed, full test coverage
- GET /api/auth/google/status endpoint for bootstrap E2E pre-flight gate
- GET /api/node-role: exposes { isL3Only } for test and UI conditional rendering
- GET /api/scrapes/cases endpoint for bootstrap-e2e step F
- playwright.e2e.config.ts: new e2e-tier Playwright project targeting port 7776 for bootstrap-e2e
- data-testid attributes on PipelineSection, CloudSpendSection, AccountPortfolioGrid
- docs/E2E-BOOTSTRAP-FLOW.md: bootstrap step flowchart + gap analysis

### Fixed
- 6 P1 bootstrap walkthrough bugs (2026-05-06): Drive folder placement, customer discovery, step error reporting
- BKL-BOOTSTRAP-L3-DATA-GATE-01: re-throw L3 gate errors from catch blocks; fail step 5 when CCSP/Pipeline CSVs missing
- BKL-BOOTSTRAP-CUSTOMER-FOLDER-DEDUP-01: prevent duplicate Drive folders for territory/SF name mismatches
- BKL-BOOTSTRAP-NESTED-FOLDER-01: nested AE Drive folder — parentFolderId vs aeFolderId confusion fixed in l3-bootstrap
- BKL-BOOTSTRAP-CCSP-STUB-01: readCcsp/readPipeline now download real L3 Drive CSVs, not header-only stubs
- Bootstrap wizard: show actual step error detail instead of hardcoded hint
- Territory lookup: East Commercial AEs and accounts now resolve correctly
- Bootstrap: remove wrong RH Portal pre-flight gate from wizard
- CI: 11 unit test failures eliminated — vertex-429 mock leak, scaffold cache path isolation, stale supportable assertion

### Architecture
- BKL-ARCH-BOOTSTRAP-STEPS-01: Extract auto-bootstrap IIFE into BootstrapStep modules (src/bootstrap/steps/)
- BKL-ARCH: run-coordinator + CcspSourceResolver + DocExtractor extractions
- BKL-ARCH: CircuitBreaker + scrape-state module extracted from scraper-manager
- BKL-ARCH: AiConfig + AutomationConfig extracted from settings-api into ai-config.ts
- BKL-ARCH: territory extraction, dead-file cleanup, SettingsCard hardening
- DATA_SOURCES_PATH in bootstrap-orchestrator made dynamic for test isolation
- Bootstrap step 4 (Write Subscriptions Sheet) removed; Drive Folder lock for second AE added

### Security
- Solr escape, sanitizeErr consistency, non-atomic write fixes (BKL-SEC batch)
- RH offline token validation UI for hero nodes
- Drive folder ID validation guards

## [Unreleased]

### Added (2026-05-06)
- BKL-OPS-E2E-MACMINI-01: Mac Mini E2E host backlog item documented (BKL-OPS-E2E-MACMINI-01)
- playwright.e2e.config.ts: new e2e-tier Playwright project targeting port 7776 for bootstrap-e2e.spec.ts
- GET /api/node-role: exposes { isL3Only } for test and UI conditional logic
- GET /api/scrapes/cases: cases endpoint surfaced in scrape-api.ts (tested by bootstrap-e2e step F)
- data-testid attributes on PipelineSection, CloudSpendSection, AccountPortfolioGrid for E2E scoped assertions
- docs/E2E-BOOTSTRAP-FLOW.md: bootstrap step flowchart + gap analysis (source of truth for E2E spec)

### Fixed (2026-05-06)
- BKL-BOOTSTRAP-NESTED-FOLDER-01: nested AE Drive folder bug — populate-data-sheets.ts was passing aeFolderId as parentFolderId to l3-bootstrap, creating a second "AE Name" folder inside the existing AE folder. Fixed: use ctx.parentFolderId ?? aeFolderId.
- BKL-BOOTSTRAP-CCSP-STUB-01: readCcsp and readPipeline were header-only stubs — now download real L3 Drive CSVs (CCSP-{pod}-*.csv and SF-PIPELINE-*.csv) from podBookingsFolderId, filter by territory, write full rows.
- Sheet tab naming: CCSP sheet tab renamed "CCSP Data", Pipeline renamed "Pipeline" at creation time so fetchCCSPData and fetchPipelineData find the correct tabs.
- bootstrap-e2e step L: was asserting opp.oppName; PipelineSection renders opp.accountName — fixed.
- bootstrap-e2e step M: CCSP tile intentionally not rendered on L3-only installs (isL3Only=true); step now skips gracefully via GET /api/node-role rather than failing.

### Added
- BKL-RH-01: Starvation detection in RH batch scraper
- BKL-DRIVE-01: POD subfolder layer in Drive folder hierarchy
- BKL-SUP-03: 4th Supportable extraction pattern for no-th detail pages
- BKL-WIZ-02: Single-AE bootstrap cancel button
- BKL-AI-02: Cap account-plan.ts maxOutputTokens at 8192
- BKL-AI-03: 7-day TTL on account intelligence cache
- BKL-AI-04: No-data gate in intelligence pipeline
- BKL-AI-05: Concurrency cap (5) on generate-all
- Supportable scraper kill switch (SUPPORTABLE_DISABLED flag)
- BKL-OPS-01: CHANGELOG.md and docs/RELEASE.md release management runbook
