/**
 * Cache strategy abstraction — pluggable invalidation strategies.
 * Issue #336: Consolidates 6 caching patterns into a unified CacheEntry<T> generic.
 *
 * Strategies:
 *   1. TTL — expires after a duration (brief, email, meeting, industry)
 *   2. ContentHash — skips writes when SHA256 of data is unchanged (sheet, CCSP, pipeline)
 *   3. ContentAddressed — keyed by (id, modifiedTime), no TTL (doc content, doc classification)
 *
 * All strategies share:
 *   - JSON file backing with atomic write (mode 0o600)
 *   - Non-fatal read/write (returns null on error, warns on write failure)
 *   - cachedAt timestamp on every entry
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { createHash } from 'crypto'

// ── Core types ──────────────────────────────────────────────────────────────

export interface CacheEntry<T> {
  data: T
  cachedAt: string
  ttlMs?: number
  hash?: string
  [key: string]: unknown
}

export interface CacheStrategy {
  name: string
  /** Check if a cache entry is still valid */
  isValid(entry: CacheEntry<unknown>): boolean
  /** Check if a write should be skipped (e.g. data unchanged) */
  shouldSkipWrite(existing: CacheEntry<unknown> | null, newData: unknown): boolean
}

// ── Strategy implementations ────────────────────────────────────────────────

export function createTTLStrategy(ttlMs: number): CacheStrategy {
  return {
    name: 'ttl',
    isValid(entry: CacheEntry<unknown>): boolean {
      if (!entry.cachedAt) return false
      const storedTtl = typeof entry.ttlMs === 'number' ? entry.ttlMs : ttlMs
      const age = Date.now() - new Date(entry.cachedAt).getTime()
      return Number.isFinite(age) && age <= storedTtl
    },
    shouldSkipWrite(): boolean {
      return false // TTL always overwrites
    },
  }
}

export function createContentHashStrategy(): CacheStrategy {
  return {
    name: 'content-hash',
    isValid(): boolean {
      return true // no expiry — valid until data changes
    },
    shouldSkipWrite(existing: CacheEntry<unknown> | null, newData: unknown): boolean {
      if (!existing) return false
      const existingHash = existing.hash ?? hashData(existing.data)
      const newHash = hashData(newData)
      return existingHash === newHash
    },
  }
}

export function createContentAddressedStrategy(): CacheStrategy {
  return {
    name: 'content-addressed',
    isValid(): boolean {
      return true // path encodes version — if file exists, it's valid
    },
    shouldSkipWrite(): boolean {
      return false // path changes on version change, so always write
    },
  }
}

// ── Generic cache operations ────────────────────────────────────────────────

export function readCacheFile<T>(path: string, strategy: CacheStrategy): CacheEntry<T> | null {
  try {
    const entry = JSON.parse(readFileSync(path, 'utf-8')) as CacheEntry<T>
    if (!strategy.isValid(entry)) return null
    return entry
  } catch {
    return null
  }
}

export function writeCacheFile<T>(
  path: string,
  entry: CacheEntry<T>,
  strategy: CacheStrategy,
  existingEntry?: CacheEntry<T> | null,
): boolean {
  if (strategy.shouldSkipWrite(existingEntry ?? null, entry.data)) return false
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(entry), { mode: 0o600 })
    return true
  } catch (e: any) {
    console.warn(`[cache] ${strategy.name} write failed for ${path}: ${e.message}`)
    return false
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function hashData(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16)
}
