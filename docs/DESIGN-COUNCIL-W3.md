# Design Council — W3 Binding Design Standards

**Status:** BINDING — all W3 UI items must conform to this document before implementation.
**Convened:** 2026-04-05 | **Council:** Aditi Sharma (design), Serena Blackwood (scalability), Marcus Webb (engineering)
**Blocks:** W3-02, W3-04, W3-05, W3-06, W3-09 and all future UI work

---

## 1. Typography Standard

### Tokens

The Tailwind config already overrides `text-xs` to 13px. Use **only** these tokens:

| Token | Size | Weight | Use |
|-------|------|--------|-----|
| `text-hero` | 18px | 700 | KPI hero numbers, health scores |
| `text-base` | 16px | 400 | Modal body, instructions |
| `text-priority` | 14px | 600 | Priority labels, section actions |
| `text-sm` | 14px | 400–500 | Card content, descriptions, case summaries, opp names |
| `text-sm font-medium` | 14px | 500 | Card titles, AE names, customer names, contact names |
| `text-sm font-semibold` | 14px | 600 | Section headers, tile titles |
| `text-xs` | 13px | 400–500 | Metadata, timestamps, badge labels, helper text |
| `text-signal` | 11px | 500 | Compact pill badges only (status, delta markers) |

### Rules

1. **`text-[10px]` is BANNED.** Minimum readable size is `text-signal` (11px), and only for compact badges. Five violations exist in `AdminPage.tsx` — must be upgraded before W3 UI work starts.
2. **Primary content is never `text-xs`.** Customer names, AE names, opportunity names, contact names, activity titles, and case summaries must use `text-sm` or larger. `text-xs` is reserved for metadata and badges.
3. **`line-clamp-N` requires `text-sm` minimum.** Never apply line-clamp to `text-xs` content — two lines of 13px is illegible at normal viewing distance. Current violation: case summaries in CustomerDetailPage at `text-xs line-clamp-2` → fix to `text-sm line-clamp-2`.
4. **No inline font sizes.** Never use `text-[Npx]` or `style={{ fontSize }}`. Use only Tailwind tokens or extend the config.

### Tailwind Config Extension (required before W3-02)

Add to `dashboard/tailwind.config.js` → `theme.extend.fontSize`:

```js
'label': ['0.8125rem', { lineHeight: '1.25rem', fontWeight: '500' }],  // alias for text-xs + medium
'detail': ['0.875rem', { lineHeight: '1.5rem' }],                       // alias for text-sm
```

This 30-minute quick win (Marcus) eliminates the need to audit every raw `text-xs`/`text-sm` usage and provides semantic intent.

---

## 2. Truncation / Overflow Standard

### Policy Table

| Content Type | Behavior | Rationale |
|-------------|----------|-----------|
| Customer name | `truncate` (1 line) | Fixed column width |
| AE name | `truncate` (1 line) | Always in constrained column |
| Opportunity name | `truncate` (1 line), tooltip on hover | Long names are common |
| Case summary | `line-clamp-2` at `text-sm` | Summary — not full text |
| Email subject | `truncate` (1 line) | Space-critical |
| Product name | `truncate` (1 line) | In table context |
| Contact name | `truncate` (1 line) | Fixed column |
| Section header | Never truncate | Layout must accommodate |
| Badge/pill text | Abbreviate content, not via CSS | Under 12 chars target |

### Rules

1. **Truncation is on the container, not the text.** Apply `truncate` or `line-clamp-N` to the container element, not inline on a `<span>`.
2. **Always pair `truncate` with `min-w-0`.** In flex children, `truncate` silently fails without `min-w-0` on the parent. This is the #1 cause of non-truncating text in the app.
3. **Tooltips for truncated primary content.** Any item where the full value has user decision value (opp name, contact name) must have a `title={}` attribute so native tooltip reveals it.
4. **No `overflow-hidden` on growing containers.** Use `overflow-y-auto` on scroll regions, not `overflow-hidden` — the sidebar has a latent clip at 16+ AEs.
5. **"Show more" pattern for lists.** When a tile/card has more than 3 items (cases) or 5 items (products/contacts), show the first N and a `+X more` link opening a modal. Do not `line-clamp` a list.

---

## 3. Grid / Column Width Standard (1–8 AE Scale)

