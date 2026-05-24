// test/unit/competitive-intel-module.test.ts
// GitHub Issue #319 — Competitive Intelligence module tests
// TDD: RED phase — these tests define the contract before implementation

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { resolve } from 'path'
import { FeatureModuleRegistry, type Signal } from '../../src/feature-module-registry.ts'

// ── Test fixtures ─────────────────────────────────────────────────────────────

const TEST_CACHE_DIR = resolve(import.meta.dir, '..', 'fixtures', 'competitive-intel-test-cache')
const COMPETITIVE_CACHE_DIR = resolve(TEST_CACHE_DIR, 'competitive-intel')

const SAMPLE_DECK_EXTRACTION = {
  competitor: 'VMware',
  product: 'vSphere',
  announcement: 'Broadcom licensing consolidation forcing customers to re-evaluate virtualization',
  redHatCounter: 'OpenShift Virtualization consolidates VMs + containers on one platform, reducing licensing complexity',
  salesTriggers: ['reduce IT staff but do more with less', 'consolidate virtualization licensing'],
  compensation: 'Q3 SPIFF: $5K per OpenShift Virt deal over $100K',
  keyDates: ['2026-07-01: VMware license renewal deadline for many customers'],
}

const SAMPLE_CACHE = {
  decks: [
    {
      deckId: 'abc123',
      deckName: 'OpenShift Edge Competitive',
      deckDate: '2026-04-26',
      contentHash: 'hash1',
      extractions: [
        {
          competitor: 'VMware',
          product: 'vSphere',
          announcement: 'Broadcom licensing consolidation forcing customers to re-evaluate virtualization',
          redHatCounter: 'OpenShift Virtualization consolidates VMs + containers on one platform',
          salesTriggers: ['reduce IT staff but do more with less'],
          compensation: 'Q3 SPIFF for OpenShift Virt',
          keyDates: ['2026-07-01'],
        },
      ],
      cachedAt: '2026-04-27T00:00:00.000Z',
    },
    {
      deckId: 'def456',
      deckName: 'IBM Fusion: 15min Competitive for RH Sellers April2026',
      deckDate: '2026-04-15',
      contentHash: 'hash2',
      extractions: [
        {
          competitor: 'AWS',
          product: 'EKS Anywhere',
          announcement: 'AWS expanding edge Kubernetes offering',
          redHatCounter: 'OpenShift edge portfolio with MicroShift for disconnected environments',
          salesTriggers: ['edge computing', 'disconnected operations'],
          compensation: null,
          keyDates: [],
        },
      ],
      cachedAt: '2026-04-16T00:00:00.000Z',
    },
  ],
  emailSearchTerms: ['subject:"15 Minute Competitive Update"'],
  lastRefreshed: '2026-04-27T00:00:00.000Z',
}

// ── Setup/teardown ────────────────────────────────────────────────────────────

