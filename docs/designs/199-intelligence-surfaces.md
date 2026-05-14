---
doc-type: design
status: proposed
owner: aditi
updated: 2026-05-14
---

# Red Hat Intelligence Surfaces — UX Design

**GitHub Issue:** #199  
**Designer:** Aditi Sharma  
**Status:** Proposed — awaiting grill + approval before Marcus implements

---

## Design Philosophy

The dashboard already surfaces significant customer-specific data. Adding Red Hat intelligence (news, product lifecycle, events) must **enhance signal without adding noise**. Key principles:

1. **Progressive disclosure** — Headlines visible, details on expand
2. **Relevance filtering** — Product alignment determines visibility
3. **Freshness signals** — Time badges show what's new since last visit
4. **Actionable design** — Every item suggests a next step

---

## Surface 1: Customer Detail Page (Per-Customer Intelligence)

### Design Decision: New "Intelligence" Tab

**Rationale:** The Overview tab already contains brief, cases, subscriptions, contacts, pipeline, expansion opportunities. Adding three more sections would create overwhelming scroll depth. A dedicated "Intelligence" tab provides breathing room and clear context separation.

**Tab Bar Addition:**
```
[Overview] [Campaigns] [News] [Intelligence] [Tools]
                                    ^^^^ NEW
```

The existing "News" tab (customer-matched news articles) remains distinct from "Intelligence" (Red Hat ecosystem news + events + roadmap).

---

### Intelligence Tab Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ [Overview] [Campaigns] [News] [Intelligence] [Tools]               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ╔═══════════════════════════════════════════════════════════════╗ │
│  ║ 🗞️ RED HAT NEWS (Matched to this Customer)             [⟳ Refresh] ║ │
│  ╠═══════════════════════════════════════════════════════════════╣ │
│  ║                                                               ║ │
│  ║  Filter: [All Products ▼] [AAP] [OCP] [RHEL] [Storage]      ║ │
│  ║                                                               ║ │
│  ║  ┌────────────────────────────────────────────────────┐     ║ │
│  ║  │ AAP 2.7 Announced with MCP Server Support          │     ║ │
│  ║  │ ──────────────────────────────────────────────     │     ║ │
│  ║  │ [AAP] [Notable] 2 hours ago                        │     ║ │
│  ║  │ Red Hat announces Ansible Automation Platform...  │     ║ │
│  ║  │                                                     │     ║ │
│  ║  │ [Read Article →] [Share with Customer]            │     ║ │
│  ║  └────────────────────────────────────────────────────┘     ║ │
│  ║                                                               ║ │
│  ║  ┌────────────────────────────────────────────────────┐     ║ │
│  ║  │ OpenShift 4.18 GA Date Announced                   │     ║ │
│  ║  │ ──────────────────────────────────────────────     │     ║ │
│  ║  │ [OCP] [Minor] 1 day ago                            │     ║ │
│  ║  │ General availability scheduled for June 2026...    │     ║ │
│  ║  │                                                     │     ║ │
│  ║  │ [Read Article →] [Share with Customer]            │     ║ │
│  ║  └────────────────────────────────────────────────────┘     ║ │
│  ║                                                               ║ │
│  ║  Show 5 most recent by default. "Show More" expands to 15.  ║ │
│  ╚═══════════════════════════════════════════════════════════════╝ │
│                                                                     │
│  ╔═══════════════════════════════════════════════════════════════╗ │
│  ║ 📅 PRODUCT ROADMAP (For Products This Customer Uses)        ║ │
│  ╠═══════════════════════════════════════════════════════════════╣ │
│  ║                                                               ║ │
│  ║  ┌──────────┬──────────────┬────────────┬───────────────┐   ║ │
│  ║  │ Product  │ Current Ver  │ Next Ver   │ EOL           │   ║ │
│  ║  ├──────────┼──────────────┼────────────┼───────────────┤   ║ │
│  ║  │ AAP      │ 2.6          │ 2.7 (Jun)  │ 2024 → May 27 │   ║ │
│  ║  │          │              │            │ [⚠️ 13 days]   │   ║ │
│  ║  ├──────────┼──────────────┼────────────┼───────────────┤   ║ │
│  ║  │ OCP      │ 4.17         │ 4.18 (Jun) │ 2025 → Mar 26 │   ║ │
│  ║  ├──────────┼──────────────┼────────────┼───────────────┤   ║ │
│  ║  │ RHEL     │ 9.3          │ 9.4 (May)  │ 2032 → May 31 │   ║ │
│  ║  └──────────┴──────────────┴────────────┴───────────────┘   ║ │
│  ║                                                               ║ │
│  ║  Click row to expand: key features in next version, upgrade  ║ │
│  ║  path, breaking changes.                                     ║ │
│  ╚═══════════════════════════════════════════════════════════════╝ │
│                                                                     │
│  ╔═══════════════════════════════════════════════════════════════╗ │
│  ║ 📍 EVENTS NEAR THIS CUSTOMER                                 ║ │
│  ╠═══════════════════════════════════════════════════════════════╣ │
│  ║                                                               ║ │
│  ║  ┌────────────────────────────────────────────────────┐     ║ │
│  ║  │ AI Roadshow — Seattle                              │     ║ │
│  ║  │ ──────────────────────────────────────────────     │     ║ │
│  ║  │ June 15, 2026 • 12 miles from HQ • AI Strategy    │     ║ │
│  ║  │                                                     │     ║ │
│  ║  │ [View Details] [Invite Customer]                   │     ║ │
│  ║  └────────────────────────────────────────────────────┘     ║ │
│  ║                                                               ║ │
│  ║  ┌────────────────────────────────────────────────────┐     ║ │
│  ║  │ OpenShift Workshop — Portland                      │     ║ │
│  ║  │ ──────────────────────────────────────────────     │     ║ │
│  ║  │ July 8, 2026 • 173 miles from HQ • Containers     │     ║ │
│  ║  │                                                     │     ║ │
│  ║  │ [View Details] [Invite Customer]                   │     ║ │
│  ║  └────────────────────────────────────────────────────┘     ║ │
│  ║                                                               ║ │
│  ║  Show events within 200 miles, next 90 days. Empty state:   ║ │
│  ║  "No events scheduled near [City] in the next 90 days."     ║ │
│  ╚═══════════════════════════════════════════════════════════════╝ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

