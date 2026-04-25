---
Last validated: 2026-04-24
---

# DailyBriefDashboard Unified Redesign Specification

**Date:** 2026-04-01
**Input:** 9-agent research synthesis + 4 specialist deep dives (Serena/Architecture, Aditi/Design, Marcus/Engineering, UI Explorer/Inventory)
**Status:** Ready for review — no code changes yet

---

## Executive Summary

Four specialist agents independently analyzed the same research findings and converged on a remarkably consistent redesign. The key additions — Morning Summary, Customer Health Score, Priority Actions, Temporal Deltas, Sparklines, Stakeholder Engagement, Competitive Signals, and Brief Noise Reduction — are all feasible with **zero breaking changes** to the existing 8,796 LOC frontend and Bun+Hono backend.

**Total new components:** 9 | **Modified components:** 5 | **New API endpoints:** 7 | **New color tokens:** 12 | **Estimated storage:** ~8.4 MB/year

---

## 1. Where All 4 Agents Agree

### Morning Summary is Position 1
All agents agree: the Morning Summary card is the **first content element** after the TopBar, before KPI cards. It pushes intelligence to the SA rather than requiring them to hunt. Zero-state shows "All clear across N accounts" — calm, not empty.

### Health Score Replaces Case-Only Triage
The current `getHealthStatusFromCases()` in AccountPortfolioGrid.tsx:23 is case-only. All agents agree it should become a **weighted composite** from 6 signals:

| Signal | Weight | Score Logic |
|--------|--------|-------------|
| Cases | 25% | 100=none, 60=Sev3/4, 30=Sev2, 0=Sev1 |
| Subscriptions | 20% | 100=no renewal in 90d, 10=within 30d or expired |
| Meetings | 15% | 100=met in 14d, 10=60d+ gap |
| Emails | 15% | 100=email in 7d, 10=30d+ gap |
| Pipeline | 15% | 100=on track or none, 30=needs tech win |
| Cloud Spend | 10% | 100=stable/growing, 10=declining >20% |

**Status thresholds:** >= 70 green, 40-69 yellow, < 40 red

### Priority Action = One Thing Per Customer
Every agent independently specified: surface exactly ONE priority action per customer, not a list. Priority ranking:
1. Sev1 case open
2. Renewal <30d with no meeting scheduled
3. Meeting today with no brief
4. Stakeholder gone silent (was weekly, now 30d+)
5. Competitor mention in last 7d
6. Pipeline opp closing <14d

### Sparklines Use Raw SVG, Not Recharts
Marcus confirmed: at 200 cards, Recharts would be catastrophic for performance. All agents agree on **64x24px raw `<svg><polyline>`** with optional area fill at 10-15% opacity. Recharts stays for the existing CloudSpend donut only.

### All Changes Are Additive
No existing endpoints are modified in breaking ways. All new fields are optional additions to existing responses. All new endpoints are net-new. The existing 260-test suite should pass unchanged.

---

## 2. Where Agents Disagree (Decisions Made)

### Sparklines on Account Cards

| Agent | Position |
|-------|----------|
| **Serena (Architect)** | Yes — sparkline for cloud ACV under card stats |
| **Aditi (Designer)** | **No** — crosses clutter threshold, 64x24 is decoration at card scale |
| **Marcus (Engineer)** | Feasible either way, but flags performance concern at 200 cards |

**Decision: Aditi wins.** Sparklines appear ONLY on the Customer Detail page. The account card health dot serves as the at-a-glance indicator. Research backs this: "72% of sellers want simplicity over functionality."

### KPI Card Sparklines on Portfolio Page

| Agent | Position |
|-------|----------|
| **Serena** | Yes — 30-day sparkline under each of the 7 KPI cards |
| **Aditi** | Not explicitly addressed for KPI cards (focused on account cards) |
| **Marcus** | Feasible — only 7 sparklines, no performance concern |

**Decision: Include.** 7 sparklines on the KPI row is fine — the concern was 200+ on account cards. KPI sparklines add directional context ("are cases trending up?") that raw numbers miss.

### Health Score Display Format

| Agent | Position |
|-------|----------|
| **Serena** | 0-100 numeric score + R/Y/G dot |
| **Aditi** | 0-10 scale with 6 mini progress bar gauges (HealthScoreHero) |

**Decision: Both.** Account cards show Serena's simple dot (0-100 internal, R/Y/G display). Customer Detail page shows Aditi's HealthScoreHero with 6 gauges on a 0-10 display scale. Different contexts need different detail levels.

### Morning Summary Layout

| Agent | Position |
|-------|----------|
| **Serena** | Two-column: Priority Actions (left) + Top Signals (right) |
| **Aditi** | Single-column signal list with severity color bars on left edge |

**Decision: Aditi's design for v1.** The single-column signal list is simpler, works better at all breakpoints, and Aditi's severity color bar system (3px left edge, red/amber/cyan) creates a scannable "severity strip." The two-column layout can be a v2 enhancement if the SA wants more content density.

### Brief Section Order on Customer Detail

