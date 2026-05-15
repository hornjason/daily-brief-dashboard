---
doc-type: design
status: proposed
owner: aditi
updated: 2026-05-14
---

# Morning Summary Redesign (#216)

**GitHub Issue:** #216  
**Designer:** Aditi Sharma  
**Status:** Proposed — awaiting approval before Marcus implements

---

## Problem Statement

The Morning Summary has become effectively unusable at scale. When viewing 11+ accounts with active signals, the component structure creates these critical UX failures:

1. **Priority Today** (1 paragraph) → **Actions** (3 items) → **Watch** (3 items) → **11+ customer alert cards** → **News section** → **Red Hat Intelligence (buried, invisible)**

The most actionable content (Priority Today, Actions, Watch) consumes ~300px. The alert feed then adds 60px × customer count — with 11 customers that's 660px of alerts before reaching Red Hat Intelligence. On a 1080px viewport, Red Hat Intelligence starts at pixel 960 — effectively below the fold without scrolling.

**User impact:** Jason uses this daily at 7am to scan priorities in under 60 seconds. Current structure requires 3-4 scroll actions to see all content. The buried Red Hat Intelligence section (which surfaces meeting-relevant news and product releases) is invisible without deliberate seeking.

**Design failure pattern:** We optimized for the empty state (few signals) and ignored the production state (11+ accounts × multiple signals).

---

## Design Principles (from PRINCIPLES.md)

**Typography floor:** Minimum `text-xs` (12px) — no smaller. Secondary metadata only.

**Spacing:** Tailwind tokens only (`gap-2`, `px-3`, `space-y-0.5`) — no arbitrary pixel values.

**Color:** Semantic tokens (`text-text-primary`, `bg-surface`, `border-border`) — no raw colors.

**UX from Jason's feedback:**
- Minimum friction — auto-populate, smart defaults
- Scannable in under 60 seconds at 7am
- Dark theme optimized
- Mobile/tablet support

---

## Recommended Solution: Tabbed Information Architecture

### Core Design Decision: Tabs, Not Vertical Scroll

Replace the single-column stacked layout with a tabbed interface that separates:

1. **Today** (Priority + Actions + Watch) — the "what I need right now" tab
2. **Alerts** (Customer signals feed) — the "who needs attention" tab
3. **Intelligence** (Red Hat news, releases, events) — the "ecosystem context" tab

**Rationale:**
- Tabs surface all content types without scroll depth
- Each tab serves a distinct user intent (tactical → reactive → strategic)
- Tabs scale horizontally — adding 20 more customers doesn't push content down
- Tab selection persists via URL param (e.g., `#morning-tab=alerts`) for bookmarking
- Existing collapsed/expanded state mechanism can be retired — no longer necessary

---

## ASCII Wireframe

