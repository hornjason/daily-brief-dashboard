/**
 * GitHub Issue #353 — Customer-product-intel: features to business objectives
 * Verifies that product intel signals surface initiative alignment and
 * feature talking points connected to business objectives.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { FeatureModuleRegistry } from '../../src/feature-module-registry.ts'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { resolve } from 'path'

const TEST_CACHE = resolve(import.meta.dir, '../fixtures/cpi-biz-obj-cache')
const originalCacheDir = process.env.CACHE_DIR

beforeAll(async () => {
  process.env.CACHE_DIR = TEST_CACHE
  mkdirSync(resolve(TEST_CACHE, 'product-intel', 'ocp-customer-intel'), { recursive: true })
  mkdirSync(resolve(TEST_CACHE, 'intelligence'), { recursive: true })

  FeatureModuleRegistry._resetForTesting()
  await import('../../src/modules/customer-product-intel-module.ts')
})

afterAll(() => {
  process.env.CACHE_DIR = originalCacheDir
  if (existsSync(TEST_CACHE)) rmSync(TEST_CACHE, { recursive: true })
})

function writeProductIntelCache(productSlug: string, customerSlug: string, intel: any) {
  const dir = resolve(TEST_CACHE, 'product-intel', `${productSlug}-customer-intel`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    resolve(dir, `${customerSlug}.json`),
    JSON.stringify({
      contentHash: 'test123',
      intel,
      cachedAt: new Date().toISOString(),
    }),
  )
}

describe('customer-product-intel business objectives', () => {
  test('signal includes initiativeAlignment in metadata when present', async () => {
    writeProductIntelCache('ocp', 'acme-corp', {
      product: 'ocp',
      customer: 'Acme Corp',
      relevanceScore: 'HIGH',
      priorityAction: 'Schedule OpenShift demo for cloud migration team',
      roadmapRelevance: [],
      expansionOpportunities: [],
      caseAlignment: [],
      competitiveAngle: null,
      featureTalkingPoints: [],
      initiativeAlignment: [
        'Their cloud-first initiative maps directly to OpenShift container platform modernization',
        'AI/ML strategy aligns with OpenShift AI for model serving infrastructure',
      ],
      generatedAt: new Date().toISOString(),
      productCacheHash: 'hash1',
    })

    const mod = FeatureModuleRegistry.get('customer-product-intel')
    const signals = await mod!.signals!('acme-corp')

    expect(signals.length).toBeGreaterThan(0)
    const sig = signals.find(s => s.metadata?.product === 'ocp')
    expect(sig).toBeDefined()
    expect(sig!.metadata!.initiativeAlignment).toBeDefined()
    expect(sig!.metadata!.initiativeAlignment).toHaveLength(2)
  })

  test('signal detail includes business objective connection when initiativeAlignment exists', async () => {
    writeProductIntelCache('ocp', 'acme-corp', {
      product: 'ocp',
      customer: 'Acme Corp',
      relevanceScore: 'HIGH',
      priorityAction: 'Schedule OpenShift demo',
      roadmapRelevance: [],
      expansionOpportunities: [{ gap: 'No container platform', product: 'OpenShift', rationale: 'Cloud migration' }],
      caseAlignment: [],
      competitiveAngle: 'Competing with VMware Tanzu',
      featureTalkingPoints: [],
      initiativeAlignment: [
        'Cloud-first initiative maps to OpenShift platform modernization',
      ],
      generatedAt: new Date().toISOString(),
      productCacheHash: 'hash1',
    })

    const mod = FeatureModuleRegistry.get('customer-product-intel')
    const signals = await mod!.signals!('acme-corp')

    const sig = signals.find(s => s.metadata?.product === 'ocp')
    expect(sig).toBeDefined()
    // Detail should reference business objective alignment
    expect(sig!.detail).toContain('Objective')
  })

  test('signal includes featureTalkingPoints in metadata when present', async () => {
    writeProductIntelCache('ocp', 'acme-corp', {
      product: 'ocp',
      customer: 'Acme Corp',
      relevanceScore: 'MEDIUM',
      priorityAction: 'Discuss new OCP features at next meeting',
      roadmapRelevance: [],
      expansionOpportunities: [],
      caseAlignment: [],
      competitiveAngle: null,
      featureTalkingPoints: [
        {
          feature: 'OCP Virtualization GA',
          status: 'GA',
          version: '4.18',
          reason: 'Customer has large VMware estate and is evaluating migration',
          signalSource: 'Case 03456789',
        },
      ],
      initiativeAlignment: [],
      generatedAt: new Date().toISOString(),
      productCacheHash: 'hash2',
    })

    const mod = FeatureModuleRegistry.get('customer-product-intel')
    const signals = await mod!.signals!('acme-corp')

    const sig = signals.find(s => s.metadata?.product === 'ocp')
    expect(sig).toBeDefined()
    expect(sig!.metadata!.featureTalkingPoints).toBeDefined()
    expect(sig!.metadata!.featureTalkingPoints).toHaveLength(1)
    expect(sig!.metadata!.featureTalkingPoints[0].feature).toBe('OCP Virtualization GA')
  })

  test('rawRelevance is boosted when initiativeAlignment has entries', async () => {
    writeProductIntelCache('ocp', 'acme-corp', {
      product: 'ocp',
      customer: 'Acme Corp',
      relevanceScore: 5,
      priorityAction: 'Review alignment',
      roadmapRelevance: [],
      expansionOpportunities: [],
      caseAlignment: [],
      competitiveAngle: null,
      featureTalkingPoints: [],
      initiativeAlignment: [
        'Initiative maps to product',
        'Second initiative aligns',
      ],
      generatedAt: new Date().toISOString(),
      productCacheHash: 'hash3',
    })

    const mod = FeatureModuleRegistry.get('customer-product-intel')
    const signals = await mod!.signals!('acme-corp')

    const sig = signals.find(s => s.metadata?.product === 'ocp')
    expect(sig).toBeDefined()
    // Base rawRelevance from score 5/10 = 0.5, should be boosted with initiative alignment
    expect(sig!.rawRelevance).toBeGreaterThan(0.5)
  })

  test('signal without initiativeAlignment has empty array in metadata', async () => {
    writeProductIntelCache('ocp', 'acme-corp', {
      product: 'ocp',
      customer: 'Acme Corp',
      relevanceScore: 3,
      priorityAction: 'Low priority review',
      roadmapRelevance: [],
      expansionOpportunities: [],
      caseAlignment: [],
      competitiveAngle: null,
      featureTalkingPoints: [],
      generatedAt: new Date().toISOString(),
      productCacheHash: 'hash4',
    })

    const mod = FeatureModuleRegistry.get('customer-product-intel')
    const signals = await mod!.signals!('acme-corp')

    const sig = signals.find(s => s.metadata?.product === 'ocp')
    expect(sig).toBeDefined()
    expect(sig!.metadata!.initiativeAlignment).toEqual([])
    expect(sig!.metadata!.featureTalkingPoints).toEqual([])
  })
})
