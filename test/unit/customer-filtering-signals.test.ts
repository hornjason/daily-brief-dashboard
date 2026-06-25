/**
 * Integration tests for customer-specific signal filtering
 * GitHub Issues #475, #486
 *
 * Verifies that ecosystem-catalog, saleshub-content, and partner-catalog modules
 * correctly set customerSlug in metadata when the item matches customer context,
 * and omit it when there's no match (graceful fallback).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { resolve } from 'path'

// Set up test cache before importing modules
const TEST_CACHE_DIR = resolve(import.meta.dir, '../../test-cache-signals')
process.env.CACHE_DIR = TEST_CACHE_DIR
process.env.CONFIG_DIR = resolve(TEST_CACHE_DIR, 'config')

import { FeatureModuleRegistry } from '../../src/feature-module-registry.ts'

// Dynamic import for saleshub-content to ensure CACHE_DIR env var is set first
// (ESM hoists static imports before module-level code)
let resetDriveContentCache: typeof import('../../src/lib/saleshub-content.ts').resetDriveContentCache

// Reset and register modules
FeatureModuleRegistry._resetForTesting()

beforeAll(async () => {
  // Create test cache structure
  mkdirSync(resolve(TEST_CACHE_DIR, 'tech-stack'), { recursive: true })
  mkdirSync(resolve(TEST_CACHE_DIR, 'ecosystem-catalog'), { recursive: true })
  mkdirSync(resolve(TEST_CACHE_DIR, 'config'), { recursive: true })

  // Tech-stack cache: customer uses VMware and Kubernetes
  writeFileSync(
    resolve(TEST_CACHE_DIR, 'tech-stack', 'test-customer.json'),
    JSON.stringify({
      technologies: [
        { name: 'VMware', category: 'Virtualization', confidence: 'HIGH' },
        { name: 'Kubernetes', category: 'Container Orchestration', confidence: 'MEDIUM' },
      ],
    })
  )

  // Subscription sheets: customer has RHEL and OpenShift
  writeFileSync(
    resolve(TEST_CACHE_DIR, 'test-customer-sheets.json'),
    JSON.stringify({
      rows: [
        { productDescription: 'Red Hat Enterprise Linux Server' },
        { productDescription: 'Red Hat OpenShift Container Platform' },
      ],
    })
  )

  // Ecosystem catalog data: one VMware solution (should match), one Citrix solution (no match)
  writeFileSync(
    resolve(TEST_CACHE_DIR, 'ecosystem-catalog', 'test-partner.json'),
    JSON.stringify({
      partnerName: 'Test Partner',
      scrapedAt: '2026-01-01T00:00:00Z',
      solutions: [
        {
          name: 'VMware Migration Tool',
          partnerName: 'Test Partner',
          platform: 'VMware',
          categories: ['Migration', 'Virtualization'],
          geoRegion: 'Global',
          description: 'Migrates VMware to OpenShift',
          coSell: true,
          publishedAt: '2026-01-01T00:00:00Z',
          url: 'https://example.com/vmware-tool',
          resources: [],
          collections: [],
        },
        {
          name: 'Citrix Optimizer',
          partnerName: 'Test Partner',
          platform: 'Citrix',
          categories: ['Optimization'],
          geoRegion: 'Global',
          description: 'Optimizes Citrix workloads',
          coSell: false,
          publishedAt: '2026-01-01T00:00:00Z',
          url: 'https://example.com/citrix',
          resources: [],
          collections: [],
        },
      ],
    })
  )

  // Partners config: one with Container Mgmt (matches OpenShift), one with no match
  // loadPartners expects a raw array
  writeFileSync(
    resolve(TEST_CACHE_DIR, 'config', 'partners.json'),
    JSON.stringify([
      {
        name: 'Container Partner',
        partnershipLevel: 'Advanced',
        specializations: ['Container Management', 'Hybrid Cloud'],
        geo: 'NA',
        country: 'US',
        domain: 'containerpartner.com',
        aliases: [],
        credentials: [{ name: 'OpenShift', count: 5 }],
        catalogUrl: 'https://example.com/partner1',
      },
      {
        name: 'Desktop Partner',
        partnershipLevel: 'Ready',
        specializations: ['Desktop Virtualization'],
        geo: 'EMEA',
        country: 'UK',
        domain: 'desktoppartner.com',
        aliases: [],
        credentials: [{ name: 'VDI', count: 2 }],
        catalogUrl: 'https://example.com/partner2',
      },
    ])
  )

  // SalesHub Drive content cache — saleshub-content module reads from
  // {CACHE_DIR}/saleshub/drive-content.json (#507 migration to Drive listing)
  mkdirSync(resolve(TEST_CACHE_DIR, 'saleshub'), { recursive: true })
  writeFileSync(
    resolve(TEST_CACHE_DIR, 'saleshub', 'drive-content.json'),
    JSON.stringify({
      files: [
        {
          name: 'RHEL Migration Guide',
          mimeType: 'application/vnd.google-apps.document',
          driveUrl: 'https://drive.google.com/doc1',
          driveId: 'doc1-id',
          size: 1024,
          modifiedTime: '2026-01-01T00:00:00Z',
          parentFolder: 'RHEL',
          extractedText: 'Guide for migrating to RHEL 9.',
        },
        {
          name: 'Satellite Admin Guide',
          mimeType: 'application/vnd.google-apps.document',
          driveUrl: 'https://drive.google.com/doc2',
          driveId: 'doc2-id',
          size: 2048,
          modifiedTime: '2026-01-01T00:00:00Z',
          parentFolder: 'Satellite',
          extractedText: 'Satellite administration guide.',
        },
      ],
      lastSynced: '2026-01-01T00:00:00Z',
      totalFiles: 2,
      withText: 2,
    })
  )

  // Dynamically import saleshub-content so it picks up our CACHE_DIR env var
  const saleshubMod = await import('../../src/lib/saleshub-content.ts')
  resetDriveContentCache = saleshubMod.resetDriveContentCache

  // Reset saleshub Drive content cache so it picks up our test data
  resetDriveContentCache()

  // Import modules (side-effect registration)
  await import('../../src/modules/ecosystem-catalog-module.ts')
  await import('../../src/modules/partner-catalog-module.ts')
  await import('../../src/modules/saleshub-content-module.ts')
})

afterAll(() => {
  if (existsSync(TEST_CACHE_DIR)) {
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
  }
})

describe('ecosystem-catalog customer filtering (#475)', () => {
  test('sets customerSlug for solutions matching customer tech stack', async () => {
    const mod = FeatureModuleRegistry.get('ecosystem-catalog')
    expect(mod).toBeDefined()
    const signals = await mod!.signals!('test-customer')

    const vmwareSolution = signals.find(s => s.headline.includes('VMware Migration Tool'))
    expect(vmwareSolution).toBeDefined()
    expect(vmwareSolution!.metadata?.customerSlug).toBe('test-customer')
  })

  test('omits customerSlug for solutions NOT matching customer tech stack', async () => {
    const mod = FeatureModuleRegistry.get('ecosystem-catalog')
    const signals = await mod!.signals!('test-customer')

    const citrixSolution = signals.find(s => s.headline.includes('Citrix Optimizer'))
    expect(citrixSolution).toBeDefined()
    expect(citrixSolution!.metadata?.customerSlug).toBeUndefined()
  })

  test('emits all signals without customerSlug when no customer context exists', async () => {
    const mod = FeatureModuleRegistry.get('ecosystem-catalog')
    const signals = await mod!.signals!('nonexistent-customer')

    for (const signal of signals) {
      expect(signal.metadata?.customerSlug).toBeUndefined()
    }
    expect(signals.length).toBeGreaterThan(0) // still emits portfolio-wide
  })
})

describe('saleshub-content customer filtering (#486)', () => {
  test('sets customerSlug for docs matching customer subscriptions', async () => {
    const mod = FeatureModuleRegistry.get('saleshub-content')
    expect(mod).toBeDefined()
    const signals = await mod!.signals!('test-customer')

    // Customer has RHEL subscription → RHEL doc should match (headline format: "Document: Name")
    const rhelDoc = signals.find(s => s.headline.includes('RHEL Migration Guide'))
    expect(rhelDoc).toBeDefined()
    expect(rhelDoc!.metadata?.customerSlug).toBe('test-customer')
  })

  test('filters out docs NOT matching customer subscriptions (#896 SC-9)', async () => {
    const mod = FeatureModuleRegistry.get('saleshub-content')
    const signals = await mod!.signals!('test-customer')

    // Customer doesn't have Satellite → Satellite doc should be filtered out entirely
    const satDoc = signals.find(s => s.headline.includes('Satellite Admin Guide'))
    expect(satDoc).toBeUndefined()
  })

  test('emits zero signals when no customer context exists (#896 SC-9)', async () => {
    const mod = FeatureModuleRegistry.get('saleshub-content')
    const signals = await mod!.signals!('nonexistent-customer')

    // With filtering, no products match → no signals emitted
    expect(signals.length).toBe(0)
  })
})

describe('partner-catalog customer filtering (#486)', () => {
  test('sets customerSlug for partners with specializations matching customer products', async () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')
    expect(mod).toBeDefined()
    const signals = await mod!.signals!('test-customer')

    // Customer has OpenShift → Container Management specialization should match
    const containerPartner = signals.find(s => s.headline.includes('Container Partner'))
    expect(containerPartner).toBeDefined()
    expect(containerPartner!.metadata?.customerSlug).toBe('test-customer')
  })

  test('omits customerSlug for partners with non-matching specializations', async () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')
    const signals = await mod!.signals!('test-customer')

    // Customer doesn't use Desktop Virtualization
    const desktopPartner = signals.find(s => s.headline.includes('Desktop Partner'))
    expect(desktopPartner).toBeDefined()
    expect(desktopPartner!.metadata?.customerSlug).toBeUndefined()
  })

  test('emits all signals without customerSlug when no customer context exists', async () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')
    const signals = await mod!.signals!('nonexistent-customer')

    for (const signal of signals) {
      expect(signal.metadata?.customerSlug).toBeUndefined()
    }
    expect(signals.length).toBeGreaterThan(0)
  })
})