| Agent | Position |
|-------|----------|
| **Serena** | Priority Action card BETWEEN header and brief |
| **Aditi** | Priority Action INSIDE the brief, after "What Changed" |

**Decision: Serena's approach.** Priority Action as a standalone card between header and brief makes it impossible to miss and keeps the brief focused on intelligence content. Aditi's brief-internal callout design is used for the visual treatment of the card itself.

---

## 3. Unified Component Architecture

### New Components (9)

| Component | File | Primary Agent | Key Spec |
|-----------|------|---------------|----------|
| `MorningSummary` | `components/MorningSummary.tsx` | Aditi | Single-column signal list, severity color bars, collapsible, zero-state |
| `HealthScoreHero` | `components/HealthScoreHero.tsx` | Aditi | 6 signal gauges + overall score, Customer Detail only |
| `HealthDot` | `components/HealthDot.tsx` | Serena | Composite health dot replacing case-only, tooltip on hover |
| `PriorityActionBanner` | `components/PriorityActionBanner.tsx` | Aditi | Full-width card on Customer Detail, severity-colored left border |
| `PriorityActionRow` | `components/PriorityActionRow.tsx` | Aditi | Compact row for Account Cards, `Zap` icon + truncated text |
| `Sparkline` | `components/Sparkline.tsx` | Both | 64x24 raw SVG polyline, trend coloring, area fill |
| `StakeholderEngagementPanel` | `components/StakeholderEngagementPanel.tsx` | Aditi | Contact list with frequency bars, "gone silent" flags |
| `TemporalDeltaSection` | `components/TemporalDeltaSection.tsx` | Serena | "What Changed Since [date]" with colored triangle markers |
| `CompetitiveSignalBadge` | `components/CompetitiveSignalBadge.tsx` | Aditi | Orange-bordered badge for competitor mentions |

### Modified Components (5)

| Component | Changes |
|-----------|---------|
| `KPICard` (KPICards.tsx) | Add optional `sparkline` prop → renders `Sparkline` below value |
| `AccountCard` (AccountPortfolioGrid.tsx) | Replace `getHealthStatusFromCases` with composite `HealthDot` + add `PriorityActionRow` between stats and meeting |
| `AccountPortfolioGrid` | Triage groups: Critical (<40) / Attention (40-69) / Healthy (70+) instead of case-based |
| `BriefSection` (CustomerDetailPage.tsx) | Add temporal delta, source citations, competitive signals section, delta markers, brief age coloring |
| `App.tsx` (Dashboard) | Insert `MorningSummary` between scrape status indicators and KPI cards |

---

## 4. New API Endpoints (7)

| Endpoint | Returns | Cache Strategy |
|----------|---------|----------------|
| `GET /api/health-scores` | All customers: `{ score, status, breakdown }[]` | 5 min, invalidated on data change |
| `GET /api/health-scores/:name` | Single customer full breakdown | Same as above |
| `GET /api/kpis/history` | 30-day daily metric snapshots | Appended daily, never stale |
| `GET /api/morning-summary` | Cross-customer signals, priority actions | Computed fresh each request |
| `GET /api/customer/:name/temporal-delta` | Changes since last interaction | Computed on demand |
| `GET /api/customer/:name/stakeholder-engagement` | Per-contact email frequency | 30 min cache |
| `GET /api/customer/:name/priority-action` | Single most important action | No cache (real-time) |

**Key constraint (Marcus):** Health score v1 uses ONLY cached data — no new API calls per customer. Reads from existing case cache, subscription cache, calendar API response, gmail API response, pipeline cache, and CCSP cache.

---

## 5. Design System Additions

### Color Tokens (12 new)

```
Health:       health-red (#F85149), health-amber (#D29922), health-green (#3FB950)
              + bg/border variants at 10%/25% opacity
Signals:      signal-competitive (#DA7756), signal-silent (#8B949E)
              + bg variants at 12% opacity
Deltas:       delta-new (#58A6FF) + bg variant at 10% opacity
Sparklines:   spark-up (#3FB950), spark-down (#F85149), spark-neutral (#484F58)
              + fill variants at 15% opacity
```

