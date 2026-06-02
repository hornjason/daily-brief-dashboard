/**
 * test/unit/motion-overrides.test.ts
 * Motion Overrides — GitHub Issue #520
 *
 * TDD tests for user overrides: custom assets, plays, dismiss/pin.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

// Use a temp dir so tests don't touch real data
const TEST_CACHE_DIR = join(import.meta.dir, '__motion-overrides-fixture__')

// We'll import the module under test after setting up the env
let mod: typeof import('../../src/lib/motion-overrides.ts')

beforeEach(async () => {
  // Clean slate
  if (existsSync(TEST_CACHE_DIR)) {
    rmSync(TEST_CACHE_DIR, { recursive: true })
  }
  mkdirSync(TEST_CACHE_DIR, { recursive: true })

  // Set CACHE_DIR env so paths.ts resolves to our test dir
  process.env.CACHE_DIR = TEST_CACHE_DIR

  // Fresh import each test
  mod = await import('../../src/lib/motion-overrides.ts')
})

afterEach(() => {
  if (existsSync(TEST_CACHE_DIR)) {
    rmSync(TEST_CACHE_DIR, { recursive: true })
  }
  delete process.env.CACHE_DIR
})

describe('motion-overrides', () => {
  // ── Test 1: loadOverrides returns empty defaults for new customer ──────
  it('loadOverrides returns empty defaults for new customer', () => {
    const overrides = mod.loadOverrides('acme-corp', TEST_CACHE_DIR)
    expect(overrides.customAssets).toEqual([])
    expect(overrides.customPlays).toEqual([])
    expect(overrides.dismissed).toEqual([])
    expect(overrides.pinned).toEqual([])
    expect(overrides.phaseDismissed).toEqual([])
    expect(overrides.phasePinned).toEqual([])
  })

  // ── Test 2: addCustomAsset stores asset in overrides file ──────────────
  it('addCustomAsset stores asset in overrides file', () => {
    const asset = { name: 'Custom Deck', url: 'https://example.com/deck.pdf', type: 'pdf' }
    mod.addCustomAsset('acme-corp', 'phase-expand-ansible', asset, TEST_CACHE_DIR)

    const overrides = mod.loadOverrides('acme-corp', TEST_CACHE_DIR)
    expect(overrides.customAssets).toHaveLength(1)
    expect(overrides.customAssets[0].phaseId).toBe('phase-expand-ansible')
    expect(overrides.customAssets[0].asset.name).toBe('Custom Deck')
    expect(overrides.customAssets[0].asset.url).toBe('https://example.com/deck.pdf')
  })

  // ── Test 3: dismissMotion flags motion as dismissed ────────────────────
  it('dismissMotion flags motion as dismissed', () => {
    mod.dismissMotion('acme-corp', 'motion-123', TEST_CACHE_DIR)

    const overrides = mod.loadOverrides('acme-corp', TEST_CACHE_DIR)
    expect(overrides.dismissed).toHaveLength(1)
    expect(overrides.dismissed[0].motionId).toBe('motion-123')
    expect(overrides.dismissed[0].dismissedAt).toBeTruthy()
  })

  // ── Test 4: pinMotion flags motion as pinned ───────────────────────────
  it('pinMotion flags motion as pinned', () => {
    mod.pinMotion('acme-corp', 'motion-456', TEST_CACHE_DIR)

    const overrides = mod.loadOverrides('acme-corp', TEST_CACHE_DIR)
    expect(overrides.pinned).toHaveLength(1)
    expect(overrides.pinned[0].motionId).toBe('motion-456')
    expect(overrides.pinned[0].pinnedAt).toBeTruthy()
  })

  // ── Test 5: undismissMotion removes dismissed flag ─────────────────────
  it('undismissMotion removes dismissed flag', () => {
    mod.dismissMotion('acme-corp', 'motion-123', TEST_CACHE_DIR)
    mod.undismissMotion('acme-corp', 'motion-123', TEST_CACHE_DIR)

    const overrides = mod.loadOverrides('acme-corp', TEST_CACHE_DIR)
    expect(overrides.dismissed).toHaveLength(0)
  })

  // ── Test 6: custom assets augment, never replace system assets ─────────
  it('custom assets augment, never replace system assets', () => {
    // Add two custom assets to the same phase
    const asset1 = { name: 'Custom Deck', url: 'https://example.com/deck.pdf', type: 'pdf' }
    const asset2 = { name: 'Case Study', url: 'https://example.com/case.pdf', type: 'pdf' }
    mod.addCustomAsset('acme-corp', 'phase-1', asset1, TEST_CACHE_DIR)
    mod.addCustomAsset('acme-corp', 'phase-1', asset2, TEST_CACHE_DIR)

    const overrides = mod.loadOverrides('acme-corp', TEST_CACHE_DIR)
    // Both assets should be present — adding never removes existing
    expect(overrides.customAssets).toHaveLength(2)
    expect(overrides.customAssets[0].asset.name).toBe('Custom Deck')
    expect(overrides.customAssets[1].asset.name).toBe('Case Study')
  })

  // ── Test 7: dismissPhase flags phase as dismissed ──────────────────────
  it('dismissPhase flags phase as dismissed', () => {
    mod.dismissPhase('acme-corp', 'phase-expand-ansible', TEST_CACHE_DIR)

    const overrides = mod.loadOverrides('acme-corp', TEST_CACHE_DIR)
    expect(overrides.phaseDismissed).toHaveLength(1)
    expect(overrides.phaseDismissed[0].phaseId).toBe('phase-expand-ansible')
    expect(overrides.phaseDismissed[0].dismissedAt).toBeTruthy()
  })

  // ── Test 8: pinPhase flags phase as pinned ─────────────────────────────
  it('pinPhase flags phase as pinned', () => {
    mod.pinPhase('acme-corp', 'phase-anchor-rhel', TEST_CACHE_DIR)

    const overrides = mod.loadOverrides('acme-corp', TEST_CACHE_DIR)
    expect(overrides.phasePinned).toHaveLength(1)
    expect(overrides.phasePinned[0].phaseId).toBe('phase-anchor-rhel')
    expect(overrides.phasePinned[0].pinnedAt).toBeTruthy()
  })

  // ── Test 9: saveOverrides persists to disk ─────────────────────────────
  it('saveOverrides persists to disk', () => {
    const overrides = mod.loadOverrides('acme-corp', TEST_CACHE_DIR)
    overrides.customAssets.push({
      phaseId: 'phase-1',
      asset: { name: 'Test', url: 'https://test.com', type: 'link' },
    })
    mod.saveOverrides('acme-corp', overrides, TEST_CACHE_DIR)

    // Re-load and verify persistence
    const reloaded = mod.loadOverrides('acme-corp', TEST_CACHE_DIR)
    expect(reloaded.customAssets).toHaveLength(1)
  })

  // ── Test 10: dismiss is idempotent ─────────────────────────────────────
  it('dismiss is idempotent — double dismiss does not duplicate', () => {
    mod.dismissMotion('acme-corp', 'motion-123', TEST_CACHE_DIR)
    mod.dismissMotion('acme-corp', 'motion-123', TEST_CACHE_DIR)

    const overrides = mod.loadOverrides('acme-corp', TEST_CACHE_DIR)
    expect(overrides.dismissed).toHaveLength(1)
  })

  // ── Test 11: pin is idempotent ─────────────────────────────────────────
  it('pin is idempotent — double pin does not duplicate', () => {
    mod.pinMotion('acme-corp', 'motion-456', TEST_CACHE_DIR)
    mod.pinMotion('acme-corp', 'motion-456', TEST_CACHE_DIR)

    const overrides = mod.loadOverrides('acme-corp', TEST_CACHE_DIR)
    expect(overrides.pinned).toHaveLength(1)
  })
})
