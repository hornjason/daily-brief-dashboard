---
doc-type: spec
status: active
owner: jason
updated: 2026-05-05
---

# Account Detail Page -- Complete Design Specification

**Version:** 1.0
**Date:** 2026-03-24
**Route:** `/customer/:customerName`
**Replaces:** existing customer.html
**Target:** 1440px desktop primary, responsive to 375px mobile

---

## 0. Key UX Principles (Account Deep-Dive Workflow)

1. **3-Second Orientation** -- The header must answer "which account, what's the health, what's urgent" before the user scrolls. Health dot + open cases + next meeting visible immediately.

2. **30-Second Prep** -- The Account Brief section (collapsed to overview by default) plus the right-column Quick Stats give the user enough context to join a call. No scrolling required for the minimum viable preparation.

3. **Progressive Disclosure** -- Every section starts compressed. The AI brief collapses to 3 lines. The timeline shows 10 items with "Load More." Meeting prep shows next 2 meetings. Expanding is the user's choice, never forced.

4. **Action Proximity** -- Every data point that implies an action has the action adjacent. A meeting card has its Join link. A case has its Portal link. An email has its Reply link. The user never has to context-switch to act.

5. **Temporal Orientation** -- The page is organized by time urgency, not data type. The header shows "next meeting in 2h." The timeline defaults to newest-first. Expiring products are red. Everything signals "what needs attention now?"

---

## 1. Color System Extensions

The existing design system covers the core palette. The account detail page needs these additional semantic tokens added to `tailwind.config.js`:

```js
// New tokens (extend existing colors object)
colors: {
  // ... existing tokens unchanged ...

  // Timeline type colors
  'timeline-meeting': '#00BCD4',    // reuse accent
  'timeline-email': '#A371F7',      // purple for email
  'timeline-doc': '#F0883E',        // orange for drive docs
  'timeline-case': '#F85149',       // reuse critical

  // Surface variants
  'surface-elevated': '#1C2128',    // slightly lighter than surface for hover/active states
  'surface-inset': '#0D1117',       // same as bg, for inset panels within cards

  // Health score
  'health-excellent': '#3FB950',    // reuse success
  'health-good': '#56D364',         // lighter green
  'health-fair': '#D29922',         // reuse warning
  'health-poor': '#F85149',         // reuse critical
}
```

These 7 new tokens extend without modifying any existing value. The timeline type colors create consistent visual differentiation across the activity feed.

---

## 2. TypeScript Interfaces (New Data Types)

```typescript
// Add to types.ts or new file: src/types/account-detail.ts

export interface EmailThread {
  threadId: string
  subject: string
  from: string
  fromDomain: string
  date: string
  snippet: string
  hasAttachments: boolean
  isActionRequired: boolean
  gmailUrl: string
}

export interface DriveDocument {
  id: string
  title: string
  mimeType: 'document' | 'spreadsheet' | 'presentation' | 'pdf' | 'folder'
  lastModified: string
  lastModifiedBy: string
  webViewLink: string
  thumbnailUrl?: string
  snippet?: string
}

export interface AccountBrief {
  accountOverview: string
  products: string
  objectives: string
  opportunities: string
  talkingPoints: string[]
  cachedAt: string
  generatedBy: string
}

export interface TimelineItem {
  id: string
  type: 'meeting' | 'email' | 'document' | 'case'
  timestamp: string
  title: string
  summary: string
  isFuture: boolean
  // Type-specific payload
  meetingData?: CalendarEvent
  emailData?: EmailThread
  documentData?: DriveDocument
  caseData?: SupportCase
}

export interface KeyContact {
  email: string
  name?: string
  domain: string
  meetingCount: number
  lastSeen: string
  role?: string
}

export interface AccountQuickStats {
  daysSinceLastContact: number
  totalMeetingsThisYear: number
  totalCasesEver: number
  renewalCountdownDays: number | null  // null if no renewal within 90 days
}

export interface AccountHealth {
  score: number          // 0-100
  label: string          // 'Excellent' | 'Good' | 'Fair' | 'Poor'
  color: string          // hex color
  signals: HealthSignal[]
}

export interface HealthSignal {
  name: string
  value: number          // 0-100 contribution
  weight: number         // 0-1 weight factor
  description: string
}
```

---

## 3. Full Layout Wireframe

### 3.1 Desktop (1440px+)

```
+--------------------------------------------------------------+
|  HEADER (fixed, h-16, full width, bg-surface, border-b)      |
|  [<-] CompanyName [health-dot]  | AE | Segment | Territory   |
|  Cases: 3  Products: 12  Licenses: 4.2K  Next: 2h  [Gen][Rf]|
+--------------------------------------------------------------+
|                                                                |
|  LEFT COLUMN (65%, pl-6 pr-3)    | RIGHT COLUMN (35%, pr-6)  |
|  overflow-y-auto                  | sticky top-16             |
|  max-h-[calc(100vh-64px)]        | max-h-[calc(100vh-64px)]  |
|                                   | overflow-y-auto           |
|  +---------------------------+   | +---------------------+   |
|  | Account Brief (collaps.)  |   | | Products & Subs     |   |
|  +---------------------------+   | +---------------------+   |
|  | Activity Timeline         |   | | Key Contacts        |   |
|  | (unified feed, 10 items)  |   | +---------------------+   |
|  +---------------------------+   | | Recent Emails       |   |
|  | Open Support Cases        |   | +---------------------+   |
|  +---------------------------+   | | Quick Stats         |   |
|  | Meeting Prep              |   | +---------------------+   |
|  +---------------------------+   |                            |
|  | Drive Documents           |   |                            |
|  +---------------------------+   |                            |
|                                                                |
+--------------------------------------------------------------+
```

