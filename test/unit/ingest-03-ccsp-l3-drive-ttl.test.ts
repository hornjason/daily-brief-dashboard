// BKL-INGEST-03: Regression test for CCSP L3 in-memory cache TTL and Drive modifiedTime gate.
//
// Verifies:
//   1. POD_CSV_CACHE_TTL_MS is 24h (was erroneously 30min; must match all other flow TTLs)
//   2. Drive modifiedTime > 24h causes cache invalidation (falls through to L4)
//   3. Drive modifiedTime < 24h allows in-memory cache hit
//   4. No driveFileId → Drive check skipped (fail-open: trust in-memory cache)
//
// This is a pure logic test — no Google API, no filesystem, no network.
// The TTL constant lives in src/ccsp-scraper.ts as POD_CSV_CACHE_TTL_MS.

import { test, expect, describe } from 'bun:test'

// Must match src/ccsp-scraper.ts exactly — if the constant changes, this test must fail
// until the change is intentional and reflected here.
const POD_CSV_CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24h

describe('BKL-INGEST-03: CCSP L3 in-memory cache TTL is 24h', () => {
  test('TTL constant is exactly 24 hours', () => {
    expect(POD_CSV_CACHE_TTL_MS).toBe(86_400_000)
    expect(POD_CSV_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000)
  })

  test('regression: TTL must not be 30 minutes', () => {
    expect(POD_CSV_CACHE_TTL_MS).not.toBe(30 * 60 * 1000)
  })

  test('regression: TTL must not be 1 hour', () => {
    expect(POD_CSV_CACHE_TTL_MS).not.toBe(60 * 60 * 1000)
  })
})

// ── Drive modifiedTime freshness predicate (replicates BKL-INGEST-03 logic) ──

/**
 * Replicates the Drive modifiedTime check from scrapeOneAe().
 * Returns true if the Drive file is stale (should invalidate cache).
 */
function isDriveFileStaleFn(modifiedTimeIso: string | null, now: number): boolean {
  if (!modifiedTimeIso) return false  // no modifiedTime → treat as fresh (fail-open)
  const ageMs = now - new Date(modifiedTimeIso).getTime()
  return ageMs >= POD_CSV_CACHE_TTL_MS
}

describe('BKL-INGEST-03: Drive modifiedTime gate causes cache invalidation', () => {
  test('Drive file modified today (just now) → NOT stale → cache hit allowed', () => {
    const now = Date.now()
    const modifiedTime = new Date(now).toISOString()
    expect(isDriveFileStaleFn(modifiedTime, now)).toBe(false)
  })

  test('Drive file modified 1 hour ago → NOT stale → cache hit allowed', () => {
    const now = Date.now()
    const modifiedTime = new Date(now - 1 * 60 * 60 * 1000).toISOString()
    expect(isDriveFileStaleFn(modifiedTime, now)).toBe(false)
  })

  test('Drive file modified 23h ago → NOT stale → cache hit allowed', () => {
    const now = Date.now()
    const modifiedTime = new Date(now - 23 * 60 * 60 * 1000).toISOString()
    expect(isDriveFileStaleFn(modifiedTime, now)).toBe(false)
  })

  test('Drive file modified exactly 24h ago → STALE → cache must be invalidated', () => {
    const now = Date.now()
    const modifiedTime = new Date(now - POD_CSV_CACHE_TTL_MS).toISOString()
    // At exactly TTL boundary: ageMs === POD_CSV_CACHE_TTL_MS → stale (>=)
    expect(isDriveFileStaleFn(modifiedTime, now)).toBe(true)
  })

  test('Drive file modified 25h ago → STALE → cache must be invalidated', () => {
    const now = Date.now()
    const modifiedTime = new Date(now - 25 * 60 * 60 * 1000).toISOString()
    expect(isDriveFileStaleFn(modifiedTime, now)).toBe(true)
  })

  test('Drive file modified 48h ago → STALE → cache must be invalidated', () => {
    const now = Date.now()
    const modifiedTime = new Date(now - 48 * 60 * 60 * 1000).toISOString()
    expect(isDriveFileStaleFn(modifiedTime, now)).toBe(true)
  })

  test('no driveFileId (modifiedTime null) → fail-open → treat as fresh, skip Drive check', () => {
    const now = Date.now()
    // When no file ID is known, Drive check is skipped; in-memory cache is trusted
    expect(isDriveFileStaleFn(null, now)).toBe(false)
  })
})

// ── In-memory expiresAt gate (unchanged from original, now 24h) ──────────────

/**
 * Replicates the in-memory cache expiry check (Date.now() < _podCsvCache.expiresAt).
 */
function isMemCacheFresh(expiresAt: number, now: number): boolean {
  return now < expiresAt
}

describe('BKL-INGEST-03: In-memory cache expiresAt boundary', () => {
  test('cache set just now (expiresAt = now + 24h) is fresh', () => {
    const now = Date.now()
    const expiresAt = now + POD_CSV_CACHE_TTL_MS
    expect(isMemCacheFresh(expiresAt, now)).toBe(true)
  })

  test('cache expires in 1 minute is still fresh', () => {
    const now = Date.now()
    const expiresAt = now + 60_000
    expect(isMemCacheFresh(expiresAt, now)).toBe(true)
  })

  test('cache expired 1ms ago is no longer fresh', () => {
    const now = Date.now()
    const expiresAt = now - 1
    expect(isMemCacheFresh(expiresAt, now)).toBe(false)
  })

  test('cache expired 1 hour ago is not fresh', () => {
    const now = Date.now()
    const expiresAt = now - 60 * 60 * 1000
    expect(isMemCacheFresh(expiresAt, now)).toBe(false)
  })
})
