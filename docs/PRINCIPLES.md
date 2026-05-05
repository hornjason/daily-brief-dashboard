---
doc-type: architecture
status: active
owner: jason
updated: 2026-05-05
---

# Design Principles — Typography and Visual Constraints

These rules were extracted from the W3 (Week 3) design council pass and are
binding for any UI work in `dashboard/`. They are intentionally restrictive —
the goal is visual consistency and accessibility floor compliance across every
surface in the app.

Companion docs: `docs/VISUAL-DESIGN-SPEC.md`, `docs/DESIGN-COUNCIL-W3.md`
(archived).

---

## 1. Typography Floor — `text-[10px]` is BANNED

`text-[10px]` is **banned** anywhere a user can see it. The minimum visible
text size is `text-xs` (12px). No exceptions for "dense tables" or "metadata
strips" — if the text is too long for `text-xs`, the layout is wrong, not the
type scale.

**Why:** `text-[10px]` fails WCAG AA at typical viewing distances and reads
as broken on Retina displays. The 12px floor protects accessibility and
visual coherence.

---

## 2. `text-xs` is RESERVED for Secondary Metadata

`text-xs` is allowed **only** for:

- Badges and pills (status, severity, count)
- Timestamps and "x ago" relative dates
- Helper text (form hints, inline validation messages)
- Footnotes and small disclosure labels

`text-xs` is **not** allowed for:

- Primary content (descriptions, brief body, customer narrative)
- Card titles or section headers
- Anything the user is expected to read as a unit of information

If the content is the point of the surface, it must be at least `text-sm`
(14px).

---

## 3. Line-Clamp Rules

- `line-clamp-1` — single-line truncation in cards, table cells, and badge
  containers. Always pair with a tooltip or expandable surface so the full
  content is reachable.
- `line-clamp-3` — **maximum** for body text in constrained card surfaces.
  Beyond 3 lines the layout becomes a wall of grey; use a "Show more" toggle
  or a detail page instead.

Do not use `line-clamp-2` as a default. Pick 1 (truncation indicator) or 3
(meaningful preview). 2 is the awkward middle.

---

## 4. Tailwind Token Reference

Use the table below as the canonical mapping. If you find yourself reaching
for an arbitrary value (`text-[13px]`, `font-[550]`), the answer is no — pick
the closest token from this table.

| Use case | Token | Notes |
|----------|-------|-------|
| Card titles | `text-sm font-medium` | Not bold |
| Section headers | `text-sm font-semibold` |  |
| Body text | `text-sm` | Default prose |
| Secondary labels | `text-xs text-muted-foreground` |  |
| Badges | `text-xs` |  |
| BANNED | `text-[10px]` | Too small for accessibility |

`font-bold` (700) is reserved for the page-level page title and KPI hero
numbers. Card titles use `font-medium` (500); section headers use
`font-semibold` (600).

---

## 5. Spacing — Tokens Only

Use Tailwind spacing tokens (`p-2`, `gap-4`, `mt-6`). **No arbitrary pixel
values** (`p-[7px]`, `mt-[13px]`).

The spacing scale (`0.5`, `1`, `2`, `3`, `4`, `6`, `8`, `12`) gives enough
granularity for any real layout. Reaching for an arbitrary value is almost
always a sign the surrounding rhythm is off and the fix is to adjust a
neighboring spacing, not introduce a one-off.

---

## 6. Color — Semantic Tokens Only

Use semantic color tokens, not raw colors:

- `text-foreground` — primary text
- `text-muted-foreground` — secondary text, metadata
- `text-primary` — brand/accent emphasis
- `bg-background`, `bg-card`, `bg-muted`
- `border-border`, `border-input`

**Banned:** `text-gray-500`, `text-zinc-700`, `text-[#666]`, etc. Raw color
values bypass the theme system and break dark mode.

The theme is the source of truth for color. If the design needs a color that
doesn't exist as a token, add a token — don't paint it inline.