**Grid implementation:**
```
<div className="flex min-h-screen bg-bg">
  <Sidebar />  {/* existing, w-60 */}
  <div className="flex-1 flex flex-col min-w-0">
    <AccountHeader />  {/* fixed, h-16 */}
    <div className="flex-1 flex overflow-hidden">
      <main className="w-[65%] overflow-y-auto p-6 pr-3 space-y-6">
        {/* Left column sections */}
      </main>
      <aside className="w-[35%] overflow-y-auto p-6 pl-3 space-y-4 sticky top-0">
        {/* Right column sections */}
      </aside>
    </div>
  </div>
</div>
```

### 3.2 Tablet (768px - 1023px)

Right column moves below the Account Brief section, before the Activity Timeline. This keeps the "context panel" (products, contacts, stats) visible early in the scroll, but allows the primary content to take full width.

```
+----------------------------------------------+
|  HEADER (full width, two rows)               |
|  Row 1: [<-] CompanyName [dot] [Gen] [Rf]   |
|  Row 2: AE | Segment | Cases | Products     |
+----------------------------------------------+
|  SINGLE COLUMN (full width, px-4)            |
|  +----------------------------------------+  |
|  | Account Brief                          |  |
|  +----------------------------------------+  |
|  | Products | Contacts | Stats (3-col)    |  |
|  +----------------------------------------+  |
|  | Recent Emails (inline)                 |  |
|  +----------------------------------------+  |
|  | Activity Timeline                      |  |
|  +----------------------------------------+  |
|  | Support Cases                          |  |
|  +----------------------------------------+  |
|  | Meeting Prep                           |  |
|  +----------------------------------------+  |
|  | Drive Documents                        |  |
|  +----------------------------------------+  |
```

### 3.3 Mobile (< 768px)

Single column. Header collapses to essential info. Right-column panels become horizontal scroll carousels or collapsible accordions.

```
+----------------------------------+
| [<-] CompanyName [dot]           |
| AE  Seg  3 cases  Next: 2h      |
| [Generate Brief] [Refresh]      |
+----------------------------------+
| Account Brief (collapsed)        |
+----------------------------------+
| Quick Stats (horizontal scroll)  |
+----------------------------------+
| Activity Timeline                |
+----------------------------------+
| Support Cases                    |
+----------------------------------+
| Meeting Prep                     |
+----------------------------------+
| Products (collapsed accordion)   |
+----------------------------------+
| Key Contacts (collapsed)         |
+----------------------------------+
| Recent Emails                    |
+----------------------------------+
| Drive Documents (2-col grid)     |
+----------------------------------+
```

---

## 4. Header Specification

### Component: `AccountHeader`

**Layout:** Fixed position, `h-16` (desktop) / `h-auto` (mobile). Two logical rows compressed into one on desktop.

```
// Desktop: single row, two halves
<header className="h-16 bg-surface border-b border-border px-6 flex items-center justify-between shrink-0">

  {/* Left side: navigation + identity */}
  <div className="flex items-center gap-4">

    {/* Back button */}
    <a href="/" className="text-text-secondary hover:text-text-primary transition-colors">
      <ArrowLeft className="w-5 h-5" />
    </a>

    {/* Company name + health */}
    <div className="flex items-center gap-2.5">
      <div
        className="w-3 h-3 rounded-full shrink-0"
        style={{ backgroundColor: health.color }}
        title={`Health: ${health.label} (${health.score}/100)`}
      />
      <h1 className="text-lg font-bold text-text-primary">{accountName}</h1>
    </div>

    {/* Metadata pills */}
    <div className="flex items-center gap-2">
      <span className="text-xs px-2 py-0.5 rounded bg-border/50 text-text-secondary">{aeName}</span>
      <span className="text-xs px-2 py-0.5 rounded bg-border/50 text-text-secondary">{segment}</span>
      <span className="text-xs px-2 py-0.5 rounded bg-border/50 text-text-secondary">{territory}</span>
    </div>
  </div>

  {/* Right side: stats + actions */}
  <div className="flex items-center gap-6">

    {/* Inline stats */}
    <div className="flex items-center gap-4 text-xs">
      <div className="flex items-center gap-1.5">
        <ShieldAlert className="w-3.5 h-3.5 text-warning" />
        <span className="text-text-primary font-semibold">{openCases}</span>
        <span className="text-text-secondary">cases</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Package className="w-3.5 h-3.5 text-success" />
        <span className="text-text-primary font-semibold">{productCount}</span>
        <span className="text-text-secondary">products</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Key className="w-3.5 h-3.5 text-warning" />
        <span className="text-text-primary font-semibold">{totalLicenses}</span>
        <span className="text-text-secondary">licenses</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Calendar className="w-3.5 h-3.5 text-accent" />
        <span className="text-accent font-semibold">{nextMeetingLabel}</span>
      </div>
    </div>

    {/* Action buttons */}
    <div className="flex items-center gap-2">
      <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-bg text-xs font-medium hover:bg-accent/80 transition-colors">
        <Sparkles className="w-3.5 h-3.5" />
        Generate Brief
      </button>
      <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-text-secondary text-xs hover:text-text-primary hover:border-text-secondary transition-all">
        <RefreshCw className="w-3.5 h-3.5" />
        Refresh
      </button>
    </div>
  </div>
</header>
```

**Mobile header (< 768px):** Stacks into 3 rows. Row 1: back + name + dot. Row 2: pills + stats (horizontal scroll). Row 3: action buttons full-width.

---

## 5. Account Brief Section

### Component: `AccountBriefSection`

**Card:** `bg-surface border border-border rounded-xl overflow-hidden`

