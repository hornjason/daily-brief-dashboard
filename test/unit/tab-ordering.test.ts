/**
 * Unit tests for CustomerTabBar tab ordering and overflow logic
 * GitHub Issue #240 — Tab auto-discovery from Feature Module Registry
 */

import { describe, it, expect } from 'bun:test'

// ── Types (matching implementation contract) ────────────────────────────────

interface TabEntry {
  id: string
  label: string
  order: number
}

interface ModuleTabDeclaration {
  name: string
  accountTab: {
    label: string
    icon: string
    order?: number
  }
}

// ── Pure functions under test ────────────────────────────────────────────────

/**
 * Build the full tab list from module declarations.
 *
 * Rules:
 * - 'overview' is always first (order: 0)
 * - Auto-discovered tabs from modules, sorted by accountTab.order ascending
 * - 'intelligence' is always last (order: 9999)
 */
export function buildTabList(moduleTabs: ModuleTabDeclaration[]): TabEntry[] {
  const tabs: TabEntry[] = [
    { id: 'overview', label: 'Overview', order: 0 }
  ]

  // Add module tabs sorted by order (nulls last)
  const sorted = moduleTabs.slice().sort((a, b) => {
    const orderA = a.accountTab.order ?? Number.MAX_SAFE_INTEGER
    const orderB = b.accountTab.order ?? Number.MAX_SAFE_INTEGER
    return orderA - orderB
  })

  for (const module of sorted) {
    tabs.push({
      id: module.name,
      label: module.accountTab.label,
      order: module.accountTab.order ?? Number.MAX_SAFE_INTEGER
    })
  }

  // Intelligence always last
  tabs.push({ id: 'intelligence', label: 'Intelligence', order: 9999 })

  return tabs
}

/**
 * Split tabs into visible and overflow based on threshold.
 *
 * Rules:
 * - If total tabs <= threshold: all visible, overflow = []
 * - If total tabs > threshold:
 *   - 'overview' always visible (first)
 *   - 'intelligence' always visible (last)
 *   - Middle tabs fill remaining visible slots
 *   - Excess middle tabs → overflow
 */
