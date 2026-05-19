---
doc-type: adr
status: active
owner: jason
updated: 2026-05-19
---

# ADR-026: Customer Engagement Playbook — Persistence, Ingestion, and API Architecture

**Status:** Proposed
**Date:** 2026-05-18
**Deciders:** Serena Blackwood (Architect), Jason Horn (Product Owner)
**Relates to:** ADR-024 (Quality Gate), ADR-025 (Enrichment), ADR-020 (Feature Module Registry), ADR-021 (Signal Contract), ADR-010 (Intelligence Dual-Write)

---

## Context

The current meeting prep system (`meeting-prep-routes.ts`) generates throwaway 10-section documents per meeting. Product information is redundantly spread across 4-6 sections. Meeting notes from real conversations are never captured back. Intelligence doesn't compound — every prep starts from scratch.

GitHub Issue #290 exposed the redundancy. A grill session redesigned the output as a persistent, per-customer **engagement playbook** with 8 sections that accumulates intelligence over time. The 8-section structure is decided (see PRD). This ADR covers the four architectural questions: state persistence, meeting note ingestion, derived views, and API surface.

### Constraints

- Single-tenant, single-process Bun server
- File-based persistence (`data/cache/`, `data/config/`) — no database
- Container-local — data lives in mounted volume
- Hybrid inline pattern (ADR-024): Gemini generates narrative, system injects deterministic data
- Quality gate (`validateAndRetry()`) must validate playbook output
- Must not break existing meeting prep, intelligence, or signal stack
- Products must hyperlink to `/dashboard/products/:slug`
- Runs alongside current meeting prep until trusted

---

## Decision

### 1. Playbook State File

**Location:** `data/cache/playbooks/{customer-slug}.json`

**Schema:**

```typescript
interface PlaybookState {
  version: 1                           // Schema version for future migration
  customerSlug: string
  customerName: string
  generatedAt: string                  // ISO 8601
  lastMeetingNoteAt: string | null     // ISO 8601 — when notes last ingested
  qualityScorecard?: QualityScorecard  // From ADR-024 quality gate

  sections: {
    strategicPosition: PlaybookSection
    keyRelationships: PlaybookSection
    currentPriorities: PlaybookSection
    productAlignment: ProductAlignmentSection  // Special: one entry per product
    openActionItems: ActionItemsSection        // Special: tracked list
    engagementHistory: EngagementHistorySection // Special: append-only log
    expansionOpportunities: PlaybookSection
    renewalsAndRisk: PlaybookSection
  }

  // Deterministic data snapshots — injected post-Gemini, NOT LLM-generated
  deterministic: {
    subscriptions: SubscriptionSnapshot[]
    cases: CaseSnapshot[]
    lifecycle: LifecycleSnapshot[]
    teamMembers: AccountTeamMember[]
  }

  // Provenance: which sources contributed to the current state
  sources: PlaybookSource[]
}

interface PlaybookSection {
  content: string           // Markdown — Gemini-generated narrative
  updatedAt: string         // ISO 8601
  sourceNotes: string[]     // Which meeting note IDs contributed
}

interface ProductAlignmentEntry {
  productSlug: string
  displayName: string
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  useCase: string                   // Gemini narrative
  proofPoints: string               // From value maps — deterministic
  whatsNew: string                  // From product summaries — deterministic
  lifecycle: string                 // Version + EOL — deterministic
  featureTalkingPoints: string      // From customer product intel — deterministic
  dashboardLink: string             // /dashboard/products/:slug
}

interface ProductAlignmentSection {
  products: ProductAlignmentEntry[]
  updatedAt: string
  sourceNotes: string[]
}

interface ActionItem {
  id: string                         // nanoid
  text: string
  owner: string                      // From account team or meeting notes
  sourceNoteId: string | null        // Which meeting note created this
  createdAt: string
  completedAt: string | null
  status: 'open' | 'completed'
}

interface ActionItemsSection {
  items: ActionItem[]
  updatedAt: string
}

interface EngagementEntry {
  date: string
  type: 'meeting' | 'campaign' | 'decision' | 'note'
  summary: string                    // 1-2 sentence Gemini summary
  sourceNoteId: string | null
  attendees: string[]
}

interface EngagementHistorySection {
  entries: EngagementEntry[]         // Append-only, newest first
  updatedAt: string
}

interface PlaybookSource {
  type: 'auto-generate' | 'meeting-note' | 'manual-edit'
  sourceId: string                   // Google Doc ID for notes, 'auto' for generation
  ingestedAt: string
  sectionsUpdated: string[]          // Which sections this source touched
}
```