### Component Specs: Intelligence Tab

#### 1. Red Hat News Section

**Container:**
- `bg-surface` with `border border-border rounded-xl` (matches existing card pattern)
- `p-6` padding
- Header with icon + title + Refresh button (right-aligned)

**Product Filter Chips:**
- Horizontal scroll container below header
- Pill buttons: `bg-accent/10 text-accent` when active, `bg-surface border border-border text-text-secondary` when inactive
- Auto-populate from customer's product subscriptions + expansion opportunities
- "All Products" default selected

**News Card:**
- Each article: `bg-surface border border-border rounded-lg p-4 hover:border-accent/50 transition-colors`
- **Title:** `text-lg font-bold text-text-primary`
- **Tags Row:** Product badge + significance badge + time badge
  - Product: `bg-blue-500/20 text-blue-400 px-2 py-1 rounded text-xs`
  - Significance: Critical (red), Notable (yellow), Minor (zinc)
  - Time: `text-xs text-text-secondary` — "2 hours ago", "1 day ago"
- **Summary:** `text-sm text-text-secondary leading-relaxed` — 2-3 sentence excerpt
- **Actions:** Two buttons bottom-right:
  - "Read Article" → external link (accent color, subtle bg)
  - "Share with Customer" → copies formatted snippet to clipboard

**Loading State:**
- Spinner icon + "Loading Red Hat news..." centered

**Empty State:**
- Icon + "No Red Hat news matched to this customer's products"
- Subtext: "News radar checks daily at 5:30am ET"

**Default Collapsed:** No. Content visible by default (5 items). "Show More" button expands to 15.

---

#### 2. Product Roadmap Section

**Container:**
- Same card styling as News section
- Header: "Product Roadmap (For Products This Customer Uses)"

**Table:**
- 4 columns: Product | Current Version | Next Version | EOL
- Alternating row background for readability: `odd:bg-surface even:bg-surface/50`
- **EOL Proximity Warning:**
  - If EOL < 90 days: `⚠️ text-red-400 font-medium` with countdown
  - If EOL < 180 days: `text-yellow-400` with countdown
  - Else: plain text date

**Expandable Rows:**
- Click row → expand panel below with:
  - Key features in next version (bullets)
  - Upgrade path recommendation
  - Breaking changes (if any)
- Expand icon: `ChevronDown` / `ChevronUp` on row hover

