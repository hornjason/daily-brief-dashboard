---
doc-type: specification
status: active
owner: aditi
updated: 2026-05-20
---

# System Health Dashboard — Design Specification

**GitHub Issue:** #339  
**Objective:** Replace 1660-line AdminPage god component with a unified, registry-driven System Health Dashboard

---

## Design Philosophy

The System Health Dashboard is a **dark command-center interface** that answers one question in 30 seconds: **"Is my system healthy?"**

Visual hierarchy guides attention: status dots → summary cards → expandable operations → collapsed settings. Every element follows the established visual language: dark backgrounds, green/yellow/red status indicators, relative timestamps, and consistent component patterns.

This is **not** a feature grid. This is an **operational control surface** for a solo developer who needs to understand system state at a glance and drill into any concern with one click.

---

## Layout Wireframe

```
╔═══════════════════════════════════════════════════════════════════╗
║ System Health Dashboard                                          ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ║
║ │ Compliance  │ │ Scheduled   │ │ Data        │ │ Pre-flight  │ ║
║ │ 61%         │ │ Tasks       │ │ Freshness   │ │ Coverage    │ ║
║ │ 11/18       │ │ 6 tasks     │ │ 12/15 fresh │ │ 11/18       │ ║
║ │ modules     │ │ all idle ●  │ │ 3 stale ●   │ │ modules     │ ║
║ │ ▓▓▓▓▓░░░    │ │             │ │             │ │ ▓▓▓▓▓░░░    │ ║
║ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ ║
║                                                                   ║
║ Scheduled Tasks                                          [Expand] ║
║ ┌─────────────────────────────────────────────────────────────┐  ║
║ │ Name             Type      Schedule        Next Run   State │  ║
║ │ RH Cases         Daily     06:00 daily     in 14h     ● idle│  ║
║ │ Intelligence     Interval  15m interval    in 4m      ● idle│  ║
║ │ L3 Sync          Daily     02:00 daily     in 9h      ● idle│  ║
║ │ CCSP Bookings    Weekly    Mon 04:00       in 2d      ● idle│  ║
║ │ SF Pipeline      Daily     05:00 daily     in 13h     ● idle│  ║
║ │ KPI Snapshot     Daily     23:55 daily     in 4h      ● idle│  ║
║ └─────────────────────────────────────────────────────────────┘  ║
║                                                                   ║
╠═══════════════════════════════════════════════════════════════════╣
║ OPERATIONS                                                        ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║ Data Sources                                         [Refresh All]║
║ ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐         ║
║ │ ● Cases   │ │ ● CCSP    │ │ ● Pipeline│ │ ● News    │         ║
║ │ 2h ago    │ │ 12h ago   │ │ 1d ago    │ │ 5m ago    │         ║
║ │ 847 recs  │ │ 1,243 recs│ │ 52 recs   │ │ 23 recs   │         ║
║ │ [Refresh] │ │ [Refresh] │ │ [Refresh] │ │ [Refresh] │         ║
║ └───────────┘ └───────────┘ └───────────┘ └───────────┘         ║
║                                                                   ║
║ Scraper Health                                      [Collapse] ▴ ║
║ ┌─────────────────────────────────────────────────────────────┐  ║
║ │ Name       State    Last Success     Last Error    [Action] │  ║
║ │ RH Portal  ● idle   2h ago           none          Run Now  │  ║
║ │ CCSP       ● idle   12h ago          none          Run Now  │  ║
║ │ SF Pipe    ● error  1d ago           Auth failed   Run Now  │  ║
║ └─────────────────────────────────────────────────────────────┘  ║
║                                                                   ║
║ Gemini Usage                                        [Collapse] ▴ ║
║ ┌─────────────────────────────────────────────────────────────┐  ║
║ │ Today:    124K input tokens  •  18K output  •  $0.42        │  ║
║ │ Month:    3.2M input tokens  •  487K output •  $11.89       │  ║
║ └─────────────────────────────────────────────────────────────┘  ║
║                                                                   ║
║ Cache Management                                    [Collapse] ▴ ║
║ ┌─────────────────────────────────────────────────────────────┐  ║
║ │ Type         Files    Oldest         [Action]               │  ║
║ │ Screenshots  142      3d ago          Clear                 │  ║
║ │ Intelligence 67       1d ago          Clear                 │  ║
║ │ Gemini       234      7d ago          Clear                 │  ║
║ └─────────────────────────────────────────────────────────────┘  ║
║                                                                   ║
╠═══════════════════════════════════════════════════════════════════╣
║ SETTINGS (collapsed by default)                      [Expand] ▾ ║
╚═══════════════════════════════════════════════════════════════════╝
```

