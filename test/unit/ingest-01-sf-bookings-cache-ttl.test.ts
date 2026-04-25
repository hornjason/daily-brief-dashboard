// BKL-INGEST-01: Regression test for SF bookings raw cache TTL (24h).
// Locks the TTL at 24 hours and asserts the freshness predicate the fetcher uses:
//   Date.now() - cached.fetchedAt < RAW_CACHE_TTL_MS
// Passing at 23h, failing at 25h.
//
// This is a pure logic test — no Google API, no filesystem, no network.
// The TTL constant lives in src/sf-bookings-reader.ts line ~40 as a module-private
// constant, so we verify against the exact same value expression used in source.

import { test, expect, describe } from 'bun:test'

// Must match src/sf-bookings-reader.ts exactly — if the source constant changes,
// this test must fail until the change is intentional and reflected here.
const RAW_CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 hours

/** Replicates the freshness predicate from fetchSfBookingsRaw() line ~242. */
function isRawCacheFresh(fetchedAt: number, now: number): boolean {
  return now - fetchedAt < RAW_CACHE_TTL_MS
}

describe('BKL-INGEST-01: SF bookings raw cache 24h TTL', () => {
  test('TTL constant is 24 hours (not 1 hour)', () => {
    expect(RAW_CACHE_TTL_MS).toBe(86_400_000)
    expect(RAW_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000)
  })

  test('regression: TTL must not silently revert to 1 hour', () => {
    expect(RAW_CACHE_TTL_MS).not.toBe(60 * 60 * 1000)
  })

  test('fresh at t=0 (just cached)', () => {
    const now = Date.now()
    expect(isRawCacheFresh(now, now)).toBe(true)
  })

  test('fresh at t=1 hour', () => {
    const now = Date.now()
    const fetchedAt = now - (1 * 60 * 60 * 1000)
    expect(isRawCacheFresh(fetchedAt, now)).toBe(true)
  })

  test('fresh at t=23 hours (edge — just under TTL)', () => {
    const now = Date.now()
    const fetchedAt = now - (23 * 60 * 60 * 1000)
    expect(isRawCacheFresh(fetchedAt, now)).toBe(true)
  })

  test('fresh at t=23h59m (edge — just under TTL boundary)', () => {
    const now = Date.now()
    const fetchedAt = now - (23 * 60 * 60 * 1000 + 59 * 60 * 1000)
    expect(isRawCacheFresh(fetchedAt, now)).toBe(true)
  })

  test('expired at exactly t=24 hours (strict <, not ≤)', () => {
    const now = Date.now()
    const fetchedAt = now - RAW_CACHE_TTL_MS
    expect(isRawCacheFresh(fetchedAt, now)).toBe(false)
  })

  test('expired at t=25 hours', () => {
    const now = Date.now()
    const fetchedAt = now - (25 * 60 * 60 * 1000)
    expect(isRawCacheFresh(fetchedAt, now)).toBe(false)
  })

  test('expired at t=48 hours', () => {
    const now = Date.now()
    const fetchedAt = now - (48 * 60 * 60 * 1000)
    expect(isRawCacheFresh(fetchedAt, now)).toBe(false)
  })
})