export function splitTabsForOverflow(
  tabs: TabEntry[],
  threshold: number
): { visible: TabEntry[]; overflow: TabEntry[] } {
  if (tabs.length <= threshold) {
    return { visible: tabs, overflow: [] }
  }

  const overview = tabs[0]
  const intelligence = tabs[tabs.length - 1]
  const middle = tabs.slice(1, -1)

  // Available slots for middle tabs = threshold - 2 (overview + intelligence)
  const middleSlots = threshold - 2
  const visibleMiddle = middle.slice(0, middleSlots)
  const overflowMiddle = middle.slice(middleSlots)

  return {
    visible: [overview, ...visibleMiddle, intelligence],
    overflow: overflowMiddle
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('buildTabList', () => {
  it('should always include overview first and intelligence last', () => {
    const result = buildTabList([])
    expect(result).toEqual([
      { id: 'overview', label: 'Overview', order: 0 },
      { id: 'intelligence', label: 'Intelligence', order: 9999 }
    ])
  })

  it('should insert module tabs between overview and intelligence', () => {
    const modules: ModuleTabDeclaration[] = [
      { name: 'campaigns', accountTab: { label: 'Campaigns', icon: 'Megaphone', order: 1 } },
      { name: 'news-radar', accountTab: { label: 'News', icon: 'Newspaper', order: 2 } }
    ]

    const result = buildTabList(modules)
    expect(result).toEqual([
      { id: 'overview', label: 'Overview', order: 0 },
      { id: 'campaigns', label: 'Campaigns', order: 1 },
      { id: 'news-radar', label: 'News', order: 2 },
      { id: 'intelligence', label: 'Intelligence', order: 9999 }
    ])
  })

  it('should sort module tabs by order ascending', () => {
    const modules: ModuleTabDeclaration[] = [
      { name: 'tools', accountTab: { label: 'Tools', icon: 'Wrench', order: 5 } },
      { name: 'campaigns', accountTab: { label: 'Campaigns', icon: 'Megaphone', order: 1 } },
      { name: 'news-radar', accountTab: { label: 'News', icon: 'Newspaper', order: 3 } }
    ]

    const result = buildTabList(modules)
    const ids = result.map(t => t.id)
    expect(ids).toEqual(['overview', 'campaigns', 'news-radar', 'tools', 'intelligence'])
  })

  it('should handle modules without explicit order (append after ordered)', () => {
    const modules: ModuleTabDeclaration[] = [
      { name: 'campaigns', accountTab: { label: 'Campaigns', icon: 'Megaphone', order: 1 } },
      { name: 'tools', accountTab: { label: 'Tools', icon: 'Wrench' } }, // no order
      { name: 'news-radar', accountTab: { label: 'News', icon: 'Newspaper', order: 2 } }
    ]

    const result = buildTabList(modules)
    const ids = result.map(t => t.id)
    // undefined order sorts last
    expect(ids).toEqual(['overview', 'campaigns', 'news-radar', 'tools', 'intelligence'])
  })
})

describe('splitTabsForOverflow', () => {
  it('should not overflow when tabs <= threshold', () => {
    const tabs: TabEntry[] = [
      { id: 'overview', label: 'Overview', order: 0 },
      { id: 'campaigns', label: 'Campaigns', order: 1 },
      { id: 'news', label: 'News', order: 2 },
      { id: 'intelligence', label: 'Intelligence', order: 9999 }
    ]

    const result = splitTabsForOverflow(tabs, 7)
    expect(result.visible).toEqual(tabs)
    expect(result.overflow).toEqual([])
  })

  it('should overflow excess middle tabs when tabs > threshold', () => {
    const tabs: TabEntry[] = [
      { id: 'overview', label: 'Overview', order: 0 },
      { id: 'campaigns', label: 'Campaigns', order: 1 },
      { id: 'news', label: 'News', order: 2 },
      { id: 'tools', label: 'Tools', order: 3 },
      { id: 'products', label: 'Products', order: 4 },
      { id: 'reports', label: 'Reports', order: 5 },
      { id: 'dashboards', label: 'Dashboards', order: 6 },
      { id: 'intelligence', label: 'Intelligence', order: 9999 }
    ]

    // Threshold = 7 → visible = [overview, 5 middle, intelligence], overflow = [1 middle]
    const result = splitTabsForOverflow(tabs, 7)

    expect(result.visible.length).toBe(7)
    expect(result.overflow.length).toBe(1)

    expect(result.visible[0].id).toBe('overview')
    expect(result.visible[result.visible.length - 1].id).toBe('intelligence')
    expect(result.overflow[0].id).toBe('dashboards')
  })

  it('should always keep overview first and intelligence last in visible', () => {
    const tabs: TabEntry[] = [
      { id: 'overview', label: 'Overview', order: 0 },
      { id: 'a', label: 'A', order: 1 },
      { id: 'b', label: 'B', order: 2 },
      { id: 'c', label: 'C', order: 3 },
      { id: 'd', label: 'D', order: 4 },
      { id: 'e', label: 'E', order: 5 },
      { id: 'f', label: 'F', order: 6 },
      { id: 'g', label: 'G', order: 7 },
      { id: 'intelligence', label: 'Intelligence', order: 9999 }
    ]

    // Threshold = 5 → visible = [overview, 3 middle, intelligence]
    const result = splitTabsForOverflow(tabs, 5)

    expect(result.visible[0].id).toBe('overview')
    expect(result.visible[result.visible.length - 1].id).toBe('intelligence')
    expect(result.visible.length).toBe(5)
    expect(result.overflow.length).toBe(4)
  })

  it('should handle edge case: threshold = 2 (only overview + intelligence visible)', () => {
    const tabs: TabEntry[] = [
      { id: 'overview', label: 'Overview', order: 0 },
      { id: 'campaigns', label: 'Campaigns', order: 1 },
      { id: 'news', label: 'News', order: 2 },
      { id: 'intelligence', label: 'Intelligence', order: 9999 }
    ]

    const result = splitTabsForOverflow(tabs, 2)

    expect(result.visible).toEqual([
      { id: 'overview', label: 'Overview', order: 0 },
      { id: 'intelligence', label: 'Intelligence', order: 9999 }
    ])
    expect(result.overflow).toEqual([
      { id: 'campaigns', label: 'Campaigns', order: 1 },
      { id: 'news', label: 'News', order: 2 }
    ])
  })
})
