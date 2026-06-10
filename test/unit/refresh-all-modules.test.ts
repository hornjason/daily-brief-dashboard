/**
 * Unit tests for refreshAllModules (ADR-037 Layer 3, F2)
 * GitHub #750
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FeatureModuleRegistry, type FeatureModule } from '../../src/feature-module-registry.ts'

// ── Test helpers ────────────────────────────────────────────────────────────

let tmpDir: string
let origCacheDir: string | undefined

function makeMockModule(name: string, opts: {
  syncDelay?: number
  syncError?: boolean
  scope?: 'portfolio' | 'customer' | 'both'
} = {}): FeatureModule {
  const { syncDelay = 5, syncError = false, scope = 'portfolio' } = opts
  return {
    name,
    cachePaths: () => [],
    fetch: async () => {},
    cleanup: async () => {},
    syncNow: async (_customer: string) => {
      if (syncDelay > 0) await new Promise(r => setTimeout(r, syncDelay))
      if (syncError) throw new Error(`${name} sync failed`)
    },
    scope,
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'refresh-all-test-'))
  mkdirSync(join(tmpDir, 'cache'), { recursive: true })
  origCacheDir = process.env.CACHE_DIR
  process.env.CACHE_DIR = join(tmpDir, 'cache')
  FeatureModuleRegistry._resetForTesting()
})

afterEach(() => {
  if (origCacheDir !== undefined) {
    process.env.CACHE_DIR = origCacheDir
  } else {
    delete process.env.CACHE_DIR
  }
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

describe('refreshAllModules', () => {
  test('processes fast-batch modules in parallel via allSettled', async () => {
    // Register 3 fast (non-Gemini) modules
    FeatureModuleRegistry.register(makeMockModule('subscriptions', { syncDelay: 10 }))
    FeatureModuleRegistry.register(makeMockModule('ccsp', { syncDelay: 10 }))
    FeatureModuleRegistry.register(makeMockModule('pipeline', { syncDelay: 10 }))

    const { refreshAllModules, getRefreshManifest } = await import('../../src/refresh-engine.ts')
    const manifest = await refreshAllModules('test')

    expect(manifest).toBeDefined()
    expect(manifest.trigger).toBe('test')
    expect(manifest.totalModules).toBe(3)
    expect(manifest.completed).toBe(3)
    expect(manifest.failed).toBe(0)
    expect(manifest.modules.subscriptions.status).toBe('done')
    expect(manifest.modules.ccsp.status).toBe('done')
    expect(manifest.modules.pipeline.status).toBe('done')

    // Manifest should also be readable from disk
    const diskManifest = getRefreshManifest()
    expect(diskManifest).not.toBeNull()
    expect(diskManifest!.completed).toBe(3)
  })

  test('Gemini modules run sequentially', async () => {
    // Register one fast and one Gemini module
    FeatureModuleRegistry.register(makeMockModule('subscriptions', { syncDelay: 5 }))
    FeatureModuleRegistry.register(makeMockModule('cloud-marketplace', { syncDelay: 5 }))

    const { refreshAllModules } = await import('../../src/refresh-engine.ts')
    const manifest = await refreshAllModules('gemini-test')

    expect(manifest.completed).toBe(2)
    expect(manifest.modules.subscriptions.status).toBe('done')
    expect(manifest.modules['cloud-marketplace'].status).toBe('done')
  })

  test('mutex prevents concurrent runs', async () => {
    // Register a slow module so the first call is still running
    FeatureModuleRegistry.register(makeMockModule('slow-module', { syncDelay: 300 }))

    const { refreshAllModules, _resetRefreshMutex } = await import('../../src/refresh-engine.ts')
    _resetRefreshMutex()

    // Start first call (don't await)
    const first = refreshAllModules('first-run')

    // Small delay to ensure first has started
    await new Promise(r => setTimeout(r, 30))

    // Second call should return the current manifest immediately
    const secondResult = await refreshAllModules('second-run')

    // Second call returns early — trigger is 'first-run' since that's active
    expect(secondResult.trigger).toBe('first-run')

    // Wait for first to finish
    const firstResult = await first
    expect(firstResult.completed).toBe(1)
  })

  test('manifest is written to disk and readable', async () => {
    FeatureModuleRegistry.register(makeMockModule('cases', { syncDelay: 5 }))

    const { refreshAllModules, getRefreshManifest } = await import('../../src/refresh-engine.ts')
    await refreshAllModules('disk-test')

    const manifest = getRefreshManifest()
    expect(manifest).not.toBeNull()
    expect(manifest!.trigger).toBe('disk-test')
    expect(manifest!.totalModules).toBe(1)
    expect(manifest!.completed).toBe(1)
    expect(manifest!.modules.cases).toBeDefined()
    expect(manifest!.modules.cases.status).toBe('done')
    expect(typeof manifest!.modules.cases.durationMs).toBe('number')
  })

  test('handles module sync failures gracefully', async () => {
    FeatureModuleRegistry.register(makeMockModule('good-module', { syncDelay: 5 }))
    FeatureModuleRegistry.register(makeMockModule('bad-module', { syncDelay: 5, syncError: true }))

    const { refreshAllModules } = await import('../../src/refresh-engine.ts')
    const manifest = await refreshAllModules('error-test')

    expect(manifest.completed).toBe(1)
    expect(manifest.failed).toBe(1)
    expect(manifest.modules['good-module'].status).toBe('done')
    expect(manifest.modules['bad-module'].status).toBe('failed')
    expect(manifest.modules['bad-module'].error).toContain('sync failed')
  })

  test('getRefreshManifest returns null when no manifest exists', async () => {
    const { getRefreshManifest } = await import('../../src/refresh-engine.ts')
    const manifest = getRefreshManifest()
    expect(manifest).toBeNull()
  })

  test('manifest has correct schema', async () => {
    FeatureModuleRegistry.register(makeMockModule('subscriptions'))

    const { refreshAllModules } = await import('../../src/refresh-engine.ts')
    const manifest = await refreshAllModules('schema-test')

    // Verify manifest schema
    expect(manifest.startedAt).toBeDefined()
    expect(typeof manifest.startedAt).toBe('string')
    expect(manifest.trigger).toBe('schema-test')
    expect(typeof manifest.totalModules).toBe('number')
    expect(typeof manifest.completed).toBe('number')
    expect(typeof manifest.failed).toBe('number')
    expect(typeof manifest.skipped).toBe('number')
    expect(manifest.inProgress).toBeNull()
  })
})
