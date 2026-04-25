# Design Specification: Subscription Tier Display in KPI Modals

**Version**: 1.0
**Author**: Aditi Sharma (Designer Agent)
**Date**: 2026-04-01
**Status**: Ready for Review
**Relates to**: BKL-M45 (free/trial filter in health-score.ts)

---

## 1. Problem Statement

The "Expiring Within 30 Days" KPI card currently shows **15 subscriptions** when only **3-4 are actionable paid renewals**. The remaining 11-12 are free-tier, beta, trial, or self-support subscriptions whose expiration is expected and requires zero action. This creates a signal-to-noise ratio of roughly 1:4 -- the SA cannot glance at this modal and immediately know which renewals need attention.

### Subscriptions That Create Noise

| Subscription | Why It Is Noise |
|---|---|
| Red Hat Quay.io (Free Tier), Self-Support | Free tier -- auto-renews or expires harmlessly |
| Red Hat Beta Access | Beta program -- expected lifecycle |
| 60 Day Product Trial of RHEL Server... | Trial -- conversion tracked elsewhere |
| 30 Day Product Trial Developer Sandbox... | Trial -- expected expiration |

### Impact on Current UX

1. **KPI card count is misleading**: "15" suggests 15 urgent renewals requiring SA action
2. **Modal is cluttered**: Real renewals are buried among noise rows
3. **Urgency coloring is diluted**: Red/amber badges on free trials create false alarm fatigue
4. **Health score is already correct**: `isFreeOrTrial()` in health-score.ts already excludes these from scoring -- the UI has not caught up

---

## 2. Research Findings

### 2.1 Industry Precedents

**Stripe Dashboard** -- Stripe's subscription management separates subscription tiers visually and in data. Their billing dashboard filters by subscription status (active, trialing, canceled, past_due) as first-class filter tabs, not buried toggles. Trial subscriptions get a distinct "trialing" badge and are excluded from MRR calculations by default. The principle: *trials are a separate lifecycle stage, not a variant of paid*.

**Salesforce Renewal Management** -- Salesforce CPQ and renewal dashboards use "Renewal Type" as a filterable dimension. Free/developer editions are excluded from renewal pipeline views by default. When included, they appear in a separate "Non-Revenue" section with muted styling. The principle: *revenue-impacting items get priority placement; non-revenue items are discoverable but deprioritized*.

**Datadog/Monitoring Dashboards** -- Alert dashboards universally implement severity-based filtering with smart defaults. Low-severity alerts are collapsed or hidden by default, with a toggle to expand. The count badge shows only actionable alerts. The principle: *the number on the badge must match the number of things you need to do something about*.

**HubSpot Deal Pipeline** -- Pipeline views exclude "lost" and "unqualified" deals from total counts by default, with filter chips to include them. The principle: *default view = decision-ready view*.

### 2.2 Notification Noise Reduction Patterns

Research from Smashing Magazine, Nielsen Norman Group, and Toptal identifies these recurring patterns:

1. **Classification by severity**: High/medium/low attention tiers with distinct visual treatment
2. **Smart defaults**: Show only actionable items by default; let users override
3. **Progressive disclosure**: Summary count first, expandable detail second
4. **Bundling**: Group low-priority items into a collapsed section rather than hiding entirely
5. **Badge accuracy**: The notification count must reflect items requiring action, not total items

### 2.3 Accessibility Requirements (WCAG 2.2)

- **SC 3.2.7 (Visible Controls)**: Toggle controls must be persistently visible, not hidden behind hover states
- **SC 1.3.1 (Info and Relationships)**: The distinction between paid and free/trial must be conveyed programmatically, not just visually
- **SC 1.4.1 (Use of Color)**: Muted styling for free/trial rows must not rely solely on color -- text labels or icons are required
- **SC 4.1.2 (Name, Role, Value)**: Toggle state must be communicated to assistive technology via `aria-pressed` or `aria-checked`
- **Discoverability**: WCAG 2.2 warns that hidden controls disadvantage users with memory-related disabilities. A visible toggle is preferred over hidden content with no indicator

### 2.4 Design Philosophy Alignment

From the existing VISUAL-DESIGN-SPEC.md, Section 1.1 ("Exception-Based Attention"):

> "The SA manages 15+ accounts. The default state is 'nothing happened.' Only deviations from normal warrant visual weight."

Free/trial expirations are *normal* -- they are expected lifecycle events. By the project's own design principles, they should visually recede. The current implementation violates this principle by giving them equal visual weight to paid renewals.

---

## 3. Recommendation: Option D+B Hybrid

