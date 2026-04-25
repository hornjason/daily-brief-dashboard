---
Last validated: 2026-04-24
---

# DailyBriefDashboard Information Architecture v2

**Author:** Serena Blackwood, PAI System Design
**Date:** 2026-04-01
**Scope:** UI/UX redesign incorporating BKL-R01 through BKL-R09 research features
**Status:** Architecture specification — no code

---

## 1. Page Hierarchy & Navigation

### Current Structure
```
/dashboard          → Dashboard (single scrolling page: KPIs → Pipeline → Cloud → Calendar → Accounts)
/dashboard/customer/:name → CustomerDetailPage
/dashboard/setup    → SetupPage
/admin              → AdminPage
```

### SA Daily Workflow (Three Modes)

The SA uses this tool in three distinct modes across the day. The navigation and information hierarchy must serve all three without friction.

**Mode 1: Morning Review (7:00-7:30 AM)**
Open dashboard → scan Morning Summary → check health triage → identify action items → done in 5 minutes.

**Mode 2: Meeting Prep (ad hoc, 5-15 min before meetings)**
Click meeting in calendar or customer name → scan priority action → review brief → check cases → join meeting.

**Mode 3: Account Deep Dive (as needed, 10-30 min)**
Navigate to customer → review full brief with temporal delta → check sparkline trends → review stakeholder engagement → plan follow-up.

### Redesigned Navigation

The sidebar navigation stays as scroll-spy anchors (current pattern works well for a single-page dashboard). No new routes needed. The key change is **section reordering** on the portfolio page and **content additions** to the customer detail page.

**Sidebar items (revised order):**
```
[AC] ASA Command Center

  Morning Summary     → #section-morning     (NEW)
  Command Center      → #section-command      (KPIs + health triage)
  Pipeline            → #section-pipeline
  Cloud Spend         → #section-cloudspend
  Calendar            → #section-calendar
  Accounts            → #section-accounts

  Settings
  Setup
```

Morning Summary replaces the old "Command Center" as the first scroll target. KPIs move to position 2 under the "Command Center" label. The SA's first glance hits the morning summary, not raw KPI numbers.

---

## 2. Portfolio Page (Home) Redesign

### Current Layout (top to bottom)
```
TopBar (date, weather, refresh, last synced)
Scrape status dots
KPI Cards (7 cards in a row)
Pipeline Section (3-col grid)
Cloud Spend Section (3-col grid)
Calendar Strip (today/week/full toggle)
Account Portfolio Grid (search, filter, view modes)
```

### Redesigned Layout (top to bottom)

```
+------------------------------------------------------------------+
| TopBar: date, weather, refresh, last synced                      |
+------------------------------------------------------------------+
| Scrape status dots (unchanged)                                   |
+==================================================================+
|                                                                  |
| SECTION: MORNING SUMMARY (#section-morning)               [NEW] |
| +--------------------------------------------------------------+ |
| | MorningSummaryCard                                            | |
| |                                                               | |
| | "Good morning. 2 accounts need attention today."              | |
| |                                                               | |
| | PRIORITY ACTIONS          | TOP SIGNALS                      | |
| | 1. [R] Acme: Sev1 case   | * CCSP ACV up 12% (Contoso)     | |
| |    opened 2h ago          | * Renewal in 8d (Fabrikam/RHEL)  | |
| | 2. [Y] Contoso: renewal   | * No meetings in 21d (Initech)   | |
| |    in 8 days, no meeting  | * Pipeline opp closing Apr 9     | |
| |    scheduled              | * Competitor mention: VMware →   | |
| | 3. Prep for 10am Initech  |   Contoso eval (from email)      | |
| |    meeting                |                                   | |
| +--------------------------------------------------------------+ |
|                                                                  |
| SECTION: COMMAND CENTER (#section-command)                       |
| +--------------------------------------------------------------+ |
| | KPI Cards row (7 cards, unchanged)                            | |
| | + NEW: sparkline under each KPI value (64x24 inline SVG)     | |
| | Each card shows 30-day trend line beneath the number          | |
| +--------------------------------------------------------------+ |
|                                                                  |
| SECTION: PIPELINE (#section-pipeline)                            |
| (unchanged — 3-col grid: totals+stage | by owner | top opps)    |
|                                                                  |
| SECTION: CLOUD SPEND (#section-cloudspend)                       |
| (unchanged — 3-col grid: totals+partner | donut | top accounts) |
|                                                                  |
| SECTION: CALENDAR (#section-calendar)                            |
| (unchanged — today/week/full toggle with prep cards)             |
|                                                                  |
| SECTION: ACCOUNTS (#section-accounts)                            |
| +--------------------------------------------------------------+ |
| | Account Portfolio Grid                                        | |
| | Search | AE filter | View: All | By AE | Triage | [Health]  | |
| |                                                               | |
| | Triage view now uses REAL health scores (R01) not just cases  | |
| | Each AccountCard gets:                                        | |
| |   - HealthDot (weighted composite) replaces case-only dot     | |
| |   - Sparkline for cloud ACV under the card stats              | |
| |   - Priority action one-liner at the bottom                   | |
| +--------------------------------------------------------------+ |
+------------------------------------------------------------------+
```

