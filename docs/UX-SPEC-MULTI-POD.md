---
Status: PENDING DECISION | Linked to: BKL-UX52 | Expires: when UX52 implementation complete
---

# UX Spec: Multi-AE / Multi-Pod Dashboard Architecture
**BKL-UX52 | Status: SPEC — Pending Implementation**
**Council Session:** 2026-04-10 | Participants: Serena (Architect), Aditi (Designer), Marcus (Engineer), Ava (Researcher)

---

## Problem Statement

With 9 AEs and 105 customers on the Southwest pod, the current flat customer list is already hard to navigate. At 2-pod scale (~18 AEs, 200 customers), the current layout becomes unusable. The redesign must make it possible to:
- See which customers need attention at a glance (without scrolling 200 rows)
- Navigate between pods without confusion
- Understand per-AE performance and per-customer health in a single screen

---

## Council Decisions

### 1. Top-Level Navigation: Pod Tabs

**Decision (unanimous):** Pod tabs at the very top of the dashboard. Not a sidebar, not a dropdown.

- Two tabs: `Southwest` / `Northwest` (names come from `data-sources.json`)
- Full-width tab bar, dark background (`#18181b`), active tab underlined in blue
- Tab selection persists in `localStorage`
- Each tab loads its pod's data independently via `?pod=<podId>` query param on all API calls

**Rejected alternatives:**
- Sidebar pod switcher — wastes horizontal space, breaks single-screen readability
- Pod dropdown — adds an extra click with no space savings

### 2. AE Grouping: Collapsible Headers Within Customer List

**Decision (3-1, Serena dissenting on semantic meaning but conceding tabs):** AEs are NOT routing destinations. They are collapsible grouping headers within the customer list.

Each AE section:
```
▾ Jane Smith (22 customers) | 4 cases | $1.2M pipeline | 3 renewals
  ├─ [●] Acme Corp           Sev2 case · $280K closes 14d
  ├─ [●] Globex Inc          3 open cases · renewal 45d
  └─ [○] Contoso Ltd         All clear
```

- Clicking the AE header row collapses/expands the customer rows beneath it
- Default state: all AE sections expanded
- AE header aggregate KPIs: customer count, open case count, pipeline ACV (current quarter), expiring renewals count

**Note:** If per-AE report views are needed in the future, they route to `/ae/:aeId`. That is out of scope for this spec.

### 3. Default Sort: Attention Score (Exception-Based)

**Decision (unanimous):** "Needs attention" as default sort — NOT alphabetical.

Customers with active alerts float to the top. Clean accounts sink. The user should see the 5 most critical customers immediately on load without scrolling.

Sort order:
1. `attentionScore` descending (primary)
2. Customer name ascending (tiebreaker)

The default sort applies within each AE group. The AE groups themselves are sorted by the highest `attentionScore` of any customer within the group (most-urgent AE group at the top).

### 4. Server-Side Attention Score

**Decision (unanimous):** Backend computes `attentionScore` per customer. Frontend sorts on the number — no client-side aggregation over 200 customers.

**Score formula (0–100, capped):**

| Signal | Points |
|---|---|
| Any Sev1 open case | +30 |
| Any Sev2 open case | +15 |
| Pipeline closing within 30 days (any amount) | +20 |
| Renewal expiring within 90 days | +15 |
| Customer brief older than 96 hours | +10 |

Score is included in every customer object in `/api/customers` response. Backend also returns `attentionReasons: string[]` — human-readable strings for each threshold that fired, used in the hover tooltip.

**Dot color thresholds:**
- Red: `score >= 70`
- Amber: `score >= 40`
- Green: `score < 40`
- Grey: no data (brief never generated, no cases loaded yet)

### 5. Customer Row: Composite Health Dot + KPI Chips

**Decision (unanimous):** Each customer row has a colored health dot (left edge) derived from `attentionScore`. On hover, the dot expands into a tooltip showing 4–6 KPI chips.

**Customer row layout (single line, 48px height):**
```
[●] Customer Name ......... [Sev2 case] [Pipeline $280K · 14d] [Renewal 45d]    Brief: 2h ago
```