### Dashboard Layout

```
┌─────────────────────────────┬──────────────┐
│ AccountPortfolioGrid (flex-1)│ Right column │
│                              │ (w-[38%])    │
└─────────────────────────────┴──────────────┘
```

- **Right column:** Change from `w-[35%]` → `w-[38%]` (Aditi: current 35% causes cramping of tile content)
- **Left column:** `flex-1` — absorbs all remaining space
- **No fixed px widths** on either column — always percentage or flex

### AE Group Card Grid

| AE Count | Card columns | Group default state |
|----------|-------------|---------------------|
| 1 | 2 | Expanded |
| 2–4 | 2 | Expanded |
| 5–8 | 2 | **Collapsed** (expand on click) |

**P0 fix (AccountPortfolioGrid.tsx line 668):** The `byAE` view currently renders all `<AEGroup>` with no `defaultCollapsed` prop, which defaults to `false` (expanded). At 8 AEs × 10 accounts each = 80 concurrent priority-action API calls fire on mount. Fix:

```tsx
<AEGroup
  key={ae}
  label={ae}
  count={aeAccounts.length}
  defaultCollapsed={aeGroups.length > 4}
>
```

This is a **one-line fix** that makes the app viable at scale. Must ship before any AE onboarding beyond current single-AE state.

### SetupPage AE List (Step 4)

- Currently: all customers for all AEs render flat
- Required: per-AE collapsible section in Step 4 (`AEsCustomersSection`)
- Same `defaultCollapsed` pattern as above — collapse all AEs by default when count > 2

---

## 4. Tile / Card Density Standards (Right Column)

### Component Structure

The right column tiles in `CustomerDetailPage.tsx` are currently **inline anonymous functions** inside a 1752-line file (`CasesSection`, `SubscriptionsSection`, `KeyContacts`, `DriveSection`). Any expand/collapse or density change **requires extracting these to named components first.** Do not attempt to add interactivity to inline functions — it creates unmaintainable state tangles.

**Extraction order (Marcus):**
1. `CasesSection` → `src/components/CasesSection.tsx` (most complex, highest priority)
2. `KeyContacts` → `src/components/KeyContactsSection.tsx`
3. `SubscriptionsSection` → `src/components/SubscriptionsSection.tsx`
4. `DriveSection` → `src/components/DriveSection.tsx`

### Density Rules

| Rule | Standard |
|------|---------|
| Tile header | `text-sm font-semibold text-text-secondary` + lucide icon at `16px` |
| Tile padding | `p-4` outer, `gap-3` between items |
| Item row height | Min `h-8` (32px) — never shorter |
| Max items before "Show more" | Cases: 3, Products: 5, Contacts: 4, Docs: 5 |
| "Show more" link | `text-xs text-accent cursor-pointer` + opens modal |
| Empty state | `<EmptyState>` component — never raw italic text |
| Loading state | Skeleton rows — never "Loading..." text |

### Right Column Width at Scale

At 8 AEs, the right column renders AE pill badges in the CCSP section. At current width (35%), 8 pills wrap to 3 lines. At 38%, they fit 2 lines. The `w-[38%]` change handles this without a layout redesign.

---

## 5. Label Alignment Standard

### Key-Value Pairs

Use CSS grid, not flex, for aligned key-value rows:

```tsx
<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
  <dt className="text-xs text-text-secondary whitespace-nowrap">Label</dt>
  <dd className="text-xs text-text-primary truncate">Value</dd>
</dl>
```

**Rules:**
1. `grid-cols-[auto_1fr]` — label column is content-width, value column fills remaining space
2. `whitespace-nowrap` on labels — prevents labels from wrapping mid-word
3. `truncate` + `min-w-0` on value column — values truncate, never push layout
4. Never use `justify-between` for key-value pairs — unpredictable at variable content lengths

### Badge / Tag Rows

```tsx
<div className="flex flex-wrap gap-1.5">
  {items.map(item => <span className="text-signal ...">{item}</span>)}
</div>
```

**Rules:**
1. `flex-wrap` + `gap-1.5` — badges wrap naturally, never overflow container
2. When count exceeds available space (e.g., 8 AE pills): show first 5, `+N more` pill
3. Never truncate badge text with CSS — abbreviate content at data level if too long

