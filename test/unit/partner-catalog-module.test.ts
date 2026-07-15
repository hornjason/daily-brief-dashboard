// test/unit/partner-catalog-module.test.ts
// GitHub Issue #640, #996 — Partner Catalog Module: signal structure, scoring, tier filtering, and ensureFresh tests

import { describe, test, expect, beforeAll } from 'bun:test'
import { FeatureModuleRegistry, scoreSignal } from '../../src/feature-module-registry.ts'

// Dynamic import to avoid ESM TDZ issues with self-registration
let isKnownTier: (level: string | null | undefined) => boolean
beforeAll(async () => {
  const mod = await import('../../src/modules/partner-catalog-module.ts')
  isKnownTier = mod.isKnownTier
})

describe('partner-catalog-module registration', () => {
  test('module is registered with name partner-catalog', () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')
    expect(mod).toBeDefined()
    expect(mod!.name).toBe('partner-catalog')
  })

  test('scope is portfolio', () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    expect(mod.scope).toBe('portfolio')
  })

  test('has signals function', () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    expect(mod.signals).toBeDefined()
    expect(typeof mod.signals).toBe('function')
  })

  test('has refreshEndpoint (AC-6)', () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    expect(mod.refreshEndpoint).toBeDefined()
    expect(mod.refreshEndpoint).toContain('partner-catalog')
  })

  test('has displayName', () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    expect(mod.displayName).toBe('Partner Catalog')
  })

  test('has ensureFresh function (AC-5)', () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    expect(mod.ensureFresh).toBeDefined()
    expect(typeof mod.ensureFresh).toBe('function')
  })

  test('has cacheTtlMs defined (AC-5)', () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    expect(mod.cacheTtlMs).toBeDefined()
    expect(typeof mod.cacheTtlMs).toBe('number')
    expect(mod.cacheTtlMs! > 0).toBe(true)
  })

  test('cachePaths returns territory-partners.json path (#996)', () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    const paths = mod.cachePaths('test-slug')
    expect(paths.length).toBeGreaterThan(0)
    expect(paths[0]).toContain('territory-partners')
  })
})

describe('partner-catalog signals output structure (AC-2, AC-3, AC-10)', () => {
  test('signals returns array (even with no data)', async () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    const signals = await mod.signals!('test-customer')
    expect(Array.isArray(signals)).toBe(true)
  })

  test('signals have source partner-catalog (AC-9)', async () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    const signals = await mod.signals!('test-customer')
    for (const s of signals) {
      expect(s.source).toBe('partner-catalog')
    }
  })

  test('signals use rawRelevance not hardcoded score (ADR-027)', async () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    const signals = await mod.signals!('test-customer')
    for (const s of signals) {
      // Must not have score set directly
      expect(s.score).toBeUndefined()
      // Must have rawRelevance
      expect(s.rawRelevance).toBeDefined()
      expect(typeof s.rawRelevance).toBe('number')
    }
  })

  test('signal metadata contains required fields (AC-3): partnerName, specializations', async () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    const signals = await mod.signals!('test-customer')
    for (const s of signals) {
      const m = s.metadata!
      expect(m).toBeDefined()
      expect(m.partnerName).toBeDefined()
      expect(m.specializations).toBeDefined()
      expect(Array.isArray(m.specializations)).toBe(true)
    }
  })

  test('match signals include matchedProducts and certifications in metadata (AC-3)', async () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    const signals = await mod.signals!('test-customer')
    // Partner match signals should have matchedProducts array
    const matchSignals = signals.filter(s =>
      s.metadata?.matchedProducts && (s.metadata.matchedProducts as string[]).length > 0
    )
    for (const s of matchSignals) {
      expect(Array.isArray(s.metadata!.matchedProducts)).toBe(true)
      // certifications should be present (may be empty array)
      expect(s.metadata!.certifications !== undefined || s.metadata!.credentialCount !== undefined).toBe(true)
    }
  })

  test('match signals include catalogUrl in metadata (AC-3)', async () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    const signals = await mod.signals!('test-customer')
    // Signals with catalogUrl in the partner data should have it in metadata
    const withUrl = signals.filter(s => s.url)
    for (const s of withUrl) {
      // catalogUrl should also be in metadata
      expect(s.metadata!.catalogUrl !== undefined).toBe(true)
    }
  })

  test('matched partner signals with customerSlug score at customer tier floor >= 0.50 (AC-4)', async () => {
    const mod = FeatureModuleRegistry.get('partner-catalog')!
    const signals = await mod.signals!('test-customer')
    const customerSignals = signals.filter(s => s.metadata?.customerSlug)
    for (const s of customerSignals) {
      const scored = scoreSignal(s)
      // Customer tier floor is 0.50 per ADR-027
      expect(scored.score!).toBeGreaterThanOrEqual(0.50)
    }
  })
})