---

## Component Hierarchy

```
SystemHealthDashboard (new root component)
├─ SystemOverviewPanel (always visible)
│  ├─ SummaryCardGrid
│  │  ├─ ComplianceCard
│  │  ├─ ScheduledTasksCard
│  │  ├─ DataFreshnessCard
│  │  └─ PreflightCoverageCard
│  └─ ScheduledTasksTable
│     └─ ScheduledTaskRow (registry-driven, auto-expands)
│
├─ OperationsPanel (expandable sections)
│  ├─ DataSourcesSection
│  │  └─ DataSourceCard (existing DataFreshnessDashboard component cards, reused)
│  ├─ ScraperHealthSection
│  │  └─ ScraperStatusRow (existing ScrapeSection component, adapted)
│  ├─ GeminiUsageSection
│  │  └─ UsageStatCards
│  └─ CacheManagementSection
│     └─ CacheTypeRow
│
└─ SettingsPanel (collapsed by default)
   ├─ AISettingsSection (existing)
   ├─ SchedulerConfigSection (existing SourceScheduleRow components)
   ├─ RegionAccessSection (existing Step0RegionAccess component)
   └─ ConfigBackupSection
```

**Key Architectural Decisions:**

1. **Reuse existing components where possible**
   - `DataSourceCard` from `DataFreshnessDashboard.tsx`
   - `ScrapeSection` from `AdminPage.tsx` (adapt to table row)
   - `Step0RegionAccess` from existing admin page
   - `SourceScheduleRow` for scheduler config

2. **New lightweight components**
   - `SummaryCardGrid` — 4-card layout with consistent sizing
   - `ScheduledTasksTable` — registry-driven, auto-populates from `/api/scheduler/status`
   - `OperationsPanel` — collapsible section container with consistent header pattern

3. **No duplication**
   - Do not create new status indicator patterns — use existing `Circle` from lucide-react
   - Do not create new timestamp formatting — use existing `formatRelTime`
   - Do not create new button patterns — use existing Tailwind classes

---

## Visual Design System

### Color Tokens

**Backgrounds:**
- Page: `bg-gray-900`
- Cards/panels: `bg-gray-800`
- Borders: `border-gray-700`
- Dividers: `border-gray-700`

**Text:**
- Primary: `text-gray-100`
- Secondary: `text-gray-300`
- Tertiary: `text-gray-400`
- Muted: `text-gray-500`

**Status Colors:**
- Healthy/fresh/idle: `text-green-400`, `bg-green-400`
- Warning/stale/running: `text-yellow-400`, `bg-yellow-400`
- Error/critical/failed: `text-red-400`, `bg-red-400`
- Unknown/not-configured: `text-gray-400`, `bg-gray-400`

**Interactive Elements:**
- Primary action: `bg-red-700 hover:bg-red-600`
- Disabled: `opacity-40 disabled:cursor-not-allowed`
- Focus: `focus:outline-none focus:border-gray-400`

### Status Indicator Specification

**Always use filled Circle component from lucide-react:**

