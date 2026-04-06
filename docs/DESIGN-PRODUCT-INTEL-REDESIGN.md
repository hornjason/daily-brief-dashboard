# Product Intelligence Page Redesign

**Author:** Aditi Sharma, UX/UI Design
**Date:** 2026-04-05
**Status:** PROPOSAL - Awaiting Jason's selection
**Scope:** Complete layout redesign of the Products page for scan-first intelligence browsing

---

## The Problem (Precisely)

The current Products page is structured as 3 stacked product sections, each containing its own status tabs, version dropdown, search box, and 2-column card grid. For RHEL alone (29 features), this produces ~800px of vertical content. With OpenShift (17) and AAP (10), the full page is 2000-2500px of scrollable feature cards.

This layout works for "I want to read about RHEL features." It fails for the actual use case: **"I have 5 minutes before a customer meeting. What should I know across all products?"**

The core failure is that the page is organized by product, but the SA's mental model is organized by **urgency and relevance**: what's new, what's in tech preview, what changed. Product is a secondary axis, not the primary one.

---

## Research: What Makes Scanning Work

I studied five reference interfaces to identify the core pattern that enables rapid scanning of feature-dense surfaces:

### 1. Linear Changelog
- **Pattern:** Reverse-chronological stream of entries, each a single dense row with inline metadata (date, category tag, one-line summary)
- **Why it works:** Time is the primary axis. You scroll until you hit content you've already seen. No decisions required.
- **Lesson for us:** Temporal ordering eliminates "where do I start?" paralysis.

### 2. Notion Database List View
- **Pattern:** Clean single-line rows with inline property pills (status, date, tags). Grouping by any property. Filters as pills above the list.
- **Why it works:** Every item is one scan line. Your eye moves vertically through names, and metadata is peripheral. Grouping creates visual sections without needing separate pages.
- **Lesson for us:** One line per feature with inline metadata is the density sweet spot.

### 3. Vercel Changelog
- **Pattern:** Timeline with date headers, each entry has a type badge + title + 1-2 sentence summary. Expandable for details.
- **Why it works:** Type badges (Feature, Fix, Improvement) create a scannable color channel down the left edge. You can skip entire entries by badge color.
- **Lesson for us:** Status badges as a left-edge color channel enable peripheral-vision filtering.

### 4. Stripe API Changelog
- **Pattern:** Dense list with date + API version + one-line description. Click to expand. Filterable by API version.
- **Why it works:** Extreme information density. Each entry is one line. Expansion is optional. You can scan 50 changes in the time it takes to read 5 cards.
- **Lesson for us:** The card format is the enemy of scanning. Dense rows beat cards for "what's new" workflows.

### 5. Figma "What's New"
- **Pattern:** Two-tier approach: marketing "hero" blocks for major features, then a dense changelog list for everything else.
- **Why it works:** The two tiers serve two audiences. The hero blocks catch the eye for the 3-4 big items. The list handles the long tail.
- **Lesson for us:** A "spotlight" zone for high-signal items + a dense list for everything else is the right two-tier structure.

### The Core Pattern

Every excellent scanning interface shares this structure:

```
[Global filters as pills]
[Spotlight / hero zone for 3-5 highest-signal items]
[Dense list of everything else, grouped, with inline metadata]
```

The current Products page has **none** of these. It has no global filters, no spotlight, and cards instead of dense rows.

---

## Proposed Redesign: Three Options