**Default state:** Collapsed to show overview only (first 3 lines, `line-clamp-3`).

**Expanded state:** Shows all 5 sections as subsections with headers.

```
+-----------------------------------------------------------+
| [FileText icon] Account Brief         Cached: 2h ago [Regenerate] |
+-----------------------------------------------------------+
| ## Account Overview                                        |
| Enterprise manufacturing company with 4,200 RHEL...       |
| [line-clamp-3 when collapsed]                              |
+-----------------------------------------------------------+
| [v Expand full brief]                                      |
+-----------------------------------------------------------+

// Expanded adds:
| ## Products                                                |
| Primary RHEL estate with OpenShift growing...              |
| ## Objectives                                              |
| Modernize legacy workloads to containers...                |
| ## Opportunities                                           |
| Ansible Automation Platform POC approved...                |
| ## Talking Points                                          |
| * Ask about Q2 migration timeline                          |
| * Reference recent Sev1 case resolution                    |
| * Mention new RHEL 10 features relevant to their stack     |
+-----------------------------------------------------------+
```

**Section header pattern:**
```
<div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
  <div className="flex items-center gap-2">
    <FileText className="w-4 h-4 text-accent" />
    <h2 className="text-sm font-semibold text-text-primary">Account Brief</h2>
    <span className="text-xs text-text-secondary">Cached {relativeTime}</span>
  </div>
  <button className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border text-text-secondary text-xs hover:text-accent hover:border-accent/50 transition-colors">
    <RefreshCw className="w-3 h-3" />
    Regenerate
  </button>
</div>
```

**Brief body subsection headers:** `text-xs text-text-secondary uppercase tracking-wide font-medium mb-1.5` (matches existing pattern in MeetingPrepCards).

**Talking points:** Bulleted list with `text-accent` dot prefix, matching MeetingPrepCards pattern.

**Cache date:** Relative time display using existing `formatRelTime`. If stale (>24h), show in warning color: `text-warning`.

**Empty state:** "No brief cached for this account. Click 'Generate Brief' to create one." with a centered FileText icon at 48px, `text-text-secondary/40`.

**Loading state:** 3 horizontal bars at varying widths (80%, 65%, 90%) with `animate-pulse-slow`.

---

## 6. Activity Timeline

### Component: `ActivityTimeline`

**Design philosophy:** A single chronological feed mixing 4 data types. Each type has a distinct left-edge color and icon. This is the page's primary content surface -- it tells the story of your relationship with this account.

**Layout:** Vertical stack with left-side colored bar indicator.

```
+-----------------------------------------------------------+
| [Activity icon] Activity Timeline    [Filter: All v] [10 shown] |
+-----------------------------------------------------------+
|                                                            |
| [colored-bar] [icon] Title                     Timestamp   |
|               1-line summary                               |
|               [action link if applicable]                  |
|                                                            |
| [colored-bar] [icon] Title                     Timestamp   |
|               1-line summary                               |
|                                                            |
| ... 10 items default, "Load 10 more" button at bottom ... |
+-----------------------------------------------------------+
```

### 6.1 Timeline Item Base Structure

```
<div className={`flex gap-3 py-3 px-4 border-b border-border/40 hover:bg-surface-elevated/50 transition-colors ${
  item.isFuture ? 'bg-accent/3' : ''
}`}>

  {/* Left color bar */}
  <div className={`w-0.5 self-stretch rounded-full shrink-0 ${typeColorClass}`} />

  {/* Icon */}
  <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${typeIconBgClass}`}>
    <TypeIcon className="w-3.5 h-3.5" />
  </div>

  {/* Content */}
  <div className="flex-1 min-w-0">
    <div className="flex items-start justify-between gap-2">
      <span className="text-sm font-medium text-text-primary truncate">{item.title}</span>
      <span className="text-xs text-text-secondary shrink-0 font-mono">{formattedTime}</span>
    </div>
    <p className="text-xs text-text-secondary mt-0.5 line-clamp-1">{item.summary}</p>
    {actionLink && (
      <a href={actionLink} className="text-xs text-accent hover:underline mt-1 inline-block">
        {actionLabel}
      </a>
    )}
  </div>
