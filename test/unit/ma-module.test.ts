import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { resolve } from 'path'

const TEST_CACHE_DIR = resolve(import.meta.dir, '../fixtures/ma-test-cache')
const MA_CACHE_PATH = resolve(TEST_CACHE_DIR, 'ma-activity.json')

// Must set env before importing the module — use dynamic import in beforeAll
import { FeatureModuleRegistry } from '../../src/feature-module-registry.ts'

describe('ma-module', () => {
  beforeAll(async () => {
    process.env.CACHE_DIR = TEST_CACHE_DIR
    mkdirSync(TEST_CACHE_DIR, { recursive: true })
    await import('../../src/modules/ma-module.ts')
  })

  beforeEach(() => {
    if (existsSync(MA_CACHE_PATH)) rmSync(MA_CACHE_PATH)
  })

  afterEach(() => {
    if (existsSync(MA_CACHE_PATH)) rmSync(MA_CACHE_PATH)
  })

  it('registers with the FeatureModuleRegistry', () => {
    const mod = FeatureModuleRegistry.get('mergers-acquisitions')
    expect(mod).toBeDefined()
    expect(mod!.name).toBe('mergers-acquisitions')
    expect(mod!.displayName).toBe('M&A Activity')
    expect(mod!.scope).toBe('customer')
    expect(mod!.refreshInterval).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('returns empty signals when no cache exists', async () => {
    const mod = FeatureModuleRegistry.get('mergers-acquisitions')!
    const signals = await mod.signals!('a10-networks-inc--ca')
    expect(signals).toEqual([])
  })

  it('returns signals from cache matching customer slug', async () => {
    const cacheData = {
      records: [
        {
          account: 'A10 NETWORKS, INC. – CA',
          date: '2025-02-01',
          acquiredEntity: 'ThreatX',
          description: 'SaaS-based WAAP, behavioral AI',
          dealType: 'acquisition',
        },
        {
          account: 'DROPBOX INC',
          date: '2025-10-01',
          acquiredEntity: 'Mobius Labs GmbH',
          description: 'AI startup, multimodal vision',
          dealType: 'acquisition',
        },
      ],
      lastUpdated: '2025-12-01T00:00:00Z',
    }
    writeFileSync(MA_CACHE_PATH, JSON.stringify(cacheData))

    const mod = FeatureModuleRegistry.get('mergers-acquisitions')!
    const signals = await mod.signals!('a10-networks-inc--ca')

    expect(signals.length).toBe(1)
    expect(signals[0].source).toBe('mergers-acquisitions')
    expect(signals[0].type).toBe('acquisition')
    expect(signals[0].headline).toContain('ThreatX')
    expect(signals[0].metadata?.customerSlug).toBe('a10-networks-inc--ca')
    expect(signals[0].metadata?.acquiredEntity).toBe('ThreatX')
    expect(signals[0].metadata?.dealType).toBe('acquisition')
    expect(signals[0].timestamp).toBe('2025-02-01')
  })

  it('scores rawRelevance based on recency', async () => {
    const now = Date.now()
    const cacheData = {
      records: [
        {
          account: 'TEST CORP',
          date: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
          acquiredEntity: 'Recent Co',
          description: 'Recent deal',
          dealType: 'acquisition',
        },
        {
          account: 'TEST CORP',
          date: new Date(now - 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
          acquiredEntity: 'Old Co',
          description: 'Older deal',
          dealType: 'merger',
        },
        {
          account: 'TEST CORP',
          date: new Date(now - 800 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
          acquiredEntity: 'Ancient Co',
          description: 'Ancient deal',
          dealType: 'partnership',
        },
      ],
      lastUpdated: new Date().toISOString(),
    }
    writeFileSync(MA_CACHE_PATH, JSON.stringify(cacheData))

    const mod = FeatureModuleRegistry.get('mergers-acquisitions')!
    const signals = await mod.signals!('test-corp')

    expect(signals.length).toBe(3)
    const recent = signals.find(s => s.metadata?.acquiredEntity === 'Recent Co')!
    const old = signals.find(s => s.metadata?.acquiredEntity === 'Old Co')!
    const ancient = signals.find(s => s.metadata?.acquiredEntity === 'Ancient Co')!

    expect(recent.rawRelevance).toBe(0.9)
    expect(old.rawRelevance).toBe(0.5)
    expect(ancient.rawRelevance).toBe(0.3)
  })

  it('matches account names using slug comparison', async () => {
    const cacheData = {
      records: [
        {
          account: 'FRED HUTCHINSON CANCER CENTER',
          date: '2024-09-01',
          acquiredEntity: 'UW Medicine consolidation',
          description: 'Consolidated into UW Medicine',
          dealType: 'expansion',
        },
      ],
      lastUpdated: '2025-12-01T00:00:00Z',
    }
    writeFileSync(MA_CACHE_PATH, JSON.stringify(cacheData))

    const mod = FeatureModuleRegistry.get('mergers-acquisitions')!
    const signals = await mod.signals!('fred-hutchinson-cancer-center')

    expect(signals.length).toBe(1)
    expect(signals[0].metadata?.dealType).toBe('expansion')
  })

  it('cachePaths returns the expected path', () => {
    const mod = FeatureModuleRegistry.get('mergers-acquisitions')!
    expect(mod.cachePaths('test')).toEqual(['data/cache/ma-activity.json'])
  })

  it('handles malformed cache gracefully', async () => {
    writeFileSync(MA_CACHE_PATH, 'not valid json{{{')

    const mod = FeatureModuleRegistry.get('mergers-acquisitions')!
    const signals = await mod.signals!('any-customer')
    expect(signals).toEqual([])
  })
})
