---
doc-type: reference
status: active
owner: jason
updated: 2026-05-15
---

# Visual Design Spec — ASA Command Center

**Author:** Aditi Sharma (Designer Agent)
**Date:** 2026-05-15
**Review basis:** Screenshots of all 9 surfaces at 1440x900 viewport, source code review of all page and component files

---

## Design System Assessment

The dashboard uses a well-defined custom dark theme with design tokens in `tailwind.config.js`. The palette is GitHub-dark inspired (`#0D1117` bg, `#161B22` surface, `#00BCD4` accent). Typography uses Inter with a custom scale. The system is mostly consistent, with specific inconsistencies documented below.

**Positive foundations:**
- Custom scrollbar styling, focus-visible rings, reduced-motion support
- Consistent card pattern: `bg-surface border border-border rounded-xl`
- `tabular-nums` utility for numeric values
- Health/status color system with semantic backgrounds

---

## P0 — Broken / Inconsistent (Fix Before Ship)

### 1. ModulePageShell uses raw zinc values instead of design tokens

**Affected surfaces:** Campaigns, Tools, Events, Red Hat News, Products (all module pages)
**Screenshot ref:** 02-campaigns.png, 03-tools.png

ModulePageShell hardcodes `bg-zinc-900`, `bg-zinc-800`, `border-zinc-700`, `text-white`, `text-zinc-400` throughout. These do not match the design token palette. The shell creates a visible color mismatch between module pages and the Home/Accounts/Book of Business pages which correctly use `bg-bg`, `bg-surface`, `border-border`, `text-text-primary`.

**Files:**
- `dashboard/src/components/ModulePageShell.tsx` line 150: `bg-zinc-900` should be `bg-bg`
- Line 152: `bg-zinc-800 border-b border-zinc-700` should be `bg-surface border-b border-border`
- Line 155: `text-zinc-400` should be `text-text-secondary`
- Line 155: `text-white` should be `text-text-primary`
- Line 110: loading spinner `text-zinc-400` should be `text-text-secondary`
- Line 126: retry button `bg-zinc-700 hover:bg-zinc-600 text-white` should be `bg-surface-hover hover:bg-surface-active text-text-primary`