describe('competitive-intel-module', () => {
  beforeEach(() => {
    // Set env vars before importing module
    process.env.CACHE_DIR = TEST_CACHE_DIR
    mkdirSync(COMPETITIVE_CACHE_DIR, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
    } catch { /* ignore */ }
    delete process.env.CACHE_DIR
  })

  // ── Registration tests ──────────────────────────────────────────────────────

  describe('module registration', () => {
    it('registers with FeatureModuleRegistry under name "competitive-intel"', async () => {
      // Force re-import to trigger registration with test env
      await import('../../src/modules/competitive-intel-module.ts')
      const mod = FeatureModuleRegistry.get('competitive-intel')
      expect(mod).toBeDefined()
      expect(mod!.name).toBe('competitive-intel')
    })

    it('has displayName "Competitive Intel"', async () => {
      await import('../../src/modules/competitive-intel-module.ts')
      const mod = FeatureModuleRegistry.get('competitive-intel')
      expect(mod!.displayName).toBe('Competitive Intel')
    })

    it('has refreshEndpoint "/api/refresh/competitive-intel"', async () => {
      await import('../../src/modules/competitive-intel-module.ts')
      const mod = FeatureModuleRegistry.get('competitive-intel')
      expect(mod!.refreshEndpoint).toBe('/api/refresh/competitive-intel')
    })

    it('has scope "portfolio" (not customer-specific)', async () => {
      await import('../../src/modules/competitive-intel-module.ts')
      const mod = FeatureModuleRegistry.get('competitive-intel')
      expect(mod!.scope).toBe('portfolio')
    })

    it('has weekly refresh interval (7 days)', async () => {
      await import('../../src/modules/competitive-intel-module.ts')
      const mod = FeatureModuleRegistry.get('competitive-intel')
      expect(mod!.refreshInterval).toBe(7 * 24 * 60 * 60 * 1000)
    })
  })

  // ── Cache structure tests ───────────────────────────────────────────────────

  describe('cache structure', () => {
    it('cachePaths returns competitive-intel directory path', async () => {
      await import('../../src/modules/competitive-intel-module.ts')
      const mod = FeatureModuleRegistry.get('competitive-intel')!
      const paths = mod.cachePaths('')
      expect(paths.length).toBeGreaterThan(0)
      expect(paths[0]).toContain('competitive-intel')
    })
  })

  // ── Signal generation tests ─────────────────────────────────────────────────

  describe('signals()', () => {
    it('returns empty array when no cache exists', async () => {
      await import('../../src/modules/competitive-intel-module.ts')
      const mod = FeatureModuleRegistry.get('competitive-intel')!
      const signals = await mod.signals!('test-customer')
      expect(signals).toEqual([])
    })

    it('generates signals from cached deck extractions', async () => {
      // Write cache
      writeFileSync(
        resolve(COMPETITIVE_CACHE_DIR, 'decks.json'),
        JSON.stringify(SAMPLE_CACHE),
      )

      await import('../../src/modules/competitive-intel-module.ts')
      const mod = FeatureModuleRegistry.get('competitive-intel')!
      const signals = await mod.signals!('test-customer')

      expect(signals.length).toBeGreaterThan(0)
    })

    it('signal source is "competitive-intel"', async () => {
      writeFileSync(
        resolve(COMPETITIVE_CACHE_DIR, 'decks.json'),
        JSON.stringify(SAMPLE_CACHE),
      )

      await import('../../src/modules/competitive-intel-module.ts')
      const mod = FeatureModuleRegistry.get('competitive-intel')!
      const signals = await mod.signals!('test-customer')

      for (const s of signals) {
        expect(s.source).toBe('competitive-intel')
      }
    })

    it('signal type is "competitive"', async () => {
      writeFileSync(
        resolve(COMPETITIVE_CACHE_DIR, 'decks.json'),
        JSON.stringify(SAMPLE_CACHE),
      )

      await import('../../src/modules/competitive-intel-module.ts')
      const mod = FeatureModuleRegistry.get('competitive-intel')!
      const signals = await mod.signals!('test-customer')

      for (const s of signals) {
        expect(s.type).toBe('competitive')
      }
    })

    it('signal headline contains competitor name', async () => {
      writeFileSync(
        resolve(COMPETITIVE_CACHE_DIR, 'decks.json'),
        JSON.stringify(SAMPLE_CACHE),
      )

      await import('../../src/modules/competitive-intel-module.ts')
      const mod = FeatureModuleRegistry.get('competitive-intel')!
      const signals = await mod.signals!('test-customer')

      // At least one signal should mention VMware or AWS
      const competitors = signals.map(s => s.headline)
      const hasCompetitor = competitors.some(h => h.includes('VMware') || h.includes('AWS'))
      expect(hasCompetitor).toBe(true)
    })

    it('signal metadata contains competitor, redHatCounter, salesTrigger, deckId, deckDate', async () => {
      writeFileSync(
        resolve(COMPETITIVE_CACHE_DIR, 'decks.json'),
        JSON.stringify(SAMPLE_CACHE),
      )

      await import('../../src/modules/competitive-intel-module.ts')
      const mod = FeatureModuleRegistry.get('competitive-intel')!
      const signals = await mod.signals!('test-customer')

      const first = signals[0]
      expect(first.metadata).toBeDefined()
      expect(first.metadata!.competitor).toBeDefined()
      expect(first.metadata!.redHatCounter).toBeDefined()
      expect(first.metadata!.deckId).toBeDefined()
      expect(first.metadata!.deckDate).toBeDefined()
    })

    it('signal has rawRelevance between 0 and 1', async () => {
      writeFileSync(
        resolve(COMPETITIVE_CACHE_DIR, 'decks.json'),
        JSON.stringify(SAMPLE_CACHE),
      )

      await import('../../src/modules/competitive-intel-module.ts')
      const mod = FeatureModuleRegistry.get('competitive-intel')!
      const signals = await mod.signals!('test-customer')

      for (const s of signals) {
        expect(s.rawRelevance).toBeGreaterThanOrEqual(0)
        expect(s.rawRelevance).toBeLessThanOrEqual(1)
      }
    })

    it('signal detail includes Red Hat counter-positioning', async () => {
      writeFileSync(
        resolve(COMPETITIVE_CACHE_DIR, 'decks.json'),
        JSON.stringify(SAMPLE_CACHE),
      )

      await import('../../src/modules/competitive-intel-module.ts')
      const mod = FeatureModuleRegistry.get('competitive-intel')!
      const signals = await mod.signals!('test-customer')

      // At least one signal detail should contain positioning language
      const hasPositioning = signals.some(s =>
        s.detail.includes('OpenShift') || s.detail.includes('Red Hat')
      )
      expect(hasPositioning).toBe(true)
    })

    it('includes salesTrigger in metadata when present', async () => {
      writeFileSync(
        resolve(COMPETITIVE_CACHE_DIR, 'decks.json'),
        JSON.stringify(SAMPLE_CACHE),
      )

      await import('../../src/modules/competitive-intel-module.ts')
      const mod = FeatureModuleRegistry.get('competitive-intel')!
      const signals = await mod.signals!('test-customer')

      // First deck has sales triggers
      const withTriggers = signals.filter(s => s.metadata?.salesTrigger)
      expect(withTriggers.length).toBeGreaterThan(0)
    })
  })

  // ── Content hash delta test ─────────────────────────────────────────────────

  describe('content hash delta', () => {
    it('cache file stores contentHash per deck for delta detection', async () => {
      writeFileSync(
        resolve(COMPETITIVE_CACHE_DIR, 'decks.json'),
        JSON.stringify(SAMPLE_CACHE),
      )

      const cache = JSON.parse(readFileSync(resolve(COMPETITIVE_CACHE_DIR, 'decks.json'), 'utf-8'))
      for (const deck of cache.decks) {
        expect(deck.contentHash).toBeDefined()
        expect(typeof deck.contentHash).toBe('string')
      }
    })
  })
})
