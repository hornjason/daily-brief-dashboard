---
doc-type: reference
status: active
owner: jason
updated: 2026-05-02
---

# DailyBriefDashboard Domain Context

The dashboard is a personal AE intelligence tool that aggregates customer data from Google Drive, Salesforce, CCSP (Red Hat's customer portal), and the Red Hat Portal. It runs as a containerized app — either as a standalone hero install or as one of several nodes in a multi-instance deployment.

## Language

### Data tiers

**L4 data**:
Live data scraped directly from source systems (CCSP, Salesforce). Only produced by the primary node. Requires authenticated browser sessions.
_Avoid_: "raw data", "live scrape", "scraped data"

**L3 data** (also: L3 cache):
A Google Drive shared folder that holds a daily snapshot of L4 data (CCSP bookings, SF pipeline). The source of truth for all non-primary nodes. Updated once per day by the L3 sync daemon running on the primary node.
_Avoid_: "shared data", "cached data", "Drive cache"

**L2 data**:
Container-local cache of L3 data, loaded at startup and refreshed on schedule.
_Avoid_: "local cache"

**L1 data**:
In-memory, request-scoped derived data (brief summaries, aggregated views).
_Avoid_: "computed data"

### Nodes and roles

**Hero install**:
The default deployment. `NODE_ROLE` is unset or false. Reads L3 data from the shared Drive folder. Does not perform L4 scrapes.
_Avoid_: "base install", "standard install", "read-only node"

**Primary node**:
A deployment with `NODE_ROLE=primary`. Performs L4 scrapes of CCSP and SF, then syncs results to the L3 shared Drive folder via the L3 sync daemon. Typically the Mac Mini.
_Avoid_: "leader", "main instance", "scraping node"

**L3 sync daemon**:
A lightweight process on the primary node. Runs once per day. Reads L4 data and writes a snapshot to the L3 shared Drive folder so hero installs can read it.
_Avoid_: "sync service", "data sync"

### Drive structure

**AE parent folder**:
The top-level Google Drive folder the user configures during setup. AE folders sit directly under it — there is no region or POD subfolder between the parent and the AE folder. Also contains sibling `Config/` and `Products/` scaffold folders created during bootstrap. Lives in the user's personal Drive or a Drive they own.
_Avoid_: "root folder", "parent folder", "Drive root", "group drive"

**AE folder**:
A subfolder directly under the AE parent folder, named after the AE. Contains 3 data sheets (SF Bookings, CCSP, Pipeline) and one customer folder per customer. No intermediate region or POD subfolder exists between the AE parent folder and the AE folder.
_Avoid_: "AE directory", "rep folder"

**Bootstrap data source**:
Bootstrap reads exclusively from the L3 cache (L3 shared folder). It has no L4 functionality. The L3 sync daemon on the Mac Mini pulls L4 data to L3 every night, so the L3 shared folder always has at least one day of data available. Hero installs always read from L3 — they never trigger or require L4 scrapes. CCSP, pipeline, and SF bookings data are all available immediately after bootstrap completes because L3 is always pre-populated.
_Avoid_: "bootstrap pulls from L4", "needs a scrape to run first", "hero install scrapes Tableau"

**SF bookings sheet** (also: subscription sheet, `subscriptionSheetId`):
The Google Sheet inside the AE folder that holds SF subscription data per customer. Created and populated by the bootstrap pipeline from L3 data. The dashboard reads from `subscriptionSheetId` in `aes.json` to serve `/customer/:name/sheetdata`. The physical sheet may be named "Supportable — {AE Name}" (legacy) or "SF Bookings" — both refer to the same concept. Only `subscriptionSheetId` matters for routing.
_Avoid_: "Supportable sheet" (use "SF bookings sheet"), "subscription sheet" (too generic)

**Bootstrap scaffold**:
Two folders created directly under the AE parent folder during bootstrap: `Config/` (holds backup sheets) and `Products/` (holds one subfolder per product slug, e.g. `openshift/`, `rhel/`). Created by `ensureConfigAndProductsScaffold()`. Idempotent — reused across bootstrap runs.
_Avoid_: "product folders", "config folder" (say "Config/ scaffold folder" to disambiguate)

**Customer folder**:
A subfolder under an AE folder, named after a customer. Contains account documents, notes, and spreadsheets used for account intelligence.
_Avoid_: "account folder", "customer directory"

**L3 shared folder**:
A Google Drive Shared Drive folder, accessible to all deployed instances. Holds CCSP booking sheets and SF pipeline data written by the primary node. Distinct from the AE parent folder.
_Avoid_: "shared Drive", "team folder", "sync folder"

### Customers and accounts

**Customer**:
A named account the AE manages. Has a name, Drive folder, account numbers (for RH Portal), domain, and territory assignment.
_Avoid_: "account", "client", "company"

**AE** (Account Executive):
The Red Hat sales rep who owns a customer relationship. Used to scope Drive folder structure and data access.
_Avoid_: "rep", "salesperson", "user"

**POD**:
A grouping of AEs for SF pipeline and CCSP scraping purposes. Determines which booking sheets are read and which CCSP data is synced.
_Avoid_: "team", "group", "squad"

**Account provenance** (also: `accountProvenance`):
Metadata tracking the source, version, and timestamp for each discovered account number. Enables automatic healing of stale data when logic bugs are fixed — accounts discovered by older code versions are automatically re-discovered on container startup. Manual account numbers carry `discoveredBy: 'manual'` and are never auto-healed.
_Avoid_: "account history", "discovery log", "audit trail"

**Startup healer**:
A function that runs once per container startup, before any scrapes execute. Compares provenance metadata on discovered data against the current app version. Queues re-discovery for any accounts marked with older versions. Manual edits are preserved.
_Avoid_: "version checker", "migration script", "bootstrap repair"

## Relationships

- An **AE** has one subfolder under the **AE parent folder**
- A **Customer** belongs to exactly one **AE** and has exactly one **customer folder**
- The **primary node** writes **L4 data** → **L3 shared folder** via the **L3 sync daemon**
- **Hero installs** read **L3 data** from the **L3 shared folder** (never directly from source systems)
- A **POD** groups multiple **AEs** and maps to a set of **L3 shared folder** subfolders

### Build targets

**Dockerfile.hero** (also: hero install image):
The container image built for hero installs. Contains the full dashboard UI, RH Hydra API scraper, Drive reader, and all scheduling for L3-sourced data. Does NOT contain L4 scrapers (CCSP/Tableau, SF OAuth), browser runtime, or Playwright. Built with `make build`.
_Avoid_: "standard image", "base image", "non-primary image"

**Dockerfile.l4** (also: L4 daemon image):
The container image built for the primary node. Contains only the L4 scrapers (CCSP/Tableau, SF OAuth), browser runtime, and the daily sync script. Does NOT contain the dashboard UI, API server, or RH Hydra scraper. Built with `make build-l4`.
_Avoid_: "sync image", "scraper image", "primary image"

### Drive client module

**Drive client** (`src/lib/drive-client.ts`):
The singleton module that wraps all Google Drive API access. All folder traversal, file listing, and folder creation goes through this module — no caller instantiates `google.drive()` directly for folder operations.
_Avoid_: "Drive wrapper", "Drive helper", "Drive service"

**Folder traversal**:
Recursively walking a Drive folder tree to collect files or spreadsheets. Always includes `supportsAllDrives: true` to cover both personal Drive and Shared Drive (L3 shared folder). Depth is bounded by `maxDepth` option.
_Avoid_: "BFS", "folder walk", "Drive scan"

**Descendant folder search**:
Finding a named folder within a folder tree using exact or fuzzy name matching, up to a configurable depth. Returns the folder ID or null. Used to resolve a customer name to its Drive folder ID.
_Avoid_: "folder lookup", "folder find", "folder search"

### CI gates

**Gate 1** (pre-push):
Local checks that run before `git push` via a pre-push hook. Must complete in <30s to avoid developer friction. Includes unit tests, type check, and hero purity check. Can be bypassed with `QUICK_PUSH=1` (but security linting always runs).
_Avoid_: "Tier 1", "commit gate", "pre-commit"

**Gate 2** (CI):
GitHub Actions checks triggered on push to main or pull request. Includes all Gate 1 checks plus shellcheck, BATS, drift gate, dashboard build, doc audit (warning-only), container image push, and container smoke test. No Playwright E2E — that scope lives exclusively in Gate 4. Budget: <2 minutes. Issue #138.
_Avoid_: "Tier 2", "PR checks", "merge gate"

**Gate 3** (nightly):
Scheduled GitHub Action that runs data assertion tests (<90s budget). Validates data integrity (account counts, POD coverage, required fields) without full E2E overhead. Coordinates with overnight batch via completion signal (lockfile), not fixed time offset.
_Avoid_: "Tier 3", "nightly E2E", "scheduled tests"

**Gate 4** (release):
Triggered on version tag (`v*`). The only gate that runs the full E2E suite, wizard E2E, Quinn-style GUI visual review, and hero install fresh-install flow. Also includes container build, GHCR push, smoke test on published image, and bootstrap E2E on Mac Mini. Requires manual approval via GitHub environment protection.
_Avoid_: "Tier 4", "deploy gate", "release checks"

**Test tier** (Playwright taxonomy):
Classification of test *type* — distinct from CI gates (which describe *when* tests run). Playwright projects: `integration-tier`, `e2e-tier`, `api-tier`, `smoke`. Unit tests run via `bun test`, not Playwright.
_Avoid_: confusing "test tier" (what kind) with "CI gate" (when it runs)

**Gate-to-project mapping:**
- Gate 1 (pre-push): `bun test test/unit/`, `tsc --noEmit`, `tsc --noEmit --project tsconfig.hero.json` — no Playwright
- Gate 2 (CI): shellcheck + BATS + drift gate + unit tests + tsc + dashboard build + doc audit (warn) + container push + smoke — no Playwright
- Gate 3 (nightly): data assertion scripts against Mac Mini production (7777) — no Playwright, <90s
- Gate 4 (release): Playwright `ci` + `wizard-e2e` + `smoke` projects, container build + GHCR push, bootstrap E2E

### Feature modules

**Feature module**:
A self-contained unit of functionality that registers with the Feature Module Registry. Declares its cache paths, Drive artifacts, NotebookLM sources, refresh interval, cleanup handler, and Sync Now endpoint. The registry manages lifecycle; the module owns business logic.
_Avoid_: "plugin", "extension", "add-on"

**Feature Module Registry**:
A central TypeScript registry (modeled after ScraperRegistry) that manages lifecycle for all registered feature modules: refresh scheduling, customer archive cleanup, Sync Now endpoint exposure, and status reporting. See ADR-020.
_Avoid_: "module manager", "feature manager", "plugin system"

**Feature module contract**:
The `FeatureModule` TypeScript interface that every feature module implements: `cachePaths`, `driveArtifacts`, `notebookSources`, `refreshInterval`, `fetch()`, `cleanup()`, `syncNow()`. TypeScript enforces completeness at compile time.
_Avoid_: "feature interface", "module spec"

### Account detail tabs

**Overview tab**:
The default tab on the account detail page. Contains all existing sections (brief, product intel, cloud spend, pipeline, activity timeline, contacts, subscriptions, cases, etc.) unchanged from the pre-tab layout.
_Avoid_: "main tab", "summary tab", "home tab"

**Campaigns tab**:
Account-level email campaign management. Create campaigns (via ContentCampaign skill), track campaign history, manage AE style guide. Output docs persist to the customer's Drive folder.
_Avoid_: "outreach tab", "email tab"

**News tab**:
Customer news radar. Daily Gemini-scored news articles about the customer, with summaries and source links. Significance threshold filters noise; high-scoring stories also surface in the morning brief.
_Avoid_: "intelligence tab", "signals tab", "radar tab"

**Tools tab**:
Smart link launcher for internal Red Hat business value tools (PitchBuilder+, FinListics CBV, CBVS). Pre-fills customer name and account numbers. Includes upload artifact action to save tool outputs to the customer's Drive intelligence folder and sync to NotebookLM.
_Avoid_: "utilities tab", "resources tab"

### News radar

**News provider**:
An interface (`NewsProvider`) that abstracts the news data source behind `searchNews(customerName: string): NewsItem[]`. Concrete implementations can be swapped without changing the feature module. Initial implementation uses Gemini grounded search.
_Avoid_: "news API", "news source", "search provider"

**Significance score**:
A 1-10 Gemini-assigned score indicating how newsworthy an article is for a specific customer. Threshold-based: 7+ surfaces in the morning brief, 3+ appears on the News tab. Threshold is configurable per customer.
_Avoid_: "relevance score" (relevance is binary — significant captures both relevance and importance)

### NotebookLM sync

**Notebook link**:
The association between a customer and a specific NotebookLM notebook (`notebookUrl` on the customer object). Can be auto-discovered by searching the user's accessible notebooks by customer name, manually selected via a picker, or created fresh.
_Avoid_: "notebook assignment", "notebook mapping"

**Drive-notebook sync**:
A hash-based diff process that compares files in the customer's Drive folder against the notebook's current sources. Adds/removes sources to keep them in sync. Runs on the heartbeat tick and on any action that writes to Drive. Manual Sync Now available.
_Avoid_: "notebook push", "source sync", "notebook refresh"

### Batch operations

**Batch Operations page**:
A top-level dashboard page (`/dashboard/batch`) for running feature module actions across multiple customers at once. Supports automated actions (campaigns, news refresh — sequential Gemini calls with progress tracking) and manual checklists (PitchBuilder, FinListics — tracked launch links with localStorage persistence).
_Avoid_: "bulk operations", "mass actions", "admin batch"

**Campaign configurator**:
A shared UI component used on both the Campaigns tab (single customer) and the Batch Operations page (multiple customers). Extracts material content via Gemini, presents editable defaults (personas, style guide, value props), then feeds the confirmed configuration into campaign generation. Extraction results are cached by URL hash with a "Re-analyze" override.
_Avoid_: "campaign wizard", "campaign builder", "campaign editor"

**Material extraction cache**:
Cached decomposition of a Google Doc/Slides URL into structured data (value props, personas, use cases). Keyed by URL hash at `data/cache/material-extractions/{urlHash}.json`. Avoids re-analyzing the same material on repeated campaign runs. Cleared manually via "Re-analyze" button.
_Avoid_: "content cache", "extraction cache"

### AE voice detection

**AE voice profile**:
A cached writing style analysis for an Account Executive, detected from their sent email history via Gemini. Contains characteristics (tone, formality, vocabulary), a prompt instruction for AI generation, and an example email. Cached to the AE's Drive folder (`Config/style-guide.json`) and locally (`data/cache/style-guides/{ae-slug}.json`). Falls back to skill voice files at `~/.claude/skills/ContentCampaign/voices/{slug}.md`.
_Avoid_: "writing style", "tone profile", "brand voice"

**Voice fallback chain**:
The priority order for loading an AE's voice: (1) local cache, (2) Drive cache, (3) skill voice `.md` files, (4) auto-detect from emails, (5) default generic voice. Once detected, cached at levels 1 and 2 for instant loading.
_Avoid_: "style detection", "voice lookup"

### Campaign generation

**Council-validated email rules**:
11 mandatory rules for generated emails, validated through a multi-agent council debate. Enforced in the Gemini prompt. Includes word limits (90 exec / 200-250 mgr), no firmographic facts, statements only, per-bullet product links, named peer proof, forward-worthy test, competitor-swap test, creepy line check, subject-as-observation, no filler, relationship context. Users can edit rules per campaign via the Style Guide advanced toggle.
_Avoid_: "email guidelines", "writing rules"

**Pre-flight intelligence**:
Before generating a campaign, the system checks that intelligence brief and account plan exist and are fresh (<7 days). Missing or stale data triggers automatic generation before the campaign runs. Ensures every campaign has complete context regardless of prior setup state.
_Avoid_: "data check", "prerequisite check"

**Signal**:
A single piece of customer intelligence contributed by a feature module or legacy cache source. Flat shape: `source`, `type`, `headline`, `detail`, `timestamp`, optional `score` (0-1 normalized), optional `url`, optional `metadata` bag for per-type extras. Consumed by all content generation features via `loadCustomerSignals()`.
_Avoid_: "data point", "insight", "intel item"

**Signal type** (also: `SignalType`):
A string literal classifying what kind of intelligence a signal represents. 13 canonical types: `news`, `intelligence`, `expansion`, `subscription`, `case`, `email`, `meeting`, `product-release`, `event`, `product-intel`, `account-plan`, `competitive`, `brief`. New types are added to the union when a new data source ships.
_Avoid_: "signal category", "signal kind"

**Universal signal stack**:
The complete set of signals collected for a customer across all registered feature modules and legacy cache sources. Collected by `loadCustomerSignals()` in `signal-loader.ts`, which calls `collectAllSignals()` on the registry then fills gaps from legacy cache files. Every content generation feature (campaigns, briefs, account plans, meeting prep) consumes the same stack.
_Avoid_: "data sources", "signal sources" (use "signal stack" as the canonical term)

**Signal auto-discovery**:
The pattern where new data sources automatically contribute to all content generation features by implementing `signals()` on their feature module. No wiring needed in consumers — the registry collects from all modules that implement the method. See ADR-021.
_Avoid_: "signal registration", "signal wiring"

### Navigation

**Page nav** (also: page-level navigation):
The sidebar navigates between discrete pages (routes), not scroll positions within a single page. Each top-level concern gets its own route. The prior scroll-to pattern was replaced because feature density made the single-page layout unmanageable.
_Avoid_: "scroll nav", "section nav", "anchor nav"

**Core page**:
A page that exists regardless of which feature modules are registered: Home, Accounts, Calendar, Admin. Hardcoded in the sidebar. These represent structural concerns, not optional capabilities.
_Avoid_: "built-in page", "system page"

**Module page**:
A top-level sidebar page auto-discovered from the Feature Module Registry. Every feature module that declares `nav` on its contract gets a sidebar entry and a route. Customer-scoped modules include a customer picker on their page. The sidebar is a capability menu — users see everything the system can do without drilling into accounts first.
_Avoid_: "feature page", "plugin page"

**Feature-first navigation**:
The primary discovery path is sidebar → feature → select customer, not sidebar → customer → discover feature in tabs. Every module gets a top-level page so capabilities are immediately visible. Account detail tabs remain as a secondary convenience path (same components, pre-filtered to that customer).
_Avoid_: "customer-first nav"

**Sidebar group**:
A collapsible section in the sidebar that organizes module pages by purpose. Two groups: `actions` (things you do — Meeting Prep, Campaigns, Tools) and `intelligence` (things you learn — News, Products, Events). Core pages (Home, Accounts, Calendar, Book of Business, Admin) sit outside groups. Modules declare their group in the `nav` contract field; the sidebar auto-discovers and renders them under the right heading.
_Avoid_: "nav section", "sidebar category"

**Module scope**:
Each feature module declares its operating scope: `portfolio` (operates across all customers — e.g., News, Products), `customer` (operates on one customer at a time — e.g., Meeting Prep), or `both` (has portfolio and per-customer views — e.g., Campaigns). Scope determines whether the module page includes a customer picker and whether it also appears as an account detail tab.
_Avoid_: "module type", "feature scope"

**Home page**:
The daily starting point. Contains Morning Summary, Top Actions Panel, and KPI Cards only — designed to be read in 30 seconds with no scrolling past the fold. Pipeline detail, Cloud Spend detail, Calendar, and Account grid live on their own pages.
_Avoid_: "dashboard", "landing page" (too generic — say "Home page")

**Book of Business page** (also: portfolio overview):
A dedicated page showing Pipeline and Cloud Spend breakdowns — the detailed per-stage, per-product views that were previously collapsed sections on the Home page. Represents the AE's full book of business. KPI cards on the Home page still show the headline numbers; this page has the drill-down.
_Avoid_: "pipeline page", "cloud spend page" (it's one combined portfolio view)

**Intelligence tab** (composite):
A single account detail tab that aggregates content from multiple modules: `news-radar` (customer news articles), `product-lifecycle` (product roadmap), and `rh-events` (Red Hat events). Not a module itself — it's a composite view. Each contributing module has its own sidebar page for portfolio-level access; the Intelligence tab is the customer-scoped summary. The Overview tab remains the default.
_Avoid_: "intelligence module", "intel tab"

**CustomerPicker** (shared component):
A standardized searchable dropdown at the top of every customer-scoped module page. Shows accounts grouped by AE. Carries customer context when navigating between module pages and account detail tabs — selecting Acme on one module page pre-selects Acme on the next. URL includes customer slug for bookmarkability (e.g., `/dashboard/meeting-prep?customer=acme-corp`). For `scope: 'both'` modules, defaults to portfolio view with the picker acting as a filter.
_Avoid_: "customer selector", "account dropdown"

**ModulePageShell** (shared layout):
A standardized page wrapper that every module page renders inside. Provides consistent layout: page title, CustomerPicker (for customer/both scope), loading/empty/error states, and content area. Ensures every module page looks, feels, and behaves identically. Modules supply their content component; the shell handles all chrome.
_Avoid_: "page template", "page layout"

### Design principles

**Contract-driven standardization**:
Every module declares its full presence — data lifecycle, signals, navigation, tabs, scope — in a single `FeatureModule` registration. The system auto-discovers everything from the contract. No manual wiring, no special-casing, no per-module layout code. Adding a new feature = one file implementing the contract. UI components (`ModulePageShell`, `CustomerPicker`, tab bar) are shared and identical across all modules.

**Desktop-only**:
The dashboard targets desktop browsers only. Mobile/tablet responsiveness is a future item — the app runs on a local container, so mobile access requires network access to the host. No responsive breakpoints or mobile layouts in current scope.

**Visual design pass**:
Part of the nav architecture work — Aditi reviews colors, typography, spacing, and component consistency to ensure enterprise-grade visual quality across all module pages and shared components.

## Flagged ambiguities

- "Shared Drive" (Google product name) vs. "L3 shared folder" (our concept): the L3 shared folder lives _in_ a Google Shared Drive, but the terms are not interchangeable. Use "L3 shared folder" for the concept, "Shared Drive" only when referring to the Google Drive product feature.
- "folder" is used for both AE parent folder subfolders and L3 shared folder subfolders — always qualify with the tier (AE folder, customer folder, L3 folder).