All pass WCAG AA (4.5:1+) against `bg` (#0D1117). Two marginal on `surface`: health-green (4.6:1) and signal-competitive (4.5:1) — always paired with non-color indicators per Aditi's colorblind safety spec.

### Typography (3 new)

| Class | Size | Weight | Usage |
|-------|------|--------|-------|
| `text-hero` | 18px | 700 | Health score numbers on detail page |
| `text-signal` | 11px | 500 | Signal badges, sparkline labels |
| `text-priority` | 14px | 600 | Priority action text |

---

## 6. Implementation Phases

Based on cross-agent consensus, ordered by independent shippability and dependency chain:

### Phase 1: Foundation (parallel, no dependencies between items)

| Item | BKL | Effort | What Ships |
|------|-----|--------|------------|
| Health Score API + HealthDot | R04 | 2-3d | Composite health replaces case-only dots, triage view upgraded |
| Brief prompt updates | R01-R03 | 1d | Temporal delta + priority action + noise reduction in Gemini output |
| Sparkline component + KPI history | R05 partial | 2-3d | 30-day sparklines under 7 KPI cards |
| Tailwind config + design tokens | — | 0.5d | Color/typography foundation for all new components |

### Phase 2: Intelligence Layer (depends on Phase 1 health scores)

| Item | BKL | Effort | What Ships |
|------|-----|--------|------------|
| Morning Summary API + component | R06 | 3-4d | Cross-customer daily intelligence card at position 1 |
| Priority Action API + Banner + Row | R03 | 2-3d | One action per customer on detail page + account cards |
| Stakeholder Engagement API + Panel | R09 | 3-4d | Per-contact frequency, "gone silent" flags |

### Phase 3: Brief Enhancement (depends on Phase 1 prompt changes)

| Item | BKL | Effort | What Ships |
|------|-----|--------|------------|
| Brief delta detection | R07 | 2d | Cache comparison, triangle markers on changed content |
| Competitive signal tracking | R08 | 2-3d | Keyword scan emails/cases, orange badges in brief |
| Source citations | R03 | 1d | Superscript references with hover tooltips |
| Brief age indicator | — | 0.5d | Color-coded staleness pill (green/amber/red) |

### Phase 4: Trends (independent, can run parallel to Phase 2-3)

| Item | BKL | Effort | What Ships |
|------|-----|--------|------------|
| Historical snapshots storage | R05 | 2d | Daily metric capture to kpi-history.json |
| Customer detail sparklines | R05 | 2d | Cases/cloud/pipeline sparklines in stat row + section headers |

---

## 7. What We Are NOT Building (Anti-Recommendations)

Per research (Johannes/contrarian findings, all 9 agents agreed):

- **AI-generated action item lists** — Busywork multiplier. ONE priority action, not 14.
- **Complex health score dashboards** — Keep it R/Y/G + 6-gauge hero. Not a 34-module Gainsight clone.
- **Automated email sequences** — Brand risk. Out of scope.
- **Predictive deal scoring** — Requires clean CRM data we don't control. Black box.
- **Team/multi-user features** — Single-user architecture is a feature at this scale, not a bug.

---

## 8. SA Workflow Validation

### Morning Review (7:00 AM, 5 minutes)

1. Open dashboard → **Morning Summary** shows "3 accounts need attention, 2 meetings today"
2. Scan signal list → Sev1 case at Acme (red bar), renewal at Fabrikam (amber bar)
3. Click Acme → Customer Detail → **HealthScoreHero** shows Cases: 0/10, overall: 3.2
4. **PriorityActionBanner**: "Review and escalate Sev1 case #12345"
5. Back → scan KPI sparklines → cases trending up, cloud spend stable
6. Done. 5 minutes. Every action item identified.

### Meeting Prep (10 minutes before meeting)

1. Click customer from calendar or Morning Summary signal
2. **"What Changed Since Last Interaction"** section: 3 items with colored triangles
3. **Competitive Signals**: VMware mentioned in 2 email threads
4. **Talking Points**: 3 prioritized items, first maps to priority action
5. **Stakeholder Engagement**: Bob Chen gone silent 21 days (was weekly contact)
6. Walk into meeting knowing more than anyone else at the table.

### Account Deep Dive (as needed)

1. Full brief with source citations — every claim traced to Supportable, Gmail, CCSP, etc.
2. Sparklines in stat row show 30-day trajectories for cases, cloud spend, pipeline
3. Stakeholder engagement panel shows per-contact email frequency bars
4. Health score breakdown reveals which signals are dragging the score down

---

## 9. Risk Register

| Risk | Mitigation |
|------|------------|
| Health score computation adds latency | v1 reads ONLY from existing caches — zero new API calls (Marcus) |
| Morning Summary API slow with many customers | Computed from local caches only, no external calls |
| Sparkline rendering at scale | Raw SVG polyline, not Recharts — tested at 200 cards |
| Brief prompt changes break existing briefs | R01/R02/R03 are prompt-only changes to `customer.ts:322` — existing sections preserved, new sections added |
| 12+ silent `.catch({})` failures (research finding) | BKL-S01 (fix silent failures) should be done BEFORE or IN PARALLEL with Phase 1 — reliability before features |
| Stale/wrong health scores from bad data | Health endpoint returns `lastUpdated` per signal; UI shows staleness |

---

## 10. Source Documents

- **Research Synthesis:** `docs/research-ai-customer-intelligence-2026.md` (9 agents, 80+ sources)
- **Information Architecture:** `docs/INFORMATION-ARCHITECTURE-V2.md` (Serena Blackwood)
- **Visual Design Spec:** `docs/VISUAL-DESIGN-SPEC.md` (Aditi Sharma)
- **Engineering Feasibility:** Marcus Webb analysis (all 9 features feasible, zero breaking changes)
- **Component Inventory:** UI Explorer (26 files, 8,796 LOC, 17 reusable components)
- **Backlog Items:** `BACKLOG.md` BKL-R01 through BKL-R10

---

*Synthesized from 4 specialist agent deep dives + 9-agent extensive research. Ready for Jason's review.*
