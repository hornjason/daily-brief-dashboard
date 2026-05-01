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
The top-level Google Drive folder the user configures during setup. Contains one subfolder per AE, each of which contains one subfolder per customer. Lives in the user's personal Drive or a Drive they own.
_Avoid_: "root folder", "parent folder", "Drive root"

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

## Flagged ambiguities

- "Shared Drive" (Google product name) vs. "L3 shared folder" (our concept): the L3 shared folder lives _in_ a Google Shared Drive, but the terms are not interchangeable. Use "L3 shared folder" for the concept, "Shared Drive" only when referring to the Google Drive product feature.
- "folder" is used for both AE parent folder subfolders and L3 shared folder subfolders — always qualify with the tier (AE folder, customer folder, L3 folder).