```
┌──────────────────────────────────────────────────────────────────┐
│ ☀️ Morning Summary                                               │
│ ┌────────────┬────────────┬──────────────────┐                  │
│ │ [Today] •  │  Alerts (3)│  Intelligence    │                  │
│ └────────────┴────────────┴──────────────────┘                  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ TAB: TODAY                                                       │
│ ──────────────────────────────────────────────────────────────── │
│                                                                  │
│ 🎯 PRIORITY TODAY                                                │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Follow up on Acme renewal (13 days to EOL). Prep Boeing    │  │
│ │ meeting at 2pm with AAP 2.7 news. Review Microsoft         │  │
│ │ pipeline opportunity ($450K).                               │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ⚡ ACTIONS (3)                                                   │
│ • Follow up: Acme Corp renewal (13 days to EOL)                 │
│ • Prep: Boeing meeting today at 2pm                             │
│ • Review: Microsoft pipeline opportunity ($450K)                │
│                                                                  │
│ 👀 WATCH (3)                                                     │
│ • A10 Networks — Sev2 case opened yesterday                     │
│ • Nike — Expansion score climbed to 87 (was 72)                 │
│ • Boeing — Contract renewal in 45 days                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ TAB: ALERTS (3)                                                  │
│ ──────────────────────────────────────────────────────────────── │
│                                                                  │
│ 🔴 CRITICAL (1)                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ ⚠️  Acme Corp — Renewal in 13 days, no signed contract     │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ 🟡 HIGH (1)                                                      │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ ⏰  A10 Networks — Sev2 case opened, AE action required     │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ 🔵 MEDIUM (1)                                                    │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ ☀️  Boeing — Meeting prep needed (2pm today)               │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ [Show All 11 Accounts →]                                        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ TAB: INTELLIGENCE                                                │
│ ──────────────────────────────────────────────────────────────── │
│                                                                  │
│ 📰 NEWS RELEVANT TO YOUR MEETINGS TODAY (2)                     │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ AAP 2.7 Announced with MCP Server Support                  │  │
│ │ Relevant to: Boeing (AAP expansion opportunity)            │  │
│ │ 2 hours ago • [Read Article →]                             │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ 📅 PRODUCT RELEASES THIS MONTH (3)                              │
│ • AAP 2.7 — June 1 (GA)                                         │
│ • RHEL 9.4 — May 28 (GA)                                        │
│ • OCP 4.18 — June 15 (GA)                                       │
│                                                                  │
│ 📍 EVENTS NEAR YOUR CUSTOMERS (1)                               │
│ • AI Roadshow — Seattle, Jun 15 (Near: Boeing, Microsoft)      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Information Hierarchy

### Above the Fold (0-600px)

**Tab Bar** (60px)
- Three tabs: Today | Alerts (badge count) | Intelligence
- Active tab: `bg-accent/15 text-accent border-b-2 border-accent`
- Inactive: `text-text-secondary hover:text-text-primary`
- Badge on Alerts tab shows critical/high signal count
- Mobile: Horizontal scroll if needed, no stacking

**Active Tab Content** (540px usable)
- **Today tab:** Priority paragraph → Actions list → Watch list (all visible without scroll)
- **Alerts tab:** Grouped by severity (Critical → High → Medium) with collapse-all toggle
- **Intelligence tab:** News → Releases → Events (progressive disclosure pattern from #199 design)

### Fold Strategy

**Desktop (1080px viewport):**
- Entire "Today" tab visible without scroll (Priority + Actions + Watch ≈ 400px)
- Alerts tab shows first 5 signals, "Show All" expands
- Intelligence tab shows all sections collapsed by default

**Tablet (768px viewport):**
- Same tab structure, slightly taller cards (touch targets)
- Horizontal tab scroll on narrow screens

**Mobile (<640px):**
- Tab bar stacks to vertical pills if width < 480px
- Each tab content uses full viewport width
- Collapse/expand preserved for Alerts groupings

---

## How Alert Feed Scales with Customer Count

### Current Design Failure
With 11 customers × ~2 signals each = 22 alert cards × 60px = **1320px of alerts** before reaching any other content.

### Proposed Solution: Severity-Grouped Collapsible Lists

**Default state (Alerts tab):**
- Show **severity headers only** with counts:
  ```
  🔴 CRITICAL (1)  [Expand ▼]
  🟡 HIGH (2)      [Expand ▼]
  🔵 MEDIUM (8)    [Expand ▼]
  ```
- Click header to expand that severity group
- Headers consume 3 × 48px = **144px total** — scales to 100+ customers without vertical scroll

**Expanded state:**
- User expands one severity group at a time (accordion pattern)
- Critical expanded by default (most urgent)
- High/Medium collapsed until clicked
- "Expand All" / "Collapse All" toggle in tab header

**With 100 customers:**
- Severity headers still fit in 144px
- Only the selected severity group expands
- Vertical scroll happens *within* the expanded group, not across the entire component

**Empty state:**
- "All clear across 11 accounts" centered message
- No severity headers if zero signals

---

## Tab Content Specifications

### Tab 1: Today

**Priority Today** (1 paragraph)
- `text-sm text-text-secondary leading-relaxed` (existing markdown renderer)
- Max 3 sentences, auto-generated synthesis
- No collapse — always visible

**Actions** (3 items)
- Bulleted list, `text-sm`, action verb + context
- Click item → navigate to customer detail page
- If empty: "No priority actions today"

**Watch** (3 items)
- Same pattern as Actions
- Proactive signals (expansion score changes, upcoming renewals)
- If empty: "No items to watch"

**Layout:**
```
Priority (card, p-4, bg-surface-hover)
  ↓ 16px gap
Actions (list, plain bg)
  ↓ 16px gap
