// test/unit/rh-product-catalog-module.test.ts
// GitHub Issue #677 — RH Product Catalog Module: registration, seed data, and signal tests

import { describe, test, expect, beforeAll } from 'bun:test'
import { FeatureModuleRegistry } from '../../src/feature-module-registry.ts'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

// Dynamic import to avoid ESM TDZ issues with self-registration
beforeAll(async () => {
  await import('../../src/modules/rh-product-catalog-module.ts')
})

describe('rh-product-catalog seed data', () => {
  const seedPath = resolve(import.meta.dir, '../../config-templates/rh-product-catalog.json')

  test('seed file exists', () => {
    expect(existsSync(seedPath)).toBe(true)
  })

  test('seed file is valid JSON', () => {
    const raw = readFileSync(seedPath, 'utf-8')
    const data = JSON.parse(raw)
    expect(data).toBeDefined()
  })

  test('seed file has version and refreshedAt fields', () => {
    const data = JSON.parse(readFileSync(seedPath, 'utf-8'))
    expect(data.version).toBe(1)
    expect(data.refreshedAt).toBeDefined()
    expect(typeof data.refreshedAt).toBe('string')
  })

  test('seed file has source URL', () => {
    const data = JSON.parse(readFileSync(seedPath, 'utf-8'))
    expect(data.source).toBe('https://www.redhat.com/en/products')
  })

  test('seed file has 30+ products', () => {
    const data = JSON.parse(readFileSync(seedPath, 'utf-8'))
    expect(data.products.length).toBeGreaterThanOrEqual(30)
  })

  test('all products have name and category fields', () => {
    const data = JSON.parse(readFileSync(seedPath, 'utf-8'))
    for (const product of data.products) {
      expect(product.name).toBeDefined()
      expect(typeof product.name).toBe('string')
      expect(product.name.length).toBeGreaterThan(0)
      expect(product.category).toBeDefined()
      expect(typeof product.category).toBe('string')
      expect(product.category.length).toBeGreaterThan(0)
    }
  })

  test('all products have url field', () => {
    const data = JSON.parse(readFileSync(seedPath, 'utf-8'))
    for (const product of data.products) {
      expect(product.url).toBeDefined()
      expect(typeof product.url).toBe('string')
      expect(product.url.startsWith('https://')).toBe(true)
    }
  })

  test('product names are unique', () => {
    const data = JSON.parse(readFileSync(seedPath, 'utf-8'))
    const names = data.products.map((p: { name: string }) => p.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })

  test('known products are present', () => {
    const data = JSON.parse(readFileSync(seedPath, 'utf-8'))
    const names = new Set(data.products.map((p: { name: string }) => p.name))
    expect(names.has('Red Hat Enterprise Linux')).toBe(true)
    expect(names.has('Red Hat OpenShift')).toBe(true)
    expect(names.has('Red Hat Ansible Automation Platform')).toBe(true)
    expect(names.has('Red Hat OpenShift AI')).toBe(true)
  })
})

describe('rh-product-catalog-module registration', () => {
  test('module is registered with name rh-product-catalog', () => {
    const mod = FeatureModuleRegistry.get('rh-product-catalog')
    expect(mod).toBeDefined()
    expect(mod!.name).toBe('rh-product-catalog')
  })

  test('scope is portfolio', () => {
    const mod = FeatureModuleRegistry.get('rh-product-catalog')!
    expect(mod.scope).toBe('portfolio')
  })

  test('has displayName', () => {
    const mod = FeatureModuleRegistry.get('rh-product-catalog')!
    expect(mod.displayName).toBe('Product Catalog')
  })

  test('has refreshEndpoint', () => {
    const mod = FeatureModuleRegistry.get('rh-product-catalog')!
    expect(mod.refreshEndpoint).toBeDefined()
    expect(mod.refreshEndpoint).toContain('rh-product-catalog')
  })

  test('has cacheTtlMs defined (weekly)', () => {
    const mod = FeatureModuleRegistry.get('rh-product-catalog')!
    expect(mod.cacheTtlMs).toBeDefined()
    expect(mod.cacheTtlMs).toBe(7 * 24 * 60 * 60 * 1000)
  })

  test('has refreshInterval defined (weekly)', () => {
    const mod = FeatureModuleRegistry.get('rh-product-catalog')!
    expect(mod.refreshInterval).toBe(7 * 24 * 60 * 60 * 1000)
  })

  test('signalRole is enrichment', () => {
    const mod = FeatureModuleRegistry.get('rh-product-catalog')!
    expect(mod.signalRole).toBe('enrichment')
  })

  test('signalAudience is all', () => {
    const mod = FeatureModuleRegistry.get('rh-product-catalog')!
    expect(mod.signalAudience).toBe('all')
  })

  test('has ensureFresh function', () => {
    const mod = FeatureModuleRegistry.get('rh-product-catalog')!
    expect(mod.ensureFresh).toBeDefined()
    expect(typeof mod.ensureFresh).toBe('function')
  })

  test('signals returns empty array (data source only)', async () => {
    const mod = FeatureModuleRegistry.get('rh-product-catalog')!
    expect(mod.signals).toBeDefined()
    const signals = await mod.signals!('test-customer')
    expect(Array.isArray(signals)).toBe(true)
    expect(signals.length).toBe(0)
  })
})

describe('loadProductCatalog', () => {
  test('exports loadProductCatalog function', async () => {
    const { loadProductCatalog } = await import('../../src/modules/rh-product-catalog-module.ts')
    expect(typeof loadProductCatalog).toBe('function')
  })

  test('loadProductCatalog returns catalog with products', async () => {
    const { loadProductCatalog } = await import('../../src/modules/rh-product-catalog-module.ts')
    const catalog = loadProductCatalog()
    expect(catalog).not.toBeNull()
    expect(catalog!.products.length).toBeGreaterThanOrEqual(30)
  })
})
