---
doc-type: design
status: proposed
owner: aditi
github-issue: 214
updated: 2026-05-14
---

# Intelligence Tab Layout Design — Issue #214

**Designer:** Aditi Sharma  
**Status:** Proposed — awaiting approval  
**Context:** Intelligence tab currently stacks 3 sections vertically. As we add competitive signals, M&A activity, and expansion opportunities, this becomes an overwhelming scroll. We need a scalable layout that works for 3-7 sections.

---

## Recommendation: Collapsible Cards (Option 3)

**TL;DR:** Each section becomes a collapsible card that expands to full width. Sections default to collapsed (header + preview only), expand on click. High-value sections (based on signal scores or recency) can auto-expand. This matches the existing Morning Summary pattern and scales gracefully from 3 to 7+ sections.

---

## Why This Works

### 1. Consistency with Existing Patterns
The Morning Summary already uses collapsible sections. Users understand this pattern. Applying it to Intelligence creates visual and interaction consistency across the app.

### 2. Progressive Disclosure at Section Level
The Intelligence tab is a **signal triage surface** — users need to scan what's available, then dive into what's relevant. Collapsible cards enable this:
- **Collapsed state:** Headlines, count badges, last-updated timestamp (6-8 lines per section)
- **Expanded state:** Full content with filtering, sorting, actions

This is superior to sub-tabs (which hide sections entirely) or always-visible cards (which create scroll fatigue).

### 3. Scales Gracefully from 3 to 7 Sections
- **3 sections:** Default state shows ~18-24 lines total (manageable scroll)
- **7 sections:** Default state shows ~42-56 lines (still one viewport on desktop, two on tablet)
- **Auto-expand logic:** Sections with high signal scores (e.g., critical product EOL warnings, breaking news) can expand automatically, surfacing urgent content without manual interaction

### 4. Mobile-First by Design
Collapsible cards work perfectly on mobile — tap to expand, tap to collapse. No horizontal scrolling, no cramped grids. Each section gets full width when expanded.

### 5. Filter Chips Remain Contextual
Product filter chips live **inside each expanded section** (not global to the tab). This prevents filter state conflicts between sections and keeps each section's controls scoped to its data.

Example:
- **Customer News section expanded:** Filter chips show [All Products] [AAP] [OCP] [RHEL]
- **Events section expanded:** Filter chips show [Virtual] [In-Person] [All Formats]

Each section's filters only affect that section's content.

---

## Design Specification

### Default State (Collapsed)

```
┌─────────────────────────────────────────────────────────────────────┐
│ [Overview] [Campaigns] [News] [Intelligence] [Tools]               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ 🗞️  CUSTOMER NEWS                                    [12] [↓] │  │
│  │ ───────────────────────────────────────────────────────────  │  │
│  │ • AAP 2.7 Announced with MCP Support (2h ago) [Critical]    │  │
│  │ • OpenShift AI 2.5 GA Announced (1d ago) [Notable]          │  │
│  │ • RHEL 9.4 Release Candidate Available (3d ago) [Minor]     │  │
│  │                                                              │  │
│  │ Last updated: 2 hours ago                                   │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ 📅 PRODUCT ROADMAP                                    [4] [↓] │  │
│  │ ───────────────────────────────────────────────────────────  │  │
│  │ • AAP 2.6 EOL in 13 days ⚠️                                  │  │
│  │ • OCP 4.18 GA June 2026                                      │  │
│  │ • RHEL 9.4 GA May 28, 2026                                   │  │
│  │                                                              │  │
│  │ Last updated: 4 hours ago                                   │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ 📍 EVENTS NEAR THIS CUSTOMER                          [2] [↓] │  │
│  │ ───────────────────────────────────────────────────────────  │  │
│  │ • AI Roadshow — Seattle, Jun 15 (12 miles from HQ)          │  │
│  │ • Container Workshop — Portland, Jul 8 (173 miles)          │  │
│  │                                                              │  │
│  │ Last updated: 12 hours ago                                  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ 🎯 COMPETITIVE SIGNALS                                [0] [↓] │  │
│  │ ───────────────────────────────────────────────────────────  │  │
│  │ No competitive signals in the last 30 days                  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ 💼 M&A ACTIVITY                                       [1] [↓] │  │
│  │ ───────────────────────────────────────────────────────────  │  │
│  │ • IBM acquires HashiCorp (Apr 2026) — impacts Terraform    │  │
│  │                                                              │  │
│  │ Last updated: 3 days ago                                    │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Expanded State (Customer News)

```
┌─────────────────────────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ 🗞️  CUSTOMER NEWS                              [12] [↑] [⟳] │  │
│  │ ───────────────────────────────────────────────────────────  │  │
│  │                                                              │  │
│  │  Filter: [All Products ▼] [AAP] [OCP] [RHEL] [Storage]     │  │
│  │                                                              │  │
│  │  ┌────────────────────────────────────────────────────┐     │  │
│  │  │ AAP 2.7 Announced with MCP Server Support          │     │  │
│  │  │ ──────────────────────────────────────────────     │     │  │
│  │  │ [AAP] [Critical] 2 hours ago                       │     │  │
│  │  │ Red Hat announces Ansible Automation Platform...  │     │  │
│  │  │                                                     │     │  │
│  │  │ [Read Article →] [Share with Customer]            │     │  │
│  │  └────────────────────────────────────────────────────┘     │  │
│  │                                                              │  │
│  │  ┌────────────────────────────────────────────────────┐     │  │
│  │  │ OpenShift AI 2.5 GA Announced                      │     │  │
│  │  │ ──────────────────────────────────────────────     │     │  │
│  │  │ [OCP] [Notable] 1 day ago                          │     │  │
│  │  │ Kubernetes-native AI workflows now available...   │     │  │
│  │  │                                                     │     │  │
│  │  │ [Read Article →] [Share with Customer]            │     │  │
│  │  └────────────────────────────────────────────────────┘     │  │
│  │                                                              │  │
│  │  [Show 7 more articles]                                     │  │
│  │                                                              │  │
│  │  Last updated: 2 hours ago                                  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ 📅 PRODUCT ROADMAP                                    [4] [↓] │  │
│  │ ───────────────────────────────────────────────────────────  │  │
│  │ • AAP 2.6 EOL in 13 days ⚠️                                  │  │
│  │ • OCP 4.18 GA June 2026                                      │  │
│  │   ...                                                        │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Section Anatomy