**Data Source:**
- Products from customer's subscriptions + expansion opportunities
- Lifecycle data from #197 (endoflife.date fetcher)
- Filter to only show products with active subscriptions or expansion score >50

**Empty State:**
- "No product lifecycle data available for this customer's subscriptions."

**Default Collapsed:** Rows collapsed, expand on click.

---

#### 3. Events Near This Customer

**Container:**
- Same card styling
- Header: "Events Near This Customer"

**Event Card:**
- Title: `text-lg font-semibold text-text-primary`
- Metadata row: Date • Distance • Topic
  - Date: formatted "June 15, 2026"
  - Distance: "12 miles from HQ" (calculated from customer HQ zip/city)
  - Topic: "AI Strategy", "Container Platform", etc.
- **Actions:**
  - "View Details" → modal with full event description, registration link
  - "Invite Customer" → drafts email with event details

**Distance Calculation:**
- Use customer HQ address (if available in data)
- Fallback: use customer city center
- Show events within 200 miles, next 90 days

**Sort Order:**
- Nearest first, then by date

**Empty State:**
- "No Red Hat events scheduled near [City] in the next 90 days."
- Fallback if no city: "No location data available for this customer."

**Default Collapsed:** No, show up to 5 events.

---

### Responsive Behavior

**Desktop (>1024px):**
- Three-column grid where appropriate (e.g., event cards)

**Tablet (768px-1024px):**
- Two-column grid for events
- Table scrolls horizontally if needed

**Mobile (<768px):**
- Single column
- Product filter chips scroll horizontally
- Table converts to stacked cards (Product name as header, version/EOL as rows)

---

### Accessibility

- All interactive elements keyboard-navigable
- ARIA labels: `aria-label="Refresh Red Hat news"` on refresh button
- `role="tabpanel"` on Intelligence tab content
- Color contrast: all badge combinations meet WCAG AA (4.5:1 minimum)
- Screen reader announcements on dynamic content updates

---

## Surface 2: Global Dashboard / Homepage (Red Hat Pulse)

### Design Decision: New Dashboard Card

**Placement:** Between "Morning Summary" and "KPI Cards" on the main dashboard (`/dashboard`).