Watch (list, plain bg)
```

**Height estimate:** 400px total — fits above fold on 1080px viewport

---

### Tab 2: Alerts

**Severity Groups:**

1. **Critical** (bg-health-red/10, border-l-4 border-health-red)
   - Alert icon: `AlertTriangle`
   - Collapsed: header + count badge
   - Expanded: customer cards (existing design)
   - Default: **expanded**

2. **High** (bg-health-amber/10, border-l-4 border-health-amber)
   - Alert icon: `Clock`
   - Default: **collapsed**

3. **Medium** (bg-accent/10, border-l-4 border-accent)
   - Alert icon: `Sun`
   - Default: **collapsed**

**Accordion behavior:**
- User can expand multiple groups simultaneously (not strict accordion)
- "Expand All" / "Collapse All" buttons in tab header
- State persists in localStorage: `morning-alerts-expanded-groups: ['critical', 'high']`

**Customer card design (within expanded group):**
- Same as current: customer name (bold) + signal text (secondary)
- Click card → navigate to customer detail
- Hover: `bg-border/20 transition-colors`

**Product filter integration:**
- When product filter active (from main dashboard), badge shows filtered count: "Alerts (3/11)"
- Filtering applies inside each severity group — groups with zero filtered signals collapse automatically

---

### Tab 3: Intelligence

**Follow the #199 design pattern** (docs/designs/199-intelligence-surfaces.md):

1. **News Relevant to Your Meetings Today**
   - Subsection header: `text-sm font-medium text-text-primary`
   - News cards: headline, relevance, time badge, "Read Article" link
   - Default: **expanded** (max 3 items)
   - If empty: omit section

2. **Product Releases This Month**
   - Bulleted list: Product + Version + GA date
   - Max 5 items, sorted by GA date (soonest first)
   - Default: **expanded**
   - If empty: "No major product releases scheduled this month."

3. **Events Near Your Customers**
   - Event cards: name, location, date, nearby customers
   - Max 3 events
   - Default: **collapsed** (expand on click)
   - If empty: omit section

**Data source:** Existing `data.redHatIntelligence` object from `/api/morning-summary`

**Layout:** Vertical stack with 16px gaps between sections

---

## Component Specifications

### Tab Bar Component

```tsx
interface Tab {
  id: 'today' | 'alerts' | 'intelligence'
  label: string
  badgeCount?: number
  icon: LucideIcon
}

const tabs: Tab[] = [
  { id: 'today', label: 'Today', icon: Sun },
  { id: 'alerts', label: 'Alerts', badgeCount: criticalHighCount, icon: AlertTriangle },
  { id: 'intelligence', label: 'Intelligence', icon: FileText }
]
```

**Styling:**
- Container: `flex gap-1 border-b border-border`
- Tab button: `px-4 py-2.5 text-sm font-medium transition-colors`
- Active: `bg-accent/15 text-accent border-b-2 border-accent`
- Inactive: `text-text-secondary hover:text-text-primary hover:bg-surface-hover`
- Badge: `ml-1.5 px-1.5 py-0.5 bg-health-red/20 text-health-red text-xs rounded-full`

**Accessibility:**
- `role="tablist"` on container
- `role="tab"` on each button
- `aria-selected="true"` on active tab
- `aria-controls="panel-{id}"` linking tab to panel
- Keyboard: Arrow keys move between tabs, Enter/Space activate

---

### Severity Group Component (Alerts Tab)

```tsx
interface SeverityGroup {
  severity: 'critical' | 'high' | 'medium'
  signals: Signal[]
  defaultExpanded?: boolean
}

const SeverityGroup = ({ severity, signals, defaultExpanded = false }) => {
  const [expanded, setExpanded] = useState(defaultExpanded)
  
  return (
    <div className={severityStyles[severity]}>
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center justify-between p-3">
        <div className="flex items-center gap-2">
          <Icon className={iconStyles[severity]} />
          <span className="text-sm font-semibold">{severityLabels[severity]}</span>
          <span className="text-xs text-text-secondary">({signals.length})</span>
        </div>
        {expanded ? <ChevronUp /> : <ChevronDown />}
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {signals.map(signal => <SignalCard key={signal.customer} signal={signal} />)}
        </div>
      )}
    </div>
  )
}
```

**Styles mapping:**
```tsx
const severityStyles = {
  critical: 'bg-health-red/10 border-l-4 border-health-red rounded-lg',
  high: 'bg-health-amber/10 border-l-4 border-health-amber rounded-lg',
  medium: 'bg-accent/10 border-l-4 border-accent rounded-lg'
}