### Card Structure

```typescript
interface CollapsibleSection {
  icon: LucideIcon
  title: string
  itemCount: number
  lastUpdated: string
  previewItems: PreviewItem[] // 2-3 items for collapsed state
  isExpanded: boolean
  autoExpand: boolean // true if high-signal content present
}

interface PreviewItem {
  headline: string
  badges: Badge[] // significance, product tags, time
  urgency: 'critical' | 'notable' | 'minor'
}
```

### Visual Specs

**Card (Collapsed):**
- `bg-surface border border-border rounded-xl`
- `p-6` padding
- Header: Icon + Title (left), Count badge + Chevron (right)
- Preview: 2-3 bullet items (headline + badges)
- Footer: "Last updated: X ago" (muted text)
- Height: ~160px (6-8 lines)

**Card (Expanded):**
- Same container styling
- Header: Icon + Title (left), Count badge + Chevron + Refresh (right)
- Filter chips (if applicable) below header
- Full content area (existing section content from IntelligenceTab.tsx)
- Footer: "Last updated" + optional pagination controls
- Height: Variable (max-h-[600px] with scroll if needed)

**Header Click Area:**
- Entire header row is clickable (not just chevron)
- Hover state: `bg-surface-hover`
- Cursor: `cursor-pointer`

**Count Badge:**
- `bg-accent/10 text-accent px-2 py-1 rounded-lg text-sm font-medium`
- Shows count of items (e.g., [12] articles, [4] products)
- Empty state: [0] with muted styling

**Chevron Icon:**
- `ChevronDown` when collapsed
- `ChevronUp` when expanded
- `w-5 h-5 text-text-secondary`
- Rotate transition: `transition-transform duration-200`

---

## Auto-Expand Logic

Sections auto-expand on tab load if any of these conditions are met:

1. **Critical urgency signal** (e.g., product EOL < 30 days, Sev1 case, breaking news)
2. **New content since last visit** (tracked via `lastVisited` timestamp in user preferences)
3. **Explicit user preference** (user can pin sections to always-expanded via context menu)

Default behavior: **All sections collapsed** on first visit. Auto-expand kicks in on subsequent visits based on signal quality.

This prevents overwhelming new users while surfacing urgent content for returning users.

---

## Interaction Patterns

### Expand/Collapse
- **Click anywhere in header** → toggle expand/collapse
- **Keyboard:** `Enter` or `Space` on focused header toggles state
- **Accessibility:** `aria-expanded="true|false"` on header, `role="button"`

### Multi-Section Expansion
- **Multiple sections can be expanded simultaneously** (not accordion behavior)
- Rationale: Users may want to compare roadmap + events side-by-side without toggling

### Collapse All / Expand All
- **Optional header controls** (not in v1, defer to backlog)
- Proposed location: Top-right of tab, next to account name
- Format: Two icon buttons (`ChevronsUp` / `ChevronsDown`)