```tsx
import { Circle } from 'lucide-react'

// Status dot examples
<Circle className="w-2 h-2 fill-green-400 text-green-400" />   // healthy
<Circle className="w-2 h-2 fill-yellow-400 text-yellow-400" /> // warning
<Circle className="w-2 h-2 fill-red-400 text-red-400" />       // error
<Circle className="w-2 h-2 fill-gray-400 text-gray-400" />     // unknown
```

**Status mapping:**
- `idle` → green
- `running`/`queued` → yellow (with `animate-pulse` on dot)
- `error`/`failed` → red
- `unknown`/not configured → gray

**Never use:**
- Text checkmarks (✓/✗)
- Colored text labels without dot
- Custom badge styles
- Ad-hoc status patterns

### Spacing & Layout

**Grid Systems:**
- Summary cards: 4-column grid on desktop (`grid-cols-4 gap-4`)
- Data source cards: 4-column grid on desktop (`grid-cols-4 gap-4`)
- Tables: full-width with responsive padding

**Card Padding:**
- Standard card: `p-4`
- Dense card (summary): `p-3`
- Table row: `py-2 px-4`

**Gaps:**
- Between cards: `gap-4`
- Between sections: `space-y-6`
- Within card elements: `space-y-2`

**Border Radius:**
- All cards: `rounded-lg`
- Buttons: `rounded`
- Inputs: `rounded`

### Typography

**Font Sizes:**
- Section headers: `text-lg font-medium`
- Card titles: `text-sm font-medium`
- Body text: `text-xs`
- Labels: `text-xs text-gray-400`

**Font Weights:**
- Headers: `font-medium`
- Stats/numbers: `font-medium`
- Body: regular (default)

### Progress Indicators

**Progress Bar (for compliance/coverage percentages):**

```tsx
<div className="w-full bg-gray-700 rounded-full h-2">
  <div 
    className="bg-green-400 h-2 rounded-full transition-all" 
    style={{ width: `${percentage}%` }}
  />
</div>
```

**Pulsing Dot (for indeterminate/running state):**

```tsx
<span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
```

---

## Button Patterns

**Primary Action (Run Now, Refresh, Clear):**

```tsx
<button className="px-3 py-1.5 text-xs font-medium rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors whitespace-nowrap">
  Run Now
</button>
```

**Disabled State:**
- `disabled:opacity-40 disabled:cursor-not-allowed`
- Text changes: "Running…" or "Queued…"

**Icon Buttons (Refresh All):**

```tsx
<button className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded bg-red-700 hover:bg-red-600 text-white">
  <RefreshCw className="w-3.5 h-3.5" />
  Refresh All
</button>
```

**Section Toggle (Expand/Collapse):**

```tsx
<button 
  onClick={() => setExpanded(!expanded)}
  className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1"
>
  {expanded ? 'Collapse' : 'Expand'}
  {expanded ? '▴' : '▾'}
</button>
```

---

## Registry-Driven Auto-Expansion

**How new modules/tasks auto-appear:**

### Scheduled Tasks Table

**Data Source:** `GET /api/scheduler/status`

**Response Shape:**

```json
{
  "tasks": [
    {
      "name": "RH Cases",
      "type": "daily" | "interval" | "weekly",
      "schedule": "06:00 daily",
      "nextRun": "2026-05-21T06:00:00Z",
      "lastRun": "2026-05-20T06:00:00Z" | null,
      "state": "idle" | "running" | "queued" | "error",
      "error": string | null
    }
  ]
}
```

**Rendering Logic:**

```tsx
const { data } = useApi<{ tasks: ScheduledTask[] }>('/api/scheduler/status')

return (
  <table>
    {data?.tasks.map(task => (
      <ScheduledTaskRow key={task.name} task={task} />
    ))}
  </table>
)
```

No hardcoded task list. Tasks auto-populate from API response. When backend adds a new scheduled task, it appears immediately on next fetch.

### Data Sources Grid

**Data Source:** `GET /api/status/freshness`

**Response Shape:**