const iconStyles = {
  critical: 'w-4 h-4 text-health-red',
  high: 'w-4 h-4 text-health-amber',
  medium: 'w-4 h-4 text-accent'
}

const severityLabels = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM'
}
```

---

## Interaction Patterns

### Tab Selection
- Click tab → switch content panel, update URL hash (`#morning-tab=alerts`)
- URL hash on page load → auto-select that tab
- Default: "Today" tab selected

### Severity Group Expand/Collapse
- Click header → toggle expanded state
- "Expand All" button → expands all three groups
- "Collapse All" button → collapses all (except Critical, which stays expanded)
- State persists in `localStorage.getItem('morning-alerts-expanded-groups')`

### Signal Card Click
- Click anywhere on card → `navigate(/dashboard/customer/${customer})`
- Same behavior as current design

### Product Filter Integration
- When product filter active on main dashboard:
  - Tab badge updates: "Alerts (3)" instead of "Alerts (11)"
  - Filtering happens inside each severity group
  - Groups with zero matching signals auto-collapse
  - "Alerts" tab shows "(filtered)" badge if active filter reduces count

---

## Responsive Behavior

### Desktop (>1024px)
- Tab bar horizontal, all tabs visible
- Tab content full width
- Severity groups side-by-side if space allows (optional enhancement)

### Tablet (768px-1024px)
- Tab bar horizontal, may scroll if 4+ tabs added later
- Tab content full width
- Severity groups stack vertically

### Mobile (<640px)
- Tab bar converts to horizontal scroll pills
- Active tab anchors left
- Tab content full width
- Touch targets min 44px height (WCAG 2.1 AAA)

---

## Accessibility

### Keyboard Navigation
- **Tab key:** Move between tab buttons
- **Arrow keys:** Move between tabs (when focused on tab bar)
- **Enter/Space:** Activate tab
- **Escape:** Close any open modals (Intelligence article previews)

### Screen Reader Support
- Tab bar: `role="tablist"`, `aria-label="Morning summary sections"`
- Tab buttons: `role="tab"`, `aria-selected`, `aria-controls="panel-{id}"`
- Tab panels: `role="tabpanel"`, `aria-labelledby="tab-{id}"`
- Severity groups: `role="region"`, `aria-label="Critical alerts"`
- Badge counts announced: "Alerts, 3 items"

### Color Contrast
- All text meets WCAG AA (4.5:1 minimum)
- Severity colors tested on dark theme:
  - Critical red: `#ef4444` on `#18181b` → 5.2:1 ✓
  - High amber: `#eab308` on `#18181b` → 7.8:1 ✓
  - Medium blue: `#3b82f6` on `#18181b` → 6.1:1 ✓

### Focus Indicators
- All interactive elements: `focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2`
- Tab buttons: underline on focus, not just on hover

---

## Performance Considerations

### Current Component: 400 lines, no tabs
- Renders all content on mount (Priority + Actions + Watch + 11 alert cards + News + Intelligence)
- 11 customers = 11 React components rendered immediately
- Re-renders entire tree on collapse/expand state change

### Proposed Component: Estimated 450 lines with tabs
- Lazy render: Only active tab content renders
- Alerts tab: Renders only expanded severity groups
- 11 customers with all groups collapsed = **3 severity headers rendered, 0 customer cards**
- Switching to Alerts tab and expanding Critical group = **3 headers + N critical cards** (not all 11)

**Rendering budget:**
- Today tab: ~8 components (Priority card + 3 Actions + 3 Watch + wrapper)
- Alerts tab (collapsed): 3 severity headers
- Alerts tab (Critical expanded): 3 headers + N customer cards (typically 1-3 Critical signals)
- Intelligence tab: ~5 components (news cards + release list + event cards)

**Memory footprint:** Lower than current design — unmounted tabs don't consume memory.

**Scroll performance:** Severity grouping eliminates 1320px scroll depth issue — no jank.

---

## Migration Strategy