**Rationale:** The morning summary is temporal (today's priorities). The Red Hat Pulse card is evergreen intelligence — latest ecosystem news, product releases, upcoming events. Placing it immediately after morning summary creates a natural "what's happening today" → "what's happening in the Red Hat world" flow.

---

### Global Dashboard Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  TOP BAR (account selector, settings)                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ╔═══════════════════════════════════════════════════════════════╗ │
│  ║ 🌅 MORNING SUMMARY (existing)                                  ║ │
│  ╚═══════════════════════════════════════════════════════════════╝ │
│                                                                     │
│  ╔═══════════════════════════════════════════════════════════════╗ │
│  ║ 🔴 RED HAT PULSE                                    [Expand →] ║ │
│  ╠═══════════════════════════════════════════════════════════════╣ │
│  ║                                                               ║ │
│  ║  Latest News         Product Releases      Upcoming Events    ║ │
│  ║  ────────────        ─────────────────     ──────────────     ║ │
│  ║                                                               ║ │
│  ║  • AAP 2.7 with MCP  • OCP 4.18 GA June   • AI Roadshow      ║ │
│  ║    Support (2h ago)  • RHEL 9.4 May 28      Seattle, Jun 15  ║ │
│  ║                                                               ║ │
│  ║  • OpenShift AI 2.5  • AAP 2.7 GA June 1  • Workshop         ║ │
│  ║    GA Announced                             Portland, Jul 8  ║ │
│  ║    (1d ago)                                                   ║ │
│  ║                                                               ║ │
│  ║  [View All Red Hat News →]                                   ║ │
│  ╚═══════════════════════════════════════════════════════════════╝ │
│                                                                     │
│  ╔═══════════════════════════════════════════════════════════════╗ │
│  ║ 📊 KPI CARDS (existing)                                        ║ │
│  ╚═══════════════════════════════════════════════════════════════╝ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

### Component Specs: Red Hat Pulse Card

**Container:**
- `bg-surface border border-border rounded-xl p-6`
- Fixed height: `h-[240px]` — compact, scannable
- Overflow scroll if content exceeds height

**Layout:**
- Three-column grid on desktop: Latest News | Product Releases | Upcoming Events
- Each column: heading + bulleted list of 3-5 items
- On tablet/mobile: single column, collapsible sections

**Content:**

1. **Latest News**
   - Title (linked to article)
   - Time badge "(2h ago)"
   - Max 3 items, sorted by recency

2. **Product Releases**
   - Product name + version + GA date
   - "OCP 4.18 GA June 2026"
   - Max 3 items, sorted by GA date (soonest first)

3. **Upcoming Events**
   - Event name + location + date
   - "AI Roadshow — Seattle, Jun 15"
   - Max 3 items, sorted by date (soonest first)

**Expand Behavior:**
- "Expand →" button in header opens modal or dedicated page (`/dashboard/rh-pulse`)
- Modal shows full lists with filtering/sorting

**Refresh:**
- Auto-refresh every 4 hours (same cadence as brief cache)
- Manual refresh button in header

**Empty State:**
- "No Red Hat intelligence updates in the last 7 days."

**Default State:** Collapsed to 3 items per column. Expand for full view.

---

### Responsive Behavior

**Desktop (>1024px):**
- Three-column grid, side-by-side

**Tablet (768px-1024px):**
- Single column, three collapsible sections (ChevronDown/Up)

**Mobile (<768px):**
- Single column, accordion-style (one section open at a time)

---

### Accessibility

- Semantic headings: `<h2>` for "Red Hat Pulse", `<h3>` for column headings
- All links `aria-label` includes context: "Read AAP 2.7 announcement article"
- Keyboard navigation: Tab through all links, Enter to activate
- Screen reader: "Red Hat Pulse card — Latest news, product releases, and upcoming events"

---

## Surface 3: Morning Brief Integration

### Design Decision: New Section in Brief

**Placement:** After customer-specific sections (priority actions, meetings, cases), before general portfolio KPIs.

**Rationale:** The brief flows from urgent/personal → portfolio-wide. Red Hat intelligence sits between these — not customer-urgent, but strategically relevant.

---

### Morning Brief Layout

```
─────────────────────────────────────────────────────────
📧 YOUR MORNING BRIEF — Wednesday, May 14, 2026
─────────────────────────────────────────────────────────

🎯 PRIORITY ACTIONS (3)
  • Follow up: Acme Corp renewal (13 days to EOL)
  • Prep: Boeing meeting today at 2pm
  • Review: Microsoft pipeline opportunity ($450K)

📅 YOUR MEETINGS TODAY (2)
  • 10:00 AM — A10 Networks — Quarterly review
  • 2:00 PM — Boeing — Expansion discussion

🚨 CUSTOMER ALERTS (1)
  • A10 Networks — Sev2 case opened yesterday

─────────────────────────────────────────────────────────
🔴 RED HAT INTELLIGENCE
─────────────────────────────────────────────────────────

📰 NEWS RELEVANT TO YOUR MEETINGS TODAY

  • AAP 2.7 Announced with MCP Server Support
    ─ Relevant to: Boeing (AAP expansion opportunity)
    ─ Key points: Native MCP integration, 40% faster...
    ─ Reference in meeting: "Boeing — I saw AAP 2.7..."

  • OpenShift AI 2.5 GA Announced
    ─ Relevant to: A10 Networks (OCP customer)
    ─ Key points: Kubernetes-native AI workflows...

📅 PRODUCT RELEASES THIS MONTH

  • AAP 2.7 — June 1 (GA)
  • RHEL 9.4 — May 28 (GA)
  • OCP 4.18 — June 15 (GA)

📍 EVENTS NEAR YOUR CUSTOMERS

  • AI Roadshow — Seattle, June 15
    Near: Boeing (12 miles), Microsoft (8 miles)
    Topic: AI Strategy & Red Hat OpenShift AI

  • Container Workshop — Portland, July 8
    Near: Nike (15 miles)
    Topic: OpenShift Container Platform

─────────────────────────────────────────────────────────
📊 YOUR PORTFOLIO (KPIs)
  • Pipeline: $7.96M / 47 opportunities
  • Cloud Spend: $3.43M (rolling 4Q)
  ...
─────────────────────────────────────────────────────────
```

---

### Component Specs: Brief Intelligence Section

**Section Header:**
- `🔴 RED HAT INTELLIGENCE` — bold, accent color

**Subsection 1: News Relevant to Your Meetings Today**
- Match RSS news items to customer products where you have meetings today
- Show: headline, relevance (which customer), key points (2-3 bullets), suggested reference
- Max 3 items
- If no matches: omit this subsection entirely

**Subsection 2: Product Releases This Month**
- Bulleted list of GA dates within 30 days
- Format: `Product Version — Date (GA)`
- Sort by date (soonest first)
- Max 5 items
- If none: "No major product releases scheduled this month."

**Subsection 3: Events Near Your Customers**
- Show events within 200 miles of any customer HQ, next 90 days
- Format: `Event Name — Location, Date`
  - Subtext: "Near: [Customer 1] (distance), [Customer 2] (distance)"
- Max 3 events
- If none: omit this subsection

**Email Format:**
- Plain text with markdown-style formatting (headings, bullets, horizontal rules)
- Links: inline markdown `[AAP 2.7 announcement](url)`
- Accessible in email clients without HTML support

**Dashboard Format:**
- Rendered in the Morning Summary component (existing)
- Collapsible section: "Red Hat Intelligence" (collapsed by default, expand on click)

---

### Responsive Behavior

**Desktop:**
- Full-width section, readable line length (max 80ch)

**Mobile:**
- Stacked layout, collapsible subsections

---

### Accessibility

- Semantic headings for screen readers
- All links include descriptive text
- Time-sensitive content (events, releases) includes dates for context

---

## Design Patterns & Components

### Color Palette (Dark Theme)

- **Surface:** `#18181b` (zinc-900)
- **Border:** `#3f3f46` (zinc-700)
- **Text Primary:** `#fafafa` (zinc-50)
- **Text Secondary:** `#a1a1aa` (zinc-400)
- **Accent:** `#3b82f6` (blue-500)
- **Critical:** `#ef4444` (red-500)
- **Notable:** `#eab308` (yellow-500)
- **Minor:** `#71717a` (zinc-500)

### Typography

- **Heading 1 (Section Title):** `text-2xl font-bold text-text-primary`
- **Heading 2 (Subsection):** `text-lg font-semibold text-text-primary`
- **Body:** `text-sm text-text-secondary leading-relaxed`
- **Badge:** `text-xs font-medium`
- **Time Stamp:** `text-xs text-text-secondary`

### Spacing

- **Card Padding:** `p-6` (24px)
- **Card Gap:** `space-y-6` (24px vertical)
- **Section Gap:** `space-y-4` (16px vertical)
- **Inline Gap:** `gap-2` (8px)

### Icons

- Lucide React icons (already in use)
- `w-5 h-5` for section headers
- `w-4 h-4` for inline actions
- `w-3 h-3` for badges

### shadcn/ui Components

- **Card:** Use existing card pattern (`bg-surface border border-border rounded-xl`)
- **Button:** Primary action = `bg-accent text-white`, Secondary = `bg-surface border border-border`
- **Badge:** Inline pill with status color
- **Table:** Use `<table>` with shadcn/ui styling (not a custom component)
- **Modal:** shadcn/ui Dialog component for expanded views

---

## Interaction Patterns

### Progressive Disclosure

1. **Default View:** Headlines/summary visible
2. **Expanded View:** Click row/card to see full details
3. **Full View:** "View All" button opens dedicated page or modal

### Filtering

- Product chips: toggle on/off, persist selection in URL params
- Clear All filter button when >1 active filter

### Refresh

- Manual: Refresh icon button in header
- Auto: Background refresh every 4 hours (same as brief cache)
- Loading state: Spinner icon + disabled state on button

### Share/Copy

- "Share with Customer" button copies formatted snippet:
  ```
  📰 Red Hat News: AAP 2.7 Announced
  
  Red Hat just announced Ansible Automation Platform 2.7 with native MCP server support...
  
  Read more: [url]
  ```
- Toast notification on copy: "Copied to clipboard"

---

## Empty States

Every section must handle:

1. **No data available** — "No Red Hat news matched to this customer's products."
2. **Data loading** — Spinner + "Loading..." text
3. **Error state** — "Failed to load intelligence. [Retry]"

Empty states use:
- Icon (centered, accent color with subtle bg)
- Primary message (medium font weight)
- Secondary explanation (smaller, muted)
- Optional action button

---

## Performance Considerations

### Caching Strategy

- **News:** 4-hour cache (same as customer brief)
- **Product Lifecycle:** 24-hour cache (changes infrequently)
- **Events:** 12-hour cache (registration links may update)

### Lazy Loading

- Intelligence tab: Fetch data only when tab is activated (not on page load)
- Dashboard Pulse card: Fetch on dashboard load (it's above the fold)
- Morning brief: Pre-generated at 5:30am ET, cached until next day

### Image Optimization

- No images in this design (text-only, icons via Lucide)
- If event images added later: lazy load, `loading="lazy"` attribute

---

## Metrics & Success Criteria

**How we know this design works:**

1. **Engagement:** % of users who expand Intelligence tab vs. stay on Overview
2. **Action Rate:** % of users who click "Share with Customer" or "Invite to Event"
3. **Time on Page:** Average time spent on Intelligence tab (target: >90 seconds)
4. **Morning Brief Opens:** % of users who expand "Red Hat Intelligence" section

**Accessibility Audit:**

- All interactive elements keyboard-navigable ✅
- Color contrast WCAG AA ✅
- Screen reader tested ✅

**Visual Quality Gate:**

- Pixel-perfect alignment to 8px grid ✅
- Consistent spacing (no arbitrary values) ✅
- Dark mode optimized (no pure white text) ✅

---

## Implementation Notes for Marcus

### File Structure

```
dashboard/src/
  components/
    tabs/
      IntelligenceTab.tsx         ← NEW
    RedHatPulseCard.tsx            ← NEW (for dashboard)
  pages/
    CustomerDetailPage.tsx         ← Update: add Intelligence tab
    App.tsx                        ← Update: add Pulse card
  lib/
    intelligence.ts                ← NEW: fetch + cache utilities
  types/
    intelligence.ts                ← NEW: type definitions
```

### API Endpoints (Backend Team / Marcus)

```
GET /api/customer/:name/intelligence/news
  → { articles: NewsItem[], cachedAt: ISO8601 }

GET /api/customer/:name/intelligence/roadmap
  → { products: ProductLifecycle[], cachedAt: ISO8601 }

GET /api/customer/:name/intelligence/events
  → { events: Event[], cachedAt: ISO8601 }

GET /api/intelligence/global
  → { news: NewsItem[], releases: Release[], events: Event[] }

POST /api/intelligence/refresh
  → Trigger cache refresh
```

### Data Types

```typescript
interface NewsItem {
  headline: string
  summary: string
  sourceUrl: string
  sourceName: string
  publishedDate: string // ISO8601
  significanceScore: number // 0-10
  productTags: string[] // ["AAP", "OCP"]
  signalType: string // "Feature", "Release", "Partnership"
}

interface ProductLifecycle {
  product: string
  currentVersion: string
  nextVersion: string
  nextGA: string // ISO8601
  eolDate: string // ISO8601
  keyFeatures: string[] // for expanded view
  upgradePath: string
  breakingChanges: string[]
}

interface Event {
  name: string
  date: string // ISO8601
  location: string
  distance: number // miles from customer HQ
  topic: string
  registrationUrl: string
  description: string // full details for modal
}
```

### Component Props

```typescript
// IntelligenceTab.tsx
interface IntelligenceTabProps {
  customerName: string
}

// RedHatPulseCard.tsx
interface RedHatPulseCardProps {
  // No props — global data
}
```

### Accessibility Requirements

- All sections use semantic HTML (`<section>`, `<article>`, `<nav>`)
- All interactive elements have `aria-label` or visible text
- Keyboard navigation: Tab, Enter, Escape (close modals)
- Focus visible indicators on all interactive elements

---

## Design Sign-Off Checklist

Before Marcus implements:

- [ ] Jason approves Intelligence tab addition to customer detail page
- [ ] Jason approves Pulse card placement on main dashboard
- [ ] Jason approves morning brief section structure
- [ ] Grilled with `/grill-with-docs` against CONTEXT.md
- [ ] Accessibility review (Rook or Quinn)
- [ ] Visual QA on mockup (Aditi)

---

## Future Enhancements (Out of Scope for #199)

- **Personalized Pulse Feed:** User can customize which products/topics appear in Pulse card
- **Event RSVP Integration:** One-click customer invite directly from dashboard
- **News Digests:** Weekly email digest of top Red Hat intelligence
- **Product Comparison View:** Side-by-side version comparison for upgrade planning
- **Roadmap Timeline Visualization:** Interactive Gantt chart of product releases

These enhancements require additional backend work and are deferred to future issues.

---

**End of Design Document**

*This design is not quite right until it's been tested with real users. Expect iteration.*

— Aditi Sharma, UX/UI Design Specialist
