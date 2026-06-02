// test/unit/saleshub-signals.test.ts
// GitHub Issue #512 — SalesHub signal pipeline: TDPs + tactics + sales plays as signals
// TDD RED phase: tests written before implementation

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { FeatureModuleRegistry, type Signal } from '../../src/feature-module-registry.ts'

// Point to test fixtures
const FIXTURES_DIR = import.meta.dir + '/../../data-test'

beforeAll(async () => {
  // Set env vars to point at test data
  process.env.CONFIG_DIR = FIXTURES_DIR + '/config'
  process.env.CACHE_DIR = FIXTURES_DIR + '/cache'

  // Reset registry to avoid cross-test pollution
  FeatureModuleRegistry._resetForTesting()

  // Reset knowledge loader cache so it re-reads with new CONFIG_DIR
  const { resetKnowledgeCache } = await import('../../src/lib/saleshub-knowledge-loader.ts')
  resetKnowledgeCache()

  // Reset drive content cache
  const { resetDriveContentCache } = await import('../../src/lib/saleshub-content.ts')
  resetDriveContentCache()

  // Import the module to trigger registration
  await import('../../src/modules/saleshub-module.ts')
})

afterAll(() => {
  delete process.env.CONFIG_DIR
  delete process.env.CACHE_DIR
})

describe('SalesHub signal pipeline (#512)', () => {
  async function getSignals(): Promise<Signal[]> {
    const mod = FeatureModuleRegistry.get('saleshub')
    expect(mod).toBeDefined()
    expect(mod!.signals).toBeDefined()
    return mod!.signals!('test-customer')
  }

  test('signals() returns 25 tactic signals', async () => {
    const signals = await getSignals()
    const tacticSignals = signals.filter(s => s.source === 'saleshub-tactics')
    expect(tacticSignals.length).toBe(25)
  })

  test('each tactic signal has parentTdp and assets', async () => {
    const signals = await getSignals()
    const tacticSignals = signals.filter(s => s.source === 'saleshub-tactics')

    for (const signal of tacticSignals) {
      expect(signal.type).toBe('recommendation')
      expect(signal.headline).toBeTruthy()
      expect(signal.metadata).toBeDefined()
      expect(typeof signal.metadata!.parentTdp).toBe('string')
      expect(signal.metadata!.playType).toBe('tactic')
      expect(Array.isArray(signal.metadata!.assets)).toBe(true)
    }
  })

  test('signals() returns 5 sales play signals', async () => {
    const signals = await getSignals()
    const playSignals = signals.filter(s => s.source === 'saleshub-plays')
    expect(playSignals.length).toBe(5)
  })

  test('each play signal has tdpAlignment and personaRoles', async () => {
    const signals = await getSignals()
    const playSignals = signals.filter(s => s.source === 'saleshub-plays')

    for (const signal of playSignals) {
      expect(signal.type).toBe('recommendation')
      expect(signal.headline).toBeTruthy()
      expect(signal.metadata).toBeDefined()
      expect(Array.isArray(signal.metadata!.tdpAlignment)).toBe(true)
      expect(Array.isArray(signal.metadata!.personaRoles)).toBe(true)
      expect(Array.isArray(signal.metadata!.painPoints)).toBe(true)
      expect(Array.isArray(signal.metadata!.discoveryQuestions)).toBe(true)
      expect(Array.isArray(signal.metadata!.valueProps)).toBe(true)
      expect(Array.isArray(signal.metadata!.whatWinsThemOver)).toBe(true)
      expect(Array.isArray(signal.metadata!.documents)).toBe(true)
      expect(Array.isArray(signal.metadata!.regionalCampaigns)).toBe(true)
      expect(signal.metadata!.playType).toBe('strategic')
    }
  })

  test('play documents matched to Drive URLs where available', async () => {
    const signals = await getSignals()
    const playSignals = signals.filter(s => s.source === 'saleshub-plays')

    // "Modernize Infrastructure" play has documents with driveUrl already set in knowledge JSON
    const modernizePlay = playSignals.find(s => s.headline === 'Modernize Infrastructure')
    expect(modernizePlay).toBeDefined()

    const docs = modernizePlay!.metadata!.documents as Array<{ name: string; driveUrl?: string }>
    expect(docs.length).toBeGreaterThan(0)

    // At least one document should have a driveUrl (from knowledge JSON or Drive cross-ref)
    const docsWithUrl = docs.filter(d => d.driveUrl && d.driveUrl.length > 0)
    expect(docsWithUrl.length).toBeGreaterThan(0)
  })

  test('signals follow ADR-027 scoring (rawRelevance, no hardcoded score)', async () => {
    const signals = await getSignals()

    for (const signal of signals) {
      // Must have rawRelevance
      expect(signal.rawRelevance).toBeDefined()
      expect(typeof signal.rawRelevance).toBe('number')
      expect(signal.rawRelevance).toBeGreaterThan(0)
      expect(signal.rawRelevance).toBeLessThanOrEqual(1)

      // Must NOT have score set by module (registry scores centrally)
      expect(signal.score).toBeUndefined()
    }

    // Tactic signals: rawRelevance = 0.3
    const tacticSignals = signals.filter(s => s.source === 'saleshub-tactics')
    for (const s of tacticSignals) {
      expect(s.rawRelevance).toBe(0.3)
    }

    // Play signals: rawRelevance = 0.4
    const playSignals = signals.filter(s => s.source === 'saleshub-plays')
    for (const s of playSignals) {
      expect(s.rawRelevance).toBe(0.4)
    }
  })

  test('module retains signalRole enrichment and scope portfolio', () => {
    const mod = FeatureModuleRegistry.get('saleshub')
    expect(mod).toBeDefined()
    expect(mod!.signalRole).toBe('enrichment')
    expect(mod!.scope).toBe('portfolio')
  })
})