</div>
```

### 6.2 Meeting Timeline Item

- **Left bar:** `bg-accent` (teal)
- **Icon background:** `bg-accent/15`
- **Icon:** `Calendar` in `text-accent`
- **Title:** Meeting title
- **Summary:** Attendee count + "with [first attendee name]..." or "Upcoming in 2h"
- **Action:** "Join" link if future + has joinUrl, "View Notes" if past + has notesUrl
- **Future distinction:** Light `bg-accent/5` background wash. A small `UPCOMING` badge: `text-xs px-1.5 py-0.5 rounded bg-accent/20 text-accent font-medium`

### 6.3 Email Timeline Item

- **Left bar:** `bg-[#A371F7]` (purple)
- **Icon background:** `bg-[#A371F7]/15`
- **Icon:** `Mail` in `text-[#A371F7]`
- **Title:** Email subject
- **Summary:** "From: [sender name]" + snippet preview
- **Action:** "Open in Gmail" link
- **Action-required badge:** If `isActionRequired`, show `ACTION` badge: `text-xs px-1.5 py-0.5 rounded bg-critical/20 text-critical font-medium`

### 6.4 Drive Document Timeline Item

- **Left bar:** `bg-[#F0883E]` (orange)
- **Icon background:** `bg-[#F0883E]/15`
- **Icon:** Varies by mimeType:
  - `document` -> `FileText`
  - `spreadsheet` -> `Table2`
  - `presentation` -> `Presentation`
  - `pdf` -> `FileText` (with different color treatment)
- **Icon color:** `text-[#F0883E]`
- **Title:** Document title
- **Summary:** "Modified by [lastModifiedBy]" + "Google Doc" / "Sheet" / "Slides"
- **Action:** "Open in Drive" link

### 6.5 Case Update Timeline Item

- **Left bar:** Severity-dependent:
  - Sev 1: `bg-critical`
  - Sev 2: `bg-warning`
  - Sev 3+: `bg-text-secondary`
- **Icon background:** `bg-critical/15` (Sev 1) / `bg-warning/15` (Sev 2) / `bg-border` (Sev 3+)
- **Icon:** `ShieldAlert` in severity color
- **Title:** "Case #[number]: [summary truncated]"
- **Summary:** Status + "Sev [N]" + "[daysOpen]d open"
- **Action:** "View in Portal" link to Red Hat support
- **Severity badge:** Same pattern as existing SupportCasesTable: `px-2 py-0.5 rounded text-xs font-bold font-mono` with severity color class

### 6.6 Future Item Visual Distinction

All future items (upcoming meetings, scheduled events) get:
1. A subtle background tint: `bg-accent/[0.03]` (barely perceptible)
2. A top-right badge: `UPCOMING` in `text-xs px-1.5 py-0.5 rounded-full bg-accent/15 text-accent`
3. The timestamp shows relative future time: "in 2h" / "Tomorrow 9:00 AM"

### 6.7 Filter Bar

Horizontal filter pills below the section header:
```
<div className="flex gap-1.5 px-4 pb-3">
  {['All', 'Meetings', 'Emails', 'Documents', 'Cases'].map(filter => (
    <button className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
      active === filter
        ? 'bg-accent/15 text-accent'
        : 'text-text-secondary hover:text-text-primary hover:bg-border/30'
    }`}>
      {filter}
    </button>
  ))}
</div>
```

### 6.8 Empty State

"No activity found for this account." Centered, with `Activity` icon at 40px, `text-text-secondary/30`.

### 6.9 Loading State

5 timeline item skeletons: each a horizontal bar with left color bar placeholder + text block placeholder. Heights alternate 48px and 56px for visual variation. All `animate-pulse-slow`.

---

## 7. Open Support Cases Section

### Component: `AccountCasesSection`

Reuses the existing `SupportCasesTable` component pattern but filtered to this account only. Presented as cards on this page (not a table) to match the detail page's card-based aesthetic.

**Card per case:**
```
<div className="bg-surface border border-border rounded-xl p-4 border-l-4"
  style={{ borderLeftColor: severityColor }}>

  <div className="flex items-start justify-between mb-2">
    <div>
      <span className="font-mono text-xs text-text-secondary">#{caseNumber}</span>
      <h3 className="text-sm font-medium text-text-primary mt-0.5">{summary}</h3>
    </div>
    <span className={`px-2 py-0.5 rounded text-xs font-bold font-mono ${severityBadgeClass}`}>
      Sev {severity}
    </span>
  </div>

  <div className="flex items-center gap-3 text-xs text-text-secondary">
    <span className={`px-2 py-0.5 rounded border ${statusBadgeClass}`}>{status}</span>
    <span>{daysOpen}d open</span>
    {product && <span className="truncate">{product}</span>}
  </div>

  <div className="mt-3 pt-3 border-t border-border/40 flex items-center justify-between">
    <span className="text-xs text-text-secondary">Last updated: {formatRelTime(lastUpdated)}</span>
    <a href={portalUrl} target="_blank" rel="noopener noreferrer"
       className="text-xs text-accent hover:underline flex items-center gap-1">
      View in Portal <ExternalLink className="w-3 h-3" />
    </a>
  </div>
</div>
```

**Layout:** `grid grid-cols-1 gap-3` (stack vertically -- cases are high-information-density items that need full width).

**Severity color mapping:** Same as existing SupportCasesTable:
- Sev 1: `bg-critical/20 text-critical`, border-left `#F85149`
- Sev 2: `bg-warning/20 text-warning`, border-left `#D29922`
- Sev 3: `bg-yellow-500/20 text-yellow-400`, border-left `#EAB308`
- Sev 4: `bg-border text-text-secondary`, border-left `#30363D`

**Portal URL pattern:** `https://access.redhat.com/support/cases/#/case/{caseNumber}`

**Empty state:** Green success message matching existing pattern:
```
<div className="bg-surface border border-border rounded-xl p-8 text-center">
  <ShieldCheck className="w-8 h-8 text-success mx-auto mb-2" />
  <p className="text-success text-sm font-medium">No open support cases</p>
  <p className="text-text-secondary text-xs mt-1">This account has no active cases</p>
</div>
```

**Loading state:** 3 card-shaped skeletons, `h-24 bg-surface border border-border rounded-xl animate-pulse-slow`.

---

## 8. Meeting Prep Section (Full-Width Variant)

### Component: `AccountMeetingPrep`

Shows the next 1-2 upcoming meetings for this account. Full-width variant of the command center's MeetingPrepCards but with more detail since we have full page width.

```
+-----------------------------------------------------------+
| [FileText] Meeting Prep                 Next 48h, 2 meetings |
+-----------------------------------------------------------+
|                                                            |
| +-------------------------------------------------------+ |
| | [left-border: accent]                                  | |
| |                                                        | |
| | 10:30 AM  Tue, Mar 24                     [Join] [Notes]| |
| | Quarterly Business Review - Acme Corp                  | |
| |                                                        | |
| | ATTENDEES: john@acme.com, sara@acme.com, +3 more      | |
| |                                                        | |
| | AGENDA                                                 | |
| | Review Q1 results, discuss expansion plans for...      | |
| |                                                        | |
| | TALKING POINTS FROM BRIEF                              | |
| | * Reference recent Sev1 resolution (Case #12345)      | |
| | * Ask about Q2 container migration timeline            | |
| | * Propose Ansible Automation Platform POC              | |
| +-------------------------------------------------------+ |
|                                                            |
+-----------------------------------------------------------+
```