### Visual Hierarchy — What the SA Sees First

1. **Morning Summary card** — full-width, prominent. Colored priority action badges draw the eye. This is the "newspaper front page" for the day.
2. **KPI row with sparklines** — numbers tell current state, sparklines tell direction. A rising Sev1 sparkline is more alarming than a flat one.
3. **Account grid in triage mode** — health dots now reflect composite score, not just case count. Red accounts surface automatically.

### Morning Summary Card — Detailed Wireframe

```
+------------------------------------------------------------------+
| [Sun icon] Good morning, Jason.  Tuesday, April 1 2026           |
|                                                                  |
| 3 accounts need attention  ·  2 meetings today  ·  1 renewal    |
|                              closing this week                   |
|                                                                  |
| +------- PRIORITY ACTIONS --------+  +---- TOP SIGNALS ---------+|
| |                                 |  |                           ||
| | [R dot] Acme Corp               |  | [up arrow] CCSP ACV      ||
| | Sev1 case #12345 opened 2h ago  |  | +12% Contoso ($14K→$16K) ||
| | → Review case & schedule call   |  |                           ||
| |                                 |  | [clock] Gone silent       ||
| | [Y dot] Fabrikam                |  | No contact in 21d:        ||
| | RHEL renewal in 8 days —        |  | Initech (was weekly)      ||
| | no meeting scheduled            |  |                           ||
| | → Schedule renewal discussion   |  | [flag] Competitor         ||
| |                                 |  | VMware mentioned in       ||
| | [B dot] Initech meeting 10am   |  | Contoso email thread      ||
| | Brief ready · 2 talking points  |  |                           ||
| | → Review brief before meeting   |  | [triangle] Pipeline       ||
| +------- clickable per-item ------+  | 2 opps closing this week  ||
|                                      +---------------------------+|
+------------------------------------------------------------------+
```

**Priority Actions** (left column, max 5):
- Sorted by urgency: Sev1 cases > expiring renewals (<30d) > meetings today > health-yellow accounts with no recent contact > stale pipeline
- Each item: HealthDot + customer name + one-line reason + one-line suggested action
- Clicking an item navigates to `/dashboard/customer/:name`

**Top Signals** (right column, max 5-10):
- Cross-portfolio signals that changed since yesterday
- Categories: CCSP delta, engagement gone-silent, competitor mentions, pipeline movement, new cases, renewal milestones
- Uses ▲/▼ delta markers from R06

### KPI Cards with Sparklines

The existing `KPICard` component adds an optional `sparkline` prop:

```
+---------------------------+
|  [icon]   42              |
|           ~~~~~/\~~~      |  ← 64x24 inline SVG sparkline
|           Open Cases      |
|           Synced 2h ago   |
+---------------------------+
```

The sparkline shows 30-day daily values. For KPIs that don't have historical data yet, the sparkline area is simply absent (graceful degradation). The data comes from a new `/api/kpis/history` endpoint that returns `{ metric: string, values: { date: string, value: number }[] }[]`.

---

## 3. Customer Detail Page Redesign

### Current Layout
```
Back button + Customer name + segment + AE badge
Health dot + account numbers + account count pill
Stats row: open cases | products | licenses | cloud ACV | pipeline ACV | next meeting
BriefSection (AI-generated brief, expandable)
2-col layout:
  Left: ActivityTimeline (meetings, emails, docs)
  Right: CasesSection + Products table
CCSP bar chart (if data exists)
Pipeline opps list (if data exists)
```

### Redesigned Layout

