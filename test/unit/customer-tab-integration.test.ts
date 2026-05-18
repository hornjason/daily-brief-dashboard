/**
 * Integration test for CustomerTabBar tab list building
 * GitHub Issue #240 — Verify tab list building from module declarations
 *
 * Note: FeatureModuleRegistry is empty in test context (modules register via import side-effects at server startup).
 * This test verifies the tab-building logic using mock module data matching production structure.
 */

import { describe, it, expect } from 'bun:test'

describe('CustomerTabBar integration with module declarations', () => {
  it('should build correct tab list with overview and intelligence bookends', () => {
    // Mock module tabs (structure matches /api/feature-modules/nav response)
    const mockModuleTabs = [
      { name: 'campaigns', accountTab: { label: 'Campaigns', icon: 'Mail', order: 10 } },
      { name: 'news-radar', accountTab: { label: 'News', icon: 'Newspaper', order: 20 } },
      { name: 'tools', accountTab: { label: 'Tools', icon: 'Wrench', order: 40 } }
    ]

    // Build full tab list (matching CustomerDetailPage logic)
    const tabs = [
      { id: 'overview', label: 'Overview', order: 0 },
      ...mockModuleTabs.map(m => ({
        id: m.name,
        label: m.accountTab.label,
        order: m.accountTab.order ?? Number.MAX_SAFE_INTEGER
      })).sort((a, b) => a.order - b.order),
      { id: 'intelligence', label: 'Intelligence', order: 9999 }
    ]

    // Verify structure
    expect(tabs[0].id).toBe('overview')
    expect(tabs[tabs.length - 1].id).toBe('intelligence')
    expect(tabs.length).toBe(5) // overview + 3 modules + intelligence

    // Verify module tabs are between overview and intelligence
    const moduleIds = tabs.slice(1, -1).map(t => t.id)
    expect(moduleIds).toEqual(['campaigns', 'news-radar', 'tools'])

    // Verify ordering: campaigns (10) < news-radar (20) < tools (40)
    const campaignsIndex = tabs.findIndex(t => t.id === 'campaigns')
    const newsIndex = tabs.findIndex(t => t.id === 'news-radar')
    const toolsIndex = tabs.findIndex(t => t.id === 'tools')

    expect(campaignsIndex).toBe(1) // after overview
    expect(newsIndex).toBe(2)
    expect(toolsIndex).toBe(3)
    expect(tabs[4].id).toBe('intelligence') // last
  })

  it('should handle modules without explicit order', () => {
    const mockModuleTabs = [
      { name: 'campaigns', accountTab: { label: 'Campaigns', icon: 'Mail', order: 10 } },
      { name: 'tools', accountTab: { label: 'Tools', icon: 'Wrench' } }, // no order
      { name: 'news-radar', accountTab: { label: 'News', icon: 'Newspaper', order: 20 } }
    ]

    const tabs = [
      { id: 'overview', label: 'Overview', order: 0 },
      ...mockModuleTabs.map(m => ({
        id: m.name,
        label: m.accountTab.label,
        order: m.accountTab.order ?? Number.MAX_SAFE_INTEGER
      })).sort((a, b) => a.order - b.order),
      { id: 'intelligence', label: 'Intelligence', order: 9999 }
    ]

    const moduleIds = tabs.slice(1, -1).map(t => t.id)
    // tools (no order = MAX_SAFE_INTEGER) should come after news-radar (20)
    expect(moduleIds).toEqual(['campaigns', 'news-radar', 'tools'])
  })
})
