import { describe, it, expect, beforeAll, beforeEach } from 'bun:test'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const TEST_CONFIG_DIR = resolve(import.meta.dir, '../fixtures/saleshub-module-test')

// Must set env before importing the module
import { FeatureModuleRegistry } from '../../src/feature-module-registry.ts'

describe('saleshub-module', () => {
  beforeAll(async () => {
    process.env.CONFIG_DIR = TEST_CONFIG_DIR
    mkdirSync(TEST_CONFIG_DIR, { recursive: true })
    // Seed a minimal knowledge JSON
    const knowledgeData = {
      tdps: [
        { name: 'TDP-1', tactics: ['T1'], customerWins: [], whatToSay: [], whatToShare: [], whatToShow: [], services: [], cheatsheetUrl: '', customerDeckUrl: '', description: 'Test TDP' },
      ],
      salesPlays: [
        { name: 'Play-1', customerLens: { pain: [], outcomes: [], impact: [] }, realWorldExamples: [], emailTemplateUrl: '', discoveryQuestionsUrl: '', introPitchDeckUrl: '', personaSection: { roles: [] } },
      ],
      tactics: [
        { name: 'T1', parentTdp: 'TDP-1', talkTrack: 'test', whatToShare: [], extractedContent: '' },
      ],
      products: [],
      scrapedAt: new Date().toISOString(),
    }
    writeFileSync(
      resolve(TEST_CONFIG_DIR, 'saleshub-knowledge.json'),
      JSON.stringify(knowledgeData),
    )
    FeatureModuleRegistry._resetForTesting()
    await import('../../src/modules/saleshub-module.ts')
  })

  it('registers with the FeatureModuleRegistry', () => {
    const mod = FeatureModuleRegistry.get('saleshub')
    expect(mod).toBeDefined()
    expect(mod!.name).toBe('saleshub')
    expect(mod!.displayName).toBe('SalesHub Knowledge')
    expect(mod!.scope).toBe('portfolio')
    expect(mod!.refreshEndpoint).toBe('/api/saleshub/refresh')
    expect(mod!.refreshInterval).toBeNull()
  })

  it('syncNow reloads knowledge and records outcome', async () => {
    const mod = FeatureModuleRegistry.get('saleshub')!
    await mod.syncNow('_global')

    const status = FeatureModuleRegistry.getStatus()
    expect(status.saleshub).toBeDefined()
    expect(status.saleshub.lastChecked).not.toBeNull()
    expect(status.saleshub.state).toBe('idle')
    expect(status.saleshub.lastError).toBeNull()
    // 1 TDP + 1 play + 1 tactic = 3
    expect(status.saleshub.recordCount).toBe(3)
  })

  it('fetch reloads knowledge', async () => {
    const mod = FeatureModuleRegistry.get('saleshub')!
    await mod.fetch('_global')

    const status = FeatureModuleRegistry.getStatus()
    expect(status.saleshub.state).toBe('idle')
    expect(status.saleshub.recordCount).toBe(3)
  })

  it('cleanup is a no-op', async () => {
    const mod = FeatureModuleRegistry.get('saleshub')!
    // Should not throw
    await mod.cleanup('_global')
  })

  it('cachePaths returns expected paths', () => {
    const mod = FeatureModuleRegistry.get('saleshub')!
    const paths = mod.cachePaths('_global')
    expect(paths.length).toBe(2)
    expect(paths[0]).toContain('saleshub-knowledge.json')
    expect(paths[1]).toContain('saleshub-content-index.json')
  })
})