```
+------------------------------------------------------------------+
| ← Back to Dashboard                                              |
|                                                                  |
| HEADER (BKL-UX02 redesign)                                      |
| +--------------------------------------------------------------+ |
| | [G dot] Contoso Ltd                           Enterprise | AE | |
| | Health: 78/100 (Good)  ·  Acct #443261, #512890              | |
| |                                                               | |
| | +----------+----------+----------+----------+----------+----+ | |
| | | Cases    | Products | Licenses | Cloud$   | Pipeline | Mtg| | |
| | | 3        | 12       | 2,400    | $16.2K   | $892K    | 2d | | |
| | | ~sparkl~ | ~sparkl~ |          | ~sparkl~ | ~sparkl~ |    | | |
| | +----------+----------+----------+----------+----------+----+ | |
| +--------------------------------------------------------------+ |
|                                                                  |
| PRIORITY ACTION CARD (NEW — R03)                                 |
| +--------------------------------------------------------------+ |
| | [!] PRIORITY: Schedule renewal discussion                     | |
| | RHEL Platform subscription expires in 8 days (Apr 9).         | |
| | No renewal meeting scheduled. Last contact: Mar 15.           | |
| | [Schedule Meeting]  [View Subscription]  [Dismiss]            | |
| +--------------------------------------------------------------+ |
|                                                                  |
| BRIEF SECTION (redesigned — R02, R06, R07, R09)                 |
| +--------------------------------------------------------------+ |
| | [sparkle] Account Brief          cached 3h ago | [Regenerate]| |
| |                                                               | |
| | -- WHAT CHANGED SINCE LAST INTERACTION (Mar 15) -- (R02)     | |
| | ▲ New Sev2 case #67890 opened Mar 28 (RHEL networking)       | |
| | ▲ CCSP ACV increased $1,800 (AWS spend up)                   | |
| | ▲ Pipeline opp "RHEL expansion" moved to Best Case           | |
| |                                                               | |
| | -- ACCOUNT OVERVIEW --                                        | |
| | Contoso is a mid-size manufacturing firm using RHEL and...    | |
| | [Source: Supportable 360, synced Mar 30]                (R09) | |
| |                                                               | |
| | -- COMPETITIVE SIGNALS -- (R07, only if detected)             | |
| | VMware mentioned in 2 email threads (Mar 22, Mar 28).        | |
| | Context: Infrastructure team evaluating alternatives.         | |
| | [Source: Gmail thread "RE: Infrastructure review"]            | |
| |                                                               | |
| | -- TALKING POINTS --                                          | |
| | · RHEL renewal due Apr 9 — confirm pricing & scope           | |
| | · Address Sev2 networking case before renewal discussion      | |
| | · AWS marketplace spend growing — propose consolidation       | |
| |                                                               | |
| | -- OPEN SUPPORT CASES --                                      | |
| | -- PIPELINE OPPORTUNITIES --                                  | |
| | -- TECHNOLOGY LANDSCAPE --                                    | |
| | [Expand full brief]                                           | |
| +--------------------------------------------------------------+ |
|                                                                  |
| 2-COL LAYOUT                                                    |
| +------- LEFT (60%) -------+  +------- RIGHT (40%) -----------+ |
| |                           |  |                               | |
| | Activity Timeline         |  | Stakeholder Engagement (R08) | |
| | (unchanged but with       |  | +---------------------------+| |
| | ▲ markers on new items    |  | | j.smith@contoso.com       || |
| | since last brief gen)     |  | | Last: Mar 28 · 4 emails   || |
| |                           |  | | Freq: Weekly [||||  ]     || |
| |                           |  | |                           || |
| |                           |  | | m.jones@contoso.com       || |
| |                           |  | | Last: Feb 12 · 1 email    || |
| |                           |  | | [!] GONE SILENT (47 days) || |
| |                           |  | | Was: Bi-weekly            || |
| |                           |  | +---------------------------+| |
| |                           |  |                               | |
| |                           |  | Cases Section                | |
| |                           |  | (unchanged)                  | |
| |                           |  |                               | |
| |                           |  | Products & Subscriptions     | |
| |                           |  | (unchanged but with          | |
| |                           |  |  expiry sparklines)          | |
| +---------------------------+  +-------------------------------+ |
|                                                                  |
| CCSP Section (unchanged, with delta badge from R06)              |
| Pipeline Section (unchanged)                                     |
+------------------------------------------------------------------+
```

### Information Hierarchy (what the SA scans in order)