**What is Gemini-generated vs deterministic:**

| Data | Source | Approach |
|------|--------|----------|
| Strategic Position narrative | Gemini | Generated from intel + signals + meeting notes |
| Key Relationships narrative | Gemini | Generated from attendees + account team |
| Current Priorities narrative | Gemini | Generated from latest signals + meeting notes |
| Product use case + confidence | Gemini | Per-product relevance assessment |
| Product proof points | `getValueMap()` | Deterministic — injected post-Gemini |
| Product what's new | `getAllProductSummaries()` | Deterministic — injected post-Gemini |
| Product lifecycle | `readProductLifecycleCache()` | Deterministic — injected post-Gemini |
| Product feature talking points | `getCachedCustomerProductIntel()` | Deterministic — injected post-Gemini |
| Product dashboard links | Template | `/dashboard/products/:slug` |
| Action items | Gemini extraction | Extracted from meeting notes, then tracked as structured data |
| Engagement history entries | Gemini summary | 1-2 sentence summary per note, then stored as structured data |
| Expansion opportunities | Gemini | Generated from existing expansion analysis + feature radar |
| Renewals & Risk | Hybrid | Gemini narrative wrapping deterministic subscription/case data |
| Team members | `getAccountTeam()` | Deterministic |
| Subscriptions snapshot | Sheet cache | Deterministic |
| Cases snapshot | RH cases cache | Deterministic |

**Rationale:** This follows the ADR-010 dual-write pattern (intelligence pipeline) — a single JSON file per customer in `data/cache/`. The `version` field enables schema migration via the startup healer pattern (ARCHITECTURE.md section 6b). The `deterministic` block separates LLM-generated content from ground truth, enabling independent refresh of either side.

### 2. Meeting Note Ingestion

**Flow:**

```
User provides Google Doc link
  → POST /api/customer/:name/playbook/ingest-notes
    → 1. Read Google Doc content via Drive API (docs.get, exportMimeType text/plain)
    → 2. Read existing playbook state from disk
    → 3. Build merge prompt:
         - Current playbook sections (as context)
         - New meeting notes (as input)
         - Structured instructions: "Update sections, don't discard prior context"
    → 4. Call Gemini with merge prompt
    → 5. validateAndRetry() via playbook quality validator
    → 6. Extract action items → append to actionItems list
    → 7. Create engagement history entry
    → 8. Write updated playbook state to disk
    → 9. Record source provenance
    → Return { updated: true, sectionsUpdated: [...], newActionItems: N }
```

**Merge strategy — the fundamental constraint:**

Gemini receives the FULL current playbook state plus the new notes. The prompt instructs:
- **Update, don't append.** If notes contradict prior state, the note wins (it's fresher).
- **Preserve context not mentioned.** If notes say nothing about a section, keep it unchanged.
- **Extract action items explicitly.** Any "we agreed to," "next step," "follow up on" becomes an ActionItem.
- **Attribute changes.** Each updated section records which `sourceNoteId` contributed.

The merge prompt uses a structured XML format (matching the existing brief XML pattern in `customer.ts`) to delineate current state from new input. This is the same pattern that works for brief delta detection (`<last_brief_date>`).

**Why full-state merge, not section-by-section:**

Gemini needs cross-section context. A meeting note might update Strategic Position AND Current Priorities simultaneously. Section-by-section would require N Gemini calls and lose cross-references. One call with full context is both cheaper and higher quality.

**Idempotency:** The `sources` array tracks ingested `sourceId` (Google Doc ID). Re-ingesting the same doc is allowed (user may have updated the doc) but the UI warns "This document was previously ingested on {date}."