### Refresh
- **Section-level refresh** (not tab-level) — each expanded section shows refresh icon in header
- Clicking refresh re-fetches only that section's data
- Loading state: Spinner in header, content fades to 50% opacity

---

## Responsive Behavior

### Desktop (>1024px)
- Cards: Full width (`max-w-4xl mx-auto`)
- Collapsed height: ~160px per section
- Expanded height: Variable, max 600px with internal scroll if needed
- 3 sections collapsed: ~480px total (one viewport)
- 7 sections collapsed: ~1120px total (1.5 viewports, manageable scroll)

### Tablet (768px-1024px)
- Same layout, full width
- Collapsed height increases slightly (~180px) for touch targets
- Filter chips scroll horizontally if needed

### Mobile (<768px)
- Same layout, full width
- Collapsed height: ~200px (larger touch targets, more vertical spacing)
- Expanded sections use full viewport height (`max-h-[80vh]`)
- Only one section expanded at a time on mobile (accordion behavior on small screens)

---

## How It Handles 3 vs 7 Sections

### 3 Sections (Current State)
- **All collapsed:** ~480px (one viewport on desktop, fits above the fold)
- **One expanded:** ~600-800px depending on content
- **Visual balance:** No overwhelming scroll, clean hierarchy

### 7 Sections (Future State)
- **All collapsed:** ~1120px (~1.5 viewports on desktop, 2-3 on tablet)
- **Auto-expand 1-2 high-signal sections:** Rest remain collapsed, total ~1400-1600px
- **User manually expands 2-3 relevant sections:** Scroll depth increases but remains manageable (users control what they see)