**Card structure:**
```
<div className="bg-surface border border-border rounded-xl border-l-4 border-l-accent overflow-hidden">

  {/* Header row */}
  <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
    <div>
      <div className="flex items-center gap-2 mb-0.5">
        <Clock className="w-3.5 h-3.5 text-accent" />
        <span className="text-xs font-mono text-accent">{formatTime(event.start)}</span>
        <span className="text-xs text-text-secondary">{formatDay(event.start)}</span>
        {isToday && <span className="text-xs px-1.5 py-0.5 rounded-full bg-accent/15 text-accent">Today</span>}
      </div>
      <h3 className="text-sm font-semibold text-text-primary">{event.title}</h3>
    </div>
    <div className="flex items-center gap-2">
      {event.joinUrl && (
        <a href={event.joinUrl} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-bg text-xs font-medium hover:bg-accent/80 transition-colors">
          <Video className="w-3.5 h-3.5" /> Join
        </a>
      )}
      {event.notesUrl && (
        <a href={event.notesUrl} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-text-secondary text-xs hover:text-text-primary hover:border-accent/50 transition-colors">
          <FileText className="w-3.5 h-3.5" /> Notes
        </a>
      )}
    </div>
  </div>

  {/* Body: 2-column on desktop */}
  <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 divide-y lg:divide-y-0 lg:divide-x divide-border/40">

    {/* Left: Attendees + Agenda */}
    <div className="p-5 space-y-4">
      {/* Attendees */}
      <div>
        <div className="text-xs text-text-secondary uppercase tracking-wide font-medium mb-2">Attendees</div>
        <div className="flex flex-wrap gap-1.5">
          {attendees.slice(0, 5).map(a => (
            <span className="text-xs px-2 py-0.5 rounded bg-border/50 text-text-primary">{a}</span>
          ))}
          {attendees.length > 5 && (
            <span className="text-xs px-2 py-0.5 rounded bg-border/30 text-text-secondary">+{attendees.length - 5} more</span>
          )}
        </div>
      </div>

      {/* Agenda */}
      <div>
        <div className="text-xs text-text-secondary uppercase tracking-wide font-medium mb-2">Agenda</div>
        <p className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">{event.description || 'No agenda provided'}</p>
      </div>
    </div>

    {/* Right: Talking Points */}
    <div className="p-5">
      <div className="text-xs text-text-secondary uppercase tracking-wide font-medium mb-2">Talking Points</div>
      {talkingPoints.length > 0 ? (
        <ul className="space-y-2">
          {talkingPoints.map((pt, i) => (
            <li className="text-sm text-text-primary flex gap-2">
              <span className="text-accent mt-0.5 shrink-0">*</span>
              <span>{pt}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-text-secondary italic">Generate a brief to see talking points</p>
      )}
    </div>
  </div>
</div>
```

**Empty state:** "No upcoming meetings for this account in the next 48 hours." Same pattern as existing MeetingPrepCards empty state.

**Loading state:** Single card skeleton, `h-48 bg-surface border border-border rounded-xl animate-pulse-slow`.

---

## 9. Drive Documents Section

### Component: `AccountDriveDocuments`

**Layout:** `grid grid-cols-2 lg:grid-cols-3 gap-3`

**Card per document:**
```
<a href={doc.webViewLink} target="_blank" rel="noopener noreferrer"
   className="bg-surface border border-border rounded-xl p-4 hover:border-accent/30 transition-all group block">

  {/* Type icon + title */}
  <div className="flex items-start gap-3 mb-3">
    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${typeIconBg}`}>
      <TypeIcon className="w-4 h-4" style={{ color: typeColor }} />
    </div>
    <div className="min-w-0">
      <h3 className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors truncate">
        {doc.title}
      </h3>
      <span className="text-xs text-text-secondary">{docTypeLabel}</span>
    </div>
  </div>

  {/* Content preview */}
  {doc.snippet && (
    <p className="text-xs text-text-secondary leading-relaxed line-clamp-2 mb-3">
      {doc.snippet}
    </p>
  )}

  {/* Footer */}
  <div className="text-xs text-text-secondary flex items-center gap-1.5">
    <Clock className="w-3 h-3" />
    <span>Modified {formatRelTime(doc.lastModified)}</span>
    {doc.lastModifiedBy && <span className="truncate">by {doc.lastModifiedBy}</span>}
  </div>
</a>
```

**Type icon mapping:**
| mimeType | Icon | Background | Color |
|----------|------|-----------|-------|
| document | `FileText` | `bg-blue-500/15` | `#539BF5` |
| spreadsheet | `Table2` | `bg-green-500/15` | `#3FB950` |
| presentation | `Presentation` | `bg-yellow-500/15` | `#D29922` |
| pdf | `FileText` | `bg-red-500/15` | `#F85149` |

**Empty state:** "No documents found in Drive for this account." with `FolderOpen` icon at 40px, `text-text-secondary/30`.

**Loading state:** 6 card skeletons in the grid, `h-32 bg-surface border border-border rounded-xl animate-pulse-slow`.

---

## 10. Right Column -- Products & Subscriptions

### Component: `AccountProducts`

Compact table inside a card. Reuses the existing `ProductsModal` table pattern but inline, not in a modal.

