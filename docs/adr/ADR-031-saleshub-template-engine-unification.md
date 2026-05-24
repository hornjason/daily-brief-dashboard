---
doc-type: adr
status: proposed
owner: jason
updated: 2026-05-23
---

# ADR-031: SalesHub Solution Play Data Flow Through Template Engine

**Date:** 2026-05-23
**References:** ADR-027 (Universal Signal Scoring), ADR-030 (Solution Intelligence Engine), PRINCIPLES.md (Three-Layer Architecture)
**Deciders:** Serena Blackwood (architecture), Rayford (DA)

## Status

Accepted (implemented 2026-05-23)

## Context

### The Problem: 4 of 5 Consumers Bypass the Template Engine

ADR-030 built a correct solution intelligence engine. The data is good. The scoring is right. The filtering works. But **the plumbing violates PRINCIPLES.md** — four of five consumers either bypass `templateAll()` or fail to render the data that flows through it.

Discovered when asking "why don't Google Docs playbooks show solution plays?" The answer: because each consumer wired itself to the data independently, and the Google Docs renderer was never wired at all.

### Specific Violations

**Violation 1 — playbook-generator.ts (lines 457-468):**
Directly imports `getCustomerSolutionContext()` and builds `solutionPlaySnapshots` as a separate data structure stored in `playbook.deterministic.solutionPlays`. This bypasses `templateAll()` entirely. The PlaybookTab React component reads this structured data correctly, but no other consumer has access to it.

**Violation 2 — customer.ts (lines 868-873, 1001-1007):**
The brief pipeline directly imports `templateSalesAlignment()` and appends it after Gemini output. This bypasses `templateAll()` — it calls one template function in isolation instead of getting it from the unified template result. Both the primary three-step pipeline and the fallback path do this.

**Violation 3 — playbook-routes.ts generatePlaybookHTML() (lines 566-688):**
The Google Docs HTML renderer renders 10 sections from `playbook.sections.*` (Gemini-generated content) but has **zero code** to render `playbook.deterministic.solutionPlays`. Solution plays exist in the playbook data structure but are invisible in the HTML export.

**Violation 4 — campaign-service.ts (lines 460-510):**
Calls `loadCustomerSignals()` and passes raw signals to `callGeminiForCampaign()`. Does not call `templateAll()`. Reconstructs its own template signals object manually from registry signals (lines 529-555).

**Violation 5 — meeting-prep-service.ts (lines 763-814):**
Builds its own Gemini prompt by extracting playbook sections directly. No call to `templateAll()`. Solution plays are absent from the meeting prep entirely.

### The Fundamental Constraint

PRINCIPLES.md Layer 3 is explicit: "Consumers are thin — they call `templateAll(signals, team, { format })` and slice." The anti-pattern list is equally explicit: "Building a consumer that assembles its own signal context — use `templateAll()`."

The violations exist because solution plays were added to the system (ADR-030) without retrofitting consumers to use the template engine as the single data path. Each consumer found its own shortcut. The result: data appears in some places and not others, with no systematic way to ensure coverage.

### What Already Works Correctly

- `templateAll()` in `signal-templates.ts` already produces `salesAlignment` and `saleshubContext` sections (lines 592-594)
- `templateAll()` already returns a `sections` object with named fields (lines 657-668)
- The `solution-intelligence-module.ts` correctly emits signals with `solutionPlayId`, `solutionPlayName`, `solutionTdp`, `matchedTechnologies`, `confidence` metadata
- `templateSalesAlignment()` correctly renders TDP/Play mapping from signals
- `templateSalesHubContext()` correctly renders talk tracks, customer wins, and assets
- `templateStrategicOpportunities()` correctly renders the Strategic Opportunities table
- The PlaybookTab React component correctly reads structured `deterministic.solutionPlays` data

The template engine already does the work. The consumers just don't use it.

## Decision

### Principle: Single Data Path Through templateAll()