- Health dot: 10px circle, `red/amber/green/grey`
- Customer name: left, 200px max, ellipsis overflow
- KPI chips: right-aligned, only chips where data exists (no empty chips)
- Brief age: far right, subtle grey text

**Health dot hover tooltip:**
```
┌─────────────────────────────────────┐
│ ● Needs Attention (score: 85)       │
│                                     │
│ 🔴 Sev2 case open (case #01234567)  │
│ 🟡 Pipeline $280K closes in 14 days │
│ 🟡 2 subscriptions expire in 45d    │
└─────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1 — Backend Schema + Scoring (Marcus, ~1 day)

**1a. Migrate `data-sources.json` to multi-pod schema:**
```json
{
  "pods": [
    {
      "id": "sw",
      "name": "Southwest",
      "aes": [ ... existing AE objects ... ]
    },
    {
      "id": "nw",
      "name": "Northwest",
      "aes": [ ... ]
    }
  ]
}
```

All existing server routes must accept `?pod=<id>` query param. Default to first pod if omitted.

**1b. Add `attentionScore` + `attentionReasons` to `/api/customers` response:**
```typescript
interface CustomerWithScore {
  // ... existing fields ...
  attentionScore: number          // 0-100
  attentionReasons: string[]      // ["Sev2 case open", "Pipeline closes in 14d"]
}
```

Score is computed server-side from cached data (cases, pipeline, subscriptions, brief timestamp). Must add no more than 5ms per customer at 200 customers.

### Phase 2 — Frontend Navigation (Aditi + Marcus, ~1 day)

**2a. Pod tab bar** — new component `PodTabBar`:
```tsx
<PodTabBar pods={pods} activePod={activePod} onChange={setActivePod} />
```
Full-width, 48px height, dark background, blue underline on active tab.

**2b. AE-grouped customer list** — replace flat `AccountPortfolioGrid` with `AEGroupedList`:
```tsx
<AEGroupedList
  aeGroups={groupedByAE}
  defaultSort="attentionScore"
  collapsible
/>
```

AE group header: collapsible row with AE name, customer count pill, aggregate KPI mini-bar.

**2c. Default sort** — `attentionScore` DESC within each group; AE groups sorted by max score of any member.

### Phase 3 — Health Dot + Tooltip (Aditi, ~0.5 day)

`HealthDot` component already exists in `dashboard/src/components/HealthDot.tsx`. Extend it:
- Accept `score: number` and `reasons: string[]` props
- Compute color from score using configurable thresholds
- Render hover tooltip with reason chips

### Phase 4 — Pod + AE Level KPI Tiles (Aditi + Marcus, ~0.5 day)

**Pod-level header** (below tab bar, above customer list):
```
Southwest Pod:  105 customers · 14 open cases · $28.1M pipeline · 7 renewals expiring
```

**AE-level header** (collapsible section header):
```
▾ Jane Smith (22 customers) | 4 cases | $1.2M pipeline · Q2 | 3 renewals
```

---

## What Does NOT Change

- Customer detail page layout
- Calendar strip
- CCSP section
- Product filter bar
- Brief generation flow
- Admin page

All of these become pod-filtered by passing `?pod=<id>` to their respective API calls. No layout or logic changes.

---

## Critical-Path Blocker

**`data-sources.json` multi-pod schema migration (Phase 1a) must ship first.**

No frontend tab UI, no AE grouping, no scoring can be built until the backend is pod-aware. Attempting the frontend before the backend means hardcoding pod data — do not do this.

**Sequence:** Phase 1 → Phase 2 → Phase 3 → Phase 4 → Quinn QA → Rook security scan → `make rebuild`

---

## Rejected Patterns

| Pattern | Why Rejected |
|---|---|
| Sidebar navigation | Wastes horizontal space; breaks single-screen readability on laptop |
| AEs as routes (`/ae/:id`) | Adds nav complexity; unnecessary at current scale |
| Client-side score aggregation | Too slow at 200 customers; produces visible sort-order flicker on load |
| Alphabetical default sort | Buries urgent accounts; defeats the purpose of the dashboard |
| Pod switcher dropdown | Extra click; no space savings vs tabs |

---

*Spec produced by Council (Serena/Aditi/Marcus/Ava), 2026-04-10. Implement in order. Do not skip phases.*