1. **Health score + name** — instant status read. Green/yellow/red dot + numeric score.
2. **Stat row with sparklines** — current values + directional trend. Six KPIs at a glance.
3. **Priority Action card** — the single most important thing to do RIGHT NOW. Impossible to miss (full-width, bordered, prominent icon). Dismissed once acted on.
4. **"What Changed" section** — temporal delta since last interaction. Every item has a ▲ marker. This is the highest-value section for meeting prep.
5. **Brief body** — overview, competitive signals, talking points. Noise-reduced (R09): risks first, sources cited, generic content removed.
6. **Stakeholder Engagement** — who you've been talking to, who's gone silent.
7. **Activity + Cases + Products** — reference data for deep dives.

---

## 4. Brief Display Redesign

### Current Brief Structure
```
## Account Overview
(paragraph)
## Talking Points
(bullet list)
## Open Support Cases
## Pipeline Opportunities
## Technology Landscape
## Products & Subscriptions
```

### Redesigned Brief Structure (server-generated markdown, client-rendered)

```
## What Changed Since [Last Interaction Date]       ← R02: Temporal Delta
▲ [change 1]
▲ [change 2]
---
## Account Overview                                  ← R09: Risks first
[risk-first paragraph with source citations]
[Source: Supportable 360, synced {date}]
---
## Competitive Signals                               ← R07: Only if detected
[competitor mention with context]
[Source: Gmail thread "{subject}"]
---
## Talking Points                                    ← R09: Prioritized
1. [most important — often maps to Priority Action]
2. [second]
3. [third]
---
## Open Support Cases
## Pipeline Opportunities
## Technology Landscape
```

### Client-Side Brief Rendering Rules

**Temporal Delta section:**
- Each line starts with ▲ (U+25B2)
- Client renders ▲ as a colored up-triangle badge: green for positive changes, amber for neutral, red for risks
- Lines with "new case" or "expired" → red badge
- Lines with "ACV increased" or "moved to Commit" → green badge
- Default → amber badge

**Source Citations (R09):**
- Lines matching `[Source: ...]` render as small gray text below the paragraph
- Format: `[Source: {system}, synced {date}]`
- Systems: Supportable 360, Gmail, Google Calendar, CCSP/Tableau, Salesforce, RH Portal

**Delta markers on regenerated briefs (R06):**
- When a brief is regenerated, the server compares against the previous cached version
- New sections get a ▲NEW badge in the section header
- Changed paragraphs get a subtle left-border highlight (4px accent left border)
- The `BriefData` response adds: `deltas?: { section: string, type: 'new' | 'changed' | 'removed' }[]`

**Competitive Signals (R07):**
- Only rendered if the section exists in the brief markdown
- Highlighted with a distinct left border color (purple/magenta — stands out from the blue accent)
- Each mention includes the source email/doc thread