```
<div className="bg-surface border border-border rounded-xl overflow-hidden">
  <div className="px-4 py-3 border-b border-border flex items-center justify-between">
    <div className="flex items-center gap-2">
      <Package className="w-4 h-4 text-accent" />
      <h3 className="text-xs font-semibold text-text-primary uppercase tracking-wide">Products</h3>
    </div>
    <span className="text-xs text-text-secondary">{products.length} products</span>
  </div>

  <div className="max-h-64 overflow-y-auto">
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-surface">
        <tr className="border-b border-border">
          <th className="text-left px-4 py-2 text-text-secondary font-medium">Product</th>
          <th className="text-center px-2 py-2 text-text-secondary font-medium w-12">Qty</th>
          <th className="text-right px-4 py-2 text-text-secondary font-medium w-24">Expires</th>
        </tr>
      </thead>
      <tbody>
        {products.map(p => (
          <tr className="border-b border-border/40 hover:bg-border/10 transition-colors">
            <td className="px-4 py-2 text-text-primary truncate max-w-[140px]">{p.productDescription}</td>
            <td className="px-2 py-2 text-center text-text-primary font-semibold">{p.quantity}</td>
            <td className={`px-4 py-2 text-right ${expiryColorClass(p.endDate)}`}>
              {formatDate(p.endDate)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
</div>
```

**Expiry color coding function:**
```typescript
function expiryColorClass(endDate?: string): string {
  if (!endDate) return 'text-text-secondary'
  const days = (new Date(endDate).getTime() - Date.now()) / 86_400_000
  if (days < 0) return 'text-critical font-bold'       // already expired
  if (days < 30) return 'text-critical'                  // <30 days
  if (days < 90) return 'text-warning'                   // <90 days
  return 'text-text-secondary'                            // >90 days
}
```

**Scroll behavior:** `max-h-64 overflow-y-auto` (256px max, roughly 8-9 product rows visible before scrolling).

**Empty state:** "No product data available." inside the card body, centered, italic, `text-text-secondary`.

**Loading state:** 4 table row skeletons.

---

## 11. Right Column -- Key Contacts

### Component: `AccountKeyContacts`

```
<div className="bg-surface border border-border rounded-xl overflow-hidden">
  <div className="px-4 py-3 border-b border-border flex items-center gap-2">
    <Users className="w-4 h-4 text-accent" />
    <h3 className="text-xs font-semibold text-text-primary uppercase tracking-wide">Key Contacts</h3>
  </div>

  <div className="p-3 space-y-1">
    {contacts.map(contact => (
      <div className="flex items-center justify-between py-1.5 px-1">
        <div className="min-w-0">
          <div className="text-xs text-text-primary truncate">
            {contact.name || contact.email}
          </div>
          <div className="text-xs text-text-secondary truncate">{contact.domain}</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-xs text-text-secondary font-mono">{contact.meetingCount}x</span>
          <div className={`w-1.5 h-1.5 rounded-full ${
            contact.meetingCount >= 5 ? 'bg-accent' :
            contact.meetingCount >= 2 ? 'bg-text-secondary' :
            'bg-border'
          }`} />
        </div>
      </div>
    ))}
  </div>
</div>
```

**Sorting:** By `meetingCount` descending (most-met contacts first).

**Meeting frequency dot:** Visual indicator -- teal for frequent (5+), gray for moderate (2-4), dim for single meeting.

**Empty state:** "No contacts found from calendar events."

**Loading state:** 4 line-item skeletons.

---

## 12. Right Column -- Recent Emails

### Component: `AccountRecentEmails`

```
<div className="bg-surface border border-border rounded-xl overflow-hidden">
  <div className="px-4 py-3 border-b border-border flex items-center justify-between">
    <div className="flex items-center gap-2">
      <Mail className="w-4 h-4 text-[#A371F7]" />
      <h3 className="text-xs font-semibold text-text-primary uppercase tracking-wide">Recent Emails</h3>
    </div>
    <a href={gmailSearchUrl} target="_blank" rel="noopener noreferrer"
       className="text-xs text-accent hover:underline">View all</a>
  </div>

  <div className="divide-y divide-border/40">
    {emails.slice(0, 4).map(email => (
      <a href={email.gmailUrl} target="_blank" rel="noopener noreferrer"
         className="block px-4 py-2.5 hover:bg-surface-elevated/50 transition-colors">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-text-primary font-medium truncate">{email.subject}</span>
          {email.isActionRequired && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-critical/20 text-critical shrink-0">ACTION</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-text-secondary truncate">{email.from}</span>
          <span className="text-xs text-text-secondary shrink-0">{formatRelTime(email.date)}</span>
        </div>
      </a>
    ))}
  </div>
</div>
```

**Gmail search URL:** `https://mail.google.com/mail/#search/from:${customerDomain}`

**Empty state:** "No recent emails with this customer."

**Loading state:** 3 email-item skeletons.

---

## 13. Right Column -- Quick Stats

### Component: `AccountQuickStats`

```
<div className="bg-surface border border-border rounded-xl p-4">
  <div className="flex items-center gap-2 mb-3">
    <BarChart3 className="w-4 h-4 text-accent" />
    <h3 className="text-xs font-semibold text-text-primary uppercase tracking-wide">Quick Stats</h3>
  </div>

  <div className="grid grid-cols-2 gap-3">

    {/* Days since last contact */}
    <div className="text-center p-2 rounded-lg bg-bg">
      <div className={`text-lg font-bold ${
        stats.daysSinceLastContact > 30 ? 'text-critical' :
        stats.daysSinceLastContact > 14 ? 'text-warning' :
        'text-text-primary'
      }`}>
        {stats.daysSinceLastContact}
      </div>
      <div className="text-xs text-text-secondary">days since contact</div>
    </div>

    {/* Total meetings this year */}
    <div className="text-center p-2 rounded-lg bg-bg">
      <div className="text-lg font-bold text-text-primary">{stats.totalMeetingsThisYear}</div>
      <div className="text-xs text-text-secondary">meetings (YTD)</div>
    </div>

    {/* Total cases ever */}
    <div className="text-center p-2 rounded-lg bg-bg">
      <div className="text-lg font-bold text-text-primary">{stats.totalCasesEver}</div>
      <div className="text-xs text-text-secondary">total cases</div>
    </div>

    {/* Renewal countdown */}
    {stats.renewalCountdownDays !== null && (
      <div className="text-center p-2 rounded-lg bg-bg">
        <div className={`text-lg font-bold ${
          stats.renewalCountdownDays < 30 ? 'text-critical' :
          stats.renewalCountdownDays < 60 ? 'text-warning' :
          'text-accent'
        }`}>
          {stats.renewalCountdownDays}d
        </div>
        <div className="text-xs text-text-secondary">to renewal</div>
      </div>
    )}
  </div>
</div>
```

