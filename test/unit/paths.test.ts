import { describe, expect, test } from 'bun:test'
import { CONFIG_DIR, DATA_DIR, CACHE_DIR, DATA_CONFIG_DIR } from '../../src/lib/paths.ts'

// ESM modules cache on first import, so we test the actual resolved values
// rather than trying to mutate env and re-import (which doesn't work in Bun ESM)

describe('paths module', () => {
  test('CONFIG_DIR is either from env or default fallback', () => {
    if (process.env.CONFIG_DIR) {
      expect(CONFIG_DIR).toBe(process.env.CONFIG_DIR)
    } else {
      expect(CONFIG_DIR).toContain('/config')
      expect(CONFIG_DIR.endsWith('/config')).toBe(true)
    }
  })

  test('DATA_DIR is either from env or default fallback', () => {
    if (process.env.DATA_DIR) {
      expect(DATA_DIR).toBe(process.env.DATA_DIR)
    } else {
      expect(DATA_DIR).toContain('/data')
      expect(DATA_DIR.endsWith('/data')).toBe(true)
    }
  })

  test('CACHE_DIR is either from env or derived from DATA_DIR', () => {
    if (process.env.CACHE_DIR) {
      expect(CACHE_DIR).toBe(process.env.CACHE_DIR)
    } else {
      expect(CACHE_DIR).toContain('/data/cache')
      expect(CACHE_DIR.endsWith('/data/cache')).toBe(true)
    }
  })

  test('DATA_CONFIG_DIR resolves correctly', () => {
    // Should use CONFIG_DIR env or DATA_DIR/config
    if (process.env.CONFIG_DIR) {
      expect(DATA_CONFIG_DIR).toBe(process.env.CONFIG_DIR)
    } else {
      expect(DATA_CONFIG_DIR).toContain('/data/config')
      expect(DATA_CONFIG_DIR.endsWith('/data/config')).toBe(true)
    }
  })

  test('CACHE_DIR uses DATA_DIR when CACHE_DIR env not set', () => {
    // If CACHE_DIR env is not set, it should be derived from DATA_DIR
    if (!process.env.CACHE_DIR) {
      if (process.env.DATA_DIR) {
        expect(CACHE_DIR).toBe(`${process.env.DATA_DIR}/cache`)
      } else {
        expect(CACHE_DIR.endsWith('/data/cache')).toBe(true)
      }
    }
  })

  test('all paths are absolute', () => {
    expect(CONFIG_DIR.startsWith('/')).toBe(true)
    expect(DATA_DIR.startsWith('/')).toBe(true)
    expect(CACHE_DIR.startsWith('/')).toBe(true)
    expect(DATA_CONFIG_DIR.startsWith('/')).toBe(true)
  })
})
