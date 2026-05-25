/**
 * Tests for cache strategy abstraction — Issue #336
 * Covers: TTL, ContentHash, ContentAddressed strategies + readCacheFile/writeCacheFile
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import {
  createTTLStrategy,
  createContentHashStrategy,
  createContentAddressedStrategy,
  readCacheFile,
  writeCacheFile,
  hashData,
  type CacheEntry,
} from '../../src/lib/cache-strategy.ts'

const TEST_DIR = join(import.meta.dir, '..', 'tmp-cache-strategy')

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

// ── hashData ────────────────────────────────────────────────────────────────

describe('hashData', () => {
  test('returns consistent hash for same data', () => {
    const h1 = hashData({ a: 1, b: [2, 3] })
    const h2 = hashData({ a: 1, b: [2, 3] })
    expect(h1).toBe(h2)
  })

  test('returns different hash for different data', () => {
    const h1 = hashData({ a: 1 })
    const h2 = hashData({ a: 2 })
    expect(h1).not.toBe(h2)
  })

  test('returns 16-char hex string', () => {
    const h = hashData('test')
    expect(h).toMatch(/^[a-f0-9]{16}$/)
  })
})

// ── TTL Strategy ────────────────────────────────────────────────────────────

describe('TTL Strategy', () => {
  const strategy = createTTLStrategy(60_000) // 60s TTL

  test('isValid returns true for fresh entry', () => {
    const entry: CacheEntry<string> = { data: 'test', cachedAt: new Date().toISOString() }
    expect(strategy.isValid(entry)).toBe(true)
  })

  test('isValid returns false for expired entry', () => {
    const entry: CacheEntry<string> = {
      data: 'test',
      cachedAt: new Date(Date.now() - 120_000).toISOString(),
    }
    expect(strategy.isValid(entry)).toBe(false)
  })

  test('isValid honors stored ttlMs over strategy default', () => {
    const entry: CacheEntry<string> = {
      data: 'test',
      cachedAt: new Date(Date.now() - 90_000).toISOString(), // 90s old
      ttlMs: 300_000, // 5min stored TTL
    }
    expect(strategy.isValid(entry)).toBe(true)
  })

  test('isValid returns false for missing cachedAt', () => {
    const entry = { data: 'test' } as any
    expect(strategy.isValid(entry)).toBe(false)
  })

  test('shouldSkipWrite always returns false', () => {
    expect(strategy.shouldSkipWrite(null, 'data')).toBe(false)
  })

  test('readCacheFile + writeCacheFile round-trip', () => {
    const path = join(TEST_DIR, 'ttl-test.json')
    const entry: CacheEntry<{ name: string }> = {
      data: { name: 'test' },
      cachedAt: new Date().toISOString(),
      ttlMs: 60_000,
    }
    writeCacheFile(path, entry, strategy)

    const result = readCacheFile<{ name: string }>(path, strategy)
    expect(result).not.toBeNull()
    expect(result!.data).toEqual({ name: 'test' })
  })

  test('readCacheFile returns null for expired entry', () => {
    const path = join(TEST_DIR, 'ttl-expired.json')
    writeFileSync(path, JSON.stringify({
      data: { name: 'old' },
      cachedAt: new Date(Date.now() - 120_000).toISOString(),
      ttlMs: 60_000,
    }))

    const result = readCacheFile<{ name: string }>(path, strategy)
    expect(result).toBeNull()
  })

  test('readCacheFile returns null for missing file', () => {
    const result = readCacheFile<string>(join(TEST_DIR, 'nope.json'), strategy)
    expect(result).toBeNull()
  })

  test('writeCacheFile creates parent directories', () => {
    const path = join(TEST_DIR, 'sub', 'dir', 'nested.json')
    const entry: CacheEntry<string> = { data: 'nested', cachedAt: new Date().toISOString() }
    const written = writeCacheFile(path, entry, strategy)
    expect(written).toBe(true)
    expect(existsSync(path)).toBe(true)
  })
})

// ── Content Hash Strategy ───────────────────────────────────────────────────

describe('ContentHash Strategy', () => {
  const strategy = createContentHashStrategy()

  test('isValid always returns true', () => {
    const entry: CacheEntry<number[]> = { data: [1, 2, 3], cachedAt: new Date().toISOString() }
    expect(strategy.isValid(entry)).toBe(true)
  })

  test('shouldSkipWrite returns false when no existing entry', () => {
    expect(strategy.shouldSkipWrite(null, [1, 2, 3])).toBe(false)
  })

  test('shouldSkipWrite returns true when data unchanged', () => {
    const existing: CacheEntry<number[]> = { data: [1, 2, 3], cachedAt: new Date().toISOString() }
    expect(strategy.shouldSkipWrite(existing, [1, 2, 3])).toBe(true)
  })

  test('shouldSkipWrite returns false when data changed', () => {
    const existing: CacheEntry<number[]> = { data: [1, 2, 3], cachedAt: new Date().toISOString() }
    expect(strategy.shouldSkipWrite(existing, [4, 5, 6])).toBe(false)
  })

  test('shouldSkipWrite uses stored hash if available', () => {
    const data = [1, 2, 3]
    const existing: CacheEntry<number[]> = {
      data,
      cachedAt: new Date().toISOString(),
      hash: hashData(data),
    }
    expect(strategy.shouldSkipWrite(existing, [1, 2, 3])).toBe(true)
  })

  test('writeCacheFile skips unchanged data', () => {
    const path = join(TEST_DIR, 'hash-skip.json')
    const entry1: CacheEntry<number> = { data: 42, cachedAt: new Date().toISOString() }
    writeCacheFile(path, entry1, strategy)
    const firstContent = readFileSync(path, 'utf-8')

    const entry2: CacheEntry<number> = { data: 42, cachedAt: new Date().toISOString() }
    const existing = readCacheFile<number>(path, strategy)
    const written = writeCacheFile(path, entry2, strategy, existing)
    expect(written).toBe(false)

    // File content should not have changed
    const secondContent = readFileSync(path, 'utf-8')
    expect(secondContent).toBe(firstContent)
  })

  test('writeCacheFile writes when data changed', () => {
    const path = join(TEST_DIR, 'hash-write.json')
    const entry1: CacheEntry<number> = { data: 42, cachedAt: new Date().toISOString() }
    writeCacheFile(path, entry1, strategy)

    const entry2: CacheEntry<number> = { data: 99, cachedAt: new Date().toISOString() }
    const existing = readCacheFile<number>(path, strategy)
    const written = writeCacheFile(path, entry2, strategy, existing)
    expect(written).toBe(true)

    const result = readCacheFile<number>(path, strategy)
    expect(result!.data).toBe(99)
  })
})

// ── Content Addressed Strategy ──────────────────────────────────────────────

describe('ContentAddressed Strategy', () => {
  const strategy = createContentAddressedStrategy()

  test('isValid always returns true (path encodes version)', () => {
    const entry: CacheEntry<string> = { data: 'content', cachedAt: new Date().toISOString() }
    expect(strategy.isValid(entry)).toBe(true)
  })

  test('shouldSkipWrite always returns false', () => {
    const existing: CacheEntry<string> = { data: 'old', cachedAt: new Date().toISOString() }
    expect(strategy.shouldSkipWrite(existing, 'new')).toBe(false)
  })

  test('different paths coexist (version in path)', () => {
    const pathV1 = join(TEST_DIR, 'file-v1.json')
    const pathV2 = join(TEST_DIR, 'file-v2.json')

    writeCacheFile(pathV1, { data: 'version 1', cachedAt: new Date().toISOString() }, strategy)
    writeCacheFile(pathV2, { data: 'version 2', cachedAt: new Date().toISOString() }, strategy)

    expect(readCacheFile<string>(pathV1, strategy)!.data).toBe('version 1')
    expect(readCacheFile<string>(pathV2, strategy)!.data).toBe('version 2')
  })
})

// ── File permissions ────────────────────────────────────────────────────────

describe('File permissions', () => {
  test('written files have 0o600 mode', () => {
    const path = join(TEST_DIR, 'perms.json')
    const strategy = createTTLStrategy(60_000)
    writeCacheFile(path, { data: 'secret', cachedAt: new Date().toISOString() }, strategy)

    const { statSync } = require('fs')
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
