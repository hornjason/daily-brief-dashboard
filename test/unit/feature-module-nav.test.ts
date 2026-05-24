// test/unit/feature-module-nav.test.ts
// Unit tests for FeatureModule nav/accountTab/scope extensions (GitHub Issue #234)
// Tests getNav(), getAccountTabs(), and nav API endpoint.
// NOTE: Registry is shared (Bun ESM). Use unique names, filter by test names.

import { describe, test, expect } from 'bun:test'
import { FeatureModuleRegistry, type FeatureModule, type NavDeclaration, type AccountTabDeclaration, type ModuleScope } from '../../src/feature-module-registry.ts'

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
  test('getNav() includes modules that declare nav', () => {
    const nav: NavDeclaration = { label: 'NavTest', icon: 'megaphone', group: 'actions', path: '/nav-test-234' }
    FeatureModuleRegistry.register(makeModule({ name: 'nav-test-234', nav, scope: 'portfolio' }))

    const result = FeatureModuleRegistry.getNav()
    const entry = result.find(r => r.name === 'nav-test-234')
    expect(entry).toBeDefined()
    expect(entry!.nav).toEqual(nav)
    expect(entry!.scope).toBe('portfolio')
  })

  test('getNav() sorts by order ascending, nulls last', () => {
    const nav1: NavDeclaration = { label: 'B', icon: 'b', group: 'actions', path: '/sort-b', order: 200 }
    const nav2: NavDeclaration = { label: 'A', icon: 'a', group: 'intelligence', path: '/sort-a', order: 100 }
    const nav3: NavDeclaration = { label: 'C', icon: 'c', group: 'actions', path: '/sort-c' }

    FeatureModuleRegistry.register(makeModule({ name: 'nav-sort-b', nav: nav1, scope: 'customer' }))
    FeatureModuleRegistry.register(makeModule({ name: 'nav-sort-a', nav: nav2, scope: 'portfolio' }))
    FeatureModuleRegistry.register(makeModule({ name: 'nav-sort-c', nav: nav3, scope: 'both' }))

    const result = FeatureModuleRegistry.getNav()
    const sortNames = result.filter(r => r.name.startsWith('nav-sort-')).map(r => r.name)
    expect(sortNames).toEqual(['nav-sort-a', 'nav-sort-b', 'nav-sort-c'])
  })

  test('getNav() defaults scope to "both" when module omits scope', () => {
    const nav: NavDeclaration = { label: 'X', icon: 'x', group: 'actions', path: '/scope-default' }
    FeatureModuleRegistry.register(makeModule({ name: 'nav-scope-default', nav }))

    const result = FeatureModuleRegistry.getNav()
    const entry = result.find(r => r.name === 'nav-scope-default')
    expect(entry).toBeDefined()
    expect(entry!.scope).toBe('both')
  })

  test('getAccountTabs() includes modules that declare accountTab', () => {
    const tab: AccountTabDeclaration = { label: 'TabTest', icon: 'brain' }
    FeatureModuleRegistry.register(makeModule({ name: 'tab-test-234', accountTab: tab, scope: 'customer' }))

    const result = FeatureModuleRegistry.getAccountTabs()
    const entry = result.find(r => r.name === 'tab-test-234')
    expect(entry).toBeDefined()
    expect(entry!.accountTab).toEqual(tab)
    expect(entry!.scope).toBe('customer')
  })

  test('getAccountTabs() sorts by order ascending, nulls last', () => {
    const tab1: AccountTabDeclaration = { label: 'Second', icon: 's', order: 200 }
    const tab2: AccountTabDeclaration = { label: 'First', icon: 'f', order: 50 }
    const tab3: AccountTabDeclaration = { label: 'Last', icon: 'l' }

    FeatureModuleRegistry.register(makeModule({ name: 'tab-sort-second', accountTab: tab1, scope: 'customer' }))
    FeatureModuleRegistry.register(makeModule({ name: 'tab-sort-first', accountTab: tab2, scope: 'customer' }))
    FeatureModuleRegistry.register(makeModule({ name: 'tab-sort-last', accountTab: tab3, scope: 'both' }))

    const result = FeatureModuleRegistry.getAccountTabs()
    const sortNames = result.filter(r => r.name.startsWith('tab-sort-')).map(r => r.name)
    expect(sortNames).toEqual(['tab-sort-first', 'tab-sort-second', 'tab-sort-last'])
  })

  test('existing modules without nav/accountTab/scope still register and work', () => {
    const legacy: FeatureModule = {
      name: 'legacy-nav-test',
      cachePaths: (slug) => [`cache/${slug}/legacy.json`],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
    }

    FeatureModuleRegistry.register(legacy)
    expect(FeatureModuleRegistry.get('legacy-nav-test')).toBeDefined()
    const navEntries = FeatureModuleRegistry.getNav()
    expect(navEntries.find(r => r.name === 'legacy-nav-test')).toBeUndefined()
  })
})