```json
{
  "sources": [
    {
      "name": "cases",
      "displayName": "Cases",
      "lastChecked": "2026-05-20T09:00:00Z",
      "recordCount": 847,
      "status": "fresh" | "stale" | "critical" | "unknown",
      "state": "idle" | "refreshing" | "queued" | "error",
      "refreshEndpoint": "/api/refresh/cases",
      "error": string | null
    }
  ]
}
```

**Rendering Logic:**

```tsx
const { data } = useApi<{ sources: DataSourceStatus[] }>('/api/status/freshness')

return (
  <div className="grid grid-cols-4 gap-4">
    {data?.sources.map(source => (
      <DataSourceCard key={source.name} source={source} onRefresh={handleRefresh} />
    ))}
  </div>
)
```

No hardcoded source list. Sources auto-populate from API response. When backend registers a new data source via the registry, it appears immediately on next fetch.

### Compliance & Pre-flight Coverage

**Data Source:** `GET /api/module-registry/compliance`

**Response Shape:**

```json
{
  "totalModules": 18,
  "compliantModules": 11,
  "withPreflightChecks": 11,
  "compliancePercentage": 61,
  "preflightCoveragePercentage": 61
}
```

**Rendering Logic:**

```tsx
const { data } = useApi<ModuleCompliance>('/api/module-registry/compliance')

return (
  <div className="bg-gray-800 rounded-lg p-3">
    <div className="text-2xl font-medium">{data?.compliancePercentage}%</div>
    <div className="text-xs text-gray-400">{data?.compliantModules}/{data?.totalModules} modules</div>
    <div className="w-full bg-gray-700 rounded-full h-2 mt-2">
      <div className="bg-green-400 h-2 rounded-full" style={{ width: `${data?.compliancePercentage}%` }} />
    </div>
  </div>
)
```

No hardcoded module counts. Registry-driven — metrics update as modules are added to or removed from the registry.

---

## Accessibility Standards

**Keyboard Navigation:**
- All buttons and interactive elements must be keyboard-accessible
- Tab order follows visual hierarchy: summary cards → tasks table → operations → settings
- Collapsible sections toggle with Enter/Space

**Screen Reader Support:**
- Status dots include `aria-label` or adjacent text label
- Progress bars include `role="progressbar"` with `aria-valuenow`, `aria-valuemin`, `aria-valuemax`
- Buttons have descriptive labels, not just icons

**Color Contrast:**
- All text meets WCAG AA standards against dark backgrounds
- Status colors chosen for sufficient contrast (green-400, yellow-400, red-400 on gray-900)

**Focus Indicators:**
- All interactive elements have visible focus state via `focus:outline-none focus:border-gray-400` or `focus:ring`

---

## Responsive Behavior

**Desktop (≥1024px):**
- Summary cards: 4-column grid
- Data sources: 4-column grid
- Full-width tables with all columns visible

**Tablet (768px - 1023px):**
- Summary cards: 2-column grid
- Data sources: 2-column grid
- Tables: horizontal scroll on overflow

**Mobile (<768px):**
- Summary cards: 1-column stack
- Data sources: 1-column stack
- Tables: collapse to card-style list view

**Implementation Notes:**
- Use Tailwind responsive prefixes: `grid-cols-1 md:grid-cols-2 lg:grid-cols-4`
- Tables use `overflow-x-auto` wrapper on small screens
- Collapsible sections default to collapsed on mobile

---

## Implementation Notes

### File Structure

**New files to create:**

```
dashboard/src/pages/SystemHealthDashboard.tsx    // Root component
dashboard/src/components/SummaryCardGrid.tsx     // 4-card summary layout
dashboard/src/components/ScheduledTasksTable.tsx // Registry-driven tasks table
dashboard/src/components/OperationsPanel.tsx     // Collapsible operations sections
```

**Existing files to adapt:**

