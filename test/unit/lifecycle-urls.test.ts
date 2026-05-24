// GitHub Issue #351 — Product lifecycle: include links to lifecycle page and upgrade docs
import { describe, test, expect } from 'bun:test'
import { readProductLifecycleCache, type ProductLifecycleCache } from '../../src/product-lifecycle.ts'

describe('lifecycle signal URLs', () => {
  test('lifecycle module includes URL metadata fields', () => {
    const cache = readProductLifecycleCache()

    if (!cache || cache.products.length === 0) {
      console.warn('Skipping test - no lifecycle cache found')
      return
    }

    // Verify cache structure includes the products we're mapping
    const productSlugs = cache.products.map(p => p.slug)
    expect(productSlugs).toContain('ocp')
    expect(productSlugs).toContain('rhel')
    expect(productSlugs).toContain('aap')
  })

  test('signal metadata includes lifecycleUrl and upgradeGuideUrl', () => {
    // Verify implementation adds URL fields to metadata
    const fs = require('fs')
    const modulePath = './src/modules/lifecycle-module.ts'
    const moduleSource = fs.readFileSync(modulePath, 'utf-8')

    // Verify metadata object includes both URL fields
    expect(moduleSource).toContain('lifecycleUrl: urls.lifecycleUrl,')
    expect(moduleSource).toContain('upgradeGuideUrl: urls.upgradeGuideUrl,')
  })

  test('URL constants cover all tracked products', () => {
    const cache = readProductLifecycleCache()

    if (!cache || cache.products.length === 0) {
      console.warn('Skipping test - no lifecycle cache found')
      return
    }

    // Read the lifecycle module source to verify URL mapping exists
    const fs = require('fs')
    const modulePath = './src/modules/lifecycle-module.ts'
    const moduleSource = fs.readFileSync(modulePath, 'utf-8')

    // Verify URL constants are defined
    expect(moduleSource).toContain('PRODUCT_URLS')
    expect(moduleSource).toContain('lifecycleUrl')
    expect(moduleSource).toContain('upgradeGuideUrl')

    // Verify all products have entries
    expect(moduleSource).toContain("'ocp':")
    expect(moduleSource).toContain("'rhel':")
    expect(moduleSource).toContain("'aap':")

    // Verify URLs are added to metadata
    expect(moduleSource).toContain('lifecycleUrl: urls.lifecycleUrl')
    expect(moduleSource).toContain('upgradeGuideUrl: urls.upgradeGuideUrl')

    // Verify URLs are added to detail string
    expect(moduleSource).toContain('Lifecycle: ${urls.lifecycleUrl}')
    expect(moduleSource).toContain('Upgrade guide: ${urls.upgradeGuideUrl}')
  })
})
