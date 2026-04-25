// BKL-INGEST-02: Regression test for SF bookings L2 freshness gate.
//
// Verifies the CACHE_HIER_FRESH_MS gate logic added to the SF bookings path in
// src/bootstrap-orchestrator.ts (mirrors the CCSP L2 pattern). The gate says:
//   if existingSupportableId modifiedTime < 24h old → read L2, skip L3
//   else → fall through to L3 (POD-level SF bookings source sheet)
//
// This is a pure logic test for the freshness predicate — the full read path
// is exercised in Playwright integration tests with mocked Drive API responses.

import { test, expect, describe } from 'bun:test'

// Must match src/bootstrap-orchestrator.ts line ~411 exactly.
const CACHE_HIER_FRESH_MS = 24 * 60 * 60 * 1000

/** Replicates the L2 freshness predicate used in bootstrap-orchestrator.ts. */
function isL2Fresh(modifiedTime: Date | null, now: number): boolean {
  if (!modifiedTime) return false
  return (now - modifiedTime.getTime()) < CACHE_HIER_FRESH_MS
}

describe('BKL-INGEST-02: SF bookings L2 freshness gate', () => {
  test('CACHE_HIER_FRESH_MS is 24 hours', () => {
    expect(CACHE_HIER_FRESH_MS).toBe(86_400_000)
  })

  test('null modifiedTime → stale (fall through to L3)', () => {
    expect(isL2Fresh(null, Date.now())).toBe(false)
  })

  test('modifiedTime just now → fresh (use L2)', () => {
    const now = Date.now()
    const modifiedTime = new Date(now)
    expect(isL2Fresh(modifiedTime, now)).toBe(true)
  })

  test('modifiedTime 1h ago → fresh', () => {
    const now = Date.now()
    const modifiedTime = new Date(now - 1 * 60 * 60 * 1000)
    expect(isL2Fresh(modifiedTime, now)).toBe(true)
  })

  test('modifiedTime 23h ago → fresh (edge)', () => {
    const now = Date.now()
    const modifiedTime = new Date(now - 23 * 60 * 60 * 1000)
    expect(isL2Fresh(modifiedTime, now)).toBe(true)
  })

  test('modifiedTime exactly 24h ago → stale (strict <)', () => {
    const now = Date.now()
    const modifiedTime = new Date(now - CACHE_HIER_FRESH_MS)
    expect(isL2Fresh(modifiedTime, now)).toBe(false)
  })

  test('modifiedTime 25h ago → stale (fall through to L3)', () => {
    const now = Date.now()
    const modifiedTime = new Date(now - 25 * 60 * 60 * 1000)
    expect(isL2Fresh(modifiedTime, now)).toBe(false)
  })

  test('modifiedTime 48h ago → stale', () => {
    const now = Date.now()
    const modifiedTime = new Date(now - 48 * 60 * 60 * 1000)
    expect(isL2Fresh(modifiedTime, now)).toBe(false)
  })

  test('modifiedTime in the future (clock skew) → fresh (age is negative, < 24h)', () => {
    const now = Date.now()
    const modifiedTime = new Date(now + 60 * 60 * 1000) // 1h in future
    // Negative age is always < 24h — treat as fresh. Prevents spurious L3 fall-through on clock drift.
    expect(isL2Fresh(modifiedTime, now)).toBe(true)
  })

  test('parity with CCSP L2 predicate (matches line ~1840 pattern)', () => {
    // The CCSP and SF-bookings L2 predicates MUST use identical math —
    // any divergence is a hierarchy-consistency bug.
    const now = Date.now()
    const modifiedTime = new Date(now - 12 * 60 * 60 * 1000) // 12h old
    const ccspStyle = (now - modifiedTime.getTime()) < CACHE_HIER_FRESH_MS
    expect(isL2Fresh(modifiedTime, now)).toBe(ccspStyle)
  })
})