**Key advantage:** Collapsed cards provide visual landmarks — users can scan section titles and counts without scrolling through full content. This is superior to:
- **Sub-tabs:** Hiding sections entirely (users forget what's available)
- **Two-column grid:** Cramped content, hard to scan on tablets
- **Always-visible sections:** Overwhelming scroll (current pain point we're solving)

---

## Filter Chips Interaction

Product filter chips live **inside each expanded section**, not at tab level.

### Why Section-Scoped Filters?

1. **Different filter types per section:**
   - Customer News → Product tags ([AAP] [OCP] [RHEL])
   - Events → Format ([Virtual] [In-Person] [All])
   - Competitive Signals → Competitor ([AWS] [Azure] [VMware])

2. **No filter state conflicts:** Selecting [AAP] in Customer News doesn't affect Events section

3. **Clearer user model:** "I'm filtering *this section's* content" vs. "What does this global filter apply to?"

### Implementation
- Filter chips appear directly below section header when section is expanded
- Same styling as existing filter chips in the app (`bg-accent/10 text-accent` when active)
- Persist filter state per section in URL query params: `?news_filter=AAP&events_format=virtual`

---

## Why Not the Other Options?

### Option 1: Sub-Tabs Within Intelligence
**Problem:** Adds navigation depth (tab → sub-tab → content). Users lose context of what's available in other sections. Works for 2-3 sub-tabs, breaks at 7.

**When it works:** Admin panels with distinct workflows (Users | Settings | Billing). Not for signal triage.

### Option 2: Two-Column Grid
**Problem:** Each column gets ~40% width on desktop, too narrow for tables (Product Roadmap) or event cards with metadata. Mobile forces stacking anyway.

**When it works:** Dashboard KPI cards (numeric data, no tables). Not for content-heavy sections.

### Option 4: Priority-Ranked View
**Problem:** Relies on signal scoring algorithm to be perfect. Misjudged scores hide relevant content. Users lose spatial memory ("where was that events section?").

**When it works:** Algorithmic feeds (Twitter, Reddit). Not for professional tools where users build mental models.

### Option 5: Dashboard-Style Grid (Resizable Cards)
**Problem:** High interaction cost (drag to resize, arrange layout). Overkill for read-only triage. Users won't customize — they'll use defaults.

**When it works:** Monitoring dashboards (Grafana, Datadog) where users build custom views. Not for standard intelligence surfaces.

---

## Accessibility

### Keyboard Navigation
- **Tab:** Focus next section header
- **Enter/Space:** Toggle expand/collapse
- **Shift+Tab:** Focus previous section header
- **Escape:** Collapse all sections (optional, defer to v2)

### ARIA Attributes
```html
<div
  role="button"
  aria-expanded="false"
  aria-controls="section-customer-news"
  tabindex="0"
>
  <h2>Customer News</h2>
</div>
<div id="section-customer-news" aria-hidden="true">
  <!-- Section content -->
</div>
```

### Screen Reader Behavior
- Header announces: "Customer News, 12 items, collapsed, button"
- Expanding announces: "Customer News expanded"
- Empty state announces: "No customer news articles found"

### Focus Management
- Expanding a section moves focus to first interactive element inside (filter chips or first article)
- Collapsing a section returns focus to section header

---

## Performance Considerations

### Lazy Loading
- **Collapsed sections:** Fetch only preview data (3 items, lightweight)
- **Expanded sections:** Fetch full dataset on expand (not on tab load)
- **Cache:** 4-hour cache per section (same as customer brief)

### Data Volume
- **3 sections:** 3 preview fetches (~15KB total)
- **7 sections:** 7 preview fetches (~35KB total)
- Expanded section fetch: ~50-200KB depending on content (news articles, product data, events)

This is significantly lighter than fetching all 7 sections' full data on tab load.

### Animation Performance
- Collapse/expand: `transition-all duration-200 ease-in-out`
- Chevron rotation: `transform: rotate(180deg)` (GPU-accelerated)
- Content fade: `opacity` transition (GPU-accelerated)

---

## Implementation Roadmap

### Phase 1: Refactor Existing 3 Sections (BKL-214)
1. Extract each section (Customer News, Product Roadmap, Events) into `<CollapsibleSection>` wrapper
2. Implement collapse/expand state management
3. Add preview items to collapsed state
4. Add section-level refresh
5. Update IntelligenceTab.tsx to render sections in collapsible cards

**Deliverable:** Existing 3 sections work in collapsible card layout

### Phase 2: Add Auto-Expand Logic (BKL-215)
1. Define signal scoring criteria (critical EOL, breaking news, etc.)
2. Implement auto-expand on tab load based on signal scores
3. Add user preference for pinned sections (always-expanded)

**Deliverable:** High-value sections auto-expand for returning users

### Phase 3: Add New Sections (BKL-216, BKL-217, BKL-218)
1. Competitive Signals section
2. M&A Activity section
3. Expansion Opportunities section

**Deliverable:** 6-7 sections in Intelligence tab, scalable layout

---

## Design Artifacts

### Figma Mockup
(To be created by Aditi post-approval)

**Includes:**
- Desktop collapsed state (3 sections, 7 sections)
- Desktop expanded state (one section, multiple sections)
- Tablet responsive layout
- Mobile accordion behavior
- Dark theme styling
- Interaction states (hover, focus, active)

### Component Spec for Marcus

```typescript
// CollapsibleSection.tsx
interface CollapsibleSectionProps {
  icon: LucideIcon
  title: string
  itemCount: number
  lastUpdated: string
  previewItems: PreviewItem[]
  isExpanded: boolean
  onToggle: () => void
  onRefresh?: () => void
  autoExpand?: boolean
  children: React.ReactNode // Full section content when expanded
}

interface PreviewItem {
  headline: string
  badges: { text: string; variant: 'critical' | 'notable' | 'minor' }[]
  timestamp: string
}
```

---

## Metrics & Success Criteria

**How we know this works:**

1. **Engagement:**
   - % of users who expand at least one section per visit (target: >60%)
   - Average sections expanded per visit (target: 2-3)
   - Time spent in Intelligence tab (target: >90 seconds)

2. **Usability:**
   - % of users who successfully find and interact with auto-expanded sections (target: >80%)
   - Bounce rate (users who enter tab and leave without expanding anything) (target: <20%)

3. **Discoverability:**
   - % of users who discover all 7 sections within first week (target: >50%)
   - User survey: "I can easily find relevant intelligence in this tab" (target: 4.5/5)

**Accessibility Audit:**
- All sections keyboard-navigable ✅
- Screen reader tested ✅
- Color contrast WCAG AA ✅

**Visual Quality Gate:**
- Collapsed cards align to 8px grid ✅
- Consistent spacing between sections (24px) ✅
- Smooth expand/collapse animation (<200ms) ✅

---

## Final Recommendation

**Use collapsible cards.** This is not the most innovative option, but it is the most **usable, scalable, and consistent** with existing patterns in the app. It solves the core problem (overwhelming scroll) without introducing new interaction models or adding navigation depth.

The other options are defensible for specific use cases, but collapsible cards are correct for this context:
- Progressive disclosure at the right granularity (section-level, not item-level)
- Scales from 3 to 7+ sections without UI redesign
- Works on tablets and mobile without compromise
- Matches existing Morning Summary pattern (user familiarity)
- Keeps product filter chips contextual (no global filter confusion)

This is the right choice.

---

**End of Design Document**

*This design is correct because it prioritizes user needs over visual novelty. Usability beats aesthetics when they conflict.*

— Aditi Sharma, UX/UI Design Specialist