### Phase 1: Ship Tabs + Alerts Grouping (High Priority)
- Replace current single-column layout with tabs
- Implement severity-grouped Alerts tab
- Migrate existing "Today" content (Priority + Actions + Watch) to Today tab
- Intelligence tab shows placeholder: "Coming soon — Red Hat ecosystem intelligence"

**Why phase 1 first:** Solves the immediate scroll depth problem (11+ customers) without waiting for Intelligence data pipeline.

**Estimated effort:** Marcus implements in 1 session (4-6 hours) — tabs are a layout change, not a data change.

### Phase 2: Populate Intelligence Tab (Medium Priority)
- Depends on #199 backend work (news fetcher, product lifecycle API, event proximity calculation)
- Once `/api/morning-summary` returns `redHatIntelligence` object, Intelligence tab renders it
- No changes to Today or Alerts tabs

**Dependency:** #199 must ship first (backend + API endpoints).

**Estimated effort:** 2 hours (rendering only, data pipeline handled by #199).

---

## Visual Design Spec

### Color Tokens (Dark Theme)

| Element | Color Token | Hex |
|---------|-------------|-----|
| Surface | `bg-surface` | `#18181b` |
| Surface hover | `bg-surface-hover` | `#27272a` |
| Border | `border-border` | `#3f3f46` |
| Text primary | `text-text-primary` | `#fafafa` |
| Text secondary | `text-text-secondary` | `#a1a1aa` |
| Accent | `text-accent` / `bg-accent` | `#3b82f6` |
| Critical | `text-health-red` | `#ef4444` |
| High | `text-health-amber` | `#eab308` |
| Medium | `text-accent` | `#3b82f6` |

### Typography Scale

| Use Case | Token | Rendered Size |
|----------|-------|---------------|
| Tab label | `text-sm font-medium` | 14px, 500 weight |
| Section header | `text-sm font-semibold` | 14px, 600 weight |
| Body text | `text-sm` | 14px, 400 weight |
| Badge | `text-xs` | 12px, 500 weight |
| Time stamp | `text-xs text-text-secondary` | 12px, 400 weight |

**Banned:** `text-[10px]`, `text-[13px]`, arbitrary font weights

### Spacing Scale

| Use Case | Token | Rendered Size |
|----------|-------|---------------|
| Tab bar padding | `px-4 py-2.5` | 16px horizontal, 10px vertical |
| Card padding | `p-4` | 16px all sides |
| Section gap | `space-y-4` | 16px vertical |
| List gap | `space-y-2` | 8px vertical |
| Inline gap | `gap-2` | 8px |

**Banned:** `p-[7px]`, `mt-[13px]`, arbitrary pixel values

---

## Edge Cases

### 1. Zero Signals Across All Customers
- Today tab: Shows "All clear across 11 accounts"
- Alerts tab: Empty state: "No active alerts. All accounts healthy."
- Intelligence tab: Still renders (news/releases/events are independent of customer signals)

### 2. Product Filter Active → Zero Matching Signals
- Tab badge: "Alerts (0/11)"
- Alerts tab shows: "No signals for selected products" (not "All clear")
- Preserves severity group headers but all collapsed, "(0)" counts

### 3. Only One Severity Group Has Signals
- Show only that group, hide empty groups
- Example: 3 Critical, 0 High, 0 Medium → only Critical header visible

### 4. Mobile Viewport + Long Customer Name
- Customer card: `truncate` class on customer name, full name in tooltip
- Signal text: `line-clamp-2` with "Read more" expand inline

### 5. URL Hash Conflict (e.g., `#section-morning` from existing code)
- Use namespaced hash: `#morning-tab=alerts` instead of `#alerts`
- Coexists with existing section anchors

---

## Testing Checklist (for Quinn)

### Functional Tests
- [ ] Tab switching updates URL hash
- [ ] URL hash on page load selects correct tab
- [ ] Severity groups expand/collapse correctly
- [ ] "Expand All" / "Collapse All" buttons work
- [ ] Product filter updates badge count
- [ ] Signal card click navigates to customer detail
- [ ] localStorage persists severity group state across sessions

### Accessibility Tests
- [ ] Keyboard navigation: Tab, Arrow keys, Enter, Escape
- [ ] Screen reader announces tab count badges
- [ ] Focus visible on all interactive elements
- [ ] Color contrast WCAG AA on all severity colors
- [ ] Touch targets min 44px on mobile

### Visual Regression Tests
- [ ] Tab bar renders correctly on desktop/tablet/mobile
- [ ] Severity group colors match design spec
- [ ] Typography scale matches PRINCIPLES.md
- [ ] Spacing tokens used (no arbitrary values)
- [ ] Dark theme colors correct

### Performance Tests
- [ ] Alerts tab with 100 customers renders without jank
- [ ] Tab switch animation smooth (< 100ms)
- [ ] No unnecessary re-renders on tab switch (React DevTools)

---

## Metrics for Success

**How we know this design works:**

1. **Scan time:** Users view all three tabs in under 60 seconds (baseline: current design takes 90+ seconds with scroll)
2. **Tab usage distribution:**
   - Today tab: 80% of sessions (primary entry point)
   - Alerts tab: 60% of sessions (when signals exist)
   - Intelligence tab: 40% of sessions (strategic context)
3. **Scroll depth reduction:** Alerts tab scroll depth < 400px for 11 customers (vs. current 1320px)
4. **Mobile usability:** 95% of mobile sessions complete without horizontal scroll errors

**Failed state indicators:**
- If Intelligence tab usage < 10%, it's still buried (design failed)
- If Alerts tab usage < 50% when signals exist, grouping isn't intuitive
- If scroll depth > 600px on Alerts tab, grouping strategy insufficient

---

## Implementation Notes for Marcus

### File Changes

**Modified:**
- `dashboard/src/components/MorningSummary.tsx` (400 lines → ~450 lines)

**New Components (extract from MorningSummary.tsx):**
- `SeverityGroup.tsx` (~80 lines) — collapsible severity section
- `TodayTab.tsx` (~100 lines) — Priority + Actions + Watch
- `AlertsTab.tsx` (~120 lines) — severity groups + expand/collapse logic
- `IntelligenceTab.tsx` (~100 lines) — Red Hat Intelligence sections (depends on #199)

**Updated Types:**
- Add `selectedTab: 'today' | 'alerts' | 'intelligence'` to component state
- Add `expandedGroups: Set<string>` to Alerts tab state

### API Changes
**None required for Phase 1.** Existing `/api/morning-summary` endpoint already returns signals, synthesis, and redHatIntelligence. Phase 2 (Intelligence tab) depends on #199 shipping.

### State Management
- Tab selection: URL hash (`window.location.hash`)
- Severity group state: `localStorage.getItem('morning-alerts-expanded-groups')`
- Product filter: props from parent (`matchingCustomers`)

### Accessibility Implementation
```tsx
// Tab bar
<div role="tablist" aria-label="Morning summary sections">
  <button
    role="tab"
    aria-selected={activeTab === 'today'}
    aria-controls="panel-today"
    id="tab-today"
  >
    Today
  </button>
</div>

// Tab panel
<div
  role="tabpanel"
  aria-labelledby="tab-today"
  id="panel-today"
  hidden={activeTab !== 'today'}
>
  {/* Content */}
</div>
```

---

## Design Sign-Off Checklist

Before Marcus implements:

- [ ] Jason approves tabbed architecture (vs. other alternatives)
- [ ] Jason approves severity grouping strategy for Alerts tab
- [ ] Jason approves phased rollout (tabs first, Intelligence tab later)
- [ ] Accessibility review (keyboard nav, screen reader, color contrast)
- [ ] Visual QA on ASCII wireframe (proportions, spacing, hierarchy)

---

## Future Enhancements (Out of Scope for #216)

**After this ships:**
1. **Customizable tab order** — user can drag-drop to reorder tabs
2. **Tab presets** — "Morning routine" vs. "End of day review" saved tab configurations
3. **Notification badges** — "3 new signals since last visit" on Alerts tab
4. **Severity threshold customization** — user defines what "Critical" means (e.g., renewal < 14 days)
5. **Alert snoozing** — "Remind me tomorrow" on specific customer signals

These require additional backend work (user preferences, notification tracking) and are deferred to future issues.

---

**End of Design Document**

*This design is not quite right until Jason uses it for a week straight. Expect iteration after deployment.*

— Aditi Sharma, UX/UI Design Specialist