// ── Tier filtering (#996 AC-3) ──────────────────────────────────────────────

describe('isKnownTier filtering (#996)', () => {
  test('Premier tier passes', () => {
    expect(isKnownTier('Premier Business Partner')).toBe(true)
  })

  test('Advanced tier passes', () => {
    expect(isKnownTier('Advanced Business Partner')).toBe(true)
  })

  test('Specialized tier passes', () => {
    expect(isKnownTier('Red Hat Specialized Partner')).toBe(true)
  })

  test('Red Hat tier passes', () => {
    expect(isKnownTier('Red Hat Ready Partner')).toBe(true)
  })

  test('null partnershipLevel is rejected', () => {
    expect(isKnownTier(null)).toBe(false)
  })

  test('undefined partnershipLevel is rejected', () => {
    expect(isKnownTier(undefined)).toBe(false)
  })

  test('empty string is rejected', () => {
    expect(isKnownTier('')).toBe(false)
  })

  test('unknown tier string is rejected', () => {
    expect(isKnownTier('Reseller')).toBe(false)
  })
})

describe('signals() tier filtering integration (#996)', () => {
  test('signals exclude partners with null partnershipLevel', async () => {
    // Write a temporary territory-partners.json with mixed tiers
    const fs = require('fs')
    const path = require('path')
    const tmpDir = '/tmp/test-partner-catalog-996'
    fs.mkdirSync(tmpDir, { recursive: true })
    const mixedPartners = [
      { name: 'Qualified Partner', aliases: [], domain: 'qual.com', partnershipLevel: 'Red Hat Specialized Partner', specializations: ['Automation'], enrichmentStatus: 'enriched' },
      { name: 'Null Tier Partner', aliases: [], domain: 'nulltier.com', partnershipLevel: null, specializations: ['Container Mgmt'], enrichmentStatus: 'pending' },
      { name: 'Empty Tier Partner', aliases: [], domain: 'empty.com', partnershipLevel: '', specializations: [], enrichmentStatus: 'pending' },
      { name: 'Advanced Partner', aliases: [], domain: 'adv.com', partnershipLevel: 'Advanced Business Partner', specializations: [], enrichmentStatus: 'enriched' },
      { name: 'Unknown Tier', aliases: [], domain: 'unk.com', partnershipLevel: 'Reseller', specializations: [], enrichmentStatus: 'enriched' },
    ]
    fs.writeFileSync(path.join(tmpDir, 'territory-partners.json'), JSON.stringify(mixedPartners))

    // Point CACHE_DIR to temp directory
    const origCacheDir = process.env.CACHE_DIR
    process.env.CACHE_DIR = tmpDir
    try {
      const mod = FeatureModuleRegistry.get('partner-catalog')!
      const signals = await mod.signals!('test-customer')
      const partnerNames = signals.map(s => s.metadata?.partnerName)
      // Only qualified + advanced should appear (2 of 5)
      expect(partnerNames).toContain('Qualified Partner')
      expect(partnerNames).toContain('Advanced Partner')
      expect(partnerNames).not.toContain('Null Tier Partner')
      expect(partnerNames).not.toContain('Empty Tier Partner')
      expect(partnerNames).not.toContain('Unknown Tier')
    } finally {
      if (origCacheDir !== undefined) process.env.CACHE_DIR = origCacheDir
      else delete process.env.CACHE_DIR
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