Every consumer gets solution play data exclusively through `templateAll()`. No consumer imports `getCustomerSolutionContext()` directly. No consumer imports individual template functions. The template engine is the single source of rendered solution play content.

### Change 1: Extend templateAll() Return Type with Structured Solution Play Data

**Current return type:**
```typescript
{
  deterministic: string,        // Rendered markdown
  narrativeContext: string,     // For Gemini
  sections: {                   // Named sections (string | null)
    salesAlignment, productAlignment, cloudMarketplace,
    renewals, cases, techStack, keyRelationships,
    strategicOpportunities, saleshubContext
  }
}
```

**New return type — add `structured` field:**
```typescript
{
  deterministic: string,
  narrativeContext: string,
  sections: { /* unchanged */ },
  structured: {
    solutionPlays: SolutionPlaySnapshot[]   // Full objects for React/HTML rendering
  }
}
```

Where `SolutionPlaySnapshot` is:
```typescript
interface SolutionPlaySnapshot {
  tdp: string
  playName: string
  triggerTechnologies: string[]
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  talkTrack?: string
  customerWins?: string[]
  linkedAssets?: Array<{ name: string; url: string }>
}
```

**Why a new `structured` field instead of extending `sections`:** The `sections` object contains rendered strings (markdown text). The PlaybookTab React component and the Google Docs HTML renderer need full objects — they render their own UI from structured data. Mixing strings and objects in `sections` would break the current contract. A separate `structured` namespace keeps the string contract clean while providing object access where needed.

**How templateAll() populates it:** Inside `templateAll()`, after building all sections, call `getCustomerSolutionContext(customerSlug)` to get the full solution context. Map `activeSolutionPlays` to `SolutionPlaySnapshot[]`. This requires adding `customerSlug` to `TemplateOptions` (or deriving it from signals).

### Change 2: Playbook Generator Uses templateAll() for Solution Plays

Remove the direct `getCustomerSolutionContext()` import from `playbook-generator.ts`. Instead, read `templateResult.structured.solutionPlays` and assign to `playbook.deterministic.solutionPlays`. The playbook generator already calls `templateAll()` at line 197 — it just needs to use the result for solution plays instead of making a separate call.

### Change 3: Brief Pipeline Uses templateAll() for Sales Alignment

Remove the direct `templateSalesAlignment()` imports from `customer.ts` (both the primary pipeline at line 869 and the fallback at line 1002). Instead, the brief pipeline should call `templateAll()` once and use `templateResult.sections.salesAlignment` for appending. If the brief pipeline doesn't already call `templateAll()`, it should — the deterministic sections are exactly what it appends.

### Change 4: Google Docs HTML Renderer Renders Solution Plays

Add a "Solution Plays" section to `generatePlaybookHTML()` in `playbook-routes.ts`. This section renders `playbook.deterministic.solutionPlays` as styled HTML cards — same card pattern used for Product Alignment (confidence badge, detail rows). Insert after section 6 (Product Alignment), before section 7 (Open Action Items).

### Change 5: Campaign Service Calls templateAll()

Replace the manual signal reconstruction in `campaign-service.ts` (lines 529-555) with a `templateAll()` call. Pass the template result's `narrativeContext` to Gemini instead of manually assembling signal strings. The campaign already has `registrySignals` — it just needs to route them through `templateAll()`.

### Change 6: Meeting Prep Service Gets Solution Plays from Playbook

The meeting prep service already reads the customer's playbook. Since Change 2 ensures `playbook.deterministic.solutionPlays` is populated from `templateAll()`, the meeting prep just needs to include solution play data in its Gemini prompt. Add a "Solution Plays" section to the prompt that lists active plays with their talk tracks — the data is already in the playbook it reads.

### Consumer Migration Summary