**Loading state:** 4 stat cells with number skeletons.

---

## 14. Account Health Score

### 14.1 Health Score Computation

The health score is a weighted composite of 5 signals, each normalized to 0-100:

| Signal | Weight | Formula | Rationale |
|--------|--------|---------|-----------|
| **Case Severity** | 0.30 | 100 if no cases. -40 per Sev1, -20 per Sev2, -10 per Sev3. Floor 0. | Active Sev1 cases are the biggest health risk |
| **Contact Recency** | 0.25 | 100 if contacted within 7d. Linear decay to 0 at 60d. | Accounts go dark before they churn |
| **Renewal Proximity** | 0.20 | 100 if no renewal in 90d or renewal >90d away. Linear decay to 0 as renewal approaches with open issues. If renewal <30d and cases open: 0. | Renewal risk compounds with unresolved issues |
| **Meeting Frequency** | 0.15 | Map meetings-per-quarter to 0-100. 0 meetings = 0. 1 = 40. 2 = 60. 3 = 80. 4+ = 100. | Regular engagement indicates healthy relationship |
| **Case Resolution Velocity** | 0.10 | Average days-to-close for last 5 cases. <3d = 100, 3-7d = 80, 7-14d = 60, 14-30d = 40, 30d+ = 20. No history = 70 (neutral). | How quickly we resolve their issues signals operational health |

**Composite:** `score = sum(signal.value * signal.weight)`, rounded to integer.

**Label mapping:**
- 80-100: "Excellent" (`#3FB950`, success green)
- 60-79: "Good" (`#56D364`, lighter green)
- 40-59: "Fair" (`#D29922`, warning amber)
- 0-39: "Poor" (`#F85149`, critical red)

### 14.2 Health Score Display

In the header, the health score is represented as a colored dot (already specified in section 4). Additionally, the health score appears as a small visual in the right column Quick Stats section:

```
{/* Health score bar -- placed at top of Quick Stats */}
<div className="mb-3">
  <div className="flex items-center justify-between mb-1">
    <span className="text-xs text-text-secondary">Account Health</span>
    <span className="text-xs font-bold" style={{ color: health.color }}>
      {health.score} -- {health.label}
    </span>
  </div>
  <div className="h-1.5 bg-border rounded-full overflow-hidden">
    <div
      className="h-full rounded-full transition-all duration-500"
      style={{
        width: `${health.score}%`,
        backgroundColor: health.color,
      }}
    />
  </div>
</div>
```

This is a thin progress bar (1.5px height) with color that matches the score. Subtle, not gaudy. The dot in the header gives instant signal; the bar here gives precise value.

**Tooltip on header dot:** On hover, show a floating tooltip with all 5 signal values:
```
Account Health: 73/100 (Good)
--
Cases: 60/100 (1 Sev2 open)
Contact: 90/100 (3 days ago)
Renewal: 80/100 (next renewal in 120d)
Meetings: 60/100 (2 this quarter)
Resolution: 70/100 (avg 5d to close)
```

---

## 15. Responsive Behavior Summary

### Breakpoints

| Breakpoint | Layout | Key Changes |
|-----------|--------|-------------|
| >= 1440px | 65/35 two-column | Full layout as specified |
| 1024-1439px | 60/40 two-column | Slightly narrower left column, right column gets more room |
| 768-1023px | Single column | Right column content moves inline after Account Brief. Meeting prep and case cards go full width. Doc grid becomes 2-col. |
| < 768px | Single column, compact | Header stacks to 3 rows. Stats become horizontal scroll. Products/Contacts become collapsible accordions. Doc grid becomes 2-col. Timeline items show less detail. |

### Mobile-Specific Behaviors

1. **Header:** 3 rows instead of 1. Back button + name + health (row 1). Stats as horizontal scroll (row 2). Action buttons stacked or side-by-side at full width (row 3).

2. **Account Brief:** Same collapsible behavior, but starts collapsed to a single line (not 3 lines).

3. **Activity Timeline:** Items show title + time only (no summary line) until tapped/expanded.

4. **Meeting Prep:** Single column layout (no 2-col split between agenda and talking points).