**Action:** Replace all raw zinc classes in ModulePageShell.tsx with design tokens. The delta between `zinc-900` (#18181b) and `bg` (#0D1117) is noticeable.

### 2. CustomerPicker uses raw zinc values

**Affected surfaces:** All module pages with picker
**Screenshot ref:** 02-campaigns.png, 03-tools.png

Same token drift issue. `CustomerPicker.tsx` uses `bg-zinc-800`, `border-zinc-700`, `text-zinc-100`, `text-zinc-300`, `text-zinc-400`, `text-zinc-500`, `bg-zinc-700/50`, `bg-zinc-900/50` throughout.

**Files:** `dashboard/src/components/CustomerPicker.tsx`
- Line 259: `bg-zinc-800 border border-zinc-700` should be `bg-surface border border-border`
- Line 269: `border-red-700` should be `border-critical`
- Line 291: Input field should use `bg-surface border-border text-text-primary placeholder-text-secondary`
- Line 298: Dropdown should use `bg-surface border-border`
- Lines 304, 310, 342: Selection states should use `bg-accent/20 text-accent` (current `bg-blue-500/20 text-blue-400` breaks accent consistency)

**Action:** The picker uses `blue-500` for focus/selection, but the design system accent is `#00BCD4` (teal/cyan). This is a palette collision. All `blue-500` references should become `accent`.

### 3. CustomerTabBar uses raw zinc values and blue-500

**Affected surfaces:** Customer detail page
**File:** `dashboard/src/components/CustomerTabBar.tsx`
- Line 52: `bg-[#18181b]` is a hardcoded hex. Should be `bg-surface` or a named token.
- Lines 68, 89: `bg-blue-500` for active indicator. Should be `bg-accent`.
- Lines 63, 80: `text-zinc-400 hover:text-zinc-200` should be `text-text-secondary hover:text-text-primary`.
- Line 93: Dropdown `bg-zinc-800 border-zinc-700` should be `bg-surface border-border`.

### 4. CampaignsPage "All Customers" view uses raw zinc

**File:** `dashboard/src/pages/CampaignsPage.tsx`
- Lines 60, 72: `text-zinc-400`, `text-zinc-600` instead of token classes
- Line 87: `text-zinc-300` heading should be `text-text-secondary`
- Line 93: Card `bg-zinc-800/50 border-zinc-700/50` should be `bg-surface/50 border-border/50`
- Line 100: Badge `bg-zinc-700 text-zinc-300` should be `bg-surface-hover text-text-secondary`

### 5. EventsPage filter chips use blue-500 instead of accent

**File:** `dashboard/src/pages/EventsPage.tsx`
- Lines 172-176: Active filter state uses `border-blue-500 bg-blue-500/10 text-blue-400`. The RedHatNewsPage correctly uses `border-accent bg-accent/10 text-accent` for identical filter chips.
- Event card badges (line 43-58): Format badges use `bg-green-500/20 text-green-400`, `bg-yellow-500/20 text-yellow-400`, `bg-blue-500/20 text-blue-400` -- these should use the health/status tokens (`bg-health-green-bg`, `bg-warning`, etc.) or at minimum follow a consistent badge pattern.
- Product tag badges (line 243-245): `bg-blue-500/20 text-blue-400` should be `bg-accent/10 text-accent` to match RedHatNewsPage's product tags.

**Action:** Standardize all filter chips across Events and RedHatNews to use `accent` token. Events should match News.

### 6. Customer detail page renders blank on initial load

**Screenshot ref:** 09-customer-detail.png (both attempts show empty page)
**Observed:** Navigating to `/dashboard/accounts/{name}` shows the top bar and sidebar but the main content area is completely empty. The SSE-based data loading does not render any loading skeleton or progress indicator while the stream connects.

**Root cause (from code):** The `CustomerDetailPage` waits for SSE data before rendering. The `customerNotFound` check on line 1177 (`!sectionLoading && meta === null`) can trigger before SSE completes if the stream takes time to start, showing the "Customer not found" page briefly, or the page renders nothing while `sectionLoading` is true but no sections have arrived yet.

**Action:** This is a functional issue as well as UX. The page MUST show:
1. A loading skeleton immediately on navigation
2. The SSE progress bar (which exists at line 1369 but is inside the `header` that only renders when `!customerNotFound`)
3. Customer name in the header from URL params even before SSE arrives

---

## P1 — Polish (Improve Quality)

### 7. Sidebar group headers lack visual weight in collapsed state

**Screenshot ref:** 10-sidebar-expanded.png, 11-sidebar-collapsed.png
**Observed:** In collapsed mode, the sidebar shows only icons with no group separators. The ACTIONS and INTELLIGENCE group headers disappear entirely (lines 231-238 only render `{!collapsed && ...}`). This means in collapsed mode, a user sees 13+ identical-looking icons with no grouping.

**Recommendation:**
- Add a thin horizontal divider (`border-t border-border/50`) between groups even in collapsed mode
- Keep the group header text hidden, but add the divider for visual separation

### 8. Sidebar active state indicator is too subtle

**Screenshot ref:** 10-sidebar-expanded.png
**Observed:** Active state uses `bg-accent/10 text-accent` which is a very faint teal wash. At the sidebar's width, this is barely distinguishable from hover state `hover:bg-border/30`.

**Recommendation:**
- Add a 2px left border indicator: `border-l-2 border-accent` on active items
- Or increase the background opacity: `bg-accent/15`

### 9. ModulePageShell header inconsistency with Home page header

**Screenshot ref:** 01-home.png vs 02-campaigns.png
**Observed:** The Home page uses the app-level header bar ("Command Center | Friday, May 15, 2026 | Last synced | Refresh"). Module pages using ModulePageShell have a SECOND header below that with the page title and CustomerPicker. This creates an inconsistent visual hierarchy:
- Home: 1 header bar → content
- Module pages: 2 header bars (app + module) → content

The module header (line 152) uses `sticky top-0 z-10` but does not account for the app-level header height, creating potential z-index stacking issues.

**Recommendation:**
- The module title should integrate with the app-level header, not create a second sticky bar
- Or: make the app-level header non-sticky on module pages so only the module header sticks

### 10. Empty state inconsistency across module pages

**Screenshot ref:** 03-tools.png
**Observed:** Empty states vary:
- ToolsPage: wrench icon + "Select a customer to access business value tools." (zinc-600 icon, zinc-400 text)
- CampaignsPage: mail icon + "No campaigns generated yet. Select a customer to create one."
- ModulePageShell built-in: generic with configurable icon/message (zinc-600 icon, zinc-400 text)

All empty state icons use `text-zinc-600` instead of the design token equivalent. More importantly, there is no consistent empty state component being shared.

**Recommendation:** Create a shared `EmptyState` component:
```tsx
// Standard empty state
<EmptyState icon="Wrench" message="Select a customer..." />
// Uses: text-text-secondary/40 for icon, text-text-secondary for message
```

### 11. Events page is extremely long with no pagination

**Screenshot ref:** 04-events.png (extends to ~5000px+ height)
**Observed:** The events list renders every single event in a single scroll. With many events, this creates an excessively long page. No "Show more" button or pagination exists.

**Recommendation:**
- Show first 10 events with a "Show N more" button (matches the Activity Timeline pattern in CustomerDetailPage)
- Or implement virtual scrolling for lists exceeding 20 items

### 12. Red Hat News page has no max-width constraint on article text

**Screenshot ref:** 05-rh-news.png
**Observed:** The page uses `max-w-6xl` container but article descriptions run the full width. At 1440px, description text lines can exceed 120 characters, well past the optimal 65-75 character line length for readability.

**Recommendation:** Apply `max-w-prose` or `max-w-3xl` to the description `<p>` elements, or increase the overall container constraint.

### 13. Products page has double title

**Screenshot ref:** 06-products.png
**Observed:** ModulePageShell renders "Product Intelligence" as the page title in the sticky header. Then line 463 renders ANOTHER `<h1>` "Product Intelligence" with a Refresh button. This is redundant and breaks heading hierarchy.

**Action:** Remove the inner `<h1>` on line 463 and move the Refresh All button into the ModulePageShell header area.

### 14. Accounts page card density could improve

**Screenshot ref:** 08-accounts.png
**Observed:** Account cards show customer name, a brief description, and upcoming meetings. The cards are well-structured, but the AE group headers ("Carolanne Farrell - 9 accounts") use a different visual weight than the sidebar nav.

**Recommendation:**
- AE group headers should use `text-xs font-semibold tracking-wider text-text-secondary uppercase` to match the sidebar group header pattern

### 15. Book of Business page lacks page-level header

**Screenshot ref:** 07-book-of-business.png
**Observed:** The page renders Pipeline and Cloud Spend sections directly with no page-level title or context. Unlike Home which has Morning Summary as context, this page jumps straight into data.

**Recommendation:** Add a simple page heading: "Book of Business" with optional subtitle showing the active filter state (AE name, product filters).

---

## P2 — Nice to Have

### 16. Sidebar version footer alignment

The "PAI Dashboard v0.1" footer text (Sidebar.tsx line 329) only shows when expanded. In collapsed mode, the footer area is completely absent. Consider showing a small "v0.1" text or icon indicator in collapsed mode for consistency.

### 17. Filter chip pattern standardization

Two filter chip patterns exist:
1. **Pill style** (Events, News): `rounded-full border px-3 py-1`
2. **Badge style** (Products): `rounded-lg border px-2.5 py-1`

Standardize on one. The pill style (rounded-full) is more conventional for filter chips.

### 18. Tooltip pattern for collapsed sidebar

Collapsed sidebar items show tooltips via CSS `opacity-0 group-hover:opacity-100`. This is fine but has no delay, so tooltips flash on mouse traversal. Consider a 200ms delay via Tailwind's `delay-200` or a proper tooltip component.

### 19. Card border radius consistency

The design token `rounded-card` (0.75rem / `rounded-xl`) is defined but not consistently used. Some cards use `rounded-lg` (0.5rem). Audit and standardize all cards to `rounded-xl` to match the token.

### 20. Loading state animation consistency

Three loading patterns exist:
1. `animate-spin` on RefreshCw icons (standard)
2. `animate-pulse-slow` on Skeleton components (custom, 2s)
3. `animate-pulse` on skeleton divs in ModulePageShell (Tailwind default, 2s)

The custom `animate-pulse-slow` and Tailwind's `animate-pulse` are nearly identical. Consolidate to one.

---

## Component-Level Token Migration Summary

| Component | Current | Should Be |
|---|---|---|
| ModulePageShell bg | `bg-zinc-900` | `bg-bg` |
| ModulePageShell header | `bg-zinc-800 border-zinc-700` | `bg-surface border-border` |
| ModulePageShell text | `text-white` / `text-zinc-400` | `text-text-primary` / `text-text-secondary` |
| CustomerPicker bg | `bg-zinc-800` | `bg-surface` |
| CustomerPicker focus | `ring-blue-500` | `ring-accent` |
| CustomerPicker selected | `bg-blue-500/20 text-blue-400` | `bg-accent/20 text-accent` |
| CustomerTabBar bg | `bg-[#18181b]` | `bg-surface` |
| CustomerTabBar indicator | `bg-blue-500` | `bg-accent` |
| CustomerTabBar text | `text-zinc-400` | `text-text-secondary` |
| Events filter active | `border-blue-500 bg-blue-500/10 text-blue-400` | `border-accent bg-accent/10 text-accent` |
| Events badges | `bg-green-500/20` etc. | `bg-health-green-bg` etc. |
| All empty state icons | `text-zinc-600` | `text-text-secondary/40` |
| All retry buttons | `bg-zinc-700 text-white` | `bg-surface-hover text-text-primary` |

---

## Spacing Audit

The spacing system is generally well-applied:
- **Page padding:** `p-6` consistently across Home, BookOfBusiness, Events content
- **Card internal:** `p-5` for primary cards, `p-4` for compact sub-cards
- **Section gaps:** `space-y-6` for major sections, `space-y-4` for sub-sections
- **Card gaps in grids:** Varies between `gap-3` and `gap-4` -- standardize on `gap-4`

---

## Typography Audit

The custom font size scale is well-designed:
- `text-hero` (18px/700) for account names
- `text-signal` (11px/500) for badges
- `text-priority` (14px/600) for action items
- `text-label` (13px/500) for field labels
- `text-detail` (14px/1.5) for body text

**Issue:** Most of the codebase does not use these custom sizes. Pages use standard Tailwind sizes (`text-sm`, `text-xs`, `text-lg`, `text-base`, `text-xl`). The custom sizes in the config exist but are only used in a few places.

**Recommendation:** Either remove unused custom sizes to reduce confusion, or audit all pages and apply the semantic sizes where appropriate (e.g., all section headings should use `text-priority`, all badge text should use `text-signal`).

---

## Summary of Changes by Priority

**P0 (5 items) — Must fix for visual consistency:**
1. Migrate ModulePageShell from zinc to design tokens
2. Migrate CustomerPicker from zinc/blue to design tokens
3. Migrate CustomerTabBar from zinc/blue to design tokens
4. Standardize filter chips across Events to match News (accent, not blue)
5. Fix customer detail blank page on initial load

**P1 (9 items) — Polish for enterprise quality:**
6. Sidebar collapsed group dividers
7. Sidebar active state indicator strengthening
8. ModulePageShell double-header issue
9. Empty state component standardization
10. Events pagination
11. News article line length
12. Products double title
13. Accounts AE header styling
14. Book of Business page header

**P2 (5 items) — Nice to have:**
15. Sidebar version footer in collapsed mode
16. Filter chip shape standardization
17. Tooltip delay on collapsed sidebar
18. Card border radius audit
19. Loading animation consolidation