### 3. Derived View Pattern — Meeting Prep from Playbook

**Decision:** Meeting prep becomes a read-time projection of the playbook, NOT a separate generation.

```
POST /api/customer/:name/meeting-prep/generate
  → 1. Read playbook state (if exists)
  → 2. If no playbook: fall back to existing meeting-prep-routes.ts (current behavior)
  → 3. If playbook exists:
       a. Filter sections by meeting attendees + agenda
       b. Product Alignment → keep only products relevant to attendees' roles
       c. Action Items → filter to items owned by or relevant to attendees
       d. Engagement History → last 3 entries only
       e. Inject deterministic enrichment tables (ADR-025 builders — reused)
       f. Call Gemini for meeting-specific framing (lightweight — 1-2 paragraphs of "for this meeting, focus on...")
       g. Return formatted prep document
```

**Key design choice:** The ADR-025 enrichment builders (`buildProductAlignmentTable`, `buildSummitAnnouncementsTable`, `buildEnhancedLifecycleTable`, `buildRSSIntelligenceTable`) are reused directly. They are pure sync functions that take data inputs and return markdown. The playbook provides the data; the builders format it identically.

**Fallback behavior:** If no playbook exists for a customer, the existing `meeting-prep-routes.ts` generation path runs unchanged. This enables the side-by-side operation: playbook-enabled customers get the derived view, others get the current throwaway doc. The route checks `existsSync(playbookPath)` as the gate.

### 4. API Surface

**New routes** (in a new `src/playbook-routes.ts` Hono sub-app):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/customer/:name/playbook` | Read current playbook state (full JSON) |
| `POST` | `/api/customer/:name/playbook/generate` | Auto-generate playbook from existing data sources |
| `POST` | `/api/customer/:name/playbook/ingest-notes` | Ingest Google Doc meeting notes into playbook |
| `POST` | `/api/customer/:name/playbook/publish` | Export one-way Google Doc snapshot |
| `GET` | `/api/customer/:name/playbook/history` | List ingested meeting notes (from `sources` array) |
| `PATCH` | `/api/customer/:name/playbook/action-items/:id` | Update action item status (open/completed) |
| `POST` | `/api/playbook/generate-all` | Batch auto-generate playbooks for all customers |

**In-flight guard:** Module-level `Set<string>` (`_playbookInFlight`) — same pattern as account plans and meeting prep. Returns 409 on duplicate.

**Batch generation:** Sequential, not parallel — Gemini rate limits. `generate-all` uses the same pattern as `intelligence/generate-all`: iterates customers, calls the single-customer generator, reports progress via polling endpoint.

### 5. Frontend — Playbook Tab on Customer Detail

**Location:** New tab on `/dashboard/customer/:name` — "Playbook" tab, positioned after Overview.

**Tab contents:**
- 8 collapsible sections matching the playbook structure
- Product Alignment section renders product cards with dashboard links (reuses `ProductIntelSection` component pattern)
- Action Items section has inline checkboxes for status toggle (PATCH to action-items endpoint)
- "Ingest Meeting Notes" button opens a modal with Google Doc URL input
- "Publish to Google Doc" button triggers the publish endpoint
- Last updated timestamp per section
- Quality scorecard badge (from ADR-024)

**Reuse:** The playbook tab does NOT duplicate existing components. Product alignment cards reuse the same value-map / lifecycle rendering as the Products page. The tab is a new composition of existing components with playbook-specific layout.

### 6. Auto-Generation from Existing Sources

**First-run generation** (when no playbook file exists):

```
POST /api/customer/:name/playbook/generate
  → 1. loadCustomerSignals(slug) — full signal stack (ADR-021)
  → 2. getAccountTeam(customer) — team context
  → 3. getCachedCustomerProductIntel(slug, productSlug) — per-product intel
  → 4. getValueMap(productSlug) — proof points per product
  → 5. readProductLifecycleCache() — lifecycle data
  → 6. getAllProductSummaries() — what's new
  → 7. getCachedExpansionOpportunities(slug) — expansion analysis
  → 8. fetchCases(customerSlug) — open support cases
  → 9. Read intelligence cache — existing account intelligence
  → 10. Build Gemini prompt with ALL sources as structured XML
  → 11. Gemini generates narrative sections (1, 2, 3, 4-use-case, 5-empty, 6-from-campaigns, 7, 8)
  → 12. validateAndRetry() with playbook validator
  → 13. Inject deterministic data (product proof points, lifecycle, links, subscriptions, cases)
  → 14. Write playbook state file
  → Return playbook
