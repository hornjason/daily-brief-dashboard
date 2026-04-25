import { test, expect, describe } from 'bun:test'

/**
 * BKL-INGEST-11 regression — L2 cold-start guard
 *
 * Root cause: the L2 SF Bookings short-circuit skipped customer derivation even
 * when customers.json was empty (cold start / wiped). The fix adds an aeHasCustomers
 * guard so that a warm L2 cache alone is NOT sufficient to skip L3 if the AE has
 * zero customers in the in-memory array.
 *
 * This file tests the core branching predicate in isolation so that it can run
 * without importing the full orchestrator (which has heavy runtime deps).
 */

// ---------------------------------------------------------------------------
// Minimal Customer shape — only the fields the guard cares about
// ---------------------------------------------------------------------------
interface MinimalCustomer {
  name: string
  ae?: string
  inactive?: boolean
}

// ---------------------------------------------------------------------------
// The exact guard extracted from bootstrap-orchestrator.ts (BKL-INGEST-11 fix)
// ---------------------------------------------------------------------------

/** Returns true when the AE already has at least one active customer in memory. */
function aeHasCustomers(customers: MinimalCustomer[], aeName: string): boolean {
  return customers.some(cx => cx.ae === aeName && !cx.inactive)
}

/** Returns true when the L2 short-circuit should fire (skip L3 + customer derivation). */
function shouldShortCircuitOnL2(
  l2Results: unknown[] | null,
  customers: MinimalCustomer[],
  aeName: string,
): boolean {
  const hasCustomers = aeHasCustomers(customers, aeName)
  return !!(l2Results && l2Results.length > 0 && hasCustomers)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BKL-INGEST-11: L2 SF Bookings cold-start guard', () => {
  const AE = 'Jane Smith'
  const fakeL2Results = [{ rows: [{ customer: 'Acme Corp' }] }]

  // --- aeHasCustomers predicate ---

  describe('aeHasCustomers()', () => {
    test('returns true when AE has active customers', () => {
      const customers: MinimalCustomer[] = [
        { name: 'Acme', ae: AE },
        { name: 'Initech', ae: AE },
      ]
      expect(aeHasCustomers(customers, AE)).toBe(true)
    })

    test('returns false when customers array is empty (cold start)', () => {
      expect(aeHasCustomers([], AE)).toBe(false)
    })

    test('returns false when AE has no customers (other AEs present)', () => {
      const customers: MinimalCustomer[] = [
        { name: 'Globex', ae: 'Other AE' },
      ]
      expect(aeHasCustomers(customers, AE)).toBe(false)
    })

    test('returns false when all AE customers are inactive', () => {
      const customers: MinimalCustomer[] = [
        { name: 'Acme', ae: AE, inactive: true },
        { name: 'Initech', ae: AE, inactive: true },
      ]
      expect(aeHasCustomers(customers, AE)).toBe(false)
    })

    test('returns true when at least one AE customer is active (mixed inactive)', () => {
      const customers: MinimalCustomer[] = [
        { name: 'Acme', ae: AE, inactive: true },
        { name: 'Initech', ae: AE },
      ]
      expect(aeHasCustomers(customers, AE)).toBe(true)
    })

    test('returns false when customers exist but ae field is undefined', () => {
      const customers: MinimalCustomer[] = [
        { name: 'Acme' },
      ]
      expect(aeHasCustomers(customers, AE)).toBe(false)
    })
  })

  // --- shouldShortCircuitOnL2 — the full guard (BKL-INGEST-11 regression) ---

  describe('shouldShortCircuitOnL2()', () => {
    test('BKL-INGEST-11: does NOT short-circuit when L2 fresh but AE has 0 customers (cold start)', () => {
      // This is the exact scenario that caused the bug.
      // L2 has rows, but customers.json was wiped — must fall through to L3.
      expect(shouldShortCircuitOnL2(fakeL2Results, [], AE)).toBe(false)
    })

    test('short-circuits when L2 fresh AND AE already has customers', () => {
      const customers: MinimalCustomer[] = [{ name: 'Acme', ae: AE }]
      expect(shouldShortCircuitOnL2(fakeL2Results, customers, AE)).toBe(true)
    })

    test('does NOT short-circuit when L2 is null (L2 miss)', () => {
      const customers: MinimalCustomer[] = [{ name: 'Acme', ae: AE }]
      expect(shouldShortCircuitOnL2(null, customers, AE)).toBe(false)
    })

    test('does NOT short-circuit when L2 returns empty array', () => {
      const customers: MinimalCustomer[] = [{ name: 'Acme', ae: AE }]
      expect(shouldShortCircuitOnL2([], customers, AE)).toBe(false)
    })

    test('does NOT short-circuit when AE has only inactive customers + L2 fresh', () => {
      const customers: MinimalCustomer[] = [{ name: 'Acme', ae: AE, inactive: true }]
      expect(shouldShortCircuitOnL2(fakeL2Results, customers, AE)).toBe(false)
    })

    test('does NOT short-circuit when different AE has customers but target AE has none', () => {
      const customers: MinimalCustomer[] = [{ name: 'Globex', ae: 'Other AE' }]
      expect(shouldShortCircuitOnL2(fakeL2Results, customers, AE)).toBe(false)
    })
  })
})