### Section Headers

```tsx
<h3 className="text-sm font-semibold text-text-secondary flex items-center gap-1.5 mb-3">
  <Icon className="w-4 h-4" />
  Section Title
</h3>
```

Icons always `w-4 h-4` (16px). No larger, no smaller in section headers.

---

## 6. Per-Page Change Priority

### P0 — Must fix before any W3 UI work starts

| # | Page | Location | Issue | Fix |
|---|------|---------|-------|-----|
| P0-1 | AdminPage | Lines 109, 214, 225, 297, 432 | `text-[10px]` below minimum | Replace with `text-signal` or `text-xs` |
| P0-2 | Dashboard | AccountPortfolioGrid.tsx:668 | All AE groups expanded by default | `defaultCollapsed={aeGroups.length > 4}` |

### P1 — Required for W3 completion

| # | Page | Location | Issue | Fix |
|---|------|---------|-------|-----|
| P1-1 | CustomerDetailPage | CasesSection (inline) | `text-xs line-clamp-2` | Extract component, change to `text-sm line-clamp-2` |
| P1-2 | CustomerDetailPage | Activity/product names | `text-xs` on primary content | Upgrade to `text-sm` |
| P1-3 | CustomerDetailPage | Right column tiles | Inline anonymous functions | Extract all 4 tiles to named components |
| P1-4 | Dashboard | AccountPortfolioGrid | Contact/opp names `text-xs` | Upgrade to `text-sm` |
| P1-5 | All | layout | Right column at 35% | Change to `w-[38%]` |

### P2 — Address in W3 iterations

| # | Page | Location | Issue | Fix |
|---|------|---------|-------|-----|
| P2-1 | SetupPage | AEsCustomersSection | No per-AE collapse | Add `defaultCollapsed` pattern |
| P2-2 | CustomerDetailPage | CCSP section | AE pills wrap > 2 lines at 8 AEs | `+N more` pill pattern |
| P2-3 | All | 39 files | 498 `text-xs` occurrences | Triage: metadata → keep, content → upgrade |
| P2-4 | All | components | Truncation without `min-w-0` | Audit 57 truncation sites, add `min-w-0` where needed |

### P3 — Latent / future-proofing

| # | Page | Location | Issue | Fix |
|---|------|---------|-------|-----|
| P3-1 | Sidebar | Sidebar.tsx | `overflow-hidden` clips at 16+ AEs | Change to `overflow-y-auto` |
| P3-2 | All | MeetingPrepCards.tsx | Dead code — imported nowhere | Delete file |
| P3-3 | Tailwind | tailwind.config.js | No semantic `label`/`detail` tokens | Add tokens (30 min, Marcus) |

---

## 7. Anti-Patterns (Never Do)

1. **`text-[10px]`** or any inline pixel size — use config tokens only
2. **`line-clamp-N` on `text-xs`** — too small to read at 2 lines
3. **Inline component functions in pages** — extract to named components before adding state
4. **`overflow-hidden` on scroll containers** — use `overflow-y-auto`
5. **`justify-between` for key-value alignment** — use CSS grid
6. **Truncate via badge abbreviation in CSS** — abbreviate data, not rendering
7. **80+ concurrent API calls on mount** — cap at 4; lazy-load when groups collapse

---

## 8. Implementation Order (Council Recommendation)

```
Week 1: P0 fixes (AdminPage text-[10px] + AccountPortfolioGrid collapse)
         → unblocks functional use at >1 AE

Week 2: P1-3 (extract right column tiles) + P1-5 (right column width)
         → required foundation for W3-02, W3-04, W3-05, W3-06

Week 3: P1-1, P1-2, P1-4 (text-sm upgrades after extraction complete)
         → resolves Aditi's 30+ readability violations

Week 4: P2 items (SetupPage collapse, CCSP pills, text-xs audit)
         → readiness for 8-AE onboarding
```

W3-05 and W3-06 specs from Aditi (expand/collapse tile state, "Show more" patterns) must be revised to conform to this document before implementation begins. Specifically: extraction must precede expansion.

---

*Council sign-off: Aditi Sharma (design audit complete), Serena Blackwood (8-AE scale analysis complete), Marcus Webb (implementation cost analysis complete)*
