---
doc-type: reference
status: active
owner: jason
updated: 2026-05-06
---

# Changelog

All notable changes to DailyBriefDashboard are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

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
