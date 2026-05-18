---
doc-type: reference
status: active
owner: jason
updated: 2026-05-15
---

# CustomerPicker Component

**GitHub Issue:** #236

## Overview

A shared, searchable customer dropdown component that fetches customer/AE data from the `/api/accounts` endpoint and provides filtering, keyboard navigation, and URL query param synchronization.

## Features

- ✅ Searchable dropdown (case-insensitive substring match on customer name)
- ✅ Grouped by AE with section headers
- ✅ Keyboard navigation (arrow keys, enter, escape)
- ✅ URL query param sync via `?customer=slug`
- ✅ Two scope modes: `customer` (one required) or `both` (includes "All customers")
- ✅ Dark theme matching existing dashboard design
- ✅ Click-outside-to-close behavior
- ✅ Loading and error states

## Usage

```tsx
import { CustomerPicker } from './components/CustomerPicker'
import { useState } from 'react'

function MyPage() {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)

  return (
    <CustomerPicker
      scope="customer"  // or "both" to include "All customers" option
      value={selectedSlug}
      onChange={setSelectedSlug}
    />
  )
}
```

## Props

| Prop | Type | Description |
|------|------|-------------|
| `scope` | `'customer' \| 'both'` | `'customer'` shows only customers (one must be selected). `'both'` includes "All customers" as the default option. |
| `value` | `string \| null` | Currently selected customer slug. `null` means no selection (or "All customers" in `both` mode). |
| `onChange` | `(slug: string \| null) => void` | Callback when selection changes. Receives customer slug or `null`. |

## URL Sync

The component automatically syncs with the `?customer=` query parameter:

- On mount, reads `?customer=slug` from the URL and calls `onChange` if present
- When user selects a customer, updates the URL param
- When user selects "All customers" (scope=both), removes the param

## Visual Design

- **Background:** `bg-zinc-800` with `border-zinc-700`
- **Text:** `text-zinc-100` (selected), `text-zinc-300` (default), `text-zinc-400` (placeholder)
- **Accent:** `blue-500` for focus rings and selections
- **Dropdown:** Positioned below input, max-height 80 (`max-h-80`), scrollable

## Keyboard Navigation

| Key | Behavior |
|-----|----------|
| `ArrowDown` | Open dropdown (when closed) or move to next item (when open) |
| `ArrowUp` | Move to previous item (skips AE headers) |
| `Enter` | Select focused item |
| `Escape` | Close dropdown and blur input |

## Data Flow

1. Fetches from `GET /api/accounts` on mount
2. Transforms response: `{ customers: [{ name, ae }] }` → `{ name, ae, slug }`
3. Filters by search query
4. Groups by AE name
5. Renders as searchable dropdown

## Testing

Unit tests are in `test/unit/customer-picker.test.ts` and test:

- ✅ Search filtering logic
- ✅ AE grouping logic
- ✅ Edge cases (empty input, no matches, customers with no AE)

Run tests:

```bash
bun test test/unit/customer-picker.test.ts
```

## Examples

See `CustomerPicker.example.tsx` for usage examples including:
- Customer-only scope
- Both scope (with "All customers")
- URL sync behavior