**Noise Reduction (R09):**
- The brief generation prompt (server-side) is restructured to:
  1. Lead with risks and time-sensitive items
  2. Require source attribution for every factual claim
  3. Skip sections with no meaningful data (don't say "No pipeline opportunities" — just omit the section)
  4. Cap each section at 3-5 bullets
- Client-side: collapsed by default. Expand reveals full brief. Overview + Talking Points always visible.

### Brief Rendering — Scannable Visual Treatment

```
+--------------------------------------------------------------+
| [sparkle] Account Brief        cached 3h ago  | [Regenerate] |
+--------------------------------------------------------------+
|                                                               |
| WHAT CHANGED SINCE MAR 15                                    |
| +----------------------------------------------------------+ |
| | [▲ red]  New Sev2 case #67890 (RHEL networking)          | |
| | [▲ grn]  CCSP ACV +$1,800 (AWS spend increase)           | |
| | [▲ amb]  Pipeline "RHEL expansion" → Best Case            | |
| +----------------------------------------------------------+ |
|                                                               |
| OVERVIEW                                                      |
| Contoso is a mid-size manufacturing firm heavily invested     |
| in RHEL for production workloads. Key risk: RHEL Platform     |
| renewal expires Apr 9 with no scheduled discussion.           |
|    [Source: Supportable 360, synced Mar 30]                   |
|                                                               |
| ┃ COMPETITIVE SIGNALS                      ← purple border   |
| ┃ VMware mentioned in email thread "RE: Infrastructure        |
| ┃ review" (Mar 22, Mar 28). Infrastructure team is            |
| ┃ evaluating alternatives for VM fleet.                       |
| ┃    [Source: Gmail thread, Mar 28]                           |
|                                                               |
| TALKING POINTS                                                |
| 1. RHEL renewal (Apr 9) — confirm pricing, flag auto-renew   |
| 2. Sev2 #67890 — acknowledge before renewal conversation     |
| 3. AWS spend growth — position marketplace consolidation      |
|                                                               |
| [v Expand full brief]                                         |
+--------------------------------------------------------------+
```

---

## 5. Component Architecture

### New Shared Components

**`HealthDot`** — Replaces the current inline colored dot in AccountCard and CustomerDetailPage header.

```
Props:
  score: number          // 0-100 composite health score
  size?: 'sm' | 'md'    // sm=10px (cards), md=14px (detail header)
  showTooltip?: boolean  // hover tooltip with breakdown

Renders:
  - Green dot: score >= 70
  - Yellow dot: score 40-69
  - Red dot: score < 40
  - Tooltip: "Health: 78/100 — Cases: OK | Subscriptions: At Risk | ..."

Replaces: getHealthStatusFromCases() in AccountPortfolioGrid.tsx
          getHealth() in CustomerDetailPage.tsx
```

**`SparklineKPI`** — 64x24px inline SVG sparkline for KPI values.

```
Props:
  values: number[]       // 30 daily values (most recent last)
  color?: string         // defaults to accent color
  width?: number         // default 64
  height?: number        // default 24
  showDot?: boolean      // dot on last value

Renders:
  - Polyline SVG, no axes, no labels
  - Subtle fill gradient below the line (10% opacity)
  - Last-value dot if showDot
  - Green line if trending up, red if trending down (optional)

Used in: KPICard (portfolio page), stat row (customer detail header)
Implements: BKL-UX47
```

**`PriorityActionCard`** — Full-width callout for the single most important action.

```
Props:
  customerName: string
  action: string         // e.g., "Schedule renewal discussion"
  reason: string         // e.g., "RHEL Platform expires in 8 days"
  context?: string       // e.g., "Last contact: Mar 15"
  severity: 'critical' | 'high' | 'medium'
  actions?: { label: string, href?: string, onClick?: () => void }[]
  onDismiss?: () => void

Renders:
  - Bordered card with severity-colored left border
  - Bold action text, supporting reason, optional context
  - Action buttons (Schedule Meeting, View Subscription, etc.)
  - Dismiss button (marks as seen for this session)

Used in: CustomerDetailPage (between header and brief)
         MorningSummaryCard (as list items in priority actions column)
```

**`MorningSummaryCard`** — Cross-customer daily summary. Full-width on portfolio page.

```
Props:
  summary: MorningSummary   // from /api/morning-summary

MorningSummary shape:
  {
    greeting: string
    attentionCount: number
    meetingsToday: number
    renewalsThisWeek: number
    priorityActions: PriorityAction[]   // max 5
    topSignals: Signal[]                // max 10
  }

PriorityAction shape:
  {
    customerName: string
    healthStatus: 'red' | 'yellow' | 'green'
    action: string
    reason: string
  }

Signal shape:
  {
    category: 'ccsp_delta' | 'gone_silent' | 'competitor' | 'pipeline' | 'case' | 'renewal'
    text: string
    customerName: string
    icon: string      // for client-side icon selection
  }

Renders:
  - Two-column layout: priority actions (left), top signals (right)
  - Each priority action item links to customer detail
  - Each signal has a category icon and colored indicator

Used in: Dashboard main page, above KPI section
```

**`StakeholderEngagementPanel`** — Per-contact email frequency visualization.

```
Props:
  contacts: StakeholderContact[]

StakeholderContact shape:
  {
    email: string
    name?: string
    lastContact: string          // ISO date
    emailCount30d: number        // emails in last 30 days
    emailCount90d: number
    frequency: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'silent'
    goneSilent: boolean          // true if frequency dropped by 50%+
    previousFrequency?: string   // what it was before going silent
  }

Renders:
  - Contact list sorted: gone-silent first, then by recency
  - Each row: email/name, last contact date, email count, frequency bar
  - "GONE SILENT" badge (red) with days-since-contact
  - Frequency bar: 5-bar visualization (filled = active, empty = gap)

Used in: CustomerDetailPage right column (above cases)
```

**`TemporalDeltaSection`** — "What Changed Since Last Interaction" block.

```
Props:
  items: DeltaItem[]
  sinceDate: string

DeltaItem shape:
  {
    type: 'case_opened' | 'case_closed' | 'ccsp_change' | 'pipeline_change' |
          'renewal_approaching' | 'competitor_mention' | 'engagement_change'
    text: string
    sentiment: 'positive' | 'neutral' | 'negative'
  }

Renders:
  - Header: "What Changed Since {formatted date}"
  - Each item: colored ▲ badge + text
  - Red badge for negative, green for positive, amber for neutral

Used in: BriefSection (top of brief, before overview)
```

**`CompetitiveSignalBadge`** — Inline indicator for competitor mentions.

```
Props:
  competitor: string
  source: string
  date: string

Renders:
  - Purple-bordered inline badge: "[VMware] mentioned in email (Mar 28)"

Used in: Brief rendering, MorningSummaryCard signals
```

**`DeltaMarker`** — Small ▲ indicator for new/changed content.

```
Props:
  type: 'new' | 'changed'

Renders:
  - 'new': small green ▲NEW badge
  - 'changed': subtle accent-colored left border (4px)

Used in: Brief sections (after regeneration), Activity timeline items
```

**`SourceCitation`** — Small gray attribution line.

```
Props:
  system: string       // "Supportable 360", "Gmail", "CCSP/Tableau", etc.
  syncDate?: string

Renders:
  - Small text: "[Source: {system}, synced {date}]" in text-text-secondary/60

Used in: Brief section paragraphs
```

### Modified Existing Components

**`KPICard` (KPICards.tsx)** — Add optional `sparkline` prop:
```
+ sparkline?: number[]   // 30 daily values, renders SparklineKPI below value
```

**`AccountCard` (AccountPortfolioGrid.tsx)** — Replace case-only health with composite:
```
- getHealthStatusFromCases(account, accountCases)
+ healthScore from API (score: number, status: 'red'|'yellow'|'green')
+ Add one-line priority action at card bottom (if exists)
+ Add sparkline for cloud ACV trend (if CCSP data exists)
```

**`AccountPortfolioGrid`** — Triage view uses health score:
```
- Groups: Critical (Sev1 cases) | Attention (any cases) | Healthy (no cases)
+ Groups: Critical (score < 40) | Attention (40-69) | Healthy (70+)
  Within each group: sort by score ascending (worst first)
```

**`CalendarStrip` / `CustomerPrepCard`** — Add priority action to prep cards:
```
+ Priority action one-liner between attendees and brief overview
+ ▲ markers on brief content if regenerated since last view
```

---

## 6. State & Data Flow

### New API Endpoints Required

```
GET  /api/health-scores
     → { scores: { customerName: string, score: number, status: 'red'|'yellow'|'green',
         breakdown: { cases: number, subscriptions: number, meetings: number,
                      emails: number, pipeline: number, cloudSpend: number } }[] }
     Computed server-side from 6 signals. Cached, refreshed on any data change.

GET  /api/health-scores/:customerName
     → Single customer health score with full breakdown.

GET  /api/kpis/history
     → { metrics: { name: string, values: { date: string, value: number }[] }[] }
     30-day daily snapshots. Stored in data/cache/kpi-history.json.
     Updated daily by a timer (append today's values, trim to 90 days).

GET  /api/morning-summary
     → MorningSummary (see MorningSummaryCard props above)
     Cross-customer aggregation. Computed fresh on each request.
     Inputs: health scores, calendar, cases, pipeline, CCSP deltas, email frequency.

GET  /api/customer/:name/temporal-delta
     → { sinceDate: string, items: DeltaItem[] }
     Compares current state against last-known state at sinceDate.
     sinceDate = most recent meeting or email with this customer.

GET  /api/customer/:name/stakeholder-engagement
     → { contacts: StakeholderContact[] }
     Derived from Gmail API data. Email frequency bucketed by 30d/90d windows.

GET  /api/customer/:name/priority-action
     → { action: string, reason: string, context: string, severity: string } | null
     Single most important action. Algorithm:
       1. Sev1 case open → "Review and escalate"
       2. Renewal <30d with no scheduled meeting → "Schedule renewal discussion"
       3. Meeting today with no brief → "Generate brief before meeting"
       4. Gone-silent stakeholder (was weekly, now 30d+) → "Re-engage"
       5. Competitor mention in last 7d → "Review competitive situation"
       6. Pipeline opp closing <14d → "Confirm forecast"
```

### Data Flow Diagram

```
                    Server-Side Computation
                    ========================

Existing caches:                    New computations:
+------------------+               +----------------------+
| cases cache      |----+          | Health Score Engine   |
| ccsp-data.json   |----+--------->| (weighted algorithm)  |
| pipeline.json    |----+          | Weights:              |
| sheet-cache-*.json|---+          |   cases: 25%          |
| calendar API     |----+          |   subscriptions: 20%  |
| gmail API        |----+          |   meetings: 15%       |
+------------------+    |          |   emails: 15%         |
                        |          |   pipeline: 15%       |
                        |          |   cloudSpend: 10%     |
                        |          +----------+------------+
                        |                     |
                        |          +----------v------------+
                        +--------->| Morning Summary       |
                        |          | (cross-customer agg)  |
                        |          +----------+------------+
                        |                     |
                        |          +----------v------------+
                        +--------->| Priority Action       |
                        |          | (per-customer, ranked) |
                        |          +----------+------------+
                        |                     |
                        |          +----------v------------+
                        +--------->| Temporal Delta        |
                        |          | (diff vs last state)  |
                        |          +-----------------------+
                        |
                        |          +-----------------------+
                        +--------->| KPI History           |
                        |          | (daily snapshots)     |
                        |          +-----------------------+
                        |
                        |          +-----------------------+
                        +--------->| Stakeholder Engagement|
                                   | (email frequency)     |
                                   +-----------------------+


                    Client-Side Data Flow
                    ======================

Dashboard mount:
  fetch /api/morning-summary     → MorningSummaryCard
  fetch /api/kpis + /api/kpis/history → KPICards + SparklineKPI
  fetch /api/health-scores       → AccountPortfolioGrid (triage + dots)
  fetch /api/accounts            → (unchanged)
  fetch /api/cases/all           → (unchanged)
  fetch /api/calendar            → (unchanged)

CustomerDetailPage mount:
  fetch /api/health-scores/:name          → header HealthDot + score
  fetch /api/customer/:name/priority-action → PriorityActionCard
  fetch /api/customer/:name/temporal-delta  → TemporalDeltaSection (in brief)
  fetch /api/customer/:name/stakeholder-engagement → StakeholderEngagementPanel
  fetch /customer/:name/brief              → BriefSection (unchanged endpoint)
  useCustomerSSE (unchanged)               → real-time activity data
```

### Health Score Computation Algorithm

```
Score = weighted sum of 6 signals, each normalized to 0-100:

cases_score:
  100 = 0 open cases
  60  = only Sev3/4 cases
  30  = Sev2 case open
  0   = Sev1 case open

subscriptions_score:
  100 = no renewals within 90 days
  70  = renewals in 60-90 days
  40  = renewals in 30-60 days
  10  = renewals within 30 days or expired

meetings_score:
  100 = met within last 14 days
  70  = met within 30 days
  40  = met within 60 days
  10  = no meeting in 60+ days

emails_score:
  100 = email exchange within 7 days
  70  = within 14 days
  40  = within 30 days
  10  = no email in 30+ days

pipeline_score:
  100 = all opps on track (Commit/Best Case, close >30d)
  60  = opps need attention (Pipeline stage, close <30d)
  30  = tech win needed
  100 = no pipeline (neutral — absence is not a risk)

cloudSpend_score:
  100 = ACV stable or growing
  70  = ACV flat (< 5% change)
  40  = ACV declining (5-20%)
  10  = ACV declining > 20%

Composite = (cases * 0.25) + (subscriptions * 0.20) + (meetings * 0.15)
          + (emails * 0.15) + (pipeline * 0.15) + (cloudSpend * 0.10)

Status:
  >= 70 → green
  40-69 → yellow
  < 40  → red
```

### Caching Strategy

- **Health scores:** Computed on demand, cached 5 minutes. Invalidated when any underlying data changes (case sync, CCSP scrape, etc.).
- **KPI history:** Appended daily at 11:59 PM. Read from `data/cache/kpi-history.json`. Never stale — it's historical.
- **Morning summary:** Computed fresh on each request (fast — reads only from local caches). No separate cache needed.
- **Priority actions:** Computed on demand per customer, no cache (depends on real-time calendar and case state).
- **Temporal delta:** Computed on demand per customer. `sinceDate` derived from most recent meeting/email timestamp.
- **Stakeholder engagement:** Computed from Gmail API cache, refreshed when emails are fetched. Cache 30 minutes.

---

## 7. Responsive Considerations

### Breakpoints

The existing app uses Tailwind's default breakpoints:
- `sm`: 640px (not heavily used)
- `md`: 768px (2-col grids kick in)
- `lg`: 1024px (3-col grids kick in)
- `xl`: 1280px (CalendarStrip prep cards go 3-col)

### Large Monitor (1440px+)

**Portfolio page:**
- Morning Summary: 2-col layout (priority actions + signals) — full width
- KPI cards: 7 in a row (unchanged, already works at lg)
- Pipeline/Cloud: 3-col grids (unchanged)
- Account grid: 3-col card grid (unchanged)

**Customer detail:**
- Header stat row: 6 KPIs in a row with sparklines
- Brief: full width
- Activity + Engagement/Cases: 60/40 split

### Laptop (1024-1440px)

**Portfolio page:**
- Morning Summary: 2-col layout still fits (narrower columns)
- KPI cards: 4 per row on md, 7 on lg (existing behavior)
- Account grid: 2-col on md, 3-col on lg

**Customer detail:**
- Header stat row: wraps to 2 rows of 3
- Brief: full width (unchanged)
- Activity + Engagement/Cases: stacks to single column below lg

### Small Laptop (768-1024px)

**Portfolio page:**
- Morning Summary: stacks to single column (priority actions above signals)
- KPI cards: 2 per row
- Pipeline/Cloud: stacks sections vertically
- Account grid: 2-col cards

**Customer detail:**
- Header stat row: 2 per row (3 rows)
- Everything else: single column stack

### Implementation Notes

- Morning Summary card uses `grid grid-cols-1 lg:grid-cols-2`
- Sparklines are fixed 64x24 — no responsive scaling needed (they're small enough at any breakpoint)
- StakeholderEngagementPanel: full-width on md, side panel on lg
- PriorityActionCard: always full-width (no responsive change needed)
- HealthDot tooltip: uses portal positioning to avoid card overflow

---

## Appendix A: Backlog Item Mapping

| Research Item | Backlog Items | Components Affected |
|---|---|---|
| R01: Customer Health Score | BKL-UX41 (triage grouping) | HealthDot, AccountPortfolioGrid, CustomerDetailPage header |
| R02: Temporal Delta | — | TemporalDeltaSection, BriefSection |
| R03: Priority Action | — | PriorityActionCard, MorningSummaryCard, CustomerPrepCard |
| R04: Trend Sparklines | BKL-UX44 (KPI container), BKL-UX47 (sparkline type) | SparklineKPI, KPICard, customer detail stat row |
| R05: Morning Summary | — | MorningSummaryCard, Sidebar, Dashboard |
| R06: Brief Delta Detection | — | DeltaMarker, BriefSection |
| R07: Competitive Signals | — | CompetitiveSignalBadge, BriefSection |
| R08: Stakeholder Engagement | — | StakeholderEngagementPanel |
| R09: Noise Reduction | — | BriefSection (rendering rules), server-side prompt |

| Existing Backlog | Status | Notes |
|---|---|---|
| BKL-UX41: Triage by health | Superseded by R01 | Health score replaces case-only triage |
| BKL-UX43: Compact list view | Unchanged | Implement independently |
| BKL-UX44: KPI container | Feeds into R04 | SparklineKPI is the first extensible KPI type |
| BKL-UX47: Sparkline type | Implemented by R04 | 64x24 inline SVG spec unchanged |
| BKL-UX39: Pagination/virtualize | Unchanged | Implement independently for large portfolios |
| BKL-UX24: Search/filter | Already implemented | Search input in AccountPortfolioGrid |
| BKL-UX02: Detail header redesign | Feeds into R01 | Health score + sparklines in header |

---

## Appendix B: Implementation Priority

Recommended implementation order (each is independently shippable):

1. **SparklineKPI component + KPI history endpoint** — Smallest scope, highest visual impact. Adds trend context to every KPI.
2. **HealthDot + health score API** — Replaces case-only health with composite. Improves triage view immediately.
3. **PriorityActionCard + priority action API** — High value for meeting prep workflow. Single component + single endpoint.
4. **MorningSummaryCard + morning summary API** — Transforms the morning review workflow. Depends on health scores (#2).
5. **TemporalDeltaSection + temporal delta API** — Enhances briefs significantly. Depends on tracking "last interaction" dates.
6. **StakeholderEngagementPanel + engagement API** — New data dimension. Depends on Gmail API email frequency parsing.
7. **Brief display redesign (R06, R07, R09)** — Rendering changes + server prompt updates. Can be done incrementally.
8. **Noise reduction (R09 server-side)** — Prompt engineering + brief generation changes. Independent of UI.