5. **Right column panels:** Become collapsible accordion sections. Products starts collapsed on mobile. Key Contacts collapsed. Quick Stats visible (it's compact).

6. **Drive Documents:** 2-column grid (`grid-cols-2`), smaller cards with title + type + date only (no snippet).

---

## 16. Empty States (Complete Inventory)

| Section | Empty State Text | Icon | Icon Size |
|---------|-----------------|------|-----------|
| Account Brief | "No brief cached for this account. Click 'Generate Brief' to create one." | `FileText` | 48px |
| Activity Timeline | "No activity found for this account." | `Activity` | 40px |
| Support Cases | "No open support cases" (green) + "This account has no active cases" | `ShieldCheck` | 32px |
| Meeting Prep | "No upcoming meetings for this account in the next 48 hours" | `CalendarOff` | 40px |
| Drive Documents | "No documents found in Drive for this account" | `FolderOpen` | 40px |
| Products | "No product data available" (inline in card) | none | -- |
| Key Contacts | "No contacts found from calendar events" (inline in card) | none | -- |
| Recent Emails | "No recent emails with this customer" (inline in card) | none | -- |
| Quick Stats | Displays all stats as 0/dashes. No special empty state needed. | -- | -- |

All empty states use:
- Container: `text-center py-8` (left column sections) or `text-center py-4` (right column cards)
- Icon: `mx-auto mb-2 text-text-secondary/30`
- Primary text: `text-sm text-text-secondary`
- Secondary text: `text-xs text-text-secondary/70 mt-1`

---

## 17. Loading States (Skeleton Patterns)

Every section gets an independent loading state. This is critical because data loads from different APIs at different speeds.

| Section | Skeleton Pattern |
|---------|-----------------|
| Header stats | 4 inline stat values replaced with `h-4 w-8 bg-border rounded animate-pulse-slow` |
| Account Brief | 3 text lines at 80%, 65%, 90% width. `h-3 bg-border/50 rounded animate-pulse-slow` |
| Activity Timeline | 5 timeline items: each has `h-12 bg-border/30 rounded-lg animate-pulse-slow` with staggered delay |
| Support Cases | 3 case cards: `h-24 bg-surface border border-border rounded-xl animate-pulse-slow` |
| Meeting Prep | 1 card: `h-48 bg-surface border border-border rounded-xl animate-pulse-slow` |
| Drive Documents | 6 doc cards in grid: `h-32 bg-surface border border-border rounded-xl animate-pulse-slow` |
| Products table | 4 table rows: `h-8 bg-border/30 rounded` alternating widths |
| Key Contacts | 4 contact rows: `h-6 bg-border/30 rounded` |
| Recent Emails | 3 email rows: `h-12 bg-border/30 rounded` |
| Quick Stats | 4 stat cells: `h-16 bg-bg rounded-lg` with `h-6 w-10 bg-border/50 rounded animate-pulse-slow` centered |

All skeletons use the existing `animate-pulse-slow` class (2s ease-in-out, 0.4 min opacity) defined in `index.css`.

---

## 18. Navigation Integration

### From Command Center to Account Detail

The existing `AccountPortfolioGrid` already links each account card header to `/customer/${encodeURIComponent(account.name)}`. This route should render the `AccountDetailPage` component.

### Routing Setup (React Router or similar)

```typescript
// In App.tsx or router config
<Route path="/customer/:customerName" element={<AccountDetailPage />} />
```

The `AccountDetailPage` extracts `customerName` from URL params and uses it to:
1. Look up the account in `/api/accounts`
2. Fetch cases filtered by account
3. Fetch calendar events filtered by customer name
4. Fetch emails by customer domain
5. Fetch drive documents by customer folder
6. Fetch cached brief by customer name

### Sidebar Behavior

When on the account detail page, the sidebar should:
- Show the same navigation items
- Highlight none of the main nav items (or add a "Back to Command Center" option)
- Optionally show account-specific sub-nav: Brief / Timeline / Cases / Meetings / Docs

---

## 19. Component File Structure

```
src/
  components/
    account-detail/
      AccountDetailPage.tsx       -- Main page component, layout orchestrator
      AccountHeader.tsx           -- Fixed header with back nav, stats, actions
      AccountBriefSection.tsx     -- Collapsible AI brief
      ActivityTimeline.tsx        -- Unified chronological feed
      TimelineItem.tsx            -- Individual timeline item (all 4 types)
      AccountCasesSection.tsx     -- Support cases as cards
      AccountMeetingPrep.tsx      -- Full-width meeting prep cards
      AccountDriveDocuments.tsx   -- Drive doc grid
      AccountProducts.tsx         -- Right column products table
      AccountKeyContacts.tsx      -- Right column contacts list
      AccountRecentEmails.tsx     -- Right column email list
      AccountQuickStats.tsx       -- Right column stats + health bar
      AccountHealthTooltip.tsx    -- Health score tooltip component
    ... existing components unchanged ...
  types/
    account-detail.ts             -- New TypeScript interfaces
  hooks/
    useAccountDetail.ts           -- Data fetching hook for account detail page
```

---

## 20. API Endpoints Expected

The design assumes these API endpoints (for the engineer to implement):

| Endpoint | Response Shape | Purpose |
|----------|---------------|---------|
| `GET /api/accounts/:name` | `AccountInfo` | Single account details |
| `GET /api/accounts/:name/cases` | `{ cases: SupportCase[] }` | Cases for this account |
| `GET /api/accounts/:name/calendar` | `{ events: CalendarEvent[] }` | Meetings for this account |
| `GET /api/accounts/:name/emails` | `{ emails: EmailThread[] }` | Recent email threads |
| `GET /api/accounts/:name/drive` | `{ documents: DriveDocument[] }` | Drive documents |
| `GET /api/accounts/:name/brief` | `AccountBrief` | Cached AI brief |
| `POST /api/accounts/:name/brief` | `AccountBrief` | Generate new brief |
| `GET /api/accounts/:name/timeline` | `{ items: TimelineItem[] }` | Unified timeline |
| `GET /api/accounts/:name/contacts` | `{ contacts: KeyContact[] }` | Extracted contacts |
| `GET /api/accounts/:name/stats` | `AccountQuickStats` | Computed quick stats |
| `GET /api/accounts/:name/health` | `AccountHealth` | Computed health score |

---

*End of design specification.*
