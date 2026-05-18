/**
 * GitHub Issue #255 — Product Intelligence module registration test
 * Verifies product-intel module is registered with correct config
 */

import { test, expect } from 'bun:test'
import { FeatureModuleRegistry } from '../../src/feature-module-registry.ts'
// Import module to trigger registration
import '../../src/modules/product-intel-module.ts'

test('product-intel module is registered', () => {
  const module = FeatureModuleRegistry.get('product-intel')
  expect(module).toBeDefined()
  expect(module?.name).toBe('product-intel')
})

test('product-intel has correct scope', () => {
  const module = FeatureModuleRegistry.get('product-intel')
  expect(module?.scope).toBe('portfolio')
})

test('product-intel has nav declaration', () => {
  const module = FeatureModuleRegistry.get('product-intel')
  expect(module?.nav).toBeDefined()
  expect(module?.nav?.label).toBe('Product Intelligence')
  expect(module?.nav?.icon).toBe('Brain')
  expect(module?.nav?.group).toBe('intelligence')
  expect(module?.nav?.path).toBe('/dashboard/products')
  expect(module?.nav?.order).toBe(5)
})

test('product-intel has 7-day refresh interval', () => {
  const module = FeatureModuleRegistry.get('product-intel')
  expect(module?.refreshInterval).toBe(7 * 24 * 60 * 60 * 1000)
})

test('product-intel cachePaths returns expected paths', () => {
  const module = FeatureModuleRegistry.get('product-intel')
  const paths = module?.cachePaths('test-slug')
  expect(paths).toEqual([
    'data/cache/product-intel/test-slug-summary.json',
    'data/cache/product-intel/test-slug-features.json',
  ])
})

test('product-intel implements required methods', () => {
  const module = FeatureModuleRegistry.get('product-intel')
  expect(typeof module?.fetch).toBe('function')
  expect(typeof module?.cleanup).toBe('function')
  expect(typeof module?.syncNow).toBe('function')
  expect(typeof module?.signals).toBe('function')
})

test('product-intel appears in registry nav list', () => {
  const navEntries = FeatureModuleRegistry.getNav()
  const productIntel = navEntries.find(e => e.name === 'product-intel')
  expect(productIntel).toBeDefined()
  expect(productIntel?.nav.label).toBe('Product Intelligence')
  expect(productIntel?.scope).toBe('portfolio')
})