```
dashboard/src/components/DataFreshnessDashboard.tsx  // Extract DataSourceCard
dashboard/src/pages/AdminPage.tsx                     // Extract ScrapeSection
```

### Component Extraction Strategy

1. **DataSourceCard** — Extract the card rendering logic from `DataFreshnessDashboard.tsx` into a standalone component. Keep the grid layout in the dashboard, extract individual card to `DataSourceCard.tsx`.

2. **ScraperStatusRow** — Adapt `ScrapeSection` from `AdminPage.tsx` to render as a table row instead of a card. Keep status dot, last run, error display logic.

3. **Reuse SourceScheduleRow** — No changes needed, import directly from `AdminPage.tsx` for scheduler config section.

4. **Reuse Step0RegionAccess** — No changes needed, import directly for region access section.

### API Endpoints Required

**Existing endpoints (already implemented):**
- `GET /api/status/freshness` → Data sources
- `GET /api/status/scrapes` → Scraper health
- `GET /api/admin/gemini-usage` → Gemini usage stats

**New endpoints needed:**
- `GET /api/scheduler/status` → Scheduled tasks list with next run times
- `GET /api/module-registry/compliance` → Module compliance metrics

### Performance Considerations

**Auto-refresh:**
- Summary cards: refresh every 30s via useApi hook
- Data sources: refresh every 30s (existing pattern in DataFreshnessDashboard)
- Scraper status: refresh every 10s when any scraper is running, else 30s

**Lazy Loading:**
- Settings panel: only fetch settings data when user expands the section
- Operations sections: fetch on mount, refresh on user action

**Debouncing:**
- Refresh All button: debounce to prevent multiple rapid clicks
- Cache Clear buttons: confirm before clearing, disable during operation

---

## Migration Path

**Phase 1: Build new components in parallel**
- Create `SystemHealthDashboard.tsx` as new route
- Extract reusable components
- Wire up to existing API endpoints
- Add new endpoints for scheduler status and compliance

**Phase 2: Switch routes**
- Update `App.tsx` routing to use `SystemHealthDashboard` instead of `AdminPage`
- Keep old `AdminPage.tsx` as `AdminPageLegacy.tsx` for one release cycle

**Phase 3: Remove legacy code**
- After one release cycle with no issues, delete `AdminPageLegacy.tsx`
- Clean up any unused components from old admin page

---

## Visual Review Checklist

**Before declaring design complete:**

- [ ] All status dots use `Circle` component with correct fill colors
- [ ] All timestamps use `formatRelTime` helper
- [ ] All buttons follow primary action pattern (bg-red-700 hover:bg-red-600)
- [ ] All cards have consistent padding (p-4 or p-3 for dense)
- [ ] All sections have consistent spacing (space-y-6 between, gap-4 within)
- [ ] All text meets WCAG AA contrast standards
- [ ] All interactive elements have visible focus state
- [ ] All grids use responsive breakpoints (grid-cols-1 md:grid-cols-2 lg:grid-cols-4)
- [ ] All registry-driven lists auto-populate from API (no hardcoded data)
- [ ] All collapsible sections have clear expand/collapse affordances

---

## Summary

This design consolidates 14 scattered admin sections into **one unified System Health Dashboard** with three clear panels: System Overview (always visible), Operations (expandable), and Settings (collapsed by default).

**Core design principles:**
1. **Visual hierarchy** — status dots → summary cards → details
2. **Registry-driven** — all lists auto-populate from API, no hardcoded data
3. **Consistent patterns** — reuse existing components, colors, spacing
4. **Accessibility-first** — WCAG AA contrast, keyboard nav, screen reader support
5. **Dark command-center aesthetic** — matches existing dashboard theme

The solo developer sees **system health in 30 seconds**: green dots mean healthy, yellow dots mean check it, red dots mean fix it. One click drills into any concern. No hunting through scattered sections.

**Next step:** Marcus implements the component hierarchy, wires up API endpoints, and verifies with Quinn on the test container (7776).