```

**Section 5 (Action Items) starts empty** on auto-generation — there are no meeting notes to extract from. Section 6 (Engagement History) seeds from existing campaign history and meeting prep history if available.

### 7. Feature Module Registration

The playbook registers as a feature module (ADR-020) with:

```typescript
FeatureModuleRegistry.register({
  name: 'playbook',
  cachePaths: ['playbooks/{slug}.json'],
  driveArtifacts: ['Playbook/'],           // subfolder for published snapshots
  refreshInterval: null,                    // on-demand only, no timer
  scope: 'customer',
  nav: { group: 'actions', label: 'Playbook', icon: 'book' },
  signals: async (slug) => {
    // Contribute playbook signals to the universal stack
    // Action items, engagement history entries become signals
  },
  fetch: async (slug) => readPlaybookState(slug),
  cleanup: async (slug) => deletePlaybookFile(slug),
  syncNow: async (slug) => generatePlaybook(slug),
})
```

**Signal contribution:** The playbook contributes signals back to the stack — open action items and recent engagement entries. This means other consumers (campaigns, briefs) automatically see playbook intelligence without explicit wiring (ADR-021 signal auto-discovery).

---

## Consequences

### Positive

- **Intelligence compounds.** Meeting notes, decisions, and action items accumulate in the playbook instead of being thrown away.
- **Single source of truth.** One playbook file per customer replaces scattered intelligence across multiple cache files for content generation purposes.
- **Derived views are cheap.** Meeting prep reads from the playbook — no redundant Gemini generation of product data that already exists.
- **Existing patterns reused.** File-based cache (ADR-010), quality gate (ADR-024), enrichment builders (ADR-025), signal loader (ADR-021), feature module registry (ADR-020) — all reused as-is.
- **Graceful migration.** Side-by-side with current meeting prep. The `existsSync(playbookPath)` gate means customers without a playbook get the old behavior. No big-bang cutover.
- **Deterministic data stays deterministic.** Product lifecycle, proof points, subscriptions, and cases are never LLM-generated — they are injected from ground truth after Gemini runs. This makes playbook data auditable.

### Negative

- **Full-state merge is the riskiest operation.** Gemini must reliably update sections without losing or contradicting prior context. This requires careful prompt engineering and testing with real meeting notes of varying quality.
- **Playbook file grows over time.** Engagement history and action items are append-only. At 23 customers with biweekly meetings, this is ~1200 entries/year — well within JSON file limits but worth monitoring.
- **Two code paths during transition.** Meeting prep route must check for playbook existence and branch. This is temporary complexity until the playbook is trusted and the old path is removed.

### Neutral

- **No new persistence technology.** Stays within the file-based, single-tenant model. This is a constraint, not a limitation — the app serves one user with 23 customers.
- **No new external integrations.** Google Doc reading for meeting notes uses the existing Drive API client (`driveClient`). Publishing uses the existing Docs API.

---

## Alternatives Considered

### A. Per-section cache files instead of single playbook file

One file per section per customer (e.g., `playbooks/{slug}/strategic-position.json`).

**Rejected because:** Meeting note ingestion needs cross-section context — Gemini must see all sections to decide what to update. Splitting into files means reassembling on every ingest and write-back to multiple files atomically. Single file is simpler, atomic, and the data volume (23 customers, ~50KB per playbook) is trivial.

### B. Append-only event log with materialized view

Store raw meeting notes as events, materialize the playbook view on demand.

**Rejected because:** This is an event-sourcing pattern that adds complexity without benefit in a single-tenant, single-user system. The playbook IS the materialized state. The `sources` provenance array provides auditability without full event sourcing.

### C. Store playbook as Google Doc (source of truth in Drive)

Make the Google Doc the primary store, read from Drive on each access.

**Rejected because:** Drive API latency (500-2000ms per read, per ADR-010 rationale). The dashboard is the source of truth; Google Doc is a portable snapshot. This also matches the ADR-010 pattern where Drive is authoritative for sharing but local JSON is the read cache.

### D. Separate Gemini calls per section during note ingestion

Call Gemini once per section to update only affected sections.

**Rejected because:** Meeting notes affect multiple sections simultaneously. A note saying "Acme is moving to Kubernetes (priority shift) and their VP Engineering was in the meeting (new relationship)" touches sections 1, 2, and 3. Per-section calls lose cross-section coherence and cost 8x in API calls.

---

## Implementation Handoff for Marcus

### New files to create

| File | Purpose |
|------|---------|
| `src/playbook-routes.ts` | Hono sub-app with all 7 routes listed in Section 4 |
| `src/playbook-generator.ts` | Core generation logic: auto-generate from sources, merge with notes |
| `src/playbook-types.ts` | TypeScript interfaces (PlaybookState, sections, action items) |
| `src/quality-validators/playbook-validator.ts` | Quality gate validator (ADR-024 pattern) |
| `dashboard/src/components/tabs/PlaybookTab.tsx` | Customer detail tab component |
| `dashboard/src/components/PlaybookSectionCard.tsx` | Collapsible section renderer |
| `dashboard/src/components/IngestNotesModal.tsx` | Google Doc URL input modal |

### Files to modify

| File | Change |
|------|--------|
| `server.ts` | Mount playbook routes: `app.route('/api', playbookRoutes)` |
| `src/feature-module-registry.ts` | Register playbook module (if not self-registering) |
| `src/meeting-prep-routes.ts` | Add playbook existence check at top of generate handler — if playbook exists, delegate to derived view path |
| `dashboard/src/pages/CustomerDetailPage.tsx` | Add Playbook tab to tab bar |
| `dashboard/src/components/tabs/index.ts` | Export PlaybookTab |

### Patterns to follow

- **Route structure:** Copy `meeting-prep-routes.ts` pattern — Hono sub-app, in-flight guard, cache read/write, Drive publish
- **Quality validator:** Copy `quality-validators/meeting-prep-validator.ts` — check section count, content length, product links, action item structure
- **Enrichment injection:** Reuse `buildProductAlignmentTable()` and siblings from `meeting-prep-enrichment.ts` — they are pure functions, no modification needed
- **Signal contribution:** Follow `src/news-radar.ts` or any feature module with a `signals()` method for the registry pattern
- **Tab component:** Follow `dashboard/src/components/tabs/CampaignsTab.tsx` for tab structure, data fetching, and layout
- **Atomic write:** Use `writeJsonAtomic()` from `src/lib/atomic-write.ts` for all playbook state writes
- **Account team:** Use `getAccountTeam(customer)` and `toPromptContext(team)` for all team references (ARCHITECTURE.md section 20)

### Estimated scope

- **New files:** 7
- **Modified files:** 5
- **Lines of code (estimate):** ~1500-2000 (routes + generator + types + validator + UI components)
- **Risk:** Medium — the Gemini merge prompt for meeting note ingestion needs real-world testing. Auto-generation from existing sources is straightforward (same data assembly as meeting prep). The UI tab is standard composition.

### Quality validator checks (for `playbook-validator.ts`)

| Check | Severity | Criteria |
|-------|----------|----------|
| Section count | required | All 8 sections present and non-empty |
| Strategic Position length | required | >= 200 chars |
| Product Alignment count | required | >= 1 product entry |
| Product dashboard links | required | Every product has `/dashboard/products/:slug` link |
| Action items structure | recommended | Each item has text + owner |
| Team members referenced | recommended | At least AE + ASA names appear |
| No internal data leakage | required | No raw account numbers, sheet IDs, or cache paths in output |
