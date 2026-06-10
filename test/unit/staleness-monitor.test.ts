/**
 * Staleness Monitor Tests — ADR-037 F3
 *
 * Tests the heartbeat staleness flagging module that checks
 * module freshness using registry status timestamps + cacheTtlMs.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { FeatureModuleRegistry } from '../../src/feature-module-registry.ts'
import {
  checkModuleStaleness,
  getStalenessMap,
  _resetStalenessForTesting,
} from '../../src/staleness-monitor.ts'
import type { FeatureModule } from '../../src/feature-module-registry.ts'

function makeMockModule(overrides: Partial<FeatureModule> & { name: string }): FeatureModule {
  return {
    cachePaths: () => [],
    fetch: async () => {},
    cleanup: async () => {},
    syncNow: async () => {},
    ...overrides,
  }
}

describe('staleness-monitor', () => {
  beforeEach(() => {
    FeatureModuleRegistry._resetForTesting()
    _resetStalenessForTesting()
  })

  test('module with cacheTtlMs and recent lastChecked → fresh', () => {
    const mod = makeMockModule({ name: 'test-fresh', cacheTtlMs: 60 * 60 * 1000 }) // 1h TTL
    FeatureModuleRegistry.register(mod)
    // Record a recent outcome — lastChecked = now
    FeatureModuleRegistry.recordOutcome('test-fresh', { success: true })

    checkModuleStaleness()
    const map = getStalenessMap()

    expect(map['test-fresh']).toBeDefined()
    expect(map['test-fresh'].level).toBe('fresh')
    expect(map['test-fresh'].lastChecked).not.toBeNull()
    expect(map['test-fresh'].cacheTtlMs).toBe(60 * 60 * 1000)
    expect(map['test-fresh'].timeUntilExpiry).toBeGreaterThan(0)
  })

  test('module with cacheTtlMs and lastChecked at 80% of TTL → expiring-soon', () => {
    const TTL = 60 * 60 * 1000 // 1h
    const mod = makeMockModule({ name: 'test-expiring', cacheTtlMs: TTL })
    FeatureModuleRegistry.register(mod)

    // Simulate lastChecked = 80% of TTL ago
    const eightyPercentAgo = new Date(Date.now() - TTL * 0.8).toISOString()
    FeatureModuleRegistry.updateStatus('test-expiring', { lastChecked: eightyPercentAgo })

    checkModuleStaleness()
    const map = getStalenessMap()

    expect(map['test-expiring'].level).toBe('expiring-soon')
    expect(map['test-expiring'].timeUntilExpiry).toBeLessThan(TTL * 0.25)
    expect(map['test-expiring'].timeUntilExpiry).toBeGreaterThan(0)
  })

  test('module with cacheTtlMs and lastChecked past TTL → stale', () => {
    const TTL = 60 * 60 * 1000 // 1h
    const mod = makeMockModule({ name: 'test-stale', cacheTtlMs: TTL })
    FeatureModuleRegistry.register(mod)

    // Simulate lastChecked = 2 hours ago (past TTL)
    const twoHoursAgo = new Date(Date.now() - 2 * TTL).toISOString()
    FeatureModuleRegistry.updateStatus('test-stale', { lastChecked: twoHoursAgo })

    checkModuleStaleness()
    const map = getStalenessMap()

    expect(map['test-stale'].level).toBe('stale')
    expect(map['test-stale'].timeUntilExpiry).toBeLessThan(0) // expired
  })

  test('module without cacheTtlMs → unknown', () => {
    const mod = makeMockModule({ name: 'test-no-ttl' }) // no cacheTtlMs
    FeatureModuleRegistry.register(mod)
    FeatureModuleRegistry.recordOutcome('test-no-ttl', { success: true })

    checkModuleStaleness()
    const map = getStalenessMap()

    expect(map['test-no-ttl'].level).toBe('unknown')
    expect(map['test-no-ttl'].cacheTtlMs).toBeNull()
    expect(map['test-no-ttl'].timeUntilExpiry).toBeNull()
  })

  test('module with cacheTtlMs but no lastChecked (never run) → stale', () => {
    const mod = makeMockModule({ name: 'test-never-run', cacheTtlMs: 60 * 60 * 1000 })
    FeatureModuleRegistry.register(mod)
    // Don't record any outcome — lastChecked stays null

    checkModuleStaleness()
    const map = getStalenessMap()

    expect(map['test-never-run'].level).toBe('stale')
    expect(map['test-never-run'].lastChecked).toBeNull()
    expect(map['test-never-run'].timeUntilExpiry).toBeNull()
  })

  test('getStalenessMap returns empty record before checkModuleStaleness is called', () => {
    const map = getStalenessMap()
    expect(Object.keys(map).length).toBe(0)
  })

  test('multiple modules are tracked independently', () => {
    const mod1 = makeMockModule({ name: 'mod-a', cacheTtlMs: 60 * 60 * 1000 })
    const mod2 = makeMockModule({ name: 'mod-b' }) // no TTL
    FeatureModuleRegistry.register(mod1)
    FeatureModuleRegistry.register(mod2)
    FeatureModuleRegistry.recordOutcome('mod-a', { success: true })

    checkModuleStaleness()
    const map = getStalenessMap()

    expect(Object.keys(map)).toHaveLength(2)
    expect(map['mod-a'].level).toBe('fresh')
    expect(map['mod-b'].level).toBe('unknown')
  })
})
