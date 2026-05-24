// test/unit/feature-module-registry.test.ts
// Unit tests for FeatureModuleRegistry (ADR-020)
// Tests the self-registration pattern, lifecycle hooks, and status tracking.
// NOTE: Registry is shared across all test files (Bun ESM caching). Tests use
// unique module names and toContain assertions to avoid ordering issues.

import { describe, test, expect } from 'bun:test'
import { FeatureModuleRegistry, type FeatureModule } from '../../src/feature-module-registry.ts'

describe('FeatureModuleRegistry', () => {
  test('register and retrieve a module by name', () => {
    const module: FeatureModule = {
      name: 'reg-test-retrieve',
      cachePaths: (slug: string) => [`cache/${slug}/test.json`],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
    }

    FeatureModuleRegistry.register(module)
    const retrieved = FeatureModuleRegistry.get('reg-test-retrieve')

    expect(retrieved).toBeDefined()
    expect(retrieved?.name).toBe('reg-test-retrieve')
  })

  test('list returns all registered modules', () => {
    const module1: FeatureModule = {
      name: 'reg-test-list-1',
      cachePaths: (slug) => [`cache/${slug}/m1.json`],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
    }

    const module2: FeatureModule = {
      name: 'reg-test-list-2',
      cachePaths: (slug) => [`cache/${slug}/m2.json`],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
    }

    FeatureModuleRegistry.register(module1)
    FeatureModuleRegistry.register(module2)

    const modules = FeatureModuleRegistry.list()
    const names = modules.map((m: FeatureModule) => m.name)
    expect(names).toContain('reg-test-list-1')
    expect(names).toContain('reg-test-list-2')
  })

  test('duplicate registration warns but does not throw', () => {
    const module: FeatureModule = {
      name: 'reg-test-dup',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
    }

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: any[]) => warnings.push(args.join(' '))

    FeatureModuleRegistry.register(module)
    FeatureModuleRegistry.register(module)

    console.warn = originalWarn

    expect(warnings.some(w => w.includes('reg-test-dup'))).toBe(true)
    expect(() => FeatureModuleRegistry.get('reg-test-dup')).not.toThrow()
  })

  test('cleanupAll calls cleanup on all modules', async () => {
    // Timeout: real modules from manifest may have slow cleanup

    const calls: string[] = []

    const module1: FeatureModule = {
      name: 'reg-test-cleanup-1',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async (customerName) => { calls.push(`cleanup-1:${customerName}`) },
      syncNow: async () => {},
    }

    const module2: FeatureModule = {
      name: 'reg-test-cleanup-2',
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
  }, { timeout: 15_000 })

  test('cleanupAll continues if one module cleanup throws', async () => {
    const calls: string[] = []

    const module1: FeatureModule = {
      name: 'reg-test-cleanup-fail',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => { throw new Error('cleanup failed') },
      syncNow: async () => {},
    }

    const module2: FeatureModule = {
      name: 'reg-test-cleanup-ok',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async (customerName) => { calls.push(`cleanup-ok:${customerName}`) },
      syncNow: async () => {},
    }

    FeatureModuleRegistry.register(module1)
    FeatureModuleRegistry.register(module2)

    await FeatureModuleRegistry.cleanupAll('test-customer')

    expect(calls).toContain('cleanup-ok:test-customer')
  }, { timeout: 15_000 })

  test('syncNowAll calls syncNow on all modules', async () => {
    // Real modules from manifest may have slow syncNow — long timeout

    const calls: string[] = []

    const module1: FeatureModule = {
      name: 'reg-test-sync-1',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async (customerName) => { calls.push(`sync-1:${customerName}`) },
    }

    const module2: FeatureModule = {
      name: 'reg-test-sync-2',
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
  }, { timeout: 15_000 })

  test('getStatus returns correct state after recordOutcome', () => {
    const module: FeatureModule = {
      name: 'reg-test-status',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
    }

    FeatureModuleRegistry.register(module)

    const initialStatus = FeatureModuleRegistry.getStatus()
    expect(initialStatus['reg-test-status']).toBeDefined()
    expect(initialStatus['reg-test-status']?.state).toBe('idle')

    FeatureModuleRegistry.recordOutcome('reg-test-status', { success: true })

    const afterSuccess = FeatureModuleRegistry.getStatus()
    expect(afterSuccess['reg-test-status']?.state).toBe('idle')
    expect(afterSuccess['reg-test-status']?.lastChanged).not.toBeNull()
  })

  test('recordOutcome with success updates lastChanged', () => {
    const module: FeatureModule = {
      name: 'reg-test-success',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
    }

    FeatureModuleRegistry.register(module)
    FeatureModuleRegistry.recordOutcome('reg-test-success', { success: true })

    const status = FeatureModuleRegistry.getStatus()
    expect(status['reg-test-success']?.lastChanged).not.toBeNull()
    expect(status['reg-test-success']?.lastError).toBeNull()
    expect(status['reg-test-success']?.state).toBe('idle')
  })

  test('recordOutcome with failure updates lastError and state', () => {
    const module: FeatureModule = {
      name: 'reg-test-failure',
      cachePaths: () => [],
      fetch: async () => {},
      cleanup: async () => {},
      syncNow: async () => {},
    }

    FeatureModuleRegistry.register(module)
    FeatureModuleRegistry.recordOutcome('reg-test-failure', {
      success: false,
      error: 'Test failure message'
    })

    const status = FeatureModuleRegistry.getStatus()
    expect(status['reg-test-failure']?.lastError).toBe('Test failure message')
    expect(status['reg-test-failure']?.state).toBe('error')
  })
})
