// test/unit/feature-module-nav.test.ts
// Unit tests for FeatureModule nav/accountTab/scope extensions (GitHub Issue #234)
// Tests getNav(), getAccountTabs(), and nav API endpoint.

import { describe, test, expect, beforeEach } from 'bun:test'
import type { FeatureModule, NavDeclaration, AccountTabDeclaration, ModuleScope } from '../../src/feature-module-registry.ts'

let FeatureModuleRegistry: any

beforeEach(async () => {
  delete require.cache[require.resolve('../../src/feature-module-registry.ts')]
  const mod = await import('../../src/feature-module-registry.ts')
  FeatureModuleRegistry = mod.FeatureModuleRegistry
})

function makeModule(overrides: Partial<FeatureModule> & { name: string }): FeatureModule {
  return {
    cachePaths: () => [],
    fetch: async () => {},
    cleanup: async () => {},
    syncNow: async () => {},
    ...overrides,
  }
}

describe('FeatureModuleRegistry — nav extensions (#234)', () => {
  // ── getNav() ────────────────────────────────────────────────────────────────

  test('getNav() returns empty array when no modules declare nav', () => {
    FeatureModuleRegistry.register(makeModule({ name: 'no-nav' }))
    expect(FeatureModuleRegistry.getNav()).toEqual([])
  })

  test('getNav() returns modules that declare nav', () => {
    const nav: NavDeclaration = { label: 'Campaigns', icon: 'megaphone', group: 'actions', path: '/campaigns' }
    FeatureModuleRegistry.register(makeModule({ name: 'campaigns', nav, scope: 'portfolio' }))
    FeatureModuleRegistry.register(makeModule({ name: 'no-nav' }))

    const result = FeatureModuleRegistry.getNav()
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('campaigns')
    expect(result[0].nav).toEqual(nav)
    expect(result[0].scope).toBe('portfolio')
  })

  test('getNav() sorts by order ascending, nulls last', () => {
    const nav1: NavDeclaration = { label: 'B', icon: 'b', group: 'actions', path: '/b', order: 20 }
    const nav2: NavDeclaration = { label: 'A', icon: 'a', group: 'intelligence', path: '/a', order: 10 }
    const nav3: NavDeclaration = { label: 'C', icon: 'c', group: 'actions', path: '/c' } // no order

    FeatureModuleRegistry.register(makeModule({ name: 'mod-b', nav: nav1, scope: 'customer' }))
    FeatureModuleRegistry.register(makeModule({ name: 'mod-a', nav: nav2, scope: 'portfolio' }))
    FeatureModuleRegistry.register(makeModule({ name: 'mod-c', nav: nav3, scope: 'both' }))

    const result = FeatureModuleRegistry.getNav()
    expect(result).toHaveLength(3)
    expect(result[0].name).toBe('mod-a')   // order 10
    expect(result[1].name).toBe('mod-b')   // order 20
    expect(result[2].name).toBe('mod-c')   // no order → last
  })

  test('getNav() defaults scope to "both" when module omits scope', () => {
    const nav: NavDeclaration = { label: 'X', icon: 'x', group: 'actions', path: '/x' }
    FeatureModuleRegistry.register(makeModule({ name: 'no-scope', nav }))

    const result = FeatureModuleRegistry.getNav()
    expect(result).toHaveLength(1)
    expect(result[0].scope).toBe('both')
  })

  // ── getAccountTabs() ────────────────────────────────────────────────────────

  test('getAccountTabs() returns empty array when no modules declare accountTab', () => {
    FeatureModuleRegistry.register(makeModule({ name: 'no-tab' }))
    expect(FeatureModuleRegistry.getAccountTabs()).toEqual([])
  })

  test('getAccountTabs() returns modules that declare accountTab', () => {
    const tab: AccountTabDeclaration = { label: 'Intel', icon: 'brain' }
    FeatureModuleRegistry.register(makeModule({ name: 'intel', accountTab: tab, scope: 'customer' }))
    FeatureModuleRegistry.register(makeModule({ name: 'no-tab' }))

    const result = FeatureModuleRegistry.getAccountTabs()
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('intel')
    expect(result[0].accountTab).toEqual(tab)
    expect(result[0].scope).toBe('customer')
  })

  test('getAccountTabs() sorts by order ascending, nulls last', () => {
    const tab1: AccountTabDeclaration = { label: 'Second', icon: 's', order: 20 }
    const tab2: AccountTabDeclaration = { label: 'First', icon: 'f', order: 5 }
    const tab3: AccountTabDeclaration = { label: 'Last', icon: 'l' }

    FeatureModuleRegistry.register(makeModule({ name: 'tab-second', accountTab: tab1, scope: 'customer' }))
    FeatureModuleRegistry.register(makeModule({ name: 'tab-first', accountTab: tab2, scope: 'customer' }))
    FeatureModuleRegistry.register(makeModule({ name: 'tab-last', accountTab: tab3, scope: 'both' }))

    const result = FeatureModuleRegistry.getAccountTabs()
    expect(result).toHaveLength(3)
    expect(result[0].name).toBe('tab-first')   // order 5
    expect(result[1].name).toBe('tab-second')   // order 20
    expect(result[2].name).toBe('tab-last')      // no order → last
  })

  // ── Backward compatibility ────────────────────────────────────────────────

  test('existing modules without nav/accountTab/scope still register and work', () => {
    const legacy: FeatureModule = {
      name: 'legacy-module',
      cachePaths: (slug) => [`cache/${slug}/legacy.json`],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
    }

    FeatureModuleRegistry.register(legacy)
    expect(FeatureModuleRegistry.get('legacy-module')).toBeDefined()
    expect(FeatureModuleRegistry.list()).toHaveLength(1)
    expect(FeatureModuleRegistry.getNav()).toEqual([])
    expect(FeatureModuleRegistry.getAccountTabs()).toEqual([])
  })
})
