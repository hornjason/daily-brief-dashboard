import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { resolve } from 'path'

describe('paths module', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv }

    // Clear module cache to allow re-import with new env
    delete require.cache[require.resolve('../../src/lib/paths.ts')]
  })

  test('CONFIG_DIR uses environment variable when set', async () => {
    process.env.CONFIG_DIR = '/custom/config'
    const { CONFIG_DIR } = await import('../../src/lib/paths.ts')
    expect(CONFIG_DIR).toBe('/custom/config')
  })

  test('CONFIG_DIR falls back to ../config when env not set', async () => {
    delete process.env.CONFIG_DIR
    const { CONFIG_DIR } = await import('../../src/lib/paths.ts')
    // Should resolve to project root config from src/lib/
    expect(CONFIG_DIR).toContain('/config')
    expect(CONFIG_DIR.endsWith('/config')).toBe(true)
  })

  test('DATA_DIR uses environment variable when set', async () => {
    process.env.DATA_DIR = '/custom/data'
    const { DATA_DIR } = await import('../../src/lib/paths.ts')
    expect(DATA_DIR).toBe('/custom/data')
  })

  test('DATA_DIR falls back to ../data when env not set', async () => {
    delete process.env.DATA_DIR
    const { DATA_DIR } = await import('../../src/lib/paths.ts')
    expect(DATA_DIR).toContain('/data')
    expect(DATA_DIR.endsWith('/data')).toBe(true)
  })

  test('CACHE_DIR uses environment variable when set', async () => {
    process.env.CACHE_DIR = '/custom/cache'
    const { CACHE_DIR } = await import('../../src/lib/paths.ts')
    expect(CACHE_DIR).toBe('/custom/cache')
  })

  test('CACHE_DIR falls back to data/cache when env not set', async () => {
    delete process.env.CACHE_DIR
    delete process.env.DATA_DIR
    const { CACHE_DIR } = await import('../../src/lib/paths.ts')
    expect(CACHE_DIR).toContain('/data/cache')
    expect(CACHE_DIR.endsWith('/data/cache')).toBe(true)
  })

  test('DATA_CONFIG_DIR resolves to data/config subdirectory', async () => {
    delete process.env.DATA_DIR
    const { DATA_CONFIG_DIR } = await import('../../src/lib/paths.ts')
    expect(DATA_CONFIG_DIR).toContain('/data/config')
    expect(DATA_CONFIG_DIR.endsWith('/data/config')).toBe(true)
  })

  test('CACHE_DIR respects custom DATA_DIR when CACHE_DIR not set', async () => {
    process.env.DATA_DIR = '/custom/data'
    delete process.env.CACHE_DIR
    const { CACHE_DIR } = await import('../../src/lib/paths.ts')
    expect(CACHE_DIR).toBe('/custom/data/cache')
  })
})