### The Verdict

Neither A, B, C, nor D alone is sufficient. The correct answer is a **hybrid of D and B** -- what I am calling **Option E: "Filtered Default with Collapsible Disclosure."**

### Why Each Pure Option Falls Short

| Option | Strength | Fatal Flaw |
|---|---|---|
| A: Hide completely | Clean, decisive | Violates discoverability. SA cannot verify what was filtered. No way to spot a trial converting to paid. |
| B: Separate section at bottom | Preserves all data | Still inflates the KPI count. Modal opens with noise visible. Does not solve the "15 vs 3" badge problem. |
| C: Inline but muted | Minimal UI change | Noise rows still occupy vertical space. SA must visually parse every row. Defeats the purpose of triage. |
| D: Toggle (default off) | Clean default, user control | Toggle alone does not show *how many* items are hidden. SA might forget hidden items exist. |

### Option E: Filtered Default with Collapsible Disclosure

This combines Option D's smart default with Option B's grouped disclosure and adds a count indicator:

1. **KPI card count shows only paid renewals** (e.g., "3" not "15")
2. **Modal opens showing only paid renewals by default**
3. **A collapsible footer section reads**: "N free/trial subscriptions hidden" with a chevron to expand
4. **When expanded**, free/trial rows appear in a visually distinct section with muted styling
5. **Toggle state is not persisted** -- resets to collapsed on each open (the SA's morning scan should always start clean)

### Why This Is Correct

- **Badge accuracy**: The number "3" tells the SA exactly how many renewals need action
- **Progressive disclosure**: Detail is available but does not compete for attention
- **Discoverability**: The count indicator ("8 free/trial hidden") is always visible -- nothing is silently suppressed
- **Accessibility**: Meets SC 3.2.7 (visible control), SC 1.3.1 (programmatic distinction), SC 1.4.1 (text label, not just color)
- **Exception-Based Attention**: Aligns with the project's core design principle -- normal events recede, exceptions advance
- **Zero-config**: No settings page, no preference to manage, no cognitive load about whether the toggle is on or off

---

## 4. Mockup Description

### 4.1 KPI Card (Expiring Within 30 Days)

```
+--------------------------------------------------+
|  [Package icon]   3                              |
|                   Expiring Within 30 Days         |
|                   (8 free/trial excluded)          |
+--------------------------------------------------+
```

- **Primary count**: Shows only paid subscription count (bold, large, existing style)
- **Subtitle line**: "(N free/trial excluded)" in `text-text-secondary/60`, `text-[10px]`
- **Accent color logic**: Based on paid count only (green when 0 paid, red when > 0)
- **Sparkline**: Tracks paid-only count over time

### 4.2 Modal Header

```
+--------------------------------------------------------------+
|  [Package] Expiring Within 30 Days                           |
|  3 subscriptions . 2 accounts    [All] [By AE]    [X]       |
+--------------------------------------------------------------+
```

- Subscription/account counts reflect **paid only**
- Existing "All / By AE" toggle remains unchanged

### 4.3 Modal Body -- Paid Renewals (Default View)

```
+--------------------------------------------------------------+
|  ACME Corp                                        [->]   2   |
|  +--------------------------------------------------------+  |
|  | Red Hat OpenShift Container Platform...  x50   12d left |  |
|  | Red Hat Enterprise Linux Server...       x200   28d left|  |
|  +--------------------------------------------------------+  |
|                                                              |
|  Globex Industries                                [->]   1   |
|  +--------------------------------------------------------+  |
|  | Red Hat Ansible Automation Platform...   x25    7d left |  |
|  +--------------------------------------------------------+  |
+--------------------------------------------------------------+
```

- Identical to current modal styling for paid rows
- Full urgency coloring (red/amber backgrounds, bold day counts)

### 4.4 Modal Footer -- Collapsible Free/Trial Section

**Collapsed state (default):**

```
+--------------------------------------------------------------+
|  [ChevronRight] 8 free/trial subscriptions not shown         |
+--------------------------------------------------------------+
```

- Styling: `bg-border/10`, `text-text-secondary/70`, `text-xs`
- Chevron icon rotates on expand
- Full row is clickable (large tap target)
- `aria-expanded="false"` on the button
- `role="region"` with `aria-label="Free and trial subscriptions"` on the expandable content

**Expanded state:**

```
+--------------------------------------------------------------+
|  [ChevronDown] 8 free/trial subscriptions                    |
|  +--------------------------------------------------------+  |
|  |  [FREE]  Red Hat Quay.io (Free Tier)...   x1   expired |  |
|  |  [TRIAL] 60 Day Product Trial of RHEL..   x1   12d left|  |
|  |  [BETA]  Red Hat Beta Access              x1    3d left |  |
|  +--------------------------------------------------------+  |
+--------------------------------------------------------------+
```

- **Badge**: Each row gets a small pill badge: `FREE`, `TRIAL`, or `BETA`
  - Badge color: `bg-border/30 text-text-secondary` (neutral, no urgency)
- **No urgency coloring**: Rows use `bg-transparent border-border/30` instead of red/amber backgrounds
- **Day count**: Displayed in `text-text-secondary` (not `text-critical` or `text-warning`)
- **No linking to customer detail**: These rows do not deep-link (reducing false action signals)

### 4.5 Visual Hierarchy Summary

| Element | Visual Weight | Urgency Color | Clickable |
|---|---|---|---|
| Paid renewal row | Full (white text, colored bg) | Yes (red/amber) | Yes (customer link) |
| Free/trial disclosure toggle | Low (muted text) | No | Yes (expand/collapse) |
| Free/trial row (expanded) | Minimal (secondary text, no bg) | No | No |

---

## 5. KPI Card Count Behavior

### Current Behavior

| KPI Card | Shows |
|---|---|
| Expiring Within 30 Days | All subscriptions with daysLeft < 30 |
| Renewals in 30-90 Days | All subscriptions with 30 <= daysLeft <= 90 |

### Proposed Behavior

| KPI Card | Shows | Subtitle |
|---|---|---|
| Expiring Within 30 Days | **Paid only** with daysLeft < 30 | "(N free/trial excluded)" |
| Renewals in 30-90 Days | **Paid only** with 30 <= daysLeft <= 90 | "(N free/trial excluded)" or omit if 0 |

### Implementation Note

The `isFreeOrTrial()` function already exists in `src/health-score.ts` and is exported. The KPICards component should import it and apply the filter when computing `renewalRows`. This is a 5-line change to the `useMemo` in KPICards.tsx (line ~159):

```typescript
// After building rows array, split into paid and free/trial
const paidRows = rows.filter(r => !isFreeOrTrial(/* need ProductSubscription */))
const freeTrialRows = rows.filter(r => isFreeOrTrial(/* ... */))
```

**Data gap**: The current `RenewalRow` interface does not carry `sku`. The `isFreeOrTrial()` function checks both `productDescription` and `sku`. Two options:

1. Add `sku` to `RenewalRow` interface (preferred -- minimal change, preserves filter accuracy)
2. Create a parallel regex check on `productDescription` only (fragile -- sku-only matches would be missed)

Recommendation: Add `sku: string` to `RenewalRow` and pass it through from `acct.products`.

---

## 6. Health Score Display Differentiation

### Current State

The health score engine (`scoreSubscriptions()` in health-score.ts, line 95) already correctly excludes free/trial subscriptions via `isFreeOrTrial()`. The health score number is accurate.

### Proposed Enhancement

The health breakdown signal text should explicitly note the exclusion for transparency:

**Current**: `"Renewal due in 12 days"`
**Proposed**: `"Renewal due in 12 days (3 free/trial excluded)"`

This ensures the SA understands why the health score does not match the raw subscription count they might see in Supportable. No visual change needed -- just the signal string.

---

## 7. Classification Logic

### Tier Classification Rules

The existing `FREE_TRIAL_RE` regex in health-score.ts handles classification:

```
/\b(free|beta|trial|eval|evaluation|developer|self-support|no-support)\b/i
```

For badge display in the modal, classify into three categories:

| Badge | Matches |
|---|---|
| `FREE` | "free" or "self-support" or "no-support" in productDescription/sku |
| `TRIAL` | "trial" or "eval" or "evaluation" in productDescription/sku |
| `BETA` | "beta" in productDescription/sku |

If multiple keywords match, use priority order: BETA > TRIAL > FREE (beta programs are more specific than generic trial/free).

For "developer" keyword matches, classify as `FREE` (developer editions are typically free-tier).

---

## 8. Edge Cases

### 8.1 All Subscriptions Are Free/Trial

If all expiring subscriptions are free/trial, the KPI card shows **0** with green accent. The modal (if somehow opened) shows only the collapsible free/trial section, with no paid section. The subtitle on the KPI card reads "(N free/trial excluded)".

### 8.2 No Free/Trial Subscriptions

If all expiring subscriptions are paid, the collapsible footer section is not rendered at all. No toggle, no "0 free/trial hidden" message. Clean.

### 8.3 Mixed AE View

When grouped "By AE", free/trial subscriptions are excluded from all AE groups in the default view. The collapsible footer section is not grouped by AE -- it is a flat list (these are not actionable per-AE items).

### 8.4 Subscription Transitions

If a trial subscription converts to paid (e.g., product description changes on renewal), it will naturally stop matching `FREE_TRIAL_RE` and appear in the paid section. No special handling needed.

---

## 9. Accessibility Specification

### Keyboard Navigation

- Collapsible toggle is focusable via Tab
- Enter/Space toggles expanded state
- When expanded, free/trial rows are in tab order (even though not clickable -- for screen reader navigation)
- Escape from expanded section collapses it and returns focus to toggle

### Screen Reader Announcements

- Toggle button: `aria-expanded="false"` / `"true"`
- Toggle label: "Show 8 free and trial subscriptions" / "Hide 8 free and trial subscriptions"
- Expanded region: `role="region"` with `aria-label="Free and trial subscriptions"`
- Each free/trial row: Badge text is part of the accessible name (e.g., "Free tier: Red Hat Quay.io, quantity 1, expired")
- KPI card subtitle: Included in the card's accessible description via `aria-describedby`

### Color Independence

- Free/trial rows are distinguished by:
  1. Pill badge with text label (FREE/TRIAL/BETA)
  2. Absence of colored background
  3. Placement in a separate, labeled section
- No information is conveyed by color alone

### Motion

- Chevron rotation: `prefers-reduced-motion` media query disables animation; chevron snaps to final state
- Section expand/collapse: Uses `prefers-reduced-motion` to disable slide animation

---

## 10. Implementation Checklist

### Files to Modify

| File | Change |
|---|---|
| `dashboard/src/components/KPIRenewalsModal.tsx` | Add collapsible free/trial section, muted row styling, badge pills |
| `dashboard/src/components/KPICards.tsx` | Filter `renewalRows` into paid/freeTrial, pass both to modal, update subtitle |
| `dashboard/src/components/KPIRenewalsModal.tsx` (interface) | Add `sku: string` to `RenewalRow`, add `freeTrialRows` prop |
| `src/health-score.ts` | Update signal string to include exclusion count |

### New Dependencies

None. All styling uses existing Tailwind classes and Lucide icons (ChevronRight, ChevronDown).

### Testing Requirements

| Test | Validates |
|---|---|
| KPI card shows paid-only count | Count excludes free/trial |
| Modal default view shows paid only | Free/trial rows not in initial render |
| Collapsible toggle shows correct count | "N free/trial subscriptions not shown" |
| Expanding section reveals free/trial rows | Rows render with muted styling and badges |
| Badge classification is correct | FREE/TRIAL/BETA badges match regex |
| Screen reader announces toggle state | aria-expanded updates on toggle |
| Keyboard navigation works | Tab to toggle, Enter to expand, Escape to collapse |
| Edge: all free/trial shows 0 paid | KPI card green, subtitle shows exclusion count |
| Edge: no free/trial hides section | No collapsible footer rendered |

---

## 11. Sources and References

- [Smashing Magazine: Design Guidelines for Better Notifications UX](https://www.smashingmagazine.com/2025/07/design-guidelines-better-notifications-ux/)
- [Toptal: Notification Design Comprehensive Guide](https://www.toptal.com/designers/ux/notification-design)
- [Nielsen Norman Group: Indicators, Validations, and Notifications](https://www.nngroup.com/articles/indicators-validations-notifications/)
- [Qualtrics XM Institute: Action-Centric Dashboard Design](https://www.qualtrics.com/articles/customer-experience/action-centric-dashboard-design/)
- [UXPin: Dashboard Design Principles](https://www.uxpin.com/studio/blog/dashboard-design-principles/)
- [WCAG 2.2: SC 3.2.7 Visible Controls](https://www.w3.org/TR/WCAG22/)
- [BOIA: WCAG 2.2 Hidden Controls Requirements](https://www.boia.org/blog/wcag-2.2-introduces-new-requirements-for-hidden-controls)
- [Stripe: Design a Subscriptions Integration](https://docs.stripe.com/billing/subscriptions/design-an-integration)
- [Databox: Stripe MRR and Subscriptions Dashboard Template](https://databox.com/dashboard-examples/stripe-mrr-subscription-overview)
- [Eleken: Filter UI Examples for SaaS](https://www.eleken.co/blog-posts/filter-ux-and-ui-for-saas)
- [DataCamp: Effective Dashboard Design Principles](https://www.datacamp.com/tutorial/dashboard-design-tutorial)
