// test/unit/feature-module-registry.test.ts
// Unit tests for FeatureModuleRegistry (ADR-020)
// Tests the self-registration pattern, lifecycle hooks, and status tracking.

import { describe, test, expect, beforeEach } from 'bun:test'
import type { FeatureModule } from '../../src/feature-module-registry.ts'

// Reset the registry before each test by re-importing
let FeatureModuleRegistry: any

beforeEach(async () => {
  // Clear module cache to get a fresh registry instance
  delete require.cache[require.resolve('../../src/feature-module-registry.ts')]
  const mod = await import('../../src/feature-module-registry.ts')
  FeatureModuleRegistry = mod.FeatureModuleRegistry
})

describe('FeatureModuleRegistry', () => {
  test('register and retrieve a module by name', () => {
    const module: FeatureModule = {
      name: 'test-module',
      cachePaths: (slug: string) => [`cache/${slug}/test.json`],
      fetch: async (customerName: string) => {},
      cleanup: async (customerName: string) => {},
      syncNow: async (customerName: string) => {},
    }

    FeatureModuleRegistry.register(module)
    const retrieved = FeatureModuleRegistry.get('test-module')

    expect(retrieved).toBeDefined()
    expect(retrieved?.name).toBe('test-module')
  })

  test('list returns all registered modules', () => {
    const module1: FeatureModule = {
      name: 'module-1',
      cachePaths: (slug) => [`cache/${slug}/m1.json`],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
    }

    const module2: FeatureModule = {
      name: 'module-2',
      cachePaths: (slug) => [`cache/${slug}/m2.json`],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
    }

    FeatureModuleRegistry.register(module1)
    FeatureModuleRegistry.register(module2)

    const modules = FeatureModuleRegistry.list()
    expect(modules).toHaveLength(2)
    expect(modules.map((m: FeatureModule) => m.name).sort()).toEqual(['module-1', 'module-2'])
  })

  test('duplicate registration warns but does not throw', () => {
    const module: FeatureModule = {
      name: 'dup-test',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
    }

    // Capture console.warn output
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: any[]) => warnings.push(args.join(' '))

    FeatureModuleRegistry.register(module)
    FeatureModuleRegistry.register(module) // duplicate

    console.warn = originalWarn

    expect(warnings.some(w => w.includes('dup-test'))).toBe(true)
    expect(() => FeatureModuleRegistry.get('dup-test')).not.toThrow()
  })

  test('cleanupAll calls cleanup on all modules', async () => {
    const calls: string[] = []

    const module1: FeatureModule = {
      name: 'cleanup-1',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async (customerName) => { calls.push(`cleanup-1:${customerName}`) },
      syncNow: async () => {},
    }

    const module2: FeatureModule = {
      name: 'cleanup-2',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async (customerName) => { calls.push(`cleanup-2:${customerName}`) },
      syncNow: async () => {},
    }

    FeatureModuleRegistry.register(module1)
    FeatureModuleRegistry.register(module2)

    await FeatureModuleRegistry.cleanupAll('test-customer')

    expect(calls).toContain('cleanup-1:test-customer')
    expect(calls).toContain('cleanup-2:test-customer')
  })

  test('cleanupAll continues if one module cleanup throws', async () => {
    const calls: string[] = []

    const module1: FeatureModule = {
      name: 'cleanup-fail',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => { throw new Error('cleanup failed') },
      syncNow: async () => {},
    }

    const module2: FeatureModule = {
      name: 'cleanup-ok',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async (customerName) => { calls.push(`cleanup-ok:${customerName}`) },
      syncNow: async () => {},
    }

    FeatureModuleRegistry.register(module1)
    FeatureModuleRegistry.register(module2)

    // Should not throw despite module1 failing
    await FeatureModuleRegistry.cleanupAll('test-customer')

    // module2 should still have been called
    expect(calls).toContain('cleanup-ok:test-customer')
  })

  test('syncNowAll calls syncNow on all modules', async () => {
    const calls: string[] = []

    const module1: FeatureModule = {
      name: 'sync-1',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async (customerName) => { calls.push(`sync-1:${customerName}`) },
    }

    const module2: FeatureModule = {
      name: 'sync-2',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async (customerName) => { calls.push(`sync-2:${customerName}`) },
    }

    FeatureModuleRegistry.register(module1)
    FeatureModuleRegistry.register(module2)

    await FeatureModuleRegistry.syncNowAll('test-customer')

    expect(calls).toContain('sync-1:test-customer')
    expect(calls).toContain('sync-2:test-customer')
  })

  test('getStatus returns correct state after recordOutcome', () => {
    const module: FeatureModule = {
      name: 'status-test',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
    }

    FeatureModuleRegistry.register(module)

    const initialStatus = FeatureModuleRegistry.getStatus()
    expect(initialStatus['status-test']).toBeDefined()
    expect(initialStatus['status-test']?.state).toBe('idle')
    // lastChanged may be null (fresh registry) or a timestamp (loaded from manifest)
    // This test just verifies the status structure exists

    FeatureModuleRegistry.recordOutcome('status-test', { success: true })

    const afterSuccess = FeatureModuleRegistry.getStatus()
    expect(afterSuccess['status-test']?.state).toBe('idle')
    expect(afterSuccess['status-test']?.lastChanged).not.toBeNull()
  })

  test('recordOutcome with success updates lastChanged', () => {
    const module: FeatureModule = {
      name: 'success-test',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
    }

    FeatureModuleRegistry.register(module)
    FeatureModuleRegistry.recordOutcome('success-test', { success: true })

    const status = FeatureModuleRegistry.getStatus()
    expect(status['success-test']?.lastChanged).not.toBeNull()
    expect(status['success-test']?.lastError).toBeNull()
    expect(status['success-test']?.state).toBe('idle')
  })

  test('recordOutcome with failure updates lastError and state', () => {
    const module: FeatureModule = {
      name: 'failure-test',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
    }

    FeatureModuleRegistry.register(module)
    FeatureModuleRegistry.recordOutcome('failure-test', {
      success: false,
      error: 'Test failure message'
    })

    const status = FeatureModuleRegistry.getStatus()
    expect(status['failure-test']?.lastError).toBe('Test failure message')
    expect(status['failure-test']?.state).toBe('error')
  })
})