All three options share these common elements:
- **Global filter bar** at the top (cross-product, replaces per-section filters)
- **Unified feature list** (all 56 features in one surface, product as a metadata dimension)
- **Dark theme** using existing tokens (accent=#58A6FF, surface, border, text-primary/secondary)
- **1440px target width**

---

### OPTION A: "The Unified Stream" (My Recommendation)

**Core concept:** A single, dense, scannable list of all features across all products, grouped by recency/status, with a compact spotlight strip at the top for the highest-signal items.

```
+------------------------------------------------------------------+
|  Product Intelligence                                    [Refresh] |
+------------------------------------------------------------------+
|                                                                    |
|  FILTER BAR:                                                       |
|  [All] [RHEL] [OCP] [AAP]    [All] [GA] [Tech Preview] [Roadmap]  |
|  [Search...........................] [Version: v ▼]                 |
|  Active tags: [security x] [networking x]                          |
|                                                                    |
+------------------------------------------------------------------+
|                                                                    |
|  SPOTLIGHT STRIP (horizontal scroll, 3-5 cards):                   |
|  +------------------+ +------------------+ +------------------+    |
|  | [NEW] [TP]       | | [NEW] [GA]       | | [NEW] [TP]       |   |
|  | Image Mode       | | RHEL 10 Crypto   | | OCP Virt Live    |   |
|  | OCP 4.21         | | RHEL 10.1        | | Migration        |   |
|  | 1-line summary   | | 1-line summary   | | OCP 4.21         |   |
|  +------------------+ +------------------+ +------------------+    |
|                                                                    |
+------------------------------------------------------------------+
|                                                                    |
|  FEATURE LIST (grouped by product, dense rows):                    |
|                                                                    |
|  RHEL  (29 features, 6 Tech Preview)                    [expand]   |
|  ----------------------------------------------------------------  |
|  [NEW][TP] Stratis Storage Manager      v10.1  [storage]    [->]   |
|  [NEW][GA] Podman 5.0 Container Tools   v10.1  [containers] [->]   |
|       [GA] FIPS 140-3 Compliance        v10.0  [security]   [->]   |
|       [GA] System Roles Enhancements    v10.0  [automation]  [->]   |
|       [TP] eBPF Networking Stack        v10.0  [kernel]      [->]   |
|       ... (click "show all 29" or scroll)                          |
|                                                                    |
|  OpenShift  (17 features, 2 Tech Preview)               [expand]   |
|  ----------------------------------------------------------------  |
|  [NEW][GA] OCP Virt Live Migration      v4.21  [virt]       [->]   |
|       [GA] Multi-cluster Observability  v4.21  [hybrid]     [->]   |
|       [TP] Dev Spaces Air-gapped        v4.21  [dev-tools]  [->]   |
|       ...                                                          |
|                                                                    |
|  AAP  (10 features, 2 Tech Preview)                     [expand]   |
|  ----------------------------------------------------------------  |
|  [NEW][GA] Lightspeed GA               v2.6   [ai]         [->]   |
|       [GA] EDA Controller 2.0          v2.6   [automation]  [->]   |
|       ...                                                          |
|                                                                    |
+------------------------------------------------------------------+
```

**Interaction model:**
- Filter bar is global: product pills, status pills, search, version dropdown, and active tag pills all filter the entire list simultaneously
- Spotlight strip shows the 3-5 features with highest signal (New + Tech Preview, or New + highest tag relevance). Auto-calculated, not curated.
- Feature list rows are dense: status badge + name + version + primary tag + arrow. One line per feature.
- Clicking a row opens a **slide-over detail panel** on the right (400px wide) with the full description, all tags, confidence indicator, source icon, and Learn More link. The list stays visible and scrollable behind it.
- Each product group shows top 8 features by default, expandable to show all
- Tech Preview rows have a subtle left-edge amber accent (2px), same principle as the current card but applied to a row
- "New" badge (blue pill) appears on features extracted within last 30 days

**Why this is the right choice:**
- 56 features in dense rows fits in ~800px of vertical space (vs 2500px today)
- Cross-product scanning is instant: you see RHEL, OCP, and AAP in one scroll
- The spotlight strip answers "what's most important right now?" without any clicking
- Filters are global and composable: "Tech Preview" + "security" shows security-related tech previews across all products
- The slide-over panel preserves scanning context (you don't lose your place)
- This is the Linear/Notion pattern adapted for a read-only intelligence surface

**Trade-offs:**
- Less visual richness than cards (no description visible in the list row)
- Requires the slide-over panel for full feature details
- Spotlight strip needs a "signal scoring" algorithm (simple: New > Tech Preview > GA, most recent first)

---

### OPTION B: "The Compact Card Grid with Global Filters"

**Core concept:** Keep cards but make them smaller, add a global filter bar, and flatten the product hierarchy into a single grid with product badges on each card.

```
+------------------------------------------------------------------+
|  Product Intelligence                                    [Refresh] |
+------------------------------------------------------------------+
|                                                                    |
|  FILTER BAR:                                                       |
|  [All] [RHEL] [OCP] [AAP]    [All] [GA] [Tech Preview] [Roadmap]  |
|  [Search...........................] [Version: v ▼]                 |
|  Active tags: [security x]                                         |
|                                                                    |
+------------------------------------------------------------------+
|                                                                    |
|  CARD GRID (3 columns at 1440px):                                  |
|                                                                    |
|  +---------------+ +---------------+ +---------------+             |
|  |[RHEL][NEW][TP]| |[RHEL][NEW][GA]| |[OCP] [NEW][GA]|            |
|  | Stratis Stor..| | Podman 5.0    | | Virt Live Mig |            |
|  | v10.1         | | v10.1         | | v4.21         |            |
|  | [storage]     | | [containers]  | | [virt]        |            |
|  +---------------+ +---------------+ +---------------+             |
|  +---------------+ +---------------+ +---------------+             |
|  |[RHEL]    [GA] | |[OCP]     [GA] | |[AAP] [NEW][GA]|            |
|  | FIPS 140-3    | | Multi-cluster | | Lightspeed GA |            |
|  | v10.0         | | v4.21         | | v2.6          |            |
|  | [security]    | | [hybrid]      | | [ai]          |            |
|  +---------------+ +---------------+ +---------------+             |
|  ... (continues, sorted by: New first, then TP, then GA)          |
|                                                                    |
+------------------------------------------------------------------+
```

**Interaction model:**
- Same global filter bar as Option A
- Cards are compact: product badge + status badge + name + version + primary tag. No description visible.
- 3-column grid at 1440px (vs current 2-column per-section)
- Clicking a card opens the same slide-over detail panel
- Cards sorted globally: New items first, then Tech Preview, then GA, then Deprecated
- No product grouping -- products are just a badge/filter dimension
- Tech Preview cards have amber left border (existing pattern)

**Why you might choose this:**
- Familiar card pattern (less cognitive change from current design)
- 3-column grid is denser than 2-column while still feeling like "browsing"
- Product badges create a scannable color channel (RHEL=red, OCP=blue, AAP=teal -- or use existing accent)
- No product sections means truly unified cross-product view

**Trade-offs:**
- Still ~1200px of vertical scroll for 56 cards (better than 2500px, worse than 800px)
- Cards without descriptions feel incomplete -- the slide-over panel becomes mandatory
- No grouping means you lose the "RHEL has 6 Tech Preview features" summary
- 3-column compact cards can feel cramped on dark backgrounds

---

### OPTION C: "The Grouped Timeline"

**Core concept:** A reverse-chronological timeline where features are grouped by extraction date / version release, with product as an inline badge. Answers "what changed?" as the primary question.

```
+------------------------------------------------------------------+
|  Product Intelligence                                    [Refresh] |
+------------------------------------------------------------------+
|                                                                    |
|  FILTER BAR:                                                       |
|  [All] [RHEL] [OCP] [AAP]    [All] [GA] [Tech Preview] [Roadmap]  |
|  [Search...........................]                                |
|  Active tags: [security x]                                         |
|                                                                    |
+------------------------------------------------------------------+
|                                                                    |
|  TIMELINE:                                                         |
|                                                                    |
|  April 2026  -  8 new features                                     |
|  ----------------------------------------------------------------  |
|  o  [RHEL][TP] Stratis Storage Manager               [storage]     |
|  |  v10.1 - Next-gen storage management with Stratis               |
|  |                                                                 |
|  o  [RHEL][GA] Podman 5.0 Container Tools            [containers]  |
|  |  v10.1 - Rootless containers with improved pod support          |
|  |                                                                 |
|  o  [OCP][GA]  OCP Virtualization Live Migration     [virt]        |
|  |  v4.21 - Zero-downtime VM migration across nodes               |
|  |                                                                 |
|  o  [AAP][GA]  Ansible Lightspeed GA                 [ai]         |
|  |  v2.6 - AI-assisted playbook generation                        |
|  |                                                                 |
|  o  [OCP][GA]  Multi-cluster Observability           [hybrid]      |
|  |  v4.21 - Unified metrics across fleet                          |
|  |  ...                                                            |
|                                                                    |
|  March 2026  -  12 features                                        |
|  ----------------------------------------------------------------  |
|  o  [RHEL][GA] FIPS 140-3 Compliance                [security]     |
|  |  v10.0 - Federal cryptographic standard compliance              |
|  |  ...                                                            |
|                                                                    |
|  Older                                                [show more]  |
|                                                                    |
+------------------------------------------------------------------+
```

**Interaction model:**
- Same global filter bar (minus version dropdown -- time IS the grouping)
- Features grouped by month of extraction, newest first
- Each entry shows product badge + status badge + name + primary tag + one-line summary
- Clicking expands inline (no slide-over) to show full description, all tags, links
- "Older" section is collapsed by default, expandable
- The SA's workflow becomes: open page, scan April 2026 section, done

**Why you might choose this:**
- Directly answers "what's new?" without any filtering
- Time-based grouping matches the SA's mental model for meeting prep
- One-line summaries visible inline (no click required for basic context)
- Feels like reading a briefing document, not navigating a dashboard

**Trade-offs:**
- Poor for "show me all Tech Preview features" -- you must scan across time groups
- Features without clear extraction dates get dumped into an "Older" bucket
- Inline expansion can push content down unpredictably
- Less dense than Option A (the one-line summary adds ~20px per row)
- "Older" bucket will grow indefinitely and needs pagination strategy

---

## Comparison Matrix

| Criterion | Option A (Stream) | Option B (Cards) | Option C (Timeline) |
|-----------|-------------------|-------------------|---------------------|
| Vertical space for 56 features | ~800px | ~1200px | ~1000px |
| "What's new across all products?" | Spotlight strip | Sort order | Time groups |
| "Show me all Tech Previews" | One filter click | One filter click | Must scan groups |
| Cross-product scanning | Grouped list | Flat grid | Inline badges |
| Information without clicking | Name + status + version + tag | Name + status + version + tag | Name + status + tag + summary |
| Detail access | Slide-over panel | Slide-over panel | Inline expand |
| Implementation complexity | Medium-high | Medium | Medium |
| Familiarity vs current | Big change | Moderate change | Big change |

---

## My Recommendation: Option A

Option A is the correct design. Here is why.

The SA's primary workflow is "scan, filter, spot, drill." Option A optimizes every step:

1. **Scan:** Dense rows mean the eye moves vertically through 56 feature names in seconds. Cards force horizontal scanning within each card before moving to the next.

2. **Filter:** Global filter bar with composable pills means "Tech Preview + security" is two clicks. The current design requires switching to the Tech Preview tab in each of three sections separately.

3. **Spot:** The spotlight strip answers "what matters most?" without any cognitive effort. It is the equivalent of a news editor putting the lead story above the fold.

4. **Drill:** The slide-over panel preserves the list context. In the current card design, clicking "Learn More" navigates away. In the timeline (Option C), inline expansion pushes content and you lose your scroll position.

Option B is a half-measure. It improves the current design but does not solve the fundamental problem: cards are the wrong pattern for scanning 56 items. Cards are for browsing 6-12 items where you want to read each one. Lists are for scanning 50+ items where you want to find the 3 that matter.

Option C is elegant for "what's new" but collapses for every other query. An SA asking "what Tech Preview features exist in RHEL?" has to scan across every time group. Time is a useful secondary axis, not the primary one.

**Option A gives the SA a 5-second answer (spotlight strip) and a 30-second deep scan (filtered list). That is the right two-tier structure for a 5-minute meeting prep workflow.**

---

## Implementation Notes (for Option A)

### New Components Needed
1. `FeatureFilterBar` -- Global filter bar with product pills, status pills, search, version dropdown, active tag pills
2. `SpotlightStrip` -- Horizontal strip of 3-5 high-signal feature cards
3. `FeatureListRow` -- Dense single-line feature row with inline metadata
4. `FeatureDetailPanel` -- Slide-over panel (400px) with full feature details
5. `ProductFeatureGroup` -- Collapsible product group header with counts

### Signal Scoring for Spotlight
```
score = 0
if (isNew)           score += 100
if (status === 'Tech Preview') score += 50
if (status === 'GA')           score += 10
if (status === 'Roadmap')      score += 30
// Top 5 by score, break ties by extractedAt descending
```

### Layout at 1440px
- Filter bar: full width, 48px height
- Spotlight strip: full width, 120px height, horizontal scroll if >5 items
- Feature list: full width, each row 40px height
- Detail panel: 400px right-anchored slide-over, list compresses to 1040px

### Color Tokens (existing)
- `accent` (#58A6FF) -- filter pills, active states, "New" badge
- `surface` -- row background
- `surface-hover` -- row hover state
- `border` -- row separators
- `text-primary` -- feature name
- `text-secondary` -- version, tags, metadata
- Status badges: green-500 (GA), amber-500 (Tech Preview), blue-500 (Roadmap), gray-500 (Deprecated)

### Keyboard Accessibility
- Arrow keys navigate the feature list
- Enter opens the detail panel
- Escape closes the detail panel
- Tab moves through filter pills
- Filter pills are toggle buttons with aria-pressed

---

## What I Am NOT Recommending

- **Radar/radial charts** -- Wrong for this data. Features are not positioned in 2D space.
- **Kanban columns by status** -- Already ruled out. Uneven feature counts make lopsided columns.
- **Expandable/collapsible cards** -- Accordion interaction debt. 56 expand/collapse decisions.
- **Table layout** -- Row-by-row comparison is wrong for browse-and-scan.
- **Drag-and-drop reordering** -- Read-only intelligence surface. No state to persist.
- **Tabs for products** -- Hides 2 of 3 products. The SA needs to see all products simultaneously.

---

## Next Steps

1. Jason selects Option A, B, or C (or requests a hybrid)
2. I produce high-fidelity component specifications for the selected option
3. Implementation begins with the filter bar and list view (highest value, lowest risk)
4. Spotlight strip ships as a fast-follow
5. Quinn validates the redesign against the "5-minute meeting prep" use case
