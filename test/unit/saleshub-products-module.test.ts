import { describe, it, expect, beforeAll } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const TEST_CONFIG_DIR = resolve(import.meta.dir, '../fixtures/saleshub-products-test')
const TEST_CACHE_DIR = resolve(import.meta.dir, '../fixtures/saleshub-products-cache')
const TEST_PRODUCTS_DIR = resolve(TEST_CONFIG_DIR, '..', 'config-templates', 'saleshub-products')

// Must import FeatureModuleRegistry before setting env and importing module
import { FeatureModuleRegistry } from '../../src/feature-module-registry.ts'

describe('saleshub-products-module', () => {
  beforeAll(async () => {
    // Set up test directories and fixtures
    mkdirSync(TEST_CONFIG_DIR, { recursive: true })
    mkdirSync(TEST_CACHE_DIR, { recursive: true })
    mkdirSync(resolve(TEST_PRODUCTS_DIR, 'test-product-a'), { recursive: true })
    mkdirSync(resolve(TEST_PRODUCTS_DIR, 'empty-product'), { recursive: true })

    // Write a mock product with multiple sections
    const productA = {
      name: 'Test Product A',
      slug: 'test-product-a',
      description: 'A test product for unit tests',
      pageUrl: 'https://saleshub.redhat.com/test-product-a',
      scrapedAt: '2026-06-15T00:00:00.000Z',
      tdpLinks: [{ name: 'TestTDP' }],
      contacts: [{ name: 'Test Contact', role: 'marketing' }],
      slackChannels: ['#test-channel'],
      sections: {
        'Product news': {
          title: 'Product news',
          type: 'text',
          textContent: 'Test Product A v2.0 released with new features',
          items: [
            { name: 'Release Blog', url: 'https://example.com/blog', itemType: 'link' },
            { name: 'Datasheet', url: 'https://example.com/datasheet', itemType: 'link' },
          ],
        },
        'Top training resources': {
          title: 'Top training resources',
          type: 'table',
          items: [
            { name: 'Training Course 1', url: 'https://example.com/training1', itemType: 'training' },
            { name: 'Training Course 2', url: 'https://example.com/training2', itemType: 'training' },
          ],
        },
        'Top services resources': {
          title: 'Top services resources',
          type: 'table',
          items: [
            { name: 'Services Deck', url: 'https://example.com/services', itemType: 'deck' },
          ],
        },
        'Custom Section': {
          title: 'Custom Section',
          type: 'cards',
          items: [
            { name: 'Custom Item', url: 'https://example.com/custom' },
          ],
        },
      },
    }

    writeFileSync(
      resolve(TEST_PRODUCTS_DIR, 'test-product-a', '_product.json'),
      JSON.stringify(productA),
    )

    // Write enrichment data for product A with AWS content kit
    const enrichmentA = {
      productSlug: 'test-product-a',
      enrichedAt: '2026-06-15T00:00:00.000Z',
      contentKits: [
        {
          documentName: 'Test Product A on AWS Content Kit',
          cloudProvider: 'AWS',
          actionableSteps: [
            { step: 'Ask the customer about cloud migration goals', url: 'https://example.com/step1' },
            { step: 'Share cost comparison data' },
          ],
          calculatorUrl: 'https://example.com/calculator',
          contactName: 'Jane Smith',
          workshops: [{ name: 'AWS Migration Workshop', url: 'https://example.com/workshop' }],
          demos: [],
          battlecards: [{ name: 'AWS Battlecard', url: 'https://example.com/bc', competitor: 'VMware' }],
          internalMaterials: [],
          salesPlayAlignment: ['Cloud Sales Play'],
        },
      ],
      messagingGuides: [],
      battlecards: [],
    }

    writeFileSync(
      resolve(TEST_PRODUCTS_DIR, 'test-product-a', '_enriched.json'),
      JSON.stringify(enrichmentA),
    )

    // empty-product has no _product.json — should be skipped gracefully

    // Set up customer subscription cache for cross-referencing tests
    // Customer "matching-customer" has a subscription to "Test Product A"
    mkdirSync(resolve(TEST_CACHE_DIR), { recursive: true })
    writeFileSync(
      resolve(TEST_CACHE_DIR, 'matching-customer-sheets.json'),
      JSON.stringify({
        rows: [
          { productDescription: 'Test Product A Premium Subscription' },
          { productDescription: 'Red Hat Enterprise Linux' },
        ],
      }),
    )

    // Customer "non-matching-customer" has unrelated subscriptions
    writeFileSync(
      resolve(TEST_CACHE_DIR, 'non-matching-customer-sheets.json'),
      JSON.stringify({
        rows: [
          { productDescription: 'Red Hat Ansible Automation Platform' },
        ],
      }),
    )

    // Set env vars BEFORE importing the module
    process.env.CONFIG_DIR = TEST_CONFIG_DIR
    process.env.CACHE_DIR = TEST_CACHE_DIR

    // Reset and import the module
    FeatureModuleRegistry._resetForTesting()
    await import('../../src/modules/saleshub-products-module.ts')
  })

  it('registers with FeatureModuleRegistry', () => {
    const mod = FeatureModuleRegistry.get('saleshub-products')
    expect(mod).toBeDefined()
    expect(mod!.name).toBe('saleshub-products')
    expect(mod!.displayName).toBe('SalesHub Products')
    expect(mod!.scope).toBe('portfolio')
    expect(mod!.signalRole).toBe('enrichment')
    expect(mod!.signalAudience).toBe('customer-specific')
    expect(mod!.refreshEndpoint).toBe('/api/saleshub-products/refresh')
    expect(mod!.cacheTtlMs).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('signals() returns product news signals with correct metadata', async () => {
    const mod = FeatureModuleRegistry.get('saleshub-products')!
    const signals = await mod.signals('some-customer')

    const newsSignals = signals.filter(s => s.type === 'product-release')
    expect(newsSignals.length).toBeGreaterThanOrEqual(1)

    const news = newsSignals[0]
    expect(news.source).toBe('saleshub-products')
    expect(news.headline).toContain('Test Product A')
    expect(news.detail).toContain('v2.0')
    expect(news.metadata?.productSlug).toBe('test-product-a')
    expect(news.metadata?.links).toBeDefined()
    expect((news.metadata!.links as any[]).length).toBe(2)
  })

  it('signals() returns cloud provider content kit signals with calculator URL', async () => {
    const mod = FeatureModuleRegistry.get('saleshub-products')!
    const signals = await mod.signals('some-customer')

    const kitSignals = signals.filter(
      s => s.type === 'recommendation' && (s.metadata?.cloudProvider as string) === 'AWS'
    )
    expect(kitSignals.length).toBe(1)

    const kit = kitSignals[0]
    expect(kit.headline).toContain('Test Product A on AWS')
    expect(kit.metadata?.calculatorUrl).toBe('https://example.com/calculator')
    expect(kit.metadata?.contactName).toBe('Jane Smith')
    expect(kit.metadata?.workshopUrl).toBe('https://example.com/workshop')
    expect(kit.metadata?.actionableSteps).toBeDefined()
    expect((kit.metadata!.actionableSteps as any[]).length).toBe(2)
  })

  it('signals() returns training resource signals', async () => {
    const mod = FeatureModuleRegistry.get('saleshub-products')!
    const signals = await mod.signals('some-customer')

    const trainingSignals = signals.filter(
      s => s.type === 'recommendation' && (s.metadata?.resourceType as string) === 'training'
    )
    expect(trainingSignals.length).toBe(1)

    const training = trainingSignals[0]
    expect(training.headline).toContain('Training resources')
    expect(training.headline).toContain('Test Product A')
    expect(training.metadata?.productSlug).toBe('test-product-a')
    expect((training.metadata!.items as any[]).length).toBe(2)
  })

  it('signals() returns services resource signals', async () => {
    const mod = FeatureModuleRegistry.get('saleshub-products')!
    const signals = await mod.signals('some-customer')

    const servicesSignals = signals.filter(
      s => s.type === 'recommendation' && (s.metadata?.resourceType as string) === 'services'
    )
    expect(servicesSignals.length).toBe(1)

    const svc = servicesSignals[0]
    expect(svc.headline).toContain('consulting resources')
    expect(svc.headline).toContain('Test Product A')
    expect((svc.metadata!.items as any[]).length).toBe(1)
  })

  it('cross-referencing: matching customer gets customerSlug in metadata', async () => {
    const mod = FeatureModuleRegistry.get('saleshub-products')!
    const signals = await mod.signals('matching-customer')

    // All signals should have customerSlug set (product matches subscription)
    for (const signal of signals) {
      expect(signal.metadata?.customerSlug).toBe('matching-customer')
    }
  })

  it('cross-referencing: non-matching customer does NOT get customerSlug', async () => {
    const mod = FeatureModuleRegistry.get('saleshub-products')!
    const signals = await mod.signals('non-matching-customer')

    // No signals should have customerSlug (product does not match subscription)
    for (const signal of signals) {
      expect(signal.metadata?.customerSlug).toBeUndefined()
    }
  })

  it('empty or missing product files produce zero signals, not crashes', async () => {
    // The empty-product directory has no _product.json, should be skipped
    const mod = FeatureModuleRegistry.get('saleshub-products')!
    // Should not throw
    const signals = await mod.signals('any-customer')
    // Only test-product-a should produce signals; empty-product is skipped
    expect(signals.length).toBeGreaterThan(0)
    for (const s of signals) {
      expect(s.metadata?.productSlug).toBe('test-product-a')
    }
  })

  it('section discovery handles sections dynamically by title', async () => {
    const mod = FeatureModuleRegistry.get('saleshub-products')!
    const signals = await mod.signals('some-customer')

    // Should find "Top training resources" via partial match on "training"
    // Should find "Top services resources" via partial match on "services"
    // Should find "Product news" via match on "product news"
    const types = new Set(signals.map(s => {
      if (s.type === 'product-release') return 'news'
      if (s.metadata?.resourceType === 'training') return 'training'
      if (s.metadata?.resourceType === 'services') return 'services'
      if (s.metadata?.cloudProvider) return 'cloud-kit'
      return 'other'
    }))

    expect(types.has('news')).toBe(true)
    expect(types.has('training')).toBe(true)
    expect(types.has('services')).toBe(true)
    expect(types.has('cloud-kit')).toBe(true)
  })

  it('syncNow reloads products and records outcome', async () => {
    const mod = FeatureModuleRegistry.get('saleshub-products')!
    await mod.syncNow('_global')

    const status = FeatureModuleRegistry.getStatus()
    expect(status['saleshub-products']).toBeDefined()
    expect(status['saleshub-products'].lastChecked).not.toBeNull()
    expect(status['saleshub-products'].state).toBe('idle')
    expect(status['saleshub-products'].recordCount).toBe(1) // 1 product directory with valid data
  })

  it('cleanup is a no-op', async () => {
    const mod = FeatureModuleRegistry.get('saleshub-products')!
    // Should not throw
    await mod.cleanup('_global')
  })
})