| Consumer | Current Path | New Path | Change Size |
|----------|-------------|----------|-------------|
| playbook-generator.ts | Direct `getCustomerSolutionContext()` | `templateAll().structured.solutionPlays` | ~15 lines |
| customer.ts (brief) | Direct `templateSalesAlignment()` x2 | `templateAll().sections.salesAlignment` | ~20 lines |
| playbook-routes.ts (HTML) | Nothing (blind) | New `renderSolutionPlays()` helper | ~40 lines |
| campaign-service.ts | Manual signal reconstruction | `templateAll()` call | ~30 lines |
| meeting-prep-service.ts | Playbook sections only | Add solution plays from playbook | ~10 lines |
| signal-templates.ts | No structured output | Add `structured.solutionPlays` | ~20 lines |

**Total estimated change: ~135 lines across 6 files.**

### What Does NOT Change

- **ADR-027 scoring** — no scoring changes
- **ADR-030 solution intelligence engine** — `getCustomerSolutionContext()` stays as-is; it just gets called from `templateAll()` instead of from each consumer
- **solution-intelligence-module.ts** — untouched
- **saleshub-knowledge-loader.ts / saleshub-filters.ts** — untouched
- **PlaybookTab React component** — reads `deterministic.solutionPlays` which is unchanged in shape
- **Signal interface** — no new fields
- **PRINCIPLES.md** — this ADR conforms to it, doesn't change it

## Consequences

**Positive:**

- **Single data path eliminates drift.** When a sixth consumer is added, it calls `templateAll()` and gets solution plays automatically. No per-consumer wiring.
- **Google Docs parity with React.** The HTML renderer gains the same solution play data the PlaybookTab already shows.
- **Brief gets sales alignment correctly.** No more post-hoc appending of isolated template function output.
- **Campaign and meeting prep gain solution play context.** Gemini sees talk tracks, customer wins, and assets — producing richer, more specific content.
- **Conforms to PRINCIPLES.md.** Eliminates all five identified violations of the three-layer architecture.

**Negative:**

- **templateAll() gains a dependency on getCustomerSolutionContext().** The template engine currently operates on signals alone (pure function of signals). Adding `getCustomerSolutionContext()` introduces a file-read dependency. Mitigation: the solution context reads the same caches that modules already read to produce signals — no new I/O sources, just a different read path within the same function.
- **customerSlug must flow into templateAll().** Currently `templateAll()` doesn't know which customer it's rendering for (it works from signals). The `structured` field requires knowing the customer slug to call `getCustomerSolutionContext()`. Mitigation: add `customerSlug` as an optional field in `TemplateOptions`. When absent, `structured` is empty.

**Risks:**

- **Performance.** `getCustomerSolutionContext()` reads multiple cache files. Calling it inside `templateAll()` adds I/O to what was a pure computation. Mitigation: single-user, single-threaded Bun app — these are local file reads measured in microseconds. The playbook generator already calls this function; we're moving the call, not adding one.
- **Breaking the PlaybookTab.** If `playbook.deterministic.solutionPlays` shape changes. Mitigation: the snapshot type is identical — we're changing where the data comes from (templateAll instead of direct call), not what it looks like.

## Alternatives Considered

### Alternative 1: Fix Only the Google Docs Renderer

Just add solution play rendering to `generatePlaybookHTML()` and leave the other consumers alone.

**Rejected because:** This fixes the symptom (missing HTML section) but not the disease (consumers bypassing the template engine). The next feature will drift the same way. The architectural violation remains.

### Alternative 2: Have Each Consumer Call getCustomerSolutionContext() Directly

Give every consumer direct access to the solution context, letting each render as it sees fit.

**Rejected because:** This is the current state and it's exactly what PRINCIPLES.md prohibits. Each consumer would need its own solution play rendering logic, and new consumers would need to remember to add it.

### Alternative 3: Remove Structured Data from templateAll(), Use Markdown Only

Have `templateAll()` render solution plays as markdown in the `deterministic` string, and have all consumers parse markdown back into objects.

**Rejected because:** The PlaybookTab React component needs structured objects (it renders custom cards with confidence badges, collapsible talk tracks, and asset links). Parsing markdown back into objects is fragile and lossy. The `structured` field provides both: markdown for simple consumers (in `deterministic`) and objects for rich consumers (in `structured`).
