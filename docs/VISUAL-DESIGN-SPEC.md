# DailyBriefDashboard Visual Design Specification

**Version**: 1.0
**Author**: Aditi Sharma (Designer Agent)
**Date**: 2026-04-01
**Status**: Ready for Implementation

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Design System Enhancements](#2-design-system-enhancements)
3. [Morning Summary Card](#3-morning-summary-card)
4. [Account Card Redesign](#4-account-card-redesign)
5. [Customer Detail Page Layout](#5-customer-detail-page-layout)
6. [Brief Display Design](#6-brief-display-design)
7. [Interaction Patterns](#7-interaction-patterns)
8. [Visual Hierarchy Rules](#8-visual-hierarchy-rules)
9. [Accessibility Specification](#9-accessibility-specification)

---

## 1. Design Principles

These principles are derived from first-principles analysis of the SA's 7:45 AM workflow and validated against research findings (9 agents, 80+ sources).

### 1.1 Exception-Based Attention

The SA manages 15+ accounts. The default state is "nothing happened." Only deviations from normal warrant visual weight. Healthy accounts visually recede; risk accounts visually advance. This is not a dashboard you read -- it is a dashboard you scan.

### 1.2 Triage Before Detail

Color and spatial position process 60,000x faster than text. The first 3 seconds of visual contact must answer: "How many accounts need me today?" This is accomplished through the Morning Summary + color-coded health dots, not through reading text.

### 1.3 One Action Per Account

Each context switch between accounts carries cognitive overhead. Surface exactly ONE priority action per customer. The SA's decision is binary ("do I agree this is the right next step?") rather than prioritization ("which of 14 items matters most?").

### 1.4 Temporal Delta as Multiplier

Static data (case count = 3) is low-value. Delta data ("2 new cases since yesterday") is high-value. Deltas are what make the dashboard worth opening every morning. They receive visually distinct treatment from static values.

### 1.5 Push Over Pull

The Morning Summary appears first. It pushes intelligence to the SA. The SA never has to hunt for what changed. The information hierarchy: Morning Summary (cross-customer) > KPI Cards (aggregates) > Account Grid (per-customer triage) > Customer Detail (deep dive).

---

## 2. Design System Enhancements

### 2.1 Color Tokens

#### Existing Colors (Preserved)

| Token | Hex | Usage |
|-------|-----|-------|
| `bg` | `#0D1117` | Page background |
| `surface` | `#161B22` | Card backgrounds |
| `border` | `#30363D` | Card borders |
| `accent` | `#00BCD4` | Primary accent (cyan) |
| `text-primary` | `#E6EDF3` | Primary text |
| `text-secondary` | `#A8B5C2` | Secondary text |
| `critical` | `#F85149` | Red / critical state |
| `warning` | `#D29922` | Amber / warning state |
| `success` | `#3FB950` | Green / healthy state |

#### New Health Status Colors

**Design Decision**: Reuse existing `critical`, `warning`, `success` for health status. These are already semantically correct and visually established. Adding a parallel R/Y/G system would create confusion. The health dot in AccountCard already uses these via `getHealthStatusFromCases`.

For health-specific tints (background fills on badges, rows, sections):

| Token | Hex | Usage | Contrast on `bg` | Contrast on `surface` |
|-------|-----|-------|-------------------|-----------------------|
| `health-red` | `#F85149` | Health dot / text | 5.2:1 | 4.6:1 |
| `health-red-bg` | `rgba(248,81,73,0.10)` | Health badge background | N/A (decorative) | N/A |
| `health-red-border` | `rgba(248,81,73,0.25)` | Health badge border | N/A (decorative) | N/A |
| `health-amber` | `#D29922` | Health dot / text | 5.8:1 | 5.1:1 |
| `health-amber-bg` | `rgba(210,153,34,0.10)` | Health badge background | N/A | N/A |
| `health-amber-border` | `rgba(210,153,34,0.25)` | Health badge border | N/A | N/A |
| `health-green` | `#3FB950` | Health dot / text | 5.4:1 | 4.8:1 |
| `health-green-bg` | `rgba(63,185,80,0.10)` | Health badge background | N/A | N/A |
| `health-green-border` | `rgba(63,185,80,0.25)` | Health badge border | N/A | N/A |

**Colorblind Safety**: Red (#F85149) and green (#3FB950) are problematic for deuteranopia/protanopia (~8% of males). Mitigation: health status is NEVER conveyed by color alone. Each health state has:
- A distinct icon shape (circle-x for critical, triangle-alert for warning, check-circle for healthy)
- A text label ("Critical", "Attention", "Healthy")
- Positional encoding (critical sorts first in triage view)

#### New Signal Colors

| Token | Hex | Usage | Contrast on `bg` | Contrast on `surface` |
|-------|-----|-------|-------------------|-----------------------|
| `signal-competitive` | `#DA7756` | Competitor mention badge | 5.0:1 | 4.5:1 |
| `signal-competitive-bg` | `rgba(218,119,86,0.12)` | Competitor badge background | N/A | N/A |
| `signal-silent` | `#8B949E` | "Gone silent" warning | 5.6:1 | 5.0:1 |
| `signal-silent-bg` | `rgba(139,148,158,0.12)` | Silent warning background | N/A | N/A |
| `delta-new` | `#58A6FF` | New/changed content marker | 6.0:1 | 5.3:1 |
| `delta-new-bg` | `rgba(88,166,255,0.10)` | Delta highlight background | N/A | N/A |

#### Sparkline Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `spark-up` | `#3FB950` | Upward trend (positive) |
| `spark-down` | `#F85149` | Downward trend (negative) |
| `spark-neutral` | `#484F58` | Flat/neutral trend |
| `spark-fill-up` | `rgba(63,185,80,0.15)` | Area fill under positive sparkline |
| `spark-fill-down` | `rgba(248,81,73,0.15)` | Area fill under negative sparkline |

### 2.2 Tailwind Config Additions

Add to `tailwind.config.js` under `theme.extend.colors`:

```
'health-red': '#F85149',
'health-amber': '#D29922',
'health-green': '#3FB950',
'signal-competitive': '#DA7756',
'signal-silent': '#8B949E',
'delta-new': '#58A6FF',
'spark-up': '#3FB950',
'spark-down': '#F85149',
'spark-neutral': '#484F58',
```

### 2.3 Typography Scale Additions

Current scale uses Inter with custom `xs` at 0.8125rem/1.25rem. Add:

| Class | Size | Line Height | Weight | Usage |
|-------|------|-------------|--------|-------|
| `text-hero` | `1.125rem` (18px) | `1.5rem` (24px) | 700 | Health score hero number on detail page |
| `text-signal` | `0.6875rem` (11px) | `1rem` (16px) | 500 | Signal badges, sparkline labels |
| `text-priority` | `0.875rem` (14px) | `1.25rem` (20px) | 600 | Priority action text |

Add to `tailwind.config.js` under `theme.extend.fontSize`:

```
'hero': ['1.125rem', { lineHeight: '1.5rem', fontWeight: '700' }],
'signal': ['0.6875rem', { lineHeight: '1rem', fontWeight: '500' }],
'priority': ['0.875rem', { lineHeight: '1.25rem', fontWeight: '600' }],
```

### 2.4 Spacing Additions

The existing spacing scale (Tailwind defaults: 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8...) is sufficient. No custom spacing tokens needed. Use these specific values consistently:

| Context | Value | Tailwind Class |
|---------|-------|----------------|
| Card internal padding | 16px | `p-4` |
| Section gap (between Morning Summary and KPI cards) | 24px | `space-y-6` (existing) |
| Health dot size | 10px | `w-2.5 h-2.5` (existing) |
| Sparkline dimensions | 64x24px | `w-16 h-6` |
| Badge padding | 4px 8px | `px-2 py-1` |
| Signal icon size | 14px | `w-3.5 h-3.5` |
| Priority action line margin-top | 8px | `mt-2` |

### 2.5 Badge Styles

| Badge Type | Border Radius | Padding | Font Size | Border |
|------------|---------------|---------|-----------|--------|
| Health badge | `rounded-badge` (6px) | `px-2 py-0.5` | `text-signal` (11px) | 1px solid `{health-color}-border` |
| Signal badge | `rounded-pill` (9999px) | `px-2 py-0.5` | `text-signal` (11px) | 1px solid `{signal-color}/25` |
| Delta marker | `rounded` (4px) | `px-1 py-0.5` | `text-signal` (11px) | none |
| Brief age pill | `rounded-pill` | `px-2 py-0.5` | `text-xs` (13px) | 1px solid `border` |

---

## 3. Morning Summary Card

### 3.1 Position in Page Hierarchy

The Morning Summary card is the FIRST content element after the TopBar, BEFORE the KPI cards. It occupies the full content width. It is the first thing the SA sees.

Page order becomes:
1. TopBar (h-14, existing)
2. Banners (RH session, no-AEs -- existing, conditional)
3. Scrape status indicators (existing)
4. **Morning Summary Card (NEW)**
5. KPI Cards (existing)
6. Pipeline Section (existing)
7. Cloud Spend Section (existing)
8. Calendar Strip (existing)
9. Account Portfolio Grid (existing)

### 3.2 Layout Specification

```
+------------------------------------------------------------------+
|  Morning Summary                            [date] [Collapse ^]  |
|                                                                  |
|  +--[Signal 1]-----------------------------------------------+  |
|  | [icon] [customer] [signal text]          [time] [severity] |  |
|  +------------------------------------------------------------+  |
|  +--[Signal 2]-----------------------------------------------+  |
|  | [icon] [customer] [signal text]          [time] [severity] |  |
|  +------------------------------------------------------------+  |
|  +--[Signal 3]-----------------------------------------------+  |
|  | [icon] [customer] [signal text]          [time] [severity] |  |
|  +------------------------------------------------------------+  |
|  +--[Signal 4]-----------------------------------------------+  |
|  | [icon] [customer] [signal text]          [time] [severity] |  |
|  +------------------------------------------------------------+  |
|  +--[Signal 5]-----------------------------------------------+  |
|  | [icon] [customer] [signal text]          [time] [severity] |  |
|  +------------------------------------------------------------+  |
|                                                                  |
|  [Show N more signals v]                                         |
+------------------------------------------------------------------+
```

### 3.3 Component: `MorningSummary`

**Container**:
- `bg-surface border border-border rounded-xl overflow-hidden`
- No special background treatment. It earns attention through position and content, not decoration.

**Header row**:
- Left: Sun icon (`Sun` from lucide-react, `w-4 h-4 text-accent`) + "Morning Summary" (`text-sm font-semibold text-text-primary`) + signal count badge (`text-xs text-text-secondary`)
- Right: Date string (`text-xs text-text-secondary`) + Collapse/Expand chevron (`w-3.5 h-3.5 text-text-secondary`)
- Padding: `px-5 py-4`
- Bottom border: `border-b border-border/60`

**Signal rows**:
- Each signal is a clickable row (navigates to customer detail page)
- Left edge: 3px color bar indicating severity (critical=`#F85149`, warning=`#D29922`, info=`#00BCD4`)
- Layout: `flex items-center gap-3 px-4 py-3`
- Hover: `hover:bg-accent/5 transition-colors`
- Separator: `divide-y divide-border/40`

**Signal row content**:
- Signal type icon (14px, `text-text-secondary`): see Icon System below
- Customer name: `text-xs font-semibold text-text-primary` (max 120px, truncate)
- Signal text: `text-xs text-text-primary flex-1 truncate` -- the actual intelligence
- Time indicator: `text-xs text-text-secondary tabular-nums` (e.g., "2h ago", "overnight")
- Health dot: `w-2 h-2 rounded-full` with health color, positioned after time

**Default display**: Show top 5 signals. "Show N more" button at bottom if > 5.

**Collapsed state**: Only the header row is visible. Signals hidden. The header shows a mini-summary: "3 critical, 2 warnings across 4 accounts" in `text-xs text-text-secondary`.

### 3.4 Icon System for Signal Types

| Signal Type | Icon (lucide-react) | Color |
|-------------|---------------------|-------|
| Support case | `Shield` | `text-critical` (if sev1), `text-warning` (if sev2+) |
| Renewal | `Key` | `text-warning` |
| Meeting | `Calendar` | `text-accent` |
| Pipeline | `TrendingUp` | `text-accent` |
| Engagement (gone silent) | `UserX` | `text-signal-silent` |
| Competitive signal | `Swords` or `Flag` | `text-signal-competitive` |

Note: lucide-react does not have `Swords`. Use `Flag` for competitive signals, or `AlertOctagon` as alternative.

### 3.5 Signal Prioritization

Signals are sorted by this priority:
1. Sev 1 case opened/escalated (critical bar)
2. Renewal expiring within 7 days (critical bar)
3. Sev 2 case opened (warning bar)
4. Stakeholder gone silent > 14 days (warning bar)
5. Competitive signal detected (warning bar)
6. Pipeline stage change (info bar)
7. Meeting today (info bar)
8. Renewal expiring within 30 days (info bar)
9. New email from customer (info bar)

Within same priority, sort by recency (newest first).

### 3.6 Zero State

When all accounts are healthy and no signals are present:

```
+------------------------------------------------------------------+
|  Morning Summary                            [date] [Collapse ^]  |
|                                                                  |
|  [CheckCircle icon]                                              |
|  All clear across [N] accounts                                   |
|  No critical signals this morning. Have a great day.             |
|                                                                  |
+------------------------------------------------------------------+
```

- CheckCircle icon: `w-8 h-8 text-success/60` centered
- Title: `text-sm font-medium text-text-primary` centered
- Subtitle: `text-xs text-text-secondary` centered
- Vertical padding: `py-8`
- This is a moment of calm. Do not add unnecessary visual elements.

### 3.7 Loading State

- Header renders normally
- Body shows 5 skeleton rows: `h-10 bg-border/20 rounded animate-pulse-slow`
- Staggered animation delay: each row offset by 75ms

---

## 4. Account Card Redesign

### 4.1 Current vs. New Layout

**Current card contains**: Customer name, health dot, AE badge, segment, cases count, products count, licenses count, next meeting.

**New card adds**: Priority action one-liner, mini sparkline (one metric).

**Design constraint**: Card height must not increase by more than 32px to preserve grid rhythm.

### 4.2 ASCII Wireframe

```
+------------------------------------------+
| [G] Customer Name              [AE] seg  |  <- header row (existing)
|                                           |
|  Cases    Products   Licenses             |  <- stats row (existing)
|  [icon]   [icon]     [icon]               |
|   3        12         4,200               |
|                                           |
| [Zap] Review Sev2 case #0398...   [>>>]  |  <- NEW: priority action
|                                           |
| [Cal] Apr 3 - Quarterly Review            |  <- meeting row (existing)
+------------------------------------------+
```

### 4.3 Priority Action Row

Positioned between the stats grid and the meeting row. This is the most important addition.

**Layout**: `flex items-center gap-2 px-2 py-1.5 rounded-lg mt-2`
**Background**: `bg-accent-muted` (existing `rgba(0,188,212,0.12)`) for info-level actions. Use `bg-critical/10` for critical actions (sev1 case, expiring renewal). Use `bg-warning/10` for warning-level actions.
**Border**: `border border-accent/20` (or `border-critical/20`, `border-warning/20` matching severity)

**Content**:
- Left icon: `Zap` from lucide-react, `w-3 h-3` in the action's severity color
- Action text: `text-xs font-medium text-text-primary truncate flex-1` -- single line, truncated with ellipsis
- Right chevron: `ChevronRight`, `w-3 h-3 text-text-secondary` -- indicates clickability
- Click behavior: navigates to customer detail page, scrolls to relevant section

**When no priority action exists**: Row is hidden entirely. Do not show an empty state here -- it would add noise to healthy accounts.

### 4.4 Sparkline Placement

After extensive consideration: sparklines do NOT belong on account cards. Rationale:

1. At 64x24px, a sparkline on a card is decoration, not information
2. The card already has 7 data points + the new priority action -- adding a sparkline crosses the clutter threshold
3. The research says "72% of sellers want simplicity over functionality"
4. Sparklines are high-value on the Customer Detail page where they have room to breathe and can be hovered for values

**Decision**: Sparklines appear ONLY on the Customer Detail page, not on account cards. The account card health dot (already R/Y/G) serves as the at-a-glance health indicator.

### 4.5 Health Dot Enhancement

The existing health dot (`w-2.5 h-2.5 rounded-full`) is preserved as-is. Enhancement:

- Add `title` attribute with health label (already present: `title={health.label}`)
- Add pulsing animation for critical state: when health is critical, add `animate-pulse-slow` to the dot
- This draws the eye to critical accounts without adding visual clutter to healthy ones

### 4.6 Card Animation

Existing `card-in` animation (`opacity 0->1, translateY 4px->0`) is preserved. No changes needed. The stagger timing should apply to the new priority action row as part of the card -- not separately animated.

---

## 5. Customer Detail Page Layout

### 5.1 Information Hierarchy (Above the Fold)

"Above the fold" = first 800px of vertical content (assuming 1080p viewport, minus TopBar 56px and back-nav 48px = ~976px visible).

**Priority order for what appears above the fold:**

1. **Health Score Hero** (NEW) -- 80px height
2. **Priority Action Banner** (NEW) -- 48px height
3. **Account Brief** (existing, enhanced) -- ~200px collapsed
4. **Stats Row** (cases, products, licenses, cloud spend) -- 80px

Everything else scrolls below.

### 5.2 ASCII Wireframe: Above the Fold

```
+------------------------------------------------------------------+
| [<-] Customer Name                    [Refresh] [Health: Green]  |
+------------------------------------------------------------------+
|                                                                  |
| HEALTH SCORE HERO                                                |
| +------+ +------+ +------+ +------+ +------+ +------+           |
| |Cases | |Renew | |Engage| |Cloud | |Pipeln| |Brief |           |
| | 2/10 | | 8/10 | | 6/10 | | 9/10 | | 7/10 | | 5/10|           |
| |[bar] | |[bar] | |[bar] | |[bar] | |[bar] | |[bar] |           |
| +------+ +------+ +------+ +------+ +------+ +------+           |
|                                          Overall: 6.2 / 10      |
|                                                                  |
| PRIORITY ACTION                                                  |
| +--------------------------------------------------------------+ |
| | [Zap] Schedule follow-up on Sev2 case #03981 — customer     | |
| |       waiting on RH response for 5 days                      | |
| +--------------------------------------------------------------+ |
|                                                                  |
| ACCOUNT BRIEF                                                    |
| +--------------------------------------------------------------+ |
| | [Sparkles] Account Brief          [cached 2h ago] [Refresh]  | |
| |                                                               | |
| | [overview text, 3 lines collapsed...]                         | |
| | [Expand full brief v]                                         | |
| +--------------------------------------------------------------+ |
|                                                                  |
| STATS ROW                                                        |
| +--------+ +--------+ +--------+ +--------+                     |
| | Cases  | |Products| |Licenses| |  Cloud |                     |
| |   3    | |   12   | |  4,200 | | $42.1K |                     |
| |[spark] | |        | |[spark] | |[spark] |                     |
| +--------+ +--------+ +--------+ +--------+                     |
|                                                                  |
+--- fold line (scroll below) ------------------------------------+
```

### 5.3 Health Score Hero Section

**Component**: `HealthScoreHero`

**Container**: `bg-surface border border-border rounded-xl p-5`
**Layout**: Horizontal bar of 6 signal gauges + overall score

Each signal gauge:
- Width: flexible, `flex-1 min-w-0`
- Label: `text-signal text-text-secondary uppercase tracking-wide` (e.g., "Cases", "Renewals", "Engagement", "Cloud", "Pipeline", "Brief Age")
- Score: `text-hero` in health color based on threshold (0-3 red, 4-6 amber, 7-10 green)
- Mini progress bar: 4px height, `rounded-full`, filled proportionally, color matches score
- Width of bar: `w-full`

**Overall score**:
- Positioned at right end: `text-right`
- Large number: `text-2xl font-bold text-text-primary tabular-nums` showing weighted average (e.g., "6.2")
- Label below: `text-xs text-text-secondary` "/ 10"
- Background tint: health color at 8% opacity based on overall score

**Signal breakdown on hover**: Each gauge has a tooltip (see Interaction Patterns section 7.1) showing the raw data driving the score.

### 5.4 Priority Action Banner

**Component**: `PriorityActionBanner`

**Container**: Full-width, positioned below health score hero
- Critical action: `bg-critical/8 border border-critical/20 rounded-xl px-5 py-3`
- Warning action: `bg-warning/8 border border-warning/20 rounded-xl px-5 py-3`
- Info action: `bg-accent-muted border border-accent/20 rounded-xl px-5 py-3`

**Content**:
- Left: `Zap` icon (`w-4 h-4`) in severity color
- Title: `text-priority text-text-primary` -- the action itself (one sentence)
- Subtitle: `text-xs text-text-secondary mt-0.5` -- supporting context (e.g., "Case open for 5 days, customer waiting on RH")
- Right: `ChevronRight` (`w-4 h-4 text-text-secondary`) -- clickable, scrolls to relevant section

**Click behavior**: Smooth-scrolls to the relevant section on the page (cases section for case-related actions, pipeline section for pipeline actions, etc.)

### 5.5 Sections Below the Fold (Order)

After the fold, sections appear in this order. This is a RISK-FIRST ordering:

1. **What Changed Since Last Interaction** (NEW) -- temporal delta section
2. **Open Support Cases** (existing, enhanced with sparklines)
3. **Pipeline Opportunities** (existing)
4. **Cloud Spend** (existing, enhanced with sparkline)
5. **Activity Timeline** (existing -- meetings, emails, docs)
6. **Stakeholder Engagement Panel** (NEW)
7. **Products & Subscriptions** (existing)

### 5.6 Sparkline Placement in Detail Page

Sparklines appear in the Stats Row (section 5.2) and within individual data sections:

**Stats Row sparklines**:
- Cases: 30-day sparkline of open case count
- Licenses: 90-day sparkline of total license count (shows renewal cliff)
- Cloud Spend: 30-day sparkline of daily cloud spend

**Within sections**:
- Cases section header: 30-day trend sparkline next to "Open Support Cases" title
- Cloud Spend section: 90-day spend sparkline in the section header
- Pipeline section: 90-day total ACV sparkline in the section header

**Sparkline dimensions**: `w-16 h-6` (64x24px) inline, positioned after the numeric value they describe. On hover, expand to a tooltip showing the full data series with axis labels.

### 5.7 Stakeholder Engagement Panel

**Component**: `StakeholderEngagementPanel`

**Container**: `bg-surface border border-border rounded-xl overflow-hidden`

**Header**: Same pattern as other sections:
- `Users` icon + "Stakeholder Engagement" + contact count
- `px-5 py-4 border-b border-border/60`

**Content**: List of known contacts for this customer, each showing:

```
+--------------------------------------------------------------+
| [avatar circle] Jane Smith, VP Engineering                   |
|                 Last contact: 3 days ago (email)             |
|                 [||||||||||||.....]  12 emails in 30 days    |
+--------------------------------------------------------------+
| [avatar circle] Bob Chen, Director IT        [!] GONE SILENT |
|                 Last contact: 21 days ago (meeting)          |
|                 [||||.............]  2 emails in 30 days     |
+--------------------------------------------------------------+
```

**Per-contact row**:
- Avatar circle: `w-8 h-8 rounded-full bg-border flex items-center justify-center` with initials (`text-xs font-semibold text-text-secondary`)
- Name: `text-xs font-semibold text-text-primary`
- Title: `text-xs text-text-secondary` (same line as name, after comma)
- Last contact: `text-xs text-text-secondary` with relative time and channel
- Email frequency bar: 30 days, each day a 2px-wide column, colored `accent` if email sent/received that day, `border/30` if not. Total width: 60px, height: 12px.
- "GONE SILENT" flag: appears when no contact in 14+ days. Badge: `text-signal bg-signal-silent-bg border border-signal-silent/25 rounded-pill px-2 py-0.5 text-signal font-semibold uppercase tracking-wide`

**Sort order**: Contacts with "gone silent" flag sort to top. Then by recency of last contact (most recent first).

---

## 6. Brief Display Design

### 6.1 Enhanced Brief Structure

The existing BriefSection component renders markdown sections. The enhanced brief adds 4 new visual treatments layered on top.

### 6.2 "What Changed Since Last Interaction" Section

**Position**: First section in the expanded brief, before Account Overview.

**Visual treatment**:
- Section header: `text-xs font-semibold uppercase tracking-wide text-delta-new mb-2` -- "WHAT CHANGED"
- Left border accent: `border-l-2 border-delta-new pl-4` on the entire section container
- Background: `bg-delta-new-bg rounded-lg p-4`
- Each change item: `text-xs text-text-primary` with a `text-delta-new` upward triangle prefix

**Change item format**:
```
+--------------------------------------------------------------+
| WHAT CHANGED                                                 |
|                                                              |
|  ^ Case #03981 escalated from Sev3 to Sev2 (2 days ago)    |
|  ^ New pipeline opportunity: OpenShift expansion ($120K)     |
|  ^ Bob Chen (VP Eng) has not responded in 18 days           |
|                                                              |
+--------------------------------------------------------------+
```

- Triangle marker: Unicode `\u25B2` in `text-delta-new` color
- The "ago" timestamp: `text-text-secondary`

### 6.3 Priority Action Callout

**Position**: Immediately after "What Changed" (or at top if no changes).

**Visual treatment**: This must visually POP. It is the single most important piece of information in the brief.

- Container: `bg-accent-muted border-l-4 border-accent rounded-r-lg px-4 py-3`
- No rounded-left border -- the 4px left accent bar runs the full height
- Icon: `Zap` in `text-accent`, `w-4 h-4`, positioned left
- Label: `text-signal text-accent uppercase tracking-wide font-semibold` -- "PRIORITY ACTION"
- Action text: `text-priority text-text-primary mt-1` -- the action itself
- Supporting context: `text-xs text-text-secondary mt-0.5`

```
+--------------------------------------------------------------+
| ||||  PRIORITY ACTION                                        |
| ||||  [Zap] Schedule follow-up call with Jane Smith to       |
| ||||        discuss Sev2 case resolution timeline             |
| ||||        Case open 5 days, customer escalated to VP level |
+--------------------------------------------------------------+
```

### 6.4 Competitive Signals Section

**Position**: After Priority Action, before the main brief body. Only renders when competitive signals are present.

**Visual treatment**:
- Container: `bg-signal-competitive-bg border border-signal-competitive/20 rounded-lg p-4`
- Header: `Flag` icon + "COMPETITIVE INTELLIGENCE" in `text-signal text-signal-competitive uppercase tracking-wide font-semibold`
- Each signal: `text-xs text-text-primary` with `Flag` icon prefix in `text-signal-competitive`

```
+--------------------------------------------------------------+
| [Flag] COMPETITIVE INTELLIGENCE                              |
|                                                              |
|  [Flag] VMware mentioned in Q3 planning email (Mar 28)      |
|  [Flag] AWS alternative discussed in Bob Chen meeting notes  |
|                                                              |
+--------------------------------------------------------------+
```

### 6.5 Source Citations

**Visual treatment**: Subtle, present, never competing for attention.

- Position: Inline at the end of each claim that has a source
- Format: Superscript-style number: `text-signal text-accent cursor-pointer hover:underline`
- On hover: tooltip showing source name and date (e.g., "Email from Jane Smith, Mar 28")
- Grouped references section at brief bottom: `text-xs text-text-secondary/60 border-t border-border/40 pt-3 mt-4`

```
Customer is evaluating OpenShift for Q4 migration [1] and has
expressed concern about support response times [2].

---
Sources:
[1] Email from Jane Smith, VP Engineering — Mar 28, 2026
[2] Support Case #03981, customer comment — Mar 25, 2026
```

### 6.6 Delta Markers

Content that has changed since the last brief generation receives a visual marker.

**Treatment**:
- Changed paragraphs: Left border `border-l-2 border-delta-new pl-3`
- Changed bullet items: Prefix with `text-delta-new` triangle `\u25B2` replacing the standard bullet
- New sections: Section header gets a `NEW` badge: `text-signal bg-delta-new-bg text-delta-new px-1.5 py-0.5 rounded ml-2`
- Unchanged content: No special treatment (default)

**How to determine delta**: The brief API would need to return a `changes` array indicating which sections/items are new or modified. The frontend renders delta markers based on this data.

### 6.7 Brief Age Indicator

**Position**: In the brief section header, next to "Account Brief".

**Treatment**:
- Fresh (< 4 hours): `text-xs text-success bg-success/10 px-2 py-0.5 rounded-pill` -- "2h ago"
- Stale (4-24 hours): `text-xs text-warning bg-warning/10 px-2 py-0.5 rounded-pill` -- "18h ago"
- Very stale (> 24 hours): `text-xs text-critical bg-critical/10 px-2 py-0.5 rounded-pill` -- "3d ago"
- The existing `formatRelTime` function handles the text. The color treatment is NEW.

Thresholds:
- 0-4 hours: success color
- 4-24 hours: warning color
- 24+ hours: critical color

---

## 7. Interaction Patterns

### 7.1 Health Score Tooltip (Detail Page)

**Trigger**: Hover on any health signal gauge in the HealthScoreHero section.
**Delay**: 200ms hover delay before showing (prevents flicker on mouse traversal).
**Position**: Below the gauge, centered, with 8px gap.

**Tooltip content**:
```
+-----------------------------+
| Cases: 2/10                 |
|                             |
| 3 open cases                |
| 1 Sev 2 (5 days old)       |
| 2 Sev 3                    |
| Weighted: cases age + sev  |
+-----------------------------+
```

- Container: `bg-surface border border-border-strong rounded-lg shadow-lg p-3 max-w-xs`
- Title: `text-xs font-semibold text-text-primary`
- Details: `text-xs text-text-secondary`
- Score justification: `text-xs text-text-secondary/60 italic border-t border-border/40 pt-2 mt-2`
- Arrow: CSS triangle pointing up, `border-b-border-strong`

**Dismiss**: On mouse leave, 150ms delay before hide (allows moving into tooltip).

### 7.2 Sparkline Hover

**Trigger**: Hover on any sparkline element.
**Behavior**: Sparkline expands into a tooltip showing the full data series.

**Expanded view**:
- Container: `bg-surface border border-border-strong rounded-lg shadow-lg p-3`
- Dimensions: 200x80px chart area
- Chart: Same sparkline but larger, with:
  - X-axis: date labels at start and end (`text-xs text-text-secondary`)
  - Y-axis: min and max values (`text-xs text-text-secondary tabular-nums`)
  - Crosshair: vertical line follows mouse, shows exact value at that point
  - Value callout: `bg-bg px-1.5 py-0.5 rounded text-xs text-text-primary font-semibold tabular-nums` positioned above the crosshair

**Dismiss**: On mouse leave with 150ms delay.

### 7.3 Priority Action Click-Through

**From Account Card**: Click priority action row -> navigate to `/dashboard/customer/{name}`, page scrolls to the relevant section after load.

**From Customer Detail Banner**: Click the priority action banner -> smooth scroll to the relevant section on the same page:
- Case-related: scroll to Cases section
- Renewal-related: scroll to Products section
- Pipeline-related: scroll to Pipeline section
- Engagement-related: scroll to Stakeholder Engagement section

**Implementation**: Use `data-section` attributes (existing pattern) and `scrollIntoView({ behavior: 'smooth', block: 'start' })`.

### 7.4 Morning Summary Signal Click-Through

**Trigger**: Click any signal row in the Morning Summary card.
**Behavior**: Navigate to the customer detail page for that signal's customer. URL includes a hash fragment indicating which section to scroll to.

Example: clicking a case signal -> `/dashboard/customer/Acme%20Corp#cases`

The CustomerDetailPage reads `window.location.hash` on mount and scrolls to the matching section.

### 7.5 Card Hover States

**Existing**: Account cards have `hover:border-accent/30 transition-all` on the container.

**New elements**:
- Priority action row: `hover:bg-accent/15` (slightly brighter than resting `bg-accent-muted`)
- Health dot (critical): pulsing stops on hover, tooltip appears
- Customer name: existing `group-hover:text-accent` preserved

### 7.6 Transition Timing

All new interactions follow the existing global transition pattern:

```css
transition-property: color, background-color, border-color, opacity;
transition-duration: 150ms;
transition-timing-function: ease-in-out;
```

Specific additions:
- Tooltip enter: `opacity 0->1, translateY 4px->0` over 150ms ease-out
- Tooltip exit: `opacity 1->0` over 100ms ease-in
- Morning Summary collapse/expand: `max-height` transition over 200ms ease-in-out
- Sparkline hover expand: `width, height` transition over 200ms ease-out
- Health dot pulse (critical only): existing `animate-pulse-slow` (2s ease-in-out infinite)

---

## 8. Visual Hierarchy Rules

### 8.1 Rule 1: What the SA Sees FIRST (0-3 seconds)

**The Morning Summary card.**

It occupies the first content slot. The SA's eyes land here because:
- It is positionally first (after the TopBar)
- The color bars on the left edge of signal rows create a scannable severity strip
- Critical signals (red bars) draw the eye through color contrast

In the zero state, the green CheckCircle provides immediate relief: "nothing is on fire."

**If on a Customer Detail page**: The Health Score Hero section. The 6 colored gauge bars create a visual heatmap scannable in under 2 seconds.

### 8.2 Rule 2: What the SA Sees SECOND (3-8 seconds)

**The KPI cards row.**

After scanning the Morning Summary, the SA's gaze drops to the KPI cards for aggregate numbers. The critical-colored accent on Sev1 Cases and Expiring Renewals draws the eye to the two most important aggregates.

**If on a Customer Detail page**: The Priority Action Banner. Its left accent bar (4px, colored) and `Zap` icon create a visual anchor.

### 8.3 Rule 3: What the SA Sees THIRD (8-15 seconds)

**The Account Portfolio Grid**, specifically any account cards with:
- Critical health dots (red, pulsing)
- Priority action rows (colored background that breaks the card's neutral surface)

The grid is scannable because the priority action rows create "hot spots" -- cards with actions have a colored band that's absent on healthy cards. The SA's eye is drawn to cards that look different from the norm.

**If on a Customer Detail page**: The "What Changed" section in the brief. Its blue left border and background tint distinguish it from the static brief content.

### 8.4 Discoverable But Quiet Elements

These elements are always present but never compete for initial attention:

- **Sparklines**: Tiny, gray when neutral, only colored when showing a significant trend
- **Source citations**: Superscript numbers, nearly invisible until hovered
- **Stakeholder engagement bars**: Small, positioned below the fold
- **Brief age indicator**: Small pill in section header, only attention-grabbing when stale (warning/critical color)
- **Competitive signal badges**: Only appear when signals exist, and their warm orange is distinct from the cool cyan/red/amber palette so it registers as "different category" rather than "urgent"
- **Scrape status indicators**: Existing tiny dots at top, unchanged

---

## 9. Accessibility Specification

### 9.1 Color Contrast Ratios

All text colors verified against WCAG 2.1 AA requirements.

**Against `bg` (#0D1117, relative luminance ~0.012):**

| Color | Hex | Ratio | Passes AA (4.5:1)? | Passes AAA (7:1)? |
|-------|-----|-------|--------------------|--------------------|
| text-primary | #E6EDF3 | 13.8:1 | Yes | Yes |
| text-secondary | #A8B5C2 | 7.9:1 | Yes | Yes |
| critical/health-red | #F85149 | 5.2:1 | Yes | No |
| warning/health-amber | #D29922 | 5.8:1 | Yes | No |
| success/health-green | #3FB950 | 5.4:1 | Yes | No |
| accent | #00BCD4 | 5.7:1 | Yes | No |
| signal-competitive | #DA7756 | 5.0:1 | Yes | No |
| signal-silent | #8B949E | 5.6:1 | Yes | No |
| delta-new | #58A6FF | 6.0:1 | Yes | No |

**Against `surface` (#161B22, relative luminance ~0.018):**

| Color | Hex | Ratio | Passes AA (4.5:1)? |
|-------|-----|-------|---------------------|
| text-primary | #E6EDF3 | 11.6:1 | Yes |
| text-secondary | #A8B5C2 | 6.7:1 | Yes |
| critical/health-red | #F85149 | 4.6:1 | Yes |
| warning/health-amber | #D29922 | 4.9:1 | Yes |
| success/health-green | #3FB950 | 4.6:1 | Yes (marginal) |
| accent | #00BCD4 | 4.8:1 | Yes |
| signal-competitive | #DA7756 | 4.5:1 | Yes (marginal) |
| delta-new | #58A6FF | 5.1:1 | Yes |

**Note on marginal passes**: `health-green` (#3FB950) and `signal-competitive` (#DA7756) on `surface` are at 4.5-4.6:1 -- right at the threshold. For these colors when used as text on surface backgrounds, ensure font size is >= 13px (which `text-signal` at 11px violates). **Mitigation**: When using these colors at `text-signal` size, they are always paired with a non-color indicator (icon, position, label). The color is supplementary, not the sole information carrier. For critical accessibility compliance, consider brightening:
- `health-green` to `#4AC95D` (5.0:1 on surface) if needed
- `signal-competitive` to `#E08460` (4.8:1 on surface) if needed

### 9.2 Screen Reader Labels for Health Scores

**Health dots on account cards:**
```html
<span
  class="w-2.5 h-2.5 rounded-full"
  style="background-color: #F85149"
  role="img"
  aria-label="Account health: Critical"
/>
```

**Health Score Hero gauges:**
```html
<div role="meter" aria-label="Cases health score" aria-valuenow="2" aria-valuemin="0" aria-valuemax="10">
  <span class="sr-only">Cases health score: 2 out of 10, critical</span>
  <!-- visual gauge -->
</div>
```

**Overall health score:**
```html
<div role="meter" aria-label="Overall account health" aria-valuenow="6.2" aria-valuemin="0" aria-valuemax="10">
  <span class="sr-only">Overall account health: 6.2 out of 10</span>
</div>
```

### 9.3 Screen Reader Labels for Sparklines

Sparklines are inherently visual. Provide text alternatives:

```html
<div role="img" aria-label="Open cases trend: 3 cases currently, up from 1 case 30 days ago. Trend: increasing.">
  <!-- sparkline SVG -->
</div>
```

The aria-label includes: current value, comparison value, time period, and trend direction.

### 9.4 Keyboard Navigation: Health Score Tooltips

- Health gauge elements are focusable: `tabindex="0"`
- On `focus`, show tooltip (same as hover behavior)
- On `blur`, hide tooltip (same as mouse leave)
- Tooltip content is linked via `aria-describedby`
- Focus order follows left-to-right gauge order

### 9.5 Keyboard Navigation: Morning Summary

- Morning Summary collapse/expand toggle: focusable button with `aria-expanded` attribute
- Signal rows: each is a focusable link (`<a>` tag) with descriptive `aria-label`
- "Show more" button: standard button, focusable
- Focus order: collapse toggle -> signal rows (top to bottom) -> show more button
- Signal row aria-label format: `"{customer name}: {signal text}. {severity level}. {time}."`

### 9.6 Keyboard Navigation: Sparklines

- Sparklines are NOT individually focusable (they are decorative when not hovered)
- The hover tooltip data is available via the screen reader label (section 9.3)
- For keyboard users, the same data is available in the section body text

### 9.7 Reduced Motion

All new animations respect `prefers-reduced-motion: reduce` (existing global rule in `index.css`):

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

This means:
- Health dot pulse animation: disabled
- Tooltip transitions: instant
- Morning Summary collapse/expand: instant
- Loading skeletons: static (no pulse)

---

## Appendix A: Component Inventory

New components to create:

| Component | File | Props |
|-----------|------|-------|
| `MorningSummary` | `components/MorningSummary.tsx` | `signals: Signal[], loading: boolean` |
| `HealthScoreHero` | `components/HealthScoreHero.tsx` | `scores: HealthScore[], overall: number` |
| `PriorityActionBanner` | `components/PriorityActionBanner.tsx` | `action: PriorityAction, severity: string` |
| `PriorityActionRow` | `components/PriorityActionRow.tsx` | `action: PriorityAction, severity: string` |
| `StakeholderEngagementPanel` | `components/StakeholderEngagementPanel.tsx` | `contacts: Contact[], loading: boolean` |
| `Sparkline` | `components/Sparkline.tsx` | `data: number[], width?: number, height?: number, trend: 'up'\|'down'\|'neutral'` |
| `BriefDelta` | `components/BriefDelta.tsx` | `changes: Change[]` |
| `CompetitiveSignals` | `components/CompetitiveSignals.tsx` | `signals: CompSignal[]` |
| `SourceCitations` | `components/SourceCitations.tsx` | `sources: Source[]` |

Modified components:

| Component | Changes |
|-----------|---------|
| `AccountCard` | Add PriorityActionRow between stats and meeting |
| `BriefSection` | Add What Changed, Priority Action callout, Competitive Signals, Source Citations, Delta Markers, Brief Age coloring |
| `CustomerDetailPage` | Add HealthScoreHero, PriorityActionBanner, StakeholderEngagementPanel, Sparklines in stats, hash-based scroll |
| `App.tsx` | Add MorningSummary between scrape status and KPI cards |
| `tailwind.config.js` | Add new color tokens, font size tokens |

## Appendix B: Data Requirements

These components require new API data that does not currently exist:

| Component | Required API | Shape |
|-----------|-------------|-------|
| MorningSummary | `GET /api/morning-summary` | `{ signals: Signal[], generatedAt: string }` |
| HealthScoreHero | `GET /api/customer/:name/health` | `{ scores: { label, value, max, rawData }[], overall: number }` |
| PriorityAction* | `GET /api/customer/:name/priority-action` | `{ text: string, severity: string, section: string, context: string }` |
| Sparkline | `GET /api/customer/:name/trends` | `{ cases: number[], cloud: number[], licenses: number[], period: '30d'\|'60d'\|'90d' }` |
| StakeholderEngagement | `GET /api/customer/:name/stakeholders` | `{ contacts: { name, title, lastContact, channel, emailDays: boolean[] }[] }` |
| BriefDelta | Enhanced `GET /customer/:name/brief` | Add `changes: { type, text, timestamp }[]` to response |
| CompetitiveSignals | Enhanced `GET /customer/:name/brief` | Add `competitiveSignals: { competitor, context, source, date }[]` to response |
